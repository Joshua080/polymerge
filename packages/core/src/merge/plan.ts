/**
 * MERGE PLAN — combines the two decomposed sides (sides.ts) into:
 *   1. merged frames (global + per part) with frame conflicts,
 *   2. per-base-vertex decisions and atomic vertex conflicts,
 *   3. additions: convergent (identical) additions, competing additions on shared edges and
 *      spatially overlapping additions,
 *   4. conflict REGIONS: unions of whole change components of both sides that touch an atomic
 *      conflict, closed under overlap (docs/merge-design.md §5).
 * Materialisation (materialize.ts) turns a plan + resolutions into a mesh. Collision conflicts
 * (collide.ts) are found on that mesh afterwards and added with `addAtomics`, which rebuilds the
 * regions.
 */
import { buildAdjacency } from '../diff/adjacency.js';
import { componentVertices, type IComponents } from '../diff/components.js';
import { boxCorners, composeRigid, identityRigid, invertRigid, maxMotion, applyRigid, type IRigid } from '../diff/linalg.js';
import { KdTree } from '../diff/spatial.js';
import type { IMesh, MergeConflictKind } from '../types.js';
import type { IMaterialized } from './materialize.js';
import { findOverlaps } from './overlap.js';
import { sideFrame, type ISide } from './sides.js';

export type FrameSource = 'base' | 'ours' | 'theirs' | 'both' | 'composed' | 'conflict';

export interface IFrameDecision {
  ours: IRigid;
  theirs: IRigid;
  /** Null when the two sides conflict (the resolution picks). */
  merged: IRigid | null;
  source: FrameSource;
}

/** One atomic conflict, before grouping into regions. */
export interface IAtomic {
  kind: MergeConflictKind;
  /** Base vertices involved: every change component (either side) touching them joins. */
  base: number[];
  /** Added faces involved, as slots into each side's addedFaces. */
  oursFaceSlots: number[];
  theirsFaceSlots: number[];
  /** Part-motion conflict: the base component. */
  part?: number;
  /** Base components whose part FRAME is involved (collisions with a moved part). */
  frames?: number[];
  /** Collision flavour (for the region summary). */
  collision?: 'crossing' | 'fold';
  detail?: string;
}

interface IChangeComponents {
  uf: UnionFind;
  touched: Uint8Array;
}

export interface IRegion {
  id: number;
  kinds: Partial<Record<MergeConflictKind, number>>;
  /** Base vertices in the region (ascending). */
  baseVertices: number[];
  /** Added faces (side face indices) of each side inside the region. */
  oursFaces: number[];
  theirsFaces: number[];
  /** Base components whose part motion is in conflict in this region. */
  partComponents: number[];
  details: string[];
}

export interface IMergePlan {
  base: IMesh;
  ours: ISide;
  theirs: ISide;
  baseComponents: IComponents;
  /** A side lost vertex identity: the only conflict is a whole-model `lineage` conflict. */
  lineage: string | null;
  global: IFrameDecision;
  parts: Map<number, IFrameDecision>;
  /** Base-frame position of every ADDED side vertex (xyz; 0 for non-added). */
  oursAddedPos: Float64Array;
  theirsAddedPos: Float64Array;
  /** theirs added vertex → identical ours added vertex (-1 = none). */
  unified: Int32Array;
  /** 1 = this added face also exists identically on the other side. */
  oursConvergent: Uint8Array;
  theirsConvergent: Uint8Array;
  /** Convergent added-face pairs [ours slot, theirs slot]. */
  convergentPairs: Array<[number, number]>;
  regions: IRegion[];
  /** Region of each base vertex (-1 = none). */
  regionOfBase: Int32Array;
  /** Region of each added face, indexed by side face index (-1 = none). */
  regionOfOursFace: Int32Array;
  regionOfTheirsFace: Int32Array;
  /** Movement threshold in base units (max of both sides). */
  eps: number;
  /** Atomic conflicts the regions are built from (collision atomics are appended later). */
  atomics: IAtomic[];
  /** Components with a part-motion conflict. */
  partConflicts: number[];
  /** Bounding-box corners of each moved part (base frame), for frame comparisons. */
  partCorners: Map<number, Float64Array>;
  /** Added-face slot of each side face (-1 = not an addition). */
  oursSlotOfFace: Int32Array;
  theirsSlotOfFace: Int32Array;
  /** Change components of each side (null until regions are built). */
  changeA: IChangeComponents | null;
  changeB: IChangeComponents | null;
  /** Check combinations for collisions (IMergeOptions.detectCollisions). */
  detectCollisions: boolean;
  /** The materialised merge with every conflict unresolved, once regions are final (cache). */
  unresolvedMerge: IMaterialized | null;
}

