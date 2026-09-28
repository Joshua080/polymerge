/**
 * COMBINED-EDIT DEFECTS — the `collision` conflict (docs/merge-design.md §4).
 *
 * Two edits can each be fine on their own side yet damage the model once both are applied: two
 * walls pushed towards each other from opposite sides now pass through each other; two
 * neighbouring vertices pushed past each other fold the faces between them. No other conflict
 * kind sees this — the edits touch different vertices — so the merge checks the COMBINATION on
 * the materialised mesh:
 *
 *   fold       a merged face whose shape matches none of base / ours / theirs is flipped against
 *              every version of it that is not degenerate, or collapsed (height < eps) where no
 *              version was;
 *   crossing   two merged faces properly cross — an edge of one passes through the other with
 *              its endpoints more than eps on either side of that face's plane — while the same
 *              two faces cross in none of base, ours or theirs.
 *
 * Only geometry that differs from every version can be new. Each merged face carries a bit per
 * version (ours 1, theirs 2, base 4), set when the face differs from that version or is absent in
 * it; a face pair is examined only when together its faces differ from all three. Face shapes are
 * compared in the base frame (frames removed; they never change a shape); crossings are tested in
 * "part space" (global frame removed, part frames kept), where eps is in base units everywhere.
 *
 * Deliberately NOT detected (v1): surfaces that merely touch or overlap in-plane (coplanar
 * contact), near misses (clearances, minimum wall thickness), and design intent in general.
 */
import { applyRigid, identityRigid, invertRigid, maxMotion } from '../diff/linalg.js';
import { TriangleBvh } from '../diff/spatial.js';
import type { IDiffLogger, IMergeWarning } from '../types.js';
import { materialize, type IMaterialized, type IResolutions } from './materialize.js';
import { addAtomics, type IAtomic, type IMergePlan } from './plan.js';
import type { ISide } from './sides.js';

/** Stop collecting after this many defects (regions union them anyway). */
export const MAX_DEFECTS = 10_000;
/** Bound on the face pairs examined by one check. */
export const MAX_PAIR_TESTS = 5_000_000;
/** Bound on detect → re-region passes (each pass only grows regions, so it converges). */
export const MAX_COLLISION_PASSES = 8;

const IN_OURS = 1;
const IN_THEIRS = 2;
const IN_BASE = 4;
const ALL = IN_OURS | IN_THEIRS | IN_BASE;

export interface IDefect {
  kind: 'crossing' | 'fold';
  /** Merged faces: two for a crossing, one for a fold. */
  faces: number[];
}

export interface IDefectReport {
  defects: IDefect[];
  pairTests: number;
  /** A bound was hit; some defects may be missing. */
  truncated: boolean;
}

// ---- Geometry ------------------------------------------------------------------------------

/** Some edge of P passes through Q: endpoints > eps on either side of Q's plane, hit inside Q. */
function edgePierces(P: Float64Array, Q: Float64Array, eps: number): boolean {
  const ux = Q[3] - Q[0];
  const uy = Q[4] - Q[1];
  const uz = Q[5] - Q[2];
  const vx = Q[6] - Q[0];
  const vy = Q[7] - Q[1];
  const vz = Q[8] - Q[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0)) return false;
  nx /= len;
  ny /= len;
  nz /= len;
  const d0 = nx * (P[0] - Q[0]) + ny * (P[1] - Q[1]) + nz * (P[2] - Q[2]);
  const d1 = nx * (P[3] - Q[0]) + ny * (P[4] - Q[1]) + nz * (P[5] - Q[2]);
  const d2 = nx * (P[6] - Q[0]) + ny * (P[7] - Q[1]) + nz * (P[8] - Q[2]);
  return (
    edgeHit(P, 0, 1, d0, d1, Q, nx, ny, nz, eps) ||
    edgeHit(P, 1, 2, d1, d2, Q, nx, ny, nz, eps) ||
    edgeHit(P, 2, 0, d2, d0, Q, nx, ny, nz, eps)
  );
}

