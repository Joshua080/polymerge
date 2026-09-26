/**
 * Uniform scale — the same model exported in different units (inches ↔ millimetres, metres,
 * centimetres, feet) or uniformly resized must be aligned with a SIMILARITY transform and
 * the unit conversion reported, instead of collapsing into "everything added/removed".
 *
 * Regression suite for the session-1 limitation "Tier 3 is rigid only: no scale (mm↔inch)".
 * Every scenario below failed on the session-1 engine.
 */
import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../../src/diff/index.js';
import { transformPoint } from '../../src/mesh.js';
import type { Vec3 } from '../../src/types.js';
import { VertexStatus } from '../../src/types.js';
import {
  assertInvariants,
  asymmetricSolid,
  axisAngle,
  captureLogger,
  cylinder,
  permuteMesh,
  randomPermutation,
  scaled,
  silent,
  transformMesh,
  withMoves,
} from './util.js';

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Column-major Mat4 of x ↦ M·x + t (M row-major, may include scale). */
const mat4 = (M: number[], t: number[]): number[] => [M[0], M[3], M[6], 0, M[1], M[4], M[7], 0, M[2], M[5], M[8], 0, t[0], t[1], t[2], 1];

function expectMatrixClose(actual: number[], expected: number[], relTol: number): void {
  const scale = Math.max(...expected.map(Math.abs));
  for (let k = 0; k < 16; k++) expect(Math.abs(actual[k] - expected[k])).toBeLessThanOrEqual(relTol * scale);
}

