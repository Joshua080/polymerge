/**
 * PIECES MATCHED BY THEIR STRUCTURE — a separate piece (connected component) that the matching
 * did not reach at all: every vertex of it unmatched, in the base and in the target. That happens
 * when a piece was reshaped as a whole in a file whose order changed: no vertex stayed where it
 * was to seed from, and the shape is no longer rigid, so registration (parts.ts) rejects it or
 * forces a wrong rigid fit on it. Read as is, the piece would be "removed" in one place and
 * "added" in the same place.
 *
 * A base piece and a target piece with the same numbers of vertices and triangles are matched by
 * walking their triangles: map one triangle onto one triangle (three ways round), then step
 * across each shared edge and map the neighbour's third corner. A walk that maps every triangle
 * and vertex without contradiction is an exact structural match (an isomorphism of the two
 * triangle meshes, winding kept). Start triangles are tried nearest first; among the walks that
 * succeed (a symmetric piece has several), the most rigid one is taken, then the one that moves
 * the vertices least. This runs before rigid registration; a piece matched here that did move
 * rigidly is still reported as a moved part. A piece deleted in one place and an
 * identical piece added elsewhere reads as moved, as for parts.ts.
 */
import type { DiffContext } from './context.js';
import { componentFaces, componentVertices, type IComponents } from './components.js';
import { applyRigid, hornRigid } from './linalg.js';
import { fitTolerance } from './parts.js';

/**
 * Start triangles tried per candidate piece (nearest first, each three ways round): as many as
 * a budget of triangle steps allows, between these bounds. An edit shifts the piece's centroid,
 * so on a large piece the true partner of the start triangle can be far down the list.
 */
const MIN_STARTS = 12;
const MAX_STARTS = 256;
const WALK_BUDGET = 4_000_000;
/** Candidate target pieces per base piece (nearest centroid first). */
const CANDIDATES = 6;
/** Pieces larger than this are left alone (a walk is linear, but the candidates multiply). */
const MAX_PIECE_FACES = 250_000;

interface IPiece {
  c: number;
  verts: Uint32Array;
  faces: Uint32Array;
  centroid: [number, number, number];
}

function unmatchedPieces(cc: IComponents, map: Int32Array, positions: Float64Array): IPiece[] {
  const out: IPiece[] = [];
  for (let c = 0; c < cc.count; c++) {
    const faces = componentFaces(cc, c);
    if (faces.length === 0 || faces.length > MAX_PIECE_FACES) continue;
    const verts = componentVertices(cc, c);
    let all = true;
    for (const v of verts) if (map[v] >= 0) {
      all = false;
      break;
    }
    if (!all) continue;
    const centroid: [number, number, number] = [0, 0, 0];
    for (const v of verts) for (let k = 0; k < 3; k++) centroid[k] += positions[v * 3 + k] / verts.length;
    out.push({ c, verts, faces, centroid });
  }
  return out;
}

/** Edge → the (up to two) faces of a piece on it; -2 marks a non-manifold edge. */
function edgeFaces(piece: IPiece, faces: Uint32Array, vertexCount: number): Map<number, [number, number]> {
  const m = new Map<number, [number, number]>();
  for (const f of piece.faces) {
    for (let k = 0; k < 3; k++) {
      const a = faces[f * 3 + k];
      const b = faces[f * 3 + ((k + 1) % 3)];
      const key = a < b ? a * vertexCount + b : b * vertexCount + a;
      const e = m.get(key);
      if (!e) m.set(key, [f, -1]);
      else if (e[1] === -1) e[1] = f;
      else e[1] = -2;
    }
  }
  return m;
}

/**
 * Walk from base face fb → target face ft (corner k of fb onto corner (k + rot) % 3 of ft).
 * Returns the vertex map (base local order → target vertex) or null on any contradiction.
 */
