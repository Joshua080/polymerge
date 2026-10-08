/**
 * Everything from a terminal: plain-ASCII output, `info --json`, `section`, `measure`, the
 * "where it changed" regions of `diff`, and `resolve --dry-run`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMesh, writeObj, writeStl } from 'polymerge-core';
import { toAscii, wantsAscii } from '../src/ascii.js';
import { runDiff } from '../src/commands/diff.js';
import { runInfo } from '../src/commands/info.js';
import { parsePoint, runMeasure } from '../src/commands/measure.js';
import { parsePlane, runSection } from '../src/commands/section.js';

/** A closed box [0,w]×[0,d]×[0,h] with a square through-hole of side s at its centre (along z). */
function boxWithHole(w: number, d: number, h: number, s: number) {
  const ring = (x0: number, y0: number, x1: number, y1: number, z: number) => [
    [x0, y0, z],
    [x1, y0, z],
    [x1, y1, z],
    [x0, y1, z],
  ];
  const cx = w / 2;
  const cy = d / 2;
  const pts = [...ring(0, 0, w, d, 0), ...ring(0, 0, w, d, h), ...ring(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2, 0), ...ring(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2, h)];
  const faces: number[] = [];
  const quad = (a: number, b: number, c: number, e: number) => faces.push(a, b, c, a, c, e);
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    quad(k, k1, 4 + k1, 4 + k);
    quad(8 + k1, 8 + k, 12 + k, 12 + k1);
    quad(4 + k, 4 + k1, 12 + k1, 12 + k);
    quad(k1, k, 8 + k, 8 + k1);
  }
  return createMesh(pts.flat(), faces);
}

/**
 * The CLI from its sources (the tests run before `npm run build`; tsx compiles on the fly). tsx is
 * passed by its full path: a bare "tsx" would be looked up from the child's working directory.
 */
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLI = ['--import', TSX, path.resolve(__dirname, '../src/cli.ts')];

let dir = '';
const file = (name: string): string => path.join(dir, name);
let out = '';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'polymerge-terminal-'));
  writeFileSync(file('block.stl'), writeStl(boxWithHole(40, 20, 10, 6)));
  writeFileSync(file('block-bigger-hole.stl'), writeStl(boxWithHole(40, 20, 10, 8)));
  // Two cubes; the edit lifts one corner of the first.
  const cubes = (lift: number) => {
    const c = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
    const p = [...c, ...c.map((x, i) => (i % 3 === 0 ? x + 3 : x))];
    p[6 * 3 + 2] += lift;
    const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
    return createMesh(p, [...t, ...t.map((v) => v + 8)]);
  };
  writeFileSync(file('cubes.obj'), writeObj(cubes(0)));
  writeFileSync(file('cubes-edited.obj'), writeObj(cubes(0.5)));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function capture(): void {
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

afterEach(() => vi.restoreAllMocks());

describe('plain ASCII output', () => {
  it('spells every symbol polymerge prints in ASCII, keeping JSON valid', () => {
    expect(toAscii('hole Ø8 moved 5 mm (+5, 0, −2) · 1.5 cm³ → ✓ ≥ 90° … “x”')).toBe("hole D8 moved 5 mm (+5, 0, -2) | 1.5 cm^3 -> ok >= 90 deg ... 'x'");
    const json = JSON.stringify({ text: 'a “quoted” → b' });
    expect(JSON.parse(toAscii(json))).toEqual({ text: "a 'quoted' -> b" });
  });

  it('on by flag or environment, automatic only in the classic Windows console', () => {
    expect(wantsAscii({ ascii: true }, {}, 'linux', true)).toBe(true);
    expect(wantsAscii({ unicode: true }, { POLYMERGE_ASCII: '1' }, 'win32', true)).toBe(false);
    expect(wantsAscii({}, { POLYMERGE_ASCII: '1' }, 'linux', false)).toBe(true);
    expect(wantsAscii({}, {}, 'win32', true)).toBe(true);
    expect(wantsAscii({}, { WT_SESSION: 'x' }, 'win32', true)).toBe(false); // Windows Terminal
    expect(wantsAscii({}, { TERM_PROGRAM: 'vscode' }, 'win32', true)).toBe(false);
    expect(wantsAscii({}, {}, 'win32', false)).toBe(false); // redirected to a file
    expect(wantsAscii({}, {}, 'darwin', true)).toBe(false);
  });

  it('the CLI writes ASCII with --ascii', () => {
    const text = execFileSync(process.execPath, [...CLI, 'info', file('block.stl'), '--ascii'], { encoding: 'utf8' });
    expect(text).toMatch(/^[\x00-\x7f]*$/);
    expect(text).toContain('volume');
  });
});

describe('info', () => {
  it('--json: counts, metrics, groups', async () => {
    capture();
    await runInfo(file('block.stl'), { json: true });
    const info = JSON.parse(out);
    expect(info).toMatchObject({ file: 'block.stl', format: 'stl', faces: 32 });
    expect(info.metrics.volume).toBeCloseTo(40 * 20 * 10 - 6 * 6 * 10);
    expect(info.metrics.closed).toBe(true);
  });
});

describe('section', () => {
  it('the plane: one of --x / --y / --z, a number or a percentage', () => {
    const mesh = boxWithHole(40, 20, 10, 6);
    expect(parsePlane({}, mesh)).toEqual({ axis: 'z', value: 5 });
    expect(parsePlane({ x: '25%' }, mesh)).toEqual({ axis: 'x', value: 10 });
    expect(parsePlane({ y: '3.5' }, mesh)).toEqual({ axis: 'y', value: 3.5 });
    expect(() => parsePlane({ x: '1', z: '2' }, mesh)).toThrow(/one plane/);
    expect(() => parsePlane({ z: 'middle' }, mesh)).toThrow(/number or a percentage/);
  });

  it('lists the outline and the hole, and how a second version differs', async () => {
    capture();
    await runSection([file('block.stl'), file('block-bigger-hole.stl')], { z: '5', svg: file('cut.svg') });
    expect(out).toMatch(/outline 1\s+40 × 20\s+at \(20, 10\)\s+perimeter 120\s+area 800/);
    expect(out).toMatch(/hole 1\s+6 × 6\s+at \(20, 10\)\s+perimeter 24\s+area 36/);
    expect(out).toMatch(/material in the cut 764/);
    expect(out).toContain('Change  material −28 (−3.7%) · loops 2 → 2');
    const svg = readFileSync(file('cut.svg'), 'utf8');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.match(/<path /g)).toHaveLength(2);
  });

  it('--json', async () => {
    capture();
    await runSection([file('block.stl')], { x: '2', json: true });
    const [cut] = JSON.parse(out);
    expect(cut.axis).toBe('x');
    expect(cut.area).toBeCloseTo(200);
  });
});

