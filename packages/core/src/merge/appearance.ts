/**
 * APPEARANCE MERGE — materials, per-face material assignment, per-corner UVs and texture references
 * (docs/appearance-merge-design.md). Built on the geometry merge's correspondence (sides.ts) and plan
 * (plan.ts); nothing is re-diffed.
 *
 *   planAppearance         per side: which side face each kept base face is, and its corner order;
 *                          material identities and the property-level definition merge (materials.ts);
 *                          the per-face assignment merge; per UV set the UV change components
 *                          (super-islands of base + side gluing) and their three-way UNITS, taken whole
 *                          from one side or in conflict; new texture-space overlaps (uv.ts, repeated
 *                          until nothing new appears); units that cannot be decided without the geometry
 *                          become `appearance-geometry` atomics for the plan's regions.
 *   materializeAppearance  a set of resolutions → the merged mesh's materials, faceMaterials and
 *                          appearance, the appearance conflicts (ids after the geometry ones) and the
 *                          post-resolution texture-space overlap warning.
 *
 * Unresolved units keep the BASE state: base property values (glTF defaults for an add/add
 * material), base assignment, base UVs on every face of a UV unit.
 */
import {
  appearanceValueKey,
  defaultMaterialDefinition,
  definitionValue,
  materialSummary,
  remapTextureRefs,
  setDefinitionValue,
  textureRefsOf,
  textureRefUvSet,
} from '../appearance.js';
import { applyRigid } from '../diff/linalg.js';
import type {
  IAppearanceMerge,
  IAppearanceMergeStats,
  IDiffLogger,
  IMaterial,
  IMaterialDefinition,
  IMergeConflict,
  IMergeWarning,
  IMesh,
  IMeshAppearance,
  IMeshGroup,
  ITextureImage,
  MergeConflictKind,
  MergeResolution,
} from '../types.js';
import type { IMaterialized } from './materialize.js';
import { definitionIn, matchMaterials, mergeDefinition, type IIdentities, type IMaterialMerge, type Version } from './materials.js';
import type { IAtomic, IMergePlan } from './plan.js';
import type { ISide } from './sides.js';
import { FaceIndex, glueIslands, sameCornerUv, sameFaceUv, searchUvOverlaps, UnionFind, uvTrianglesOverlap } from './uv.js';

/** Default UV comparison threshold: 1/16 texel at 4096 px, above 16-bit re-quantisation noise. */
export const DEFAULT_UV_EPSILON = 2 ** -16;
/** Bound on the texture-space overlap passes (each only merges units, so it converges). */
export const MAX_OVERLAP_PASSES = 8;
/** Bound on UV triangle pairs tested by one overlap search. */
export const MAX_UV_PAIR_TESTS = 5_000_000;

const IN_OURS = 1;
const IN_THEIRS = 2;
const IN_BASE = 4;
const ALL = IN_OURS | IN_THEIRS | IN_BASE;

/** 0 = base, 1 = ours, 2 = theirs. */
type Decision = Version;

const decisionOf = (r: MergeResolution | null | undefined): Decision => (r === 'ours' ? 1 : r === 'theirs' ? 2 : 0);

/** One side as the appearance merge sees it. */
interface ILookSide {
  side: ISide;
  mesh: IMesh;
  look: IMeshAppearance;
  /** Side face of each base face kept on this side (-1 = not kept). */
  faceOfBase: Int32Array;
  /** Base face of each side face (-1 = added). */
  baseOfFace: Int32Array;
  /** Per UV set: the side's UVs of each kept base face in BASE corner order (NaN when not kept). */
  uvOnBase: Float32Array[];
  /** Per UV set: the side's own per-corner UVs (NaN-filled when the side lacks the set). */
  uvs: Float32Array[];
  /** Added-face slot of each side face (-1 = not added). */
  slotOfFace: Int32Array;
}

interface IUvUnit {
  /** ours / theirs = taken whole from that side; both = identical; conflict = neither contains the other, or a new overlap. */
  status: 'ours' | 'theirs' | 'both' | 'conflict';
  baseFaces: number[];
  /** Added faces (side face indices) of ours / theirs in the unit. */
  oursFaces: number[];
  theirsFaces: number[];
  /** Layout conflicts (component groups both sides changed differently) inside the unit. */
  layout: number;
  /** New texture-space overlaps (face pairs) that joined the unit. */
  overlaps: number;
  /** Coupled (region-decided) owner, or -1. */
  owner: number;
  /** Pure appearance conflict deciding the unit, or -1. */
  conflict: number;
}

interface IUvSetPlan {
  unitOfBase: Int32Array;
  /** Unit of each ours / theirs face (added faces only; -1 otherwise). */
  unitOfOurs: Int32Array;
  unitOfTheirs: Int32Array;
  units: IUvUnit[];
}

/** An appearance unit decided by a geometry region (`appearance-geometry`). */
interface ICoupled {
  atomic: IAtomic;
  /** Base faces whose material assignment the region decides. */
  faces: number[];
  /** Convergent added faces (ours face → theirs face) whose assignment the region decides. */
  pairs: Array<[number, number]>;
  /** UV units the region decides: [set, unit]. */
  units: Array<[number, number]>;
}

type AppearanceKind = 'material-property' | 'material-assignment' | 'uv-layout' | 'uv-overlap';

interface IConflictPlan {
  kinds: Partial<Record<AppearanceKind, number>>;
  identity?: number;
  properties?: string[];
  set?: number;
  baseFaces: number[];
  oursFaces: number[];
  theirsFaces: number[];
  message: string;
}

export interface IAppearancePlan {
  meshes: [IMesh, IMesh, IMesh];
  ours: ILookSide;
  theirs: ILookSide;
  eps: number;
  /** A side lost vertex identity: the merged mesh is one whole version, appearance included. */
  lineage: boolean;
  identities: IIdentities;
  /** Definition merge per identity. */
  materials: IMaterialMerge[];
  /** Pure conflict of each identity (-1 = none). */
  materialConflict: Int32Array;
  /** Per base face: material identity in base / ours / theirs (-1 = no material, -2 = face not kept). */
  faceId: [Int32Array, Int32Array, Int32Array];
  /** Per base face: pure assignment conflict (-1 = none), region-decided owner (-1 = none). */
  assignConflict: Int32Array;
  assignOwner: Int32Array;
  /** Convergent added faces: ours face → theirs face, and ours face → owner. */
  convergent: Map<number, number>;
  pairOwner: Map<number, number>;
  /** Base UVs per set (NaN-filled when base lacks the set). */
  baseUvs: Float32Array[];
  uv: IUvSetPlan[];
  coupled: ICoupled[];
  conflicts: IConflictPlan[];
  stats: Omit<IAppearanceMergeStats, 'materials' | 'conflicts' | 'unresolved'>;
}

export interface IAppearanceChoices {
  /** Resolution of a geometry region (appearance-geometry units follow it). */
  region: (id: number) => MergeResolution | null;
  /** Resolution of pure appearance conflict k (its id is idOffset + k). */
  conflict: (k: number) => MergeResolution | null;
}

