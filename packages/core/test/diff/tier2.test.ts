/**
 * Tier 2 — topological (geometric + adjacency) matching on re-indexed meshes.
 */
import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../../src/diff/index.js';
import { createMesh } from '../../src/mesh.js';
import { VertexStatus, type IMesh } from '../../src/types.js';
import {
  appendGeometry,
  assertInvariants,
  asymmetricSolid,
  axisAngle,
  cube,
  grid,
  permuteMesh,
  randomPermutation,
  removeVertices,
  silent,
  transformMesh,
  withMoves,
} from './util.js';

describe('Tier 2 · topological', () => {
  it('vertex order permuted + one moved vertex → Tier 1 REJECTED, Tier 2 ACCEPTED with the exact inverse permutation', () => {
    const base = asymmetricSolid();
    const perm = randomPermutation(base.vertexCount, 21);
    const v = 123;
    const target = permuteMesh(withMoves(base, { [v]: [0.02, 0.03, -0.04] }), perm, 22);
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.attempts.map((a) => [a.tier, a.accepted])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(r.tier).toBe(2);
    for (let i = 0; i < base.vertexCount; i++) {
      expect(r.baseToTarget[i]).toBe(perm[i]);
      expect(r.targetToBase[perm[i]]).toBe(i);
    }
    expect(r.stats.vertices).toEqual({ unchanged: base.vertexCount - 1, moved: 1, added: 0, removed: 0 });
    expect(r.targetVertexStatus[perm[v]]).toBe(VertexStatus.Moved);
    expect(r.stats.faces.added + r.stats.faces.removed).toBe(0);
    expect(r.alignment.isIdentity).toBe(true);
  });

  describe('permuted + raised bump + removed patch + added patch', () => {
    // 30×30 unit grid. Bump: cone of radius 3 edges, peak raised by 2 edge lengths.
    // Removed patch: interior 4×4 vertex block (all incident faces deleted).
    // Added patch: a new row of 10 vertices welded below the bottom boundary (18 faces).
    const N = 30;
    const base = grid(N, N);
    const pos = Float64Array.from(base.positions);
    const bumpVertices: number[] = [];
    for (let v = 0; v < base.vertexCount; v++) {
      const r = Math.hypot(pos[v * 3] - 8, pos[v * 3 + 1] - 20);
      if (r < 3) {
        pos[v * 3 + 2] += 2 * (1 - r / 3);
        bumpVertices.push(v);
      }
    }
    const drop: number[] = [];
    for (let j = 5; j <= 8; j++) for (let i = 20; i <= 23; i++) drop.push(j * N + i);
    const { mesh: holed, map } = removeVertices(createMesh(pos, base.faces), drop);
    const n0 = holed.vertexCount;
    const addPos: number[] = [];
    const addFaces: number[] = [];
    for (let i = 0; i < 10; i++) addPos.push(i, -1, 0);
    for (let i = 0; i < 9; i++) addFaces.push(n0 + i, n0 + i + 1, map[i + 1], n0 + i, map[i + 1], map[i]);
    const edited = appendGeometry(holed, addPos, addFaces);
    const perm = randomPermutation(edited.vertexCount, 99);
    const target = permuteMesh(edited, perm, 42);
    const removedFaces = base.faceCount - holed.faceCount;

    it('lands on Tier 2 with exactly correct counts', () => {
      const r = diffMeshes(base, target, { logger: silent });
      assertInvariants(r, base, target);
      expect(r.tier).toBe(2);
      expect(bumpVertices.length).toBe(25);
      expect(r.stats.vertices).toEqual({
        unchanged: base.vertexCount - drop.length - bumpVertices.length,
        moved: bumpVertices.length,
        added: 10,
        removed: drop.length,
      });
      expect(r.stats.faces.removed).toBe(removedFaces);
      expect(r.stats.faces.added).toBe(addFaces.length / 3);
      expect(r.stats.maxDisplacement).toBeCloseTo(2, 12);
    });

    it('recovers every surviving vertex exactly, including the bump peak moved 2 edge lengths', () => {
      const r = diffMeshes(base, target, { logger: silent });
      for (let v = 0; v < base.vertexCount; v++) {
        const expected = map[v] >= 0 ? perm[map[v]] : -1;
        expect(r.baseToTarget[v]).toBe(expected);
      }
      const peak = 20 * N + 8;
      expect(r.targetVertexStatus[perm[map[peak]]]).toBe(VertexStatus.Moved);
      expect(r.displacement[perm[map[peak]]]).toBeCloseTo(2, 6);
      for (let i = 0; i < 10; i++) expect(r.targetToBase[perm[n0 + i]]).toBe(-1);
    });
  });

  it('handles multiple disconnected components (each with a moved vertex)', () => {
    const a = grid(8, 8);
    const b = transformMesh(grid(6, 5), axisAngle([1, 0, 0], 90), [20, 0, 0]);
    const c = transformMesh(cube(2), axisAngle([0, 0, 1], 0), [0, 20, 0]);
    const merged = mergeMeshes([a, b, c]);
    const moved = withMoves(merged, { 10: [0, 0, 0.2], [64 + 7]: [0.3, 0, 0], [64 + 30 + 2]: [0, 0.1, 0.1] });
    const perm = randomPermutation(merged.vertexCount, 5);
    const target = permuteMesh(moved, perm, 6);
    const r = diffMeshes(merged, target, { logger: silent });
    assertInvariants(r, merged, target);
    expect(r.tier).toBe(2);
    expect(r.stats.vertices.moved).toBe(3);
    for (let i = 0; i < merged.vertexCount; i++) expect(r.baseToTarget[i]).toBe(perm[i]);
  });

  it('resolves coincident duplicate vertices (unwelded seam) by topology, not by index', () => {
    // Two grids sharing the seam x = 5 without welding: 6 pairs of coincident vertices.
    const left = grid(6, 6);
    const right = transformMesh(grid(6, 6), axisAngle([0, 0, 1], 0), [5, 0, 0]);
    const merged = mergeMeshes([left, right]);
    const moved = withMoves(merged, { 14: [0, 0, 0.3] });
    for (const seed of [1, 2, 3, 4]) {
      const perm = randomPermutation(merged.vertexCount, seed);
      const target = permuteMesh(moved, perm, seed + 100);
      const r = diffMeshes(merged, target, { logger: silent });
      assertInvariants(r, merged, target);
      expect(r.tier).toBe(2);
      expect(r.attempts[1].metrics.ambiguousSeeds).toBe(6); // one per coincident pair reaches the check
      for (let i = 0; i < merged.vertexCount; i++) expect(r.baseToTarget[i]).toBe(perm[i]);
      expect(r.stats.faces.added + r.stats.faces.removed).toBe(0);
    }
  });

  it('fails cleanly when there are no seeds (whole model rigidly moved) so Tier 3 takes over', () => {
    const base = asymmetricSolid();
    const target = permuteMesh(transformMesh(base, axisAngle([0, 1, 0], 5), [0.5, 0, 0]), randomPermutation(base.vertexCount, 8));
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.attempts[1].tier).toBe(2);
    expect(r.attempts[1].accepted).toBe(false);
    expect(r.attempts[1].score).toBe(0);
    expect(r.attempts[1].reason).toMatch(/no seed pairs/);
    expect(r.tier).toBe(3);
  });

  it('leaves genuinely new geometry unmatched even when it touches matched vertices', () => {
    // A fan of new triangles attached along an existing boundary must be "added", not
    // matched to anything, even though it is adjacent to matched vertices.
    const base = grid(10, 10);
    const n = base.vertexCount;
    const target0 = appendGeometry(base, [0.5, -0.8, 0, 1.5, -0.8, 0], [n, 1, 0, n, n + 1, 1, n + 1, 2, 1]);
    const perm = randomPermutation(target0.vertexCount, 31);
    const target = permuteMesh(target0, perm, 32);
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.tier).toBe(2);
    expect(r.stats.vertices).toEqual({ unchanged: n, moved: 0, added: 2, removed: 0 });
    expect(r.stats.faces.added).toBe(3);
  });
});

/** Concatenate meshes (no welding). */
function mergeMeshes(meshes: IMesh[]): IMesh {
  const pos: number[] = [];
  const faces: number[] = [];
  let off = 0;
  for (const m of meshes) {
    pos.push(...m.positions);
    for (const f of m.faces) faces.push(f + off);
    off += m.vertexCount;
  }
  return createMesh(pos, faces);
}
