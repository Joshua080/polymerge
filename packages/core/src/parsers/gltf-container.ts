/**
 * glTF / GLB container pre-processing, done BEFORE three.js' GLTFLoader sees the asset.
 *
 * Why: GLTFLoader resolves every `uri` (data: URIs included) through FileLoader → fetch,
 * which fails under Node (`ProgressEvent is not defined`), and it loads textures through
 * image decoders that do not exist in Node and can stall in browsers. Rather than patch
 * globals, we hand GLTFLoader a self-contained in-memory GLB:
 *
 *  1. Parse the container: JSON text, or GLB (12-byte header + JSON chunk + optional BIN
 *     chunk). JSON.parse is used for the JSON; geometry decoding stays with GLTFLoader.
 *  2. Reject required geometry compression (KHR_draco_mesh_compression,
 *     EXT_meshopt_compression, KHR_meshopt_compression) with MeshLoadError; drop
 *     optional (non-required) uses so the loader reads the uncompressed fallback data.
 *  3. Strip `images`, `textures`, `samplers` and every `*Texture` reference inside
 *     materials (core and extensions), with one warning.
 *  4. Resolve every buffer to bytes (GLB BIN chunk for a uri-less buffer 0, decoded
 *     `data:` URIs; any other URI → MeshLoadError "external resources not supported in
 *     v1"), concatenate them into ONE binary blob (each buffer 4-byte aligned) and
 *     rewrite every bufferView's `buffer` / `byteOffset` into it.
 *  5. Serialise a GLB: header + JSON chunk (space-padded) + BIN chunk (zero-padded).
 */
import { MeshLoadError, type SourceFormat } from '../types.js';
import { decodeUtf8, readU32LE } from './bytes.js';

export interface GltfJson {
  asset?: { version?: unknown; generator?: unknown; minVersion?: unknown; copyright?: unknown };
  buffers?: { uri?: string; byteLength?: number; [k: string]: unknown }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number; extensions?: Record<string, unknown> }[];
  meshes?: { name?: string; primitives?: { extensions?: Record<string, unknown>; [k: string]: unknown }[] }[];
  materials?: Record<string, unknown>[];
  nodes?: { name?: string; [k: string]: unknown }[];
  scenes?: unknown[];
  scene?: number;
  images?: unknown[];
  textures?: unknown[];
  samplers?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [k: string]: unknown;
}

export interface GltfContainer {
  json: GltfJson;
  /** GLB BIN chunk, if any. */
  bin: Uint8Array | null;
  isGlb: boolean;
}

