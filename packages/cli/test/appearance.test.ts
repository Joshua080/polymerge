/**
 * `polymerge merge` on glTF inputs: appearance conflicts are reported with the geometry ones,
 * resolved with the same --pick ids, counted in the exit code, and written to the JSON report.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMesh, mergeMeshes } from 'polymerge-core';
import { buildGltf, glbBytes } from '../../core/test/parsers/helpers.js';
import { formatMergeReport, runMerge } from '../src/commands/merge.js';

const FLOAT = 5126;

/**
 * A 3 × 3-vertex quad grid as GLB: one material "Paint" (glTF material properties given), a
 * TEXCOORD_0 layout at `uvOffset`, vertex 4 (the centre) raised by `lift`.
 */
function gridGlb(paint: Record<string, unknown>, uvOffset = 0, lift = 0): Uint8Array {
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
      materials: [{ name: 'Paint', ...paint }],
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