export interface IAppearanceResult {
  mesh: IMesh;
  info: IAppearanceMerge;
  conflicts: IMergeConflict[];
  warning: IMergeWarning | null;
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

function nanArray(n: number): Float32Array {
  return new Float32Array(n).fill(NaN);
}

/** dst.push(...src) without the argument-count limit (a unit can span a whole mesh). */
function append<T>(dst: T[], src: readonly T[]): void {
  for (const x of src) dst.push(x);
}

function lookSide(side: ISide, base: IMesh, index: FaceIndex, sets: number, baseSlots: Int32Array): ILookSide {
  const mesh = side.mesh;
  const look = mesh.appearance!;
  const FO = base.faceCount;
  const faceOfBase = new Int32Array(FO).fill(-1);
  const baseOfFace = new Int32Array(mesh.faceCount).fill(-1);
  const sf = mesh.faces;
  const inv = side.inv;
  for (let s = 0; s < mesh.faceCount; s++) {
    const a = inv[sf[s * 3]];
    const b = inv[sf[s * 3 + 1]];
    const c = inv[sf[s * 3 + 2]];
    if (a < 0 || b < 0 || c < 0) continue;
    const f = index.get(a, b, c);
    if (f < 0 || !side.faceKept[f] || faceOfBase[f] >= 0) continue;
    faceOfBase[f] = s;
    baseOfFace[s] = f;
  }
  const uvs: Float32Array[] = [];
  const uvOnBase: Float32Array[] = [];
  const bf = base.faces;
  for (let k = 0; k < sets; k++) {
    const own = look.uvs[k] ?? nanArray(mesh.faceCount * 6);
    uvs.push(own);
    const out = nanArray(FO * 6);
    for (let f = 0; f < FO; f++) {
      const s = faceOfBase[f];
      if (s < 0) continue;
      for (let j = 0; j < 3; j++) {
        const t = side.map[bf[f * 3 + j]];
        const p = sf[s * 3] === t ? 0 : sf[s * 3 + 1] === t ? 1 : 2;
        out[(f * 3 + j) * 2] = own[(s * 3 + p) * 2];
        out[(f * 3 + j) * 2 + 1] = own[(s * 3 + p) * 2 + 1];
      }
    }
    uvOnBase.push(out);
  }
  return { side, mesh, look, faceOfBase, baseOfFace, uvOnBase, uvs, slotOfFace: baseSlots };
}

/** Identity of a side face's material (-1 = none). */
function faceIdentity(mesh: IMesh, of: Int32Array, face: number): number {
  const m = mesh.faceMaterials?.[face] ?? -1;
  return m >= 0 ? of[m] : -1;
}

/**
 * Plan the appearance merge, or return null when some version carries no appearance data (STL / OBJ
 * input): the merge is then geometry-only, as before.
 */
export function planAppearance(plan: IMergePlan, options: { uvEpsilon?: number; logger?: IDiffLogger | null } = {}): IAppearancePlan | null {
  const { base, ours: sideA, theirs: sideB } = plan;
  const meshes: [IMesh, IMesh, IMesh] = [base, sideA.mesh, sideB.mesh];
  const missing = (['base', 'ours', 'theirs'] as const).filter((_, i) => !meshes[i].appearance);
  if (missing.length > 0) {
    if (missing.length < 3) {
      const formats = missing.map((n) => meshes[n === 'base' ? 0 : n === 'ours' ? 1 : 2].metadata.format.toUpperCase());
      options.logger?.info(
        `[polymerge] merge: appearance not merged: ${missing.join(', ')} (${formats.join(', ')}) carries no materials or UVs; the result is geometry only`,
      );
    }
    return null;
  }
  const eps = options.uvEpsilon ?? DEFAULT_UV_EPSILON;
  const FO = base.faceCount;
  // A lineage merge is one whole version: nothing is compared, so no UV data is needed.
  const sets = plan.lineage !== null ? 0 : Math.max(...meshes.map((m) => m.appearance!.uvs.length));
  const baseUvs = Array.from({ length: sets }, (_, k) => base.appearance!.uvs[k] ?? nanArray(FO * 6));
  const index = new FaceIndex(base.faces);
  const A = lookSide(sideA, base, index, sets, plan.oursSlotOfFace);
  const B = lookSide(sideB, base, index, sets, plan.theirsSlotOfFace);
  const stats: IAppearancePlan['stats'] = {
    propertiesFromOurs: 0,
    propertiesFromTheirs: 0,
    propertiesConvergent: 0,
    facesReassignedFromOurs: 0,
    facesReassignedFromTheirs: 0,
    facesReassignedConvergent: 0,
    uvFacesFromOurs: 0,
    uvFacesFromTheirs: 0,
    uvFacesConvergent: 0,
  };
  const empty = (): IAppearancePlan => ({
    meshes,
    ours: A,
    theirs: B,
    eps,
    lineage: plan.lineage !== null,
    identities: { list: [], of: [new Int32Array(0), new Int32Array(0), new Int32Array(0)], renamed: [0, 0] },
    materials: [],
    materialConflict: new Int32Array(0),
    faceId: [new Int32Array(FO).fill(-1), new Int32Array(FO).fill(-2), new Int32Array(FO).fill(-2)],
    assignConflict: new Int32Array(FO).fill(-1),
    assignOwner: new Int32Array(FO).fill(-1),
    convergent: new Map(),
    pairOwner: new Map(),
    baseUvs,
    uv: [],
    coupled: [],
    conflicts: [],
    stats,
  });
  const look = empty();
  if (look.lineage) return look;

  // ---- Materials: identities and definitions ----------------------------------------------------
  const ids = matchMaterials(base, A.mesh, B.mesh, A.faceOfBase, B.faceOfBase);
  look.identities = ids;
  look.materials = ids.list.map((id, i) => mergeDefinition(i, id, meshes));
  look.materialConflict = new Int32Array(ids.list.length).fill(-1);
  for (const mm of look.materials) {
    for (const p of mm.properties) {
      if (p.source === 'ours') stats.propertiesFromOurs++;
      else if (p.source === 'theirs') stats.propertiesFromTheirs++;
      else if (p.source === 'both') stats.propertiesConvergent++;
    }
  }
  if (ids.renamed[0] + ids.renamed[1] > 0) {
    options.logger?.info(`[polymerge] merge: material renames recognised: ${ids.renamed[0]} on ours, ${ids.renamed[1]} on theirs`);
  }

  // ---- Assignment, per face ----------------------------------------------------------------------
  const [idO, idA, idB] = look.faceId;
  for (let f = 0; f < FO; f++) {
    idO[f] = faceIdentity(base, ids.of[0], f);
    if (A.faceOfBase[f] >= 0) idA[f] = faceIdentity(A.mesh, ids.of[1], A.faceOfBase[f]);
    if (B.faceOfBase[f] >= 0) idB[f] = faceIdentity(B.mesh, ids.of[2], B.faceOfBase[f]);
  }
  const assignConflictFaces: number[] = [];
  for (let f = 0; f < FO; f++) {
    const o = idO[f];
    const a = idA[f];
    const b = idB[f];
    if (a === -2 || b === -2) continue; // deleted on a side: moot unless replaced (coupling below)
    if (a === b) {
      if (a !== o) stats.facesReassignedConvergent++;
    } else if (a === o) stats.facesReassignedFromTheirs++;
    else if (b === o) stats.facesReassignedFromOurs++;
    else assignConflictFaces.push(f);
  }
  for (const [i, j] of plan.convergentPairs) look.convergent.set(sideA.addedFaces[i], sideB.addedFaces[j]);

  // ---- UVs, per set --------------------------------------------------------------------------------
  const inComp: Array<[Uint8Array, Uint8Array]> = [];
  for (let k = 0; k < sets; k++) {
    const r = planUvSet(plan, look, k, stats);
    look.uv.push(r.plan);
    inComp.push(r.inComp);
  }

  // ---- Coupling seeds: appearance units the geometry must decide ------------------------------------
  const seeds: ISeed[] = [];
  // Replacement: one side deleted faces with additions in the same change component (a remesh or
  // retriangulation) where the other side changed the material or the UVs.
  for (const [D, E, e] of [
    [sideA, B, 1],
    [sideB, A, 0],
  ] as const) {
    const change = D === sideA ? plan.changeA : plan.changeB;
    if (!change) continue;
    const nO = base.vertexCount;
    const replacing = new Uint8Array(nO + D.addedFaces.length);
    for (let i = 0; i < D.addedFaces.length; i++) replacing[change.uf.find(nO + i)] = 1;
    const idE = e === 1 ? idB : idA;
    for (let f = 0; f < FO; f++) {
      if (D.faceKept[f] || E.faceOfBase[f] < 0) continue;
      if (!replacing[change.uf.find(base.faces[f * 3])]) continue;
      const reassigned = idE[f] !== idO[f];
      const units: Array<[number, number]> = [];
      for (let k = 0; k < sets; k++) if (inComp[k][e][f]) units.push([k, look.uv[k].unitOfBase[f]]);
      if (!reassigned && units.length === 0) continue;
      seeds.push({
        base: [base.faces[f * 3], base.faces[f * 3 + 1], base.faces[f * 3 + 2]],
        oursSlots: [],
        theirsSlots: [],
        faces: reassigned ? [f] : [],
        pairs: [],
        units,
        what: `${D.name} replaced face(s) whose ${[reassigned ? 'material' : '', units.length ? 'UVs' : ''].filter(Boolean).join(' and ')} ${E.side.name} changed`,
      });
    }
  }
  // The same new face on both sides, with different materials.
  for (const [i, j] of plan.convergentPairs) {
    const X = sideA.addedFaces[i];
    const Y = sideB.addedFaces[j];
    if (faceIdentity(A.mesh, ids.of[1], X) === faceIdentity(B.mesh, ids.of[2], Y)) continue;
    seeds.push({ base: [], oursSlots: [i], theirsSlots: [j], faces: [], pairs: [[X, Y]], units: [], what: 'both sides added the same face(s) with different materials' });
  }

  // ---- New texture-space overlaps (units join; unresolved = base), then UV units needing geometry ----
  // Faces whose assignment stays at base while unresolved: assignment conflicts and replacements.
  const pending = new Uint8Array(FO);
  for (const f of assignConflictFaces) pending[f] = 1;
  for (const seed of seeds) for (const f of seed.faces) pending[f] = 1;
  for (let k = 0; k < sets; k++) {
    if (look.uv[k].units.length === 0) continue;
    joinOverlaps(plan, look, k, seeds, pending, options.logger ?? null);
  }
  for (let k = 0; k < sets; k++) {
    look.uv[k].units.forEach((u, ui) => {
      if (u.status === 'conflict' && u.oursFaces.length + u.theirsFaces.length > 0) {
        seeds.push({ base: [], oursSlots: [], theirsSlots: [], faces: [], pairs: [], units: [[k, ui]], what: 'new faces take part in a UV conflict' });
      }
    });
  }
  couple(plan, look, seeds);

  // ---- Pure appearance conflicts, in id order: materials, assignment patches, UV units ---------------
  look.materials.forEach((mm, i) => {
    if (mm.conflicts.length === 0) return;
    look.materialConflict[i] = look.conflicts.length;
    const faces: number[] = [];
    for (let f = 0; f < FO; f++) if (idO[f] === i || idA[f] === i || idB[f] === i) faces.push(f);
    look.conflicts.push({
      kinds: { 'material-property': mm.conflicts.length },
      identity: i,
      properties: [...mm.conflicts],
      baseFaces: faces,
      oursFaces: [],
      theirsFaces: [],
      message: materialMessage(look, i, mm.conflicts),
    });
  });
  for (const patch of patches(base, assignConflictFaces)) {
    const k = look.conflicts.length;
    for (const f of patch) look.assignConflict[f] = k;
    look.conflicts.push({
      kinds: { 'material-assignment': patch.length },
      baseFaces: patch,
      oursFaces: [],
      theirsFaces: [],
      message: `${patch.length} face(s) given different materials by ours (${namesOf(look, 1, patch.map((f) => idA[f]))}) and theirs (${namesOf(look, 2, patch.map((f) => idB[f]))})`,
    });
  }
  for (let k = 0; k < sets; k++) {
    for (const u of look.uv[k].units) {
      if (u.status !== 'conflict' || u.owner >= 0) continue;
      u.conflict = look.conflicts.length;
      const kinds: IConflictPlan['kinds'] = {};
      const text: string[] = [];
      if (u.layout > 0) {
        kinds['uv-layout'] = u.baseFaces.length;
        text.push(`both sides changed the UV layout of the same island(s) differently (UV set ${k}, ${u.baseFaces.length} face(s))`);
      }
      if (u.overlaps > 0) {
        kinds['uv-overlap'] = u.overlaps;
        text.push(`islands changed by different sides now overlap in texture space on a shared image (UV set ${k}, ${u.overlaps} face pair(s))`);
      }
      look.conflicts.push({ kinds, set: k, baseFaces: u.baseFaces, oursFaces: u.oursFaces, theirsFaces: u.theirsFaces, message: text.join('; ') });
    }
  }
  return look;
}

/** UV change components of both sides for one set, and their three-way units. */
function planUvSet(
  plan: IMergePlan,
  look: IAppearancePlan,
  k: number,
  stats: IAppearancePlan['stats'],
): { plan: IUvSetPlan; inComp: [Uint8Array, Uint8Array] } {
  const { base } = plan;
  const FO = base.faceCount;
  const eps = look.eps;
  const O = look.baseUvs[k];
  const sides = [look.ours, look.theirs] as const;
  const out: IUvSetPlan = {
    unitOfBase: new Int32Array(FO).fill(-1),
    unitOfOurs: new Int32Array(look.ours.mesh.faceCount).fill(-1),
    unitOfTheirs: new Int32Array(look.theirs.mesh.faceCount).fill(-1),
    units: [],
  };
  const inComp: [Uint8Array, Uint8Array] = [new Uint8Array(FO), new Uint8Array(FO)];
  // Changed faces per side: kept base faces with different UVs, and added faces that have UVs.
  const changed = sides.map((S) => {
    const c = new Uint8Array(FO);
    let any = false;
    for (let f = 0; f < FO; f++) {
      if (S.faceOfBase[f] >= 0 && !sameFaceUv(S.uvOnBase[k], f * 6, O, f * 6, eps)) {
        c[f] = 1;
        any = true;
      }
    }
    const added = S.side.addedFaces;
    const newUv = new Uint8Array(added.length);
    for (let i = 0; i < added.length; i++) {
      const o = added[i] * 6;
      for (let q = 0; q < 6; q++) {
        if (S.uvs[k][o + q] === S.uvs[k][o + q]) {
          newUv[i] = 1;
          any = true;
          break;
        }
      }
    }
    return { base: c, added: newUv, any };
  });
  if (!changed[0].any && !changed[1].any) return { plan: out, inComp };

  // Super-islands: base gluing, then each side's own gluing on top (a side without changes has none).
  const baseUf = new UnionFind(FO);
  glueIslands(base.faces, FO, base.vertexCount, O, eps, (f, g) => baseUf.union(f, g));
  const comps = sides.map((S, si) => {
    const nAdded = S.side.addedFaces.length;
    const comp = new Int32Array(FO + nAdded).fill(-1);
    if (!changed[si].any) return comp;
    const uf = new UnionFind(FO + nAdded);
    for (let f = 0; f < FO; f++) uf.parent[f] = baseUf.find(f);
    const node = (s: number): number => (S.baseOfFace[s] >= 0 ? S.baseOfFace[s] : S.slotOfFace[s] >= 0 ? FO + S.slotOfFace[s] : -1);
    glueIslands(S.mesh.faces, S.mesh.faceCount, S.mesh.vertexCount, S.uvs[k], eps, (s1, s2) => {
      const a = node(s1);
      const b = node(s2);
      if (a >= 0 && b >= 0) uf.union(a, b);
    });
    const hot = new Uint8Array(FO + nAdded);
    for (let f = 0; f < FO; f++) if (changed[si].base[f]) hot[uf.find(f)] = 1;
    for (let i = 0; i < nAdded; i++) if (changed[si].added[i]) hot[uf.find(FO + i)] = 1;
    for (let x = 0; x < FO + nAdded; x++) {
      const r = uf.find(x);
      if (hot[r]) comp[x] = r;
    }
    for (let f = 0; f < FO; f++) if (comp[f] >= 0) inComp[si][f] = 1;
    return comp;
  });
  // Units: components of the two sides joined where they share a base face or a convergent new face.
  const [cA, cB] = comps;
  const offB = cA.length;
  const groups = new UnionFind(cA.length + cB.length);
  for (let f = 0; f < FO; f++) if (cA[f] >= 0 && cB[f] >= 0) groups.union(cA[f], offB + cB[f]);
  for (const [i, j] of plan.convergentPairs) {
    if (cA[FO + i] >= 0 && cB[FO + j] >= 0) groups.union(cA[FO + i], offB + cB[FO + j]);
  }
  const unitOfGroup = new Map<number, number>();
  const flags: Array<{ a: boolean; b: boolean }> = [];
  const unitOf = (g: number): number => {
    let u = unitOfGroup.get(g);
    if (u === undefined) {
      u = out.units.length;
      unitOfGroup.set(g, u);
      out.units.push({ status: 'conflict', baseFaces: [], oursFaces: [], theirsFaces: [], layout: 0, overlaps: 0, owner: -1, conflict: -1 });
      flags.push({ a: false, b: false });
    }
    return u;
  };
  for (let f = 0; f < FO; f++) {
    const g = cA[f] >= 0 ? groups.find(cA[f]) : cB[f] >= 0 ? groups.find(offB + cB[f]) : -1;
    if (g < 0) continue;
    const u = unitOf(g);
    out.unitOfBase[f] = u;
    out.units[u].baseFaces.push(f);
    if (cA[f] >= 0) flags[u].a = true;
    if (cB[f] >= 0) flags[u].b = true;
  }
  sides.forEach((S, si) => {
    const comp = comps[si];
    const offset = si === 0 ? 0 : offB;
    S.side.addedFaces.forEach((face, i) => {
      if (comp[FO + i] < 0) return;
      const u = unitOf(groups.find(offset + comp[FO + i]));
      (si === 0 ? out.unitOfOurs : out.unitOfTheirs)[face] = u;
      (si === 0 ? out.units[u].oursFaces : out.units[u].theirsFaces).push(face);
      if (si === 0) flags[u].a = true;
      else flags[u].b = true;
    });
  });
  // Status: taken whole from one side, identical, or a layout conflict. Never per face (it tears islands).
  const [UA, UB] = [look.ours.uvOnBase[k], look.theirs.uvOnBase[k]];
  out.units.forEach((u, ui) => {
    const { a, b } = flags[ui];
    if (!b) u.status = 'ours';
    else if (!a) u.status = 'theirs';
    else {
      let equal = true;
      let bInA = true;
      let aInB = true;
      for (const f of u.baseFaces) {
        if (look.ours.faceOfBase[f] < 0 || look.theirs.faceOfBase[f] < 0) continue;
        const ab = sameFaceUv(UA, f * 6, UB, f * 6, eps);
        if (ab) continue;
        equal = false;
        if (!sameFaceUv(UB, f * 6, O, f * 6, eps)) bInA = false;
        if (!sameFaceUv(UA, f * 6, O, f * 6, eps)) aInB = false;
      }
      // New faces: convergent ones must carry the same UVs; others exist on one side only.
      let oursNew = 0;
      let theirsNew = 0;
      const convergentTheirs = new Set<number>();
      for (const X of u.oursFaces) {
        const Y = look.convergent.get(X);
        if (Y === undefined) {
          oursNew++;
          continue;
        }
        convergentTheirs.add(Y);
        if (!sameTriangleUv(look.ours.uvs[k], X, look.theirs.uvs[k], Y, plan, eps)) equal = bInA = aInB = false;
      }
      for (const Y of u.theirsFaces) if (!convergentTheirs.has(Y)) theirsNew++;
      if (equal) u.status = 'both';
      else if (bInA && theirsNew === 0) u.status = 'ours';
      else if (aInB && oursNew === 0) u.status = 'theirs';
      else {
        u.status = 'conflict';
        u.layout = 1;
      }
    }
    if (u.status === 'conflict') return;
    const src = u.status === 'theirs' ? UB : UA;
    const S = u.status === 'theirs' ? look.theirs : look.ours;
    for (const f of u.baseFaces) {
      if (S.faceOfBase[f] < 0 || sameFaceUv(src, f * 6, O, f * 6, eps)) continue;
      if (u.status === 'ours') stats.uvFacesFromOurs++;
      else if (u.status === 'theirs') stats.uvFacesFromTheirs++;
      else stats.uvFacesConvergent++;
    }
  });
  return { plan: out, inComp };
}

/** Corner UVs of convergent new faces X (ours) and Y (theirs) agree, corners matched by vertex. */
function sameTriangleUv(ua: Float32Array, X: number, ub: Float32Array, Y: number, plan: IMergePlan, eps: number): boolean {
  const map = convergentCorners(plan, X, Y);
  for (let c = 0; c < 3; c++) {
    const q = map[c];
    if (q < 0) return false;
    if (!sameCornerUv(ua, (X * 3 + c) * 2, ub, (Y * 3 + q) * 2, eps)) return false;
  }
  return true;
}

/** For each corner of ours face X, the corner of theirs face Y with the same (canonical) vertex. */
function convergentCorners(plan: IMergePlan, X: number, Y: number): [number, number, number] {
  const nO = plan.base.vertexCount;
  const nA = plan.ours.mesh.vertexCount;
  const canonA = (t: number): number => (plan.ours.inv[t] >= 0 ? plan.ours.inv[t] : nO + t);
  const canonB = (t: number): number =>
    plan.theirs.inv[t] >= 0 ? plan.theirs.inv[t] : plan.unified[t] >= 0 ? nO + plan.unified[t] : nO + nA + t;
  const FA = plan.ours.mesh.faces;
  const FB = plan.theirs.mesh.faces;
  const out: [number, number, number] = [-1, -1, -1];
  for (let c = 0; c < 3; c++) {
    const v = canonA(FA[X * 3 + c]);
    for (let q = 0; q < 3; q++) if (canonB(FB[Y * 3 + q]) === v) out[c] = q;
  }
  return out;
}

interface ISeed {
  base: number[];
  oursSlots: number[];
  theirsSlots: number[];
  faces: number[];
  pairs: Array<[number, number]>;
  units: Array<[number, number]>;
  what: string;
}

/** Image hashes each identity samples through UV set k, in the unresolved merge. */
function imagesBySet(look: IAppearancePlan, k: number): string[][] {
  return look.materials.map((mm) => {
    const { def, images } = mergedDefinition(look, mm, () => 0);
    return textureRefsOf(def)
      .filter((r) => textureRefUvSet(r) === k)
      .map((r) => images[r.image]?.hash ?? '');
  });
}

/**
 * Texture-space overlaps between faces whose UVs come from different sides, in the unresolved merge
 * (conflict units at base): the units of an overlapping pair join into one conflict unit. Reverting a
 * unit can expose a new overlap, so the search repeats until nothing changes.
 */
function joinOverlaps(plan: IMergePlan, look: IAppearancePlan, k: number, seeds: ISeed[], pending: Uint8Array, logger: IDiffLogger | null): void {
  const set = look.uv[k];
  const nUnits = set.units.length;
  const uu = new UnionFind(nUnits);
  const hits = new Int32Array(nUnits); // overlap pairs per original unit (counted on the lower one)
  // Per union ROOT: in conflict; decided by a region (a replacement seed owns it). Both = base while unresolved.
  const conflict = new Uint8Array(nUnits);
  const owned = new Uint8Array(nUnits);
  set.units.forEach((u, i) => (conflict[i] = u.status === 'conflict' ? 1 : 0));
  for (const s of seeds) for (const [sk, u] of s.units) if (sk === k) owned[u] = 1;
  /** Join two units into one conflict; true when that changed anything. */
  const join = (a: number, b: number): boolean => {
    const ra = uu.find(a);
    const rb = uu.find(b);
    if (ra === rb && conflict[ra]) return false;
    uu.union(ra, rb);
    const r = uu.find(ra);
    conflict[r] = 1;
    owned[r] = owned[ra] | owned[rb];
    return true;
  };
  const imageSets = imagesBySet(look, k);
  const { ours: A, theirs: B, eps } = look;
  const O = look.baseUvs[k];
  // Records: base faces kept on both sides, and new faces (a convergent one once, from ours).
  const recFace: number[] = [];
  const recSrc: number[] = [];
  const record = (x: number, src: number): void => {
    recFace.push(x);
    recSrc.push(src);
  };
  for (let f = 0; f < plan.base.faceCount; f++) {
    if (set.unitOfBase[f] >= 0 && A.faceOfBase[f] >= 0 && B.faceOfBase[f] >= 0) record(f, 0);
  }
  for (const X of plan.ours.addedFaces) if (set.unitOfOurs[X] >= 0) record(X, 1);
  const convergentTheirs = new Set(look.convergent.values());
  for (const Y of plan.theirs.addedFaces) if (set.unitOfTheirs[Y] >= 0 && !convergentTheirs.has(Y)) record(Y, 2);
  const n = recFace.length;
  if (n < 2) return;
  const unitOfRec = recFace.map((x, r) => (recSrc[r] === 0 ? set.unitOfBase[x] : recSrc[r] === 1 ? set.unitOfOurs[x] : set.unitOfTheirs[x]));
  const identityOfRec = recFace.map((x, r) => {
    if (recSrc[r] === 1) return faceIdentity(A.mesh, look.identities.of[1], x);
    if (recSrc[r] === 2) return faceIdentity(B.mesh, look.identities.of[2], x);
    return pending[x] ? look.faceId[0][x] : autoIdentity(look, x);
  });
  const uv = new Float32Array(n * 6);
  const bits = new Uint8Array(n);
  let truncated = false;
  for (let pass = 0; pass < MAX_OVERLAP_PASSES; pass++) {
    // Merged UVs and version bits in the current unresolved state.
    for (let r = 0; r < n; r++) {
      const x = recFace[r];
      const root = uu.find(unitOfRec[r]);
      const unit = set.units[unitOfRec[r]];
      const unresolved = conflict[root] || owned[root];
      if (recSrc[r] === 0) {
        const d: Decision = unresolved ? 0 : unit.status === 'theirs' ? 2 : 1;
        const src = d === 0 ? O : d === 1 ? A.uvOnBase[k] : B.uvOnBase[k];
        uv.set(src.subarray(x * 6, x * 6 + 6), r * 6);
        bits[r] =
          (sameFaceUv(uv, r * 6, O, x * 6, eps) ? 0 : IN_BASE) |
          (sameFaceUv(uv, r * 6, A.uvOnBase[k], x * 6, eps) ? 0 : IN_OURS) |
          (sameFaceUv(uv, r * 6, B.uvOnBase[k], x * 6, eps) ? 0 : IN_THEIRS);
      } else {
        const own = recSrc[r] === 1 ? A.uvs[k] : B.uvs[k];
        uv.set(own.subarray(x * 6, x * 6 + 6), r * 6);
        const other = recSrc[r] === 1 ? (look.convergent.has(x) ? 0 : IN_THEIRS) : IN_OURS;
        bits[r] = IN_BASE | other;
      }
    }
    let changed = false;
    const versionUv = new Float32Array(12);
    truncated = searchUvOverlaps({
      uv,
      count: n,
      eps,
      maxTests: MAX_UV_PAIR_TESTS,
      consider: (a, b) => {
        if ((bits[a] | bits[b]) !== ALL) return false;
        const ia = imageSets[identityOfRec[a]] ?? [];
        const ib = imageSets[identityOfRec[b]] ?? [];
        if (!ia.some((h) => ib.includes(h))) return false;
        // Overlapping in some version already: not new.
        for (const v of [0, 1, 2] as const) {
          if (!versionFaceUv(look, k, recFace[a], recSrc[a], v, versionUv, 0)) continue;
          if (!versionFaceUv(look, k, recFace[b], recSrc[b], v, versionUv, 6)) continue;
          if (uvTrianglesOverlap(versionUv, 0, versionUv, 6, eps)) return false;
        }
        return true;
      },
      hit: (a, b) => {
        hits[Math.min(unitOfRec[a], unitOfRec[b])]++;
        if (join(unitOfRec[a], unitOfRec[b])) changed = true;
        return true;
      },
    });
    if (!changed) break;
    if (pass === MAX_OVERLAP_PASSES - 1) logger?.warn('[polymerge] merge: texture-space overlap check did not settle; the unresolved merge may still have overlapping islands');
  }
  if (truncated) logger?.warn(`[polymerge] merge: texture-space overlap check hit its bound (UV set ${k}); some overlaps may be unreported`);
  // Rebuild the units as unions.
  const newIndex = new Map<number, number>();
  const units: IUvUnit[] = [];
  const remap = new Int32Array(nUnits);
  for (let i = 0; i < nUnits; i++) {
    const root = uu.find(i);
    let j = newIndex.get(root);
    if (j === undefined) {
      j = units.length;
      newIndex.set(root, j);
      units.push({ status: set.units[i].status, baseFaces: [], oursFaces: [], theirsFaces: [], layout: 0, overlaps: 0, owner: -1, conflict: -1 });
    }
    remap[i] = j;
    const u = units[j];
    const src = set.units[i];
    append(u.baseFaces, src.baseFaces);
    append(u.oursFaces, src.oursFaces);
    append(u.theirsFaces, src.theirsFaces);
    u.layout += src.layout;
    u.overlaps += hits[i];
    // A union of several units was joined by an overlap, so it is a conflict; a lone unit keeps its status.
    if (conflict[root]) u.status = 'conflict';
  }
  for (const u of units) u.baseFaces.sort((a, b) => a - b);
  for (const arr of [set.unitOfBase, set.unitOfOurs, set.unitOfTheirs]) for (let x = 0; x < arr.length; x++) if (arr[x] >= 0) arr[x] = remap[arr[x]];
  set.units = units;
  for (const s of seeds) s.units = s.units.map(([sk, u]) => [sk, sk === k ? remap[u] : u]);
}

/** The UVs face x (record source src) has in version v, into out[o..o+6); false when absent there. */
function versionFaceUv(look: IAppearancePlan, k: number, x: number, src: number, v: Version, out: Float32Array, o: number): boolean {
  if (src === 0) {
    const arr = v === 0 ? look.baseUvs[k] : v === 1 ? look.ours.uvOnBase[k] : look.theirs.uvOnBase[k];
    out.set(arr.subarray(x * 6, x * 6 + 6), o);
    return true;
  }
  if (v === 0) return false;
  if (src === 1) {
    if (v === 1) return (out.set(look.ours.uvs[k].subarray(x * 6, x * 6 + 6), o), true);
    const y = look.convergent.get(x);
    return y === undefined ? false : (out.set(look.theirs.uvs[k].subarray(y * 6, y * 6 + 6), o), true);
  }
  return v === 2 ? (out.set(look.theirs.uvs[k].subarray(x * 6, x * 6 + 6), o), true) : false;
}

/**
 * Merge the coupling seeds that share an appearance unit into one `appearance-geometry` atomic each:
 * the region then decides the geometry and those units together. Every new face inside an owned UV
 * unit joins the atomic, so resolving 'the other side' removes it instead of leaving it laid out
 * against a layout it was not made for.
 */
function couple(plan: IMergePlan, look: IAppearancePlan, seeds: ISeed[]): void {
  if (seeds.length === 0) return;
  const uf = new UnionFind(seeds.length);
  const owner = new Map<string, number>();
  const claim = (key: string, s: number): void => {
    const o = owner.get(key);
    if (o === undefined) owner.set(key, s);
    else uf.union(o, s);
  };
  seeds.forEach((s, i) => {
    for (const [k, u] of s.units) claim(`u${k}:${u}`, i);
    for (const f of s.faces) claim(`f${f}`, i);
    for (const [X] of s.pairs) claim(`p${X}`, i);
  });
  const byRoot = new Map<number, number>();
  /** Seed descriptions of each coupled unit, with counts. */
  const whats: Array<Map<string, number>> = [];
  seeds.forEach((s, i) => {
    const root = uf.find(i);
    let c = byRoot.get(root);
    if (c === undefined) {
      c = look.coupled.length;
      byRoot.set(root, c);
      look.coupled.push({ atomic: { kind: 'appearance-geometry', base: [], oursFaceSlots: [], theirsFaceSlots: [] }, faces: [], pairs: [], units: [] });
      whats.push(new Map());
    }
    const cp = look.coupled[c];
    append(cp.atomic.base, s.base);
    append(cp.atomic.oursFaceSlots, s.oursSlots);
    append(cp.atomic.theirsFaceSlots, s.theirsSlots);
    append(cp.faces, s.faces);
    append(cp.pairs, s.pairs);
    for (const [k, u] of s.units) if (!cp.units.some(([a, b]) => a === k && b === u)) cp.units.push([k, u]);
    whats[c].set(s.what, (whats[c].get(s.what) ?? 0) + 1);
  });
  look.coupled.forEach((cp, c) => {
    for (const f of cp.faces) look.assignOwner[f] = c;
    for (const [X] of cp.pairs) look.pairOwner.set(X, c);
    const oursSlots = new Set(cp.atomic.oursFaceSlots);
    const theirsSlots = new Set(cp.atomic.theirsFaceSlots);
    for (const [k, u] of cp.units) {
      const unit = look.uv[k].units[u];
      unit.owner = c;
      for (const X of unit.oursFaces) oursSlots.add(plan.oursSlotOfFace[X]);
      for (const Y of unit.theirsFaces) theirsSlots.add(plan.theirsSlotOfFace[Y]);
    }
    cp.atomic.oursFaceSlots = [...oursSlots].filter((x) => x >= 0);
    cp.atomic.theirsFaceSlots = [...theirsSlots].filter((x) => x >= 0);
    cp.atomic.base = [...new Set(cp.atomic.base)];
    cp.atomic.detail = [...whats[c]].map(([what, n]) => `${what} (${n})`).join('; ');
  });
}

/** Faces connected through shared edges, grouped (each group ascending, groups by first face). */
function patches(base: IMesh, faces: number[]): number[][] {
  if (faces.length === 0) return [];
  const uf = new UnionFind(faces.length);
  const byEdge = new Map<number, number>();
  const n = base.vertexCount;
  faces.forEach((f, i) => {
    for (let c = 0; c < 3; c++) {
      const a = base.faces[f * 3 + c];
      const b = base.faces[f * 3 + ((c + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      const j = byEdge.get(key);
      if (j === undefined) byEdge.set(key, i);
      else uf.union(i, j);
    }
  });
  const groups = new Map<number, number[]>();
  faces.forEach((f, i) => {
    const r = uf.find(i);
    const g = groups.get(r);
    if (g) g.push(f);
    else groups.set(r, [f]);
  });
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

/** Assignment of base face f outside every conflict (deleted on a side = no opinion). */
function autoIdentity(look: IAppearancePlan, f: number): number {
  const [idO, idA, idB] = look.faceId;
  const o = idO[f];
  const a = idA[f];
  const b = idB[f];
  if (a === -2 && b === -2) return o;
  if (a === -2) return b;
  if (b === -2) return a;
  if (a === b || b === o) return a;
  return b;
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

function identityName(look: IAppearancePlan, i: number): string {
  if (i < 0) return '(none)';
  const id = look.identities.list[i];
  for (const v of [1, 2, 0] as const) {
    const idx = id.index[v];
    if (idx >= 0) return look.meshes[v].materials[idx]?.name ?? id.key;
  }
  return id.key;
}

function namesOf(look: IAppearancePlan, _v: Version, list: number[]): string {
  const names = [...new Set(list)].map((i) => `"${identityName(look, i)}"`);
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');
}

function describeValue(value: unknown, images: readonly ITextureImage[]): string {
  if (value === undefined) return 'none';
  if (typeof value === 'number') return String(Number(value.toPrecision(4)));
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((x) => typeof x === 'number')) return `[${value.map((x) => Number(x.toPrecision(4))).join(', ')}]`;
  if (typeof value === 'object' && value !== null && typeof (value as { image?: unknown }).image === 'number') {
    const img = images[(value as { image: number }).image];
    const what = img?.name ?? img?.uri ?? (img ? `image ${img.hash.split(':')[1]?.slice(0, 8)}` : 'image ?');
    return `texture ${what}`;
  }
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function materialMessage(look: IAppearancePlan, i: number, properties: string[]): string {
  const id = look.identities.list[i];
  const A = definitionIn(id, 1, look.meshes)!;
  const B = definitionIn(id, 2, look.meshes)!;
  const imgA = look.meshes[1].appearance?.images ?? [];
  const imgB = look.meshes[2].appearance?.images ?? [];
  const parts = properties.map((p) => `${p} (ours ${describeValue(definitionValue(A, p), imgA)}, theirs ${describeValue(definitionValue(B, p), imgB)})`);
  return `both sides changed material "${identityName(look, i)}" differently: ${parts.join('; ')}`;
}

// ---------------------------------------------------------------------------------------------
// Materialisation
// ---------------------------------------------------------------------------------------------

/** Merged image table: images by content hash, in first-use order. */
class ImageTable {
  readonly images: ITextureImage[] = [];
  private readonly byHash = new Map<string, number>();
  add(img: ITextureImage | undefined): number {
    if (!img) return -1;
    let i = this.byHash.get(img.hash);
    if (i === undefined) {
      i = this.images.push(img) - 1;
      this.byHash.set(img.hash, i);
    }
    return i;
  }
}

/**
 * The merged definition of one identity, each property from the version its source (or the
 * material's conflict resolution, `choice`) says; image indices point into the returned table.
 */
function mergedDefinition(
  look: IAppearancePlan,
  mm: IMaterialMerge,
  choice: () => Decision,
  table = new ImageTable(),
): { def: IMaterialDefinition; images: ITextureImage[]; fallbackName: string } {
  const id = look.identities.list[mm.identity];
  const defs = [0, 1, 2].map((v) => definitionIn(id, v as Version, look.meshes));
  const def: IMaterialDefinition = defaultMaterialDefinition();
  for (const { name, source } of mm.properties) {
    let v: Decision;
    if (source === 'conflict') v = choice();
    else v = source === 'ours' || source === 'both' ? 1 : source === 'theirs' ? 2 : 0;
    const from = defs[v] ?? (v === 0 ? defaultMaterialDefinition() : defs[0] ?? defaultMaterialDefinition());
    const images = look.meshes[defs[v] ? v : 0].appearance?.images ?? [];
    const value = definitionValue(from, name);
    setDefinitionValue(def, name, value === undefined ? undefined : remapTextureRefs(structuredClone(value), (i) => table.add(images[i])));
  }
  return { def, images: table.images, fallbackName: identityName(look, mm.identity) };
}

/** Region of a coupled atomic after the regions were (re)built: the region holding any of its nodes. */
function regionOfAtomic(plan: IMergePlan, a: IAtomic): number {
  for (const v of a.base) if (plan.regionOfBase[v] >= 0) return plan.regionOfBase[v];
  for (const i of a.oursFaceSlots) {
    const r = plan.regionOfOursFace[plan.ours.addedFaces[i]];
    if (r >= 0) return r;
  }
  for (const j of a.theirsFaceSlots) {
    const r = plan.regionOfTheirsFace[plan.theirs.addedFaces[j]];
    if (r >= 0) return r;
  }
  return -1;
}

/** The whole-version copy of a lineage merge carries that version's appearance. */
function lineageAppearance(look: IAppearancePlan, m: IMaterialized): IAppearanceResult {
  const src = m.provenance.faceSource[0] ?? 0;
  const from = look.meshes[src];
  // A copy, like the geometry (image bytes are shared: they are never modified).
  const app = from.appearance!;
  const mesh: IMesh = {
    ...m.mesh,
    materials: from.materials.map((x) => ({ ...x })),
    appearance: { materials: structuredClone(app.materials), images: [...app.images], uvs: app.uvs.map((u) => Float32Array.from(u)) },
  };
  if (from.faceMaterials) mesh.faceMaterials = Int32Array.from(from.faceMaterials);
  return {
    mesh,
    info: {
      stats: { ...look.stats, materials: from.materials.length, conflicts: 0, unresolved: 0 },
      faceChangedBy: new Uint8Array(m.mesh.faceCount).fill(src === 0 ? 0 : src),
      faceConflict: new Int32Array(m.mesh.faceCount).fill(-1),
    },
    conflicts: [],
    warning: null,
  };
}

/**
 * Apply the appearance merge to a materialised geometry merge: the merged mesh with materials,
 * faceMaterials and appearance, per-face provenance, the appearance conflicts (ids from `idOffset`)
 * and, when anything was resolved, a warning for texture-space overlaps the chosen combination makes.
 */
export function materializeAppearance(
  look: IAppearancePlan,
  plan: IMergePlan,
  m: IMaterialized,
  choices: IAppearanceChoices,
  idOffset: number,
  checkOverlaps: boolean,
): IAppearanceResult {
  if (look.lineage) return lineageAppearance(look, m);
  const mesh = m.mesh;
  const prov = m.provenance;
  const nF = mesh.faceCount;
  const { ours: A, theirs: B } = look;
  const [idO, idA, idB] = look.faceId;
  const conflictChoice = look.conflicts.map((_, k) => decisionOf(choices.conflict(k)));
  const coupledChoice = look.coupled.map((c) => {
    const r = regionOfAtomic(plan, c.atomic);
    return r >= 0 ? decisionOf(choices.region(r)) : 0;
  });
  const unitDecision = look.uv.map((set) =>
    set.units.map((u): Decision => {
      if (u.owner >= 0) return coupledChoice[u.owner];
      if (u.conflict >= 0) return conflictChoice[u.conflict];
      return u.status === 'theirs' ? 2 : u.status === 'conflict' ? 0 : 1;
    }),
  );
  const pick = (d: Decision, f: number): number => (d === 1 && idA[f] !== -2 ? idA[f] : d === 2 && idB[f] !== -2 ? idB[f] : idO[f]);

  // ---- Assignment per merged face ---------------------------------------------------------------
  const identity = new Int32Array(nF);
  const changedBy = new Uint8Array(nF);
  const faceConflict = new Int32Array(nF).fill(-1);
  const theirsCounterpart = new Int32Array(nF).fill(-1); // convergent faces decided 'theirs'
  for (let j = 0; j < nF; j++) {
    const src = prov.faceSource[j];
    const fi = prov.faceIndex[j];
    if (src === 1) {
      identity[j] = faceIdentity(A.mesh, look.identities.of[1], fi);
      changedBy[j] = 1;
      const owner = look.pairOwner.get(fi);
      const Y = look.convergent.get(fi);
      if (Y !== undefined) {
        changedBy[j] = 3;
        if (owner !== undefined && coupledChoice[owner] === 2) {
          identity[j] = faceIdentity(B.mesh, look.identities.of[2], Y);
          theirsCounterpart[j] = Y;
        }
      }
      continue;
    }
    if (src === 2) {
      identity[j] = faceIdentity(B.mesh, look.identities.of[2], fi);
      changedBy[j] = 2;
      continue;
    }
    const f = fi;
    let id: number;
    if (look.assignOwner[f] >= 0) id = pick(coupledChoice[look.assignOwner[f]], f);
    else if (look.assignConflict[f] >= 0) {
      id = pick(conflictChoice[look.assignConflict[f]], f);
      faceConflict[j] = idOffset + look.assignConflict[f];
    } else id = autoIdentity(look, f);
    identity[j] = id;
    if (id !== idO[f]) changedBy[j] |= (idA[f] === id ? 1 : 0) | (idB[f] === id ? 2 : 0);
  }

  // ---- UVs per merged face corner -----------------------------------------------------------------
  const uvs: Float32Array[] = look.uv.map((set, k) => {
    const out = nanArray(nF * 6);
    const O = look.baseUvs[k];
    for (let j = 0; j < nF; j++) {
      const src = prov.faceSource[j];
      const fi = prov.faceIndex[j];
      const Y = src === 1 ? look.convergent.get(fi) : undefined;
      const unitOfNew = src === 1 ? set.unitOfOurs[fi] : -1;
      if (Y !== undefined && (theirsCounterpart[j] >= 0 || (unitOfNew >= 0 && unitDecision[k][unitOfNew] === 2))) {
        // A convergent new face decided 'theirs': theirs' corners, matched by vertex.
        const map = convergentCorners(plan, fi, Y);
        for (let c = 0; c < 3; c++) {
          const q = map[c] >= 0 ? map[c] : c;
          out[j * 6 + c * 2] = B.uvs[k][(Y * 3 + q) * 2];
          out[j * 6 + c * 2 + 1] = B.uvs[k][(Y * 3 + q) * 2 + 1];
        }
        continue;
      }
      if (src !== 0) {
        const own = src === 1 ? A.uvs[k] : B.uvs[k];
        out.set(own.subarray(fi * 6, fi * 6 + 6), j * 6);
        continue;
      }
      const u = set.unitOfBase[fi];
      const d: Decision = u >= 0 ? unitDecision[k][u] : 0;
      const S = d === 1 ? A : d === 2 ? B : null;
      const from = S && S.faceOfBase[fi] >= 0 ? S.uvOnBase[k] : O;
      out.set(from.subarray(fi * 6, fi * 6 + 6), j * 6);
      if (u >= 0) {
        const unit = set.units[u];
        const both = unit.status === 'both' && unit.conflict < 0 && unit.owner < 0;
        if (from !== O && !sameFaceUv(from, fi * 6, O, fi * 6, look.eps)) changedBy[j] |= both ? 3 : d;
        if (unit.conflict >= 0 && faceConflict[j] < 0) faceConflict[j] = idOffset + unit.conflict;
      }
    }
    return out;
  });

  // ---- Materials: the identities merged faces use, in first-use order ------------------------------
  const table = new ImageTable();
  const materialOf = new Map<number, number>();
  const materials: IMaterial[] = [];
  const definitions: IMaterialDefinition[] = [];
  const faceMaterials = new Int32Array(nF).fill(-1);
  let anyMaterial = false;
  for (let j = 0; j < nF; j++) {
    const id = identity[j];
    if (id < 0) continue;
    let mi = materialOf.get(id);
    if (mi === undefined) {
      mi = materials.length;
      materialOf.set(id, mi);
      const mm = look.materials[id];
      const k = look.materialConflict[id];
      const { def, fallbackName } = mergedDefinition(look, mm, () => (k >= 0 ? conflictChoice[k] : 0), table);
      definitions.push(def);
      materials.push(materialSummary(def, fallbackName));
    }
    faceMaterials[j] = mi;
    anyMaterial = true;
  }
  const groups: IMeshGroup[] = mesh.groups.map((g) => {
    const out: IMeshGroup = { ...g };
    const m0 = faceMaterials[g.faceStart];
    let uniform = anyMaterial && m0 >= 0;
    for (let f = g.faceStart + 1; uniform && f < g.faceStart + g.faceCount; f++) uniform = faceMaterials[f] === m0;
    if (uniform) out.materialIndex = m0;
    return out;
  });
  const merged: IMesh = {
    ...mesh,
    groups,
    materials,
    appearance: { materials: definitions, images: table.images, uvs },
  };
  if (anyMaterial) merged.faceMaterials = faceMaterials;

  const conflicts = look.conflicts.map((c, k) => toConflict(look, plan, m, c, idOffset + k, choices.conflict(k)));
  const unresolved = conflicts.filter((c) => c.resolution === null).length;
  return {
    mesh: merged,
    info: {
      stats: { ...look.stats, materials: materials.length, conflicts: conflicts.length, unresolved },
      faceChangedBy: changedBy,
      faceConflict,
    },
    conflicts,
    warning: checkOverlaps ? overlapWarning(look, plan, merged, prov, faceConflict) : null,
  };
}

/** An appearance conflict as IMergeConflict (faces, vertices of each version, focus in the merged frame). */
function toConflict(look: IAppearancePlan, plan: IMergePlan, m: IMaterialized, c: IConflictPlan, id: number, resolution: MergeResolution | null): IMergeConflict {
  const { base } = plan;
  const verts = new Set<number>();
  for (const f of c.baseFaces) for (let q = 0; q < 3; q++) verts.add(base.faces[f * 3 + q]);
  const sideVerts = (S: ILookSide, added: number[]): Uint32Array => {
    const set = new Set<number>();
    for (const f of c.baseFaces) {
      const s = S.faceOfBase[f];
      if (s >= 0) for (let q = 0; q < 3; q++) set.add(S.mesh.faces[s * 3 + q]);
    }
    for (const s of added) for (let q = 0; q < 3; q++) set.add(S.mesh.faces[s * 3 + q]);
    return Uint32Array.from([...set].sort((a, b) => a - b));
  };
  const q = new Float64Array(3);
  let fx = 0;
  let fy = 0;
  let fz = 0;
  let n = 0;
  const bp = base.positions;
  for (const v of verts) {
    applyRigid(m.global, bp[v * 3], bp[v * 3 + 1], bp[v * 3 + 2], q);
    fx += q[0];
    fy += q[1];
    fz += q[2];
    n++;
  }
  if (n === 0) {
    for (const [faces, pos, S] of [
      [c.oursFaces, plan.oursAddedPos, look.ours],
      [c.theirsFaces, plan.theirsAddedPos, look.theirs],
    ] as const) {
      for (const s of faces) {
        for (let k = 0; k < 3; k++) {
          const t = S.mesh.faces[s * 3 + k];
          if (S.side.inv[t] >= 0) continue;
          applyRigid(m.global, pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2], q);
          fx += q[0];
          fy += q[1];
          fz += q[2];
          n++;
        }
      }
    }
  }
  const out: IMergeConflict = {
    id,
    kinds: { ...c.kinds } as Partial<Record<MergeConflictKind, number>>,
    message: c.message,
    baseVertices: Uint32Array.from([...verts].sort((a, b) => a - b)),
    baseFaces: Uint32Array.from(c.baseFaces),
    oursVertices: sideVerts(look.ours, c.oursFaces),
    theirsVertices: sideVerts(look.theirs, c.theirsFaces),
    focus: n > 0 ? [fx / n, fy / n, fz / n] : [0, 0, 0],
    resolution,
    wholeModel: false,
    appearance: { faces: c.baseFaces.length + c.oursFaces.length + c.theirsFaces.length },
  };
  if (c.identity !== undefined) out.appearance!.material = identityName(look, c.identity);
  if (c.properties) out.appearance!.properties = c.properties;
  if (c.set !== undefined) out.appearance!.uvSet = c.set;
  return out;
}

/**
 * Texture-space overlaps that only the chosen combination of resolutions creates: merged faces on a
 * common image whose UVs overlap where no version had them overlap (null when none).
 */
function overlapWarning(look: IAppearancePlan, plan: IMergePlan, merged: IMesh, prov: IMaterialized['provenance'], faceConflict: Int32Array): IMergeWarning | null {
  const app = merged.appearance!;
  if (app.uvs.length === 0) return null;
  const nF = merged.faceCount;
  const faces = new Set<number>();
  const conflicts = new Set<number>();
  let pairs = 0;
  let truncated = false;
  const imageSets = app.uvs.map((_, k) =>
    app.materials.map((d) =>
      textureRefsOf(d)
        .filter((r) => textureRefUvSet(r) === k)
        .map((r) => app.images[r.image]?.hash ?? ''),
    ),
  );
  for (let k = 0; k < app.uvs.length; k++) {
    const uv = app.uvs[k];
    const bits = new Uint8Array(nF);
    const version = new Float32Array(6);
    const cand: number[] = [];
    for (let j = 0; j < nF; j++) {
      const src = prov.faceSource[j];
      const fi = prov.faceIndex[j];
      let b = 0;
      for (const v of [0, 1, 2] as const) {
        const has = versionFaceUv(look, k, fi, src, v, version, 0);
        if (!has || !sameFaceUv(uv, j * 6, version, 0, look.eps)) b |= v === 0 ? IN_BASE : v === 1 ? IN_OURS : IN_THEIRS;
      }
      bits[j] = b;
      if (b !== 0 && b !== IN_BASE) cand.push(j);
    }
    if (cand.length < 2) continue;
    const recUv = new Float32Array(cand.length * 6);
    cand.forEach((j, r) => recUv.set(uv.subarray(j * 6, j * 6 + 6), r * 6));
    const both = new Float32Array(12);
    truncated =
      searchUvOverlaps({
        uv: recUv,
        count: cand.length,
        eps: look.eps,
        maxTests: MAX_UV_PAIR_TESTS,
        consider: (a, b) => {
          const ja = cand[a];
          const jb = cand[b];
          if ((bits[ja] | bits[jb]) !== ALL) return false;
          const ia = merged.faceMaterials?.[ja] ?? -1;
          const ib = merged.faceMaterials?.[jb] ?? -1;
          if (ia < 0 || ib < 0 || !imageSets[k][ia].some((h) => imageSets[k][ib].includes(h))) return false;
          for (const v of [0, 1, 2] as const) {
            if (!versionFaceUv(look, k, prov.faceIndex[ja], prov.faceSource[ja], v, both, 0)) continue;
            if (!versionFaceUv(look, k, prov.faceIndex[jb], prov.faceSource[jb], v, both, 6)) continue;
            if (uvTrianglesOverlap(both, 0, both, 6, look.eps)) return false;
          }
          return true;
        },
        hit: (a, b) => {
          pairs++;
          for (const j of [cand[a], cand[b]]) {
            faces.add(j);
            if (faceConflict[j] >= 0) conflicts.add(faceConflict[j]);
            for (let q = 0; q < 3; q++) {
              const r = prov.vertexConflict[merged.faces[j * 3 + q]];
              if (r >= 0) conflicts.add(r);
            }
          }
          return true;
        },
      }) || truncated;
  }
  if (pairs === 0) return null;
  const ids = [...conflicts].sort((a, b) => a - b);
  return {
    kind: 'uv-overlap',
    message:
      `the chosen resolutions make UV islands overlap in texture space on a shared image: ${pairs} face pair(s)` +
      (ids.length > 0 ? ` (where conflicts ${ids.map((c) => `#${c}`).join(', ')} meet)` : '') +
      (truncated ? '; the check hit its bound, so there may be more' : ''),
    mergedFaces: Uint32Array.from([...faces].sort((a, b) => a - b)),
    conflicts: ids,
  };
}