function sameRigid(a: IRigid, b: IRigid, corners: Float64Array, eps: number): boolean {
  return maxMotion(a, b, corners) <= eps;
}

function isIdentity(g: IRigid, corners: Float64Array, eps: number): boolean {
  return maxMotion(g, identityRigid(), corners) <= eps;
}

class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) x = p[x] = p[p[x]];
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}

/**
 * Change components of one side over nodes [0, nO) = base vertices and nO + i = i-th added
 * face (in side.addedFaces order): a base vertex is touched when deleted, locally moved,
 * incident to a base face the side removed, or anchoring the side's additions.
 */
function changeComponents(plan: { base: IMesh }, side: ISide, adjNeighbors: { offsets: Uint32Array; neighbors: Uint32Array }) {
  const nO = plan.base.vertexCount;
  const added = side.addedFaces;
  const uf = new UnionFind(nO + added.length);
  const touched = new Uint8Array(nO);
  for (let v = 0; v < nO; v++) if (side.deleted[v] || side.moved[v] || side.anchors[v]) touched[v] = 1;
  const bf = plan.base.faces;
  for (let f = 0; f < plan.base.faceCount; f++) {
    if (side.faceKept[f]) continue;
    const a = bf[f * 3];
    const b = bf[f * 3 + 1];
    const c = bf[f * 3 + 2];
    touched[a] = touched[b] = touched[c] = 1;
    uf.union(a, b);
    uf.union(a, c);
  }
  for (let v = 0; v < nO; v++) {
    if (!touched[v]) continue;
    for (let i = adjNeighbors.offsets[v], e = adjNeighbors.offsets[v + 1]; i < e; i++) {
      const u = adjNeighbors.neighbors[i];
      if (touched[u]) uf.union(v, u);
    }
  }
  // Added faces: joined to their anchors and to each other through shared added vertices.
  const firstFaceOfVertex = new Int32Array(side.mesh.vertexCount).fill(-1);
  const sf = side.mesh.faces;
  added.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      const t = sf[f * 3 + k];
      const b = side.inv[t];
      if (b >= 0) uf.union(nO + i, b);
      else if (firstFaceOfVertex[t] < 0) firstFaceOfVertex[t] = i;
      else uf.union(nO + i, nO + firstFaceOfVertex[t]);
    }
  });
  return { uf, touched };
}

function describeRigid(g: IRigid): string {
  const angle = Math.atan2(0.5 * Math.hypot(g.r[7] - g.r[5], g.r[2] - g.r[6], g.r[3] - g.r[1]), 0.5 * (g.r[0] + g.r[4] + g.r[8] - 1));
  const t = Array.from(g.t, (x) => Number(x.toPrecision(4)));
  return `${g.s !== 1 ? `×${Number(g.s.toPrecision(6))} ` : ''}rotation ${((angle * 180) / Math.PI).toFixed(1)}°, translation (${t.join(', ')})`;
}