function edgeHit(P: Float64Array, a: number, b: number, da: number, db: number, Q: Float64Array, nx: number, ny: number, nz: number, eps: number): boolean {
  if (!((da > eps && db < -eps) || (da < -eps && db > eps))) return false;
  const t = da / (da - db);
  const x = P[a * 3] + t * (P[b * 3] - P[a * 3]);
  const y = P[a * 3 + 1] + t * (P[b * 3 + 1] - P[a * 3 + 1]);
  const z = P[a * 3 + 2] + t * (P[b * 3 + 2] - P[a * 3 + 2]);
  for (let k = 0; k < 3; k++) {
    const o = k * 3;
    const e = ((k + 1) % 3) * 3;
    const ex = Q[e] - Q[o];
    const ey = Q[e + 1] - Q[o + 1];
    const ez = Q[e + 2] - Q[o + 2];
    const wx = x - Q[o];
    const wy = y - Q[o + 1];
    const wz = z - Q[o + 2];
    if ((ey * wz - ez * wy) * nx + (ez * wx - ex * wz) * ny + (ex * wy - ey * wx) * nz < 0) return false;
  }
  return true;
}

/** The two triangles (9 coordinates each) properly cross, with an eps margin. */
export function trianglesCross(P: Float64Array, Q: Float64Array, eps: number): boolean {
  return edgePierces(P, Q, eps) || edgePierces(Q, P, eps);
}

/** Unnormalised normal into n; returns the triangle's smallest height (2·area / longest edge). */
function normalHeight(t: Float64Array, n: Float64Array): number {
  const ux = t[3] - t[0];
  const uy = t[4] - t[1];
  const uz = t[5] - t[2];
  const vx = t[6] - t[0];
  const vy = t[7] - t[1];
  const vz = t[8] - t[2];
  n[0] = uy * vz - uz * vy;
  n[1] = uz * vx - ux * vz;
  n[2] = ux * vy - uy * vx;
  const longest = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(t[6] - t[3], t[7] - t[4], t[8] - t[5]));
  return longest > 0 ? Math.hypot(n[0], n[1], n[2]) / longest : 0;
}

// ---- Detection -------------------------------------------------------------------------------

