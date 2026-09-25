/**
 * Format detection: file extension first (case-insensitive), then content sniffing.
 */
import { MeshLoadError, type SourceFormat } from '../types.js';
import { decodeUtf8, namePrefix, readU32LE, toBytes } from './bytes.js';

const EXTENSIONS: Record<string, SourceFormat> = { stl: 'stl', obj: 'obj', gltf: 'gltf', glb: 'glb' };

/** How much of the file is decoded as text for sniffing. */
const SNIFF_BYTES = 64 * 1024;

/** Format implied by a file name / path / URL extension, if it is one of ours. */
export function formatFromFileName(fileName?: string): SourceFormat | undefined {
  if (!fileName) return undefined;
  const base = (fileName.replace(/[?#].*$/, '').split(/[\\/]/).pop() ?? '').toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXTENSIONS[base.slice(dot + 1)];
}

/** True if a line in bytes[from..] starts (after blanks) with `f` + blank: an OBJ face. */
function hasObjFaceLine(bytes: Uint8Array, from: number): boolean {
  let i = from;
  const n = bytes.length;
  while (i < n) {
    const nl = bytes.indexOf(0x0a, i);
    if (nl < 0) return false;
    let j = nl + 1;
    while (j < n && (bytes[j] === 0x20 || bytes[j] === 0x09)) j++;
    if (j + 1 < n && bytes[j] === 0x66 && (bytes[j + 1] === 0x20 || bytes[j + 1] === 0x09)) return true;
    i = nl + 1;
  }
  return false;
}

/**
 * Guess the format from the bytes alone. Order: GLB magic → exact binary-STL size
 * (84 + 50 × triangleCount, which is checked before any text heuristic because many
 * binary STL headers start with "solid") → JSON `{` → ASCII `solid … facet` → OBJ
 * `v x y z` + `f …` lines. Returns undefined if nothing matches.
 */
export function sniffFormat(data: ArrayBuffer | Uint8Array): SourceFormat | undefined {
  const bytes = toBytes(data);
  const n = bytes.length;
  if (n === 0) return undefined;
  // "glTF" little-endian magic.
  if (n >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return 'glb';
  if (n >= 84 && 84 + 50 * readU32LE(bytes, 80) === n) return 'stl';

  const head = decodeUtf8(bytes.subarray(0, Math.min(n, SNIFF_BYTES)));
  const text = head.trimStart();
  if (text.startsWith('{')) return 'gltf';
  if (text.startsWith('solid') && /\b(facet|endsolid)\b/.test(text)) return 'stl';
  if (/^[ \t]*v[ \t]+[-+.\dEeIiNn]/m.test(head)) {
    if (/^[ \t]*f[ \t]+\S/m.test(head)) return 'obj';
    if (n > SNIFF_BYTES && hasObjFaceLine(bytes, SNIFF_BYTES - 4096)) return 'obj';
  }
  return undefined;
}

/** DetectFormatFn implementation (see types.ts). Throws MeshLoadError if unknown. */
export function detectFormat(data: ArrayBuffer | Uint8Array, fileName?: string): SourceFormat {
  const byName = formatFromFileName(fileName);
  if (byName) return byName;
  const bytes = toBytes(data);
  if (bytes.length === 0) throw new MeshLoadError(`${namePrefix(fileName)}empty input: cannot detect the mesh format`);
  const sniffed = sniffFormat(bytes);
  if (sniffed) return sniffed;
  throw new MeshLoadError(
    `${namePrefix(fileName)}unknown mesh format: expected STL (ASCII or binary), OBJ, glTF (.gltf JSON) or GLB`,
  );
}
