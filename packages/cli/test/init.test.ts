/** `polymerge init` against real git, with the global config and HOME redirected to a temp dir. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { planAttributes, runInit, withAttributes } from '../src/commands/init.js';

let tmp = '';
let repo = '';
let stdout = '';
const saved: Record<string, string | undefined> = {};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const config = (scope: string, key: string, cwd = repo) => {
  try {
    return git(cwd, 'config', scope, '--get', key);
  } catch {
    return null;
  }
};

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-init-')));
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) saved[k] = process.env[k];
  process.env.HOME = path.join(tmp, 'home');
  process.env.XDG_CONFIG_HOME = path.join(tmp, 'home', '.config');
  process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'home', '.gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
  git(repo, 'init', '-q');
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((stdout += String(s)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('polymerge init', () => {
  it('writes .gitattributes and the drivers into the repository, and a second run changes nothing', async () => {
    fs.mkdirSync(path.join(repo, 'sub'));
    expect(await runInit({ cwd: path.join(repo, 'sub') })).toBe(0);
    const attrs = fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8');
    expect(attrs).toContain('*.stl diff=polymerge merge=polymerge\n');
    expect(attrs).toContain('*.step diff=polymerge merge=binary\n');
    expect(git(repo, 'check-attr', 'diff', 'merge', '--', 'parts/a.glb')).toBe('parts/a.glb: diff: polymerge\nparts/a.glb: merge: polymerge');
    expect(config('--local', 'merge.polymerge.driver')).toBe('polymerge git-merge %O %A %B %P');
    expect(config('--global', 'merge.polymerge.driver')).toBeNull();
    expect(stdout).toMatch(/Commit \.gitattributes/);

    stdout = '';
    await runInit({ cwd: repo });
    expect(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8')).toBe(attrs);
    expect(stdout).toContain('Nothing to do');
  });

  it("keeps a line or setting you already have, and says so", async () => {
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.png binary\n*.glb -diff');
    git(repo, 'config', '--local', 'diff.polymerge.command', '/opt/bin/polymerge git-diff');
    await runInit({ cwd: repo });
    const attrs = fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8');
    expect(attrs.startsWith('*.png binary\n*.glb -diff\n\n# polymerge')).toBe(true);
    expect(attrs).not.toContain('*.glb diff=polymerge');
    expect(config('--local', 'diff.polymerge.command')).toBe('/opt/bin/polymerge git-diff');
    expect(stdout).toMatch(/kept\s+\*\.glb -diff/);
    expect(stdout).toMatch(/kept\s+diff\.polymerge\.command = \/opt\/bin\/polymerge git-diff/);
  });

  it('--dry-run writes nothing', async () => {
    await runInit({ cwd: repo, dryRun: true });
    expect(fs.existsSync(path.join(repo, '.gitattributes'))).toBe(false);
    expect(config('--local', 'diff.polymerge.command')).toBeNull();
    expect(stdout).toMatch(/dry run/);
    expect(stdout).toMatch(/would add \*\.stl/);
  });

  it('--global writes the global attributes file and ~/.gitconfig, from anywhere', async () => {
    const outside = fs.mkdtempSync(path.join(tmp, 'plain-'));
    await runInit({ cwd: outside, global: true });
    const attrs = fs.readFileSync(path.join(tmp, 'home', '.config', 'git', 'attributes'), 'utf8');
    expect(attrs).toContain('*.obj diff=polymerge merge=polymerge');
    expect(config('--global', 'diff.polymerge.command', outside)).toBe('polymerge git-diff');
    // A fresh repository now uses polymerge without its own setup.
    expect(git(repo, 'check-attr', 'diff', '--', 'm.stl')).toBe('m.stl: diff: polymerge');
    // core.attributesFile, when set, is the file used.
    git(outside, 'config', '--global', 'core.attributesFile', '~/my-attributes');
    await runInit({ cwd: outside, global: true });
    expect(fs.readFileSync(path.join(tmp, 'home', 'my-attributes'), 'utf8')).toContain('*.stp diff=polymerge merge=binary');
    git(outside, 'config', '--global', '--unset', 'core.attributesFile');
  });

  it('outside a repository it asks for one (or --global)', async () => {
    const outside = fs.mkdtempSync(path.join(tmp, 'plain-'));
    await expect(runInit({ cwd: outside })).rejects.toThrow(/not inside a git repository.*--global/);
  });
});

describe('attribute planning', () => {
  it('later lines for a pattern win, like in git; comments and blanks are ignored', () => {
    const { add, changes } = planAttributes('# *.stl -diff\n*.stl -diff\n\n*.stl diff=polymerge merge=polymerge\r\n');
    expect(add).not.toContain('*.stl diff=polymerge merge=polymerge');
    expect(changes.find((c) => c.text.startsWith('*.stl'))?.mark).toBe('=');
  });

  it('appends after a file without a final newline, with the header once', () => {
    expect(withAttributes('*.png binary', ['*.stl x'])).toBe('*.png binary\n\n# polymerge: structural diff and three-way merge for 3D models (written by polymerge init)\n*.stl x\n');
    expect(withAttributes('', ['*.stl x'])).toBe('# polymerge: structural diff and three-way merge for 3D models (written by polymerge init)\n*.stl x\n');
    expect(withAttributes('a\n', [])).toBe('a\n');
  });
});
