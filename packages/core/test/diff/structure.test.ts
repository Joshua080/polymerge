/**
 * Structure matching (structure.ts): a piece whose triangles are unchanged is matched by them,
 * however far it moved or was reshaped — the case of a file re-ordered by another tool AND
 * edited, where position-based seeds are missing exactly where the edit is.
 */
import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../../src/diff/index.js';
import { assertInvariants, asymmetricSolid, combineMeshes, permuteMesh, randomPermutation, silent, transformMesh } from './util.js';

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe('structure matching', () => {
  it('a piece reshaped (not rigidly) and moved far, in a re-ordered file → moved, exact correspondence', () => {
    const a = asymmetricSolid(24, 12);
    const b = transformMesh(asymmetricSolid(16, 8), I3, [6, 0, 0]);
    const base = combineMeshes([a, b]);
    // Stretched along x, squashed along z, and carried 4 units away: no rigid motion explains it.
    const reshaped = transformMesh(b, [1.6, 0, 0, 0, 1, 0, 0, 0, 0.7], [-3, 4, 0]);
    const perm = randomPermutation(base.mesh.vertexCount, 31);
    const target = permuteMesh(combineMeshes([a, reshaped]).mesh, perm, 32);
    const r = diffMeshes(base.mesh, target, { logger: silent });
    assertInvariants(r, base.mesh, target);
    expect(r.stats.vertices).toEqual({ unchanged: a.vertexCount, moved: b.vertexCount, added: 0, removed: 0 });
    for (let k = 0; k < b.vertexCount; k++) expect(r.baseToTarget[base.offsets[1] + k]).toBe(perm[base.offsets[1] + k]);
    // Not a rigid part motion.
    expect(r.parts).toEqual([]);
  });
});
