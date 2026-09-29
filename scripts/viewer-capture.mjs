/**
 * Rendering the REAL viewer in headless Chromium, shared by everything that makes images from it:
 * the README images (scripts/readme-images.mjs) and the GitHub Action's pull-request images
 * (action/render.mjs).
 *
 *   const viewer = await startViewer();        // the built CLI's local server (`polymerge demo`)
 *   const browser = await launchBrowser();     // headless Chromium, software WebGL (SwiftShader)
 *   const page = await browser.newPage();
 *   await page.goto(`${viewer.origin}/?case=moved-part`);
 *   await waitReady(page);                     // body[data-state="ready"]
 *   await page.screenshot({ path: 'out.png' });
 *   await browser.close();
 *   viewer.stop();
 *
 * Needs `npm run build` first (the CLI and the viewer it serves).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** WebGL without a GPU: SwiftShader, which headless Chromium otherwise refuses to use. */
export const CHROMIUM_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];

/**
 * Start the built CLI's viewer server (`polymerge demo --no-open --port 0` by default: the viewer
 * with no files of its own) and resolve once it prints its URL. `stop()` kills it.
 */
export async function startViewer({ cli = path.join(root, 'packages/cli/dist/cli.js'), args = ['demo'], timeoutMs = 15_000 } = {}) {
  const child = spawn(process.execPath, [cli, ...args, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  try {
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`the viewer server printed no URL within ${timeoutMs} ms`)), timeoutMs);
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/https?:\/\/\S+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the viewer server exited early (code ${code})`));
      });
    });
    return { url, origin: new URL(url).origin, process: child, stop };
  } catch (err) {
    stop();
    throw err;
  }
}

/** Headless Chromium with software WebGL. */
export function launchBrowser(options = {}) {
  return chromium.launch({ headless: true, ...options, args: [...CHROMIUM_ARGS, ...(options.args ?? [])] });
}

/**
 * Wait until the viewer has settled: `body[data-state="ready"]`, or `"error"` when `allowError`
 * (then the caller reads the hook for the message). Resolves the state.
 */
export async function waitReady(page, { timeout = 120_000, allowError = false } = {}) {
  const selector = allowError ? 'body[data-state="ready"], body[data-state="error"]' : 'body[data-state="ready"]';
  await page.waitForSelector(selector, { timeout });
  return page.evaluate(() => document.body.dataset.state);
}

/**
 * Bound a promise that has no timeout of its own (`page.evaluate`, `newPage`, …): a stalled GPU
 * process stops frames while the page's JavaScript stays alive, and such calls would wait forever.
 */
export function bounded(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The viewer's automation hook (`window.__POLYMERGE__`), bounded. */
export function readHook(page, ms = 10_000) {
  return bounded(
    page.evaluate(() => /** @type {any} */ (window).__POLYMERGE__),
    ms,
    'read the viewer hook',
  );
}
