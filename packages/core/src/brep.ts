/**
 * CAD (B-rep) faces: fitting the surface a STEP face lies on, comparing surfaces between two
 * versions, and describing them in words.
 *
 * OpenCascade's tessellation of a face puts every vertex exactly ON the face's surface (to float
 * precision). Its normals are only approximate (averaged facet normals, off by several degrees),
 * but on a cylinder or cone every facet normal still lies in a plane perpendicular to the axis
 * (or at a fixed angle to it), so the normals give directions and the points give sizes:
 *  - plane: every normal the same; offset = normal · point;
 *  - cylinder / cone: the axis is the direction in which the normals vary least; normals at right
 *    angles to it make a cylinder, at a fixed angle a cone. The points, projected along the axis,
 *    lie on a circle (cylinder) or on circles whose radius grows linearly along it (cone);
 *  - sphere: the points lie on one sphere.
 * Circles and spheres are fitted to the points by linear least squares (Kåsa). A fit is accepted
 * only when every vertex lies on it within `tol`; anything else (B-splines, tori, ...) is 'other'
 * and is compared by shape alone. Normals pointing at the axis or centre mark a concave surface
 * (`inward`: a hole).
 */
import { jacobiEigenSymmetric, solveLinear } from './diff/linalg.js';
import type { IBrepSurface, Vec3 } from './types.js';

/** Normals closer than this (radians) count as parallel. */
export const BREP_ANGLE_TOLERANCE = 1e-4;

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: ArrayLike<number>): number => Math.hypot(a[0], a[1], a[2]);

function unit(a: ArrayLike<number>): Vec3 {
  const l = norm(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Snap -0 and float noise to clean values so descriptions and comparisons stay tidy. */
function clean(v: Vec3, eps: number): Vec3 {
  return v.map((x) => (Math.abs(x) < eps ? 0 : x)) as Vec3;
}

/**
 * Fit the surface of one face. `points` and `normals` are xyz triples (`count` of each);
 * `tol` is the largest distance a vertex may sit from the fitted surface (mm).
 */
export function fitSurface(points: ArrayLike<number>, normals: ArrayLike<number>, count: number, tol: number): IBrepSurface {
  if (count < 3) return { type: 'other' };
  const n: Vec3[] = [];
  const p: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const nn = [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]];
    const l = norm(nn);
    if (!(l > 0.5) || !Number.isFinite(l)) return { type: 'other' }; // no usable normal
    n.push([nn[0] / l, nn[1] / l, nn[2] / l]);
    p.push([points[i * 3], points[i * 3 + 1], points[i * 3 + 2]]);
  }
  return fitPlane(p, n, tol) ?? fitCylinderOrCone(p, n, tol) ?? fitSphere(p, n, tol) ?? { type: 'other' };
}

function fitPlane(p: Vec3[], n: Vec3[], tol: number): IBrepSurface | null {
  const sum: Vec3 = [0, 0, 0];
  for (const v of n) for (let k = 0; k < 3; k++) sum[k] += v[k];
  const m = unit(sum);
  const minCos = Math.cos(BREP_ANGLE_TOLERANCE);
  if (n.some((v) => dot(v, m) < minCos)) return null;
  let d = 0;
  for (const q of p) d += dot(m, q);
  d /= p.length;
  if (p.some((q) => Math.abs(dot(m, q) - d) > tol)) return null;
  return { type: 'plane', normal: clean(m, 1e-12), offset: Math.abs(d) < 1e-12 ? 0 : d };
}

