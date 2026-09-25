/**
 * TIER 1 — direct lineage (index / ID correspondence).
 *
 * Proposal:
 *  - ID mode when both meshes carry `vertexIds` on ≥ ID_COVERAGE_MIN of their vertices:
 *    pair vertices whose id is non-null and unique on BOTH sides.
 *  - Index mode otherwise (or when ID mode scores below the threshold): i ↔ i for
 *    i < min(nBase, nTarget). The welding contract (first-appearance order) makes this
 *    valid across formats for meshes that share lineage and face order.
 *
 * Validation (face agreement): a face is PRESERVED when its mapped vertex triple is a
 * face of the other mesh (unordered triples, exact hash set).
 *
 * Orphan rule: a matched pair (b, t) is UN-MATCHED (→ b Removed, t Added) when b has at
 * least one incident face and none of them is preserved. Under a one-to-one matching a
 * base face is preserved iff its image target face is, so "all of b's faces unpreserved"
 * ⇔ "all of t's faces unpreserved"; checking one side is enough. Un-matching only
 * touches already-unpreserved faces, so one pass is a fixed point.
 *
 * Score = min(faceAgreement, matchedFraction) where, over the SMALLER mesh,
 *   faceAgreement   = min(preservedBaseFaces, preservedTargetFaces) / min(fBase, fTarget)
 *   matchedFraction = matchedPairs (after the orphan rule) / min(nBase, nTarget)
 * Measuring against the smaller mesh makes geometry appended at (or removed from) the END
 * of the streams score 1, as do vertex moves of any size (topology is untouched), while
 * re-indexed / shuffled / unrelated meshes score ≈ 0. matchedFraction is the sanity check
 * that most of the smaller mesh is actually explained by the pairing.
 */
import { pct, type DiffContext, type ITierOutcome, identityAlignment } from './context.js';

/** Minimum fraction of vertices carrying a non-null id (on both sides) for ID mode. */
export const ID_COVERAGE_MIN = 0.5;

interface IEvaluation {
  mode: 'ID' | 'index';
  baseToTarget: Int32Array;
  targetToBase: Int32Array;
  score: number;
  faceAgreement: number;
  matchedFraction: number;
  preservedFaces: number;
  matched: number;
  orphaned: number;
}

function idCoverage(ids: (string | null)[] | undefined, n: number): number {
  if (!ids || ids.length !== n || n === 0) return 0;
  let c = 0;
  for (let i = 0; i < n; i++) if (ids[i] != null) c++;
  return c / n;
}

function uniqueIdIndex(ids: (string | null)[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id == null) continue;
    map.set(id, map.has(id) ? -1 : i); // -1 marks a duplicate id
  }
  return map;
}

function matchById(ctx: DiffContext): [Int32Array, Int32Array] {
  const b2t = new Int32Array(ctx.base.vertexCount).fill(-1);
  const t2b = new Int32Array(ctx.target.vertexCount).fill(-1);
  const bMap = uniqueIdIndex(ctx.base.vertexIds!);
  const tMap = uniqueIdIndex(ctx.target.vertexIds!);
  for (const [id, t] of tMap) {
    if (t < 0) continue;
    const b = bMap.get(id);
    if (b === undefined || b < 0) continue;
    b2t[b] = t;
    t2b[t] = b;
  }
  return [b2t, t2b];
}

function matchByIndex(ctx: DiffContext): [Int32Array, Int32Array] {
  const nB = ctx.base.vertexCount;
  const nT = ctx.target.vertexCount;
  const b2t = new Int32Array(nB).fill(-1);
  const t2b = new Int32Array(nT).fill(-1);
  const n = Math.min(nB, nT);
  for (let i = 0; i < n; i++) {
    b2t[i] = i;
    t2b[i] = i;
  }
  return [b2t, t2b];
}

