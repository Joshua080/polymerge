#!/usr/bin/env node
/**
 * `polymerge log`, end to end, on a throwaway git repository (a plate: added, edited, renamed,
 * then changed without committing):
 *  1. The text output lists the four versions with what each did; --json the same.
 *  2. `log -o page.html` opens from disk with the network refused: the versions list, the
 *     newest change shown from the saved diffs (nothing computed), [ and ] step through versions.
 *  3. `log --view` serves the history; "Compare with" an older version computes that diff in the page.
 *
 *   node scripts/e2e-log.mjs     (needs `npm run build`)
 *
 * $POLYMERGE_CLI points it at another cli.js (e2e-pack: the npm-installed package).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bounded, launchBrowser, readHook, startViewer, waitReady } from './viewer-capture.mjs';
import { watchdog } from './watchdog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.POLYMERGE_CLI ?? path.join(root, 'packages/cli/dist/cli.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-log-e2e-')));
const shots = path.join(root, 'apps/web/e2e/screenshots');
fs.mkdirSync(shots, { recursive: true });
const dog = watchdog('e2e-log', 5 * 60_000);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

// ---- The repository.
const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'models'), { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** A 10 × 10 grid plate as OBJ; `lift` raises vertex "i,j" to z. */
function plate(lift = {}, n = 10) {
  const lines = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) lines.push(`v ${i} ${j} ${lift[`${i},${j}`] ?? 0}`);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i + 1;
      lines.push(`f ${a} ${a + 1} ${a + n + 2}`, `f ${a} ${a + n + 2} ${a + n + 1}`);
    }
  return lines.join('\n') + '\n';
}
git('init', '-q');
fs.writeFileSync(path.join(repo, 'models/plate.obj'), plate());
git('add', '-A');
git('commit', '-q', '-m', 'first plate');
fs.writeFileSync(path.join(repo, 'models/plate.obj'), plate({ '5,5': 0.8, '5,6': 0.4 }));
git('commit', '-q', '-am', 'raise the middle');
git('mv', 'models/plate.obj', 'models/base-plate.obj');
git('commit', '-q', '-m', 'rename');
fs.writeFileSync(path.join(repo, 'models/base-plate.obj'), plate({ '5,5': 0.8, '5,6': 0.4, '1,1': -0.5 }));
const file = path.join(repo, 'models/base-plate.obj');

const polymerge = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });

// ---- 1. Text and JSON.
dog.mark('text');
const text = polymerge('log', 'models/base-plate.obj');
check(/polymerge log {2}models\/base-plate\.obj {2}\(4 versions, 3 changes, newest first\)/.test(text), 'the header counts versions and changes');
check(/working .*uncommitted changes\n {2}~ 1 vertex moved \(largest 0\.5\)/.test(text), 'the uncommitted change is on top, with what it did');
check(/rename {2}\(renamed from models\/plate\.obj\)\n {2}= no change to the model/.test(text), 'the rename is followed and reads as no change');
check(/raise the middle\n {2}~ 2 vertices moved \(largest 0\.8\)/.test(text), 'the edit reads as 2 vertices moved');
check(/first plate\n {2}\+ added: 200 faces/.test(text), 'the first version reads as added');
if (failures) console.log(text);
const json = JSON.parse(polymerge('log', 'models/base-plate.obj', '--json'));
check(json.versions.length === 4 && json.versions[2].step.stats.vertices.moved === 2, `--json: 4 versions, the edit's stats (${json.versions.map((v) => v.step.kind).join(', ')})`);

dog.mark('export');
const pageFile = path.join(tmp, 'history.html');
const said = polymerge('log', 'models/base-plate.obj', '-o', pageFile);
check(/^Wrote .*history\.html \([\d.]+ (KB|MB)\): 4 versions of models\/base-plate\.obj/.test(said), `-o says what it wrote (${said.trim()})`);

dog.mark('launch browser');
const browser = await launchBrowser();
dog.onTimeout(() => browser.close().catch(() => {}));
let server = null;

