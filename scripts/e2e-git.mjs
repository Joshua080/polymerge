#!/usr/bin/env node
/**
 * End-to-end check of the git integration with REAL git and the built CLI:
 *   1. diff driver:  `git diff` on a model prints the structural report;
 *   2. merge driver: a clean three-way merge commits with both edits;
 *   3. merge driver: a conflicting merge stops (UU), keeps the base geometry in the conflict
 *      region; `polymerge resolve --pick 0=theirs` computes the resolution (then the file is put
 *      back as the driver left it); `polymerge review` serves git's three stages to the merge
 *      review, and in headless Chromium "Theirs" + "Save to repository" writes exactly the
 *      resolve output and stages it (no longer UU); `git commit` finishes it.
 *   4. the same for a .glb with a node hierarchy: the driver writes GLB and keeps the nodes; a
 *      conflict is saved from the review exactly as `polymerge resolve` writes it.
 *   5. a textured .glb: material properties, textures and UVs merge in the driver; a material
 *      conflict keeps the base colour, and `polymerge resolve` writes the chosen side's.
 *   6. `polymerge init` in a fresh repository, with polymerge on PATH (as after `npm install -g`):
 *      the config it writes calls `polymerge` by name, and plain `git diff` / `git merge` work.
 *
 *   node scripts/e2e-git.mjs        (needs `npm run build` first)
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { watchdog } from './watchdog.mjs';

const dog = watchdog('e2e-git', 5 * 60_000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages/cli/dist/cli.js');
const core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href);
const baseObj = fs.readFileSync(path.join(root, 'fixtures/cases/grid-bump/base.obj'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-git-'));

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitRaw = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
const polymerge = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });

/** The grid-bump base OBJ with the vertex at (x, y, 0) moved to height z. */
const withZ = (text, x, y, z) => text.replace(new RegExp(`^v ${x} ${y} 0$`, 'm'), `v ${x} ${y} ${z}`);
const zOf = (x, y) => {
  const m = new RegExp(`^v ${x} ${y} (\\S+)$`, 'm').exec(fs.readFileSync(path.join(dir, 'part.obj'), 'utf8'));
  return m ? Number(m[1]) : NaN;
};
const write = (text) => fs.writeFileSync(path.join(dir, 'part.obj'), text);

const hook = (page) => page.evaluate(() => window.__POLYMERGE__);

/** Run an action that starts a resolution round-trip; wait for 'loading' and then its settled state. */
async function settle(page, action) {
  await page.evaluate(() => {
    window.__settled = new Promise((resolve) => {
      let sawLoading = false;
      const obs = new MutationObserver(() => {
        const state = document.body.dataset.state;
        if (state === 'loading') sawLoading = true;
        else if (sawLoading) {
          obs.disconnect();
          resolve(state);
        }
      });
      obs.observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
      setTimeout(() => {
        obs.disconnect();
        resolve('timeout');
      }, 30_000);
    });
  });
  await action();
  return page.evaluate(() => window.__settled);
}

/**
 * `polymerge review <file>` during the conflict: the merge review is served git's three stages;
 * in the browser, resolving the conflict to theirs and clicking "Save to repository" writes the
 * result and stages it.
 */
