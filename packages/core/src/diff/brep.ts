/**
 * FACE-AWARE STEP DIFF — compare two STEP models CAD face by CAD face, as surfaces.
 *
 * The triangle-level diff sees a re-triangulation: OpenCascade re-meshes a whole flat face when a
 * hole in it moves, so most of that face reads as modified, added and removed although the
 * surface did not change. Both models carry their CAD faces (IMesh.brep: the B-rep face of every
 * triangle and the fitted surface of every face, ../brep.ts), so this pass asks instead:
 *
 *  1. Same surface: which faces of the two versions lie on the same surface (a plane with the
 *     same normal and offset, a cylinder with the same axis and radius, ...; for 'other' surfaces,
 *     the same shape: most of one face's triangles lie on the other's).
 *  2. Same extent: a triangle of such a face is unchanged when the other version's faces on that
 *     surface cover it (its corners, edge midpoints and centre lie on them, within twice the
 *     tessellation tolerance); an uncovered triangle is area that face gained (added) or lost
 *     (removed): the outline changed.
 *  3. Faces with no same-surface partner are paired with a face of the same kind and orientation
 *     nearby: the same size elsewhere is a move (a hole moved 5 mm), another size is a resize
 *     (Ø8 → Ø8.1, a fillet r5 → r8). Those faces are modified. The rest were added or removed.
 *
 * The triangle statuses become the face-aware ones, vertices that now touch only unchanged
 * triangles become unchanged, and the counts are recomputed, so everything downstream (the
 * viewer's colours, the PR images, the CLI report) shows real edits instead of re-meshing.
 * Each change is reported in words, per face (IBrepDiff).
 */
import { describeSurface, describeVector, mm, sameSurface, surfaceChange, transformSurface } from '../brep.js';
import { boundsDiagonal } from '../mesh.js';
import {
  FaceStatus,
  VertexStatus,
  type IBrepDiff,
  type IBrepFaceChange,
  type IBrepSurface,
  type IDiffStats,
  type IMesh,
  type IRigidTransform,
  type Vec3,
} from '../types.js';
import type { IClassification } from './classify.js';
import { TriangleBvh } from './spatial.js';

/** Triangles of each CAD face (CSR), and each face's bounding box. */
interface IFaceIndex {
  offsets: Uint32Array;
  triangles: Uint32Array;
  boxes: Float64Array;
}

function indexFaces(mesh: IMesh): IFaceIndex {
  const brep = mesh.brep!;
  const F = brep.faces.length;
  const offsets = new Uint32Array(F + 1);
  for (let t = 0; t < mesh.faceCount; t++) {
    const f = brep.faceOf[t];
    if (f >= 0 && f < F) offsets[f + 1]++;
  }
  for (let f = 0; f < F; f++) offsets[f + 1] += offsets[f];
  const fill = offsets.slice(0, F);
  const triangles = new Uint32Array(offsets[F]);
  for (let t = 0; t < mesh.faceCount; t++) {
    const f = brep.faceOf[t];
    if (f >= 0 && f < F) triangles[fill[f]++] = t;
  }
  const boxes = new Float64Array(F * 6);
  for (let f = 0; f < F; f++) {
    boxes.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], f * 6);
    for (let i = offsets[f]; i < offsets[f + 1]; i++) {
      const t = triangles[i];
      for (let c = 0; c < 3; c++) {
        const v = mesh.faces[t * 3 + c] * 3;
        for (let k = 0; k < 3; k++) {
          const x = mesh.positions[v + k];
          if (x < boxes[f * 6 + k]) boxes[f * 6 + k] = x;
          if (x > boxes[f * 6 + 3 + k]) boxes[f * 6 + 3 + k] = x;
        }
      }
    }
  }
  return { offsets, triangles, boxes };
}