export function buildPlan(base: IMesh, ours: ISide, theirs: ISide, baseComponents: IComponents): IMergePlan {
  const nO = base.vertexCount;
  const corners = boxCorners(base.metadata.bounds);
  const eps = Math.max(ours.eps, theirs.eps);
  const nA = ours.mesh.vertexCount;
  const nB = theirs.mesh.vertexCount;

  const empty = (): IMergePlan => ({
    base,
    ours,
    theirs,
    baseComponents,
    lineage: null,
    global: { ours: ours.T, theirs: theirs.T, merged: identityRigid(), source: 'base' },
    parts: new Map(),
    oursAddedPos: new Float64Array(nA * 3),
    theirsAddedPos: new Float64Array(nB * 3),
    unified: new Int32Array(nB).fill(-1),
    oursConvergent: new Uint8Array(ours.mesh.faceCount),
    theirsConvergent: new Uint8Array(theirs.mesh.faceCount),
    convergentPairs: [],
    regions: [],
    regionOfBase: new Int32Array(nO).fill(-1),
    regionOfOursFace: new Int32Array(ours.mesh.faceCount).fill(-1),
    regionOfTheirsFace: new Int32Array(theirs.mesh.faceCount).fill(-1),
    eps,
    atomics: [],
    partConflicts: [],
    partCorners: new Map(),
    oursSlotOfFace: slotsOf(ours),
    theirsSlotOfFace: slotsOf(theirs),
    changeA: null,
    changeB: null,
    detectCollisions: true,
    unresolvedMerge: null,
  });
  const plan = empty();

  // ---- Lineage ------------------------------------------------------------------------------
  if (!ours.usable || !theirs.usable) {
    plan.lineage = [ours.unusableReason, theirs.unusableReason].filter(Boolean).join('; ');
    return plan;
  }

  // ---- 1. Frames ----------------------------------------------------------------------------
  const epsTarget = Math.max(ours.diff.moveEpsilon, theirs.diff.moveEpsilon);
  const idA = ours.diff.alignment.isIdentity;
  const idB = theirs.diff.alignment.isIdentity;
  let global: IFrameDecision;
  if (idA && idB) global = { ours: ours.T, theirs: theirs.T, merged: identityRigid(), source: 'base' };
  else if (idB) global = { ours: ours.T, theirs: theirs.T, merged: ours.T, source: 'ours' };
  else if (idA) global = { ours: ours.T, theirs: theirs.T, merged: theirs.T, source: 'theirs' };
  else if (sameRigid(ours.T, theirs.T, corners, epsTarget)) global = { ours: ours.T, theirs: theirs.T, merged: ours.T, source: 'both' };
  else if (ours.unitOnly) global = { ours: ours.T, theirs: theirs.T, merged: composeRigid(ours.T, theirs.T), source: 'composed' };
  else if (theirs.unitOnly) global = { ours: ours.T, theirs: theirs.T, merged: composeRigid(theirs.T, ours.T), source: 'composed' };
  else global = { ours: ours.T, theirs: theirs.T, merged: null, source: 'conflict' };
  plan.global = global;

  const partConflicts: number[] = [];
  const comps = new Set<number>([...ours.partMotion.keys(), ...theirs.partMotion.keys()]);
  for (const c of [...comps].sort((a, b) => a - b)) {
    const I = identityRigid();
    const a = ours.partMotion.get(c) ?? I;
    const b = theirs.partMotion.get(c) ?? I;
    const verts = componentVertices(baseComponents, c);
    const cc = partCorners(base, verts);
    plan.partCorners.set(c, cc);
    let d: IFrameDecision;
    if (isIdentity(b, cc, eps)) d = { ours: a, theirs: b, merged: a, source: 'ours' };
    else if (isIdentity(a, cc, eps)) d = { ours: a, theirs: b, merged: b, source: 'theirs' };
    else if (sameRigid(a, b, cc, eps)) d = { ours: a, theirs: b, merged: a, source: 'both' };
    else {
      d = { ours: a, theirs: b, merged: null, source: 'conflict' };
      partConflicts.push(c);
    }
    plan.parts.set(c, d);
  }

  // ---- 2. Vertices ----------------------------------------------------------------------------
  const atomics = plan.atomics;
  for (let v = 0; v < nO; v++) {
    const dA = ours.deleted[v];
    const dB = theirs.deleted[v];
    if (dA && dB) continue;
    if (dA || dB) {
      const keeper = dA ? theirs : ours;
      if (keeper.moved[v]) atomics.push({ kind: 'move-delete', base: [v], oursFaceSlots: [], theirsFaceSlots: [] });
      else if (keeper.anchors[v]) atomics.push({ kind: 'delete-dependency', base: [v], oursFaceSlots: [], theirsFaceSlots: [] });
      continue;
    }
    if (ours.moved[v] && theirs.moved[v]) {
      const ddx = ours.delta[v * 3] - theirs.delta[v * 3];
      const ddy = ours.delta[v * 3 + 1] - theirs.delta[v * 3 + 1];
      const ddz = ours.delta[v * 3 + 2] - theirs.delta[v * 3 + 2];
      if (Math.hypot(ddx, ddy, ddz) > eps) atomics.push({ kind: 'move-move', base: [v], oursFaceSlots: [], theirsFaceSlots: [] });
    }
  }

  // ---- 3. Additions (in the base frame) --------------------------------------------------------
  const addedPos = (side: ISide, out: Float64Array): void => {
    const inv = new Map<number, IRigid>();
    const q = new Float64Array(3);
    const p = side.mesh.positions;
    for (let t = 0; t < side.mesh.vertexCount; t++) {
      if (!side.isAdded[t]) continue;
      const c = side.anchorComponent[t];
      let g = inv.get(c);
      if (!g) {
        g = invertRigid(c >= 0 ? sideFrame(side, c) : side.T);
        inv.set(c, g);
      }
      applyRigid(g, p[t * 3], p[t * 3 + 1], p[t * 3 + 2], q);
      out.set(q, t * 3);
    }
  };
  addedPos(ours, plan.oursAddedPos);
  addedPos(theirs, plan.theirsAddedPos);

  // Unify identical added vertices (mutual nearest within eps).
  const oursAddedIdx: number[] = [];
  for (let t = 0; t < nA; t++) if (ours.isAdded[t]) oursAddedIdx.push(t);
  const theirsAddedIdx: number[] = [];
  for (let t = 0; t < nB; t++) if (theirs.isAdded[t]) theirsAddedIdx.push(t);
  if (oursAddedIdx.length > 0 && theirsAddedIdx.length > 0) {
    const pa = new Float64Array(oursAddedIdx.length * 3);
    oursAddedIdx.forEach((t, i) => pa.set(plan.oursAddedPos.subarray(t * 3, t * 3 + 3), i * 3));
    const pb = new Float64Array(theirsAddedIdx.length * 3);
    theirsAddedIdx.forEach((t, i) => pb.set(plan.theirsAddedPos.subarray(t * 3, t * 3 + 3), i * 3));
    const kdA = new KdTree(pa);
    const kdB = new KdTree(pb);
    const e2 = eps * eps;
    for (let j = 0; j < theirsAddedIdx.length; j++) {
      const i = kdA.nearest(pb[j * 3], pb[j * 3 + 1], pb[j * 3 + 2], e2);
      if (i < 0) continue;
      if (kdB.nearest(pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2], e2) !== j) continue;
      plan.unified[theirsAddedIdx[j]] = oursAddedIdx[i];
    }
  }

  // Canonical vertex ids: base v → v; ours added x → nO + x; theirs added y → unified or nO + nA + y.
  const canonOurs = (t: number): number => (ours.inv[t] >= 0 ? ours.inv[t] : nO + t);
  const canonTheirs = (t: number): number =>
    theirs.inv[t] >= 0 ? theirs.inv[t] : plan.unified[t] >= 0 ? nO + plan.unified[t] : nO + nA + t;
  const key = (a: number, b: number, c: number): string => {
    const s = [a, b, c].sort((x, y) => x - y);
    return `${s[0]},${s[1]},${s[2]}`;
  };
  const oursFaceKeys = new Map<string, number>();
  ours.addedFaces.forEach((f, i) => {
    const F = ours.mesh.faces;
    oursFaceKeys.set(key(canonOurs(F[f * 3]), canonOurs(F[f * 3 + 1]), canonOurs(F[f * 3 + 2])), i);
  });
  const theirsSlotCanon: number[][] = [];
  /** Convergent added-face pairs [ours slot, theirs slot]. */
  const convergentPairs: Array<[number, number]> = [];
  theirs.addedFaces.forEach((f, j) => {
    const F = theirs.mesh.faces;
    const tri = [canonTheirs(F[f * 3]), canonTheirs(F[f * 3 + 1]), canonTheirs(F[f * 3 + 2])];
    theirsSlotCanon.push(tri);
    const i = oursFaceKeys.get(key(tri[0], tri[1], tri[2]));
    if (i !== undefined) {
      plan.oursConvergent[ours.addedFaces[i]] = 1;
      plan.theirsConvergent[f] = 1;
      convergentPairs.push([i, j]);
    }
  });

  // Competing additions: a non-convergent added face of each side on the same edge.
  const edgeKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  const oursEdges = new Map<string, number>();
  ours.addedFaces.forEach((f, i) => {
    if (plan.oursConvergent[f]) return;
    const F = ours.mesh.faces;
    const c = [canonOurs(F[f * 3]), canonOurs(F[f * 3 + 1]), canonOurs(F[f * 3 + 2])];
    for (let k = 0; k < 3; k++) oursEdges.set(edgeKey(c[k], c[(k + 1) % 3]), i);
  });
  theirs.addedFaces.forEach((f, j) => {
    if (plan.theirsConvergent[f]) return;
    const c = theirsSlotCanon[j];
    for (let k = 0; k < 3; k++) {
      const i = oursEdges.get(edgeKey(c[k], c[(k + 1) % 3]));
      if (i === undefined) continue;
      const shared = [c[k], c[(k + 1) % 3]].filter((x) => x < nO);
      atomics.push({ kind: 'competing-additions', base: shared, oursFaceSlots: [i], theirsFaceSlots: [j] });
      break;
    }
  });

  // Overlapping additions in space (non-convergent faces only).
  for (const [i, j] of findOverlaps(plan, canonOurs, canonTheirs, eps)) {
    atomics.push({ kind: 'overlapping-additions', base: [], oursFaceSlots: [i], theirsFaceSlots: [j] });
  }

  // ---- 4. Regions -------------------------------------------------------------------------------
  plan.partConflicts = partConflicts;
  for (const c of partConflicts) {
    const d = plan.parts.get(c)!;
    atomics.push({
      kind: 'part-motion',
      base: [],
      oursFaceSlots: [],
      theirsFaceSlots: [],
      part: c,
      detail: `ours ${describeRigid(d.ours)} vs theirs ${describeRigid(d.theirs)}`,
    });
  }
  plan.convergentPairs = convergentPairs;
  const adj = buildAdjacency(nO, base.faces);
  plan.changeA = changeComponents({ base }, ours, adj);
  plan.changeB = changeComponents({ base }, theirs, adj);
  buildRegions(plan);
  return plan;
}