async function reviewAndSave(file = 'part.obj') {
  const child = spawn(process.execPath, [cli, 'review', file, '--no-open', '--port', '0'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  dog.onTimeout(() => child.kill());
  let browser;
  try {
    dog.mark('review: start');
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/https?:\/\/\S+/);
        if (m) resolve(m[0]);
      });
      child.on('exit', (c) => reject(new Error(`review exited ${c}`)));
      setTimeout(() => reject(new Error('review did not start')), 30_000);
    });
    const u = new URL(url);
    check(u.searchParams.get('mode') === 'merge' && u.searchParams.get('path') === file, `polymerge review opens the merge review for ${file}`);
    check(/^#token=[A-Za-z0-9_-]{43}$/.test(u.hash) && !u.search.includes(u.hash.slice(7)), 'the session token is in the URL fragment, not the query');
    let same = true;
    for (const [side, n] of [['base', 1], ['ours', 2], ['theirs', 3]]) {
      const served = Buffer.from(await (await fetch(new URL(u.searchParams.get(side), u.origin))).arrayBuffer());
      same &&= served.equals(execFileSync('git', ['show', `:${n}:${file}`], { cwd: dir }));
    }
    check(same, 'it serves git stages :1 / :2 / :3 as base / ours / theirs');

    dog.mark('browser: open the review');
    browser = await chromium.launch({
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForSelector('body[data-state="ready"], body[data-state="error"]', { timeout: 120_000 });
    await page.waitForFunction(() => window.__POLYMERGE__?.merge?.save, null, { timeout: 30_000 });
    let h = await hook(page);
    check(h.state === 'ready' && h.merge.unresolved === 1, `the review shows the unresolved conflict (state ${h.state}${h.error ? `: ${h.error}` : ''})`);
    check(h.merge.save.writable && h.merge.save.path === file && !h.merge.save.enabled, `"Save to repository" is offered for ${file}, disabled while a conflict is unresolved`);
    check(!page.url().includes('token'), 'the page removed the token from the address bar');

    dog.mark('browser: resolve theirs');
    const state = await settle(page, () => page.click('[data-conflict="0"] [data-pick="theirs"]'));
    h = await hook(page);
    check(state === 'ready' && h.merge.unresolved === 0 && h.merge.save.enabled, 'choosing "Theirs" resolves the conflict and enables Save');

    dog.mark('browser: save');
    await page.click('[data-save="repo"]');
    await page.waitForFunction(() => ['saved', 'error'].includes(window.__POLYMERGE__?.merge?.save?.state), null, { timeout: 60_000 });
    h = await hook(page);
    check(h.merge.save.state === 'saved', `Save reports success (${h.merge.save.message})`);
    check(/git commit/.test(await page.locator('.save-repo').innerText()), 'the viewer suggests git commit next');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser?.close();
    child.kill();
  }
}

/**
 * 4. A .glb with a node hierarchy ("assembly" → "bracket", rotated and scaled): merged by the
 * driver as GLB with its nodes kept; a conflict is saved from the review, byte-identical to what
 * `polymerge resolve` writes.
 */
async function checkGlb() {
  const bytes = fs.readFileSync(path.join(root, 'fixtures/cases/gltf-node-hierarchy/target.glb'));
  const base = await core.loadMesh(bytes, { fileName: 'bracket.glb' });
  const at = (m, v) => [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
  const a = at(base, 0);
  const dist = (v) => Math.hypot(...at(base, v).map((x, k) => x - a[k]));
  let far = 0;
  for (let v = 1; v < base.vertexCount; v++) if (dist(v) > dist(far)) far = v;
  const b = at(base, far);
  /** The model with world vertex v raised by dz, written as GLB with its nodes. */
  const edited = (v, dz) => {
    const positions = Float64Array.from(base.positions);
    positions[v * 3 + 2] += dz;
    return core.writeGlb({ ...base, positions });
  };
  const read = () => core.loadMesh(fs.readFileSync(path.join(dir, 'bracket.glb')), { fileName: 'bracket.glb' });
  const has = (m, p) => {
    for (let i = 0; i < m.vertexCount; i++) if (at(m, i).every((x, k) => x === p[k])) return true;
    return false;
  };
  const writeGlbFile = (data) => fs.writeFileSync(path.join(dir, 'bracket.glb'), data);

  fs.appendFileSync(path.join(dir, '.gitattributes'), '*.glb diff=polymerge merge=polymerge\n');
  writeGlbFile(bytes);
  git('add', '-A');
  git('commit', '-qm', 'glb base');
  const glbBase = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'glb-theirs');
  writeGlbFile(edited(far, -0.25));
  git('commit', '-qam', 'theirs: lower the far corner');
  git('checkout', '-q', 'main');
  writeGlbFile(edited(0, 0.5));
  git('commit', '-qam', 'ours: raise corner 0');
  const clean = gitRaw('merge', '--no-edit', 'glb-theirs');
  check(clean.status === 0, `clean .glb merge exits 0 (got ${clean.status})`);
  const merged = await read();
  check(has(merged, [a[0], a[1], a[2] + 0.5]) && has(merged, [b[0], b[1], b[2] - 0.25]), 'the merged .glb has both edits');
  check(merged.scene?.nodes.map((n) => n.name).join() === 'assembly,bracket', 'and keeps its node hierarchy (assembly → bracket)');

  git('checkout', '-q', '-b', 'glb-clash', glbBase);
  writeGlbFile(edited(0, -0.5));
  git('commit', '-qam', 'theirs: lower corner 0');
  git('checkout', '-q', 'main');
  const clash = gitRaw('merge', '--no-edit', 'glb-clash');
  check(clash.status !== 0 && git('status', '--short').trim() === 'UU bracket.glb', 'conflicting .glb merge stops, file unmerged (UU)');
  check(has(await read(), a), 'the conflict region keeps the base geometry in the .glb');
  const conflicted = fs.readFileSync(path.join(dir, 'bracket.glb'));
  const res = polymerge('resolve', 'bracket.glb', '--pick', '0=theirs', '-q');
  check(res.status === 0, `polymerge resolve bracket.glb exits 0 (got ${res.status}: ${res.stderr.trim()})`);
  const resolved = await read();
  check(has(resolved, [a[0], a[1], a[2] - 0.5]) && resolved.scene?.nodes.length === 2, 'resolve writes theirs into the .glb, nodes kept');
  const resolvedBytes = fs.readFileSync(path.join(dir, 'bracket.glb'));
  writeGlbFile(conflicted);
  await reviewAndSave('bracket.glb');
  dog.mark('after .glb save');
  check(fs.readFileSync(path.join(dir, 'bracket.glb')).equals(resolvedBytes), 'the review saved the .glb byte-identical to `polymerge resolve` output');
  check(git('ls-files', '-u').trim() === '' && git('status', '--short').trim() === 'M  bracket.glb', 'bracket.glb is staged (UU → M)');
  git('commit', '-qm', 'merge glb clash (theirs)');
  check(git('status', '--short').trim() === '', '.glb merge committed, working tree clean');
}

/** A valid size × size RGB PNG of one colour (polymerge never decodes images, but validators do). */
function png(rgb, size = 2) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rows.set(rgb, y * (1 + size * 3) + 1 + x * 3);
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]),
  );
}

