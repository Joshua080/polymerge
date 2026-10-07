import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../src/diff/index.js';
import { changeRegions } from '../src/diff/regions.js';
import { SurfaceLocator } from '../src/locate.js';
import { createMesh } from '../src/mesh.js';
import { sectionMesh } from '../src/section.js';
import type { IMesh, Vec3 } from '../src/types.js';
import { CUBE_CORNERS, CUBE_TRIS } from './parsers/helpers.js';

const silent = { info: () => {}, warn: () => {} };

/** A closed square tube along z: outer square ±o, inner square hole ±i, height h (outward faces). */
function tube(o: number, i: number, h: number): IMesh {
  const ring = (r: number, z: number): Vec3[] => [
    [-r, -r, z],
    [r, -r, z],
    [r, r, z],
    [-r, r, z],
  ];
  const pts = [...ring(o, 0), ...ring(o, h), ...ring(i, 0), ...ring(i, h)];
  const faces: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => faces.push(a, b, c, a, c, d);
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    quad(k, k1, 4 + k1, 4 + k); // outer wall, facing out
    quad(8 + k1, 8 + k, 12 + k, 12 + k1); // inner wall, facing the hole
    quad(4 + k, 4 + k1, 12 + k1, 12 + k); // top ring, facing +z
    quad(k1, k, 8 + k, 8 + k1); // bottom ring, facing −z
  }
  return createMesh(pts.flat(), faces);
}

/** A closed cylinder (n sides) of radius r around the z axis, height h. */
function cylinder(r: number, h: number, n = 48): IMesh {
  const pts: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    pts.push(r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(a), r * Math.sin(a), h);
  }
  pts.push(0, 0, 0, 0, 0, h);
  const faces: number[] = [];
  const c0 = 2 * n;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    faces.push(2 * k, 2 * k1, 2 * k1 + 1, 2 * k, 2 * k1 + 1, 2 * k + 1);
    faces.push(c0, 2 * k1, 2 * k, c0 + 1, 2 * k + 1, 2 * k1 + 1);
  }
  return createMesh(pts, faces);
}

describe('sectionMesh', () => {
  it('a cube cut halfway: one closed counter-clockwise square of area 1', () => {
    const s = sectionMesh(createMesh(CUBE_CORNERS.flat(), CUBE_TRIS.flat()), 'z', 0.5);
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0].closed).toBe(true);
    expect(s.loops[0].perimeter).toBeCloseTo(4);
    expect(s.loops[0].area).toBeCloseTo(1);
    expect(s.area).toBeCloseTo(1);
    expect([s.uAxis, s.vAxis]).toEqual(['x', 'y']);
    expect(s.loops[0].min).toEqual([0, 0]);
    expect(s.loops[0].max).toEqual([1, 1]);
  });

  it('a tube: the outline counts positive, the hole negative', () => {
    const s = sectionMesh(tube(2, 1, 3), 'z', 1.5);
    expect(s.loops.map((l) => Number(l.area.toFixed(9)))).toEqual([16, -4]);
    expect(s.area).toBeCloseTo(12);
    // Cut lengthwise through the middle: two separate walls of material.
    const across = sectionMesh(tube(2, 1, 3), 'x', 0);
    expect(across.loops.map((l) => Number(l.area.toFixed(9)))).toEqual([3, 3]);
    // …and off-centre, through the solid side: one strip.
    expect(sectionMesh(tube(2, 1, 3), 'x', 1.5).area).toBeCloseTo(12);
  });

  it('recognises a circle and gives its diameter', () => {
    const s = sectionMesh(cylinder(4, 10), 'z', 5);
    expect(s.loops).toHaveLength(1);
    // A 48-sided polygon: the cut runs through corners and chord midpoints, so ≈ 8, not exactly.
    expect(s.loops[0].circleDiameter).toBeCloseTo(8, 1);
    expect(s.loops[0].center.map((x) => Number(x.toFixed(9)))).toEqual([0, 0, 5]);
  });

  it('a cut along a row of vertices is one line, not a piece per triangle', () => {
    // A flat 4×4-quad grid in z = 0; x = 2 runs through a column of its vertices.
    const p: number[] = [];
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) p.push(i, j, 0);
    const f: number[] = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) f.push(j * 5 + i, j * 5 + i + 1, j * 5 + i + 6, j * 5 + i, j * 5 + i + 6, j * 5 + i + 5);
    const s = sectionMesh(createMesh(p, f), 'x', 2);
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0].closed).toBe(false);
    expect(s.loops[0].perimeter).toBeCloseTo(4);
    // A closed box with a ring of vertices half way up, cut exactly there: one closed square.
    const ring = (z: number) => [0, 0, z, 2, 0, z, 2, 2, z, 0, 2, z];
    const box: number[] = [0, 2, 1, 0, 3, 2, 8, 9, 10, 8, 10, 11];
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < 4; i++) {
        const i1 = (i + 1) % 4;
        box.push(k * 4 + i, k * 4 + i1, (k + 1) * 4 + i1, k * 4 + i, (k + 1) * 4 + i1, (k + 1) * 4 + i);
      }
    }
    const mid = sectionMesh(createMesh([...ring(0), ...ring(1), ...ring(2)], box), 'z', 1);
    expect(mid.loops.map((l) => [l.closed, Number(l.area.toFixed(9))])).toEqual([[true, 4]]);
  });

  it('an open sheet gives an open line; a plane that misses the model gives nothing', () => {
    const sheet = createMesh([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
    const s = sectionMesh(sheet, 'x', 0.5);
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0].closed).toBe(false);
    expect(s.loops[0].perimeter).toBeCloseTo(1);
    expect(sectionMesh(sheet, 'x', 5).loops).toEqual([]);
  });
});

describe('changeRegions', () => {
  /** Two separate unit cubes, the second at x = 3. */
  const twoCubes = (lift: number) => {
    const p = [...CUBE_CORNERS.flat(), ...CUBE_CORNERS.flatMap(([x, y, z]) => [x + 3, y, z])];
    p[2 * 3 + 2] += lift; // corner 2 of the first cube: z
    return createMesh(p, [...CUBE_TRIS.flat(), ...CUBE_TRIS.flat().map((v) => v + 8)]);
  };

  it('one region per connected patch of change, with its size and largest move', () => {
    const base = twoCubes(0);
    const target = twoCubes(0.5);
    const r = diffMeshes(base, target, { logger: silent });
    const regions = changeRegions(r, base, target);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ side: 'target', added: 0, removed: 0, maxDisplacement: 0.5 });
    expect(regions[0].faces).toBe(r.stats.faces.modified);
    expect(regions[0].center[0]).toBeLessThan(1.5); // on the first cube
  });

  it('removed faces form base regions, placed in target space', () => {
    const base = twoCubes(0);
    const target = createMesh(CUBE_CORNERS.flat(), CUBE_TRIS.flat()); // the second cube is gone
    const r = diffMeshes(base, target, { logger: silent, forceTier: 1 });
    const regions = changeRegions(r, base, target);
    expect(regions.map((x) => [x.side, x.removed])).toEqual([['base', 12]]);
    expect(regions[0].center).toEqual([3.5, 0.5, 0.5]);
  });
});

describe('SurfaceLocator', () => {
  it('snaps a point to the nearest point of the surface', () => {
    const loc = new SurfaceLocator(createMesh(CUBE_CORNERS.flat(), CUBE_TRIS.flat()));
    const hit = loc.nearest([0.5, 0.5, 3])!;
    expect(hit.point).toEqual([0.5, 0.5, 1]);
    expect(hit.distance).toBeCloseTo(2);
  });
});
