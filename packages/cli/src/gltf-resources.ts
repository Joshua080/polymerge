/**
 * A `.gltf` usually comes with files beside it: its geometry in a `.bin`, its textures as images.
 * The engine reads one self-contained file, so the CLI inlines those files as `data:` URIs first,
 * from the folder the `.gltf` is in. Only files inside that folder (or below it) are read: a URI
 * that leaves it (`../`, an absolute path, another scheme such as http:) is left as it is, and the
 * loader then says which file it could not use.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Reads a file by its path relative to the `.gltf`'s folder ("/"-separated); null when absent. */
export type SiblingReader = (rel: string) => Promise<Uint8Array | null>;

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2' };

/** The relative path a URI names inside the folder, or null when it is not a plain relative path into it. */
export function siblingPath(uri: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('/') || uri.startsWith('\\')) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(uri.split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm === '.' || norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm) || /^[a-z]:/i.test(norm)) return null;
  return norm;
}

/** Disk: files beside `gltfPath`. */
export function diskSiblings(gltfPath: string): SiblingReader {
  const dir = path.dirname(path.resolve(gltfPath));
  return (rel) => readFile(path.join(dir, ...rel.split('/'))).then((b) => new Uint8Array(b), () => null);
}

/**
 * `bytes` (a .gltf) with its buffers' and images' sibling files inlined. Returns the input
 * unchanged when it is not JSON glTF or needs nothing.
 */
export async function inlineGltfResources(bytes: Uint8Array, read: SiblingReader): Promise<Uint8Array> {
  let json: { buffers?: { uri?: unknown }[]; images?: { uri?: unknown; mimeType?: unknown }[] };
  try {
    json = JSON.parse(new TextDecoder().decode(bytes)) as typeof json;
  } catch {
    return bytes; // GLB or not glTF: the loader decides
  }
  if (!json || typeof json !== 'object') return bytes;
  let changed = false;
  const inline = async (holder: { uri?: unknown; mimeType?: unknown }, type: (rel: string) => string) => {
    if (typeof holder?.uri !== 'string' || holder.uri.startsWith('data:')) return;
    const rel = siblingPath(holder.uri);
    if (!rel) return;
    const data = await read(rel);
    if (!data) return;
    holder.uri = `data:${type(rel)};base64,${Buffer.from(data).toString('base64')}`;
    changed = true;
  };
  for (const buffer of Array.isArray(json.buffers) ? json.buffers : []) await inline(buffer, () => 'application/octet-stream');
  for (const image of Array.isArray(json.images) ? json.images : []) {
    await inline(image, (rel) => (typeof image.mimeType === 'string' ? image.mimeType : (IMAGE_TYPES[path.posix.extname(rel).toLowerCase()] ?? 'application/octet-stream')));
  }
  return changed ? new TextEncoder().encode(JSON.stringify(json)) : bytes;
}
