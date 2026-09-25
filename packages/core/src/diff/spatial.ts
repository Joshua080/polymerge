/**
 * Spatial indices for the diff engine (pure TypeScript, no allocations per query):
 *
 *  - `KdTree`       — static kd-tree over points; exact nearest neighbour with an
 *                     optional radius cap and exclusion mask. Median splits on the axis
 *                     of largest extent, tight per-node AABBs for pruning.
 *  - `TriangleBvh`  — static AABB bounding-volume hierarchy over triangles; exact
 *                     closest point on the surface (Ericson's point–triangle test).
 *
 * Both break distance ties on the lowest index, so query results are deterministic and
 * independent of traversal order.
 */

/** Wirth/Hoare quickselect on `order[lo, hi)` so that position k holds the k-th smallest key. */
function selectByKey(order: Uint32Array, key: Float64Array, stride: number, axis: number, lo: number, hi: number, k: number): void {
  let l = lo;
  let r = hi - 1;
  while (r > l) {
    const m = (l + r) >>> 1;
    const a = key[order[l] * stride + axis];
    const b = key[order[m] * stride + axis];
    const c = key[order[r] * stride + axis];
    // Median of three as pivot value.
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
    let i = l;
    let j = r;
    while (i <= j) {
      while (key[order[i] * stride + axis] < pivot) i++;
      while (key[order[j] * stride + axis] > pivot) j--;
      if (i <= j) {
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) r = j;
    else if (k >= i) l = i;
    else break;
  }
}

export class KdTree {
  readonly count: number;
  /** Squared distance of the last successful `nearest` query (Infinity if none). */
  lastDist2 = Infinity;

  private readonly pts: Float64Array;
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
    this.pts = positions;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    this.order = order;
    const S: number[] = [];
    const E: number[] = [];
    const L: number[] = [];
    const R: number[] = [];
    const B: number[] = [];
    let maxDepth = 0;
    const build = (s: number, e: number, depth: number): number => {
      const node = S.length;
      S.push(s);
      E.push(e);
      L.push(-1);
      R.push(-1);
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      for (let i = s; i < e; i++) {
        const o = order[i] * 3;
        const x = positions[o];
        const y = positions[o + 1];
        const z = positions[o + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      B.push(x0, y0, z0, x1, y1, z1);
      if (depth > maxDepth) maxDepth = depth;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      if (e - s <= leafSize || !(dx > 0 || dy > 0 || dz > 0)) return node;
      const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
      const mid = (s + e) >>> 1;
      selectByKey(order, positions, 3, axis, s, e, mid);
      const l = build(s, mid, depth + 1);
      const r = build(mid, e, depth + 1);
      L[node] = l;
      R[node] = r;
      return node;
    };
    if (n > 0) build(0, n, 0);
    this.start = Uint32Array.from(S);
    this.end = Uint32Array.from(E);
    this.left = Int32Array.from(L);
    this.right = Int32Array.from(R);
    this.box = Float64Array.from(B);
    this.stack = new Int32Array(2 * maxDepth + 8);
    this.stackD = new Float64Array(2 * maxDepth + 8);
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
    const pts = this.pts;
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
          const o = idx * 3;
          const dx = pts[o] - x;
          const dy = pts[o + 1] - y;
          const dz = pts[o + 2] - z;
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
    const pts = this.pts;
    const order = this.order;
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
          const o = order[i] * 3;
          const dx = pts[o] - x;
          const dy = pts[o + 1] - y;
          const dz = pts[o + 2] - z;
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
    const tbox = new Float64Array(F * 6);
    for (let f = 0; f < F; f++) {
      const a = faces[f * 3] * 3;
      const b = faces[f * 3 + 1] * 3;
      const c = faces[f * 3 + 2] * 3;
      for (let k = 0; k < 3; k++) {
        const va = positions[a + k];
        const vb = positions[b + k];
        const vc = positions[c + k];
        cent[f * 3 + k] = (va + vb + vc) / 3;
        tbox[f * 6 + k] = Math.min(va, vb, vc);
        tbox[f * 6 + 3 + k] = Math.max(va, vb, vc);
      }
    }
    const order = new Uint32Array(F);
    for (let i = 0; i < F; i++) order[i] = i;
    const S: number[] = [];
    const E: number[] = [];
    const L: number[] = [];
    const R: number[] = [];
    const B: number[] = [];
    let maxDepth = 0;
    const build = (s: number, e: number, depth: number): number => {
      const node = S.length;
      S.push(s);
      E.push(e);
      L.push(-1);
      R.push(-1);
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      let cx0 = Infinity;
      let cy0 = Infinity;
      let cz0 = Infinity;
      let cx1 = -Infinity;
      let cy1 = -Infinity;
      let cz1 = -Infinity;
      for (let i = s; i < e; i++) {
        const f = order[i];
        const o = f * 6;
        if (tbox[o] < x0) x0 = tbox[o];
        if (tbox[o + 1] < y0) y0 = tbox[o + 1];
        if (tbox[o + 2] < z0) z0 = tbox[o + 2];
        if (tbox[o + 3] > x1) x1 = tbox[o + 3];
        if (tbox[o + 4] > y1) y1 = tbox[o + 4];
        if (tbox[o + 5] > z1) z1 = tbox[o + 5];
        const cx = cent[f * 3];
        const cy = cent[f * 3 + 1];
        const cz = cent[f * 3 + 2];
        if (cx < cx0) cx0 = cx;
        if (cx > cx1) cx1 = cx;
        if (cy < cy0) cy0 = cy;
        if (cy > cy1) cy1 = cy;
        if (cz < cz0) cz0 = cz;
        if (cz > cz1) cz1 = cz;
      }
      B.push(x0, y0, z0, x1, y1, z1);
      if (depth > maxDepth) maxDepth = depth;
      const dx = cx1 - cx0;
      const dy = cy1 - cy0;
      const dz = cz1 - cz0;
      if (e - s <= leafSize || !(dx > 0 || dy > 0 || dz > 0)) return node;
      const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
      const mid = (s + e) >>> 1;
      selectByKey(order, cent, 3, axis, s, e, mid);
      const l = build(s, mid, depth + 1);
      const r = build(mid, e, depth + 1);
      L[node] = l;
      R[node] = r;
      return node;
    };
    if (F > 0) build(0, F, 0);
    this.start = Uint32Array.from(S);
    this.end = Uint32Array.from(E);
    this.left = Int32Array.from(L);
    this.right = Int32Array.from(R);
    this.box = Float64Array.from(B);
    this.stack = new Int32Array(2 * maxDepth + 8);
    this.stackD = new Float64Array(2 * maxDepth + 8);
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
