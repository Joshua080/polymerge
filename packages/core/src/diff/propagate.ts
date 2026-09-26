/**
 * MeshGit-inspired greedy correspondence PROPAGATION over vertex adjacency, shared by Tier 2
 * (grow from positional seeds), Tier 1's part-recovery post-pass and moved-part recovery
 * (grow from registration seeds). It extends a one-to-one partial matching in place.
 *
 * A min-heap holds candidate pairs (b', t') where b' is an unmatched neighbour of a matched
 * b and t' an unmatched neighbour of its partner t.
 *
 * Validity gate — FACE SUPPORT: at least one base face (b', x, y) with x, y matched must map
 * onto an existing target face (t', x', y'). A candidate is thus always anchored on a matched
 * edge whose triangle exists on both sides. Isolated coincident vertices (typical of a
 * remesh) cannot grow a foreign tessellation, while moved vertices next to matched
 * triangles (bumps, dents) can.
 *
 * Cost of a supported pair:   cost(b', t') = g / √a + W · (1 − J)
 *   a  = # matched neighbours of b' whose partner is a neighbour of t'  (agreement)
 *   mb, mt = # matched neighbours of b' / t'
 *   J  = a / (mb + mt − a)   — Jaccard agreement of the two matched neighbourhoods
 *   g  = |target[t'] − (base[b'] + δ̄)| / L  — residual after carrying b' along with δ̄, the
 *        mean displacement of its a agreeing neighbours, normalised by
 *        L = ½ (mean edge length at b' + mean edge length at t'). Any affine displacement
 *        field (a rigidly moved or uniformly scaled part) is followed to first order.
 *   W  = PROPAGATION_ADJACENCY_WEIGHT (2).
 * Pairs costing more than PROPAGATION_COST_CUTOFF (3) are never accepted. Costs are
 * re-evaluated lazily when popped (agreement only grows as matches are added, and every
 * agreement-increasing match pushes fresh entries).
 */
import { hasNeighbor } from './adjacency.js';
import type { DiffContext } from './context.js';
import { PairHeap } from './heap.js';

export const PROPAGATION_ADJACENCY_WEIGHT = 2;
export const PROPAGATION_COST_CUTOFF = 3;

export class Propagator {
  maxAcceptedCost = 0;
  heapPops = 0;
  private readonly heap: PairHeap;

  constructor(
    private readonly ctx: DiffContext,
    readonly b2t: Int32Array,
    readonly t2b: Int32Array,
    capacityHint = 1024,
  ) {
    this.heap = new PairHeap(Math.max(1024, Math.min(1 << 20, capacityHint)));
  }

  /** Cost of pairing unmatched b' with unmatched t' (Infinity when unsupported). */
  cost(bv: number, tv: number): number {
    const { ctx, b2t, t2b } = this;
    const bp = ctx.base.positions;
    const tp = ctx.target.positions;
    const bf = ctx.base.faces;
    const vf = ctx.baseVertexFaces;
    const offVF = vf.offsets;
    const listVF = vf.neighbors;
    const tSet = ctx.targetFaceSet;
    // Face support gate.
    let supported = false;
    for (let i = offVF[bv], e = offVF[bv + 1]; i < e; i++) {
      const f = listVF[i] * 3;
      const v0 = bf[f];
      const v1 = bf[f + 1];
      const v2 = bf[f + 2];
      const x = v0 === bv ? v1 : v0;
      const y = v2 === bv ? v1 : v2;
      const tx = b2t[x];
      const ty = b2t[y];
      if (tx >= 0 && ty >= 0 && tSet.has(tv, tx, ty)) {
        supported = true;
        break;
      }
    }
    if (!supported) return Infinity;
    const adjB = ctx.baseAdjacency;
    const adjT = ctx.targetAdjacency;
    let mb = 0;
    let a = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = adjB.offsets[bv], e = adjB.offsets[bv + 1]; i < e; i++) {
      const bn = adjB.neighbors[i];
      const tn = b2t[bn];
      if (tn < 0) continue;
      mb++;
      if (hasNeighbor(adjT, tv, tn)) {
        a++;
        sx += tp[tn * 3] - bp[bn * 3];
        sy += tp[tn * 3 + 1] - bp[bn * 3 + 1];
        sz += tp[tn * 3 + 2] - bp[bn * 3 + 2];
      }
    }
    if (a === 0) return Infinity;
    let mt = 0;
    for (let j = adjT.offsets[tv], e = adjT.offsets[tv + 1]; j < e; j++) if (t2b[adjT.neighbors[j]] >= 0) mt++;
    const J = a / (mb + mt - a);
    const px = bp[bv * 3] + sx / a;
    const py = bp[bv * 3 + 1] + sy / a;
    const pz = bp[bv * 3 + 2] + sz / a;
    const L = 0.5 * (ctx.baseEdgeLengths[bv] + ctx.targetEdgeLengths[tv]);
    const g = Math.hypot(tp[tv * 3] - px, tp[tv * 3 + 1] - py, tp[tv * 3 + 2] - pz) / L;
    return g / Math.sqrt(a) + PROPAGATION_ADJACENCY_WEIGHT * (1 - J);
  }

  /** Queue every candidate pair around the matched pair (b, t). */
  pushFrom(b: number, t: number): void {
    const { b2t, t2b } = this;
    const adjB = this.ctx.baseAdjacency;
    const adjT = this.ctx.targetAdjacency;
    for (let i = adjB.offsets[b], ei = adjB.offsets[b + 1]; i < ei; i++) {
      const bv = adjB.neighbors[i];
      if (b2t[bv] >= 0) continue;
      for (let j = adjT.offsets[t], ej = adjT.offsets[t + 1]; j < ej; j++) {
        const tv = adjT.neighbors[j];
        if (t2b[tv] >= 0) continue;
        const c = this.cost(bv, tv);
        if (c <= PROPAGATION_COST_CUTOFF) this.heap.push(c, bv, tv);
      }
    }
  }

  /** Accept candidates cheapest-first until none is left; returns the number accepted. */
  drain(onAccept?: (b: number, t: number) => void): number {
    const { heap, b2t, t2b } = this;
    let accepted = 0;
    while (heap.pop()) {
      this.heapPops++;
      const c0 = heap.topCost;
      const bv = heap.topA;
      const tv = heap.topB;
      if (b2t[bv] >= 0 || t2b[tv] >= 0) continue;
      const c = this.cost(bv, tv);
      if (c > c0) {
        // Stale (agreement dropped since the push): re-queue at its current cost.
        if (c <= PROPAGATION_COST_CUTOFF) heap.push(c, bv, tv);
        continue;
      }
      b2t[bv] = tv;
      t2b[tv] = bv;
      accepted++;
      onAccept?.(bv, tv);
      if (c > this.maxAcceptedCost) this.maxAcceptedCost = c;
      this.pushFrom(bv, tv);
    }
    return accepted;
  }
}
