/**
 * 3MF (3D Manufacturing Format: a ZIP package of XML "model" parts) → IMesh.
 *
 * three.js' ThreeMFLoader needs the browser's DOMParser, which Node lacks, so the package is
 * unzipped with the fflate build that three.js ships (no extra dependency) and the model XML is
 * read by a small scanner of its own. What is read:
 *  - The root model part named by `_rels/.rels` (normally /3D/3dmodel.model), and model parts it
 *    reaches through the Production extension's `p:path` (Bambu Studio and Orca keep each object
 *    in /3D/Objects/*.model).
 *  - Every build item, with its transform, recursively through `<components>`: one TrianglePart
 *    (→ IMeshGroup) per mesh object instance, named after the object (else its parent object, else
 *    "object <id>"); a repeated name gets " #2", " #3", ... An object printed twice is two groups.
 *  - Units: positions are converted to MILLIMETRES (the model's `unit`: micron, millimeter,
 *    centimeter, inch, foot or meter), so two versions saved in different units compare directly.
 *  - Colours: a triangle's property (its `pid` / `p1`, else its object's `pid` / `pindex`) from
 *    `<basematerials>` (the base's name and displaycolor) or a Materials-extension
 *    `<colorgroup>` (named by its sRGB hex) → IMaterial + per-face material.
 *  - Slicer project data (print settings, plates, painted supports, thumbnails) is ignored:
 *    polymerge compares the geometry.
 */
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { MeshLoadError, type IMaterial, type IMesh, type Mat4 } from '../types.js';
import { namePrefix, type FormatLoadContext } from './bytes.js';
import { buildWeldedMesh, type TrianglePart } from './weld.js';

/** Millimetres per model unit (3MF core specification, `model@unit`). */
export const THREEMF_UNITS: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

export const MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

/** Extensions whose content is read (or safely ignored); any other REQUIRED extension gets a warning. */
const KNOWN_EXTENSIONS = [
  'http://schemas.microsoft.com/3dmanufacturing/production/2015/06',
  'http://schemas.microsoft.com/3dmanufacturing/material/2015/02',
];

type Attrs = Record<string, string>;

const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY, (_, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

const localName = (name: string): string => {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
};

/**
 * A minimal, fast XML tag scanner: calls `open(localName, attrs, selfClosing, qualifiedName)` for
 * every start tag and `close(localName)` for every end tag. Attributes are keyed by their LOCAL
 * name (`p:path` → `path`), except namespace declarations, which keep their `xmlns…` name.
 * Comments, CDATA, processing instructions and DOCTYPE are skipped; text content is ignored
 * (3MF keeps geometry in attributes).
 */
export function scanXml(
  text: string,
  open: (name: string, attrs: Attrs, selfClosing: boolean, qualified: string) => void,
  close: (name: string) => void,
): void {
  const n = text.length;
  let i = 0;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt < 0 || lt + 1 >= n) return;
    const c = text.charCodeAt(lt + 1);
    if (c === 33 /* ! */) {
      let end: number;
      if (text.startsWith('<!--', lt)) end = text.indexOf('-->', lt + 4) + 3;
      else if (text.startsWith('<![CDATA[', lt)) end = text.indexOf(']]>', lt + 9) + 3;
      else end = text.indexOf('>', lt) + 1;
      if (end <= 2) return;
      i = end;
      continue;
    }
    if (c === 63 /* ? */) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return;
      i = end + 2;
      continue;
    }
    if (c === 47 /* / */) {
      const end = text.indexOf('>', lt + 2);
      if (end < 0) return;
      close(localName(text.slice(lt + 2, end).trim()));
      i = end + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n) {
      const ch = text.charCodeAt(j);
      if (ch <= 32 || ch === 47 || ch === 62) break;
      j++;
    }
    const qualified = text.slice(lt + 1, j);
    const attrs: Attrs = {};
    let selfClosing = false;
    for (;;) {
      while (j < n && text.charCodeAt(j) <= 32) j++;
      if (j >= n) return;
      const ch = text.charCodeAt(j);
      if (ch === 62 /* > */) {
        j++;
        break;
      }
      if (ch === 47 /* / */) {
        selfClosing = true;
        j = text.indexOf('>', j) + 1;
        if (j <= 0) return;
        break;
      }
      const eq = text.indexOf('=', j);
      if (eq < 0) return;
      const attrName = text.slice(j, eq).trim();
      let q = eq + 1;
      while (q < n && text.charCodeAt(q) <= 32) q++;
      const quote = text[q];
      if (quote !== '"' && quote !== "'") return; // malformed: stop scanning
      const endQuote = text.indexOf(quote, q + 1);
      if (endQuote < 0) return;
      const value = decodeEntities(text.slice(q + 1, endQuote));
      attrs[attrName.startsWith('xmlns') ? attrName : localName(attrName)] = value;
      j = endQuote + 1;
    }
    open(localName(qualified), attrs, selfClosing, qualified);
    i = j;
  }
}

