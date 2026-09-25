/**
 * Test-input builders for the parser tests: ASCII / binary STL, OBJ text, and a tiny
 * glTF writer (JSON + BIN → GLB bytes or .gltf text with a base64 data: URI).
 * Deliberately independent from src/parsers/gltf-container.ts.
 */
import type { Vec3 } from '../../src/types.js';

export type Tri = [Vec3, Vec3, Vec3];

/** Unit cube corners. */
export const CUBE_CORNERS: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

/** 12 outward-facing (CCW) triangles, as indices into CUBE_CORNERS. */
export const CUBE_TRIS: [number, number, number][] = [
  [0, 2, 1],
  [0, 3, 2], // bottom z=0
  [4, 5, 6],
  [4, 6, 7], // top z=1
  [0, 1, 5],
  [0, 5, 4], // front y=0
  [3, 7, 6],
  [3, 6, 2], // back y=1
  [0, 4, 7],
  [0, 7, 3], // left x=0
  [1, 2, 6],
  [1, 6, 5], // right x=1
];

/**
 * The welded result expected for CUBE_TRIS in this order (first-appearance numbering):
 * corners enter as c0, c2, c1, c3, c4, c5, c6, c7.
 */
export const CUBE_EXPECTED_POSITIONS = [0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
export const CUBE_EXPECTED_FACES = [
  0, 1, 2, 0, 3, 1, 4, 5, 6, 4, 6, 7, 0, 2, 5, 0, 5, 4, 3, 7, 6, 3, 6, 1, 0, 4, 7, 0, 7, 3, 2, 1, 6, 2, 6, 5,
];

export function trianglesOf(corners: Vec3[], tris: number[][]): Tri[] {
  return tris.map((t) => [corners[t[0]], corners[t[1]], corners[t[2]]] as Tri);
}

export function cubeTriangles(offset: Vec3 = [0, 0, 0]): Tri[] {
  const moved = CUBE_CORNERS.map((c) => [c[0] + offset[0], c[1] + offset[1], c[2] + offset[2]] as Vec3);
  return trianglesOf(moved, CUBE_TRIS);
}

function normalOf(t: Tri): Vec3 {
  const [a, b, c] = t;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

export function asciiStl(solids: { name?: string; tris: Tri[] }[], eol = '\n'): string {
  const out: string[] = [];
  for (const s of solids) {
    out.push(s.name ? `solid ${s.name}` : 'solid');
    for (const t of s.tris) {
      out.push(`  facet normal ${normalOf(t).join(' ')}`, '    outer loop');
      for (const v of t) out.push(`      vertex ${v.map((x) => x.toExponential(8)).join(' ')}`);
      out.push('    endloop', '  endfacet');
    }
    out.push(s.name ? `endsolid ${s.name}` : 'endsolid');
  }
  return out.join(eol) + eol;
}

export interface BinaryStlOptions {
  header?: string;
  /** Per-triangle 15-bit colour word (bit 15 clear = own colour), Magics layout. */
  colors?: number[];
  trailingBytes?: number;
}

export function binaryStl(tris: Tri[], opts: BinaryStlOptions = {}): Uint8Array {
  const size = 84 + 50 * tris.length + (opts.trailingBytes ?? 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const header = opts.header ?? 'binary stl written by polymerge tests';
  for (let i = 0; i < Math.min(80, header.length); i++) bytes[i] = header.charCodeAt(i);
  view.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + 50 * i;
    const n = normalOf(t);
    for (let k = 0; k < 3; k++) view.setFloat32(o + k * 4, n[k], true);
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) view.setFloat32(o + 12 + v * 12 + k * 4, t[v][k], true);
    view.setUint16(o + 48, opts.colors?.[i] ?? 0, true);
  });
  return bytes;
}

