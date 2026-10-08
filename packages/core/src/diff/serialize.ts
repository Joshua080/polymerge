/**
 * Lossless JSON (de)serialisation of IDiffResult.
 *
 * - Typed arrays are written as plain JSON number arrays and restored to their exact
 *   typed-array classes by field name.
 * - Numbers JSON cannot represent (NaN, ±Infinity, -0) are written as {"$num": "<text>"}
 *   and revived, so every numeric field (matrix entries, metrics, ...) round-trips bit-exactly.
 *   Finite doubles round-trip exactly through JSON's shortest-representation printing, and
 *   Float32Array values are exact doubles, so they do too.
 * - `parts[i].baseVertices / targetVertices` (Uint32Array) are handled the same way.
 * - Older session-1 JSON (no `parts`, no `alignment.scale`) is upgraded on read.
 */
import type { IDiffResult } from '../types.js';

type TypedCtor = Int32ArrayConstructor | Uint8ArrayConstructor | Float32ArrayConstructor;

const TYPED_FIELDS: Readonly<Record<string, TypedCtor>> = {
  baseToTarget: Int32Array,
  targetToBase: Int32Array,
  baseVertexStatus: Uint8Array,
  targetVertexStatus: Uint8Array,
  displacement: Float32Array,
  baseFaceStatus: Uint8Array,
  targetFaceStatus: Uint8Array,
};

/** Expected length of each typed field, from the mesh summaries. */
const LENGTH_OF: Readonly<Record<string, (r: IDiffResult) => number>> = {
  baseToTarget: (r) => r.base.vertexCount,
  targetToBase: (r) => r.target.vertexCount,
  baseVertexStatus: (r) => r.base.vertexCount,
  targetVertexStatus: (r) => r.target.vertexCount,
  displacement: (r) => r.target.vertexCount,
  baseFaceStatus: (r) => r.base.faceCount,
  targetFaceStatus: (r) => r.target.faceCount,
};

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { $num: Object.is(value, -0) ? '-0' : String(value) };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.$num === 'string' && Object.keys(o).length === 1) return Number(o.$num);
  }
  return value;
}

/** One number as the replacer would write it (JSON text). */
function numberJson(x: number): string {
  return Number.isFinite(x) && !Object.is(x, -0) ? String(x) : JSON.stringify(replacer('', x));
}

/** A typed array as JSON array text, built directly: JSON.stringify with a replacer would call it per element. */
function arrayJson(arr: ArrayLike<number>, integers: boolean): string {
  const n = arr.length;
  if (n === 0) return '[]';
  const parts = new Array<string>(n);
  if (integers) for (let i = 0; i < n; i++) parts[i] = String(arr[i]);
  else for (let i = 0; i < n; i++) parts[i] = numberJson(arr[i]);
  return `[${parts.join(',')}]`;
}

/** JSON-safe serialisation (typed arrays → plain arrays). */
export function serializeDiff(result: IDiffResult): string {
  // Everything but the big per-vertex / per-face arrays goes through JSON.stringify with the
  // replacer; those arrays are written directly (a replacer would be called once per element)
  // and appended as the object's last members.
  const plain: Record<string, unknown> = { ...result };
  for (const key of Object.keys(TYPED_FIELDS)) delete plain[key];
  plain.parts = (result.parts ?? []).map((p) => ({
    ...p,
    baseVertices: Array.from(p.baseVertices),
    targetVertices: Array.from(p.targetVertices),
  }));
  const rest = JSON.stringify(plain, replacer);
  const arrays = Object.entries(TYPED_FIELDS)
    .map(([key, Ctor]) => `${JSON.stringify(key)}:${arrayJson((result as unknown as Record<string, ArrayLike<number>>)[key], Ctor !== Float32Array)}`)
    .join(',');
  return rest === '{}' ? `{${arrays}}` : `${rest.slice(0, -1)},${arrays}}`;
}

/** Inverse of serializeDiff (plain arrays → typed arrays). Throws on malformed input. */
export function deserializeDiff(json: string): IDiffResult {
  const raw = JSON.parse(json, reviver) as Record<string, unknown>;
  if (raw === null || typeof raw !== 'object') throw new TypeError('deserializeDiff: not a JSON object');
  if (raw.schemaVersion !== 1) {
    throw new TypeError(`deserializeDiff: unsupported schemaVersion ${String(raw.schemaVersion)} (expected 1)`);
  }
  for (const [key, Ctor] of Object.entries(TYPED_FIELDS)) {
    const v = raw[key];
    if (!Array.isArray(v)) throw new TypeError(`deserializeDiff: field "${key}" must be an array`);
    raw[key] = Ctor.from(v as number[]);
  }
  const parts = raw.parts ?? [];
  if (!Array.isArray(parts)) throw new TypeError('deserializeDiff: field "parts" must be an array');
  raw.parts = parts.map((p: Record<string, unknown>) => ({
    ...p,
    baseVertices: Uint32Array.from(p.baseVertices as number[]),
    targetVertices: Uint32Array.from(p.targetVertices as number[]),
  }));
  const result = raw as unknown as IDiffResult;
  if (!result.base || !result.target) throw new TypeError('deserializeDiff: missing base/target summaries');
  if (result.alignment && typeof result.alignment.scale !== 'number') result.alignment.scale = 1;
  for (const [key, len] of Object.entries(LENGTH_OF)) {
    const got = (raw[key] as ArrayLike<number>).length;
    if (got !== len(result)) throw new RangeError(`deserializeDiff: field "${key}" has length ${got}, expected ${len(result)}`);
  }
  return result;
}
