/**
 * TIER 3 — point-cloud fallback: rigid ICP alignment + nearest-surface mapping.
 *
 * Pipeline
 *  1. Deterministic subsamples of BASE vertices (seeded PRNG): ICP_SAMPLE_COUNT for the
 *     fit, ICP_EVAL_SAMPLE_COUNT for choosing the initial guess.
 *  2. Initial guesses: identity; centroid translation; PCA frame alignments
 *     R = E_t · P · E_bᵀ (E = area-weighted surface principal axes, made proper with
 *     det = +1) for every signed permutation P with det(P) = +1 — the 4 sign flips, or
 *     all 24 axis permutations when two principal moments are within 10% (ambiguous
 *     axes). No reflections are ever generated.
 *  3. Coarse stage: each guess runs ICP_CANDIDATE_ITERATIONS trimmed point-to-point ICP
 *     iterations (kd-tree nearest target vertex) on the evaluation subsample and is scored
 *     by the 80%-trimmed RMS point-to-SURFACE distance. Shortlist = the best guess plus up
 *     to SHORTLIST_SIZE−1 DISTINCT guesses scoring within SHORTLIST_FACTOR of it, smallest
 *     motion first (symmetric shapes have several equally good alignments).
 *  4. Refinement: each shortlisted guess runs trimmed point-to-point ICP to convergence
 *     (Horn's closed-form unit-quaternion solution: largest eigenvector of the 4×4
 *     symmetric matrix N via Jacobi), then a point-to-PLANE polish (Chen–Medioni): closest
 *     point + triangle normal on the target surface via BVH, linearised 6×6 solve, exact
 *     Rodrigues rotation. Point-to-point on sparse vertices stalls at discrete fixed points
 *     and slides on remeshes; the point-to-plane polish converges in a few iterations and
 *     cannot drift along directions the surface does not constrain. Both stop when an
 *     update moves no point of the base bbox by more than `icp.convergence × diagonal`, or
 *     after `icp.maxIterations`. Every iteration keeps pairs with
 *     d ≤ min(90th percentile, max(3 × median, floor)) — robust to added/removed geometry.
 *  5. Choice: the refined fits plus the un-refined identity are compared by trimmed surface
 *     RMS; among those within COMPARABLE_FACTOR (1.25×) of the best + moveEpsilon, the one
 *     with the SMALLEST motion wins. So an unmoved remesh reports no motion and a moved
 *     symmetric part reports its least-motion equivalent. A fit moving no bbox point by
 *     more than moveEpsilon is snapped to the exact identity (`isIdentity`).
 *  6. Mapping, for every target vertex: nearest point on the aligned BASE surface (BVH,
 *     queried with the inverse transform — distances are rigid-invariant) and nearest
 *     aligned base vertex (kd-tree). targetToBase[t] = that vertex if the surface
 *     distance ≤ surfaceTolerance, else -1 (Added). Symmetrically for base vertices
 *     against the target surface (baseToTarget[b] = nearest aligned target vertex).
 *
 * Score = inlier fraction = (target inliers + base inliers) / (nTarget + nBase).
 * Tier 3 is terminal and always accepted; the reason states the quality.
 */
import { pct, type DiffContext, type ITierOutcome } from './context.js';
import {
  applyRigid,
  boxCorners,
  hornRigid,
  identityRigid,
  invertRigid,
  jacobiEigenSymmetric,
  maxMotion,
  composeRigid,
  mul3,
  pointToPlaneStep,
  rigidToMat4,
  rotationAngle,
  surfaceMoments,
  transpose3,
  type IRigid,
} from './linalg.js';
import { sampleIndices } from './prng.js';

export const ICP_SAMPLE_COUNT = 4000;
export const ICP_EVAL_SAMPLE_COUNT = 1000;
export const ICP_CANDIDATE_ITERATIONS = 8;
/** Guesses whose coarse metric is within this factor of the best are shortlist-eligible. */
export const SHORTLIST_FACTOR = 2;
/** Max guesses refined with the full point-to-surface ICP. */
export const SHORTLIST_SIZE = 3;
/** Two fits are the same transform if they differ by ≤ this fraction of the diagonal. */
export const DISTINCT_FRACTION = 0.01;
/** Final fits within this factor (+ moveEpsilon) of the best residual count as equally good. */
export const COMPARABLE_FACTOR = 1.25;
/** Pairs above this percentile are always rejected in an ICP iteration. */
export const ICP_KEEP_PERCENTILE = 0.9;
/** ...and pairs farther than this multiple of the median distance. */
export const ICP_MEDIAN_FACTOR = 3;
/** Fraction of best distances used by the trimmed-RMS quality metric. */
export const METRIC_KEEP_FRACTION = 0.8;
/** Tier 3 quality bands on the inlier fraction. */
export const TIER3_GOOD = 0.9;
export const TIER3_FAIR = 0.6;