/** OBJ text from 0-based indexed triangles/polygons. */
export function objText(verts: Vec3[], faces: number[][], preamble: string[] = []): string {
  return [
    ...preamble,
    ...verts.map((v) => `v ${v.join(' ')}`),
    ...faces.map((f) => `f ${f.map((i) => i + 1).join(' ')}`),
    '',
  ].join('\n');
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// glTF writer
// ---------------------------------------------------------------------------

export interface PrimitiveSpec {
  positions: number[];
  /** POSITION component type (default FLOAT) and optional byteStride (interleaved-style padding). */
  positionComponentType?: number;
  positionStride?: number;
  positionNormalized?: boolean;
  indices?: number[];
  /** Written as the custom attribute `_VERTEX_ID` (UNSIGNED_INT scalar). */
  vertexIds?: number[];
  material?: number;
  /** 4 = TRIANGLES (default), 0 = POINTS, 1 = LINES. */
  mode?: number;
  /** Extra attributes: name → { data, type, componentType }. */
  attributes?: Record<string, { data: number[]; type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4'; componentType: number }>;
  /** Morph targets: POSITION displacements per target. */
  targets?: number[][];
  extensions?: Record<string, unknown>;
}

export interface NodeSpec {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  translation?: Vec3;
  rotation?: [number, number, number, number];
  scale?: Vec3;
  matrix?: number[];
  extensions?: Record<string, unknown>;
}

export interface GltfSpec {
  meshes: { name?: string; weights?: number[]; primitives: PrimitiveSpec[] }[];
  nodes: NodeSpec[];
  /** Root node lists per scene; default: one scene with every node that is nobody's child. */
  scenes?: number[][];
  materials?: Record<string, unknown>[];
  /** Extra accessors appended after the primitives' ones (e.g. skin matrices), by key. */
  extraAccessors?: Record<string, { data: number[]; type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4'; componentType: number }>;
  /** Extra top-level JSON (skins, images, textures, extensionsUsed, ...). May reference `@accessor:<key>`. */
  extra?: Record<string, unknown>;
  generator?: string;
}

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as const;

export interface BuiltGltf {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  bin: Uint8Array;
}

export function buildGltf(spec: GltfSpec): BuiltGltf {
  const chunks: Uint8Array[] = [];
  let binLength = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];

  const addAccessor = (
    data: number[],
    type: keyof typeof COMPONENTS,
    componentType: number,
    withBounds = false,
    stride?: number,
  ): number => {
    const Ctor =
      componentType === FLOAT
        ? Float32Array
        : componentType === UNSIGNED_INT
          ? Uint32Array
          : componentType === 5123
            ? Uint16Array
            : componentType === 5122
              ? Int16Array
              : Uint8Array;
    const typed = new Ctor(data);
    let bytes = new Uint8Array(typed.buffer.slice(0));
    const itemBytes = COMPONENTS[type] * Ctor.BYTES_PER_ELEMENT;
    if (stride !== undefined && stride !== itemBytes) {
      const count = data.length / COMPONENTS[type];
      const strided = new Uint8Array(count * stride).fill(0x7f);
      for (let i = 0; i < count; i++) strided.set(bytes.subarray(i * itemBytes, (i + 1) * itemBytes), i * stride);
      bytes = strided;
    }
    const offset = binLength;
    chunks.push(bytes);
    const padded = (bytes.length + 3) & ~3;
    if (padded > bytes.length) chunks.push(new Uint8Array(padded - bytes.length));
    binLength += padded;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(stride ? { byteStride: stride } : {}) });
    const acc: Record<string, unknown> = {
      bufferView: bufferViews.length - 1,
      componentType,
      count: data.length / COMPONENTS[type],
      type,
    };
    if (withBounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], Math.fround(data[i + k]));
          max[k] = Math.max(max[k], Math.fround(data[i + k]));
        }
      }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  const meshes = spec.meshes.map((m) => ({
    ...(m.name ? { name: m.name } : {}),
    ...(m.weights ? { weights: m.weights } : {}),
    primitives: m.primitives.map((p) => {
      const attributes: Record<string, number> = {
        POSITION: addAccessor(p.positions, 'VEC3', p.positionComponentType ?? FLOAT, true, p.positionStride),
      };
      if (p.positionNormalized) accessors[attributes.POSITION].normalized = true;
      if (p.vertexIds) attributes._VERTEX_ID = addAccessor(p.vertexIds, 'SCALAR', UNSIGNED_INT);
      for (const [name, a] of Object.entries(p.attributes ?? {})) attributes[name] = addAccessor(a.data, a.type, a.componentType);
      const prim: Record<string, unknown> = { attributes };
      if (p.indices) prim.indices = addAccessor(p.indices, 'SCALAR', UNSIGNED_INT);
      if (p.material !== undefined) prim.material = p.material;
      if (p.mode !== undefined) prim.mode = p.mode;
      if (p.targets) prim.targets = p.targets.map((t) => ({ POSITION: addAccessor(t, 'VEC3', FLOAT, true) }));
      if (p.extensions) prim.extensions = p.extensions;
      return prim;
    }),
  }));

  const extraAccessorIndex: Record<string, number> = {};
  for (const [key, a] of Object.entries(spec.extraAccessors ?? {})) {
    extraAccessorIndex[key] = addAccessor(a.data, a.type, a.componentType);
  }

  const childSet = new Set(spec.nodes.flatMap((n) => n.children ?? []));
  const roots = spec.nodes.map((_, i) => i).filter((i) => !childSet.has(i));
  const scenes = (spec.scenes ?? [roots]).map((nodes) => ({ nodes }));

  const bin = new Uint8Array(binLength);
  let o = 0;
  for (const c of chunks) {
    bin.set(c, o);
    o += c.length;
  }

  const json = {
    asset: { version: '2.0', generator: spec.generator ?? 'polymerge-tests' },
    scene: 0,
    scenes,
    nodes: spec.nodes,
    meshes,
    ...(spec.materials ? { materials: spec.materials } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
    ...(spec.extra ?? {}),
  };
  // Resolve "@accessor:<key>" placeholders anywhere in the JSON.
  const resolved = JSON.parse(
    JSON.stringify(json).replace(/"@accessor:([^"]+)"/g, (_, key: string) => String(extraAccessorIndex[key])),
  );
  return { json: resolved, bin };
}

