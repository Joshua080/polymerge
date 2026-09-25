/**
 * Small dense linear algebra for the diff engine: rigid transforms, a cyclic Jacobi
 * eigen-solver for symmetric matrices, Horn's closed-form absolute orientation
 * (unit-quaternion) solver and area-weighted surface moments for PCA.
 *
 * Conventions: a rigid transform maps x ↦ R·x + t with R stored ROW-major (r[row*3+col]).
 * `rigidToMat4` converts to the column-major Mat4 layout of the shared contract.
 */
import type { IBounds, Mat4 } from '../types.js';

export interface IRigid {
  /** 3×3 rotation, row-major. */
  r: Float64Array;
  t: Float64Array;
}

export function identityRigid(): IRigid {
  return { r: Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), t: new Float64Array(3) };
}

export function rigidFrom(r: ArrayLike<number>, t: ArrayLike<number>): IRigid {
  return { r: Float64Array.from(r), t: Float64Array.from(t) };
}

/** out[o..o+2] = R·(x,y,z) + t */
export function applyRigid(g: IRigid, x: number, y: number, z: number, out: Float64Array, o = 0): void {
  const r = g.r;
  const t = g.t;
  out[o] = r[0] * x + r[1] * y + r[2] * z + t[0];
  out[o + 1] = r[3] * x + r[4] * y + r[5] * z + t[1];
  out[o + 2] = r[6] * x + r[7] * y + r[8] * z + t[2];
}

/** Inverse rigid transform: x ↦ Rᵀ·(x − t). */
export function invertRigid(g: IRigid): IRigid {
  const r = g.r;
  const t = g.t;
  const ri = Float64Array.of(r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]);
  const ti = Float64Array.of(
    -(ri[0] * t[0] + ri[1] * t[1] + ri[2] * t[2]),
    -(ri[3] * t[0] + ri[4] * t[1] + ri[5] * t[2]),
    -(ri[6] * t[0] + ri[7] * t[1] + ri[8] * t[2]),
  );
  return { r: ri, t: ti };
}

/** a ∘ b : x ↦ a(b(x)). */
export function composeRigid(a: IRigid, b: IRigid): IRigid {
  const r = mul3(a.r, b.r);
  const t = new Float64Array(3);
  applyRigid(a, b.t[0], b.t[1], b.t[2], t);
  return { r, t };
}

/** Row-major 3×3 product a·b. */
export function mul3(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const o = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return o;
}

export function transpose3(a: ArrayLike<number>): Float64Array {
  return Float64Array.of(a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]);
}

export function det3(a: ArrayLike<number>): number {
  return (
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])
  );
}

/** Contract Mat4 (column-major) from a rigid transform. */
export function rigidToMat4(g: IRigid): Mat4 {
  const r = g.r;
  const t = g.t;
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, t[0], t[1], t[2], 1];
}

/** Rigid transform from a column-major Mat4 (the projective row is ignored). */
export function mat4ToRigid(m: ArrayLike<number>): IRigid {
  return {
    r: Float64Array.of(m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]),
    t: Float64Array.of(m[12], m[13], m[14]),
  };
}

/** Rotation angle in radians (robust for small and large angles). */
export function rotationAngle(r: ArrayLike<number>): number {
  // sin θ from the skew part, cos θ from the trace: atan2 keeps precision near 0 and π.
  const sx = r[7] - r[5];
  const sy = r[2] - r[6];
  const sz = r[3] - r[1];
  const s = 0.5 * Math.hypot(sx, sy, sz);
  const c = 0.5 * (r[0] + r[4] + r[8] - 1);
  return Math.atan2(s, c);
}

/** The 8 corners of an AABB, interleaved xyz. */
export function boxCorners(b: IBounds): Float64Array {
  const out = new Float64Array(24);
  let o = 0;
  for (let i = 0; i < 8; i++) {
    out[o++] = i & 1 ? b.max[0] : b.min[0];
    out[o++] = i & 2 ? b.max[1] : b.min[1];
    out[o++] = i & 4 ? b.max[2] : b.min[2];
  }
  return out;
}

