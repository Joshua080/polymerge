import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMesh, loadMesh, writeObj, writeStl } from 'polymerge-core';
import { outputFormat, parsePicks, runGitMerge, runMerge } from '../src/commands/merge.js';

/** 6×6 vertex grid (spacing 1) with optional vertex moves. */
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
  return createMesh(pos, faces);
}

/** Two parallel 6×6 sheets: the grid at z = 0 (vertices 0–35) and a copy at z = 1 (36–71). */
function sheets(moves: Record<number, [number, number, number]> = {}) {
  const g = grid();
  const pos = [...g.positions, ...g.positions.map((x, i) => (i % 3 === 2 ? x + 1 : x))];
  for (const [k, d] of Object.entries(moves)) for (let a = 0; a < 3; a++) pos[Number(k) * 3 + a] += d[a];
  return createMesh(pos, [...g.faces, ...g.faces.map((f) => f + 36)]);
}

let dir = '';
const file = (name: string): string => path.join(dir, name);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'polymerge-merge-'));
  writeFileSync(file('base.obj'), writeObj(grid()));
  writeFileSync(file('ours.obj'), writeObj(grid({ 14: [0, 0, 1] })));
  writeFileSync(file('theirs.obj'), writeObj(grid({ 21: [0, 0, 2] })));
  writeFileSync(file('theirs-conflict.obj'), writeObj(grid({ 14: [0, 0, -1] })));
  writeFileSync(file('base.stl'), writeStl(grid()));
  writeFileSync(file('ours.stl'), writeStl(grid({ 14: [0, 0, 1] })));
  writeFileSync(file('theirs.stl'), writeStl(grid({ 14: [0, 0, -1] })));
  // Combined-edit fold: vertex 14 (2, 2) and its neighbour 15 (3, 2) pushed past each other.
  writeFileSync(file('ours-fold.obj'), writeObj(grid({ 14: [0.6, 0, 0] })));
  writeFileSync(file('theirs-fold.obj'), writeObj(grid({ 15: [-0.6, 0, 0] })));
  // Two stacked sheets (z = 0 and z = 1). Vertex 14 of the lower sheet is a move-move conflict;
  // theirs also lowers vertex 50 of the upper sheet (directly above it) to z = 0.5.
  writeFileSync(file('sheets.stl'), writeStl(sheets()));
  writeFileSync(file('sheets-ours.stl'), writeStl(sheets({ 14: [0, 0, 0.7] })));
  writeFileSync(file('sheets-theirs.stl'), writeStl(sheets({ 14: [0, 0, 0.2], 50: [0, 0, -0.5] })));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const zAt = async (f: string, x: number, y: number): Promise<number> => {
  const m = await loadMesh(readFileSync(f), { fileName: f });
  for (let i = 0; i < m.vertexCount; i++) {
    if (m.positions[i * 3] === x && m.positions[i * 3 + 1] === y) return m.positions[i * 3 + 2];
  }
  throw new Error(`no vertex at (${x}, ${y})`);
};

