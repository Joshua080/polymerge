/**
 * SIDE DECOMPOSITION — one side (ours / theirs) of a three-way merge, expressed as atomic
 * edits against the base (docs/merge-design.md §2):
 *
 *   frames      T_S (global) and R_S,c = T_S⁻¹ ∘ G_S,c (per moved part, relative to T_S)
 *   residuals   δ_S(v) = Φ_S(v)⁻¹(p_S(m_S(v))) − p_O(v)   in the BASE frame, Φ_S(v) = T_S ∘ R_S,c(v)
 *   deletions   base vertices without a partner; base faces whose image is not a face of S
 *   additions   vertices of S nobody maps to; faces of S that are not images of kept base faces,
 *               each added vertex anchored to the base component of its S-component (or floating)
 */
import { buildComponents, type IComponents } from '../diff/components.js';
import { FaceSet } from '../diff/faceset.js';
import {
  applyRigid,
  boxCorners,
  composeRigid,
  identityRigid,
  invertRigid,
  mat4ToRigid,
  maxMotion,
  type IRigid,
} from '../diff/linalg.js';
import type { IDiffResult, IMesh } from '../types.js';

export type SideName = 'ours' | 'theirs';

export interface ISide {
  name: SideName;
  mesh: IMesh;
  diff: IDiffResult;
  /** False when vertex identity is lost (Tier 3 retessellation): no vertex-level merge. */
  usable: boolean;
  unusableReason?: string;
  /** Global frame T_S (base → side). */
  T: IRigid;
  /** T_S is a pure unit conversion (scale snapped to a unit factor, no rotation / translation). */
  unitOnly: boolean;
  /** Relative part motion R_S,c per base component (only non-identity entries). */
  partMotion: Map<number, IRigid>;
  /** base vertex → side vertex (-1 = deleted). */
  map: Int32Array;
  /** side vertex → base vertex (-1 = added). */
  inv: Int32Array;
  /** Local residual per base vertex (base frame, xyz); 0 for deleted vertices. */
  delta: Float64Array;
  /** 1 = kept and locally moved (|δ| > eps). */
  moved: Uint8Array;
  /** 1 = deleted base vertex. */
  deleted: Uint8Array;
  /** 1 = base face kept on this side. */
  faceKept: Uint8Array;
  /** Side face indices that are additions. */
  addedFaces: Uint32Array;
  /** 1 = side vertex is added (no base partner). */
  isAdded: Uint8Array;
  /** Base component an added side vertex is attached to (-1 = floating, or not added). */
  anchorComponent: Int32Array;
  /** 1 = base vertex is used (as an anchor) by this side's added faces. */
  anchors: Uint8Array;
  /** Movement threshold in base units. */
  eps: number;
  /** Side mesh connected components. */
  components: IComponents;
}

function rigidIsIdentity(g: IRigid, corners: Float64Array, eps: number): boolean {
  return maxMotion(g, identityRigid(), corners) <= eps;
}

/**
 * Pure unit conversion: a snapped unit scale and nothing else (about the origin).
 * `eps` is in target units, like the distances maxMotion measures here.
 */
function isUnitOnly(diff: IDiffResult, T: IRigid, corners: Float64Array, eps: number): boolean {
  if (!diff.alignment.units) return false;
  const scaleOnly: IRigid = { ...identityRigid(), s: T.s };
  return maxMotion(T, scaleOnly, corners) <= eps;
}

