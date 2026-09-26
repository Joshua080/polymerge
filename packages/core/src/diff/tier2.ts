/**
 * TIER 2 — topological fallback: greedy geometric + adjacency matching (MeshGit-inspired).
 *
 * 1. SEEDS: mutual nearest neighbours within moveEpsilon (kd-trees on both meshes):
 *    b's nearest target vertex is t AND t's nearest base vertex is b → (b, t) unchanged.
 *    A pair is only seeded when it is UNAMBIGUOUS (no second vertex within moveEpsilon on
 *    either side); coincident duplicates such as unwelded seams would otherwise be paired
 *    by index tie-break, possibly across components. They are resolved by propagation
 *    (topology picks the partner whose neighbourhood agrees) or by the leftover pass.
 * 2. PROPAGATION: a min-heap of candidate pairs (b', t') where b' is an unmatched
 *    neighbour of a matched b and t' an unmatched neighbour of its partner t.
 *
 *    Validity gate — FACE SUPPORT: at least one base face (b', x, y) with x, y matched
 *    must map onto an existing target face (t', x', y'). A candidate is thus always
 *    anchored on a matched edge whose triangle exists on both sides. Isolated coincident
 *    vertices (typical of a remesh: corners, every 3rd sample) cannot grow a foreign
 *    tessellation, while moved vertices next to matched triangles (bumps, dents) can.
 *    Support only grows as matches are added, and every support-increasing match pushes
 *    the candidate again, so the lazy heap never misses a newly valid pair.
 *
 *    Cost of a supported pair:
 *
 *        cost(b', t') = g / √a + W · (1 − J)
 *
 *    a  = # matched neighbours of b' whose partner is a neighbour of t'  (agreement, ≥ 2)
 *    mb = # matched neighbours of b',  mt = # matched neighbours of t'
 *    J  = a / (mb + mt − a)   — Jaccard agreement of the two matched neighbourhoods
 *    g  = |target[t'] − (base[b'] + δ̄)| / L  — geometric residual after carrying b' along
 *         with δ̄, the mean displacement of its a agreeing neighbours, normalised by
 *         L = ½ (mean edge length at b' + mean edge length at t').
 *    W  = TIER2_ADJACENCY_WEIGHT (2).
 *
 *    More agreement lowers the cost twice: J → 1 removes the topology penalty, and every
 *    agreeing neighbour widens the geometric tolerance by √a. A vertex surrounded by
 *    matched neighbours therefore matches even when it moved several edge lengths
 *    (a raised bump), while frontier pairs with a single supporting neighbour must stay
 *    within ~TIER2_COST_CUTOFF edge lengths of where their neighbours predict.
 *    Pairs with cost > TIER2_COST_CUTOFF (3) are never accepted, so genuinely added or
 *    removed geometry stays unmatched (no candidate pair even exists unless unmatched
 *    vertices exist on both sides next to the same matched pair).
 *    Costs are re-evaluated lazily when popped (agreement can only change when matches
 *    are added, and every agreement-increasing match pushes fresh entries).
 * 3. LEFTOVERS: unmatched vertices are paired by near-exact position (≤ moveEpsilon,
 *    mutual among the unmatched — resolves coincident duplicates), then propagation
 *    resumes from those pairs.
 *
 * Score = coverage × edgeConsistency   (default acceptance threshold 0.6)
 *   coverage        = (matched − slid) / (min(nBase, nTarget) + onSurfaceUnmatched)
 *   edgeConsistency = (base edges with both ends matched whose image is a target edge +
 *                      the same count from the target side) /
 *                     (base edges with both ends matched + target edges with both ends matched)
 *   slid               = matched pairs with displacement d > moveEpsilon whose target vertex
 *                        still lies within d/2 of the base surface (moved ALONG the old surface)
 *   onSurfaceUnmatched = unmatched vertices within min(surfaceTolerance, ¼ local mean edge
 *                        length) of the other mesh's surface
 * Normalising by the smaller mesh keeps appended/removed geometry free (it lies off the
 * other surface); the two retessellation terms are what separate "an edit of one
 * tessellation" (evidence ≈ 0) from "two tessellations of one surface" (e.g. 24- vs
 * 32-segment capped cylinders: fans around coincident cap centres propagate cleanly, yet
 * 32/50 matches slid and 16/16 unmatched vertices lie on the base surface → 0.25).
 * No seeds ⇒ score 0 with an explicit reason (e.g. the whole model moved rigidly), so
 * Tier 3 takes over. Disconnected components are handled naturally: seeds are global.
 */
