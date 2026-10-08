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
 * Plus one info line per refinement that fires after the accepted tier:
 *   info  [polymerge] ↳ global transform: …   (Tiers 1/2 — the whole model moved / changed units)
 *   info  [polymerge] ↳ moved part …           (per part that moved rigidly on its own)
 *
 * Refinements after the accepted tier (each can be switched off in IDiffOptions):
 *  1. Tiers 1/2: global-transform detection (global.ts) — one rigid/similarity motion that
 *     explains ≥ 90% of the matched vertices becomes the alignment.
 *  2. Tier 1: moved-part recovery (parts.ts) for components the index/ID matching lost
 *     (Tiers 2 and 3 recover parts internally, before scoring).
 *  3. Tiers 1/2: matched-part analysis — parts already matched that moved rigidly are reported.
 */
import { computeBounds, summarizeMesh } from '../mesh.js';
import { stepInfo } from '../parsers/step.js';
import { compareMetrics, computeMetrics } from '../metrics.js';
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
import { refineByBrepFaces } from './brep.js';
import { classify } from './classify.js';
import { DiffContext, pct, resolveOptions, type ITierOutcome } from './context.js';
import { detectGlobalTransform } from './global.js';
import { mat4ToRigid, rigidToMat4, rotationAngle } from './linalg.js';
import { analyzeMatchedParts, finalizeParts, recoverPartsTopological } from './parts.js';
import { runTier1 } from './tier1.js';
import { runTier2 } from './tier2.js';
import { runTier3, tier3Quality } from './tier3.js';
import { describeUnits } from './units.js';

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
        alignment: { matrix: [], scale: 1, rmsError: 0, iterations: 0, isIdentity: true },
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

  logger.info(`[polymerge] ✔ correspondence resolved by Tier ${result.tier} — ${TIER_NAMES[result.tier]}`);

  // ---- Refinements -----------------------------------------------------------------------
  let A = mat4ToRigid(result.alignment.matrix);
  if (result.tier !== 3 && opts.detectGlobalTransform) {
    const g = detectGlobalTransform(ctx, result.baseToTarget);
    if (g) {
      A = g.rigid;
      result.alignment = {
        matrix: rigidToMat4(g.rigid),
        scale: g.rigid.s,
        ...(g.units ? { units: g.units } : {}),
        rmsError: g.rms,
        iterations: 0,
        isIdentity: false,
      };
      const t = g.rigid.t;
      const scaleText = g.units
        ? `unit conversion ${describeUnits(g.units)}, `
        : g.rigid.s !== 1
          ? `uniform scale ×${Number(g.rigid.s.toPrecision(6))}, `
          : '';
      logger.info(
        `[polymerge] ↳ global transform: one ${g.rigid.s !== 1 ? 'similarity' : 'rigid'} motion explains ` +
          `${pct(g.explained)} of the matched vertices (${scaleText}rotation ` +
          `${((rotationAngle(g.rigid.r) * 180) / Math.PI).toFixed(2)}°, translation ` +
          `(${Array.from(t, (v) => Number(v.toPrecision(6))).join(', ')})) — reported as the alignment`,
      );
    }
  }
  const internalParts = result.parts ? [...result.parts] : [];
  if (opts.detectParts && result.tier === 1) {
    internalParts.push(...recoverPartsTopological(ctx, A, result.baseToTarget, result.targetToBase));
  }
  if (opts.detectParts && result.tier !== 3) {
    const skip = new Set(internalParts.map((p) => p.baseComponent));
    internalParts.push(...analyzeMatchedParts(ctx, A, result.baseToTarget, result.targetToBase, skip));
  }
  const parts = finalizeParts(ctx, internalParts, A);
  for (const p of parts) {
    const verb = p.source === 'registration' ? 're-matched by rigid registration (would read as removed + added)' : 'already matched';
    const name = p.baseName ?? p.targetName;
    logger.info(
      `[polymerge] ↳ moved part${name ? ` "${name}"` : ''}: ${p.baseVertices.length} base / ${p.targetVertices.length} target ` +
        `vertices, rotation ${p.rotationDeg.toFixed(2)}°, centroid shift ` +
        `(${p.centroidShift.map((v) => Number(v.toPrecision(4))).join(', ')})` +
        `${p.deformedVertices > 0 ? `, ${p.deformedVertices} vertex(es) also edited locally` : ''} — ${verb}`,
    );
  }

  const cls = classify(ctx, result);
  // STEP: compare the CAD faces as surfaces, so re-triangulated faces read as unchanged.
  let brep: IDiffResult['brep'];
  if (options.brepFaces !== false && base.brep && target.brep) {
    const deflection = stepInfo(target)?.deflection ?? stepInfo(base)?.deflection ?? 0;
    brep = refineByBrepFaces({ base, target, alignment: result.alignment, deflection }, cls);
    logger.info(
      `[polymerge] ↳ CAD faces: ${brep.unchanged} of ${brep.targetFaces} unchanged, ${brep.changes.length} changed; ` +
        `${brep.retriangulated.target + brep.retriangulated.base} re-triangulated triangle(s) count as unchanged`,
    );
  }

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
    parts,
    ...(options.metrics === false ? {} : { metrics: compareMetrics(computeMetrics(base), computeMetrics(target)) }),
    ...(brep ? { brep } : {}),
    durationMs: now() - t0,
  };
};
