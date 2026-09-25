/**
 * Tier 1 — direct lineage (index / ID). Acceptance on identical topology (any moves),
 * appended / truncated streams; rejection on re-indexed and unrelated meshes; orphan rule.
 */
import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../../src/diff/index.js';
import { createMesh } from '../../src/mesh.js';
import { FaceStatus, VertexStatus } from '../../src/types.js';
import {
  appendGeometry,
  assertInvariants,
  asymmetricSolid,
  axisAngle,
  cube,
  grid,
  permuteMesh,
  randomPermutation,
  silent,
  transformMesh,
  withMoves,
} from './util.js';

const incidentFaces = (faces: Uint32Array, v: number): Set<number> => {
  const s = new Set<number>();
  for (let f = 0; f < faces.length / 3; f++) if (faces[f * 3] === v || faces[f * 3 + 1] === v || faces[f * 3 + 2] === v) s.add(f);
  return s;
};

describe('Tier 1 · index/ID', () => {
  it('identical meshes → Tier 1, everything unchanged, identity alignment', () => {
    const m = asymmetricSolid();
    const r = diffMeshes(m, m, { logger: silent });
    assertInvariants(r, m, m);
    expect(r.tier).toBe(1);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0].score).toBe(1);
    expect(r.stats.vertices).toEqual({ unchanged: m.vertexCount, moved: 0, added: 0, removed: 0 });
    expect(r.stats.faces).toEqual({ unchanged: m.faceCount, modified: 0, added: 0, removed: 0 });
    expect(r.alignment.isIdentity).toBe(true);
    expect(Array.from(r.baseToTarget)).toEqual(Array.from({ length: m.vertexCount }, (_, i) => i));
  });

  it('one vertex moved → Tier 1, moved = 1, modified faces = exactly its incident faces', () => {
    const base = grid(12, 9);
    const v = 40;
    const target = withMoves(base, { [v]: [0.1, -0.2, 0.3] });
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(1);
    expect(r.stats.vertices).toEqual({ unchanged: base.vertexCount - 1, moved: 1, added: 0, removed: 0 });
    expect(r.targetVertexStatus[v]).toBe(VertexStatus.Moved);
    expect(r.displacement[v]).toBeCloseTo(Math.hypot(0.1, 0.2, 0.3), 6);
    expect(r.stats.maxDisplacement).toBeCloseTo(Math.hypot(0.1, 0.2, 0.3), 12);
    const inc = incidentFaces(base.faces, v);
    expect(inc.size).toBe(6);
    expect(r.stats.faces.modified).toBe(inc.size);
    for (let f = 0; f < base.faceCount; f++) {
      const expected = inc.has(f) ? FaceStatus.Modified : FaceStatus.Unchanged;
      expect(r.targetFaceStatus[f]).toBe(expected);
      expect(r.baseFaceStatus[f]).toBe(expected);
    }
  });

  it('large moves with identical topology (noise of ~diagonal size + 90° turn) → still Tier 1', () => {
    const base = asymmetricSolid();
    const rng = randomPermutation(base.vertexCount, 5); // reuse as a cheap deterministic source
    const moves: Record<number, [number, number, number]> = {};
    for (let i = 0; i < base.vertexCount; i++) moves[i] = [(rng[i] % 7) - 3, (rng[i] % 5) - 2, (rng[i] % 3) - 1];
    const target = transformMesh(withMoves(base, moves), axisAngle([0, 0, 1], 90), [10, 0, 0]);
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(1);
    expect(r.stats.vertices.moved).toBe(base.vertexCount);
    expect(r.stats.faces.modified).toBe(base.faceCount);
    expect(r.stats.vertices.added + r.stats.vertices.removed).toBe(0);
  });

  it('geometry appended at the end → Tier 1 with exact added counts', () => {
    const base = grid(10, 10);
    const nb = base.vertexCount;
    // A flap welded onto existing boundary vertices (2 new vertices) + a detached cube (8).
    const c = cube(0.5);
    const cubePos = Array.from(c.positions).map((x, i) => x + (i % 3 === 2 ? 5 : 0));
    const cubeFaces = Array.from(c.faces).map((i) => i + nb + 2);
    const target = appendGeometry(
      base,
      [0, -1, 0, 1, -1, 0, ...cubePos],
      [nb, nb + 1, 1, nb, 1, 0, ...cubeFaces],
    );
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(1);
    expect(r.attempts[0].score).toBe(1);
    expect(r.stats.vertices).toEqual({ unchanged: nb, moved: 0, added: 10, removed: 0 });
    expect(r.stats.faces).toEqual({ unchanged: base.faceCount, modified: 0, added: 14, removed: 0 });
  });

  it('faces (and their vertices) removed at the end → Tier 1 with exact removed counts', () => {
    const nx = 8;
    const base = grid(nx, 8);
    // Drop the last row of quads: its top-row vertices (the last nx) disappear.
    const keepFaces = base.faces.slice(0, base.faces.length - 6 * (nx - 1));
    const target = createMesh(base.positions.slice(0, (base.vertexCount - nx) * 3), keepFaces);
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(1);
    expect(r.stats.vertices).toEqual({ unchanged: base.vertexCount - nx, moved: 0, added: 0, removed: nx });
    expect(r.stats.faces).toEqual({ unchanged: target.faceCount, modified: 0, added: 0, removed: 2 * (nx - 1) });
  });

  it('re-indexed (shuffled) mesh → Tier 1 REJECTED', () => {
    const base = asymmetricSolid();
    const target = permuteMesh(base, randomPermutation(base.vertexCount, 3), 4);
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.attempts[0].tier).toBe(1);
    expect(r.attempts[0].accepted).toBe(false);
    expect(r.attempts[0].score).toBeLessThan(0.05);
    expect(r.tier).not.toBe(1);
  });

  it('unrelated meshes with coincidentally equal counts → Tier 1 REJECTED', () => {
    const base = grid(12, 12);
    const other = permuteMesh(grid(12, 12, { height: (x, y) => Math.sin(x) * Math.cos(y) * 3 + 20 }), randomPermutation(144, 77), 78);
    expect(other.vertexCount).toBe(base.vertexCount);
    expect(other.faceCount).toBe(base.faceCount);
    const r = diffMeshes(base, other, { logger: silent });
    expect(r.attempts[0].accepted).toBe(false);
    expect(r.attempts[0].score).toBeLessThan(0.05);
  });

  it('orphan rule: matched pairs whose incident faces are all unpreserved are un-matched', () => {
    // Swap the indices of two distant vertices: index mode then pairs geometrically unrelated
    // vertices whose every incident face fails the face check → removed + added.
    const base = grid(12, 12);
    const p = 30;
    const q = 100;
    const perm = Array.from({ length: base.vertexCount }, (_, i) => (i === p ? q : i === q ? p : i));
    const target = permuteMesh(base, perm);
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(1);
    expect(r.attempts[0].metrics.orphanedPairs).toBe(2);
    expect(r.baseToTarget[p]).toBe(-1);
    expect(r.baseToTarget[q]).toBe(-1);
    expect(r.stats.vertices).toEqual({ unchanged: base.vertexCount - 2, moved: 0, added: 2, removed: 2 });
    const touched = new Set([...incidentFaces(base.faces, p), ...incidentFaces(base.faces, q)]);
    expect(r.stats.faces.removed).toBe(touched.size);
    expect(r.stats.faces.added).toBe(touched.size);
  });

  it('ID mode: stable vertex ids survive re-indexing (exact mapping, one move detected)', () => {
    const base0 = asymmetricSolid(20, 10);
    const ids = Array.from({ length: base0.vertexCount }, (_, i) => `v${i}`);
    const base = createMesh(base0.positions, base0.faces, { vertexIds: ids });
    const perm = randomPermutation(base.vertexCount, 9);
    const moved = withMoves(base0, { 7: [0, 0, 0.05] });
    const shuffled = permuteMesh(moved, perm, 10);
    const tIds: string[] = [];
    for (let i = 0; i < base.vertexCount; i++) tIds[perm[i]] = ids[i];
    const target = createMesh(shuffled.positions, shuffled.faces, { vertexIds: tIds });
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(1);
    expect(r.attempts[0].metrics.idMode).toBe(1);
    for (let i = 0; i < base.vertexCount; i++) expect(r.baseToTarget[i]).toBe(perm[i]);
    expect(r.stats.vertices.moved).toBe(1);
    expect(r.targetVertexStatus[perm[7]]).toBe(VertexStatus.Moved);
  });

  it('ID mode ignores duplicate ids and falls back to index mode when ids are useless', () => {
    const base0 = grid(6, 6);
    const dupIds = Array.from({ length: 36 }, (_, i) => (i < 4 ? 'dup' : `v${i}`));
    const a = createMesh(base0.positions, base0.faces, { vertexIds: dupIds });
    const r = diffMeshes(a, a, { logger: silent });
    // The duplicated ids cannot be matched by id; index mode explains everything instead.
    expect(r.tier).toBe(1);
    expect(r.attempts[0].metrics.idMode).toBe(0);
    expect(r.stats.vertices.unchanged).toBe(36);
    const junk = createMesh(base0.positions, base0.faces, { vertexIds: Array.from({ length: 36 }, (_, i) => `x${(i * 7) % 36}`) });
    const r2 = diffMeshes(a, junk, { logger: silent });
    expect(r2.tier).toBe(1);
    expect(r2.attempts[0].metrics.idMode).toBe(0);
    expect(r2.attempts[0].reason).toMatch(/ID mode scored only/);
  });
});
