#!/usr/bin/env node
/**
 * polymerge viewer smoke test.
 *
 *   node apps/web/e2e/smoke.mjs [--mock] [--case <id> ...] [--all] [--build] [--timeout <ms>] [--verbose]
 *                               [--trace] [--repeat <n>]
 *
 * --trace prints every browser call's duration per case and a per-step summary (--trace-live
 * also announces each call on stderr as it starts); --repeat runs
 * the targets n times over (stress runs hunting intermittent stalls). Every case has a hard
 * deadline that names the call it is stuck in; the browser is then discarded (its process group
 * killed if close() hangs) and relaunched. --simulate-hang <step> self-tests that path.
 * Background: DEVLOG session 3, milestone 4 (a stalled GPU process stops frames; an unbounded
 * frame wait turned that into an infinite hang).
 *
 * Serves apps/web/dist with `vite preview` (building first only if dist/ is missing, or with
 * --build), opens each target in headless Chromium (WebGL via SwiftShader), waits for
 * body[data-state="ready"], checks the window.__POLYMERGE__ hook, verifies the canvas is not
 * blank and shows the diff colours, clicks the model to exercise vertex inspection, and saves
 * PNGs to apps/web/e2e/screenshots/. Exits non-zero on any failure.
 *
 * Default target set: --all when fixtures/manifest.json exists, otherwise --mock.
 */
import { execFileSync } from 'node:child_process';
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
  const opts = {
    mock: false,
    all: false,
    cases: [],
    build: false,
    timeout: 120_000,
    verbose: false,
    trace: false,
    traceLive: false,
    repeat: 1,
    deadlineSlack: 30_000,
    simulateHang: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') opts.mock = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--build') opts.build = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--trace') opts.trace = true;
    else if (a === '--trace-live') opts.traceLive = opts.trace = true;
    else if (a === '--repeat') opts.repeat = Number(argv[++i]);
    else if (a === '--deadline-slack') opts.deadlineSlack = Number(argv[++i]);
    else if (a === '--simulate-hang') opts.simulateHang = argv[++i];
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
  const text =
    'usage: node apps/web/e2e/smoke.mjs [--mock] [--case <id> ...] [--all] [--build] [--timeout <ms>] [--verbose] [--trace] [--repeat <n>]';
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

/**
 * PIDs of the browsers this process launched (Playwright starts each in its own process group).
 * Used to kill a browser whose close() hangs — e.g. with a stalled GPU process — so that a
 * relaunch really starts fresh. POSIX only; elsewhere it finds nothing and nothing is killed.
 */
