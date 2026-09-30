/**
 * glTF appearance → IMesh.appearance, read WITHOUT decoding a single image
 * (docs/appearance-merge-design.md §2):
 *
 *  - Material definitions straight from the JSON (not from three.js' materials, which lose texture
 *    references): core properties with glTF defaults filled in; the five core texture slots
 *    resolved through `textures` / `samplers` / KHR_texture_transform into ITextureRefs; every other
 *    material extension kept whole, with the texture references inside it resolved the same way.
 *  - Images: embedded bytes (bufferView, or data: URI) carried as-is with their mimeType and a
 *    content hash; an external URI kept as a reference, never fetched.
 *  - Texture coordinates per source vertex from the loaded geometry (TEXCOORD_n arrives as three's
 *    `uv`, `uv1`, `uv2`, `uv3`); the welder turns them into per-corner data.
 *
 * The container step (gltf-container.ts) strips images / textures / samplers and every texture
 * reference before GLTFLoader sees the JSON, so `captureGltfAppearance` copies them first and
 * `resolveGltfAppearance` reads the image bytes from the prepared GLB's single BIN chunk afterwards.
 */
import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute } from 'three';
import { defaultMaterialDefinition, hashBytes } from '../appearance.js';
import type { IMaterialDefinition, ITextureImage, ITextureRef, ITextureSampler, ITextureTransform, MaterialAlphaMode } from '../types.js';
import { readU32LE } from './bytes.js';
import { decodeDataUri, type GltfJson, type PreparedGltf } from './gltf-container.js';

/** What the container step would strip, copied before it runs. */
export interface GltfAppearanceCapture {
  materials: unknown[];
  textures: unknown[];
  images: unknown[];
  samplers: unknown[];
}

export interface GltfAppearance {
  /** Definition per glTF material index. */
  materials: IMaterialDefinition[];
  /** Images referenced by the definitions (indices used by their ITextureRefs). */
  images: ITextureImage[];
}

/** three.js attribute names of TEXCOORD_0..3. */
export const UV_ATTRIBUTES = ['uv', 'uv1', 'uv2', 'uv3'] as const;

