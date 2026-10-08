/**
 * PLY (Stanford polygon format, ASCII and binary little / big endian) → IMesh.
 *
 * A hand-written reader rather than three.js' PLYLoader, which drops polygons with more than
 * four corners, splits quads along the other diagonal than every other polymerge format, and
 * builds JavaScript arrays (slow for the million-triangle scans PLY is used for). Mapping:
 *  - `vertex` x / y / z → positions (any numeric type; float32 after welding, as everywhere).
 *  - `face` `vertex_indices` (or `vertex_index`) lists → triangles. Polygons are fan-triangulated
 *    (v0 v1 v2, v0 v2 v3, …), exactly as OBJLoader does, so the same polygons saved as OBJ and
 *    PLY load as the same IMesh.
 *  - `tristrips` (a strip list with -1 restarts), when there is no `face` element.
 *  - Per-face red / green / blue (uchar or float) → one material per distinct colour, as binary STL
 *    colours are. Per-vertex colours, normals and texture coordinates are ignored: polymerge
 *    compares shape (`extras.ply.vertexColors` records that they were there).
 *  - One group, named after the file. Other elements (edges, materials, …) are skipped.
 */
import { defaultGroupName } from '../mesh.js';
import { MeshLoadError, type IMaterial, type IMesh } from '../types.js';
import { namePrefix, type FormatLoadContext } from './bytes.js';
import { buildWeldedMesh } from './weld.js';

type Scalar = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

const TYPES: Record<string, Scalar> = {
  char: 'int8',
  int8: 'int8',
  uchar: 'uint8',
  uint8: 'uint8',
  short: 'int16',
  int16: 'int16',
  ushort: 'uint16',
  uint16: 'uint16',
  int: 'int32',
  int32: 'int32',
  uint: 'uint32',
  uint32: 'uint32',
  float: 'float32',
  float32: 'float32',
  double: 'float64',
  float64: 'float64',
};

const SIZES: Record<Scalar, number> = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8 };

interface Property {
  name: string;
  type: Scalar;
  /** Lists only: the type of the item count. */
  countType?: Scalar;
}

interface Element {
  name: string;
  count: number;
  properties: Property[];
}

export interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  elements: Element[];
  /** Byte offset of the body. */
  bodyStart: number;
  comments: string[];
}

function fail(prefix: string, message: string): never {
  throw new MeshLoadError(`${prefix}${message}`, 'ply');
}

export function parsePlyHeader(bytes: Uint8Array, prefix = ''): PlyHeader {
  // The header is ASCII and ends with an "end_header" line.
  const limit = Math.min(bytes.length, 1 << 20);
  let text = '';
  for (let i = 0; i < limit; i++) text += String.fromCharCode(bytes[i]);
  if (!/^ply[ \t]*\r?\n/.test(text)) fail(prefix, 'not a PLY file: it does not start with a "ply" line');
  const match = /(^|\n)end_header[ \t]*(\r?\n|$)/.exec(text);
  if (!match) fail(prefix, 'PLY header has no "end_header" line');
  const bodyStart = match.index + match[0].length;
  const lines = text.slice(0, match.index).split(/\r?\n/);
  let format: PlyHeader['format'] | undefined;
  const elements: Element[] = [];
  const comments: string[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const words = line.split(/\s+/);
    switch (words[0]) {
      case 'format':
        if (words[1] !== 'ascii' && words[1] !== 'binary_little_endian' && words[1] !== 'binary_big_endian') {
          fail(prefix, `unknown PLY format "${words[1]}" (expected ascii, binary_little_endian or binary_big_endian)`);
        }
        format = words[1];
        break;
      case 'comment':
      case 'obj_info':
        comments.push(line.slice(words[0].length).trim());
        break;
      case 'element': {
        const count = Number(words[2]);
        if (!words[1] || !Number.isInteger(count) || count < 0) fail(prefix, `malformed PLY header line "${line}"`);
        elements.push({ name: words[1], count, properties: [] });
        break;
      }
      case 'property': {
        const element = elements[elements.length - 1];
        if (!element) fail(prefix, `PLY property before any element: "${line}"`);
        if (words[1] === 'list') {
          const countType = TYPES[words[2]];
          const type = TYPES[words[3]];
          if (!countType || !type || !words[4]) fail(prefix, `malformed PLY list property "${line}"`);
          element.properties.push({ name: words[4], type, countType });
        } else {
          const type = TYPES[words[1]];
          if (!type || !words[2]) fail(prefix, `unknown PLY property type in "${line}"`);
          element.properties.push({ name: words[2], type });
        }
        break;
      }
      default:
        // Unknown header keywords are ignored, as most readers do.
        break;
    }
  }
  if (!format) fail(prefix, 'PLY header has no "format" line');
  return { format, elements, bodyStart, comments };
}

