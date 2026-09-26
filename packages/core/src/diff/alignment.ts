/**
 * ALIGNMENT ESTIMATOR — robust ICP registration of a SOURCE surface onto a DESTINATION
 * surface, shared by Tier 3 (whole models, similarity allowed) and moved-part recovery
 * (single connected components, rigid).
 *
 * Pipeline
 *  1. Deterministic subsamples (seeded PRNG): ICP_SAMPLE_COUNT source points for the fit,
 *     ICP_EVAL_SAMPLE_COUNT source (and, when scale is in play, destination) points for
 *     choosing among initial guesses.
 *  2. Scale hypotheses: always 1. With `allowScale`, the moment ratio
 *     s0 = √(tr Σ_dst / tr Σ_src) (area-weighted surface covariances — exact for a uniformly
 *     scaled copy, tessellation independent) is added when |s0 − 1| > MIN_SCALE_DEVIATION;
 *     if s0 is within UNIT_SNAP_TOLERANCE of a length-unit factor that factor replaces it,
 *     otherwise the nearest unit factor within ×1.25 is added as a third hypothesis (robust
 *     to added/removed geometry skewing the moments).
 *  3. Initial guesses per hypothesis h: identity (h = 1 only); centroid translation; PCA
 *     frame alignments R = E_dst · P · E_srcᵀ for every signed permutation P with det(P) = +1
 *     (the 4 sign flips, or all 24 when two principal moments are within 10%). No reflections.
 *  4. Coarse stage: each guess runs ICP_CANDIDATE_ITERATIONS trimmed point-to-point ICP
 *     iterations (kd-tree nearest destination vertex; guesses with h ≠ 1 re-estimate the scale
 *     each step, clamped to [h/1.5, 1.5h]) and is scored by the trimmed RMS point-to-SURFACE
 *     distance. With scale hypotheses the score is SYMMETRIC (source→destination and
 *     destination→source): a one-sided score would reward shrinking the source into a corner
 *     of the destination. Shortlist = best guess + up to SHORTLIST_SIZE−1 DISTINCT guesses
 *     within SHORTLIST_FACTOR of it, smallest motion first (symmetric shapes).
 *  5. Refinement: trimmed point-to-point ICP to convergence (Horn's quaternion solution with
 *     Umeyama's scale when free), then a point-to-PLANE polish (Chen–Medioni, 7 unknowns with
 *     scale). Every iteration keeps pairs with d ≤ min(90th percentile, max(3 × median, floor)).
 *  6. Choice: refined fits + the unrefined identity; among those within COMPARABLE_FACTOR of
 *     the best score (+ moveEpsilon) the SMALLEST motion wins — so a rigid fit beats an
 *     equally good scaled one, and an unmoved remesh reports no motion.
 *  7. Scale snapping: a fitted scale within UNIT_SNAP_TOLERANCE of a unit factor is snapped
 *     to it exactly (and labelled); one within MIN_SCALE_DEVIATION of 1 becomes 1. Either way
 *     rotation/translation are re-refined with the scale fixed. A fit moving no source-bbox
 *     point by more than moveEpsilon is snapped to the exact identity.
 */
import type { IBounds, IUnitConversion } from '../types.js';
import {
  applyRigid,
  boxCorners,
  composeRigid,
  hornRigid,
  identityRigid,
  invertRigid,
  jacobiEigenSymmetric,
  maxMotion,
  mul3,
  pointToPlaneStep,
  surfaceMoments,
  transpose3,
  withScale,
  type IRigid,
} from './linalg.js';
import { sampleIndices } from './prng.js';
import type { KdTree, TriangleBvh } from './spatial.js';
import { detectUnits, MIN_SCALE_DEVIATION, nearbyUnitFactors, UNIT_SNAP_TOLERANCE } from './units.js';

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
/** A scaled guess may drift at most this factor from its hypothesis during ICP. */
export const SCALE_DRIFT = 1.5;
/** Unit factors within this ratio of the moment estimate become extra hypotheses. */
export const UNIT_HYPOTHESIS_RATIO = 1.25;

const SEED_FIT = 0x5eed_1c9;
const SEED_EVAL = 0x0e7a_1d5;
const SEED_EVAL_DST = 0x0e7a_2d6;

