/**
 * MOVED PARTS — connected components ("parts") that moved rigidly ON THEIR OWN.
 *
 * Positional seeds (Tier 2) and a single global alignment (Tier 3) cannot explain a part
 * that moved relative to the rest of the model: it would read as Removed at its old place and
 * Added at its new one. The correspondence is recoverable because a rigid part keeps its
 * shape, so this module re-matches such parts by registering them pairwise.
 *
 * Candidate pairs (base component B, target component T):
 *  - both have ≥ MIN_PART_VERTICES vertices, at least PART_UNMATCHED_MIN of each is still
 *    unmatched, and whatever IS matched in B is matched into T and vice versa (an isolated
 *    pair — the current matching links them to nothing else);
 *  - compatible size: vertex counts within ×PART_COUNT_RATIO and RMS radii within
 *    ×PART_RADIUS_RATIO of each other (a rigid motion preserves both, up to local edits);
 *  - ranked by shape similarity then by distance (least motion first); PART_CANDIDATES per B.
 * Evaluation: rigid registration of alignment·B onto T (alignment.ts, no scale), then
 *  - topological mode (Tiers 1/2): seeds = unambiguous mutual nearest neighbours within
 *    max(moveEpsilon, 4 × registration rms), grown by the shared propagation (so locally
 *    edited vertices of the moved part are matched too) plus a mutual-nearest leftover pass;
 *  - surface mode (Tier 3): nearest-surface mapping under the part's transform, exactly as
 *    Tier 3 maps the whole model under the global one.
 * A pair is accepted only when it explains clearly more than the current matching:
 *    gain = matched_after − matched_before ≥ max(3, 10% of the part), and
 *    matched_after ≥ 50% of the part.
 * Accepted pairs are applied greedily (largest gain first, then least motion); each component
 * is used once. A part deleted at one place and a DIFFERENT part added elsewhere never pairs
 * (sizes / shapes differ or registration explains nothing); a deleted part and an IDENTICAL
 * copy added elsewhere is indistinguishable from a move and is reported as one.
 *
 * Matched-part analysis (Tiers 1/2): parts whose vertices are already matched but mostly
 * moved are fitted with one rigid motion (trimmed Horn); when ≥ PART_RIGID_FRACTION of the
 * pairs follow it, the motion is reported (source 'matched') — no correspondence changes.
 */
import { groupIndexOfFace } from '../mesh.js';
import type { IMesh, IPartMotion, Vec3 } from '../types.js';
import { estimateAlignment, type IAlignSurface } from './alignment.js';
import { componentFaces, componentSize, componentVertices, type IComponents } from './components.js';
import type { DiffContext, IPartInternal } from './context.js';
import {
  applyRigid,
  boxCorners,
  composeRigid,
  hornRigid,
  identityRigid,
  invertRigid,
  maxMotion,
  rigidToMat4,
  rotationAngle,
  type IRigid,
} from './linalg.js';
import { Propagator } from './propagate.js';
import { KdTree, TriangleBvh } from './spatial.js';

export const MIN_PART_VERTICES = 4;
export const PART_UNMATCHED_MIN = 0.25;
export const PART_CANDIDATES = 3;
export const PART_MAX_REGISTRATIONS = 64;
export const PART_COUNT_RATIO = 3;
export const PART_RADIUS_RATIO = 1.5;
export const PART_RIGID_FRACTION = 0.9;

// ---------------------------------------------------------------------------------------
// Component bookkeeping
// ---------------------------------------------------------------------------------------

interface ILinks {
  /** Matched vertices per component. */
  matched: Int32Array;
  /** The single component of the other mesh the matched vertices map into (-1 none, -2 several). */
  link: Int32Array;
}

function linkInfo(cc: IComponents, map: Int32Array, otherId: Int32Array): ILinks {
  const matched = new Int32Array(cc.count);
  const link = new Int32Array(cc.count).fill(-1);
  for (let v = 0; v < map.length; v++) {
    const w = map[v];
    if (w < 0) continue;
    const c = cc.id[v];
    matched[c]++;
    const o = otherId[w];
    if (link[c] === -1) link[c] = o;
    else if (link[c] !== o) link[c] = -2;
  }
  return { matched, link };
}

