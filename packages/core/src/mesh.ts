/**
 * Small, dependency-free helpers shared by parsers, diff engine, CLI, viewer and tests.
 * Owned by the orchestrator (see types.ts header).
 */
import {
  VertexStatus,
  type IBounds,
  type IDiffResult,
  type IFace,
  type IMesh,
  type IMeshAppearance,
  type IMeshGroup,
  type IMeshMetadata,
  type IMeshSummary,
  type IMaterial,
  type IVertex,
  type IVertexChange,
  type Mat4,
  type SourceFormat,
  type Vec3,
  type VertexStatusCode,
} from './types.js';

export const IDENTITY_MAT4: Readonly<Mat4> = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function computeBounds(positions: ArrayLike<number>): IBounds {
  if (positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export function boundsDiagonal(b: IBounds): number {
  return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

export interface CreateMeshInit {
  groups?: IMeshGroup[];
  materials?: IMaterial[];
  faceMaterials?: Int32Array;
  vertexIds?: (string | null)[];
  metadata?: Partial<IMeshMetadata>;
  /** Appearance layer (per-corner UVs must have faceCount × 6 values per set). */
  appearance?: IMeshAppearance;
}

/**
 * Build a well-formed IMesh from ALREADY-WELDED indexed arrays. Computes counts and
 * bounds, fills a default group covering every face, and defaults the metadata.
 * Parsers call this after welding; tests use it to hand-build meshes.
 */
export function createMesh(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  init: CreateMeshInit = {},
): IMesh {
  if (positions.length % 3 !== 0) throw new Error(`positions length ${positions.length} is not a multiple of 3`);
  if (faces.length % 3 !== 0) throw new Error(`faces length ${faces.length} is not a multiple of 3`);
  const pos = positions instanceof Float64Array ? positions : Float64Array.from(positions);
  const tri = faces instanceof Uint32Array ? faces : Uint32Array.from(faces);
  const vertexCount = pos.length / 3;
  const faceCount = tri.length / 3;
  for (let i = 0; i < tri.length; i++) {
    if (tri[i] >= vertexCount) throw new Error(`face index ${tri[i]} out of range (vertexCount ${vertexCount})`);
  }
  const format: SourceFormat = init.metadata?.format ?? 'obj';
  const sourceName = init.metadata?.sourceName;
  const groups =
    init.groups && init.groups.length > 0
      ? init.groups
      : [{ name: defaultGroupName(sourceName), faceStart: 0, faceCount }];
  const metadata: IMeshMetadata = {
    format,
    sourceName,
    sourceVertexCount: init.metadata?.sourceVertexCount ?? vertexCount,
    sourceFaceCount: init.metadata?.sourceFaceCount ?? faceCount,
    degenerateFacesDropped: init.metadata?.degenerateFacesDropped ?? 0,
    weldEpsilon: init.metadata?.weldEpsilon ?? 0,
    bounds: computeBounds(pos),
    warnings: init.metadata?.warnings ?? [],
    extras: init.metadata?.extras,
  };
  const mesh: IMesh = {
    positions: pos,
    faces: tri,
    vertexCount,
    faceCount,
    groups,
    materials: init.materials ?? [],
    metadata,
  };
  if (init.faceMaterials) mesh.faceMaterials = init.faceMaterials;
  if (init.vertexIds) mesh.vertexIds = init.vertexIds;
  if (init.appearance) {
    for (const uv of init.appearance.uvs) {
      if (uv.length !== faceCount * 6) throw new Error(`appearance.uvs: ${uv.length} values for ${faceCount} faces (expected ${faceCount * 6})`);
    }
    mesh.appearance = init.appearance;
  }
  return mesh;
}

export function defaultGroupName(sourceName?: string): string {
  if (!sourceName) return 'default';
  const base = sourceName.split(/[\\/]/).pop() ?? sourceName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function getPosition(mesh: IMesh, index: number): Vec3 {
  const p = mesh.positions;
  return [p[index * 3], p[index * 3 + 1], p[index * 3 + 2]];
}

export function getVertex(mesh: IMesh, index: number): IVertex {
  const v: IVertex = { index, position: getPosition(mesh, index) };
  const id = mesh.vertexIds?.[index];
  if (id != null) v.id = id;
  return v;
}

export function groupIndexOfFace(mesh: IMesh, faceIndex: number): number {
  const g = mesh.groups;
  let lo = 0;
  let hi = g.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (faceIndex < g[mid].faceStart) hi = mid - 1;
    else if (faceIndex >= g[mid].faceStart + g[mid].faceCount) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function getFace(mesh: IMesh, index: number): IFace {
  const f = mesh.faces;
  const face: IFace = {
    index,
    vertices: [f[index * 3], f[index * 3 + 1], f[index * 3 + 2]],
    groupIndex: groupIndexOfFace(mesh, index),
  };
  const m = mesh.faceMaterials?.[index];
  if (m !== undefined && m >= 0) face.materialIndex = m;
  return face;
}

export function summarizeMesh(mesh: IMesh): IMeshSummary {
  return {
    format: mesh.metadata.format,
    sourceName: mesh.metadata.sourceName,
    vertexCount: mesh.vertexCount,
    faceCount: mesh.faceCount,
    bounds: mesh.metadata.bounds,
  };
}

/** Apply a column-major 4x4 matrix to a point. */
export function transformPoint(m: ArrayLike<number>, p: ArrayLike<number>): Vec3 {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * Describe what happened to one vertex, from either side of the diff.
 * `side` says whether `index` is a base or a target vertex index.
 */
export function describeVertexChange(
  result: IDiffResult,
  base: IMesh,
  target: IMesh,
  side: 'base' | 'target',
  index: number,
): IVertexChange {
  const baseIndex = side === 'base' ? index : result.targetToBase[index];
  const targetIndex = side === 'target' ? index : result.baseToTarget[index];
  const status: VertexStatusCode =
    side === 'base'
      ? (result.baseVertexStatus[index] as VertexStatusCode)
      : (result.targetVertexStatus[index] as VertexStatusCode);
  const from = baseIndex >= 0 ? transformPoint(result.alignment.matrix, getPosition(base, baseIndex)) : null;
  const to = targetIndex >= 0 ? getPosition(target, targetIndex) : null;
  const delta: Vec3 | null = from && to ? [to[0] - from[0], to[1] - from[1], to[2] - from[2]] : null;
  let distance = 0;
  if (status === VertexStatus.Added || status === VertexStatus.Removed) distance = 0;
  else if (side === 'target') distance = result.displacement[index];
  else if (targetIndex >= 0) distance = result.displacement[targetIndex];
  return { status, baseIndex, targetIndex, from, to, delta, distance };
}
