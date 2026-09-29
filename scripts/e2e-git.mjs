#!/usr/bin/env node
/**
 * End-to-end check of the git integration with REAL git and the built CLI:
 *   1. diff driver:  `git diff` on a model prints the structural report;
 *   2. merge driver: a clean three-way merge commits with both edits;
 *   3. merge driver: a conflicting merge stops (UU), keeps the base geometry in the conflict
 *      region; `polymerge review` serves git's three stages to the merge review, and
 *      `polymerge resolve --pick 0=theirs` + `git add` finishes it.
 *   4. the same for a .glb with a node hierarchy: the driver writes GLB, keeps the nodes, and
 *      `polymerge resolve` settles a conflict in it.
 *
 *   node scripts/e2e-git.mjs        (needs `npm run build` first)
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages/cli/dist/cli.js');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
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

/** `polymerge review part.obj` during the conflict: the merge review is served git's three stages. */
async function checkReview() {
  const child = spawn(process.execPath, [cli, 'review', 'part.obj', '--no-open', '--port', '0'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/https?:\/\/\S+/);
        if (m) resolve(m[0]);
      });
      child.on('exit', (c) => reject(new Error(`review exited ${c}`)));
      setTimeout(() => reject(new Error('review did not start')), 30_000);
    });
    const u = new URL(url);
    check(u.searchParams.get('mode') === 'merge' && u.searchParams.get('path') === 'part.obj', 'polymerge review opens the merge review for part.obj');
    let same = true;
    for (const [side, n] of [['base', 1], ['ours', 2], ['theirs', 3]]) {
      const served = Buffer.from(await (await fetch(new URL(u.searchParams.get(side), u.origin))).arrayBuffer());
      same &&= served.equals(execFileSync('git', ['show', `:${n}:part.obj`], { cwd: dir }));
    }
    check(same, 'it serves git stages :1 / :2 / :3 as base / ours / theirs');
  } finally {
    child.kill();
  }
}

/**
 * 4. A .glb with a node hierarchy ("assembly" → "bracket", rotated and scaled): merged by the
 * driver as GLB with its nodes kept; a conflict is settled with `polymerge resolve`.
 */
async function checkGlb() {
  const bytes = fs.readFileSync(path.join(root, 'fixtures/cases/gltf-node-hierarchy/target.glb'));
  const base = await core.loadMesh(bytes, { fileName: 'bracket.glb' });
  const at = (m, v) => [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
  const a = at(base, 0);
  const dist = (v) => Math.hypot(...at(base, v).map((x, k) => x - a[k]));
  let far = 0;
  for (let v = 1; v < base.vertexCount; v++) if (dist(v) > dist(far)) far = v;
  const b = at(base, far);
  /** The model with world vertex v raised by dz, written as GLB with its nodes. */
  const edited = (v, dz) => {
    const positions = Float64Array.from(base.positions);
    positions[v * 3 + 2] += dz;
    return core.writeGlb({ ...base, positions });
  };
  const read = () => core.loadMesh(fs.readFileSync(path.join(dir, 'bracket.glb')), { fileName: 'bracket.glb' });
  const has = (m, p) => {
    for (let i = 0; i < m.vertexCount; i++) if (at(m, i).every((x, k) => x === p[k])) return true;
    return false;
  };
  const writeGlbFile = (data) => fs.writeFileSync(path.join(dir, 'bracket.glb'), data);

  fs.appendFileSync(path.join(dir, '.gitattributes'), '*.glb diff=polymerge merge=polymerge\n');
  writeGlbFile(bytes);
  git('add', '-A');
  git('commit', '-qm', 'glb base');
  const glbBase = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'glb-theirs');
  writeGlbFile(edited(far, -0.25));
  git('commit', '-qam', 'theirs: lower the far corner');
  git('checkout', '-q', 'main');
  writeGlbFile(edited(0, 0.5));
  git('commit', '-qam', 'ours: raise corner 0');
  const clean = gitRaw('merge', '--no-edit', 'glb-theirs');
  check(clean.status === 0, `clean .glb merge exits 0 (got ${clean.status})`);
  const merged = await read();
  check(has(merged, [a[0], a[1], a[2] + 0.5]) && has(merged, [b[0], b[1], b[2] - 0.25]), 'the merged .glb has both edits');
  check(merged.scene?.nodes.map((n) => n.name).join() === 'assembly,bracket', 'and keeps its node hierarchy (assembly → bracket)');

  git('checkout', '-q', '-b', 'glb-clash', glbBase);
  writeGlbFile(edited(0, -0.5));
  git('commit', '-qam', 'theirs: lower corner 0');
  git('checkout', '-q', 'main');
  const clash = gitRaw('merge', '--no-edit', 'glb-clash');
  check(clash.status !== 0 && git('status', '--short').trim() === 'UU bracket.glb', 'conflicting .glb merge stops, file unmerged (UU)');
  check(has(await read(), a), 'the conflict region keeps the base geometry in the .glb');
  const res = polymerge('resolve', 'bracket.glb', '--pick', '0=theirs', '-q');
  check(res.status === 0, `polymerge resolve bracket.glb exits 0 (got ${res.status}: ${res.stderr.trim()})`);
  const resolved = await read();
  check(has(resolved, [a[0], a[1], a[2] - 0.5]) && resolved.scene?.nodes.length === 2, 'resolve wrote theirs into the .glb, nodes kept');
  git('add', 'bracket.glb');
  git('commit', '-qm', 'merge glb clash (theirs)');
  check(git('status', '--short').trim() === '', '.glb merge committed, working tree clean');
}

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
  await checkReview();
  const res = polymerge('resolve', 'part.obj', '--pick', '0=theirs', '-q');
  check(res.status === 0, `polymerge resolve exits 0 (got ${res.status}: ${res.stderr.trim()})`);
  check(zOf(2, 2) === -1, 'resolve applied theirs to the conflict region');
  git('add', 'part.obj');
  git('commit', '-qm', 'merge clash (theirs)');
  check(git('status', '--short').trim() === '', 'merge committed, working tree clean');

  await checkGlb();
} catch (err) {
  console.error(err.stderr ?? err);
  failures++;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? 'e2e-git: PASS' : `e2e-git: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