/**
 * 5. A textured .glb (material "Paint" with a base colour, roughness and a base colour texture, UVs)
 * in real git. Clean: one side recolours and swaps the texture, the other changes the roughness; the
 * driver merges both into the GLB. Conflict: both recolour differently; the driver keeps the base
 * colour (and applies the other edits: the texture swap, a raised vertex) and reports a
 * material-property conflict; `polymerge resolve --pick 0=theirs` writes theirs' colour.
 */
async function checkGlbAppearance() {
  const imageA = png([200, 200, 200]);
  const imageB = png([220, 20, 20]);
  /** A 5 × 5-vertex panel, one island of UVs, material "Paint" textured with `image`; the centre raised by `lift`. */
  const panel = ({ color = [0.8, 0.8, 0.8, 1], roughness = 0.5, image = imageA, lift = 0 } = {}) => {
    const positions = [];
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) positions.push(i, j, i === 2 && j === 2 ? lift : 0);
    const faces = [];
    const uv = [];
    const at = (v) => [(v % 5) / 4, Math.floor(v / 5) / 4];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const a = j * 5 + i;
        const tri = [a, a + 1, a + 6, a, a + 6, a + 5];
        faces.push(...tri);
        for (const v of tri) uv.push(...at(v));
      }
    }
    const def = { ...core.defaultMaterialDefinition(), name: 'Paint', baseColorFactor: color, roughnessFactor: roughness, baseColorTexture: { image: 0, texCoord: 0 } };
    const mesh = core.createMesh(positions, faces, {
      materials: [core.materialSummary(def, 'material_0')],
      faceMaterials: new Int32Array(faces.length / 3),
      appearance: { materials: [def], images: [{ hash: core.hashBytes(image), data: image, mimeType: 'image/png' }], uvs: [Float32Array.from(uv)] },
      metadata: { format: 'glb', sourceName: 'panel.glb' },
    });
    return core.writeGlb(mesh);
  };
  const file = path.join(dir, 'panel.glb');
  const read = () => core.loadMesh(fs.readFileSync(file), { fileName: 'panel.glb' });
  const close = (a, b) => a.length === b.length && b.every((x, i) => Math.abs(a[i] - x) < 1e-6);
  const topZ = (m) => Math.max(...Array.from(m.positions).filter((_, i) => i % 3 === 2));
  const paint = (m) => m.appearance.materials[0];
  const imageHash = (m) => m.appearance.images[paint(m).baseColorTexture.image].hash;

  fs.writeFileSync(file, panel());
  git('add', '-A');
  git('commit', '-qm', 'panel base');
  const panelBase = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'look-theirs');
  fs.writeFileSync(file, panel({ roughness: 0.9 }));
  git('commit', '-qam', 'theirs: rougher');
  git('checkout', '-q', 'main');
  fs.writeFileSync(file, panel({ color: [1, 0, 0, 1], image: imageB }));
  git('commit', '-qam', 'ours: red, another texture');
  const clean = gitRaw('merge', '--no-edit', 'look-theirs');
  check(clean.status === 0, `clean appearance merge of a textured .glb exits 0 (got ${clean.status})`);
  let m = await read();
  check(close(paint(m).baseColorFactor, [1, 0, 0, 1]) && Math.abs(paint(m).roughnessFactor - 0.9) < 1e-6, 'it has ours\' colour and theirs\' roughness');
  check(imageHash(m) === core.hashBytes(imageB), 'and ours\' texture, byte for byte');

  git('checkout', '-q', '-b', 'look-clash', panelBase);
  fs.writeFileSync(file, panel({ color: [0, 0, 1, 1], lift: 0.5 }));
  git('commit', '-qam', 'theirs: blue, raise the centre');
  git('checkout', '-q', 'main');
  const clash = gitRaw('merge', '--no-edit', 'look-clash');
  check(clash.status !== 0 && /CONFLICT/.test(clash.stdout + clash.stderr), 'a material conflict in a .glb stops the merge with CONFLICT');
  check(/material-property/.test(clash.stderr) && /baseColorFactor/.test(clash.stderr), 'the driver names the conflict (material-property, baseColorFactor)');
  check(git('status', '--short').trim() === 'UU panel.glb', 'the model is marked unmerged (UU)');
  m = await read();
  check(close(paint(m).baseColorFactor, [0.8, 0.8, 0.8, 1]), 'the conflicting colour stays at its base value in the file');
  check(topZ(m) === 0.5 && imageHash(m) === core.hashBytes(imageB) && Math.abs(paint(m).roughnessFactor - 0.9) < 1e-6, 'the other edits merged: theirs\' raised vertex, ours\' texture and roughness');
  const res = polymerge('resolve', 'panel.glb', '--pick', '0=theirs', '-q');
  check(res.status === 0, `polymerge resolve panel.glb exits 0 (got ${res.status}: ${res.stderr.trim()})`);
  m = await read();
  check(close(paint(m).baseColorFactor, [0, 0, 1, 1]) && topZ(m) === 0.5 && imageHash(m) === core.hashBytes(imageB), 'resolve writes theirs\' colour into the .glb; the rest stays');
  git('add', 'panel.glb');
  git('commit', '-qm', 'merge look-clash (theirs)');
  check(git('status', '--short').trim() === '', 'textured .glb merge committed, working tree clean');
}

