/**
 * STL → IMesh via three.js' STLLoader (ASCII and binary).
 *
 * What the stock loader exposes, and how it is mapped:
 *  - ASCII: one `geometry.groups` entry per `solid … endsolid` block (vertex ranges) and
 *    `geometry.userData.groupNames` → one IMeshGroup per solid, named after the solid
 *    (falling back to the file base name).
 *  - Binary: per-vertex linear colours (`geometry.hasColors`, `geometry.alpha`) when the
 *    80-byte header carries a Materialise-Magics `COLOR=` default → one IMaterial per
 *    distinct facet colour plus `faceMaterials`. Colours are NOT turned into groups
 *    (groups must be contiguous; painted facets are usually interleaved).
 *
 * Pre-flight checks guard the loader against inputs it handles badly: truncated
 * binaries (it would allocate for the declared triangle count and then throw a
 * RangeError), inputs shorter than the 84-byte binary header (its binary/ASCII test
 * reads offset 80 unconditionally) and binary files whose header starts with "solid"
 * but carry trailing bytes (it would mis-parse them as ASCII).
 */
import { Color, type BufferGeometry } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { defaultGroupName } from '../mesh.js';
import { MeshLoadError, type IMaterial, type IMesh } from '../types.js';
import { namePrefix, readU32LE, type FormatLoadContext } from './bytes.js';
import { buildWeldedMesh, type TrianglePart } from './weld.js';

const SOLID = [0x73, 0x6f, 0x6c, 0x69, 0x64]; // "solid"

/** three.js' ASCII test: "solid" at byte offset 0..4 (after an optional BOM / prefix). */
function startsWithSolid(bytes: Uint8Array): boolean {
  for (let off = 0; off < 5; off++) {
    let match = true;
    for (let i = 0; i < 5 && match; i++) match = bytes[off + i] === SOLID[i];
    if (match) return true;
  }
  return false;
}

/** Binary triangle records contain control bytes (e.g. the zero bytes of 0.0 / 1.0); ASCII STL never does. */
function looksBinary(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const b = bytes[i];
    if (b < 0x09 || (b > 0x0d && b < 0x20)) return true;
  }
  return false;
}

/** Printable text of the 80-byte binary header (up to the first NUL), trimmed. */
function headerText(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < 80 && i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) break;
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
  }
  return s.trim();
}

const STL_KEYWORD = /^(facet|outer|vertex|endloop|endfacet|endsolid)\b/;

/**
 * Clean a name captured by STLLoader's `/solid\s(.+)/`: for an unnamed `solid` that
 * regex can capture the following "facet normal …" line, and it keeps a trailing "\r".
 */
export function cleanSolidName(raw: string | undefined): string {
  if (!raw) return '';
  const name = raw.split(/[\r\n]/)[0].trim();
  return STL_KEYWORD.test(name) ? '' : name;
}

export function loadStl(buffer: ArrayBuffer, ctx: FormatLoadContext): IMesh {
  const bytes = new Uint8Array(buffer);
  const warnings: string[] = [];
  const prefix = namePrefix(ctx.fileName);
  const fallbackName = defaultGroupName(ctx.fileName);
  let input: ArrayBuffer = buffer;

  const solid = startsWithSolid(bytes);
  if (bytes.length >= 84) {
    const declared = readU32LE(bytes, 80);
    const expected = 84 + 50 * declared;
    if (expected !== bytes.length && (!solid || looksBinary(bytes, 84, Math.min(bytes.length, 84 + 50 * 64)))) {
      // Binary (the stock loader agrees unless the header starts with "solid").
      if (expected > bytes.length) {
        throw new MeshLoadError(
          `${prefix}truncated binary STL: the header declares ${declared} triangles (${expected} bytes) ` +
            `but the file has ${bytes.length} bytes`,
          'stl',
        );
      }
      warnings.push(`binary STL: ${bytes.length - expected} trailing byte(s) after ${declared} triangles ignored`);
      // A header starting with "solid" would send the loader down its ASCII path; trimming
      // the buffer to the declared size makes its size test pick the binary path.
      if (solid) input = buffer.slice(0, expected);
    }
  } else if (solid) {
    // Pad tiny ASCII files: STLLoader's binary test reads a uint32 at offset 80.
    const padded = new Uint8Array(84).fill(0x20);
    padded.set(bytes);
    input = padded.buffer;
  } else {
    throw new MeshLoadError(
      `${prefix}not an STL file: ${bytes.length} bytes is shorter than a binary STL header and there is no ASCII "solid" header`,
      'stl',
    );
  }

  const geometry: BufferGeometry = new STLLoader().parse(input);
  const position = geometry.getAttribute('position');
  const positions = (position?.array ?? new Float32Array(0)) as Float32Array;
  const groupNames = geometry.userData.groupNames as string[] | undefined;
  const ascii = Array.isArray(groupNames);

  const parts: TrianglePart[] = [];
  const materials: IMaterial[] = [];
  let extras: Record<string, unknown>;

  if (ascii) {
    if (positions.length % 9 !== 0) {
      throw new MeshLoadError(
        `${prefix}malformed ASCII STL: a facet does not have exactly 3 vertices ` +
          `(${positions.length / 3} vertices in total)`,
        'stl',
      );
    }
    const solidNames = groupNames.map(cleanSolidName);
    geometry.groups.forEach((g, i) => {
      parts.push({
        name: solidNames[i] || fallbackName,
        positions: positions.subarray(g.start * 3, (g.start + g.count) * 3),
      });
    });
    extras = { encoding: 'ascii', solidNames };
  } else {
    const part: TrianglePart = { name: fallbackName, positions };
    const g = geometry as BufferGeometry & { hasColors?: boolean; alpha?: number };
    const color = geometry.getAttribute('color');
    if (g.hasColors && color) {
      const col = color.array as Float32Array;
      const alpha = typeof g.alpha === 'number' ? g.alpha : 1;
      const triangleCount = Math.floor(positions.length / 9);
      const faceMaterials = new Int32Array(triangleCount);
      const byKey = new Map<string, number>();
      const tmp = new Color();
      let pr = NaN;
      let pg = NaN;
      let pb = NaN;
      for (let t = 0; t < triangleCount; t++) {
        const r = col[t * 9];
        const gg = col[t * 9 + 1];
        const b = col[t * 9 + 2];
        if (r === pr && gg === pg && b === pb) {
          faceMaterials[t] = faceMaterials[t - 1];
          continue;
        }
        const key = `${r},${gg},${b}`;
        let mi = byKey.get(key);
        if (mi === undefined) {
          mi = materials.length;
          byKey.set(key, mi);
          // Loader colours are linear (converted from the file's sRGB); name by sRGB hex.
          materials.push({ name: `color_${tmp.setRGB(r, gg, b).getHexString()}`, color: [r, gg, b, alpha] });
        }
        faceMaterials[t] = mi;
        pr = r;
        pg = gg;
        pb = b;
      }
      part.faceMaterials = faceMaterials;
    }
    parts.push(part);
    extras = { encoding: 'binary', header: headerText(bytes), hasColors: !!g.hasColors };
  }

  if (positions.length < 9) {
    throw new MeshLoadError(`${prefix}STL contains no triangles (${ascii ? 'ASCII' : 'binary'})`, 'stl');
  }

  return buildWeldedMesh({
    format: 'stl',
    parts,
    materials,
    fileName: ctx.fileName,
    weldEpsilon: ctx.weldEpsilon,
    warnings,
    extras,
  });
}