/** A similarity transform x ↦ M·x (column-major) and its inverse, as point mappers. */
function mappers(al: IRigidTransform): { toTarget: (p: Vec3) => Vec3; toBase: (p: Vec3) => Vec3; scale: number } {
  const m = al.matrix;
  if (al.isIdentity || m.length !== 16) return { toTarget: (p) => p, toBase: (p) => p, scale: 1 };
  const s = al.scale || 1;
  const toTarget = (p: Vec3): Vec3 => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
  // Inverse of s·R·x + t is Rᵀ(y − t)/s, and Rᵀ/s = Mᵀ/s² for the 3×3 block M = s·R.
  const toBase = (p: Vec3): Vec3 => {
    const x = p[0] - m[12];
    const y = p[1] - m[13];
    const z = p[2] - m[14];
    const k = 1 / (s * s);
    return [(m[0] * x + m[1] * y + m[2] * z) * k, (m[4] * x + m[5] * y + m[6] * z) * k, (m[8] * x + m[9] * y + m[10] * z) * k];
  };
  return { toTarget, toBase, scale: s };
}

function triangleCentroid(mesh: IMesh, t: number): Vec3 {
  const f = mesh.faces;
  const p = mesh.positions;
  const a = f[t * 3] * 3;
  const b = f[t * 3 + 1] * 3;
  const c = f[t * 3 + 2] * 3;
  return [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3];
}

function boxesOverlap(a: Float64Array, i: number, b: Float64Array, j: number, pad: number): boolean {
  for (let k = 0; k < 3; k++) {
    if (a[i * 6 + k] - pad > b[j * 6 + 3 + k] || b[j * 6 + k] - pad > a[i * 6 + 3 + k]) return false;
  }
  return true;
}

/** Lazily built BVH per CAD face (only the faces that coverage tests need). */
class FaceBvhs {
  private readonly cache = new Map<number, TriangleBvh>();
  constructor(
    private readonly mesh: IMesh,
    private readonly index: IFaceIndex,
  ) {}
  /** The face's triangle (global index) nearest q within √tol2, or -1. */
  closestTriangle(face: number, q: Vec3, tol2: number): number {
    const local = this.get(face).closest(q[0], q[1], q[2], tol2);
    return local < 0 ? -1 : this.index.triangles[this.index.offsets[face] + local];
  }
  get(face: number): TriangleBvh {
    let bvh = this.cache.get(face);
    if (!bvh) {
      const { offsets, triangles } = this.index;
      const n = offsets[face + 1] - offsets[face];
      const faces = new Uint32Array(n * 3);
      for (let i = 0; i < n; i++) faces.set(this.mesh.faces.subarray(triangles[offsets[face] + i] * 3, triangles[offsets[face] + i] * 3 + 3), i * 3);
      bvh = new TriangleBvh(this.mesh.positions, faces);
      this.cache.set(face, bvh);
    }
    return bvh;
  }
}

/** Whether point q (in the BVH's space) is within `tol` of any of the faces' triangles. */
function covered(q: Vec3, faces: number[], bvhs: FaceBvhs, tol: number): boolean {
  const tol2 = tol * tol;
  for (const f of faces) if (bvhs.get(f).closest(q[0], q[1], q[2], tol2) >= 0) return true;
  return false;
}

/**
 * Points that stand for a triangle in coverage tests: its corners, edge midpoints and centre.
 * Corners matter: CAD tessellations fan long thin triangles out from a hole's rim, and their
 * centres can lie far from the change they touch.
 */
function samplePoints(mesh: IMesh, t: number): Vec3[] {
  const f = mesh.faces;
  const p = mesh.positions;
  const v = [f[t * 3] * 3, f[t * 3 + 1] * 3, f[t * 3 + 2] * 3].map((o): Vec3 => [p[o], p[o + 1], p[o + 2]]);
  const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return [...v, mid(v[0], v[1]), mid(v[1], v[2]), mid(v[2], v[0]), [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3, (v[0][2] + v[1][2] + v[2][2]) / 3]];
}

/** A triangle is covered when every sample point lies on the other version's faces. */
function triangleCovered(mesh: IMesh, t: number, map: (p: Vec3) => Vec3, faces: number[], bvhs: FaceBvhs, tol: number): boolean {
  for (const q of samplePoints(mesh, t)) if (!covered(map(q), faces, bvhs, tol)) return false;
  return true;
}

