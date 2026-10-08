import { describe, expect, it } from 'vitest';
import { createMesh } from '../src/mesh.js';
import { compareMetrics, computeMetrics, displayUnit, formatChange, formatMeasure, formatNumber, volumeNote } from '../src/metrics.js';
import { diffMeshes } from '../src/diff/index.js';
import type { SourceFormat } from '../src/types.js';
import { CUBE_CORNERS, CUBE_TRIS } from './parsers/helpers.js';

const silent = { info: () => {}, warn: () => {} };

/** Axis-aligned box [0, sx] × [0, sy] × [0, sz] with outward faces, moved by `at`. */
function box(sx: number, sy: number, sz: number, at: [number, number, number] = [0, 0, 0], format: SourceFormat = 'stl') {
  const pos = CUBE_CORNERS.flatMap(([x, y, z]) => [x * sx + at[0], y * sy + at[1], z * sz + at[2]]);
  return createMesh(pos, CUBE_TRIS.flat(), { metadata: { format } });
}

describe('computeMetrics', () => {
  it('a closed box: size, area, volume, centroid, one part', () => {
    const m = computeMetrics(box(2, 3, 4, [10, 0, -5]));
    expect(m).toMatchObject({ vertices: 8, faces: 12, parts: 1, size: [2, 3, 4], closed: true, openEdges: 0, nonManifoldEdges: 0, flippedEdges: 0, insideOut: false });
    expect(m.surfaceArea).toBeCloseTo(2 * (6 + 8 + 12));
    expect(m.volume).toBeCloseTo(24);
    expect(m.centroid.map((v) => Number(v.toFixed(9)))).toEqual([11, 1.5, -3]);
    expect(m.unit).toBeUndefined();
    expect(volumeNote(m)).toBeNull();
  });

  it('faces pointing inwards: the same volume, flagged', () => {
    const b = box(1, 1, 1);
    const flipped = createMesh(b.positions, Array.from(b.faces).map((_, i, f) => f[i - (i % 3) + [0, 2, 1][i % 3]]));
    const m = computeMetrics(flipped);
    expect(m.volume).toBeCloseTo(1);
    expect(m.insideOut).toBe(true);
    expect(volumeNote(m)).toBe('faces point inwards');
  });

  it('an open surface (one face missing) has no volume and says why', () => {
    const b = box(1, 1, 1);
    const open = createMesh(b.positions, Array.from(b.faces).slice(3));
    const m = computeMetrics(open);
    expect(m).toMatchObject({ closed: false, volume: null, openEdges: 3, faces: 11 });
    expect(volumeNote(m)).toBe('not closed: 3 open edges');
  });

  it('one flipped face: closed but no volume', () => {
    const f = Array.from(box(1, 1, 1).faces);
    [f[1], f[2]] = [f[2], f[1]];
    const m = computeMetrics(createMesh(box(1, 1, 1).positions, f));
    expect(m.closed).toBe(true);
    expect(m.flippedEdges).toBe(3);
    expect(m.volume).toBeNull();
    expect(volumeNote(m)).toBe('not closed: 3 edges between flipped faces');
  });

  it('non-manifold edges and several parts', () => {
    // Two boxes far apart: two parts, volumes add up.
    const a = box(1, 1, 1);
    const b = box(2, 1, 1, [5, 0, 0]);
    const two = createMesh([...a.positions, ...b.positions], [...a.faces, ...Array.from(b.faces, (x) => x + 8)]);
    const m = computeMetrics(two);
    expect(m.parts).toBe(2);
    expect(m.volume).toBeCloseTo(3);
    // A fin sharing one edge of the box: that edge has three faces.
    const fin = createMesh([...a.positions, 0.5, -1, 0], [...a.faces, 0, 2, 8]);
    // Corner 0 is (0,0,0), corner 1 is (1,0,0): a triangle on the edge 0–1 (welded indices).
    const finMetrics = computeMetrics(createMesh([...a.positions, 0.5, -1, 0], [...a.faces, 0, 1, 8]));
    expect(finMetrics.nonManifoldEdges + finMetrics.openEdges).toBeGreaterThan(0);
    expect(finMetrics.closed).toBe(false);
    expect(computeMetrics(fin).closed).toBe(false);
  });

  it('states mm for STEP and 3MF, m for glTF, nothing for STL / OBJ / PLY', () => {
    expect(computeMetrics(box(1, 1, 1, [0, 0, 0], 'step')).unit).toBe('mm');
    expect(computeMetrics(box(1, 1, 1, [0, 0, 0], '3mf')).unit).toBe('mm');
    expect(computeMetrics(box(1, 1, 1, [0, 0, 0], 'glb')).unit).toBe('m');
    expect(computeMetrics(box(1, 1, 1, [0, 0, 0], 'ply')).unit).toBeUndefined();
  });

  it('is fast enough for big meshes (a 200k-triangle grid in well under a second)', () => {
    const n = 317; // 316² × 2 ≈ 200k triangles
    const pos: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pos.push(i, j, Math.sin(i / 7) * Math.cos(j / 9));
    const faces: number[] = [];
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        faces.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
      }
    const mesh = createMesh(pos, faces);
    const t0 = performance.now();
    const m = computeMetrics(mesh);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(m.openEdges).toBe(4 * (n - 1));
    expect(m.closed).toBe(false);
  });
});