/** GLB bytes (JSON chunk + BIN chunk). `offsetPad` > 0 returns a view with that byteOffset. */
export function glbBytes(gltf: BuiltGltf, offsetPad = 0, jsonPadByte = 0x20): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(gltf.json));
  const jsonLen = (json.length + 3) & ~3;
  const binLen = (gltf.bin.length + 3) & ~3;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(offsetPad + total + 5);
  const view = new DataView(out.buffer, offsetPad);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(json, offsetPad + 20);
  out.fill(jsonPadByte, offsetPad + 20 + json.length, offsetPad + 20 + jsonLen);
  view.setUint32(20 + jsonLen, binLen, true);
  view.setUint32(24 + jsonLen, 0x004e4942, true);
  out.set(gltf.bin, offsetPad + 28 + jsonLen);
  out.fill(0xee, offsetPad + total); // garbage after the view, must be ignored
  return out.subarray(offsetPad, offsetPad + total);
}

/** .gltf JSON text with the BIN embedded as a base64 data: URI. */
export function gltfText(gltf: BuiltGltf): string {
  const json = structuredClone(gltf.json);
  let binary = '';
  for (const b of gltf.bin) binary += String.fromCharCode(b);
  json.buffers[0].uri = `data:application/octet-stream;base64,${btoa(binary)}`;
  return JSON.stringify(json, null, 2);
}

/** Positions and faces of a mesh as plain arrays (for toEqual). */
export function arraysOf(mesh: { positions: Float64Array; faces: Uint32Array }): { positions: number[]; faces: number[] } {
  return { positions: Array.from(mesh.positions), faces: Array.from(mesh.faces) };
}

/** Flat positions array of a triangle soup, indexed by CUBE_TRIS order. */
export function soupPositions(tris: Tri[]): number[] {
  return tris.flatMap((t) => t.flatMap((v) => v));
}
