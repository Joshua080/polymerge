/**
 * Spatial indices for the diff engine (pure TypeScript, no allocations per query):
 *
 *  - `KdTree`       — static tree over points; exact nearest neighbour with an optional
 *                     radius cap and exclusion mask.
 *  - `TriangleBvh`  — static AABB bounding-volume hierarchy over triangles; exact
 *                     closest point on the surface (Ericson's point–triangle test).
 *
 * Both are built the same way, in O(n) after one radix sort, which matters for million-
 * triangle meshes: the items are ordered along a Morton (Z-order) curve of their points /
 * triangle centroids, the sorted range is split at its middle down to small leaves, and each
 * node's tight bounding box is computed bottom-up from its children. The tree shape only
 * affects speed: every query is exact and breaks distance ties on the lowest index, so
 * results are deterministic and independent of the tree.
 */

/** Spread the low 10 bits of v so that bit i lands at bit 3i. */
function part1by2(v: number): number {
  let x = v & 0x3ff;
  x = (x | (x << 16)) & 0x030000ff;
  x = (x | (x << 8)) & 0x0300f00f;
  x = (x | (x << 4)) & 0x030c30c3;
  x = (x | (x << 2)) & 0x09249249;
  return x;
}

/**
 * Indices 0..n−1 ordered by the 30-bit Morton code of `keys[i·stride + 0..2]`, each axis
 * quantised to 1024 steps over its own extent, and the codes in that order. Stable (two 15-bit
 * counting-sort passes), so items with equal codes keep their index order.
 */
function mortonOrder(keys: Float64Array, stride: number, n: number): { order: Uint32Array; codes: Uint32Array } {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const x = keys[o];
    const y = keys[o + 1];
    const z = keys[o + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const sx = x1 > x0 ? 1023 / (x1 - x0) : 0;
  const sy = y1 > y0 ? 1023 / (y1 - y0) : 0;
  const sz = z1 > z0 ? 1023 / (z1 - z0) : 0;
  // NaN and out-of-range values clamp into 0..1023 (comparisons with NaN are false).
  const q = (v: number): number => (v >= 0 ? (v < 1023 ? v | 0 : 1023) : 0);
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    codes[i] = ((part1by2(q((keys[o] - x0) * sx)) << 2) | (part1by2(q((keys[o + 1] - y0) * sy)) << 1) | part1by2(q((keys[o + 2] - z0) * sz))) >>> 0;
  }
  let order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  let next = new Uint32Array(n);
  const count = new Uint32Array(1 << 15);
  for (const shift of [0, 15]) {
    count.fill(0);
    for (let i = 0; i < n; i++) count[(codes[order[i]] >>> shift) & 0x7fff]++;
    let sum = 0;
    for (let b = 0; b < count.length; b++) {
      const c = count[b];
      count[b] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const idx = order[i];
      next[count[(codes[idx] >>> shift) & 0x7fff]++] = idx;
    }
    const t = order;
    order = next;
    next = t;
  }
  // Codes in sorted order (reusing the spare buffer).
  for (let i = 0; i < n; i++) next[i] = codes[order[i]];
  return { order, codes: next };
}

/** Binary tree over n Morton-sorted items: node ranges [start, end), children, depth. */
interface ITopology {
  count: number;
  start: Uint32Array;
  end: Uint32Array;
  left: Int32Array;
  right: Int32Array;
  maxDepth: number;
}

/**
 * A binary radix tree over Morton-sorted codes: a range is split where its highest differing
 * code bit changes, so every node is a compact cell of the Z-order grid (an octree split into
 * halves) and sibling boxes barely overlap; a range of equal codes is halved. Ranges of at most
 * `leafSize` items are leaves. Nodes are numbered in pre-order, so every child has a larger
 * number than its parent (bottom-up passes run from the last node to the first).
 */
