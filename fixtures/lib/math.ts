/**
 * Small numeric helpers for the fixture generator and tests.
 *
 * Matrix conventions match three.js exactly (column-major `elements`, the same
 * `compose` / `multiplyMatrices` / `applyMatrix4` arithmetic, in the same
 * operation order) so the generator can predict, bit for bit, the world-space
 * float32 positions a parser gets when it bakes glTF node transforms.
 *
 * Nothing here imports polymerge's parsers or diff engine (type imports only).
 */
import type { Mat4, Vec3 } from '../../packages/core/src/types.js';

export type Quat = [x: number, y: number, z: number, w: number];

export const f32 = Math.fround;

/** A float32-exact point. */
export function v3(x: number, y: number, z: number): Vec3 {
  return [f32(x), f32(y), f32(z)];
}

export function toF32(p: readonly number[]): Vec3 {
  return [f32(p[0]), f32(p[1]), f32(p[2])];
}

/**
 * Text for a float32 value that parses (parseFloat / JSON / STL regex) back to
 * exactly that float32 value: the shortest float64 round-trip representation of
 * the float32 number. -0 is written as 0 (welding treats them as equal anyway).
 */
export function fmt(value: number): string {
  const x = f32(value);
  if (!Number.isFinite(x)) throw new Error(`fmt: non-finite value ${value}`);
  const s = Object.is(x, -0) ? '0' : String(x);
  if (f32(parseFloat(s)) !== x) throw new Error(`fmt: ${s} does not round-trip to ${x}`);
  return s;
}

/** Snap trig noise (|v| < 1e-12) to 0 so e.g. cos(90°) is written as 0. */
export function clean(v: number): number {
  return Math.abs(v) < 1e-12 ? 0 : v;
}

export function add(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale(a: readonly number[], s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function length(a: readonly number[]): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
export function normalize(a: readonly number[]): Vec3 {
  const l = length(a);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

export function triangleNormal(a: readonly number[], b: readonly number[], c: readonly number[]): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)));
}

// ---------------------------------------------------------------------------
// Matrices (three.js-compatible arithmetic)
// ---------------------------------------------------------------------------

export function identityMat4(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Unit quaternion for a rotation of `deg` degrees about `axis` (normalised here). */
export function quatFromAxisAngle(axis: readonly number[], deg: number): Quat {
  const n = normalize(axis);
  const half = (deg * Math.PI) / 360;
  const s = Math.sin(half);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(half)];
}

/** Same arithmetic as three.js `Matrix4.compose(position, quaternion, scale)`. */
export function composeTRS(t: readonly number[] = [0, 0, 0], q: Quat = [0, 0, 0, 1], s: readonly number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

/** a × b, same summation order as three.js `Matrix4.multiplyMatrices(a, b)`. */
export function multiplyMat4(a: readonly number[], b: readonly number[]): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** Same arithmetic as three.js `Vector3.applyMatrix4` (float64, NOT rounded to float32). */
export function applyMat4(m: readonly number[], p: readonly number[]): Vec3 {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) * w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) * w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) * w,
  ];
}

export interface RigidDecomposition {
  translation: Vec3;
  /** Rotation angle in degrees, in [0, 180]. */
  angleDeg: number;
  /** Unit rotation axis (arbitrary [1,0,0] when the angle is ~0). */
  axis: Vec3;
  /** max |RᵀR − I| entry. */
  orthonormalityError: number;
  determinant: number;
}

/** Decompose a column-major rigid 4×4 matrix into translation + axis/angle. */
export function decomposeRigid(m: ArrayLike<number>): RigidDecomposition {
  // R[row][col] = m[col * 4 + row]
  const r = (row: number, col: number) => m[col * 4 + row];
  const translation: Vec3 = [m[12], m[13], m[14]];
  let orthonormalityError = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += r(k, i) * r(k, j);
      orthonormalityError = Math.max(orthonormalityError, Math.abs(s - (i === j ? 1 : 0)));
    }
  }
  const determinant =
    r(0, 0) * (r(1, 1) * r(2, 2) - r(1, 2) * r(2, 1)) -
    r(0, 1) * (r(1, 0) * r(2, 2) - r(1, 2) * r(2, 0)) +
    r(0, 2) * (r(1, 0) * r(2, 1) - r(1, 1) * r(2, 0));
  const trace = r(0, 0) + r(1, 1) + r(2, 2);
  const cosA = Math.min(1, Math.max(-1, (trace - 1) / 2));
  const angle = Math.acos(cosA);
  let axis: Vec3;
  if (angle < 1e-9) {
    axis = [1, 0, 0];
  } else if (Math.PI - angle < 1e-6) {
    // Near 180°: R ≈ 2 n nᵀ − I, take the largest diagonal column of (R + I) / 2.
    const d = [r(0, 0), r(1, 1), r(2, 2)];
    const k = d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
    const col: Vec3 = [(r(0, k) + (k === 0 ? 1 : 0)) / 2, (r(1, k) + (k === 1 ? 1 : 0)) / 2, (r(2, k) + (k === 2 ? 1 : 0)) / 2];
    axis = normalize(col);
  } else {
    axis = normalize([r(2, 1) - r(1, 2), r(0, 2) - r(2, 0), r(1, 0) - r(0, 1)]);
  }
  return { translation, angleDeg: (angle * 180) / Math.PI, axis, orthonormalityError, determinant };
}

/** Angle in degrees between two directions. */
export function angleBetweenDeg(a: readonly number[], b: readonly number[]): number {
  const c = dot(normalize(a), normalize(b));
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Geometry queries
// ---------------------------------------------------------------------------

/** Euclidean distance from p to triangle abc (Ericson, Real-Time Collision Detection §5.1.5). */
export function pointTriangleDistance(p: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[]): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return distance(p, a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return distance(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return distance(p, add(a, scale(ab, v)));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return distance(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return distance(p, add(a, scale(ac, w)));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return distance(p, add(b, scale(sub(c, b), w)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return distance(p, add(a, add(scale(ab, v), scale(ac, w))));
}

/** Axis-aligned bounds diagonal of a point list. */
export function boundsDiagonal(points: readonly (readonly number[])[]): number {
  if (points.length === 0) return 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** Eigenvalues (descending) of the covariance of a point set (cyclic Jacobi). */
export function covarianceEigenvalues(points: readonly (readonly number[])[]): [number, number, number] {
  const n = points.length;
  const c = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) c[k] += p[k] / n;
  const a = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of points) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += ((p[i] - c[i]) * (p[j] - c[j])) / n;
  }
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1);
      const sn = t * cs;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = cs * akp - sn * akq;
        a[k][q] = sn * akp + cs * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = cs * apk - sn * aqk;
        a[q][k] = sn * apk + cs * aqk;
      }
    }
  }
  const ev = [a[0][0], a[1][1], a[2][2]].sort((x, y) => y - x);
  return [ev[0], ev[1], ev[2]];
}
