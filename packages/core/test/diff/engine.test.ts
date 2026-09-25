/**
 * Engine-level behaviour: logging contract, forceTier, options, determinism, edge cases,
 * invariants across scenarios and the JSON round trip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deserializeDiff, diffMeshes, serializeDiff } from '../../src/diff/index.js';
import { createMesh, describeVertexChange } from '../../src/mesh.js';
import { TIER_NAMES, VertexStatus, type IDiffResult } from '../../src/types.js';
import {
  assertInvariants,
  asymmetricSolid,
  axisAngle,
  captureLogger,
  grid,
  permuteMesh,
  randomPermutation,
  silent,
  transformMesh,
  withMoves,
} from './util.js';

const solid = asymmetricSolid(24, 12);
const permuted = permuteMesh(withMoves(solid, { 5: [0, 0.01, 0] }), randomPermutation(solid.vertexCount, 1), 2);
const rotated = permuteMesh(transformMesh(solid, axisAngle([1, 1, 0], 30), [2, 0, 1]), randomPermutation(solid.vertexCount, 3));

/** Result without wall-clock fields, for determinism comparisons. */
const timeless = (r: IDiffResult): unknown => ({ ...r, durationMs: 0, attempts: r.attempts.map((a) => ({ ...a, durationMs: 0 })) });

describe('logging contract', () => {
  it('logs the header, one line per attempt and the resolving tier', () => {
    const cap = captureLogger();
    diffMeshes(solid, permuted, { logger: cap.logger });
    expect(cap.info).toHaveLength(4);
    expect(cap.info[0]).toBe(
      `[polymerge] diff: base "sphere" (${solid.vertexCount} v / ${solid.faceCount} f) → target "sphere" (${solid.vertexCount} v / ${solid.faceCount} f)`,
    );
    expect(cap.info[1]).toMatch(/^\[polymerge\] Tier 1 \(index\/ID\): REJECTED score=0\.\d{3} threshold=0\.950 — .+ \(\d+\.\d ms\)$/);
    expect(cap.info[2]).toMatch(/^\[polymerge\] Tier 2 \(topological\): ACCEPTED score=0\.9\d\d threshold=0\.600 — .+ \(\d+\.\d ms\)$/);
    expect(cap.info[3]).toBe(`[polymerge] ✔ correspondence resolved by Tier 2 — ${TIER_NAMES[2]}`);
    expect(cap.warn).toHaveLength(0);
  });

  it('logs all three attempts when falling through to Tier 3', () => {
    const cap = captureLogger();
    diffMeshes(solid, rotated, { logger: cap.logger });
    expect(cap.info.map((l) => l.match(/Tier (\d) \([^)]+\): (ACCEPTED|REJECTED)/)?.slice(1, 3).join(':')).filter(Boolean)).toEqual([
      '1:REJECTED',
      '2:REJECTED',
      '3:ACCEPTED',
    ]);
    expect(cap.info[3]).toMatch(/threshold=0\.000 — .*quality good/);
    expect(cap.info.at(-1)).toBe(`[polymerge] ✔ correspondence resolved by Tier 3 — ${TIER_NAMES[3]}`);
  });

  describe('default sink', () => {
    afterEach(() => vi.restoreAllMocks());
    it('falls back to console when no logger is given', () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      diffMeshes(solid, solid);
      expect(info).toHaveBeenCalledTimes(3);
      expect(String(info.mock.calls[2][0])).toContain('resolved by Tier 1');
    });
  });
});