import { hasNeighbor, type IAdjacency } from './adjacency.js';
import { pct, identityAlignment, type DiffContext, type ITierOutcome } from './context.js';
import { identityRigid } from './linalg.js';
import { recoverPartsTopological } from './parts.js';
import { PROPAGATION_ADJACENCY_WEIGHT, PROPAGATION_COST_CUTOFF, Propagator } from './propagate.js';
import { closestPointOnTriangle, type KdTree } from './spatial.js';

export const TIER2_ADJACENCY_WEIGHT = PROPAGATION_ADJACENCY_WEIGHT;
export const TIER2_COST_CUTOFF = PROPAGATION_COST_CUTOFF;

export function runTier2(ctx: DiffContext): ITierOutcome {
  const { base, target } = ctx;
  const nB = base.vertexCount;
  const nT = target.vertexCount;
  const b2t = new Int32Array(nB).fill(-1);
  const t2b = new Int32Array(nT).fill(-1);
  const minV = Math.min(nB, nT);

  if (minV === 0) {
    return {
      tier: 2,
      score: 1,
      reason: 'one mesh has no vertices: everything on the other side is added/removed',
      metrics: { seeds: 0, propagated: 0, leftoverMatched: 0, matchedPairs: 0, matchedFraction: 1, edgeConsistency: 1 },
      targetToBase: t2b,
      baseToTarget: b2t,
      alignment: identityAlignment(),
    };
  }

  const eps = ctx.options.moveEpsilon;
  const eps2 = eps * eps;
  const bp = base.positions;
  const tp = target.positions;
  const kdT = ctx.targetKd;
  const kdB = ctx.baseKd;

  // ---- 1. Seeds: unambiguous mutual nearest neighbours within moveEpsilon --------------
  let seeds = 0;
  let ambiguous = 0;
  for (let b = 0; b < nB; b++) {
    const x = bp[b * 3];
    const y = bp[b * 3 + 1];
    const z = bp[b * 3 + 2];
    const t = kdT.nearest(x, y, z, eps2);
    if (t < 0) continue;
    if (kdB.nearest(tp[t * 3], tp[t * 3 + 1], tp[t * 3 + 2], eps2) !== b) continue;
    // Coincident duplicates (unwelded seams) make "nearest" an index tie-break: leave them
    // to the topology-aware propagation / leftover pass instead of guessing.
    if (kdT.countWithin(x, y, z, eps2, 2) > 1 || kdB.countWithin(tp[t * 3], tp[t * 3 + 1], tp[t * 3 + 2], eps2, 2) > 1) {
      ambiguous++;
      continue;
    }
    b2t[b] = t;
    t2b[t] = b;
    seeds++;
  }
  if (seeds === 0 && ambiguous === 0) {
    return {
      tier: 2,
      score: 0,
      reason:
        'no seed pairs: no base vertex has a mutual-nearest target vertex within moveEpsilon ' +
        '(model moved rigidly, rescaled or remeshed?) — nothing to propagate from',
      metrics: {
        seeds: 0,
        ambiguousSeeds: 0,
        propagated: 0,
        leftoverMatched: 0,
        matchedPairs: 0,
        matchedFraction: 0,
        edgeConsistency: 0,
      },
      targetToBase: t2b,
      baseToTarget: b2t,
      alignment: identityAlignment(),
    };
  }

  // ---- 2. Propagation (propagate.ts) ----------------------------------------------------
  const adjB = ctx.baseAdjacency;
  const adjT = ctx.targetAdjacency;
  const offB = adjB.offsets;
  const nbB = adjB.neighbors;
  const offT = adjT.offsets;
  const nbT = adjT.neighbors;
  const Lb = ctx.baseEdgeLengths;
  const Lt = ctx.targetEdgeLengths;
  const prop = new Propagator(ctx, b2t, t2b, 4 * (nB - seeds) + 64);
  for (let b = 0; b < nB; b++) if (b2t[b] >= 0) prop.pushFrom(b, b2t[b]);
  let propagated = prop.drain();

  // ---- 3. Leftovers by near-exact position ---------------------------------------------
  const takenT = new Uint8Array(nT);
  const takenB = new Uint8Array(nB);
  for (let t = 0; t < nT; t++) takenT[t] = t2b[t] >= 0 ? 1 : 0;
  for (let b = 0; b < nB; b++) takenB[b] = b2t[b] >= 0 ? 1 : 0;
  const fresh: number[] = [];
  for (let b = 0; b < nB; b++) {
    if (takenB[b]) continue;
    const t = kdT.nearest(bp[b * 3], bp[b * 3 + 1], bp[b * 3 + 2], eps2, takenT);
    if (t < 0) continue;
    if (kdB.nearest(tp[t * 3], tp[t * 3 + 1], tp[t * 3 + 2], eps2, takenB) !== b) continue;
    b2t[b] = t;
    t2b[t] = b;
    takenB[b] = 1;
    takenT[t] = 1;
    fresh.push(b);
  }
  const leftoverMatched = fresh.length;
  if (leftoverMatched > 0) {
    for (const b of fresh) prop.pushFrom(b, b2t[b]);
    propagated += prop.drain();
  }

  // ---- 3b. Moved parts: components that moved rigidly on their own ------------------------
  // Positional seeds cannot exist inside a part that moved away from where it was; rigid
  // registration of the still-unmatched components re-matches it (parts.ts), so it reads as
  // Moved instead of Removed + Added — and counts towards coverage below.
  const parts = ctx.options.detectParts ? recoverPartsTopological(ctx, identityRigid(), b2t, t2b) : [];
  const inPart = new Uint8Array(nT);
  let partMatched = 0;
  for (const p of parts) {
    for (const t of p.targetVertices) {
      inPart[t] = 1;
      if (t2b[t] >= 0) partMatched++;
    }
  }

  // ---- 4. Score ------------------------------------------------------------------------
  let matched = 0;
  for (let b = 0; b < nB; b++) if (b2t[b] >= 0) matched++;
  let totB = 0;
  let consB = 0;
  for (let b = 0; b < nB; b++) {
    const t1 = b2t[b];
    if (t1 < 0) continue;
    for (let i = offB[b], e = offB[b + 1]; i < e; i++) {
      const b2 = nbB[i];
      if (b2 <= b) continue;
      const t2 = b2t[b2];
      if (t2 < 0) continue;
      totB++;
      if (hasNeighbor(adjT, t1, t2)) consB++;
    }
  }
  let totT = 0;
  let consT = 0;
  for (let t = 0; t < nT; t++) {
    const b1 = t2b[t];
    if (b1 < 0) continue;
    for (let j = offT[t], e = offT[t + 1]; j < e; j++) {
      const t2 = nbT[j];
      if (t2 <= t) continue;
      const b2 = t2b[t2];
      if (b2 < 0) continue;
      totT++;
      if (hasNeighbor(adjB, b1, b2)) consT++;
    }
  }
  const matchedFraction = Math.min(1, matched / minV);
  const edgeConsistency = totB + totT === 0 ? 1 : (consB + consT) / (totB + totT);

  // ---- 5. Retessellation evidence ------------------------------------------------------
  // A locally consistent matching can still be a wrong explanation: two tessellations of
  // ONE surface (e.g. fans around coincident cap centres) propagate happily. Their scale-
  // free signature, absent from genuine edits (which move vertices OFF the old surface or
  // add/remove geometry ≳ one edge away from it), is:
  //  (a) SLID matches: displacement d > moveEpsilon, yet the target vertex still lies
  //      within d/2 of the BASE surface — it slid tangentially along the old surface;
  //  (b) ON-SURFACE unmatched vertices: within min(surfaceTolerance, ¼ local mean edge
  //      length) of the OTHER mesh's surface — "added"/"removed" but already explained.
  // Surface distance is measured locally (LocalSurface: faces around the nearest vertex of
  // the other mesh) — no BVH build; it can only over-estimate, i.e. errs towards Tier 2.
  const tol = ctx.options.surfaceTolerance;
  const baseNear = new LocalSurface(base.positions, base.faces, ctx.baseVertexFaces, adjB, kdB);
  const targetNear = new LocalSurface(target.positions, target.faces, ctx.targetVertexFaces, adjT, kdT);
  let slid = 0;
  let onSurface = 0;
  for (let t = 0; t < nT; t++) {
    const x = tp[t * 3];
    const y = tp[t * 3 + 1];
    const z = tp[t * 3 + 2];
    const b = t2b[t];
    if (b >= 0) {
      if (inPart[t]) continue; // a registered rigid part motion is not a retessellation slide
      const d = Math.hypot(bp[b * 3] - x, bp[b * 3 + 1] - y, bp[b * 3 + 2] - z);
      if (d > eps && baseNear.within(x, y, z, 0.25 * d * d)) slid++;
    } else {
      const lim = Math.min(tol, 0.25 * Lt[t]);
      if (baseNear.within(x, y, z, lim * lim)) onSurface++;
    }
  }
  for (let b = 0; b < nB; b++) {
    if (b2t[b] >= 0) continue;
    const lim = Math.min(tol, 0.25 * Lb[b]);
    if (targetNear.within(bp[b * 3], bp[b * 3 + 1], bp[b * 3 + 2], lim * lim)) onSurface++;
  }
  const coverage = Math.min(1, (matched - slid) / (minV + onSurface));
  const score = coverage * edgeConsistency;
  let reason =
    `${seeds} seed(s) within moveEpsilon${ambiguous > 0 ? ` (+${ambiguous} ambiguous deferred)` : ''}, ` +
    `${propagated} propagated, ${leftoverMatched} exact-position leftover(s) → ` +
    `${matched}/${minV} of the smaller mesh matched (${pct(matchedFraction)}), edge consistency ${pct(edgeConsistency)}`;
  if (parts.length > 0) {
    reason += `; ${parts.length} moved part(s) re-matched by rigid registration (${partMatched} vertices)`;
  }
  if (slid + onSurface > 0) {
    reason +=
      `; retessellation evidence: ${slid} match(es) slid along the old surface, ` +
      `${onSurface} unmatched vertex(es) lie on the other surface → coverage ${pct(coverage)}`;
  }

  return {
    tier: 2,
    score,
    reason,
    metrics: {
      seeds,
      ambiguousSeeds: ambiguous,
      propagated,
      leftoverMatched,
      matchedPairs: matched,
      matchedFraction,
      edgeConsistency,
      slidMatches: slid,
      onSurfaceUnmatched: onSurface,
      coverage,
      partsRecovered: parts.length,
      maxAcceptedCost: prop.maxAcceptedCost,
      heapPops: prop.heapPops,
    },
    targetToBase: t2b,
    baseToTarget: b2t,
    alignment: identityAlignment(),
    parts,
  };
}

