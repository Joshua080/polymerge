/**
 * Appearance merge — scenarios for every rule in docs/appearance-merge-design.md: property-level
 * material merge, identity (renames, add/add), per-face assignment, UV islands taken whole,
 * texture-space overlaps, the geometry coupling, resolution and the unresolved (base) state,
 * symmetry and identities.
 */
import { describe, expect, it } from 'vitest';
import { appearanceValueKey } from '../../src/appearance.js';
import { mergeMeshes, resolveMerge } from '../../src/merge/index.js';
import { loadMesh } from '../../src/parsers/index.js';
import type { IMaterialDefinition, IMergeResult, IMesh } from '../../src/types.js';
import { captureLogger, cylinder, grid, silent, withMoves } from '../diff/util.js';
import { buildGltf, glbBytes } from '../parsers/helpers.js';
import { writeGlb } from '../../src/writers/index.js';
import {
  appendFaces,
  arraysOf,
  def,
  dropFaces,
  faceUv,
  fromArrays,
  image,
  quadFace,
  reverseMaterials,
  sortedFaces,
  tex,
  textured,
  withLook,
  type ILookSpec,
} from './appearance-util.js';

const opts = { logger: silent };

/** 5 × 5 vertices = 4 × 4 quads = 32 faces, one island, one material "Paint". */
const PAINT = def('Paint', { baseColorFactor: [0.8, 0.8, 0.8, 1], roughnessFactor: 0.5 });
const plain: ILookSpec = { nx: 5, ny: 5, materials: [PAINT] };

/** Merged definition of the material called `name` (throws when absent). */
function material(r: IMergeResult, name: string): IMaterialDefinition {
  const i = r.merged.materials.findIndex((m) => m.name === name);
  expect(i, `material "${name}" in the merge`).toBeGreaterThanOrEqual(0);
  return r.merged.appearance!.materials[i];
}

/** Material name of every merged face that came from base face f (undefined when absent). */
function materialOfBaseFace(r: IMergeResult, f: number): string | undefined {
  const p = r.provenance;
  for (let j = 0; j < r.merged.faceCount; j++) {
    if (p.faceSource[j] === 0 && p.faceIndex[j] === f) {
      const m = r.merged.faceMaterials?.[j] ?? -1;
      return m >= 0 ? r.merged.materials[m].name : '(none)';
    }
  }
  return undefined;
}

/** Merged UVs (6 values) of base face f, or undefined when the face is not in the merge. */
function uvOfBaseFace(r: IMergeResult, f: number, k = 0): number[] | undefined {
  const p = r.provenance;
  for (let j = 0; j < r.merged.faceCount; j++) {
    if (p.faceSource[j] === 0 && p.faceIndex[j] === f) return faceUv(r.merged, j, k);
  }
  return undefined;
}

const close = (a: ArrayLike<number> | undefined, b: ArrayLike<number>): boolean =>
  !!a && a.length === b.length && Array.from(a).every((x, i) => Math.abs(x - b[i]) < 1e-6);

/**
 * Structural invariants of a merge with appearance, and: the merged mesh can be written as GLB and
 * read back with every face intact (its corners, material definition and corner UVs).
 */
async function checkAppearance(r: IMergeResult): Promise<void> {
  checkStructure(r);
  const back = await loadMesh(writeGlb(r.merged), { fileName: 'merged.glb' });
  expect(sortedFaces(back)).toEqual(sortedFaces(r.merged));
}

function checkStructure(r: IMergeResult): void {
  const m = r.merged;
  const look = m.appearance!;
  expect(look).toBeDefined();
  expect(look.materials.length).toBe(m.materials.length);
  for (const uv of look.uvs) expect(uv.length).toBe(m.faceCount * 6);
  if (m.faceMaterials) {
    expect(m.faceMaterials.length).toBe(m.faceCount);
    for (const x of m.faceMaterials) expect(x).toBeLessThan(m.materials.length);
    // Every material is used.
    const used = new Set(m.faceMaterials);
    m.materials.forEach((_, i) => expect(used.has(i), `material ${i} used`).toBe(true));
  }
  for (const d of look.materials) {
    for (const slot of ['baseColorTexture', 'normalTexture', 'emissiveTexture'] as const) {
      if (d[slot]) expect(d[slot]!.image).toBeLessThan(look.images.length);
    }
  }
  expect(r.appearance!.faceChangedBy.length).toBe(m.faceCount);
  expect(r.appearance!.faceConflict.length).toBe(m.faceCount);
  expect(r.clean).toBe(r.conflicts.every((c) => c.resolution !== null));
  r.conflicts.forEach((c, i) => expect(c.id).toBe(i));
}

const kinds = (r: IMergeResult): string[] => r.conflicts.flatMap((c) => Object.keys(c.kinds)).sort();

