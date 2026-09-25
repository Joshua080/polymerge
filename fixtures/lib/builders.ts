/**
 * Deterministic geometry builders. Every coordinate is either dyadic (exact in
 * float32 by construction) or explicitly rounded with Math.fround, and every
 * face/vertex order is fixed, so the generated files are byte-stable.
 */
import type { Vec3 } from '../../packages/core/src/types.js';
import { MeshBuilder, type KMesh, assertClosedManifold } from './kmesh.js';
import { clean, f32 } from './math.js';

export interface GridOptions {
  /** Distance between neighbouring grid lines (default 1). */
  spacing?: number;
  /** Position of vertex (0,0) (default origin). */
  origin?: readonly number[];
  /** z offset for vertex (i, j) (default 0). Must be float32-exact. */
  height?: (i: number, j: number) => number;
  /** Key prefix (default "g:"). Keys are `${prefix}${i},${j}`. */
  prefix?: string;
}

export function gridKey(i: number, j: number, prefix = 'g:'): string {
  return `${prefix}${i},${j}`;
}

/**
 * nx × ny quads in the xy-plane, (nx+1)(ny+1) vertices, 2·nx·ny triangles.
 * Quads are emitted row-major (j outer, i inner); quad (i,j) with corners
 * v00=(i,j) v10=(i+1,j) v11=(i+1,j+1) v01=(i,j+1) becomes the two
 * counter-clockwise triangles (v00,v10,v11) and (v00,v11,v01) — i.e. every
 * quad is split along its v00–v11 diagonal. Vertex list is row-major too.
 */
export function grid(nx: number, ny: number, opts: GridOptions = {}): KMesh {
  const s = opts.spacing ?? 1;
  const o = opts.origin ?? [0, 0, 0];
  const h = opts.height ?? (() => 0);
  const prefix = opts.prefix ?? 'g:';
  const b = new MeshBuilder();
  const idx: number[][] = [];
  for (let j = 0; j <= ny; j++) {
    idx[j] = [];
    for (let i = 0; i <= nx; i++) {
      const p: Vec3 = [o[0] + i * s, o[1] + j * s, o[2] + h(i, j)];
      for (const c of p) if (f32(c) !== c) throw new Error(`grid: coordinate ${c} is not float32-exact`);
      idx[j][i] = b.vertex(gridKey(i, j, prefix), p);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v00 = idx[j][i];
      const v10 = idx[j][i + 1];
      const v11 = idx[j + 1][i + 1];
      const v01 = idx[j + 1][i];
      b.face(v00, v10, v11);
      b.face(v00, v11, v01);
    }
  }
  return b.build();
}

/** Face index of the first triangle of quad (i, j) in a grid built by `grid(nx, …)`. */
export function gridQuadFace(nx: number, i: number, j: number): number {
  return 2 * (j * nx + i);
}

export type Cell = [x: number, y: number, z: number];

export interface PolycubeOptions {
  /** Subdivisions per unit cell edge (default 1). */
  k?: number;
  /** World position of lattice point (0,0,0) (default origin). */
  origin?: readonly number[];
  /** Size of one cell along x, y, z (default 1,1,1). */
  unit?: readonly number[];
  /** Key prefix (default "c:"). Keys are `${prefix}${lx},${ly},${lz}` in 1/k lattice units. */
  prefix?: string;
}

/**
 * Closed surface of a union of unit cells ("polycube"). Every exposed cell face is
 * split into k×k sub-quads, each split into two triangles with outward winding.
 * Lattice point (lx,ly,lz) (in units of 1/k) sits at origin + (l/k)·unit, computed
 * from the integer lattice coordinate alone, so shared edges between neighbouring
 * faces get bit-identical coordinates.
 *
 * Emission order: cells in the given order, then directions +x −x +y −y +z −z,
 * then sub-quads (t outer, s inner).
 */
export function polycube(cells: readonly Cell[], opts: PolycubeOptions = {}): KMesh {
  const k = opts.k ?? 1;
  const origin = opts.origin ?? [0, 0, 0];
  const unit = opts.unit ?? [1, 1, 1];
  const prefix = opts.prefix ?? 'c:';
  const occupied = new Set(cells.map((c) => c.join(',')));
  if (occupied.size !== cells.length) throw new Error('polycube: duplicate cells');
  const b = new MeshBuilder();
  const lattice = (l: readonly number[]): number =>
    b.vertex(`${prefix}${l[0]},${l[1]},${l[2]}`, [
      origin[0] + (l[0] / k) * unit[0],
      origin[1] + (l[1] / k) * unit[1],
      origin[2] + (l[2] / k) * unit[2],
    ]);
  const dirs: Array<[axis: number, sign: 1 | -1]> = [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ];
  for (const cell of cells) {
    for (const [a, sign] of dirs) {
      const n = [...cell];
      n[a] += sign;
      if (occupied.has(n.join(','))) continue;
      const u = (a + 1) % 3;
      const v = (a + 2) % 3;
      for (let t = 0; t < k; t++) {
        for (let s = 0; s < k; s++) {
          const corner = (du: number, dv: number): number => {
            const l = [cell[0] * k, cell[1] * k, cell[2] * k];
            l[a] += sign > 0 ? k : 0;
            l[u] += s + du;
            l[v] += t + dv;
            return lattice(l);
          };
          const c00 = corner(0, 0);
          const c10 = corner(1, 0);
          const c11 = corner(1, 1);
          const c01 = corner(0, 1);
          // e_u × e_v = e_a for cyclic (a, u, v): CCW (c00,c10,c11) faces +a.
          if (sign > 0) {
            b.face(c00, c10, c11);
            b.face(c00, c11, c01);
          } else {
            b.face(c00, c11, c10);
            b.face(c00, c01, c11);
          }
        }
      }
    }
  }
  const mesh = b.build();
  assertClosedManifold(mesh, 'polycube');
  return mesh;
}