/** Folds and crossings in a materialised merge that none of base / ours / theirs has. */
export function findDefects(plan: IMergePlan, m: IMaterialized): IDefectReport {
  const report: IDefectReport = { defects: [], pairTests: 0, truncated: false };
  const { base, ours, theirs, eps } = plan;
  const mesh = m.mesh;
  const nV = mesh.vertexCount;
  const nF = mesh.faceCount;
  if (plan.lineage !== null || nF === 0) return report;
  const prov = m.provenance;
  const F = mesh.faces;
  const bp = base.positions;

  // Part frames: does the merged frame of a moved part differ from each version's?
  const I = identityRigid();
  const frameBits = new Uint8Array(plan.baseComponents.count);
  for (const [c, d] of plan.parts) {
    const R = m.partFrames.get(c) ?? I;
    const cc = plan.partCorners.get(c)!;
    frameBits[c] =
      (maxMotion(R, d.ours, cc) > eps ? IN_OURS : 0) | (maxMotion(R, d.theirs, cc) > eps ? IN_THEIRS : 0) | (maxMotion(R, I, cc) > eps ? IN_BASE : 0);
  }
  const fb = (c: number): number => (c >= 0 ? frameBits[c] : 0);
  // ours added vertex → the theirs vertex unified with it (convergent additions).
  const unifiedRev = new Int32Array(ours.mesh.vertexCount).fill(-1);
  plan.unified.forEach((u, t) => {
    if (u >= 0) unifiedRev[u] = t;
  });

  // Per merged vertex / face: in which versions does it differ (or not exist)?
  const e2 = eps * eps;
  const vBits = new Uint8Array(nV);
  const compId = plan.baseComponents.id;
  const dA = ours.delta;
  const dB = theirs.delta;
  for (let i = 0; i < nV; i++) {
    const idx = prov.vertexIndex[i];
    const src = prov.vertexSource[i];
    if (src === 1) {
      const f = fb(ours.anchorComponent[idx]);
      vBits[i] = IN_BASE | (f & IN_OURS) | (unifiedRev[idx] >= 0 ? f & IN_THEIRS : IN_THEIRS);
      continue;
    }
    if (src === 2) {
      vBits[i] = IN_BASE | IN_OURS | (fb(theirs.anchorComponent[idx]) & IN_THEIRS);
      continue;
    }
    const o = idx * 3;
    let bits = frameBits[compId[idx]];
    const dx = m.delta[o];
    const dy = m.delta[o + 1];
    const dz = m.delta[o + 2];
    if (dx * dx + dy * dy + dz * dz > e2) bits |= IN_BASE;
    if (ours.deleted[idx] || (dx - dA[o]) ** 2 + (dy - dA[o + 1]) ** 2 + (dz - dA[o + 2]) ** 2 > e2) bits |= IN_OURS;
    if (theirs.deleted[idx] || (dx - dB[o]) ** 2 + (dy - dB[o + 1]) ** 2 + (dz - dB[o + 2]) ** 2 > e2) bits |= IN_THEIRS;
    vBits[i] = bits;
  }
  const fBits = new Uint8Array(nF);
  let seen = 0;
  for (let j = 0; j < nF; j++) {
    let bits = vBits[F[j * 3]] | vBits[F[j * 3 + 1]] | vBits[F[j * 3 + 2]];
    const fi = prov.faceIndex[j];
    const src = prov.faceSource[j];
    if (src === 0) bits |= (ours.faceKept[fi] ? 0 : IN_OURS) | (theirs.faceKept[fi] ? 0 : IN_THEIRS);
    else if (src === 1) bits |= IN_BASE | (plan.oursConvergent[fi] ? 0 : IN_THEIRS);
    else bits |= IN_BASE | IN_OURS;
    fBits[j] = bits;
    seen |= bits;
  }
  if (seen !== ALL) return report; // nothing differs from every version: no combination at all

  const inVersion = (j: number, bit: number): boolean => {
    const src = prov.faceSource[j];
    const fi = prov.faceIndex[j];
    if (bit === IN_BASE) return src === 0;
    if (bit === IN_OURS) return src === 0 ? !!ours.faceKept[fi] : src === 1;
    return src === 0 ? !!theirs.faceKept[fi] : src === 1 ? !!plan.oursConvergent[fi] : true;
  };
  const TinvM = invertRigid(m.global);
  const TinvA = invertRigid(ours.T);
  const TinvB = invertRigid(theirs.T);
  /** ours added vertex idx → the matching vertex of `side` (theirs: via unification). */
  const addedOn = (side: ISide, src: number, idx: number): number => (src === 2 || side === ours ? idx : unifiedRev[idx]);
  /**
   * SHAPE of face j in the base frame (frames removed): base position + the version's residual,
   * or an addition's base-frame position. `bit` 0 = the merge itself.
   */
  const shape = (j: number, bit: number, out: Float64Array): void => {
    const delta = bit === 0 ? m.delta : bit === IN_OURS ? ours.delta : bit === IN_THEIRS ? theirs.delta : null;
    for (let k = 0; k < 3; k++) {
      const i = F[j * 3 + k];
      const idx = prov.vertexIndex[i];
      const src = prov.vertexSource[i];
      const o = k * 3;
      if (src === 0) {
        for (let a = 0; a < 3; a++) out[o + a] = bp[idx * 3 + a] + (delta ? delta[idx * 3 + a] : 0);
      } else {
        const onTheirs = src === 2 || bit === IN_THEIRS;
        const pos = onTheirs ? plan.theirsAddedPos : plan.oursAddedPos;
        const t = onTheirs ? addedOn(theirs, src, idx) : idx;
        for (let a = 0; a < 3; a++) out[o + a] = pos[t * 3 + a];
      }
    }
  };
  /** Face j in PART SPACE of one version (its global frame removed; base units). */
  const partSpace = (j: number, bit: number, out: Float64Array): void => {
    for (let k = 0; k < 3; k++) {
      const i = F[j * 3 + k];
      const idx = prov.vertexIndex[i];
      const o = k * 3;
      if (bit === IN_BASE) {
        out[o] = bp[idx * 3];
        out[o + 1] = bp[idx * 3 + 1];
        out[o + 2] = bp[idx * 3 + 2];
        continue;
      }
      const side = bit === IN_OURS ? ours : theirs;
      const src = prov.vertexSource[i];
      const t = src === 0 ? side.map[idx] : addedOn(side, src, idx);
      const sp = side.mesh.positions;
      applyRigid(side === ours ? TinvA : TinvB, sp[t * 3], sp[t * 3 + 1], sp[t * 3 + 2], out, o);
    }
  };

  // ---- Folds: faces whose shape is new (differs from every version) ----
  const tri = new Float64Array(9);
  const nM = new Float64Array(3);
  const nV3 = new Float64Array(3);
  for (let j = 0; j < nF && report.defects.length < MAX_DEFECTS; j++) {
    if (fBits[j] !== ALL) continue;
    shape(j, 0, tri);
    const hM = normalHeight(tri, nM);
    let refs = 0;
    let valid = 0;
    let opposed = 0;
    for (const bit of [IN_BASE, IN_OURS, IN_THEIRS]) {
      if (!inVersion(j, bit)) continue;
      refs++;
      shape(j, bit, tri);
      if (normalHeight(tri, nV3) < eps) continue;
      valid++;
      if (nM[0] * nV3[0] + nM[1] * nV3[1] + nM[2] * nV3[2] < 0) opposed++;
    }
    if (valid === 0) continue;
    if (hM < eps ? valid === refs : opposed === valid) report.defects.push({ kind: 'fold', faces: [j] });
  }

  // ---- Crossings: face pairs that together differ from every version ----
  const both = IN_OURS | IN_THEIRS;
  let nOursOnly = 0;
  let nTheirsOnly = 0;
  let nBoth = 0;
  for (let j = 0; j < nF; j++) {
    const ab = fBits[j] & both;
    if (ab === IN_OURS) nOursOnly++;
    else if (ab === IN_THEIRS) nTheirsOnly++;
    else if (ab === both) nBoth++;
  }
  // Pairs are enumerated once: from "differs from both sides" faces to anything, and between the
  // two one-sided sets from the smaller one.
  const small = nOursOnly <= nTheirsOnly ? IN_OURS : IN_THEIRS;
  const other = small === IN_OURS ? IN_THEIRS : IN_OURS;
  if (nBoth === 0 && (nOursOnly === 0 || nTheirsOnly === 0)) return report;
  const pm = new Float64Array(nV * 3);
  for (let i = 0; i < nV; i++) applyRigid(TinvM, mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2], pm, i * 3);
  // Index only faces that can be a partner and lie near some querying face.
  const isQuery = (f: number): boolean => {
    const ab = fBits[f] & both;
    return ab === both || ab === small;
  };
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let f = 0; f < nF; f++) {
    if (!isQuery(f)) continue;
    for (let k = 0; k < 3; k++) {
      const o = F[f * 3 + k] * 3;
      for (let a = 0; a < 3; a++) {
        if (pm[o + a] < lo[a]) lo[a] = pm[o + a];
        if (pm[o + a] > hi[a]) hi[a] = pm[o + a];
      }
    }
  }
  const indexed: number[] = [];
  for (let f = 0; f < nF; f++) {
    if (nBoth === 0 && (fBits[f] & both) !== other) continue;
    let inside = true;
    for (let a = 0; a < 3 && inside; a++) {
      const v0 = pm[F[f * 3] * 3 + a];
      const v1 = pm[F[f * 3 + 1] * 3 + a];
      const v2 = pm[F[f * 3 + 2] * 3 + a];
      inside = Math.max(v0, v1, v2) >= lo[a] - eps && Math.min(v0, v1, v2) <= hi[a] + eps;
    }
    if (inside) indexed.push(f);
  }
  const indexedFaces = new Uint32Array(indexed.length * 3);
  indexed.forEach((f, k) => indexedFaces.set(F.subarray(f * 3, f * 3 + 3), k * 3));
  const bvh = new TriangleBvh(pm, indexedFaces);
  const PM = new Float64Array(9);
  const QM = new Float64Array(9);
  const PV = new Float64Array(9);
  const QV = new Float64Array(9);
  const merged = (j: number, out: Float64Array): void => {
    for (let k = 0; k < 3; k++) {
      const o = F[j * 3 + k] * 3;
      out[k * 3] = pm[o];
      out[k * 3 + 1] = pm[o + 1];
      out[k * 3 + 2] = pm[o + 2];
    }
  };
  const crossesInAVersion = (f: number, g: number): boolean => {
    for (const bit of [IN_BASE, IN_OURS, IN_THEIRS]) {
      if (!inVersion(f, bit) || !inVersion(g, bit)) continue;
      partSpace(f, bit, PV);
      partSpace(g, bit, QV);
      if (trianglesCross(PV, QV, eps)) return true;
    }
    return false;
  };
  const hits: number[] = [];
  const visit = (f: number, accept: (g: number) => boolean): void => {
    merged(f, PM);
    const x0 = Math.min(PM[0], PM[3], PM[6]) - eps;
    const y0 = Math.min(PM[1], PM[4], PM[7]) - eps;
    const z0 = Math.min(PM[2], PM[5], PM[8]) - eps;
    const x1 = Math.max(PM[0], PM[3], PM[6]) + eps;
    const y1 = Math.max(PM[1], PM[4], PM[7]) + eps;
    const z1 = Math.max(PM[2], PM[5], PM[8]) + eps;
    bvh.queryBox(x0, y0, z0, x1, y1, z1, hits);
    for (const k of hits) {
      const g = indexed[k];
      if (g === f || (fBits[f] | fBits[g]) !== ALL || !accept(g)) continue;
      if (++report.pairTests > MAX_PAIR_TESTS) {
        report.truncated = true;
        return;
      }
      merged(g, QM);
      if (!trianglesCross(PM, QM, eps) || crossesInAVersion(f, g)) continue;
      report.defects.push({ kind: 'crossing', faces: [f, g] });
      if (report.defects.length >= MAX_DEFECTS) return;
    }
  };
  for (let f = 0; f < nF && !report.truncated && report.defects.length < MAX_DEFECTS; f++) {
    const ab = fBits[f] & both;
    if (ab === both) visit(f, (g) => (fBits[g] & both) !== both || g > f);
    else if (ab === small) visit(f, (g) => (fBits[g] & both) === other);
  }
  if (report.defects.length >= MAX_DEFECTS) report.truncated = true;
  return report;
}