/** A mesh surface to align, with its acceleration structures. */
export interface IAlignSurface {
  positions: Float64Array;
  faces: Uint32Array;
  bounds: IBounds;
  kd: KdTree;
  /** Null when the mesh has no faces (vertex-only correspondence). */
  bvh: TriangleBvh | null;
}

export interface IAlignParams {
  moveEpsilon: number;
  surfaceTolerance: number;
  /** Diagonal of the destination frame (sets the convergence and distinctness scales). */
  diagonal: number;
  icp: { maxIterations: number; convergence: number };
  allowScale: boolean;
}

export interface IAlignEstimate {
  /** Chosen source → destination transform (s = 1 unless a scale was detected). */
  rigid: IRigid;
  isIdentity: boolean;
  /** The unrefined identity was chosen although some ICP fit moved (equally good data fit). */
  preferredIdentity: boolean;
  /** Set when the scale was snapped to a length-unit factor. */
  units?: IUnitConversion;
  /** Trimmed RMS point-to-surface distance of the chosen fit (symmetric when scale was in play). */
  metric: number;
  iterations: number;
  /** Label of the initial guess the chosen fit came from. */
  origin: string;
  candidates: number;
  refined: number;
  candidateIterations: number;
  refineIterations: number;
  scaleHypotheses: number[];
}

/**
 * Correspondence oracle: writes the matched point to out[0..2] (and, for surface oracles,
 * the unit normal of the hit triangle to out[3..5]); returns the squared distance.
 */
type Correspond = (x: number, y: number, z: number, out: Float64Array) => number;

interface ICandidate {
  label: string;
  rigid: IRigid;
  /** Scale bounds when the scale is re-estimated during ICP; null = keep the guess's scale. */
  scaleBounds: [number, number] | null;
}

interface IIcpResult {
  rigid: IRigid;
  iterations: number;
  rms: number;
}

export function gather(positions: Float64Array, idx: Uint32Array): Float64Array {
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

function fmtScale(h: number): string {
  return Number(h.toPrecision(6)).toString();
}

function buildCandidates(src: IAlignSurface, dst: IAlignSurface, allowScale: boolean): { list: ICandidate[]; hyps: number[] } {
  const mB = surfaceMoments(src.positions, src.faces, src.bounds);
  const mT = surfaceMoments(dst.positions, dst.faces, dst.bounds);
  const hyps = [1];
  const trB = mB.cov[0] + mB.cov[4] + mB.cov[8];
  const trT = mT.cov[0] + mT.cov[4] + mT.cov[8];
  if (allowScale && trB > 0 && trT > 0) {
    const s0 = Math.sqrt(trT / trB);
    if (Math.abs(s0 - 1) > MIN_SCALE_DEVIATION) {
      const unit = detectUnits(s0, UNIT_SNAP_TOLERANCE);
      if (unit) hyps.push(unit.factor);
      else {
        hyps.push(s0);
        const near = nearbyUnitFactors(s0, UNIT_HYPOTHESIS_RATIO);
        if (near.length > 0 && Math.abs(near[0] - 1) > MIN_SCALE_DEVIATION) hyps.push(near[0]);
      }
    }
  }
  const list: ICandidate[] = [{ label: 'identity', rigid: identityRigid(), scaleBounds: null }];
  const eB = jacobiEigenSymmetric(mB.cov, 3);
  const eT = jacobiEigenSymmetric(mT.cov, 3);
  const pcaOk = eB.values[0] > 0 && eT.values[0] > 0;
  const EB = pcaOk ? properFrame(eB.vectors) : null;
  const ET = pcaOk ? properFrame(eT.vectors) : null;
  const perms = pcaOk ? properSignedPermutations(!(ambiguousAxes(eB.values) || ambiguousAxes(eT.values))) : [];
  for (const h of hyps) {
    const bounds: [number, number] | null = h === 1 ? null : [h / SCALE_DRIFT, h * SCALE_DRIFT];
    const suffix = h === 1 ? '' : ` ×${fmtScale(h)}`;
    const tr = identityRigid();
    tr.s = h;
    for (let k = 0; k < 3; k++) tr.t[k] = mT.c[k] - h * mB.c[k];
    list.push({ label: `centroid translation${suffix}`, rigid: tr, scaleBounds: bounds });
    if (!EB || !ET) continue;
    const EBt = transpose3(EB);
    perms.forEach((P, i) => {
      const r = mul3(mul3(ET, P), EBt);
      const t = Float64Array.of(
        mT.c[0] - h * (r[0] * mB.c[0] + r[1] * mB.c[1] + r[2] * mB.c[2]),
        mT.c[1] - h * (r[3] * mB.c[0] + r[4] * mB.c[1] + r[5] * mB.c[2]),
        mT.c[2] - h * (r[6] * mB.c[0] + r[7] * mB.c[1] + r[8] * mB.c[2]),
      );
      list.push({ label: `PCA frame #${i + 1}${suffix}`, rigid: { r, t, s: h }, scaleBounds: bounds });
    });
  }
  return { list, hyps };
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
   * `scaleBounds` non-null → the scale is re-estimated every step and clamped to it.
   */
  run(
    src: Float64Array,
    init: IRigid,
    maxIter: number,
    corr: Correspond,
    plane = false,
    scaleBounds: [number, number] | null = null,
  ): IIcpResult {
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
      let next: IRigid;
      if (plane) {
        next = composeRigid(pointToPlaneStep(keptSrc, keptDst, keptN, k, scaleBounds !== null), cur);
        if (scaleBounds) next.s = Math.min(scaleBounds[1], Math.max(scaleBounds[0], next.s));
      } else {
        next = hornRigid(keptSrc, keptDst, k, scaleBounds ? 'free' : cur.s, scaleBounds ?? undefined);
      }
      iterations++;
      const motion = maxMotion(cur, next, this.corners);
      cur = next;
      if (motion <= this.stopMotion) break;
    }
    return { rigid: cur, iterations, rms };
  }

  /** Trimmed (best METRIC_KEEP_FRACTION) RMS of correspondence distances under `g`. */
  metric(src: Float64Array, g: IRigid, corr: Correspond, distanceScale = 1): number {
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
    return distanceScale * Math.sqrt(sum / k);
  }
}

