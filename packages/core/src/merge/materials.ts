/**
 * MATERIALS in a three-way merge (docs/appearance-merge-design.md §3, §5):
 *
 *   identity     which material of ours / theirs is which material of the base: by NAME (rank among
 *                same-named materials breaks duplicates), then RENAMES (a vanished base name and a new
 *                side name that are each other's most frequent partner over the kept faces, covering
 *                more than half of the base material's kept faces), then NEW (by name; the same new
 *                name on both sides is one material, add/add). Indices mean nothing: the loader keeps
 *                materials in first-use order.
 *   definitions  merged PROPERTY BY PROPERTY with the three-way rule; a texture slot and an extension
 *                are one property each. A side that no longer uses a material has no opinion on it.
 *                An add/add material compares against the glTF defaults (what "absent" means).
 */
import {
  appearanceValueKey,
  defaultMaterialDefinition,
  definitionProperties,
  definitionValue,
} from '../appearance.js';
import type { IMaterialDefinition, IMesh, ITextureImage } from '../types.js';

/** Version indices: 0 = base, 1 = ours, 2 = theirs. */
export type Version = 0 | 1 | 2;

export interface IMaterialIdentity {
  /** Base material name key, or the new material's name key. */
  key: string;
  /** Material index in base / ours / theirs (-1 = the version does not use it). */
  index: [base: number, ours: number, theirs: number];
}

export interface IIdentities {
  list: IMaterialIdentity[];
  /** Identity of every material of base / ours / theirs. */
  of: [Int32Array, Int32Array, Int32Array];
  /** Materials matched by rename detection on ours / theirs. */
  renamed: [number, number];
}

/** Where a merged property value comes from ('conflict': decided by the material's conflict). */
export type PropertySource = 'base' | 'ours' | 'theirs' | 'both' | 'conflict';

export interface IMaterialMerge {
  identity: number;
  /** Every property any version sets, with its source. */
  properties: Array<{ name: string; source: PropertySource }>;
  /** Properties both sides changed differently. */
  conflicts: string[];
}

/** Name keys of a mesh's materials: the name, and `name#k` for the k-th material of that name (k ≥ 2). */
export function materialKeys(mesh: IMesh): string[] {
  const seen = new Map<string, number>();
  return mesh.materials.map((m) => {
    const n = (seen.get(m.name) ?? 0) + 1;
    seen.set(m.name, n);
    return n === 1 ? m.name : `${m.name}#${n}`;
  });
}

/**
 * Match one side's materials to the base's: by name key, then renames over the kept faces.
 * `faceOfBase[f]` is the side face of kept base face f (-1 = not kept). Returns side → base (-1 = new).
 */