/** Add atomic conflicts (collisions found on a materialised merge) and rebuild the regions. */
export function addAtomics(plan: IMergePlan, extra: IAtomic[]): void {
  // A loop, not push(...extra): a big model can have more collisions than a call takes arguments.
  for (const a of extra) plan.atomics.push(a);
  plan.unresolvedMerge = null;
  buildRegions(plan);
}

/**
 * Regions = connected groups of change units (each side's change components, conflicting part
 * frames, and part frames involved in collisions) joined by atomic conflicts, numbered in order
 * of first discovery.
 */
function buildRegions(plan: IMergePlan): void {
  const { base, ours, theirs, baseComponents } = plan;
  const nO = base.vertexCount;
  const cA = plan.changeA!;
  const cB = plan.changeB!;
  const nNodesA = nO + ours.addedFaces.length;
  const nNodesB = nO + theirs.addedFaces.length;
  const offB = nNodesA;
  const offP = nNodesA + nNodesB;
  // Frame units: conflicting part frames first, then frames only involved in collisions.
  const frameNode = new Map<number, number>();
  plan.partConflicts.forEach((c, k) => frameNode.set(c, offP + k));
  for (const a of plan.atomics) for (const c of a.frames ?? []) if (!frameNode.has(c)) frameNode.set(c, offP + frameNode.size);
  const uf = new UnionFind(offP + frameNode.size);
  const nodeA = (x: number): number => cA.uf.find(x);
  const nodeB = (x: number): number => offB + cB.uf.find(x);
  // Overlap: a base vertex touched by both sides joins their components.
  for (let v = 0; v < nO; v++) if (cA.touched[v] && cB.touched[v]) uf.union(nodeA(v), nodeB(v));
  // Convergent additions join the two sides' components.
  for (const [i, j] of plan.convergentPairs) uf.union(nodeA(nO + i), nodeB(nO + j));
  // A conflicting part frame spans every change of either side on that part.
  for (const c of plan.partConflicts) {
    const node = frameNode.get(c)!;
    for (const v of componentVertices(baseComponents, c)) {
      if (cA.touched[v]) uf.union(node, nodeA(v));
      if (cB.touched[v]) uf.union(node, nodeB(v));
    }
  }
  const seeds: Array<[number, IAtomic]> = [];
  for (const a of plan.atomics) {
    const nodes: number[] = [];
    for (const v of a.base) {
      if (cA.touched[v]) nodes.push(nodeA(v));
      if (cB.touched[v]) nodes.push(nodeB(v));
    }
    for (const i of a.oursFaceSlots) nodes.push(nodeA(nO + i));
    for (const j of a.theirsFaceSlots) nodes.push(nodeB(nO + j));
    if (a.part !== undefined) nodes.push(frameNode.get(a.part)!);
    for (const c of a.frames ?? []) nodes.push(frameNode.get(c)!);
    for (let k = 1; k < nodes.length; k++) uf.union(nodes[0], nodes[k]);
    if (nodes.length > 0) seeds.push([nodes[0], a]);
  }

  // Regions in order of first discovery.
  const regionOfRoot = new Map<number, number>();
  const regions: IRegion[] = [];
  const collisions: Array<{ crossing: number; fold: number }> = [];
  for (const [node, a] of seeds) {
    const root = uf.find(node);
    let r = regionOfRoot.get(root);
    if (r === undefined) {
      r = regions.length;
      regionOfRoot.set(root, r);
      regions.push({ id: r, kinds: {}, baseVertices: [], oursFaces: [], theirsFaces: [], partComponents: [], details: [] });
      collisions.push({ crossing: 0, fold: 0 });
    }
    const reg = regions[r];
    reg.kinds[a.kind] = (reg.kinds[a.kind] ?? 0) + 1;
    if (a.part !== undefined && !reg.partComponents.includes(a.part)) reg.partComponents.push(a.part);
    if (a.detail) reg.details.push(a.detail);
    if (a.collision) collisions[r][a.collision]++;
  }
  collisions.forEach(({ crossing, fold }, r) => {
    const text = [crossing > 0 ? `${crossing} crossing face pair(s)` : '', fold > 0 ? `${fold} folded or collapsed face(s)` : ''].filter(Boolean);
    if (text.length > 0) regions[r].details.push(text.join(', '));
  });
  const regionOfNode = (node: number): number => regionOfRoot.get(uf.find(node)) ?? -1;
  plan.regionOfBase.fill(-1);
  for (let v = 0; v < nO; v++) {
    let r = -1;
    if (cA.touched[v]) r = regionOfNode(nodeA(v));
    if (r < 0 && cB.touched[v]) r = regionOfNode(nodeB(v));
    if (r >= 0) {
      plan.regionOfBase[v] = r;
      regions[r].baseVertices.push(v);
    }
  }
  // Part frames in a region: the region decides the frame, and shows the whole part. Vertices
  // another change of either side touches keep that change's own region.
  for (const [c, node] of frameNode) {
    const r = regionOfNode(node);
    if (r < 0) continue;
    if (!regions[r].partComponents.includes(c)) regions[r].partComponents.push(c);
    for (const v of componentVertices(baseComponents, c)) {
      if (plan.regionOfBase[v] >= 0 || cA.touched[v] || cB.touched[v]) continue;
      plan.regionOfBase[v] = r;
      regions[r].baseVertices.push(v);
    }
  }
  plan.regionOfOursFace.fill(-1);
  plan.regionOfTheirsFace.fill(-1);
  ours.addedFaces.forEach((f, i) => {
    const r = regionOfNode(nodeA(nO + i));
    plan.regionOfOursFace[f] = r;
    if (r >= 0) regions[r].oursFaces.push(f);
  });
  theirs.addedFaces.forEach((f, j) => {
    const r = regionOfNode(nodeB(nO + j));
    plan.regionOfTheirsFace[f] = r;
    if (r >= 0) regions[r].theirsFaces.push(f);
  });
  for (const r of regions) r.baseVertices.sort((a, b) => a - b);
  plan.regions = regions;
}

/** Added-face slot per side face (-1 = not an addition). */
function slotsOf(side: ISide): Int32Array {
  const out = new Int32Array(side.mesh.faceCount).fill(-1);
  side.addedFaces.forEach((f, i) => (out[f] = i));
  return out;
}

/** Bounding-box corners of a set of base vertices. */
export function partCorners(base: IMesh, verts: Uint32Array): Float64Array {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = base.positions;
  for (const v of verts) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[v * 3 + k]);
      max[k] = Math.max(max[k], p[v * 3 + k]);
    }
  }
  return boxCorners({ min: min as [number, number, number], max: max as [number, number, number] });
}
