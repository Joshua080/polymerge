/**
 * `polymerge merge` and the git merge driver on glTF inputs: appearance conflicts are reported with
 * the geometry ones, resolved with the same --pick ids, counted in the exit code, written to the
 * JSON report, and the merged materials, textures and UVs are in the written GLB.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMesh, mergeMeshes, type IMesh } from 'polymerge-core';
import { png } from '../../core/test/merge/appearance-util.js';
import { buildGltf, glbBytes } from '../../core/test/parsers/helpers.js';
import { validateGltf } from '../../core/test/writers/validate.js';
import { formatMergeReport, runGitMerge, runMerge } from '../src/commands/merge.js';

const FLOAT = 5126;

/**
 * A 3 × 3-vertex quad grid as GLB: one material "Paint" (glTF material properties given), a
 * TEXCOORD_0 layout at `uvOffset`, vertex 4 (the centre) raised by `lift`. With `image` (PNG bytes)
 * the material's base colour texture is that image, embedded as a data: URI.
 */
function gridGlb(paint: Record<string, unknown>, uvOffset = 0, lift = 0, image?: Uint8Array): Uint8Array {
  const positions: number[] = [];
  const uv: number[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      positions.push(i, j, i === 1 && j === 1 ? lift : 0);
      uv.push(uvOffset + i * 0.25, j * 0.25);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const a = j * 3 + i;
      indices.push(a, a + 1, a + 4, a, a + 4, a + 3);
    }
  }
  return glbBytes(
    buildGltf({
      meshes: [{ name: 'Panel', primitives: [{ positions, indices, material: 0, attributes: { TEXCOORD_0: { data: uv, type: 'VEC2', componentType: FLOAT } } }] }],
      nodes: [{ name: 'Panel', mesh: 0 }],
      materials: [image ? { name: 'Paint', ...paint, pbrMetallicRoughness: { ...(paint.pbrMetallicRoughness as object), baseColorTexture: { index: 0 } } } : { name: 'Paint', ...paint }],
      ...(image ? { extra: { images: [{ uri: `data:image/png;base64,${Buffer.from(image).toString('base64')}` }], textures: [{ source: 0 }] } } : {}),
    }),
  );
}

