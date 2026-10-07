#!/usr/bin/env node
/**
 * End-to-end check of the full local pipeline through the CLI:
 *   polymerge view <base> <target> --no-open  →  local server  →  headless Chromium
 *   →  real loadMesh + diffMeshes in the page  →  WebGL render.
 *
 *   node scripts/e2e-view.mjs [<base> <target>]
 *
 * $POLYMERGE_CLI points it at another cli.js (e2e-pack uses it for the npm-installed package).
 * Needs `npm run build` first. Saves apps/web/e2e/screenshots/cli-view.png and exits
 * non-zero on failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { watchdog } from './watchdog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [base, target] =
  process.argv.length >= 4
    ? process.argv.slice(2, 4)
    : ['fixtures/cases/mixed-topology-edit/base.obj', 'fixtures/cases/mixed-topology-edit/target.obj'];

const cliJs = process.env.POLYMERGE_CLI ?? path.join(root, 'packages/cli/dist/cli.js');
const cli = spawn(process.execPath, [cliJs, 'view', base, target, '--no-open', '--port', '0'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const dog = watchdog('e2e-view', 3 * 60_000);
dog.onTimeout(() => cli.kill());

/**
 * Two points on the model, in page coordinates: model pixels (unlike the background colour of the
 * canvas's corners) far apart along the middle row band of the 3D view.
 */
async function modelPoints(page) {
  const canvas = await page.$('canvas.viewer-canvas');
  const box = await canvas.boundingBox();
  const png = await page.screenshot({ clip: box });
  const found = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const bg = [d[0], d[1], d[2]];
    const model = (x, y) => {
      const i = (y * c.width + x) * 4;
      return Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 60;
    };
    // The widest run of model pixels on rows near the middle; its points 20% in from each end.
    let best = null;
    for (let y = Math.floor(c.height * 0.35); y < c.height * 0.65; y += 4) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < c.width; x++) if (model(x, y)) (first < 0 && (first = x), (last = x));
      if (first >= 0 && (!best || last - first > best.last - best.first)) best = { y, first, last };
    }
    if (!best) return null;
    const w = best.last - best.first;
    const pick = (x) => {
      // Nudge onto a model pixel.
      for (let dx = 0; dx < 40; dx++) for (const s of [1, -1]) if (model(x + s * dx, best.y)) return [x + s * dx, best.y];
      return [x, best.y];
    };
    return [pick(Math.round(best.first + 0.2 * w)), pick(Math.round(best.last - 0.2 * w))];
  }, png.toString('base64'));
  if (!found) fail('no model pixels found to click');
  return found.map(([x, y]) => [box.x + x, box.y + y]);
}

const fail = (msg) => {
  console.error(`e2e-view: FAIL — ${msg}`);
  cli.kill();
  process.exit(1);
};

const url = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('CLI did not print a URL within 15 s')), 15_000);
  cli.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/https?:\/\/\S+/);
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  });
  cli.on('exit', (code) => reject(new Error(`CLI exited early with code ${code}`)));
}).catch((e) => fail(e.message));

console.log(`e2e-view: CLI serving ${url}`);
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  dog.mark('load');
  await page.goto(url);
  await page.waitForSelector('body[data-state="ready"], body[data-state="error"]', { timeout: 120_000 });
  dog.mark('read hook');
  const hook = await page.evaluate(() => window.__POLYMERGE__);
  if (hook.state !== 'ready') fail(`viewer error: ${hook.error}`);
  const tierLine = consoleLines.find((l) => /resolved by Tier \d/.test(l));
  if (!tierLine) fail('engine did not log the accepted tier to the browser console');
  const shots = path.join(root, 'apps/web/e2e/screenshots');
  fs.mkdirSync(shots, { recursive: true });
  dog.mark('screenshot');
  await page.screenshot({ path: path.join(shots, 'cli-view.png') });
  console.log(`e2e-view: ready — ${hook.tierName}`);
  console.log(`e2e-view: browser console → ${tierLine}`);
  console.log(`e2e-view: base "${hook.base?.sourceName}" → target "${hook.target?.sourceName}"`);
  console.log(`e2e-view: vertices ${JSON.stringify(hook.stats?.vertices)} faces ${JSON.stringify(hook.stats?.faces)}`);

  // ---- The review tools: section, before / after, measure.
  const review = () => page.evaluate(() => window.__POLYMERGE__.review);
  dog.mark('tools: section');
  await page.keyboard.press('s');
  await page.waitForFunction(() => window.__POLYMERGE__.review?.section?.target, null, { timeout: 15_000 });
  const cut = (await review()).section;
  if (!(cut.target.outlines + cut.target.open > 0)) fail(`the section cuts nothing (${JSON.stringify(cut)})`);
  console.log(`e2e-view: section ${cut.axis} = ${cut.value.toFixed(3)}: ${JSON.stringify(cut.target)} (before ${JSON.stringify(cut.base)})`);
  await page.keyboard.press('s');
  if ((await review()).section !== null) fail('the section tool does not turn off');

  dog.mark('tools: before / after');
  await page.keyboard.press('c');
  if ((await review()).compare !== 0.5) fail(`before / after does not start in the middle (${(await review()).compare})`);
  const handle = await page.$('.compare-handle');
  const stage = await (await page.$('.stage')).boundingBox();
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.3, stage.y + stage.height / 2, { steps: 6 });
  await page.mouse.up();
  const split = (await review()).compare;
  if (!(Math.abs(split - 0.3) < 0.02)) fail(`dragging the divider to 30% left it at ${split}`);
  await page.screenshot({ path: path.join(shots, 'cli-view-compare.png') });
  await page.keyboard.press('c');

  dog.mark('tools: measure');
  await page.keyboard.press('m');
  const [p1, p2] = await modelPoints(page);
  await page.mouse.click(...p1);
  await page.mouse.click(...p2);
  const m = (await review()).measure;
  if (!(m?.points?.length === 2 && m.distance > 0)) fail(`measuring between two clicks on the model gave ${JSON.stringify(m)}`);
  const label = await page.textContent('.measure-label');
  console.log(`e2e-view: measured ${m.distance.toFixed(4)} (label "${label}")`);
  await page.screenshot({ path: path.join(shots, 'cli-view-measure.png') });
  await page.keyboard.press('Escape');
  if ((await review()).measure.points.length !== 0) fail('Esc does not clear the measurement');
  console.log('e2e-view: PASS (screenshot: apps/web/e2e/screenshots/cli-view.png)');
} finally {
  await browser.close();
  cli.kill();
}
