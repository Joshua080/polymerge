/**
 * UV machinery for the appearance merge (docs/appearance-merge-design.md §4, §5):
 *
 *   islands    faces glued along an edge whose two end corners carry the same UVs in both faces
 *              (per version, per UV set), via an exact edge hash — O(corners);
 *   overlap    positive-area overlap of two UV triangles (separating axes with an ε margin, so faces
 *              that merely share an edge or touch do not count), searched on a uniform grid over the
 *              candidate faces only.
 *
 * UVs are compared per coordinate within ε; NaN (no UV in that set) equals only NaN.
 */
import { hash3 } from '../diff/faceset.js';
import { Uint32TripleMap } from '../parsers/weld.js';

export class UnionFind {
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

/** Exact map from an unordered vertex triple to the first face with those vertices. */
export class FaceIndex {
  private readonly keys: Uint32Array;
  private readonly values: Int32Array;
  private readonly mask: number;

  constructor(faces: Uint32Array) {
    const n = Math.floor(faces.length / 3);
    let cap = 16;
    while (cap < n * 2) cap *= 2;
    this.keys = new Uint32Array(cap * 3);
    this.values = new Int32Array(cap).fill(-1);
    this.mask = cap - 1;
    const sorted = [0, 0, 0];
    for (let f = 0; f < n; f++) {
      sort3(faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2], sorted);
      const slot = this.slot(sorted);
      if (this.values[slot] >= 0) continue; // a duplicate face: the first one wins
      this.keys.set(sorted, slot * 3);
      this.values[slot] = f;
    }
  }

  /** Face with the unordered triple {a, b, c}, or -1. */
  get(a: number, b: number, c: number): number {
    const sorted = [0, 0, 0];
    sort3(a, b, c, sorted);
    return this.values[this.slot(sorted)];
  }

  /** Slot holding the sorted triple, or the empty slot where it would go. */
  private slot(t: number[]): number {
    const keys = this.keys;
    let slot = hash3(t[0], t[1], t[2]) & this.mask;
    for (;;) {
      const o = slot * 3;
      if (this.values[slot] < 0 || (keys[o] === t[0] && keys[o + 1] === t[1] && keys[o + 2] === t[2])) return slot;
      slot = (slot + 1) & this.mask;
    }
  }
}

function sort3(a: number, b: number, c: number, out: number[]): void {
  let t: number;
  if (a > b) (t = a), (a = b), (b = t);
  if (b > c) (t = b), (b = c), (c = t);
  if (a > b) (t = a), (a = b), (b = t);
  out[0] = a;
  out[1] = b;
  out[2] = c;
}

/** One corner's (u, v) in `a` at offset ia equals `b` at ib: within eps per coordinate, NaN only equal to NaN. */
export function sameCornerUv(a: ArrayLike<number>, ia: number, b: ArrayLike<number>, ib: number, eps: number): boolean {
  for (let k = 0; k < 2; k++) {
    const x = a[ia + k];
    const y = b[ib + k];
    if (x !== x || y !== y) {
      if ((x !== x) !== (y !== y)) return false;
    } else if (Math.abs(x - y) > eps) return false;
  }
  return true;
}

/** Three corners (6 values) equal, see {@link sameCornerUv}. */
export function sameFaceUv(a: ArrayLike<number>, ia: number, b: ArrayLike<number>, ib: number, eps: number): boolean {
  return sameCornerUv(a, ia, b, ib, eps) && sameCornerUv(a, ia + 2, b, ib + 2, eps) && sameCornerUv(a, ia + 4, b, ib + 4, eps);
}

/**
 * Glue the faces of a mesh into UV islands for one UV set: calls `glue(f, g)` for every pair of
 * faces sharing an edge whose end corners carry the same UVs in both (`uv` is per face corner). On
 * a non-manifold edge every later face is compared with the first one.
 */
export function glueIslands(faces: Uint32Array, faceCount: number, uv: Float32Array, eps: number, glue: (f: number, g: number) => void): void {
  const edges = new Uint32TripleMap(faceCount * 2);
  for (let f = 0; f < faceCount; f++) {
    for (let c = 0; c < 3; c++) {
      const a = faces[f * 3 + c];
      const b = faces[f * 3 + ((c + 1) % 3)];
      const value = f * 3 + c;
      const first = edges.getOrInsert(a < b ? a : b, a < b ? b : a, 0, value);
      if (first === value) continue;
      const g = (first / 3) | 0;
      const cg = first - g * 3;
      const ga = faces[first];
      // Corner of g holding vertex a, and of vertex b.
      const ia = ga === a ? cg : (cg + 1) % 3;
      const ib = ga === a ? (cg + 1) % 3 : cg;
      if (sameCornerUv(uv, (f * 3 + c) * 2, uv, (g * 3 + ia) * 2, eps) && sameCornerUv(uv, (f * 3 + ((c + 1) % 3)) * 2, uv, (g * 3 + ib) * 2, eps)) {
        glue(f, g);
      }
    }
  }
}

/** Twice the signed area of a UV triangle (6 values from offset o). */
function area2(t: ArrayLike<number>, o: number): number {
  return (t[o + 2] - t[o]) * (t[o + 5] - t[o + 1]) - (t[o + 4] - t[o]) * (t[o + 3] - t[o + 1]);
}

