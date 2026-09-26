/**
 * Moved parts — a connected component (a "part") that moved rigidly on its own must be
 * reported as MOVED with its vertex-level correspondence intact, never as removed + added.
 *
 * Regression suite for the session-1 limitation "Tier 2 cannot seed a component that was
 * rigidly moved on its own; it shows as removed + added" (and the same failure after a
 * Tier 3 global alignment). Every scenario below failed on the session-1 engine.
 */
import { describe, expect, it } from 'vitest';
import { deserializeDiff, diffMeshes, serializeDiff } from '../../src/diff/index.js';
import type { IMesh, Vec3 } from '../../src/types.js';
import { VertexStatus } from '../../src/types.js';
import {
  assertInvariants,
  asymmetricSolid,
  axisAngle,
  captureLogger,
  combineMeshes,
  cube,
  moveRigid,
  pebble,
  permuteMesh,
  randomPermutation,
  scaled,
  silent,
  transformMesh,
  uvSphere,
  vertexCentroid,
  withMoves,
} from './util.js';

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Small asymmetric part (a scaled "pebble", 62 vertices / 120 triangles) centred near `at`. */
function knob(at: Vec3, size = 0.35): IMesh {
  return transformMesh(uvSphere(12, 6, pebble), scaled(I3, size), at);
}

/** Body (266 v) + knob (62 v) + cube (8 v): three disconnected parts. */
function assembly(knobMesh: IMesh = knob([5, 0, 0])): { parts: IMesh[]; mesh: IMesh; offsets: number[] } {
  const parts = [asymmetricSolid(24, 12), knobMesh, transformMesh(cube(0.5), I3, [0, 3.5, 0])];
  return { parts, ...combineMeshes(parts) };
}

const KNOB_R = axisAngle([0, 1, 1], 25);
const KNOB_D: Vec3 = [0, 1.5, 0.5];

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, digits: number): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], digits);
}

