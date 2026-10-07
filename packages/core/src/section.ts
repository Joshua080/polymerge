/**
 * CROSS-SECTIONS — where a plane cuts a mesh: the closed loops it traces, with their perimeter,
 * area and shape. The terminal's `polymerge section` prints them; the viewer draws the same cut.
 *
 * Every triangle the plane crosses gives one segment. Segment ends are keyed by the mesh EDGE they
 * lie on, so the two triangles that share an edge produce the very same point and the loops chain
 * up exactly, with no distance tolerance. A vertex exactly on the plane counts as above it, so no
 * segment is produced twice. Each segment runs with the material on its left (from the triangle's
 * outward normal), so outer outlines go counter-clockwise around the plane's normal and holes
 * clockwise: the signed areas add up to the area of material in the cut. Faces lying in the plane
 * itself are not part of the cut.
 */
import type { IMesh, Vec3 } from './types.js';

export type SectionAxis = 'x' | 'y' | 'z';

export interface ISectionLoop {
  /** The loop's points in order (3D, on the plane); the last joins the first when `closed`. */
  points: Vec3[];
  closed: boolean;
  /** Length of the loop. */
  perimeter: number;
  /**
   * Signed area enclosed (closed loops; 0 for open ones): positive for an outline of material,
   * negative for a hole in it.
   */
  area: number;
  /** Bounding box of the loop in the plane's own 2D coordinates (see ISection.uAxis / vAxis). */
  min: [u: number, v: number];
  max: [u: number, v: number];
  /** Centre of the box, in 3D. */
  center: Vec3;
  /** When the loop is a circle (every point within 1% of one radius from its centre): the diameter. */
  circleDiameter: number | null;
}

export interface ISection {
  axis: SectionAxis;
  /** Where the plane cuts: axis = value. */
  value: number;
  /** The 2D coordinates of the plane: u and v are the other two axes, in order (x→(y,z), y→(z,x), z→(x,y)). */
  uAxis: SectionAxis;
  vAxis: SectionAxis;
  loops: ISectionLoop[];
  /** Sum of the signed areas: the area of material in the cut (closed loops only). */
  area: number;
}

const AXIS_INDEX: Record<SectionAxis, number> = { x: 0, y: 1, z: 2 };
const NAMES: SectionAxis[] = ['x', 'y', 'z'];

