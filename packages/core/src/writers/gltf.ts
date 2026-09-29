/**
 * glTF 2.0 WRITER — an IMesh as GLB, or as one self-contained .gltf (JSON with the buffer embedded
 * as a base64 data: URI). Isomorphic: returns bytes.
 *
 * Structure. With `IMesh.scene` (a glTF source, or a merge of one: merge/structure.ts) the source's
 * scene is rebuilt: node hierarchy, node names, local transforms as the source wrote them (TRS or
 * matrix), mesh names and node → mesh links. IMesh positions are world space (baked), so each
 * node's faces are UN-BAKED with the inverse of the node's world matrix. Faces that belong to no
 * node — and every face of a mesh without a scene (STL, OBJ) — go to one extra root node per group
 * name, with no transform, in world space.
 *
 * Exactness. World matrices are recomputed from the written local transforms exactly as
 * GLTFLoader computes them when the file is read (scene.ts), and every local position is chosen so
 * that re-baking it the way the loader does (parsers/three-mesh.ts) gives back the float32 world
 * position bit for bit: the rounded inverse or one of its neighbours, else a bounded lattice search
 * (`Unbaker`). So glTF → IMesh → glTF → IMesh reproduces positions and faces exactly.
 * `inexactVertices` counts positions no local float32 value was found for — after a merge moved a
 * vertex under a transform that magnifies (not every float32 world point has a float32 preimage
 * then), or under extreme anisotropic scaling; they are written at the nearest candidate found.
 *
 * Primitives. Within a node, faces are split into one primitive per (source primitive, material),
 * in source-primitive order. glTF primitives do not share vertices, so each primitive gets its own
 * copy of the welded vertices it uses (loaders weld them back). NORMAL is not written: IMesh has no
 * normals, and glTF clients compute flat normals when a primitive has none.
 *
 * Instancing. A mesh that several nodes use is written once when one set of local data bakes
 * exactly to every node's geometry (found jointly per vertex where the nodes' own un-bakings
 * differ); a node whose geometry diverged (e.g. a merge edited one instance) gets its own copy of
 * the mesh, under the same name, appended after the source's meshes so their indices stay stable.
 *
 * Vertex ids. `IMesh.vertexIds` are written as the custom attribute `_VERTEX_ID` (SCALAR FLOAT,
 * read back by the loader) on each primitive whose vertices all carry a float32-exact number id.
 *
 * Not written: UVs, textures, normals, skins, morph targets, animations, cameras, lights, extras
 * and extensions. Skinned, morphed and GPU-instanced geometry is written as static triangles in
 * the shape it was baked in (see `notes`).
 *
 * APPEARANCE SEAM (materials, UVs, textures), marked `SEAM(appearance)` below:
 *  - `primitiveKey` decides which faces share a primitive (source primitive + material today);
 *  - `collectPrimitive` defines a primitive's vertices: today one per welded vertex. Per-corner
 *    attributes (UVs) must key them by (welded vertex, corner values) instead, so that corners
 *    across a UV seam become separate glTF vertices, and gather the values into `PrimitiveData`;
 *  - `primitiveAttributes` emits every per-vertex accessor of a primitive (POSITION, _VERTEX_ID;
 *    TEXCOORD_n / COLOR_n / NORMAL go here), and `sameStructure` must compare what it adds;
 *  - `gltfMaterial` maps one IMaterial; textures need document-level images / samplers / textures
 *    arrays next to `json.materials` in `buildGltfDocument`, with image bytes in the buffer
 *    (`BinBuilder.view`).
 */
import { Matrix4 } from 'three';
import { writeGlb as packGlb } from '../parsers/gltf-container.js';
import { copyTransform, worldMatrices, type SceneTransform } from '../scene.js';
import type { IMaterial, IMesh, IMeshScene } from '../types.js';

export interface IGltfWriteOptions {
  /** `asset.generator` (default "polymerge"). */
  generator?: string;
}