function evaluate(ctx: DiffContext, mode: 'ID' | 'index', b2t: Int32Array, t2b: Int32Array): IEvaluation {
  const { base, target } = ctx;
  const nB = base.vertexCount;
  const nT = target.vertexCount;
  const bf = base.faces;
  const tf = target.faces;
  const tSet = ctx.targetFaceSet;
  const bSet = ctx.baseFaceSet;

  const hasFace = new Uint8Array(nB);
  const hasPreserved = new Uint8Array(nB);
  let preservedB = 0;
  for (let f = 0; f < bf.length; f += 3) {
    const a = bf[f];
    const b = bf[f + 1];
    const c = bf[f + 2];
    hasFace[a] = hasFace[b] = hasFace[c] = 1;
    const ta = b2t[a];
    const tb = b2t[b];
    const tc = b2t[c];
    if (ta >= 0 && tb >= 0 && tc >= 0 && tSet.has(ta, tb, tc)) {
      preservedB++;
      hasPreserved[a] = hasPreserved[b] = hasPreserved[c] = 1;
    }
  }
  // Orphan rule.
  let orphaned = 0;
  let matched = 0;
  for (let b = 0; b < nB; b++) {
    const t = b2t[b];
    if (t < 0) continue;
    if (hasFace[b] && !hasPreserved[b]) {
      b2t[b] = -1;
      t2b[t] = -1;
      orphaned++;
    } else matched++;
  }
  let preservedT = 0;
  for (let f = 0; f < tf.length; f += 3) {
    const ba = t2b[tf[f]];
    const bb = t2b[tf[f + 1]];
    const bc = t2b[tf[f + 2]];
    if (ba >= 0 && bb >= 0 && bc >= 0 && bSet.has(ba, bb, bc)) preservedT++;
  }
  const minF = Math.min(base.faceCount, target.faceCount);
  const minV = Math.min(nB, nT);
  const preservedFaces = Math.min(preservedB, preservedT);
  const faceAgreement = minF === 0 ? 1 : Math.min(1, preservedFaces / minF);
  const matchedFraction = minV === 0 ? 1 : Math.min(1, matched / minV);
  return {
    mode,
    baseToTarget: b2t,
    targetToBase: t2b,
    score: Math.min(faceAgreement, matchedFraction),
    faceAgreement,
    matchedFraction,
    preservedFaces,
    matched,
    orphaned,
  };
}

export function runTier1(ctx: DiffContext): ITierOutcome {
  const { base, target } = ctx;
  const threshold = ctx.options.thresholds.tier1;
  const covB = idCoverage(base.vertexIds, base.vertexCount);
  const covT = idCoverage(target.vertexIds, target.vertexCount);
  const idCov = Math.min(covB, covT);

  let idEval: IEvaluation | null = null;
  if (idCov >= ID_COVERAGE_MIN) idEval = evaluate(ctx, 'ID', ...matchById(ctx));
  let best = idEval;
  if (!idEval || idEval.score < threshold) {
    const ixEval = evaluate(ctx, 'index', ...matchByIndex(ctx));
    if (!best || ixEval.score > best.score) best = ixEval;
  }
  const e = best!;
  const minF = Math.min(base.faceCount, target.faceCount);
  const minV = Math.min(base.vertexCount, target.vertexCount);
  let reason =
    `${e.mode} mode: ${pct(e.faceAgreement)} of the smaller mesh's faces preserved (${e.preservedFaces}/${minF}), ` +
    `${pct(e.matchedFraction)} of its vertices matched (${e.matched}/${minV})`;
  if (e.orphaned > 0) reason += `, ${e.orphaned} orphaned pair(s) un-matched`;
  if (idEval && e.mode === 'index') reason += `; ID mode scored only ${idEval.score.toFixed(3)}`;
  const dv = target.vertexCount - base.vertexCount;
  if (dv !== 0) reason += `; target has ${dv > 0 ? '+' : ''}${dv} vertices vs base`;

  return {
    tier: 1,
    score: e.score,
    reason,
    metrics: {
      idMode: e.mode === 'ID' ? 1 : 0,
      idCoverage: idCov,
      faceAgreement: e.faceAgreement,
      matchedFraction: e.matchedFraction,
      preservedFaces: e.preservedFaces,
      matchedPairs: e.matched,
      orphanedPairs: e.orphaned,
    },
    targetToBase: e.targetToBase,
    baseToTarget: e.baseToTarget,
    alignment: identityAlignment(),
  };
}
