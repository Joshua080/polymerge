/**
 * Merge performance at ~100k vertices, including the combined-edit (collision) check, which
 * examines every face pair near geometry that differs from both sides. Runs in the perf pass
 * (vitest.perf.config.ts), alone, so the bound measures the merge rather than the scheduler.
 */
import { describe, expect, it } from 'vitest';
import { mergeMeshes } from '../../src/merge/index.js';
import { createMesh } from '../../src/mesh.js';
import { grid, silent, withMoves } from '../diff/util.js';

describe('merge performance (~100k vertices)', () => {
  it('a moved 50k-vertex part (ours) + 3000 local edits on it (theirs) merges cleanly within seconds', () => {
    const g = grid(250, 200, { height: (x, y) => Math.sin(x / 9) * Math.cos(y / 7) });
    const nG = g.vertexCount;
    // Two copies of the wavy sheet, 5 units apart: two parts.
    const pos = new Float64Array(g.positions.length * 2);
    pos.set(g.positions);
    pos.set(g.positions.map((x, i) => (i % 3 === 2 ? x + 5 : x)), g.positions.length);
    const faces = new Uint32Array(g.faces.length * 2);
    faces.set(g.faces);
    faces.set(g.faces.map((f) => f + nG), g.faces.length);
    const base = createMesh(pos, faces);
    const partMove: Record<number, [number, number, number]> = {};
    for (let v = nG; v < 2 * nG; v++) partMove[v] = [3, 2, 0.5];
    let seed = 7;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const local: Record<number, [number, number, number]> = {};
    // Every edit well above the move threshold (±0.05..0.25).
    for (let k = 0; k < 3000; k++) local[nG + Math.floor(rand() * nG)] = [0, 0, (rand() < 0.5 ? -1 : 1) * (0.05 + 0.2 * rand())];
    const t0 = performance.now();
    const r = mergeMeshes(base, withMoves(base, partMove), withMoves(base, local), { logger: silent });
    const ms = performance.now() - t0;
    console.info(`[perf] merge ${base.vertexCount} vertices / ${base.faceCount} faces (collision check on): ${ms.toFixed(0)} ms`);
    expect(r.clean).toBe(true);
    expect(r.stats.partMotionsFromOurs).toBe(1);
    expect(r.stats.movedFromTheirs).toBe(Object.keys(local).length);
    expect(ms).toBeLessThan(15_000);
  });
});
