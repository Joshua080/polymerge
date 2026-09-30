/**
 * Test helpers for the appearance merge: textured grids whose UV layout is a set of ISLANDS (each
 * with its own placement in texture space, so island borders are UV seams), per-face materials,
 * fake embedded images, and edits that keep per-face data (materials, per-corner UVs) in sync
 * with geometry edits.
 */
import { deflateSync } from 'node:zlib';
import { defaultMaterialDefinition, hashBytes, materialSummary } from '../../src/appearance.js';
import { createMesh } from '../../src/mesh.js';
import type { IMaterialDefinition, IMesh, ITextureImage, ITextureRef, Vec3 } from '../../src/types.js';

/** A fake embedded image: the bytes of `text`, identified by content (never decoded, so any bytes do). */
export function image(text: string, name = text): ITextureImage {
  const data = new TextEncoder().encode(`fake image: ${text}`);
  return { hash: hashBytes(data), data, mimeType: 'image/png', name };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A real (valid) size × size RGB PNG of one colour — what glTF validators accept as an image. */
export function png(rgb: [number, number, number], size = 2): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type));
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(body, 4);
    dv.setUint32(8 + data.length, crc32(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, deflate, no filter, no interlace
  const rows = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rows.set(rgb, y * (1 + size * 3) + 1 + x * 3);
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(rows))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A real PNG image (one colour) as an embedded ITextureImage. */
export function pngImage(name: string, rgb: [number, number, number]): ITextureImage {
  const data = png(rgb);
  return { hash: hashBytes(data), data, mimeType: 'image/png', name };
}

/** A material definition: glTF defaults, a name, overrides. */
export function def(name: string, over: Partial<IMaterialDefinition> = {}): IMaterialDefinition {
  return { ...defaultMaterialDefinition(), name, ...over };
}

/** A texture slot on image `image` through UV set `texCoord`. */
export function tex(image: number, texCoord = 0, extra: Partial<ITextureRef> = {}): ITextureRef {
  return { image, texCoord, ...extra };
}

export interface ILookSpec {
  /** Vertex grid size (quads: (nx − 1) × (ny − 1), two triangles each). */
  nx: number;
  ny: number;
  /** Island of quad (i, j). Default: one island. */
  island?: (i: number, j: number) => number;
  /** Placement of an island in texture space: uv = (u0 + x·s, v0 + y·s) for grid point (x, y). */
  place?: (island: number) => [u0: number, v0: number, s: number];
  materials: IMaterialDefinition[];
  /** Material of triangle t (0 | 1) of quad (i, j). Default 0. */
  material?: (i: number, j: number, t: number) => number;
  images?: ITextureImage[];
  /** Vertex displacements (geometry edits). */
  moves?: Record<number, Vec3>;
}

/** Face index of triangle t of quad (i, j) in a textured grid. */
export const quadFace = (spec: { nx: number }, i: number, j: number, t: 0 | 1 = 0): number => 2 * (j * (spec.nx - 1) + i) + t;

/**
 * An nx × ny textured grid (same vertex and face order as test/diff/util.ts `grid`): vertex (i, j) =
 * j·nx + i; quad (i, j) = triangles (a, b, d) and (a, d, c).
 */
export function textured(spec: ILookSpec): IMesh {
  const { nx, ny } = spec;
  const island = spec.island ?? (() => 0);
  const place = spec.place ?? (() => [0, 0, 1 / Math.max(nx, ny)]);
  const pos: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pos.push(i, j, 0);
  for (const [k, d] of Object.entries(spec.moves ?? {})) for (let a = 0; a < 3; a++) pos[Number(k) * 3 + a] += d[a];
  const faces: number[] = [];
  const uv: number[] = [];
  const faceMaterials: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      const [u0, v0, s] = place(island(i, j));
      const at = (v: number): number[] => [u0 + (v % nx) * s, v0 + Math.floor(v / nx) * s];
      faces.push(a, b, d, a, d, c);
      uv.push(...at(a), ...at(b), ...at(d), ...at(a), ...at(d), ...at(c));
      faceMaterials.push(spec.material?.(i, j, 0) ?? 0, spec.material?.(i, j, 1) ?? 0);
    }
  }
  return withAppearance(pos, faces, faceMaterials, spec.materials, spec.images ?? [], [uv]);
}

/**
 * An IMesh from explicit arrays (per-face materials, per-corner UVs per set). Materials no face uses
 * are dropped and the rest renumbered in first-use order, as the loader does.
 */
