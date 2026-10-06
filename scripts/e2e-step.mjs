#!/usr/bin/env node
/**
 * STEP end to end, in headless Chromium:
 *  1. `polymerge view base.step ours.step`: the CLI serves the two STEP files and the user's own
 *     OpenCascade (occt-import-js) under vendor/; the page tessellates both versions with ONE
 *     tolerance and diffs them: Tier 2, the moved hole's 50 vertices moved by exactly 5 mm. Nothing
 *     is fetched from another origin.
 *  2. `polymerge view` with three STEP files (a merge review) refuses, saying why.
 *  3. The hosted viewer (apps/web/dist as plain files under /polymerge/, no vendor/), opening STEP
 *     files by link from another site:
 *       - it asks before downloading OpenCascade from jsDelivr (here answered from node_modules by
 *         request interception), and after "Download and open" diffs the two versions;
 *       - a download that does not match the pinned SHA-256 is refused, not run;
 *       - declining is reported as such;
 *       - the merge review refuses STEP without asking or downloading anything.
 *  4. The pull-request action (action/render.mjs) on a branch that edits a .step file and adds a
 *     .stp one, with palette: colorblind: both rendered Z up, the edit matched as the moved hole,
 *     the comment's colour key in the same palette, and its "explore" command brings OpenCascade
 *     along.
 *
 *   node scripts/e2e-step.mjs     (needs `npm run build`, and occt-import-js installed: a
 *                                  devDependency of the monorepo)
 *
 * $POLYMERGE_CLI points steps 1–2 at another cli.js (e2e-pack: the npm-installed package);
 * --cli-only skips step 3.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounded, launchBrowser, readHook, startViewer, waitReady } from './viewer-capture.mjs';
import { watchdog } from './watchdog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.POLYMERGE_CLI ?? path.join(root, 'packages/cli/dist/cli.js');
const cliOnly = process.argv.includes('--cli-only');
const examples = path.join(root, 'examples/step-plate');
const step = (name) => path.join(examples, `${name}.step`);
const dist = path.join(root, 'apps/web/dist');
const dog = watchdog('e2e-step', 5 * 60_000);
const servers = [];
let viewer = null;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const cleanup = () => {
  viewer?.stop();
  servers.forEach((s) => s.close());
};
dog.onTimeout(cleanup);

/** The hook's diff summary, plus the Meshes panel's Tessellation row. */
async function summary(page) {
  const hook = await readHook(page);
  const tessellation = await bounded(
    page.evaluate(() => {
      const row = [...document.querySelectorAll('table.meshes tr')].find((r) => r.querySelector('th')?.textContent === 'Tessellation');
      return row ? [...row.querySelectorAll('td')].map((c) => c.textContent) : null;
    }),
    10_000,
    'read the Tessellation row',
  );
  return { hook, tessellation };
}

dog.mark('launch browser');
const browser = await launchBrowser();
dog.onTimeout(() => browser.close().catch(() => {}));

