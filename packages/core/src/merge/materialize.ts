/**
 * MATERIALISATION — a merge plan + one resolution per conflict region → the merged mesh.
 *
 * Per base vertex v (docs/merge-design.md §3, §5):
 *   outside every region:  deleted if either side deleted it; δ = the side that moved it
 *                          (both → identical by construction); position Φ_M(v)(p_O + δ)
 *   in a region, 'ours':   exactly ours' state (deleted / δ_A); 'theirs' symmetric;
 *   'base' / unresolved:   the base state (kept, δ = 0).
 * Base faces: kept outside regions iff both sides kept them; in a region per the chosen side.
 * Added faces: included when not in a region, or the region chose their side; identical
 * additions of both sides are emitted once (from ours).
 * Frames: Φ_M(c) = T_M ∘ R_M,c. A part whose frame belongs to a region (a part-motion conflict,
 * or a part motion involved in a collision) takes the region's choice: ours' R, theirs' R, or none.
 */
import { componentVertices } from '../diff/components.js';
import { applyRigid, composeRigid, identityRigid, type IRigid } from '../diff/linalg.js';
import { createMesh, groupIndexOfFace } from '../mesh.js';
import type { IMergeProvenance, IMergeStats, IMesh, IMeshGroup, MergeResolution } from '../types.js';
import type { IMergePlan } from './plan.js';
import type { ISide } from './sides.js';

export interface IMaterialized {
  mesh: IMesh;
  provenance: IMergeProvenance;
  stats: Omit<IMergeStats, 'conflicts' | 'unresolved'>;
  /** Global frame actually applied. */
  global: IRigid;
  /** Local residual applied to each base vertex (base frame, xyz; 0 when unmoved or deleted). */
  delta: Float64Array;
  /** Relative part frame R_M,c applied per base component (absent = identity). */
  partFrames: Map<number, IRigid>;
}

export interface IResolutions {
  region: (id: number) => MergeResolution | null;
  global: MergeResolution | null;
  lineage: MergeResolution | null;
}

function emptyStats(): IMaterialized['stats'] {
  return {
    movedFromOurs: 0,
    movedFromTheirs: 0,
    movedConvergent: 0,
    deletedFromOurs: 0,
    deletedFromTheirs: 0,
    deletedConvergent: 0,
    facesAddedFromOurs: 0,
    facesAddedFromTheirs: 0,
    facesAddedConvergent: 0,
    facesRemoved: 0,
    partMotionsFromOurs: 0,
    partMotionsFromTheirs: 0,
  };
}

/** Group runs for a face list whose group names come from `nameOf(face)`. */
class GroupBuilder {
  readonly groups: IMeshGroup[] = [];
  private count = 0;
  push(name: string): void {
    const last = this.groups[this.groups.length - 1];
    if (last && last.name === name) last.faceCount++;
    else this.groups.push({ name, faceStart: this.count, faceCount: 1 });
    this.count++;
  }
}

function copyMesh(m: IMesh, source: 0 | 1 | 2): IMaterialized {
  const nV = m.vertexCount;
  const nF = m.faceCount;
  const mesh = createMesh(Float64Array.from(m.positions), Uint32Array.from(m.faces), {
    groups: m.groups.map((g) => ({ ...g })),
    metadata: { ...m.metadata, sourceName: 'merged' },
  });
  return {
    mesh,
    provenance: {
      vertexSource: new Uint8Array(nV).fill(source),
      vertexIndex: Int32Array.from({ length: nV }, (_, i) => i),
      vertexChangedBy: new Uint8Array(nV).fill(source === 0 ? 0 : source === 1 ? 1 : 2),
      faceSource: new Uint8Array(nF).fill(source),
      faceIndex: Int32Array.from({ length: nF }, (_, i) => i),
      vertexConflict: new Int32Array(nV).fill(source === 0 ? 0 : -1),
    },
    stats: emptyStats(),
    global: identityRigid(),
    delta: new Float64Array(0),
    partFrames: new Map(),
  };
}