describe('forceTier', () => {
  it('runs exactly the forced tier and accepts it', () => {
    for (const tier of [1, 2, 3] as const) {
      const cap = captureLogger();
      const r = diffMeshes(solid, solid, { logger: cap.logger, forceTier: tier });
      assertInvariants(r, solid, solid);
      expect(r.tier).toBe(tier);
      expect(r.tierName).toBe(TIER_NAMES[tier]);
      expect(r.attempts).toHaveLength(1);
      expect(r.attempts[0].accepted).toBe(true);
      expect(r.attempts[0].reason).toMatch(/^forced via forceTier; /);
      expect(r.stats.vertices.unchanged).toBe(solid.vertexCount);
      expect(cap.info.at(-1)).toContain(`resolved by Tier ${tier}`);
    }
  });

  it('accepts a forced tier even when its score is below the threshold', () => {
    const r = diffMeshes(solid, permuted, { logger: silent, forceTier: 1 });
    expect(r.tier).toBe(1);
    expect(r.attempts[0].score).toBeLessThan(0.05);
    expect(r.attempts[0].accepted).toBe(true);
    assertInvariants(r, solid, permuted);
  });
});

describe('options', () => {
  it('resolves default epsilons from the larger bounding-box diagonal', () => {
    const small = grid(3, 3); // diagonal √8
    const big = grid(5, 5); // diagonal √32
    const r = diffMeshes(small, big, { logger: silent });
    expect(r.moveEpsilon).toBeCloseTo(1e-6 * Math.sqrt(32), 15);
    expect(r.surfaceTolerance).toBeCloseTo(0.01 * Math.sqrt(32), 15);
  });

  it('honours moveEpsilon / thresholds overrides', () => {
    const moved = withMoves(solid, { 3: [0, 0, 1e-3] });
    expect(diffMeshes(solid, moved, { logger: silent }).stats.vertices.moved).toBe(1);
    expect(diffMeshes(solid, moved, { logger: silent, moveEpsilon: 1e-2 }).stats.vertices.moved).toBe(0);
    // A zero Tier 1 threshold accepts even a scrambled index mapping.
    expect(diffMeshes(solid, permuted, { logger: silent, thresholds: { tier1: 0 } }).tier).toBe(1);
    // `permuted` has one tangentially slid vertex, so its Tier 2 score is just below 1:
    // a threshold of 1 pushes it on to Tier 3, a lenient one keeps it at Tier 2.
    const strict = diffMeshes(solid, permuted, { logger: silent, thresholds: { tier2: 1 } });
    expect(strict.attempts[1].score).toBeLessThan(1);
    expect(strict.attempts[1].threshold).toBe(1);
    expect(strict.tier).toBe(3);
    expect(diffMeshes(solid, permuted, { logger: silent, thresholds: { tier2: 0.5 } }).tier).toBe(2);
  });

  it('rejects invalid options', () => {
    expect(() => diffMeshes(solid, solid, { logger: silent, moveEpsilon: -1 })).toThrow(RangeError);
    expect(() => diffMeshes(solid, solid, { logger: silent, surfaceTolerance: Number.NaN })).toThrow(RangeError);
    expect(() => diffMeshes(solid, solid, { logger: silent, thresholds: { tier1: 1.5 } })).toThrow(RangeError);
    expect(() => diffMeshes(solid, solid, { logger: silent, icp: { maxIterations: 0 } })).toThrow(RangeError);
    expect(() => diffMeshes(solid, solid, { logger: silent, forceTier: 4 as never })).toThrow(RangeError);
    const broken = { ...solid, vertexCount: solid.vertexCount + 1 };
    expect(() => diffMeshes(broken, solid, { logger: silent })).toThrow(RangeError);
  });

  it('respects icp.maxIterations', () => {
    const r = diffMeshes(solid, rotated, { logger: silent, icp: { maxIterations: 1 } });
    expect(r.tier).toBe(3);
    expect(r.alignment.iterations).toBeLessThanOrEqual(2); // ≤ 1 point-to-point + 1 point-to-plane
  });
});