function matchSide(base: IMesh, side: IMesh, faceOfBase: Int32Array): { toBase: Int32Array; renamed: number } {
  const nB = base.materials.length;
  const nS = side.materials.length;
  const toBase = new Int32Array(nS).fill(-1);
  const byKey = new Map(materialKeys(base).map((k, i) => [k, i]));
  const matched = new Uint8Array(nB);
  materialKeys(side).forEach((k, j) => {
    const i = byKey.get(k);
    if (i === undefined) return;
    toBase[j] = i;
    matched[i] = 1;
  });
  let renamed = 0;
  const bfm = base.faceMaterials;
  const sfm = side.faceMaterials;
  if (!bfm || !sfm || matched.every((x) => x === 1) || toBase.every((x) => x >= 0)) return { toBase, renamed };
  // Pair counts over kept faces between unmatched base and unmatched side materials.
  const kept = new Int32Array(nB);
  const counts = new Map<number, number>();
  for (let f = 0; f < base.faceCount; f++) {
    const s = faceOfBase[f];
    const i = bfm[f];
    if (s < 0 || i < 0) continue;
    kept[i]++;
    const j = sfm[s];
    if (matched[i] || j < 0 || toBase[j] >= 0) continue;
    const key = i * nS + j;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const bestOfBase = new Int32Array(nB).fill(-1);
  const bestOfBaseN = new Int32Array(nB);
  const bestOfSide = new Int32Array(nS).fill(-1);
  const bestOfSideN = new Int32Array(nS);
  for (const [key, n] of [...counts].sort((a, b) => a[0] - b[0])) {
    const i = Math.floor(key / nS);
    const j = key - i * nS;
    if (n > bestOfBaseN[i]) {
      bestOfBaseN[i] = n;
      bestOfBase[i] = j;
    }
    if (n > bestOfSideN[j]) {
      bestOfSideN[j] = n;
      bestOfSide[j] = i;
    }
  }
  for (let i = 0; i < nB; i++) {
    const j = bestOfBase[i];
    if (matched[i] || j < 0 || bestOfSide[j] !== i || 2 * bestOfBaseN[i] <= kept[i]) continue;
    toBase[j] = i;
    renamed++;
  }
  return { toBase, renamed };
}

export function matchMaterials(base: IMesh, ours: IMesh, theirs: IMesh, oursFaceOfBase: Int32Array, theirsFaceOfBase: Int32Array): IIdentities {
  const nB = base.materials.length;
  const list: IMaterialIdentity[] = materialKeys(base).map((key, i) => ({ key, index: [i, -1, -1] }));
  const a = matchSide(base, ours, oursFaceOfBase);
  const b = matchSide(base, theirs, theirsFaceOfBase);
  // New materials: one identity per name key, shared by both sides (add/add); sorted by key so that
  // swapping ours and theirs gives the same identities.
  const newKeys = new Map<string, [number, number]>();
  const newEntry = (key: string): [number, number] => {
    let e = newKeys.get(key);
    if (!e) newKeys.set(key, (e = [-1, -1]));
    return e;
  };
  const keysA = materialKeys(ours);
  const keysB = materialKeys(theirs);
  a.toBase.forEach((i, j) => {
    if (i < 0) newEntry(keysA[j])[0] = j;
  });
  b.toBase.forEach((i, j) => {
    if (i < 0) newEntry(keysB[j])[1] = j;
  });
  const ofA = new Int32Array(ours.materials.length);
  const ofB = new Int32Array(theirs.materials.length);
  a.toBase.forEach((i, j) => {
    if (i >= 0) {
      ofA[j] = i;
      list[i].index[1] = j;
    }
  });
  b.toBase.forEach((i, j) => {
    if (i >= 0) {
      ofB[j] = i;
      list[i].index[2] = j;
    }
  });
  for (const key of [...newKeys.keys()].sort()) {
    const [ja, jb] = newKeys.get(key)!;
    const id = list.length;
    list.push({ key, index: [-1, ja, jb] });
    if (ja >= 0) ofA[ja] = id;
    if (jb >= 0) ofB[jb] = id;
  }
  return { list, of: [Int32Array.from({ length: nB }, (_, i) => i), ofA, ofB], renamed: [a.renamed, b.renamed] };
}

/** The definition of an identity in one version (null when the version does not use it). */
export function definitionIn(id: IMaterialIdentity, v: Version, meshes: readonly [IMesh, IMesh, IMesh]): IMaterialDefinition | null {
  const i = id.index[v];
  if (i < 0) return null;
  return meshes[v].appearance?.materials[i] ?? defaultMaterialDefinition();
}

/** Three-way merge of one material's definition, property by property. */
export function mergeDefinition(identity: number, id: IMaterialIdentity, meshes: readonly [IMesh, IMesh, IMesh]): IMaterialMerge {
  const O = definitionIn(id, 0, meshes) ?? defaultMaterialDefinition();
  const A = definitionIn(id, 1, meshes);
  const B = definitionIn(id, 2, meshes);
  const images = (v: Version): readonly ITextureImage[] => meshes[v].appearance?.images ?? [];
  const names = new Set<string>(definitionProperties(O));
  if (A) for (const p of definitionProperties(A)) names.add(p);
  if (B) for (const p of definitionProperties(B)) names.add(p);
  const out: IMaterialMerge = { identity, properties: [], conflicts: [] };
  for (const name of names) {
    const kO = appearanceValueKey(definitionValue(O, name), images(0));
    const kA = A ? appearanceValueKey(definitionValue(A, name), images(1)) : null;
    const kB = B ? appearanceValueKey(definitionValue(B, name), images(2)) : null;
    let source: PropertySource;
    if (kA === null && kB === null) source = 'base';
    else if (kA === null) source = kB === kO ? 'base' : 'theirs';
    else if (kB === null) source = kA === kO ? 'base' : 'ours';
    else if (kA === kB) source = kA === kO ? 'base' : 'both';
    else if (kA === kO) source = 'theirs';
    else if (kB === kO) source = 'ours';
    else source = 'conflict';
    out.properties.push({ name, source });
    if (source === 'conflict') out.conflicts.push(name);
  }
  return out;
}