/**
 * The outline of a set of CAD faces: edges used by exactly one of their triangles, as segment
 * endpoints mapped by `map` (6 numbers per edge).
 */
function outline(mesh: IMesh, idx: IFaceIndex, faces: number[], map: (p: Vec3) => Vec3): Float64Array {
  const count = new Map<string, [number, number, number]>();
  const f = mesh.faces;
  for (const face of faces) {
    for (let i = idx.offsets[face]; i < idx.offsets[face + 1]; i++) {
      const t = idx.triangles[i];
      for (let k = 0; k < 3; k++) {
        const a = f[t * 3 + k];
        const b = f[t * 3 + ((k + 1) % 3)];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const e = count.get(key);
        if (e) e[2]++;
        else count.set(key, [a, b, 1]);
      }
    }
  }
  const out: number[] = [];
  const p = mesh.positions;
  for (const [a, b, n] of count.values()) {
    if (n !== 1) continue;
    const pa = map([p[a * 3], p[a * 3 + 1], p[a * 3 + 2]]);
    const pb = map([p[b * 3], p[b * 3 + 1], p[b * 3 + 2]]);
    out.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
  }
  return Float64Array.from(out);
}

/** Whether q lies within `tol` of any segment of an outline. */
function nearOutline(q: Vec3, edges: Float64Array, tol: number): boolean {
  const tol2 = tol * tol;
  for (let i = 0; i < edges.length; i += 6) {
    const ax = edges[i];
    const ay = edges[i + 1];
    const az = edges[i + 2];
    const dx = edges[i + 3] - ax;
    const dy = edges[i + 4] - ay;
    const dz = edges[i + 5] - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    let t = l2 > 0 ? ((q[0] - ax) * dx + (q[1] - ay) * dy + (q[2] - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - q[0];
    const ey = ay + t * dy - q[1];
    const ez = az + t * dz - q[2];
    if (ex * ex + ey * ey + ez * ez <= tol2) return true;
  }
  return false;
}

/** Midpoints of an outline's segments. */
function midpoints(edges: Float64Array): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < edges.length; i += 6) out.push([(edges[i] + edges[i + 3]) / 2, (edges[i + 1] + edges[i + 4]) / 2, (edges[i + 2] + edges[i + 5]) / 2]);
  return out;
}

class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) x = this.parent[x] = this.parent[this.parent[x]];
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

const sizeOf = (s: IBrepSurface, r: number): string => (s.type === 'cylinder' && s.full) || s.type === 'sphere' ? `Ø${mm(2 * r)}` : s.type === 'cone' ? `${mm(2 * r)}°` : `r${mm(r)}`;
const len = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

export interface IBrepRefineInput {
  base: IMesh;
  target: IMesh;
  alignment: IRigidTransform;
  /** The tessellation tolerance both versions were made with (mm). */
  deflection: number;
}

/**
 * Compare the CAD faces and rewrite `cls` (statuses, displacement stats, counts) to the
 * face-aware result. Returns the per-face report.
 */
