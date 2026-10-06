/**
 * The render step's output (result.json + PNG images) as the post step receives it. In the
 * fork-safe setup it arrives as an artifact of a run that executed the pull request's own code, so
 * EVERYTHING in it is untrusted: validateResult() rebuilds a clean object from known fields with
 * checked types, lengths and enums (nothing is passed through), and checkImages() accepts only
 * regular files with our own names that really are PNGs of a sane size. Anything else rejects the
 * whole artifact.
 *
 * result.json, schema 1:
 *   { schema: 1, tool, pr, base (merge-base commit), head (head commit),
 *     limits: { maxFiles, maxFaces, maxBytes },
 *     palette: 'standard' | 'colorblind' (absent = standard), upAxis: 'auto' | 'y' | 'z' (absent = auto),
 *     files: [{ path, oldPath, change, status, image, error, modeChanged,
 *               mesh: { before: { vertices, faces } | null, after: … | null },
 *               limit: { what: 'faces' | 'bytes', value, max } | null,
 *               diff: summary (lib/summary.mjs) | null }] }
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ vertices: number, faces: number }} MeshCounts
 * @typedef {{ name: string | null, rotationDeg: number, distance: number }} PartSummary
 * @typedef {{ units: { from: string, to: string, factor: number } | null, scale: number, rotationDeg: number, distance: number }} TransformSummary
 * @typedef {{
 *   tier: number,
 *   vertices: { before: number, after: number, unchanged: number, moved: number, added: number, removed: number },
 *   faces: { before: number, after: number, unchanged: number, modified: number, added: number, removed: number },
 *   maxDisplacement: number, parts: PartSummary[], partsTotal: number, transform: TransformSummary | null
 * }} DiffSummary
 * @typedef {{
 *   path: string, oldPath: string | null, change: string, status: string, image: string | null,
 *   error: string | null, modeChanged: boolean, mesh: { before: MeshCounts | null, after: MeshCounts | null },
 *   limit: { what: string, value: number, max: number } | null, diff: DiffSummary | null
 * }} FileResult
 * @typedef {{
 *   schema: 1, tool: string | null, pr: number, base: string, head: string,
 *   limits: { maxFiles: number, maxFaces: number, maxBytes: number }, files: FileResult[],
 *   palette: 'standard' | 'colorblind', upAxis: 'auto' | 'y' | 'z'
 * }} RenderResult
 */

export const CHANGES = ['added', 'deleted', 'modified', 'renamed'];
export const PALETTES = ['standard', 'colorblind'];
export const UP_AXES = ['auto', 'y', 'z'];
export const STATUSES = ['rendered', 'same-content', 'same-geometry', 'error', 'lfs', 'too-large', 'not-rendered', 'skipped', 'render-failed'];

export const LIMITS = {
  files: 500,
  images: 100,
  path: 4096,
  text: 1000,
  resultBytes: 8 * 1024 * 1024,
  imageBytes: 12 * 1024 * 1024,
  totalImageBytes: 120 * 1024 * 1024,
  imageSide: 8192,
};

const IMAGE_NAME = /^\d{1,3}\.png$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ResultError extends Error {
  constructor(message) {
    super(`invalid render result: ${message}`);
    this.name = 'ResultError';
  }
}

/** @returns {never} */
function fail(message) {
  throw new ResultError(message);
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(v, where, max = LIMITS.text) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || v.includes('\0')) fail(`${where} must be a string of 1–${max} characters`);
  return v;
}

function optText(v, where, max) {
  return v === null || v === undefined ? null : text(v, where, max);
}

function count(v, where, max = 1e12) {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) fail(`${where} must be a whole number in 0…${max}`);
  return v;
}