function walk(
  ctx: DiffContext,
  pb: IPiece,
  pt: IPiece,
  eb: Map<number, [number, number]>,
  et: Map<number, [number, number]>,
  fb: number,
  ft: number,
  rot: number,
  vmap: Map<number, number>,
  used: Set<number>,
): boolean {
  const BF = ctx.base.faces;
  const TF = ctx.target.faces;
  const nb = ctx.base.vertexCount;
  const nt = ctx.target.vertexCount;
  vmap.clear();
  used.clear();
  const fmap = new Map<number, number>();
  const usedF = new Set<number>();
  const assign = (b: number, t: number): boolean => {
    const have = vmap.get(b);
    if (have !== undefined) return have === t;
    if (used.has(t)) return false;
    vmap.set(b, t);
    used.add(t);
    return true;
  };
  const mapFace = (b: number, t: number, r: number): boolean => {
    for (let k = 0; k < 3; k++) if (!assign(BF[b * 3 + k], TF[t * 3 + ((k + r) % 3)])) return false;
    fmap.set(b, t);
    usedF.add(t);
    return true;
  };
  if (!mapFace(fb, ft, rot)) return false;
  const queue = [fb];
  while (queue.length > 0) {
    const b = queue.pop()!;
    for (let k = 0; k < 3; k++) {
      const u = BF[b * 3 + k];
      const v = BF[b * 3 + ((k + 1) % 3)];
      const eB = eb.get(u < v ? u * nb + v : v * nb + u)!;
      if (eB[1] === -2) return false;
      const other = eB[0] === b ? eB[1] : eB[0];
      const tu = vmap.get(u)!;
      const tv = vmap.get(v)!;
      const eT = et.get(tu < tv ? tu * nt + tv : tv * nt + tu);
      if (!eT || eT[1] === -2) return false;
      const t = fmap.get(b)!;
      const otherT = eT[0] === t ? eT[1] : eT[0];
      if ((other === -1) !== (otherT === -1)) return false; // a border on one side only
      if (other === -1) continue;
      const known = fmap.get(other);
      if (known !== undefined) {
        if (known !== otherT) return false;
        continue;
      }
      if (usedF.has(otherT)) return false;
      // The neighbour runs (v, u, w) in base; find the rotation that puts tv, tu first in target.
      let r = -1;
      for (let s = 0; s < 3; s++) {
        let ok = true;
        for (let j = 0; j < 3 && ok; j++) {
          const bv = BF[other * 3 + j];
          const want = vmap.get(bv);
          if (want !== undefined && TF[otherT * 3 + ((j + s) % 3)] !== want) ok = false;
        }
        if (ok) {
          r = s;
          break;
        }
      }
      if (r < 0 || !mapFace(other, otherT, r)) return false;
      queue.push(other);
    }
  }
  return fmap.size === pb.faces.length && vmap.size === pb.verts.length && pt.faces.length === pb.faces.length;
}

/** RMS distance left after the best rigid fit of the mapped vertices. */
function rigidResidual(BP: Float64Array, TP: Float64Array, map: Map<number, number>): number {
  const src = new Float64Array(map.size * 3);
  const dst = new Float64Array(map.size * 3);
  let i = 0;
  for (const [b, t] of map) {
    for (let k = 0; k < 3; k++) {
      src[i * 3 + k] = BP[b * 3 + k];
      dst[i * 3 + k] = TP[t * 3 + k];
    }
    i++;
  }
  const g = hornRigid(src, dst, map.size);
  const q = new Float64Array(3);
  let sum = 0;
  for (let j = 0; j < map.size; j++) {
    applyRigid(g, src[j * 3], src[j * 3 + 1], src[j * 3 + 2], q);
    sum += (q[0] - dst[j * 3]) ** 2 + (q[1] - dst[j * 3 + 1]) ** 2 + (q[2] - dst[j * 3 + 2]) ** 2;
  }
  return Math.sqrt(sum / map.size);
}

