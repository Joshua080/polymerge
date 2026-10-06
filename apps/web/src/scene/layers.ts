/**
 * Pure builders turning an IMesh pair + IDiffResult into three.js geometry.
 * Everything is expressed in TARGET space, minus `origin` (a recentring offset that
 * keeps float32 vertex data precise for models far from the world origin).
 */
import * as THREE from 'three';
import {
  FaceStatus,
  VertexStatus,
  type IDiffResult,
  type IMesh,
  type FaceStatusCode,
  type Mat4,
} from 'polymerge-core';
import { diffColors, paletteName } from '../view-options.js';

export type RGB = [r: number, g: number, b: number];

/** An sRGB hex colour in three's linear working space (for vertex colours). */
export function linearColor(hex: string): RGB {
  const c = new THREE.Color().setStyle(hex);
  return [c.r, c.g, c.b];
}

type DiffLinear = Readonly<Record<'added' | 'removed' | 'modified' | 'unchanged', RGB>>;
const linearCache = new Map<string, DiffLinear>();

/** The current palette's diff colours, linear (view-options.ts). Read when a layer is built. */
export function diffLinear(): DiffLinear {
  const name = paletteName();
  let out = linearCache.get(name);
  if (!out) {
    const c = diffColors();
    out = { added: linearColor(c.added), removed: linearColor(c.removed), modified: linearColor(c.modified), unchanged: linearColor(c.unchanged) };
    linearCache.set(name, out);
  }
  return out;
}

/** Base / "old" accent used for the ghost and the tail of displacement vectors (not a status colour). */
export const BASE_ACCENT = '#93c5fd';

export function faceStatusColor(status: number, colors: DiffLinear = diffLinear()): RGB {
  switch (status as FaceStatusCode) {
    case FaceStatus.Added:
      return colors.added;
    case FaceStatus.Removed:
      return colors.removed;
    case FaceStatus.Modified:
      return colors.modified;
    default:
      return colors.unchanged;
  }
}

/** A triangle soup whose draw-order triangle k corresponds to mesh face `faceMap[k]`. */
export interface IFaceLayer {
  geometry: THREE.BufferGeometry;
  faceMap: Uint32Array;
  /** Triangles [0, changedFaces) are non-Unchanged; the rest are Unchanged. */
  changedFaces: number;
}

/** Apply a column-major matrix to every vertex of a mesh (base → target space). */
export function alignPositions(positions: Float64Array, matrix: Mat4 | null): Float64Array {
  if (!matrix) return positions;
  const m = matrix;
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

export function isIdentityMatrix(m: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) {
    const expected = i % 5 === 0 ? 1 : 0;
    if (Math.abs(m[i] - expected) > 1e-12) return false;
  }
  return true;
}

