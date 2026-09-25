/**
 * Convert a loaded three.js `Mesh` (or `SkinnedMesh` / `InstancedMesh`) into a
 * {@link TrianglePart} for the weld builder: world-space positions (matrixWorld baked,
 * skinning / morph targets evaluated exactly as three.js does for raycasting), the
 * index buffer if any, per-triangle materials from `geometry.groups`, and optional
 * per-vertex ids from a custom attribute.
 */
import {
  Matrix4,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type InstancedMesh,
  type InterleavedBufferAttribute,
  type Material,
  type Mesh,
  type SkinnedMesh,
} from 'three';
import type { TrianglePart } from './weld.js';

type Attribute = BufferAttribute | InterleavedBufferAttribute;

/** Maps a three.js material to an index into the caller's material table (-1 = none). */
export type MaterialResolver = (material: Material | undefined) => number;

export interface MeshPartOptions {
  name: string;
  resolveMaterial: MaterialResolver;
  /** three.js attribute name holding per-vertex ids (e.g. `_vertex_id`). */
  idAttribute?: string;
}

export interface MeshPartInfo {
  part: TrianglePart;
  skinned: boolean;
  morphed: boolean;
  instances: number;
}

const IDENTITY = new Matrix4().elements;

function isIdentity(m: Matrix4): boolean {
  const e = m.elements;
  for (let i = 0; i < 16; i++) if (e[i] !== IDENTITY[i]) return false;
  return true;
}

function isInterleaved(attr: Attribute): attr is InterleavedBufferAttribute {
  return (attr as InterleavedBufferAttribute).isInterleavedBufferAttribute === true;
}

/** Raw (not de-normalised) component `c` of element `i`. */
function rawComponent(attr: Attribute, i: number, c: number): number {
  if (isInterleaved(attr)) return attr.data.array[i * attr.data.stride + attr.offset + c] as number;
  return attr.array[i * attr.itemSize + c] as number;
}

function hasActiveMorph(mesh: Mesh): boolean {
  const morph = mesh.geometry.morphAttributes.position;
  const influences = mesh.morphTargetInfluences;
  return !!morph && morph.length > 0 && !!influences && influences.some((w) => w !== 0);
}

