#!/usr/bin/env node
/**
 * End-to-end check of the git integration with REAL git and the built CLI:
 *   1. diff driver:  `git diff` on a model prints the structural report;
 *   2. merge driver: a clean three-way merge commits with both edits;
 *   3. merge driver: a conflicting merge stops (UU), keeps the base geometry in the conflict
 *      region; `polymerge resolve --pick 0=theirs` computes the resolution (then the file is put
 *      back as the driver left it); `polymerge review` serves git's three stages to the merge
 *      review, and in headless Chromium "Theirs" + "Save to repository" writes exactly the
 *      resolve output and stages it (no longer UU); `git commit` finishes it.
 *
 *   node scripts/e2e-git.mjs        (needs `npm run build` first)
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { watchdog } from './watchdog.mjs';

const dog = watchdog('e2e-git', 5 * 60_000);
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

const hook = (page) => page.evaluate(() => window.__POLYMERGE__);

/** Run an action that starts a resolution round-trip; wait for 'loading' and then its settled state. */
async function settle(page, action) {
  await page.evaluate(() => {
    window.__settled = new Promise((resolve) => {
      let sawLoading = false;
      const obs = new MutationObserver(() => {
        const state = document.body.dataset.state;
        if (state === 'loading') sawLoading = true;
        else if (sawLoading) {
          obs.disconnect();
          resolve(state);
        }
      });
      obs.observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
      setTimeout(() => {
        obs.disconnect();
        resolve('timeout');
      }, 30_000);
    });
  });
  await action();
  return page.evaluate(() => window.__settled);
}

/**
 * `polymerge review part.obj` during the conflict: the merge review is served git's three stages;
 * in the browser, resolving the conflict to theirs and clicking "Save to repository" writes the
 * result and stages it.
 */
async function reviewAndSave() {
  const child = spawn(process.execPath, [cli, 'review', 'part.obj', '--no-open', '--port', '0'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  dog.onTimeout(() => child.kill());
  let browser;
  try {
    dog.mark('review: start');
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
    check(/^#token=[A-Za-z0-9_-]{43}$/.test(u.hash) && !u.search.includes(u.hash.slice(7)), 'the session token is in the URL fragment, not the query');
    let same = true;
    for (const [side, n] of [['base', 1], ['ours', 2], ['theirs', 3]]) {
      const served = Buffer.from(await (await fetch(new URL(u.searchParams.get(side), u.origin))).arrayBuffer());
      same &&= served.equals(execFileSync('git', ['show', `:${n}:part.obj`], { cwd: dir }));
    }
    check(same, 'it serves git stages :1 / :2 / :3 as base / ours / theirs');

    dog.mark('browser: open the review');
    browser = await chromium.launch({
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector('body[data-state="ready"], body[data-state="error"]', { timeout: 120_000 });
    await page.waitForFunction(() => window.__POLYMERGE__?.merge?.save, null, { timeout: 30_000 });
    let h = await hook(page);
    check(h.state === 'ready' && h.merge.unresolved === 1, `the review shows the unresolved conflict (state ${h.state}${h.error ? `: ${h.error}` : ''})`);
    check(h.merge.save.writable && h.merge.save.path === 'part.obj' && !h.merge.save.enabled, '"Save to repository" is offered for part.obj, disabled while a conflict is unresolved');
    check(!page.url().includes('token'), 'the page removed the token from the address bar');

    dog.mark('browser: resolve theirs');
    const state = await settle(page, () => page.click('[data-conflict="0"] [data-pick="theirs"]'));
    h = await hook(page);
    check(state === 'ready' && h.merge.unresolved === 0 && h.merge.save.enabled, 'choosing "Theirs" resolves the conflict and enables Save');

    dog.mark('browser: save');
    await page.click('[data-save="repo"]');
    await page.waitForFunction(() => ['saved', 'error'].includes(window.__POLYMERGE__?.merge?.save?.state), null, { timeout: 60_000 });
    h = await hook(page);
    check(h.merge.save.state === 'saved', `Save reports success (${h.merge.save.message})`);
    check(/git commit/.test(await page.locator('.save-repo').innerText()), 'the viewer suggests git commit next');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser?.close();
    child.kill();
  }
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
  // What `polymerge resolve --pick 0=theirs` writes; then put the file back as the driver left it.
  const conflicted = fs.readFileSync(path.join(dir, 'part.obj'));
  const res = polymerge('resolve', 'part.obj', '--pick', '0=theirs', '-q');
  check(res.status === 0, `polymerge resolve exits 0 (got ${res.status}: ${res.stderr.trim()})`);
  check(zOf(2, 2) === -1, 'resolve applied theirs to the conflict region');
  const resolved = fs.readFileSync(path.join(dir, 'part.obj'));
  fs.writeFileSync(path.join(dir, 'part.obj'), conflicted);
  check(git('status', '--short').trim() === 'UU part.obj', 'still unmerged (UU) before the review');

  await reviewAndSave();
  dog.mark('after save');
  check(fs.readFileSync(path.join(dir, 'part.obj')).equals(resolved), 'the saved file is byte-identical to `polymerge resolve --pick 0=theirs` output');
  check(zOf(2, 2) === -1 && zOf(8, 7) === -0.25, 'it has theirs in the conflict region and the automatic edit');
  check(git('diff', '--cached', '--name-only').trim() === 'part.obj', 'git diff --cached shows part.obj staged');
  check(execFileSync('git', ['show', ':0:part.obj'], { cwd: dir }).equals(resolved), 'the index holds the saved file (stage 0)');
  check(git('ls-files', '-u').trim() === '' && git('status', '--short').trim() === 'M  part.obj', 'part.obj is no longer unmerged (UU → M)');
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