/** Cut `mesh` with the plane `axis = value`. */
export function sectionMesh(mesh: IMesh, axis: SectionAxis, value: number): ISection {
  const a = AXIS_INDEX[axis];
  const ua = (a + 1) % 3;
  const va = (a + 2) % 3;
  const p = mesh.positions;
  const f = mesh.faces;
  // Point on the edge (i, j) where it crosses the plane, keyed by the edge.
  const points = new Map<string, Vec3>();
  const pointOn = (i: number, j: number): string => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (!points.has(key)) {
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      const dl = p[lo * 3 + a] - value;
      const dh = p[hi * 3 + a] - value;
      const t = dl === dh ? 0 : dl / (dl - dh);
      const q: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) q[k] = p[lo * 3 + k] + t * (p[hi * 3 + k] - p[lo * 3 + k]);
      q[a] = value;
      points.set(key, q);
    }
    return key;
  };
  /** Segments as [from key, to key], oriented with the material on the left. */
  const next = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (let t = 0; t < mesh.faceCount; t++) {
    const v = [f[t * 3], f[t * 3 + 1], f[t * 3 + 2]];
    const above = v.map((i) => p[i * 3 + a] - value >= 0);
    if (above[0] === above[1] && above[1] === above[2]) continue;
    const ends: string[] = [];
    for (let k = 0; k < 3; k++) {
      const i = v[k];
      const j = v[(k + 1) % 3];
      if (above[k] !== above[(k + 1) % 3]) ends.push(pointOn(i, j));
    }
    if (ends.length !== 2 || ends[0] === ends[1]) continue;
    // Orientation: along (plane normal × triangle normal), which keeps the material on the left.
    const e1 = [p[v[1] * 3] - p[v[0] * 3], p[v[1] * 3 + 1] - p[v[0] * 3 + 1], p[v[1] * 3 + 2] - p[v[0] * 3 + 2]];
    const e2 = [p[v[2] * 3] - p[v[0] * 3], p[v[2] * 3 + 1] - p[v[0] * 3 + 1], p[v[2] * 3 + 2] - p[v[0] * 3 + 2]];
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    // plane normal n = unit axis a: n × N has components (u, v) = (−N_v, N_u) in the plane's frame.
    const dir = [0, 0, 0];
    dir[ua] = -nrm[va];
    dir[va] = nrm[ua];
    const qa = points.get(ends[0])!;
    const qb = points.get(ends[1])!;
    const along = (qb[0] - qa[0]) * dir[0] + (qb[1] - qa[1]) * dir[1] + (qb[2] - qa[2]) * dir[2];
    const [from, to] = along >= 0 ? [ends[0], ends[1]] : [ends[1], ends[0]];
    if (!next.has(from)) next.set(from, []);
    next.get(from)!.push(to);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  // Chain: start open chains at points nothing leads into, then close the rest.
  const loops: ISectionLoop[] = [];
  const take = (from: string): string | undefined => {
    const list = next.get(from);
    if (!list || list.length === 0) return undefined;
    const to = list.shift()!;
    incoming.set(to, (incoming.get(to) ?? 1) - 1);
    return to;
  };
  const walk = (start: string): void => {
    const keys = [start];
    let cur = start;
    for (;;) {
      const to = take(cur);
      if (to === undefined) break;
      if (to === start) {
        loops.push(describeLoop(keys.map((k) => points.get(k)!), true, ua, va));
        return;
      }
      keys.push(to);
      cur = to;
    }
    if (keys.length > 1) loops.push(describeLoop(keys.map((k) => points.get(k)!), false, ua, va));
  };
  const starts = [...next.keys()].sort();
  for (const k of starts) if ((incoming.get(k) ?? 0) === 0) while ((next.get(k)?.length ?? 0) > 0) walk(k);
  for (const k of starts) while ((next.get(k)?.length ?? 0) > 0) walk(k);
  loops.sort((x, y) => Math.abs(y.area) - Math.abs(x.area) || y.perimeter - x.perimeter);
  return { axis, value, uAxis: NAMES[ua], vAxis: NAMES[va], loops, area: loops.reduce((s, l) => s + (l.closed ? l.area : 0), 0) };
}

function describeLoop(pts: Vec3[], closed: boolean, ua: number, va: number): ISectionLoop {
  let perimeter = 0;
  let area2 = 0;
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    min[0] = Math.min(min[0], p[ua]);
    min[1] = Math.min(min[1], p[va]);
    max[0] = Math.max(max[0], p[ua]);
    max[1] = Math.max(max[1], p[va]);
    if (i + 1 < n || closed) {
      const q = pts[(i + 1) % n];
      perimeter += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (closed) area2 += p[ua] * q[va] - q[ua] * p[va];
    }
  }
  const center: Vec3 = [...pts[0]];
  center[ua] = (min[0] + max[0]) / 2;
  center[va] = (min[1] + max[1]) / 2;
  let circleDiameter: number | null = null;
  if (closed && n >= 8) {
    const cu = center[ua];
    const cv = center[va];
    const radii = pts.map((p) => Math.hypot(p[ua] - cu, p[va] - cv));
    const mean = radii.reduce((s, r) => s + r, 0) / n;
    if (mean > 0 && radii.every((r) => Math.abs(r - mean) <= 0.01 * mean)) circleDiameter = 2 * mean;
  }
  return { points: pts, closed, perimeter, area: closed ? area2 / 2 : 0, min, max, center, circleDiameter };
}
