/**
 * TIER 3 — point-cloud fallback: ICP similarity alignment + nearest-surface mapping.
 *
 *  1. Alignment (alignment.ts): robust ICP of the base surface onto the target surface from
 *     identity / centroid / PCA initial guesses, with uniform-scale hypotheses so the same
 *     model in other units (in ↔ mm ↔ cm ↔ m ↔ ft) or uniformly resized is aligned too. A
 *     scale within 0.5% of a unit factor is snapped to it and reported in `alignment.units`;
 *     scales within 1.5% of 1 are not modelled (they are real edits, reported as moves).
 *  2. Mapping, for every target vertex: nearest point on the aligned BASE surface (BVH,
 *     queried through the inverse transform; base-space distances × scale = target units) and
 *     nearest aligned base vertex (kd-tree — nearest-neighbour order is similarity
 *     invariant). targetToBase[t] = that vertex if the surface distance ≤ surfaceTolerance,
 *     else -1 (Added). Symmetrically for base vertices against the target surface.
 *  3. Moved-part recovery (parts.ts, surface mode): components left mostly Added/Removed by
 *     the global alignment are rigidly registered pairwise; a part that moved on its own is
 *     re-matched as Moved instead of Removed + Added.
 *
 * Score = inlier fraction = (target inliers + base inliers) / (nTarget + nBase).
 * Tier 3 is terminal and always accepted; the reason states the quality.
 */
import { estimateAlignment, type IAlignSurface } from './alignment.js';
import { pct, type DiffContext, type ITierOutcome } from './context.js';
import { applyRigid, identityRigid, invertRigid, rigidToMat4, rotationAngle } from './linalg.js';
import { recoverPartsSurface } from './parts.js';
import { describeUnits } from './units.js';

/** Tier 3 quality bands on the inlier fraction. */
export const TIER3_GOOD = 0.9;
export const TIER3_FAIR = 0.6;

export function tier3Quality(score: number): 'good' | 'fair' | 'poor' {
  return score >= TIER3_GOOD ? 'good' : score >= TIER3_FAIR ? 'fair' : 'poor';
}

