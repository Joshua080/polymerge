#!/usr/bin/env node
/**
 * Evidence that the viewer stays responsive while a LARGE diff runs:
 *  - generates a ~40k-vertex model pair (re-indexed + shuffled, so Tier 2 has real work),
 *  - serves it with `polymerge view`, opens it in headless Chromium, and records the main
 *    thread's LONG TASKS (PerformanceObserver 'longtask') while the diff runs,
 *  - once with the Web Worker (default) and once with `?worker=0` (main-thread fallback).
 * Passes when the diff ran in the worker and no main-thread task during the diff phase took
 * longer than MAX_TASK_MS. (Raw frame gaps are printed for information only: headless
 * Chromium rasterises WebGL in software — SwiftShader — so a frame of a freshly loaded
 * 80k-triangle model can take ~300 ms without any JavaScript running.)
 *
 *   node scripts/e2e-worker.mjs      (needs `npm run build` first)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMesh, writeStl } from '@polymerge/core';

const MAX_TASK_MS = 250;
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
        for (const e of list.getEntries()) w.__gaps.longTasks.push([Math.round(e.startTime), Math.round(e.duration), document.querySelector('.loading-msg')?.textContent ?? '']);
      }).observe({ type: 'longtask', buffered: true });
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
    const w = await measure(browser, url);
    const m = await measure(browser, `${url}&worker=0`);
    // Longest main-thread task while the diff was computing (after "Computing diff…" appeared).
    const diffTask = (r) => Math.max(0, ...r.gaps.longTasks.filter(([, , phase]) => phase !== 'Loading models…').map(([, d]) => d));
    const line = (label, r) =>
      `${label}: engine=${r.hook.engine} tier=${r.hook.tier} moved=${r.hook.stats?.vertices.moved} ready in ${r.ms} ms, ` +
      `longest main-thread task during the diff ${diffTask(r)} ms, longest frame gap ${r.gaps.max.toFixed(0)} ms (${r.gaps.frames} frames)`;
    console.log(line('worker   ', w));
    if (process.env.GAPS) console.log('gaps>60ms', JSON.stringify(w.gaps.log.filter(([g]) => g > 60)), 'longtasks', JSON.stringify(w.gaps.longTasks));
    console.log(line('main-only', m));
    const ok = (cond, label) => {
      console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
      if (!cond) failures++;
    };
    ok(w.hook.state === 'ready' && w.hook.engine === 'worker', 'the diff ran in the Web Worker');
    ok(w.hook.stats?.vertices.moved === 1 && w.hook.tier === 2, 'worker result is correct (Tier 2, 1 moved vertex)');
    ok(diffTask(w) < MAX_TASK_MS, `main thread never blocked > ${MAX_TASK_MS} ms during the worker diff`);
    ok(diffTask(m) > diffTask(w), 'the main-thread fallback blocks longer (sanity check of the measurement)');
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