// ---- Conflicts and warnings --------------------------------------------------------------------

/** Atomic `collision` conflicts: every change unit (either side, any part frame) under the faces. */
export function defectAtomics(plan: IMergePlan, m: IMaterialized, defects: IDefect[]): IAtomic[] {
  const F = m.mesh.faces;
  const prov = m.provenance;
  return defects.map((d) => {
    const base = new Set<number>();
    const oursSlots = new Set<number>();
    const theirsSlots = new Set<number>();
    const frames = new Set<number>();
    for (const j of d.faces) {
      const fi = prov.faceIndex[j];
      if (prov.faceSource[j] === 1) oursSlots.add(plan.oursSlotOfFace[fi]);
      else if (prov.faceSource[j] === 2) theirsSlots.add(plan.theirsSlotOfFace[fi]);
      for (let k = 0; k < 3; k++) {
        const i = F[j * 3 + k];
        const idx = prov.vertexIndex[i];
        const src = prov.vertexSource[i];
        if (src === 0) base.add(idx);
        const c = src === 0 ? plan.baseComponents.id[idx] : src === 1 ? plan.ours.anchorComponent[idx] : plan.theirs.anchorComponent[idx];
        if (c >= 0 && plan.parts.has(c)) frames.add(c);
      }
    }
    return {
      kind: 'collision',
      base: [...base],
      oursFaceSlots: [...oursSlots],
      theirsFaceSlots: [...theirsSlots],
      frames: [...frames],
      collision: d.kind,
    };
  });
}

