/**
 * Test helpers for the diff engine: procedural meshes, permutations, rigid transforms,
 * a capturing logger and a correspondence-invariant checker.
 */
import { expect } from 'vitest';
import { createMesh } from '../../src/mesh.js';
import { FaceStatus, VertexStatus, type IDiffLogger, type IDiffResult, type IMesh } from '../../src/types.js';
import { mulberry32 } from '../../src/diff/prng.js';

export type HeightFn = (x: number, y: number) => number;

/** nx × ny vertex grid in the XY plane (spacing s), z = height(x, y). Vertex (i, j) = j·nx + i. */
export function grid(nx: number, ny: number, opts: { spacing?: number; height?: HeightFn; flip?: boolean; name?: string } = {}): IMesh {
  const s = opts.spacing ?? 1;
  const h = opts.height ?? (() => 0);
  const pos: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) pos.push(i * s, j * s, h(i * s, j * s));
  }
  const faces: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      if (opts.flip) faces.push(a, b, c, b, d, c);
      else faces.push(a, b, d, a, d, c);
    }
  }
  return createMesh(pos, faces, { metadata: { sourceName: opts.name ?? 'grid' } });
}

/** Axis-aligned unit cube (8 vertices, 12 triangles, outward winding). */
export function cube(size = 1): IMesh {
  const s = size;
  const pos = [0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s];
  const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return createMesh(pos, faces, { metadata: { sourceName: 'cube' } });
}

/**
 * UV sphere: 2 poles + (rings − 1) latitude rings of `seg` vertices, optionally deformed.
 * Default deformation makes it an asymmetric "pebble" with no rotational/reflective symmetry.
 */
export function uvSphere(seg: number, rings: number, deform?: (x: number, y: number, z: number) => [number, number, number]): IMesh {
  const f = deform ?? ((x: number, y: number, z: number) => [x, y, z] as [number, number, number]);
  const pos: number[] = [];
  pos.push(...f(0, 0, 1));
  for (let r = 1; r < rings; r++) {
    const th = (Math.PI * r) / rings;
    for (let k = 0; k < seg; k++) {
      const ph = (2 * Math.PI * k) / seg;
      pos.push(...f(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)));
    }
  }
  pos.push(...f(0, 0, -1));
  const south = 1 + (rings - 1) * seg;
  const ring = (r: number, k: number): number => 1 + (r - 1) * seg + (((k % seg) + seg) % seg);
  const faces: number[] = [];
  for (let k = 0; k < seg; k++) faces.push(0, ring(1, k), ring(1, k + 1));
  for (let r = 1; r < rings - 1; r++) {
    for (let k = 0; k < seg; k++) {
      const a = ring(r, k);
      const b = ring(r, k + 1);
      const c = ring(r + 1, k);
      const d = ring(r + 1, k + 1);
      faces.push(a, c, d, a, d, b);
    }
  }
  for (let k = 0; k < seg; k++) faces.push(south, ring(rings - 1, k + 1), ring(rings - 1, k));
  return createMesh(pos, faces, { metadata: { sourceName: 'sphere' } });
}

export const pebble = (x: number, y: number, z: number): [number, number, number] => [
  2.0 * x + 0.35 * y * y + 0.1 * z,
  1.2 * y + 0.3 * x * z,
  0.7 * z + 0.25 * x * x - 0.1 * y,
];

/** Asymmetric closed solid (deformed UV sphere). */
export function asymmetricSolid(seg = 32, rings = 16): IMesh {
  return uvSphere(seg, rings, pebble);
}

/** Open cylinder around Z: `seg` vertices per ring, `rings` rings from z=0 to z=h, angular phase offset. */
export function cylinder(seg: number, rings: number, opts: { r?: number; h?: number; phase?: number } = {}): IMesh {
  const r = opts.r ?? 1;
  const h = opts.h ?? 3;
  const phase = opts.phase ?? 0;
  const pos: number[] = [];
  for (let j = 0; j < rings; j++) {
    for (let k = 0; k < seg; k++) {
      const a = phase + (2 * Math.PI * k) / seg;
      pos.push(r * Math.cos(a), r * Math.sin(a), (h * j) / (rings - 1));
    }
  }
  const faces: number[] = [];
  for (let j = 0; j < rings - 1; j++) {
    for (let k = 0; k < seg; k++) {
      const a = j * seg + k;
      const b = j * seg + ((k + 1) % seg);
      const c = a + seg;
      const d = b + seg;
      faces.push(a, b, d, a, d, c);
    }
  }
  return createMesh(pos, faces, { metadata: { sourceName: 'cylinder' } });
}

/**
 * Closed cylinder (r = 1, z ∈ [−1, 1]) with both caps as triangle fans around a centre
 * vertex — the tessellation that lets coincident cap centres + every-k-th ring vertices
 * support topological propagation across two different segment counts.
 */