interface IStats {
  c: [number, number, number];
  radius: number;
}

/** Vertex centroid and RMS radius of a component, optionally through a transform. */
function stats(pos: Float64Array, verts: Uint32Array, g: IRigid | null): IStats {
  const q = new Float64Array(3);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of verts) {
    if (g) applyRigid(g, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], q);
    else q.set(pos.subarray(v * 3, v * 3 + 3));
    cx += q[0];
    cy += q[1];
    cz += q[2];
  }
  const n = verts.length || 1;
  cx /= n;
  cy /= n;
  cz /= n;
  let r2 = 0;
  for (const v of verts) {
    if (g) applyRigid(g, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], q);
    else q.set(pos.subarray(v * 3, v * 3 + 3));
    r2 += (q[0] - cx) ** 2 + (q[1] - cy) ** 2 + (q[2] - cz) ** 2;
  }
  return { c: [cx, cy, cz], radius: Math.sqrt(r2 / n) };
}

interface ISub {
  verts: Uint32Array;
  /** Local positions (through the transform when given). */
  surf: IAlignSurface;
}

/** A component as a standalone surface (positions optionally transformed, faces re-indexed). */
function subSurface(mesh: IMesh, cc: IComponents, c: number, g: IRigid | null, local: Int32Array): ISub {
  const verts = componentVertices(cc, c);
  const pos = new Float64Array(verts.length * 3);
  const q = new Float64Array(3);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  verts.forEach((v, i) => {
    local[v] = i;
    const p = mesh.positions;
    if (g) applyRigid(g, p[v * 3], p[v * 3 + 1], p[v * 3 + 2], q);
    else q.set(p.subarray(v * 3, v * 3 + 3));
    pos.set(q, i * 3);
    minX = Math.min(minX, q[0]);
    minY = Math.min(minY, q[1]);
    minZ = Math.min(minZ, q[2]);
    maxX = Math.max(maxX, q[0]);
    maxY = Math.max(maxY, q[1]);
    maxZ = Math.max(maxZ, q[2]);
  });
  const fl = componentFaces(cc, c);
  const faces = new Uint32Array(fl.length * 3);
  fl.forEach((f, i) => {
    faces[i * 3] = local[mesh.faces[f * 3]];
    faces[i * 3 + 1] = local[mesh.faces[f * 3 + 1]];
    faces[i * 3 + 2] = local[mesh.faces[f * 3 + 2]];
  });
  const bounds = { min: [minX, minY, minZ] as Vec3, max: [maxX, maxY, maxZ] as Vec3 };
  return {
    verts,
    surf: { positions: pos, faces, bounds, kd: new KdTree(pos), bvh: faces.length > 0 ? new TriangleBvh(pos, faces) : null },
  };
}

interface IRegistration {
  /** Target-space rigid motion of the part relative to the global alignment. */
  g: IRigid;
  metric: number;
  src: ISub;
  dst: ISub;
}

function register(ctx: DiffContext, A: IRigid, cB: number, cT: number, localB: Int32Array, localT: Int32Array): IRegistration {
  const src = subSurface(ctx.base, ctx.baseComponents, cB, A, localB);
  const dst = subSurface(ctx.target, ctx.targetComponents, cT, null, localT);
  const diag = (b: IAlignSurface['bounds']): number => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const est = estimateAlignment(src.surf, dst.surf, {
    moveEpsilon: ctx.options.moveEpsilon,
    surfaceTolerance: ctx.options.surfaceTolerance,
    diagonal: Math.max(diag(src.surf.bounds), diag(dst.surf.bounds), ctx.options.moveEpsilon),
    icp: ctx.options.icp,
    allowScale: false,
  });
  return { g: est.rigid, metric: est.metric, src, dst };
}