export function decomposeSide(
  name: SideName,
  base: IMesh,
  side: IMesh,
  diff: IDiffResult,
  baseComponents: IComponents,
  baseFaceSet: FaceSet,
): ISide {
  const nO = base.vertexCount;
  const nS = side.vertexCount;
  const map = diff.baseToTarget;
  const inv = diff.targetToBase;
  const T = mat4ToRigid(diff.alignment.matrix);
  if (diff.alignment.isIdentity) {
    T.r.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    T.t.fill(0);
    T.s = 1;
  }
  const eps = diff.moveEpsilon / T.s;
  const corners = boxCorners(base.metadata.bounds);

  // ---- Usability: one-to-one correspondence with every face preserved (Tier 3 only) ------
  let usable = true;
  let unusableReason: string | undefined;
  if (diff.tier === 3) {
    let mutual = true;
    for (let b = 0; b < nO && mutual; b++) if (map[b] >= 0 && inv[map[b]] !== b) mutual = false;
    for (let t = 0; t < nS && mutual; t++) if (inv[t] >= 0 && map[inv[t]] !== t) mutual = false;
    const sideFaces = new FaceSet(side.faces);
    let mappable = 0;
    let preserved = 0;
    for (let f = 0; f < base.faceCount; f++) {
      const a = map[base.faces[f * 3]];
      const b = map[base.faces[f * 3 + 1]];
      const c = map[base.faces[f * 3 + 2]];
      if (a < 0 || b < 0 || c < 0) continue;
      mappable++;
      if (sideFaces.has(a, b, c)) preserved++;
    }
    if (!mutual || (mappable > 0 && preserved < 0.99 * mappable)) {
      usable = false;
      unusableReason =
        `${name} was matched by Tier 3 without one-to-one vertex identity ` +
        `(${mutual ? 'faces' : 'vertices'} do not correspond: a remesh or re-tessellation), so edits cannot be merged vertex by vertex`;
    }
  }

  // ---- Part frames -----------------------------------------------------------------------
  const Tinv = invertRigid(T);
  const partMotion = new Map<number, IRigid>();
  for (const p of diff.parts ?? []) {
    if (p.baseVertices.length === 0) continue;
    const c = baseComponents.id[p.baseVertices[0]];
    const rel = composeRigid(Tinv, mat4ToRigid(p.matrix));
    if (!rigidIsIdentity(rel, corners, eps)) partMotion.set(c, rel);
  }

  // ---- Residuals ---------------------------------------------------------------------------
  const delta = new Float64Array(nO * 3);
  const moved = new Uint8Array(nO);
  const deleted = new Uint8Array(nO);
  const frameInv = new Map<number, IRigid>();
  const phiInv = (c: number): IRigid => {
    let g = frameInv.get(c);
    if (!g) {
      const R = partMotion.get(c);
      g = invertRigid(R ? composeRigid(T, R) : T);
      frameInv.set(c, g);
    }
    return g;
  };
  const q = new Float64Array(3);
  const bp = base.positions;
  const sp = side.positions;
  for (let v = 0; v < nO; v++) {
    const t = map[v];
    if (t < 0) {
      deleted[v] = 1;
      continue;
    }
    applyRigid(phiInv(baseComponents.id[v]), sp[t * 3], sp[t * 3 + 1], sp[t * 3 + 2], q);
    const dx = q[0] - bp[v * 3];
    const dy = q[1] - bp[v * 3 + 1];
    const dz = q[2] - bp[v * 3 + 2];
    if (Math.hypot(dx, dy, dz) > eps) {
      moved[v] = 1;
      delta[v * 3] = dx;
      delta[v * 3 + 1] = dy;
      delta[v * 3 + 2] = dz;
    }
  }

  // ---- Faces -------------------------------------------------------------------------------
  const sideFaceSet = new FaceSet(side.faces);
  const faceKept = new Uint8Array(base.faceCount);
  for (let f = 0; f < base.faceCount; f++) {
    const a = map[base.faces[f * 3]];
    const b = map[base.faces[f * 3 + 1]];
    const c = map[base.faces[f * 3 + 2]];
    if (a >= 0 && b >= 0 && c >= 0 && sideFaceSet.has(a, b, c)) faceKept[f] = 1;
  }
  const isAdded = new Uint8Array(nS);
  for (let t = 0; t < nS; t++) if (inv[t] < 0) isAdded[t] = 1;
  const added: number[] = [];
  const anchors = new Uint8Array(nO);
  for (let f = 0; f < side.faceCount; f++) {
    const a = side.faces[f * 3];
    const b = side.faces[f * 3 + 1];
    const c = side.faces[f * 3 + 2];
    const ba = inv[a];
    const bb = inv[b];
    const bc = inv[c];
    // An image of a kept base face is not an addition.
    if (ba >= 0 && bb >= 0 && bc >= 0 && baseFaceSet.has(ba, bb, bc)) continue;
    added.push(f);
    if (ba >= 0) anchors[ba] = 1;
    if (bb >= 0) anchors[bb] = 1;
    if (bc >= 0) anchors[bc] = 1;
  }

  // ---- Anchoring of added vertices ----------------------------------------------------------
  const components = buildComponents(nS, side.faces);
  const compAnchor = new Int32Array(components.count).fill(-1);
  for (let t = 0; t < nS; t++) {
    const b = inv[t];
    if (b < 0) continue;
    const c = components.id[t];
    if (compAnchor[c] < 0) compAnchor[c] = baseComponents.id[b];
  }
  const anchorComponent = new Int32Array(nS).fill(-1);
  for (let t = 0; t < nS; t++) if (isAdded[t]) anchorComponent[t] = compAnchor[components.id[t]];

  return {
    name,
    mesh: side,
    diff,
    usable,
    unusableReason,
    T,
    unitOnly: !diff.alignment.isIdentity && isUnitOnly(diff, T, corners, diff.moveEpsilon),
    partMotion,
    map,
    inv,
    delta,
    moved,
    deleted,
    faceKept,
    addedFaces: Uint32Array.from(added),
    isAdded,
    anchorComponent,
    anchors,
    eps,
    components,
  };
}

/** Frame Φ_S for a base component: T_S ∘ R_S,c. */
export function sideFrame(side: ISide, component: number): IRigid {
  const R = side.partMotion.get(component);
  return R ? composeRigid(side.T, R) : side.T;
}