function finish(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Non-indexed, per-face coloured triangle soup of `mesh`. Faces are ordered changed-first
 * so that "hide unchanged faces" is just a draw range. With `status` null every face is
 * drawn in the neutral colour (single-mesh preview).
 */
export function buildFaceLayer(
  mesh: IMesh,
  positions: Float64Array,
  status: Uint8Array | null,
  origin: THREE.Vector3,
  pick?: (status: number) => boolean,
): IFaceLayer {
  const selected: number[] = [];
  const unchanged: number[] = [];
  for (let f = 0; f < mesh.faceCount; f++) {
    const s = status ? status[f] : FaceStatus.Unchanged;
    if (pick && !pick(s)) continue;
    (s === FaceStatus.Unchanged ? unchanged : selected).push(f);
  }
  const faceMap = new Uint32Array(selected.length + unchanged.length);
  faceMap.set(selected, 0);
  faceMap.set(unchanged, selected.length);

  const n = faceMap.length;
  const pos = new Float32Array(n * 9);
  const col = new Float32Array(n * 9);
  const faces = mesh.faces;
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;
  const colors = diffLinear();
  for (let k = 0; k < n; k++) {
    const f = faceMap[k];
    const c = faceStatusColor(status ? status[f] : FaceStatus.Unchanged, colors);
    for (let j = 0; j < 3; j++) {
      const v = faces[f * 3 + j] * 3;
      const o = k * 9 + j * 3;
      pos[o] = positions[v] - ox;
      pos[o + 1] = positions[v + 1] - oy;
      pos[o + 2] = positions[v + 2] - oz;
      col[o] = c[0];
      col[o + 1] = c[1];
      col[o + 2] = c[2];
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return { geometry: finish(geometry), faceMap, changedFaces: selected.length };
}

/** Indexed geometry of a whole mesh (used for the base ghost). Face k = mesh face k. */
export function buildIndexedGeometry(mesh: IMesh, positions: Float64Array, origin: THREE.Vector3): THREE.BufferGeometry {
  const pos = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    pos[i] = positions[i] - origin.x;
    pos[i + 1] = positions[i + 1] - origin.y;
    pos[i + 2] = positions[i + 2] - origin.z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const index = mesh.vertexCount > 65535 ? new Uint32Array(mesh.faces) : new Uint16Array(mesh.faces);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return finish(geometry);
}

export interface IMarkerLayer {
  geometry: THREE.BufferGeometry;
  counts: { moved: number; added: number; removed: number };
}

/** Points for Moved (yellow) + Added (green) target vertices and Removed (red) base vertices. */
export function buildMarkers(
  target: IMesh,
  alignedBase: Float64Array,
  result: IDiffResult,
  origin: THREE.Vector3,
): IMarkerLayer {
  const counts = { moved: 0, added: 0, removed: 0 };
  const tvs = result.targetVertexStatus;
  const bvs = result.baseVertexStatus;
  for (let i = 0; i < tvs.length; i++) {
    if (tvs[i] === VertexStatus.Moved) counts.moved++;
    else if (tvs[i] === VertexStatus.Added) counts.added++;
  }
  for (let i = 0; i < bvs.length; i++) if (bvs[i] === VertexStatus.Removed) counts.removed++;
  const n = counts.moved + counts.added + counts.removed;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let k = 0;
  const put = (src: Float64Array, v: number, c: RGB) => {
    pos[k * 3] = src[v * 3] - origin.x;
    pos[k * 3 + 1] = src[v * 3 + 1] - origin.y;
    pos[k * 3 + 2] = src[v * 3 + 2] - origin.z;
    col[k * 3] = c[0];
    col[k * 3 + 1] = c[1];
    col[k * 3 + 2] = c[2];
    k++;
  };
  const colors = diffLinear();
  for (let i = 0; i < tvs.length; i++) {
    if (tvs[i] === VertexStatus.Moved) put(target.positions, i, colors.modified);
    else if (tvs[i] === VertexStatus.Added) put(target.positions, i, colors.added);
  }
  for (let i = 0; i < bvs.length; i++) if (bvs[i] === VertexStatus.Removed) put(alignedBase, i, colors.removed);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return { geometry: finish(geometry), counts };
}

/**
 * Line segments aligned-base position → target position for every Moved target vertex
 * (via targetToBase). Tail = base accent, head = the "moved" yellow.
 */
export function buildDisplacementVectors(
  target: IMesh,
  alignedBase: Float64Array,
  result: IDiffResult,
  origin: THREE.Vector3,
): { geometry: THREE.BufferGeometry; count: number } {
  const tvs = result.targetVertexStatus;
  const t2b = result.targetToBase;
  let n = 0;
  for (let i = 0; i < tvs.length; i++) if (tvs[i] === VertexStatus.Moved && t2b[i] >= 0) n++;
  const pos = new Float32Array(n * 6);
  const col = new Float32Array(n * 6);
  const tail = linearColor(BASE_ACCENT);
  const head = diffLinear().modified;
  let k = 0;
  for (let i = 0; i < tvs.length; i++) {
    const b = t2b[i];
    if (tvs[i] !== VertexStatus.Moved || b < 0) continue;
    const o = k * 6;
    pos[o] = alignedBase[b * 3] - origin.x;
    pos[o + 1] = alignedBase[b * 3 + 1] - origin.y;
    pos[o + 2] = alignedBase[b * 3 + 2] - origin.z;
    pos[o + 3] = target.positions[i * 3] - origin.x;
    pos[o + 4] = target.positions[i * 3 + 1] - origin.y;
    pos[o + 5] = target.positions[i * 3 + 2] - origin.z;
    col.set(tail, o);
    col.set(head, o + 3);
    k++;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return { geometry: finish(geometry), count: n };
}

/** Bounds of a flat xyz array, as a Box3 (empty box for no vertices). */
export function boxOf(positions: ArrayLike<number>): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i + 2 < positions.length; i += 3) box.expandByPoint(v.set(positions[i], positions[i + 1], positions[i + 2]));
  return box;
}

/** Circle sprite (white disc with a dark rim) so marker colours read even on same-coloured faces. */
export function makeDotTexture(size = 64): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const r = size / 2;
  g.beginPath();
  g.arc(r, r, r - 1, 0, Math.PI * 2);
  g.fillStyle = '#0b0f17';
  g.fill();
  g.beginPath();
  g.arc(r, r, r * 0.74, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Ring sprite for the selection highlight. */
export function makeRingTexture(size = 64): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const r = size / 2;
  g.lineWidth = size * 0.2;
  g.strokeStyle = '#0b0f17';
  g.beginPath();
  g.arc(r, r, r * 0.72, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = size * 0.1;
  g.strokeStyle = '#ffffff';
  g.beginPath();
  g.arc(r, r, r * 0.72, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(r, r, r * 0.16, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
