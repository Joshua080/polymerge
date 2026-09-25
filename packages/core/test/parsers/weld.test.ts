import { describe, expect, it } from 'vitest';
import { buildWeldedMesh, Uint32TripleMap } from '../../src/parsers/weld.js';
import { MeshLoadError, type IMaterial } from '../../src/types.js';
import { CUBE_EXPECTED_FACES, CUBE_EXPECTED_POSITIONS, cubeTriangles, soupPositions } from './helpers.js';

function checkGroupsCover(mesh: { groups: { faceStart: number; faceCount: number }[]; faceCount: number }): void {
  let next = 0;
  for (const g of mesh.groups) {
    expect(g.faceStart).toBe(next);
    expect(g.faceCount).toBeGreaterThan(0);
    next += g.faceCount;
  }
  expect(next).toBe(mesh.faceCount);
}

describe('buildWeldedMesh — exact weld', () => {
  it('welds a cube soup in first-appearance order', () => {
    const mesh = buildWeldedMesh({ format: 'stl', parts: [{ name: 'cube', positions: soupPositions(cubeTriangles()) }] });
    expect(mesh.vertexCount).toBe(8);
    expect(mesh.faceCount).toBe(12);
    expect(Array.from(mesh.positions)).toEqual(CUBE_EXPECTED_POSITIONS);
    expect(Array.from(mesh.faces)).toEqual(CUBE_EXPECTED_FACES);
    expect(mesh.positions).toBeInstanceOf(Float64Array);
    expect(mesh.faces).toBeInstanceOf(Uint32Array);
    expect(mesh.metadata.sourceVertexCount).toBe(36);
    expect(mesh.metadata.sourceFaceCount).toBe(12);
    expect(mesh.metadata.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(mesh.faceMaterials).toBeUndefined();
    expect(mesh.vertexIds).toBeUndefined();
    expect(mesh.materials).toEqual([]);
  });

  it('keys on float32 values: -0 equals +0, float64 noise below float32 precision welds', () => {
    const mesh = buildWeldedMesh({
      format: 'obj',
      parts: [
        {
          name: 'g',
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, -0, -0, -0, 0, 1, 0, 1 + 1e-12, 0, 0, 0.1, 0.2, 0.3, 0.1, 0.2, 0.3000000001, 5, 5, 5],
        },
      ],
    });
    // Triangles: (0,1,2), (-0 → 0, 2, 1+1e-12 → 1), (0.1.., 0.1.., 5) → degenerate after float32 rounding.
    expect(mesh.vertexCount).toBe(3);
    expect(Array.from(mesh.faces)).toEqual([0, 1, 2, 0, 2, 1]);
    expect(Object.is(mesh.positions[0], 0)).toBe(true);
    expect(mesh.metadata.degenerateFacesDropped).toBe(1);
  });

  it('stores float32-exact values in the Float64Array', () => {
    const mesh = buildWeldedMesh({ format: 'obj', parts: [{ name: 'g', positions: [0.1, 0.2, 0.3, 1, 0, 0, 0, 1, 0] }] });
    expect(mesh.positions[0]).toBe(Math.fround(0.1));
    expect(mesh.positions[1]).toBe(Math.fround(0.2));
    expect(mesh.positions[2]).toBe(Math.fround(0.3));
  });

  it('handles indexed parts and applies first-appearance order to the triangle stream, not the vertex buffer', () => {
    const mesh = buildWeldedMesh({
      format: 'glb',
      parts: [{ name: 'q', positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], indices: [2, 3, 0, 2, 0, 1] }],
    });
    expect(Array.from(mesh.faces)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(Array.from(mesh.positions)).toEqual([1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
    expect(mesh.metadata.sourceVertexCount).toBe(4);
  });

  it('never keeps a vertex that only a dropped triangle referenced, and renumbers canonically', () => {
    const A = [5, 5, 5];
    const B = [9, 9, 9];
    const tri1 = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const tri2 = [...B, 0, 0, 0, 0, 1, 0];
    // Degenerate first: (A, A, B) introduces A and B before the valid triangles.
    const withDegenerate = buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions: [...A, ...A, ...B, ...tri1, ...tri2] }] });
    const without = buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions: [...tri1, ...tri2] }] });
    expect(withDegenerate.metadata.degenerateFacesDropped).toBe(1);
    expect(withDegenerate.metadata.sourceFaceCount).toBe(3);
    expect(withDegenerate.faceCount).toBe(2);
    expect(withDegenerate.vertexCount).toBe(4); // A is gone
    expect(Array.from(withDegenerate.positions)).toEqual(Array.from(without.positions));
    expect(Array.from(withDegenerate.faces)).toEqual(Array.from(without.faces));
    expect(withDegenerate.metadata.warnings.some((w) => w.includes('degenerate'))).toBe(true);
  });

  it('drops triangles with repeated indices, collinear-but-distinct triangles are kept', () => {
    const mesh = buildWeldedMesh({
      format: 'glb',
      parts: [{ name: 'g', positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0], indices: [0, 1, 1, 0, 1, 2, 0, 1, 3] }],
    });
    expect(mesh.faceCount).toBe(2); // (0,1,1) dropped; zero-area (0,1,2) has 3 distinct vertices → kept
    expect(mesh.metadata.degenerateFacesDropped).toBe(1);
  });

  it('drops non-finite and out-of-range triangles and counts them', () => {
    const mesh = buildWeldedMesh({
      format: 'glb',
      parts: [
        {
          name: 'g',
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 0, Infinity, 1, 1],
          indices: [0, 1, 2, 0, 1, 3, 0, 1, 4, 0, 1, 7],
        },
      ],
    });
    expect(mesh.faceCount).toBe(1);
    expect(mesh.vertexCount).toBe(3);
    expect(mesh.metadata.degenerateFacesDropped).toBe(3);
    expect(mesh.metadata.extras).toMatchObject({ invalidFacesDropped: 3 });
    expect(mesh.faceCount).toBe(mesh.metadata.sourceFaceCount - mesh.metadata.degenerateFacesDropped);
  });

  it('builds contiguous groups, removes emptied groups, and keeps faceMaterials aligned', () => {
    const materials: IMaterial[] = [{ name: 'unused' }, { name: 'red' }, { name: 'blue' }];
    const t = (x: number): number[] => [x, 0, 0, x + 1, 0, 0, x, 1, 0];
    const degenerate = [7, 7, 7, 7, 7, 7, 8, 8, 8];
    const mesh = buildWeldedMesh({
      format: 'obj',
      materials,
      parts: [
        { name: 'first', positions: [...t(0), ...degenerate, ...t(10)], faceMaterials: [2, 1, 1] },
        { name: 'emptied', positions: degenerate, material: 0 },
        { name: 'third', positions: [...t(20), ...t(30)], material: 1 },
        { name: 'none', positions: t(40) },
      ],
    });
    expect(mesh.groups).toEqual([
      { name: 'first', faceStart: 0, faceCount: 2 },
      { name: 'third', faceStart: 2, faceCount: 2, materialIndex: 1 },
      { name: 'none', faceStart: 4, faceCount: 1 },
    ]);
    checkGroupsCover(mesh);
    // Only referenced materials survive, in first-use order: blue, red.
    expect(mesh.materials).toEqual([{ name: 'blue' }, { name: 'red' }]);
    expect(Array.from(mesh.faceMaterials!)).toEqual([0, 1, 1, 1, -1]);
    expect(mesh.metadata.degenerateFacesDropped).toBe(2);
  });

  it('maps vertex ids: first non-null id wins, null elsewhere, conflicts are reported', () => {
    const mesh = buildWeldedMesh({
      format: 'glb',
      parts: [
        { name: 'noIds', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
        { name: 'ids', positions: [0, 0, 0, 0, 1, 0, 1, 1, 0], vertexIds: ['a', 'b', 'c'], indices: [0, 2, 1] },
        { name: 'more', positions: [1, 1, 0, 0, 1, 0, 2, 2, 2], vertexIds: ['x', null, 'z'] },
      ],
    });
    // Vertices: 0=(0,0,0) 1=(1,0,0) 2=(0,1,0) 3=(1,1,0) 4=(2,2,2)
    expect(mesh.vertexIds).toEqual(['a', null, 'b', 'c', 'z']);
    expect(mesh.metadata.warnings.some((w) => w.includes('vertex id'))).toBe(true);
  });

  it('omits vertexIds when no part carries ids', () => {
    const mesh = buildWeldedMesh({ format: 'glb', parts: [{ name: 'g', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }] });
    expect('vertexIds' in mesh).toBe(false);
  });

  it('throws MeshLoadError when nothing survives', () => {
    expect(() => buildWeldedMesh({ format: 'stl', parts: [] })).toThrow(MeshLoadError);
    expect(() => buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions: [1, 1, 1, 1, 1, 1, 2, 2, 2] }] })).toThrow(
      /degenerate/,
    );
    expect(() => buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions: [0, 0, 0] }], weldEpsilon: -1 })).toThrow(
      MeshLoadError,
    );
  });

  it('warns about trailing vertices that do not form a triangle', () => {
    const mesh = buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5] }] });
    expect(mesh.faceCount).toBe(1);
    expect(mesh.metadata.warnings.some((w) => w.includes('trailing vertex'))).toBe(true);
  });
});

