#!/usr/bin/env node
/**
 * The viewer as a static site on a SUBPATH (GitHub Pages serves a project at /<repo>/), opening
 * models from OTHER sites, with no polymerge server involved:
 *  1. serves the built viewer (apps/web/dist) from one origin under /polymerge/, as plain files;
 *  2. serves two models from a second origin that allows cross-origin reads (like
 *     raw.githubusercontent.com), and a third that does not;
 *  3. in headless Chromium checks that
 *       - the page, its worker and its example fixtures all load under the subpath;
 *       - ?base=&target= with absolute URLs on the second origin runs a real diff in the worker,
 *         and the panel says which site the models came from;
 *       - the merge review opens from three such URLs too;
 *       - a site that blocks cross-origin reads gives an error that says so, not a bare "Failed to fetch".
 *
 *   node scripts/e2e-pages.mjs      (needs `npm run build` first)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounded, launchBrowser, readHook, waitReady } from './viewer-capture.mjs';
import { watchdog } from './watchdog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/web/dist');
const plate = path.join(root, 'examples/plate');
const dog = watchdog('e2e-pages', 4 * 60_000);
const servers = [];

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.stl': 'model/stl', '.obj': 'model/obj' };

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

dog.onTimeout(() => servers.forEach((s) => s.close()));
dog.mark('start servers');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('e2e-pages: apps/web/dist is missing; run `npm run build` first');
  process.exit(1);
}

// 1. The site: dist/ as plain static files under /polymerge/ — nothing else.
const site = await listen((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (!pathname.startsWith('/polymerge/')) return void res.writeHead(404).end('outside the site');
  let rel = decodeURIComponent(pathname.slice('/polymerge/'.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(dist, rel);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
});

// 2. Model hosts: one allows cross-origin reads, one does not.
const modelFile = (name) => fs.readFileSync(path.join(plate, name));
const open = await listen((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  if (!/^(base|ours|theirs)\.stl$/.test(name)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'model/stl', 'access-control-allow-origin': '*' }).end(modelFile(name));
});
const closed = await listen((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1);
  if (!/^(base|ours)\.stl$/.test(name)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'model/stl' }).end(modelFile(name)); // no Access-Control-Allow-Origin
});

dog.mark('launch browser');
const browser = await launchBrowser();
dog.onTimeout(() => browser.close().catch(() => {}));

async function open_(url, { allowError = false } = {}) {
  const page = await bounded(browser.newPage({ viewport: { width: 1280, height: 800 } }), 20_000, 'newPage');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { timeout: 30_000 });
  const state = await waitReady(page, { timeout: 90_000, allowError });
  return { page, state, errors };
}

try {
  // 3a. The viewer itself, under the subpath, with its bundled examples.
  dog.mark('example under the subpath');
  {
    const { page, state, errors } = await open_(`${site}/polymerge/?case=moved-part`);
    const hook = await readHook(page);
    check(state === 'ready', 'the viewer opens under /polymerge/ and runs a bundled example');
    check(hook?.engine === 'worker', 'the diff runs in the Web Worker, loaded from under the subpath');
    check(String(hook?.tierName ?? '').startsWith('Tier'), `a tier was chosen (${hook?.tierName})`);
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await page.close();
  }

  // 3b. Models from another site, by absolute URL.
  dog.mark('models from another site');
  {
    const q = new URLSearchParams({ base: `${open}/base.stl`, target: `${open}/ours.stl` });
    const { page, state, errors } = await open_(`${site}/polymerge/?${q}`);
    const hook = await readHook(page);
    check(state === 'ready' && hook?.source === 'url', 'two models fetched from another origin diff without any polymerge server');
    check(hook?.engine === 'worker' && hook?.stats?.vertices?.moved === 10, `the diff is right (10 moved vertices, got ${hook?.stats?.vertices?.moved})`);
    const host = new URL(open).host;
    const loadedFrom = await page.evaluate(() => {
      const row = [...document.querySelectorAll('table.meshes tr')].find((r) => r.querySelector('th')?.textContent === 'Loaded from');
      return row ? [...row.querySelectorAll('td')].map((c) => c.textContent) : null;
    });
    check(JSON.stringify(loadedFrom) === JSON.stringify([host, host]), `the panel says where the models came from (${JSON.stringify(loadedFrom)})`);
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await page.close();
  }

  // 3c. The merge review from three URLs on another site: the one move-move conflict of the plate example.
  dog.mark('merge review by link');
  {
    const q = new URLSearchParams({ mode: 'merge', base: `${open}/base.stl`, ours: `${open}/ours.stl`, theirs: `${open}/theirs.stl` });
    const { page, state, errors } = await open_(`${site}/polymerge/?${q}`);
    const hook = await readHook(page);
    check(state === 'ready' && hook?.merge?.conflicts?.length === 1, `three models from another origin open the merge review with its one conflict (${hook?.merge?.conflicts?.length})`);
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
    await page.close();
  }

  // 3d. A site that does not allow other sites to read its files.
  dog.mark('blocked cross-origin');
  {
    const q = new URLSearchParams({ base: `${closed}/base.stl`, target: `${closed}/ours.stl` });
    const { page, state } = await open_(`${site}/polymerge/?${q}`, { allowError: true });
    const hook = await readHook(page);
    check(state === 'error', 'a model host without CORS ends in the error state');
    check(/CORS/.test(hook?.error ?? ''), `the error says why (${JSON.stringify(hook?.error)})`);
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
  servers.forEach((s) => s.close());
}

if (failures > 0) {
  console.error(`e2e-pages: FAIL (${failures})`);
  process.exit(1);
}
console.log('e2e-pages: PASS');