/** Parse a 3MF transform ("m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32", row vectors) into a column-major Mat4. */
export function parseThreeMfTransform(value: string | undefined, unitScale: number): Mat4 | null {
  if (value === undefined) return null;
  const m = value.trim().split(/\s+/).map(Number);
  if (m.length !== 12 || m.some((x) => !Number.isFinite(x))) return null;
  // x' = m00 x + m10 y + m20 z + m30 (and so on): column k of the 3×3 is (m0k, m1k, m2k) read across.
  return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9] * unitScale, m[10] * unitScale, m[11] * unitScale, 1];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A growable Float64Array / Uint32Array / Int32Array. */
class Grow<T extends Float64Array | Uint32Array | Int32Array> {
  length = 0;
  constructor(
    public data: T,
    private readonly make: (n: number) => T,
  ) {}
  push(x: number): void {
    if (this.length === this.data.length) {
      const next = this.make(this.data.length * 2 + 16);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = x;
  }
  view(): T {
    return this.data.subarray(0, this.length) as T;
  }
}

interface MeshData {
  /** In millimetres. */
  positions: Float64Array;
  triangles: Uint32Array;
  /** Per triangle: index into the model's property keys, -1 = none. */
  props: Int32Array;
}

interface ObjectDef {
  id: string;
  name?: string;
  type: string;
  mesh?: MeshData;
  components: { objectId: string; path?: string; transform: Mat4 }[];
}

interface ModelPart {
  path: string;
  /** Millimetres per unit of this part. */
  unit: number;
  objects: Map<string, ObjectDef>;
  build: { objectId: string; path?: string; transform: Mat4; partNumber?: string }[];
  /** Property groups by id: base materials and colour groups, each a list of [name, sRGB hex]. */
  groups: Map<string, { kind: 'base' | 'color'; entries: [name: string | undefined, color: string | undefined][] }>;
  /** "pid:index" keys used by triangles, in first-use order. */
  propKeys: string[];
  warnings: string[];
}

function parseModelPart(path: string, text: string, prefix: string): ModelPart {
  const part: ModelPart = { path, unit: 1, objects: new Map(), build: [], groups: new Map(), propKeys: [], warnings: [] };
  const keyIndex = new Map<string, number>();
  let object: ObjectDef | null = null;
  let objectPid: string | undefined;
  let objectPindex: string | undefined;
  let vertices: Grow<Float64Array> | null = null;
  let triangles: Grow<Uint32Array> | null = null;
  let props: Grow<Int32Array> | null = null;
  let group: { kind: 'base' | 'color'; entries: [string | undefined, string | undefined][] } | null = null;
  let inBuild = false;
  let sawModel = false;

  const propKey = (pid: string | undefined, index: string | undefined): number => {
    if (pid === undefined) return -1;
    const key = `${pid}:${index ?? '0'}`;
    let k = keyIndex.get(key);
    if (k === undefined) {
      k = part.propKeys.length;
      keyIndex.set(key, k);
      part.propKeys.push(key);
    }
    return k;
  };

  scanXml(
    text,
    (name, a, selfClosing) => {
      switch (name) {
        case 'model': {
          sawModel = true;
          const unit = a.unit ?? 'millimeter';
          const scale = THREEMF_UNITS[unit];
          if (scale === undefined) part.warnings.push(`${path}: unknown unit "${unit}", read as millimetres`);
          part.unit = scale ?? 1;
          const required = (a.requiredextensions ?? '').split(/\s+/).filter(Boolean);
          for (const p of required) {
            const ns = a[`xmlns:${p}`];
            if (ns && KNOWN_EXTENSIONS.includes(ns)) continue;
            if (ns && /securecontent/i.test(ns)) {
              throw new MeshLoadError(`${prefix}this 3MF is encrypted (Secure Content extension), which polymerge cannot read`, '3mf');
            }
            part.warnings.push(`${path}: requires the 3MF extension ${ns ?? `"${p}"`}, which polymerge does not read: the geometry shown may be incomplete`);
          }
          break;
        }
        case 'object':
          object = { id: a.id ?? '', name: a.name, type: a.type ?? 'model', components: [] };
          objectPid = a.pid;
          objectPindex = a.pindex;
          if (object.id) part.objects.set(object.id, object);
          if (selfClosing) object = null;
          break;
        case 'vertices':
          vertices = new Grow(new Float64Array(3 * 1024), (n) => new Float64Array(n));
          break;
        case 'vertex':
          if (vertices) {
            vertices.push(Number(a.x) * part.unit);
            vertices.push(Number(a.y) * part.unit);
            vertices.push(Number(a.z) * part.unit);
          }
          break;
        case 'triangles':
          triangles = new Grow(new Uint32Array(3 * 1024), (n) => new Uint32Array(n));
          props = new Grow(new Int32Array(1024), (n) => new Int32Array(n));
          break;
        case 'triangle':
          if (triangles && props) {
            for (const v of [a.v1, a.v2, a.v3]) {
              const x = Number(v);
              triangles.push(Number.isInteger(x) && x >= 0 && x < 0xffffffff ? x : 0xffffffff);
            }
            props.push(a.pid !== undefined ? propKey(a.pid, a.p1) : propKey(objectPid, objectPindex));
          }
          break;
        case 'component':
          if (object) {
            object.components.push({ objectId: a.objectid ?? '', path: a.path, transform: parseThreeMfTransform(a.transform, part.unit) ?? IDENTITY });
          }
          break;
        case 'basematerials':
          group = { kind: 'base', entries: [] };
          if (a.id) part.groups.set(a.id, group);
          break;
        case 'colorgroup':
          group = { kind: 'color', entries: [] };
          if (a.id) part.groups.set(a.id, group);
          break;
        case 'base':
          group?.entries.push([a.name, a.displaycolor]);
          break;
        case 'color':
          group?.entries.push([undefined, a.color]);
          break;
        case 'build':
          inBuild = true;
          break;
        case 'item':
          if (inBuild) {
            part.build.push({ objectId: a.objectid ?? '', path: a.path, transform: parseThreeMfTransform(a.transform, part.unit) ?? IDENTITY, partNumber: a.partnumber });
          }
          break;
        default:
          break;
      }
    },
    (name) => {
      switch (name) {
        case 'object':
          object = null;
          break;
        case 'mesh':
          if (object && vertices && triangles && props) {
            object.mesh = { positions: vertices.view(), triangles: triangles.view(), props: props.view() };
          }
          vertices = triangles = props = null;
          break;
        case 'basematerials':
        case 'colorgroup':
          group = null;
          break;
        case 'build':
          inBuild = false;
          break;
        default:
          break;
      }
    },
  );
  if (!sawModel) throw new MeshLoadError(`${prefix}${path} is not a 3MF model part (no <model> element)`, '3mf');
  return part;
}

/** "#RRGGBB" or "#RRGGBBAA" → linear RGBA, or undefined. */
function colorOf(hex: string | undefined): [number, number, number, number] | undefined {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex?.trim() ?? '');
  if (!m) return undefined;
  const v = parseInt(m[1], 16);
  const lin = (b: number): number => {
    const c = b / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [lin(v >> 16), lin((v >> 8) & 255), lin(v & 255), m[2] ? parseInt(m[2], 16) / 255 : 1];
}

const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+/, '');

