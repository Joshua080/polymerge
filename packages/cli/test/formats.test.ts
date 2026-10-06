/**
 * PLY and 3MF through the CLI: diff, merge to either format (with the notes about what the
 * format leaves out), and the git driver's attribute choices.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMesh, loadMesh, writePly, writeThreeMf } from 'polymerge-core';
import { GIT_ATTRIBUTES } from '../src/commands/git.js';
import { outputNotes, runMerge } from '../src/commands/merge.js';
import { runDiff } from '../src/commands/diff.js';

/** 6×6 grid with optional vertex moves, as two named parts (left / right half) in mm. */
function grid(moves: Record<number, [number, number, number]> = {}) {
  const pos: number[] = [];
  for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) pos.push(i, j, 0);
  for (const [k, d] of Object.entries(moves)) for (let a = 0; a < 3; a++) pos[Number(k) * 3 + a] += d[a];
  const faces: number[] = [];
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 5; i++) {
      const a = j * 6 + i;
      faces.push(a, a + 1, a + 7, a, a + 7, a + 6);
    }
  }
  return createMesh(pos, faces, {
    groups: [
      { name: 'left', faceStart: 0, faceCount: 24 },
      { name: 'right', faceStart: 24, faceCount: 26 },
    ],
  });
}

let dir = '';
const file = (name: string): string => path.join(dir, name);
let stdout = '';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'polymerge-formats-'));
  for (const [ext, write] of [
    ['ply', writePly],
    ['3mf', writeThreeMf],
  ] as const) {
    writeFileSync(file(`base.${ext}`), write(grid()));
    writeFileSync(file(`ours.${ext}`), write(grid({ 14: [0, 0, 1] })));
    writeFileSync(file(`theirs.${ext}`), write(grid({ 21: [0, 0, 2] })));
  }
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('PLY and 3MF in the CLI', () => {
  it.each(['ply', '3mf'])('polymerge diff reads %s and finds the one moved vertex', async (ext) => {
    stdout = '';
    expect(await runDiff(file(`base.${ext}`), file(`ours.${ext}`), { exitCode: true })).toBe(1);
    expect(stdout).toContain(ext.toUpperCase());
    expect(stdout).toMatch(/moved 1 /);
  });

  it('merges 3MF into 3MF and notes that slicer settings are not kept', async () => {
    stdout = '';
    const out = file('merged.3mf');
    expect(await runMerge(file('base.3mf'), file('ours.3mf'), file('theirs.3mf'), { output: out })).toBe(0);
    const merged = await loadMesh(new Uint8Array(readFileSync(out)), { fileName: 'merged.3mf' });
    expect(merged.groups.map((g) => g.name)).toEqual(['left', 'right']);
    expect(merged.positions[14 * 3 + 2]).toBe(1);
    expect(merged.positions[21 * 3 + 2]).toBe(2);
    expect(stdout).toContain('slicer settings and plates from the inputs are not kept');
  });

  it('merges PLY into PLY and notes that the parts become one mesh', async () => {
    stdout = '';
    const out = file('merged.ply');
    expect(await runMerge(file('base.ply'), file('ours.ply'), file('theirs.ply'), { output: out })).toBe(0);
    const merged = await loadMesh(new Uint8Array(readFileSync(out)), { fileName: 'merged.ply' });
    expect(merged.faceCount).toBe(50);
    // PLY has no groups: the inputs load as one group each, so the note does not apply here…
    expect(stdout).not.toContain('PLY has no parts');
    // …but it does when the merged mesh has several (here: 3MF in, PLY out).
    expect(await runMerge(file('base.3mf'), file('ours.3mf'), file('theirs.3mf'), { output: file('from-3mf.ply') })).toBe(0);
    expect(stdout).toContain('PLY has no parts: the 2 groups are written as one mesh.');
  });

  it('outputNotes stays quiet for formats that keep everything', () => {
    const result = { merged: grid(), appearance: undefined } as unknown as Parameters<typeof outputNotes>[1];
    expect(outputNotes('glb', result, 'm.glb')).toEqual([]);
    expect(outputNotes('obj', result, 'm.obj')).toEqual([]);
  });

  it('git: PLY is merged by the driver, 3MF only when asked (merge=binary)', () => {
    const attrs = Object.fromEntries(GIT_ATTRIBUTES.map((a) => [a.pattern, a.attributes]));
    expect(attrs['*.ply']).toBe('diff=polymerge merge=polymerge');
    expect(attrs['*.3mf']).toBe('diff=polymerge merge=binary');
  });
});