function buildTopology(codes: Uint32Array, n: number, leafSize: number): ITopology {
  let cap = Math.max(16, Math.ceil((4 * n) / Math.max(1, leafSize)));
  let start = new Uint32Array(cap);
  let end = new Uint32Array(cap);
  let left = new Int32Array(cap);
  let right = new Int32Array(cap);
  let count = 0;
  let maxDepth = 0;
  const grow = (): void => {
    cap *= 2;
    const s2 = new Uint32Array(cap);
    s2.set(start);
    start = s2;
    const e2 = new Uint32Array(cap);
    e2.set(end);
    end = e2;
    const l2 = new Int32Array(cap);
    l2.set(left);
    left = l2;
    const r2 = new Int32Array(cap);
    r2.set(right);
    right = r2;
  };
  const build = (s: number, e: number, depth: number): number => {
    if (count === cap) grow();
    const node = count++;
    start[node] = s;
    end[node] = e;
    left[node] = -1;
    right[node] = -1;
    if (depth > maxDepth) maxDepth = depth;
    if (e - s <= leafSize) return node;
    const first = codes[s];
    const last = codes[e - 1];
    let mid: number;
    if (first === last) mid = (s + e) >>> 1;
    else {
      // First index whose code has the highest differing bit set (codes are ascending).
      const bit = 31 - Math.clz32(first ^ last);
      let lo = s + 1;
      let hi = e - 1;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if ((codes[m] >>> bit) & 1) hi = m;
        else lo = m + 1;
      }
      mid = lo;
    }
    const l = build(s, mid, depth + 1);
    const r = build(mid, e, depth + 1);
    left[node] = l;
    right[node] = r;
    return node;
  };
  if (n > 0) build(0, n, 0);
  return { count, start: start.slice(0, count), end: end.slice(0, count), left: left.slice(0, count), right: right.slice(0, count), maxDepth };
}

/** Union of two child boxes into `node`'s box (6 values per node: min xyz, max xyz). */
function unionBoxes(box: Float64Array, node: number, l: number, r: number): void {
  const o = node * 6;
  const a = l * 6;
  const b = r * 6;
  for (let k = 0; k < 3; k++) {
    box[o + k] = box[a + k] < box[b + k] ? box[a + k] : box[b + k];
    box[o + 3 + k] = box[a + 3 + k] > box[b + 3 + k] ? box[a + 3 + k] : box[b + 3 + k];
  }
}

export class KdTree {
  readonly count: number;
  /** Squared distance of the last successful `nearest` query (Infinity if none). */
  lastDist2 = Infinity;

  /** Point coordinates in leaf order (rp[i] is point order[i]): leaves read contiguous memory. */
  private readonly rp: Float64Array;
  private readonly order: Uint32Array;
  private readonly start: Uint32Array;
  private readonly end: Uint32Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly box: Float64Array;
  private readonly stack: Int32Array;
  private readonly stackD: Float64Array;