interface ICandidatePair {
  cB: number;
  cT: number;
  rank: number;
  motion: number;
}

/** Enumerate isolated, size-compatible (B, T) component pairs, best-ranked first. */
function candidatePairs(ctx: DiffContext, A: IRigid, b2t: Int32Array, t2b: Int32Array): ICandidatePair[] {
  const ccB = ctx.baseComponents;
  const ccT = ctx.targetComponents;
  if (ccB.count === 0 || ccT.count === 0) return [];
  const lB = linkInfo(ccB, b2t, ccT.id);
  const lT = linkInfo(ccT, t2b, ccB.id);
  const eligible = (cc: IComponents, l: ILinks, c: number): boolean => {
    const n = componentSize(cc, c);
    return n >= MIN_PART_VERTICES && n - l.matched[c] >= Math.max(1, PART_UNMATCHED_MIN * n) && l.link[c] !== -2;
  };
  const bList: number[] = [];
  for (let c = 0; c < ccB.count; c++) if (eligible(ccB, lB, c)) bList.push(c);
  const tList: number[] = [];
  for (let c = 0; c < ccT.count; c++) if (eligible(ccT, lT, c)) tList.push(c);
  if (bList.length === 0 || tList.length === 0) return [];
  const tStats = new Map<number, IStats>();
  for (const d of tList) tStats.set(d, stats(ctx.target.positions, componentVertices(ccT, d), null));
  const diag = Math.max(ctx.options.diagonal, 1e-300);
  const out: ICandidatePair[] = [];
  for (const c of bList) {
    const sB = stats(ctx.base.positions, componentVertices(ccB, c), A);
    const nB = componentSize(ccB, c);
    const mine: ICandidatePair[] = [];
    for (const d of tList) {
      if (lB.link[c] >= 0 && lB.link[c] !== d) continue;
      if (lT.link[d] >= 0 && lT.link[d] !== c) continue;
      const nT = componentSize(ccT, d);
      if (Math.max(nB, nT) > PART_COUNT_RATIO * Math.min(nB, nT)) continue;
      const sT = tStats.get(d)!;
      if (!(sB.radius > 0 && sT.radius > 0)) continue;
      if (Math.max(sB.radius, sT.radius) > PART_RADIUS_RATIO * Math.min(sB.radius, sT.radius)) continue;
      const motion = Math.hypot(sT.c[0] - sB.c[0], sT.c[1] - sB.c[1], sT.c[2] - sB.c[2]);
      const rank = Math.abs(Math.log(sB.radius / sT.radius)) + 0.5 * Math.abs(Math.log(nB / nT)) + motion / diag;
      mine.push({ cB: c, cT: d, rank, motion });
    }
    mine.sort((a, b) => a.rank - b.rank || a.cT - b.cT);
    out.push(...mine.slice(0, PART_CANDIDATES));
  }
  out.sort((a, b) => a.rank - b.rank || a.cB - b.cB || a.cT - b.cT);
  return out.slice(0, PART_MAX_REGISTRATIONS);
}

function enoughGain(gain: number, after: number, size: number, minSize: number): boolean {
  return gain >= Math.max(3, Math.ceil(0.1 * size)) && after >= 0.5 * minSize;
}

/** Greedy selection: largest gain first, then least motion, each component used once. */
function selectGreedy<T extends { pair: ICandidatePair; gain: number }>(evaluated: T[]): T[] {
  evaluated.sort((a, b) => b.gain - a.gain || a.pair.motion - b.pair.motion || a.pair.cB - b.pair.cB || a.pair.cT - b.pair.cT);
  const usedB = new Set<number>();
  const usedT = new Set<number>();
  const out: T[] = [];
  for (const e of evaluated) {
    if (usedB.has(e.pair.cB) || usedT.has(e.pair.cT)) continue;
    usedB.add(e.pair.cB);
    usedT.add(e.pair.cT);
    out.push(e);
  }
  return out;
}