/** 6. `polymerge init`, then git finds the drivers by name on PATH (a shim stands in for npm install -g). */
function checkInit() {
  dog.mark('6. polymerge init');
  const repo = path.join(dir, 'init-repo');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'polymerge'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const run = (cmd, ...args) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env });
  run('git', 'init', '-q', '-b', 'main');
  run('git', 'config', 'user.email', 'e2e@polymerge.test');
  run('git', 'config', 'user.name', 'polymerge e2e');
  const init = run('polymerge', 'init');
  check(init.status === 0 && /added\s+\*\.obj diff=polymerge merge=polymerge/.test(init.stdout) && !/not on your PATH/.test(init.stdout), `polymerge init sets the repository up (exit ${init.status})`);
  fs.writeFileSync(path.join(repo, 'part.obj'), baseObj);
  run('git', 'add', '-A');
  run('git', 'commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'part.obj'), withZ(baseObj, 2, 2, 0.5));
  const d = run('git', 'diff', '--', 'part.obj');
  check(d.status === 0 && /polymerge diff --git a\/part\.obj/.test(d.stdout) && /moved 1\b/.test(d.stdout), 'after init, plain `git diff` prints the polymerge report');
  run('git', 'commit', '-qam', 'raise');
  const again = run('polymerge', 'init');
  check(again.status === 0 && /Nothing to do/.test(again.stdout), 'a second polymerge init changes nothing');
}