export function refineByBrepFaces(input: IBrepRefineInput, cls: IClassification): IBrepDiff {
  const { base, target } = input;
  const bBrep = base.brep!;
  const tBrep = target.brep!;
  const bIdx = indexFaces(base);
  const tIdx = indexFaces(target);
  const diag = boundsDiagonal(target.metadata.bounds) || 1;
  const maxAbs = Math.max(...target.metadata.bounds.min.map(Math.abs), ...target.metadata.bounds.max.map(Math.abs), 1);
  // Surfaces of the two versions match within this (float32 storage noise is the floor)…
  const tol = Math.max(1e-5 * diag, 4 * 2 ** -24 * maxAbs);
  // …and a triangle centre lies on the other version's triangles within twice the chord error.
  const coverTol = 2 * input.deflection + tol;
  const map = mappers(input.alignment);
  const scaledCover = coverTol / map.scale;
  const baseSurf = bBrep.faces.map((f) => (input.alignment.isIdentity ? f.surface : transformSurface(f.surface, input.alignment.matrix, map.scale)));
  const tSurf = tBrep.faces.map((f) => f.surface);
  const FB = bBrep.faces.length;
  const FT = tBrep.faces.length;
  const bBvh = new FaceBvhs(base, bIdx);
  const tBvh = new FaceBvhs(target, tIdx);
  // Base face boxes in target space, for the shape test of 'other' surfaces.
  const bBoxT = new Float64Array(FB * 6);
  for (let f = 0; f < FB; f++) {
    const lo: Vec3 = [bIdx.boxes[f * 6], bIdx.boxes[f * 6 + 1], bIdx.boxes[f * 6 + 2]];
    const hi: Vec3 = [bIdx.boxes[f * 6 + 3], bIdx.boxes[f * 6 + 4], bIdx.boxes[f * 6 + 5]];
    const corners: Vec3[] = [];
    for (let k = 0; k < 8; k++) corners.push(map.toTarget([k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]]));
    for (let k = 0; k < 3; k++) {
      bBoxT[f * 6 + k] = Math.min(...corners.map((c) => c[k]));
      bBoxT[f * 6 + 3 + k] = Math.max(...corners.map((c) => c[k]));
    }
  }

  // ---- 1. Same-surface pairs -------------------------------------------------------------------
  const partnersOfT: number[][] = Array.from({ length: FT }, () => []);
  const partnersOfB: number[][] = Array.from({ length: FB }, () => []);
  const uf = new UnionFind(FB + FT);
  for (let t = 0; t < FT; t++) {
    for (let b = 0; b < FB; b++) {
      if (!boxesOverlap(tIdx.boxes, t, bBoxT, b, coverTol)) continue;
      let same: boolean;
      if (tSurf[t].type === 'other' || baseSurf[b].type === 'other') {
        // No parameters to compare: the same shape when at least half of each face lies on the other.
        same = tSurf[t].type === baseSurf[b].type && shareShape(target, tIdx, t, base, bIdx, b, tBvh, bBvh, map, coverTol);
      } else same = sameSurface(baseSurf[b], tSurf[t], tol);
      if (!same) continue;
      partnersOfT[t].push(b);
      partnersOfB[b].push(t);
      uf.union(b, FB + t);
    }
  }

  // ---- 2. Coverage, triangle by triangle ------------------------------------------------------
  const tCovered = new Uint8Array(target.faceCount);
  const bCovered = new Uint8Array(base.faceCount);
  for (let t = 0; t < FT; t++) {
    if (partnersOfT[t].length === 0) continue;
    for (let i = tIdx.offsets[t]; i < tIdx.offsets[t + 1]; i++) {
      const tri = tIdx.triangles[i];
      if (triangleCovered(target, tri, map.toBase, partnersOfT[t], bBvh, scaledCover)) tCovered[tri] = 1;
    }
  }
  for (let b = 0; b < FB; b++) {
    if (partnersOfB[b].length === 0) continue;
    for (let i = bIdx.offsets[b]; i < bIdx.offsets[b + 1]; i++) {
      const tri = bIdx.triangles[i];
      if (triangleCovered(base, tri, map.toTarget, partnersOfB[b], tBvh, coverTol)) bCovered[tri] = 1;
    }
  }

  // Outlines: where one version's outline runs through the inside of the other's face (a new hole
  // in a flat face, a hole that moved away), the triangle it crosses is not fully covered, even
  // when all its sample points are (a small hole can sit inside one large triangle).
  const groupsOf = new Map<number, { bs: number[]; ts: number[] }>();
  for (let b = 0; b < FB; b++) {
    if (partnersOfB[b].length === 0) continue;
    const r = uf.find(b);
    if (!groupsOf.has(r)) groupsOf.set(r, { bs: [], ts: [] });
    groupsOf.get(r)!.bs.push(b);
  }
  for (let t = 0; t < FT; t++) {
    if (partnersOfT[t].length === 0) continue;
    const r = uf.find(FB + t);
    if (!groupsOf.has(r)) groupsOf.set(r, { bs: [], ts: [] });
    groupsOf.get(r)!.ts.push(t);
  }
  const scaledCover2 = scaledCover * scaledCover;
  const cover2 = coverTol * coverTol;
  for (const { bs, ts } of groupsOf.values()) {
    const bLine = outline(base, bIdx, bs, map.toTarget);
    const tLine = outline(target, tIdx, ts, (p) => p);
    for (const m of midpoints(tLine)) {
      if (nearOutline(m, bLine, coverTol)) continue;
      const q = map.toBase(m);
      for (const b of bs) {
        const tri = bBvh.closestTriangle(b, q, scaledCover2);
        if (tri >= 0) bCovered[tri] = 0;
      }
    }
    for (const m of midpoints(bLine)) {
      if (nearOutline(m, tLine, coverTol)) continue;
      for (const t of ts) {
        const tri = tBvh.closestTriangle(t, m, cover2);
        if (tri >= 0) tCovered[tri] = 0;
      }
    }
  }

  // ---- 3. Moved / resized pairs among faces with no same-surface partner -------------------------
  const centroidT = (b: number): Vec3 => map.toTarget(bBrep.faces[b].centroid);
  const loneB = Array.from({ length: FB }, (_, b) => b).filter((b) => partnersOfB[b].length === 0);
  const loneT = Array.from({ length: FT }, (_, t) => t).filter((t) => partnersOfT[t].length === 0);
  const candidates: { b: number; t: number; dist: number; change: NonNullable<ReturnType<typeof surfaceChange>> }[] = [];
  for (const t of loneT) {
    for (const b of loneB) {
      const change = surfaceChange(baseSurf[b], tSurf[t], tol);
      if (!change) continue;
      const cb = centroidT(b);
      const ct = tBrep.faces[t].centroid;
      const dist = Math.hypot(ct[0] - cb[0], ct[1] - cb[1], ct[2] - cb[2]);
      const reach = Math.max(3 * Math.sqrt(Math.max(tBrep.faces[t].area, bBrep.faces[b].area * map.scale ** 2)), 0.05 * diag);
      if (dist <= reach) candidates.push({ b, t, dist, change });
    }
  }
  candidates.sort((x, y) => x.dist - y.dist || x.t - y.t || x.b - y.b);
  const pairedB = new Int32Array(FB).fill(-1);
  const pairedT = new Int32Array(FT).fill(-1);
  const pairs: typeof candidates = [];
  for (const c of candidates) {
    if (pairedB[c.b] >= 0 || pairedT[c.t] >= 0) continue;
    pairedB[c.b] = c.t;
    pairedT[c.t] = c.b;
    pairs.push(c);
  }

  // ---- 4. Triangle and vertex statuses ---------------------------------------------------------
  const { targetFaceStatus, baseFaceStatus, targetVertexStatus, baseVertexStatus } = cls;
  let retriangulatedT = 0;
  let retriangulatedB = 0;
  for (let tri = 0; tri < target.faceCount; tri++) {
    const f = tBrep.faceOf[tri];
    if (f < 0 || f >= FT) continue;
    const s = partnersOfT[f].length > 0 ? (tCovered[tri] ? FaceStatus.Unchanged : FaceStatus.Added) : pairedT[f] >= 0 ? FaceStatus.Modified : FaceStatus.Added;
    if (s === FaceStatus.Unchanged && targetFaceStatus[tri] !== FaceStatus.Unchanged) retriangulatedT++;
    targetFaceStatus[tri] = s;
  }
  for (let tri = 0; tri < base.faceCount; tri++) {
    const f = bBrep.faceOf[tri];
    if (f < 0 || f >= FB) continue;
    const s = partnersOfB[f].length > 0 ? (bCovered[tri] ? FaceStatus.Unchanged : FaceStatus.Removed) : pairedB[f] >= 0 ? FaceStatus.Modified : FaceStatus.Removed;
    if (s === FaceStatus.Unchanged && baseFaceStatus[tri] !== FaceStatus.Unchanged) retriangulatedB++;
    baseFaceStatus[tri] = s;
  }
  settleVertices(target, targetFaceStatus, targetVertexStatus);
  settleVertices(base, baseFaceStatus, baseVertexStatus);
  cls.stats = recount(cls, target.faceCount, base.faceCount);

  // ---- 5. The report ---------------------------------------------------------------------------
  const changes: IBrepFaceChange[] = [];
  let unchanged = 0;
  const uncoveredFocus = (mesh: IMesh, idx: IFaceIndex, faces: number[], cov: Uint8Array, toT: (p: Vec3) => Vec3): Vec3 | null => {
    const sum: Vec3 = [0, 0, 0];
    let n = 0;
    for (const f of faces) {
      for (let i = idx.offsets[f]; i < idx.offsets[f + 1]; i++) {
        const tri = idx.triangles[i];
        if (cov[tri]) continue;
        const c = toT(triangleCentroid(mesh, tri));
        for (let k = 0; k < 3; k++) sum[k] += c[k];
        n++;
      }
    }
    return n > 0 ? [sum[0] / n, sum[1] / n, sum[2] / n] : null;
  };
  for (const { bs, ts } of groupsOf.values()) {
    const focus = uncoveredFocus(target, tIdx, ts, tCovered, (p) => p) ?? uncoveredFocus(base, bIdx, bs, bCovered, map.toTarget);
    if (!focus) {
      unchanged += ts.length;
      continue;
    }
    const areaB = bs.reduce((a, b) => a + bBrep.faces[b].area, 0) * map.scale ** 2;
    const areaT = ts.reduce((a, t) => a + tBrep.faces[t].area, 0);
    const what = describeSurface(tSurf[ts[0]]);
    changes.push({
      kind: 'reshaped',
      surface: tSurf[ts[0]].type,
      baseFaces: bs,
      targetFaces: ts,
      group: tBrep.faces[ts[0]].group,
      description: `${what}: outline changed${Math.abs(areaT - areaB) > tol * diag ? `, area ${mm(areaB)} → ${mm(areaT)} mm²` : ''}`,
      area: [areaB, areaT],
      focus,
    });
  }
  for (const { b, t, change } of pairs) {
    const sb = baseSurf[b];
    const st = tSurf[t];
    const moved = len(change.offset) > tol;
    const parts: string[] = [];
    if (change.size) parts.push(`${sizeOf(sb, change.size[0])} → ${sizeOf(st, change.size[1])}`);
    if (moved) parts.push(`moved ${mm(len(change.offset))} mm ${describeVector(change.offset)}`);
    const name = describeSurface(sb).replace(/ (?:Ø|r)[\d.]+$| [\d.]+°$/, '');
    const item: IBrepFaceChange = {
      kind: change.size ? 'resized' : 'moved',
      surface: st.type,
      baseFaces: [b],
      targetFaces: [t],
      group: tBrep.faces[t].group,
      description: `${change.size ? name : describeSurface(sb)} ${parts.join(', ') || 'changed'}`,
      area: [bBrep.faces[b].area * map.scale ** 2, tBrep.faces[t].area],
      focus: tBrep.faces[t].centroid,
    };
    if (moved) item.offset = change.offset;
    // Diameters for full cylinders and spheres, full angles for cones, else radii (as described).
    const k = (st.type === 'cylinder' && st.full) || st.type === 'sphere' || st.type === 'cone' ? 2 : 1;
    if (change.size) item.size = [change.size[0] * k, change.size[1] * k];
    changes.push(item);
  }
  for (const t of loneT) {
    if (pairedT[t] >= 0) continue;
    changes.push({ kind: 'added', surface: tSurf[t].type, baseFaces: [], targetFaces: [t], group: tBrep.faces[t].group, description: `new ${describeSurface(tSurf[t])}`, area: [0, tBrep.faces[t].area], focus: tBrep.faces[t].centroid });
  }
  for (const b of loneB) {
    if (pairedB[b] >= 0) continue;
    changes.push({ kind: 'removed', surface: baseSurf[b].type, baseFaces: [b], targetFaces: [], group: bBrep.faces[b].group, description: `${describeSurface(baseSurf[b])} removed`, area: [bBrep.faces[b].area * map.scale ** 2, 0], focus: centroidT(b) });
  }
  const order: Record<IBrepFaceChange['kind'], number> = { moved: 0, resized: 1, added: 2, removed: 3, reshaped: 4 };
  changes.sort((x, y) => order[x.kind] - order[y.kind] || (x.targetFaces[0] ?? Infinity) - (y.targetFaces[0] ?? Infinity) || (x.baseFaces[0] ?? Infinity) - (y.baseFaces[0] ?? Infinity));
  return { baseFaces: FB, targetFaces: FT, unchanged, changes, retriangulated: { base: retriangulatedB, target: retriangulatedT } };
}

