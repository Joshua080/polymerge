/**
 * CHANGE REGIONS — where a diff changed the model, as a short list: connected patches of changed
 * faces (target faces modified or added; base faces removed, shown where they were), each with
 * its size, centre and largest vertex move. It is what the colours of the viewer say, in words,
 * for a terminal report or a list to step through.
 */
import { groupIndexOfFace } from '../mesh.js';
import { FaceStatus, VertexStatus, type IDiffResult, type IMesh, type Vec3 } from '../types.js';

export interface IChangeRegion {
  /** 'target': changed faces of the new version; 'base': faces removed from the old one. */
  side: 'target' | 'base';
  /** Faces in the region, by status (target: modified + added; base: removed). */
  faces: number;
  modified: number;
  added: number;
  removed: number;
  /** Centre and size of the region's bounding box, in target space. */
  center: Vec3;
  size: Vec3;
  /** Largest move of a moved vertex in the region (0 when none moved). */
  maxDisplacement: number;
  /** Index of the group (part) of the region's first face, in its own mesh. */
  group: number;
}

class UnionFind {
  readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    while (this.parent[x] !== x) x = this.parent[x] = this.parent[this.parent[x]];
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

function regionsOf(
  mesh: IMesh,
  status: Uint8Array,
  changed: (s: number) => boolean,
  side: 'target' | 'base',
  toTarget: (p: Vec3) => Vec3,
  displacement: Float32Array | null,
  vertexStatus: Uint8Array | null,
): IChangeRegion[] {
  const f = mesh.faces;
  const uf = new UnionFind(mesh.faceCount);
  // Faces that share a vertex belong together: link each changed face to the first changed face
  // seen at each of its vertices.
  const firstAt = new Int32Array(mesh.vertexCount).fill(-1);
  for (let t = 0; t < mesh.faceCount; t++) {
    if (!changed(status[t])) continue;
    for (let c = 0; c < 3; c++) {
      const v = f[t * 3 + c];
      if (firstAt[v] < 0) firstAt[v] = t;
      else uf.union(t, firstAt[v]);
    }
  }
  const byRoot = new Map<number, IChangeRegion & { lo: Vec3; hi: Vec3 }>();
  for (let t = 0; t < mesh.faceCount; t++) {
    const s = status[t];
    if (!changed(s)) continue;
    const root = uf.find(t);
    let r = byRoot.get(root);
    if (!r) {
      r = {
        side,
        faces: 0,
        modified: 0,
        added: 0,
        removed: 0,
        center: [0, 0, 0],
        size: [0, 0, 0],
        maxDisplacement: 0,
        group: Math.max(0, groupIndexOfFace(mesh, t)),
        lo: [Infinity, Infinity, Infinity],
        hi: [-Infinity, -Infinity, -Infinity],
      };
      byRoot.set(root, r);
    }
    r.faces++;
    if (s === FaceStatus.Modified) r.modified++;
    else if (s === FaceStatus.Added) r.added++;
    else if (s === FaceStatus.Removed) r.removed++;
    for (let c = 0; c < 3; c++) {
      const v = f[t * 3 + c];
      const p = toTarget([mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]);
      for (let k = 0; k < 3; k++) {
        if (p[k] < r.lo[k]) r.lo[k] = p[k];
        if (p[k] > r.hi[k]) r.hi[k] = p[k];
      }
      if (displacement && vertexStatus && vertexStatus[v] === VertexStatus.Moved && displacement[v] > r.maxDisplacement) r.maxDisplacement = displacement[v];
    }
  }
  return [...byRoot.values()].map(({ lo, hi, ...r }) => ({
    ...r,
    center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] as Vec3,
    size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] as Vec3,
  }));
}

/**
 * The connected regions of change of a diff, largest first: changed target faces (modified or
 * added) and removed base faces (placed in target space through the alignment).
 */
export function changeRegions(result: IDiffResult, base: IMesh, target: IMesh): IChangeRegion[] {
  const m = result.alignment.matrix;
  const toTarget = result.alignment.isIdentity || m.length !== 16
    ? (p: Vec3): Vec3 => p
    : (p: Vec3): Vec3 => [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      ];
  const out = [
    ...regionsOf(target, result.targetFaceStatus, (s) => s === FaceStatus.Modified || s === FaceStatus.Added, 'target', (p) => p, result.displacement, result.targetVertexStatus),
    ...regionsOf(base, result.baseFaceStatus, (s) => s === FaceStatus.Removed, 'base', toTarget, null, null),
  ];
  return out.sort((a, b) => b.faces - a.faces || (a.side === b.side ? 0 : a.side === 'target' ? -1 : 1));
}