export interface PreparedGltf {
  /** Self-contained GLB for GLTFLoader.parse. */
  glb: ArrayBuffer;
  /** The rewritten JSON (same object that was serialised into `glb`). */
  json: GltfJson;
  format: SourceFormat;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export const UNSUPPORTED_COMPRESSION = [
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
] as const;

function fail(message: string, format: SourceFormat): never {
  throw new MeshLoadError(message, format);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a .gltf (JSON) or .glb container. Validates the asset version. */
export function readGltfContainer(buffer: ArrayBuffer): GltfContainer {
  const bytes = new Uint8Array(buffer);
  const isGlb = bytes.length >= 4 && readU32LE(bytes, 0) === GLB_MAGIC;
  const format: SourceFormat = isGlb ? 'glb' : 'gltf';
  let text: string;
  let bin: Uint8Array | null = null;

  if (isGlb) {
    if (bytes.length < 12) fail('truncated GLB: shorter than the 12-byte header', format);
    const version = readU32LE(bytes, 4);
    if (version !== 2) fail(`unsupported GLB container version ${version} (only glTF 2.0 is supported)`, format);
    const declared = readU32LE(bytes, 8);
    if (declared > bytes.length) fail(`truncated GLB: header declares ${declared} bytes, file has ${bytes.length}`, format);
    let offset = 12;
    let json: Uint8Array | null = null;
    while (offset + 8 <= declared) {
      const length = readU32LE(bytes, offset);
      const type = readU32LE(bytes, offset + 4);
      const start = offset + 8;
      if (start + length > declared) fail('truncated GLB: a chunk extends past the end of the file', format);
      if (type === CHUNK_JSON && !json) json = bytes.subarray(start, start + length);
      else if (type === CHUNK_BIN && !bin) bin = bytes.subarray(start, start + length);
      offset = start + length;
    }
    if (!json) fail('GLB has no JSON chunk', format);
    // Spec pads with spaces; some writers pad with NUL, which JSON.parse rejects.
    text = decodeUtf8(json).replace(/[\s\0]+$/, '');
  } else {
    text = decodeUtf8(bytes);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    fail(`invalid glTF JSON: ${err instanceof Error ? err.message : String(err)}`, format);
  }
  if (!isObject(json)) fail('invalid glTF: the JSON root is not an object', format);
  const asset = json.asset;
  if (!isObject(asset) || asset.version === undefined) fail('invalid glTF: missing "asset.version"', format);
  const major = parseInt(String(asset.version), 10);
  if (!(major >= 2)) fail(`unsupported glTF version "${String(asset.version)}" (only 2.x is supported)`, format);
  return { json: json as GltfJson, bin, isGlb };
}

/** Decode a `data:` URI (base64 or percent-encoded) to bytes. */
export function decodeDataUri(uri: string, format: SourceFormat): Uint8Array {
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:') || comma < 0) fail('malformed data: URI', format);
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64$/i.test(meta)) {
    const b64 = payload.replace(/\s+/g, '');
    const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
    try {
      if (typeof fromBase64 === 'function') return fromBase64(b64);
      const binary = atob(b64);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    } catch {
      fail('invalid base64 payload in data: URI', format);
    }
  }
  // Percent-encoded octets.
  const out: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charCodeAt(i);
    const hex = ch === 0x25 /* % */ ? payload.slice(i + 1, i + 3) : '';
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else if (ch < 0x100) out.push(ch);
    else fail('non-octet character in a percent-encoded data: URI', format);
  }
  return Uint8Array.from(out);
}

/** Recursively delete `*Texture` object properties (textureInfo references). Returns the count. */
function stripTextureRefs(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, item) => n + stripTextureRefs(item), 0);
  if (!isObject(node)) return 0;
  let removed = 0;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (/Texture$/.test(key) && isObject(value)) {
      delete node[key];
      removed++;
    } else if (typeof value === 'object' && value !== null) {
      removed += stripTextureRefs(value);
    }
  }
  return removed;
}

function removeExtensionFrom(list: string[] | undefined, name: string): string[] | undefined {
  if (!list) return list;
  const next = list.filter((e) => e !== name);
  return next.length > 0 ? next : undefined;
}

function setOrDelete(json: GltfJson, key: 'extensionsUsed' | 'extensionsRequired', value: string[] | undefined): void {
  if (value) json[key] = value;
  else delete json[key];
}

