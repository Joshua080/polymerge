/**
 * KMesh — a "keyed" indexed triangle mesh used to CONSTRUCT fixtures.
 *
 * Every vertex carries a logical key (e.g. "g:3,4" for grid vertex i=3, j=4).
 * Keys are the ground truth of vertex identity: a base vertex and a target vertex
 * with the same key are the same logical vertex (possibly moved). All expected
 * correspondences in the manifest are derived by pushing keys through each
 * file's normalisation (welding) order — never by guessing indices.
 *
 * All positions are float32-exact (rounded with Math.fround on creation).
 */
import type { Vec3 } from '../../packages/core/src/types.js';
import { f32, toF32 } from './math.js';

export type Tri = [a: number, b: number, c: number];

export interface KMesh {
  positions: Vec3[];
  keys: string[];
  faces: Tri[];
}

/** Incremental builder that de-duplicates vertices by key. */
export class MeshBuilder {
  readonly positions: Vec3[] = [];
  readonly keys: string[] = [];
  readonly faces: Tri[] = [];
  private readonly byKey = new Map<string, number>();

  /** Index of the vertex with this key, creating it at `p` (float32-rounded) if new. */
  vertex(key: string, p: readonly number[]): number {
    const q = toF32(p);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      const e = this.positions[existing];
      if (e[0] !== q[0] || e[1] !== q[1] || e[2] !== q[2]) {
        throw new Error(`MeshBuilder: key ${key} re-used at a different position (${e} vs ${q})`);
      }
      return existing;
    }
    const i = this.positions.length;
    this.byKey.set(key, i);
    this.positions.push(q);
    this.keys.push(key);
    return i;
  }

  face(a: number, b: number, c: number): void {
    if (a === b || b === c || a === c) throw new Error(`MeshBuilder: degenerate face ${a},${b},${c}`);
    this.faces.push([a, b, c]);
  }

  build(): KMesh {
    return { positions: this.positions.slice(), keys: this.keys.slice(), faces: this.faces.map((f) => [...f] as Tri) };
  }
}

export function cloneMesh(m: KMesh): KMesh {
  return { positions: m.positions.map((p) => [...p] as Vec3), keys: m.keys.slice(), faces: m.faces.map((f) => [...f] as Tri) };
}

export function indexOfKey(m: KMesh, key: string): number {
  const i = m.keys.indexOf(key);
  if (i < 0) throw new Error(`indexOfKey: no vertex with key ${key}`);
  return i;
}

/** Map every position through `fn` (result rounded to float32). */
export function mapPositions(m: KMesh, fn: (p: Vec3, key: string) => readonly number[]): KMesh {
  const out = cloneMesh(m);
  out.positions = m.positions.map((p, i) => toF32(fn(p, m.keys[i])));
  return out;
}

/** Translate the vertices with the given keys by `delta` (float32-exact result required). */
export function moveVertices(m: KMesh, keys: readonly string[], delta: readonly number[]): KMesh {
  const set = new Set(keys);
  for (const k of set) indexOfKey(m, k);
  return mapPositions(m, (p, key) => {
    if (!set.has(key)) return p;
    const q = [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]];
    for (let k = 0; k < 3; k++) {
      if (f32(q[k]) !== q[k]) throw new Error(`moveVertices: ${key} moves to a non-float32-exact coordinate ${q[k]}`);
    }
    return q;
  });
}

/**
 * Append `extra` after `m` (faces of `extra` come AFTER all faces of `m`).
 * Vertices are merged by key: a key present in both must have the same position
 * (that is how attached geometry shares existing vertices).
 */
export function appendMesh(m: KMesh, extra: KMesh): KMesh {
  const b = new MeshBuilder();
  for (let i = 0; i < m.positions.length; i++) b.vertex(m.keys[i], m.positions[i]);
  for (const f of m.faces) b.face(f[0], f[1], f[2]);
  const map = extra.positions.map((p, i) => b.vertex(extra.keys[i], p));
  for (const f of extra.faces) b.face(map[f[0]], map[f[1]], map[f[2]]);
  return b.build();
}

/** Remove faces matching `pred`; vertices no longer referenced by any face are dropped. */
export function removeFaces(m: KMesh, pred: (face: Tri, faceIndex: number) => boolean): KMesh {
  const keptFaces = m.faces.filter((f, i) => !pred(f, i));
  const used = new Array<boolean>(m.positions.length).fill(false);
  for (const f of keptFaces) for (const v of f) used[v] = true;
  const remap = new Array<number>(m.positions.length).fill(-1);
  const out: KMesh = { positions: [], keys: [], faces: [] };
  for (let i = 0; i < m.positions.length; i++) {
    if (!used[i]) continue;
    remap[i] = out.positions.length;
    out.positions.push([...m.positions[i]] as Vec3);
    out.keys.push(m.keys[i]);
  }
  out.faces = keptFaces.map((f) => [remap[f[0]], remap[f[1]], remap[f[2]]] as Tri);
  return out;
}

/** New face order: `order[newIndex] = oldIndex`. */
export function reorderFaces(m: KMesh, order: readonly number[]): KMesh {
  if (order.length !== m.faces.length) throw new Error('reorderFaces: order length mismatch');
  const out = cloneMesh(m);
  out.faces = order.map((i) => [...m.faces[i]] as Tri);
  return out;
}

/** Cyclically rotate each face's corners by shifts[f] ∈ {0,1,2} (winding is preserved). */
export function rotateCorners(m: KMesh, shifts: readonly number[]): KMesh {
  const out = cloneMesh(m);
  out.faces = m.faces.map((f, i) => {
    const s = ((shifts[i] % 3) + 3) % 3;
    return [f[s], f[(s + 1) % 3], f[(s + 2) % 3]] as Tri;
  });
  return out;
}

/** Number of faces incident to each vertex. */
export function valences(m: KMesh): number[] {
  const v = new Array<number>(m.positions.length).fill(0);
  for (const f of m.faces) for (const i of f) v[i]++;
  return v;
}

/** Number of faces touching at least one vertex with one of the given keys. */
export function facesTouching(m: KMesh, keys: readonly string[]): number {
  const set = new Set(keys.map((k) => indexOfKey(m, k)));
  return m.faces.filter((f) => f.some((v) => set.has(v))).length;
}

/**
 * Edge-manifold check for closed solids: every undirected edge is used by exactly
 * two faces, once in each direction (consistent outward winding).
 */
export function assertClosedManifold(m: KMesh, label: string): void {
  const directed = new Map<string, number>();
  for (const f of m.faces) {
    for (let k = 0; k < 3; k++) {
      const a = f[k];
      const b = f[(k + 1) % 3];
      const key = `${a}>${b}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    const [a, b] = key.split('>');
    if (count !== 1 || directed.get(`${b}>${a}`) !== 1) {
      throw new Error(`${label}: not a closed, consistently wound manifold at edge ${key}`);
    }
  }
}