const SEED_FIT = 0x5eed_1c9;
const SEED_EVAL = 0x0e7a_1d5;

export function tier3Quality(score: number): 'good' | 'fair' | 'poor' {
  return score >= TIER3_GOOD ? 'good' : score >= TIER3_FAIR ? 'fair' : 'poor';
}

/**
 * Correspondence oracle: writes the matched point to out[0..2] (and, for surface oracles,
 * the unit normal of the hit triangle to out[3..5]); returns the squared distance.
 */
type Correspond = (x: number, y: number, z: number, out: Float64Array) => number;

interface ICandidate {
  label: string;
  rigid: IRigid;
}

interface IIcpResult {
  rigid: IRigid;
  iterations: number;
  rms: number;
}

function gather(positions: Float64Array, idx: Uint32Array): Float64Array {
  const out = new Float64Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) {
    const o = idx[i] * 3;
    out[i * 3] = positions[o];
    out[i * 3 + 1] = positions[o + 1];
    out[i * 3 + 2] = positions[o + 2];
  }
  return out;
}

/** All 3×3 signed permutation matrices with det = +1 (the 24 proper rotations of the cube). */
function properSignedPermutations(diagonalOnly: boolean): Float64Array[] {
  const perms = [
    [0, 1, 2, 1],
    [0, 2, 1, -1],
    [1, 0, 2, -1],
    [1, 2, 0, 1],
    [2, 0, 1, 1],
    [2, 1, 0, -1],
  ];
  const signs = [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [-1, -1, -1],
    [-1, 1, 1],
    [1, -1, 1],
    [1, 1, -1],
  ];
  const out: Float64Array[] = [];
  for (const p of diagonalOnly ? perms.slice(0, 1) : perms) {
    for (const s of signs) {
      if (p[3] * s[0] * s[1] * s[2] !== 1) continue;
      const P = new Float64Array(9);
      for (let i = 0; i < 3; i++) P[i * 3 + p[i]] = s[i];
      out.push(P);
    }
  }
  return out;
}

/** Eigenvector columns → proper rotation frame (flip the last axis if det < 0). */
function properFrame(vectors: Float64Array): Float64Array {
  const E = Float64Array.from(vectors);
  const d =
    E[0] * (E[4] * E[8] - E[5] * E[7]) - E[1] * (E[3] * E[8] - E[5] * E[6]) + E[2] * (E[3] * E[7] - E[4] * E[6]);
  if (d < 0) {
    E[2] = -E[2];
    E[5] = -E[5];
    E[8] = -E[8];
  }
  return E;
}

function ambiguousAxes(values: Float64Array): boolean {
  const [a, b, c] = values;
  return a - b <= 0.1 * a || b - c <= 0.1 * b;
}

function buildCandidates(ctx: DiffContext): ICandidate[] {
  const { base, target } = ctx;
  const out: ICandidate[] = [{ label: 'identity', rigid: identityRigid() }];
  const mB = surfaceMoments(base.positions, base.faces, ctx.baseBounds);
  const mT = surfaceMoments(target.positions, target.faces, ctx.targetBounds);
  const tr = identityRigid();
  tr.t[0] = mT.c[0] - mB.c[0];
  tr.t[1] = mT.c[1] - mB.c[1];
  tr.t[2] = mT.c[2] - mB.c[2];
  out.push({ label: 'centroid translation', rigid: tr });
  const eB = jacobiEigenSymmetric(mB.cov, 3);
  const eT = jacobiEigenSymmetric(mT.cov, 3);
  if (!(eB.values[0] > 0 && eT.values[0] > 0)) return out;
  const EB = properFrame(eB.vectors);
  const ET = properFrame(eT.vectors);
  const EBt = transpose3(EB);
  const perms = properSignedPermutations(!(ambiguousAxes(eB.values) || ambiguousAxes(eT.values)));
  perms.forEach((P, i) => {
    const r = mul3(mul3(ET, P), EBt);
    const t = Float64Array.of(
      mT.c[0] - (r[0] * mB.c[0] + r[1] * mB.c[1] + r[2] * mB.c[2]),
      mT.c[1] - (r[3] * mB.c[0] + r[4] * mB.c[1] + r[5] * mB.c[2]),
      mT.c[2] - (r[6] * mB.c[0] + r[7] * mB.c[1] + r[8] * mB.c[2]),
    );
    out.push({ label: `PCA frame #${i + 1}`, rigid: { r, t } });
  });
  return out;
}