describe('robustness', () => {
  it('is deterministic: identical inputs give identical results', () => {
    for (const target of [solid, permuted, rotated]) {
      const a = diffMeshes(solid, target, { logger: silent });
      const b = diffMeshes(solid, target, { logger: silent });
      expect(timeless(b)).toEqual(timeless(a));
    }
  });

  it('handles empty meshes', () => {
    const empty = createMesh([], []);
    const g = grid(3, 3);
    const add = diffMeshes(empty, g, { logger: silent });
    assertInvariants(add, empty, g);
    expect(add.stats.vertices).toEqual({ unchanged: 0, moved: 0, added: 9, removed: 0 });
    expect(add.stats.faces.added).toBe(8);
    const rem = diffMeshes(g, empty, { logger: silent });
    expect(rem.stats.vertices.removed).toBe(9);
    const none = diffMeshes(empty, empty, { logger: silent });
    expect(none.tier).toBe(1);
    for (const tier of [2, 3] as const) {
      const r = diffMeshes(empty, g, { logger: silent, forceTier: tier });
      assertInvariants(r, empty, g);
      expect(r.stats.vertices.added).toBe(9);
    }
  });

  it('keeps every correspondence invariant across tiers and scenarios', () => {
    const scenarios = [
      [solid, solid],
      [solid, withMoves(solid, { 1: [1, 1, 1] })],
      [solid, permuted],
      [solid, rotated],
      [grid(10, 10), grid(13, 13, { spacing: 0.75 })],
    ] as const;
    for (const [a, b] of scenarios) {
      for (const forceTier of [undefined, 1, 2, 3] as const) {
        assertInvariants(diffMeshes(a, b, { logger: silent, forceTier }), a, b);
      }
    }
  });

  it('describeVertexChange agrees with the result (from/to/delta in target space)', () => {
    const r = diffMeshes(solid, rotated, { logger: silent });
    const t = 17;
    const ch = describeVertexChange(r, solid, rotated, 'target', t);
    expect(ch.status).toBe(VertexStatus.Unchanged);
    expect(Math.hypot(...ch.delta!)).toBeLessThan(1e-9);
  });
});

describe('serialisation', () => {
  it('round-trips every field losslessly (typed-array classes included)', () => {
    for (const target of [permuted, rotated]) {
      const r = diffMeshes(solid, target, { logger: silent });
      const back = deserializeDiff(serializeDiff(r));
      expect(back).toEqual(r);
      expect(back.baseToTarget).toBeInstanceOf(Int32Array);
      expect(back.targetToBase).toBeInstanceOf(Int32Array);
      expect(back.displacement).toBeInstanceOf(Float32Array);
      expect(back.baseVertexStatus).toBeInstanceOf(Uint8Array);
      expect(back.targetFaceStatus).toBeInstanceOf(Uint8Array);
      expect(serializeDiff(back)).toBe(serializeDiff(r));
    }
  });

  it('writes typed arrays as plain JSON arrays and preserves -0 / ±Infinity / NaN', () => {
    const r = diffMeshes(solid, permuted, { logger: silent });
    r.alignment.matrix[1] = -0;
    r.attempts[0].metrics.weird = Number.POSITIVE_INFINITY;
    r.attempts[0].metrics.weirder = Number.NaN;
    const json = serializeDiff(r);
    const raw = JSON.parse(json);
    expect(Array.isArray(raw.baseToTarget)).toBe(true);
    expect(raw.baseToTarget.slice(0, 3)).toEqual(Array.from(r.baseToTarget.slice(0, 3)));
    const back = deserializeDiff(json);
    expect(Object.is(back.alignment.matrix[1], -0)).toBe(true);
    expect(back.attempts[0].metrics.weird).toBe(Number.POSITIVE_INFINITY);
    expect(back.attempts[0].metrics.weirder).toBeNaN();
  });

  it('rejects malformed payloads', () => {
    const r = diffMeshes(solid, solid, { logger: silent });
    const raw = JSON.parse(serializeDiff(r));
    expect(() => deserializeDiff(JSON.stringify({ ...raw, schemaVersion: 2 }))).toThrow(/schemaVersion/);
    expect(() => deserializeDiff(JSON.stringify({ ...raw, displacement: raw.displacement.slice(1) }))).toThrow(/length/);
    expect(() => deserializeDiff(JSON.stringify({ ...raw, baseToTarget: 'nope' }))).toThrow(/array/);
  });
});