try {
  // 1. The CLI serves STEP and its own OpenCascade.
  dog.mark('polymerge view (STEP)');
  {
    viewer = await startViewer({ cli, args: ['view', step('base'), step('ours')] });
    const page = await bounded(browser.newPage({ viewport: { width: 1280, height: 800 } }), 20_000, 'newPage');
    const foreign = [];
    page.on('request', (r) => {
      if (new URL(r.url()).origin !== viewer.origin) foreign.push(r.url());
    });
    await page.goto(viewer.url, { timeout: 30_000 });
    const state = await waitReady(page, { timeout: 150_000, allowError: true });
    const { hook, tessellation } = await summary(page);
    check(state === 'ready', `polymerge view opens two STEP files (${hook?.error ?? state})`);
    check(hook?.base?.format === 'step' && hook?.target?.format === 'step', 'both sides were read as STEP');
    check(hook?.tier === 2 && hook?.stats?.vertices?.moved === 50, `the moved hole is found: Tier 2, 50 vertices moved (Tier ${hook?.tier}, ${hook?.stats?.vertices?.moved} moved)`);
    check(Math.abs((hook?.stats?.maxDisplacement ?? 0) - 5) < 1e-4, `by exactly 5 mm (max ${hook?.stats?.maxDisplacement})`);
    check(JSON.stringify(tessellation) === JSON.stringify(['0.05 mm', '0.05 mm']), `both versions share one tolerance (${JSON.stringify(tessellation)})`);
    check(foreign.length === 0, `OpenCascade came from the CLI, nothing from another origin (${foreign.slice(0, 2).join(', ')})`);
    check(hook?.view?.up === 'z' && (await page.inputValue('#up-axis')) === 'z', `STEP opens Z up, the CAD convention (${JSON.stringify(hook?.view)})`);
    await page.selectOption('#up-axis', 'y');
    const turned = await readHook(page);
    check(turned?.view?.up === 'y' && new URL(page.url()).searchParams.get('up') === 'y', 'switching to Y up turns it and keeps the choice in the address');
    await page.close();
    viewer.stop();
    viewer = null;
  }

  // 2. A merge review of STEP files is refused before anything starts.
  dog.mark('polymerge view (three STEP files)');
  {
    let out = '';
    let code = 0;
    try {
      execFileSync(process.execPath, [cli, 'view', step('base'), step('ours'), step('theirs'), '--no-open', '--port', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    } catch (e) {
      code = e.status ?? -1;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    check(code === 1 && /can be viewed and diffed, not merged/.test(out), `a three-way STEP review is refused (exit ${code}: ${out.trim().split('\n')[0]})`);
  }

  if (!cliOnly) {
    await hostedViewer();
    actionRender();
  }
} finally {
  await browser.close().catch(() => {});
  cleanup();
}

// 3. The hosted viewer: consent, fingerprint check, decline, merge refusal.
async function hostedViewer() {
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('apps/web/dist is missing; run `npm run build` first');
  const occtDir = path.join(path.dirname(createRequire(import.meta.url).resolve('occt-import-js/package.json')), 'dist');
  const listen = (handler) =>
    new Promise((resolve) => {
      const server = http.createServer(handler);
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
  const site = await listen((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (!pathname.startsWith('/polymerge/')) return void res.writeHead(404).end();
    let rel = decodeURIComponent(pathname.slice('/polymerge/'.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dist, rel);
    // Like GitHub Pages: a missing file is a 404 HTML page (so vendor/ is "not there").
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>404</h1>');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  const models = await listen((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.slice(1);
    if (!/^(base|ours|theirs)\.step$/.test(name)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'model/step', 'access-control-allow-origin': '*' }).end(fs.readFileSync(step(name.slice(0, -5))));
  });

  /** A fresh context (empty storage) whose jsDelivr requests are answered from node_modules, optionally tampered. */
  async function hostedPage({ tamper = false } = {}) {
    const context = await bounded(browser.newContext({ viewport: { width: 1280, height: 800 } }), 20_000, 'newContext');
    const cdn = [];
    await context.route('https://cdn.jsdelivr.net/**', (route) => {
      const url = route.request().url();
      cdn.push(url);
      const name = url.split('/').pop();
      if (!/^occt-import-js\.(js|wasm)$/.test(name)) return route.fulfill({ status: 404, body: 'not found' });
      let body = fs.readFileSync(path.join(occtDir, name));
      if (tamper && name.endsWith('.wasm')) body = Buffer.concat([body, Buffer.from([0])]);
      return route.fulfill({ status: 200, contentType: name.endsWith('.js') ? 'application/javascript' : 'application/wasm', headers: { 'access-control-allow-origin': '*' }, body });
    });
    const page = await bounded(context.newPage(), 20_000, 'newPage');
    return { context, page, cdn };
  }
  const diffLink = `${site}/polymerge/?${new URLSearchParams({ base: `${models}/base.step`, target: `${models}/ours.step` })}`;
  const answer = async (page, action) => {
    const button = page.locator(`[data-action="occt-${action}"]`);
    await button.waitFor({ timeout: 30_000 });
    await button.click();
  };

  dog.mark('hosted: consent, then diff');
  {
    const { context, page, cdn } = await hostedPage();
    await page.goto(diffLink, { timeout: 30_000 });
    const asked = await page.locator('.consent').isVisible().catch(() => false) || (await page.locator('.consent').waitFor({ timeout: 30_000 }).then(() => true, () => false));
    check(asked && cdn.length === 0, `the hosted viewer asks before downloading OpenCascade (asked: ${asked}, downloads so far: ${cdn.length})`);
    const text = await page.locator('.consent').textContent();
    check(/LGPL-2\.1/.test(text ?? '') && /7\.6 MB/.test(text ?? '') && /cdn\.jsdelivr\.net/.test(text ?? ''), 'the question names the licence, the size and the source');
    await answer(page, 'accept');
    const state = await waitReady(page, { timeout: 150_000, allowError: true });
    const { hook, tessellation } = await summary(page);
    check(state === 'ready' && hook?.tier === 2 && hook?.stats?.vertices?.moved === 50, `after "Download and open" the STEP diff runs (Tier ${hook?.tier}, ${hook?.stats?.vertices?.moved} moved; ${hook?.error ?? state})`);
    check(JSON.stringify(tessellation) === JSON.stringify(['0.05 mm', '0.05 mm']), `one tolerance for both versions (${JSON.stringify(tessellation)})`);
    check(cdn.length === 2 && cdn.every((u) => u.includes('/occt-import-js@0.0.23/dist/')), `exactly the pinned version was downloaded (${cdn.length} files)`);
    // "Don't ask again" was left ticked: a reload goes straight through.
    cdn.length = 0;
    await page.reload({ timeout: 30_000 });
    const again = await waitReady(page, { timeout: 150_000, allowError: true });
    check(again === 'ready' && !(await page.locator('.consent').count()), 'the answer is remembered in this browser');
    await context.close();
  }

  dog.mark('hosted: tampered download');
  {
    const { context, page } = await hostedPage({ tamper: true });
    await page.goto(diffLink, { timeout: 30_000 });
    await answer(page, 'accept');
    const state = await waitReady(page, { timeout: 120_000, allowError: true });
    const hook = await readHook(page);
    check(state === 'error' && /do not match/.test(hook?.error ?? ''), `a download that does not match the pinned SHA-256 is refused (${JSON.stringify(hook?.error)})`);
    await context.close();
  }

  dog.mark('hosted: declined');
  {
    const { context, page, cdn } = await hostedPage();
    await page.goto(diffLink, { timeout: 30_000 });
    await answer(page, 'decline');
    const state = await waitReady(page, { timeout: 60_000, allowError: true });
    const hook = await readHook(page);
    check(state === 'error' && /declined/.test(hook?.error ?? '') && cdn.length === 0, `declining downloads nothing and says so (${JSON.stringify(hook?.error)})`);
    await context.close();
  }

  dog.mark('hosted: merge review of STEP');
  {
    const { context, page, cdn } = await hostedPage();
    const q = new URLSearchParams({ mode: 'merge', base: `${models}/base.step`, ours: `${models}/ours.step`, theirs: `${models}/theirs.step` });
    await page.goto(`${site}/polymerge/?${q}`, { timeout: 30_000 });
    const state = await waitReady(page, { timeout: 60_000, allowError: true });
    const hook = await readHook(page);
    const asked = await page.locator('.consent').count();
    check(state === 'error' && /not merged/.test(hook?.error ?? '') && cdn.length === 0 && asked === 0, `the merge review refuses STEP without asking or downloading (${JSON.stringify(hook?.error)})`);
    await context.close();
  }
}

// 4. The pull-request action renders a STEP change.
function actionRender() {
  dog.mark('action: render a STEP change');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-step-action-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'models'), { recursive: true });
    const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    fs.copyFileSync(step('base'), path.join(repo, 'models/plate.step'));
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'feature');
    fs.copyFileSync(step('ours'), path.join(repo, 'models/plate.step'));
    fs.copyFileSync(step('theirs'), path.join(repo, 'models/new-plate.stp'));
    git('add', '-A');
    git('commit', '-qm', 'move a hole; add a plate');
    const head = git('rev-parse', 'HEAD');
    const event = path.join(tmp, 'event.json');
    fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 7, base: { sha: base, ref: 'main' }, head: { sha: head, ref: 'feature' } } }));
    const out = path.join(tmp, 'out');
    const summary = path.join(tmp, 'summary.md');
    const r = spawnSync(process.execPath, [path.join(root, 'action/render.mjs')], {
      encoding: 'utf8',
      timeout: 240_000,
      env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_WORKSPACE: repo, GITHUB_OUTPUT: path.join(tmp, 'output.txt'), GITHUB_STEP_SUMMARY: summary, POLYMERGE_OUT: out, POLYMERGE_PALETTE: 'colorblind' },
    });
    check(r.status === 0, `the action's render step exits 0 on STEP files${r.status ? `:\n${r.stdout}${r.stderr}` : ''}`);
    const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    const plate = byPath['models/plate.step'];
    const added = byPath['models/new-plate.stp'];
    check(plate?.status === 'rendered' && plate.diff?.tier === 2 && plate.diff?.vertices?.moved === 50, `the edited .step is rendered, the hole matched as moved (${plate?.status}, Tier ${plate?.diff?.tier}, ${plate?.diff?.vertices?.moved} moved${plate?.error ? `: ${plate.error}` : ''})`);
    check(added?.change === 'added' && added.status === 'rendered', `the added .stp is rendered (${added?.change} → ${added?.status}${added?.error ? `: ${added.error}` : ''})`);
    const images = [plate, added].map((f) => f?.image && path.join(out, f.image));
    check(images.every((f) => f && fs.existsSync(f) && fs.statSync(f).size > 20_000), 'both images exist and are not empty');
    for (const [i, f] of images.entries()) if (f && fs.existsSync(f)) fs.copyFileSync(f, path.join(root, 'apps/web/e2e/screenshots', `action-step-${i}.png`));
    const log = JSON.parse(fs.readFileSync(path.join(out, 'render-log.json'), 'utf8'));
    check(log.find((l) => l.path === 'models/plate.step')?.tier === 2, 'the image was drawn from the same match as the summary (Tier 2)');
    const views = log.map((l) => l.view);
    check(views.length === 2 && views.every((v) => v?.up === 'z' && v?.palette === 'colorblind'), `up-axis auto turns STEP Z up, and palette: colorblind reaches the images (${JSON.stringify(views)})`);
    const comment = fs.readFileSync(summary, 'utf8');
    check(
      comment.includes(`npx -p @joshuahurley/polymerge -p occt-import-js@0.0.23 polymerge view before.step after.step --palette colorblind`),
      "the comment's explore command fetches OpenCascade too",
    );
    check(result.palette === 'colorblind' && comment.includes('🟦 added'), "the comment's status squares match the colour-blind images (🟦 added)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`e2e-step: FAIL (${failures})`);
  process.exit(1);
}
console.log('e2e-step: PASS');
process.exit(0);
