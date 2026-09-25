/**
 * Reference implementations used to DERIVE fixture expectations (generator) and to
 * cross-check them against three.js-loaded data (selfcheck) and engine output (e2e).
 *
 * These are deliberately small, independent re-statements of the contract in
 * packages/core/src/types.ts — they do not import polymerge's parsers or engine.
 */
import type { IDiffStats, Vec3 } from '../../packages/core/src/types.js';
import { FaceStatus, VertexStatus } from '../../packages/core/src/types.js';
import type { CornerTri } from './documents.js';
import type { Tri } from './kmesh.js';
import { applyMat4, boundsDiagonal, distance, f32 } from './math.js';

// ---------------------------------------------------------------------------
// Welding (NORMALISATION CONTRACT, steps 3–6)
// ---------------------------------------------------------------------------

export interface WeldedMesh {
  /** float32-exact positions, in first-appearance order of the triangle stream. */
  positions: Vec3[];
  /** Logical key of each welded vertex (null when the stream carried none). */
  keys: (string | null)[];
  faces: Tri[];
  sourceFaceCount: number;
  degenerateDropped: number;
}

export interface WeldCorner {
  p: readonly number[];
  key?: string | null;
}

export function positionKey(p: readonly number[]): string {
  // String(-0) === "0", so -0 and 0 share a key (the contract says -0 === 0).
  return `${f32(p[0])},${f32(p[1])},${f32(p[2])}`;
}

/**
 * Exact float32 welding in first-appearance order; triangles whose welded corners
 * are not 3 distinct vertices are dropped.
 *
 * Strictness for fixture construction (`strictKeys`):
 *  - two corners with different logical keys must never weld (no accidental welds);
 *  - one logical key must never appear at two positions;
 *  - a degenerate triangle must not be the first appearance of any vertex, so the
 *    contract's step 4/5/6 ordering is unambiguous for our files.
 */
export function weld(stream: readonly (readonly WeldCorner[])[], strictKeys = true): WeldedMesh {
  const byPos = new Map<string, number>();
  const posOfKey = new Map<string, string>();
  const positions: Vec3[] = [];
  const keys: (string | null)[] = [];
  const faces: Tri[] = [];
  let degenerateDropped = 0;
  for (const tri of stream) {
    const idx: number[] = [];
    let introduced = 0;
    for (const c of tri) {
      const pk = positionKey(c.p);
      const key = c.key ?? null;
      let i = byPos.get(pk);
      if (i === undefined) {
        i = positions.length;
        byPos.set(pk, i);
        positions.push([f32(c.p[0]), f32(c.p[1]), f32(c.p[2])]);
        keys.push(key);
        introduced++;
      } else if (strictKeys && keys[i] !== key) {
        throw new Error(`weld: accidental weld of ${key} onto ${keys[i]} at ${pk}`);
      }
      if (strictKeys && key !== null) {
        const prev = posOfKey.get(key);
        if (prev !== undefined && prev !== pk) throw new Error(`weld: key ${key} appears at two positions (${prev} / ${pk})`);
        posOfKey.set(key, pk);
      }
      idx.push(i);
    }
    if (idx[0] !== idx[1] && idx[1] !== idx[2] && idx[0] !== idx[2]) {
      faces.push([idx[0], idx[1], idx[2]]);
    } else {
      degenerateDropped++;
      if (strictKeys && introduced > 0) throw new Error('weld: a degenerate triangle introduces a new vertex (ambiguous order)');
    }
  }
  // Step 6: vertices referenced only by dropped triangles do not exist. With the
  // strict rule above that set is empty; compact defensively in the lax mode.
  const used = new Array<boolean>(positions.length).fill(false);
  for (const f of faces) for (const v of f) used[v] = true;
  if (used.every(Boolean)) return { positions, keys, faces, sourceFaceCount: stream.length, degenerateDropped };
  const remap = new Array<number>(positions.length).fill(-1);
  const p2: Vec3[] = [];
  const k2: (string | null)[] = [];
  positions.forEach((p, i) => {
    if (!used[i]) return;
    remap[i] = p2.length;
    p2.push(p);
    k2.push(keys[i]);
  });
  return {
    positions: p2,
    keys: k2,
    faces: faces.map((f) => [remap[f[0]], remap[f[1]], remap[f[2]]] as Tri),
    sourceFaceCount: stream.length,
    degenerateDropped,
  };
}

export function weldStream(stream: readonly CornerTri[]): WeldedMesh {
  return weld(stream);
}

// ---------------------------------------------------------------------------
// Status rules (IDiffResult doc comment)
// ---------------------------------------------------------------------------

