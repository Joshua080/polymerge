#!/usr/bin/env node
/**
 * End-to-end check of the merge review in a real browser (headless Chromium, SwiftShader WebGL):
 *
 *  1. `polymerge view base ours theirs` (three files → merge review) on a plate whose boss both
 *     sides raised to different heights: the conflict region shows orange, the automatic edits
 *     blue / purple; clicking "Theirs" resolves it (orange gone, --pick in the command), and the
 *     downloaded STL has theirs' boss height.
 *  2. The thin-wall example (a collision conflict): clicking the orange region IN THE 3D VIEW
 *     selects it, and the key "1" resolves it to ours.
 *  3. The mixed-choices example: two conflicts whose mixed resolution collides → a warning.
 *
 *   node scripts/e2e-merge.mjs      (needs `npm run build` first)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMesh, loadMesh, writeStl } from 'polymerge-core';
import { watchdog } from './watchdog.mjs';

const dog = watchdog('e2e-merge', 5 * 60_000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'apps/web/e2e/screenshots');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-merge-'));
fs.mkdirSync(shots, { recursive: true });

// MERGE_COLORS hue classes: conflict orange 25°, ours blue 217°, theirs purple 271°.
const HUES = { conflict: [12, 38], ours: [200, 232], theirs: [258, 290] };

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};

// ---- A plate (closed slab) whose centre boss both sides raise, to different heights ----------
const N = 9;
const top = (i, j) => j * N + i;
function slab() {
  const p = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) p.push(i, j, 1);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) p.push(i, j, 0);
  const b = (i, j) => N * N + j * N + i;
  const f = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      f.push(top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j), top(i + 1, j + 1), top(i, j + 1));
      f.push(b(i, j), b(i + 1, j + 1), b(i + 1, j), b(i, j), b(i, j + 1), b(i + 1, j + 1));
    }
  }
  const ring = [];
  for (let i = 0; i < N - 1; i++) ring.push([i, 0]);
  for (let j = 0; j < N - 1; j++) ring.push([N - 1, j]);
  for (let i = N - 1; i > 0; i--) ring.push([i, N - 1]);
  for (let j = N - 1; j > 0; j--) ring.push([0, j]);
  ring.forEach(([i0, j0], k) => {
    const [i1, j1] = ring[(k + 1) % ring.length];
    f.push(b(i0, j0), b(i1, j1), top(i1, j1), b(i0, j0), top(i1, j1), top(i0, j0));
  });
  return { p, f };
}
const boss = [];
for (let j = 3; j <= 5; j++) for (let i = 3; i <= 5; i++) boss.push(top(i, j));
const plate = slab();
const moved = (moves) => {
  const p = plate.p.slice();
  for (const [v, d] of moves) for (let k = 0; k < 3; k++) p[v * 3 + k] += d[k];
  return createMesh(p, plate.f);
};
fs.writeFileSync(path.join(dir, 'base.stl'), writeStl(createMesh(plate.p, plate.f)));
fs.writeFileSync(path.join(dir, 'ours.stl'), writeStl(moved([...boss.map((v) => [v, [0, 0, 0.8]]), [top(0, 8), [0.3, -0.3, -0.3]]])));
fs.writeFileSync(path.join(dir, 'theirs.stl'), writeStl(moved([...boss.map((v) => [v, [0, 0, 0.4]]), [top(8, 0), [-0.3, 0.3, -0.3]]])));

// ---- Browser helpers ---------------------------------------------------------------------------

const hook = (page) => page.evaluate(() => window.__POLYMERGE__);
const ready = (page) => page.waitForSelector('body[data-state="ready"], body[data-state="error"]', { timeout: 120_000 });
/**
 * Run an action that starts a resolution round-trip and wait for it to finish: the state must go
 * to 'loading' and then settle (other re-publishes of 'ready', e.g. a hover selecting a conflict,
 * do not count). Resolves the final state, or 'timeout'.
 */
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

/** Pixels of the canvas per merge colour class (hue with enough saturation). */
async function colours(page, shot) {
  const png = await page.locator('canvas').screenshot({ path: path.join(shots, shot) });
  return page.evaluate(
    async ({ b64, hues }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const counts = { conflict: 0, ours: 0, theirs: 0 };
      for (let i = 0; i < d.length; i += 4) {
        const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
        const max = Math.max(r, gg, b);
        const min = Math.min(r, gg, b);
        if (max < 50 || (max - min) / max < 0.45) continue;
        let hue = max === r ? (60 * (gg - b)) / (max - min) : max === gg ? 60 * (2 + (b - r) / (max - min)) : 60 * (4 + (r - gg) / (max - min));
        if (hue < 0) hue += 360;
        for (const [k, [lo, hi]] of Object.entries(hues)) if (hue >= lo && hue <= hi) counts[k]++;
      }
      return counts;
    },
    { b64: png.toString('base64'), hues: HUES },
  );
}

// ---- Run ---------------------------------------------------------------------------------------