/**
 * Largest distance any of the given points moves between transform `a` and `b`.
 * Evaluated on a bounding box's corners this bounds the motion of every point inside it
 * (the difference of two affine maps is affine, so its norm is maximised at a corner).
 */
export function maxMotion(a: IRigid, b: IRigid, pts: Float64Array): number {
  const pa = new Float64Array(3);
  const pb = new Float64Array(3);
  let m = 0;
  for (let i = 0; i < pts.length; i += 3) {
    applyRigid(a, pts[i], pts[i + 1], pts[i + 2], pa);
    applyRigid(b, pts[i], pts[i + 1], pts[i + 2], pb);
    const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    if (d > m) m = d;
  }
  return m;
}

export interface IEigen {
  /** Eigenvalues in DESCENDING order. */
  values: Float64Array;
  /** Eigenvectors as columns, row-major n×n: vectors[i*n + k] = component i of eigenvector k. */
  vectors: Float64Array;
}

/**
 * Cyclic Jacobi eigen-decomposition of a symmetric n×n matrix (row-major). Unconditionally
 * stable and accurate to machine precision for the tiny matrices used here (3×3, 4×4).
 */
export function jacobiEigenSymmetric(input: ArrayLike<number>, n: number, maxSweeps = 64): IEigen {
  const a = Float64Array.from(input);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    let diag = 0;
    for (let p = 0; p < n; p++) {
      diag += a[p * n + p] * a[p * n + p];
      for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    }
    if (off === 0 || off <= 1e-32 * diag) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (apq === 0) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t =
          theta === 0 ? 1 : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // A ← Jᵀ A J with J the Givens rotation in the (p, q) plane.
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  // Sort eigenpairs by descending eigenvalue (stable on index for determinism).
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j * n + j] - a[i * n + i] || i - j);
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const src = order[k];
    values[k] = a[src * n + src];
    for (let i = 0; i < n; i++) vectors[i * n + k] = v[i * n + src];
  }
  return { values, vectors };
}

/** Row-major rotation matrix of the unit quaternion (w, x, y, z). */
export function quaternionToMatrix(w: number, x: number, y: number, z: number): Float64Array {
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n;
  x /= n;
  y /= n;
  z /= n;
  return Float64Array.of(
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  );
}

/**
 * Horn (1987) closed-form absolute orientation: the rigid transform minimising
 * Σ |R·src_i + t − dst_i|². src/dst are interleaved xyz with `count` points each.
 * The optimal rotation is the unit quaternion = eigenvector of the largest eigenvalue of
 * Horn's symmetric 4×4 matrix N, found with the Jacobi solver above.
 */
export function hornRigid(src: ArrayLike<number>, dst: ArrayLike<number>, count: number): IRigid {
  if (count <= 0) return identityRigid();
  let psx = 0;
  let psy = 0;
  let psz = 0;
  let qsx = 0;
  let qsy = 0;
  let qsz = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    psx += src[o];
    psy += src[o + 1];
    psz += src[o + 2];
    qsx += dst[o];
    qsy += dst[o + 1];
    qsz += dst[o + 2];
  }
  const pcx = psx / count;
  const pcy = psy / count;
  const pcz = psz / count;
  const qcx = qsx / count;
  const qcy = qsy / count;
  const qcz = qsz / count;
  let sxx = 0;
  let sxy = 0;
  let sxz = 0;
  let syx = 0;
  let syy = 0;
  let syz = 0;
  let szx = 0;
  let szy = 0;
  let szz = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const px = src[o] - pcx;
    const py = src[o + 1] - pcy;
    const pz = src[o + 2] - pcz;
    const qx = dst[o] - qcx;
    const qy = dst[o + 1] - qcy;
    const qz = dst[o + 2] - qcz;
    sxx += px * qx;
    sxy += px * qy;
    sxz += px * qz;
    syx += py * qx;
    syy += py * qy;
    syz += py * qz;
    szx += pz * qx;
    szy += pz * qy;
    szz += pz * qz;
  }
  const N = [
    sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
    syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
    szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
    sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
  ];
  const { vectors } = jacobiEigenSymmetric(N, 4);
  // Column 0 = eigenvector of the largest eigenvalue. Canonical sign: w ≥ 0.
  let w = vectors[0];
  let x = vectors[4];
  let y = vectors[8];
  let z = vectors[12];
  if (w < 0) {
    w = -w;
    x = -x;
    y = -y;
    z = -z;
  }
  const r = quaternionToMatrix(w, x, y, z);
  const t = Float64Array.of(
    qcx - (r[0] * pcx + r[1] * pcy + r[2] * pcz),
    qcy - (r[3] * pcx + r[4] * pcy + r[5] * pcz),
    qcz - (r[6] * pcx + r[7] * pcy + r[8] * pcz),
  );
  return { r, t };
}