/**
 * Rigid refit of a part over its matched pairs: residuals under the registration `g0`
 * (robust — trimmed ICP) separate locally edited vertices; Horn refits the rest exactly.
 */
function refitPart(ctx: DiffContext, A: IRigid, pairs: Array<[number, number]>, g0: IRigid, tol: number): { g: IRigid; deformed: number; rms: number } {
  const bp = ctx.base.positions;
  const tp = ctx.target.positions;
  const q = new Float64Array(3);
  const src = new Float64Array(pairs.length * 3);
  const dst = new Float64Array(pairs.length * 3);
  const residual = (g: IRigid, i: number): number => {
    applyRigid(g, src[i * 3], src[i * 3 + 1], src[i * 3 + 2], q);
    return Math.hypot(q[0] - dst[i * 3], q[1] - dst[i * 3 + 1], q[2] - dst[i * 3 + 2]);
  };
  pairs.forEach(([b, t], i) => {
    applyRigid(A, bp[b * 3], bp[b * 3 + 1], bp[b * 3 + 2], q);
    src.set(q, i * 3);
    dst[i * 3] = tp[t * 3];
    dst[i * 3 + 1] = tp[t * 3 + 1];
    dst[i * 3 + 2] = tp[t * 3 + 2];
  });
  let g = g0;
  let keep = pairs.map((_, i) => i).filter((i) => residual(g, i) <= tol);
  if (keep.length >= 3) {
    const ks = new Float64Array(keep.length * 3);
    const kd = new Float64Array(keep.length * 3);
    keep.forEach((i, k) => {
      ks.set(src.subarray(i * 3, i * 3 + 3), k * 3);
      kd.set(dst.subarray(i * 3, i * 3 + 3), k * 3);
    });
    g = hornRigid(ks, kd, keep.length);
    keep = pairs.map((_, i) => i).filter((i) => residual(g, i) <= tol);
  }
  let sum = 0;
  for (const i of keep) sum += residual(g, i) ** 2;
  return { g, deformed: pairs.length - keep.length, rms: keep.length > 0 ? Math.sqrt(sum / keep.length) : 0 };
}

/** Deviation tolerance for rigid part fits: moveEpsilon, widened by float32 storage noise. */
function fitTolerance(ctx: DiffContext, metric = 0): number {
  const b = ctx.targetBounds;
  const maxAbs = Math.max(...b.min.map(Math.abs), ...b.max.map(Math.abs));
  return Math.max(ctx.options.moveEpsilon, 4 * metric, 8 * 2 ** -24 * maxAbs);
}

// ---------------------------------------------------------------------------------------
// Topological mode (Tiers 1/2): one-to-one matching, propagation
// ---------------------------------------------------------------------------------------