/** Separating axis along the normal of edge (i → j) of triangle `t` at offset o. */
function separated(t: ArrayLike<number>, o: number, i: number, j: number, p: ArrayLike<number>, po: number, q: ArrayLike<number>, qo: number, eps: number): boolean {
  const nx = -(t[o + j * 2 + 1] - t[o + i * 2 + 1]);
  const ny = t[o + j * 2] - t[o + i * 2];
  const len = Math.hypot(nx, ny);
  if (!(len > 0)) return false;
  let p0 = Infinity;
  let p1 = -Infinity;
  let q0 = Infinity;
  let q1 = -Infinity;
  for (let k = 0; k < 3; k++) {
    const dp = (p[po + k * 2] * nx + p[po + k * 2 + 1] * ny) / len;
    const dq = (q[qo + k * 2] * nx + q[qo + k * 2 + 1] * ny) / len;
    if (dp < p0) p0 = dp;
    if (dp > p1) p1 = dp;
    if (dq < q0) q0 = dq;
    if (dq > q1) q1 = dq;
  }
  return p1 <= q0 + eps || q1 <= p0 + eps;
}

/**
 * Two UV triangles overlap with positive area: no separating axis among their edge normals, with
 * an eps margin (so shared edges and mere touching do not count). Degenerate or NaN triangles never overlap.
 */
export function uvTrianglesOverlap(p: ArrayLike<number>, po: number, q: ArrayLike<number>, qo: number, eps: number): boolean {
  const ap = area2(p, po);
  const aq = area2(q, qo);
  if (!(Math.abs(ap) > eps * eps) || !(Math.abs(aq) > eps * eps)) return false;
  for (let e = 0; e < 3; e++) {
    if (separated(p, po, e, (e + 1) % 3, p, po, q, qo, eps)) return false;
    if (separated(q, qo, e, (e + 1) % 3, p, po, q, qo, eps)) return false;
  }
  return true;
}

export interface IUvOverlapSearch {
  /** Candidate triangles: 6 UV values each (record r at r * 6). */
  uv: Float32Array;
  count: number;
  /** Examine the pair (a < b)? Cheap filter applied before the geometric test. */
  consider: (a: number, b: number) => boolean;
  /** Called for every overlapping pair that passed `consider`; return false to stop. */
  hit: (a: number, b: number) => boolean;
  eps: number;
  /** Bound on geometric pair tests. */
  maxTests: number;
}

/**
 * Overlapping candidate pairs, on a uniform grid sized by the mean triangle extent; triangles
 * spanning more than 16 cells are tested against every candidate instead. Returns true when the
 * bound on pair tests was hit.
 */
export function searchUvOverlaps(s: IUvOverlapSearch): boolean {
  const { uv, count, eps } = s;
  if (count < 2) return false;
  const box = new Float64Array(count * 4);
  let extent = 0;
  let valid = 0;
  for (let r = 0; r < count; r++) {
    const o = r * 6;
    const x0 = Math.min(uv[o], uv[o + 2], uv[o + 4]);
    const y0 = Math.min(uv[o + 1], uv[o + 3], uv[o + 5]);
    const x1 = Math.max(uv[o], uv[o + 2], uv[o + 4]);
    const y1 = Math.max(uv[o + 1], uv[o + 3], uv[o + 5]);
    box.set([x0, y0, x1, y1], r * 4);
    if (Number.isFinite(x0 + y0 + x1 + y1)) {
      extent += Math.max(x1 - x0, y1 - y0);
      valid++;
    }
  }
  if (valid < 2) return false;
  const cell = Math.max((2 * extent) / valid, 1e-9);
  const finite = (r: number): boolean => Number.isFinite(box[r * 4] + box[r * 4 + 1] + box[r * 4 + 2] + box[r * 4 + 3]);
  const range = (r: number): [number, number, number, number] => {
    const o = r * 4;
    return [Math.floor(box[o] / cell), Math.floor(box[o + 1] / cell), Math.floor(box[o + 2] / cell), Math.floor(box[o + 3] / cell)];
  };
  const isBig = (r: number): boolean => {
    const [i0, j0, i1, j1] = range(r);
    return i1 - i0 > 16 || j1 - j0 > 16;
  };
  const grid = new Map<number, number[]>();
  const big: number[] = [];
  for (let r = 0; r < count; r++) {
    if (!finite(r)) continue;
    if (isBig(r)) {
      big.push(r);
      continue;
    }
    const [i0, j0, i1, j1] = range(r);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = i * 1_000_003 + j;
        const list = grid.get(key);
        if (list) list.push(r);
        else grid.set(key, [r]);
      }
    }
  }
  let tests = 0;
  let stop = false;
  /** Test the pair once (a < b); false = stop the search. */
  const test = (a: number, b: number): boolean => {
    const ao = a * 4;
    const bo = b * 4;
    if (box[ao + 2] < box[bo] || box[bo + 2] < box[ao] || box[ao + 3] < box[bo + 1] || box[bo + 3] < box[ao + 1]) return true;
    if (!s.consider(a, b)) return true;
    if (++tests > s.maxTests) return false;
    return !uvTrianglesOverlap(uv, a * 6, uv, b * 6, eps) || s.hit(a, b);
  };
  const seen = new Set<number>();
  for (let a = 0; a < count && !stop; a++) {
    if (!finite(a) || isBig(a)) continue;
    seen.clear();
    const [i0, j0, i1, j1] = range(a);
    for (let i = i0; i <= i1 && !stop; i++) {
      for (let j = j0; j <= j1 && !stop; j++) {
        for (const b of grid.get(i * 1_000_003 + j) ?? []) {
          if (b <= a || seen.has(b)) continue;
          seen.add(b);
          if (!test(a, b)) {
            stop = true;
            break;
          }
        }
      }
    }
  }
  // Big triangles against every other candidate (each pair once).
  const isBigSet = new Set(big);
  for (const a of big) {
    for (let b = 0; b < count && !stop; b++) {
      if (b === a || !finite(b) || (isBigSet.has(b) && b < a)) continue;
      if (!test(Math.min(a, b), Math.max(a, b))) stop = true;
    }
  }
  return tests > s.maxTests;
}