/** The glTF JSON and binary buffer, before packing (GLB) or embedding (.gltf). */
export interface IGltfDocument {
  json: Record<string, unknown>;
  /** The one buffer's bytes (4-byte aligned; empty when there is no geometry). */
  bin: Uint8Array;
  /** What the file cannot express the way the source did (static skinned geometry, faces with no node, …). */
  notes: string[];
  /** Vertices written at the nearest float32 local position because none re-bakes exactly (0 normally). */
  inexactVertices: number;
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

// ---------------------------------------------------------------------------
// Exact un-baking
// ---------------------------------------------------------------------------

const F32 = new Float32Array(1);
const I32 = new Int32Array(F32.buffer);

/** float32 → integer such that consecutive float32 values are consecutive integers (±0 → 0). */
function ordered(v: number): number {
  F32[0] = v;
  const b = I32[0];
  return b >= 0 ? b : -(b & 0x7fffffff);
}

function unordered(o: number): number {
  I32[0] = o >= 0 ? o : -o | 0x80000000;
  return F32[0];
}

/** Bake one local point exactly as parsers/three-mesh.ts does (float64 affine map, then float32). */
function bakeInto(e: ArrayLike<number>, x: number, y: number, z: number, out: Float64Array): void {
  out[0] = Math.fround(e[0] * x + e[4] * y + e[8] * z + e[12]);
  out[1] = Math.fround(e[1] * x + e[5] * y + e[9] * z + e[13]);
  out[2] = Math.fround(e[2] * x + e[6] * y + e[10] * z + e[14]);
}

const IDENTITY = new Matrix4().elements;
const isIdentity = (e: ArrayLike<number>): boolean => IDENTITY.every((v, i) => e[i] === v);

/**
 * Lattice cells examined per vertex, and per document, before giving up (a vertex is then written
 * at the nearest candidate). Only near-singular, extremely anisotropic transforms get close.
 */
const MAX_LATTICE_STEPS = 20_000;
const MAX_LATTICE_STEPS_TOTAL = 4_000_000;

/** Integers from lo to hi, nearest to `center` first. */
function* centerOut(center: number, lo: number, hi: number): Generator<number> {
  const c = Math.min(hi, Math.max(lo, Math.round(center)));
  yield c;
  for (let d = 1; c - d >= lo || c + d <= hi; d++) {
    if (c + d <= hi) yield c + d;
    if (c - d >= lo) yield c - d;
  }
}

/** A world matrix, and the float32 world point a local point has to bake to under it. */
interface IBakeTarget {
  e: ArrayLike<number>;
  t: number[];
}

class Unbaker {
  inexact = 0;
  private readonly w = new Float64Array(3);
  private budget = MAX_LATTICE_STEPS_TOTAL;

  /**
   * Local float32 position of world point (x, y, z) under world matrix `e` (inverse `inv`), written
   * to out[o..o+2]: one that bakes back to exactly fround(x, y, z) whenever such a point exists.
   * The direct inverse, rounded to float32, and its 26 float32 neighbours settle almost every
   * vertex; the rest go to the lattice search (`search`).
   */
  unbake(e: ArrayLike<number>, inv: ArrayLike<number> | null, x: number, y: number, z: number, out: Float32Array, o: number): void {
    const t = [Math.fround(x), Math.fround(y), Math.fround(z)];
    if (!inv) {
      out[o] = t[0];
      out[o + 1] = t[1];
      out[o + 2] = t[2];
      return;
    }
    const b = [
      Math.fround(inv[0] * x + inv[4] * y + inv[8] * z + inv[12]),
      Math.fround(inv[1] * x + inv[5] * y + inv[9] * z + inv[13]),
      Math.fround(inv[2] * x + inv[6] * y + inv[10] * z + inv[14]),
    ];
    const targets = [{ e, t }];
    if (!this.near(targets, b, out, o, true) && !this.search(targets, b, out, o)) this.inexact++;
  }

  /**
   * One local point that bakes exactly to every target (the instances of a shared mesh), searched
   * around out[o..o+2]; written there on success. Returns false (leaving it unchanged) otherwise.
   */
  shared(targets: IBakeTarget[], out: Float32Array, o: number): boolean {
    const b = [out[o], out[o + 1], out[o + 2]];
    const found = new Float32Array(3);
    if (!this.near(targets, b, found, 0, false) && !this.search(targets, b, found, 0)) return false;
    out.set(found, o);
    return true;
  }