describe('measure', () => {
  it('snaps both points to the surface and gives the distance', async () => {
    capture();
    await runMeasure(file('block.stl'), '0,0,15', '40,0,15', {});
    expect(out).toContain('from  (0, 0, 10) on the surface, 5 from (0, 0, 15)');
    expect(out).toMatch(/distance 40 /);
  });

  it('negative coordinates are values, not options', () => {
    const json = execFileSync(process.execPath, [...CLI, 'measure', file('block.stl'), '-5,0,5', '45,0,5', '--no-snap', '--json'], { encoding: 'utf8' });
    expect(JSON.parse(json).distance).toBe(50);
    const cut = execFileSync(process.execPath, [...CLI, 'section', file('block.stl'), '--z', '-1'], { encoding: 'utf8' });
    expect(cut).toContain('the plane does not cut the model here');
  });

  it('a vertex by number, or the raw points with --no-snap', async () => {
    const mesh = boxWithHole(40, 20, 10, 6);
    expect(parsePoint('v:1', mesh)).toEqual([40, 0, 0]);
    expect(() => parsePoint('v:999', mesh)).toThrow(/no vertex 999/);
    expect(() => parsePoint('1,2', mesh)).toThrow(/x,y,z/);
    capture();
    await runMeasure(file('block.stl'), '0,0,15', '3,4,15', { snap: false, json: true });
    expect(JSON.parse(out).distance).toBe(5);
  });
});

describe('diff: where it changed', () => {
  it('lists the regions of change with their place and size', async () => {
    capture();
    await runDiff(file('cubes.obj'), file('cubes-edited.obj'), { top: '0' });
    expect(out).toMatch(/Where it changed \(1 region\):\n {2}1\. \d+ modified faces around \(\d.*\), .*largest move 0\.5/);
  });
});

describe('resolve --dry-run', () => {
  it('writes nothing', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'polymerge-dry-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
    const grid = (z: number) => {
      const p: number[] = [];
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) p.push(i, j, i === 1 && j === 1 ? z : 0);
      const f: number[] = [];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) f.push(j * 3 + i, j * 3 + i + 1, j * 3 + i + 4, j * 3 + i, j * 3 + i + 4, j * 3 + i + 3);
      return writeObj(createMesh(p, f));
    };
    try {
      git('init', '-q', '-b', 'main');
      writeFileSync(path.join(repo, 'm.obj'), grid(0));
      git('add', '-A');
      git('commit', '-qm', 'base');
      git('checkout', '-qb', 'other');
      writeFileSync(path.join(repo, 'm.obj'), grid(-1));
      git('commit', '-qam', 'theirs');
      git('checkout', '-q', 'main');
      writeFileSync(path.join(repo, 'm.obj'), grid(1));
      git('commit', '-qam', 'ours');
      try {
        git('merge', '-q', 'other');
      } catch {
        // a conflict, as intended
      }
      const before = readFileSync(path.join(repo, 'm.obj'));
      // `resolve` reads git's stages of the repository it runs in: run the CLI there.
      let code = 0;
      let text = '';
      try {
        text = execFileSync(process.execPath, [...CLI, 'resolve', 'm.obj', '--dry-run'], { cwd: repo, encoding: 'utf8' });
      } catch (err) {
        const e = err as { status: number; stdout: string };
        code = e.status;
        text = e.stdout;
      }
      expect(code).toBe(1);
      expect(text).toContain('Dry run: m.obj was not written.');
      expect(text).toMatch(/#0 \[move-move\]/);
      expect(readFileSync(path.join(repo, 'm.obj')).equals(before)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
