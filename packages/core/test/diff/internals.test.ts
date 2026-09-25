/**
 * Unit tests for the diff engine's building blocks, each checked against a brute-force
 * or closed-form reference.
 */
import { describe, expect, it } from 'vitest';
import { buildAdjacency, buildVertexFaces, hasNeighbor, meanEdgeLengths } from '../../src/diff/adjacency.js';
import { FaceSet } from '../../src/diff/faceset.js';
import { PairHeap } from '../../src/diff/heap.js';
import {
  applyRigid,
  composeRigid,
  det3,
  hornRigid,
  invertRigid,
  jacobiEigenSymmetric,
  mat4ToRigid,
  quaternionToMatrix,
  rigidToMat4,
  rotationAngle,
  surfaceMoments,
} from '../../src/diff/linalg.js';
import { mulberry32, sampleIndices } from '../../src/diff/prng.js';
import { closestPointOnTriangle, KdTree, TriangleBvh } from '../../src/diff/spatial.js';
import { computeBounds, transformPoint } from '../../src/mesh.js';
import { asymmetricSolid, axisAngle, grid } from './util.js';

const rand = mulberry32(12345);
const randomPoints = (n: number, scale = 10): Float64Array => {
  const p = new Float64Array(n * 3);
  for (let i = 0; i < p.length; i++) p[i] = (rand() - 0.5) * scale;
  return p;
};