  /** b and its 26 float32 neighbours; with `keepBest`, out holds the closest one when none is exact. */
  private near(targets: IBakeTarget[], b: number[], out: Float32Array, o: number, keepBest: boolean): boolean {
    const w = this.w;
    const ob = b.map(ordered);
    let best = Infinity;
    for (let n = 0; n < 27; n++) {
      // n = 13 is b itself: try it first.
      const m = n === 0 ? 13 : n === 13 ? 0 : n;
      const cx = unordered(ob[0] + ((m % 3) - 1));
      const cy = unordered(ob[1] + ((Math.floor(m / 3) % 3) - 1));
      const cz = unordered(ob[2] + (Math.floor(m / 9) - 1));
      let err = 0;
      for (const { e, t } of targets) {
        bakeInto(e, cx, cy, cz, w);
        err += Math.abs(w[0] - t[0]) + Math.abs(w[1] - t[1]) + Math.abs(w[2] - t[2]);
      }
      if (!(err < best)) continue;
      best = err;
      if (err === 0 || keepBest) {
        out[o] = cx;
        out[o + 1] = cy;
        out[o + 2] = cz;
      }
      if (err === 0) return true;
    }
    return false;
  }

  /**
   * Lattice search. The local points that bake into a target's float32 cell form a thin, rotated
   * box (under an anisotropic transform it can lie a hundred ulps from the inverse along a
   * contracting axis). In ulp steps k from b, a bake is ≈ W·b − t + W·diag(ulp(b))·k, and the cell
   * is |that| ≤ half an ulp of t on each axis: 3 linear constraints per target. The bounding box of
   * the constraints is intersected over the targets; its two narrowest axes are enumerated from
   * the centre outwards, the third is solved as an interval from every constraint, and each
   * candidate is checked with the loader's exact arithmetic against every target.
   */
  private search(targets: IBakeTarget[], b: number[], out: Float32Array, o: number): boolean {
    const ob = b.map(ordered);
    const u = b.map((v, j) => unordered(ob[j] + 1) - v);
    const A: number[][] = [];
    const c: number[] = [];
    const lo = [-Infinity, -Infinity, -Infinity];
    const hi = [Infinity, Infinity, Infinity];
    for (const { e, t } of targets) {
      const rows: number[][] = [];
      const rhs: number[] = [];
      for (let i = 0; i < 3; i++) {
        // Scaled by the half-width of the target's cell (the wider side at a binade edge: a superset).
        const ov = ordered(t[i]);
        const h = Math.max(unordered(ov + 1) - t[i], t[i] - unordered(ov - 1)) / 2;
        rows.push([0, 1, 2].map((j) => (e[j * 4 + i] * u[j]) / h));
        rhs.push(-(e[i] * b[0] + e[4 + i] * b[1] + e[8 + i] * b[2] + e[12 + i] - t[i]) / h);
      }
      const inv = invert3(rows);
      if (!inv) return false;
      for (let j = 0; j < 3; j++) {
        const k = inv[j][0] * rhs[0] + inv[j][1] * rhs[1] + inv[j][2] * rhs[2];
        const ext = Math.abs(inv[j][0]) + Math.abs(inv[j][1]) + Math.abs(inv[j][2]);
        lo[j] = Math.max(lo[j], Math.ceil(k - ext) - 1);
        hi[j] = Math.min(hi[j], Math.floor(k + ext) + 1);
      }
      A.push(...rows);
      c.push(...rhs);
    }
    if (![...lo, ...hi].every(Number.isFinite) || lo.some((l, j) => l > hi[j])) return false;
    const [p, q, s] = [0, 1, 2].sort((m, n) => hi[m] - lo[m] - (hi[n] - lo[n]));
    const k = [0, 0, 0];
    const w = this.w;
    let steps = 0;
    for (const kp of centerOut((lo[p] + hi[p]) / 2, lo[p], hi[p])) {
      for (const kq of centerOut((lo[q] + hi[q]) / 2, lo[q], hi[q])) {
        if (++steps > MAX_LATTICE_STEPS || --this.budget < 0) return false;
        let from = -Infinity;
        let to = Infinity;
        for (let i = 0; i < A.length && from <= to + 2; i++) {
          const rest = A[i][p] * kp + A[i][q] * kq - c[i];
          const a = A[i][s];
          if (a === 0) {
            if (Math.abs(rest) > 1.5) from = Infinity;
            continue;
          }
          const x1 = (-1 - rest) / a;
          const x2 = (1 - rest) / a;
          from = Math.max(from, Math.min(x1, x2));
          to = Math.min(to, Math.max(x1, x2));
        }
        if (!(from <= to + 2)) continue; // (+ slack for the linear model at binade edges)
        const mid = Math.round((from + to) / 2);
        const first = to - from > 6 ? mid - 1 : Math.ceil(from) - 1;
        const last = to - from > 6 ? mid + 1 : Math.floor(to) + 1;
        k[p] = kp;
        k[q] = kq;
        candidates: for (let ks = first; ks <= last; ks++) {
          k[s] = ks;
          const cx = unordered(ob[0] + k[0]);
          const cy = unordered(ob[1] + k[1]);
          const cz = unordered(ob[2] + k[2]);
          for (const { e, t } of targets) {
            bakeInto(e, cx, cy, cz, w);
            if (w[0] !== t[0] || w[1] !== t[1] || w[2] !== t[2]) continue candidates;
          }
          out[o] = cx;
          out[o + 1] = cy;
          out[o + 2] = cz;
          return true;
        }
      }
    }
    return false;
  }
}

/** Inverse of a 3×3 matrix (rows), or null when singular / not finite. */
function invert3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(det !== 0 && Number.isFinite(det))) return null;
  const r = 1 / det;
  const out = [
    [A * r, (c * h - b * i) * r, (b * f - c * e) * r],
    [B * r, (a * i - c * g) * r, (c * d - a * f) * r],
    [C * r, (b * g - a * h) * r, (a * e - b * d) * r],
  ];
  return out.every((row) => row.every(Number.isFinite)) ? out : null;
}

