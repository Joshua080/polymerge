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
  console.log('e2e-view: PASS (screenshot: apps/web/e2e/screenshots/cli-view.png)');
} finally {
  await browser.close();
  cli.kill();
}
