/** The section tool's drawing of a cut: filled outlines with their holes, and the outline lines. */
import { describe, expect, it } from 'vitest';
import { createMesh, sectionMesh, type IMesh, type Vec3 } from 'polymerge-core';
import { drawing } from '../src/tools.js';

/** A closed square tube along z: outer square ±o, inner square hole ±i, height h, centred at (cx, 0). */
function tube(o: number, i: number, h: number, cx = 0): { positions: number[]; faces: number[] } {
  const ring = (r: number, z: number): Vec3[] => [
    [cx - r, -r, z],
    [cx + r, -r, z],
    [cx + r, r, z],
    [cx - r, r, z],
  ];
  const positions = [...ring(o, 0), ...ring(o, h), ...ring(i, 0), ...ring(i, h)].flat();
  const faces: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => faces.push(a, b, c, a, c, d);
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    quad(k, k1, 4 + k1, 4 + k);
    quad(8 + k1, 8 + k, 12 + k, 12 + k1);
    quad(4 + k, 4 + k1, 12 + k1, 12 + k);
    quad(k1, k, 8 + k, 8 + k1);
  }
  return { positions, faces };
}

/** Sum of the triangles' areas. */
function fillArea(fill: Float32Array): number {
  let sum = 0;
  for (let t = 0; t < fill.length; t += 9) {
    const a = [fill[t + 3] - fill[t], fill[t + 4] - fill[t + 1], fill[t + 5] - fill[t + 2]];
    const b = [fill[t + 6] - fill[t], fill[t + 7] - fill[t + 1], fill[t + 8] - fill[t + 2]];
    sum += Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) / 2;
  }
  return sum;
}

describe('section drawing', () => {
  it('fills the material and leaves the hole open', () => {
    const t = tube(2, 1, 3);
    const s = sectionMesh(createMesh(t.positions, t.faces), 'z', 1.5);
    const d = drawing(s);
    expect(fillArea(d.fill)).toBeCloseTo(12); // 16 − 4
    // One segment per loop point: each square passes 4 corners and 4 wall diagonals.
    expect(d.lines.length / 6).toBe(s.loops.reduce((n, l) => n + l.points.length, 0));
    expect(d.lines.length / 6).toBe(16);
    for (let k = 2; k < d.fill.length; k += 3) expect(d.fill[k]).toBeCloseTo(1.5); // on the plane
  });

  it('gives each hole to the outline around it', () => {
    const a = tube(2, 1, 3);
    const b = tube(2, 1, 3, 10);
    const mesh: IMesh = createMesh([...a.positions, ...b.positions], [...a.faces, ...b.faces.map((v) => v + 16)]);
    const d = drawing(sectionMesh(mesh, 'z', 1));
    expect(fillArea(d.fill)).toBeCloseTo(24);
  });

  it('an open surface gives lines and no fill', () => {
    const sheet = createMesh([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
    const d = drawing(sectionMesh(sheet, 'x', 0.5));
    expect(d.fill.length).toBe(0);
    // An open line of n points has n − 1 segments (here across the sheet's two triangles).
    expect(d.lines.length / 6).toBe(2);
  });
});