/** True when local point o of `a` bakes under `e` to exactly the float32 world point `target`. */
function bakesTo(e: ArrayLike<number>, a: Float32Array, o: number, x: number, y: number, z: number, w: Float64Array): boolean {
  bakeInto(e, a[o], a[o + 1], a[o + 2], w);
  return w[0] === Math.fround(x) && w[1] === Math.fround(y) && w[2] === Math.fround(z);
}

// ---------------------------------------------------------------------------
// Binary buffer
// ---------------------------------------------------------------------------

class BinBuilder {
  readonly bufferViews: Record<string, unknown>[] = [];
  readonly accessors: Record<string, unknown>[] = [];
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  /** Add a 4-byte-aligned buffer view (e.g. an embedded image when `target` is omitted). Returns its index. */
  view(bytes: Uint8Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) this.push(new Uint8Array(pad));
    const view: Record<string, unknown> = { buffer: 0, byteOffset: this.length, byteLength: bytes.length };
    if (target !== undefined) view.target = target;
    this.bufferViews.push(view);
    this.push(bytes);
    return this.bufferViews.length - 1;
  }

  /** Add an accessor over a new buffer view. Returns the accessor index. */
  accessor(data: Float32Array | Uint16Array | Uint32Array, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4', target: number, extra: Record<string, unknown> = {}): number {
    this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), target);
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const componentType = data instanceof Float32Array ? FLOAT : data instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT;
    this.accessors.push({ bufferView: this.bufferViews.length - 1, componentType, count: data.length / size, type, ...extra });
    return this.accessors.length - 1;
  }

  finish(): Uint8Array {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) this.push(new Uint8Array(pad));
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
}

// ---------------------------------------------------------------------------
// Appearance (the seam: see the module comment)
// ---------------------------------------------------------------------------

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * SEAM(appearance): an IMaterial as a glTF material. Unknown metalness is written as 0 (glTF's
 * default of 1 would make it a metal); the alpha of `color` goes into baseColorFactor only (no
 * alphaMode: IMaterial does not record one).
 */
export function gltfMaterial(m: IMaterial): Record<string, unknown> {
  const pbr: Record<string, unknown> = {};
  if (m.color) pbr.baseColorFactor = m.color.map(clamp01);
  pbr.metallicFactor = clamp01(m.metalness ?? 0);
  if (m.roughness !== undefined) pbr.roughnessFactor = clamp01(m.roughness);
  const out: Record<string, unknown> = { pbrMetallicRoughness: pbr };
  if (m.name) out.name = m.name;
  return out;
}

/** Faces of one primitive-to-be, keyed by `primitiveKey`. */
interface PrimitiveFaces {
  /** Source primitive index (-1 = none; sorts last). */
  primitive: number;
  material: number;
  faces: number[];
}

/** SEAM(appearance): faces are split into primitives by this key: source primitive + material. */
function primitiveKey(primitive: number, material: number): string {
  return `${primitive}|${material}`;
}