class Icp {
  private readonly d2: Float64Array;
  private readonly sorted: Float64Array;
  private readonly dst: Float64Array;
  private readonly keptSrc: Float64Array;
  private readonly keptDst: Float64Array;
  private readonly moved: Float64Array;
  private readonly nrm: Float64Array;
  private readonly keptN: Float64Array;
  private readonly q = new Float64Array(3);
  private readonly hit = new Float64Array(6);

  constructor(
    maxPoints: number,
    private readonly corners: Float64Array,
    private readonly stopMotion: number,
    private readonly floor2: number,
  ) {
    this.d2 = new Float64Array(maxPoints);
    this.sorted = new Float64Array(maxPoints);
    this.dst = new Float64Array(maxPoints * 3);
    this.keptSrc = new Float64Array(maxPoints * 3);
    this.keptDst = new Float64Array(maxPoints * 3);
    this.moved = new Float64Array(maxPoints * 3);
    this.nrm = new Float64Array(maxPoints * 3);
    this.keptN = new Float64Array(maxPoints * 3);
  }

  /**
   * Trimmed ICP from `init`: returns the final transform, iteration count and last trimmed
   * RMS. `plane = false` → point-to-point pairs solved with Horn; `plane = true` → the
   * oracle must supply normals and each step is a linearised point-to-plane solve.
   */
  run(src: Float64Array, init: IRigid, maxIter: number, corr: Correspond, plane = false): IIcpResult {
    const m = src.length / 3;
    const { d2, sorted, dst, keptSrc, keptDst, keptN, moved, nrm, q, hit } = this;
    let cur = init;
    let iterations = 0;
    let rms = Infinity;
    if (m < 3) return { rigid: cur, iterations, rms };
    for (let it = 0; it < maxIter; it++) {
      for (let i = 0; i < m; i++) {
        applyRigid(cur, src[i * 3], src[i * 3 + 1], src[i * 3 + 2], q);
        d2[i] = corr(q[0], q[1], q[2], hit);
        dst[i * 3] = hit[0];
        dst[i * 3 + 1] = hit[1];
        dst[i * 3 + 2] = hit[2];
        if (plane) {
          moved[i * 3] = q[0];
          moved[i * 3 + 1] = q[1];
          moved[i * 3 + 2] = q[2];
          nrm[i * 3] = hit[3];
          nrm[i * 3 + 1] = hit[4];
          nrm[i * 3 + 2] = hit[5];
        }
      }
      const s = sorted.subarray(0, m);
      s.set(d2.subarray(0, m));
      s.sort();
      const pKeep = s[Math.floor(ICP_KEEP_PERCENTILE * (m - 1))];
      const med = s[Math.floor(0.5 * (m - 1))];
      let thr = Math.min(pKeep, Math.max(ICP_MEDIAN_FACTOR * ICP_MEDIAN_FACTOR * med, this.floor2));
      if (thr < s[2]) thr = s[2]; // always keep at least 3 pairs
      let k = 0;
      let sum = 0;
      for (let i = 0; i < m; i++) {
        if (!(d2[i] <= thr)) continue;
        const from = plane ? moved : src;
        keptSrc[k * 3] = from[i * 3];
        keptSrc[k * 3 + 1] = from[i * 3 + 1];
        keptSrc[k * 3 + 2] = from[i * 3 + 2];
        if (plane) {
          keptN[k * 3] = nrm[i * 3];
          keptN[k * 3 + 1] = nrm[i * 3 + 1];
          keptN[k * 3 + 2] = nrm[i * 3 + 2];
        }
        keptDst[k * 3] = dst[i * 3];
        keptDst[k * 3 + 1] = dst[i * 3 + 1];
        keptDst[k * 3 + 2] = dst[i * 3 + 2];
        sum += d2[i];
        k++;
      }
      if (k < 3) break;
      rms = Math.sqrt(sum / k);
      const next = plane ? composeRigid(pointToPlaneStep(keptSrc, keptDst, keptN, k), cur) : hornRigid(keptSrc, keptDst, k);
      iterations++;
      const motion = maxMotion(cur, next, this.corners);
      cur = next;
      if (motion <= this.stopMotion) break;
    }
    return { rigid: cur, iterations, rms };
  }

