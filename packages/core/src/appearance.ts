/**
 * Appearance helpers shared by the glTF loader, the merge and writers (docs/appearance-merge-design.md):
 * glTF material defaults, the IMaterial summary of a definition, content-based comparison keys
 * (images compared by content hash, never by index) and the image content hash itself.
 * Isomorphic, dependency-free.
 */
import type { IMaterial, IMaterialDefinition, IMeshAppearance, ITextureImage, ITextureRef } from './types.js';

/** The five core texture slots of a glTF material. */
export const TEXTURE_SLOTS = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
] as const;
export type TextureSlot = (typeof TEXTURE_SLOTS)[number];

/** Scalar / vector properties of a definition, in the order they are compared and reported. */
export const SCALAR_PROPERTIES = [
  'name',
  'baseColorFactor',
  'metallicFactor',
  'roughnessFactor',
  'emissiveFactor',
  'alphaMode',
  'alphaCutoff',
  'doubleSided',
] as const;

/** A glTF material with every property at its default (what an absent property means). */
export function defaultMaterialDefinition(): IMaterialDefinition {
  return {
    baseColorFactor: [1, 1, 1, 1],
    metallicFactor: 1,
    roughnessFactor: 1,
    emissiveFactor: [0, 0, 0],
    alphaMode: 'OPAQUE',
    alphaCutoff: 0.5,
    doubleSided: false,
  };
}

export function isUnlit(def: IMaterialDefinition): boolean {
  return !!def.extensions && 'KHR_materials_unlit' in def.extensions;
}

/**
 * The IMaterial summary of a definition, exactly as the glTF loader reports it (three.js' mapping):
 * baseColorFactor as the colour, metalness / roughness unless the material is unlit.
 */
export function materialSummary(def: IMaterialDefinition, fallbackName: string): IMaterial {
  const out: IMaterial = { name: def.name || fallbackName, color: [...def.baseColorFactor] };
  if (!isUnlit(def)) {
    out.metalness = def.metallicFactor;
    out.roughness = def.roughnessFactor;
  }
  return out;
}

/** Every property name of a definition that is set, extensions as `extensions.<name>`. */
export function definitionProperties(def: IMaterialDefinition): string[] {
  const out: string[] = [...SCALAR_PROPERTIES];
  for (const slot of TEXTURE_SLOTS) if (def[slot]) out.push(slot);
  for (const name of Object.keys(def.extensions ?? {})) out.push(`extensions.${name}`);
  if (def.extras !== undefined) out.push('extras');
  return out;
}

/** Value of a property named as in {@link definitionProperties} (undefined when unset). */
export function definitionValue(def: IMaterialDefinition, property: string): unknown {
  if (property.startsWith('extensions.')) return def.extensions?.[property.slice(11)];
  return (def as unknown as Record<string, unknown>)[property];
}

/** Set (or, with `undefined`, remove) a property named as in {@link definitionProperties}. */
export function setDefinitionValue(def: IMaterialDefinition, property: string, value: unknown): void {
  if (property.startsWith('extensions.')) {
    const name = property.slice(11);
    if (value === undefined) {
      if (def.extensions) {
        delete def.extensions[name];
        if (Object.keys(def.extensions).length === 0) delete def.extensions;
      }
    } else (def.extensions ??= {})[name] = value;
    return;
  }
  const d = def as unknown as Record<string, unknown>;
  if (value === undefined) delete d[property];
  else d[property] = value;
}

function isTextureRef(value: unknown): value is ITextureRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ITextureRef).image === 'number' &&
    typeof (value as ITextureRef).texCoord === 'number'
  );
}

/**
 * Canonical comparison key of a property value: object keys sorted, numbers compared at float32
 * precision (so a float32-widened re-export such as 0.800000011920929 equals 0.8), and every texture
 * reference's image replaced by that image's content hash.
 */
export function appearanceValueKey(value: unknown, images: readonly ITextureImage[]): string {
  const canon = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isFinite(v) ? Math.fround(v) : String(v);
    if (Array.isArray(v)) return v.map(canon);
    if (typeof v !== 'object' || v === null) return v;
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      out[k] = k === 'image' && isTextureRef(v) ? `image:${images[src.image as number]?.hash ?? '?'}` : canon(src[k]);
    }
    return out;
  };
  return value === undefined ? 'undefined' : JSON.stringify(canon(value));
}

/** Deep copy of a property value with every texture reference's image index mapped through `map`. */
export function remapTextureRefs<T>(value: T, map: (image: number) => number): T {
  if (Array.isArray(value)) return value.map((v) => remapTextureRefs(v, map)) as T;
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = remapTextureRefs(v, map);
  if (isTextureRef(value)) out.image = map(value.image);
  return out as T;
}

/** Every texture reference inside a definition (core slots and extensions). */
export function textureRefsOf(def: IMaterialDefinition): ITextureRef[] {
  const out: ITextureRef[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === 'object' && v !== null) {
      if (isTextureRef(v)) out.push(v);
      else Object.values(v).forEach(visit);
    }
  };
  for (const slot of TEXTURE_SLOTS) if (def[slot]) out.push(def[slot]);
  visit(def.extensions);
  return out;
}

/** The UV set a texture reference samples (KHR_texture_transform may override it). */
export function textureRefUvSet(ref: ITextureRef): number {
  return ref.transform?.texCoord ?? ref.texCoord;
}

/**
 * Keep only the images some definition references (in first-reference order) and renumber the
 * references. Returns the same object when nothing changes.
 */
export function pruneImages(appearance: IMeshAppearance): IMeshAppearance {
  const remap = new Map<number, number>();
  for (const def of appearance.materials) {
    for (const ref of textureRefsOf(def)) if (!remap.has(ref.image)) remap.set(ref.image, remap.size);
  }
  if (remap.size === appearance.images.length && [...remap].every(([from, to]) => from === to)) return appearance;
  const images: ITextureImage[] = new Array(remap.size);
  for (const [from, to] of remap) images[to] = appearance.images[from];
  return {
    ...appearance,
    materials: appearance.materials.map((d) => remapTextureRefs(d, (i) => remap.get(i)!)),
    images,
  };
}

/**
 * Content hash of image bytes: `<byteLength>:<16 hex digits>` (two 32-bit multiply–rotate lanes
 * with a murmur3 finaliser). Identity only — not cryptographic.
 */
export function hashBytes(bytes: Uint8Array): string {
  const n = bytes.length;
  let h1 = 0x9e3779b9 ^ n;
  let h2 = 0x85ebca6b ^ Math.imul(n, 0x27d4eb2f);
  const words = n >>> 2;
  for (let w = 0; w < words; w++) {
    const i = w << 2;
    const k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    h1 = Math.imul(h1 ^ k, 0xcc9e2d51);
    h1 = (h1 << 15) | (h1 >>> 17);
    h2 = Math.imul(h2 ^ k ^ w, 0x1b873593);
    h2 = ((h2 << 13) | (h2 >>> 19)) + h1;
  }
  for (let i = words << 2; i < n; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0xcc9e2d51);
    h2 = Math.imul(h2 ^ bytes[i] ^ i, 0x1b873593) + h1;
  }
  const fmix = (h: number): number => {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  };
  const a = fmix(h1 ^ Math.imul(h2, 0x165667b1));
  const b = fmix(h2 ^ Math.imul(a, 0x27d4eb2f));
  return `${n}:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}