export function cappedCylinder(seg: number): IMesh {
  const pos: number[] = [0, 0, -1, 0, 0, 1];
  for (const z of [-1, 1]) {
    for (let k = 0; k < seg; k++) {
      const a = (2 * Math.PI * k) / seg;
      pos.push(Math.cos(a), Math.sin(a), z);
    }
  }
  const lo = (k: number): number => 2 + (k % seg);
  const hi = (k: number): number => 2 + seg + (k % seg);
  const faces: number[] = [];
  for (let k = 0; k < seg; k++) {
    faces.push(0, lo(k + 1), lo(k)); // bottom fan
    faces.push(1, hi(k), hi(k + 1)); // top fan
    faces.push(lo(k), lo(k + 1), hi(k + 1), lo(k), hi(k + 1), hi(k)); // side quad
  }
  return createMesh(pos, faces, { metadata: { sourceName: `cylinder${seg}` } });
}

/** Seeded random permutation of [0, n). */
export function randomPermutation(n: number, seed: number): Uint32Array {
  const p = new Uint32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const rand = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  return p;
}

/**
 * Re-index a mesh: old vertex i becomes new vertex perm[i]; faces are remapped
 * (and optionally shuffled with `faceSeed`). Returns the permuted mesh.
 */
export function permuteMesh(mesh: IMesh, perm: ArrayLike<number>, faceSeed?: number): IMesh {
  const n = mesh.vertexCount;
  const pos = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = perm[i];
    pos[j * 3] = mesh.positions[i * 3];
    pos[j * 3 + 1] = mesh.positions[i * 3 + 1];
    pos[j * 3 + 2] = mesh.positions[i * 3 + 2];
  }
  const faces = new Uint32Array(mesh.faces.length);
  for (let i = 0; i < faces.length; i++) faces[i] = perm[mesh.faces[i]];
  if (faceSeed !== undefined) {
    const order = randomPermutation(mesh.faceCount, faceSeed);
    const shuffled = new Uint32Array(faces.length);
    for (let f = 0; f < mesh.faceCount; f++) {
      const g = order[f];
      shuffled[g * 3] = faces[f * 3];
      shuffled[g * 3 + 1] = faces[f * 3 + 1];
      shuffled[g * 3 + 2] = faces[f * 3 + 2];
    }
    return createMesh(pos, shuffled, { metadata: { sourceName: mesh.metadata.sourceName } });
  }
  return createMesh(pos, faces, { metadata: { sourceName: mesh.metadata.sourceName } });
}

/** Row-major rotation matrix about a (normalised) axis by `deg` degrees (Rodrigues). */
export function axisAngle(axis: [number, number, number], deg: number): number[] {
  const n = Math.hypot(...axis);
  const [x, y, z] = axis.map((v) => v / n);
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

/** Apply x ↦ R·x + t (R row-major) to every vertex. */
export function transformMesh(mesh: IMesh, r: number[], t: [number, number, number]): IMesh {
  const p = mesh.positions;
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    out[i] = r[0] * x + r[1] * y + r[2] * z + t[0];
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z + t[1];
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z + t[2];
  }
  return createMesh(out, mesh.faces, { metadata: { sourceName: mesh.metadata.sourceName } });
}

/** Copy of `mesh` with some vertices displaced. */
export function withMoves(mesh: IMesh, moves: Record<number, [number, number, number]>): IMesh {
  const pos = Float64Array.from(mesh.positions);
  for (const [k, d] of Object.entries(moves)) {
    const i = Number(k);
    pos[i * 3] += d[0];
    pos[i * 3 + 1] += d[1];
    pos[i * 3 + 2] += d[2];
  }
  return createMesh(pos, mesh.faces, { metadata: { sourceName: mesh.metadata.sourceName } });
}

/** Append extra vertices/faces (face indices may reference existing or new vertices). */
export function appendGeometry(mesh: IMesh, positions: number[], faces: number[]): IMesh {
  return createMesh([...mesh.positions, ...positions], [...mesh.faces, ...faces], {
    metadata: { sourceName: mesh.metadata.sourceName },
  });
}

/**
 * Remove every face touching one of `drop`, then drop unreferenced vertices, compacting
 * indices in their original order. Returns the mesh and old→new vertex map (-1 = gone).
 */