function real(v, where) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where} must be a finite number`);
  return v;
}

function oneOf(v, list, where) {
  if (!list.includes(v)) fail(`${where} must be one of ${list.join(', ')}`);
  return v;
}

function sha(v, where) {
  if (typeof v !== 'string' || !SHA.test(v)) fail(`${where} must be a full commit id`);
  return v;
}

function meshCounts(v, where) {
  if (v === null || v === undefined) return null;
  if (!isObject(v)) fail(`${where} must be an object`);
  return { vertices: count(v.vertices, `${where}.vertices`), faces: count(v.faces, `${where}.faces`) };
}

function diffSummary(v, where) {
  if (v === null || v === undefined) return null;
  if (!isObject(v) || !isObject(v.vertices) || !isObject(v.faces)) fail(`${where} must be a diff summary`);
  const vx = v.vertices;
  const fc = v.faces;
  if (!Array.isArray(v.parts) || v.parts.length > 20) fail(`${where}.parts must be an array of at most 20`);
  let transform = null;
  if (v.transform !== null && v.transform !== undefined) {
    const t = v.transform;
    if (!isObject(t)) fail(`${where}.transform must be an object`);
    let units = null;
    if (t.units !== null && t.units !== undefined) {
      if (!isObject(t.units)) fail(`${where}.transform.units must be an object`);
      const unit = ['mm', 'cm', 'm', 'in', 'ft'];
      units = { from: oneOf(t.units.from, unit, `${where}.transform.units.from`), to: oneOf(t.units.to, unit, `${where}.transform.units.to`), factor: real(t.units.factor, `${where}.transform.units.factor`) };
    }
    transform = { units, scale: real(t.scale, `${where}.transform.scale`), rotationDeg: real(t.rotationDeg, `${where}.transform.rotationDeg`), distance: real(t.distance, `${where}.transform.distance`) };
  }
  return {
    tier: oneOf(v.tier, [1, 2, 3], `${where}.tier`),
    vertices: Object.fromEntries(['before', 'after', 'unchanged', 'moved', 'added', 'removed'].map((k) => [k, count(vx[k], `${where}.vertices.${k}`)])),
    faces: Object.fromEntries(['before', 'after', 'unchanged', 'modified', 'added', 'removed'].map((k) => [k, count(fc[k], `${where}.faces.${k}`)])),
    maxDisplacement: real(v.maxDisplacement, `${where}.maxDisplacement`),
    parts: v.parts.map((p, i) => {
      if (!isObject(p)) fail(`${where}.parts[${i}] must be an object`);
      return { name: optText(p.name, `${where}.parts[${i}].name`, 200), rotationDeg: real(p.rotationDeg, `${where}.parts[${i}].rotationDeg`), distance: real(p.distance, `${where}.parts[${i}].distance`) };
    }),
    partsTotal: count(v.partsTotal, `${where}.partsTotal`),
    transform,
  };
}

/**
 * A clean, fully checked copy of a parsed result.json. Throws ResultError.
 * @param {any} raw
 * @returns {RenderResult}
 */
export function validateResult(raw) {
  if (!isObject(raw)) fail('not a JSON object');
  if (raw.schema !== 1) fail(`unsupported schema ${JSON.stringify(raw.schema)}`);
  if (!Array.isArray(raw.files) || raw.files.length > LIMITS.files) fail(`files must be an array of at most ${LIMITS.files}`);
  if (!isObject(raw.limits)) fail('limits must be an object');
  const images = new Set();
  const files = raw.files.map((f, i) => {
    const where = `files[${i}]`;
    if (!isObject(f)) fail(`${where} must be an object`);
    const image = f.image === null || f.image === undefined ? null : f.image;
    if (image !== null) {
      if (typeof image !== 'string' || !IMAGE_NAME.test(image)) fail(`${where}.image must be a name like 0.png`);
      if (images.has(image)) fail(`${where}.image ${image} is used twice`);
      images.add(image);
    }
    const status = oneOf(f.status, STATUSES, `${where}.status`);
    if ((status === 'rendered') !== (image !== null)) fail(`${where}: an image goes with status "rendered", and only with it`);
    if (!isObject(f.mesh)) fail(`${where}.mesh must be an object`);
    let limit = null;
    if (f.limit !== null && f.limit !== undefined) {
      if (!isObject(f.limit)) fail(`${where}.limit must be an object`);
      limit = { what: oneOf(f.limit.what, ['faces', 'bytes'], `${where}.limit.what`), value: count(f.limit.value, `${where}.limit.value`), max: count(f.limit.max, `${where}.limit.max`) };
    }
    return {
      path: text(f.path, `${where}.path`, LIMITS.path),
      oldPath: optText(f.oldPath, `${where}.oldPath`, LIMITS.path),
      change: oneOf(f.change, CHANGES, `${where}.change`),
      status,
      image,
      error: optText(f.error, `${where}.error`, LIMITS.text),
      modeChanged: f.modeChanged === true,
      mesh: { before: meshCounts(f.mesh.before, `${where}.mesh.before`), after: meshCounts(f.mesh.after, `${where}.mesh.after`) },
      limit,
      diff: diffSummary(f.diff, `${where}.diff`),
    };
  });
  if (images.size > LIMITS.images) fail(`more than ${LIMITS.images} images`);
  return {
    schema: 1,
    tool: optText(raw.tool, 'tool', 100),
    pr: count(raw.pr, 'pr', 1e9),
    base: sha(raw.base, 'base'),
    head: sha(raw.head, 'head'),
    limits: {
      maxFiles: count(raw.limits.maxFiles, 'limits.maxFiles'),
      maxFaces: count(raw.limits.maxFaces, 'limits.maxFaces'),
      maxBytes: count(raw.limits.maxBytes, 'limits.maxBytes'),
    },
    files,
    palette: /** @type {'standard' | 'colorblind'} */ (raw.palette === undefined ? 'standard' : oneOf(raw.palette, PALETTES, 'palette')),
    upAxis: /** @type {'auto' | 'y' | 'z'} */ (raw.upAxis === undefined ? 'auto' : oneOf(raw.upAxis, UP_AXES, 'upAxis')),
  };
}

/**
 * Read and validate <dir>/result.json (a regular file of sane size).
 * @param {string} dir
 * @returns {RenderResult}
 */
export function readResult(dir) {
  const file = path.join(dir, 'result.json');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`no result.json in ${dir}`);
  }
  if (!stat.isFile() || stat.size > LIMITS.resultBytes) fail('result.json must be a regular file under 8 MB');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`result.json is not JSON (${err.message})`);
  }
  return validateResult(raw);
}

/**
 * Check every image the result names: a regular file (not a link) in `dir`, under the size cap,
 * starting with the PNG signature and a sane IHDR. Returns [{ name, file, bytes }].
 * @param {string} dir
 * @param {RenderResult} result
 * @returns {{ name: string, file: string, bytes: Buffer }[]}
 */
export function checkImages(dir, result) {
  let total = 0;
  const out = [];
  for (const f of result.files) {
    if (!f.image) continue;
    const file = path.join(dir, f.image);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      fail(`image ${f.image} is missing`);
    }
    if (!stat.isFile()) fail(`image ${f.image} is not a regular file`);
    if (stat.size > LIMITS.imageBytes) fail(`image ${f.image} is larger than ${LIMITS.imageBytes} bytes`);
    total += stat.size;
    if (total > LIMITS.totalImageBytes) fail('the images are too large in total');
    const bytes = fs.readFileSync(file);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') fail(`image ${f.image} is not a PNG`);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > LIMITS.imageSide || height > LIMITS.imageSide) fail(`image ${f.image} has an unreasonable size ${width}×${height}`);
    out.push({ name: f.image, file, bytes });
  }
  return out;
}