describe('linalg', () => {
  it('Jacobi diagonalises symmetric matrices: A·v = λ·v, orthonormal, sorted descending', () => {
    for (const n of [3, 4]) {
      for (let trial = 0; trial < 20; trial++) {
        const a = new Float64Array(n * n);
        for (let i = 0; i < n; i++) for (let j = i; j < n; j++) a[i * n + j] = a[j * n + i] = rand() * 4 - 2;
        const { values, vectors } = jacobiEigenSymmetric(a, n);
        for (let k = 1; k < n; k++) expect(values[k]).toBeLessThanOrEqual(values[k - 1]);
        for (let k = 0; k < n; k++) {
          for (let i = 0; i < n; i++) {
            let av = 0;
            for (let j = 0; j < n; j++) av += a[i * n + j] * vectors[j * n + k];
            expect(av).toBeCloseTo(values[k] * vectors[i * n + k], 12);
          }
          for (let l = 0; l < n; l++) {
            let dot = 0;
            for (let i = 0; i < n; i++) dot += vectors[i * n + k] * vectors[i * n + l];
            expect(dot).toBeCloseTo(k === l ? 1 : 0, 12);
          }
        }
      }
    }
  });

  it('Horn recovers random rigid transforms exactly (incl. ~180° rotations)', () => {
    for (const deg of [0, 1e-4, 10, 90, 179.9, 180]) {
      const R = axisAngle([rand() - 0.5, rand() - 0.5, rand() - 0.5], deg);
      const t = [rand() * 100, -rand() * 50, rand()];
      const src = randomPoints(50);
      const dst = new Float64Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        const [x, y, z] = [src[i], src[i + 1], src[i + 2]];
        dst[i] = R[0] * x + R[1] * y + R[2] * z + t[0];
        dst[i + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
        dst[i + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
      }
      const g = hornRigid(src, dst, 50);
      for (let k = 0; k < 9; k++) expect(g.r[k]).toBeCloseTo(R[k], 10);
      for (let k = 0; k < 3; k++) expect(g.t[k]).toBeCloseTo(t[k], 8);
      expect(det3(g.r)).toBeCloseTo(1, 12);
    }
  });

  it('rigid helpers: inverse, compose, Mat4 round trip, rotation angle', () => {
    const g = { r: Float64Array.from(axisAngle([1, 2, 3], 30)), t: Float64Array.of(5, -3, 2) };
    const id = composeRigid(g, invertRigid(g));
    for (let k = 0; k < 9; k++) expect(id.r[k]).toBeCloseTo(k % 4 === 0 ? 1 : 0, 14);
    for (let k = 0; k < 3; k++) expect(id.t[k]).toBeCloseTo(0, 13);
    const m = rigidToMat4(g);
    const out = new Float64Array(3);
    applyRigid(g, 1, 2, 3, out);
    const viaMat = transformPoint(m, [1, 2, 3]);
    for (let k = 0; k < 3; k++) expect(viaMat[k]).toBeCloseTo(out[k], 13);
    const back = mat4ToRigid(m);
    expect(Array.from(back.r)).toEqual(Array.from(g.r));
    expect((rotationAngle(g.r) * 180) / Math.PI).toBeCloseTo(30, 10);
    expect((rotationAngle(quaternionToMatrix(0, 1, 0, 0)) * 180) / Math.PI).toBeCloseTo(180, 10);
  });

  it('surface moments are tessellation-independent (area weighted)', () => {
    const a = surfaceMoments(grid(5, 5, { spacing: 0.25 }).positions, grid(5, 5, { spacing: 0.25 }).faces, computeBounds([0, 0, 0, 1, 1, 0]));
    const fine = grid(41, 41, { spacing: 0.025 });
    const b = surfaceMoments(fine.positions, fine.faces, computeBounds(fine.positions));
    for (let k = 0; k < 3; k++) expect(a.c[k]).toBeCloseTo(b.c[k], 12);
    for (let k = 0; k < 9; k++) expect(a.cov[k]).toBeCloseTo(b.cov[k], 12);
    expect(a.cov[0]).toBeCloseTo(1 / 12, 12); // variance of U(0, 1)
    expect(a.area).toBeCloseTo(1, 12);
  });
});

describe('spatial', () => {
  it('KdTree.nearest matches brute force, honours radius and skip mask, ties → lowest index', () => {
    const pts = randomPoints(3000);
    // Duplicate some points to exercise tie-breaking.
    for (let i = 0; i < 30; i++) pts.copyWithin((2000 + i) * 3, i * 3, i * 3 + 3);
    const kd = new KdTree(pts);
    const skip = new Uint8Array(3000);
    for (let i = 0; i < 3000; i += 7) skip[i] = 1;
    for (let q = 0; q < 400; q++) {
      const [x, y, z] = q < 30 ? [pts[q * 3], pts[q * 3 + 1], pts[q * 3 + 2]] : [(rand() - 0.5) * 12, (rand() - 0.5) * 12, (rand() - 0.5) * 12];
      const r2 = q % 3 === 0 ? 0.5 : Infinity;
      const useSkip = q % 2 === 0;
      let best = -1;
      let bestD = r2;
      for (let i = 0; i < 3000; i++) {
        if (useSkip && skip[i]) continue;
        const d = (pts[i * 3] - x) ** 2 + (pts[i * 3 + 1] - y) ** 2 + (pts[i * 3 + 2] - z) ** 2;
        if (d < bestD || (d === bestD && (best < 0 || i < best))) {
          bestD = d;
          best = i;
        }
      }
      expect(kd.nearest(x, y, z, r2, useSkip ? skip : null)).toBe(best);
      if (best >= 0) expect(kd.lastDist2).toBe(bestD);
      let cnt = 0;
      for (let i = 0; i < 3000; i++) if ((pts[i * 3] - x) ** 2 + (pts[i * 3 + 1] - y) ** 2 + (pts[i * 3 + 2] - z) ** 2 <= 0.5) cnt++;
      expect(kd.countWithin(x, y, z, 0.5)).toBe(cnt);
    }
    expect(new KdTree(new Float64Array(0)).nearest(0, 0, 0)).toBe(-1);
  });

  it('closestPointOnTriangle covers all Voronoi regions and degenerate triangles', () => {
    const T = [0, 0, 0, 1, 0, 0, 0, 1, 0] as const;
    const cp = (x: number, y: number, z: number): number => closestPointOnTriangle(x, y, z, ...T);
    expect(cp(0.2, 0.2, 1)).toBeCloseTo(1, 14); // face interior
    expect(cp(-1, -1, 0)).toBeCloseTo(2, 14); // vertex a
    expect(cp(2, 0, 0)).toBeCloseTo(1, 14); // vertex b
    expect(cp(0, 3, 0)).toBeCloseTo(4, 14); // vertex c
    expect(cp(0.5, -1, 0)).toBeCloseTo(1, 14); // edge ab
    expect(cp(-2, 0.5, 0)).toBeCloseTo(4, 14); // edge ac
    expect(cp(1, 1, 0)).toBeCloseTo(0.5, 14); // edge bc
    // Collinear (zero-area) triangle falls back to segments.
    expect(closestPointOnTriangle(0.5, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0)).toBeCloseTo(1, 14);
  });

  it('TriangleBvh.closest matches brute force over all triangles', () => {
    const mesh = asymmetricSolid(24, 12);
    const bvh = new TriangleBvh(mesh.positions, mesh.faces);
    const p = mesh.positions;
    const f = mesh.faces;
    for (let q = 0; q < 300; q++) {
      const x = (rand() - 0.5) * 6;
      const y = (rand() - 0.5) * 4;
      const z = (rand() - 0.5) * 3;
      let best = Infinity;
      for (let t = 0; t < mesh.faceCount; t++) {
        const a = f[t * 3] * 3;
        const b = f[t * 3 + 1] * 3;
        const c = f[t * 3 + 2] * 3;
        best = Math.min(best, closestPointOnTriangle(x, y, z, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]));
      }
      expect(bvh.closest(x, y, z)).toBeGreaterThanOrEqual(0);
      expect(bvh.lastDist2).toBeCloseTo(best, 12);
      const lp = bvh.lastPoint;
      expect((lp[0] - x) ** 2 + (lp[1] - y) ** 2 + (lp[2] - z) ** 2).toBeCloseTo(best, 12);
      // Radius cap: nothing within a radius smaller than the true distance.
      if (best > 1e-6) expect(bvh.closest(x, y, z, best * 0.99)).toBe(-1);
    }
  });
});

