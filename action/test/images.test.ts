import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBranchName, imageUrl, publishImages } from '../lib/images.mjs';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-images-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('publishImages', () => {
  it('commits the images on top of the branch, one commit per run, keeping earlier commits reachable', () => {
    const bare = path.join(tmp(), 'repo.git');
    git(tmp(), 'init', '-q', '--bare', bare);
    const src = tmp();
    fs.writeFileSync(path.join(src, '0.png'), 'first image');
    fs.writeFileSync(path.join(src, '1.png'), 'second image');
    const remote = `file://${bare}`;
    const first = publishImages({ remote, branch: 'polymerge-images', files: [{ path: 'pr-1/aaa/0.png', file: path.join(src, '0.png') }, { path: 'pr-1/aaa/1.png', file: path.join(src, '1.png') }], message: 'one' });
    expect(git(bare, 'rev-parse', 'refs/heads/polymerge-images')).toBe(first);
    expect(git(bare, 'cat-file', '-p', `${first}:pr-1/aaa/1.png`)).toBe('second image');
    expect(git(bare, 'log', '--format=%an <%ae>', '-1', first)).toBe('github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');

    const second = publishImages({ remote, branch: 'polymerge-images', files: [{ path: 'pr-2/bbb/0.png', file: path.join(src, '0.png') }], message: 'two' });
    expect(git(bare, 'rev-parse', `${second}^`)).toBe(first);
    // Each commit's tree holds only its own run's images; the first commit still has its own.
    expect(git(bare, 'ls-tree', '-r', '--name-only', second)).toBe('pr-2/bbb/0.png');
    expect(git(bare, 'cat-file', '-p', `${first}:pr-1/aaa/0.png`)).toBe('first image');
  });

  it('fails clearly when the remote cannot be written', () => {
    const src = tmp();
    fs.writeFileSync(path.join(src, '0.png'), 'x');
    expect(() => publishImages({ remote: `file://${path.join(tmp(), 'missing.git')}`, branch: 'polymerge-images', files: [{ path: '0.png', file: path.join(src, '0.png') }], message: 'm', attempts: 1 })).toThrow(/polymerge-images/);
  });
});

describe('checkBranchName / imageUrl', () => {
  it('accepts plain branch names and refuses option-like or odd ones', () => {
    expect(checkBranchName('polymerge-images')).toBe('polymerge-images');
    expect(checkBranchName('ci/renders')).toBe('ci/renders');
    for (const bad of ['-f', '--upload-pack=x', 'a..b', 'a b', 'x.lock', 'a/', '', 'refs//x']) expect(() => checkBranchName(bad)).toThrow(/not a usable branch name/);
  });

  it('pins the URL to the commit and encodes each path segment', () => {
    expect(imageUrl('https://github.com/', 'o/r', 'c0ffee', 'pr-1/abc/0.png')).toBe('https://github.com/o/r/raw/c0ffee/pr-1/abc/0.png');
    expect(imageUrl('https://ghe.example', 'o/r', 'c0ffee', 'a b/#1.png')).toBe('https://ghe.example/o/r/raw/c0ffee/a%20b/%231.png');
  });
});
