/**
 * Diff engine orchestration: resolve options, run the tier chain (1 → 2 → 3, or only
 * `forceTier`), log every attempt, classify the accepted correspondence and assemble the
 * IDiffResult.
 *
 * Mandatory log lines (sink = options.logger ?? console):
 *   info  [polymerge] diff: base "<name>" (V v / F f) → target "<name>" (V v / F f)
 *   info  [polymerge] Tier N (<short>): ACCEPTED|REJECTED score=0.000 threshold=0.000 — <reason> (<ms> ms)
 *   info  [polymerge] ✔ correspondence resolved by Tier N — <TIER_NAMES[N]>
 *   warn  when Tier 3's quality is poor.
 */
import { computeBounds, summarizeMesh } from '../mesh.js';
import {
  TIER_NAMES,
  type DiffMeshesFn,
  type IDiffLogger,
  type IDiffOptions,
  type IDiffResult,
  type IMesh,
  type ITierAttempt,
  type MatchTier,
} from '../types.js';
import { classify } from './classify.js';
import { DiffContext, pct, resolveOptions, type ITierOutcome } from './context.js';
import { runTier1 } from './tier1.js';
import { runTier2 } from './tier2.js';
import { runTier3, tier3Quality } from './tier3.js';

export const TIER_SHORT_NAMES: Readonly<Record<MatchTier, string>> = {
  1: 'index/ID',
  2: 'topological',
  3: 'point cloud',
};

const RUNNERS: Readonly<Record<MatchTier, (ctx: DiffContext) => ITierOutcome>> = {
  1: runTier1,
  2: runTier2,
  3: runTier3,
};

const now: () => number =
  typeof globalThis.performance?.now === 'function' ? () => globalThis.performance.now() : () => Date.now();

function meshLabel(mesh: IMesh, fallback: string): string {
  return mesh.metadata?.sourceName ?? mesh.groups?.[0]?.name ?? fallback;
}

function validateMesh(mesh: IMesh, side: string): void {
  if (!mesh || !(mesh.positions instanceof Float64Array) || !(mesh.faces instanceof Uint32Array)) {
    throw new TypeError(`diffMeshes: ${side} is not an IMesh (positions: Float64Array, faces: Uint32Array)`);
  }
  if (mesh.positions.length !== mesh.vertexCount * 3 || mesh.faces.length !== mesh.faceCount * 3) {
    throw new RangeError(
      `diffMeshes: ${side} counts disagree with its arrays ` +
        `(vertexCount ${mesh.vertexCount} vs ${mesh.positions.length / 3}, faceCount ${mesh.faceCount} vs ${mesh.faces.length / 3})`,
    );
  }
  const n = mesh.vertexCount;
  const f = mesh.faces;
  for (let i = 0; i < f.length; i++) {
    if (f[i] >= n) throw new RangeError(`diffMeshes: ${side} face index ${f[i]} out of range (vertexCount ${n})`);
  }
}

export const diffMeshes: DiffMeshesFn = (base: IMesh, target: IMesh, options: IDiffOptions = {}): IDiffResult => {
  const t0 = now();
  validateMesh(base, 'base');
  validateMesh(target, 'target');
  const logger: IDiffLogger = options.logger ?? console;
  const baseBounds = computeBounds(base.positions);
  const targetBounds = computeBounds(target.positions);
  const opts = resolveOptions(baseBounds, targetBounds, options);

  logger.info(
    `[polymerge] diff: base "${meshLabel(base, 'base')}" (${base.vertexCount} v / ${base.faceCount} f) → ` +
      `target "${meshLabel(target, 'target')}" (${target.vertexCount} v / ${target.faceCount} f)`,
  );

  const ctx = new DiffContext(base, target, opts, baseBounds, targetBounds);
  const chain: MatchTier[] = opts.forceTier ? [opts.forceTier] : [1, 2, 3];
  const attempts: ITierAttempt[] = [];
  let accepted: ITierOutcome | null = null;

  for (const tier of chain) {
    const start = now();
    const forced = opts.forceTier === tier;
    let outcome: ITierOutcome;
    let failed = false;
    try {
      outcome = RUNNERS[tier](ctx);
    } catch (err) {
      // A crashing non-terminal tier must not sink the diff: record it and fall through.
      if (tier === 3 || forced) throw err;
      const message = err instanceof Error ? err.message : String(err);
      failed = true;
      logger.warn(`[polymerge] Tier ${tier} (${TIER_SHORT_NAMES[tier]}) failed with an internal error: ${message}`);
      outcome = {
        tier,
        score: 0,
        reason: `internal error: ${message}`,
        metrics: { error: 1 },
        targetToBase: new Int32Array(0),
        baseToTarget: new Int32Array(0),
        alignment: { matrix: [], rmsError: 0, iterations: 0, isIdentity: true },
      };
    }
    const durationMs = now() - start;
    const threshold = tier === 1 ? opts.thresholds.tier1 : tier === 2 ? opts.thresholds.tier2 : 0;
    const ok = !failed && (forced || tier === 3 || outcome.score >= threshold);
    const reason = forced ? `forced via forceTier; ${outcome.reason}` : outcome.reason;
    attempts.push({
      tier,
      name: TIER_NAMES[tier],
      accepted: ok,
      score: outcome.score,
      threshold,
      reason,
      durationMs,
      metrics: outcome.metrics,
    });
    logger.info(
      `[polymerge] Tier ${tier} (${TIER_SHORT_NAMES[tier]}): ${ok ? 'ACCEPTED' : 'REJECTED'} ` +
        `score=${outcome.score.toFixed(3)} threshold=${threshold.toFixed(3)} — ${reason} (${durationMs.toFixed(1)} ms)`,
    );
    if (ok) {
      accepted = outcome;
      break;
    }
  }
  // The chain always ends with an accepted tier (Tier 3 is terminal, forced tiers accept).
  const result = accepted!;

  if (result.tier === 3 && tier3Quality(result.score) === 'poor') {
    logger.warn(
      `[polymerge] ⚠ Tier 3 quality is poor: only ${pct(result.score)} of vertices lie within surfaceTolerance ` +
        `(${opts.surfaceTolerance.toPrecision(3)}) after rigid alignment — the models may differ substantially or ` +
        `not be rigidly related; treat the correspondence as approximate.`,
    );
  }

  const cls = classify(ctx, result);
  logger.info(`[polymerge] ✔ correspondence resolved by Tier ${result.tier} — ${TIER_NAMES[result.tier]}`);

  return {
    schemaVersion: 1,
    base: summarizeMesh(base),
    target: summarizeMesh(target),
    tier: result.tier,
    tierName: TIER_NAMES[result.tier],
    attempts,
    alignment: result.alignment,
    moveEpsilon: opts.moveEpsilon,
    surfaceTolerance: opts.surfaceTolerance,
    baseToTarget: result.baseToTarget,
    targetToBase: result.targetToBase,
    baseVertexStatus: cls.baseVertexStatus,
    targetVertexStatus: cls.targetVertexStatus,
    displacement: cls.displacement,
    baseFaceStatus: cls.baseFaceStatus,
    targetFaceStatus: cls.targetFaceStatus,
    stats: cls.stats,
    durationMs: now() - t0,
  };
};