/** Match whole unmatched pieces by structure; returns how many pieces and vertices were matched. */
export function matchPiecesByStructure(ctx: DiffContext, b2t: Int32Array, t2b: Int32Array): { pieces: number; vertices: number; baseComponents: Set<number> } {
  const BP = ctx.base.positions;
  const TP = ctx.target.positions;
  const bases = unmatchedPieces(ctx.baseComponents, b2t, BP);
  const baseComponents = new Set<number>();
  if (bases.length === 0) return { pieces: 0, vertices: 0, baseComponents };
  const targets = unmatchedPieces(ctx.targetComponents, t2b, TP);
  if (targets.length === 0) return { pieces: 0, vertices: 0, baseComponents };
  const byShape = new Map<string, IPiece[]>();
  for (const p of targets) {
    const key = `${p.verts.length}:${p.faces.length}`;
    if (!byShape.has(key)) byShape.set(key, []);
    byShape.get(key)!.push(p);
  }
  const tol = fitTolerance(ctx);
  const d2 = (a: ArrayLike<number>, b: ArrayLike<number>) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const faceCentroid = (pos: Float64Array, faces: Uint32Array, f: number): [number, number, number] => {
    const c: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) c[j] += pos[faces[f * 3 + k] * 3 + j] / 3;
    return c;
  };
  // Every successful walk: (base piece, target piece, cost, map).
  const found: { pb: IPiece; pt: IPiece; cost: number; map: Map<number, number> }[] = [];
  const edgesT = new Map<number, Map<number, [number, number]>>();
  for (const pb of bases) {
    const same = byShape.get(`${pb.verts.length}:${pb.faces.length}`);
    if (!same) continue;
    const eb = edgeFaces(pb, ctx.base.faces, ctx.base.vertexCount);
    const fb = pb.faces[0];
    const cb = faceCentroid(BP, ctx.base.faces, fb);
    const candidates = [...same].sort((x, y) => d2(x.centroid, pb.centroid) - d2(y.centroid, pb.centroid)).slice(0, CANDIDATES);
    for (const pt of candidates) {
      let et = edgesT.get(pt.c);
      if (!et) edgesT.set(pt.c, (et = edgeFaces(pt, ctx.target.faces, ctx.target.vertexCount)));
      // Start triangles: the target triangles nearest to the base start triangle, after moving it with the piece.
      const shift = [pt.centroid[0] - pb.centroid[0], pt.centroid[1] - pb.centroid[1], pt.centroid[2] - pb.centroid[2]];
      const goal = [cb[0] + shift[0], cb[1] + shift[1], cb[2] + shift[2]];
      const starts = Array.from(pt.faces)
        .map((f) => ({ f, d: d2(faceCentroid(TP, ctx.target.faces, f), goal) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, Math.max(MIN_STARTS, Math.min(MAX_STARTS, Math.floor(WALK_BUDGET / (3 * pb.faces.length)))));
      const vmap = new Map<number, number>();
      const used = new Set<number>();
      let best: { cost: number; rms: number; map: Map<number, number> } | null = null;
      for (const { f } of starts) {
        for (let rot = 0; rot < 3; rot++) {
          if (!walk(ctx, pb, pt, eb, et, fb, f, rot, vmap, used)) continue;
          let cost = 0;
          for (const [b, t] of vmap) cost += Math.sqrt(d2([BP[b * 3], BP[b * 3 + 1], BP[b * 3 + 2]], [TP[t * 3], TP[t * 3 + 1], TP[t * 3 + 2]]));
          // A symmetric mesh has several walks; the true one is the most rigid (the least
          // movement alone can favour a mirror-image or rotated-round map), then the least movement.
          const rms = rigidResidual(BP, TP, vmap);
          if (!best || rms < best.rms - tol || (rms <= best.rms + tol && cost < best.cost)) best = { cost, rms, map: new Map(vmap) };
        }
      }
      if (best) found.push({ pb, pt, ...best });
    }
  }
  // Least movement first; each piece once.
  found.sort((a, b) => a.cost / a.pb.verts.length - b.cost / b.pb.verts.length);
  const takenB = new Set<number>();
  const takenT = new Set<number>();
  let pieces = 0;
  let vertices = 0;
  for (const m of found) {
    if (takenB.has(m.pb.c) || takenT.has(m.pt.c)) continue;
    takenB.add(m.pb.c);
    takenT.add(m.pt.c);
    for (const [b, t] of m.map) {
      b2t[b] = t;
      t2b[t] = b;
    }
    pieces++;
    vertices += m.map.size;
    baseComponents.add(m.pb.c);
  }
  return { pieces, vertices, baseComponents };
}
