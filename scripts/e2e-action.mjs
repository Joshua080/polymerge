#!/usr/bin/env node
/**
 * End-to-end check of the pull-request action (action.yml → action/render.mjs + action/post.mjs)
 * with real git, the built CLI and viewer in headless Chromium, and a local mock of the GitHub API:
 *
 *  1. A temporary repository: `main`, then a pull-request branch that moves a part, adds a model
 *     (upper-case .STL), deletes one, renames one unchanged, adds an unreadable file, an LFS
 *     pointer without content, an LFS pointer whose object is in the local LFS store, a model over
 *     the triangle cap, one over the file cap and one with a hostile name. `main` then moves on,
 *     so diffing against its tip instead of the merge base would show a file the PR never touched.
 *  2. render.mjs: the result per file; the images exist and are not blank, show the expected diff
 *     colours, and before / after share one camera (identical cameras, and the unchanged model's
 *     pixels are identical in both panels).
 *  3. The comment: sections, notes, local command, footer, and the hostile name only ever inside
 *     code spans (no HTML, links, mentions or emphasis escape; table rows stay intact).
 *  4. post.mjs against the mock API, with a local bare repository as the image remote:
 *     same-repo run → creates the comment and pushes the images; a new push, posted the fork-safe
 *     way (workflow_run + artifact) → updates the SAME comment; a push that drops every model
 *     change → the comment says so. Rejected: an artifact naming another pull request, a tampered
 *     artifact (bad image name, fake PNG, wrong commit); a fork's pull_request run only warns. A
 *     stranger's comment that carries the marker is never touched.
 *
 *   node scripts/e2e-action.mjs     (needs `npm run build` first)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createMesh, writeObj, writeStl } from 'polymerge-core';
import { watchdog } from './watchdog.mjs';

const dog = watchdog('e2e-action', 6 * 60_000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-action-'));
const repo = path.join(tmp, 'repo');
const shots = path.join(root, 'apps/web/e2e/screenshots');
fs.mkdirSync(repo);
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
const children = new Set();
dog.onTimeout(() => {
  for (const c of children) c.kill('SIGKILL');
});

/** Run a script as the action does (a child process), with extra environment; resolves { code, out }. */
function run(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      children.delete(child);
      resolve({ code, out });
    });
  });
}

/**
 * git for building the fixture repository. Where git-lfs is installed (GitHub's runners), its
 * smudge filter would try to download the pointer files this test commits on purpose and fail
 * the checkout, so the fixture's own git leaves pointers as they are. The action's scripts run
 * with the normal environment: their `git lfs smudge` fallback is exercised for real there.
 */
function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' };
    const child = spawn('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(' ')}: ${err}`))));
  });
}

// ---- Models -----------------------------------------------------------------------------------

/** An axis-aligned box as 8 vertices / 12 outward triangles, offset by `base` vertices. */
function box([x0, y0, z0], [x1, y1, z1], base = 0) {
  const p = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const q = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
    [0, 4, 7, 3],
    [1, 2, 6, 5],
  ];
  const f = q.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]).map((v) => v + base);
  return { p, f };
}
/** Turn points about the vertical axis through (cx, cz), then shift them. */
function place(points, deg, [cx, cz], [dx, dy, dz]) {
  const a = (deg * Math.PI) / 180;
  const out = [];
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i] - cx;
    const z = points[i + 2] - cz;
    out.push(cx + x * Math.cos(a) - z * Math.sin(a) + dx, points[i + 1] + dy, cz + x * Math.sin(a) + z * Math.cos(a) + dz);
  }
  return out;
}
/** A plate with a knob on it, as an OBJ with the groups "plate" and "knob". */
function assembly(knobDeg, knobShift) {
  const plate = box([-5, 0, -3], [5, 0.6, 3]);
  const knob = box([-3.6, 0.6, -0.6], [-2.4, 1.8, 0.6], 8);
  const p = [...plate.p, ...place(knob.p, knobDeg, [-3, 0], knobShift)];
  return writeObj(createMesh(p, [...plate.f, ...knob.f], { groups: [{ name: 'plate', faceStart: 0, faceCount: 12 }, { name: 'knob', faceStart: 12, faceCount: 12 }] }));
}
const stl = (b) => writeStl(createMesh(b.p, b.f));
function grid(nx, nz) {
  const p = [];
  const f = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) p.push(i * 0.1, Math.sin(i * 0.3) * 0.2, j * 0.1);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      f.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  }
  return stl({ p, f });
}
const lfsPointer = (bytes) => `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(bytes).digest('hex')}\nsize ${bytes.length}\n`;

