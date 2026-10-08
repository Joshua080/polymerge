/**
 * SELF-CONTAINED PAGES — a diff packed into one HTML file with the viewer: both models (their
 * welded triangles, groups, materials and CAD faces) and the computed result. The page needs no
 * install, no server and no network; it can be mailed or attached to a ticket. `polymerge export`
 * writes one; the viewer's "Save as HTML" writes the same from the browser.
 *
 * The payload is one deflated binary blob, base64 in the page:
 *
 *   "PMX1" · u32 header length · header JSON (UTF-8) · zero padding to a multiple of 4 ·
 *   the arrays the header points into ([byte offset, element count, type])
 *
 * Positions are stored as float32 when that is exact (it is for every loaded model: welded
 * positions are float32 values), else as float64, so the models come back bit for bit. The result is serializeDiff's lossless JSON. Not carried: glTF
 * appearance (textures, UVs) and scene structure, which only the writers use.
 */
import { deflateSync, inflateSync } from 'three/examples/jsm/libs/fflate.module.js';
import { deserializeDiff, serializeDiff } from './diff/serialize.js';
import type { IDiffResult, IMesh } from './types.js';

export const EMBED_MAGIC = 'PMX1';

export interface IEmbedModel {
  /** File name as shown. */
  name: string;
  /** Size of the original file in bytes (0 when unknown). */
  bytes: number;
  mesh: IMesh;
}

/** How the page opens: which axis of the models is up. */
export interface IEmbedView {
  up?: 'y' | 'z';
}

export interface IEmbeddedDiff {
  /** What wrote it, e.g. "polymerge 0.3.0". */
  generator: string;
  base: IEmbedModel;
  target: IEmbedModel;
  result: IDiffResult;
  view?: IEmbedView;
}

type ArrayType = 'f32' | 'f64' | 'u32' | 'i32' | 'utf8';
type ArrayRef = [offset: number, count: number, type: ArrayType];

interface IHeaderModel {
  name: string;
  bytes: number;
  /** The mesh without its typed arrays (those are in `arrays`). */
  mesh: Record<string, unknown>;
  arrays: Record<string, ArrayRef>;
}

interface IHeader {
  version: 1;
  generator: string;
  view?: IEmbedView;
  models: [IHeaderModel, IHeaderModel];
  result: ArrayRef;
}

const ELEMENT_BYTES: Record<ArrayType, number> = { f32: 4, f64: 8, u32: 4, i32: 4, utf8: 1 };

/** Pack a diff (models and result) into deflated bytes. */
export function packDiff(d: IEmbeddedDiff): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const add = (bytes: Uint8Array, count: number, type: ArrayType): ArrayRef => {
    const ref: ArrayRef = [offset, count, type];
    chunks.push(bytes);
    offset += bytes.byteLength;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    return ref;
  };
  const typed = (a: Float32Array | Float64Array | Uint32Array | Int32Array, type: ArrayType) => add(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), a.length, type);
  const model = (m: IEmbedModel): IHeaderModel => {
    const { positions, faces, faceMaterials, brep, appearance: _appearance, scene: _scene, ...rest } = m.mesh;
    const single = Float32Array.from(positions);
    const exact = single.every((v, i) => v === positions[i]);
    const arrays: Record<string, ArrayRef> = {
      positions: exact ? typed(single, 'f32') : typed(Float64Array.from(positions), 'f64'),
      faces: typed(faces, 'u32'),
    };
    if (faceMaterials) arrays.faceMaterials = typed(faceMaterials, 'i32');
    const mesh: Record<string, unknown> = { ...rest, metadata: jsonSafe(rest.metadata) };
    if (brep) {
      arrays.brepFaceOf = typed(brep.faceOf, 'i32');
      mesh.brepFaces = brep.faces;
    }
    return { name: m.name, bytes: m.bytes, mesh, arrays };
  };
  const models: [IHeaderModel, IHeaderModel] = [model(d.base), model(d.target)];
  const resultText = new TextEncoder().encode(serializeDiff(d.result));
  const result = add(resultText, resultText.byteLength, 'utf8');
  const header: IHeader = { version: 1, generator: d.generator, view: d.view, models, result };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const headPad = (4 - ((8 + headerBytes.byteLength) % 4)) % 4;
  const raw = new Uint8Array(8 + headerBytes.byteLength + headPad + offset);
  raw.set(new TextEncoder().encode(EMBED_MAGIC), 0);
  new DataView(raw.buffer).setUint32(4, headerBytes.byteLength, true);
  raw.set(headerBytes, 8);
  let at = 8 + headerBytes.byteLength + headPad;
  for (const c of chunks) {
    raw.set(c, at);
    at += c.byteLength;
  }
  // f64 arrays need 8-byte alignment when read back: the reader copies every array, so 4 is enough.
  // Level 6 normally; 1 for big models (pure JavaScript deflate, ≈2× faster, a few % larger).
  return deflateSync(raw, { level: raw.byteLength > 32 * 2 ** 20 ? 1 : 6 });
}