describe('buildWeldedMesh — epsilon weld', () => {
  const eps = 1e-3;
  // Two triangles sharing an edge whose second copy is jittered by < eps.
  const jitter = 4e-4;
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1 + jitter, -jitter, jitter, 0 + jitter, 1, -jitter, 1, 1, 0];

  it('keeps near-duplicates apart with weldEpsilon = 0', () => {
    const mesh = buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions }] });
    expect(mesh.vertexCount).toBe(6);
    expect(mesh.metadata.weldEpsilon).toBe(0);
  });

  it('merges corners within epsilon into the earliest vertex (seed position kept)', () => {
    const mesh = buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions }], weldEpsilon: eps });
    expect(mesh.vertexCount).toBe(4);
    expect(Array.from(mesh.faces)).toEqual([0, 1, 2, 1, 2, 3]);
    expect(Array.from(mesh.positions.subarray(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(mesh.metadata.weldEpsilon).toBe(eps);
  });

  it('uses inclusive Euclidean distance and is not transitive (distance to seeds only)', () => {
    const e = 0.5;
    // Seeds along x: A=0; B=0.4 (≤ e → joins A); C=0.8 (0.8 from A → new vertex even though 0.4 from B).
    const mesh = buildWeldedMesh({
      format: 'stl',
      weldEpsilon: e,
      parts: [
        {
          name: 'g',
          positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0.4, 0, 0, 10, 0, 0, 0, 10, 0, 0.8, 0, 0, 10, 0, 0, 0, 10, 0],
        },
      ],
    });
    expect(Array.from(mesh.faces)).toEqual([0, 1, 2, 0, 1, 2, 3, 1, 2]);
    // Diagonal distance exactly at the limit merges; just beyond does not.
    const d = e / Math.sqrt(3);
    const onLimit = buildWeldedMesh({
      format: 'stl',
      weldEpsilon: 0.5,
      parts: [{ name: 'g', positions: [1, 1, 1, 10, 0, 0, 0, 10, 0, 1 + d * 0.999, 1 + d * 0.999, 1 + d * 0.999, 10, 0, 0, 0, 10, 0] }],
    });
    expect(onLimit.vertexCount).toBe(3);
  });

  it('merges into the earliest of several candidates and handles negative / cell-boundary coordinates', () => {
    const e = 0.1;
    const mesh = buildWeldedMesh({
      format: 'stl',
      weldEpsilon: e,
      parts: [
        {
          name: 'g',
          positions: [
            -0.05, -0.05, -0.05, 5, 5, 5, -5, 5, 5, // seed S0 near the origin (straddles cell boundaries)
            0.04, 0.04, 0.04, 5, -5, 5, -5, -5, 5, // S1: 0.156 from S0 → new seed
            -0.0, 0.0, 0.0, 6, 6, 6, -6, 6, 6, // origin: 0.087 from S0 and 0.069 from S1 → earliest (S0)
          ],
        },
      ],
    });
    expect(mesh.faces[6]).toBe(0);
    expect(mesh.vertexCount).toBe(3 + 3 + 2);
  });

  it('epsilon weld can create degenerate triangles, which are dropped', () => {
    const mesh = buildWeldedMesh({
      format: 'stl',
      weldEpsilon: 0.01,
      parts: [{ name: 'g', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0.005, 0, 0, 0, 1, 0] }],
    });
    expect(mesh.faceCount).toBe(1);
    expect(mesh.metadata.degenerateFacesDropped).toBe(1);
  });

  it('matches the exact weld on data without near-duplicates', () => {
    const soup = soupPositions(cubeTriangles());
    const exact = buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions: soup }] });
    const approx = buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions: soup }], weldEpsilon: 0.25 });
    expect(Array.from(approx.positions)).toEqual(Array.from(exact.positions));
    expect(Array.from(approx.faces)).toEqual(Array.from(exact.faces));
  });

  it('agrees with a brute-force reference on random clustered points', () => {
    let seed = 42;
    const rand = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const e = 0.05;
    const pts: number[] = [];
    for (let i = 0; i < 3 * 600; i++) {
      const cx = Math.floor(rand() * 5) * 0.07;
      pts.push(cx + rand() * 0.06 - 0.03, rand() * 0.2 - 0.1, (rand() - 0.5) * 0.1);
    }
    const mesh = buildWeldedMesh({ format: 'stl', parts: [{ name: 'g', positions: pts }], weldEpsilon: e });
    // Reference: greedy "earliest seed within e" over float32 values, then drop degenerates,
    // then renumber in first appearance order among kept triangles.
    const seeds: number[][] = [];
    const prov: number[] = [];
    for (let i = 0; i < pts.length; i += 3) {
      const p = [Math.fround(pts[i]), Math.fround(pts[i + 1]), Math.fround(pts[i + 2])];
      let best = seeds.findIndex((s) => (s[0] - p[0]) ** 2 + (s[1] - p[1]) ** 2 + (s[2] - p[2]) ** 2 <= e * e);
      if (best < 0) {
        best = seeds.length;
        seeds.push(p);
      }
      prov.push(best);
    }
    const kept: number[] = [];
    for (let t = 0; t < prov.length; t += 3) {
      const [a, b, c] = prov.slice(t, t + 3);
      if (a !== b && b !== c && a !== c) kept.push(a, b, c);
    }
    const remap = new Map<number, number>();
    const faces = kept.map((p) => {
      if (!remap.has(p)) remap.set(p, remap.size);
      return remap.get(p)!;
    });
    expect(Array.from(mesh.faces)).toEqual(faces);
    const positions: number[] = [];
    for (const [p] of [...remap.entries()].sort((x, y) => x[1] - y[1])) positions.push(...seeds[p]);
    expect(Array.from(mesh.positions)).toEqual(positions);
  });
});

describe('Uint32TripleMap', () => {
  it('stores, finds and survives growth', () => {
    const map = new Uint32TripleMap(4);
    for (let i = 0; i < 5000; i++) expect(map.getOrInsert(i, i * 7, 0xffffffff - i, i)).toBe(i);
    for (let i = 0; i < 5000; i++) expect(map.get(i, i * 7, 0xffffffff - i)).toBe(i);
    expect(map.getOrInsert(3, 21, 0xffffffff - 3, 99)).toBe(3);
    expect(map.get(1, 2, 3)).toBe(-1);
    expect(map.size).toBe(5000);
  });
});
