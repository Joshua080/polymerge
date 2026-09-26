/**
 * Three-way merge — known-answer scenarios for every rule in docs/merge-design.md:
 * what merges automatically (including frame composition), every conflict kind, resolution,
 * symmetry and structural invariants.
 */
import { describe, expect, it } from 'vitest';
import { mergeMeshes, resolveMerge } from '../../src/merge/index.js';
import { createMesh } from '../../src/mesh.js';
import type { IMergeResult, IMesh, Vec3 } from '../../src/types.js';
import {
  appendGeometry,
  asymmetricSolid,
  axisAngle,
  combineMeshes,
  cube,
  cylinder,
  grid,
  moveRigid,
  pebble,
  permuteMesh,
  randomPermutation,
  removeVertices,
  scaled,
  silent,
  transformMesh,
  uvSphere,
  withMoves,
} from '../diff/util.js';

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const opts = { logger: silent };

function pos(m: IMesh, i: number): Vec3 {
  return [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
}

/** Merged vertex index of base vertex v (-1 when deleted). */
function mergedOf(r: IMergeResult, v: number): number {
  const p = r.provenance;
  for (let i = 0; i < p.vertexSource.length; i++) if (p.vertexSource[i] === 0 && p.vertexIndex[i] === v) return i;
  return -1;
}

function expectAt(r: IMergeResult, v: number, expected: ArrayLike<number>, digits = 9): void {
  const i = mergedOf(r, v);
  expect(i, `base vertex ${v} present in the merge`).toBeGreaterThanOrEqual(0);
  const p = pos(r.merged, i);
  for (let k = 0; k < 3; k++) expect(p[k]).toBeCloseTo(expected[k], digits);
}

function add(a: ArrayLike<number>, b: ArrayLike<number>): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Structural invariants every merge result must satisfy. */
function checkMerge(r: IMergeResult): void {
  const m = r.merged;
  expect(m.positions.length).toBe(m.vertexCount * 3);
  for (const x of m.positions) expect(Number.isFinite(x)).toBe(true);
  for (const f of m.faces) expect(f).toBeLessThan(m.vertexCount);
  const p = r.provenance;
  expect(p.vertexSource.length).toBe(m.vertexCount);
  expect(p.vertexIndex.length).toBe(m.vertexCount);
  expect(p.vertexChangedBy.length).toBe(m.vertexCount);
  expect(p.vertexConflict.length).toBe(m.vertexCount);
  expect(p.faceSource.length).toBe(m.faceCount);
  expect(p.faceIndex.length).toBe(m.faceCount);
  const used = new Uint8Array(m.vertexCount);
  for (const f of m.faces) used[f] = 1;
  for (let i = 0; i < m.vertexCount; i++) if (p.vertexSource[i] !== 0) expect(used[i], `added vertex ${i} is used`).toBe(1);
  expect(r.clean).toBe(r.conflicts.every((c) => c.resolution !== null));
  expect(r.stats.conflicts).toBe(r.conflicts.length);
  r.conflicts.forEach((c, i) => expect(c.id).toBe(i));
}

const kinds = (r: IMergeResult): string[] => r.conflicts.flatMap((c) => Object.keys(c.kinds)).sort();

/** One triangle on border edge (a, b) of a grid, to a new vertex at p. */
const flap = (m: IMesh, a: number, b: number, p: Vec3): IMesh => appendGeometry(m, p, [b, a, m.vertexCount]);

describe('three-way merge · clean merges', () => {
  const base = grid(10, 10);

  it('edits to different vertices merge automatically', () => {
    const ours = withMoves(base, { 22: [0, 0, 0.5] });
    const theirs = withMoves(base, { 77: [0, 0, -0.3] });
    const r = mergeMeshes(base, ours, theirs, opts);
    checkMerge(r);
    expect(r.clean).toBe(true);
    expect(r.conflicts).toEqual([]);
    expectAt(r, 22, add(pos(base, 22), [0, 0, 0.5]));
    expectAt(r, 77, add(pos(base, 77), [0, 0, -0.3]));
    expectAt(r, 50, pos(base, 50));
    expect(r.stats.movedFromOurs).toBe(1);
    expect(r.stats.movedFromTheirs).toBe(1);
    expect(r.merged.faceCount).toBe(base.faceCount);
  });

  it('adjacent vertex edits are independent (a vertex is a surface sample, not a hunk)', () => {
    const r = mergeMeshes(base, withMoves(base, { 44: [0, 0, 1] }), withMoves(base, { 45: [0, 0, 2] }), opts);
    expect(r.clean).toBe(true);
    expectAt(r, 44, add(pos(base, 44), [0, 0, 1]));
    expectAt(r, 45, add(pos(base, 45), [0, 0, 2]));
  });

  it('the same move on both sides is applied once (convergent)', () => {
    const e = withMoves(base, { 33: [0.1, 0.2, 0.3] });
    const r = mergeMeshes(base, e, e, opts);
    expect(r.clean).toBe(true);
    expect(r.stats.movedConvergent).toBe(1);
    expectAt(r, 33, add(pos(base, 33), [0.1, 0.2, 0.3]));
  });

  it('deleting the same geometry on both sides is fine', () => {
    const { mesh: hole } = removeVertices(base, [44, 45]);
    const r = mergeMeshes(base, hole, hole, opts);
    expect(r.clean).toBe(true);
    expect(r.stats.deletedConvergent).toBe(2);
    expect(r.merged.vertexCount).toBe(base.vertexCount - 2);
    expect(r.merged.faceCount).toBe(hole.faceCount);
  });

  it('a hole on one side + moving a rim vertex it kept on the other compose', () => {
    // Ours removes the two triangles of quad (4,4) — its corners stay (used by neighbours).
    const quad = new Set([2 * (4 * 9 + 4), 2 * (4 * 9 + 4) + 1]);
    const f: number[] = [];
    for (let i = 0; i < base.faceCount; i++) if (!quad.has(i)) f.push(...base.faces.subarray(i * 3, i * 3 + 3));
    const ours = createMesh(base.positions, f);
    const theirs = withMoves(base, { 44: [0, 0, 0.7] });
    const r = mergeMeshes(base, ours, theirs, opts);
    checkMerge(r);
    expect(r.clean).toBe(true);
    expect(r.merged.faceCount).toBe(base.faceCount - 2);
    expectAt(r, 44, add(pos(base, 44), [0, 0, 0.7]));
  });

  it('a vertex whose faces were all removed (different faces by each side) is dropped', () => {
    // Vertex 44 has 6 incident faces; ours deletes three, theirs the other three.
    const inc: number[] = [];
    for (let i = 0; i < base.faceCount; i++) if (Array.from(base.faces.subarray(i * 3, i * 3 + 3)).includes(44)) inc.push(i);
    expect(inc).toHaveLength(6);
    const without = (drop: number[]): IMesh => {
      const f: number[] = [];
      for (let i = 0; i < base.faceCount; i++) if (!drop.includes(i)) f.push(...base.faces.subarray(i * 3, i * 3 + 3));
      return createMesh(base.positions, f);
    };
    const r = mergeMeshes(base, without(inc.slice(0, 3)), without(inc.slice(3)), opts);
    checkMerge(r);
    expect(r.clean).toBe(true);
    expect(r.merged.faceCount).toBe(base.faceCount - 6);
    expect(mergedOf(r, 44)).toBe(-1);
    expect(r.merged.vertexCount).toBe(base.vertexCount - 1);
  });

  it('additions on different edges are both kept', () => {
    const ours = flap(base, 0, 1, [0.5, -0.8, 0.3]);
    const theirs = flap(base, 7, 8, [7.5, -0.8, 0.3]);
    const r = mergeMeshes(base, ours, theirs, opts);
    checkMerge(r);
    expect(r.clean).toBe(true);
    expect(r.merged.faceCount).toBe(base.faceCount + 2);
    expect(r.stats.facesAddedFromOurs).toBe(1);
    expect(r.stats.facesAddedFromTheirs).toBe(1);
  });

  it('identical additions on both sides are emitted once', () => {
    const e = flap(base, 0, 1, [0.5, -0.8, 0.3]);
    const r = mergeMeshes(base, e, e, opts);
    expect(r.clean).toBe(true);
    expect(r.stats.facesAddedConvergent).toBe(1);
    expect(r.merged.faceCount).toBe(base.faceCount + 1);
    expect(r.merged.vertexCount).toBe(base.vertexCount + 1);
  });

  it('a re-ordered side (Tier 2) still maps its edits to the right base vertices', () => {
    const perm = randomPermutation(base.vertexCount, 5);
    const ours = permuteMesh(withMoves(base, { 12: [0, 0, 0.4] }), perm, 6);
    const theirs = withMoves(base, { 87: [0, 0, 0.9] });
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(r.ours.tier).toBe(2);
    expect(r.clean).toBe(true);
    expectAt(r, 12, add(pos(base, 12), [0, 0, 0.4]));
    expectAt(r, 87, add(pos(base, 87), [0, 0, 0.9]));
  });
});

describe('three-way merge · frames compose (no false conflicts)', () => {
  const knob = transformMesh(uvSphere(12, 6, pebble), scaled(I3, 0.35), [5, 0, 0]);
  const parts = [asymmetricSolid(24, 12), knob, transformMesh(cube(0.5), I3, [0, 3.5, 0])];
  const { mesh: base, offsets } = combineMeshes(parts);
  const R = axisAngle([0, 1, 1], 25);
  const D: Vec3 = [0, 1.5, 0.5];
  const moveKnob = (m: IMesh): IMesh => {
    const p = [parts[0], moveRigid(knob, R, D), parts[2]];
    void m;
    return combineMeshes(p).mesh;
  };

  it('ours moves a part, theirs edits a vertex on that part → the edited part, moved', () => {
    const ours = moveKnob(base);
    const k = offsets[1] + 20;
    const theirs = withMoves(base, { [k]: [0, 0, 0.1] });
    const r = mergeMeshes(base, ours, theirs, opts);
    checkMerge(r);
    expect(r.clean).toBe(true);
    expect(r.stats.partMotionsFromOurs).toBe(1);
    // Part motion G (rotate about the knob centroid, then shift) applied to theirs' edited point.
    const n = knob.vertexCount;
    const c = [0, 1, 2].map((a) => Array.from({ length: n }, (_, i) => knob.positions[i * 3 + a]).reduce((s, x) => s + x, 0) / n);
    const G = (p: number[]): number[] =>
      [0, 1, 2].map((i) => R[i * 3] * (p[0] - c[0]) + R[i * 3 + 1] * (p[1] - c[1]) + R[i * 3 + 2] * (p[2] - c[2]) + c[i] + D[i]);
    expectAt(r, k, G(add(pos(base, k), [0, 0, 0.1])), 6);
    expectAt(r, offsets[1] + 3, G(pos(base, offsets[1] + 3)), 6);
    expectAt(r, 0, pos(base, 0)); // body untouched
  });

  it('both sides move the same part differently → part-motion conflict, left at base until resolved', () => {
    const ours = moveKnob(base);
    const theirs = combineMeshes([parts[0], moveRigid(knob, I3, [0, 0, 2]), parts[2]]).mesh;
    const r = mergeMeshes(base, ours, theirs, opts);
    checkMerge(r);
    expect(kinds(r)).toEqual(['part-motion']);
    expect(r.clean).toBe(false);
    const k = offsets[1] + 5;
    expectAt(r, k, pos(base, k));
    const t = resolveMerge(r, { 0: 'theirs' });
    expect(t.clean).toBe(true);
    expectAt(t, k, add(pos(base, k), [0, 0, 2]), 6);
  });

  it('ours re-exports in mm (×25.4), theirs edits in inches → theirs edit, converted', () => {
    const solid = asymmetricSolid(16, 8);
    const ours = transformMesh(solid, scaled(I3, 25.4), [0, 0, 0]);
    const theirs = withMoves(solid, { 30: [0, 0, 0.05] });
    const r = mergeMeshes(solid, ours, theirs, opts);
    checkMerge(r);
    expect(r.clean).toBe(true);
    expect(r.frame.source).toBe('ours');
    expect(r.frame.transform.units).toEqual({ from: 'in', to: 'mm', factor: 25.4 });
    expectAt(r, 30, add(pos(solid, 30), [0, 0, 0.05]).map((x) => 25.4 * x), 6);
    expectAt(r, 31, pos(solid, 31).map((x) => 25.4 * x), 6);
  });

  it('both sides converted identically + different local edits → both edits, in mm', () => {
    const solid = asymmetricSolid(16, 8);
    const mm = (m: IMesh): IMesh => transformMesh(m, scaled(I3, 25.4), [0, 0, 0]);
    const r = mergeMeshes(solid, mm(withMoves(solid, { 10: [0, 0, 0.1] })), mm(withMoves(solid, { 60: [0.1, 0, 0] })), opts);
    expect(r.clean).toBe(true);
    expect(r.frame.source).toBe('both');
    expectAt(r, 10, add(pos(solid, 10), [0, 0, 0.1]).map((x) => 25.4 * x), 6);
    expectAt(r, 60, add(pos(solid, 60), [0.1, 0, 0]).map((x) => 25.4 * x), 6);
  });

  it('a unit conversion on one side and a whole-model move on the other compose (units applied last)', () => {
    const solid = asymmetricSolid(16, 8);
    const ours = transformMesh(solid, scaled(I3, 25.4), [0, 0, 0]);
    const theirs = transformMesh(solid, I3, [2, 0, 0]);
    const r = mergeMeshes(solid, ours, theirs, opts);
    expect(r.clean).toBe(true);
    expect(r.frame.source).toBe('composed');
    expectAt(r, 7, add(pos(solid, 7), [2, 0, 0]).map((x) => 25.4 * x), 6);
  });
});

describe('three-way merge · conflicts', () => {
  const base = grid(10, 10);

  it('move-move: the same vertex moved differently → conflict, base state until resolved', () => {
    const ours = withMoves(base, { 44: [0, 0, 1] });
    const theirs = withMoves(base, { 44: [0, 0, -1] });
    const r = mergeMeshes(base, ours, theirs, opts);
    checkMerge(r);
    expect(r.clean).toBe(false);
    expect(kinds(r)).toEqual(['move-move']);
    expect(Array.from(r.conflicts[0].baseVertices)).toEqual([44]);
    expect(r.conflicts[0].resolution).toBeNull();
    expectAt(r, 44, pos(base, 44));
    const o = resolveMerge(r, { 0: 'ours' });
    expect(o.clean).toBe(true);
    expectAt(o, 44, add(pos(base, 44), [0, 0, 1]));
    expectAt(resolveMerge(r, { 0: 'theirs' }), 44, add(pos(base, 44), [0, 0, -1]));
    expectAt(mergeMeshes(base, ours, theirs, { ...opts, defaultResolution: 'theirs' }), 44, add(pos(base, 44), [0, 0, -1]));
  });

  it('a conflict region takes whole edits: an overlapping bump on each side resolves as a unit', () => {
    const ours = withMoves(base, { 44: [0, 0, 1], 45: [0, 0, 1], 54: [0, 0, 1] });
    const theirs = withMoves(base, { 45: [0, 0, -1], 46: [0, 0, -1] });
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(r.conflicts).toHaveLength(1);
    expect(Array.from(r.conflicts[0].baseVertices)).toEqual([44, 45, 46, 54]);
    const t = resolveMerge(r, { 0: 'theirs' });
    expectAt(t, 44, pos(base, 44)); // ours' part of the overlapping edit is NOT half-applied
    expectAt(t, 46, add(pos(base, 46), [0, 0, -1]));
  });

  it('move-delete: one side moved a vertex the other deleted', () => {
    const ours = withMoves(base, { 44: [0, 0, 1] });
    const { mesh: theirs } = removeVertices(base, [44]);
    const r = mergeMeshes(base, ours, theirs, opts);
    checkMerge(r);
    expect(kinds(r)).toEqual(['move-delete']);
    expectAt(r, 44, pos(base, 44));
    expect(r.merged.faceCount).toBe(base.faceCount);
    const t = resolveMerge(r, { 0: 'theirs' });
    expect(mergedOf(t, 44)).toBe(-1);
    expect(t.merged.faceCount).toBe(theirs.faceCount);
  });

  it('delete-dependency: one side attached new geometry to a vertex the other deleted', () => {
    const ours = flap(base, 0, 1, [0.5, -0.8, 0.3]);
    const { mesh: theirs } = removeVertices(base, [1]);
    const r = mergeMeshes(base, ours, theirs, opts);
    checkMerge(r);
    expect(kinds(r)).toEqual(['delete-dependency']);
    expect(r.merged.faceCount).toBe(base.faceCount); // base state: no flap, vertex 1 kept
    const o = resolveMerge(r, { 0: 'ours' });
    expect(o.merged.faceCount).toBe(base.faceCount + 1);
    const t = resolveMerge(r, { 0: 'theirs' });
    expect(mergedOf(t, 1)).toBe(-1);
    expect(t.merged.faceCount).toBe(theirs.faceCount);
  });

  it('competing-additions: different faces added on the same edge', () => {
    const r = mergeMeshes(base, flap(base, 0, 1, [0.5, -0.8, 0.3]), flap(base, 0, 1, [0.5, -0.8, -0.6]), opts);
    checkMerge(r);
    expect(kinds(r)).toEqual(['competing-additions']);
    expect(r.merged.faceCount).toBe(base.faceCount);
    expect(resolveMerge(r, { 0: 'ours' }).merged.faceCount).toBe(base.faceCount + 1);
  });

  it('overlapping-additions: two different new parts in the same place; distant ones merge', () => {
    const box = (s: number, at: Vec3): IMesh => transformMesh(cube(s), scaled(I3, 1), at);
    const withBox = (b: IMesh): IMesh => combineMeshes([base, b]).mesh;
    const r = mergeMeshes(base, withBox(box(1, [20, 0, 0])), withBox(box(1.3, [20.4, 0.3, 0.2])), opts);
    checkMerge(r);
    expect(kinds(r)).toEqual(['overlapping-additions']);
    const far = mergeMeshes(base, withBox(box(1, [20, 0, 0])), withBox(box(1, [40, 0, 0])), opts);
    expect(far.clean).toBe(true);
    expect(far.merged.faceCount).toBe(base.faceCount + 24);
  });

  it('global-transform: both sides moved the whole model differently (local edits still merge)', () => {
    const solid = asymmetricSolid(16, 8);
    const ours = transformMesh(withMoves(solid, { 5: [0, 0, 0.2] }), axisAngle([0, 0, 1], 90), [0, 0, 0]);
    const theirs = transformMesh(withMoves(solid, { 40: [0, 0, 0.3] }), I3, [10, 0, 0]);
    const r = mergeMeshes(solid, ours, theirs, opts);
    checkMerge(r);
    expect(kinds(r)).toEqual(['global-transform']);
    expect(r.conflicts[0].wholeModel).toBe(true);
    // Unresolved: base frame, both local edits applied.
    expectAt(r, 5, add(pos(solid, 5), [0, 0, 0.2]), 6);
    expectAt(r, 40, add(pos(solid, 40), [0, 0, 0.3]), 6);
    const t = resolveMerge(r, { 0: 'theirs' });
    expectAt(t, 5, add(add(pos(solid, 5), [0, 0, 0.2]), [10, 0, 0]), 6);
  });

  it('lineage: a remeshed side cannot be merged vertex by vertex', () => {
    const b = cylinder(48, 10);
    const ours = withMoves(b, { 100: [0.2, 0, 0] });
    const theirs = cylinder(64, 13, { phase: 0.03 });
    const r = mergeMeshes(b, ours, theirs, opts);
    checkMerge(r);
    expect(r.theirs.tier).toBe(3);
    expect(kinds(r)).toEqual(['lineage']);
    expect(r.merged.vertexCount).toBe(b.vertexCount);
    expect(resolveMerge(r, { 0: 'theirs' }).merged.vertexCount).toBe(theirs.vertexCount);
  });
});

describe('three-way merge · properties', () => {
  it('is symmetric: swapping ours and theirs gives the same conflicts and the same base-vertex positions', () => {
    const base = grid(12, 12);
    const A = flap(withMoves(base, { 30: [0, 0, 1], 70: [0, 0, 1] }), 0, 1, [0.5, -0.8, 0.3]);
    const B = withMoves(removeVertices(base, [100]).mesh, { 70: [0, 0, -1], 90: [0, 0.3, 0] });
    const ab = mergeMeshes(base, A, B, opts);
    const ba = mergeMeshes(base, B, A, opts);
    expect(kinds(ab)).toEqual(kinds(ba));
    expect(ab.conflicts.map((c) => Array.from(c.baseVertices))).toEqual(ba.conflicts.map((c) => Array.from(c.baseVertices)));
    for (let v = 0; v < base.vertexCount; v++) {
      const i = mergedOf(ab, v);
      const j = mergedOf(ba, v);
      expect(i >= 0).toBe(j >= 0);
      if (i >= 0) for (let k = 0; k < 3; k++) expect(ab.merged.positions[i * 3 + k]).toBeCloseTo(ba.merged.positions[j * 3 + k], 9);
    }
    expect(ab.merged.faceCount).toBe(ba.merged.faceCount);
  });

  it('merging a side with the base, or a side with itself, returns that side', () => {
    const base = grid(8, 8);
    const A = flap(withMoves(base, { 20: [0, 0, 1] }), 0, 1, [0.5, -0.8, 0.3]);
    for (const r of [mergeMeshes(base, A, base, opts), mergeMeshes(base, base, A, opts), mergeMeshes(base, A, A, opts)]) {
      checkMerge(r);
      expect(r.clean).toBe(true);
      expect(r.merged.vertexCount).toBe(A.vertexCount);
      expect(r.merged.faceCount).toBe(A.faceCount);
      expectAt(r, 20, pos(A, 20));
    }
  });

  it('logs the tier of each side and a merge summary', () => {
    const info: string[] = [];
    const base = grid(6, 6);
    mergeMeshes(base, withMoves(base, { 7: [0, 0, 1] }), withMoves(base, { 7: [0, 0, 2] }), {
      logger: { info: (m) => info.push(m), warn: () => {} },
    });
    expect(info.some((l) => /ours resolved by Tier 1, theirs by Tier 1/.test(l))).toBe(true);
    expect(info.some((l) => /1 conflict\(s\), 1 unresolved/.test(l))).toBe(true);
    expect(info.some((l) => /conflict #0: 1 vertex\(es\) moved to different places/.test(l))).toBe(true);
  });
});