describe('appearance merge · material definitions (property by property)', () => {
  const base = textured(plain);

  it('different properties of one material merge: ours recolours, theirs changes roughness', async () => {
    const ours = textured({ ...plain, materials: [{ ...PAINT, baseColorFactor: [1, 0, 0, 1] }] });
    const theirs = textured({ ...plain, materials: [{ ...PAINT, roughnessFactor: 0.9 }] });
    const r = mergeMeshes(base, ours, theirs, opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    expect(r.merged.materials).toHaveLength(1);
    const m = material(r, 'Paint');
    expect(m.baseColorFactor).toEqual([1, 0, 0, 1]);
    expect(m.roughnessFactor).toBe(0.9);
    expect(r.merged.materials[0]).toEqual({ name: 'Paint', color: [1, 0, 0, 1], metalness: 1, roughness: 0.9 });
    expect(r.appearance!.stats).toMatchObject({ propertiesFromOurs: 1, propertiesFromTheirs: 1, conflicts: 0 });
  });

  it('the same property changed differently → material-property conflict; base value until resolved, other properties still merge', async () => {
    const ours = textured({ ...plain, materials: [{ ...PAINT, baseColorFactor: [1, 0, 0, 1] }] });
    const theirs = textured({ ...plain, materials: [{ ...PAINT, baseColorFactor: [0, 0, 1, 1], metallicFactor: 0 }] });
    const r = mergeMeshes(base, ours, theirs, opts);
    await checkAppearance(r);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0];
    expect(c.kinds).toEqual({ 'material-property': 1 });
    expect(c.appearance).toMatchObject({ material: 'Paint', properties: ['baseColorFactor'] });
    expect(c.baseFaces.length).toBe(base.faceCount); // every face uses the material
    expect(c.message).toMatch(/material "Paint".*baseColorFactor \(ours \[1, 0, 0, 1\], theirs \[0, 0, 1, 1\]\)/);
    // Unresolved: the base colour, with theirs' metallic change applied.
    expect(material(r, 'Paint').baseColorFactor).toEqual([0.8, 0.8, 0.8, 1]);
    expect(material(r, 'Paint').metallicFactor).toBe(0);
    expect(material(resolveMerge(r, { 0: 'ours' }), 'Paint').baseColorFactor).toEqual([1, 0, 0, 1]);
    const t = resolveMerge(r, { 0: 'theirs' });
    expect(t.clean).toBe(true);
    expect(material(t, 'Paint').baseColorFactor).toEqual([0, 0, 1, 1]);
    expect(material(t, 'Paint').metallicFactor).toBe(0);
    expect(material(resolveMerge(r, { 0: 'base' }), 'Paint').baseColorFactor).toEqual([0.8, 0.8, 0.8, 1]);
  });

  it('a rename on one side and an edit on the other: the renamed material, edited (one material, not two)', async () => {
    const ours = textured({ ...plain, materials: [{ ...PAINT, name: 'Lacquer' }] });
    const theirs = textured({ ...plain, materials: [{ ...PAINT, metallicFactor: 0.25 }] });
    const log = captureLogger();
    const r = mergeMeshes(base, ours, theirs, { logger: log.logger });
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    expect(r.merged.materials.map((m) => m.name)).toEqual(['Lacquer']);
    expect(material(r, 'Lacquer').metallicFactor).toBe(0.25);
    expect(log.info.join('\n')).toMatch(/material renames recognised: 1 on ours, 0 on theirs/);
  });

  it('a rename on one side and a different rename on the other → conflict on the name', async () => {
    const ours = textured({ ...plain, materials: [{ ...PAINT, name: 'Lacquer' }] });
    const theirs = textured({ ...plain, materials: [{ ...PAINT, name: 'Enamel' }] });
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(r.conflicts.map((c) => c.appearance?.properties)).toEqual([['name']]);
    expect(r.merged.materials[0].name).toBe('Paint'); // base name until resolved
    expect(resolveMerge(r, { 0: 'theirs' }).merged.materials[0].name).toBe('Enamel');
  });

  it('reordering materials in the file changes nothing (identity is the name, not the index)', async () => {
    const two: ILookSpec = { ...plain, materials: [PAINT, def('Rubber')], material: (i) => (i < 2 ? 0 : 1) };
    const b = textured(two);
    const reordered = reverseMaterials(b);
    expect(reordered.materials.map((m) => m.name)).toEqual(['Rubber', 'Paint']);
    const theirs = textured({ ...two, materials: [PAINT, def('Rubber', { roughnessFactor: 0.2 })] });
    const r = mergeMeshes(b, reordered, theirs, opts);
    expect(r.clean).toBe(true);
    expect(r.appearance!.stats).toMatchObject({ facesReassignedFromOurs: 0, propertiesFromOurs: 0, propertiesFromTheirs: 1 });
    expect(material(r, 'Rubber').roughnessFactor).toBe(0.2);
    expect(materialOfBaseFace(r, quadFace(plain, 3, 3))).toBe('Rubber');
  });

  it('add/add: the same new material on both sides is one material; different definitions conflict against the glTF defaults', async () => {
    const sticker = (color: [number, number, number, number]): ILookSpec => ({
      ...plain,
      materials: [PAINT, def('Sticker', { baseColorFactor: color })],
      material: (i, j) => (i === 1 && j === 1 ? 1 : 0),
    });
    const same = mergeMeshes(base, textured(sticker([1, 1, 0, 1])), textured(sticker([1, 1, 0, 1])), opts);
    await checkAppearance(same);
    expect(same.clean).toBe(true);
    expect(same.merged.materials.map((m) => m.name)).toEqual(['Paint', 'Sticker']);
    expect(same.appearance!.stats.facesReassignedConvergent).toBe(2);

    const diff = mergeMeshes(base, textured(sticker([1, 1, 0, 1])), textured(sticker([0, 1, 1, 1])), opts);
    expect(diff.conflicts.map((c) => [c.appearance?.material, c.appearance?.properties])).toEqual([['Sticker', ['baseColorFactor']]]);
    expect(material(diff, 'Sticker').baseColorFactor).toEqual([1, 1, 1, 1]); // glTF default = "neither side"
    expect(material(resolveMerge(diff, { 0: 'theirs' }), 'Sticker').baseColorFactor).toEqual([0, 1, 1, 1]);
  });

  it('a texture swapped on both sides: the same image (by content) converges; different images conflict', async () => {
    const A = image('albedo-v1');
    const B = image('albedo-v2');
    const withTex = (images: ReturnType<typeof image>[], slotImage: number): ILookSpec => ({
      ...plain,
      images,
      materials: [{ ...PAINT, baseColorTexture: tex(slotImage) }],
    });
    const b = textured(withTex([A], 0));
    // Theirs stores the same new bytes at another index, under another name: still the same image.
    const renamedB = { ...B, name: 'renamed.png' };
    const same = mergeMeshes(b, textured(withTex([A, B], 1)), textured(withTex([renamedB], 0)), opts);
    await checkAppearance(same);
    expect(same.clean).toBe(true);
    expect(same.appearance!.stats.propertiesConvergent).toBe(1);
    const look = same.merged.appearance!;
    expect(look.images.map((i) => i.hash)).toEqual([B.hash]);

    const C = image('albedo-v3');
    const diff = mergeMeshes(b, textured(withTex([B], 0)), textured(withTex([C], 0)), opts);
    expect(diff.conflicts.map((c) => c.appearance?.properties)).toEqual([['baseColorTexture']]);
    expect(diff.merged.appearance!.images.map((i) => i.hash)).toEqual([A.hash]); // base texture until resolved
    expect(resolveMerge(diff, { 0: 'theirs' }).merged.appearance!.images.map((i) => i.hash)).toEqual([C.hash]);
  });

  it('a texture slot is one property: ours changes its UV set, theirs its transform → conflict, not a mix', async () => {
    const A = image('albedo');
    const spec = (slot: ReturnType<typeof tex>): ILookSpec => ({ ...plain, images: [A], materials: [{ ...PAINT, baseColorTexture: slot }] });
    const r = mergeMeshes(textured(spec(tex(0))), textured(spec(tex(0, 1))), textured(spec(tex(0, 0, { transform: { scale: [2, 2] } }))), opts);
    expect(r.conflicts.map((c) => c.appearance?.properties)).toEqual([['baseColorTexture']]);
    const ours = resolveMerge(r, { 0: 'ours' });
    expect(material(ours, 'Paint').baseColorTexture).toEqual({ image: 0, texCoord: 1 });
  });

  it('extensions merge as whole properties next to core ones', async () => {
    const ours = textured({ ...plain, materials: [{ ...PAINT, extensions: { KHR_materials_emissive_strength: { emissiveStrength: 4 } } }] });
    const theirs = textured({ ...plain, materials: [{ ...PAINT, emissiveFactor: [1, 0.5, 0] }] });
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(r.clean).toBe(true);
    const m = material(r, 'Paint');
    expect(m.extensions).toEqual({ KHR_materials_emissive_strength: { emissiveStrength: 4 } });
    expect(m.emissiveFactor).toEqual([1, 0.5, 0]);
  });

  it('factors compare at float32 precision: a float32-widened re-export is not a change', async () => {
    expect(appearanceValueKey(0.8, [])).toBe(appearanceValueKey(0.800000011920929, []));
    const reexported = textured({ ...plain, materials: [{ ...PAINT, baseColorFactor: [0.800000011920929, 0.800000011920929, 0.800000011920929, 1] }] });
    const theirs = textured({ ...plain, materials: [{ ...PAINT, baseColorFactor: [0, 1, 0, 1] }] });
    const r = mergeMeshes(base, reexported, theirs, opts);
    expect(r.clean).toBe(true);
    expect(material(r, 'Paint').baseColorFactor).toEqual([0, 1, 0, 1]);
  });
});