/** Reads the body value by value, in file order, whatever the encoding. */
interface ValueReader {
  next(type: Scalar): number;
  /** True once a read went past the end of the input. */
  readonly exhausted: boolean;
}

function binaryReader(bytes: Uint8Array, start: number, little: boolean): ValueReader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length;
  let offset = start;
  let exhausted = false;
  return {
    next(type: Scalar): number {
      const at = offset;
      offset += SIZES[type];
      if (offset > end) {
        exhausted = true;
        return NaN;
      }
      switch (type) {
        case 'uint8':
          return bytes[at];
        case 'int8':
          return view.getInt8(at);
        case 'int16':
          return view.getInt16(at, little);
        case 'uint16':
          return view.getUint16(at, little);
        case 'int32':
          return view.getInt32(at, little);
        case 'uint32':
          return view.getUint32(at, little);
        case 'float32':
          return view.getFloat32(at, little);
        case 'float64':
          return view.getFloat64(at, little);
      }
    },
    get exhausted() {
      return exhausted;
    },
  };
}

function asciiReader(bytes: Uint8Array, start: number): ValueReader {
  const text = new TextDecoder('latin1').decode(bytes.subarray(start));
  const n = text.length;
  let i = 0;
  let exhausted = false;
  return {
    next(): number {
      // Values are read as one stream: line breaks are whitespace like any other.
      while (i < n && text.charCodeAt(i) <= 32) i++;
      if (i >= n) {
        exhausted = true;
        return NaN;
      }
      const from = i;
      while (i < n && text.charCodeAt(i) > 32) i++;
      return Number(text.slice(from, i));
    },
    get exhausted() {
      return exhausted;
    },
  };
}

