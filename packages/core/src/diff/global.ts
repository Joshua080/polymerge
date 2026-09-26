/**
 * GLOBAL TRANSFORM detection for one-to-one matchings (Tiers 1/2).
 *
 * When the whole model moved — translated, rotated, or re-exported in other units (the same
 * lineage at ×25.4) — every matched vertex "moved", which is true but useless: one rigid or
 * similarity transform explains the edit. This pass fits that transform to the matched pairs
 * and, when it explains nearly everything, reports it as the diff's `alignment`; vertices are
 * then classified relative to it (a unit re-export reads as unchanged + "in → mm").
 *
 *  1. Fit a similarity (Horn + Umeyama scale) to all matched pairs (deterministic stride
 *     subsample above GLOBAL_SAMPLE_LIMIT), keep the best 90% by residual and refit.
 *  2. Scale: snapped to a length-unit factor within 0.5%; within 1.5% of 1 it is set to 1
 *     (small scales are real edits, not re-exports); otherwise kept (a uniform resize).
 *     Rotation/translation are refitted with the scale fixed.
 *  3. Adopted iff ≥ GLOBAL_EXPLAINED_MIN of ALL matched pairs lie within the fit tolerance
 *     (moveEpsilon widened by float32 storage noise) and the transform actually moves the
 *     model by more than moveEpsilon.
 */
import { boxCorners, hornRigid, identityRigid, maxMotion, type IRigid } from './linalg.js';
import type { DiffContext } from './context.js';
import type { IUnitConversion } from '../types.js';
import { detectUnits, MIN_SCALE_DEVIATION } from './units.js';

export const GLOBAL_EXPLAINED_MIN = 0.9;
export const GLOBAL_SAMPLE_LIMIT = 20000;

export interface IGlobalTransform {
  rigid: IRigid;
  units?: IUnitConversion;
  /** Fraction of matched pairs within the fit tolerance. */
  explained: number;
  rms: number;
}

function fitTolerance(ctx: DiffContext): number {
  let maxAbs = 0;
  for (const b of [ctx.baseBounds, ctx.targetBounds]) {
    for (const v of [...b.min, ...b.max]) maxAbs = Math.max(maxAbs, Math.abs(v));
  }
  return Math.max(ctx.options.moveEpsilon, 8 * 2 ** -24 * maxAbs);
}

export function detectGlobalTransform(ctx: DiffContext, b2t: Int32Array): IGlobalTransform | null {
  const bp = ctx.base.positions;
  const tp = ctx.target.positions;
  // Quick exit: when the identity already explains more than half of the matched pairs, no
  // other similarity can explain ≥ 90% (their common fixed set is at most a line or a point).
  const tol = fitTolerance(ctx);
  let checked = 0;
  let still = 0;
  const step = Math.max(1, Math.floor(b2t.length / 4096));
  for (let b = 0; b < b2t.length; b += step) {
    const t = b2t[b];
    if (t < 0) continue;
    checked++;
    if (Math.hypot(bp[b * 3] - tp[t * 3], bp[b * 3 + 1] - tp[t * 3 + 1], bp[b * 3 + 2] - tp[t * 3 + 2]) <= tol) still++;
  }
  if (checked > 0 && still > 0.5 * checked) return null;
  const all: number[] = [];
  for (let b = 0; b < b2t.length; b++) if (b2t[b] >= 0) all.push(b);
  if (all.length < 4) return null;
  const stride = Math.max(1, Math.ceil(all.length / GLOBAL_SAMPLE_LIMIT));
  const sample = all.filter((_, i) => i % stride === 0);
  const pack = (list: number[]): { src: Float64Array; dst: Float64Array } => {
    const src = new Float64Array(list.length * 3);
    const dst = new Float64Array(list.length * 3);
    list.forEach((b, i) => {
      const t = b2t[b];
      src.set(bp.subarray(b * 3, b * 3 + 3), i * 3);
      dst.set(tp.subarray(t * 3, t * 3 + 3), i * 3);
    });
    return { src, dst };
  };
  const residual = (g: IRigid, b: number): number => {
    const t = b2t[b];
    const x = bp[b * 3];
    const y = bp[b * 3 + 1];
    const z = bp[b * 3 + 2];
    const r = g.r;
    return Math.hypot(
      g.s * (r[0] * x + r[1] * y + r[2] * z) + g.t[0] - tp[t * 3],
      g.s * (r[3] * x + r[4] * y + r[5] * z) + g.t[1] - tp[t * 3 + 1],
      g.s * (r[6] * x + r[7] * y + r[8] * z) + g.t[2] - tp[t * 3 + 2],
    );
  };

  // 1. Fit, trim to the best 90%, refit.
  let p = pack(sample);
  let g = hornRigid(p.src, p.dst, sample.length, 'free');
  const res = sample.map((b) => residual(g, b));
  const cut = Float64Array.from(res).sort()[Math.floor(0.9 * (sample.length - 1))];
  const trimmed = sample.filter((_, i) => res[i] <= cut);
  p = pack(trimmed);
  g = hornRigid(p.src, p.dst, trimmed.length, 'free');

  // 2. Scale decision, then refit with the scale fixed.
  let units = detectUnits(g.s);
  const s = units ? units.factor : Math.abs(g.s - 1) <= MIN_SCALE_DEVIATION ? 1 : g.s;
  g = hornRigid(p.src, p.dst, trimmed.length, s);
  if (s !== units?.factor) units = undefined;

  // 3. Adoption.
  let inliers = 0;
  let sum = 0;
  for (const b of all) {
    const d = residual(g, b);
    if (d <= tol) {
      inliers++;
      sum += d * d;
    }
  }
  const explained = inliers / all.length;
  if (explained < GLOBAL_EXPLAINED_MIN) return null;
  if (maxMotion(g, identityRigid(), boxCorners(ctx.baseBounds)) <= ctx.options.moveEpsilon) return null;
  return { rigid: g, ...(units ? { units } : {}), explained, rms: inliers > 0 ? Math.sqrt(sum / inliers) : 0 };
}