/** A real file name (anything but "/" and NUL): HTML, emphasis, a table pipe, a link, a mention, shell syntax, quotes, a bidi override, a newline. */
const HOSTILE = 'models/evil <img src=x onerror=alert(1)> *b* | [l](javascript:alert(1)) @octocat `$(id)` \'"' + String.fromCodePoint(0x202e) + '\nx.stl';
const write = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), data);
};

// ---- PNG decoding (8-bit RGB / RGBA, as Chromium writes them) -----------------------------------

function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG (bit depth / interlace)');
      channels = { 2: 3, 6: 4 }[data[9]];
      if (!channels) throw new Error(`unsupported PNG colour type ${data[9]}`);
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, pr][filter]) & 255;
    }
    for (let x = 0; x < width; x++) line.copy(px, (y * width + x) * 3, x * channels, x * channels + 3);
    prev = line;
  }
  return { width, height, px };
}

/** Colour class of a pixel: the diff colours by hue, grey (the unchanged model), or background. */
function classify(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 45) return 'bg';
  const sat = (max - min) / max;
  if (sat < 0.14) return max > 70 ? 'grey' : 'bg';
  if (sat < 0.4) return 'other';
  let hue = max === r ? (60 * (g - b)) / (max - min) : max === g ? 60 * (2 + (b - r) / (max - min)) : 60 * (4 + (r - g) / (max - min));
  if (hue < 0) hue += 360;
  if (hue >= 40 && hue <= 60) return 'yellow';
  if (hue >= 120 && hue <= 160) return 'green';
  if (hue <= 12 || hue >= 348) return 'red';
  return 'other';
}

/** Per-panel colour counts of a capture image, and the two panels' pixels. */
function panels(img, capture) {
  return capture.panels.map((p) => {
    const [x0, y0, w, h] = p.rect.map((v) => Math.round(v * 2)); // captured at device scale 2
    const counts = { bg: 0, grey: 0, yellow: 0, green: 0, red: 0, other: 0 };
    const cls = [];
    const rgb = [];
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * img.width + x) * 3;
        const c = classify(img.px[i], img.px[i + 1], img.px[i + 2]);
        counts[c]++;
        cls.push(c);
        rgb.push((img.px[i] << 16) | (img.px[i + 1] << 8) | img.px[i + 2]);
      }
    }
    return { side: p.side, counts, cls, rgb, total: w * h };
  });
}

// ---- Mock GitHub API ----------------------------------------------------------------------------