/** Object-space positions after skinning / morphing, or the raw float32 array when neither applies. */
function localPositions(mesh: Mesh, position: Attribute, deform: boolean): ArrayLike<number> {
  if (
    !deform &&
    !isInterleaved(position) &&
    position.itemSize === 3 &&
    !position.normalized &&
    position.array instanceof Float32Array &&
    position.array.length >= position.count * 3
  ) {
    return position.array;
  }
  const n = position.count;
  const out = new Float64Array(n * 3);
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    if (deform) mesh.getVertexPosition(i, v);
    else v.fromBufferAttribute(position, i);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

/** Apply an affine column-major matrix to `count` points (result rounded to float32). */
function transformPositions(local: ArrayLike<number>, count: number, m: Matrix4, out: Float32Array, offset: number): void {
  const e = m.elements;
  for (let i = 0; i < count; i++) {
    const x = local[i * 3];
    const y = local[i * 3 + 1];
    const z = local[i * 3 + 2];
    const o = offset + i * 3;
    out[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
}

function triangleMaterials(
  mesh: Mesh,
  geometry: BufferGeometry,
  triangleCount: number,
  resolve: MaterialResolver,
): { material?: number; faceMaterials?: Int32Array } {
  const material = mesh.material;
  if (!Array.isArray(material)) return { material: resolve(material) };
  // Multi-material mesh: geometry.groups ranges are in index units (indexed) or vertex
  // units (non-indexed) — 3 per triangle either way. Faces outside every group get -1.
  const faceMaterials = new Int32Array(triangleCount).fill(-1);
  for (const g of geometry.groups) {
    const mi = resolve(material[g.materialIndex ?? 0]);
    const t0 = Math.max(0, Math.floor(g.start / 3));
    const t1 = Math.min(triangleCount, Math.floor((g.start + g.count) / 3));
    for (let t = t0; t < t1; t++) faceMaterials[t] = mi;
  }
  return { faceMaterials };
}

function readIds(attr: Attribute): (string | null)[] {
  const n = attr.count;
  const size = attr.itemSize;
  const ids = new Array<string | null>(n);
  for (let i = 0; i < n; i++) {
    if (size === 1) ids[i] = String(rawComponent(attr, i, 0));
    else {
      const parts: string[] = [];
      for (let c = 0; c < size; c++) parts.push(String(rawComponent(attr, i, c)));
      ids[i] = parts.join(',');
    }
  }
  return ids;
}

function repeat(src: ArrayLike<number>, times: number, add: (k: number) => number): Uint32Array {
  const n = src.length;
  const out = new Uint32Array(n * times);
  for (let k = 0; k < times; k++) {
    const shift = add(k);
    for (let i = 0; i < n; i++) out[k * n + i] = src[i] + shift;
  }
  return out;
}

/**
 * Extract a {@link TrianglePart} from a three.js triangle mesh. Returns `null` if the mesh
 * has no position attribute. `mesh.matrixWorld` must be up to date.
 */
export function meshToPart(mesh: Mesh, options: MeshPartOptions): MeshPartInfo | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position') as Attribute | undefined;
  if (!position || position.count === 0) return null;

  const skinned = (mesh as SkinnedMesh).isSkinnedMesh === true && !!(mesh as SkinnedMesh).skeleton;
  const morphed = hasActiveMorph(mesh);
  const count = position.count;
  const local = localPositions(mesh, position, skinned || morphed);

  const index = geometry.index;
  const indices: ArrayLike<number> | null = index ? (index.array as ArrayLike<number>) : null;
  const triangleCount = indices ? Math.floor(indices.length / 3) : Math.floor(count / 3);
  const mats = triangleMaterials(mesh, geometry, triangleCount, options.resolveMaterial);

  const idAttr = options.idAttribute ? (geometry.getAttribute(options.idAttribute) as Attribute | undefined) : undefined;
  const ids = idAttr && idAttr.count >= count ? readIds(idAttr) : null;

  // World matrices: one per instance for InstancedMesh.
  const instanced = (mesh as InstancedMesh).isInstancedMesh === true;
  const matrices: Matrix4[] = [];
  if (instanced) {
    const im = mesh as InstancedMesh;
    for (let i = 0; i < im.count; i++) {
      const m = new Matrix4();
      im.getMatrixAt(i, m);
      matrices.push(m.premultiply(mesh.matrixWorld));
    }
  } else {
    matrices.push(mesh.matrixWorld);
  }

  const instances = matrices.length;
  let positions: ArrayLike<number>;
  if (instances === 1 && isIdentity(matrices[0])) {
    positions = local;
  } else {
    const out = new Float32Array(count * 3 * instances);
    for (let k = 0; k < instances; k++) transformPositions(local, count, matrices[k], out, k * count * 3);
    positions = out;
  }

  const part: TrianglePart = { name: options.name, positions };
  if (instances === 1) {
    part.indices = indices;
    if (ids) part.vertexIds = ids;
    if (mats.faceMaterials) part.faceMaterials = mats.faceMaterials;
    else part.material = mats.material;
  } else {
    // Concatenate the instances into one part (one group per three.js mesh).
    if (indices) part.indices = repeat(indices, instances, (k) => k * count);
    else if (count % 3 !== 0) {
      // Keep the per-instance triangle stream aligned: index the instances explicitly.
      const seq = new Uint32Array(triangleCount * 3);
      for (let i = 0; i < seq.length; i++) seq[i] = i;
      part.indices = repeat(seq, instances, (k) => k * count);
    }
    if (ids) {
      // Suffix the instance number so that ids stay unique across instances.
      const all: (string | null)[] = [];
      for (let k = 0; k < instances; k++) for (const id of ids) all.push(id === null ? null : `${id}#${k}`);
      part.vertexIds = all;
    }
    if (mats.faceMaterials) {
      const fm = new Int32Array(triangleCount * instances);
      for (let k = 0; k < instances; k++) fm.set(mats.faceMaterials, k * triangleCount);
      part.faceMaterials = fm;
    } else part.material = mats.material;
  }
  return { part, skinned, morphed, instances };
}
