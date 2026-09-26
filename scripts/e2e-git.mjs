#!/usr/bin/env node
/**
 * End-to-end check of the git integration with REAL git and the built CLI:
 *   1. diff driver:  `git diff` on a model prints the structural report;
 *   2. merge driver: a clean three-way merge commits with both edits;
 *   3. merge driver: a conflicting merge stops (UU), keeps the base geometry in the conflict
 *      region, and `polymerge resolve --pick 0=theirs` + `git add` finishes it.
 *
 *   node scripts/e2e-git.mjs        (needs `npm run build` first)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages/cli/dist/cli.js');
const baseObj = fs.readFileSync(path.join(root, 'fixtures/cases/grid-bump/base.obj'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-git-'));

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitRaw = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
const polymerge = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });

/** The grid-bump base OBJ with the vertex at (x, y, 0) moved to height z. */
const withZ = (text, x, y, z) => text.replace(new RegExp(`^v ${x} ${y} 0$`, 'm'), `v ${x} ${y} ${z}`);
const zOf = (x, y) => {
  const m = new RegExp(`^v ${x} ${y} (\\S+)$`, 'm').exec(fs.readFileSync(path.join(dir, 'part.obj'), 'utf8'));
  return m ? Number(m[1]) : NaN;
};
const write = (text) => fs.writeFileSync(path.join(dir, 'part.obj'), text);

try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@polymerge.test');
  git('config', 'user.name', 'polymerge e2e');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.obj diff=polymerge merge=polymerge\n');
  git('config', 'diff.polymerge.command', `"${process.execPath}" "${cli}" git-diff`);
  git('config', 'merge.polymerge.driver', `"${process.execPath}" "${cli}" git-merge %O %A %B %P`);
  write(baseObj);
  git('add', '-A');
  git('commit', '-qm', 'base');

  // 1. diff driver
  write(withZ(baseObj, 2, 2, 0.5));
  const diff = git('diff', '--', 'part.obj');
  check(/resolved by Tier 1/.test(diff) && /moved 1/.test(diff), 'git diff shows the structural report (Tier 1, 1 moved vertex)');
  git('commit', '-qam', 'ours: raise (2,2)');

  // 2. clean merge
  git('checkout', '-q', '-b', 'clean', 'HEAD~1');
  write(withZ(baseObj, 8, 7, -0.25));
  git('commit', '-qam', 'theirs: lower (8,7)');
  git('checkout', '-q', 'main');
  const clean = gitRaw('merge', '--no-edit', 'clean');
  check(clean.status === 0, `clean merge exits 0 (got ${clean.status})`);
  check(zOf(2, 2) === 0.5 && zOf(8, 7) === -0.25, 'clean merge keeps both edits');

  // 3. conflicting merge + resolve
  git('checkout', '-q', '-b', 'clash', 'HEAD~2');
  write(withZ(baseObj, 2, 2, -1));
  git('commit', '-qam', 'theirs: lower (2,2)');
  git('checkout', '-q', 'main');
  const clash = gitRaw('merge', '--no-edit', 'clash');
  check(clash.status !== 0 && /CONFLICT/.test(clash.stdout + clash.stderr), 'conflicting merge stops with CONFLICT');
  check(/move-move/.test(clash.stderr), 'the driver explains the conflict (move-move)');
  check(git('status', '--short').trim() === 'UU part.obj', 'the model is marked unmerged (UU)');
  check(zOf(2, 2) === 0 && zOf(8, 7) === -0.25, 'conflict region keeps base geometry; other edits stay merged');
  const res = polymerge('resolve', 'part.obj', '--pick', '0=theirs', '-q');
  check(res.status === 0, `polymerge resolve exits 0 (got ${res.status}: ${res.stderr.trim()})`);
  check(zOf(2, 2) === -1, 'resolve applied theirs to the conflict region');
  git('add', 'part.obj');
  git('commit', '-qm', 'merge clash (theirs)');
  check(git('status', '--short').trim() === '', 'merge committed, working tree clean');
} catch (err) {
  console.error(err.stderr ?? err);
  failures++;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? 'e2e-git: PASS' : `e2e-git: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