function childBrowserPids() {
  try {
    return execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => /chrom|headless_shell/i.test(l))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

/** Close a browser; if that does not finish in 5 s, kill its whole process group. */
async function discardBrowser(browser, pids) {
  const closed = await Promise.race([
    browser.close().then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (closed) return;
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
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

/**
 * Every browser call of a case goes through `trace.step`, which records the step's name and
 * duration: if a case ever hangs again, the per-case deadline reports exactly which call hung
 * (and `--trace` prints every step's timing).
 */
function makeTrace(simulateHang, live, caseName) {
  const trace = { current: 'start', since: Date.now(), steps: [] };
  trace.step = async (name, fn) => {
    trace.current = name;
    trace.since = Date.now();
    if (live) process.stderr.write(`  › ${caseName}: ${name}\n`);
    try {
      // Self-test of the deadline path: --simulate-hang <step> makes that step never finish.
      if (name === simulateHang) await new Promise(() => {});
      return await fn();
    } catch (err) {
      trace.failed ??= name;
      throw err;
    } finally {
      trace.steps.push([name, Date.now() - trace.since]);
      trace.current = `after ${name}`;
    }
  };
  return trace;
}

/** Two animation frames, but never more than `ms` (a stalled compositor must not hang the test). */
const settleFrames = (page, ms = 3000) =>
  page.evaluate(
    (limit) =>
      new Promise((resolve) => {
        const done = () => resolve(undefined);
        requestAnimationFrame(() => requestAnimationFrame(done));
        setTimeout(done, limit);
      }),
    ms,
  );

async function runTarget(browser, baseUrl, target, opts, trace) {
  const failures = [];
  const warnings = [];
  const logs = [];
  const context = await trace.step('newContext', () => browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }));
  // Explicit bound for every action that takes a timeout (screenshots, locator waits, boxes).
  context.setDefaultTimeout(Math.min(30_000, opts.timeout));
  const page = await trace.step('newPage', () => context.newPage());
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on('crash', () => {
    logs.push('[crash] the renderer process crashed');
    failures.push('renderer crashed');
  });
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
    await trace.step('goto', () => page.goto(report.url, { waitUntil: 'load' }));
    await trace.step('wait ready', () =>
      page.waitForFunction(() => ['ready', 'error'].includes(document.body.dataset.state), null, {
        timeout: opts.timeout,
        polling: 100,
      }),
    );
    report.ms = Date.now() - t0;
    const hook = await trace.step('read hook', () => page.evaluate(() => window.__POLYMERGE__));
    report.hook = hook;
    if (hook.state === 'error') {
      failures.push(`viewer reported error: ${hook.error}`);
      await trace.step('screenshot (error)', () => page.screenshot({ path: path.join(shotsDir, `${target.name}.png`) }));
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
      const options = await trace.step('read examples', () => page.$$eval('#examples option', (os) => os.map((o) => o.value).filter(Boolean)));
      if (!options.includes(target.caseId)) failures.push(`examples select does not list "${target.caseId}" (${options.length} options)`);
    }
    if (target.expect?.acceptableTiers && !target.expect.acceptableTiers.includes(hook.tier)) {
      warnings.push(`engine chose tier ${hook.tier}; manifest expects ${target.expect.acceptableTiers.join('/')}`);
    }

    // --- pixels ------------------------------------------------------------------------
    await trace.step('frames', () => settleFrames(page));
    await trace.step('screenshot', () => page.screenshot({ path: path.join(shotsDir, `${target.name}.png`) }));
    const canvas = page.locator('canvas.viewer-canvas');
    // Hide HUD overlays (the legend has colour swatches) so only WebGL pixels are analysed.
    const bare = await trace.step('hide HUD', () => page.addStyleTag({ content: '.stage > :not(.viewport) { visibility: hidden !important; }' }));
    const png = await trace.step('canvas screenshot', () => canvas.screenshot());
    await trace.step('show HUD', () => bare.evaluate((n) => n.remove()));
    const px = await trace.step('analyse pixels', () => analyzePng(page, png));
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
      const box = await trace.step('canvas box', () => canvas.boundingBox());
      await trace.step('click', () => page.mouse.click(box.x + px.click.x, box.y + px.click.y));
      try {
        await trace.step('wait selection', () => page.waitForFunction(() => !!window.__POLYMERGE__.selection, null, { timeout: 5000 }));
        const sel = await trace.step('read selection', () => page.evaluate(() => window.__POLYMERGE__.selection));
        report.selection = sel;
        if (!['base', 'target'].includes(sel.side) || !Number.isInteger(sel.index)) failures.push('selection malformed');
        if (!(await trace.step('inspector visible', () => page.locator('.inspector-card').isVisible()))) failures.push('inspector card not visible after click');
        await trace.step('frames', () => settleFrames(page));
        await trace.step('screenshot (inspect)', () => page.screenshot({ path: path.join(shotsDir, `${target.name}-inspect.png`) }));
      } catch {
        (target.mock ? failures : warnings).push(`clicking the model at (${px.click.x}, ${px.click.y}) selected no vertex`);
      }
    } else {
      (target.mock ? failures : warnings).push('no solid surface area found to click');
    }
  } catch (err) {
    failures.push(`${err.message.split('\n')[0]} (in "${trace.failed ?? trace.current}")`);
    report.hook ??= await trace.step('read hook (after error)', () => page.evaluate(() => window.__POLYMERGE__)).catch(() => undefined);
    await trace.step('screenshot (after error)', () => page.screenshot({ path: path.join(shotsDir, `${target.name}.png`) })).catch(() => {});
  } finally {
    await trace.step('close', () => context.close());
  }
  return { ...report, failures, warnings, logs, steps: trace.steps };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  const once = resolveTargets(opts, manifest);
  if (once.length === 0) throw new Error('nothing to test (empty manifest?)');
  // --repeat n: the same targets n times over (a stress run hunting intermittent stalls).
  const targets = Array.from({ length: Math.max(1, opts.repeat) }, () => once).flat();
  fs.mkdirSync(shotsDir, { recursive: true });
  await ensureBuild(opts.build);
  const { server, url } = await startPreview();
  let browser;
  let failed = 0;
  const stepStats = {};
  try {
    browser = await launchBrowser();
    let browserPids = childBrowserPids();
    console.log(`smoke: ${targets.length} target(s) against ${url} (${browser.version()})`);
    for (const target of targets) {
      // Hard per-case deadline: a hung browser call (seen once with SwiftShader) must fail the
      // case loudly instead of stalling the whole run. The browser is relaunched afterwards.
      const deadline = opts.timeout + opts.deadlineSlack;
      const trace = makeTrace(opts.simulateHang, opts.traceLive, target.name);
      let timer;
      const hung = new Promise((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              name: target.name,
              hook: undefined,
              failures: [
                `hung: no result within ${deadline} ms — stuck in "${trace.current}" for ${Date.now() - trace.since} ms ` +
                  `(browser connected: ${browser.isConnected()}; steps done: ${trace.steps.map(([n, ms]) => `${n} ${ms}ms`).join(', ')})`,
              ],
              warnings: [],
              logs: [],
            }),
          deadline,
        );
      });
      const r = await Promise.race([runTarget(browser, url, target, opts, trace), hung]);
      clearTimeout(timer);
      for (const [name, ms] of r.steps ?? []) {
        const agg = (stepStats[name] ??= { n: 0, total: 0, max: 0, maxCase: '' });
        agg.n++;
        agg.total += ms;
        if (ms > agg.max) {
          agg.max = ms;
          agg.maxCase = r.name;
        }
      }
      if (opts.trace) console.log(`     steps: ${(r.steps ?? []).map(([n, ms]) => `${n} ${ms}`).join(' · ')}`);
      if (r.failures.some((f) => f.startsWith('hung:'))) {
        const before = new Set(browserPids);
        await discardBrowser(browser, browserPids);
        browser = await launchBrowser();
        browserPids = childBrowserPids().filter((pid) => !before.has(pid));
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
  if (opts.trace) {
    console.log('smoke: step timings (count · mean · max @ case)');
    for (const [name, a] of Object.entries(stepStats)) {
      console.log(`  ${name.padEnd(22)} ${String(a.n).padStart(4)} · ${(a.total / a.n).toFixed(0).padStart(5)} ms · ${String(a.max).padStart(5)} ms @ ${a.maxCase}`);
    }
  }
  console.log(`smoke: ${targets.length - failed}/${targets.length} passed · screenshots in ${path.relative(process.cwd(), shotsDir) || shotsDir}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`smoke: ${err.stack || err}`);
  process.exit(1);
});