describe('uniform scale / unit conversion', () => {
  it('inches → millimetres (×25.4) + rotation + shuffled order → Tier 3, scale snapped to 25.4, all unchanged', () => {
    const base = asymmetricSolid();
    const R = axisAngle([1, 2, 3], 30);
    const t: Vec3 = [100, -50, 20];
    const perm = randomPermutation(base.vertexCount, 11);
    const target = permuteMesh(transformMesh(base, scaled(R, 25.4), t), perm, 12);
    const cap = captureLogger();
    const r = diffMeshes(base, target, { logger: cap.logger });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(3);
    expect(r.alignment.scale).toBe(25.4);
    expect(r.alignment.units).toEqual({ from: 'in', to: 'mm', factor: 25.4 });
    expectMatrixClose(r.alignment.matrix, mat4(scaled(R, 25.4), t), 1e-9);
    expect(r.stats.vertices).toEqual({ unchanged: base.vertexCount, moved: 0, added: 0, removed: 0 });
    for (let i = 0; i < base.vertexCount; i++) expect(r.baseToTarget[i]).toBe(perm[i]);
    expect(cap.info.some((l) => /in → mm|inches/.test(l))).toBe(true);
  });

  it('millimetres → inches (×1/25.4), translation only', () => {
    const base = transformMesh(asymmetricSolid(), scaled(I3, 25.4), [0, 0, 0]);
    const target = permuteMesh(transformMesh(base, scaled(I3, 1 / 25.4), [3, 1, -2]), randomPermutation(base.vertexCount, 3), 4);
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.tier).toBe(3);
    expect(r.alignment.scale).toBe(1 / 25.4);
    expect(r.alignment.units).toEqual({ from: 'mm', to: 'in', factor: 1 / 25.4 });
    expect(r.stats.vertices.unchanged).toBe(base.vertexCount);
  });

  it('metres → millimetres (×1000) with rotation', () => {
    const base = transformMesh(asymmetricSolid(), scaled(I3, 0.05), [0, 0, 0]); // a 20 cm part in metres
    const R = axisAngle([0, 1, 0], 75);
    const target = permuteMesh(transformMesh(base, scaled(R, 1000), [10, 20, 30]), randomPermutation(base.vertexCount, 5), 6);
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.tier).toBe(3);
    expect(r.alignment.scale).toBe(1000);
    expect(r.alignment.units).toEqual({ from: 'm', to: 'mm', factor: 1000 });
    expect(r.stats.vertices.unchanged).toBe(base.vertexCount);
  });

  it('a non-unit uniform resize (×1.5) is recovered and reported without a unit label', () => {
    const base = asymmetricSolid();
    const R = axisAngle([-1, 1, 2], 50);
    const target = permuteMesh(transformMesh(base, scaled(R, 1.5), [2, 2, 2]), randomPermutation(base.vertexCount, 7), 8);
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.tier).toBe(3);
    expect(r.alignment.scale).toBeCloseTo(1.5, 9);
    expect(r.alignment.units).toBeUndefined();
    expect(r.stats.vertices.unchanged).toBe(base.vertexCount);
  });

  it('unit conversion + a real local edit: the edit is still reported (as Moved), everything else unchanged', () => {
    const base = asymmetricSolid();
    const edited = withMoves(base, { 40: [0, 0, 0.02], 41: [0, 0, 0.02], 70: [0, 0.02, 0] });
    const perm = randomPermutation(base.vertexCount, 9);
    const target = permuteMesh(transformMesh(edited, scaled(axisAngle([1, 0, 0], 90), 25.4), [0, 0, 0]), perm, 10);
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(3);
    expect(r.alignment.scale).toBe(25.4);
    expect(r.stats.vertices.added + r.stats.vertices.removed).toBe(0);
    for (const v of [40, 41, 70]) expect(r.targetVertexStatus[perm[v]]).toBe(VertexStatus.Moved);
    expect(r.stats.vertices.moved).toBeGreaterThanOrEqual(3);
    expect(r.stats.vertices.moved).toBeLessThanOrEqual(6);
  });

  it('same lineage exported in other units (×25.4, same order) → Tier 1 + global unit conversion, all unchanged', () => {
    const base = asymmetricSolid();
    const target = transformMesh(base, scaled(I3, 25.4), [0, 0, 0]);
    const cap = captureLogger();
    const r = diffMeshes(base, target, { logger: cap.logger });
    assertInvariants(r, base, target);
    expect(r.tier).toBe(1);
    expect(r.alignment.scale).toBe(25.4);
    expect(r.alignment.units).toEqual({ from: 'in', to: 'mm', factor: 25.4 });
    expect(r.alignment.isIdentity).toBe(false);
    expect(r.stats.vertices).toEqual({ unchanged: base.vertexCount, moved: 0, added: 0, removed: 0 });
    expect(cap.info.some((l) => /global/i.test(l))).toBe(true);
  });

  it('same lineage, whole model translated → Tier 1 reports ONE global translation, not N moved vertices', () => {
    const base = asymmetricSolid();
    const target = transformMesh(base, I3, [10, 0, 0]);
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.tier).toBe(1);
    expect(r.alignment.scale).toBe(1);
    expect(r.alignment.isIdentity).toBe(false);
    transformPoint(r.alignment.matrix, [0, 0, 0]).forEach((v, i) => expect(v).toBeCloseTo([10, 0, 0][i], 9));
    expect(r.stats.vertices.unchanged).toBe(base.vertexCount);
  });

  it('rigid cases keep scale exactly 1 (no false scale on a remesh)', () => {
    const base = cylinder(48, 10);
    const target = cylinder(64, 13, { phase: 0.03 });
    const r = diffMeshes(base, target, { logger: silent });
    expect(r.tier).toBe(3);
    expect(r.alignment.scale).toBe(1);
    expect(r.alignment.units).toBeUndefined();
    expect(r.alignment.isIdentity).toBe(true);

    const solid = asymmetricSolid();
    const moved = permuteMesh(transformMesh(solid, axisAngle([0, 0, 1], 45), [1, 2, 3]), randomPermutation(solid.vertexCount, 13));
    const r2 = diffMeshes(solid, moved, { logger: silent });
    expect(r2.tier).toBe(3);
    expect(r2.alignment.scale).toBe(1);
    expect(r2.stats.vertices.unchanged).toBe(solid.vertexCount);
  });
});