/** Exact rotation matrix (row-major) for the rotation vector ω (axis · angle). */
export function rodrigues(wx: number, wy: number, wz: number): Float64Array {
  const th = Math.hypot(wx, wy, wz);
  if (th < 1e-300) return Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  const h = 0.5 * th;
  const s = Math.sin(h) / th;
  return quaternionToMatrix(Math.cos(h), wx * s, wy * s, wz * s);
}

/** Solve the dense n×n system A·x = b in place (Gaussian elimination, partial pivoting). */
export function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const x = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const t = A[c * n + k];
        A[c * n + k] = A[piv * n + k];
        A[piv * n + k] = t;
      }
      const t = b[c];
      b[c] = b[piv];
      b[piv] = t;
    }
    const d = A[c * n + c];
    if (Math.abs(d) < 1e-300) continue;
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  for (let c = n - 1; c >= 0; c--) {
    const d = A[c * n + c];
    let s = b[c];
    for (let k = c + 1; k < n; k++) s -= A[c * n + k] * x[k];
    x[c] = Math.abs(d) < 1e-300 ? 0 : s / d;
  }
  return x;
}

/**
 * One linearised point-to-plane step (Chen & Medioni): the rigid Δ minimising
 * Σ ((Δ(p_i) − q_i) · n_i)² for small rotations, with Δ(x) = R(ω)(x − c) + c + τ.
 * Rows are centred on the centroid c and the rotation block scaled by the RMS radius for
 * conditioning; a tiny Tikhonov term keeps directions the surface does not constrain
 * (sliding along a plane / spinning a cylinder) at zero instead of drifting.
 * p, q, n are interleaved xyz; n must be unit normals (zero rows are ignored).
 */
export function pointToPlaneStep(p: Float64Array, q: Float64Array, n: Float64Array, count: number): IRigid {
  if (count <= 0) return identityRigid();
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += p[i * 3];
    cy += p[i * 3 + 1];
    cz += p[i * 3 + 2];
  }
  cx /= count;
  cy /= count;
  cz /= count;
  let r2 = 0;
  for (let i = 0; i < count; i++) r2 += (p[i * 3] - cx) ** 2 + (p[i * 3 + 1] - cy) ** 2 + (p[i * 3 + 2] - cz) ** 2;
  const rho = Math.sqrt(r2 / count) || 1;
  const A = new Float64Array(36);
  const g = new Float64Array(6);
  const a = new Float64Array(6);
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const dx = (p[o] - cx) / rho;
    const dy = (p[o + 1] - cy) / rho;
    const dz = (p[o + 2] - cz) / rho;
    const nx = n[o];
    const ny = n[o + 1];
    const nz = n[o + 2];
    a[0] = dy * nz - dz * ny;
    a[1] = dz * nx - dx * nz;
    a[2] = dx * ny - dy * nx;
    a[3] = nx;
    a[4] = ny;
    a[5] = nz;
    const res = (q[o] - p[o]) * nx + (q[o + 1] - p[o + 1]) * ny + (q[o + 2] - p[o + 2]) * nz;
    for (let j = 0; j < 6; j++) {
      g[j] += a[j] * res;
      for (let k = 0; k <= j; k++) A[j * 6 + k] += a[j] * a[k];
    }
  }
  let trace = 0;
  for (let j = 0; j < 6; j++) {
    trace += A[j * 6 + j];
    for (let k = 0; k < j; k++) A[k * 6 + j] = A[j * 6 + k];
  }
  const lambda = 1e-9 * (trace / 6) + 1e-300;
  for (let j = 0; j < 6; j++) A[j * 6 + j] += lambda;
  const x = solveLinear(A, g, 6);
  const r = rodrigues(x[0] / rho, x[1] / rho, x[2] / rho);
  const t = Float64Array.of(
    cx + x[3] - (r[0] * cx + r[1] * cy + r[2] * cz),
    cy + x[4] - (r[3] * cx + r[4] * cy + r[5] * cz),
    cz + x[5] - (r[6] * cx + r[7] * cy + r[8] * cz),
  );
  return { r, t };
}

