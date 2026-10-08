/**
 * The nearest point of a mesh's surface to any point: what `polymerge measure` snaps to, like the
 * viewer's measuring tool snaps a click to the model.
 */
import { groupIndexOfFace } from './mesh.js';
import { TriangleBvh } from './diff/spatial.js';
import type { IMesh, Vec3 } from './types.js';

export interface ISurfacePoint {
  /** The nearest point on the surface. */
  point: Vec3;
  /** Its distance from the point asked about. */
  distance: number;
  /** The triangle it lies on, and that triangle's group (part). */
  face: number;
  group: number;
}

export class SurfaceLocator {
  private readonly bvh: TriangleBvh;
  constructor(private readonly mesh: IMesh) {
    this.bvh = new TriangleBvh(mesh.positions, mesh.faces);
  }

  /** Nearest surface point, or null for a mesh without faces. */
  nearest(p: Vec3): ISurfacePoint | null {
    const face = this.bvh.closest(p[0], p[1], p[2]);
    if (face < 0) return null;
    const q = this.bvh.lastPoint;
    return { point: [q[0], q[1], q[2]], distance: Math.sqrt(this.bvh.lastDist2), face, group: Math.max(0, groupIndexOfFace(this.mesh, face)) };
  }
}