const TOKEN = 'ghs_e2e_token';
const REPO = 'octo/models';
const api = { pulls: new Map(), comments: [], nextId: 5000, writes: [], unauthorised: 0 };
const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      api.unauthorised++;
      return send(401, { message: 'Bad credentials' });
    }
    const url = new URL(req.url, 'http://localhost');
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/octo\/models\/pulls\/(\d+)$/))) {
      const pull = api.pulls.get(Number(m[1]));
      return pull ? send(200, pull) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/repos\/octo\/models\/issues\/(\d+)\/comments$/))) {
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const list = api.comments.filter((c) => c.issue === Number(m[1]));
      return send(200, list.slice((page - 1) * per, page * per));
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/repos\/octo\/models\/issues\/(\d+)\/comments$/))) {
      const c = { id: api.nextId++, issue: Number(m[1]), user: BOT, body: JSON.parse(body).body };
      c.html_url = `https://github.test/octo/models/pull/${m[1]}#issuecomment-${c.id}`;
      api.comments.push(c);
      api.writes.push(['create', c.id]);
      return send(201, c);
    }
    if (req.method === 'PATCH' && (m = url.pathname.match(/^\/repos\/octo\/models\/issues\/comments\/(\d+)$/))) {
      const c = api.comments.find((x) => x.id === Number(m[1]));
      if (!c) return send(404, { message: 'Not Found' });
      c.body = JSON.parse(body).body;
      api.writes.push(['update', c.id]);
      return send(200, c);
    }
    send(404, { message: `no mock for ${req.method} ${url.pathname}` });
  });
});

// ---- Run ----------------------------------------------------------------------------------------

