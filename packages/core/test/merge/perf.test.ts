/**
 * Merge performance at ~100k vertices, including the combined-edit (collision) check, which
 * examines every face pair near geometry that differs from both sides, and the appearance merge
 * (islands, assignment, texture-space overlap search). Runs in the perf pass
 * (vitest.perf.config.ts), alone, so the bound measures the merge rather than the scheduler.
 */
import { describe, expect, it } from 'vitest';
import { mergeMeshes } from '../../src/merge/index.js';
import { createMesh } from '../../src/mesh.js';
import type { IMesh, IMeshScene, Vec3 } from '../../src/types.js';
import { writeGlb } from '../../src/writers/index.js';
import { grid, silent, withMoves } from '../diff/util.js';
import { def, image, tex, textured, type ILookSpec } from './appearance-util.js';

/** Two wavy sheets (two parts), and the edits of the scenario below. */
function scenario(): { base: IMesh; ours: IMesh; theirs: IMesh; local: Record<number, [number, number, number]> } {
  const g = grid(250, 200, { height: (x, y) => Math.sin(x / 9) * Math.cos(y / 7) });
  const nG = g.vertexCount;
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
  for (let k = 0; k < 3000; k++) local[nG + Math.floor(rand() * nG)] = [0, 0, (rand() < 0.5 ? -1 : 1) * (0.05 + 0.2 * rand())];
  return { base, ours: withMoves(base, partMove), theirs: withMoves(base, local), local };
}

/** glTF-like structure for the two sheets: one node each; `moved` puts sheet B's move in its transform. */
function withScene(m: IMesh, moved?: Vec3): IMesh {
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const faceSources = new Int32Array(m.faceCount);
  faceSources.fill(1, m.faceCount / 2);
  const scene: IMeshScene = {
    nodes: [
      { name: 'sheet A', children: [], mesh: 0, world: I },
      { name: 'sheet B', children: [], mesh: 1, world: moved ? [...I.slice(0, 12), ...moved, 1] : I, ...(moved ? { translation: moved } : {}) },
    ],
    roots: [0, 1],
    meshes: [{ name: 'A' }, { name: 'B' }],
    sources: [
      { node: 0, primitive: 0 },
      { node: 1, primitive: 0 },
    ],
    faceSources,
  };
  return { ...m, scene };
}

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

  it('appearance (glTF-like, ~100k vertices, per-corner UVs in 256 islands): both sides re-UV, repaint and edit, clean within seconds', () => {
    // 321 × 321 vertices = 320 × 320 quads = 204.8k faces; islands of 20 × 20 quads, each in its own
    // cell of texture space; 4 materials by quadrant, all sampling one image.
    const n = 321;
    const cell = 1 / 16;
    const island = (i: number, j: number): number => Math.floor(i / 20) + 16 * Math.floor(j / 20);
    const s = (cell / 20) * 0.95; // a margin between the cells, so islands are separate
    const place = (k: number, moved: Set<number>): [number, number, number] => {
      const [ci, cj] = [k % 16, Math.floor(k / 16)];
      const shift = moved.has(k) ? 2 : 0; // moved islands go to a free area beyond u = 1
      return [shift + ci * cell - ci * 20 * s, cj * cell - cj * 20 * s, s];
    };
    const albedo = image('albedo');
    const materials = ['A', 'B', 'C', 'D'].map((name) => def(name, { baseColorTexture: tex(0) }));
    const spec = (moved: Set<number>, paint: (i: number, j: number) => number, extra: Partial<ILookSpec> = {}): ILookSpec => ({
      nx: n,
      ny: n,
      island,
      place: (k) => place(k, moved),
      materials,
      images: [albedo],
      material: (i, j) => paint(i, j),
      ...extra,
    });
    const quadrantPaint = (i: number, j: number): number => (i < 160 ? 0 : 1) + (j < 160 ? 0 : 2);
    const t0 = performance.now();
    const base = textured(spec(new Set(), quadrantPaint));
    // Ours: 30 islands moved in texture space, a 50 × 50-quad patch repainted, a roughness change.
    const oursMoved = new Set(Array.from({ length: 30 }, (_, k) => k * 3));
    const ours = textured(
      spec(oursMoved, (i, j) => (i >= 40 && i < 90 && j >= 40 && j < 90 ? 3 : quadrantPaint(i, j)), {
        materials: [{ ...materials[0], roughnessFactor: 0.2 }, ...materials.slice(1)],
      }),
    );
    // Theirs: 30 other islands moved, another patch repainted, 3000 local vertex edits.
    const theirsMoved = new Set(Array.from({ length: 30 }, (_, k) => 128 + k * 3));
    let seed = 11;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const moves: Record<number, [number, number, number]> = {};
    for (let k = 0; k < 3000; k++) moves[Math.floor(rand() * n * n)] = [0, 0, (rand() < 0.5 ? -1 : 1) * (0.05 + 0.2 * rand())];
    const theirs = textured(spec(theirsMoved, (i, j) => (i >= 200 && i < 250 && j >= 200 && j < 250 ? 2 : quadrantPaint(i, j)), { moves }));
    const built = performance.now() - t0;
    const t1 = performance.now();
    const geometryOnly = mergeMeshes(base, ours, theirs, { logger: silent, mergeAppearance: false });
    const tGeometry = performance.now() - t1;
    const t2 = performance.now();
    const r = mergeMeshes(base, ours, theirs, { logger: silent });
    const ms = performance.now() - t2;
    console.info(
      `[perf] merge with appearance ${base.vertexCount} vertices / ${base.faceCount} faces: ${ms.toFixed(0)} ms ` +
        `(geometry only ${tGeometry.toFixed(0)} ms; building the inputs ${built.toFixed(0)} ms)`,
    );
    expect(geometryOnly.clean).toBe(true);
    expect(r.clean).toBe(true);
    expect(r.stats.movedFromTheirs).toBe(Object.keys(moves).length);
    expect(r.appearance!.stats).toMatchObject({ uvFacesFromOurs: 30 * 800, uvFacesFromTheirs: 30 * 800, propertiesFromOurs: 1 });
    expect(r.appearance!.stats.facesReassignedFromOurs).toBe(50 * 50 * 2);
    expect(r.appearance!.stats.facesReassignedFromTheirs).toBe(50 * 50 * 2);
    expect(ms).toBeLessThan(15_000);
  });
});