try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@polymerge.test');
  git('config', 'user.name', 'polymerge e2e');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.obj diff=polymerge merge=polymerge\n');
  git('config', 'diff.polymerge.command', `"${process.execPath}" "${cli}" git-diff`);
  git('config', 'merge.polymerge.driver', `"${process.execPath}" "${cli}" git-merge %O %A %B %P`);
  write(baseObj);
  git('add', '-A');
  git('commit', '-qm', 'base');

  // 1. diff driver
  write(withZ(baseObj, 2, 2, 0.5));
  const diff = git('diff', '--', 'part.obj');
  check(/resolved by Tier 1/.test(diff) && /moved 1/.test(diff), 'git diff shows the structural report (Tier 1, 1 moved vertex)');
  git('commit', '-qam', 'ours: raise (2,2)');

  // 2. clean merge
  git('checkout', '-q', '-b', 'clean', 'HEAD~1');
  write(withZ(baseObj, 8, 7, -0.25));
  git('commit', '-qam', 'theirs: lower (8,7)');
  git('checkout', '-q', 'main');
  const clean = gitRaw('merge', '--no-edit', 'clean');
  check(clean.status === 0, `clean merge exits 0 (got ${clean.status})`);
  check(zOf(2, 2) === 0.5 && zOf(8, 7) === -0.25, 'clean merge keeps both edits');

  // 3. conflicting merge + resolve
  git('checkout', '-q', '-b', 'clash', 'HEAD~2');
  write(withZ(baseObj, 2, 2, -1));
  git('commit', '-qam', 'theirs: lower (2,2)');
  git('checkout', '-q', 'main');
  const clash = gitRaw('merge', '--no-edit', 'clash');
  check(clash.status !== 0 && /CONFLICT/.test(clash.stdout + clash.stderr), 'conflicting merge stops with CONFLICT');
  check(/move-move/.test(clash.stderr), 'the driver explains the conflict (move-move)');
  check(git('status', '--short').trim() === 'UU part.obj', 'the model is marked unmerged (UU)');
  check(zOf(2, 2) === 0 && zOf(8, 7) === -0.25, 'conflict region keeps base geometry; other edits stay merged');
  // What `polymerge resolve --pick 0=theirs` writes; then put the file back as the driver left it.
  const conflicted = fs.readFileSync(path.join(dir, 'part.obj'));
  const res = polymerge('resolve', 'part.obj', '--pick', '0=theirs', '-q');
  check(res.status === 0, `polymerge resolve exits 0 (got ${res.status}: ${res.stderr.trim()})`);
  check(zOf(2, 2) === -1, 'resolve applied theirs to the conflict region');
  const resolved = fs.readFileSync(path.join(dir, 'part.obj'));
  fs.writeFileSync(path.join(dir, 'part.obj'), conflicted);
  check(git('status', '--short').trim() === 'UU part.obj', 'still unmerged (UU) before the review');

  await reviewAndSave();
  dog.mark('after save');
  check(fs.readFileSync(path.join(dir, 'part.obj')).equals(resolved), 'the saved file is byte-identical to `polymerge resolve --pick 0=theirs` output');
  check(zOf(2, 2) === -1 && zOf(8, 7) === -0.25, 'it has theirs in the conflict region and the automatic edit');
  check(git('diff', '--cached', '--name-only').trim() === 'part.obj', 'git diff --cached shows part.obj staged');
  check(execFileSync('git', ['show', ':0:part.obj'], { cwd: dir }).equals(resolved), 'the index holds the saved file (stage 0)');
  check(git('ls-files', '-u').trim() === '' && git('status', '--short').trim() === 'M  part.obj', 'part.obj is no longer unmerged (UU → M)');
  git('commit', '-qm', 'merge clash (theirs)');
  check(git('status', '--short').trim() === '', 'merge committed, working tree clean');

  await checkGlb();
  await checkGlbAppearance();
  checkInit();
} catch (err) {
  console.error(err.stderr ?? err);
  failures++;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? 'e2e-git: PASS' : `e2e-git: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