/** For 'other' surfaces: whether at least half of each face's triangle centres lie on the other face. */
function shareShape(target: IMesh, tIdx: IFaceIndex, t: number, base: IMesh, bIdx: IFaceIndex, b: number, tBvh: FaceBvhs, bBvh: FaceBvhs, map: ReturnType<typeof mappers>, coverTol: number): boolean {
  const fraction = (mesh: IMesh, idx: IFaceIndex, f: number, test: (c: Vec3) => boolean): number => {
    const n = idx.offsets[f + 1] - idx.offsets[f];
    if (n === 0) return 0;
    let on = 0;
    for (let i = idx.offsets[f]; i < idx.offsets[f + 1]; i++) if (test(triangleCentroid(mesh, idx.triangles[i]))) on++;
    return on / n;
  };
  return (
    fraction(target, tIdx, t, (c) => covered(map.toBase(c), [b], bBvh, coverTol / map.scale)) >= 0.5 &&
    fraction(base, bIdx, b, (c) => covered(map.toTarget(c), [t], tBvh, coverTol)) >= 0.5
  );
}

/** A vertex whose every triangle is unchanged is unchanged (it only slid along a CAD face, or was re-meshed). */
function settleVertices(mesh: IMesh, faceStatus: Uint8Array, vertexStatus: Uint8Array): void {
  const touchesChange = new Uint8Array(mesh.vertexCount);
  const f = mesh.faces;
  for (let t = 0; t < mesh.faceCount; t++) {
    if (faceStatus[t] === FaceStatus.Unchanged) continue;
    touchesChange[f[t * 3]] = 1;
    touchesChange[f[t * 3 + 1]] = 1;
    touchesChange[f[t * 3 + 2]] = 1;
  }
  for (let v = 0; v < mesh.vertexCount; v++) if (!touchesChange[v]) vertexStatus[v] = VertexStatus.Unchanged;
}