/** The root model part's path, from the package relationships (falls back to the usual name). */
function rootModelPath(files: Record<string, Uint8Array>): string | undefined {
  const rels = files['_rels/.rels'];
  if (rels) {
    let target: string | undefined;
    scanXml(
      new TextDecoder().decode(rels),
      (name, a) => {
        if (name === 'Relationship' && target === undefined && a.Type === MODEL_REL && a.Target) target = normalizePath(a.Target);
      },
      () => {},
    );
    if (target && files[target]) return target;
  }
  if (files['3D/3dmodel.model']) return '3D/3dmodel.model';
  return Object.keys(files).find((f) => f.toLowerCase().endsWith('.model'));
}

/** True when these bytes are a ZIP package that holds a 3MF model part. */
export function looksLikeThreeMf(bytes: Uint8Array): boolean {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return false;
  // Entry names are in the central directory at the end (and in each local header).
  const tail = bytes.subarray(Math.max(0, bytes.length - (1 << 18)));
  const text = new TextDecoder('latin1').decode(tail);
  return /\.model/i.test(text) || /3D\//.test(new TextDecoder('latin1').decode(bytes.subarray(0, 512)));
}

export function loadThreeMf(buffer: ArrayBuffer, ctx: FormatLoadContext): IMesh {
  const prefix = namePrefix(ctx.fileName);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new MeshLoadError(`${prefix}not a 3MF file: 3MF is a ZIP package, and this file is not one`, '3mf');
  }
  let files: Record<string, Uint8Array>;
  try {
    // Only the parts needed: model XML and relationships (skips thumbnails, G-code, configs).
    files = unzipSync(bytes, { filter: (f) => /\.(model|rels)$/i.test(f.name) });
  } catch (err) {
    throw new MeshLoadError(`${prefix}could not unzip the 3MF package: ${(err as Error).message}`, '3mf');
  }
  const normalized: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) normalized[normalizePath(name)] = data;
  const rootPath = rootModelPath(normalized);
  if (!rootPath) throw new MeshLoadError(`${prefix}the 3MF package has no 3D model part (expected 3D/3dmodel.model)`, '3mf');

  const decoder = new TextDecoder('utf-8');
  const parts = new Map<string, ModelPart>();
  const modelPart = (path: string): ModelPart | undefined => {
    const key = normalizePath(path);
    let part = parts.get(key);
    if (part) return part;
    const data = normalized[key];
    if (!data) return undefined;
    part = parseModelPart(key, decoder.decode(data), prefix);
    parts.set(key, part);
    return part;
  };
  const root = modelPart(rootPath)!;
  const warnings: string[] = [];

  // Materials: one IMaterial per (model part, pid, index) actually used, deduplicated by name + colour.
  const materials: IMaterial[] = [];
  const materialIndex = new Map<string, number>();
  const materialOf = (part: ModelPart, propKey: number): number => {
    if (propKey < 0) return -1;
    const key = part.propKeys[propKey];
    const [pid, index] = key.split(':');
    const group = part.groups.get(pid);
    const entry = group?.entries[Number(index)];
    if (!group || !entry) return -1;
    const [name, color] = entry;
    const label = name ?? (color ? color.toLowerCase() : `${pid}:${index}`);
    const dedupe = `${label}|${color ?? ''}`;
    let m = materialIndex.get(dedupe);
    if (m === undefined) {
      m = materials.length;
      materialIndex.set(dedupe, m);
      const c = colorOf(color);
      materials.push(c ? { name: label, color: c } : { name: label });
    }
    return m;
  };

  const used = new Map<string, number>();
  const unique = (name: string): string => {
    const count = (used.get(name) ?? 0) + 1;
    used.set(name, count);
    return count === 1 ? name : `${name} #${count}`;
  };

  const triangleParts: TrianglePart[] = [];
  let instances = 0;
  const missing = new Set<string>();
  const visit = (part: ModelPart, objectId: string, matrix: Mat4, inherited: string | undefined, depth: number, trail: string[]): void => {
    const object = part.objects.get(objectId);
    if (!object) {
      missing.add(`${part.path}#${objectId}`);
      return;
    }
    const here = `${part.path}#${objectId}`;
    if (depth > 32 || trail.includes(here)) {
      warnings.push(`object ${objectId} in ${part.path} refers to itself through its components; skipped`);
      return;
    }
    const name = object.name || inherited;
    if (object.mesh) {
      instances++;
      const { positions, triangles, props } = object.mesh;
      const world = new Float64Array(positions.length);
      const e = matrix;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        world[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
        world[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        world[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      let faceMaterials: Int32Array | null = null;
      if (props.some((p) => p >= 0)) {
        faceMaterials = new Int32Array(props.length);
        const cache = new Map<number, number>();
        for (let t = 0; t < props.length; t++) {
          const p = props[t];
          let m = cache.get(p);
          if (m === undefined) {
            m = materialOf(part, p);
            cache.set(p, m);
          }
          faceMaterials[t] = m;
        }
      }
      triangleParts.push({ name: unique(name || `object ${objectId}`), positions: world, indices: triangles, faceMaterials });
    }
    for (const c of object.components) {
      const target = c.path ? modelPart(c.path) : part;
      if (!target) {
        missing.add(`${c.path}#${c.objectId}`);
        continue;
      }
      visit(target, c.objectId, multiply(matrix, c.transform), name, depth + 1, [...trail, here]);
    }
  };

  for (const item of root.build) {
    const target = item.path ? modelPart(item.path) : root;
    if (!target) {
      missing.add(`${item.path}#${item.objectId}`);
      continue;
    }
    visit(target, item.objectId, item.transform, item.partNumber, 0, []);
  }
  if (missing.size > 0) warnings.push(`the build refers to object(s) the package does not contain: ${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? ', …' : ''}`);
  for (const part of parts.values()) warnings.push(...part.warnings);
  if (triangleParts.every((p) => (p.indices?.length ?? 0) === 0)) {
    throw new MeshLoadError(
      `${prefix}the 3MF has no triangles to show${root.build.length === 0 ? ' (its build section is empty)' : ''}`,
      '3mf',
    );
  }

  const unitName = Object.entries(THREEMF_UNITS).find(([, v]) => v === root.unit)?.[0] ?? 'millimeter';
  return buildWeldedMesh({
    format: '3mf',
    parts: triangleParts,
    materials,
    fileName: ctx.fileName,
    weldEpsilon: ctx.weldEpsilon,
    warnings,
    extras: {
      threemf: { unit: unitName, convertedTo: 'mm', modelParts: [...parts.keys()], buildItems: root.build.length, instances },
    },
  });
}