function fitCylinderOrCone(p: Vec3[], n: Vec3[], tol: number): IBrepSurface | null {
  const N = n.length;
  // Covariance of the normals about their mean: they lie in a plane perpendicular to the axis.
  const mean: Vec3 = [0, 0, 0];
  for (const v of n) for (let k = 0; k < 3; k++) mean[k] += v[k] / N;
  const C = new Float64Array(9);
  for (const v of n) {
    const d0 = v[0] - mean[0];
    const d1 = v[1] - mean[1];
    const d2 = v[2] - mean[2];
    C[0] += d0 * d0;
    C[1] += d0 * d1;
    C[2] += d0 * d2;
    C[4] += d1 * d1;
    C[5] += d1 * d2;
    C[8] += d2 * d2;
  }
  C[3] = C[1];
  C[6] = C[2];
  C[7] = C[5];
  const eig = jacobiEigenSymmetric(C, 3);
  // The normals must spread in the plane (else it is a plane or a sliver) and not out of it.
  if (!(eig.values[1] > 1e-10 * N) || eig.values[2] > 1e-6 * eig.values[1]) return null;
  let axis: Vec3 = unit([eig.vectors[2], eig.vectors[5], eig.vectors[8]]);
  // Canonical direction: the largest component positive (so equal axes compare equal).
  const big = Math.abs(axis[0]) >= Math.abs(axis[1]) && Math.abs(axis[0]) >= Math.abs(axis[2]) ? 0 : Math.abs(axis[1]) >= Math.abs(axis[2]) ? 1 : 2;
  if (axis[big] < 0) axis = [-axis[0], -axis[1], -axis[2]];
  axis = clean(axis, 1e-12);
  let cosine = 0;
  for (const v of n) cosine += dot(v, axis) / N;
  // A 2D frame (u, w) perpendicular to the axis.
  const ref: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit([ref[1] * axis[2] - ref[2] * axis[1], ref[2] * axis[0] - ref[0] * axis[2], ref[0] * axis[1] - ref[1] * axis[0]]);
  const w: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  const x = p.map((q) => dot(q, u));
  const y = p.map((q) => dot(q, w));
  const h = p.map((q) => dot(q, axis));
  // Concave when the normals point towards the axis (decided after the centre is known).
  const inwardAround = (cx: number, cy: number): boolean => {
    let s = 0;
    for (let i = 0; i < N; i++) s += dot(n[i], u) * (x[i] - cx) + dot(n[i], w) * (y[i] - cy);
    return s < 0;
  };
  const toWorld = (cx: number, cy: number): Vec3 => [cx * u[0] + cy * w[0], cx * u[1] + cy * w[1], cx * u[2] + cy * w[2]];
  if (Math.abs(cosine) < Math.sin(1e-3)) {
    const circle = fitCircle(x, y);
    if (!circle) return null;
    const [cx, cy, r] = circle;
    for (let i = 0; i < N; i++) if (Math.abs(Math.hypot(x[i] - cx, y[i] - cy) - r) > tol) return null;
    if (!(r > tol)) return null;
    return { type: 'cylinder', axis, origin: clean(toWorld(cx, cy), 1e-9), radius: r, inward: inwardAround(cx, cy), full: goesAllTheWayRound(n.map((v) => { const t = dot(v, axis); return [v[0] - t * axis[0], v[1] - t * axis[1], v[2] - t * axis[2]] as Vec3; }), axis) };
  }
  // Cone: |q − c|² = (k·h + b)² for the projected point q, centre c and height h, which is linear
  // in (cx, cy, k², k·b, b² − |c|²) after expanding: x² + y² = 2cx·x + 2cy·y + A·h² + 2B·h + E.
  const mx = x.reduce((a, v) => a + v, 0) / N;
  const my = y.reduce((a, v) => a + v, 0) / N;
  const mh = h.reduce((a, v) => a + v, 0) / N;
  const A = new Float64Array(25);
  const bb = new Float64Array(5);
  for (let i = 0; i < N; i++) {
    const xi = x[i] - mx;
    const yi = y[i] - my;
    const hi = h[i] - mh;
    const row = [2 * xi, 2 * yi, hi * hi, 2 * hi, 1];
    const rhs = xi * xi + yi * yi;
    for (let r = 0; r < 5; r++) {
      bb[r] += row[r] * rhs;
      for (let k = 0; k < 5; k++) A[r * 5 + k] += row[r] * row[k];
    }
  }
  const sol = solveLinear(A, bb, 5);
  const [cxl, cyl, A2, B] = [sol[0], sol[1], sol[2], sol[3]];
  if (!(A2 > 1e-12) || ![cxl, cyl, A2, B].every(Number.isFinite)) return null;
  const k = Math.sqrt(A2);
  const b0 = B / k; // radius at the mean height
  for (let i = 0; i < N; i++) {
    const rho = Math.hypot(x[i] - mx - cxl, y[i] - my - cyl);
    if (Math.abs(rho - Math.abs(k * (h[i] - mh) + b0)) > tol) return null;
  }
  const halfAngle = Math.atan(k);
  // The normals' angle must agree with the slope (a cone's normal meets its axis at 90° − α).
  if (Math.abs(Math.asin(Math.min(1, Math.abs(cosine))) - halfAngle) > 0.05) return null;
  const cx = cxl + mx;
  const cy = cyl + my;
  const apexH = mh - b0 / k;
  const c = toWorld(cx, cy);
  const apex: Vec3 = [c[0] + apexH * axis[0], c[1] + apexH * axis[1], c[2] + apexH * axis[2]];
  return { type: 'cone', axis, apex: clean(apex, 1e-9), halfAngleDeg: (halfAngle * 180) / Math.PI, inward: inwardAround(cx, cy) };
}