const UNRESOLVED: IResolutions = { region: () => null, global: null, lineage: null };

/**
 * Turn combined-edit damage in the unresolved merge into `collision` conflicts: detect on the
 * merge, add the conflicts (their regions then stay in the base state), and repeat — reverting a
 * region can expose geometry the region's edits had hidden — until the merge is free of it.
 */
export function addCollisionConflicts(plan: IMergePlan, logger: IDiffLogger | null): void {
  if (plan.lineage !== null) return;
  let crossing = 0;
  let fold = 0;
  for (let pass = 0; pass < MAX_COLLISION_PASSES; pass++) {
    const m = materialize(plan, UNRESOLVED);
    const rep = findDefects(plan, m);
    if (rep.defects.length === 0) {
      plan.unresolvedMerge = m; // exactly what assemble() needs when nothing is resolved
      break;
    }
    for (const d of rep.defects) {
      if (d.kind === 'crossing') crossing++;
      else fold++;
    }
    addAtomics(plan, defectAtomics(plan, m, rep.defects));
    if (rep.truncated) logger?.warn(`[polymerge] merge: combined-edit check hit its bound (${rep.pairTests} face pairs, ${rep.defects.length} defects); some collisions may be unreported`);
    if (pass === MAX_COLLISION_PASSES - 1) logger?.warn('[polymerge] merge: combined-edit check did not settle; the unresolved merge may still intersect itself');
  }
  if (crossing + fold > 0) {
    logger?.info(
      `[polymerge] merge: combined edits damage the model where neither side does (${crossing} crossing face pair(s), ` +
        `${fold} folded or collapsed face(s)) → reported as collision conflict(s)`,
    );
  }
}

