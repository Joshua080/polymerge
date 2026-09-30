/**
 * STRUCTURE CARRY-THROUGH — gives the merged mesh the scene structure (`IMesh.scene`) and vertex
 * ids of its inputs, so that a merge written as glTF keeps the source's nodes (writers/gltf.ts) and
 * Tier 1's ID mode keeps working on the merged file. Positions are never changed here: the merged
 * world geometry is the merge's result, and the structure only decides how a writer expresses it.
 *
 * Scene (when base, ours or theirs has one):
 *  - Skeleton: the base's scene; for a base without one (e.g. OBJ), ours', else theirs'. The other
 *    inputs' nodes are matched to it by name path (the names of the node and its ancestors, and
 *    its rank among same-named siblings), then by index under the same parent.
 *  - Every merged face keeps its source face's node + primitive (the provenance names the input
 *    and face it came from). A face of a structure-less base takes the node of its image in ours
 *    (or theirs). A face from a side whose node the skeleton lacks brings that node along, with
 *    its unmatched ancestors, so geometry a side added as a new node stays a node.
 *  - Faces still without a node (from an STL / OBJ side) join the node of a face they share a
 *    vertex with, transitively; floating ones stay nodeless (the writer gives them a root node).
 *  - Transforms, per skeleton node, top-down: the base's local transform, or a side's different
 *    one — whichever explains the node's merged geometry best, i.e. whose motion relative to the
 *    base world matrix carries the most of its subtree's base vertices onto their merged position
 *    (within the merge's move threshold). Ties keep the base. A node a side moved by its transform
 *    thus keeps the new transform and its local data; a conflict left at base keeps the base one.
 *  - A base node with no faces left in its subtree is dropped when a side deleted it and the other
 *    side deleted it too or left it unchanged.
 * Vertex ids (when the base has them): base vertices keep theirs; a side's added vertex keeps its
 * id unless the merge already uses it; other added vertices get fresh ids (max + 1, …) when every
 * id is a number.
 */
import type { Matrix4 } from 'three';
import { copyTransform, nodeLocalMatrix, sameTransform, worldMatrices, type SceneTransform } from '../scene.js';
import { Uint32TripleMap } from '../parsers/weld.js';
import type { IMergeProvenance, IMesh, IMeshScene, ISceneMesh, ISceneNode, ISceneSource, Mat4 } from '../types.js';
import type { IRigid } from '../diff/linalg.js';
import type { IMergePlan } from './plan.js';

/** Attach `scene` and `vertexIds` to a freshly materialised merged mesh. O(faces + vertices). */
export function carryStructure(plan: IMergePlan, mesh: IMesh, provenance: IMergeProvenance, global: IRigid): void {
  const inputs = [plan.base, plan.ours.mesh, plan.theirs.mesh];
  if (plan.base.vertexIds) mesh.vertexIds = carryIds(inputs, provenance);
  if (inputs.some((m) => m.scene)) mesh.scene = mergeScene(plan, inputs, mesh, provenance, global);
}

// ---------------------------------------------------------------------------
// Vertex ids
// ---------------------------------------------------------------------------