function recount(cls: IClassification, targetFaces: number, baseFaces: number): IDiffStats {
  const vertices = { unchanged: 0, moved: 0, added: 0, removed: 0 };
  let maxD = 0;
  let sumD = 0;
  for (let v = 0; v < cls.targetVertexStatus.length; v++) {
    const s = cls.targetVertexStatus[v];
    if (s === VertexStatus.Moved) {
      vertices.moved++;
      const d = cls.displacement[v];
      sumD += d;
      if (d > maxD) maxD = d;
    } else if (s === VertexStatus.Added) vertices.added++;
    else vertices.unchanged++;
  }
  for (let v = 0; v < cls.baseVertexStatus.length; v++) if (cls.baseVertexStatus[v] === VertexStatus.Removed) vertices.removed++;
  const faces = { unchanged: 0, modified: 0, added: 0, removed: 0 };
  for (let t = 0; t < targetFaces; t++) {
    const s = cls.targetFaceStatus[t];
    if (s === FaceStatus.Added) faces.added++;
    else if (s === FaceStatus.Modified) faces.modified++;
    else faces.unchanged++;
  }
  for (let t = 0; t < baseFaces; t++) if (cls.baseFaceStatus[t] === FaceStatus.Removed) faces.removed++;
  return { vertices, faces, maxDisplacement: maxD, meanDisplacement: vertices.moved > 0 ? sumD / vertices.moved : 0 };
}