export function materialize(plan: IMergePlan, res: IResolutions): IMaterialized {
  const { base, ours, theirs } = plan;
  if (plan.lineage !== null) {
    const r = res.lineage;
    return r === 'ours' ? copyMesh(ours.mesh, 1) : r === 'theirs' ? copyMesh(theirs.mesh, 2) : copyMesh(base, 0);
  }
  const stats = emptyStats();
  const nO = base.vertexCount;

  // ---- Frames --------------------------------------------------------------------------------
  const T =
    plan.global.merged ??
    (res.global === 'ours' ? plan.global.ours : res.global === 'theirs' ? plan.global.theirs : identityRigid());
  const partRegion = new Map<number, number>();
  for (const r of plan.regions) for (const c of r.partComponents) partRegion.set(c, r.id);
  const frameOf = new Map<number, IRigid>();
  const partFrames = new Map<number, IRigid>();
  const phi = (c: number): IRigid => {
    let g = frameOf.get(c);
    if (g) return g;
    const d = c >= 0 ? plan.parts.get(c) : undefined;
    let R: IRigid | null = null;
    if (d) {
      const region = partRegion.get(c);
      // A frame inside a region follows the region's choice (unresolved = base = no motion).
      const src = region !== undefined ? res.region(region) : d.source;
      R = region !== undefined ? (src === 'ours' ? d.ours : src === 'theirs' ? d.theirs : null) : d.merged;
      if (R) {
        partFrames.set(c, R);
        if (src === 'ours' && ours.partMotion.has(c)) stats.partMotionsFromOurs++;
        else if (src === 'theirs' && theirs.partMotion.has(c)) stats.partMotionsFromTheirs++;
      }
    }
    g = R ? composeRigid(T, R) : T;
    frameOf.set(c, g);
    return g;
  };
  // Count part motions once (frames are created lazily per component).
  for (const c of plan.parts.keys()) phi(c);

  // ---- Base vertices ---------------------------------------------------------------------------
  const deleted = new Uint8Array(nO);
  const changedBy = new Uint8Array(nO);
  const delta = new Float64Array(nO * 3);
  const choose = (side: ISide, v: number, bit: number): void => {
    if (side.deleted[v]) deleted[v] = 1;
    else if (side.moved[v]) {
      delta.set(side.delta.subarray(v * 3, v * 3 + 3), v * 3);
    }
    if (side.deleted[v] || side.moved[v]) changedBy[v] |= bit;
  };
  for (let v = 0; v < nO; v++) {
    const r = plan.regionOfBase[v];
    if (r >= 0) {
      const choice = res.region(r);
      if (choice === 'ours') choose(ours, v, 1);
      else if (choice === 'theirs') choose(theirs, v, 2);
      continue;
    }
    const dA = ours.deleted[v];
    const dB = theirs.deleted[v];
    if (dA || dB) {
      deleted[v] = 1;
      changedBy[v] = (dA ? 1 : 0) | (dB ? 2 : 0);
      if (dA && dB) stats.deletedConvergent++;
      else if (dA) stats.deletedFromOurs++;
      else stats.deletedFromTheirs++;
      continue;
    }
    const mA = ours.moved[v];
    const mB = theirs.moved[v];
    if (mA) delta.set(ours.delta.subarray(v * 3, v * 3 + 3), v * 3);
    else if (mB) delta.set(theirs.delta.subarray(v * 3, v * 3 + 3), v * 3);
    changedBy[v] = (mA ? 1 : 0) | (mB ? 2 : 0);
    if (mA && mB) stats.movedConvergent++;
    else if (mA) stats.movedFromOurs++;
    else if (mB) stats.movedFromTheirs++;
  }

  const positions: number[] = [];
  const vSource: number[] = [];
  const vIndex: number[] = [];
  const vChanged: number[] = [];
  const vConflict: number[] = [];
  const mergedOfBase = new Int32Array(nO).fill(-1);
  const q = new Float64Array(3);
  const bp = base.positions;
  for (let v = 0; v < nO; v++) {
    if (deleted[v]) continue;
    applyRigid(phi(plan.baseComponents.id[v]), bp[v * 3] + delta[v * 3], bp[v * 3 + 1] + delta[v * 3 + 1], bp[v * 3 + 2] + delta[v * 3 + 2], q);
    mergedOfBase[v] = positions.length / 3;
    positions.push(q[0], q[1], q[2]);
    vSource.push(0);
    vIndex.push(v);
    vChanged.push(changedBy[v]);
    vConflict.push(plan.regionOfBase[v]);
  }

  // ---- Base faces ------------------------------------------------------------------------------
  const faces: number[] = [];
  const fSource: number[] = [];
  const fIndex: number[] = [];
  const groups = new GroupBuilder();
  const bf = base.faces;
  for (let f = 0; f < base.faceCount; f++) {
    const a = bf[f * 3];
    const b = bf[f * 3 + 1];
    const c = bf[f * 3 + 2];
    let r = plan.regionOfBase[a];
    if (r < 0) r = plan.regionOfBase[b];
    if (r < 0) r = plan.regionOfBase[c];
    const kA = ours.faceKept[f];
    const kB = theirs.faceKept[f];
    let keep: boolean;
    if (r < 0) keep = !!(kA && kB);
    else {
      const choice = res.region(r);
      keep = choice === 'ours' ? !!kA : choice === 'theirs' ? !!kB : true;
    }
    const ma = mergedOfBase[a];
    const mb = mergedOfBase[b];
    const mc = mergedOfBase[c];
    if (!keep || ma < 0 || mb < 0 || mc < 0) {
      stats.facesRemoved++;
      continue;
    }
    faces.push(ma, mb, mc);
    fSource.push(0);
    fIndex.push(f);
    groups.push(base.groups[groupIndexOfFace(base, f)]?.name ?? 'default');
  }

  // ---- Additions -------------------------------------------------------------------------------
  const oursAddedMerged = new Int32Array(ours.mesh.vertexCount).fill(-1);
  const theirsAddedMerged = new Int32Array(theirs.mesh.vertexCount).fill(-1);
  const addVertex = (side: ISide, t: number, src: 1 | 2, pos: Float64Array, region: number): number => {
    applyRigid(phi(side.anchorComponent[t]), pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2], q);
    const idx = positions.length / 3;
    positions.push(q[0], q[1], q[2]);
    vSource.push(src);
    vIndex.push(t);
    vChanged.push(src);
    vConflict.push(region);
    return idx;
  };
  const vertexFor = (side: ISide, t: number, region: number): number => {
    const b = side.inv[t];
    if (b >= 0) return mergedOfBase[b];
    if (side === ours) {
      if (oursAddedMerged[t] < 0) oursAddedMerged[t] = addVertex(ours, t, 1, plan.oursAddedPos, region);
      return oursAddedMerged[t];
    }
    const u = plan.unified[t];
    if (u >= 0) {
      if (oursAddedMerged[u] < 0) oursAddedMerged[u] = addVertex(ours, u, 1, plan.oursAddedPos, region);
      return oursAddedMerged[u];
    }
    if (theirsAddedMerged[t] < 0) theirsAddedMerged[t] = addVertex(theirs, t, 2, plan.theirsAddedPos, region);
    return theirsAddedMerged[t];
  };
  const emit = (side: ISide, src: 1 | 2): void => {
    const regionOf = side === ours ? plan.regionOfOursFace : plan.regionOfTheirsFace;
    const convergent = side === ours ? plan.oursConvergent : plan.theirsConvergent;
    const F = side.mesh.faces;
    for (const f of side.addedFaces) {
      const r = regionOf[f];
      const choice = r >= 0 ? res.region(r) : null;
      const both = !!convergent[f];
      if (src === 2 && both) continue; // emitted once, from ours
      let include: boolean;
      if (r < 0) include = true;
      else if (both) include = choice === 'ours' || choice === 'theirs';
      else include = choice === (src === 1 ? 'ours' : 'theirs');
      if (!include) continue;
      const tri = [vertexFor(side, F[f * 3], r), vertexFor(side, F[f * 3 + 1], r), vertexFor(side, F[f * 3 + 2], r)];
      if (tri.some((x) => x < 0)) continue; // an anchor was deleted by the chosen resolution
      faces.push(tri[0], tri[1], tri[2]);
      fSource.push(src);
      fIndex.push(f);
      groups.push(side.mesh.groups[groupIndexOfFace(side.mesh, f)]?.name ?? side.name);
      if (both) stats.facesAddedConvergent++;
      else if (src === 1) stats.facesAddedFromOurs++;
      else stats.facesAddedFromTheirs++;
    }
  };
  emit(ours, 1);
  emit(theirs, 2);

  // Vertices every face around which was removed (different faces by each side) are dropped:
  // an IMesh has no unreferenced vertices.
  const used = new Uint8Array(positions.length / 3);
  for (const f of faces) used[f] = 1;
  if (used.some((u) => u === 0)) {
    const remap = new Int32Array(used.length).fill(-1);
    let n = 0;
    for (let i = 0; i < used.length; i++) {
      if (!used[i]) continue;
      remap[i] = n;
      if (n !== i) {
        positions[n * 3] = positions[i * 3];
        positions[n * 3 + 1] = positions[i * 3 + 1];
        positions[n * 3 + 2] = positions[i * 3 + 2];
        vSource[n] = vSource[i];
        vIndex[n] = vIndex[i];
        vChanged[n] = vChanged[i];
        vConflict[n] = vConflict[i];
      }
      n++;
    }
    positions.length = n * 3;
    vSource.length = vIndex.length = vChanged.length = vConflict.length = n;
    for (let k = 0; k < faces.length; k++) faces[k] = remap[faces[k]];
  }

  const mesh = createMesh(positions, faces, {
    groups: groups.groups.length > 0 ? groups.groups : undefined,
    metadata: { format: base.metadata.format, sourceName: 'merged' },
  });
  return {
    mesh,
    provenance: {
      vertexSource: Uint8Array.from(vSource),
      vertexIndex: Int32Array.from(vIndex),
      vertexChangedBy: Uint8Array.from(vChanged),
      faceSource: Uint8Array.from(fSource),
      faceIndex: Int32Array.from(fIndex),
      vertexConflict: Int32Array.from(vConflict),
    },
    stats,
    global: T,
    delta,
    partFrames,
  };
}

/** Base vertices of a component (re-exported helper for conflict descriptions). */
export { componentVertices };