/** Least-squares circle through 2D points (Kåsa), on centred coordinates: [cx, cy, r] or null. */
function fitCircle(x: number[], y: number[]): [number, number, number] | null {
  const N = x.length;
  const mx = x.reduce((a, v) => a + v, 0) / N;
  const my = y.reduce((a, v) => a + v, 0) / N;
  // x² + y² + D·x + E·y + F = 0 on centred coordinates.
  const A = new Float64Array(9);
  const b = new Float64Array(3);
  for (let i = 0; i < N; i++) {
    const xi = x[i] - mx;
    const yi = y[i] - my;
    const row = [xi, yi, 1];
    const rhs = -(xi * xi + yi * yi);
    for (let r = 0; r < 3; r++) {
      b[r] += row[r] * rhs;
      for (let k = 0; k < 3; k++) A[r * 3 + k] += row[r] * row[k];
    }
  }
  const [D, E, F] = solveLinear(A, b, 3);
  const r2 = (D * D + E * E) / 4 - F;
  if (!(r2 > 0) || ![D, E, F].every(Number.isFinite)) return null;
  return [mx - D / 2, my - E / 2, Math.sqrt(r2)];
}

/** Whether flattened normals cover the full turn around the axis (no gap wider than 45°). */
function goesAllTheWayRound(m: Vec3[], axis: Vec3): boolean {
  const ref = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit([ref[1] * axis[2] - ref[2] * axis[1], ref[2] * axis[0] - ref[0] * axis[2], ref[0] * axis[1] - ref[1] * axis[0]]);
  const v: Vec3 = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  const angles = m.map((x) => Math.atan2(dot(x, v), dot(x, u))).sort((a, b) => a - b);
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  return gap < Math.PI / 4;
}

function fitSphere(p: Vec3[], n: Vec3[], tol: number): IBrepSurface | null {
  const N = p.length;
  const m: Vec3 = [0, 0, 0];
  for (const q of p) for (let k = 0; k < 3; k++) m[k] += q[k] / N;
  // x² + y² + z² + D·x + E·y + F·z + G = 0 on centred coordinates.
  const A = new Float64Array(16);
  const b = new Float64Array(4);
  for (const q of p) {
    const x = q[0] - m[0];
    const y = q[1] - m[1];
    const z = q[2] - m[2];
    const row = [x, y, z, 1];
    const rhs = -(x * x + y * y + z * z);
    for (let r = 0; r < 4; r++) {
      b[r] += row[r] * rhs;
      for (let k = 0; k < 4; k++) A[r * 4 + k] += row[r] * row[k];
    }
  }
  const [D, E, F, G] = solveLinear(A, b, 4);
  const r2 = (D * D + E * E + F * F) / 4 - G;
  if (!(r2 > 0) || ![D, E, F, G].every(Number.isFinite)) return null;
  const r = Math.sqrt(r2);
  const c: Vec3 = [m[0] - D / 2, m[1] - E / 2, m[2] - F / 2];
  for (const q of p) if (Math.abs(Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) - r) > tol) return null;
  if (!(r > tol)) return null;
  let toward = 0;
  for (let i = 0; i < N; i++) toward += dot(n[i], [p[i][0] - c[0], p[i][1] - c[1], p[i][2] - c[2]]);
  return { type: 'sphere', center: clean(c, 1e-9), radius: r, inward: toward < 0 };
}