/** Axis-aligned box with corners min/max: 8 vertices, 12 triangles. Keys `${prefix}lx,ly,lz` with l ∈ {0,1}. */
export function box(min: readonly number[], max: readonly number[], prefix = 'c:'): KMesh {
  return polycube([[0, 0, 0]], { origin: min, unit: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], prefix });
}

/**
 * W×H×D box of unit cells whose faces are subdivided into (1/k)-sized quads,
 * centred on the origin (W, H, D even keeps the origin shift dyadic).
 */
export function subdividedBox(w: number, h: number, d: number, k: number, prefix = 'b:'): KMesh {
  const cells: Cell[] = [];
  for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push([x, y, z]);
  return polycube(cells, { k, origin: [-w / 2, -h / 2, -d / 2], prefix });
}

/**
 * The asymmetric test solid: an L-bracket (4×2×1 base plate + 1×2×2 upright
 * at x=0) with a notch cut out of the plate at cell (2,1,0) and a tab added at
 * cell (3,0,1). It has no mirror or rotational symmetry, so rigid registration
 * (PCA / ICP) has a unique answer. Shifted by (−2,−1,−1) so it straddles the
 * origin: x ∈ [−2,2], y ∈ [−1,1], z ∈ [−1,2]. Integer coordinates.
 */
export const L_BRACKET_CELLS: readonly Cell[] = [
  // base plate (y = 0 row, y = 1 row minus the notch at x = 2)
  [0, 0, 0],
  [1, 0, 0],
  [2, 0, 0],
  [3, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [3, 1, 0],
  // upright
  [0, 0, 1],
  [0, 1, 1],
  [0, 0, 2],
  [0, 1, 2],
  // tab
  [3, 0, 1],
];

export function lBracket(prefix = 'L:', k = 1): KMesh {
  return polycube(L_BRACKET_CELLS, { origin: [-2, -1, -1], prefix, k });
}

export interface CylinderOptions {
  radius?: number;
  z0?: number;
  z1?: number;
  prefix?: string;
}

/**
 * Closed n-gon prism: bottom ring b_k and top ring t_k at angle 2πk/n
 * (float32-rounded cos/sin), plus cap centres. Faces: for each k the side quad
 * as (b_k, b_k+1, t_k+1), (b_k, t_k+1, t_k); then the bottom fan
 * (cb, b_k+1, b_k); then the top fan (ct, t_k, t_k+1). 2n+2 vertices, 4n faces.
 */
export function cylinder(n: number, opts: CylinderOptions = {}): KMesh {
  const r = opts.radius ?? 1;
  const z0 = opts.z0 ?? -1;
  const z1 = opts.z1 ?? 1;
  const prefix = opts.prefix ?? 'cyl:';
  const b = new MeshBuilder();
  const ring = (k: number, top: boolean): number => {
    const kk = ((k % n) + n) % n;
    const theta = (2 * Math.PI * kk) / n;
    return b.vertex(`${prefix}${top ? 't' : 'b'}${kk}`, [clean(r * Math.cos(theta)), clean(r * Math.sin(theta)), top ? z1 : z0]);
  };
  for (let k = 0; k < n; k++) {
    ring(k, false);
    ring(k, true);
  }
  const cb = b.vertex(`${prefix}cb`, [0, 0, z0]);
  const ct = b.vertex(`${prefix}ct`, [0, 0, z1]);
  for (let k = 0; k < n; k++) {
    b.face(ring(k, false), ring(k + 1, false), ring(k + 1, true));
    b.face(ring(k, false), ring(k + 1, true), ring(k, true));
  }
  for (let k = 0; k < n; k++) b.face(cb, ring(k + 1, false), ring(k, false));
  for (let k = 0; k < n; k++) b.face(ct, ring(k, true), ring(k + 1, true));
  const mesh = b.build();
  assertClosedManifold(mesh, 'cylinder');
  return mesh;
}
