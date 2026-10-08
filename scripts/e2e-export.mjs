#!/usr/bin/env node
/**
 * Self-contained pages, end to end, in headless Chromium with every network request refused:
 *  1. `polymerge export` an OBJ pair; the page opens from disk (file://), shows the saved diff
 *     (the same numbers as `polymerge diff --json`) without computing or fetching anything, and
 *     the review tools work in it.
 *  2. `polymerge export` the STEP plate: the page needs no OpenCascade, opens Z up and lists the
 *     CAD faces ("hole Ø8 moved 5 mm").
 *  3. "Save as HTML" in an opened page writes a page that opens the same way.
 *
 *   node scripts/e2e-export.mjs     (needs `npm run build`)
 *
 * $POLYMERGE_CLI points it at another cli.js (e2e-pack: the npm-installed package).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bounded, launchBrowser, readHook, waitReady } from './viewer-capture.mjs';
import { watchdog } from './watchdog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.POLYMERGE_CLI ?? path.join(root, 'packages/cli/dist/cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-export-e2e-'));
const shots = path.join(root, 'apps/web/e2e/screenshots');
fs.mkdirSync(shots, { recursive: true });
const dog = watchdog('e2e-export', 5 * 60_000);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const polymerge = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });

dog.mark('export');
const obj = ['fixtures/cases/mixed-topology-edit/base.obj', 'fixtures/cases/mixed-topology-edit/target.obj'];
const objPage = path.join(tmp, 'mixed.html');
const said = polymerge('export', ...obj, '-o', objPage);
check(/^Wrote .*mixed\.html \([\d.]+ (KB|MB)\): base\.obj → target\.obj, Tier \d/.test(said), `export says what it wrote (${said.split('\n')[0]})`);
const expected = JSON.parse(polymerge('diff', ...obj, '--json', '-', '-q'));
const stepPage = path.join(tmp, 'plate.html');
polymerge('export', 'examples/step-plate/base.step', 'examples/step-plate/ours.step', '-o', stepPage, '-q');

dog.mark('launch browser');
const browser = await launchBrowser();
dog.onTimeout(() => browser.close().catch(() => {}));

/** Open a page from disk with the network refused; returns the page, the hook and what was refused. */
async function open(file) {
  const context = await bounded(browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true }), 20_000, 'newContext');
  const refused = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (/^(file|data|blob):/.test(url)) return route.continue();
    refused.push(url);
    return route.abort();
  });
  const page = await bounded(context.newPage(), 20_000, 'newPage');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const t0 = Date.now();
  await page.goto(pathToFileURL(file).href, { timeout: 30_000 });
  const state = await waitReady(page, { timeout: 60_000, allowError: true });
  return { context, page, state, ms: Date.now() - t0, hook: await readHook(page), refused, errors };
}

try {
  // 1. An OBJ pair.
  dog.mark('open the OBJ page');
  {
    const { context, page, state, ms, hook, refused, errors } = await open(objPage);
    check(state === 'ready' && hook.source === 'embedded', `the page opens from disk and shows its saved diff (${state}, ${ms} ms${hook.error ? `: ${hook.error}` : ''})`);
    check(JSON.stringify(hook.stats) === JSON.stringify(expected.stats) && hook.tier === expected.tier, `the same result as polymerge diff (Tier ${hook.tier}, ${JSON.stringify(hook.stats?.vertices)})`);
    check(hook.engine === undefined, 'nothing was computed in the page');
    check(refused.length === 0, `nothing was fetched from the network (${refused.slice(0, 3).join(', ')})`);
    check(errors.length === 0, `no errors in the page (${errors.slice(0, 2).join(' | ')})`);
    const examples = await page.isVisible('#examples');
    check(!examples, 'the examples list (which needs a server) is hidden');
    await page.keyboard.press('s');
    await bounded(page.waitForFunction(() => window.__POLYMERGE__.review?.section?.target, null, { timeout: 10_000 }), 15_000, 'section');
    const cut = (await readHook(page)).review.section;
    check(cut.target.outlines + cut.target.open > 0, `the section tool works in the page (${JSON.stringify(cut.target)})`);
    await page.keyboard.press('s');

    // 3. Save as HTML, from the page itself.
    dog.mark('save as HTML');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.click('#save-html')]);
    const resaved = path.join(tmp, 'resaved.html');
    await download.saveAs(resaved);
    check(download.suggestedFilename() === 'base__target.html', `"Save as HTML" offers base__target.html (${download.suggestedFilename()})`);
    await page.screenshot({ path: path.join(shots, 'export-page.png') });
    await context.close();
    const again = await open(resaved);
    check(again.state === 'ready' && JSON.stringify(again.hook.stats) === JSON.stringify(expected.stats), 'the page it saves opens with the same diff');
    check(again.refused.length === 0 && again.errors.length === 0, 'again offline and without errors');
    await again.context.close();
  }

  // 2. STEP, without OpenCascade.
  dog.mark('open the STEP page');
  {
    const { context, state, hook, refused, errors } = await open(stepPage);
    check(state === 'ready' && hook.base?.format === 'step', `the STEP page opens without OpenCascade (${state}${hook.error ? `: ${hook.error}` : ''})`);
    check(hook.view?.up === 'z', `Z up, as for STEP (${hook.view?.up})`);
    check(hook.cad?.changes?.[0]?.text === 'hole Ø8 moved 5 mm (+5, 0, 0)', `the CAD faces are in the page (${JSON.stringify(hook.cad?.changes?.map((c) => c.text))})`);
    check(refused.length === 0 && errors.length === 0, `offline and without errors (${[...refused, ...errors].slice(0, 2).join(' | ')})`);
    await context.close();
  }
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? 'e2e-export: PASS' : `e2e-export: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