export function faceKey(a: number, b: number, c: number): string {
  const s = [a, b, c].sort((x, y) => x - y);
  return `${s[0]},${s[1]},${s[2]}`;
}

/**
 * Face statuses from a vertex correspondence + vertex statuses, per the contract:
 *  target face: any vertex Added, or (tiers 1/2) mapped triple not a base face → Added;
 *               else any vertex Moved → Modified; else Unchanged.
 *  base face:   any vertex Removed, or (tiers 1/2) mapped triple not a target face → Removed;
 *               else any vertex Moved → Modified; else Unchanged.
 */
export function faceStatusesByContract(
  baseFaces: ArrayLike<number>,
  targetFaces: ArrayLike<number>,
  baseToTarget: ArrayLike<number>,
  targetToBase: ArrayLike<number>,
  baseVertexStatus: ArrayLike<number>,
  targetVertexStatus: ArrayLike<number>,
  checkTriples: boolean,
): { base: Uint8Array; target: Uint8Array } {
  const nb = baseFaces.length / 3;
  const nt = targetFaces.length / 3;
  const baseSet = new Set<string>();
  const targetSet = new Set<string>();
  for (let f = 0; f < nb; f++) baseSet.add(faceKey(baseFaces[3 * f], baseFaces[3 * f + 1], baseFaces[3 * f + 2]));
  for (let f = 0; f < nt; f++) targetSet.add(faceKey(targetFaces[3 * f], targetFaces[3 * f + 1], targetFaces[3 * f + 2]));
  const target = new Uint8Array(nt);
  for (let f = 0; f < nt; f++) {
    const v = [targetFaces[3 * f], targetFaces[3 * f + 1], targetFaces[3 * f + 2]];
    if (v.some((t) => targetVertexStatus[t] === VertexStatus.Added)) target[f] = FaceStatus.Added;
    else if (checkTriples && (v.some((t) => targetToBase[t] < 0) || !baseSet.has(faceKey(targetToBase[v[0]], targetToBase[v[1]], targetToBase[v[2]]))))
      target[f] = FaceStatus.Added;
    else if (v.some((t) => targetVertexStatus[t] === VertexStatus.Moved)) target[f] = FaceStatus.Modified;
    else target[f] = FaceStatus.Unchanged;
  }
  const base = new Uint8Array(nb);
  for (let f = 0; f < nb; f++) {
    const v = [baseFaces[3 * f], baseFaces[3 * f + 1], baseFaces[3 * f + 2]];
    if (v.some((b) => baseVertexStatus[b] === VertexStatus.Removed)) base[f] = FaceStatus.Removed;
    else if (checkTriples && (v.some((b) => baseToTarget[b] < 0) || !targetSet.has(faceKey(baseToTarget[v[0]], baseToTarget[v[1]], baseToTarget[v[2]]))))
      base[f] = FaceStatus.Removed;
    else if (v.some((b) => baseVertexStatus[b] === VertexStatus.Moved)) base[f] = FaceStatus.Modified;
    else base[f] = FaceStatus.Unchanged;
  }
  return { base, target };
}

export function countCodes(codes: ArrayLike<number>): [number, number, number, number] {
  const c: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < codes.length; i++) c[codes[i]]++;
  return c;
}

export function flatFaces(faces: readonly Tri[]): Uint32Array {
  const out = new Uint32Array(faces.length * 3);
  faces.forEach((f, i) => out.set(f, i * 3));
  return out;
}

export interface ReferenceDiff {
  baseToTarget: Int32Array;
  targetToBase: Int32Array;
  baseVertexStatus: Uint8Array;
  targetVertexStatus: Uint8Array;
  baseFaceStatus: Uint8Array;
  targetFaceStatus: Uint8Array;
  /** Per target vertex |T·base[match] − target[t]| (0 when unmatched). */
  displacement: number[];
  moveEpsilon: number;
  stats: IDiffStats;
  /** Matched pairs [base, target], sorted by base index. */
  pairs: [number, number][];
}

/**
 * Ground-truth diff: correspondence = equal logical keys (optionally through `keyMap`,
 * base key → target key); statuses by the contract with the DEFAULT moveEpsilon
 * (1e-6 × larger bounds diagonal). `baseToTarget` (a rigid base→target matrix)
 * is applied to base positions before measuring displacement.
 */