const ALPHA_MODES: readonly MaterialAlphaMode[] = ['OPAQUE', 'MASK', 'BLEND'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function numbers(v: unknown, n: number): number[] | undefined {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [...(v as number[])] : undefined;
}

/** Copy what prepareGltf strips (it mutates materials in place, so those are deep-copied). */
export function captureGltfAppearance(json: GltfJson): GltfAppearanceCapture {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return {
    materials: structuredClone(list(json.materials)),
    textures: list(json.textures),
    images: list(json.images),
    samplers: list(json.samplers),
  };
}

/** The BIN chunk of a GLB (the prepared container has exactly one, or none). */
function glbBin(glb: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(glb);
  const jsonLength = readU32LE(bytes, 12);
  const o = 20 + jsonLength;
  if (o + 8 > bytes.length) return new Uint8Array(0);
  return bytes.subarray(o + 8, o + 8 + readU32LE(bytes, o));
}

/**
 * Resolve the captured definitions and the images they reference. Problems (a texture or image
 * index that does not exist, an undecodable data: URI) drop that one reference, with a warning.
 */
export function resolveGltfAppearance(capture: GltfAppearanceCapture, prepared: PreparedGltf, warnings: string[]): GltfAppearance {
  const images: ITextureImage[] = [];
  const imageOf = new Map<number, number>();
  const problems: string[] = [];
  let bin: Uint8Array | null = null;

  const image = (index: number): number => {
    const known = imageOf.get(index);
    if (known !== undefined) return known;
    const src = capture.images[index];
    let out: ITextureImage | null = null;
    if (isObject(src)) {
      const name = typeof src.name === 'string' ? src.name : undefined;
      let mimeType = typeof src.mimeType === 'string' ? src.mimeType : undefined;
      let data: Uint8Array | null = null;
      if (typeof src.bufferView === 'number') {
        const view = prepared.json.bufferViews?.[src.bufferView];
        bin ??= glbBin(prepared.glb);
        const start = view?.byteOffset ?? 0;
        const length = view?.byteLength ?? 0;
        if (view && start + length <= bin.length) data = bin.slice(start, start + length);
        else problems.push(`image ${index}: bufferView ${src.bufferView} is missing`);
      } else if (typeof src.uri === 'string' && src.uri.startsWith('data:')) {
        try {
          data = decodeDataUri(src.uri, prepared.format);
          mimeType ??= /^data:([^;,]+)/.exec(src.uri)?.[1];
        } catch {
          problems.push(`image ${index}: undecodable data: URI`);
        }
      } else if (typeof src.uri === 'string') {
        out = { hash: `uri:${src.uri}`, uri: src.uri };
        if (name) out.name = name;
        if (mimeType) out.mimeType = mimeType;
      } else problems.push(`image ${index} has neither a bufferView nor a uri`);
      if (data) {
        out = { hash: hashBytes(data), data };
        if (name) out.name = name;
        if (mimeType) out.mimeType = mimeType;
      }
    } else problems.push(`image ${index} does not exist`);
    const k = out ? images.push(out) - 1 : -1;
    imageOf.set(index, k);
    return k;
  };

  const sampler = (index: unknown): ITextureSampler | undefined => {
    const s = typeof index === 'number' ? capture.samplers[index] : undefined;
    if (!isObject(s)) return undefined;
    const out: ITextureSampler = {};
    for (const key of ['magFilter', 'minFilter', 'wrapS', 'wrapT'] as const) {
      const v = num(s[key]);
      if (v !== undefined) out[key] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const transform = (ext: unknown): ITextureTransform | undefined => {
    if (!isObject(ext)) return undefined;
    const out: ITextureTransform = {};
    const offset = numbers(ext.offset, 2);
    if (offset && (offset[0] !== 0 || offset[1] !== 0)) out.offset = offset as [number, number];
    const rotation = num(ext.rotation);
    if (rotation) out.rotation = rotation;
    const scale = numbers(ext.scale, 2);
    if (scale && (scale[0] !== 1 || scale[1] !== 1)) out.scale = scale as [number, number];
    const texCoord = num(ext.texCoord);
    if (texCoord !== undefined) out.texCoord = texCoord;
    return Object.keys(out).length > 0 ? out : undefined;
  };

  /** textureInfo → ITextureRef (null when it cannot be resolved). */
  const textureRef = (info: Record<string, unknown>, where: string): ITextureRef | null => {
    const tex = typeof info.index === 'number' ? capture.textures[info.index] : undefined;
    if (!isObject(tex)) {
      problems.push(`${where}: texture ${String(info.index)} does not exist`);
      return null;
    }
    let source = num(tex.source);
    let sourceExtension: string | undefined;
    if (source === undefined && isObject(tex.extensions)) {
      for (const [name, ext] of Object.entries(tex.extensions)) {
        if (isObject(ext) && typeof ext.source === 'number') {
          source = ext.source;
          sourceExtension = name;
          break;
        }
      }
    }
    const img = source === undefined ? -1 : image(source);
    if (img < 0) {
      if (source === undefined) problems.push(`${where}: texture ${String(info.index)} has no image source`);
      return null;
    }
    const ref: ITextureRef = { image: img, texCoord: num(info.texCoord) ?? 0 };
    const s = sampler(tex.sampler);
    if (s) ref.sampler = s;
    const t = isObject(info.extensions) ? transform(info.extensions.KHR_texture_transform) : undefined;
    if (t) ref.transform = t;
    const scale = num(info.scale);
    if (scale !== undefined && scale !== 1) ref.scale = scale;
    const strength = num(info.strength);
    if (strength !== undefined && strength !== 1) ref.strength = strength;
    if (sourceExtension) ref.sourceExtension = sourceExtension;
    return ref;
  };

  /** Deep copy of an extension value with every `…Texture` textureInfo resolved. */
  const resolveNested = (value: unknown, where: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => resolveNested(v, where));
    if (!isObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/Texture$/.test(k) && isObject(v) && typeof v.index === 'number') {
        const ref = textureRef(v, `${where}.${k}`);
        if (ref) out[k] = ref;
      } else out[k] = resolveNested(v, where);
    }
    return out;
  };

  const materials = capture.materials.map((m, i): IMaterialDefinition => {
    const def = defaultMaterialDefinition();
    if (!isObject(m)) return def;
    const where = `material ${i}`;
    if (typeof m.name === 'string' && m.name) def.name = m.name;
    const pbr = isObject(m.pbrMetallicRoughness) ? m.pbrMetallicRoughness : {};
    def.baseColorFactor = (numbers(pbr.baseColorFactor, 4) as IMaterialDefinition['baseColorFactor']) ?? def.baseColorFactor;
    def.metallicFactor = num(pbr.metallicFactor) ?? def.metallicFactor;
    def.roughnessFactor = num(pbr.roughnessFactor) ?? def.roughnessFactor;
    def.emissiveFactor = (numbers(m.emissiveFactor, 3) as IMaterialDefinition['emissiveFactor']) ?? def.emissiveFactor;
    if ((ALPHA_MODES as readonly unknown[]).includes(m.alphaMode)) def.alphaMode = m.alphaMode as MaterialAlphaMode;
    // The cutoff means something in MASK mode only (validators warn otherwise): 0.5 elsewhere, so a
    // write / read cycle cannot invent a change.
    if (def.alphaMode === 'MASK') def.alphaCutoff = num(m.alphaCutoff) ?? def.alphaCutoff;
    def.doubleSided = m.doubleSided === true;
    const slots: Array<[keyof IMaterialDefinition & `${string}Texture`, unknown]> = [
      ['baseColorTexture', pbr.baseColorTexture],
      ['metallicRoughnessTexture', pbr.metallicRoughnessTexture],
      ['normalTexture', m.normalTexture],
      ['occlusionTexture', m.occlusionTexture],
      ['emissiveTexture', m.emissiveTexture],
    ];
    for (const [slot, info] of slots) {
      if (!isObject(info)) continue;
      const ref = textureRef(info, `${where}.${slot}`);
      if (ref) def[slot] = ref;
    }
    if (isObject(m.extensions) && Object.keys(m.extensions).length > 0) {
      def.extensions = resolveNested(m.extensions, `${where}.extensions`) as Record<string, unknown>;
    }
    if (m.extras !== undefined) def.extras = structuredClone(m.extras);
    return def;
  });

  if (problems.length > 0) {
    const shown = problems.slice(0, 3).join('; ');
    warnings.push(`${problems.length} texture reference problem(s) ignored: ${shown}${problems.length > 3 ? '; …' : ''}`);
  }
  return { materials, images };
}

/**
 * Texture coordinates of a loaded geometry, one array per UV set (2 floats per source vertex,
 * repeated for every instance), or null when it has none. Normalised integer UVs
 * (KHR_mesh_quantization) are de-normalised as three.js does.
 */
export function readUvSets(geometry: BufferGeometry, count: number, instances: number): (Float32Array | null)[] | null {
  let last = -1;
  const sets = UV_ATTRIBUTES.map((name, k): Float32Array | null => {
    const attr = geometry.getAttribute(name) as BufferAttribute | InterleavedBufferAttribute | undefined;
    if (!attr || attr.count < count || attr.itemSize < 2) return null;
    last = k;
    const out = new Float32Array(count * 2 * instances);
    for (let i = 0; i < count; i++) {
      const u = attr.getX(i);
      const v = attr.getY(i);
      for (let k2 = 0; k2 < instances; k2++) {
        const o = (k2 * count + i) * 2;
        out[o] = u;
        out[o + 1] = v;
      }
    }
    return out;
  });
  return last < 0 ? null : sets.slice(0, last + 1);
}