export function runTier3(ctx: DiffContext): ITierOutcome {
  const { base, target } = ctx;
  const { moveEpsilon: eps, surfaceTolerance: tol, diagonal, icp: icpOpts } = ctx.options;
  const nB = base.vertexCount;
  const nT = target.vertexCount;
  const bp = base.positions;
  const tp = target.positions;

  if (nB === 0 || nT === 0) {
    const both = nB + nT;
    return {
      tier: 3,
      score: both === 0 ? 1 : 0,
      reason: 'one mesh has no vertices: nothing to align; everything is added/removed',
      metrics: { icpIterations: 0, inlierFractionTarget: 0, inlierFractionBase: 0 },
      targetToBase: new Int32Array(nT).fill(-1),
      baseToTarget: new Int32Array(nB).fill(-1),
      alignment: { matrix: rigidToMat4(identityRigid()), scale: 1, rmsError: 0, iterations: 0, isIdentity: true },
      surfaceDistance: { target: new Float64Array(nT).fill(Infinity), base: new Float64Array(nB).fill(Infinity) },
      parts: [],
    };
  }

  const kdT = ctx.targetKd;
  const kdB = ctx.baseKd;
  const bvhT = target.faceCount > 0 ? ctx.targetBvh : null;
  const bvhB = base.faceCount > 0 ? ctx.baseBvh : null;
  const src: IAlignSurface = { positions: bp, faces: base.faces, bounds: ctx.baseBounds, kd: kdB, bvh: bvhB };
  const dst: IAlignSurface = { positions: tp, faces: target.faces, bounds: ctx.targetBounds, kd: kdT, bvh: bvhT };

  // ---- 1. Alignment ----------------------------------------------------------------------
  const est = estimateAlignment(src, dst, {
    moveEpsilon: eps,
    surfaceTolerance: tol,
    diagonal,
    icp: icpOpts,
    allowScale: ctx.options.detectScale,
  });
  const chosen = est.rigid;
  const s = chosen.s;

  // ---- 2. Nearest-surface mapping in both directions -----------------------------------
  const inv = invertRigid(chosen);
  const q = new Float64Array(3);
  const cap2 = tol * tol * (1 + 1e-9);
  const cap2Base = cap2 / (s * s);
  const t2b = new Int32Array(nT);
  const b2t = new Int32Array(nB);
  const dT = new Float64Array(nT);
  const dB = new Float64Array(nB);
  for (let t = 0; t < nT; t++) {
    applyRigid(inv, tp[t * 3], tp[t * 3 + 1], tp[t * 3 + 2], q);
    let d2: number;
    if (bvhB) {
      bvhB.closest(q[0], q[1], q[2], cap2Base);
      d2 = bvhB.lastDist2;
    } else {
      kdB.nearest(q[0], q[1], q[2], cap2Base);
      d2 = kdB.lastDist2;
    }
    const d = s * Math.sqrt(d2);
    if (d <= tol) {
      t2b[t] = kdB.nearest(q[0], q[1], q[2]);
      dT[t] = d;
    } else {
      t2b[t] = -1;
      dT[t] = Infinity;
    }
  }
  for (let b = 0; b < nB; b++) {
    applyRigid(chosen, bp[b * 3], bp[b * 3 + 1], bp[b * 3 + 2], q);
    let d2: number;
    if (bvhT) {
      bvhT.closest(q[0], q[1], q[2], cap2);
      d2 = bvhT.lastDist2;
    } else {
      kdT.nearest(q[0], q[1], q[2], cap2);
      d2 = kdT.lastDist2;
    }
    const d = Math.sqrt(d2);
    if (d <= tol) {
      b2t[b] = kdT.nearest(q[0], q[1], q[2]);
      dB[b] = d;
    } else {
      b2t[b] = -1;
      dB[b] = Infinity;
    }
  }

  // ---- 3. Moved-part recovery ------------------------------------------------------------
  const parts = ctx.options.detectParts ? recoverPartsSurface(ctx, chosen, t2b, b2t, dT, dB) : [];
  const inPartT = new Uint8Array(nT);
  const inPartB = new Uint8Array(nB);
  for (const p of parts) {
    for (const t of p.targetVertices) inPartT[t] = 1;
    for (const b of p.baseVertices) inPartB[b] = 1;
  }

  // Score counts every inlier; the rms only the globally aligned ones (parts moved on purpose).
  let inT = 0;
  let inB = 0;
  let recovered = 0;
  let sumSq = 0;
  let nSq = 0;
  for (let t = 0; t < nT; t++) {
    if (t2b[t] < 0) continue;
    inT++;
    if (inPartT[t]) recovered++;
    else {
      sumSq += dT[t] * dT[t];
      nSq++;
    }
  }
  for (let b = 0; b < nB; b++) {
    if (b2t[b] < 0) continue;
    inB++;
    if (!inPartB[b]) {
      sumSq += dB[b] * dB[b];
      nSq++;
    }
  }
  const score = (inT + inB) / (nT + nB);
  const rmsError = nSq > 0 ? Math.sqrt(sumSq / nSq) : 0;
  const rotDeg = (rotationAngle(chosen.r) * 180) / Math.PI;
  const transNorm = Math.hypot(chosen.t[0], chosen.t[1], chosen.t[2]);
  const quality = tier3Quality(score);
  const scaleText = est.units
    ? `, scale ×${Number(s.toPrecision(6))} = unit conversion ${describeUnits(est.units)}`
    : s !== 1
      ? `, uniform scale ×${Number(s.toPrecision(6))}`
      : '';
  const motionText = est.isIdentity
    ? est.preferredIdentity
      ? 'the identity explains the data as well as any ICP fit (no rigid motion)'
      : 'alignment ≈ identity (no rigid motion)'
    : `rotation ${rotDeg.toFixed(2)}°, translation ${transNorm.toPrecision(4)}${scaleText}`;
  const origin = est.origin === 'identity' ? 'identity' : `ICP from ${est.origin}`;
  const partText = parts.length > 0 ? `; ${parts.length} moved part(s) recovered (${recovered} target vertices)` : '';
  const reason =
    `${origin} (${est.candidates} initial guesses, ${est.refined} refined, ${est.iterations} iterations): ` +
    `${motionText}, rms ${rmsError.toExponential(2)}; ${pct(score)} of vertices within surfaceTolerance ` +
    `(target ${pct(inT / nT)}, base ${pct(inB / nB)})${partText} — quality ${quality}`;

  return {
    tier: 3,
    score,
    reason,
    metrics: {
      candidates: est.candidates,
      refinedCandidates: est.refined,
      candidateIterations: est.candidateIterations,
      refineIterations: est.refineIterations,
      icpIterations: est.iterations,
      trimmedSurfaceRms: est.metric,
      rmsError,
      rotationDeg: rotDeg,
      translation: transNorm,
      scale: s,
      scaleHypotheses: est.scaleHypotheses.length,
      inlierFractionTarget: inT / nT,
      inlierFractionBase: inB / nB,
      identityPreferred: est.preferredIdentity ? 1 : 0,
      partsRecovered: parts.length,
    },
    targetToBase: t2b,
    baseToTarget: b2t,
    alignment: {
      matrix: rigidToMat4(chosen),
      scale: s,
      ...(est.units ? { units: est.units } : {}),
      rmsError,
      iterations: est.iterations,
      isIdentity: est.isIdentity,
    },
    surfaceDistance: { target: dT, base: dB },
    parts,
  };
}
