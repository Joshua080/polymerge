/**
 * In-memory models of the files the generator writes, plus the triangle stream
 * each one produces under the NORMALISATION CONTRACT (types.ts, IMesh):
 *
 *  - STL: triangles in file order.
 *  - OBJ: `f` statements in file order (three's OBJLoader starts a new mesh at
 *    every `o`/`g` and keeps faces in file order inside each mesh; `usemtl`
 *    only adds geometry groups), so the stream is simply file order.
 *  - glTF/GLB: scene nodes depth-first pre-order (Object3D.traverse order),
 *    each mesh's primitives in order, each primitive's index buffer in order,
 *    positions baked with the node's world matrix (three.js arithmetic) and
 *    rounded to float32.
 *
 * Every corner carries the logical key of its vertex so the reference welder
 * (reference.ts) can map welded indices back to ground-truth identities.
 */
import type { Vec3 } from '../../packages/core/src/types.js';
import type { KMesh } from './kmesh.js';
import { applyMat4, composeTRS, identityMat4, multiplyMat4, toF32, type Quat } from './math.js';

export interface Corner {
  /** Position as stored in the file (local space for glTF). float32-exact. */
  p: Vec3;
  key: string;
}
export type CornerTri = [Corner, Corner, Corner];

// --------------------------------- STL ------------------------------------

export interface StlDoc {
  kind: 'stl';
  encoding: 'ascii' | 'binary';
  /** ASCII: `solid <name>`. */
  solidName: string;
  /** Binary: 80-byte header text (must not start with "solid"). */
  header: string;
  triangles: CornerTri[];
}

export function stlFromMesh(m: KMesh, encoding: 'ascii' | 'binary', solidName: string, header: string): StlDoc {
  const corner = (i: number): Corner => ({ p: m.positions[i], key: m.keys[i] });
  return { kind: 'stl', encoding, solidName, header, triangles: m.faces.map((f) => [corner(f[0]), corner(f[1]), corner(f[2])]) };
}

// --------------------------------- OBJ ------------------------------------

export type ObjStatement =
  | { kind: 'o' | 'g' | 'usemtl'; name: string }
  | { kind: 'f'; v: [number, number, number] };

export interface ObjDoc {
  kind: 'obj';
  comments: string[];
  /** `v` lines in file order. */
  vertices: Corner[];
  /** Statements written after all `v` lines; `f` indices are 0-based here (written 1-based). */
  statements: ObjStatement[];
}

/**
 * Incremental OBJ document builder. Vertices are de-duplicated by key and listed
 * in first-use order unless `permuteVertices` is called at the end.
 */
export class ObjBuilder {
  private readonly doc: ObjDoc = { kind: 'obj', comments: [], vertices: [], statements: [] };
  private readonly byKey = new Map<string, number>();

  comment(text: string): this {
    this.doc.comments.push(text);
    return this;
  }
  object(name: string): this {
    this.doc.statements.push({ kind: 'o', name });
    return this;
  }
  group(name: string): this {
    this.doc.statements.push({ kind: 'g', name });
    return this;
  }
  usemtl(name: string): this {
    this.doc.statements.push({ kind: 'usemtl', name });
    return this;
  }
  /** Declare all vertices of `m` (in mesh order) without emitting faces. */
  declareVertices(m: KMesh): this {
    for (let i = 0; i < m.positions.length; i++) this.vertexIndex(m.positions[i], m.keys[i]);
    return this;
  }
  /** Emit faces of `m` (all, or the given face indices, in the given order). */
  faces(m: KMesh, faceIndices?: readonly number[]): this {
    const list = faceIndices ?? m.faces.map((_, i) => i);
    for (const fi of list) {
      const f = m.faces[fi];
      const v = f.map((i) => this.vertexIndex(m.positions[i], m.keys[i])) as [number, number, number];
      this.doc.statements.push({ kind: 'f', v });
    }
    return this;
  }
  /** Reorder the `v` lines: `perm[newPosition] = oldPosition`. Face indices are remapped. */
  permuteVertices(perm: readonly number[]): this {
    if (perm.length !== this.doc.vertices.length) throw new Error('ObjBuilder.permuteVertices: length mismatch');
    const newIndexOf = new Array<number>(perm.length);
    perm.forEach((old, nw) => (newIndexOf[old] = nw));
    this.doc.vertices = perm.map((old) => this.doc.vertices[old]);
    for (const s of this.doc.statements) if (s.kind === 'f') s.v = s.v.map((i) => newIndexOf[i]) as [number, number, number];
    this.byKey.clear();
    this.doc.vertices.forEach((c, i) => this.byKey.set(c.key, i));
    return this;
  }
  get vertexCount(): number {
    return this.doc.vertices.length;
  }
  build(): ObjDoc {
    return structuredClone(this.doc);
  }
  private vertexIndex(p: Vec3, key: string): number {
    const e = this.byKey.get(key);
    if (e !== undefined) return e;
    const i = this.doc.vertices.length;
    this.byKey.set(key, i);
    this.doc.vertices.push({ p: [...p] as Vec3, key });
    return i;
  }
}

export function objFromMesh(m: KMesh, comments: string[] = [], vertexPerm?: readonly number[]): ObjDoc {
  const b = new ObjBuilder();
  for (const c of comments) b.comment(c);
  b.declareVertices(m).faces(m);
  if (vertexPerm) b.permuteVertices(vertexPerm);
  return b.build();
}

// -------------------------------- glTF ------------------------------------