export function removeVertices(mesh: IMesh, drop: Iterable<number>): { mesh: IMesh; map: Int32Array } {
  const dropSet = new Set(drop);
  const keptFaces: number[] = [];
  for (let f = 0; f < mesh.faceCount; f++) {
    const tri = [mesh.faces[f * 3], mesh.faces[f * 3 + 1], mesh.faces[f * 3 + 2]];
    if (tri.some((v) => dropSet.has(v))) continue;
    keptFaces.push(...tri);
  }
  const used = new Uint8Array(mesh.vertexCount);
  for (const v of keptFaces) used[v] = 1;
  const map = new Int32Array(mesh.vertexCount).fill(-1);
  const pos: number[] = [];
  let n = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    if (!used[v]) continue;
    map[v] = n++;
    pos.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
  }
  return {
    mesh: createMesh(pos, keptFaces.map((v) => map[v]), { metadata: { sourceName: mesh.metadata.sourceName } }),
    map,
  };
}

export interface ICapture {
  logger: IDiffLogger;
  info: string[];
  warn: string[];
}

export function captureLogger(): ICapture {
  const info: string[] = [];
  const warn: string[] = [];
  return { logger: { info: (m) => info.push(m), warn: (m) => warn.push(m) }, info, warn };
}

/** A logger that swallows everything (keeps test output clean). */
export const silent: IDiffLogger = { info: () => {}, warn: () => {} };

/** Assert every structural invariant of an IDiffResult from types.ts. */
export function assertInvariants(r: IDiffResult, base: IMesh, target: IMesh): void {
  expect(r.baseToTarget.length).toBe(base.vertexCount);
  expect(r.targetToBase.length).toBe(target.vertexCount);
  expect(r.baseVertexStatus.length).toBe(base.vertexCount);
  expect(r.targetVertexStatus.length).toBe(target.vertexCount);
  expect(r.displacement.length).toBe(target.vertexCount);
  expect(r.baseFaceStatus.length).toBe(base.faceCount);
  expect(r.targetFaceStatus.length).toBe(target.faceCount);
  expect(r.attempts.length).toBeGreaterThan(0);
  expect(r.attempts[r.attempts.length - 1].accepted).toBe(true);
  expect(r.attempts[r.attempts.length - 1].tier).toBe(r.tier);
  for (const a of r.attempts.slice(0, -1)) expect(a.accepted).toBe(false);

  let bad = 0;
  for (let t = 0; t < target.vertexCount; t++) {
    const b = r.targetToBase[t];
    const s = r.targetVertexStatus[t];
    if (b < -1 || b >= base.vertexCount) bad++;
    if (b < 0 && s !== VertexStatus.Added) bad++;
    if (b >= 0 && s === VertexStatus.Added) bad++;
    if (s === VertexStatus.Removed) bad++;
    if (s === VertexStatus.Added && r.displacement[t] !== 0) bad++;
    if (r.tier !== 3 && b >= 0 && r.baseToTarget[b] !== t) bad++; // bijection
  }
  for (let b = 0; b < base.vertexCount; b++) {
    const t = r.baseToTarget[b];
    const s = r.baseVertexStatus[b];
    if (t < -1 || t >= target.vertexCount) bad++;
    if (t < 0 && s !== VertexStatus.Removed) bad++;
    if (t >= 0 && s === VertexStatus.Removed) bad++;
    if (s === VertexStatus.Added) bad++;
    if (r.tier !== 3 && t >= 0 && r.targetToBase[t] !== b) bad++;
    if (r.tier !== 3 && t >= 0 && r.targetVertexStatus[t] !== s) bad++;
  }
  expect(bad).toBe(0);
  for (const s of r.targetFaceStatus) expect(s === FaceStatus.Removed).toBe(false);
  for (const s of r.baseFaceStatus) expect(s === FaceStatus.Added).toBe(false);

  // Stats agree with the arrays.
  const count = (arr: Uint8Array, v: number): number => arr.reduce((n, x) => n + (x === v ? 1 : 0), 0);
  expect(r.stats.vertices.added).toBe(count(r.targetVertexStatus, VertexStatus.Added));
  expect(r.stats.vertices.removed).toBe(count(r.baseVertexStatus, VertexStatus.Removed));
  expect(r.stats.vertices.moved).toBe(count(r.targetVertexStatus, VertexStatus.Moved));
  expect(r.stats.vertices.unchanged).toBe(count(r.targetVertexStatus, VertexStatus.Unchanged));
  expect(r.stats.faces.added).toBe(count(r.targetFaceStatus, FaceStatus.Added));
  expect(r.stats.faces.removed).toBe(count(r.baseFaceStatus, FaceStatus.Removed));
  expect(r.stats.faces.modified).toBe(count(r.targetFaceStatus, FaceStatus.Modified));
  expect(r.stats.faces.unchanged).toBe(count(r.targetFaceStatus, FaceStatus.Unchanged));
  if (r.tier !== 3) {
    // With a bijection both sides agree on moved/modified counts.
    expect(count(r.baseVertexStatus, VertexStatus.Moved)).toBe(r.stats.vertices.moved);
    expect(count(r.baseFaceStatus, FaceStatus.Modified)).toBe(r.stats.faces.modified);
  }
}
