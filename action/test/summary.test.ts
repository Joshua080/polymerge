import { createMesh, diffMeshes } from 'polymerge-core';
import { describe, expect, it } from 'vitest';
import { hasLocalChanges, rotationDeg, summarizeDiff } from '../lib/summary.mjs';

const silent = { info() {}, warn() {} };

/** Two boxes (a plate and a small cube); the cube's corners can be moved. */
function scene(shift: [number, number, number] = [0, 0, 0], scale = 1) {
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, base: number) => ({
    p: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    f: [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5].map((v) => v + base),
  });
  const plate = box(-5, 0, -3, 5, 0.6, 3, 0);
  const cube = box(-3.6, 0.6, -0.6, -2.4, 1.8, 0.6, 8);
  const cubeP = cube.p.map((v, i) => v + shift[i % 3]);
  const p = [...plate.p, ...cubeP].map((v) => v * scale);
  return createMesh(p, [...plate.f, ...cube.f], { groups: [{ name: 'plate', faceStart: 0, faceCount: 12 }, { name: 'cube', faceStart: 12, faceCount: 12 }] });
}

describe('summarizeDiff', () => {
  it('reports a moved part with its name when the model has named groups', () => {
    const d = diffMeshes(scene(), scene([6, 0, 0]), { logger: silent });
    const s = summarizeDiff(d, { named: true });
    expect(s.tier).toBe(d.tier);
    expect(s.vertices).toMatchObject({ before: 16, after: 16, moved: 8, added: 0, removed: 0 });
    expect(s.faces).toMatchObject({ before: 24, after: 24, modified: 12 });
    expect(s.partsTotal).toBe(1);
    expect(s.parts[0].name).toBe('cube');
    expect(s.parts[0].distance).toBeCloseTo(6, 6);
    expect(s.transform).toBeNull();
    expect(hasLocalChanges(s)).toBe(true);
    expect(summarizeDiff(d).parts[0].name).toBeNull();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s); // plain JSON, no typed arrays
  });

  it('reports a unit change as a whole-model transform, not a local change', () => {
    const d = diffMeshes(scene(), scene([0, 0, 0], 25.4), { logger: silent });
    const s = summarizeDiff(d);
    expect(s.transform?.units).toEqual({ from: 'in', to: 'mm', factor: 25.4 });
    expect(s.transform?.rotationDeg).toBeCloseTo(0, 6);
    expect(hasLocalChanges(s)).toBe(false);
  });

  it('sees no change in an identical model', () => {
    expect(hasLocalChanges(summarizeDiff(diffMeshes(scene(), scene(), { logger: silent })))).toBe(false);
  });
});

describe('rotationDeg', () => {
  it('reads the angle of a scaled rotation', () => {
    const a = (40 * Math.PI) / 180;
    const k = 2;
    expect(rotationDeg([k * Math.cos(a), k * Math.sin(a), 0, 0, -k * Math.sin(a), k * Math.cos(a), 0, 0, 0, 0, k, 0, 0, 0, 0, 1], k)).toBeCloseTo(40, 9);
  });
});