/** A Uint32Array that grows as values are pushed. */
class U32Builder {
  data: Uint32Array;
  length = 0;
  constructor(capacity: number) {
    this.data = new Uint32Array(Math.max(16, capacity));
  }
  private reserve(n: number): void {
    if (this.length + n <= this.data.length) return;
    const next = new Uint32Array(this.data.length * 2 + n);
    next.set(this.data);
    this.data = next;
  }
  push(a: number): void {
    this.reserve(1);
    this.data[this.length++] = a;
  }
  push3(a: number, b: number, c: number): void {
    this.reserve(3);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  view(): Uint32Array {
    return this.data.subarray(0, this.length);
  }
}

/** A vertex index as read → an index the weld builder accepts; anything invalid becomes out of range (dropped and counted there). */
function vertexIndex(x: number): number {
  return Number.isInteger(x) && x >= 0 && x < 0xffffffff ? x : 0xffffffff;
}

const isFloat = (type: Scalar): boolean => type === 'float32' || type === 'float64';

/** A colour component as written (uchar 0..255, or a float in [0, 1]) → a byte. */
function colorByte(value: number, type: Scalar): number {
  const b = isFloat(type) ? value * 255 : value;
  return Math.min(255, Math.max(0, Math.round(Number.isFinite(b) ? b : 0)));
}

/** sRGB byte → linear [0, 1]. */
function linearOf(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function loadPly(buffer: ArrayBuffer, ctx: FormatLoadContext): IMesh {
  const bytes = new Uint8Array(buffer);
  const prefix = namePrefix(ctx.fileName);
  const header = parsePlyHeader(bytes, prefix);
  const reader =
    header.format === 'ascii' ? asciiReader(bytes, header.bodyStart) : binaryReader(bytes, header.bodyStart, header.format === 'binary_little_endian');

  const vertexElement = header.elements.find((e) => e.name === 'vertex');
  if (!vertexElement) fail(prefix, 'PLY file has no "vertex" element');
  const axes = ['x', 'y', 'z'].map((a) => vertexElement.properties.findIndex((p) => p.name === a && !p.countType));
  if (axes.some((k) => k < 0)) fail(prefix, 'PLY vertices have no x, y and z properties');
  const faceElement = header.elements.find((e) => e.name === 'face') ?? header.elements.find((e) => e.name === 'tristrips');

  let positions = new Float64Array(0);
  const triangles = new U32Builder((faceElement?.count ?? 0) * 3);
  /** Per triangle: the sRGB colour of its polygon as 0xRRGGBB, when faces carry colours. */
  let triangleColors: U32Builder | null = null;
  const vertexColors = vertexElement.properties.some((p) => p.name === 'red' || p.name === 'diffuse_red');

  for (const element of header.elements) {
    const props = element.properties;
    if (element === vertexElement) {
      positions = new Float64Array(element.count * 3);
      const slot = props.map((_, k) => axes.indexOf(k));
      for (let v = 0; v < element.count; v++) {
        for (let k = 0; k < props.length; k++) {
          const p = props[k];
          if (p.countType) {
            const count = reader.next(p.countType);
            for (let j = 0; j < count; j++) reader.next(p.type);
            continue;
          }
          const value = reader.next(p.type);
          if (slot[k] >= 0) positions[v * 3 + slot[k]] = value;
        }
      }
      continue;
    }
    if (element === faceElement) {
      const strip = element.name === 'tristrips';
      const listIndex = props.findIndex((p) => !!p.countType && (p.name === 'vertex_indices' || p.name === 'vertex_index'));
      if (listIndex < 0) fail(prefix, `PLY "${element.name}" element has no vertex_indices list`);
      const colorIndex = ['red', 'green', 'blue'].map((c) => props.findIndex((p) => p.name === c && !p.countType));
      const colored = !strip && colorIndex.every((k) => k >= 0);
      if (colored) triangleColors = new U32Builder(element.count);
      const corners: number[] = [];
      const rgb = [0, 0, 0];
      for (let f = 0; f < element.count; f++) {
        corners.length = 0;
        for (let k = 0; k < props.length; k++) {
          const p = props[k];
          if (p.countType) {
            const count = reader.next(p.countType);
            if (k === listIndex) for (let j = 0; j < count; j++) corners.push(reader.next(p.type));
            else for (let j = 0; j < count; j++) reader.next(p.type);
            continue;
          }
          const value = reader.next(p.type);
          if (colored) {
            const c = colorIndex.indexOf(k);
            if (c >= 0) rgb[c] = colorByte(value, p.type);
          }
        }
        if (strip) {
          // A strip of n corners gives n − 2 triangles, every other one flipped to keep the
          // winding; -1 restarts the strip.
          let runStart = 0;
          for (let j = 0; j <= corners.length; j++) {
            if (j < corners.length && corners[j] >= 0) continue;
            for (let q = runStart + 2; q < j; q++) {
              const even = (q - runStart) % 2 === 0;
              const a = vertexIndex(corners[even ? q - 2 : q - 1]);
              const b = vertexIndex(corners[even ? q - 1 : q - 2]);
              triangles.push3(a, b, vertexIndex(corners[q]));
            }
            runStart = j + 1;
          }
          continue;
        }
        const first = vertexIndex(corners[0]);
        for (let j = 2; j < corners.length; j++) {
          triangles.push3(first, vertexIndex(corners[j - 1]), vertexIndex(corners[j]));
          triangleColors?.push((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
        }
      }
      continue;
    }
    // Any other element: read past it.
    for (let e = 0; e < element.count; e++) {
      for (const p of props) {
        if (p.countType) {
          const count = reader.next(p.countType);
          for (let j = 0; j < count; j++) reader.next(p.type);
        } else reader.next(p.type);
      }
    }
  }
  if (reader.exhausted) fail(prefix, 'PLY body is shorter than its header says (truncated file?)');
  if (!faceElement || triangles.length === 0) {
    fail(prefix, `PLY file has no faces${vertexElement.count > 0 ? ` (${vertexElement.count} vertices: a point cloud, which polymerge cannot compare as a surface)` : ''}`);
  }

  const materials: IMaterial[] = [];
  let faceMaterials: Int32Array | null = null;
  if (triangleColors) {
    const count = triangles.length / 3;
    faceMaterials = new Int32Array(count);
    const byColor = new Map<number, number>();
    const colors = triangleColors.data;
    for (let t = 0; t < count; t++) {
      const rgb = colors[t];
      let index = byColor.get(rgb);
      if (index === undefined) {
        index = materials.length;
        byColor.set(rgb, index);
        const hex = rgb.toString(16).padStart(6, '0');
        materials.push({ name: `color_${hex}`, color: [linearOf(rgb >> 16), linearOf((rgb >> 8) & 255), linearOf(rgb & 255), 1] });
      }
      faceMaterials[t] = index;
    }
  }

  return buildWeldedMesh({
    format: 'ply',
    parts: [{ name: defaultGroupName(ctx.fileName), positions, indices: triangles.view(), faceMaterials }],
    materials,
    fileName: ctx.fileName,
    weldEpsilon: ctx.weldEpsilon,
    extras: { ply: { encoding: header.format, comments: header.comments, polygons: faceElement.count, vertexColors } },
  });
}