/**
 * Local "is a point within r of this surface?" test: exact point–triangle distances over the
 * faces incident to the nearest vertex and to its neighbours (a 2-ring). Exact whenever the
 * closest surface point lies in that neighbourhood — always the case for points near a
 * reasonably shaped mesh — and otherwise an over-estimate.
 */
class LocalSurface {
  constructor(
    private readonly pos: Float64Array,
    private readonly faces: Uint32Array,
    private readonly vf: IAdjacency,
    private readonly adj: IAdjacency,
    private readonly kd: KdTree,
  ) {}

  within(x: number, y: number, z: number, r2: number): boolean {
    const v = this.kd.nearest(x, y, z);
    if (v < 0) return false;
    if (this.kd.lastDist2 <= r2) return true;
    if (this.facesWithin(v, x, y, z, r2)) return true;
    const off = this.adj.offsets;
    const nb = this.adj.neighbors;
    for (let i = off[v], e = off[v + 1]; i < e; i++) if (this.facesWithin(nb[i], x, y, z, r2)) return true;
    return false;
  }

  private facesWithin(v: number, x: number, y: number, z: number, r2: number): boolean {
    const p = this.pos;
    const f = this.faces;
    const off = this.vf.offsets;
    const list = this.vf.neighbors;
    for (let i = off[v], e = off[v + 1]; i < e; i++) {
      const o = list[i] * 3;
      const a = f[o] * 3;
      const b = f[o + 1] * 3;
      const c = f[o + 2] * 3;
      const d2 = closestPointOnTriangle(x, y, z, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]);
      if (d2 <= r2) return true;
    }
    return false;
  }
}
