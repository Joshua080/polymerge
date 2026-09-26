#!/usr/bin/env node
/**
 * polymerge viewer smoke test.
 *
 *   node apps/web/e2e/smoke.mjs [--mock] [--case <id> ...] [--all] [--build] [--timeout <ms>] [--verbose]
 *
 * Serves apps/web/dist with `vite preview` (building first only if dist/ is missing, or with
 * --build), opens each target in headless Chromium (WebGL via SwiftShader), waits for
 * body[data-state="ready"], checks the window.__POLYMERGE__ hook, verifies the canvas is not
 * blank and shows the diff colours, clicks the model to exercise vertex inspection, and saves
 * PNGs to apps/web/e2e/screenshots/. Exits non-zero on any failure.
 *
 * Default target set: --all when fixtures/manifest.json exists, otherwise --mock.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const repoRoot = path.resolve(webDir, '../..');
const distDir = path.join(webDir, 'dist');
const shotsDir = path.join(here, 'screenshots');
const manifestPath = path.join(repoRoot, 'fixtures', 'manifest.json');

// DIFF_COLORS hue classes (see packages/core/src/types.ts): green 142°, red 0°, yellow 50°.
const HUES = {
  added: [115, 165],
  removed: [-18, 14],
  modified: [38, 64],
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { mock: false, all: false, cases: [], build: false, timeout: 120_000, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') opts.mock = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--build') opts.build = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--case') {
      const id = argv[++i];
      if (!id) usage('--case needs an id');
      opts.cases.push(id);
    } else if (a.startsWith('--case=')) opts.cases.push(a.slice(7));
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown argument: ${a}`);
  }
  return opts;
}

function usage(error) {
  const text = 'usage: node apps/web/e2e/smoke.mjs [--mock] [--case <id> ...] [--all] [--build] [--timeout <ms>] [--verbose]';
  if (error) {
    console.error(`smoke: ${error}\n${text}`);
    process.exit(2);
  }
  console.log(text);
  process.exit(0);
}

function readManifest() {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.warn(`smoke: fixtures/manifest.json is not valid JSON (${err.message})`);
    return null;
  }
}

function resolveTargets(opts, manifest) {
  const targets = [];
  const explicit = opts.mock || opts.all || opts.cases.length > 0;
  const useMock = opts.mock || (!explicit && !manifest);
  const useAll = opts.all || (!explicit && !!manifest);
  if (useMock) {
    targets.push({ name: 'mock', query: '?mock=1', mock: true });
    targets.push({ name: 'mock-tier3', query: '?mock=3', mock: true });
  }
  const ids = [...opts.cases];
  if (useAll) {
    if (!manifest) throw new Error('--all requested but fixtures/manifest.json is missing');
    for (const c of manifest.cases) if (!ids.includes(c.id)) ids.push(c.id);
  }
  for (const id of ids) {
    const c = manifest?.cases?.find((x) => x.id === id);
    targets.push({ name: `case-${id}`, query: `?case=${encodeURIComponent(id)}`, mock: false, caseId: id, expect: c?.expect });
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function ensureBuild(force) {
  if (!force && fs.existsSync(path.join(distDir, 'index.html'))) return;
  console.log(`smoke: building ${path.relative(repoRoot, webDir)} …`);
  const { build } = await import('vite');
  await build({ root: webDir, configFile: path.join(webDir, 'vite.config.ts'), logLevel: 'warn' });
}

async function startPreview() {
  const { preview } = await import('vite');
  const port = await freePort();
  const server = await preview({
    root: webDir,
    configFile: path.join(webDir, 'vite.config.ts'),
    logLevel: 'warn',
    preview: { host: '127.0.0.1', port, strictPort: true, open: false },
  });
  return { server, url: `http://127.0.0.1:${port}/` };
}

function findChromeExecutable() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

async function launchBrowser() {
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];
  try {
    return await chromium.launch({ headless: true, args });
  } catch (err) {
    const executablePath = findChromeExecutable();
    if (!executablePath) throw err;
    console.warn(`smoke: default launch failed (${err.message.split('\n')[0]}); retrying with ${executablePath}`);
    return chromium.launch({ headless: true, args, executablePath });
  }
}

// ---------------------------------------------------------------------------
// Pixel analysis (runs in the page: decodes the PNG with the browser's own decoder)
// ---------------------------------------------------------------------------

async function analyzePng(page, png) {
  return page.evaluate(
    async ({ b64, hues }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const w = img.width;
      const h = img.height;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, w, h).data;
      const px = (x, y) => (y * w + x) * 4;
      // Background = colour of the four corners (they agree for a framed model).
      const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
      const bg = [0, 1, 2].map((k) => Math.round(corners.reduce((s, i) => s + d[i + k], 0) / 4));
      const classOf = new Uint8Array(w * h); // 0 bg, 1 neutral, 2 added, 3 removed, 4 modified, 5 other
      const counts = { model: 0, neutral: 0, added: 0, removed: 0, modified: 0, other: 0 };
      const distinct = new Set();
      let cx = 0;
      let cy = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = px(x, y);
          const r = d[i];
          const gg = d[i + 1];
          const b = d[i + 2];
          distinct.add(((r >> 3) << 10) | ((gg >> 3) << 5) | (b >> 3));
          if (Math.abs(r - bg[0]) + Math.abs(gg - bg[1]) + Math.abs(b - bg[2]) < 24) continue;
          counts.model++;
          cx += x;
          cy += y;
          const max = Math.max(r, gg, b);
          const min = Math.min(r, gg, b);
          const v = max / 255;
          const s = max === 0 ? 0 : (max - min) / max;
          let hue = 0;
          if (max !== min) {
            if (max === r) hue = (60 * (gg - b)) / (max - min);
            else if (max === gg) hue = 60 * (2 + (b - r) / (max - min));
            else hue = 60 * (4 + (r - gg) / (max - min));
          }
          const inRange = ([lo, hi]) => (lo < 0 ? hue >= 360 + lo || hue <= hi : hue >= lo && hue <= hi);
          let cls = 5;
          if (s < 0.18 && v > 0.2) cls = 1;
          else if (s >= 0.45 && v >= 0.2) {
            if (inRange(hues.added)) cls = 2;
            else if (inRange(hues.removed)) cls = 3;
            else if (inRange(hues.modified)) cls = 4;
          }
          classOf[y * w + x] = cls;
          counts[['bg', 'neutral', 'added', 'removed', 'modified', 'other'][cls]]++;
        }
      }
      // Click candidates: pixels whose 7x7 neighbourhood is entirely one surface class.
      const solid = (x, y, cls) => {
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h || classOf[yy * w + xx] !== cls) return false;
          }
        return true;
      };
      const mx = counts.model ? cx / counts.model : w / 2;
      const my = counts.model ? cy / counts.model : h / 2;
      let click = null;
      for (const cls of [4, 2, 3, 1]) {
        let best = null;
        let bestD = Infinity;
        for (let y = 4; y < h - 4; y += 3)
          for (let x = 4; x < w - 4; x += 3) {
            if (classOf[y * w + x] !== cls || !solid(x, y, cls)) continue;
            const dd = (x - mx) ** 2 + (y - my) ** 2;
            if (dd < bestD) {
              bestD = dd;
              best = { x, y, cls };
            }
          }
        if (best) {
          click = best;
          break;
        }
      }
      return { width: w, height: h, background: bg, distinctColors: distinct.size, counts, modelFraction: counts.model / (w * h), click };
    },
    { b64: png.toString('base64'), hues: HUES },
  );
}

// ---------------------------------------------------------------------------
// One target
// ---------------------------------------------------------------------------

async function runTarget(browser, baseUrl, target, opts) {
  const failures = [];
  const warnings = [];
  const logs = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => {
    logs.push(`[pageerror] ${e.stack || e.message}`);
    failures.push(`uncaught page error: ${e.message}`);
  });
  page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`);
  });

  const t0 = Date.now();
  const report = { name: target.name, url: baseUrl + target.query };
  try {
    await page.goto(report.url, { waitUntil: 'load' });
    await page.waitForFunction(() => ['ready', 'error'].includes(document.body.dataset.state), null, {
      timeout: opts.timeout,
      polling: 100,
    });
    report.ms = Date.now() - t0;
    const hook = await page.evaluate(() => window.__POLYMERGE__);
    report.hook = hook;
    if (hook.state === 'error') {
      failures.push(`viewer reported error: ${hook.error}`);
      await page.screenshot({ path: path.join(shotsDir, `${target.name}.png`) });
      return { ...report, failures, warnings, logs };
    }

    // --- hook contract -----------------------------------------------------------
    if (![1, 2, 3].includes(hook.tier)) failures.push(`hook.tier is ${JSON.stringify(hook.tier)}`);
    if (typeof hook.tierName !== 'string' || !hook.tierName) failures.push('hook.tierName missing');
    // Real diffs run in the Web Worker (the mock builds its result on the main thread by design).
    if (!target.mock && hook.engine !== 'worker') failures.push(`diff ran on "${hook.engine}", expected the Web Worker`);
    const s = hook.stats;
    const statKeys = { vertices: ['unchanged', 'moved', 'added', 'removed'], faces: ['unchanged', 'modified', 'added', 'removed'] };
    for (const [group, keys] of Object.entries(statKeys))
      for (const k of keys) if (typeof s?.[group]?.[k] !== 'number') failures.push(`hook.stats.${group}.${k} missing`);
    if (!Array.isArray(hook.attempts) || hook.attempts.length === 0) failures.push('hook.attempts empty');
    else if (!hook.attempts[hook.attempts.length - 1].accepted) failures.push('last tier attempt is not the accepted one');
    if (!hook.base || !hook.target) failures.push('hook.base / hook.target summaries missing');
    if (target.caseId) {
      if (hook.source !== `case:${target.caseId}`) failures.push(`hook.source is ${JSON.stringify(hook.source)}, expected "case:${target.caseId}"`);
      const options = await page.$$eval('#examples option', (os) => os.map((o) => o.value).filter(Boolean));
      if (!options.includes(target.caseId)) failures.push(`examples select does not list "${target.caseId}" (${options.length} options)`);
    }
    if (target.expect?.acceptableTiers && !target.expect.acceptableTiers.includes(hook.tier)) {
      warnings.push(`engine chose tier ${hook.tier}; manifest expects ${target.expect.acceptableTiers.join('/')}`);
    }

    // --- pixels ------------------------------------------------------------------------
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: path.join(shotsDir, `${target.name}.png`) });
    const canvas = page.locator('canvas.viewer-canvas');
    // Hide HUD overlays (the legend has colour swatches) so only WebGL pixels are analysed.
    const bare = await page.addStyleTag({ content: '.stage > :not(.viewport) { visibility: hidden !important; }' });
    const png = await canvas.screenshot();
    await bare.evaluate((n) => n.remove());
    const px = await analyzePng(page, png);
    report.pixels = px;
    if (px.distinctColors < 8) failures.push(`canvas looks blank (${px.distinctColors} distinct colours)`);
    if (px.modelFraction < 0.01) failures.push(`model covers only ${(px.modelFraction * 100).toFixed(2)}% of the canvas`);
    if (px.modelFraction > 0.97) failures.push('model fills the entire canvas (camera fit is off)');
    const changed = s ? s.faces.modified + s.faces.added + s.faces.removed + s.vertices.moved + s.vertices.added + s.vertices.removed : 0;
    const huePixels = px.counts.added + px.counts.removed + px.counts.modified;
    if (target.mock) {
      for (const k of ['added', 'removed', 'modified']) if (px.counts[k] < 20) failures.push(`no "${k}" colour visible (${px.counts[k]} px)`);
      if (px.counts.neutral < 100) failures.push('no neutral "unchanged" grey visible');
    } else if (changed > 0 && huePixels === 0) {
      warnings.push('diff has changes but no DIFF_COLORS hue is visible from the default view');
    }
    if (changed === 0 && huePixels > 50) warnings.push(`no changes reported but ${huePixels} diff-coloured pixels visible`);

    // --- click-to-inspect ---------------------------------------------------------------
    if (px.click) {
      const box = await canvas.boundingBox();
      await page.mouse.click(box.x + px.click.x, box.y + px.click.y);
      try {
        await page.waitForFunction(() => !!window.__POLYMERGE__.selection, null, { timeout: 5000 });
        const sel = await page.evaluate(() => window.__POLYMERGE__.selection);
        report.selection = sel;
        if (!['base', 'target'].includes(sel.side) || !Number.isInteger(sel.index)) failures.push('selection malformed');
        if (!(await page.locator('.inspector-card').isVisible())) failures.push('inspector card not visible after click');
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.screenshot({ path: path.join(shotsDir, `${target.name}-inspect.png`) });
      } catch {
        (target.mock ? failures : warnings).push(`clicking the model at (${px.click.x}, ${px.click.y}) selected no vertex`);
      }
    } else {
      (target.mock ? failures : warnings).push('no solid surface area found to click');
    }
  } catch (err) {
    failures.push(err.message.split('\n')[0]);
    report.hook ??= await page.evaluate(() => window.__POLYMERGE__).catch(() => undefined);
    await page.screenshot({ path: path.join(shotsDir, `${target.name}.png`) }).catch(() => {});
  } finally {
    await context.close();
  }
  return { ...report, failures, warnings, logs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  const targets = resolveTargets(opts, manifest);
  if (targets.length === 0) throw new Error('nothing to test (empty manifest?)');
  fs.mkdirSync(shotsDir, { recursive: true });
  await ensureBuild(opts.build);
  const { server, url } = await startPreview();
  let browser;
  let failed = 0;
  try {
    browser = await launchBrowser();
    console.log(`smoke: ${targets.length} target(s) against ${url} (${browser.version()})`);
    for (const target of targets) {
      // Hard per-case deadline: a hung browser call (seen once with SwiftShader) must fail the
      // case loudly instead of stalling the whole run. The browser is relaunched afterwards.
      const deadline = opts.timeout + 30_000;
      let timer;
      const hung = new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ name: target.name, hook: undefined, failures: [`hung: no result within ${deadline} ms (browser stalled)`], warnings: [], logs: [] }),
          deadline,
        );
      });
      const r = await Promise.race([runTarget(browser, url, target, opts), hung]);
      clearTimeout(timer);
      if (r.failures.some((f) => f.startsWith('hung:'))) {
        await Promise.race([browser.close().catch(() => {}), new Promise((res) => setTimeout(res, 5000))]);
        browser = await launchBrowser();
      }
      const h = r.hook ?? {};
      const st = h.stats;
      const line = st
        ? `tier ${h.tier} · v ${st.vertices.unchanged}/${st.vertices.moved}/${st.vertices.added}/${st.vertices.removed} · f ${st.faces.unchanged}/${st.faces.modified}/${st.faces.added}/${st.faces.removed}`
        : `state ${h.state ?? '?'}`;
      const pix = r.pixels
        ? ` · px ${(r.pixels.modelFraction * 100).toFixed(1)}% model, ${r.pixels.distinctColors} colours, hue g/r/y/grey ${r.pixels.counts.added}/${r.pixels.counts.removed}/${r.pixels.counts.modified}/${r.pixels.counts.neutral}`
        : '';
      const sel = r.selection ? ` · click → ${r.selection.side} #${r.selection.index}` : '';
      const ok = r.failures.length === 0;
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${r.name} (${r.ms ?? '?'} ms) ${line}${pix}${sel}`);
      for (const w of r.warnings) console.log(`     warn: ${w}`);
      for (const f of r.failures) console.log(`     fail: ${f}`);
      if (!ok || opts.verbose) {
        if (h.error) console.log(`     hook.error: ${h.error}`);
        for (const l of r.logs) console.log(`     ${l}`);
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
  console.log(`smoke: ${targets.length - failed}/${targets.length} passed · screenshots in ${path.relative(process.cwd(), shotsDir) || shotsDir}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`smoke: ${err.stack || err}`);
  process.exit(1);
});