// ---------------------------------------------------------------------------
// Comparing surfaces
// ---------------------------------------------------------------------------

const parallel = (a: Vec3, b: Vec3): boolean => Math.abs(dot(a, b)) >= Math.cos(BREP_ANGLE_TOLERANCE);

/** Distance between the axis lines of two parallel cylinders / cones (through o1 and o2 along a). */
function axisOffset(a: Vec3, o1: Vec3, o2: Vec3): Vec3 {
  const d: Vec3 = [o2[0] - o1[0], o2[1] - o1[1], o2[2] - o1[2]];
  const t = dot(d, a);
  return [d[0] - t * a[0], d[1] - t * a[1], d[2] - t * a[2]];
}

/** Whether two surfaces are the same surface (same kind and parameters within `tol` mm). */
export function sameSurface(a: IBrepSurface, b: IBrepSurface, tol: number): boolean {
  switch (a.type) {
    case 'plane':
      return b.type === 'plane' && dot(a.normal, b.normal) >= Math.cos(BREP_ANGLE_TOLERANCE) && Math.abs(a.offset - b.offset) <= tol;
    case 'cylinder':
      return (
        b.type === 'cylinder' &&
        a.inward === b.inward &&
        parallel(a.axis, b.axis) &&
        Math.abs(a.radius - b.radius) <= tol &&
        norm(axisOffset(a.axis, a.origin, b.origin)) <= tol
      );
    case 'cone': {
      if (b.type !== 'cone' || a.inward !== b.inward || !parallel(a.axis, b.axis)) return false;
      const d: Vec3 = [b.apex[0] - a.apex[0], b.apex[1] - a.apex[1], b.apex[2] - a.apex[2]];
      return Math.abs(a.halfAngleDeg - b.halfAngleDeg) <= 0.01 && norm(d) <= tol;
    }
    case 'sphere':
      return (
        b.type === 'sphere' &&
        a.inward === b.inward &&
        Math.abs(a.radius - b.radius) <= tol &&
        Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2]) <= tol
      );
    case 'other':
      return false;
  }
}

/**
 * How `b` differs from `a` when both are the same KIND of surface in the same orientation:
 * the displacement (moved) and the size before / after (resized). Null when they are not
 * comparable (different kinds, axes or normals that are not parallel, concave vs convex).
 */
export function surfaceChange(a: IBrepSurface, b: IBrepSurface, tol: number): { offset: Vec3; size: [number, number] | null } | null {
  switch (a.type) {
    case 'plane': {
      if (b.type !== 'plane' || dot(a.normal, b.normal) < Math.cos(BREP_ANGLE_TOLERANCE)) return null;
      const d = b.offset - a.offset;
      return { offset: [d * a.normal[0], d * a.normal[1], d * a.normal[2]], size: null };
    }
    case 'cylinder': {
      if (b.type !== 'cylinder' || a.inward !== b.inward || !parallel(a.axis, b.axis)) return null;
      const size: [number, number] | null = Math.abs(a.radius - b.radius) > tol ? [a.radius, b.radius] : null;
      return { offset: axisOffset(a.axis, a.origin, b.origin), size };
    }
    case 'cone': {
      if (b.type !== 'cone' || a.inward !== b.inward || !parallel(a.axis, b.axis)) return null;
      return { offset: [b.apex[0] - a.apex[0], b.apex[1] - a.apex[1], b.apex[2] - a.apex[2]], size: Math.abs(a.halfAngleDeg - b.halfAngleDeg) > 0.01 ? [a.halfAngleDeg, b.halfAngleDeg] : null };
    }
    case 'sphere': {
      if (b.type !== 'sphere' || a.inward !== b.inward) return null;
      const size: [number, number] | null = Math.abs(a.radius - b.radius) > tol ? [a.radius, b.radius] : null;
      return { offset: [b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]], size };
    }
    case 'other':
      return null;
  }
}