export interface IMoments {
  /** Centroid. */
  c: Float64Array;
  /** Covariance about the centroid, row-major 3×3. */
  cov: Float64Array;
  /** Total surface area (0 when vertex moments were used). */
  area: number;
}

/**
 * Area-weighted surface moments (centroid + covariance of a uniform distribution over the
 * triangle surface). Insensitive to tessellation density, which matters when the two
 * meshes are different remeshes of the same shape. Falls back to vertex moments when the
 * mesh has no area. Accumulated relative to the bbox centre to avoid cancellation.
 */
export function surfaceMoments(positions: Float64Array, faces: Uint32Array, bounds: IBounds): IMoments {
  const ox = 0.5 * (bounds.min[0] + bounds.max[0]);
  const oy = 0.5 * (bounds.min[1] + bounds.max[1]);
  const oz = 0.5 * (bounds.min[2] + bounds.max[2]);
  let area = 0;
  const m1 = new Float64Array(3);
  const m2 = new Float64Array(9);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3;
    const b = faces[f + 1] * 3;
    const c = faces[f + 2] * 3;
    const ax = positions[a] - ox;
    const ay = positions[a + 1] - oy;
    const az = positions[a + 2] - oz;
    const bx = positions[b] - ox;
    const by = positions[b + 1] - oy;
    const bz = positions[b + 2] - oz;
    const cx = positions[c] - ox;
    const cy = positions[c + 1] - oy;
    const cz = positions[c + 2] - oz;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const A = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (!(A > 0)) continue;
    area += A;
    const sx = ax + bx + cx;
    const sy = ay + by + cy;
    const sz = az + bz + cz;
    m1[0] += (A * sx) / 3;
    m1[1] += (A * sy) / 3;
    m1[2] += (A * sz) / 3;
    // E[p pᵀ] over a triangle = (a aᵀ + b bᵀ + c cᵀ + s sᵀ) / 12 with s = a + b + c.
    const k = A / 12;
    const P = [ax, ay, az, bx, by, bz, cx, cy, cz, sx, sy, sz];
    for (let i = 0; i < 3; i++) {
      for (let j = i; j < 3; j++) {
        m2[i * 3 + j] += k * (P[i] * P[j] + P[3 + i] * P[3 + j] + P[6 + i] * P[6 + j] + P[9 + i] * P[9 + j]);
      }
    }
  }
  if (!(area > 0)) {
    // Vertex moments.
    const n = positions.length / 3;
    if (n === 0) return { c: new Float64Array(3), cov: new Float64Array(9), area: 0 };
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] - ox;
      const y = positions[i + 1] - oy;
      const z = positions[i + 2] - oz;
      m1[0] += x;
      m1[1] += y;
      m1[2] += z;
      const P = [x, y, z];
      for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) m2[a * 3 + b] += P[a] * P[b];
    }
    return finishMoments(m1, m2, n, ox, oy, oz, 0);
  }
  return finishMoments(m1, m2, area, ox, oy, oz, area);
}

function finishMoments(
  m1: Float64Array,
  m2: Float64Array,
  w: number,
  ox: number,
  oy: number,
  oz: number,
  area: number,
): IMoments {
  const c = Float64Array.of(m1[0] / w, m1[1] / w, m1[2] / w);
  const cov = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      const v = m2[i * 3 + j] / w - c[i] * c[j];
      cov[i * 3 + j] = v;
      cov[j * 3 + i] = v;
    }
  }
  c[0] += ox;
  c[1] += oy;
  c[2] += oz;
  return { c, cov, area };
}
