/**
 * Combined-edit damage (the `collision` conflict, docs/merge-design.md §4): two edits that are
 * each fine on their own side — and conflict under no other rule — but damage the model once
 * both are applied. Every scenario checks both sides are individually sound, that the merge
 * refuses to combine them, and that each resolution gives back one side's sound geometry.
 */
import { describe, expect, it } from 'vitest';
import { mergeMeshes, resolveMerge } from '../../src/merge/index.js';
import { createMesh } from '../../src/mesh.js';
import type { IMergeResult, IMesh, Vec3 } from '../../src/types.js';
import { appendGeometry, cube, grid, silent, withMoves } from '../diff/util.js';

const opts = { logger: silent };

function pos(m: IMesh, i: number): Vec3 {
  return [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
}

function mergedOf(r: IMergeResult, v: number): number {
  const p = r.provenance;
  for (let i = 0; i < p.vertexSource.length; i++) if (p.vertexSource[i] === 0 && p.vertexIndex[i] === v) return i;
  return -1;
}

function expectAt(r: IMergeResult, v: number, expected: ArrayLike<number>): void {
  const i = mergedOf(r, v);
  expect(i, `base vertex ${v} present in the merge`).toBeGreaterThanOrEqual(0);
  const p = pos(r.merged, i);
  for (let k = 0; k < 3; k++) expect(p[k]).toBeCloseTo(expected[k], 9);
}

const kinds = (r: IMergeResult): string[] => [...new Set(r.conflicts.flatMap((c) => Object.keys(c.kinds)))].sort();

/**
 * A closed n×n slab: top grid at z = t (normals up), bottom grid at z = 0 (normals down) and
 * side walls. Top vertex (i, j) is j·n + i; the bottom one is n² + j·n + i.
 */
function slab(n: number, t = 1): IMesh {
  const top = (i: number, j: number): number => j * n + i;
  const bot = (i: number, j: number): number => n * n + j * n + i;
  const p: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) p.push(i, j, t);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) p.push(i, j, 0);
  const faces: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      faces.push(top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j), top(i + 1, j + 1), top(i, j + 1));
      faces.push(bot(i, j), bot(i + 1, j + 1), bot(i + 1, j), bot(i, j), bot(i, j + 1), bot(i + 1, j + 1));
    }
  }
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) ring.push([i, 0]);
  for (let j = 0; j < n - 1; j++) ring.push([n - 1, j]);
  for (let i = n - 1; i > 0; i--) ring.push([i, n - 1]);
  for (let j = n - 1; j > 0; j--) ring.push([0, j]);
  ring.forEach(([i0, j0], k) => {
    const [i1, j1] = ring[(k + 1) % ring.length];
    faces.push(bot(i0, j0), bot(i1, j1), top(i1, j1), bot(i0, j0), top(i1, j1), top(i0, j0));
  });
  return createMesh(p, faces, { metadata: { sourceName: 'slab' } });
}

/** Append a separate axis-aligned box [min, min + size]; returns its vertex indices too. */
function withBox(mesh: IMesh, min: Vec3, size: Vec3): { mesh: IMesh; verts: number[] } {
  const c = cube(1);
  const o = mesh.vertexCount;
  const p: number[] = [];
  for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) p.push(min[k] + c.positions[i * 3 + k] * size[k]);
  return { mesh: appendGeometry(mesh, p, Array.from(c.faces, (f) => f + o)), verts: Array.from({ length: 8 }, (_, i) => o + i) };
}

/** Move a set of vertices by d. */
const shift = (m: IMesh, verts: number[], d: Vec3): IMesh => withMoves(m, Object.fromEntries(verts.map((v) => [v, d])));

/** Merging a mesh with itself / its base proves a single side is sound (no damage of its own). */
function sound(base: IMesh, side: IMesh): void {
  const r = mergeMeshes(base, side, base, opts);
  expect(r.clean, 'the side on its own merges cleanly').toBe(true);
}

const N = 7;
const T = 3 * N + 3; // top centre (3, 3, 1)
const B = N * N + T; // bottom centre (3, 3, 0)