describe('moved parts', () => {
  it('a small part rotated + translated on its own (order shuffled) → Tier 2, part MOVED, exact correspondence', () => {
    const base = assembly();
    const moved = assembly(moveRigid(base.parts[1], KNOB_R, KNOB_D));
    const perm = randomPermutation(base.mesh.vertexCount, 101);
    const target = permuteMesh(moved.mesh, perm, 102);
    const cap = captureLogger();
    const r = diffMeshes(base.mesh, target, { logger: cap.logger });
    assertInvariants(r, base.mesh, target);

    expect(r.tier).toBe(2);
    const nKnob = base.parts[1].vertexCount;
    const nRest = base.mesh.vertexCount - nKnob;
    expect(r.stats.vertices).toEqual({ unchanged: nRest, moved: nKnob, added: 0, removed: 0 });
    expect(r.stats.faces.added + r.stats.faces.removed).toBe(0);
    expect(r.stats.faces.modified).toBe(base.parts[1].faceCount);
    // Vertex-level truth: every knob vertex maps to its own moved copy.
    const o = base.offsets[1];
    for (let k = 0; k < nKnob; k++) {
      expect(r.baseToTarget[o + k]).toBe(perm[o + k]);
      expect(r.targetVertexStatus[perm[o + k]]).toBe(VertexStatus.Moved);
    }
    // The part motion is reported as one rigid move.
    expect(r.parts).toHaveLength(1);
    const p = r.parts[0];
    expect(p.source).toBe('registration');
    expect(p.matchedVertices).toBe(nKnob);
    expect(p.deformedVertices).toBe(0);
    expect(p.rotationDeg).toBeCloseTo(25, 6);
    expectClose(p.centroidShift, KNOB_D, 6);
    expect(Array.from(p.baseVertices)).toEqual(Array.from({ length: nKnob }, (_, k) => o + k));
    expect(cap.info.some((l) => /moved part/i.test(l))).toBe(true);
  });

  it('a part as large as the rest of the model moved (50/50) → still MOVED, not removed + added', () => {
    const a = asymmetricSolid(24, 12);
    const b = transformMesh(asymmetricSolid(20, 10), scaled(I3, 0.8), [7, 0, 0]);
    const base = combineMeshes([a, b]);
    const moved = combineMeshes([a, moveRigid(b, axisAngle([1, 0, 1], 40), [0, 4, 0])]);
    const perm = randomPermutation(base.mesh.vertexCount, 7);
    const target = permuteMesh(moved.mesh, perm, 8);
    const r = diffMeshes(base.mesh, target, { logger: silent });
    assertInvariants(r, base.mesh, target);
    expect(r.tier).toBe(2);
    expect(r.stats.vertices).toEqual({ unchanged: a.vertexCount, moved: b.vertexCount, added: 0, removed: 0 });
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].rotationDeg).toBeCloseTo(40, 6);
    for (let k = 0; k < b.vertexCount; k++) expect(r.baseToTarget[base.offsets[1] + k]).toBe(perm[base.offsets[1] + k]);
  });

  it('direct lineage (same order) → Tier 1 already matches; the part motion is still reported', () => {
    const base = assembly();
    const target = assembly(moveRigid(base.parts[1], KNOB_R, KNOB_D)).mesh;
    const r = diffMeshes(base.mesh, target, { logger: silent });
    assertInvariants(r, base.mesh, target);
    expect(r.tier).toBe(1);
    expect(r.alignment.isIdentity).toBe(true); // only one part moved: no global transform
    expect(r.stats.vertices.moved).toBe(base.parts[1].vertexCount);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].source).toBe('matched');
    expect(r.parts[0].rotationDeg).toBeCloseTo(25, 6);
    expectClose(r.parts[0].centroidShift, KNOB_D, 6);
  });

  it('whole model moved (Tier 3) AND one part moved relative to it → part MOVED after the global alignment', () => {
    const base = assembly();
    const moved = assembly(moveRigid(base.parts[1], KNOB_R, KNOB_D)).mesh;
    const Rg = axisAngle([1, 2, 3], 30);
    const tg: Vec3 = [5, -3, 2];
    const perm = randomPermutation(base.mesh.vertexCount, 31);
    const target = permuteMesh(transformMesh(moved, Rg, tg), perm, 32);
    const r = diffMeshes(base.mesh, target, { logger: silent });
    assertInvariants(r, base.mesh, target);
    expect(r.tier).toBe(3);
    const nKnob = base.parts[1].vertexCount;
    expect(r.stats.vertices.added).toBe(0);
    expect(r.stats.vertices.removed).toBe(0);
    expect(r.stats.vertices.moved).toBe(nKnob);
    expect(r.stats.vertices.unchanged).toBe(base.mesh.vertexCount - nKnob);
    // Global alignment = the whole-model motion.
    const g = r.alignment.matrix;
    expectClose([g[0], g[4], g[8], g[1], g[5], g[9], g[2], g[6], g[10]], Rg, 6);
    expectClose([g[12], g[13], g[14]], tg, 6);
    // The knob's own motion, relative to the global alignment, in target space.
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].rotationDeg).toBeCloseTo(25, 5);
    const shift = [0, 1, 2].map((i) => Rg[i * 3] * KNOB_D[0] + Rg[i * 3 + 1] * KNOB_D[1] + Rg[i * 3 + 2] * KNOB_D[2]);
    expectClose(r.parts[0].centroidShift, shift, 5);
    const o = base.offsets[1];
    for (let k = 0; k < nKnob; k++) expect(r.baseToTarget[o + k]).toBe(perm[o + k]);
  });

  it('four identical parts, one moved → the moved copy (not a look-alike) carries the correspondence', () => {
    const body = asymmetricSolid(24, 12);
    const spots: Vec3[] = [
      [4, 4, 0],
      [-4, 4, 0],
      [-4, -4, 0],
      [4, -4, 0],
    ];
    const copies = spots.map((s) => knob(s));
    const base = combineMeshes([body, ...copies]);
    const movedCopy = moveRigid(copies[0], axisAngle([0, 0, 1], 60), [-4, -4, 5]);
    const moved = combineMeshes([body, movedCopy, ...copies.slice(1)]);
    const perm = randomPermutation(base.mesh.vertexCount, 41);
    const target = permuteMesh(moved.mesh, perm, 42);
    const r = diffMeshes(base.mesh, target, { logger: silent });
    assertInvariants(r, base.mesh, target);
    const n = copies[0].vertexCount;
    expect(r.stats.vertices).toEqual({ unchanged: base.mesh.vertexCount - n, moved: n, added: 0, removed: 0 });
    for (let k = 0; k < n; k++) expect(r.baseToTarget[base.offsets[1] + k]).toBe(perm[base.offsets[1] + k]);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].rotationDeg).toBeCloseTo(60, 6);
  });

  it('a moved part that was ALSO edited locally keeps exact correspondence; the edit is counted', () => {
    const base = assembly();
    const knobMoved = moveRigid(base.parts[1], KNOB_R, KNOB_D);
    const edited = withMoves(knobMoved, { 20: [0, 0, 0.12] });
    const perm = randomPermutation(base.mesh.vertexCount, 51);
    const target = permuteMesh(assembly(edited).mesh, perm, 52);
    const r = diffMeshes(base.mesh, target, { logger: silent });
    assertInvariants(r, base.mesh, target);
    expect(r.tier).toBe(2);
    const n = base.parts[1].vertexCount;
    expect(r.stats.vertices).toEqual({ unchanged: base.mesh.vertexCount - n, moved: n, added: 0, removed: 0 });
    const o = base.offsets[1];
    for (let k = 0; k < n; k++) expect(r.baseToTarget[o + k]).toBe(perm[o + k]);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].deformedVertices).toBe(1);
    // The rigid fit ignores the locally edited vertex.
    expect(r.parts[0].rotationDeg).toBeCloseTo(25, 6);
    expectClose(r.parts[0].centroidShift, KNOB_D, 2);
  });

  it('negative control: a part deleted and a DIFFERENT part added elsewhere stay removed + added', () => {
    const body = asymmetricSolid(24, 12);
    const box = transformMesh(cube(0.5), I3, [0, 3.5, 0]);
    const base = combineMeshes([body, box]).mesh;
    const target = permuteMesh(combineMeshes([body, knob([5, 0, 0])]).mesh, randomPermutation(body.vertexCount + 62, 61), 62);
    const r = diffMeshes(base, target, { logger: silent });
    assertInvariants(r, base, target);
    expect(r.stats.vertices).toEqual({ unchanged: body.vertexCount, moved: 0, added: 62, removed: 8 });
    expect(r.parts).toEqual([]);
  });

  it('part motions survive JSON serialisation (typed arrays restored)', () => {
    const base = assembly();
    const target = permuteMesh(assembly(moveRigid(base.parts[1], KNOB_R, KNOB_D)).mesh, randomPermutation(base.mesh.vertexCount, 81), 82);
    const r = diffMeshes(base.mesh, target, { logger: silent });
    const back = deserializeDiff(serializeDiff(r));
    expect(back).toEqual(r);
    expect(back.parts[0].baseVertices).toBeInstanceOf(Uint32Array);
    expect(back.parts[0].targetVertices).toBeInstanceOf(Uint32Array);
    // Session-1 JSON (no parts, no scale) still loads.
    const old = JSON.parse(serializeDiff(r));
    delete old.parts;
    delete old.alignment.scale;
    const upgraded = deserializeDiff(JSON.stringify(old));
    expect(upgraded.parts).toEqual([]);
    expect(upgraded.alignment.scale).toBe(1);
  });

  it('negative control: unchanged multi-part models report no part motion', () => {
    const { mesh } = assembly();
    const target = permuteMesh(mesh, randomPermutation(mesh.vertexCount, 71), 72);
    const r = diffMeshes(mesh, target, { logger: silent });
    expect(r.tier).toBe(2);
    expect(r.stats.vertices.unchanged).toBe(mesh.vertexCount);
    expect(r.parts).toEqual([]);
    expect(vertexCentroid(mesh)).toHaveLength(3);
  });
});
