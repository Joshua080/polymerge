/**
 * Minimal, deterministic WRITERS for STL (ASCII + binary), OBJ, GLB and JSON
 * glTF with an embedded base64 data: URI buffer. (The project's "no hand-written
 * tokenizers" rule is about parsing; writing is fine.)
 *
 * Floats are written as float32 (binary) or as the shortest text that parses
 * back to the identical float32 value (text), so every format round-trips to
 * the same float32 coordinates — the precondition for cross-format Tier 1.
 */
import type { FileDoc, GltfDoc, ObjDoc, StlDoc } from './documents.js';
import { fmt, triangleNormal } from './math.js';

const encoder = new TextEncoder();

export function writeFile(doc: FileDoc): Uint8Array {
  switch (doc.kind) {
    case 'stl':
      return doc.encoding === 'ascii' ? writeStlAscii(doc) : writeStlBinary(doc);
    case 'obj':
      return writeObj(doc);
    case 'gltf':
      return doc.container === 'glb' ? writeGlb(doc) : writeGltfJson(doc);
  }
}

// --------------------------------- STL ------------------------------------

export function writeStlBinary(doc: StlDoc): Uint8Array {
  if (/^\s*solid/i.test(doc.header)) throw new Error('binary STL header must not start with "solid"');
  const n = doc.triangles.length;
  const buf = new ArrayBuffer(84 + 50 * n);
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  const header = encoder.encode(doc.header);
  if (header.length > 80) throw new Error('binary STL header longer than 80 bytes');
  bytes.fill(0x20, 0, 80);
  bytes.set(header, 0);
  dv.setUint32(80, n, true);
  let o = 84;
  for (const tri of doc.triangles) {
    const nrm = triangleNormal(tri[0].p, tri[1].p, tri[2].p);
    for (const v of [nrm, tri[0].p, tri[1].p, tri[2].p]) {
      dv.setFloat32(o, v[0], true);
      dv.setFloat32(o + 4, v[1], true);
      dv.setFloat32(o + 8, v[2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}

export function writeStlAscii(doc: StlDoc): Uint8Array {
  if (/endsolid/.test(doc.solidName)) throw new Error('solid name must not contain "endsolid"');
  const lines: string[] = [`solid ${doc.solidName}`];
  for (const tri of doc.triangles) {
    const nrm = triangleNormal(tri[0].p, tri[1].p, tri[2].p);
    lines.push(`  facet normal ${fmt(nrm[0])} ${fmt(nrm[1])} ${fmt(nrm[2])}`);
    lines.push('    outer loop');
    for (const c of tri) lines.push(`      vertex ${fmt(c.p[0])} ${fmt(c.p[1])} ${fmt(c.p[2])}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${doc.solidName}`);
  return encoder.encode(lines.join('\n') + '\n');
}

// --------------------------------- OBJ ------------------------------------

export function writeObj(doc: ObjDoc): Uint8Array {
  const lines: string[] = doc.comments.map((c) => `# ${c}`);
  for (const v of doc.vertices) lines.push(`v ${fmt(v.p[0])} ${fmt(v.p[1])} ${fmt(v.p[2])}`);
  for (const s of doc.statements) {
    if (s.kind === 'f') lines.push(`f ${s.v[0] + 1} ${s.v[1] + 1} ${s.v[2] + 1}`);
    else lines.push(`${s.kind} ${s.name}`);
  }
  return encoder.encode(lines.join('\n') + '\n');
}

// -------------------------------- glTF ------------------------------------

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const TRIANGLES = 4;

interface BuiltGltf {
  json: Record<string, unknown>;
  bin: Uint8Array;
}

/** Build the glTF JSON (without buffer uri) and the 4-byte-aligned binary buffer. */
export function buildGltf(doc: GltfDoc): BuiltGltf {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];

  const addView = (data: Uint8Array, target: number): number => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length, target });
    chunks.push(data);
    byteLength += data.length;
    return bufferViews.length - 1;
  };
  const addAccessor = (a: Record<string, unknown>): number => {
    accessors.push(a);
    return accessors.length - 1;
  };

  const meshes = doc.meshes.map((mesh) => ({
    name: mesh.name,
    primitives: mesh.primitives.map((prim) => {
      const n = prim.vertices.length;
      const pos = new Float32Array(n * 3);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      prim.vertices.forEach((v, i) => {
        for (let k = 0; k < 3; k++) {
          pos[i * 3 + k] = v.p[k];
          const f = pos[i * 3 + k];
          if (f < min[k]) min[k] = f;
          if (f > max[k]) max[k] = f;
        }
      });
      const attributes: Record<string, number> = {
        POSITION: addAccessor({
          bufferView: addView(new Uint8Array(pos.buffer), ARRAY_BUFFER),
          componentType: FLOAT,
          count: n,
          type: 'VEC3',
          min,
          max,
        }),
      };
      if (prim.vertexIds) {
        if (prim.vertexIds.length !== n) throw new Error('vertexIds length mismatch');
        const ids = Float32Array.from(prim.vertexIds);
        ids.forEach((v, i) => {
          if (v !== prim.vertexIds![i]) throw new Error(`_VERTEX_ID ${prim.vertexIds![i]} is not float32-exact`);
        });
        attributes._VERTEX_ID = addAccessor({
          bufferView: addView(new Uint8Array(ids.buffer), ARRAY_BUFFER),
          componentType: FLOAT,
          count: n,
          type: 'SCALAR',
        });
      }
      const maxIndex = prim.indices.reduce((a, b) => Math.max(a, b), 0);
      const indexType = prim.indexType ?? (maxIndex < 65535 ? 'u16' : 'u32');
      const idx = indexType === 'u16' ? Uint16Array.from(prim.indices) : Uint32Array.from(prim.indices);
      if (idx.some((v, i) => v !== prim.indices[i])) throw new Error('index overflow');
      const indices = addAccessor({
        bufferView: addView(new Uint8Array(idx.buffer), ELEMENT_ARRAY_BUFFER),
        componentType: indexType === 'u16' ? UNSIGNED_SHORT : UNSIGNED_INT,
        count: prim.indices.length,
        type: 'SCALAR',
      });
      const out: Record<string, unknown> = { attributes, indices, mode: TRIANGLES };
      if (prim.material !== undefined) out.material = prim.material;
      return out;
    }),
  }));

  const pad = (4 - (byteLength % 4)) % 4;
  if (pad) {
    chunks.push(new Uint8Array(pad));
    byteLength += pad;
  }
  const bin = new Uint8Array(byteLength);
  let o = 0;
  for (const c of chunks) {
    bin.set(c, o);
    o += c.length;
  }

  const nodes = doc.nodes.map((n) => {
    const out: Record<string, unknown> = { name: n.name };
    if (n.translation) out.translation = n.translation;
    if (n.rotation) out.rotation = n.rotation;
    if (n.scale) out.scale = n.scale;
    if (n.mesh !== undefined) out.mesh = n.mesh;
    if (n.children && n.children.length) out.children = n.children;
    return out;
  });

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'polymerge fixtures generator' },
    scene: 0,
    scenes: [{ name: doc.sceneName, nodes: doc.sceneNodes }],
    nodes,
    meshes,
  };
  if (doc.materials.length) {
    json.materials = doc.materials.map((m) => ({
      name: m.name,
      pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: 0, roughnessFactor: 1 },
    }));
  }
  json.accessors = accessors;
  json.bufferViews = bufferViews;
  json.buffers = [{ byteLength: bin.length }];
  return { json, bin };
}

/** Assemble a GLB container: 12-byte header, JSON chunk (space-padded), BIN chunk (zero-padded). */
export function packGlb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const jsonRaw = encoder.encode(JSON.stringify(json));
  const jsonLen = Math.ceil(jsonRaw.length / 4) * 4;
  const binLen = Math.ceil(bin.length / 4) * 4;
  const total = 12 + 8 + jsonLen + (binLen > 0 ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.fill(0x20, 20, 20 + jsonLen);
  out.set(jsonRaw, 20);
  if (binLen > 0) {
    const o = 20 + jsonLen;
    dv.setUint32(o, binLen, true);
    dv.setUint32(o + 4, 0x004e4942, true); // "BIN\0"
    out.set(bin, o + 8);
  }
  return out;
}

export function writeGlb(doc: GltfDoc): Uint8Array {
  const { json, bin } = buildGltf(doc);
  return packGlb(json, bin);
}

export function writeGltfJson(doc: GltfDoc): Uint8Array {
  const { json, bin } = buildGltf(doc);
  const buffers = [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}` }];
  return encoder.encode(JSON.stringify({ ...json, buffers }, null, 2) + '\n');
}