describe('compareMetrics and formatting', () => {
  it('reports the change of volume, area and size', () => {
    const c = compareMetrics(computeMetrics(box(10, 10, 10, [0, 0, 0], 'step')), computeMetrics(box(10, 10, 12, [0, 0, 0], 'step')));
    expect(c.volume).toMatchObject({ base: 1000, target: 1200, delta: 200 });
    expect(c.volume!.percent).toBeCloseTo(20);
    expect(c.size[2].delta).toBeCloseTo(2);
    expect(c.size[0].delta).toBe(0);
    expect(displayUnit(c)).toBe('mm');
    expect(formatChange(c.volume!, 3, 'mm')).toBe('+0.2 cm³ (+20%)');
    expect(formatChange(c.size[0], 1, 'mm')).toBe('no change');
  });

  it('no volume change when either side is open; units that disagree are flagged', () => {
    const b = box(1, 1, 1);
    const open = createMesh(b.positions, Array.from(b.faces).slice(3));
    expect(compareMetrics(computeMetrics(b), computeMetrics(open)).volume).toBeNull();
    const c = compareMetrics(computeMetrics(box(1, 1, 1, [0, 0, 0], '3mf')), computeMetrics(box(1, 1, 1, [0, 0, 0], 'glb')));
    expect(c.unitsDiffer).toBe(true);
    expect(displayUnit(c)).toBeUndefined();
    expect(displayUnit(compareMetrics(computeMetrics(box(1, 1, 1)), computeMetrics(box(1, 1, 1, [0, 0, 0], '3mf'))))).toBe('mm');
  });

  it('formatMeasure picks mm, cm or m by size; bare numbers without a unit', () => {
    expect(formatMeasure(12.5, 1, 'mm')).toBe('12.5 mm');
    expect(formatMeasure(25000, 1, 'mm')).toBe('25 m');
    expect(formatMeasure(0.1, 1, 'm')).toBe('100 mm');
    expect(formatMeasure(500, 2, 'mm')).toBe('500 mm²');
    expect(formatMeasure(6000, 2, 'mm')).toBe('60 cm²');
    expect(formatMeasure(800, 3, 'mm')).toBe('800 mm³');
    expect(formatMeasure(52345.6, 3, 'mm')).toBe('52.35 cm³');
    expect(formatMeasure(0.002, 3, 'm')).toBe('2000 cm³');
    expect(formatMeasure(3, 3, 'm')).toBe('3 m³');
    expect(formatMeasure(52345.6, 3, undefined)).toBe('52346');
  });

  it('formatNumber: four significant figures, no trailing zeros', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(1.5)).toBe('1.5');
    expect(formatNumber(12.3456)).toBe('12.35');
    expect(formatNumber(1234.5)).toBe('1235');
    expect(formatNumber(0.00012)).toBe('1.20e-4');
    expect(formatNumber(-2.5)).toBe('-2.5');
  });

  it('diffMeshes carries the comparison (and can skip it)', () => {
    const r = diffMeshes(box(1, 1, 1), box(1, 1, 2), { logger: silent });
    expect(r.metrics?.volume?.delta).toBeCloseTo(1);
    expect(diffMeshes(box(1, 1, 1), box(1, 1, 2), { logger: silent, metrics: false }).metrics).toBeUndefined();
  });
});
