/**
 * STEP through the CLI with the real OpenCascade reader (occt-import-js, a devDependency of the
 * monorepo), on the committed STEP files (scripts/make-step-examples.mjs made them).
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { diffMeshes, stepInfo } from 'polymerge-core';
import { runDiff } from '../src/commands/diff.js';
import { gitSetupText, runGitDiff } from '../src/commands/git.js';
import { runInfo } from '../src/commands/info.js';
import { resolveStages, runGitMerge, runMerge } from '../src/commands/merge.js';
import { loadMeshFile, loadMeshPair, loadModel } from '../src/io.js';
import { findOcct, occtMissingMessage } from '../src/step.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const plate = (n: string): string => path.join(repo, 'examples/step-plate', `${n}.step`);
const fixture = (n: string): string => path.join(repo, 'packages/cli/test/fixtures/step', n);

let dir = '';
let stdout = '';
let stderr = '';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'polymerge-step-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function capture(): void {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((stderr += String(s)), true));
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.POLYMERGE_OCCT;
});

describe('loading STEP', () => {
  it('finds occt-import-js next to polymerge', () => {
    expect(findOcct()?.version).toBe('0.0.23');
  });

  it('loads an assembly: named solids (a part used twice is #2), colours, mm, 0.05 mm tolerance', async () => {
    const { mesh } = await loadMeshFile(fixture('assembly-mm.step'));
    expect(mesh.metadata.format).toBe('step');
    expect(mesh.groups.map((g) => g.name)).toEqual(['plate', 'pin', 'pin #2']);
    expect(mesh.materials.map((m) => m.name)).toEqual(['#7d93ad', '#e0a032']);
    expect(stepInfo(mesh)).toMatchObject({ deflection: 0.05, unit: 'mm', solids: 3, brepFaces: 22 });
    expect(mesh.metadata.bounds).toEqual({ min: [-50, -30, 0], max: [50, 30, 33] });
  });

  it('the same assembly written in inches loads in mm, and diffs as unchanged', async () => {
    const [mm, inch] = await loadMeshPair({ path: fixture('assembly-mm.step') }, { path: fixture('assembly-inch.step') });
    expect(inch.mesh.metadata.bounds).toEqual(mm.mesh.metadata.bounds);
    const d = diffMeshes(mm.mesh, inch.mesh, { logger: { info() {}, warn() {} } });
    expect(d.stats.vertices).toEqual({ unchanged: 420, moved: 0, added: 0, removed: 0 });
  });

  it('tessellation is deterministic', async () => {
    const [a, b] = await Promise.all([loadMeshFile(plate('base')), loadMeshFile(plate('base'))]);
    expect(Array.from(b.mesh.positions)).toEqual(Array.from(a.mesh.positions));
    expect(Array.from(b.mesh.faces)).toEqual(Array.from(a.mesh.faces));
  });

  it("a pair is tessellated with the base's tolerance, whatever the target's own would be", async () => {
    const coarse = await loadModel(new Uint8Array(readFileSync(plate('base'))), 'base.step', { stepDeflection: 0.5 });
    expect(stepInfo(coarse)?.deflection).toBe(0.5);
    const fine = await loadModel(new Uint8Array(readFileSync(plate('base'))), 'base.step');
    expect(coarse.faceCount).toBeLessThan(fine.faceCount);
    const [, target] = await loadMeshPair({ path: plate('base') }, { path: plate('ours') });
    expect(stepInfo(target.mesh)?.deflection).toBe(stepInfo(fine)?.deflection);
  });

  it('says how to install the reader when it is missing', () => {
    process.env.POLYMERGE_OCCT = dir;
    expect(() => findOcct()).toThrow(/is not an occt-import-js package directory/);
    const message = occtMissingMessage('part.step');
    expect(message).toMatch(/^part\.step: STEP files are read with OpenCascade, an optional download/);
    expect(message).toContain('LGPL-2.1');
    expect(message).toContain('npm install -g occt-import-js@0.0.23');
    expect(message).toContain('npx -p @joshuahurley/polymerge -p occt-import-js@0.0.23 polymerge');
  });
});

describe('commands on STEP', () => {
  it('diff: the moved hole, with the tessellation noted', async () => {
    capture();
    const code = await runDiff(plate('base'), plate('ours'), { top: '1' });
    expect(code).toBe(0);
    expect(stdout).toContain('base.step  STEP  188 vertices · 380 faces');
    expect(stdout).toContain('STEP   tessellated by OpenCascade (deflection 0.05 mm for both)');
    expect(stdout).toMatch(/Vertices\s+unchanged 130\s+moved 50/);
    expect(stdout).toContain('Δ (5.0000, 0, 0)');
  });

  it('info: solids, B-rep faces and the tolerance', async () => {
    capture();
    await runInfo(fixture('assembly-inch.step'));
    expect(stdout).toContain('STEP          3 solid(s), 22 B-rep face(s), in mm');
    expect(stdout).toContain('tessellation  OpenCascade, deflection 0.05 mm, angular 0.5 rad');
    expect(stdout).toContain('- pin #2: faces 608..835');
  });

  it("git-diff: git's temp files named by the repository path", async () => {
    capture();
    const a = path.join(dir, 'old-tmp');
    const b = path.join(dir, 'new-tmp');
    copyFileSync(plate('base'), a);
    copyFileSync(plate('ours'), b);
    const code = await runGitDiff(['cad/plate.step', a, '0'.repeat(40), '100644', b, '1'.repeat(40), '100644']);
    expect(code).toBe(0);
    expect(stdout).toContain('polymerge diff --git a/cad/plate.step b/cad/plate.step');
    expect(stdout).toContain('deflection 0.05 mm for both');
    expect(stdout).toMatch(/moved 50/);
  });

  it('merge refuses STEP, even under another extension, before loading anything', async () => {
    const disguised = path.join(dir, 'ours.model');
    copyFileSync(plate('ours'), disguised);
    await expect(runMerge(plate('base'), plate('ours'), plate('theirs'), {})).rejects.toThrow(/base\.step: STEP files can be viewed and diffed, not merged/);
    const stl = (n: string): string => path.join(repo, 'examples/plate', `${n}.stl`);
    await expect(runMerge(stl('base'), disguised, stl('theirs'), {})).rejects.toThrow(/ours\.model: STEP files can be viewed and diffed, not merged/);
  });

  it('git-merge leaves a STEP file for manual merging (exit 2, file untouched)', async () => {
    capture();
    const current = path.join(dir, 'current.step');
    copyFileSync(plate('ours'), current);
    const before = readFileSync(current);
    const code = await runGitMerge([plate('base'), current, plate('theirs'), 'cad/plate.step']);
    expect(code).toBe(2);
    expect(readFileSync(current).equals(before)).toBe(true);
    expect(stderr).toMatch(/cad\/plate\.step: STEP files can be viewed and diffed, not merged.*leaving the file for manual merging/);
  });

  it('resolve refuses STEP', async () => {
    const stage = (n: 1 | 2 | 3) => new Uint8Array(readFileSync(plate(['base', 'ours', 'theirs'][n - 1])));
    await expect(resolveStages(stage, 'cad/plate.step', {})).rejects.toThrow(/not merged/);
  });

  it('git-setup: STEP is diffed by polymerge and never merged line by line', () => {
    const text = gitSetupText();
    expect(text).toContain('*.step diff=polymerge merge=binary');
    expect(text).toContain('*.stp diff=polymerge merge=binary');
  });
});