describe('polymerge merge', () => {
  it('clean merge → exit 0, both edits in the written file', async () => {
    const code = await runMerge(file('base.obj'), file('ours.obj'), file('theirs.obj'), { output: file('out.obj'), quiet: true });
    expect(code).toBe(0);
    expect(await zAt(file('out.obj'), 2, 2)).toBe(1); // vertex 14 = (2, 2)
    expect(await zAt(file('out.obj'), 3, 3)).toBe(2); // vertex 21 = (3, 3)
  });

  it('conflict → exit 1, base geometry kept there, JSON report written', async () => {
    const code = await runMerge(file('base.obj'), file('ours.obj'), file('theirs-conflict.obj'), {
      output: file('out2.stl'),
      report: file('report.json'),
      quiet: true,
    });
    expect(code).toBe(1);
    expect(await zAt(file('out2.stl'), 2, 2)).toBe(0);
    const report = JSON.parse(readFileSync(file('report.json'), 'utf8'));
    expect(report.clean).toBe(false);
    expect(report.conflicts).toHaveLength(1);
    expect(Object.keys(report.conflicts[0].kinds)).toEqual(['move-move']);
    expect(report.conflicts[0].baseVertices).toEqual([14]);
  });

  it('--pick / --resolve settle conflicts', async () => {
    expect(await runMerge(file('base.obj'), file('ours.obj'), file('theirs-conflict.obj'), { output: file('o3.obj'), pick: ['0=theirs'], quiet: true })).toBe(0);
    expect(await zAt(file('o3.obj'), 2, 2)).toBe(-1);
    expect(await runMerge(file('base.obj'), file('ours.obj'), file('theirs-conflict.obj'), { output: file('o4.obj'), resolve: 'ours', quiet: true })).toBe(0);
    expect(await zAt(file('o4.obj'), 2, 2)).toBe(1);
  });

  it('combined edits that fold the surface → collision conflict (exit 1); --no-collision-check merges them', async () => {
    const report = file('fold.json');
    expect(await runMerge(file('base.obj'), file('ours-fold.obj'), file('theirs-fold.obj'), { output: file('f1.obj'), report, quiet: true })).toBe(1);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    expect(Object.keys(json.conflicts[0].kinds)).toEqual(['collision']);
    expect(json.conflicts[0].baseVertices).toEqual(expect.arrayContaining([14, 15]));
    expect(await zAt(file('f1.obj'), 2, 2)).toBe(0); // region kept at base: vertex 14 still at x = 2
    expect(
      await runMerge(file('base.obj'), file('ours-fold.obj'), file('theirs-fold.obj'), { output: file('f2.obj'), quiet: true, collisionCheck: false }),
    ).toBe(0);
  });

  it('validates flags and output formats', () => {
    expect(parsePicks(['0=ours', '12=base'])).toEqual({ 0: 'ours', 12: 'base' });
    expect(() => parsePicks(['x=ours'])).toThrow(/--pick/);
    expect(() => parsePicks(['1=mine'])).toThrow(/ours, theirs or base/);
    expect(outputFormat('a/b/model.STL')).toBe('stl');
    expect(() => outputFormat('model.glb')).toThrow(/cannot write/);
  });
});

describe('polymerge git-merge (merge driver protocol)', () => {
  it('writes the merge over %A and exits 1 on conflicts, 0 when clean', async () => {
    // %O %A %B are temp files with arbitrary names; %P gives the real path (and format).
    writeFileSync(file('A.tmp'), readFileSync(file('ours.stl')));
    expect(await runGitMerge([file('base.stl'), file('A.tmp'), file('theirs.stl'), 'parts/bracket.stl'])).toBe(1);
    expect(await zAt(file('A.tmp'), 2, 2)).toBe(0); // conflict region kept at base
    writeFileSync(file('A2.tmp'), readFileSync(file('ours.stl')));
    expect(await runGitMerge([file('base.stl'), file('A2.tmp'), file('base.stl'), 'parts/bracket.stl'])).toBe(0);
    expect(await zAt(file('A2.tmp'), 2, 2)).toBe(1);
    expect(await runGitMerge([file('base.stl'), file('A2.tmp'), file('theirs.stl'), 'x.glb'])).toBe(2);
    expect(await runGitMerge(['only-one'])).toBe(2);
  });

  it('with --resolve, a resolution that combines into damage stops the merge (exit 1) instead of committing it', async () => {
    // Unresolved, vertex 14 stays at base and theirs' lowered upper sheet is harmless. Resolving
    // 14 'ours' raises it to 0.7, through the upper sheet theirs lowered to 0.5.
    const report = file('sheets.json');
    writeFileSync(file('A3.tmp'), readFileSync(file('sheets-ours.stl')));
    expect(await runGitMerge([file('sheets.stl'), file('A3.tmp'), file('sheets-theirs.stl'), 'part.stl'])).toBe(1);
    writeFileSync(file('A4.tmp'), readFileSync(file('sheets-ours.stl')));
    expect(await runGitMerge([file('sheets.stl'), file('A4.tmp'), file('sheets-theirs.stl'), 'part.stl'], { resolve: 'theirs' })).toBe(0);
    writeFileSync(file('A5.tmp'), readFileSync(file('sheets-ours.stl')));
    expect(await runGitMerge([file('sheets.stl'), file('A5.tmp'), file('sheets-theirs.stl'), 'part.stl'], { resolve: 'ours' })).toBe(1);
    // The explicit CLI writes the chosen result and reports the warning (exit 0: nothing unresolved).
    expect(
      await runMerge(file('sheets.stl'), file('sheets-ours.stl'), file('sheets-theirs.stl'), { output: file('f3.stl'), resolve: 'ours', report, quiet: true }),
    ).toBe(0);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    expect(json.clean).toBe(true);
    expect(json.warnings).toHaveLength(1);
    expect(json.warnings[0].kind).toBe('collision');
    expect(json.warnings[0].mergedFaces.length).toBeGreaterThan(0);
  });
});
