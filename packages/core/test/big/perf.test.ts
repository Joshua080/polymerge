/**
 * Million-triangle meshes: a closed, bumpy ellipsoid of 998,000 triangles (a scan-sized model)
 * through every diff tier, the metrics, and the writers and readers. The time bounds are
 * several times what a laptop needs (Tier 1 ≈ 1.5 s, Tier 2 ≈ 4 s, Tier 3 ≈ 10 s), so they
 * catch a lost index or a quadratic step, not a slow runner.
 */
import { describe, expect, it } from 'vitest';
import { diffMeshes } from '../../src/diff/index.js';
import { createMesh } from '../../src/mesh.js';
import { computeMetrics } from '../../src/metrics.js';
import { loadMesh } from '../../src/parsers/index.js';
import type { IMesh } from '../../src/types.js';
import { writeGlb, writeMesh, writeObj, writePly, writeStl, writeThreeMf } from '../../src/writers/index.js';

const silent = { info: () => {}, warn: () => {} };

/** Bumpy ellipsoid: `rings` latitude rings × 2·rings segments, optionally with a raised bump. */
function ellipsoid(rings: number, bump: [number, number, number] | null = null): IMesh {
  const segs = rings * 2;
  const R = 50;
  const pos: number[] = [0, 0, 0.5 * R];
  for (let i = 1; i < rings; i++) {
    const th = (Math.PI * i) / rings;
    for (let j = 0; j < segs; j++) {
      const ph = (2 * Math.PI * j) / segs;
      const r = R + 0.8 * Math.sin(5 * th) * Math.cos(7 * ph) + 0.3 * Math.sin(17 * th + 3 * ph);
      let x = r * Math.sin(th) * Math.cos(ph);
      let y = 0.7 * r * Math.sin(th) * Math.sin(ph);
      let z = 0.5 * r * Math.cos(th);
      if (bump) {
        const d = Math.hypot(x - bump[0], y - bump[1], z - bump[2]);
        if (d < 8) {
          const k = (1 + Math.cos((Math.PI * d) / 8)) / 2 * 2;
          x += (k * x) / r;
          y += (k * y) / r;
          z += (k * z) / r;
        }
      }
      pos.push(x, y, z);
    }
  }
  pos.push(0, 0, -0.5 * R);
  const faces: number[] = [];
  const idx = (i: number, j: number) => 1 + (i - 1) * segs + (j % segs);
  for (let j = 0; j < segs; j++) faces.push(0, idx(1, j), idx(1, j + 1));
  for (let i = 1; i < rings - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = idx(i, j);
      const b = idx(i, j + 1);
      const c = idx(i + 1, j);
      const d = idx(i + 1, j + 1);
      faces.push(a, c, d, a, d, b);
    }
  }
  const south = pos.length / 3 - 1;
  for (let j = 0; j < segs; j++) faces.push(south, idx(rings - 1, j + 1), idx(rings - 1, j));
  // Round through float32 as every loader does, so written files read back identically.
  return createMesh(Float64Array.from(Float32Array.from(pos)), faces, { metadata: { format: 'stl', sourceName: 'scan.stl' } });
}

/**
 * The same mesh as another exporter might write it: faces in a fixed pseudo-random order and
 * vertices renumbered by first appearance, as the loaders number them (defeats Tier 1).
 */
function shuffled(mesh: IMesh): IMesh {
  const n = mesh.faceCount;
  const order = Array.from({ length: n }, (_, i) => i);
  let seed = 7;
  for (let i = n - 1; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const k = seed % (i + 1);
    [order[i], order[k]] = [order[k], order[i]];
  }
  const renumber = new Int32Array(mesh.vertexCount).fill(-1);
  const positions = new Float64Array(mesh.positions.length);
  const faces = new Uint32Array(n * 3);
  let next = 0;
  order.forEach((o, i) => {
    for (let c = 0; c < 3; c++) {
      const v = mesh.faces[o * 3 + c];
      if (renumber[v] < 0) {
        renumber[v] = next;
        positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), next * 3);
        next++;
      }
      faces[i * 3 + c] = renumber[v];
    }
  });
  return createMesh(positions, faces);
}

const timed = <T>(f: () => T): [T, number] => {
  const t0 = performance.now();
  const r = f();
  return [r, performance.now() - t0];
};

describe('million-triangle meshes', () => {
  const base = ellipsoid(500);
  const edited = ellipsoid(500, [50, 0, 0]);

  it('the test model really is a million triangles, closed', () => {
    expect(base.faceCount).toBe(998_000);
    const [m, ms] = timed(() => computeMetrics(base));
    console.info(`[perf] metrics of ${base.faceCount} faces: ${ms.toFixed(0)} ms`);
    expect(m.closed).toBe(true);
    expect(m.volume).toBeGreaterThan(0);
    expect(ms).toBeLessThan(3000);
  });

  it('Tier 1: a local edit', () => {
    const [r, ms] = timed(() => diffMeshes(base, edited, { logger: silent }));
    console.info(`[perf] Tier 1, ${base.faceCount} faces: ${ms.toFixed(0)} ms`);
    expect(r.tier).toBe(1);
    expect(r.stats.vertices.moved).toBeGreaterThan(1000);
    expect(r.stats.vertices.added + r.stats.vertices.removed).toBe(0);
    expect(ms).toBeLessThan(10_000);
  });

  it('Tier 2: the same edit, faces re-ordered', () => {
    const [r, ms] = timed(() => diffMeshes(base, shuffled(edited), { logger: silent }));
    console.info(`[perf] Tier 2, ${base.faceCount} faces: ${ms.toFixed(0)} ms`);
    expect(r.tier).toBe(2);
    expect(r.stats.vertices.added + r.stats.vertices.removed).toBe(0);
    expect(ms).toBeLessThan(30_000);
  });

  it('Tier 3: a re-meshed version (different triangles)', () => {
    const remeshed = ellipsoid(490, [50, 0, 0]);
    const [r, ms] = timed(() => diffMeshes(base, remeshed, { logger: silent }));
    console.info(`[perf] Tier 3, ${base.faceCount} → ${remeshed.faceCount} faces: ${ms.toFixed(0)} ms`);
    expect(r.tier).toBe(3);
    expect(r.alignment.isIdentity).toBe(true);
    expect(ms).toBeLessThan(60_000);
  });

  it('every writer handles it, and the binary formats read back exactly', async () => {
    for (const [name, write] of [
      ['ply', writePly],
      ['3mf', writeThreeMf],
      ['glb', writeGlb],
      ['stl', (m: IMesh) => writeStl(m)],
    ] as const) {
      const [bytes, writeMs] = timed(() => write(base));
      const t0 = performance.now();
      const back = await loadMesh(bytes, { fileName: `scan.${name}` });
      const readMs = performance.now() - t0;
      console.info(`[perf] ${name}: ${(bytes.length / 1e6).toFixed(1)} MB, write ${writeMs.toFixed(0)} ms, read ${readMs.toFixed(0)} ms`);
      expect(back.faceCount).toBe(base.faceCount);
      expect(back.vertexCount).toBe(base.vertexCount);
    }
    // Text formats: written without trouble (their stock loaders are slower; not timed here).
    expect(writeObj(base).length).toBeGreaterThan(10_000_000);
    expect(writeMesh(base, 'gltf').length).toBeGreaterThan(10_000_000);
  });
});