/** A warning for damage created by the combination of chosen resolutions (null when none). */
export function collisionWarning(plan: IMergePlan, m: IMaterialized): IMergeWarning | null {
  const rep = findDefects(plan, m);
  if (rep.defects.length === 0) return null;
  const faces = new Set<number>();
  const conflicts = new Set<number>();
  let crossing = 0;
  let fold = 0;
  const F = m.mesh.faces;
  for (const d of rep.defects) {
    if (d.kind === 'crossing') crossing++;
    else fold++;
    for (const j of d.faces) {
      faces.add(j);
      for (let k = 0; k < 3; k++) {
        const r = m.provenance.vertexConflict[F[j * 3 + k]];
        if (r >= 0) conflicts.add(r);
      }
    }
  }
  const ids = [...conflicts].sort((a, b) => a - b);
  const parts = [crossing > 0 ? `${crossing} crossing face pair(s)` : '', fold > 0 ? `${fold} folded or collapsed face(s)` : ''].filter(Boolean);
  return {
    kind: 'collision',
    message:
      `the chosen resolutions combine into damage neither side has: ${parts.join(', ')}` +
      (ids.length > 0 ? ` (where conflicts ${ids.map((c) => `#${c}`).join(', ')} meet)` : '') +
      (rep.truncated ? '; the check hit its bound, so there may be more' : ''),
    mergedFaces: Uint32Array.from([...faces].sort((a, b) => a - b)),
    conflicts: ids,
  };
}