function deleteExtension(holder: { extensions?: Record<string, unknown> } | undefined, name: string): boolean {
  if (!holder || !isObject(holder.extensions) || !(name in holder.extensions)) return false;
  delete holder.extensions[name];
  if (Object.keys(holder.extensions).length === 0) delete holder.extensions;
  return true;
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Rewrite the container into a self-contained GLB (see module doc). Mutates
 * `container.json`. Appends non-fatal notes to `warnings`.
 */
export function prepareGltf(container: GltfContainer, warnings: string[]): PreparedGltf {
  const { json } = container;
  const format: SourceFormat = container.isGlb ? 'glb' : 'gltf';
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed.filter((e) => typeof e === 'string') : [];
  const required = Array.isArray(json.extensionsRequired)
    ? json.extensionsRequired.filter((e) => typeof e === 'string')
    : [];

  // 2. Geometry compression.
  for (const ext of UNSUPPORTED_COMPRESSION) {
    if (required.includes(ext)) {
      fail(`the file requires ${ext}; compressed geometry is not supported in v1`, format);
    }
    if (!used.includes(ext)) continue;
    let dropped = 0;
    if (ext === 'KHR_draco_mesh_compression') {
      for (const mesh of json.meshes ?? []) for (const prim of mesh?.primitives ?? []) if (deleteExtension(prim, ext)) dropped++;
    } else {
      for (const view of json.bufferViews ?? []) if (deleteExtension(view, ext)) dropped++;
      for (const buf of json.buffers ?? []) deleteExtension(buf as { extensions?: Record<string, unknown> }, ext);
    }
    setOrDelete(json, 'extensionsUsed', removeExtensionFrom(json.extensionsUsed, ext));
    warnings.push(`optional ${ext} ignored (${dropped} use(s)); the uncompressed fallback data was loaded`);
  }

  // 3. Textures never block loading: strip them.
  const images = Array.isArray(json.images) ? json.images.length : 0;
  const textures = Array.isArray(json.textures) ? json.textures.length : 0;
  delete json.images;
  delete json.textures;
  delete json.samplers;
  const refs = stripTextureRefs(json.materials);
  if (images + textures + refs > 0) {
    warnings.push(
      `textures ignored (${images} image(s), ${textures} texture(s), ${refs} material texture reference(s)); ` +
        'polymerge compares geometry only',
    );
  }

  // 4. Buffers → one BIN blob.
  const buffers = Array.isArray(json.buffers) ? json.buffers : [];
  const blobs: Uint8Array[] = [];
  buffers.forEach((buf, i) => {
    const byteLength = typeof buf?.byteLength === 'number' ? buf.byteLength : NaN;
    if (!(byteLength >= 0)) fail(`buffer ${i} has no valid byteLength`, format);
    let data: Uint8Array;
    if (buf.uri === undefined) {
      if (i === 0 && container.bin) data = container.bin;
      else fail(`buffer ${i} has no uri and no GLB BIN chunk to refer to`, format);
    } else if (typeof buf.uri === 'string' && buf.uri.startsWith('data:')) {
      data = decodeDataUri(buf.uri, format);
    } else {
      fail(`buffer ${i} references "${String(buf.uri)}": external resources not supported in v1`, format);
    }
    if (data.length < byteLength) {
      fail(`buffer ${i} is truncated: ${data.length} bytes available, byteLength is ${byteLength}`, format);
    }
    blobs.push(data.subarray(0, byteLength));
  });
  const offsets: number[] = [];
  let total = 0;
  for (const blob of blobs) {
    offsets.push(total);
    total = align4(total + blob.length);
  }
  const bin = new Uint8Array(total);
  blobs.forEach((blob, i) => bin.set(blob, offsets[i]));
  (json.bufferViews ?? []).forEach((view, i) => {
    const b = view?.buffer;
    if (typeof b !== 'number' || !(b >= 0 && b < blobs.length)) fail(`bufferView ${i} references a missing buffer`, format);
    const start = view.byteOffset ?? 0;
    const length = view.byteLength ?? 0;
    if (start + length > blobs[b].length) fail(`bufferView ${i} extends past the end of buffer ${b}`, format);
    view.buffer = 0;
    view.byteOffset = offsets[b] + start;
  });
  if (blobs.length > 0) json.buffers = [{ byteLength: total }];
  else delete json.buffers;

  // 5. Serialise.
  return { glb: writeGlb(json, blobs.length > 0 ? bin : null), json, format };
}

/** Serialise JSON + optional BIN into a GLB ArrayBuffer. */
export function writeGlb(json: unknown, bin: Uint8Array | null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.length);
  const binLength = bin ? align4(bin.length) : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  if (bin) {
    const o = 20 + jsonLength;
    view.setUint32(o, binLength, true);
    view.setUint32(o + 4, CHUNK_BIN, true);
    out.set(bin, o + 8);
  }
  return out.buffer;
}