export interface GltfPrimitiveSpec {
  /** Vertex buffer in file order (local space). */
  vertices: Corner[];
  /** Triangle list indices into `vertices`. */
  indices: number[];
  /** Optional `_VERTEX_ID` custom attribute (SCALAR FLOAT), one per vertex. */
  vertexIds?: number[];
  material?: number;
  /** Index component type (default: u16 when it fits, else u32). */
  indexType?: 'u16' | 'u32';
}

export interface GltfMeshSpec {
  name: string;
  primitives: GltfPrimitiveSpec[];
}

export interface GltfNodeSpec {
  name: string;
  translation?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
  mesh?: number;
  children?: number[];
  /**
   * Generator-only (not written): prefix for the logical keys of vertices
   * instanced by this node, so two instances of one mesh are distinct vertices.
   */
  keyPrefix?: string;
}

export interface GltfMaterialSpec {
  name: string;
  color: [number, number, number, number];
}

export interface GltfDoc {
  kind: 'gltf';
  /** Written as .glb (binary container) or .gltf (JSON + base64 data: URI). */
  container: 'glb' | 'gltf';
  sceneName: string;
  sceneNodes: number[];
  nodes: GltfNodeSpec[];
  meshes: GltfMeshSpec[];
  materials: GltfMaterialSpec[];
}

export interface PrimitiveOptions {
  /** Subset / order of faces of `m` to include (default: all, in order). */
  faceIndices?: readonly number[];
  /**
   * Vertex buffer order. 'first-use' = order of first reference by the faces;
   * a number[] = a permutation applied to the first-use order
   * (`perm[newSlot] = firstUseSlot`).
   */
  vertexOrder?: 'first-use' | readonly number[];
  vertexIds?: (key: string) => number;
  material?: number;
  indexType?: 'u16' | 'u32';
}

export function primitiveFromMesh(m: KMesh, opts: PrimitiveOptions = {}): GltfPrimitiveSpec {
  const faceIdx = opts.faceIndices ?? m.faces.map((_, i) => i);
  const slotOf = new Map<number, number>();
  const firstUse: number[] = [];
  for (const fi of faceIdx) {
    for (const v of m.faces[fi]) {
      if (!slotOf.has(v)) {
        slotOf.set(v, firstUse.length);
        firstUse.push(v);
      }
    }
  }
  let order = firstUse;
  if (Array.isArray(opts.vertexOrder)) {
    const perm = opts.vertexOrder as readonly number[];
    if (perm.length !== firstUse.length) throw new Error('primitiveFromMesh: vertexOrder length mismatch');
    order = perm.map((s) => firstUse[s]);
  }
  const bufferSlot = new Map<number, number>();
  order.forEach((v, slot) => bufferSlot.set(v, slot));
  const prim: GltfPrimitiveSpec = {
    vertices: order.map((v) => ({ p: [...m.positions[v]] as Vec3, key: m.keys[v] })),
    indices: faceIdx.flatMap((fi) => m.faces[fi].map((v) => bufferSlot.get(v)!)),
  };
  if (opts.vertexIds) prim.vertexIds = order.map((v) => opts.vertexIds!(m.keys[v]));
  if (opts.material !== undefined) prim.material = opts.material;
  if (opts.indexType) prim.indexType = opts.indexType;
  return prim;
}

/** World matrix of every node (three.js: matrixWorld = parent.matrixWorld × matrix). */
export function nodeWorldMatrices(doc: GltfDoc): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const visit = (n: number, parent: readonly number[]) => {
    const node = doc.nodes[n];
    const world = multiplyMat4(parent, composeTRS(node.translation, node.rotation, node.scale));
    out.set(n, world);
    for (const c of node.children ?? []) visit(c, world);
  };
  for (const n of doc.sceneNodes) visit(n, identityMat4());
  return out;
}

// ------------------------------- streams ----------------------------------

export type FileDoc = StlDoc | ObjDoc | GltfDoc;

export function fileExtension(doc: FileDoc): string {
  if (doc.kind === 'stl') return 'stl';
  if (doc.kind === 'obj') return 'obj';
  return doc.container;
}

/** Source triangle count as delivered by the three.js loader (before welding). */
export function sourceTriangleCount(doc: FileDoc): number {
  return triangleStream(doc).length;
}

/**
 * The triangle stream (world-space float32 corners + logical keys) in exactly the
 * order the normalisation contract visits it for this file.
 */
export function triangleStream(doc: FileDoc): CornerTri[] {
  if (doc.kind === 'stl') return doc.triangles.map((t) => t.map((c) => ({ p: toF32(c.p), key: c.key })) as CornerTri);
  if (doc.kind === 'obj') {
    const out: CornerTri[] = [];
    for (const s of doc.statements) {
      if (s.kind !== 'f') continue;
      out.push(s.v.map((i) => ({ p: toF32(doc.vertices[i].p), key: doc.vertices[i].key })) as CornerTri);
    }
    return out;
  }
  const world = nodeWorldMatrices(doc);
  const out: CornerTri[] = [];
  const visit = (n: number, prefix: string) => {
    const node = doc.nodes[n];
    const keyPrefix = prefix + (node.keyPrefix ?? '');
    if (node.mesh !== undefined) {
      const m = world.get(n)!;
      for (const prim of doc.meshes[node.mesh].primitives) {
        for (let i = 0; i < prim.indices.length; i += 3) {
          out.push(
            [0, 1, 2].map((k) => {
              const v = prim.vertices[prim.indices[i + k]];
              return { p: toF32(applyMat4(m, v.p)), key: keyPrefix + v.key };
            }) as CornerTri,
          );
        }
      }
    }
    for (const c of node.children ?? []) visit(c, keyPrefix);
  };
  for (const n of doc.sceneNodes) visit(n, '');
  return out;
}