function nearestVertexOracle(s: IAlignSurface): Correspond {
  const kd = s.kd;
  const p = s.positions;
  return (x, y, z, out) => {
    const j = kd.nearest(x, y, z);
    out[0] = p[j * 3];
    out[1] = p[j * 3 + 1];
    out[2] = p[j * 3 + 2];
    return kd.lastDist2;
  };
}

function surfaceOracle(s: IAlignSurface): Correspond {
  const bvh = s.bvh;
  if (!bvh) return nearestVertexOracle(s);
  return (x, y, z, out) => {
    bvh.closest(x, y, z);
    out[0] = bvh.lastPoint[0];
    out[1] = bvh.lastPoint[1];
    out[2] = bvh.lastPoint[2];
    out[3] = bvh.lastNormal[0];
    out[4] = bvh.lastNormal[1];
    out[5] = bvh.lastNormal[2];
    return bvh.lastDist2;
  };
}

/** Register `src` onto `dst` (see the module header). Both surfaces need ≥ 1 vertex. */
export function estimateAlignment(src: IAlignSurface, dst: IAlignSurface, p: IAlignParams): IAlignEstimate {
  const { moveEpsilon: eps, surfaceTolerance: tol, diagonal, icp: icpOpts } = p;
  const nS = src.positions.length / 3;
  const nD = dst.positions.length / 3;
  const nnCorr = nearestVertexOracle(dst);
  const surfCorr = surfaceOracle(dst);
  const srcSurfCorr = surfaceOracle(src);

  // ---- 1–3. Samples, hypotheses, initial guesses ---------------------------------------
  const fitPts = gather(src.positions, sampleIndices(nS, ICP_SAMPLE_COUNT, SEED_FIT));
  const evalPts = gather(src.positions, sampleIndices(nS, ICP_EVAL_SAMPLE_COUNT, SEED_EVAL));
  const corners = boxCorners(src.bounds);
  const stopMotion = Math.max(icpOpts.convergence * diagonal, 0);
  const floor = Math.max(0.05 * tol, 10 * eps);
  const { list: candidates, hyps } = buildCandidates(src, dst, p.allowScale);
  const symmetric = hyps.length > 1;
  const dstEval = symmetric ? gather(dst.positions, sampleIndices(nD, ICP_EVAL_SAMPLE_COUNT, SEED_EVAL_DST)) : null;
  const maxPts = Math.max(fitPts.length, evalPts.length, dstEval?.length ?? 0) / 3;
  const icp = new Icp(maxPts, corners, stopMotion, floor * floor);

  // Symmetric score: forward (src → dst surface) and reverse (dst → src surface through the
  // inverse transform; distances scaled back into destination units).
  const score = (g: IRigid, pts: Float64Array): number => {
    const fwd = icp.metric(pts, g, surfCorr);
    if (!dstEval) return fwd;
    const rev = icp.metric(dstEval, invertRigid(g), srcSurfCorr, g.s);
    return Math.sqrt(0.5 * (fwd * fwd + rev * rev));
  };

  const identity = identityRigid();
  const coarseIters = Math.min(ICP_CANDIDATE_ITERATIONS, icpOpts.maxIterations);
  let candidateIterations = 0;
  const coarse = candidates.map((c, i) => {
    const r = icp.run(evalPts, c.rigid, coarseIters, nnCorr, false, c.scaleBounds);
    candidateIterations += r.iterations;
    return { i, rigid: r.rigid, metric: score(r.rigid, evalPts), motion: maxMotion(r.rigid, identity, corners) };
  });
  let best = coarse[0];
  for (const c of coarse) if (c.metric < best.metric) best = c;
  const shortlist = [best];
  const pool = coarse
    .filter((c) => c !== best && c.metric <= SHORTLIST_FACTOR * best.metric + eps)
    .sort((a, b) => a.motion - b.motion || a.i - b.i);
  for (const c of pool) {
    if (shortlist.length >= SHORTLIST_SIZE) break;
    if (shortlist.some((s) => maxMotion(s.rigid, c.rigid, corners) <= DISTINCT_FRACTION * diagonal)) continue;
    shortlist.push(c);
  }

  // ---- 5. Refinement: point-to-point to convergence, then point-to-plane ---------------
  let refineIterations = 0;
  const refine = (g: IRigid, bounds: [number, number] | null): { rigid: IRigid; iterations: number } => {
    const p2p = icp.run(fitPts, g, icpOpts.maxIterations, nnCorr, false, bounds);
    const r = dst.bvh ? icp.run(fitPts, p2p.rigid, icpOpts.maxIterations, surfCorr, true, bounds) : p2p;
    const iterations = p2p.iterations + (dst.bvh ? r.iterations : 0);
    refineIterations += iterations;
    return { rigid: r.rigid, iterations };
  };
  const finals = shortlist.map((s) => {
    const r = refine(s.rigid, candidates[s.i].scaleBounds);
    return {
      label: candidates[s.i].label,
      rigid: r.rigid,
      iterations: r.iterations,
      metric: score(r.rigid, fitPts),
      motion: maxMotion(r.rigid, identity, corners),
    };
  });
  finals.push({ label: 'identity', rigid: identity, iterations: 0, metric: score(identity, fitPts), motion: 0 });

  // ---- 6. Choose: smallest motion among the fits within COMPARABLE_FACTOR of the best ----
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

  // ---- 7. Scale snapping -----------------------------------------------------------------
  let chosen = pick.rigid;
  let metric = pick.metric;
  let iterations = pick.iterations;
  let units: IUnitConversion | undefined;
  if (chosen.s !== 1) {
    units = detectUnits(chosen.s);
    const snapped = units ? units.factor : Math.abs(chosen.s - 1) <= MIN_SCALE_DEVIATION ? 1 : null;
    if (snapped !== null) {
      const r = refine(withScale(chosen, snapped), null);
      chosen = r.rigid;
      chosen.s = snapped;
      iterations += r.iterations;
      metric = score(chosen, fitPts);
    }
  }
  let isIdentity = false;
  if (maxMotion(chosen, identity, corners) <= eps) {
    chosen = identityRigid();
    isIdentity = true;
    units = undefined;
  }
  return {
    rigid: chosen,
    isIdentity,
    preferredIdentity,
    units,
    metric,
    iterations,
    origin: pick.rigid === identity ? 'identity' : pick.label,
    candidates: candidates.length,
    refined: shortlist.length,
    candidateIterations,
    refineIterations,
    scaleHypotheses: hyps,
  };
}

export { UNIT_SNAP_TOLERANCE, MIN_SCALE_DEVIATION };