describe('appearance merge · material assignment (face by face)', () => {
  const palette = [PAINT, def('Red', { baseColorFactor: [1, 0, 0, 1] }), def('Blue', { baseColorFactor: [0, 0, 1, 1] }), def('Chrome', { metallicFactor: 1, roughnessFactor: 0.05 })];
  const spec = (paint: (i: number, j: number) => number): ILookSpec => ({ ...plain, materials: palette, material: (i, j) => paint(i, j) });
  const base = textured(spec(() => 0));

  it('neighbouring re-assignments compose: ours paints row 0 red, theirs row 1 blue', async () => {
    const r = mergeMeshes(base, textured(spec((_, j) => (j === 0 ? 1 : 0))), textured(spec((_, j) => (j === 1 ? 2 : 0))), opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    expect(materialOfBaseFace(r, quadFace(plain, 2, 0))).toBe('Red');
    expect(materialOfBaseFace(r, quadFace(plain, 2, 1, 1))).toBe('Blue');
    expect(materialOfBaseFace(r, quadFace(plain, 2, 2))).toBe('Paint');
    expect(r.appearance!.stats).toMatchObject({ facesReassignedFromOurs: 8, facesReassignedFromTheirs: 8 });
  });

  it('a repaint over a smaller repaint conflicts only where both painted: the red door with a chrome handle', async () => {
    const door = (i: number): boolean => i < 3; // the wall (i = 3) stays "Paint" on both sides
    const handle = (i: number, j: number): boolean => i === 2 && j === 2;
    const r = mergeMeshes(base, textured(spec((i) => (door(i) ? 1 : 0))), textured(spec((i, j) => (handle(i, j) ? 3 : 0))), opts);
    await checkAppearance(r);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0];
    expect(c.kinds).toEqual({ 'material-assignment': 2 });
    expect(Array.from(c.baseFaces)).toEqual([quadFace(plain, 2, 2, 0), quadFace(plain, 2, 2, 1)]);
    expect(c.message).toMatch(/2 face\(s\) given different materials by ours \("Red"\) and theirs \("Chrome"\)/);
    // Unresolved: the handle keeps the base material; the rest of the door is ours' red.
    expect(materialOfBaseFace(r, quadFace(plain, 2, 2))).toBe('Paint');
    expect(materialOfBaseFace(r, quadFace(plain, 0, 0))).toBe('Red');
    expect(materialOfBaseFace(r, quadFace(plain, 3, 0))).toBe('Paint');
    const t = resolveMerge(r, { 0: 'theirs' });
    expect(materialOfBaseFace(t, quadFace(plain, 2, 2))).toBe('Chrome');
    expect(materialOfBaseFace(t, quadFace(plain, 0, 0))).toBe('Red');
    expect(materialOfBaseFace(resolveMerge(r, { 0: 'ours' }), quadFace(plain, 2, 2))).toBe('Red');
    // The appearance conflict is recorded per merged face.
    const j = r.provenance.faceIndex.findIndex((f, k) => r.provenance.faceSource[k] === 0 && f === quadFace(plain, 2, 2));
    expect(r.appearance!.faceConflict[j]).toBe(0);
  });

  it('a new material that takes over ALL of a vanished material\'s faces reads as a rename (design §3): no conflict', async () => {
    // Ours repaints everything "Red" (so "Paint" is gone); theirs paints the handle chrome. In the
    // file this is indistinguishable from renaming Paint to Red and recolouring it.
    const r = mergeMeshes(base, textured(spec(() => 1)), textured(spec((i, j) => (i === 2 && j === 2 ? 3 : 0))), opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    expect(materialOfBaseFace(r, quadFace(plain, 0, 0))).toBe('Red');
    expect(materialOfBaseFace(r, quadFace(plain, 2, 2))).toBe('Chrome');
    expect(material(r, 'Red').baseColorFactor).toEqual([1, 0, 0, 1]);
  });

  it('separate conflicting patches are separate conflicts, ordered by their first face', async () => {
    const r = mergeMeshes(base, textured(spec((i, j) => (j === 0 || j === 3 ? 1 : 0))), textured(spec((i, j) => ((j === 0 || j === 3) && i === 1 ? 2 : 0))), opts);
    expect(r.conflicts.map((c) => Array.from(c.baseFaces))).toEqual([
      [quadFace(plain, 1, 0, 0), quadFace(plain, 1, 0, 1)],
      [quadFace(plain, 1, 3, 0), quadFace(plain, 1, 3, 1)],
    ]);
    const one = resolveMerge(r, { 1: 'theirs' });
    expect(one.clean).toBe(false);
    expect(materialOfBaseFace(one, quadFace(plain, 1, 3))).toBe('Blue');
    expect(materialOfBaseFace(one, quadFace(plain, 1, 0))).toBe('Paint');
  });

  it('the same repaint on both sides is applied once', async () => {
    const red = textured(spec((i) => (i === 0 ? 1 : 0)));
    const r = mergeMeshes(base, red, red, opts);
    expect(r.clean).toBe(true);
    expect(r.appearance!.stats.facesReassignedConvergent).toBe(8);
    expect(materialOfBaseFace(r, quadFace(plain, 0, 3))).toBe('Red');
  });
});

// ---- UV scenarios: a 5 × 5 grid in four 2 × 2-quad islands, each in its own cell of texture space ----

const ALBEDO = image('albedo');
const TEXTURED = def('Paint', { baseColorTexture: tex(0) });
/** Island of quad (i, j): 0 = bottom-left, 1 = bottom-right, 2 = top-left, 3 = top-right. */
const quadrant = (i: number, j: number): number => (i < 2 ? 0 : 1) + (j < 2 ? 0 : 2);
/** Texture-space cell [cu, cu + 0.2] × [cv, cv + 0.2] of each island in the base. */
const CELLS: Array<[number, number]> = [
  [0, 0],
  [0.3, 0],
  [0, 0.3],
  [0.3, 0.3],
];
/** Placement putting island k's 2 × 2 quads into cell (cu, cv). */
const cellPlace = (k: number, cu: number, cv: number): [number, number, number] => [cu - (k % 2 ? 2 : 0) * 0.1, cv - (k >= 2 ? 2 : 0) * 0.1, 0.1];
function islands(cells: Partial<Record<number, [number, number]>> = {}, over: Partial<ILookSpec> = {}): ILookSpec {
  return {
    nx: 5,
    ny: 5,
    island: quadrant,
    place: (k) => {
      const [cu, cv] = cells[k] ?? CELLS[k];
      return cellPlace(k, cu, cv);
    },
    materials: [TEXTURED],
    images: [ALBEDO],
    ...over,
  };
}
/** Base faces of island k. */
function islandFaces(k: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (quadrant(i, j) === k) out.push(quadFace(plain, i, j, 0), quadFace(plain, i, j, 1));
  return out.sort((a, b) => a - b);
}
/** Every base face of `faces` has exactly the UVs `version` gives it. */
function uvsAre(r: IMergeResult, version: IMesh, faces: number[]): boolean {
  return faces.every((f) => close(uvOfBaseFace(r, f), faceUv(version, f)));
}

describe('appearance merge · UVs (whole islands only)', () => {
  const base = textured(islands());

  it('different islands moved by different sides merge (each island whole, from its side)', async () => {
    const ours = textured(islands({ 0: [0.6, 0] }));
    const theirs = textured(islands({ 3: [0.6, 0.6] }));
    const r = mergeMeshes(base, ours, theirs, opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    expect(uvsAre(r, ours, islandFaces(0))).toBe(true);
    expect(uvsAre(r, theirs, islandFaces(3))).toBe(true);
    expect(uvsAre(r, base, [...islandFaces(1), ...islandFaces(2)])).toBe(true);
    expect(r.appearance!.stats).toMatchObject({ uvFacesFromOurs: 8, uvFacesFromTheirs: 8 });
  });

  it('no half-islands, ever: edits to DIFFERENT corners of one island conflict as the whole island', async () => {
    const one: ILookSpec = { ...plain, materials: [TEXTURED], images: [ALBEDO] };
    const b = textured(one);
    /** Nudge the UVs of every corner at vertex v (a UV-vertex tweak inside the island). */
    const nudge = (v: number, du: number): IMesh => {
      const a = arraysOf(b);
      for (let c = 0; c < a.faces.length; c++) if (a.faces[c] === v) a.uvs[0][c * 2] += du;
      return fromArrays(a);
    };
    const ours = nudge(6, 0.02); // vertex (1, 1)
    const theirs = nudge(18, -0.02); // vertex (3, 3): no face touches both
    // A per-corner merge would find nothing changed twice:
    for (let c = 0; c < b.faces.length; c++) {
      const changedA = ours.appearance!.uvs[0][c * 2] !== b.appearance!.uvs[0][c * 2];
      const changedB = theirs.appearance!.uvs[0][c * 2] !== b.appearance!.uvs[0][c * 2];
      expect(changedA && changedB).toBe(false);
    }
    const r = mergeMeshes(b, ours, theirs, opts);
    await checkAppearance(r);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].kinds).toEqual({ 'uv-layout': 32 });
    expect(r.conflicts[0].appearance).toMatchObject({ uvSet: 0, faces: 32 });
    const all = Array.from({ length: 32 }, (_, f) => f);
    // Every resolution gives the island exactly one version's UVs, never a mix.
    expect(uvsAre(r, b, all)).toBe(true);
    expect(uvsAre(resolveMerge(r, { 0: 'ours' }), ours, all)).toBe(true);
    expect(uvsAre(resolveMerge(r, { 0: 'theirs' }), theirs, all)).toBe(true);
    expect(uvsAre(resolveMerge(r, { 0: 'base' }), b, all)).toBe(true);
  });

  it("theirs' layout edit contained in ours' is taken whole from ours; the torn combination is a conflict", async () => {
    // Both move island 0 to (0.6, 0); ours also stitches island 1 onto it (same placement: glued).
    const stitched = textured({ ...islands({ 0: [0.6, 0] }), place: (k) => (k <= 1 ? cellPlace(0, 0.6, 0) : cellPlace(k, ...CELLS[k])) });
    const moved = textured(islands({ 0: [0.6, 0] }));
    const r = mergeMeshes(base, stitched, moved, opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    expect(uvsAre(r, stitched, [...islandFaces(0), ...islandFaces(1)])).toBe(true);
    // Ours moves island 0; theirs stitches island 1 onto island 0's OLD place. Per-face merging would
    // move island 0 away from what island 1 is glued to; the two islands conflict as one unit.
    const oldStitch = textured({ ...islands(), place: (k) => (k <= 1 ? cellPlace(0, 0, 0) : cellPlace(k, ...CELLS[k])) });
    const torn = mergeMeshes(base, moved, oldStitch, opts);
    expect(torn.conflicts).toHaveLength(1);
    expect(Object.keys(torn.conflicts[0].kinds)).toEqual(['uv-layout']);
    expect(Array.from(torn.conflicts[0].baseFaces)).toEqual([...islandFaces(0), ...islandFaces(1)].sort((a, b) => a - b));
    expect(uvsAre(resolveMerge(torn, { 0: 'theirs' }), oldStitch, [...islandFaces(0), ...islandFaces(1)])).toBe(true);
  });

  it('the same island move on both sides is applied once', async () => {
    const moved = textured(islands({ 2: [0.6, 0.6] }));
    const r = mergeMeshes(base, moved, moved, opts);
    expect(r.clean).toBe(true);
    expect(r.appearance!.stats.uvFacesConvergent).toBe(8);
    expect(uvsAre(r, moved, islandFaces(2))).toBe(true);
  });

  it('uv-overlap: two different islands moved into the same empty texture space conflict (one unit, both islands)', async () => {
    const ours = textured(islands({ 0: [0.6, 0.6] }));
    const theirs = textured(islands({ 3: [0.65, 0.65] }));
    const r = mergeMeshes(base, ours, theirs, opts);
    await checkAppearance(r);
    expect(kinds(r)).toEqual(['uv-overlap']);
    const c = r.conflicts[0];
    expect(Array.from(c.baseFaces)).toEqual([...islandFaces(0), ...islandFaces(3)].sort((a, b) => a - b));
    expect(c.message).toMatch(/overlap in texture space on a shared image \(UV set 0, \d+ face pair/);
    // Unresolved: both islands where the base had them; 'ours' = ours' whole layout there.
    expect(uvsAre(r, base, [...islandFaces(0), ...islandFaces(3)])).toBe(true);
    const o = resolveMerge(r, { 0: 'ours' });
    expect(uvsAre(o, ours, [...islandFaces(0), ...islandFaces(3)])).toBe(true);
    expect(o.warnings).toEqual([]);
  });

  it('uv-overlap needs a shared image, a new overlap and positive area (negative controls)', async () => {
    // Moved next to each other, not onto each other.
    expect(mergeMeshes(base, textured(islands({ 0: [0.6, 0.6] })), textured(islands({ 3: [0.8, 0.6] })), opts).clean).toBe(true);
    // Different images: island 3 uses its own material and texture.
    const own = (cells: Partial<Record<number, [number, number]>>): ILookSpec =>
      islands(cells, {
        materials: [TEXTURED, def('Other', { baseColorTexture: tex(1) })],
        images: [ALBEDO, image('other')],
        material: (i, j) => (quadrant(i, j) === 3 ? 1 : 0),
      });
    expect(mergeMeshes(textured(own({})), textured(own({ 0: [0.6, 0.6] })), textured(own({ 3: [0.65, 0.65] })), opts).clean).toBe(true);
    // No texture at all: the UVs sample nothing, so an overlap is harmless.
    const bare = (cells: Partial<Record<number, [number, number]>>): ILookSpec => islands(cells, { materials: [PAINT], images: [] });
    expect(mergeMeshes(textured(bare({})), textured(bare({ 0: [0.6, 0.6] })), textured(bare({ 3: [0.65, 0.65] })), opts).clean).toBe(true);
    // Already stacked in the base (islands 0 and 3 share a cell): moving both onto one new cell is not new.
    const stacked = textured(islands({ 3: [0, 0] }));
    expect(mergeMeshes(stacked, textured(islands({ 0: [0.6, 0.6], 3: [0, 0] })), textured(islands({ 3: [0.6, 0.6] })), opts).clean).toBe(true);
  });

  it('a UV edit on one side and a geometry edit on the same faces on the other compose', async () => {
    const ours = textured(islands({}, { moves: { 6: [0, 0, 0.5], 7: [0, 0, 0.25] } }));
    const theirs = textured(islands({ 0: [0.6, 0] }));
    const r = mergeMeshes(base, ours, theirs, opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    expect(uvsAre(r, theirs, islandFaces(0))).toBe(true);
    const j = r.provenance.vertexIndex.findIndex((v, i) => r.provenance.vertexSource[i] === 0 && v === 6);
    expect(r.merged.positions[j * 3 + 2]).toBeCloseTo(0.5, 9);
  });

  it('a new image on one side and moved UVs on the other merge unjudged (texel content is never judged)', async () => {
    const ours = textured(islands({}, { images: [image('albedo-v2')] }));
    const theirs = textured(islands({ 1: [0.6, 0.6] }));
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(r.clean).toBe(true);
    expect(r.merged.appearance!.images[0].hash).toBe(image('albedo-v2').hash);
    expect(uvsAre(r, theirs, islandFaces(1))).toBe(true);
  });
});

describe('appearance merge · with geometry edits', () => {
  const palette = [TEXTURED, def('Red', { baseColorFactor: [1, 0, 0, 1], baseColorTexture: tex(0) }), def('Decal', { baseColorTexture: tex(0) })];
  const spec = (over: Partial<ILookSpec> = {}): ILookSpec => islands({}, { materials: palette, ...over });
  const base = textured(spec());
  /** Quad (1, 1) of the grid: vertices a = 6, b = 7, c = 11, d = 12; faces (a, b, d) and (a, d, c). */
  const QUAD = [quadFace(plain, 1, 1, 0), quadFace(plain, 1, 1, 1)];

  it('geometry on one side, appearance on the other, same faces: both apply', async () => {
    const ours = textured(spec({ moves: { 12: [0, 0, 1] } }));
    const theirs = textured(spec({ material: (i, j) => (i === 1 && j === 1 ? 1 : 0) }));
    const r = mergeMeshes(base, ours, theirs, opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    expect(materialOfBaseFace(r, QUAD[0])).toBe('Red');
    const j = r.provenance.vertexIndex.findIndex((v, i) => r.provenance.vertexSource[i] === 0 && v === 12);
    expect(r.merged.positions[j * 3 + 2]).toBeCloseTo(1, 9);
  });

  it("deletion beats an appearance edit: ours cuts a hole where theirs repainted or re-UV'd; the rest of theirs' edit applies", async () => {
    const ours = dropFaces(base, QUAD);
    const repainted = textured(spec({ material: (_, j) => (j === 1 ? 1 : 0) }));
    const relaid = textured({ ...spec({ material: (_, j) => (j === 1 ? 1 : 0) }), place: (k) => (k === 0 ? cellPlace(0, 0.6, 0.6) : cellPlace(k, ...CELLS[k])) });
    for (const t of [repainted, relaid]) {
      const r = mergeMeshes(base, ours, t, opts);
      await checkAppearance(r);
      expect(r.clean).toBe(true);
      expect(r.merged.faceCount).toBe(base.faceCount - 2);
      expect(uvOfBaseFace(r, QUAD[0])).toBeUndefined();
      expect(materialOfBaseFace(r, quadFace(plain, 0, 1))).toBe('Red');
      expect(uvsAre(r, t, islandFaces(0).filter((f) => !QUAD.includes(f)))).toBe(true);
    }
  });

  it('replacement vs repaint: ours retriangulates a quad theirs repainted → appearance-geometry region, decided with the geometry', async () => {
    // Ours flips the diagonal of quad (1, 1): deletes its two faces, adds (a, b, c) and (b, d, c).
    const a = arraysOf(base);
    const uv = (v: number): number[] => {
      for (let c = 0; c < a.faces.length; c++) if (a.faces[c] === v && islandFaces(0).includes(Math.floor(c / 3))) return a.uvs[0].slice(c * 2, c * 2 + 2);
      throw new Error(`no corner at ${v}`);
    };
    const flipped = appendFaces(dropFaces(base, QUAD), [], [6, 7, 11, 7, 12, 11], [0, 0], [[...uv(6), ...uv(7), ...uv(11), ...uv(7), ...uv(12), ...uv(11)]]);
    const theirs = textured(spec({ material: (i, j) => (i === 1 && j === 1 ? 1 : 0) }));
    const r = mergeMeshes(base, flipped, theirs, opts);
    await checkAppearance(r);
    expect(r.conflicts).toHaveLength(1);
    const c = r.conflicts[0];
    expect(Object.keys(c.kinds)).toEqual(['appearance-geometry']);
    expect(c.appearance).toBeUndefined(); // a geometry region
    expect(c.message).toMatch(/ours replaced face\(s\) whose material theirs changed/);
    // Unresolved: the base triangles, base material.
    expect(materialOfBaseFace(r, QUAD[0])).toBe('Paint');
    expect(r.merged.faceCount).toBe(base.faceCount);
    // Theirs: the base triangles, repainted; ours' new triangles are not there.
    const t = resolveMerge(r, { 0: 'theirs' });
    expect(materialOfBaseFace(t, QUAD[0])).toBe('Red');
    expect(t.provenance.faceSource.filter((s) => s === 1)).toHaveLength(0);
    // Ours: the flipped triangles with ours' material; the repaint is gone with the faces it was on.
    const o = resolveMerge(r, { 0: 'ours' });
    expect(materialOfBaseFace(o, QUAD[0])).toBeUndefined();
    const added = [...o.provenance.faceSource].map((s, j) => (s === 1 ? j : -1)).filter((j) => j >= 0);
    expect(added).toHaveLength(2);
    for (const j of added) expect(o.merged.materials[o.merged.faceMaterials![j]].name).toBe('Paint');
  });

  it('new faces glued to an island the other side moves → appearance-geometry: the additions and the layout are decided together', async () => {
    // Ours adds a flap below the bottom edge of island 0 (vertices 0, 1), laid out as part of island 0.
    const [u0, v0, s] = cellPlace(0, ...CELLS[0]);
    const at = (x: number, y: number): number[] => [u0 + x * s, v0 + y * s];
    const flap = appendFaces(base, [0.5, -1, 0], [1, 0, 25], [0], [[...at(1, 0), ...at(0, 0), ...at(0.5, -1)]]);
    const theirs = textured(spec({ place: (k) => (k === 0 ? cellPlace(0, 0.6, 0.6) : cellPlace(k, ...CELLS[k])) }));
    const r = mergeMeshes(base, flap, theirs, opts);
    await checkAppearance(r);
    expect(r.conflicts.flatMap((c) => Object.keys(c.kinds))).toEqual(['appearance-geometry']);
    expect(r.merged.faceCount).toBe(base.faceCount); // unresolved: no flap, island 0 at base
    expect(uvsAre(r, base, islandFaces(0))).toBe(true);
    const o = resolveMerge(r, { 0: 'ours' });
    expect(o.merged.faceCount).toBe(base.faceCount + 1);
    expect(uvsAre(o, base, islandFaces(0))).toBe(true);
    const t = resolveMerge(r, { 0: 'theirs' });
    expect(t.merged.faceCount).toBe(base.faceCount);
    expect(uvsAre(t, theirs, islandFaces(0))).toBe(true);
  });

  it("new faces keep their own side's material and UVs", async () => {
    const flap = appendFaces(base, [0.5, -1, 0], [1, 0, 25], [1], [[0.9, 0.9, 0.95, 0.9, 0.9, 0.95]], [palette[2]]);
    const theirs = textured(spec({ material: (i, j) => (i === 3 && j === 3 ? 1 : 0) }));
    const r = mergeMeshes(base, flap, theirs, opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    const j = [...r.provenance.faceSource].indexOf(1);
    expect(r.merged.materials[r.merged.faceMaterials![j]].name).toBe('Decal');
    expect(close(faceUv(r.merged, j), [0.9, 0.9, 0.95, 0.9, 0.9, 0.95])).toBe(true);
    expect(r.appearance!.faceChangedBy[j]).toBe(1);
    expect(materialOfBaseFace(r, quadFace(plain, 3, 3))).toBe('Red');
  });

  it('the same new face on both sides with different materials → appearance-geometry conflict', async () => {
    /** The same flap on either side; material 0 = Paint (the mesh's own), 1 = Decal (new). */
    const flapWith = (m: number): IMesh => appendFaces(base, [0.5, -1, 0], [1, 0, 25], [m], [[0.9, 0.9, 0.95, 0.9, 0.9, 0.95]], [palette[2]]);
    const same = mergeMeshes(base, flapWith(1), flapWith(1), opts);
    expect(same.clean).toBe(true);
    expect(same.merged.faceCount).toBe(base.faceCount + 1);
    const r = mergeMeshes(base, flapWith(0), flapWith(1), opts);
    expect(r.conflicts.flatMap((c) => Object.keys(c.kinds))).toEqual(['appearance-geometry']);
    expect(r.merged.faceCount).toBe(base.faceCount);
    const t = resolveMerge(r, { 0: 'theirs' });
    const j = [...t.provenance.faceSource].indexOf(1);
    expect(t.merged.materials[t.merged.faceMaterials![j]].name).toBe('Decal');
    const o = resolveMerge(r, { 0: 'ours' });
    expect(o.merged.materials[o.merged.faceMaterials![[...o.provenance.faceSource].indexOf(1)]].name).toBe('Paint');
  });
});

describe('appearance merge · resolution, ids, options', () => {
  const base = textured(islands());

  it('appearance conflicts follow the geometry ones in id order; each is resolved on its own', async () => {
    // Geometry: vertex 24 moved differently (move-move). Appearance: Paint recoloured differently.
    const ours = textured(islands({}, { moves: { 24: [0, 0, 1] }, materials: [{ ...TEXTURED, baseColorFactor: [1, 0, 0, 1] }] }));
    const theirs = textured(islands({}, { moves: { 24: [0, 0, -1] }, materials: [{ ...TEXTURED, baseColorFactor: [0, 1, 0, 1] }] }));
    const r = mergeMeshes(base, ours, theirs, opts);
    await checkAppearance(r);
    expect(r.conflicts.map((c) => Object.keys(c.kinds)[0])).toEqual(['move-move', 'material-property']);
    expect(r.stats.conflicts).toBe(2);
    expect(r.appearance!.stats).toMatchObject({ conflicts: 1, unresolved: 1 });
    const one = resolveMerge(r, { 1: 'theirs' });
    expect(one.clean).toBe(false);
    expect(one.conflicts.map((c) => c.resolution)).toEqual([null, 'theirs']);
    expect(material(one, 'Paint').baseColorFactor).toEqual([0, 1, 0, 1]);
    const both = resolveMerge(one, { 0: 'ours' });
    expect(both.clean).toBe(true);
    expect(material(both, 'Paint').baseColorFactor).toEqual([0, 1, 0, 1]);
    const all = mergeMeshes(base, ours, theirs, { ...opts, defaultResolution: 'ours' });
    expect(all.clean).toBe(true);
    expect(material(all, 'Paint').baseColorFactor).toEqual([1, 0, 0, 1]);
  });

  it('chosen resolutions that make islands overlap in texture space → a uv-overlap warning, not a new conflict', async () => {
    // Island 0: ours → (0.6, 0.6), theirs → (0.6, 0); island 3: ours → (0.6, 0.3), theirs → (0.6, 0.6).
    const ours = textured(islands({ 0: [0.6, 0.6], 3: [0.6, 0.3] }));
    const theirs = textured(islands({ 0: [0.6, 0], 3: [0.6, 0.6] }));
    const r = mergeMeshes(base, ours, theirs, opts);
    expect(kinds(r)).toEqual(['uv-layout', 'uv-layout']);
    expect(r.warnings).toEqual([]);
    const mixed = resolveMerge(r, { 0: 'ours', 1: 'theirs' });
    expect(mixed.clean).toBe(true);
    expect(mixed.warnings.map((w) => w.kind)).toEqual(['uv-overlap']);
    expect(mixed.warnings[0].conflicts).toEqual([0, 1]);
    expect(mixed.warnings[0].mergedFaces.length).toBeGreaterThan(0);
    expect(resolveMerge(r, { 0: 'ours', 1: 'ours' }).warnings).toEqual([]);
  });

  it('STL / OBJ-like meshes (no appearance) merge exactly as before; mixed inputs log why appearance is skipped', async () => {
    const g = grid(5, 5);
    const r = mergeMeshes(g, withMoves(g, { 6: [0, 0, 1] }), g, opts);
    expect(r.appearance).toBeUndefined();
    expect(r.merged.appearance).toBeUndefined();
    expect(r.merged.materials).toEqual([]);
    const log = captureLogger();
    const mixed = mergeMeshes(base, grid(5, 5), base, { logger: log.logger });
    expect(mixed.appearance).toBeUndefined();
    expect(log.info.join('\n')).toMatch(/appearance not merged: ours \(OBJ\) carries no materials or UVs/);
    expect(mergeMeshes(base, base, base, { ...opts, mergeAppearance: false }).appearance).toBeUndefined();
  });
});

describe('appearance merge · properties', () => {
  const palette = [TEXTURED, def('Red', { baseColorFactor: [1, 0, 0, 1], baseColorTexture: tex(0) }), def('Blue', { baseColorTexture: tex(0) })];
  const spec = (cells: Partial<Record<number, [number, number]>>, paint: (i: number, j: number) => number, over: Partial<ILookSpec> = {}): ILookSpec =>
    islands(cells, { materials: palette, material: (i, j) => paint(i, j), ...over });
  const base = textured(spec({}, () => 0));
  const scenarios: Array<[string, IMesh, IMesh]> = [
    ['clean mix', textured(spec({ 0: [0.6, 0] }, (i) => (i === 0 ? 1 : 0))), textured(spec({ 3: [0.6, 0.6] }, (_, j) => (j === 3 ? 2 : 0)))],
    ['assignment conflict', textured(spec({}, (i) => (i < 2 ? 1 : 0))), textured(spec({}, (i, j) => (i === 1 && j === 1 ? 2 : 0)))],
    ['uv conflict + overlap', textured(spec({ 0: [0.6, 0.6], 1: [0.62, 0] }, () => 0)), textured(spec({ 3: [0.65, 0.65], 1: [0.66, 0.3] }, () => 0))],
    [
      'property conflict',
      textured(spec({}, () => 0, { materials: [{ ...TEXTURED, roughnessFactor: 0.1 }, ...palette.slice(1)] })),
      textured(spec({}, () => 0, { materials: [{ ...TEXTURED, roughnessFactor: 0.9 }, ...palette.slice(1)] })),
    ],
  ];
  /** Per base face: material name and UVs; conflicts as (kinds, faces), order-free. */
  const signature = (r: IMergeResult): { faces: unknown[]; conflicts: string[] } => ({
    faces: Array.from({ length: base.faceCount }, (_, f) => [materialOfBaseFace(r, f), uvOfBaseFace(r, f)?.map((x) => Math.round(x * 1e6))]),
    conflicts: r.conflicts.map((c) => JSON.stringify([c.kinds, Array.from(c.baseFaces)])).sort(),
  });

  it.each(scenarios)('is symmetric: swapping ours and theirs gives the same conflicts and the same result (%s)', async (_, ours, theirs) => {
    const r = mergeMeshes(base, ours, theirs, opts);
    const s = mergeMeshes(base, theirs, ours, opts);
    await checkAppearance(r);
    await checkAppearance(s);
    expect(signature(s)).toEqual(signature(r));
    // Resolving everything 'ours' in one equals resolving everything 'theirs' in the other.
    const allOurs = resolveMerge(r, Object.fromEntries(r.conflicts.map((c) => [c.id, 'ours' as const])));
    const allTheirs = resolveMerge(s, Object.fromEntries(s.conflicts.map((c) => [c.id, 'theirs' as const])));
    expect(signature(allTheirs).faces).toEqual(signature(allOurs).faces);
  });

  it.each(scenarios)("merging with the base or with itself returns that version's appearance (%s)", async (_, ours) => {
    const same = async (r: IMergeResult, m: IMesh): Promise<void> => {
      await checkAppearance(r);
      expect(r.clean).toBe(true);
      expect(Array.from(r.merged.faceMaterials ?? [])).toEqual(Array.from(m.faceMaterials ?? []));
      expect(r.merged.materials).toEqual(m.materials);
      expect(r.merged.appearance!.materials).toEqual(m.appearance!.materials);
      expect(r.merged.appearance!.images.map((i) => i.hash)).toEqual(m.appearance!.images.map((i) => i.hash));
      expect(Array.from(r.merged.appearance!.uvs[0])).toEqual(Array.from(m.appearance!.uvs[0]));
    };
    await same(mergeMeshes(base, base, base, opts), base);
    await same(mergeMeshes(base, ours, base, opts), ours);
    await same(mergeMeshes(base, base, ours, opts), ours);
    await same(mergeMeshes(base, ours, ours, opts), ours);
  });

  it("a lineage conflict (remeshed side) carries the chosen whole version's appearance", async () => {
    const look = (m: IMesh, color: [number, number, number, number]): IMesh =>
      withLook(m, def('Metal', { baseColorFactor: color }), (x, y, z) => [Math.atan2(y, x) / (2 * Math.PI) + 0.5, z / 2]);
    const b = look(cylinder(24, 6), [0.5, 0.5, 0.5, 1]);
    const remeshed = look(cylinder(32, 6, { phase: 0.37 }), [1, 0, 0, 1]);
    const r = mergeMeshes(b, remeshed, b, opts);
    expect(kinds(r)).toEqual(['lineage']);
    expect(r.merged.appearance!.materials[0].baseColorFactor).toEqual([0.5, 0.5, 0.5, 1]);
    const o = resolveMerge(r, { 0: 'ours' });
    expect(o.merged.faceCount).toBe(remeshed.faceCount);
    expect(o.merged.materials).toEqual(remeshed.materials);
    expect(Array.from(o.merged.appearance!.uvs[0])).toEqual(Array.from(remeshed.appearance!.uvs[0]));
  });
});

describe('appearance merge · glTF files end to end (parse → merge)', () => {
  /**
   * A 3 × 3-vertex panel (2 × 2 quads) as a GLB: two UV islands (left and right column of quads,
   * a seam at x = 1, so those positions are stored twice), material "Paint" with an embedded
   * texture (never decoded, so any bytes do), the right island shifted by `rightU` in u.
   */
  function panel(imageText: string, rightU = 0.5): Uint8Array {
    const positions: number[] = [];
    const uv: number[] = [];
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const u0 = i === 0 ? 0 : rightU - 1 * 0.2;
        const corner = (x: number, y: number): void => {
          positions.push(x, y, 0);
          uv.push(u0 + x * 0.2, y * 0.2);
        };
        // Triangles (a, b, d) and (a, d, c) of quad (i, j).
        corner(i, j);
        corner(i + 1, j);
        corner(i + 1, j + 1);
        corner(i, j);
        corner(i + 1, j + 1);
        corner(i, j + 1);
      }
    }
    return glbBytes(
      buildGltf({
        meshes: [{ name: 'Panel', primitives: [{ positions, material: 0, attributes: { TEXCOORD_0: { data: uv, type: 'VEC2', componentType: 5126 } } }] }],
        nodes: [{ name: 'Panel', mesh: 0 }],
        materials: [{ name: 'Paint', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        extra: { textures: [{ source: 0 }], images: [{ uri: `data:image/png;base64,${btoa(imageText)}` }] },
      }),
    );
  }
  const load = (bytes: Uint8Array, name: string): Promise<IMesh> => loadMesh(bytes, { fileName: name });
  /** Faces of the right-hand island (quads with i = 1) in the loaded panel. */
  const rightFaces = [2, 3, 6, 7];

  it('ours swaps the texture, theirs moves an island: both, from real GLB bytes', async () => {
    const base = await load(panel('albedo v1'), 'base.glb');
    const ours = await load(panel('albedo v2'), 'ours.glb');
    const theirs = await load(panel('albedo v1', 0.75), 'theirs.glb');
    expect(base.vertexCount).toBe(9); // the seam is in the UVs, not in the welded vertices
    const r = mergeMeshes(base, ours, theirs, opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    expect(r.merged.appearance!.images.map((i) => i.hash)).toEqual([ours.appearance!.images[0].hash]);
    expect(Array.from(r.merged.appearance!.images[0].data!)).toEqual(Array.from(new TextEncoder().encode('albedo v2')));
    expect(uvsAre(r, theirs, rightFaces)).toBe(true);
    expect(uvsAre(r, base, [0, 1, 4, 5])).toBe(true);
    expect(r.appearance!.stats).toMatchObject({ propertiesFromOurs: 1, uvFacesFromTheirs: 4 });
  });

  it('both sides swap the texture: the same bytes converge, different bytes conflict until resolved', async () => {
    const base = await load(panel('albedo v1'), 'base.glb');
    const v2 = await load(panel('albedo v2'), 'ours.glb');
    const same = mergeMeshes(base, v2, await load(panel('albedo v2'), 'theirs.glb'), opts);
    expect(same.clean).toBe(true);
    const r = mergeMeshes(base, v2, await load(panel('albedo v3'), 'theirs.glb'), opts);
    expect(r.conflicts.map((c) => [Object.keys(c.kinds), c.appearance?.properties])).toEqual([[['material-property'], ['baseColorTexture']]]);
    expect(r.merged.appearance!.images[0].hash).toBe(base.appearance!.images[0].hash);
    const t = resolveMerge(r, { 0: 'theirs' });
    expect(Array.from(t.merged.appearance!.images[0].data!)).toEqual(Array.from(new TextEncoder().encode('albedo v3')));
  });

  /**
   * Two nodes ("Left", "Right"), each a quad of two triangles with its own material and UVs: Left is
   * "Wood" (textured, its UV island at `leftU`), Right is "Steel" (a colour, `steel`).
   */
  function twoParts(leftU: number, steel: number[]): Uint8Array {
    const quad = (x0: number, u0: number) => ({
      positions: [x0, 0, 0, x0 + 1, 0, 0, x0 + 1, 1, 0, x0, 0, 0, x0 + 1, 1, 0, x0, 1, 0],
      attributes: { TEXCOORD_0: { data: [u0, 0, u0 + 0.25, 0, u0 + 0.25, 0.25, u0, 0, u0 + 0.25, 0.25, u0, 0.25], type: 'VEC2' as const, componentType: 5126 } },
    });
    return glbBytes(
      buildGltf({
        meshes: [
          { name: 'LeftMesh', primitives: [{ ...quad(0, leftU), material: 0 }] },
          { name: 'RightMesh', primitives: [{ ...quad(3, 0), material: 1 }] },
        ],
        nodes: [{ name: 'Left', mesh: 0 }, { name: 'Right', mesh: 1, translation: [0, 2, 0] }],
        materials: [
          { name: 'Wood', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
          { name: 'Steel', pbrMetallicRoughness: { baseColorFactor: steel, metallicFactor: 1 } },
        ],
        extra: { images: [{ uri: `data:image/png;base64,${btoa('wood')}` }], textures: [{ source: 0 }] },
      }),
    );
  }

  it('node structure and appearance travel together: faces keep their node, material and UVs through merge, write and read', async () => {
    const base = await load(twoParts(0, [0.5, 0.5, 0.5, 1]), 'base.glb');
    const ours = await load(twoParts(0.5, [0.5, 0.5, 0.5, 1]), 'ours.glb'); // Left's island moved
    const theirs = await load(twoParts(0, [0.9, 0.9, 1, 1]), 'theirs.glb'); // Steel recoloured
    expect(base.scene!.nodes.map((n) => n.name)).toEqual(['Left', 'Right']);
    const r = mergeMeshes(base, ours, theirs, opts);
    await checkAppearance(r);
    expect(r.clean).toBe(true);
    const m = r.merged;
    // Materials and faceMaterials reach the merged mesh, and each node's faces keep their own.
    expect(m.materials.map((x) => x.name)).toEqual(['Wood', 'Steel']);
    expect(Array.from(m.faceMaterials!)).toEqual([0, 0, 1, 1]);
    expect(m.scene!.nodes.map((n) => n.name)).toEqual(['Left', 'Right']);
    expect(Array.from(m.scene!.faceSources, (s) => m.scene!.sources[s].node)).toEqual([0, 0, 1, 1]);
    expect(m.appearance!.materials[1].baseColorFactor.map((x) => Number(x.toFixed(3)))).toEqual([0.9, 0.9, 1, 1]);
    expect(close(faceUv(m, 0), faceUv(ours, 0))).toBe(true); // Left's island: ours
    const back = await load(writeGlb(m), 'merged.glb');
    expect(back.scene!.nodes.map((n) => [n.name, n.translation])).toEqual([['Left', undefined], ['Right', [0, 2, 0]]]);
    expect(back.groups.map((g) => g.name)).toEqual(['Left', 'Right']);
    expect(sortedFaces(back)).toEqual(sortedFaces(m));
  });
});
