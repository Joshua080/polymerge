/**
 * Geometry builders for merge review: the merged mesh coloured by who shaped each face
 * (MERGE_COLORS), and "ghost" previews of one conflict region as base / ours / theirs have it.
 * Positions are merged-frame world coordinates minus `origin` (see layers.ts).
 */
import * as THREE from 'three';
import { MERGE_COLORS, type IMergeConflict, type IMesh, type Mat4 } from 'polymerge-core';
import type { IMergeView } from '../worker/protocol.js';
import { linearColor, type RGB } from './layers.js';

export type MergeFaceKind = 'unchanged' | 'ours' | 'theirs' | 'both' | 'conflict';

export const MERGE_LINEAR: Record<MergeFaceKind, RGB> = {
  unchanged: linearColor(MERGE_COLORS.unchanged),
  ours: linearColor(MERGE_COLORS.ours),
  theirs: linearColor(MERGE_COLORS.theirs),
  both: linearColor(MERGE_COLORS.both),
  conflict: linearColor(MERGE_COLORS.conflict),
};

/** Conflict region of each merged face (-1 = none): the first corner inside a region. */
export function faceConflicts(view: IMergeView): Int32Array {
  const m = view.merged;
  const vc = view.provenance.vertexConflict;
  const out = new Int32Array(m.faceCount).fill(-1);
  for (let f = 0; f < m.faceCount; f++) {
    for (let k = 0; k < 3; k++) {
      const r = vc[m.faces[f * 3 + k]];
      if (r >= 0) {
        out[f] = r;
        break;
      }
    }
  }
  return out;
}

/**
 * Who shaped each merged face: an unresolved conflict region is 'conflict'; otherwise the face's
 * own origin (added by a side) or the sides that changed its corners (local moves, part motions).
 * A resolved region shows the side it was resolved to.
 */
export function mergeFaceKinds(view: IMergeView, conflictOf: Int32Array): MergeFaceKind[] {
  const m = view.merged;
  const p = view.provenance;
  const byId = new Map(view.conflicts.map((c) => [c.id, c]));
  const out: MergeFaceKind[] = new Array(m.faceCount);
  for (let f = 0; f < m.faceCount; f++) {
    const r = conflictOf[f];
    if (r >= 0 && byId.get(r)?.resolution == null) {
      out[f] = 'conflict';
      continue;
    }
    let bits = p.faceSource[f];
    if (bits === 0) bits = p.vertexChangedBy[m.faces[f * 3]] | p.vertexChangedBy[m.faces[f * 3 + 1]] | p.vertexChangedBy[m.faces[f * 3 + 2]];
    out[f] = bits === 3 ? 'both' : bits === 1 ? 'ours' : bits === 2 ? 'theirs' : 'unchanged';
  }
  return out;
}

export interface IMergeLayer {
  geometry: THREE.BufferGeometry;
  /** Draw triangle k = merged face faceMap[k] (changed faces first). */
  faceMap: Uint32Array;
  /** Triangles [0, changedFaces) are not 'unchanged'. */
  changedFaces: number;
}

/** Non-indexed triangle soup of the merged mesh, one flat colour per face, changed faces first. */
export function buildMergeLayer(mesh: IMesh, kinds: MergeFaceKind[], origin: THREE.Vector3): IMergeLayer {
  const changed: number[] = [];
  const unchanged: number[] = [];
  for (let f = 0; f < mesh.faceCount; f++) (kinds[f] === 'unchanged' ? unchanged : changed).push(f);
  const faceMap = new Uint32Array(mesh.faceCount);
  faceMap.set(changed, 0);
  faceMap.set(unchanged, changed.length);
  const n = faceMap.length;
  const pos = new Float32Array(n * 9);
  const col = new Float32Array(n * 9);
  const P = mesh.positions;
  for (let k = 0; k < n; k++) {
    const f = faceMap[k];
    const c = MERGE_LINEAR[kinds[f]];
    for (let j = 0; j < 3; j++) {
      const v = mesh.faces[f * 3 + j] * 3;
      const o = k * 9 + j * 3;
      pos[o] = P[v] - origin.x;
      pos[o + 1] = P[v + 1] - origin.y;
      pos[o + 2] = P[v + 2] - origin.z;
      col[o] = c[0];
      col[o + 1] = c[1];
      col[o + 2] = c[2];
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, faceMap, changedFaces: changed.length };
}

/** Triangle soup of some faces of `mesh`, each vertex mapped by `matrix` (null = as is). */
export function buildFaceSubset(mesh: IMesh, faces: ArrayLike<number>, matrix: THREE.Matrix4 | null, origin: THREE.Vector3): THREE.BufferGeometry {
  const pos = new Float32Array(faces.length * 9);
  const v = new THREE.Vector3();
  const P = mesh.positions;
  for (let k = 0; k < faces.length; k++) {
    const f = faces[k];
    for (let j = 0; j < 3; j++) {
      const i = mesh.faces[f * 3 + j] * 3;
      v.set(P[i], P[i + 1], P[i + 2]);
      if (matrix) v.applyMatrix4(matrix);
      const o = k * 9 + j * 3;
      pos[o] = v.x - origin.x;
      pos[o + 1] = v.y - origin.y;
      pos[o + 2] = v.z - origin.z;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Faces of `mesh` with at least one corner in `vertices`. */
export function facesTouching(mesh: IMesh, vertices: ArrayLike<number>): number[] {
  const mark = new Uint8Array(mesh.vertexCount);
  for (let i = 0; i < vertices.length; i++) mark[vertices[i]] = 1;
  const out: number[] = [];
  for (let f = 0; f < mesh.faceCount; f++) {
    if (mark[mesh.faces[f * 3]] || mark[mesh.faces[f * 3 + 1]] || mark[mesh.faces[f * 3 + 2]]) out.push(f);
  }
  return out;
}

/** Map a side's world coordinates into the merged frame: T_merged · T_side⁻¹ (base → x frames). */
export function sideToMerged(mergedFrame: Mat4, sideFrame: Mat4 | null): THREE.Matrix4 {
  const m = new THREE.Matrix4().fromArray(Array.from(mergedFrame));
  if (sideFrame) m.multiply(new THREE.Matrix4().fromArray(Array.from(sideFrame)).invert());
  return m;
}

export interface IGhostSpec {
  geometry: THREE.BufferGeometry;
  color: string;
  label: 'base' | 'ours' | 'theirs';
}

/** The three versions of one conflict region, in the merged frame. */
export function conflictGhosts(
  conflict: IMergeConflict,
  view: IMergeView,
  meshes: { base: IMesh; ours: IMesh; theirs: IMesh },
  origin: THREE.Vector3,
): IGhostSpec[] {
  const T = view.frame.transform.matrix;
  return [
    { label: 'base', color: MERGE_COLORS.unchanged, geometry: buildFaceSubset(meshes.base, conflict.baseFaces, sideToMerged(T, null), origin) },
    {
      label: 'ours',
      color: MERGE_COLORS.ours,
      geometry: buildFaceSubset(meshes.ours, facesTouching(meshes.ours, conflict.oursVertices), sideToMerged(T, view.ours.alignment.matrix), origin),
    },
    {
      label: 'theirs',
      color: MERGE_COLORS.theirs,
      geometry: buildFaceSubset(
        meshes.theirs,
        facesTouching(meshes.theirs, conflict.theirsVertices),
        sideToMerged(T, view.theirs.alignment.matrix),
        origin,
      ),
    },
  ];
}