describe('topology helpers', () => {
  it('FaceSet compares unordered triples exactly', () => {
    const fs = new FaceSet(Uint32Array.from([0, 1, 2, 2, 3, 0, 5, 4, 3, 2, 1, 0]));
    expect(fs.size).toBe(3);
    for (const [a, b, c] of [[0, 1, 2], [2, 0, 1], [1, 2, 0], [0, 2, 1], [3, 0, 2], [4, 3, 5]]) expect(fs.has(a, b, c)).toBe(true);
    for (const [a, b, c] of [[0, 1, 3], [1, 2, 3], [0, 4, 5], [6, 7, 8]]) expect(fs.has(a, b, c)).toBe(false);
    const big = grid(300, 300);
    const set = new FaceSet(big.faces);
    expect(set.size).toBe(big.faceCount);
    for (let f = 0; f < big.faceCount; f += 997) expect(set.has(big.faces[f * 3 + 2], big.faces[f * 3], big.faces[f * 3 + 1])).toBe(true);
  });

  it('CSR adjacency and incident faces', () => {
    const g = grid(3, 3); // 9 vertices, centre = 4
    const adj = buildAdjacency(9, g.faces);
    const nb = (v: number): number[] => Array.from(adj.neighbors.subarray(adj.offsets[v], adj.offsets[v + 1]));
    expect(nb(4)).toEqual([0, 1, 3, 5, 7, 8]);
    expect(nb(0)).toEqual([1, 3, 4]);
    expect(hasNeighbor(adj, 4, 8)).toBe(true);
    expect(hasNeighbor(adj, 4, 2)).toBe(false);
    const vf = buildVertexFaces(9, g.faces);
    expect(vf.offsets[5] - vf.offsets[4]).toBe(6);
    const L = meanEdgeLengths(g.positions, adj);
    expect(L[0]).toBeCloseTo((1 + 1 + Math.SQRT2) / 3, 14);
  });

  it('PairHeap pops in (cost, a, b) order', () => {
    const h = new PairHeap(2);
    const items: [number, number, number][] = [];
    for (let i = 0; i < 500; i++) items.push([Math.floor(rand() * 20) / 4, Math.floor(rand() * 5), Math.floor(rand() * 5)]);
    for (const [c, a, b] of items) h.push(c, a, b);
    items.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    const out: [number, number, number][] = [];
    while (h.pop()) out.push([h.topCost, h.topA, h.topB]);
    expect(out).toEqual(items);
  });

  it('seeded sampling is deterministic, distinct and sorted', () => {
    const a = sampleIndices(10000, 500, 42);
    expect(Array.from(a)).toEqual(Array.from(sampleIndices(10000, 500, 42)));
    expect(new Set(a).size).toBe(500);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThan(a[i - 1]);
    expect(sampleIndices(10, 50, 1).length).toBe(10);
  });
});