/**
 * The surface after a similarity transform x ↦ s·R·x + t (column-major 4×4 `m`, scale `s`):
 * how a base surface reads in target space.
 */
export function transformSurface(sf: IBrepSurface, m: ArrayLike<number>, s: number): IBrepSurface {
  const dir = (v: Vec3): Vec3 => unit([m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]]);
  const pt = (v: Vec3): Vec3 => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
  switch (sf.type) {
    case 'plane': {
      const normal = dir(sf.normal);
      const onPlane = pt([sf.normal[0] * sf.offset, sf.normal[1] * sf.offset, sf.normal[2] * sf.offset]);
      return { type: 'plane', normal, offset: dot(normal, onPlane) };
    }
    case 'cylinder': {
      const axis = dir(sf.axis);
      const o = pt(sf.origin);
      // Back to the axis point nearest the origin.
      const t = dot(o, axis);
      return { ...sf, axis, origin: [o[0] - t * axis[0], o[1] - t * axis[1], o[2] - t * axis[2]], radius: sf.radius * s };
    }
    case 'cone':
      return { ...sf, axis: dir(sf.axis), apex: pt(sf.apex) };
    case 'sphere':
      return { ...sf, center: pt(sf.center), radius: sf.radius * s };
    case 'other':
      return sf;
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** A length in mm for descriptions: up to 3 decimals, no trailing zeros. */
export function mm(x: number): string {
  const r = Math.round(x * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString();
}

const AXES: [string, Vec3][] = [
  ['+X', [1, 0, 0]],
  ['−X', [-1, 0, 0]],
  ['+Y', [0, 1, 0]],
  ['−Y', [0, -1, 0]],
  ['+Z', [0, 0, 1]],
  ['−Z', [0, 0, -1]],
];

/** "+Z" for a direction along a coordinate axis, else null. */
function axisName(v: Vec3): string | null {
  for (const [name, a] of AXES) if (dot(v, a) >= Math.cos(BREP_ANGLE_TOLERANCE)) return name;
  return null;
}

/** A surface in a few words: "hole Ø8", "flat face facing +Z", "round r5", "sphere Ø10". */
export function describeSurface(sf: IBrepSurface): string {
  switch (sf.type) {
    case 'plane': {
      const dir = axisName(sf.normal);
      return dir ? `flat face facing ${dir}` : 'flat face';
    }
    case 'cylinder':
      if (sf.full) return sf.inward ? `hole Ø${mm(2 * sf.radius)}` : `cylinder Ø${mm(2 * sf.radius)}`;
      return `${sf.inward ? 'inner' : 'outer'} round r${mm(sf.radius)}`;
    case 'cone':
      return `${sf.inward ? 'countersink' : 'cone'} ${mm(2 * sf.halfAngleDeg)}°`;
    case 'sphere':
      return `${sf.inward ? 'spherical recess' : 'sphere'} Ø${mm(2 * sf.radius)}`;
    case 'other':
      return 'curved face';
  }
}

/** "(+5, 0, −2)": a vector in mm. */
export function describeVector(v: Vec3): string {
  return `(${v.map((x) => {
    const s = mm(x);
    return s === '0' ? '0' : x > 0 ? `+${s}` : s.replace('-', '−');
  }).join(', ')})`;
}
