/**
 * Performance smoke test on ~100k-vertex meshes (317 × 317 = 100 489 vertices, 199 712
 * triangles) for each tier. Bounds are deliberately generous (CI machines vary); typical
 * timings on a laptop-class CPU are ~0.15 s (Tier 1), ~0.6 s (Tier 1 → 2) and ~1.7 s
 * (Tier 1 → 2 → 3).
 */
import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../../src/diff/index.js';
import { axisAngle, grid, permuteMesh, randomPermutation, silent, transformMesh, withMoves } from './util.js';

const N = 317;
const height = (x: number, y: number): number => 3 * Math.sin(x / 23) * Math.cos(y / 31) + 0.002 * x * y;
const base = grid(N, N, { height });
const moved = withMoves(base, { 5000: [0, 0, 0.5] });

function timed<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
}

describe('performance (~100k vertices)', () => {
  it('Tier 1 resolves in well under a second', () => {
    expect(base.vertexCount).toBeGreaterThanOrEqual(100_000);
    const [r, ms] = timed(() => diffMeshes(base, moved, { logger: silent }));
    expect(r.tier).toBe(1);
    expect(r.stats.vertices.moved).toBe(1);
    expect(ms).toBeLessThan(1000);
  });

  it('Tier 2 (fully re-indexed + shuffled faces) resolves within a few seconds', () => {
    const perm = randomPermutation(base.vertexCount, 1);
    const target = permuteMesh(moved, perm, 2);
    const [r, ms] = timed(() => diffMeshes(base, target, { logger: silent }));
    expect(r.tier).toBe(2);
    expect(r.stats.vertices.moved).toBe(1);
    expect(r.baseToTarget[5000]).toBe(perm[5000]);
    expect(ms).toBeLessThan(6000);
  });

  it('Tier 3 (rigidly moved + re-indexed) resolves within a few seconds', () => {
    const R = axisAngle([0.3, 1, 0.2], 25);
    const target = permuteMesh(transformMesh(base, R, [40, -10, 5]), randomPermutation(base.vertexCount, 3));
    const [r, ms] = timed(() => diffMeshes(base, target, { logger: silent }));
    expect(r.tier).toBe(3);
    expect(r.stats.vertices.unchanged).toBe(base.vertexCount);
    expect(r.attempts[2].metrics.rotationDeg).toBeCloseTo(25, 6);
    expect(ms).toBeLessThan(15000);
  });
});
