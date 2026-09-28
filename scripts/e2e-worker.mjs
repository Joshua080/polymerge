#!/usr/bin/env node
/**
 * Evidence that the viewer stays responsive while a LARGE diff runs:
 *  - generates a ~40k-vertex model pair (re-indexed + shuffled, so Tier 2 has real work),
 *  - serves it with `polymerge view`, opens it in headless Chromium, and records the main
 *    thread's LONG TASKS (PerformanceObserver 'longtask') while the diff runs,
 *  - once with the Web Worker (default) and once with `?worker=0` (main-thread fallback).
 * The check is SCALE-FREE, so it holds on a slow CI runner as well as on a fast laptop: the app
 * publishes the diff's own timing window (epoch ms, measured where the diff ran), and the
 * script measures the longest stretch of that window the main thread spent inside a single
 * long task. With the worker that must stay under WORKER_MAX_BLOCKED of the window; with the
 * fallback the diff IS one main-thread task, so it must cover at least FALLBACK_MIN_BLOCKED
 * (a sanity check that the measurement sees blocking at all). Absolute times are printed for
 * information only. (So are raw frame gaps: headless Chromium rasterises WebGL in software —
 * SwiftShader — so a frame of a freshly loaded 80k-triangle model can take ~300 ms without any
 * JavaScript running.)
 *
 *   node scripts/e2e-worker.mjs      (needs `npm run build` first)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMesh, writeStl } from 'polymerge-core';
import { watchdog } from './watchdog.mjs';

/** Fractions of the diff window spent inside one main-thread long task. */
const WORKER_MAX_BLOCKED = 0.25;
const FALLBACK_MIN_BLOCKED = 0.75;
const dog = watchdog('e2e-worker', 5 * 60_000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-worker-'));

// ---- a large pair: 200×200 wavy grid; target re-indexed, faces shuffled, one bump ------------
const N = 200;
const pos = [];
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) pos.push(i, j, Math.fround(2 * Math.sin(i / 17) * Math.cos(j / 23)));
const faces = [];
for (let j = 0; j < N - 1; j++) {
  for (let i = 0; i < N - 1; i++) {
    const a = j * N + i;
    faces.push(a, a + 1, a + N + 1, a, a + N + 1, a + N);
  }
}
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const order = Array.from({ length: faces.length / 3 }, (_, k) => k);
for (let k = order.length - 1; k > 0; k--) {
  const r = Math.floor(rand() * (k + 1));
  [order[k], order[r]] = [order[r], order[k]];
}
const shuffled = order.flatMap((k) => faces.slice(k * 3, k * 3 + 3));
const moved = pos.slice();
moved[(100 * N + 100) * 3 + 2] += 1;
fs.writeFileSync(path.join(dir, 'base.stl'), writeStl(createMesh(pos, faces)));
fs.writeFileSync(path.join(dir, 'target.stl'), writeStl(createMesh(moved, shuffled)));

async function measure(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // Record the longest rAF gap from the moment the page starts until the diff is ready.
  await page.addInitScript(() => {
    const w = window;
    w.__gaps = { max: 0, frames: 0, longTasks: [] };
    try {
      new PerformanceObserver((list) => {
        // Absolute epoch times, comparable with the diff window the worker reports.
        for (const e of list.getEntries()) w.__gaps.longTasks.push([performance.timeOrigin + e.startTime, e.duration]);
      }).observe({ type: 'longtask' });
    } catch {}
    let last = performance.now();
    const tick = (t) => {
      const gap = t - last;
      last = t;
      if (document.body?.dataset.state === 'loading' || document.body?.dataset.state === 'idle') {
        w.__gaps.frames++;
        const phase = document.querySelector('.loading-msg')?.textContent ?? '';
        (w.__gaps.log ??= []).push([Math.round(gap), phase]);
        if (gap > w.__gaps.max && w.__gaps.frames > 3) {
          w.__gaps.max = gap;
          w.__gaps.phase = phase;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForSelector('body[data-state="ready"], body[data-state="error"]', { timeout: 180_000 });
  const out = await page.evaluate(() => ({ hook: window.__POLYMERGE__, gaps: window.__gaps }));
  await page.close();
  return { ...out, ms: Date.now() - t0 };
}

const cli = spawn(process.execPath, [path.join(root, 'packages/cli/dist/cli.js'), 'view', path.join(dir, 'base.stl'), path.join(dir, 'target.stl'), '--no-open', '--port', '0'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
});
dog.onTimeout(() => cli.kill());
let failures = 0;
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
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  try {
    dog.mark('worker run');
    const w = await measure(browser, url);
    dog.mark('main-thread run');
    const m = await measure(browser, `${url}&worker=0`);
    // Longest stretch of the diff window [a, b] the main thread spent inside one long task.
    const blocked = (r) => {
      const [a, b] = r.hook.diffWindow ?? [0, 0];
      let ms = 0;
      for (const [s, d] of r.gaps.longTasks) ms = Math.max(ms, Math.min(s + d, b) - Math.max(s, a));
      return { ms, window: b - a, fraction: b > a ? ms / (b - a) : NaN };
    };
    const line = (label, r) => {
      const x = blocked(r);
      return (
        `${label}: engine=${r.hook.engine} tier=${r.hook.tier} moved=${r.hook.stats?.vertices.moved} ready in ${r.ms} ms, ` +
        `diff ${x.window.toFixed(0)} ms, main thread blocked for ${x.ms.toFixed(0)} ms of it (${(100 * x.fraction).toFixed(1)}%), ` +
        `longest frame gap ${r.gaps.max.toFixed(0)} ms (${r.gaps.frames} frames)`
      );
    };
    console.log(line('worker   ', w));
    if (process.env.GAPS) console.log('gaps>60ms', JSON.stringify(w.gaps.log.filter(([g]) => g > 60)), 'longtasks', JSON.stringify(w.gaps.longTasks));
    console.log(line('main-only', m));
    const ok = (cond, label) => {
      console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
      if (!cond) failures++;
    };
    ok(w.hook.state === 'ready' && w.hook.engine === 'worker', 'the diff ran in the Web Worker');
    ok(w.hook.stats?.vertices.moved === 1 && w.hook.tier === 2, 'worker result is correct (Tier 2, 1 moved vertex)');
    ok(Array.isArray(w.hook.diffWindow) && Array.isArray(m.hook.diffWindow), 'both runs published their diff window');
    ok(blocked(w).fraction < WORKER_MAX_BLOCKED, `worker diff: main thread blocked < ${100 * WORKER_MAX_BLOCKED}% of the diff window`);
    ok(
      blocked(m).fraction >= FALLBACK_MIN_BLOCKED,
      `main-thread fallback: blocked ≥ ${100 * FALLBACK_MIN_BLOCKED}% of the diff window (sanity check of the measurement)`,
    );
    ok(m.hook.engine === 'main' && m.hook.stats?.vertices.moved === 1, 'main-thread fallback gives the same result');
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
console.log(failures === 0 ? 'e2e-worker: PASS' : `e2e-worker: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