  /** Trimmed (best METRIC_KEEP_FRACTION) RMS of correspondence distances under `g`. */
  metric(src: Float64Array, g: IRigid, corr: Correspond): number {
    const m = src.length / 3;
    if (m === 0) return Infinity;
    const { d2, q, hit } = this;
    for (let i = 0; i < m; i++) {
      applyRigid(g, src[i * 3], src[i * 3 + 1], src[i * 3 + 2], q);
      d2[i] = corr(q[0], q[1], q[2], hit);
    }
    const s = d2.subarray(0, m);
    s.sort();
    const k = Math.max(1, Math.ceil(METRIC_KEEP_FRACTION * m));
    let sum = 0;
    for (let i = 0; i < k; i++) sum += s[i];
    return Math.sqrt(sum / k);
  }
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
      alignment: { matrix: rigidToMat4(identityRigid()), rmsError: 0, iterations: 0, isIdentity: true },
      surfaceDistance: { target: new Float64Array(nT).fill(Infinity), base: new Float64Array(nB).fill(Infinity) },
    };
  }

  const kdT = ctx.targetKd;
  const kdB = ctx.baseKd;
  const hasTargetFaces = target.faceCount > 0;
  const hasBaseFaces = base.faceCount > 0;
  const bvhT = hasTargetFaces ? ctx.targetBvh : null;
  const bvhB = hasBaseFaces ? ctx.baseBvh : null;

  const nnCorr: Correspond = (x, y, z, out) => {
    const j = kdT.nearest(x, y, z);
    out[0] = tp[j * 3];
    out[1] = tp[j * 3 + 1];
    out[2] = tp[j * 3 + 2];
    return kdT.lastDist2;
  };
  const surfCorr: Correspond = bvhT
    ? (x, y, z, out) => {
        bvhT.closest(x, y, z);
        out[0] = bvhT.lastPoint[0];
        out[1] = bvhT.lastPoint[1];
        out[2] = bvhT.lastPoint[2];
        out[3] = bvhT.lastNormal[0];
        out[4] = bvhT.lastNormal[1];
        out[5] = bvhT.lastNormal[2];
        return bvhT.lastDist2;
      }
    : nnCorr;

  // ---- 1–3. Samples, initial guesses, candidate selection -----------------------------
  const fitPts = gather(bp, sampleIndices(nB, ICP_SAMPLE_COUNT, SEED_FIT));
  const evalPts = gather(bp, sampleIndices(nB, ICP_EVAL_SAMPLE_COUNT, SEED_EVAL));
  const corners = boxCorners(ctx.baseBounds);
  const stopMotion = Math.max(icpOpts.convergence * diagonal, 0);
  const floor = Math.max(0.05 * tol, 10 * eps);
  const icp = new Icp(Math.max(fitPts.length, evalPts.length) / 3, corners, stopMotion, floor * floor);

  const identity = identityRigid();
  const candidates = buildCandidates(ctx);
  const coarseIters = Math.min(ICP_CANDIDATE_ITERATIONS, icpOpts.maxIterations);
  let candidateIterations = 0;
  const coarse = candidates.map((c, i) => {
    const r = icp.run(evalPts, c.rigid, coarseIters, nnCorr);
    candidateIterations += r.iterations;
    return { i, rigid: r.rigid, metric: icp.metric(evalPts, r.rigid, surfCorr), motion: maxMotion(r.rigid, identity, corners) };
  });
  let best = coarse[0];
  for (const c of coarse) if (c.metric < best.metric) best = c;
  // Shortlist: the best guess plus the smallest-motion DISTINCT guesses that are nearly as good
  // (symmetric shapes converge to several equally good transforms).
  const shortlist = [best];
  const pool = coarse
    .filter((c) => c !== best && c.metric <= SHORTLIST_FACTOR * best.metric + eps)
    .sort((a, b) => a.motion - b.motion || a.i - b.i);
  for (const c of pool) {
    if (shortlist.length >= SHORTLIST_SIZE) break;
    if (shortlist.some((s) => maxMotion(s.rigid, c.rigid, corners) <= DISTINCT_FRACTION * diagonal)) continue;
    shortlist.push(c);
  }

  // ---- 4. Refinement: point-to-point to convergence, then point-to-plane ---------------
  let refineIterations = 0;
  const finals = shortlist.map((s) => {
    const p2p = icp.run(fitPts, s.rigid, icpOpts.maxIterations, nnCorr);
    const r = bvhT ? icp.run(fitPts, p2p.rigid, icpOpts.maxIterations, surfCorr, true) : p2p;
    const iterations = p2p.iterations + (bvhT ? r.iterations : 0);
    refineIterations += iterations;
    return {
      label: candidates[s.i].label,
      rigid: r.rigid,
      iterations,
      metric: icp.metric(fitPts, r.rigid, surfCorr),
      motion: maxMotion(r.rigid, identity, corners),
    };
  });
  const mId = icp.metric(fitPts, identity, surfCorr);
  finals.push({ label: 'identity (unrefined)', rigid: identity, iterations: 0, metric: mId, motion: 0 });

  // ---- 5. Choose: smallest motion among the fits within COMPARABLE_FACTOR of the best ----
  let mBest = Infinity;
  for (const f of finals) if (f.metric < mBest) mBest = f.metric;
  let pick = finals[0];
  let pickSet = false;
  for (const f of finals) {
    if (!(f.metric <= COMPARABLE_FACTOR * mBest + eps)) continue;
    if (!pickSet || f.motion < pick.motion) {
      pick = f;
      pickSet = true;
    }
  }
  const bestFinal = finals.reduce((a, b) => (b.metric < a.metric ? b : a));
  const preferredIdentity = pick.rigid === identity && bestFinal.rigid !== identity && bestFinal.motion > eps;
  let chosen = pick.rigid;
  const chosenMetric = pick.metric;
  let isIdentity = false;
  if (maxMotion(chosen, identity, corners) <= eps) {
    chosen = identity;
    isIdentity = true;
  }
  const icpIterations = pick.iterations;
  const bestIdx = pick.rigid === identity ? -1 : shortlist[finals.indexOf(pick)].i;

  // ---- 6. Nearest-surface mapping in both directions -----------------------------------
  const inv = invertRigid(chosen);
  const q = new Float64Array(3);
  const cap2 = tol * tol * (1 + 1e-9);
  const t2b = new Int32Array(nT);
  const b2t = new Int32Array(nB);
  const dT = new Float64Array(nT);
  const dB = new Float64Array(nB);
  let inT = 0;
  let inB = 0;
  let sumSq = 0;
  for (let t = 0; t < nT; t++) {
    applyRigid(inv, tp[t * 3], tp[t * 3 + 1], tp[t * 3 + 2], q);
    let d2: number;
    if (bvhB) {
      bvhB.closest(q[0], q[1], q[2], cap2);
      d2 = bvhB.lastDist2;
    } else {
      kdB.nearest(q[0], q[1], q[2], cap2);
      d2 = kdB.lastDist2;
    }
    const d = Math.sqrt(d2);
    if (d <= tol) {
      t2b[t] = kdB.nearest(q[0], q[1], q[2]);
      dT[t] = d;
      inT++;
      sumSq += d2;
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
      inB++;
      sumSq += d2;
    } else {
      b2t[b] = -1;
      dB[b] = Infinity;
    }
  }

  const score = (inT + inB) / (nT + nB);
  const rmsError = inT + inB > 0 ? Math.sqrt(sumSq / (inT + inB)) : 0;
  const rotDeg = (rotationAngle(chosen.r) * 180) / Math.PI;
  const transNorm = Math.hypot(chosen.t[0], chosen.t[1], chosen.t[2]);
  const quality = tier3Quality(score);
  const motionText = isIdentity
    ? preferredIdentity
      ? 'the identity explains the data as well as any ICP fit (no rigid motion)'
      : 'alignment ≈ identity (no rigid motion)'
    : `rotation ${rotDeg.toFixed(2)}°, translation ${transNorm.toPrecision(4)}`;
  const origin = bestIdx < 0 ? 'identity' : `ICP from ${candidates[bestIdx].label}`;
  const reason =
    `${origin} (${candidates.length} initial guesses, ${shortlist.length} refined, ${icpIterations} iterations): ` +
    `${motionText}, rms ${rmsError.toExponential(2)}; ${pct(score)} of vertices within surfaceTolerance ` +
    `(target ${pct(inT / nT)}, base ${pct(inB / nB)}) — quality ${quality}`;

  return {
    tier: 3,
    score,
    reason,
    metrics: {
      candidates: candidates.length,
      chosenCandidate: bestIdx,
      refinedCandidates: shortlist.length,
      candidateIterations,
      refineIterations,
      icpIterations,
      trimmedSurfaceRms: chosenMetric,
      rmsError,
      rotationDeg: rotDeg,
      translation: transNorm,
      inlierFractionTarget: inT / nT,
      inlierFractionBase: inB / nB,
      identityPreferred: preferredIdentity ? 1 : 0,
      samples: fitPts.length / 3,
    },
    targetToBase: t2b,
    baseToTarget: b2t,
    alignment: { matrix: rigidToMat4(chosen), rmsError, iterations: icpIterations, isIdentity },
    surfaceDistance: { target: dT, base: dB },
  };
}