function carryIds(inputs: IMesh[], prov: IMergeProvenance): (string | null)[] {
  const n = prov.vertexSource.length;
  const ids = new Array<string | null>(n).fill(null);
  const used = new Set<string>();
  for (let v = 0; v < n; v++) {
    if (prov.vertexSource[v] !== 0) continue;
    const id = inputs[0].vertexIds![prov.vertexIndex[v]] ?? null;
    ids[v] = id;
    if (id !== null) used.add(id);
  }
  let max = -Infinity;
  let numeric = true;
  for (const m of inputs) {
    for (const id of m.vertexIds ?? []) {
      if (id == null) continue;
      const x = Number(id);
      if (Number.isFinite(x) && String(x) === id) max = Math.max(max, x);
      else numeric = false;
    }
  }
  let next = max === -Infinity ? 0 : Math.floor(max) + 1;
  for (let v = 0; v < n; v++) {
    const src = prov.vertexSource[v];
    if (src === 0) continue;
    const id = inputs[src].vertexIds?.[prov.vertexIndex[v]] ?? null;
    if (id !== null && !used.has(id)) {
      ids[v] = id;
      used.add(id);
    } else if (numeric) {
      ids[v] = String(next++);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Node matching
// ---------------------------------------------------------------------------

function parents(scene: IMeshScene): Int32Array {
  const out = new Int32Array(scene.nodes.length).fill(-1);
  scene.nodes.forEach((n, i) => {
    for (const c of n.children) if (c >= 0 && c < out.length && out[c] < 0) out[c] = i;
  });
  return out;
}

/** Name path of every node reachable from the roots (undefined otherwise); unique per scene. */
function pathKeys(scene: IMeshScene): (string | undefined)[] {
  const keys = new Array<string | undefined>(scene.nodes.length);
  const visit = (siblings: readonly number[], prefix: string): void => {
    const rank = new Map<string, number>();
    for (const n of siblings) {
      if (n < 0 || n >= keys.length || keys[n] !== undefined) continue;
      const name = scene.nodes[n].name ?? '';
      const r = rank.get(name) ?? 0;
      rank.set(name, r + 1);
      keys[n] = `${prefix}/${name.replace(/[\\/#]/g, '\\$&')}#${r}`;
      visit(scene.nodes[n].children, keys[n]!);
    }
  };
  visit(scene.roots, '');
  return keys;
}

/** For every node of `side`, the matching node of `skeleton` (-1 = none). */
function matchNodes(skeleton: IMeshScene, side: IMeshScene): Int32Array {
  const out = new Int32Array(side.nodes.length).fill(-1);
  const taken = new Uint8Array(skeleton.nodes.length);
  const byKey = new Map<string, number>();
  pathKeys(skeleton).forEach((k, i) => k !== undefined && byKey.set(k, i));
  const sideKeys = pathKeys(side);
  sideKeys.forEach((k, i) => {
    const j = k === undefined ? undefined : byKey.get(k);
    if (j !== undefined) {
      out[i] = j;
      taken[j] = 1;
    }
  });
  // Fallback (e.g. a renamed node): the same index under corresponding parents, top-down.
  const pA = parents(skeleton);
  const pB = parents(side);
  const visit = (n: number): void => {
    if (out[n] < 0 && n < skeleton.nodes.length && !taken[n]) {
      const same = pB[n] < 0 ? pA[n] < 0 && skeleton.roots.includes(n) : out[pB[n]] === pA[n];
      if (same) {
        out[n] = n;
        taken[n] = 1;
      }
    }
    for (const c of side.nodes[n].children) if (c >= 0 && c < side.nodes.length && c !== n) visit(c);
  };
  for (const r of side.roots) if (r >= 0 && r < side.nodes.length) visit(r);
  return out;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

interface MergedNode {
  name?: string;
  children: number[];
  transform: SceneTransform;
  mesh?: number;
  baked?: ISceneNode['baked'];
  /** Index in the skeleton, or -1 for a node brought in from a side. */
  skeleton: number;
}

function mergeScene(plan: IMergePlan, inputs: IMesh[], mesh: IMesh, prov: IMergeProvenance, global: IRigid): IMeshScene {
  const k0 = inputs.findIndex((m) => m.scene);
  const skeleton = inputs[k0].scene!;
  const nodes: MergedNode[] = skeleton.nodes.map((n, i) => {
    const out: MergedNode = { children: [...n.children], transform: copyTransform(n), skeleton: i };
    if (n.name !== undefined) out.name = n.name;
    if (n.mesh !== undefined) out.mesh = n.mesh;
    if (n.baked) out.baked = [...n.baked];
    return out;
  });
  const roots = [...skeleton.roots];
  const meshes: ISceneMesh[] = skeleton.meshes.map((m) => ({ ...m }));

  // Node and mesh maps from each input into the merged scene.
  const nodeMap: (Int32Array | null)[] = inputs.map((m, k) => {
    if (!m.scene) return null;
    return k === k0 ? Int32Array.from(m.scene.nodes, (_, i) => i) : matchNodes(skeleton, m.scene);
  });
  const meshMap: (Map<number, number> | null)[] = inputs.map((m, k) => {
    if (!m.scene) return null;
    const map = new Map<number, number>();
    m.scene.nodes.forEach((n, i) => {
      const j = nodeMap[k]![i];
      const target = j >= 0 ? nodes[j].mesh : undefined;
      if (n.mesh !== undefined && target !== undefined && !map.has(n.mesh)) map.set(n.mesh, target);
    });
    return map;
  });
  const sideParents = inputs.map((m) => (m.scene ? parents(m.scene) : null));

  /** Merged node of input k's node n, bringing it (and unmatched ancestors) in when needed. */
  const mapNode = (k: number, n: number, depth = 0): number => {
    const map = nodeMap[k]!;
    if (map[n] >= 0) return map[n];
    const src = inputs[k].scene!.nodes[n];
    const parent = sideParents[k]![n];
    // (The depth bound only guards a malformed, cyclic hierarchy: it then attaches at the root.)
    const mp = parent >= 0 && depth < nodeMap[k]!.length ? mapNode(k, parent, depth + 1) : -1;
    if (map[n] >= 0) return map[n]; // (reached through the cycle)
    const node: MergedNode = { children: [], transform: copyTransform(src), skeleton: -1 };
    if (src.name !== undefined) node.name = src.name;
    if (src.baked) node.baked = [...src.baked];
    if (src.mesh !== undefined) {
      let m = meshMap[k]!.get(src.mesh);
      if (m === undefined) {
        m = meshes.length;
        meshes.push({ ...inputs[k].scene!.meshes[src.mesh] });
        meshMap[k]!.set(src.mesh, m);
      }
      node.mesh = m;
    }
    const index = nodes.length;
    nodes.push(node);
    if (mp >= 0) nodes[mp].children.push(index);
    else roots.push(index);
    map[n] = index;
    return index;
  };

  // ---- Face sources ------------------------------------------------------------------------------
  const sources: ISceneSource[] = [];
  const sourceIndex = new Map<string, number>();
  const cached: Int32Array[] = inputs.map((m) => new Int32Array(m.scene ? m.scene.sources.length : 0).fill(-2));
  /** Merged source of input k's face i (-1 = none). */
  const sourceOf = (k: number, i: number): number => {
    const sc = inputs[k].scene;
    if (!sc) return -1;
    const s = sc.faceSources[i];
    if (s === undefined || s < 0) return -1;
    if (cached[k][s] !== -2) return cached[k][s];
    const node = mapNode(k, sc.sources[s].node);
    const primitive = sc.sources[s].primitive;
    const key = `${node}:${primitive}`;
    let index = sourceIndex.get(key);
    if (index === undefined) {
      index = sources.length;
      sourceIndex.set(key, index);
      sources.push({ node, primitive });
    }
    cached[k][s] = index;
    return index;
  };
  // A base face of a structure-less base: its image in a side with structure.
  const images = [null, plan.ours, plan.theirs].map((side) => {
    if (!side || !side.mesh.scene || inputs[0].scene) return null;
    const f = side.mesh.faces;
    const map = new Uint32TripleMap(side.mesh.faceCount);
    const t = [0, 0, 0];
    for (let i = 0; i < side.mesh.faceCount; i++) {
      t[0] = f[i * 3];
      t[1] = f[i * 3 + 1];
      t[2] = f[i * 3 + 2];
      t.sort((a, b) => a - b);
      map.getOrInsert(t[0], t[1], t[2], i);
    }
    return { side, map };
  });
  const viaImage = (face: number): number => {
    const bf = inputs[0].faces;
    for (let k = 1; k <= 2; k++) {
      const img = images[k];
      if (!img || !img.side.faceKept[face]) continue;
      const t = [img.side.map[bf[face * 3]], img.side.map[bf[face * 3 + 1]], img.side.map[bf[face * 3 + 2]]].sort((a, b) => a - b);
      const i = img.map.get(t[0], t[1], t[2]);
      if (i >= 0) return sourceOf(k, i);
    }
    return -1;
  };

  const nF = mesh.faceCount;
  const faceSources = new Int32Array(nF);
  let pending = 0;
  for (let f = 0; f < nF; f++) {
    const k = prov.faceSource[f];
    const i = prov.faceIndex[f];
    let s = sourceOf(k, i);
    if (s < 0 && k === 0) s = viaImage(i);
    faceSources[f] = s;
    if (s < 0) pending++;
  }
  if (pending > 0) attachByNeighbours(mesh, faceSources);

  // ---- Transforms (a base skeleton only: that is what the sides changed) --------------------------
  const skeletonWorlds = worldMatrices(skeleton.nodes, skeleton.roots);
  if (k0 === 0) chooseTransforms(plan, inputs, mesh, prov, global, nodes, roots, nodeMap, sources, faceSources, skeletonWorlds);

  // ---- Drop base nodes a side deleted that carry no faces any more -------------------------------
  const keep = k0 === 0 ? prunable(inputs, nodes, roots, nodeMap, sources, faceSources).map((p) => !p) : nodes.map(() => true);
  const newIndex = new Int32Array(nodes.length).fill(-1);
  let count = 0;
  keep.forEach((k, i) => {
    if (k) newIndex[i] = count++;
  });
  const worlds = worldMatrices(nodes.map((n) => ({ ...n.transform, children: n.children })), roots);
  const outNodes: ISceneNode[] = [];
  nodes.forEach((n, i) => {
    if (!keep[i]) return;
    const out: ISceneNode = {
      ...n.transform,
      children: n.children.filter((c) => keep[c]).map((c) => newIndex[c]),
      world: worlds[i] ? (Array.from(worlds[i]!.elements) as Mat4) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
    if (n.name !== undefined) out.name = n.name;
    if (n.mesh !== undefined) out.mesh = n.mesh;
    if (n.baked?.length) out.baked = n.baked;
    outNodes.push(out);
  });
  const scene: IMeshScene = {
    nodes: outNodes,
    roots: roots.filter((r) => keep[r]).map((r) => newIndex[r]),
    meshes,
    sources: sources.map((s) => ({ node: newIndex[s.node], primitive: s.primitive })),
    faceSources,
  };
  if (skeleton.name !== undefined) scene.name = skeleton.name;
  return scene;
}

/** Nodeless faces join the node + primitive of a face they share a vertex with (breadth-first). */
function attachByNeighbours(mesh: IMesh, faceSources: Int32Array): void {
  const f = mesh.faces;
  const nV = mesh.vertexCount;
  const vertexSource = new Int32Array(nV).fill(-1);
  const start = new Int32Array(nV + 1);
  for (let i = 0; i < faceSources.length; i++) {
    for (let c = 0; c < 3; c++) {
      const v = f[i * 3 + c];
      if (faceSources[i] >= 0) {
        if (vertexSource[v] < 0) vertexSource[v] = faceSources[i];
      } else start[v + 1]++;
    }
  }
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nV);
  const adjacent = new Int32Array(start[nV]);
  const queue: number[] = [];
  for (let i = 0; i < faceSources.length; i++) {
    if (faceSources[i] >= 0) continue;
    let touches = false;
    for (let c = 0; c < 3; c++) {
      const v = f[i * 3 + c];
      adjacent[fill[v]++] = i;
      if (vertexSource[v] >= 0) touches = true;
    }
    if (touches) queue.push(i);
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    if (faceSources[i] >= 0) continue;
    let s = -1;
    for (let c = 0; c < 3 && s < 0; c++) s = vertexSource[f[i * 3 + c]];
    faceSources[i] = s;
    for (let c = 0; c < 3; c++) {
      const v = f[i * 3 + c];
      if (vertexSource[v] >= 0) continue;
      vertexSource[v] = s;
      for (let a = start[v]; a < start[v + 1]; a++) if (faceSources[adjacent[a]] < 0) queue.push(adjacent[a]);
    }
  }
}

/**
 * Per skeleton node (top-down), take a side's changed local transform when it explains the merged
 * geometry better than the base's (see the module comment). Mutates `nodes[].transform`.
 */
function chooseTransforms(
  plan: IMergePlan,
  inputs: IMesh[],
  mesh: IMesh,
  prov: IMergeProvenance,
  global: IRigid,
  nodes: MergedNode[],
  roots: number[],
  nodeMap: (Int32Array | null)[],
  sources: ISceneSource[],
  faceSources: Int32Array,
  baseWorlds: (Matrix4 | undefined)[],
): void {
  // Candidates: the base transform plus each side's different one.
  const candidates: SceneTransform[][] = nodes.map((n) => [n.transform]);
  let any = false;
  for (let k = 1; k <= 2; k++) {
    const map = nodeMap[k];
    if (!map) continue;
    map.forEach((j, i) => {
      if (j < 0 || nodes[j].skeleton < 0) return;
      const t = inputs[k].scene!.nodes[i];
      if (candidates[j].some((c) => sameTransform(c, t))) return;
      candidates[j].push(copyTransform(t));
      any = true;
    });
  }
  if (!any) return;

  // Corners of base vertices, per node (merged vertex index, repeated per corner).
  const corners: number[][] = nodes.map(() => []);
  const f = mesh.faces;
  for (let i = 0; i < faceSources.length; i++) {
    const s = faceSources[i];
    if (s < 0) continue;
    const list = corners[sources[s].node];
    for (let c = 0; c < 3; c++) {
      const v = f[i * 3 + c];
      if (prov.vertexSource[v] === 0) list.push(v);
    }
  }
  const eps = plan.eps * global.s;
  const bp = plan.base.positions;
  const mp = mesh.positions;
  /** Base vertices of n's subtree that `delta` (world → world) carries onto their merged position. */
  const score = (n: number, delta: ArrayLike<number>): number => {
    let hits = 0;
    const stack = [n];
    while (stack.length) {
      const d = stack.pop()!;
      for (const v of corners[d]) {
        const b = prov.vertexIndex[v] * 3;
        const x = bp[b];
        const y = bp[b + 1];
        const z = bp[b + 2];
        const e = delta;
        if (
          Math.abs(e[0] * x + e[4] * y + e[8] * z + e[12] - mp[v * 3]) <= eps &&
          Math.abs(e[1] * x + e[5] * y + e[9] * z + e[13] - mp[v * 3 + 1]) <= eps &&
          Math.abs(e[2] * x + e[6] * y + e[10] * z + e[14] - mp[v * 3 + 2]) <= eps
        ) {
          hits++;
        }
      }
      for (const c of nodes[d].children) stack.push(c);
    }
    return hits;
  };

  const visit = (n: number, parentWorld: Matrix4): void => {
    const node = nodes[n];
    const cands = candidates[n];
    const base = node.skeleton >= 0 ? baseWorlds[node.skeleton] : undefined;
    if (cands.length > 1 && base && base.determinant() !== 0) {
      const baseInverse = base.clone().invert();
      let best = -1;
      for (const c of cands) {
        const delta = parentWorld.clone().multiply(nodeLocalMatrix(c)).multiply(baseInverse);
        const s = score(n, delta.elements);
        if (s > best) {
          best = s;
          node.transform = c;
        }
      }
    }
    const world = parentWorld.clone().multiply(nodeLocalMatrix(node.transform));
    for (const c of node.children) visit(c, world);
  };
  const identity = nodeLocalMatrix({});
  for (const r of roots) visit(r, identity);
}

/** Base nodes to drop: no faces in their subtree, deleted by a side, deleted or unchanged on the other. */
function prunable(
  inputs: IMesh[],
  nodes: MergedNode[],
  roots: number[],
  nodeMap: (Int32Array | null)[],
  sources: ISceneSource[],
  faceSources: Int32Array,
): boolean[] {
  const faces = new Int32Array(nodes.length);
  for (const s of faceSources) if (s >= 0) faces[sources[s].node]++;
  // Side node of every skeleton node (-1 = deleted there).
  const sideOf = [1, 2].map((k) => {
    const map = nodeMap[k];
    if (!map) return null;
    const inv = new Int32Array(nodes.length).fill(-1);
    map.forEach((j, i) => {
      if (j >= 0 && inv[j] < 0) inv[j] = i;
    });
    return inv;
  });
  const drop = new Array<boolean>(nodes.length).fill(false);
  const visit = (n: number): boolean => {
    let all = true;
    for (const c of nodes[n].children) all = visit(c) && all;
    const node = nodes[n];
    if (!all || faces[n] > 0 || node.skeleton < 0) return false;
    const base = inputs[0].scene!.nodes[node.skeleton];
    let deleted = 0;
    let objects = 0;
    sideOf.forEach((inv, s) => {
      if (!inv) return;
      const i = inv[n];
      if (i < 0) deleted++;
      else {
        const t = inputs[s + 1].scene!.nodes[i];
        if (!sameTransform(t, base) || t.name !== base.name) objects++;
      }
    });
    drop[n] = deleted > 0 && objects === 0;
    return drop[n];
  };
  for (const r of roots) visit(r);
  return drop;
}
