#!/usr/bin/env node
/**
 * End-to-end check of the npm packages as a user gets them — not the monorepo:
 *   npm pack polymerge-core + polymerge  →  npm install the two tarballs into an empty project
 *   →  the installed `polymerge` bin: --version, diff, merge, demo, and `view` in headless Chromium
 *   (served from the viewer bundled in the package), plus `import 'polymerge-core'`.
 *
 *   node scripts/e2e-pack.mjs
 *
 * Needs `npm run build` first, and the npm registry for the `three` dependency.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchdog } from './watchdog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dog = watchdog('e2e-pack', 5 * 60_000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-pack-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env };
delete env.POLYMERGE_WEB_DIST; // the installed package must find its own viewer

const fail = (msg) => {
  console.error(`e2e-pack: FAIL — ${msg}`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

try {
  dog.mark('pack');
  const packed = JSON.parse(run(npm, ['pack', '-w', 'polymerge-core', '-w', 'polymerge', '--json', '--pack-destination', tmp], { cwd: root }));
  const tarballs = packed.map((p) => path.join(tmp, p.filename));
  const cliPack = packed.find((p) => p.name === 'polymerge');
  const files = cliPack.files.map((f) => f.path);
  for (const must of ['dist/cli.js', 'dist/viewer/index.html', 'dist/viewer/fixtures/manifest.json', 'README.md', 'LICENSE']) if (!files.includes(must)) fail(`polymerge tarball lacks ${must}`);
  if (files.some((f) => f.startsWith('src/') || f.endsWith('.map'))) fail('polymerge tarball ships sources or source maps');
  console.log(`e2e-pack: packed ${packed.map((p) => `${p.name}@${p.version} (${p.entryCount} files, ${(p.size / 1024).toFixed(0)} kB)`).join(', ')}`);

  dog.mark('install');
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'pack-check', private: true, type: 'module' }));
  run(npm, ['install', '--no-audit', '--no-fund', '--prefer-offline', ...tarballs], { cwd: app });
  const bin = path.join(app, 'node_modules/.bin', process.platform === 'win32' ? 'polymerge.cmd' : 'polymerge');
  const cliJs = path.join(app, 'node_modules/polymerge/dist/cli.js');
  const polymerge = (args, opts = {}) => {
    try {
      return { code: 0, out: run(bin, args, { cwd: app, ...opts }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  dog.mark('version');
  const version = polymerge(['--version']).out.trim();
  if (version !== cliPack.version) fail(`--version printed "${version}", package is ${cliPack.version}`);

  dog.mark('diff');
  const fx = (c, f) => path.join(root, 'fixtures/cases', c, f);
  const diff = polymerge(['diff', fx('moved-part', 'base.obj'), fx('moved-part', 'target.obj'), '--exit-code']);
  if (diff.code !== 1 || !/moved/.test(diff.out)) fail(`diff: exit ${diff.code}\n${diff.out}`);

  dog.mark('library');
  // The README's library example, verbatim, against the installed polymerge-core.
  for (const side of ['base', 'ours', 'theirs']) fs.copyFileSync(path.join(root, 'examples/plate', `${side}.stl`), path.join(app, `${side}.stl`));
  fs.writeFileSync(
    path.join(app, 'library.mjs'),
    `import { readFile, writeFile } from 'node:fs/promises';
import { loadMesh, diffMeshes, mergeMeshes, resolveMerge, writeStl } from 'polymerge-core';

const load = async (file) => loadMesh(await readFile(file), { fileName: file });
const [base, ours, theirs] = await Promise.all(['base.stl', 'ours.stl', 'theirs.stl'].map(load));

const diff = diffMeshes(base, ours);
console.log(diff.tierName, diff.stats.vertices); // Tier 1 · index/ID (direct lineage) { unchanged: 152, moved: 10, … }

const merge = mergeMeshes(base, ours, theirs);
for (const c of merge.conflicts) console.log(\`#\${c.id} \${c.message}\`);
const resolved = resolveMerge(merge, { 0: 'theirs' });
await writeFile('merged.stl', writeStl(resolved.merged));
`,
  );
  const lib = run(process.execPath, ['library.mjs'], { cwd: app });
  if (!/moved: 10/.test(lib) || !/#0 9 vertex/.test(lib) || !fs.existsSync(path.join(app, 'merged.stl'))) fail(`library example:\n${lib}`);
  fs.rmSync(path.join(app, 'merged.stl'));

  dog.mark('merge');
  const conflicted = polymerge(['merge', 'base.stl', 'ours.stl', 'theirs.stl', '-o', 'merged.stl']);
  if (conflicted.code !== 1 || !/move-move/.test(conflicted.out)) fail(`merge should report a move-move conflict:\n${conflicted.out}`);
  const resolved = polymerge(['merge', 'base.stl', 'ours.stl', 'theirs.stl', '-o', 'merged.stl', '--pick', '0=theirs']);
  if (resolved.code !== 0 || !fs.existsSync(path.join(app, 'merged.stl'))) fail(`merge --pick 0=theirs failed:\n${resolved.out}`);

  dog.mark('demo');
  await new Promise((resolve, reject) => {
    const demo = spawn(bin, ['demo', '--no-open', '--port', '0'], { cwd: app, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('demo printed no URL in 15 s')), 15_000);
    demo.stdout.on('data', async (d) => {
      buf += d;
      const m = buf.match(/https?:\/\/\S+/);
      if (!m) return;
      clearTimeout(timer);
      try {
        const url = new URL(m[0]);
        if (url.searchParams.get('demo') !== 'boss-height') throw new Error(`demo opened ${url}`);
        const res = await fetch(url);
        const html = await res.text();
        if (res.status !== 200 || !/<script[^>]+src="\.\/assets\//.test(html)) throw new Error(`demo page: ${res.status}`);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        demo.kill();
      }
    });
    demo.on('error', reject);
    demo.on('exit', (code) => reject(new Error(`demo exited with code ${code}: ${buf}`)));
  }).catch((e) => fail(`demo: ${e.message}`));

  dog.mark('view in browser');
  // The installed viewer, rendered for real (reuses e2e-view with the installed cli.js).
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts/e2e-view.mjs')], {
      cwd: root,
      env: { ...env, POLYMERGE_CLI: cliJs },
      stdio: 'inherit',
    });
  } catch {
    fail('the installed package failed e2e-view');
  }
  console.log('e2e-pack: PASS — installed from tarballs: --version, diff, merge, library import, demo, view');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