/** The inverse of packDiff. Throws on anything that is not a packed diff. */
export function unpackDiff(packed: Uint8Array): IEmbeddedDiff {
  const raw = inflateSync(packed);
  if (raw.byteLength < 8 || new TextDecoder().decode(raw.subarray(0, 4)) !== EMBED_MAGIC) throw new Error('not a polymerge page payload');
  const headerLength = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headerLength))) as IHeader;
  if (header.version !== 1) throw new Error(`unsupported page payload version ${String(header.version)}`);
  const base = 8 + headerLength + ((4 - ((8 + headerLength) % 4)) % 4);
  const view = ([off, count, type]: ArrayRef): Uint8Array => {
    const start = base + off;
    const end = start + count * ELEMENT_BYTES[type];
    if (end > raw.byteLength) throw new Error('page payload is truncated');
    return raw.subarray(start, end);
  };
  // Copies, so each array owns aligned memory.
  const f32 = (r: ArrayRef) => new Float32Array(view(r).slice().buffer);
  const u32 = (r: ArrayRef) => new Uint32Array(view(r).slice().buffer);
  const i32 = (r: ArrayRef) => new Int32Array(view(r).slice().buffer);
  const model = (m: IHeaderModel): IEmbedModel => {
    const { brepFaces, ...rest } = m.mesh as Record<string, unknown> & { brepFaces?: unknown };
    const p = m.arrays.positions;
    const positions = p[2] === 'f64' ? new Float64Array(view(p).slice().buffer) : Float64Array.from(f32(p));
    const mesh = { ...rest, positions, faces: u32(m.arrays.faces) } as unknown as IMesh;
    if (m.arrays.faceMaterials) mesh.faceMaterials = i32(m.arrays.faceMaterials);
    if (m.arrays.brepFaceOf && brepFaces) mesh.brep = { faceOf: i32(m.arrays.brepFaceOf), faces: brepFaces as NonNullable<IMesh['brep']>['faces'] };
    return { name: m.name, bytes: m.bytes, mesh };
  };
  return {
    generator: header.generator,
    view: header.view,
    base: model(header.models[0]),
    target: model(header.models[1]),
    result: deserializeDiff(new TextDecoder().decode(view(header.result))),
  };
}

/** Metadata through JSON: format extras may hold things JSON cannot (typed arrays, cycles): those are dropped. */
function jsonSafe<T>(value: T): T {
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => {
      if (ArrayBuffer.isView(v)) return undefined;
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    }),
  ) as T;
}

// ---------------------------------------------------------------------------
// Base64 (the same in Node and the browser)
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DECODE = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 3 * 16384;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    let s = '';
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    if (i < end) {
      const n = (bytes[i] << 16) | ((i + 1 < end ? bytes[i + 1] : 0) << 8);
      s += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + (i + 1 < end ? ALPHABET[(n >> 6) & 63] : '=') + '=';
    }
    parts.push(s);
  }
  return parts.join('');
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < clean.length; i += 4) {
    const n = (DECODE[clean.charCodeAt(i)] << 18) | (DECODE[clean.charCodeAt(i + 1)] << 12) | (DECODE[clean.charCodeAt(i + 2)] << 6) | DECODE[clean.charCodeAt(i + 3)];
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = clean.length - i;
  if (rest >= 2) {
    const n = (DECODE[clean.charCodeAt(i)] << 18) | (DECODE[clean.charCodeAt(i + 1)] << 12) | (rest === 3 ? DECODE[clean.charCodeAt(i + 2)] << 6 : 0);
    out[o++] = n >> 16;
    if (rest === 3) out[o++] = (n >> 8) & 255;
  }
  return out.subarray(0, o);
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export interface IStandalonePage {
  title: string;
  /** The viewer's script (the built module bundle). */
  script: string;
  /** The viewer's style sheet, with its fonts already inlined (or none). */
  style: string;
  /** base64 of packDiff(...). */
  payload: string;
  /** One line about where it came from, kept in a comment at the top. */
  generator: string;
}

/** HTML text, escaped for an element's content or an attribute value. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Script text for an inline <script>: "</script" and "<!--" would end it (or change how the
 * HTML parser reads it), so their "<" is escaped — inside JavaScript strings, regular expressions
 * and comments, which is the only place they can occur, "\/" and "\!" mean the same.
 */
export function inlineScript(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/** One HTML file: the viewer (script and style inline) and the packed diff. */
export function standaloneHtml(p: IStandalonePage): string {
  return [
    '<!doctype html>',
    `<!-- ${escapeHtml(p.generator).replace(/--/g, '- -')}. A self-contained polymerge page: open it in any browser, no install or network needed.`,
    '     polymerge (MIT) · three.js (MIT) · fflate (MIT) · Inter typeface (SIL Open Font License 1.1, https://rsms.me/inter) -->',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="color-scheme" content="light dark" />',
    `<meta name="generator" content="${escapeHtml(p.generator)}" />`,
    `<title>${escapeHtml(p.title)}</title>`,
    `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M16 3 29 10v12L16 29 3 22V10z' fill='%239ca3af'/%3E%3Cpath d='M16 3 29 10 16 17 3 10z' fill='%23facc15'/%3E%3C/svg%3E" />`,
    `<style>${p.style.replace(/<\/(style)/gi, '<\\/$1')}</style>`,
    '</head>',
    '<body data-state="idle">',
    '<div id="app"></div>',
    `<script type="application/octet-stream" id="polymerge-embed" data-encoding="pmx1+deflate+base64">${p.payload}</script>`,
    `<script type="module">${inlineScript(p.script)}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The viewer's style sheet with its fonts inlined: `fonts` maps each url() as written in the CSS
 * to the font file's bytes. @font-face rules whose file is not given are dropped (the text falls
 * back to the system font for those characters).
 */
export function inlineFonts(css: string, fonts: Record<string, Uint8Array>): string {
  return css.replace(/@font-face\s*{[^}]*}/g, (rule) => {
    const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(rule);
    if (!m) return rule;
    const bytes = fonts[m[2]];
    return bytes ? rule.replace(m[0], `url(data:font/woff2;base64,${toBase64(bytes)})`) : '';
  });
}
