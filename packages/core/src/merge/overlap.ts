/**
 * Spatial overlap of the two sides' ADDITIONS (docs/merge-design.md §4, overlapping-additions):
 * two non-identical added triangles, one from each side, that share no vertex and
 *   (a) cross — an edge of one pierces the other (Möller–Trumbore segment test), or
 *   (b) touch — a vertex of one lies within eps of the other (covers coplanar overlaps).
 * Positions are compared in the BASE frame (each side's frames removed), so the test is
 * independent of global / part motions. A uniform grid over theirs' triangles keeps it
 * near-linear for typical additions.
 */
import { closestPointOnTriangle } from '../diff/spatial.js';
import type { IMergePlan } from './plan.js';
import type { ISide } from './sides.js';

/** Max reported pairs (regions union them anyway). */
export const MAX_OVERLAP_PAIRS = 10000;

interface ITris {
  /** Slot = index into side.addedFaces. */
  slots: number[];
  pos: Float64Array; // 9 per triangle
  canon: Int32Array; // 3 per triangle
  box: Float64Array; // 6 per triangle
}

function collect(side: ISide, addedPos: Float64Array, convergent: Uint8Array, canon: (t: number) => number, base: IMergePlan['base']): ITris {
  const slots: number[] = [];
  const F = side.mesh.faces;
  side.addedFaces.forEach((f, i) => {
    if (!convergent[f]) slots.push(i);
  });
  const pos = new Float64Array(slots.length * 9);
  const cn = new Int32Array(slots.length * 3);
  const box = new Float64Array(slots.length * 6);
  const bp = base.positions;
  slots.forEach((i, k) => {
    const f = side.addedFaces[i];
    for (let c = 0; c < 3; c++) {
      const t = F[f * 3 + c];
      const b = side.inv[t];
      cn[k * 3 + c] = canon(t);
      for (let a = 0; a < 3; a++) {
        // Anchors: base position + the side's own local edit; added vertices: base-frame position.
        pos[k * 9 + c * 3 + a] = b >= 0 ? bp[b * 3 + a] + side.delta[b * 3 + a] : addedPos[t * 3 + a];
      }
    }
    for (let a = 0; a < 3; a++) {
      const v0 = pos[k * 9 + a];
      const v1 = pos[k * 9 + 3 + a];
      const v2 = pos[k * 9 + 6 + a];
      box[k * 6 + a] = Math.min(v0, v1, v2);
      box[k * 6 + 3 + a] = Math.max(v0, v1, v2);
    }
  });
  return { slots, pos, canon: cn, box };
}

function segmentHitsTriangle(p: Float64Array, po: number, qo: number, t: Float64Array, to: number): boolean {
  const ax = t[to];
  const ay = t[to + 1];
  const az = t[to + 2];
  const e1x = t[to + 3] - ax;
  const e1y = t[to + 4] - ay;
  const e1z = t[to + 5] - az;
  const e2x = t[to + 6] - ax;
  const e2y = t[to + 7] - ay;
  const e2z = t[to + 8] - az;
  const dx = p[qo] - p[po];
  const dy = p[qo + 1] - p[po + 1];
  const dz = p[qo + 2] - p[po + 2];
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  const scale = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z) * Math.hypot(dx, dy, dz);
  if (!(Math.abs(det) > 1e-12 * scale)) return false; // parallel / coplanar: handled by the touch test
  const f = 1 / det;
  const sx = p[po] - ax;
  const sy = p[po + 1] - ay;
  const sz = p[po + 2] - az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return false;
  const s = f * (e2x * qx + e2y * qy + e2z * qz);
  return s >= 0 && s <= 1;
}

function trianglesOverlap(A: ITris, i: number, B: ITris, j: number, eps: number): boolean {
  // Triangles sharing a vertex (a common anchor / unified vertex) are adjacent, not overlapping.
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (A.canon[i * 3 + a] === B.canon[j * 3 + b]) return false;
  const pa = A.pos;
  const pb = B.pos;
  for (let k = 0; k < 3; k++) {
    if (segmentHitsTriangle(pa, i * 9 + k * 3, i * 9 + ((k + 1) % 3) * 3, pb, j * 9)) return true;
    if (segmentHitsTriangle(pb, j * 9 + k * 3, j * 9 + ((k + 1) % 3) * 3, pa, i * 9)) return true;
  }
  const e2 = eps * eps;
  const touch = (P: Float64Array, o: number, T: Float64Array, to: number): boolean =>
    closestPointOnTriangle(P[o], P[o + 1], P[o + 2], T[to], T[to + 1], T[to + 2], T[to + 3], T[to + 4], T[to + 5], T[to + 6], T[to + 7], T[to + 8]) <= e2;
  for (let k = 0; k < 3; k++) {
    if (touch(pa, i * 9 + k * 3, pb, j * 9)) return true;
    if (touch(pb, j * 9 + k * 3, pa, i * 9)) return true;
  }
  return false;
}

/** Pairs [ours slot, theirs slot] of interpenetrating / touching non-convergent additions. */
export function findOverlaps(
  plan: IMergePlan,
  canonOurs: (t: number) => number,
  canonTheirs: (t: number) => number,
  eps: number,
): Array<[number, number]> {
  const A = collect(plan.ours, plan.oursAddedPos, plan.oursConvergent, canonOurs, plan.base);
  const B = collect(plan.theirs, plan.theirsAddedPos, plan.theirsConvergent, canonTheirs, plan.base);
  const out: Array<[number, number]> = [];
  if (A.slots.length === 0 || B.slots.length === 0) return out;
  // Grid over theirs' triangles; cell = mean triangle extent.
  let ext = 0;
  for (let j = 0; j < B.slots.length; j++) {
    ext += Math.max(B.box[j * 6 + 3] - B.box[j * 6], B.box[j * 6 + 4] - B.box[j * 6 + 1], B.box[j * 6 + 5] - B.box[j * 6 + 2]);
  }
  const cell = Math.max(ext / B.slots.length, eps * 16, 1e-12);
  const grid = new Map<string, number[]>();
  const cellsOf = (box: Float64Array, o: number, pad: number, fn: (k: string) => void): boolean => {
    const lo = [0, 1, 2].map((a) => Math.floor((box[o + a] - pad) / cell));
    const hi = [0, 1, 2].map((a) => Math.floor((box[o + 3 + a] + pad) / cell));
    const count = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (count > 4096) return false;
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) fn(`${x},${y},${z}`);
    return true;
  };
  const big: number[] = [];
  for (let j = 0; j < B.slots.length; j++) {
    const ok = cellsOf(B.box, j * 6, eps, (k) => {
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(j);
    });
    if (!ok) big.push(j);
  }
  const boxesTouch = (i: number, j: number): boolean => {
    for (let a = 0; a < 3; a++) {
      if (A.box[i * 6 + a] - eps > B.box[j * 6 + 3 + a] || B.box[j * 6 + a] - eps > A.box[i * 6 + 3 + a]) return false;
    }
    return true;
  };
  for (let i = 0; i < A.slots.length && out.length < MAX_OVERLAP_PAIRS; i++) {
    const cand = new Set<number>(big);
    const ok = cellsOf(A.box, i * 6, eps, (k) => {
      for (const j of grid.get(k) ?? []) cand.add(j);
    });
    if (!ok) for (let j = 0; j < B.slots.length; j++) cand.add(j);
    for (const j of [...cand].sort((a, b) => a - b)) {
      if (!boxesTouch(i, j)) continue;
      if (trianglesOverlap(A, i, B, j, eps)) {
        out.push([A.slots[i], B.slots[j]]);
        break;
      }
    }
  }
  return out;
}
