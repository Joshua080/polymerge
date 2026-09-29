/**
 * Format-agnostic "triangle soup → welded IMesh" builder.
 *
 * Every format loader reduces its three.js output to a list of {@link TrianglePart}s
 * (one per named sub-mesh, in traversal order) and hands them to
 * {@link buildWeldedMesh}, which implements steps 3–6 of the NORMALISATION CONTRACT
 * in `types.ts`:
 *
 *  - Triangles are visited part → face → corner (0, 1, 2); every corner position is
 *    rounded to float32.
 *  - Exact weld (`weldEpsilon === 0`): corners are keyed on the float32 BIT patterns of
 *    x, y, z (with -0 normalised to +0) in a custom open-addressing hash table
 *    (murmur3-style mix of three uint32 words, linear probing, power-of-two table grown
 *    at load 0.5). O(1) expected per corner, no per-corner strings or objects.
 *  - Epsilon weld (`weldEpsilon > 0`): see {@link EpsilonWelder}.
 *  - Triangles whose welded corners are not three distinct vertices are dropped;
 *    triangles with a non-finite coordinate or an out-of-range index are dropped too
 *    (both counted in `metadata.degenerateFacesDropped`, so that
 *    `faceCount === sourceFaceCount - degenerateFacesDropped` always holds).
 *  - Vertex indices are FIRST-APPEARANCE ORDER IN THE STREAM OF KEPT TRIANGLES. When
 *    triangles were dropped after welding, a second O(n) pass renumbers the vertices so
 *    that a dropped triangle can neither leave an unreferenced vertex behind nor
 *    perturb the order.
 */
import { createMesh } from '../mesh.js';
import { MeshLoadError, type IMaterial, type IMesh, type IMeshGroup, type SourceFormat } from '../types.js';

/** One named sub-mesh of the triangle soup (becomes one IMeshGroup if any face survives). */
export interface TrianglePart {
  /** Group name. */
  name: string;
  /** Source vertex positions, interleaved xyz (world space). Rounded to float32 on read. */
  positions: ArrayLike<number>;
  /**
   * Triangle list, 3 vertex indices per triangle into `positions`. Omit / null for
   * non-indexed geometry (every 3 consecutive source vertices form a triangle).
   */
  indices?: ArrayLike<number> | null;
  /** Optional stable id per SOURCE vertex (`null` = unknown). */
  vertexIds?: ArrayLike<string | null> | null;
  /** Material index (into `WeldInput.materials`) for every triangle of the part. Default -1 (none). */
  material?: number;
  /** Per-triangle material index (overrides `material`), -1 = none. */
  faceMaterials?: ArrayLike<number> | null;
}

