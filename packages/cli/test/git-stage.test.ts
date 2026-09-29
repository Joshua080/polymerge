/**
 * `polymerge resolve <path>` reads git's index stages with `git show :n:<path>`. Git resolves
 * that path from the repository ROOT unless it starts with ./ or ../, so a user standing in a
 * subdirectory (or passing an absolute path) must still get the file they named.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitStage } from '../src/commands/merge.js';

let dir = '';
const STAGES = ['ancestor\n', 'ours\n', 'theirs\n'];

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-git-stage-')));
  const git = (input: string | undefined, ...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  git(undefined, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'sub'));
  // Unmerged `sub/part.obj` (stages 1/2/3), plus a decoy of the same name at the root.
  const oids = STAGES.map((s) => git(s, 'hash-object', '-w', '--stdin').trim());
  git(`${oids.map((o, i) => `100644 ${o} ${i + 1}\tsub/part.obj\n`).join('')}`, 'update-index', '--index-info');
  const decoy = git('decoy\n', 'hash-object', '-w', '--stdin').trim();
  git(`100644 ${decoy} 1\tpart.obj\n`, 'update-index', '--index-info');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('gitStage', () => {
  it('reads a path given from the repository root', () => {
    expect(String(gitStage(2, 'sub/part.obj', dir))).toBe('ours\n');
  });

  it('reads a path relative to a subdirectory, not the root', () => {
    const sub = path.join(dir, 'sub');
    expect(String(gitStage(1, 'part.obj', sub))).toBe('ancestor\n');
    expect(String(gitStage(3, './part.obj', sub))).toBe('theirs\n');
  });

  it('reads an absolute path', () => {
    expect(String(gitStage(2, path.join(dir, 'sub', 'part.obj'), path.join(dir, 'sub')))).toBe('ours\n');
  });

  it('explains a missing stage', () => {
    expect(() => gitStage(2, 'part.obj', dir)).toThrow(/no stage 2 for part\.obj/);
  });
});