  constructor(positions: Float64Array, leafSize = 10) {
    const n = Math.floor(positions.length / 3);
    this.count = n;
    const { order, codes } = mortonOrder(positions, 3, n);
    const rp = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = order[i] * 3;
      rp[i * 3] = positions[o];
      rp[i * 3 + 1] = positions[o + 1];
      rp[i * 3 + 2] = positions[o + 2];
    }
    const t = buildTopology(codes, n, leafSize);
    const box = new Float64Array(t.count * 6);
    for (let node = t.count - 1; node >= 0; node--) {
      const l = t.left[node];
      if (l >= 0) {
        unionBoxes(box, node, l, t.right[node]);
        continue;
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      for (let i = t.start[node], e = t.end[node]; i < e; i++) {
        const x = rp[i * 3];
        const y = rp[i * 3 + 1];
        const z = rp[i * 3 + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      const o = node * 6;
      box[o] = x0;
      box[o + 1] = y0;
      box[o + 2] = z0;
      box[o + 3] = x1;
      box[o + 4] = y1;
      box[o + 5] = z1;
    }
    this.rp = rp;
    this.order = order;
    this.start = t.start;
    this.end = t.end;
    this.left = t.left;
    this.right = t.right;
    this.box = box;
    this.stack = new Int32Array(2 * t.maxDepth + 8);
    this.stackD = new Float64Array(2 * t.maxDepth + 8);
  }

  private boxDist2(node: number, x: number, y: number, z: number): number {
    const b = this.box;
    const o = node * 6;
    let d = 0;
    let v = b[o] - x;
    if (v > 0) d += v * v;
    else {
      v = x - b[o + 3];
      if (v > 0) d += v * v;
    }
    v = b[o + 1] - y;
    if (v > 0) d += v * v;
    else {
      v = y - b[o + 4];
      if (v > 0) d += v * v;
    }
    v = b[o + 2] - z;
    if (v > 0) d += v * v;
    else {
      v = z - b[o + 5];
      if (v > 0) d += v * v;
    }
    return d;
  }

  /**
   * Index of the nearest point with squared distance ≤ maxDist2 (inclusive), skipping
   * points whose `skip[i]` is non-zero. Returns -1 if none. Ties → lowest index.
   */
  nearest(x: number, y: number, z: number, maxDist2 = Infinity, skip?: Uint8Array | null): number {
    this.lastDist2 = Infinity;
    if (this.count === 0) return -1;
    const rp = this.rp;
    const order = this.order;
    const stack = this.stack;
    const stackD = this.stackD;
    let best = maxDist2;
    let bestIdx = -1;
    let sp = 0;
    const d0 = this.boxDist2(0, x, y, z);
    if (d0 > best) return -1;
    stack[sp] = 0;
    stackD[sp++] = d0;
    while (sp > 0) {
      sp--;
      if (stackD[sp] > best) continue;
      const node = stack[sp];
      const l = this.left[node];
      if (l < 0) {
        const e = this.end[node];
        for (let i = this.start[node]; i < e; i++) {
          const idx = order[i];
          if (skip && skip[idx]) continue;
          const o = i * 3;
          const dx = rp[o] - x;
          const dy = rp[o + 1] - y;
          const dz = rp[o + 2] - z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < best || (d2 === best && (bestIdx < 0 || idx < bestIdx))) {
            best = d2;
            bestIdx = idx;
          }
        }
        continue;
      }
      const r = this.right[node];
      const dl = this.boxDist2(l, x, y, z);
      const dr = this.boxDist2(r, x, y, z);
      // Push the farther child first so the nearer one is explored first.
      if (dl <= dr) {
        if (dr <= best) {
          stack[sp] = r;
          stackD[sp++] = dr;
        }
        if (dl <= best) {
          stack[sp] = l;
          stackD[sp++] = dl;
        }
      } else {
        if (dl <= best) {
          stack[sp] = l;
          stackD[sp++] = dl;
        }
        if (dr <= best) {
          stack[sp] = r;
          stackD[sp++] = dr;
        }
      }
    }
    if (bestIdx >= 0) this.lastDist2 = best;
    return bestIdx;
  }

  /** Number of points with squared distance ≤ maxDist2, counting stops at `limit`. */
  countWithin(x: number, y: number, z: number, maxDist2: number, limit = Infinity): number {
    if (this.count === 0) return 0;
    const rp = this.rp;
    const stack = this.stack;
    let sp = 0;
    let n = 0;
    if (this.boxDist2(0, x, y, z) > maxDist2) return 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const l = this.left[node];
      if (l < 0) {
        const e = this.end[node];
        for (let i = this.start[node]; i < e; i++) {
          const o = i * 3;
          const dx = rp[o] - x;
          const dy = rp[o + 1] - y;
          const dz = rp[o + 2] - z;
          if (dx * dx + dy * dy + dz * dz <= maxDist2 && ++n >= limit) return n;
        }
        continue;
      }
      const r = this.right[node];
      if (this.boxDist2(r, x, y, z) <= maxDist2) stack[sp++] = r;
      if (this.boxDist2(l, x, y, z) <= maxDist2) stack[sp++] = l;
    }
    return n;
  }
}

/** Closest point written by `closestPointOnTriangle`. */
export const CLOSEST = new Float64Array(3);

/**
 * Squared distance from p to triangle (a, b, c); the closest point is written to CLOSEST.
 * Voronoi-region method from Ericson, "Real-Time Collision Detection" §5.1.5, with a
 * segment fallback for degenerate (collinear) triangles.
 */