/** One primitive's per-vertex data, local to its node. */
interface PrimitiveData {
  material: number;
  /** Welded (IMesh) vertex of every primitive vertex. */
  vertices: Int32Array;
  positions: Float32Array;
  /** `_VERTEX_ID` values, when every vertex has a numeric id. */
  ids: Float32Array | null;
  /** Some vertices have ids but the attribute could not be written (a missing or non-numeric id). */
  idsDropped: boolean;
  indices: Uint32Array;
}

/** A vertex id that round-trips through a float32 `_VERTEX_ID` attribute (the loader reads String(value)). */
function idValue(id: string | null | undefined): number | null {
  if (id == null || id === '') return null;
  const n = Number(id);
  return Number.isFinite(n) && Math.fround(n) === n && String(n) === id ? n : null;
}

/**
 * Gather one primitive: its own vertex list (first use order), local positions from the node's
 * un-bake cache, ids, and the index list.
 *
 * SEAM(appearance): a glTF vertex here is one welded vertex (`stamp` / `slot`). With per-corner
 * attributes, key it by (welded vertex, the corner's values) and collect the values per glTF vertex.
 */
function collectPrimitive(mesh: IMesh, prim: PrimitiveFaces, local: (v: number, out: Float32Array, o: number) => void, stamp: Int32Array, slot: Int32Array, stampId: number): PrimitiveData {
  const f = mesh.faces;
  const indices = new Uint32Array(prim.faces.length * 3);
  const vertices: number[] = [];
  let k = 0;
  for (const face of prim.faces) {
    for (let c = 0; c < 3; c++) {
      const v = f[face * 3 + c];
      if (stamp[v] !== stampId) {
        stamp[v] = stampId;
        slot[v] = vertices.length;
        vertices.push(v);
      }
      indices[k++] = slot[v];
    }
  }
  const n = vertices.length;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) local(vertices[i], positions, i * 3);
  let ids: Float32Array | null = mesh.vertexIds ? new Float32Array(n) : null;
  let anyId = false;
  for (let i = 0; i < n && mesh.vertexIds; i++) {
    const id = mesh.vertexIds[vertices[i]];
    if (id != null) anyId = true;
    const value = idValue(id);
    if (value === null) ids = null;
    else if (ids) ids[i] = value;
  }
  return { material: prim.material, vertices: Int32Array.from(vertices), positions, ids, idsDropped: anyId && !ids, indices };
}

/** SEAM(appearance): every per-vertex attribute of a primitive, as accessors (NORMAL / TEXCOORD_n / COLOR_n go here). */
function primitiveAttributes(bin: BinBuilder, data: PrimitiveData): Record<string, number> {
  const p = data.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (p[i + a] < min[a]) min[a] = p[i + a];
      if (p[i + a] > max[a]) max[a] = p[i + a];
    }
  }
  const attributes: Record<string, number> = {
    POSITION: bin.accessor(p, 'VEC3', ARRAY_BUFFER, { min, max }),
  };
  if (data.ids) attributes._VERTEX_ID = bin.accessor(data.ids, 'SCALAR', ARRAY_BUFFER);
  return attributes;
}

function primitiveJson(bin: BinBuilder, data: PrimitiveData, materialCount: number): Record<string, unknown> {
  const attributes = primitiveAttributes(bin, data);
  // The largest index value is the primitive-restart value of its type and must not be used.
  const small = data.vertices.length - 1 < 0xffff;
  const indices = bin.accessor(small ? Uint16Array.from(data.indices) : data.indices, 'SCALAR', ELEMENT_ARRAY_BUFFER);
  const out: Record<string, unknown> = { attributes, indices };
  if (data.material >= 0 && data.material < materialCount) out.material = data.material;
  return out;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** A node of the file being written. */
interface OutNode {
  name?: string;
  children: number[];
  transform: SceneTransform;
  /** Source mesh (index into scene.meshes), or -1 for a mesh of its own. */
  sceneMesh: number;
  meshName?: string;
  world: ArrayLike<number>;
  /** Inverse world matrix; null = identity (positions are written as they are). */
  inverse: ArrayLike<number> | null;
  /** False when faces cannot be written under it: a singular world matrix, or not in the scene. */
  usable: boolean;
  /** Primitives by `primitiveKey`, in first-seen order. */
  prims: Map<string, PrimitiveFaces>;
  baked?: string[];
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 5).map((n) => `"${n}"`);
  if (names.length > 5) shown.push('…');
  return shown.join(', ');
}