export function recoverPartsTopological(ctx: DiffContext, A: IRigid, b2t: Int32Array, t2b: Int32Array): IPartInternal[] {
  const pairs = candidatePairs(ctx, A, b2t, t2b);
  if (pairs.length === 0) return [];
  const ccB = ctx.baseComponents;
  const ccT = ctx.targetComponents;
  const localB = new Int32Array(ctx.base.vertexCount);
  const localT = new Int32Array(ctx.target.vertexCount);
  const prop = new Propagator(ctx, b2t, t2b);
  const tp = ctx.target.positions;

  const evaluated: Array<{ pair: ICandidatePair; gain: number; matches: Array<[number, number]>; reg: IRegistration }> = [];
  for (const pair of pairs) {
    const vB = componentVertices(ccB, pair.cB);
    const vT = componentVertices(ccT, pair.cT);
    const saved: Array<[number, number]> = [];
    for (const b of vB) if (b2t[b] >= 0) saved.push([b, b2t[b]]);
    for (const [b, t] of saved) {
      b2t[b] = -1;
      t2b[t] = -1;
    }
    const reg = register(ctx, A, pair.cB, pair.cT, localB, localT);
    const tol = fitTolerance(ctx, reg.metric);
    const tol2 = tol * tol;
    // Base part through the part transform, as a kd-tree for the mutual-nearest checks.
    const moved = new Float64Array(vB.length * 3);
    const q = new Float64Array(3);
    for (let i = 0; i < vB.length; i++) {
      applyRigid(reg.g, reg.src.surf.positions[i * 3], reg.src.surf.positions[i * 3 + 1], reg.src.surf.positions[i * 3 + 2], q);
      moved.set(q, i * 3);
    }
    const kdMoved = new KdTree(moved);
    const kdT = reg.dst.surf.kd;
    const takenB = new Uint8Array(vB.length);
    const takenT = new Uint8Array(vT.length);
    const seed = (ambiguityCheck: boolean): Array<[number, number]> => {
      const fresh: Array<[number, number]> = [];
      for (let i = 0; i < vB.length; i++) {
        if (takenB[i] || b2t[vB[i]] >= 0) continue;
        const x = moved[i * 3];
        const y = moved[i * 3 + 1];
        const z = moved[i * 3 + 2];
        const j = kdT.nearest(x, y, z, tol2, takenT);
        if (j < 0 || t2b[vT[j]] >= 0) continue;
        const t = vT[j];
        if (kdMoved.nearest(tp[t * 3], tp[t * 3 + 1], tp[t * 3 + 2], tol2, takenB) !== i) continue;
        if (ambiguityCheck && (kdT.countWithin(x, y, z, tol2, 2) > 1 || kdMoved.countWithin(tp[t * 3], tp[t * 3 + 1], tp[t * 3 + 2], tol2, 2) > 1)) continue;
        b2t[vB[i]] = t;
        t2b[t] = vB[i];
        takenB[i] = 1;
        takenT[j] = 1;
        fresh.push([vB[i], t]);
      }
      return fresh;
    };
    const syncTaken = (): void => {
      for (let i = 0; i < vB.length; i++) takenB[i] = b2t[vB[i]] >= 0 ? 1 : 0;
      for (let j = 0; j < vT.length; j++) takenT[j] = t2b[vT[j]] >= 0 ? 1 : 0;
    };
    for (const [b, t] of seed(true)) prop.pushFrom(b, t);
    prop.drain();
    syncTaken();
    const leftovers = seed(false);
    for (const [b, t] of leftovers) prop.pushFrom(b, t);
    if (leftovers.length > 0) prop.drain();
    const matches: Array<[number, number]> = [];
    for (const b of vB) if (b2t[b] >= 0) matches.push([b, b2t[b]]);
    // Restore the state before this evaluation.
    for (const [b, t] of matches) {
      b2t[b] = -1;
      t2b[t] = -1;
    }
    for (const [b, t] of saved) {
      b2t[b] = t;
      t2b[t] = b;
    }
    const gain = matches.length - saved.length;
    if (enoughGain(gain, matches.length, Math.max(vB.length, vT.length), Math.min(vB.length, vT.length))) {
      evaluated.push({ pair, gain, matches, reg });
    }
  }

  const out: IPartInternal[] = [];
  for (const e of selectGreedy(evaluated)) {
    const vB = componentVertices(ccB, e.pair.cB);
    const vT = componentVertices(ccT, e.pair.cT);
    for (const b of vB) {
      if (b2t[b] >= 0) t2b[b2t[b]] = -1;
      b2t[b] = -1;
    }
    for (const t of vT) {
      if (t2b[t] >= 0) b2t[t2b[t]] = -1;
      t2b[t] = -1;
    }
    for (const [b, t] of e.matches) {
      b2t[b] = t;
      t2b[t] = b;
    }
    const fit = refitPart(ctx, A, e.matches, e.reg.g, fitTolerance(ctx, e.reg.metric));
    out.push({
      source: 'registration',
      baseComponent: e.pair.cB,
      targetComponent: e.pair.cT,
      baseVertices: Uint32Array.from(vB),
      targetVertices: Uint32Array.from(vT),
      transform: composeRigid(fit.g, A),
      matchedVertices: e.matches.length,
      deformedVertices: fit.deformed,
      rmsError: fit.rms,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Surface mode (Tier 3): nearest-surface mapping under each part's transform
// ---------------------------------------------------------------------------------------

export function recoverPartsSurface(
  ctx: DiffContext,
  A: IRigid,
  t2b: Int32Array,
  b2t: Int32Array,
  dT: Float64Array,
  dB: Float64Array,
): IPartInternal[] {
  const pairs = candidatePairs(ctx, A, b2t, t2b);
  if (pairs.length === 0) return [];
  const ccB = ctx.baseComponents;
  const ccT = ctx.targetComponents;
  const tol = ctx.options.surfaceTolerance;
  const eps = ctx.options.moveEpsilon;
  const cap2 = tol * tol * (1 + 1e-9);
  const localB = new Int32Array(ctx.base.vertexCount);
  const localT = new Int32Array(ctx.target.vertexCount);
  const bp = ctx.base.positions;
  const tp = ctx.target.positions;
  const q = new Float64Array(3);

  interface IMap {
    tAssign: Int32Array;
    tDist: Float64Array;
    bAssign: Int32Array;
  }
  const evaluated: Array<{ pair: ICandidatePair; gain: number; map: IMap; reg: IRegistration; deformed: number }> = [];
  for (const pair of pairs) {
    const vB = componentVertices(ccB, pair.cB);
    const vT = componentVertices(ccT, pair.cT);
    let before = 0;
    for (const t of vT) if (t2b[t] >= 0) before++;
    for (const b of vB) if (b2t[b] >= 0) before++;
    const reg = register(ctx, A, pair.cB, pair.cT, localB, localT);
    const gInv = invertRigid(reg.g);
    const sB = reg.src.surf;
    const sT = reg.dst.surf;
    const map: IMap = { tAssign: new Int32Array(vT.length).fill(-1), tDist: new Float64Array(vT.length), bAssign: new Int32Array(vB.length).fill(-1) };
    let after = 0;
    let deformed = 0;
    vT.forEach((t, j) => {
      applyRigid(gInv, tp[t * 3], tp[t * 3 + 1], tp[t * 3 + 2], q);
      let d2: number;
      if (sB.bvh) {
        sB.bvh.closest(q[0], q[1], q[2], cap2);
        d2 = sB.bvh.lastDist2;
      } else {
        sB.kd.nearest(q[0], q[1], q[2], cap2);
        d2 = sB.kd.lastDist2;
      }
      if (Math.sqrt(d2) > tol) return;
      map.tAssign[j] = vB[sB.kd.nearest(q[0], q[1], q[2])];
      map.tDist[j] = Math.sqrt(d2);
      if (map.tDist[j] > eps) deformed++;
      after++;
    });
    vB.forEach((_, i) => {
      applyRigid(reg.g, sB.positions[i * 3], sB.positions[i * 3 + 1], sB.positions[i * 3 + 2], q);
      let d2: number;
      if (sT.bvh) {
        sT.bvh.closest(q[0], q[1], q[2], cap2);
        d2 = sT.bvh.lastDist2;
      } else {
        sT.kd.nearest(q[0], q[1], q[2], cap2);
        d2 = sT.kd.lastDist2;
      }
      if (Math.sqrt(d2) > tol) return;
      map.bAssign[i] = vT[sT.kd.nearest(q[0], q[1], q[2])];
      after++;
    });
    const gain = after - before;
    if (enoughGain(gain, after, vB.length + vT.length, vB.length + vT.length)) {
      evaluated.push({ pair, gain, map, reg, deformed });
    }
  }

  const out: IPartInternal[] = [];
  const motionDistance = (b: number, t: number): number => {
    applyRigid(A, bp[b * 3], bp[b * 3 + 1], bp[b * 3 + 2], q);
    return Math.hypot(q[0] - tp[t * 3], q[1] - tp[t * 3 + 1], q[2] - tp[t * 3 + 2]);
  };
  for (const e of selectGreedy(evaluated)) {
    const vB = componentVertices(ccB, e.pair.cB);
    const vT = componentVertices(ccT, e.pair.cT);
    const pairsForFit: Array<[number, number]> = [];
    vT.forEach((t, j) => {
      const b = e.map.tAssign[j];
      t2b[t] = b;
      dT[t] = b >= 0 ? motionDistance(b, t) : Infinity;
      if (b >= 0 && e.map.tDist[j] <= fitTolerance(ctx, e.reg.metric)) pairsForFit.push([b, t]);
    });
    vB.forEach((b, i) => {
      const t = e.map.bAssign[i];
      b2t[b] = t;
      dB[b] = t >= 0 ? motionDistance(b, t) : Infinity;
    });
    let matched = 0;
    for (const t of vT) if (t2b[t] >= 0) matched++;
    out.push({
      source: 'registration',
      baseComponent: e.pair.cB,
      targetComponent: e.pair.cT,
      baseVertices: Uint32Array.from(vB),
      targetVertices: Uint32Array.from(vT),
      transform: composeRigid(e.reg.g, A),
      matchedVertices: matched,
      deformedVertices: e.deformed,
      rmsError: e.reg.metric,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Matched-part analysis (Tiers 1/2)
// ---------------------------------------------------------------------------------------

export function analyzeMatchedParts(ctx: DiffContext, A: IRigid, b2t: Int32Array, t2b: Int32Array, skip: Set<number>): IPartInternal[] {
  const ccB = ctx.baseComponents;
  const ccT = ctx.targetComponents;
  const lB = linkInfo(ccB, b2t, ccT.id);
  const lT = linkInfo(ccT, t2b, ccB.id);
  const bp = ctx.base.positions;
  const tp = ctx.target.positions;
  const eps = ctx.options.moveEpsilon;
  const tol = fitTolerance(ctx);
  const q = new Float64Array(3);
  const out: IPartInternal[] = [];
  for (let c = 0; c < ccB.count; c++) {
    if (skip.has(c)) continue;
    const d = lB.link[c];
    if (d < 0 || lT.link[d] !== c) continue;
    const vB = componentVertices(ccB, c);
    if (vB.length < MIN_PART_VERTICES) continue;
    let nPairs = 0;
    let moved = 0;
    for (const b of vB) {
      const t = b2t[b];
      if (t < 0) continue;
      nPairs++;
      applyRigid(A, bp[b * 3], bp[b * 3 + 1], bp[b * 3 + 2], q);
      if (Math.hypot(q[0] - tp[t * 3], q[1] - tp[t * 3 + 1], q[2] - tp[t * 3 + 2]) > eps) moved++;
    }
    if (nPairs < MIN_PART_VERTICES || moved < 0.5 * nPairs) continue;
    const pairs: Array<[number, number]> = [];
    for (const b of vB) if (b2t[b] >= 0) pairs.push([b, b2t[b]]);
    // Trimmed Horn: fit all, keep the best 90%, refit, then classify with the tolerance.
    const src = new Float64Array(pairs.length * 3);
    const dst = new Float64Array(pairs.length * 3);
    pairs.forEach(([b, t], i) => {
      applyRigid(A, bp[b * 3], bp[b * 3 + 1], bp[b * 3 + 2], q);
      src.set(q, i * 3);
      dst[i * 3] = tp[t * 3];
      dst[i * 3 + 1] = tp[t * 3 + 1];
      dst[i * 3 + 2] = tp[t * 3 + 2];
    });
    const res = (g: IRigid): Float64Array => {
      const r = new Float64Array(pairs.length);
      for (let i = 0; i < pairs.length; i++) {
        applyRigid(g, src[i * 3], src[i * 3 + 1], src[i * 3 + 2], q);
        r[i] = Math.hypot(q[0] - dst[i * 3], q[1] - dst[i * 3 + 1], q[2] - dst[i * 3 + 2]);
      }
      return r;
    };
    let g = hornRigid(src, dst, pairs.length);
    const r0 = res(g);
    const cut = Float64Array.from(r0).sort()[Math.floor(0.9 * (pairs.length - 1))];
    const keep0 = pairs.map((_, i) => i).filter((i) => r0[i] <= cut);
    const fit = refitPart(ctx, A, keep0.map((i) => pairs[i]), g, Number.POSITIVE_INFINITY);
    g = fit.g;
    const r1 = res(g);
    let inliers = 0;
    let sum = 0;
    for (let i = 0; i < pairs.length; i++) {
      if (r1[i] <= tol) {
        inliers++;
        sum += r1[i] ** 2;
      }
    }
    if (inliers < PART_RIGID_FRACTION * pairs.length) continue;
    const vT = componentVertices(ccT, d);
    const pts = boxCorners(cornersOf(bp, vB, A));
    if (maxMotion(g, identityRigid(), pts) <= eps) continue;
    out.push({
      source: 'matched',
      baseComponent: c,
      targetComponent: d,
      baseVertices: Uint32Array.from(vB),
      targetVertices: Uint32Array.from(vT),
      transform: composeRigid(g, A),
      matchedVertices: pairs.length,
      deformedVertices: pairs.length - inliers,
      rmsError: inliers > 0 ? Math.sqrt(sum / inliers) : 0,
    });
  }
  return out;
}

/** Axis-aligned bounds of a component through a transform. */
function cornersOf(pos: Float64Array, verts: Uint32Array, g: IRigid): { min: Vec3; max: Vec3 } {
  const q = new Float64Array(3);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    applyRigid(g, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], q);
    for (let k = 0; k < 3; k++) {
      if (q[k] < min[k]) min[k] = q[k];
      if (q[k] > max[k]) max[k] = q[k];
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------------------------------
// Public records
// ---------------------------------------------------------------------------------------

/** Turn internal part motions into contract records, relative to the final alignment `A`. */
export function finalizeParts(ctx: DiffContext, parts: IPartInternal[], A: IRigid): IPartMotion[] {
  const Ainv = invertRigid(A);
  const q = new Float64Array(3);
  return parts.map((p) => {
    const rel = composeRigid(p.transform, Ainv);
    const angle = rotationAngle(rel.r);
    const r = rel.r;
    let axis: Vec3 = [r[7] - r[5], r[2] - r[6], r[3] - r[1]];
    const n = Math.hypot(...axis);
    axis = n > 1e-12 ? [axis[0] / n, axis[1] / n, axis[2] / n] : [0, 0, 1];
    const c = stats(ctx.base.positions, p.baseVertices, null).c;
    applyRigid(A, c[0], c[1], c[2], q);
    const a: Vec3 = [q[0], q[1], q[2]];
    applyRigid(p.transform, c[0], c[1], c[2], q);
    const nameOf = (mesh: IMesh, cc: IComponents, comp: number): string | undefined => {
      const f = componentFaces(cc, comp);
      if (f.length === 0) return undefined;
      return mesh.groups[groupIndexOfFace(mesh, f[0])]?.name;
    };
    const rec: IPartMotion = {
      source: p.source,
      baseVertices: p.baseVertices,
      targetVertices: p.targetVertices,
      matchedVertices: p.matchedVertices,
      deformedVertices: p.deformedVertices,
      matrix: rigidToMat4(p.transform),
      rotationDeg: (angle * 180) / Math.PI,
      rotationAxis: axis,
      centroidShift: [q[0] - a[0], q[1] - a[1], q[2] - a[2]],
      rmsError: p.rmsError,
    };
    const bn = nameOf(ctx.base, ctx.baseComponents, p.baseComponent);
    const tn = nameOf(ctx.target, ctx.targetComponents, p.targetComponent);
    if (bn !== undefined) rec.baseName = bn;
    if (tn !== undefined) rec.targetName = tn;
    return rec;
  });
}