describe('scene structure at ~100k vertices', () => {
  it('carrying glTF structure through the same merge costs O(faces); the move is carried as a transform; GLB written in seconds', () => {
    const { base, ours, theirs } = scenario();
    const structured = [withScene(base), withScene(ours, [3, 2, 0.5]), withScene(theirs)] as const;
    // Alternating runs, best of two each: a single pair mostly measures garbage collection and
    // warm-up order, not the (one) structure pass.
    let plainMs = Infinity;
    let ms = Infinity;
    let plain = mergeMeshes(base, ours, theirs, { logger: silent });
    let r = plain;
    for (let k = 0; k < 2; k++) {
      let t0 = performance.now();
      plain = mergeMeshes(base, ours, theirs, { logger: silent });
      plainMs = Math.min(plainMs, performance.now() - t0);
      t0 = performance.now();
      r = mergeMeshes(...structured, { logger: silent });
      ms = Math.min(ms, performance.now() - t0);
    }
    const t0 = performance.now();
    const bytes = writeGlb(r.merged);
    const writeMs = performance.now() - t0;
    console.info(`[perf] merge without / with scene structure: ${plainMs.toFixed(0)} / ${ms.toFixed(0)} ms; GLB write ${writeMs.toFixed(0)} ms (${(bytes.length / 1e6).toFixed(1)} MB)`);
    expect(r.clean).toBe(true);
    expect(Array.from(r.merged.positions)).toEqual(Array.from(plain.merged.positions));
    expect(r.merged.scene!.nodes[1].translation).toEqual([3, 2, 0.5]);
    expect(ms).toBeLessThan(plainMs * 1.5 + 500);
    expect(writeMs).toBeLessThan(10_000);
  });
});