export function withAppearance(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  faceMaterials: number[],
  materials: IMaterialDefinition[],
  images: ITextureImage[],
  uvs: number[][],
): IMesh {
  const remap = new Map<number, number>();
  const fm = new Int32Array(faceMaterials.length);
  faceMaterials.forEach((m, f) => {
    if (m < 0) return void (fm[f] = -1);
    if (!remap.has(m)) remap.set(m, remap.size);
    fm[f] = remap.get(m)!;
  });
  const defs: IMaterialDefinition[] = [];
  for (const [m] of [...remap].sort((a, b) => a[1] - b[1])) defs.push(materials[m]);
  return createMesh(positions, faces, {
    materials: defs.map((d, i) => materialSummary(d, `material_${i}`)),
    faceMaterials: remap.size > 0 ? fm : undefined,
    appearance: { materials: defs, images, uvs: uvs.map((u) => Float32Array.from(u)) },
    metadata: { format: 'glb', sourceName: 'textured.glb' },
  });
}

/** Explicit arrays of a mesh with appearance, for editing. */
export interface ILookArrays {
  positions: number[];
  faces: number[];
  faceMaterials: number[];
  materials: IMaterialDefinition[];
  images: ITextureImage[];
  uvs: number[][];
}

export function arraysOf(mesh: IMesh): ILookArrays {
  const look = mesh.appearance!;
  return {
    positions: Array.from(mesh.positions),
    faces: Array.from(mesh.faces),
    faceMaterials: Array.from(mesh.faceMaterials ?? new Int32Array(mesh.faceCount).fill(-1)),
    materials: look.materials.map((d) => structuredClone(d)),
    images: [...look.images],
    uvs: look.uvs.map((u) => Array.from(u)),
  };
}

export function fromArrays(a: ILookArrays): IMesh {
  return withAppearance(a.positions, a.faces, a.faceMaterials, a.materials, a.images, a.uvs);
}

/** Copy of `mesh` with the listed faces removed (vertices kept only while some face uses them). */
export function dropFaces(mesh: IMesh, drop: Iterable<number>): IMesh {
  const a = arraysOf(mesh);
  const gone = new Set(drop);
  const keep = (f: number): boolean => !gone.has(f);
  const faces: number[] = [];
  const fm: number[] = [];
  const uvs: number[][] = a.uvs.map(() => []);
  for (let f = 0; f < mesh.faceCount; f++) {
    if (!keep(f)) continue;
    faces.push(...a.faces.slice(f * 3, f * 3 + 3));
    fm.push(a.faceMaterials[f]);
    a.uvs.forEach((u, k) => uvs[k].push(...u.slice(f * 6, f * 6 + 6)));
  }
  // Compact vertices no face uses any more (an IMesh has none).
  const used = new Uint8Array(mesh.vertexCount);
  for (const v of faces) used[v] = 1;
  const map = new Int32Array(mesh.vertexCount).fill(-1);
  const pos: number[] = [];
  let n = 0;
  for (let v = 0; v < mesh.vertexCount; v++) {
    if (!used[v]) continue;
    map[v] = n++;
    pos.push(...a.positions.slice(v * 3, v * 3 + 3));
  }
  return withAppearance(pos, faces.map((v) => map[v]), fm, a.materials, a.images, uvs);
}

/**
 * Copy of `mesh` with faces (and vertices) appended; per face: a material, and 6 UV values per set.
 * New faces' materials index the mesh's own materials followed by `extraMaterials`.
 */
export function appendFaces(
  mesh: IMesh,
  positions: number[],
  faces: number[],
  faceMaterials: number[],
  uvs: number[][],
  extraMaterials: IMaterialDefinition[] = [],
): IMesh {
  const a = arraysOf(mesh);
  return withAppearance(
    [...a.positions, ...positions],
    [...a.faces, ...faces],
    [...a.faceMaterials, ...faceMaterials],
    [...a.materials, ...extraMaterials],
    a.images,
    a.uvs.map((u, k) => [...u, ...(uvs[k] ?? [])]),
  );
}

/** Any mesh with one material and planar UVs (u, v) = uv(x, y, z) per corner. */
export function withLook(mesh: IMesh, material: IMaterialDefinition, uv: (x: number, y: number, z: number) => [number, number], images: ITextureImage[] = []): IMesh {
  const uvs: number[] = [];
  for (const v of mesh.faces) uvs.push(...uv(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]));
  return withAppearance(mesh.positions, mesh.faces, new Array<number>(mesh.faceCount).fill(0), [material], images, [uvs]);
}

/** Copy of `mesh` with its material order reversed (same assignment, different indices). */
export function reverseMaterials(mesh: IMesh): IMesh {
  const n = mesh.materials.length;
  const fm = Int32Array.from(mesh.faceMaterials!, (m) => (m < 0 ? m : n - 1 - m));
  return createMesh(mesh.positions, mesh.faces, {
    materials: [...mesh.materials].reverse(),
    faceMaterials: fm,
    appearance: { ...mesh.appearance!, materials: [...mesh.appearance!.materials].reverse() },
    metadata: { format: 'glb', sourceName: 'reversed.glb' },
  });
}

/** UVs of face f in set k (6 numbers). */
export function faceUv(mesh: IMesh, f: number, k = 0): number[] {
  return Array.from(mesh.appearance!.uvs[k].subarray(f * 6, f * 6 + 6));
}