export function closestPointOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number;
  let qy: number;
  let qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax;
    qy = ay;
    qz = az;
  } else {
    const bpx = px - bx;
    const bpy = py - by;
    const bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx;
      qy = by;
      qz = bz;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx;
        qy = ay + v * aby;
        qz = az + v * abz;
      } else {
        const cpx = px - cx;
        const cpy = py - cy;
        const cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) {
          qx = cx;
          qy = cy;
          qz = cz;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx;
            qy = ay + w * acy;
            qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + w * (cx - bx);
              qy = by + w * (cy - by);
              qz = bz + w * (cz - bz);
            } else {
              const sum = va + vb + vc;
              if (!(sum > 0) || !Number.isFinite(1 / sum)) {
                return closestOnSegments(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
              }
              const denom = 1 / sum;
              const v = vb * denom;
              const w = vc * denom;
              qx = ax + abx * v + acx * w;
              qy = ay + aby * v + acy * w;
              qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  CLOSEST[0] = qx;
  CLOSEST[1] = qy;
  CLOSEST[2] = qz;
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

function closestOnSegments(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  let best = Infinity;
  let bx0 = ax;
  let by0 = ay;
  let bz0 = az;
  const seg = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void => {
    const dx = ex - sx;
    const dy = ey - sy;
    const dz = ez - sz;
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = len2 > 0 ? ((px - sx) * dx + (py - sy) * dy + (pz - sz) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = sx + t * dx;
    const qy = sy + t * dy;
    const qz = sz + t * dz;
    const d = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
    if (d < best) {
      best = d;
      bx0 = qx;
      by0 = qy;
      bz0 = qz;
    }
  };
  seg(ax, ay, az, bx, by, bz);
  seg(bx, by, bz, cx, cy, cz);
  seg(cx, cy, cz, ax, ay, az);
  CLOSEST[0] = bx0;
  CLOSEST[1] = by0;
  CLOSEST[2] = bz0;
  return best;
}

export class TriangleBvh {
  readonly faceCount: number;
  /** Results of the last successful `closest` query. */
  lastDist2 = Infinity;
  readonly lastPoint = new Float64Array(3);
  /** Unit normal of the triangle hit by the last query (zero vector if degenerate). */
  readonly lastNormal = new Float64Array(3);

  private readonly tri: Float64Array; // 9 coords per triangle, in leaf order
  private readonly triFace: Uint32Array; // original face index per leaf slot
  private readonly start: Uint32Array;
  private readonly end: Uint32Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly box: Float64Array;
  private readonly stack: Int32Array;
  private readonly stackD: Float64Array;

  constructor(positions: Float64Array, faces: Uint32Array, leafSize = 4) {
    const F = Math.floor(faces.length / 3);
    this.faceCount = F;
    const cent = new Float64Array(F * 3);
    for (let f = 0; f < F; f++) {
      const a = faces[f * 3] * 3;
      const b = faces[f * 3 + 1] * 3;
      const c = faces[f * 3 + 2] * 3;
      cent[f * 3] = (positions[a] + positions[b] + positions[c]) / 3;
      cent[f * 3 + 1] = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
      cent[f * 3 + 2] = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    }
    const { order, codes } = mortonOrder(cent, 3, F);
    // Triangles in leaf order, 9 coordinates each.
    const tri = new Float64Array(F * 9);
    for (let i = 0; i < F; i++) {
      const f = order[i];
      for (let c = 0; c < 3; c++) {
        const v = faces[f * 3 + c] * 3;
        tri[i * 9 + c * 3] = positions[v];
        tri[i * 9 + c * 3 + 1] = positions[v + 1];
        tri[i * 9 + c * 3 + 2] = positions[v + 2];
      }
    }
    const t = buildTopology(codes, F, leafSize);
    const box = new Float64Array(t.count * 6);
    for (let node = t.count - 1; node >= 0; node--) {
      const l = t.left[node];
      if (l >= 0) {
        unionBoxes(box, node, l, t.right[node]);
        continue;
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      for (let i = t.start[node] * 9, e = t.end[node] * 9; i < e; i += 3) {
        const x = tri[i];
        const y = tri[i + 1];
        const z = tri[i + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      const o = node * 6;
      box[o] = x0;
      box[o + 1] = y0;
      box[o + 2] = z0;
      box[o + 3] = x1;
      box[o + 4] = y1;
      box[o + 5] = z1;
    }
    this.start = t.start;
    this.end = t.end;
    this.left = t.left;
    this.right = t.right;
    this.box = box;
    this.stack = new Int32Array(2 * t.maxDepth + 8);
    this.stackD = new Float64Array(2 * t.maxDepth + 8);
    this.tri = tri;
    this.triFace = order;
  }

  private boxDist2(node: number, x: number, y: number, z: number): number {
    const b = this.box;
    const o = node * 6;
    let d = 0;
    let v = b[o] - x;
    if (v > 0) d += v * v;
    else {
      v = x - b[o + 3];
      if (v > 0) d += v * v;
    }
    v = b[o + 1] - y;
    if (v > 0) d += v * v;
    else {
      v = y - b[o + 4];
      if (v > 0) d += v * v;
    }
    v = b[o + 2] - z;
    if (v > 0) d += v * v;
    else {
      v = z - b[o + 5];
      if (v > 0) d += v * v;
    }
    return d;
  }

  /**
   * Faces whose triangle bounding box overlaps the box [x0, y0, z0]–[x1, y1, z1] (inclusive).
   * `out` is cleared, filled with face indices (in no particular order) and returned.
   */
  queryBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, out: number[]): number[] {
    out.length = 0;
    if (this.faceCount === 0) return out;
    const b = this.box;
    const tri = this.tri;
    const stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 6;
      if (b[o] > x1 || b[o + 1] > y1 || b[o + 2] > z1 || b[o + 3] < x0 || b[o + 4] < y0 || b[o + 5] < z0) continue;
      const l = this.left[node];
      if (l >= 0) {
        stack[sp++] = l;
        stack[sp++] = this.right[node];
        continue;
      }
      for (let i = this.start[node], e = this.end[node]; i < e; i++) {
        const t = i * 9;
        if (Math.min(tri[t], tri[t + 3], tri[t + 6]) > x1 || Math.max(tri[t], tri[t + 3], tri[t + 6]) < x0) continue;
        if (Math.min(tri[t + 1], tri[t + 4], tri[t + 7]) > y1 || Math.max(tri[t + 1], tri[t + 4], tri[t + 7]) < y0) continue;
        if (Math.min(tri[t + 2], tri[t + 5], tri[t + 8]) > z1 || Math.max(tri[t + 2], tri[t + 5], tri[t + 8]) < z0) continue;
        out.push(this.triFace[i]);
      }
    }
    return out;
  }

  /**
   * Closest surface point within squared distance maxDist2 (inclusive). Returns the face
   * index (ties → lowest index) or -1; distance and point land in lastDist2/lastPoint.
   */
  closest(x: number, y: number, z: number, maxDist2 = Infinity): number {
    this.lastDist2 = Infinity;
    if (this.faceCount === 0) return -1;
    const tri = this.tri;
    const triFace = this.triFace;
    const stack = this.stack;
    const stackD = this.stackD;
    let best = maxDist2;
    let bestF = -1;
    let bestSlot = -1;
    let qx = 0;
    let qy = 0;
    let qz = 0;
    let sp = 0;
    const d0 = this.boxDist2(0, x, y, z);
    if (d0 > best) return -1;
    stack[sp] = 0;
    stackD[sp++] = d0;
    while (sp > 0) {
      sp--;
      if (stackD[sp] > best) continue;
      const node = stack[sp];
      const l = this.left[node];
      if (l < 0) {
        const e = this.end[node];
        for (let i = this.start[node]; i < e; i++) {
          const o = i * 9;
          const d2 = closestPointOnTriangle(
            x, y, z,
            tri[o], tri[o + 1], tri[o + 2],
            tri[o + 3], tri[o + 4], tri[o + 5],
            tri[o + 6], tri[o + 7], tri[o + 8],
          );
          const f = triFace[i];
          if (d2 < best || (d2 === best && (bestF < 0 || f < bestF))) {
            best = d2;
            bestF = f;
            bestSlot = i;
            qx = CLOSEST[0];
            qy = CLOSEST[1];
            qz = CLOSEST[2];
          }
        }
        continue;
      }
      const r = this.right[node];
      const dl = this.boxDist2(l, x, y, z);
      const dr = this.boxDist2(r, x, y, z);
      if (dl <= dr) {
        if (dr <= best) {
          stack[sp] = r;
          stackD[sp++] = dr;
        }
        if (dl <= best) {
          stack[sp] = l;
          stackD[sp++] = dl;
        }
      } else {
        if (dl <= best) {
          stack[sp] = l;
          stackD[sp++] = dl;
        }
        if (dr <= best) {
          stack[sp] = r;
          stackD[sp++] = dr;
        }
      }
    }
    if (bestF >= 0) {
      this.lastDist2 = best;
      this.lastPoint[0] = qx;
      this.lastPoint[1] = qy;
      this.lastPoint[2] = qz;
      const o = bestSlot * 9;
      const ux = tri[o + 3] - tri[o];
      const uy = tri[o + 4] - tri[o + 1];
      const uz = tri[o + 5] - tri[o + 2];
      const vx = tri[o + 6] - tri[o];
      const vy = tri[o + 7] - tri[o + 1];
      const vz = tri[o + 8] - tri[o + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      const inv = len > 0 ? 1 / len : 0;
      this.lastNormal[0] = nx * inv;
      this.lastNormal[1] = ny * inv;
      this.lastNormal[2] = nz * inv;
    }
    return bestF;
  }
}