describe('three-way merge · combined edits that damage the model (collision)', () => {
  const base = slab(N);

  it('walls pushed towards each other from both sides pass through each other: conflict, base kept', () => {
    const ours = withMoves(base, { [T]: [0, 0, -0.7] }); // top centre down to z = 0.3
    const theirs = withMoves(base, { [B]: [0, 0, 0.7] }); // bottom centre up to z = 0.7
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(r.clean).toBe(false);
    expect(kinds(r)).toEqual(['collision']);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0];
    expect([...c.baseVertices]).toEqual(expect.arrayContaining([T, B]));
    expect(c.message).toMatch(/crossing face pair/);
    // Unresolved: the region stays in the base state (the tool never guesses).
    expectAt(r, T, [3, 3, 1]);
    expectAt(r, B, [3, 3, 0]);
    // Each resolution is one side's sound geometry.
    const ro = resolveMerge(r, { 0: 'ours' });
    expectAt(ro, T, [3, 3, 0.3]);
    expectAt(ro, B, [3, 3, 0]);
    expect(ro.clean).toBe(true);
    expect(ro.warnings).toEqual([]);
    const rt = resolveMerge(r, { 0: 'theirs' });
    expectAt(rt, T, [3, 3, 1]);
    expectAt(rt, B, [3, 3, 0.7]);
    expect(rt.warnings).toEqual([]);
  });

  it('the same edits without contact merge cleanly (negative control)', () => {
    const r = mergeMeshes(base, withMoves(base, { [T]: [0, 0, -0.3] }), withMoves(base, { [B]: [0, 0, 0.2] }), opts);
    expect(r.clean).toBe(true);
    expectAt(r, T, [3, 3, 0.7]);
    expectAt(r, B, [3, 3, 0.2]);
  });

  it("a side's OWN self-intersection is not blamed on the merge", () => {
    const ours = withMoves(base, { [T]: [0, 0, -1.5] }); // pushed right through the bottom by ours alone
    const theirs = withMoves(base, { 0: [0, 0, 0.1] });
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(r.clean).toBe(true);
    expectAt(r, T, [3, 3, -0.5]);
  });

  it('is symmetric in ours / theirs', () => {
    const a = withMoves(base, { [T]: [0, 0, -0.7] });
    const b = withMoves(base, { [B]: [0, 0, 0.7] });
    const r1 = mergeMeshes(base, a, b, opts);
    const r2 = mergeMeshes(base, b, a, opts);
    expect(kinds(r2)).toEqual(kinds(r1));
    expect([...r2.conflicts[0].baseVertices]).toEqual([...r1.conflicts[0].baseVertices]);
  });

  it('neighbouring vertices pushed past each other fold the faces between them', () => {
    const g = grid(N, N);
    const a = 3 * N + 3;
    const b = a + 1;
    const ours = withMoves(g, { [a]: [0.6, 0, 0] }); // x 3 → 3.6, still left of b (x = 4)
    const theirs = withMoves(g, { [b]: [-0.6, 0, 0] }); // x 4 → 3.4, still right of a (x = 3)
    sound(g, ours);
    sound(g, theirs);
    const r = mergeMeshes(g, ours, theirs, opts);
    expect(kinds(r)).toEqual(['collision']);
    expect(r.conflicts[0].message).toMatch(/2 folded or collapsed face/);
    expect([...r.conflicts[0].baseVertices]).toEqual(expect.arrayContaining([a, b]));
    expectAt(r, a, pos(g, a));
    expectAt(r, b, pos(g, b));
    expectAt(resolveMerge(r, { 0: 'theirs' }), b, [3.4, 3, 0]);
  });

  it('two parts moved into the same space by different sides', () => {
    const { mesh: withA, verts: boxA } = withBox(base, [0, 0, 3], [1, 1, 1]);
    const { mesh: two, verts: boxB } = withBox(withA, [5, 0, 3], [1, 1, 1]);
    const ours = shift(two, boxA, [2.5, 0.3, 0.2]); // → x 2.5..3.5, y 0.3..1.3, z 3.2..4.2
    const theirs = shift(two, boxB, [-2.2, 0.1, 0.4]); // → x 2.8..3.8, y 0.1..1.1, z 3.4..4.4
    sound(two, ours);
    sound(two, theirs);
    const r = mergeMeshes(two, ours, theirs, opts);
    expect(kinds(r)).toEqual(['collision']);
    expect(r.conflicts).toHaveLength(1);
    expect([...r.conflicts[0].baseVertices]).toEqual(expect.arrayContaining([...boxA, ...boxB]));
    expectAt(r, boxA[0], [0, 0, 3]);
    expectAt(r, boxB[0], [5, 0, 3]);
    const ro = resolveMerge(r, { 0: 'ours' });
    expectAt(ro, boxA[0], [2.5, 0.3, 3.2]);
    expectAt(ro, boxB[0], [5, 0, 3]);
    expect(ro.warnings).toEqual([]);
  });

  it('new geometry on one side pierced by an edit on the other', () => {
    // ours adds a floating block above the top centre; theirs raises the top centre into it.
    const { mesh: ours } = withBox(base, [2.8, 2.8, 1.4], [0.4, 0.4, 0.5]);
    const theirs = withMoves(base, { [T]: [0, 0, 0.7] });
    sound(base, ours);
    sound(base, theirs);
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(kinds(r)).toEqual(['collision']);
    expect(r.conflicts[0].oursVertices.length).toBeGreaterThan(0);
    // Unresolved: neither the block nor the raised vertex.
    expect(r.merged.vertexCount).toBe(base.vertexCount);
    expectAt(r, T, [3, 3, 1]);
    const ro = resolveMerge(r, { 0: 'ours' });
    expect(ro.merged.vertexCount).toBe(base.vertexCount + 8);
    expectAt(ro, T, [3, 3, 1]);
    const rt = resolveMerge(r, { 0: 'theirs' });
    expect(rt.merged.vertexCount).toBe(base.vertexCount);
    expectAt(rt, T, [3, 3, 1.7]);
  });

  it('reverting a collision region can expose another: the check repeats until the merge is sound', () => {
    // theirs dents the top centre AND lowers a block into the dent; ours bumps the bottom centre
    // into the dent. Reverting the dent/bump collision leaves the lowered block crossing the flat
    // top, so the block's move must join the region too.
    const { mesh: withK, verts: K } = withBox(base, [2.85, 2.85, 1.4], [0.3, 0.3, 0.8]); // z 1.4..2.2
    const theirs = shift(withMoves(withK, { [T]: [0, 0, -0.8] }), K, [0, 0, -0.9]); // dent to 0.2, block to 0.5..1.3
    const ours = withMoves(withK, { [B]: [0, 0, 0.3] }); // bump to 0.3: above the dent, below the block
    sound(withK, ours);
    sound(withK, theirs);
    const r = mergeMeshes(withK, ours, theirs, opts);
    expect(kinds(r)).toEqual(['collision']);
    expect(r.conflicts).toHaveLength(1);
    expect([...r.conflicts[0].baseVertices]).toEqual(expect.arrayContaining([T, B, ...K]));
    expectAt(r, K[0], [2.85, 2.85, 1.4]);
    const rt = resolveMerge(r, { 0: 'theirs' });
    expectAt(rt, T, [3, 3, 0.2]);
    expectAt(rt, K[0], [2.85, 2.85, 0.5]);
    expectAt(rt, B, [3, 3, 0]);
    expect(rt.warnings).toEqual([]);
  });

  it('resolutions that are fine one by one but collide together are reported as a warning', () => {
    // Two move-move conflicts: ours puts the top centre at 0.3 and the bottom centre at 0.1;
    // theirs puts them at 0.9 and 0.7. Either side alone is sound; mixing top-from-ours with
    // bottom-from-theirs is not.
    const ours = withMoves(base, { [T]: [0, 0, -0.7], [B]: [0, 0, 0.1] });
    const theirs = withMoves(base, { [T]: [0, 0, -0.1], [B]: [0, 0, 0.7] });
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(kinds(r)).toEqual(['move-move']);
    expect(r.conflicts).toHaveLength(2);
    expect(r.warnings).toEqual([]);
    const top = r.conflicts.find((c) => c.baseVertices.includes(T))!.id;
    const bottom = r.conflicts.find((c) => c.baseVertices.includes(B))!.id;
    const mixed = resolveMerge(r, { [top]: 'ours', [bottom]: 'theirs' });
    expect(mixed.clean).toBe(true);
    expect(mixed.warnings).toHaveLength(1);
    expect(mixed.warnings[0].kind).toBe('collision');
    expect(mixed.warnings[0].conflicts).toEqual([top, bottom].sort((x, y) => x - y));
    expect(mixed.warnings[0].mergedFaces.length).toBeGreaterThan(0);
    expect(mixed.warnings[0].message).toMatch(/crossing face pair/);
    expect(resolveMerge(r, { [top]: 'ours', [bottom]: 'ours' }).warnings).toEqual([]);
    expect(resolveMerge(r, { [top]: 'theirs', [bottom]: 'theirs' }).warnings).toEqual([]);
  });

  it('detectCollisions: false merges the damaging combination as before (escape hatch)', () => {
    const r = mergeMeshes(base, withMoves(base, { [T]: [0, 0, -0.7] }), withMoves(base, { [B]: [0, 0, 0.7] }), {
      ...opts,
      detectCollisions: false,
    });
    expect(r.clean).toBe(true);
    expectAt(r, T, [3, 3, 0.3]);
    expectAt(r, B, [3, 3, 0.7]);
  });
});