try {
  dog.mark('build the repository');
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'e2e@polymerge.test');
  await git(repo, 'config', 'user.name', 'polymerge e2e');
  write('.gitattributes', 'models/scan*.* filter=lfs diff=lfs merge=lfs -text\n');
  write('README.md', '# models\n');
  write('models/assembly.obj', assembly(0, [0, 0, 0]));
  write('models/old-bracket.stl', stl(box([0, 0, 0], [2, 0.4, 1])));
  write('models/lid.stl', stl(box([0, 0, 0], [3, 0.2, 3])));
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'base');
  const forkPoint = await git(repo, 'rev-parse', 'HEAD');

  await git(repo, 'checkout', '-q', '-b', 'feature');
  write('models/assembly.obj', assembly(30, [6, 0, 0.5])); // the knob: moved across the plate and turned
  write('models/New-Part.STL', stl(box([0, 0, 0], [1, 2, 1])));
  fs.rmSync(path.join(repo, 'models/old-bracket.stl'));
  fs.renameSync(path.join(repo, 'models/lid.stl'), path.join(repo, 'models/cover.stl'));
  write('models/broken.obj', 'hello\nthis is not a model\n');
  write('models/scan.glb', lfsPointer(Buffer.from('content that was never fetched')));
  const localLfs = Buffer.from(stl(box([0, 0, 0], [1, 1, 3])));
  write('models/scan-local.stl', lfsPointer(localLfs));
  const oid = createHash('sha256').update(localLfs).digest('hex');
  fs.mkdirSync(path.join(repo, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4)), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid), localLfs);
  write('models/dense.stl', grid(50, 60)); // 6,000 triangles: over the cap of 5,000
  write('models/huge.obj', `# ${'x'.repeat(2 * 1024 * 1024)}\n`); // over the 1 MB file cap: never read
  write(HOSTILE, stl(box([0, 0, 0], [1, 1, 1])));
  write('models/zz-extra.obj', writeObj(createMesh(box([0, 0, 0], [1, 1, 1]).p, box([0, 0, 0], [1, 1, 1]).f)));
  write('README.md', '# models\n\nEdited.\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'feature: move the knob, add / remove / rename models');
  const head1 = await git(repo, 'rev-parse', 'HEAD');

  await git(repo, 'checkout', '-q', 'main');
  write('models/main-only.stl', stl(box([0, 0, 0], [1, 1, 1])));
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'main moves on');
  const mainTip = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', 'feature');

  const event = (head, headRepo = REPO) => ({
    pull_request: { number: 42, base: { sha: mainTip, ref: 'main', repo: { full_name: REPO } }, head: { sha: head, ref: 'feature', repo: { full_name: headRepo } } },
  });
  const eventFile = (name, json) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, JSON.stringify(json));
    return file;
  };
  const renderEnv = (out, head) => ({
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventFile(`event-${head.slice(0, 7)}.json`, event(head)),
    GITHUB_WORKSPACE: repo,
    GITHUB_OUTPUT: path.join(tmp, 'output.txt'),
    GITHUB_STEP_SUMMARY: path.join(tmp, 'summary.md'),
    POLYMERGE_OUT: out,
    POLYMERGE_MAX_FILES: '9',
    POLYMERGE_MAX_TRIANGLES: '5000',
    POLYMERGE_MAX_FILE_MB: '1',
  });

  // ---- 2. render ----------------------------------------------------------------------------------
  dog.mark('render --list');
  const out1 = path.join(tmp, 'out1');
  let r = await run('action/render.mjs', ['--list'], renderEnv(out1, head1));
  check(r.code === 0 && /count<<\S+\n11\n/.test(fs.readFileSync(path.join(tmp, 'output.txt'), 'utf8')), `render --list finds the 11 changed model files with git alone (exit ${r.code})`);

  dog.mark('render');
  const t0 = Date.now();
  r = await run('action/render.mjs', [], renderEnv(out1, head1));
  check(r.code === 0, `render exits 0 in ${((Date.now() - t0) / 1000).toFixed(1)} s${r.code ? `:\n${r.out}` : ''}`);
  check(!/^::(?!error::|warning::)/m.test(r.out) && !r.out.includes('Unexpected line'), 'nothing from the models reaches the job log unescaped (no parser chatter, no workflow commands)');
  const result = JSON.parse(fs.readFileSync(path.join(out1, 'result.json'), 'utf8'));
  const log = JSON.parse(fs.readFileSync(path.join(out1, 'render-log.json'), 'utf8'));
  const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
  check(result.base === forkPoint && result.head === head1, 'it diffs the merge base against the head, not main\'s tip');
  check(!byPath['models/main-only.stl'] && !byPath['README.md'], 'files the PR did not touch, and non-model files, are not listed');
  const expect = {
    'models/New-Part.STL': ['added', 'rendered'],
    'models/assembly.obj': ['modified', 'rendered'],
    'models/broken.obj': ['added', 'error'],
    'models/cover.stl': ['renamed', 'same-content'],
    'models/dense.stl': ['added', 'too-large'],
    'models/huge.obj': ['added', 'too-large'],
    [HOSTILE]: ['added', 'rendered'],
    'models/old-bracket.stl': ['deleted', 'rendered'],
    'models/scan-local.stl': ['added', 'rendered'],
    'models/scan.glb': ['added', 'lfs'],
    'models/zz-extra.obj': ['added', 'not-rendered'],
  };
  for (const [p, [change, status]] of Object.entries(expect)) {
    const f = byPath[p];
    check(f?.change === change && f?.status === status, `${JSON.stringify(p).slice(0, 40)}: ${change} → ${status} (got ${f?.change} → ${f?.status}${f?.error ? `: ${f.error}` : ''})`);
  }
  check(result.files.length === 11, `11 model files listed (got ${result.files.length})`);
  check(byPath['models/cover.stl']?.oldPath === 'models/lid.stl', 'the rename keeps its old path');
  check(/no triangle faces/.test(byPath['models/broken.obj']?.error ?? ''), 'the unreadable file carries the parser message');
  check(byPath['models/dense.stl']?.limit?.what === 'faces' && byPath['models/dense.stl'].limit.value === 6000, 'the dense model is over the triangle cap (6,000 > 5,000)');
  check(byPath['models/huge.obj']?.limit?.what === 'bytes', 'the huge file is over the size cap without being parsed');
  const asm = byPath['models/assembly.obj'];
  check(asm?.diff?.partsTotal === 1 && asm.diff.parts[0].name === 'knob' && Math.abs(asm.diff.parts[0].rotationDeg - 30) < 0.5, `the knob reads as one moved part, turned 30° (${JSON.stringify(asm?.diff?.parts)})`);
  check(asm?.diff?.vertices.added === 0 && asm.diff.vertices.removed === 0 && asm.diff.vertices.moved === 8, `8 moved vertices, none added or removed (${JSON.stringify(asm?.diff?.vertices)})`);

  dog.mark('check the images');
  const images = Object.fromEntries(log.map((l) => [l.path, { ...l, img: decodePng(fs.readFileSync(path.join(out1, l.image))) }]));
  check(log.length === 5, `5 images rendered (got ${log.length})`);
  for (const l of Object.values(images)) {
    fs.copyFileSync(path.join(out1, l.image), path.join(shots, `action-${l.image}`));
    const ps = panels(l.img, l.capture);
    const content = ps.reduce((s, p) => s + p.total - p.counts.bg, 0) / ps.reduce((s, p) => s + p.total, 0);
    check(l.img.width === 1600 && content > 0.02, `${JSON.stringify(l.path).slice(0, 30)}: ${l.img.width}×${l.img.height}, ${(content * 100).toFixed(1)}% model pixels (not blank)`);
  }
  const [asmBefore, asmAfter] = panels(images['models/assembly.obj'].img, images['models/assembly.obj'].capture);
  console.log(`   assembly before ${JSON.stringify(asmBefore.counts)}\n   assembly after  ${JSON.stringify(asmAfter.counts)}`);
  check(asmBefore.counts.yellow > 500 && asmAfter.counts.yellow > 500, 'the moved knob is yellow in both panels');
  check(asmBefore.counts.green + asmBefore.counts.red + asmAfter.counts.green + asmAfter.counts.red < 50, 'nothing is added or removed in the assembly');
  const cams = images['models/assembly.obj'].capture.panels.map((p) => JSON.stringify(p.camera));
  check(cams[0] === cams[1], 'before and after have identical cameras');
  let both = 0;
  let same = 0;
  for (let i = 0; i < asmBefore.cls.length; i++) {
    if (asmBefore.cls[i] !== 'grey' || asmAfter.cls[i] !== 'grey') continue;
    both++;
    if (asmBefore.rgb[i] === asmAfter.rgb[i]) same++;
  }
  check(both > 20_000 && same / both > 0.99, `the unchanged plate is pixel-identical in both panels (${same} of ${both} grey pixels, ${((same / both) * 100).toFixed(2)}%)`);
  const [newBefore, newAfter] = panels(images['models/New-Part.STL'].img, images['models/New-Part.STL'].capture);
  check(newAfter.counts.green > 500 && newBefore.counts.bg / newBefore.total > 0.9, 'an added model is green, with an empty before panel');
  const [delBefore, delAfter] = panels(images['models/old-bracket.stl'].img, images['models/old-bracket.stl'].capture);
  check(delBefore.counts.red > 500 && delAfter.counts.bg / delAfter.total > 0.9, 'a deleted model is red, with an empty after panel');
  check(panels(images['models/scan-local.stl'].img, images['models/scan-local.stl'].capture)[1].counts.green > 500, 'an LFS pointer whose object is in the local LFS store is rendered from it');

  // ---- 3 + 4. post -----------------------------------------------------------------------------------
  dog.mark('post: same-repo pull request');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const remoteRoot = path.join(tmp, 'server');
  const bare = path.join(remoteRoot, 'octo/models.git');
  fs.mkdirSync(bare, { recursive: true });
  await git(bare, 'init', '-q', '--bare');
  const pull = (head, headRepo = REPO) => ({ number: 42, head: { sha: head, repo: { full_name: headRepo } }, base: { ref: 'main', repo: { full_name: REPO } } });
  api.pulls.set(42, pull(head1));
  api.pulls.set(43, { number: 43, head: { sha: 'f'.repeat(40), repo: { full_name: 'someone/else' } }, base: { ref: 'main', repo: { full_name: REPO } } });
  for (let i = 0; i < 150; i++) api.comments.push({ id: i + 1, issue: 42, user: { login: `user${i}`, type: 'User' }, body: `comment ${i}` });
  const strangerBody = '<!-- polymerge:pr-diff -->\nI pasted the marker into my own comment.';
  api.comments.push({ id: 999, issue: 42, user: { login: 'mallory', type: 'User' }, body: strangerBody });
  const postEnv = (eventName, eventJson, resultDir) => ({
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventFile(`post-${eventName}-${Math.random().toString(36).slice(2)}.json`, eventJson),
    GITHUB_REPOSITORY: REPO,
    GITHUB_API_URL: apiUrl,
    GITHUB_SERVER_URL: `file://${remoteRoot}`,
    GITHUB_OUTPUT: path.join(tmp, 'post-output.txt'),
    GITHUB_STEP_SUMMARY: path.join(tmp, 'post-summary.md'), // never the real job summary when CI runs this
    POLYMERGE_TOKEN: TOKEN,
    POLYMERGE_RESULT: resultDir,
  });
  r = await run('action/post.mjs', [], postEnv('pull_request', event(head1), out1));
  check(r.code === 0, `post (same-repo pull_request) exits 0${r.code ? `:\n${r.out}` : ''}`);
  const ours = () => api.comments.filter((c) => c.user.login === BOT.login);
  check(ours().length === 1 && api.writes.length === 1 && api.writes[0][0] === 'create', `it creates one comment (writes ${JSON.stringify(api.writes)})`);
  const commit1 = await git(bare, 'rev-parse', 'refs/heads/polymerge-images');
  const body1 = ours()[0]?.body ?? '';
  fs.writeFileSync(path.join(shots, 'action-comment.md'), body1);
  const urls = [...body1.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
  check(urls.length === 5 && urls.every((u) => u.startsWith(`file://${remoteRoot}/octo/models/raw/${commit1}/pr-42/${head1.slice(0, 12)}/`)), `5 images, each pinned to the image commit ${commit1.slice(0, 7)}`);
  let pushedOk = true;
  for (const l of log) {
    const blob = await new Promise((resolve) => {
      const child = spawn('git', ['cat-file', 'blob', `${commit1}:pr-42/${head1.slice(0, 12)}/${l.image}`], { cwd: bare });
      const parts = [];
      child.stdout.on('data', (d) => parts.push(d));
      child.on('close', () => resolve(Buffer.concat(parts)));
    });
    pushedOk &&= blob.equals(fs.readFileSync(path.join(out1, l.image)));
  }
  check(pushedOk, 'the image branch holds exactly the rendered PNGs');

  dog.mark('check the comment');
  check(body1.startsWith('<!-- polymerge:pr-diff -->\n### 3D model diff'), 'the comment starts with the hidden marker and a heading');
  check(body1.includes(`against \`main\` (merge base \`${forkPoint.slice(0, 7)}\`)`), 'it names the base branch and the merge base');
  check(/\| `models\/assembly\.obj` \| 🟨 1 part moved · 8 vertices moved/.test(body1), 'the table summarises the moved part');
  check(/\| `models\/lid\.stl` → `models\/cover\.stl` \| renamed, content unchanged \|/.test(body1), 'the pure rename is a row, without an image');
  check(/`models\/broken\.obj` could not be read as a model: `.*no triangle faces`/.test(body1), 'the unreadable file gets an error note with the parser message');
  check(/`models\/scan\.glb` is stored in \*\*Git LFS\*\*.*`lfs: true`/.test(body1), 'the LFS pointer gets the how-to-enable-LFS note');
  check(/too large to render \(6,000 faces; limit 5,000\)/.test(body1) && /too large to render \(2,097,\d+ bytes; limit 1,048,576\)/.test(body1), 'the capped models say why they are not rendered');
  check(/`models\/zz-extra\.obj` \| not rendered: over the limit of 9 models per comment/.test(body1), 'files over max-files are listed');
  check(/- \*\*Moved part\*\* `knob` moved [\d.]+, turned 30°/.test(body1), 'the section names the moved part');
  check(body1.includes('Matched by Tier 1 · index/ID (direct lineage).'), 'the section says how the correspondence was found');
  check(body1.includes(`git fetch origin pull/42/head\ngit show ${forkPoint.slice(0, 12)}:models/assembly.obj > before.obj\ngit show ${head1.slice(0, 12)}:models/assembly.obj > after.obj\nnpx @joshuahurley/polymerge view before.obj after.obj`), 'it gives the local command to explore the diff');
  check(body1.includes('Rendered by [polymerge](https://github.com/Joshua080/polymerge)'), 'the footer links the project');
  // The hostile name: outside code spans and our own <img> tags, none of it may survive.
  const outside = body1
    .replace(/<img src="[^"<>]*" width="800" alt="[^"<>]*">/g, '')
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, '');
  check(!/onerror|<img|\]\(javascript|@octocat|\*b\*|\$\(id\)/.test(outside) && body1.includes('onerror'),'the hostile name appears only inside code spans (no HTML, link, mention or emphasis)');
  check(!body1.includes(String.fromCodePoint(0x202e)) && body1.includes('\\u{202e}') && body1.includes('\\nx.stl') && !body1.split('\n').some((l) => l.startsWith('x.stl')), 'its invisible and newline characters are shown as escapes');
  const rows = body1.split('\n').filter((l) => l.startsWith('| '));
  check(rows.length === 13 && rows.every((l) => l.replace(/\\\|/g, '').split('|').length === 4), `every table row keeps exactly two cells (${rows.length} rows)`);
  check(api.comments.find((c) => c.id === 999)?.body === strangerBody, "a stranger's comment carrying the marker is not touched");

  // ---- a new push, posted the fork-safe way (workflow_run + artifact) --------------------------------
  dog.mark('render the second push');
  write('models/assembly.obj', assembly(45, [6, 0, -0.5]));
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'turn the knob further');
  const head2 = await git(repo, 'rev-parse', 'HEAD');
  const out2 = path.join(tmp, 'out2');
  r = await run('action/render.mjs', [], renderEnv(out2, head2));
  check(r.code === 0, `render of the second push exits 0${r.code ? `:\n${r.out}` : ''}`);
  dog.mark('post: workflow_run');
  api.pulls.set(42, pull(head2, 'fork/models'));
  const workflowRun = (head, extra = {}) => ({ workflow_run: { id: 7, event: 'pull_request', conclusion: 'success', head_sha: head, head_repository: { full_name: 'fork/models' }, pull_requests: [], ...extra } });
  const writesBefore = api.writes.length;
  r = await run('action/post.mjs', [], postEnv('workflow_run', workflowRun(head2), out2));
  check(r.code === 0, `post (workflow_run, fork) exits 0${r.code ? `:\n${r.out}` : ''}`);
  const commit2 = await git(bare, 'rev-parse', 'refs/heads/polymerge-images');
  check(ours().length === 1 && api.writes.length === writesBefore + 1 && api.writes.at(-1)[0] === 'update' && api.writes.at(-1)[1] === ours()[0].id, 'the second push updates the same comment (found past the first page of 100)');
  check(ours()[0].body.includes(`updated for \`${head2.slice(0, 7)}\``) && ours()[0].body.includes(`/raw/${commit2}/`), 'the updated comment shows the new head and the new images');
  check((await git(bare, 'rev-parse', `${commit2}^`)) === commit1, 'the image branch keeps the earlier commit (old image URLs stay valid)');

  dog.mark('post: rejections');
  const tampered = (name, edit) => {
    const dir = path.join(tmp, name);
    fs.cpSync(out2, dir, { recursive: true });
    const res = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    edit(res, dir);
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(res));
    return dir;
  };
  const noWrites = async (label, env, expectCode) => {
    const n = api.writes.length;
    const before = await git(bare, 'rev-parse', 'refs/heads/polymerge-images');
    const res = await run('action/post.mjs', [], env);
    const after = await git(bare, 'rev-parse', 'refs/heads/polymerge-images');
    check(res.code === expectCode && api.writes.length === n && before === after, `${label} (exit ${res.code}, no comment written, no image pushed)`);
    return res;
  };
  await noWrites('an artifact naming another pull request is skipped', postEnv('workflow_run', workflowRun(head2), tampered('t-pr', (x) => (x.pr = 43))), 0);
  let t = await noWrites('an artifact for another commit is rejected', postEnv('workflow_run', workflowRun(head2), tampered('t-head', (x) => (x.head = head1))), 1);
  check(/rejected the render result/.test(t.out), '… with an error that says so');
  await noWrites('an image path outside the artifact is rejected', postEnv('workflow_run', workflowRun(head2), tampered('t-path', (x) => (x.files.find((f) => f.image).image = '../result.json'))), 1);
  await noWrites('an image that is not a PNG is rejected', postEnv('workflow_run', workflowRun(head2), tampered('t-png', (x, dir) => fs.writeFileSync(path.join(dir, x.files.find((f) => f.image).image), '<svg onload=alert(1)>'))), 1);
  await noWrites('a run that did not succeed posts nothing', postEnv('workflow_run', workflowRun(head2, { conclusion: 'failure' }), out2), 0);
  t = await noWrites('a fork pull_request run (read-only token) only warns', postEnv('pull_request', event(head2, 'fork/models'), out2), 0);
  check(/::warning::.*fork/.test(t.out), '… with a warning pointing at the two-workflow setup');

  // ---- a push that removes every model change -------------------------------------------------------
  dog.mark('render a push without model changes');
  await git(repo, 'rm', '-rq', 'models');
  await git(repo, 'checkout', '-q', forkPoint, '--', 'models');
  await git(repo, 'commit', '-qm', 'drop the model changes');
  const head3 = await git(repo, 'rev-parse', 'HEAD');
  const out3 = path.join(tmp, 'out3');
  r = await run('action/render.mjs', ['--list'], renderEnv(out3, head3));
  const empty = JSON.parse(fs.readFileSync(path.join(out3, 'result.json'), 'utf8'));
  check(r.code === 0 && empty.files.length === 0, `render --list writes an empty result by itself (${empty.files.length} files)`);
  api.pulls.set(42, pull(head3));
  r = await run('action/post.mjs', [], postEnv('pull_request', event(head3), out3));
  check(r.code === 0 && ours().length === 1 && ours()[0].body.includes('no longer changes any 3D model files') && !ours()[0].body.includes('<img'), 'the comment is updated to say there are no model changes any more');
  check(api.unauthorised === 0, 'every API call carried the token');

  // ---- GitHub's merge ref, with an out-of-date base.sha in the event ----------------------------------
  dog.mark('render at a merge ref');
  await git(repo, 'merge', '-q', '--no-edit', 'main'); // the branch takes main in, main-only.stl included
  const headM = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', '--detach', 'main');
  await git(repo, 'merge', '-q', '--no-ff', '--no-edit', headM); // what actions/checkout checks out: parents (base, head)
  const out4 = path.join(tmp, 'out4');
  const stale = { pull_request: { number: 42, base: { sha: forkPoint, ref: 'main', repo: { full_name: REPO } }, head: { sha: headM, ref: 'feature', repo: { full_name: REPO } } } };
  r = await run('action/render.mjs', ['--list'], { ...renderEnv(out4, headM), GITHUB_EVENT_PATH: eventFile('event-stale.json', stale) });
  const atMerge = fs.existsSync(path.join(out4, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(out4, 'result.json'), 'utf8')) : null;
  check(r.code === 0 && atMerge?.base === mainTip && atMerge.files.length === 0, `at the merge ref, the base is its first parent, not the event's older base.sha (merge base ${atMerge?.base?.slice(0, 7)}, main ${mainTip.slice(0, 7)}; main's own file not listed)`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures === 0 ? 'e2e-action: PASS' : `e2e-action: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