/** The scene, if it is consistent with the mesh (a stale or malformed one is ignored with a note). */
function usableScene(mesh: IMesh, notes: string[]): IMeshScene | null {
  const s = mesh.scene;
  if (!s) return null;
  const ok =
    s.faceSources.length === mesh.faceCount &&
    s.sources.every((src) => src.node >= 0 && src.node < s.nodes.length) &&
    s.faceSources.every((i) => i >= -1 && i < s.sources.length);
  if (!ok) notes.push('the scene structure does not match the mesh; it was written without it');
  return ok ? s : null;
}

/** Build the glTF JSON + binary buffer for `mesh` (see the module comment). */
export function buildGltfDocument(mesh: IMesh, opts: IGltfWriteOptions = {}): IGltfDocument {
  const notes: string[] = [];
  const scene = usableScene(mesh, notes);
  const nodes: OutNode[] = [];
  const roots: number[] = [];

  // ---- Nodes of the source scene, with the world matrices the loader will compute --------------
  const singular: string[] = [];
  if (scene) {
    // Undefined for a node the roots do not reach: a loader would never visit it.
    const worlds = worldMatrices(scene.nodes, scene.roots);
    scene.nodes.forEach((n, i) => {
      const world = worlds[i] ?? new Matrix4();
      const identity = isIdentity(world.elements);
      const det = world.determinant();
      const inverse = identity || !(det !== 0 && Number.isFinite(det)) ? null : world.clone().invert().elements;
      const node: OutNode = {
        children: [...n.children],
        transform: copyTransform(n),
        sceneMesh: n.mesh ?? -1,
        world: world.elements,
        inverse,
        usable: !!worlds[i] && (identity || inverse !== null),
        prims: new Map(),
      };
      if (n.name !== undefined) node.name = n.name;
      if (n.mesh !== undefined) node.meshName = scene.meshes[n.mesh]?.name;
      if (n.baked?.length) node.baked = n.baked;
      if (worlds[i] && !node.usable) singular.push(n.name ?? `#${i}`);
      nodes.push(node);
    });
    roots.push(...scene.roots);
  }
  const usable = (n: number): boolean => n >= 0 && n < nodes.length && nodes[n].usable;

  // ---- Faces → node → primitive -----------------------------------------------------------------
  const materials = mesh.materials;
  const loose = new Map<string, number>();
  let looseFaces = 0;
  const addFace = (node: number, primitive: number, face: number): void => {
    let material = mesh.faceMaterials ? mesh.faceMaterials[face] : -1;
    if (!(material >= 0 && material < materials.length)) material = -1;
    const key = primitiveKey(primitive, material);
    const prims = nodes[node].prims;
    let p = prims.get(key);
    if (!p) {
      p = { primitive, material, faces: [] };
      prims.set(key, p);
    }
    p.faces.push(face);
  };
  for (const g of mesh.groups) {
    for (let f = g.faceStart; f < g.faceStart + g.faceCount; f++) {
      const s = scene ? scene.faceSources[f] : -1;
      const src = s >= 0 ? scene!.sources[s] : null;
      if (src && usable(src.node)) {
        addFace(src.node, src.primitive, f);
        continue;
      }
      // No node: one extra root per group name, in world space.
      let n = loose.get(g.name);
      if (n === undefined) {
        n = nodes.length;
        loose.set(g.name, n);
        nodes.push({ name: g.name, children: [], transform: {}, sceneMesh: -1, meshName: g.name, world: IDENTITY, inverse: null, usable: true, prims: new Map() });
        roots.push(n);
      }
      addFace(n, -1, f);
      if (scene) looseFaces++;
    }
  }

  // ---- Per node: un-bake and gather primitives --------------------------------------------------
  const nV = mesh.vertexCount;
  const unbaker = new Unbaker();
  const cache = new Float32Array(nV * 3);
  const cacheStamp = new Int32Array(nV).fill(-1);
  const primStamp = new Int32Array(nV).fill(-1);
  const primSlot = new Int32Array(nV);
  let primCounter = 0;
  const p = mesh.positions;
  const dataOf: (PrimitiveData[] | null)[] = nodes.map((node, ni) => {
    if (node.prims.size === 0) return null;
    const local = (v: number, out: Float32Array, o: number): void => {
      if (cacheStamp[v] !== ni) {
        cacheStamp[v] = ni;
        unbaker.unbake(node.world, node.inverse, p[v * 3], p[v * 3 + 1], p[v * 3 + 2], cache, v * 3);
      }
      out[o] = cache[v * 3];
      out[o + 1] = cache[v * 3 + 1];
      out[o + 2] = cache[v * 3 + 2];
    };
    // Source primitive order; faces without a source primitive last; ties in first-seen order.
    const rank = (x: PrimitiveFaces): number => (x.primitive < 0 ? Number.MAX_SAFE_INTEGER : x.primitive);
    const prims = [...node.prims.values()].sort((a, b) => rank(a) - rank(b));
    return prims.map((prim) => collectPrimitive(mesh, prim, local, primStamp, primSlot, primCounter++));
  });

  // ---- Meshes: shared where one set of local data fits every user ----------------------------------
  const bin = new BinBuilder();
  const meshesJson: Record<string, unknown>[] = [];
  const meshOfNode = new Int32Array(nodes.length).fill(-1);
  const w = new Float64Array(3);
  // SEAM(appearance): instances share a mesh only if every per-vertex attribute is equal too.
  const sameStructure = (a: PrimitiveData[], b: PrimitiveData[]): boolean =>
    a.length === b.length &&
    a.every((d, i) => {
      const m = b[i];
      if (m.material !== d.material || m.indices.length !== d.indices.length || m.vertices.length !== d.vertices.length) return false;
      if (!m.indices.every((x, k) => x === d.indices[k])) return false;
      return !!m.ids === !!d.ids && (!m.ids || m.ids.every((x, k) => x === d.ids![k]));
    });
  const target = (n: number, prim: number, slot: number): IBakeTarget => {
    const v = dataOf[n]![prim].vertices[slot];
    return { e: nodes[n].world, t: [Math.fround(p[v * 3]), Math.fround(p[v * 3 + 1]), Math.fround(p[v * 3 + 2])] };
  };
  /**
   * Node u joins a variant (users sharing one mesh) when the variant's local data, adjusted where
   * needed to a point that bakes exactly for every user (each instance was un-baked on its own and
   * may have landed on a different valid local point), fits u too.
   */
  const join = (variant: { data: PrimitiveData[]; nodes: number[] }, u: number): boolean => {
    const mine = dataOf[u]!;
    if (!sameStructure(variant.data, mine)) return false;
    const e = nodes[u].world;
    const changes: { prim: number; slot: number; at: Float32Array }[] = [];
    for (let i = 0; i < mine.length; i++) {
      const positions = variant.data[i].positions;
      for (let k = 0; k < mine[i].vertices.length; k++) {
        const v = mine[i].vertices[k];
        if (bakesTo(e, positions, k * 3, p[v * 3], p[v * 3 + 1], p[v * 3 + 2], w)) continue;
        const at = positions.slice(k * 3, k * 3 + 3);
        if (!unbaker.shared([...variant.nodes, u].map((n) => target(n, i, k)), at, 0)) return false;
        changes.push({ prim: i, slot: k, at });
      }
    }
    for (const ch of changes) variant.data[ch.prim].positions.set(ch.at, ch.slot * 3);
    return true;
  };
  const emitMesh = (name: string | undefined, data: PrimitiveData[]): number => {
    const json: Record<string, unknown> = { primitives: data.map((d) => primitiveJson(bin, d, materials.length)) };
    if (name) json.name = name;
    meshesJson.push(json);
    return meshesJson.length - 1;
  };
  const extra: { name: string | undefined; data: PrimitiveData[]; nodes: number[] }[] = [];
  const usersOf: number[][] = scene ? scene.meshes.map(() => []) : [];
  nodes.forEach((n, i) => {
    if (dataOf[i] && n.sceneMesh >= 0 && n.sceneMesh < usersOf.length) usersOf[n.sceneMesh].push(i);
  });
  for (let m = 0; m < usersOf.length; m++) {
    const users = usersOf[m];
    if (users.length === 0) continue;
    const variants: { data: PrimitiveData[]; nodes: number[] }[] = [];
    for (const u of users) {
      const fit = variants.find((vr) => join(vr, u));
      if (fit) fit.nodes.push(u);
      else variants.push({ data: dataOf[u]!, nodes: [u] });
    }
    const name = scene!.meshes[m].name;
    const first = emitMesh(name, variants[0].data);
    for (const u of variants[0].nodes) meshOfNode[u] = first;
    for (const vr of variants.slice(1)) extra.push({ name, ...vr });
  }
  for (const vr of extra) {
    const index = emitMesh(vr.name, vr.data);
    for (const u of vr.nodes) meshOfNode[u] = index;
  }
  nodes.forEach((n, i) => {
    if (meshOfNode[i] < 0 && dataOf[i]) meshOfNode[i] = emitMesh(n.meshName ?? n.name, dataOf[i]!);
  });
  if (extra.length) {
    notes.push(`${extra.length} instance(s) of shared meshes diverged and were written as separate meshes`);
  }

  // ---- Notes ------------------------------------------------------------------------------------
  const bakedNames = (kind: string): string[] => nodes.filter((n, i) => dataOf[i] && n.baked?.includes(kind)).map((n) => n.name ?? '(unnamed)');
  const describe: Record<string, string> = {
    skin: 'skinned geometry was written as static triangles in its posed shape (skin dropped)',
    morph: 'morphed geometry was written as static triangles with its default weights applied (morph targets dropped)',
    instances: 'EXT_mesh_gpu_instancing copies were written as plain geometry of their node',
  };
  for (const kind of ['skin', 'morph', 'instances']) {
    const names = bakedNames(kind);
    if (names.length) notes.push(`${names.length} node(s) (${listNames(names)}): ${describe[kind]}`);
  }
  if (singular.length) notes.push(`${singular.length} node(s) (${listNames(singular)}) have a singular transform; their geometry was written in world space under new root node(s)`);
  if (looseFaces > 0) notes.push(`${looseFaces} face(s) belong to no node; written in world space under ${loose.size} new root node(s) (${listNames([...loose.keys()])})`);
  if (unbaker.inexact > 0) notes.push(`${unbaker.inexact} vertex position(s) cannot be reached exactly from their node's local space; written within a few float32 steps`);
  const idless = dataOf.reduce((n, d) => n + (d ? d.filter((x) => x.idsDropped).length : 0), 0);
  if (idless > 0) notes.push(`${idless} primitive(s) mix vertices with and without float32-exact numeric ids; written without _VERTEX_ID`);

  // ---- JSON -------------------------------------------------------------------------------------
  const nodesJson = nodes.map((n, i) => {
    const out: Record<string, unknown> = {};
    if (n.name !== undefined) out.name = n.name;
    if (n.children.length) out.children = n.children;
    Object.assign(out, n.transform);
    if (meshOfNode[i] >= 0) out.mesh = meshOfNode[i];
    return out;
  });
  const asset: Record<string, unknown> = { version: '2.0', generator: opts.generator ?? 'polymerge' };
  const copyright = mesh.metadata.extras?.copyright;
  if (typeof copyright === 'string') asset.copyright = copyright;
  const sceneJson: Record<string, unknown> = {};
  if (scene?.name) sceneJson.name = scene.name;
  if (roots.length) sceneJson.nodes = roots;
  const json: Record<string, unknown> = { asset, scene: 0, scenes: [sceneJson] };
  if (nodesJson.length) json.nodes = nodesJson;
  if (meshesJson.length) json.meshes = meshesJson;
  // SEAM(appearance): textures add images / samplers / textures arrays here.
  if (materials.length) json.materials = materials.map(gltfMaterial);
  const bytes = bin.finish();
  if (bytes.length) {
    json.accessors = bin.accessors;
    json.bufferViews = bin.bufferViews;
    json.buffers = [{ byteLength: bytes.length }];
  }
  return { json, bin: bytes, notes, inexactVertices: unbaker.inexact };
}

/** Base64 without Node's Buffer (browsers and Node). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Write `mesh` as a binary glTF (.glb). */
export function writeGlb(mesh: IMesh, opts: IGltfWriteOptions = {}): Uint8Array {
  const doc = buildGltfDocument(mesh, opts);
  return new Uint8Array(packGlb(doc.json, doc.bin.length ? doc.bin : null));
}

/** Write `mesh` as one self-contained .gltf: JSON with the buffer embedded as a base64 data: URI. */
export function writeGltf(mesh: IMesh, opts: IGltfWriteOptions = {}): Uint8Array {
  const doc = buildGltfDocument(mesh, opts);
  if (doc.bin.length) {
    doc.json.buffers = [{ byteLength: doc.bin.length, uri: `data:application/octet-stream;base64,${toBase64(doc.bin)}` }];
  }
  return new TextEncoder().encode(JSON.stringify(doc.json, null, 2) + '\n');
}