const cli = spawn(
  process.execPath,
  [path.join(root, 'packages/cli/dist/cli.js'), 'view', ...['base', 'ours', 'theirs'].map((s) => path.join(dir, `${s}.stl`)), '--no-open', '--port', '0', '--name', 'parts/plate.stl'],
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
);
dog.onTimeout(() => cli.kill());
try {
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    cli.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/https?:\/\/\S+/);
      if (m) resolve(m[0]);
    });
    cli.on('exit', (c) => reject(new Error(`CLI exited ${c}`)));
  });
  const origin = new URL(url).origin;
  check(/mode=merge/.test(url) && /ours=/.test(url) && /theirs=/.test(url), 'polymerge view with three files opens the merge review');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  try {
    dog.mark('1. CLI files (boss conflict)');
    // 1. CLI files: move-move conflict, resolved by clicking "Theirs"; download the result.
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await ready(page);
    let h = await hook(page);
    check(h.state === 'ready' && h.mode === 'merge', `merge review ready (state ${h.state}${h.error ? `: ${h.error}` : ''})`);
    check(h.engine === 'worker', `the merge ran in the Web Worker (engine ${h.engine})`);
    check(h.merge?.conflicts.length === 1 && h.merge.conflicts[0].kinds['move-move'] > 0, 'one move-move conflict (the boss)');
    check(h.merge?.stats.movedFromOurs === 1 && h.merge.stats.movedFromTheirs === 1, 'the two corner edits merged automatically');
    check(h.merge?.selected === 0, 'the first conflict is selected on open');
    let px = await colours(page, 'merge-cli-unresolved.png');
    console.log(`   pixels unresolved: conflict ${px.conflict}, ours ${px.ours}, theirs ${px.theirs}`);
    check(px.conflict > 200, 'the conflict region is highlighted (orange)');
    check(px.ours > 20 && px.theirs > 20, 'automatic edits show as ours (blue) and theirs (purple)');
    const state = await settle(page, () => page.click('[data-conflict="0"] [data-pick="theirs"]'));
    h = await hook(page);
    check(state === 'ready' && h.merge?.conflicts[0].resolution === 'theirs' && h.merge.unresolved === 0, 'clicking "Theirs" resolves the conflict');
    check(/--pick 0=theirs/.test(h.merge?.command ?? '') && /polymerge resolve parts\/plate\.stl --pick 0=theirs/.test(h.merge.command), 'the CLI / git commands carry the choice');
    const after = await colours(page, 'merge-cli-theirs.png');
    console.log(`   pixels resolved:   conflict ${after.conflict}, ours ${after.ours}, theirs ${after.theirs}`);
    check(after.conflict < px.conflict / 10 && after.theirs > px.theirs, 'the region turns from orange to theirs (purple)');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-download="stl"]')]);
    const file = path.join(dir, 'merged.stl');
    await download.saveAs(file);
    const merged = await loadMesh(fs.readFileSync(file), { fileName: 'merged.stl' });
    let bossZ = [];
    for (let i = 0; i < merged.vertexCount; i++) {
      const [x, y, z] = [merged.positions[i * 3], merged.positions[i * 3 + 1], merged.positions[i * 3 + 2]];
      if (x >= 3 && x <= 5 && y >= 3 && y <= 5 && z > 0.5) bossZ.push(z);
    }
    bossZ = [...new Set(bossZ.map((z) => Math.round(z * 1e4) / 1e4))];
    check(bossZ.length === 1 && Math.abs(bossZ[0] - 1.4) < 1e-4, `the downloaded STL has theirs' boss height (z = ${bossZ.join(', ')})`);
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await page.close();

    dog.mark('2. thin-wall example');
    // 2. Collision example: select by clicking the region in 3D, resolve with a key.
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p2.goto(`${origin}/?mode=merge&demo=thin-wall`);
    await ready(p2);
    h = await hook(p2);
    check(h.merge?.conflicts.length === 1 && h.merge.conflicts[0].kinds.collision > 0, 'thin wall: one collision conflict');
    await p2.keyboard.press('Escape');
    h = await hook(p2);
    check(h.merge?.selected === null, 'Escape clears the selection');
    const at = h.merge?.conflicts[0].screen;
    const box = await p2.locator('canvas').boundingBox();
    if (at && box) await p2.mouse.click(box.x + at[0], box.y + at[1]);
    h = await hook(p2);
    check(!!at && h.merge?.selected === 0, `clicking the orange region in the 3D view selects it (at ${at?.map(Math.round)})`);
    await colours(p2, 'merge-thin-wall-selected.png');
    await settle(p2, () => p2.keyboard.press('1'));
    h = await hook(p2);
    check(h.merge?.conflicts[0].resolution === 'ours' && h.merge.warnings.length === 0, 'key "1" resolves it to ours, with no warning');
    await p2.close();

    dog.mark('3. mixed-choices example');
    // 3. Two conflicts whose MIXED resolution collides → a warning.
    const p3 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p3.goto(`${origin}/?mode=merge&demo=mixed-choices`);
    await ready(p3);
    h = await hook(p3);
    check(h.merge?.conflicts.length === 2, 'mixed choices: two move-move conflicts');
    await settle(p3, () => p3.click('[data-conflict="0"] [data-pick="ours"]'));
    await settle(p3, () => p3.click('[data-conflict="1"] [data-pick="theirs"]'));
    h = await hook(p3);
    check(h.merge?.unresolved === 0 && h.merge.warnings.length === 1, `ours for one, theirs for the other → a collision warning (unresolved ${h.merge?.unresolved}, warnings ${JSON.stringify(h.merge?.warnings)}, resolutions ${h.merge?.conflicts.map((c) => c.resolution)})`);
    check(await p3.locator('.merge-warning').isVisible(), 'the warning is shown in the panel');
    await colours(p3, 'merge-mixed-warning.png');
    await settle(p3, () => p3.click('[data-all="ours"]'));
    h = await hook(p3);
    check(h.merge?.warnings.length === 0 && h.merge.conflicts.every((c) => c.resolution === 'ours'), '"All ours" is consistent: no warning');
    await p3.close();
  } finally {
    await browser.close();
  }
} catch (err) {
  console.error(err);
  failures++;
} finally {
  cli.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? 'e2e-merge: PASS' : `e2e-merge: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
