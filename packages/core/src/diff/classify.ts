/**
 * SHARED CLASSIFIER — turns any tier's correspondence into vertex/face statuses,
 * per-target-vertex displacement and stats, exactly per the status rules in types.ts.
 *
 * Tiers 1 & 2 (one-to-one matching, `surfaceDistance` undefined):
 *   displacement[t] = |A·base[b] − target[t]| for matched t (A = alignment), 0 if Added;
 *   vertex: matched & d ≤ moveEpsilon → Unchanged, matched & d > moveEpsilon → Moved,
 *   unmatched → Added (target) / Removed (base). A base vertex shares its partner's status.
 * Tier 3 (`surfaceDistance` present): d = nearest-SURFACE distance in aligned space;
 *   unmatched (d > surfaceTolerance) → Added/Removed, d ≤ moveEpsilon → Unchanged,
 *   else Moved; displacement[t] = d (0 for Added).
 * Faces (unordered vertex triples):
 *   target: any vertex Added, or (Tiers 1/2) mapped triple not a base face → Added;
 *           else any vertex Moved → Modified; else Unchanged. Base side symmetric (Removed).
 * Stats: vertex unchanged/moved and face unchanged/modified are counted on the TARGET side
 * (results live in target space; for Tiers 1/2 both sides agree); added from the target,
 * removed from the base. max/mean displacement over Moved target vertices.
 */
import { FaceStatus, VertexStatus, type IDiffStats } from '../types.js';
import type { DiffContext, ITierOutcome } from './context.js';
import { mat4ToRigid } from './linalg.js';

export interface IClassification {
  baseVertexStatus: Uint8Array;
  targetVertexStatus: Uint8Array;
  displacement: Float32Array;
  baseFaceStatus: Uint8Array;
  targetFaceStatus: Uint8Array;
  stats: IDiffStats;
}

export function classify(ctx: DiffContext, outcome: ITierOutcome): IClassification {
  const { base, target } = ctx;
  const eps = ctx.options.moveEpsilon;
  const nB = base.vertexCount;
  const nT = target.vertexCount;
  const b2t = outcome.baseToTarget;
  const t2b = outcome.targetToBase;
  const targetVertexStatus = new Uint8Array(nT);
  const baseVertexStatus = new Uint8Array(nB);
  const displacement = new Float32Array(nT);

  let moved = 0;
  let unchanged = 0;
  let added = 0;
  let removed = 0;
  let maxD = 0;
  let sumD = 0;

  const surf = outcome.surfaceDistance;
  if (!surf) {
    const g = mat4ToRigid(outcome.alignment.matrix);
    const r = g.r.map((v) => v * g.s); // s·R (the alignment may be a similarity)
    const tr = g.t;
    const bp = base.positions;
    const tp = target.positions;
    for (let t = 0; t < nT; t++) {
      const b = t2b[t];
      if (b < 0) {
        targetVertexStatus[t] = VertexStatus.Added;
        added++;
        continue;
      }
      const x = bp[b * 3];
      const y = bp[b * 3 + 1];
      const z = bp[b * 3 + 2];
      const d = Math.hypot(
        r[0] * x + r[1] * y + r[2] * z + tr[0] - tp[t * 3],
        r[3] * x + r[4] * y + r[5] * z + tr[1] - tp[t * 3 + 1],
        r[6] * x + r[7] * y + r[8] * z + tr[2] - tp[t * 3 + 2],
      );
      displacement[t] = d;
      if (d <= eps) {
        targetVertexStatus[t] = VertexStatus.Unchanged;
        unchanged++;
      } else {
        targetVertexStatus[t] = VertexStatus.Moved;
        moved++;
        sumD += d;
        if (d > maxD) maxD = d;
      }
    }
    for (let b = 0; b < nB; b++) {
      const t = b2t[b];
      if (t < 0) {
        baseVertexStatus[b] = VertexStatus.Removed;
        removed++;
      } else baseVertexStatus[b] = targetVertexStatus[t];
    }
  } else {
    for (let t = 0; t < nT; t++) {
      const d = surf.target[t];
      if (t2b[t] < 0) {
        targetVertexStatus[t] = VertexStatus.Added;
        added++;
      } else if (d <= eps) {
        targetVertexStatus[t] = VertexStatus.Unchanged;
        displacement[t] = d;
        unchanged++;
      } else {
        targetVertexStatus[t] = VertexStatus.Moved;
        displacement[t] = d;
        moved++;
        sumD += d;
        if (d > maxD) maxD = d;
      }
    }
    for (let b = 0; b < nB; b++) {
      const d = surf.base[b];
      if (b2t[b] < 0) {
        baseVertexStatus[b] = VertexStatus.Removed;
        removed++;
      } else baseVertexStatus[b] = d <= eps ? VertexStatus.Unchanged : VertexStatus.Moved;
    }
  }

  // Faces.
  const checkTriples = !surf;
  const tf = target.faces;
  const bf = base.faces;
  const targetFaceStatus = new Uint8Array(target.faceCount);
  const baseFaceStatus = new Uint8Array(base.faceCount);
  const fStats = { unchanged: 0, modified: 0, added: 0, removed: 0 };
  const bSet = checkTriples ? ctx.baseFaceSet : null;
  const tSet = checkTriples ? ctx.targetFaceSet : null;
  for (let f = 0; f < target.faceCount; f++) {
    const a = tf[f * 3];
    const b = tf[f * 3 + 1];
    const c = tf[f * 3 + 2];
    const sa = targetVertexStatus[a];
    const sb = targetVertexStatus[b];
    const sc = targetVertexStatus[c];
    let s: number;
    if (sa === VertexStatus.Added || sb === VertexStatus.Added || sc === VertexStatus.Added) s = FaceStatus.Added;
    else if (bSet && !bSet.has(t2b[a], t2b[b], t2b[c])) s = FaceStatus.Added;
    else if (sa === VertexStatus.Moved || sb === VertexStatus.Moved || sc === VertexStatus.Moved) s = FaceStatus.Modified;
    else s = FaceStatus.Unchanged;
    targetFaceStatus[f] = s;
    if (s === FaceStatus.Added) fStats.added++;
    else if (s === FaceStatus.Modified) fStats.modified++;
    else fStats.unchanged++;
  }
  for (let f = 0; f < base.faceCount; f++) {
    const a = bf[f * 3];
    const b = bf[f * 3 + 1];
    const c = bf[f * 3 + 2];
    const sa = baseVertexStatus[a];
    const sb = baseVertexStatus[b];
    const sc = baseVertexStatus[c];
    let s: number;
    if (sa === VertexStatus.Removed || sb === VertexStatus.Removed || sc === VertexStatus.Removed) s = FaceStatus.Removed;
    else if (tSet && !tSet.has(b2t[a], b2t[b], b2t[c])) s = FaceStatus.Removed;
    else if (sa === VertexStatus.Moved || sb === VertexStatus.Moved || sc === VertexStatus.Moved) s = FaceStatus.Modified;
    else s = FaceStatus.Unchanged;
    baseFaceStatus[f] = s;
    if (s === FaceStatus.Removed) fStats.removed++;
  }

  return {
    baseVertexStatus,
    targetVertexStatus,
    displacement,
    baseFaceStatus,
    targetFaceStatus,
    stats: {
      vertices: { unchanged, moved, added, removed },
      faces: fStats,
      maxDisplacement: maxD,
      meanDisplacement: moved > 0 ? sumD / moved : 0,
    },
  };
}