let dir = '';
const file = (name: string): string => path.join(dir, name);
let out = '';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'polymerge-appearance-'));
  const pbr = (baseColorFactor: number[], roughnessFactor = 0.5) => ({ pbrMetallicRoughness: { baseColorFactor, roughnessFactor } });
  writeFileSync(file('base.glb'), gridGlb(pbr([0.8, 0.8, 0.8, 1])));
  writeFileSync(file('ours-red.glb'), gridGlb(pbr([1, 0, 0, 1])));
  writeFileSync(file('theirs-rough.glb'), gridGlb(pbr([0.8, 0.8, 0.8, 1], 0.9)));
  writeFileSync(file('theirs-blue.glb'), gridGlb(pbr([0, 0, 1, 1]), 0, 0.5));
  // Textured: base has one image; ours swaps it, theirs swaps it for another and raises the centre.
  writeFileSync(file('tex-base.glb'), gridGlb(pbr([0.8, 0.8, 0.8, 1]), 0, 0, png([200, 200, 200])));
  writeFileSync(file('tex-ours.glb'), gridGlb(pbr([0.8, 0.8, 0.8, 1]), 0, 0, png([220, 20, 20])));
  writeFileSync(file('tex-theirs.glb'), gridGlb(pbr([0.8, 0.8, 0.8, 1]), 0, 0.5, png([20, 20, 220])));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('polymerge merge · glTF appearance', () => {
  it('property edits to one material on each side merge cleanly (exit 0)', async () => {
    const report = file('clean.json');
    expect(await runMerge(file('base.glb'), file('ours-red.glb'), file('theirs-rough.glb'), { report, quiet: true })).toBe(0);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    expect(json.clean).toBe(true);
    expect(json.appearance.stats).toMatchObject({ propertiesFromOurs: 1, propertiesFromTheirs: 1, materials: 1 });
    expect(json.merged.materials).toBe(1);
  });

  it('a material conflict: exit 1, reported with its material and properties, resolved with --pick like any conflict', async () => {
    const report = file('conflict.json');
    out = '';
    expect(await runMerge(file('base.glb'), file('ours-red.glb'), file('theirs-blue.glb'), { report, output: file('out.obj') })).toBe(1);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    expect(json.clean).toBe(false);
    expect(json.conflicts).toHaveLength(1);
    expect(json.conflicts[0].kinds).toEqual({ 'material-property': 1 });
    expect(json.conflicts[0].appearance).toMatchObject({ material: 'Paint', properties: ['baseColorFactor'] });
    // The report names the material and the property; the result line says what stays at base.
    // Ours' only property change is the one in conflict, so nothing was applied from ours automatically.
    expect(out).toMatch(/Appearance ours: 0 material propert\(ies\), 0 re-assigned face\(s\), 0 re-UV'd face\(s\)/);
    expect(out).toMatch(/1 material\(s\) in the result/);
    expect(out).toMatch(/#0 \[material-property\] both sides changed material "Paint" differently: baseColorFactor \(ours \[1, 0, 0, 1\], theirs \[0, 0, 1, 1\]\)/);
    expect(out).toMatch(/material "Paint": baseColorFactor {2}unresolved \(base kept\)/);
    expect(out).toMatch(/keep the BASE geometry and appearance/);
    expect(out).toMatch(/Note: OBJ carries geometry only; the merged materials, UVs and textures are not in .*out\.obj/);
    // Theirs' geometry edit (the raised centre) merged regardless.
    const merged = await loadMesh(readFileSync(file('out.obj')), { fileName: 'out.obj' });
    expect(Math.max(...Array.from(merged.positions).filter((_, i) => i % 3 === 2))).toBe(0.5);
    expect(await runMerge(file('base.glb'), file('ours-red.glb'), file('theirs-blue.glb'), { pick: ['0=theirs'], quiet: true })).toBe(0);
    expect(await runMerge(file('base.glb'), file('ours-red.glb'), file('theirs-blue.glb'), { resolve: 'ours', quiet: true })).toBe(0);
  });

  it('the report lists appearance conflicts after the geometry ones', async () => {
    const load = async (f: string) => loadMesh(readFileSync(file(f)), { fileName: f });
    const base = await load('base.glb');
    const ours = await loadMesh(gridGlb({ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }, 0.5, -0.5), { fileName: 'o.glb' });
    const theirs = await load('theirs-blue.glb');
    const r = mergeMeshes(base, ours, theirs, { logger: { info() {}, warn() {} } });
    expect(r.conflicts.map((c) => Object.keys(c.kinds)[0])).toEqual(['move-move', 'material-property']);
    const text = formatMergeReport(r, { base: 'base.glb', ours: 'o.glb', theirs: 't.glb' });
    expect(text.indexOf('#0 [move-move]')).toBeLessThan(text.indexOf('#1 [material-property]'));
    // Ours also moved its UVs (theirs did not): applied, whole island.
    expect(r.appearance!.stats.uvFacesFromOurs).toBe(8);
  });
});

// ---- Output: the merged appearance is in the written GLB --------------------------------------------

const near = (a: ArrayLike<number>, b: number[]): boolean => a.length === b.length && b.every((x, i) => Math.abs(a[i] - x) < 1e-6);
const centreZ = (m: IMesh): number => Math.max(...Array.from(m.positions).filter((_, i) => i % 3 === 2));
const loadFile = async (f: string): Promise<IMesh> => loadMesh(readFileSync(f), { fileName: f });
/** The first material's base colour texture image bytes as a hex string, read back from a GLB. */
const textureHex = (m: IMesh): string => {
  const ref = m.appearance!.materials[0].baseColorTexture!;
  return Buffer.from(m.appearance!.images[ref.image].data!).toString('hex');
};
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
/** The Khronos validator: no errors, no warnings. */
async function expectValidGlb(f: string): Promise<void> {
  const v = await validateGltf(readFileSync(f));
  expect(v.problems, `${path.basename(f)} validator errors / warnings`).toEqual([]);
  expect([v.errors, v.warnings]).toEqual([0, 0]);
}

describe('polymerge merge -o out.glb · the merged appearance is written', () => {
  it('a clean merge: materials, edits and geometry of both sides in a valid GLB; no STL/OBJ "geometry only" note', async () => {
    out = '';
    expect(await runMerge(file('base.glb'), file('ours-red.glb'), file('theirs-rough.glb'), { output: file('clean-out.glb') })).toBe(0);
    expect(out).toMatch(/Wrote .*clean-out\.glb/);
    expect(out).not.toMatch(/carries geometry only/);
    await expectValidGlb(file('clean-out.glb'));
    const m = await loadFile(file('clean-out.glb'));
    expect(m.materials.map((x) => x.name)).toEqual(['Paint']);
    expect(near(m.appearance!.materials[0].baseColorFactor, [1, 0, 0, 1])).toBe(true); // ours
    expect(m.appearance!.materials[0].roughnessFactor).toBeCloseTo(0.9, 6); // theirs
    expect(m.appearance!.uvs).toHaveLength(1);
    expect(m.appearance!.uvs[0].some(Number.isNaN)).toBe(false);
  });

  it('the same merge to OBJ still says the materials are not in the file', async () => {
    out = '';
    expect(await runMerge(file('base.glb'), file('ours-red.glb'), file('theirs-rough.glb'), { output: file('clean-out.obj') })).toBe(0);
    expect(out).toMatch(/Note: OBJ carries geometry only; the merged materials, UVs and textures are not in .*clean-out\.obj/);
  });

  it('textures: a conflict writes the base texture; --pick writes the chosen side\'s image bytes (valid GLB both ways)', async () => {
    const report = file('tex.json');
    expect(await runMerge(file('tex-base.glb'), file('tex-ours.glb'), file('tex-theirs.glb'), { output: file('tex-out.glb'), report, quiet: true })).toBe(1);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    expect(json.conflicts.map((c: { kinds: object; appearance: { properties: string[] } }) => [Object.keys(c.kinds), c.appearance.properties])).toEqual([[['material-property'], ['baseColorTexture']]]);
    await expectValidGlb(file('tex-out.glb'));
    const unresolved = await loadFile(file('tex-out.glb'));
    expect(textureHex(unresolved)).toBe(hex(png([200, 200, 200]))); // base texture until resolved
    expect(centreZ(unresolved)).toBe(0.5); // theirs' geometry edit merged regardless
    for (const [side, image] of [
      ['ours', png([220, 20, 20])],
      ['theirs', png([20, 20, 220])],
    ] as const) {
      expect(await runMerge(file('tex-base.glb'), file('tex-ours.glb'), file('tex-theirs.glb'), { output: file(`tex-${side}.out.glb`), pick: [`0=${side}`], quiet: true })).toBe(0);
      await expectValidGlb(file(`tex-${side}.out.glb`));
      expect(textureHex(await loadFile(file(`tex-${side}.out.glb`)))).toBe(hex(image));
    }
  });
});

describe('polymerge git-merge on .glb (the git merge driver)', () => {
  /** Run the driver as git does: %O ancestor, %A current (overwritten), %B other, %P the repository path. */
  async function driver(ours: string, theirs: string, o: { resolve?: string } = {}, base = 'base.glb', name = 'A.tmp'): Promise<{ code: number; merged: string }> {
    writeFileSync(file(name), readFileSync(file(ours)));
    const code = await runGitMerge([file(base), file(name), file(theirs), 'parts/panel.glb'], o);
    return { code, merged: file(name) };
  }

  it('a material conflict: exit 1, the base material and the other side\'s geometry written; git sees a conflicted file', async () => {
    const { code, merged } = await driver('ours-red.glb', 'theirs-blue.glb');
    expect(code).toBe(1);
    await expectValidGlb(merged);
    const m = await loadFile(merged);
    expect(near(m.appearance!.materials[0].baseColorFactor, [0.8, 0.8, 0.8, 1])).toBe(true); // the base state
    expect(centreZ(m)).toBe(0.5); // theirs' raised centre was merged automatically
  });

  it('--resolve settles it: exit 0 and the chosen material in the file (ours or theirs)', async () => {
    for (const [side, color] of [
      ['ours', [1, 0, 0, 1]],
      ['theirs', [0, 0, 1, 1]],
    ] as const) {
      const { code, merged } = await driver('ours-red.glb', 'theirs-blue.glb', { resolve: side }, 'base.glb', `A-${side}.tmp`);
      expect(code).toBe(0);
      await expectValidGlb(merged);
      const m = await loadFile(merged);
      expect(near(m.appearance!.materials[0].baseColorFactor, color)).toBe(true);
      expect(centreZ(m)).toBe(0.5);
    }
  });

  it('a clean appearance merge exits 0 with both sides\' edits; a texture conflict exits 1 with the base image', async () => {
    const clean = await driver('ours-red.glb', 'theirs-rough.glb', {}, 'base.glb', 'A-clean.tmp');
    expect(clean.code).toBe(0);
    await expectValidGlb(clean.merged);
    const m = await loadFile(clean.merged);
    expect(near(m.appearance!.materials[0].baseColorFactor, [1, 0, 0, 1])).toBe(true);
    expect(m.appearance!.materials[0].roughnessFactor).toBeCloseTo(0.9, 6);
    const tex = await driver('tex-ours.glb', 'tex-theirs.glb', {}, 'tex-base.glb', 'A-tex.tmp');
    expect(tex.code).toBe(1);
    expect(textureHex(await loadFile(tex.merged))).toBe(hex(png([200, 200, 200])));
    const resolved = await driver('tex-ours.glb', 'tex-theirs.glb', { resolve: 'theirs' }, 'tex-base.glb', 'A-tex2.tmp');
    expect(resolved.code).toBe(0);
    expect(textureHex(await loadFile(resolved.merged))).toBe(hex(png([20, 20, 220])));
  });
});