async function open(url, { offline }) {
  const context = await bounded(browser.newContext({ viewport: { width: 1280, height: 800 } }), 20_000, 'newContext');
  const refused = [];
  if (offline) {
    await context.route('**/*', (route) => {
      const u = route.request().url();
      if (/^(file|data|blob):/.test(u)) return route.continue();
      refused.push(u);
      return route.abort();
    });
  }
  const page = await bounded(context.newPage(), 20_000, 'newPage');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url, { timeout: 30_000 });
  const state = await waitReady(page, { timeout: 60_000, allowError: true });
  return { context, page, state, hook: await readHook(page), refused, errors };
}

const shown = (page, short) => bounded(page.waitForFunction((s) => window.__POLYMERGE__.state === 'ready' && window.__POLYMERGE__.history?.shown === s, short, { timeout: 30_000 }), 35_000, `version ${short}`);

try {
  // ---- 2. The page, offline.
  dog.mark('open the history page');
  {
    const { context, page, state, hook, refused, errors } = await open(pathToFileURL(pageFile).href, { offline: true });
    check(state === 'ready' && hook.history?.versions === 4 && hook.history.selected === 0, `the page opens on the newest version (${state}${hook.error ? `: ${hook.error}` : ''}, ${JSON.stringify(hook.history)})`);
    check(hook.stats?.vertices.moved === 1 && hook.engine === undefined, `it shows the uncommitted change from the saved diff (${JSON.stringify(hook.stats?.vertices)}, engine ${hook.engine})`);
    const items = await page.$$eval('.history-item', (els) => els.map((e) => e.dataset.kind));
    check(JSON.stringify(items) === JSON.stringify(['modified', 'unchanged', 'modified', 'added']), `the versions list (${items.join(', ')})`);
    await page.keyboard.press('[');
    await page.keyboard.press('[');
    const short = json.versions[2].short;
    await shown(page, short);
    const h2 = await readHook(page);
    check(h2.stats?.vertices.moved === 2 && h2.engine === undefined, `[ steps to "raise the middle": 2 vertices moved (${JSON.stringify(h2.stats?.vertices)})`);
    await page.screenshot({ path: path.join(shots, 'log-page.png') });
    await page.keyboard.press(']');
    await shown(page, json.versions[1].short);
    const h1 = await readHook(page);
    check(h1.stats?.vertices.moved === 0 && h1.stats?.vertices.added === 0, `] steps back to the rename: no change (${JSON.stringify(h1.stats?.vertices)})`);
    check(refused.length === 0 && errors.length === 0, `offline and without errors (${[...refused, ...errors].slice(0, 2).join(' | ')})`);
    await context.close();
  }

  // ---- 3. log --view, and Compare with.
  dog.mark('log --view');
  server = await startViewer({ cli, args: ['log', file, '--view'] });
  {
    const { context, page, state, hook, errors } = await open(server.url, { offline: false });
    check(state === 'ready' && hook.history?.versions === 4, `log --view opens the history (${state}${hook.error ? `: ${hook.error}` : ''})`);
    await page.selectOption('#history-compare', '3');
    await bounded(page.waitForFunction(() => window.__POLYMERGE__.state === 'ready' && window.__POLYMERGE__.history?.compareTo === 3, null, { timeout: 60_000 }), 65_000, 'compare');
    const hc = await readHook(page);
    check(hc.stats?.vertices.moved === 3 && hc.engine !== undefined, `"Compare with" the first version computes that diff here: 3 vertices moved (${JSON.stringify(hc.stats?.vertices)}, engine ${hc.engine})`);
    await page.screenshot({ path: path.join(shots, 'log-view.png') });
    check(errors.length === 0, `no errors in the page (${errors.slice(0, 2).join(' | ')})`);
    await context.close();
  }
} finally {
  server?.stop();
  await browser.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? 'e2e-log: PASS' : `e2e-log: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