export interface WeldInput {
  format: SourceFormat;
  /** Parts in traversal order. Empty parts are allowed (they produce no group). */
  parts: readonly TrianglePart[];
  /** Candidate materials; only those referenced by a surviving face are kept (in first-use order). */
  materials?: readonly IMaterial[];
  /** Used for `metadata.sourceName`. */
  fileName?: string;
  /** Weld tolerance in model units (default 0 = exact float32 equality). */
  weldEpsilon?: number;
  /** Warnings collected by the format loader (copied, then extended by the builder). */
  warnings?: readonly string[];
  /** Format-specific metadata extras. */
  extras?: Record<string, unknown>;
  /** Output, when given: filled with the index into `parts` of each group of the result, in group order. */
  groupParts?: number[];
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** murmur3_32 over three 32-bit words (x, y, z), including the final avalanche. */
function hash3(x: number, y: number, z: number): number {
  let h = 0x2f5a3c71;
  let k = Math.imul(x, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  h ^= Math.imul(k, 0x1b873593);
  h = (h << 13) | (h >>> 19);
  h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  k = Math.imul(y, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  h ^= Math.imul(k, 0x1b873593);
  h = (h << 13) | (h >>> 19);
  h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  k = Math.imul(z, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  h ^= Math.imul(k, 0x1b873593);
  h = (h << 13) | (h >>> 19);
  h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  h ^= 12;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

function nextPow2(n: number): number {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}

/**
 * Open-addressing hash map from a triple of uint32 words (float32 bit patterns) to an
 * int32 value. Keys are stored contiguously (entry i at keys[3i..3i+2]); the table
 * holds entry indices (-1 = empty slot).
 */
export class Uint32TripleMap {
  keys: Uint32Array;
  values: Int32Array;
  size = 0;
  private table: Int32Array;
  private mask: number;

  constructor(expectedEntries = 16) {
    const cap = Math.max(16, Math.ceil(expectedEntries));
    this.keys = new Uint32Array(cap * 3);
    this.values = new Int32Array(cap);
    const tableSize = nextPow2(cap * 2);
    this.table = new Int32Array(tableSize).fill(-1);
    this.mask = tableSize - 1;
  }

  /** Value stored for (x, y, z), or -1. */
  get(x: number, y: number, z: number): number {
    const keys = this.keys;
    const table = this.table;
    const mask = this.mask;
    let slot = hash3(x, y, z) & mask;
    for (;;) {
      const e = table[slot];
      if (e < 0) return -1;
      const k = e * 3;
      if (keys[k] === x && keys[k + 1] === y && keys[k + 2] === z) return this.values[e];
      slot = (slot + 1) & mask;
    }
  }

  /** Returns the value stored for (x, y, z); if absent, stores `value` and returns it. */
  getOrInsert(x: number, y: number, z: number, value: number): number {
    const keys = this.keys;
    const table = this.table;
    const mask = this.mask;
    let slot = hash3(x, y, z) & mask;
    for (;;) {
      const e = table[slot];
      if (e < 0) break;
      const k = e * 3;
      if (keys[k] === x && keys[k + 1] === y && keys[k + 2] === z) return this.values[e];
      slot = (slot + 1) & mask;
    }
    const e = this.size;
    if (e === this.values.length) this.growEntries();
    const k = e * 3;
    this.keys[k] = x;
    this.keys[k + 1] = y;
    this.keys[k + 2] = z;
    this.values[e] = value;
    table[slot] = e;
    this.size = e + 1;
    if (this.size * 2 > table.length) this.rehash(table.length * 2);
    return value;
  }

  private growEntries(): void {
    const cap = this.values.length * 2;
    const keys = new Uint32Array(cap * 3);
    keys.set(this.keys);
    const values = new Int32Array(cap);
    values.set(this.values);
    this.keys = keys;
    this.values = values;
  }

  private rehash(tableSize: number): void {
    const table = new Int32Array(tableSize).fill(-1);
    const mask = tableSize - 1;
    const keys = this.keys;
    for (let e = 0; e < this.size; e++) {
      const k = e * 3;
      let slot = hash3(keys[k], keys[k + 1], keys[k + 2]) & mask;
      while (table[slot] >= 0) slot = (slot + 1) & mask;
      table[slot] = e;
    }
    this.table = table;
    this.mask = mask;
  }
}

// ---------------------------------------------------------------------------
// Welders
// ---------------------------------------------------------------------------

interface Welder {
  /** Number of (provisional) vertices created so far. */
  readonly count: number;
  /**
   * Weld one corner. `x, y, z` are float32-exact values, `bx, by, bz` their bit patterns
   * (with -0 already normalised to +0). Returns the provisional vertex index.
   */
  add(x: number, y: number, z: number, bx: number, by: number, bz: number): number;
  /** Provisional vertex positions (float32-exact), length >= count * 3. */
  positions(): Float32Array | Float64Array;
}

/** weldEpsilon === 0: one hash-map entry per distinct float32 position. Entry index = vertex index. */
class ExactWelder implements Welder {
  private map: Uint32TripleMap;

  constructor(expectedVertices: number) {
    this.map = new Uint32TripleMap(expectedVertices);
  }

  get count(): number {
    return this.map.size;
  }

  add(_x: number, _y: number, _z: number, bx: number, by: number, bz: number): number {
    return this.map.getOrInsert(bx, by, bz, this.map.size);
  }

  positions(): Float32Array {
    // The keys ARE the float32 bit patterns of the vertices, in creation order.
    return new Float32Array(this.map.keys.buffer, 0, this.map.size * 3);
  }
}

/**
 * weldEpsilon > 0: greedy clustering on a uniform grid.
 *
 * Every vertex is represented by the position of the first corner that created it (its
 * "seed"). A new corner merges into the EARLIEST existing vertex whose seed lies within
 * `epsilon` (Euclidean, inclusive); only if there is none does it create a new vertex.
 * Seeds are bucketed in cubic cells of edge `2ε × (1 + 2⁻²⁰)`. Along each axis the ε-ball
 * of a corner then overlaps only its own cell and the neighbour on the side of the cell
 * half it lies in (the tiny inflation keeps that true despite floating-point rounding),
 * so a query inspects exactly the 2×2×2 block of cells nearest to the corner.
 *
 * Approximation (documented, deliberate): merging is NOT transitive. Distances are
 * measured to seeds, never to the corners that merged into them, so for a chain A–B–C
 * with |AB| ≤ ε, |BC| ≤ ε but |AC| > ε, B joins A and C becomes a new vertex. Results are
 * deterministic and depend only on the triangle order.
 *
 * Speed-up: an exact float32-bits map caches the vertex chosen for every distinct corner
 * position already seen, so repeated corners (≈ 6 per vertex in an STL) cost one hash
 * lookup. This is exact, not a heuristic: when a position p was first seen, no seed
 * created earlier than the chosen vertex was within ε of p, and seeds created later have
 * larger indices, so "earliest seed within ε of p" never changes.
 */
class EpsilonWelder implements Welder {
  count = 0;
  private readonly eps2: number;
  private readonly invCell: number;
  private readonly exact: Uint32TripleMap;
  private pos: Float64Array;
  private next: Int32Array;
  // Grid: open addressing on integer cell coordinates (stored as doubles).
  private cellKeys: Float64Array;
  private cellHead: Int32Array;
  private cellCount = 0;
  private cellTable: Int32Array;
  private cellMask: number;

  constructor(epsilon: number, expectedVertices: number) {
    this.eps2 = epsilon * epsilon;
    this.invCell = 1 / (2 * epsilon * (1 + 2 ** -20));
    this.exact = new Uint32TripleMap(expectedVertices);
    const cap = Math.max(16, Math.ceil(expectedVertices));
    this.pos = new Float64Array(cap * 3);
    this.next = new Int32Array(cap);
    this.cellKeys = new Float64Array(cap * 3);
    this.cellHead = new Int32Array(cap);
    const tableSize = nextPow2(cap * 2);
    this.cellTable = new Int32Array(tableSize).fill(-1);
    this.cellMask = tableSize - 1;
  }

  add(x: number, y: number, z: number, bx: number, by: number, bz: number): number {
    const cached = this.exact.get(bx, by, bz);
    if (cached >= 0) return cached;

    const inv = this.invCell;
    const gx = x * inv;
    const gy = y * inv;
    const gz = z * inv;
    const cx = Math.floor(gx);
    const cy = Math.floor(gy);
    const cz = Math.floor(gz);
    const ox = gx - cx < 0.5 ? -1 : 1;
    const oy = gy - cy < 0.5 ? -1 : 1;
    const oz = gz - cz < 0.5 ? -1 : 1;
    const pos = this.pos;
    const next = this.next;
    const eps2 = this.eps2;
    let best = -1;
    for (let q = 0; q < 8; q++) {
      const cell = this.findCell(q & 1 ? cx + ox : cx, q & 2 ? cy + oy : cy, q & 4 ? cz + oz : cz);
      if (cell < 0) continue;
      for (let v = this.cellHead[cell]; v >= 0; v = next[v]) {
        if (best >= 0 && v >= best) continue;
        const k = v * 3;
        const ex = pos[k] - x;
        const ey = pos[k + 1] - y;
        const ez = pos[k + 2] - z;
        if (ex * ex + ey * ey + ez * ez <= eps2) best = v;
      }
    }

    if (best < 0) {
      best = this.count;
      if (best === this.next.length) this.growVertices();
      const k = best * 3;
      this.pos[k] = x;
      this.pos[k + 1] = y;
      this.pos[k + 2] = z;
      const cell = this.getOrCreateCell(cx, cy, cz);
      this.next[best] = this.cellHead[cell];
      this.cellHead[cell] = best;
      this.count = best + 1;
    }
    this.exact.getOrInsert(bx, by, bz, best);
    return best;
  }

  positions(): Float64Array {
    return this.pos.subarray(0, this.count * 3);
  }

  private cellSlot(cx: number, cy: number, cz: number): number {
    // `| 0` keeps the low 32 bits of the (integer-valued) coordinates; full doubles are compared.
    return hash3(cx | 0, cy | 0, cz | 0) & this.cellMask;
  }

  private findCell(cx: number, cy: number, cz: number): number {
    const table = this.cellTable;
    const keys = this.cellKeys;
    const mask = this.cellMask;
    let slot = this.cellSlot(cx, cy, cz);
    for (;;) {
      const c = table[slot];
      if (c < 0) return -1;
      const k = c * 3;
      if (keys[k] === cx && keys[k + 1] === cy && keys[k + 2] === cz) return c;
      slot = (slot + 1) & mask;
    }
  }

  private getOrCreateCell(cx: number, cy: number, cz: number): number {
    const found = this.findCell(cx, cy, cz);
    if (found >= 0) return found;
    const c = this.cellCount;
    if (c === this.cellHead.length) {
      const cap = c * 2;
      const keys = new Float64Array(cap * 3);
      keys.set(this.cellKeys);
      const heads = new Int32Array(cap);
      heads.set(this.cellHead);
      this.cellKeys = keys;
      this.cellHead = heads;
    }
    const k = c * 3;
    this.cellKeys[k] = cx;
    this.cellKeys[k + 1] = cy;
    this.cellKeys[k + 2] = cz;
    this.cellHead[c] = -1;
    this.cellCount = c + 1;
    let slot = this.cellSlot(cx, cy, cz);
    while (this.cellTable[slot] >= 0) slot = (slot + 1) & this.cellMask;
    this.cellTable[slot] = c;
    if (this.cellCount * 2 > this.cellTable.length) this.rehashCells(this.cellTable.length * 2);
    return c;
  }

  private rehashCells(tableSize: number): void {
    this.cellTable = new Int32Array(tableSize).fill(-1);
    this.cellMask = tableSize - 1;
    const keys = this.cellKeys;
    for (let c = 0; c < this.cellCount; c++) {
      const k = c * 3;
      let slot = this.cellSlot(keys[k], keys[k + 1], keys[k + 2]);
      while (this.cellTable[slot] >= 0) slot = (slot + 1) & this.cellMask;
      this.cellTable[slot] = c;
    }
  }

  private growVertices(): void {
    const cap = this.next.length * 2;
    const pos = new Float64Array(cap * 3);
    pos.set(this.pos);
    const next = new Int32Array(cap);
    next.set(this.next);
    this.pos = pos;
    this.next = next;
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Weld a triangle soup into a normalised {@link IMesh} (see the module doc comment).
 * Throws {@link MeshLoadError} when no valid triangle survives.
 */
export function buildWeldedMesh(input: WeldInput): IMesh {
  const format = input.format;
  const eps = input.weldEpsilon ?? 0;
  if (typeof eps !== 'number' || !Number.isFinite(eps) || eps < 0) {
    throw new MeshLoadError(`weldEpsilon must be a finite number >= 0 (got ${String(eps)})`, format);
  }
  const parts = input.parts;
  const warnings = input.warnings ? [...input.warnings] : [];
  const srcMaterials = input.materials ?? [];

  // Pass 0: sizes.
  let totalTris = 0;
  let sourceVertexCount = 0;
  let expectedVertices = 0;
  let hasIds = false;
  for (const part of parts) {
    const nv = Math.floor(part.positions.length / 3);
    const nt = part.indices ? Math.floor(part.indices.length / 3) : Math.floor(nv / 3);
    sourceVertexCount += nv;
    totalTris += nt;
    // Indexed parts rarely weld much further; non-indexed soups have ~6 corners per vertex.
    expectedVertices += part.indices ? nv : Math.ceil(nv / 4);
    if (part.vertexIds) hasIds = true;
    const leftover = part.indices ? part.indices.length % 3 : nv % 3;
    if (leftover !== 0) {
      const what = part.indices ? 'index value(s)' : 'vertex position(s)';
      warnings.push(`part "${part.name}": ${leftover} trailing ${what} not forming a complete triangle ignored`);
    }
  }

  const welder: Welder = eps > 0 ? new EpsilonWelder(eps, expectedVertices) : new ExactWelder(expectedVertices);
  const faces = new Uint32Array(totalTris * 3);
  const faceMat = new Int32Array(totalTris);
  // Global source-vertex index of each kept corner (only needed to resolve vertex ids).
  const cornerSrc = hasIds ? new Int32Array(totalTris * 3) : null;
  const ranges: { name: string; start: number; count: number; part: number }[] = [];

  const f = new Float32Array(9);
  const u = new Uint32Array(f.buffer);
  const src = [0, 0, 0];
  let nf = 0;
  let degenerate = 0;
  let invalid = 0;
  let srcBase = 0;
  let partIndex = 0;

  // Pass 1: weld, drop invalid / degenerate triangles.
  for (const part of parts) {
    const pos = part.positions;
    const idx = part.indices ?? null;
    const nv = Math.floor(pos.length / 3);
    const nt = idx ? Math.floor(idx.length / 3) : Math.floor(nv / 3);
    const perFace = part.faceMaterials ?? null;
    const partMat = part.material ?? -1;
    const start = nf;

    for (let t = 0; t < nt; t++) {
      let ok = true;
      for (let c = 0; c < 3; c++) {
        const vi = idx ? idx[t * 3 + c] : t * 3 + c;
        if (!(vi >= 0 && vi < nv)) {
          ok = false;
          break;
        }
        src[c] = vi;
        const k = vi * 3;
        f[c * 3] = pos[k];
        f[c * 3 + 1] = pos[k + 1];
        f[c * 3 + 2] = pos[k + 2];
      }
      if (ok) {
        for (let k = 0; k < 9; k++) {
          const b = u[k];
          if ((b & 0x7f800000) === 0x7f800000) {
            ok = false; // NaN or ±Infinity
            break;
          }
          if (b === 0x80000000) u[k] = 0; // -0 → +0
        }
      }
      if (!ok) {
        invalid++;
        continue;
      }
      const a = welder.add(f[0], f[1], f[2], u[0], u[1], u[2]);
      const b = welder.add(f[3], f[4], f[5], u[3], u[4], u[5]);
      const c = welder.add(f[6], f[7], f[8], u[6], u[7], u[8]);
      if (a === b || b === c || a === c) {
        degenerate++;
        continue;
      }
      const o = nf * 3;
      faces[o] = a;
      faces[o + 1] = b;
      faces[o + 2] = c;
      if (cornerSrc) {
        cornerSrc[o] = srcBase + src[0];
        cornerSrc[o + 1] = srcBase + src[1];
        cornerSrc[o + 2] = srcBase + src[2];
      }
      faceMat[nf] = perFace ? (perFace[t] ?? -1) : partMat;
      nf++;
    }
    if (nf > start) ranges.push({ name: part.name, start, count: nf - start, part: partIndex });
    srcBase += nv;
    partIndex++;
  }

  if (nf === 0) {
    const detail =
      totalTris === 0
        ? 'the file contains no triangles'
        : `all ${plural(totalTris, 'triangle')} were degenerate or invalid ` +
          `(${degenerate} degenerate, ${invalid} with non-finite coordinates or bad indices)`;
    throw new MeshLoadError(`No usable triangle geometry: ${detail}`, format);
  }

  // Pass 2: canonical renumbering when triangles were dropped after welding.
  const provPositions = welder.positions();
  let vertexCount = welder.count;
  let positions: Float64Array;
  if (degenerate > 0) {
    const remap = new Int32Array(welder.count).fill(-1);
    let next = 0;
    for (let i = 0, n = nf * 3; i < n; i++) {
      const p = faces[i];
      let r = remap[p];
      if (r < 0) {
        r = next++;
        remap[p] = r;
      }
      faces[i] = r;
    }
    vertexCount = next;
    positions = new Float64Array(vertexCount * 3);
    for (let p = 0; p < remap.length; p++) {
      const r = remap[p];
      if (r < 0) continue;
      positions[r * 3] = provPositions[p * 3];
      positions[r * 3 + 1] = provPositions[p * 3 + 1];
      positions[r * 3 + 2] = provPositions[p * 3 + 2];
    }
  } else {
    positions = Float64Array.from(provPositions.subarray(0, vertexCount * 3));
  }
  const outFaces = nf * 3 === faces.length ? faces : faces.slice(0, nf * 3);

  // Materials: keep only referenced ones, in first-use (face) order.
  const matRemap = new Int32Array(srcMaterials.length).fill(-1);
  const materials: IMaterial[] = [];
  const faceMaterials = new Int32Array(nf);
  let anyMaterial = false;
  for (let i = 0; i < nf; i++) {
    const m = faceMat[i];
    if (m >= 0 && m < srcMaterials.length) {
      let r = matRemap[m];
      if (r < 0) {
        r = materials.length;
        matRemap[m] = r;
        materials.push(srcMaterials[m]);
      }
      faceMaterials[i] = r;
      anyMaterial = true;
    } else {
      faceMaterials[i] = -1;
    }
  }

  if (input.groupParts) for (const r of ranges) input.groupParts.push(r.part);
  const groups: IMeshGroup[] = ranges.map((r) => {
    const g: IMeshGroup = { name: r.name, faceStart: r.start, faceCount: r.count };
    if (anyMaterial) {
      const m0 = faceMaterials[r.start];
      let uniform = m0 >= 0;
      for (let i = r.start + 1, end = r.start + r.count; uniform && i < end; i++) uniform = faceMaterials[i] === m0;
      if (uniform) g.materialIndex = m0;
    }
    return g;
  });

  // Vertex ids: first non-null id among the kept corners of a vertex wins.
  let vertexIds: (string | null)[] | undefined;
  if (hasIds && cornerSrc) {
    const flat: (string | null)[] = new Array<string | null>(sourceVertexCount).fill(null);
    let base = 0;
    for (const part of parts) {
      const nv = Math.floor(part.positions.length / 3);
      const ids = part.vertexIds;
      if (ids) for (let i = 0; i < nv; i++) flat[base + i] = ids[i] ?? null;
      base += nv;
    }
    vertexIds = new Array<string | null>(vertexCount).fill(null);
    let conflicts = 0;
    for (let i = 0, n = nf * 3; i < n; i++) {
      const id = flat[cornerSrc[i]];
      if (id == null) continue;
      const v = outFaces[i];
      const cur = vertexIds[v];
      if (cur == null) vertexIds[v] = id;
      else if (cur !== id) conflicts++;
    }
    if (conflicts > 0) {
      warnings.push(`${plural(conflicts, 'welded corner')} carried a vertex id different from the one kept (first id wins)`);
    }
  }

  if (degenerate > 0) warnings.push(`${plural(degenerate, 'degenerate triangle')} dropped after welding`);
  if (invalid > 0) {
    warnings.push(`${plural(invalid, 'triangle')} with non-finite coordinates or out-of-range indices dropped`);
  }

  const extras: Record<string, unknown> | undefined =
    invalid > 0 ? { ...(input.extras ?? {}), invalidFacesDropped: invalid } : input.extras;

  return createMesh(positions, outFaces, {
    groups,
    materials,
    faceMaterials: anyMaterial ? faceMaterials : undefined,
    vertexIds,
    metadata: {
      format,
      sourceName: input.fileName,
      sourceVertexCount,
      sourceFaceCount: totalTris,
      degenerateFacesDropped: degenerate + invalid,
      weldEpsilon: eps,
      warnings,
      extras,
    },
  });
}