export function referenceDiff(
  base: WeldedMesh,
  target: WeldedMesh,
  opts: { checkTriples: boolean; baseToTarget?: readonly number[]; keyMap?: (baseKey: string) => string | undefined } = {
    checkTriples: true,
  },
): ReferenceDiff {
  const nb = base.positions.length;
  const nt = target.positions.length;
  const moveEpsilon = 1e-6 * Math.max(boundsDiagonal(base.positions), boundsDiagonal(target.positions));
  const targetByKey = new Map<string, number>();
  target.keys.forEach((k, i) => {
    if (k === null) throw new Error('referenceDiff: target vertex without key');
    if (targetByKey.has(k)) throw new Error(`referenceDiff: duplicate target key ${k}`);
    targetByKey.set(k, i);
  });
  const b2t = new Int32Array(nb).fill(-1);
  const t2b = new Int32Array(nt).fill(-1);
  base.keys.forEach((k, b) => {
    if (k === null) throw new Error('referenceDiff: base vertex without key');
    const tk = opts.keyMap ? opts.keyMap(k) : k;
    const t = tk === undefined ? undefined : targetByKey.get(tk);
    if (t === undefined) return;
    if (t2b[t] >= 0) throw new Error(`referenceDiff: target vertex ${t} matched twice`);
    b2t[b] = t;
    t2b[t] = b;
  });
  const displacement = new Array<number>(nt).fill(0);
  const baseVS = new Uint8Array(nb);
  const targetVS = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const b = t2b[t];
    if (b < 0) {
      targetVS[t] = VertexStatus.Added;
      continue;
    }
    const from = opts.baseToTarget ? applyMat4(opts.baseToTarget, base.positions[b]) : base.positions[b];
    const d = distance(from, target.positions[t]);
    displacement[t] = d;
    targetVS[t] = d <= moveEpsilon ? VertexStatus.Unchanged : VertexStatus.Moved;
  }
  for (let b = 0; b < nb; b++) baseVS[b] = b2t[b] < 0 ? VertexStatus.Removed : targetVS[b2t[b]];
  const fs = faceStatusesByContract(flatFaces(base.faces), flatFaces(target.faces), b2t, t2b, baseVS, targetVS, opts.checkTriples);
  const tv = countCodes(targetVS);
  const bv = countCodes(baseVS);
  const tf = countCodes(fs.target);
  const bf = countCodes(fs.base);
  const moved = displacement.filter((_, t) => targetVS[t] === VertexStatus.Moved);
  const stats: IDiffStats = {
    vertices: { unchanged: tv[0], moved: tv[1], added: tv[2], removed: bv[3] },
    faces: { unchanged: tf[0], modified: tf[1], added: tf[2], removed: bf[3] },
    maxDisplacement: moved.length ? Math.max(...moved) : 0,
    meanDisplacement: moved.length ? moved.reduce((a, b) => a + b, 0) / moved.length : 0,
  };
  if (bv[0] !== tv[0] || bv[1] !== tv[1]) throw new Error('referenceDiff: asymmetric vertex counts');
  if (opts.checkTriples && (bf[0] !== tf[0] || bf[1] !== tf[1])) throw new Error('referenceDiff: asymmetric face counts');
  const pairs: [number, number][] = [];
  for (let b = 0; b < nb; b++) if (b2t[b] >= 0) pairs.push([b, b2t[b]]);
  return {
    baseToTarget: b2t,
    targetToBase: t2b,
    baseVertexStatus: baseVS,
    targetVertexStatus: targetVS,
    baseFaceStatus: fs.base,
    targetFaceStatus: fs.target,
    displacement,
    moveEpsilon,
    stats,
    pairs,
  };
}

/**
 * Fraction of target faces that are also base faces under the IDENTITY index map
 * (i.e. what a pure index-based Tier 1 would see).
 */
export function identityIndexFaceAgreement(base: WeldedMesh, target: WeldedMesh): number {
  const set = new Set(base.faces.map((f) => faceKey(f[0], f[1], f[2])));
  if (target.faces.length === 0) return 1;
  return target.faces.filter((f) => set.has(faceKey(f[0], f[1], f[2]))).length / target.faces.length;
}

/** Number of target vertices whose exact float32 position also exists in the base. */
export function exactPositionMatches(base: WeldedMesh, target: WeldedMesh): number {
  const set = new Set(base.positions.map(positionKey));
  return target.positions.filter((p) => set.has(positionKey(p))).length;
}

/** Max over `points` of the distance to the nearest triangle of `mesh` (brute force). */
export function maxSurfaceDistance(points: readonly (readonly number[])[], mesh: WeldedMesh, dist: (p: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[]) => number): number {
  let worst = 0;
  for (const p of points) {
    let best = Infinity;
    for (const f of mesh.faces) {
      const d = dist(p, mesh.positions[f[0]], mesh.positions[f[1]], mesh.positions[f[2]]);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best > worst) worst = best;
  }
  return worst;
}
