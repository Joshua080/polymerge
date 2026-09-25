/**
 * Tier 3 — ICP rigid alignment + nearest-surface mapping.
 */
import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../../src/diff/index.js';
import { createMesh, transformPoint } from '../../src/mesh.js';
import { VertexStatus } from '../../src/types.js';
import {
  appendGeometry,
  assertInvariants,
  asymmetricSolid,
  axisAngle,
  cappedCylinder,
  captureLogger,
  cube,
  cylinder,
  grid,
  permuteMesh,
  randomPermutation,
  removeVertices,
  silent,
  transformMesh,
  uvSphere,
} from './util.js';

/** Expected column-major Mat4 for x ↦ R·x + t (R row-major). */
const mat4 = (R: number[], t: number[]): number[] => [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];

describe('Tier 3 · point cloud', () => {
  it('asymmetric solid rotated 30° + translated + permuted → Tier 3, exact transform, all unchanged', () => {
    const base = asymmetricSolid();
    const R = axisAngle([1, 2, 3], 30);
    const t = [5, -3, 2];
    const perm = randomPermutation(base.vertexCount, 11);
    const target = permuteMesh(transformMesh(base, R, t as [number, number, number]), perm, 12);
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.attempts.map((a) => [a.tier, a.accepted])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(r.tier).toBe(3);
    const expected = mat4(R, t);
    for (let k = 0; k < 16; k++) expect(r.alignment.matrix[k]).toBeCloseTo(expected[k], 9);
    expect(r.alignment.isIdentity).toBe(false);
    expect(r.alignment.rmsError).toBeLessThan(1e-9);
    expect(r.attempts[2].metrics.rotationDeg).toBeCloseTo(30, 6);
    expect(r.stats.vertices).toEqual({ unchanged: base.vertexCount, moved: 0, added: 0, removed: 0 });
    expect(r.stats.faces.unchanged).toBe(base.faceCount);
    // With identical sampling the nearest aligned vertex is the true correspondent.
    for (let i = 0; i < base.vertexCount; i++) {
      expect(r.baseToTarget[i]).toBe(perm[i]);
      expect(r.targetToBase[perm[i]]).toBe(i);
    }
  });

  it('recovers large rotations via PCA frames (150° about a skew axis)', () => {
    const base = asymmetricSolid(28, 14);
    const R = axisAngle([-0.4, 1, 0.7], 150);
    const target = permuteMesh(transformMesh(base, R, [-20, 4, 9]), randomPermutation(base.vertexCount, 17));
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.tier).toBe(3);
    const expected = mat4(R, [-20, 4, 9]);
    for (let k = 0; k < 16; k++) expect(r.alignment.matrix[k]).toBeCloseTo(expected[k], 8);
    expect(r.stats.vertices.unchanged).toBe(base.vertexCount);
  });

  it('tolerates removed and added geometry (trimmed ICP): transform still exact, counts right', () => {
    const base0 = asymmetricSolid(32, 16);
    // Base loses a cap (vertices of ring 1–2 and the north pole) in the target, and the
    // target gains a detached cube far from the solid.
    const drop = Array.from({ length: 1 + 2 * 32 }, (_, i) => i);
    const { mesh: capless } = removeVertices(base0, drop);
    const c = cube(0.6);
    const withCube = appendGeometry(
      capless,
      Array.from(c.positions).map((x, i) => x + [4, 0, 0][i % 3]),
      Array.from(c.faces).map((f) => f + capless.vertexCount),
    );
    const R = axisAngle([0, 1, 1], 30);
    const t: [number, number, number] = [1, 2, 3];
    const target = permuteMesh(transformMesh(withCube, R, t), randomPermutation(withCube.vertexCount, 3), 4);
    const r = diffMeshes(base0, target, { logger: silent });
    assertInvariants(r, base0, target);
    expect(r.tier).toBe(3);
    const expected = mat4(R, t);
    for (let k = 0; k < 16; k++) expect(r.alignment.matrix[k]).toBeCloseTo(expected[k], 8);
    expect(r.stats.vertices.added).toBe(8); // the cube
    // Removed: the dropped cap vertices that are farther than surfaceTolerance from the
    // remaining target surface; the pole and first ring certainly are.
    expect(r.stats.vertices.removed).toBeGreaterThanOrEqual(1 + 32);
    expect(r.stats.vertices.removed).toBeLessThanOrEqual(drop.length);
    expect(r.baseVertexStatus[0]).toBe(VertexStatus.Removed);
  });

  it('remeshed plane (10×10 vs 13×13 samples) → Tier 3, no added/removed, identity alignment', () => {
    const base = grid(10, 10, { spacing: 1 / 9 });
    const target = grid(13, 13, { spacing: 1 / 12, flip: true });
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(3);
    expect(r.stats.vertices.added).toBe(0);
    expect(r.stats.vertices.removed).toBe(0);
    expect(r.alignment.isIdentity).toBe(true);
    expect(r.alignment.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(r.stats.vertices.unchanged).toBe(target.vertexCount); // every sample lies on the plane
  });

  it('remeshed cylinder (48×10 vs 64×13, phase-shifted) → Tier 3, no added/removed, no rigid motion', () => {
    for (const phase of [0, 0.03]) {
      const base = cylinder(48, 10);
      const target = cylinder(64, 13, { phase });
      const r = diffMeshes(base, target, { logger: silent });
      assertInvariants(r, base, target);
      expect(r.tier).toBe(3);
      expect(r.stats.vertices.added).toBe(0);
      expect(r.stats.vertices.removed).toBe(0);
      expect(r.alignment.isIdentity).toBe(true);
      // Deviations are chordal (faceting) error only: ≤ sagitta of the 48-gon.
      expect(r.stats.maxDisplacement).toBeLessThanOrEqual(1 - Math.cos(Math.PI / 48) + 1e-9);
    }
  });

  it('capped cylinder 24 vs 32 segments: Tier 2 sees the retessellation and defers to Tier 3', () => {
    // Cap centres and the ring vertices at multiples of 45° coincide, and the cap fans give
    // those seeds face support, so Tier 2 CAN propagate a locally consistent matching —
    // the score must still reject it (slid matches + on-surface unmatched vertices).
    const base = cappedCylinder(24);
    const target = cappedCylinder(32);
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    const t2 = r.attempts[1];
    expect(t2.tier).toBe(2);
    expect(t2.accepted).toBe(false);
    expect(t2.metrics.seeds).toBe(18);
    expect(t2.metrics.slidMatches).toBeGreaterThan(0);
    expect(t2.metrics.onSurfaceUnmatched).toBeGreaterThan(0);
    expect(t2.score).toBeLessThan(0.4);
    expect(r.tier).toBe(3);
    expect(r.stats.vertices.added).toBe(0);
    expect(r.stats.vertices.removed).toBe(0);
    expect(r.alignment.isIdentity).toBe(true);
    expect(r.stats.maxDisplacement).toBeLessThanOrEqual(1 - Math.cos(Math.PI / 24) + 1e-9);
  });

  it('remeshed AND moved sphere-like solid: transform recovered to within the tessellation error', () => {
    const base = uvSphere(40, 20, (x, y, z) => [1.6 * x + 0.2 * y * y, y, 0.8 * z + 0.15 * x]);
    const fine = uvSphere(56, 27, (x, y, z) => [1.6 * x + 0.2 * y * y, y, 0.8 * z + 0.15 * x]);
    const R = axisAngle([1, -1, 2], 20);
    const t: [number, number, number] = [3, 3, -1];
    const target = transformMesh(fine, R, t);
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.tier).toBe(3);
    expect(r.stats.vertices.added + r.stats.vertices.removed).toBe(0);
    const m = r.alignment.matrix;
    // Compare the recovered and true images of a few probe points.
    for (const p of [[0, 0, 0], [1.6, 0, 0], [0, 1, 0], [0, 0, 0.8]] as [number, number, number][]) {
      const got = transformPoint(m, p);
      const want = transformPoint(mat4(R, t), p);
      expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeLessThan(0.01);
    }
  });

  it('warns when Tier 3 quality is poor (unrelated shapes)', () => {
    const base = asymmetricSolid();
    const target = createMesh(
      grid(20, 20, { spacing: 0.5 }).positions.map((v, i) => (i % 3 === 2 ? v + 30 : v)),
      grid(20, 20).faces,
    );
    const cap = captureLogger();
    const r = diffMeshes(base, target, { logger: cap.logger, forceTier: 3 });
    expect(r.tier).toBe(3);
    expect(r.attempts[0].score).toBeLessThan(0.6);
    expect(r.attempts[0].reason).toMatch(/quality poor/);
    expect(cap.warn.some((w) => /Tier 3 quality is poor/.test(w))).toBe(true);
  });
});
