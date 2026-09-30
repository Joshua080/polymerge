/**
 * "Save to repository" from the merge review, attacked through the REAL server and REAL git
 * repositories. Threat model: docs/write-back-security.md (§ numbers below refer to it).
 *
 * Every refused request must fail safely: an error status, the work-tree file byte-identical,
 * the index still conflicted (stages 1/2/3), no temporary file left, nothing written elsewhere.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMesh, WRITABLE_FORMATS, writeObj, writeStl } from 'polymerge-core';
import { resolveStages } from '../src/commands/merge.js';
import { startViewServer } from '../src/commands/view.js';
import { hostAllowed, isLoopbackAddress, originAllowed, staticAllowlist, staticFile, tokenMatches } from '../src/serve-guard.js';
import { parseSaveRequest, ReviewWriteBack } from '../src/write-back.js';

// ---- Models --------------------------------------------------------------------------------

/** 6×6 vertex grid (spacing 1) with optional vertex moves. */
function grid(moves: Record<number, [number, number, number]> = {}) {
  const pos: number[] = [];
  for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) pos.push(i, j, 0);
  for (const [k, d] of Object.entries(moves)) for (let a = 0; a < 3; a++) pos[Number(k) * 3 + a] += d[a];
  const faces: number[] = [];
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 5; i++) {
      const a = j * 6 + i;
      faces.push(a, a + 1, a + 7, a, a + 7, a + 6);
    }
  }
  return createMesh(pos, faces);
}

/** Two parallel sheets (z = 0 and z = 1); resolving #0 'ours' pushes the lower through the upper. */
function sheets(moves: Record<number, [number, number, number]> = {}) {
  const g = grid();
  const pos = [...g.positions, ...g.positions.map((x, i) => (i % 3 === 2 ? x + 1 : x))];
  for (const [k, d] of Object.entries(moves)) for (let a = 0; a < 3; a++) pos[Number(k) * 3 + a] += d[a];
  return createMesh(pos, [...g.faces, ...g.faces.map((f) => f + 36)]);
}

/** One move-move conflict (#0) at vertex 14: ours raises it, theirs lowers it. */
const GRID: [Uint8Array, Uint8Array, Uint8Array] = [writeObj(grid()), writeObj(grid({ 14: [0, 0, 1] })), writeObj(grid({ 14: [0, 0, -1] }))];
const SHEETS: [Uint8Array, Uint8Array, Uint8Array] = [
  writeStl(sheets()),
  writeStl(sheets({ 14: [0, 0, 0.7] })),
  writeStl(sheets({ 14: [0, 0, 0.2], 50: [0, 0, -0.5] })),
];

// ---- Repositories with an unresolved conflict -------------------------------------------------

let tmp = '';
let webDist = '';
const servers: http.Server[] = [];

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'polymerge-write-back-')));
  // A stand-in viewer, with a secret NEXT TO it that traversal must never reach.
  webDist = path.join(tmp, 'viewer');
  fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>viewer</title>');
  fs.writeFileSync(path.join(webDist, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP-SECRET');
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface IRepo {
  dir: string;
  rel: string;
  file: string;
  /** The work-tree file as the merge driver left it. */
  before: Buffer;
  git: (...args: string[]) => string;
}

/** A repository whose index holds `rel` unmerged (stages 1/2/3), as a conflicted `git merge` leaves it. */
function conflictRepo(stages: [Uint8Array, Uint8Array, Uint8Array], rel = 'part.obj'): IRepo {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const gitIn = (input: string | Uint8Array, ...args: string[]): string => execFileSync('git', args, { cwd: dir, input, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@polymerge.test');
  git('config', 'user.name', 'polymerge test');
  git('config', 'commit.gpgsign', 'false');
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stages[0]);
  git('add', '-A');
  git('commit', '-qm', 'base');
  const oids = stages.map((s) => gitIn(s, 'hash-object', '-w', '--stdin').trim());
  gitIn(`0 ${'0'.repeat(40)}\t${rel}\n${oids.map((o, i) => `100644 ${o} ${i + 1}\t${rel}\n`).join('')}`, 'update-index', '--index-info');
  const before = Buffer.from(stages[0]);
  fs.writeFileSync(file, before);
  return { dir, rel, file, before, git };
}

const unmergedCount = (repo: IRepo): number => repo.git('ls-files', '-u', '--', repo.rel).split('\n').filter(Boolean).length;
const tempFiles = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n.includes('.polymerge-'));

/** The refusal left everything as it was. */
function expectUntouched(repo: IRepo): void {
  expect(fs.lstatSync(repo.file).isFile()).toBe(true);
  expect(fs.readFileSync(repo.file).equals(repo.before)).toBe(true);
  expect(unmergedCount(repo)).toBe(3);
  expect(tempFiles(path.dirname(repo.file))).toEqual([]);
}

// ---- Server and requests -----------------------------------------------------------------------

interface IReview {
  session: ReviewWriteBack;
  port: number;
  url: string;
  token: string;
}

async function startReview(repo: IRepo, o: { host?: string; resolve?: typeof resolveStages } = {}): Promise<IReview & { writeRoutes: boolean }> {
  const session = await ReviewWriteBack.open(repo.rel, repo.dir, { resolve: o.resolve });
  const files = ([1, 2, 3] as const).map((n) => ({ name: path.basename(repo.rel), bytes: session.stages[n] }));
  const { server, url, writeRoutes } = await startViewServer(files, { host: o.host ?? '127.0.0.1', port: '0', webDist, name: repo.rel }, {}, session);
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  return { session, port, url, token: /#token=(.+)$/.exec(url)?.[1] ?? '', writeRoutes };
}

interface IResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A raw HTTP request to 127.0.0.1:port, with full control over the headers (including Host). */
function send(port: number, p: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<IResponse> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...o.headers };
    if (o.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'transfer-encoding')) {
      headers['content-length'] ??= String(Buffer.byteLength(o.body));
    }
    const req = http.request({ host: '127.0.0.1', port, path: p, method: o.method ?? 'GET', headers, agent: false }, (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // The server may answer and close before an oversized body is fully sent.
    req.on('error', (err) => {
      if (!answered) reject(err);
    });
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** The headers the real viewer sends with a save. */
const viewerHeaders = (r: IReview): Record<string, string> => ({
  origin: `http://127.0.0.1:${r.port}`,
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
  'x-polymerge-token': r.token,
});

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** What `polymerge resolve <path> --pick …` writes, and its digest (what the viewer sends as `expect`). */
async function expected(r: IReview, pick: string[]): Promise<{ bytes: Uint8Array; expect: string }> {
  const { bytes } = await resolveStages((n) => r.session.stages[n], r.session.indexPath, { pick });
  return { bytes, expect: sha256(bytes) };
}

const save = (r: IReview, body: unknown, headers: Record<string, string> = {}): Promise<IResponse> =>
  send(r.port, '/api/review/save', { method: 'POST', headers: { ...viewerHeaders(r), ...headers }, body: JSON.stringify(body) });

// ---- Tests -------------------------------------------------------------------------------------

describe('request guards (unit)', () => {
  it('Host: localhost or an IP literal on this port; the write routes: loopback only (§4.2)', () => {
    for (const ok of ['127.0.0.1:5178', 'localhost:5178', 'LOCALHOST:5178', '[::1]:5178', '127.0.0.2:5178']) expect(hostAllowed(ok, 5178, true), ok).toBe(true);
    expect(hostAllowed('10.0.0.5:5178', 5178)).toBe(true); // read-only viewing by IP (--host 0.0.0.0)
    expect(hostAllowed('10.0.0.5:5178', 5178, true)).toBe(false);
    for (const bad of [
      undefined,
      '',
      'evil.example:5178',
      '127.0.0.1.evil.example:5178',
      'localhost.:5178',
      'sub.localhost:5178',
      '127.0.0.1:5179',
      '127.0.0.1',
      '127.0.0.1:5178/x',
      'user@127.0.0.1:5178',
      '127.0.0.1:5178?x',
    ]) {
      expect(hostAllowed(bad, 5178), String(bad)).toBe(false);
    }
  });

  it('Origin: only the viewer’s own loopback origins (§4.1)', () => {
    expect(originAllowed('http://127.0.0.1:5178', 5178)).toBe(true);
    expect(originAllowed('http://localhost:5178', 5178)).toBe(true);
    for (const bad of [undefined, 'null', 'https://127.0.0.1:5178', 'http://127.0.0.1:3000', 'http://evil.example:5178', 'http://10.0.0.5:5178', 'http://127.0.0.1:5178/x']) {
      expect(originAllowed(bad, 5178), String(bad)).toBe(false);
    }
  });

  it('loopback addresses, and constant-time token comparison (§4.3, §4.4)', () => {
    for (const a of ['127.0.0.1', '127.9.8.7', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of [undefined, '0.0.0.0', '::', '192.168.1.2', '::ffff:10.0.0.1', 'localhost']) expect(isLoopbackAddress(a), String(a)).toBe(false);
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('abcd', 'abc')).toBe(false);
    expect(tokenMatches(['abc', 'abc'], 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });

  it('static files: exact allowlist lookup, so traversal has nothing to match (§4.9)', () => {
    const list = staticAllowlist(webDist);
    expect(staticFile(list, '/')).toBe(path.join(webDist, 'index.html'));
    expect(staticFile(list, '/assets/app.js')).toBe(path.join(webDist, 'assets', 'app.js'));
    for (const bad of [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%5csecret.txt',
      '/assets%5c..%5c..%5csecret.txt',
      '/C:/Windows/win.ini',
      '/C:%5cWindows%5cwin.ini',
      '/index.html%00.js',
      '/%252e%252e/secret.txt',
      '/%E0%A4%A',
      '/index.html::$DATA',
    ]) {
      expect(staticFile(list, bad), bad).toBeNull();
    }
  });

  it('a save body names choices only (§4.5)', () => {
    const expect64 = 'a'.repeat(64);
    expect(parseSaveRequest({ picks: { 0: 'theirs', 12: 'base' }, expect: expect64 }).picks).toEqual(new Map([[0, 'theirs'], [12, 'base']]));
    for (const bad of [
      null,
      [],
      'x',
      { picks: {}, expect: expect64, path: '/etc/passwd' },
      { picks: {}, expect: expect64, bytes: 'AAAA' },
      { picks: {}, expect: expect64, format: 'obj' },
      JSON.parse(`{"picks":{},"expect":"${expect64}","__proto__":{"x":1}}`),
      { picks: { '-1': 'ours' }, expect: expect64 },
      { picks: { '01': 'ours' }, expect: expect64 },
      JSON.parse(`{"picks":{"__proto__":"ours"},"expect":"${expect64}"}`),
      { picks: { 0: 'mine' }, expect: expect64 },
      { picks: [], expect: expect64 },
      { picks: {}, expect: 'A'.repeat(64) },
      { picks: {}, expect: expect64, acknowledgeWarnings: 'yes' },
    ]) {
      expect(() => parseSaveRequest(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('the viewer server: Host on every route, allowlisted files, model types (§4.2, §4.9)', () => {
  const model = (name: string) => ({ name, bytes: new TextEncoder().encode('MODEL-BYTES solid x') });

  it('a hostile Host header is refused on every GET route, and nothing is served', async () => {
    const { server, url } = await startViewServer([model('a.obj'), model('b.obj'), model('c.obj')], { port: '0', webDist }, {});
    servers.push(server);
    const u = new URL(url);
    const port = Number(u.port);
    const modelPath = u.searchParams.get('base')!;
    expect((await send(port, modelPath)).body).toContain('MODEL-BYTES'); // control: the right Host works
    for (const p of ['/', '/index.html', '/assets/app.js', modelPath]) {
      for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `127.0.0.1:${port + 1}`]) {
        const res = await send(port, p, { headers: { host } });
        expect(res.status, `${p} with Host ${host}`).toBe(403);
        expect(res.body).not.toContain('MODEL-BYTES');
      }
    }
  });

  it('traversal attempts over HTTP get 404 and never the file next to the viewer', async () => {
    const { server, url } = await startViewServer([], { port: '0', webDist }, { case: 'x' });
    servers.push(server);
    const port = Number(new URL(url).port);
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/assets/..%5c..%5csecret.txt', '/C:/secret.txt', '/%252e%252e/secret.txt', '/index.html%00', '/%zz']) {
      const res = await send(port, p);
      expect(res.status, p).toBe(404);
      expect(res.body).not.toContain('TOP-SECRET');
    }
  });

  it('security headers on every response; models only as model types; per-session model URLs', async () => {
    const { server, url } = await startViewServer([model('x.html'), model('y.stl')], { port: '0', webDist }, {});
    servers.push(server);
    const u = new URL(url);
    const port = Number(u.port);
    const page = await send(port, '/');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(page.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    // A model named *.html is never served as HTML on the viewer's origin.
    expect((await send(port, u.searchParams.get('base')!)).headers['content-type']).toBe('application/octet-stream');
    expect((await send(port, u.searchParams.get('target')!)).headers['content-type']).toBe('model/stl');
    // Model paths carry a random segment: the predictable old path serves nothing.
    expect(u.searchParams.get('base')).toMatch(/^\/models\/[0-9a-f]{24}\/base\/x\.html$/);
    expect((await send(port, '/models/base/x.html')).status).toBe(404);
    expect(url).not.toContain('#token=');
  });

  it('`demo` and `view` have no write routes (404), whatever is sent (§5)', async () => {
    const demo = await startViewServer([], { port: '0', webDist }, { mode: 'merge', demo: 'boss-height' });
    const view = await startViewServer([model('a.obj'), model('b.obj'), model('c.obj')], { port: '0', webDist }, {});
    servers.push(demo.server, view.server);
    for (const { url, writeRoutes } of [demo, view]) {
      expect(writeRoutes).toBe(false);
      const port = Number(new URL(url).port);
      const headers = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-polymerge-token': 'x'.repeat(43) };
      expect((await send(port, '/api/review/session', { headers })).status).toBe(404);
      expect((await send(port, '/api/review/save', { method: 'POST', headers, body: JSON.stringify({ picks: {}, expect: 'a'.repeat(64) }) })).status).toBe(404);
    }
  });
});

describe('polymerge review: saving to the repository', () => {
  it('happy path: writes exactly what `polymerge resolve --pick` writes, stages it, and only once', async () => {
    const repo = conflictRepo(GRID);
    expect(repo.git('status', '--short').trim()).toBe('UU part.obj');
    const r = await startReview(repo);
    expect(r.writeRoutes).toBe(true);
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const info = await send(r.port, '/api/review/session', { headers: { 'x-polymerge-token': r.token, 'sec-fetch-site': 'same-origin' } });
    expect(JSON.parse(info.body)).toEqual({ path: 'part.obj', name: 'part.obj', format: 'obj', writable: true });

    const { bytes, expect: digest } = await expected(r, ['0=theirs']);
    const res = await save(r, { picks: { 0: 'theirs' }, expect: digest });
    expect(res.status, res.body).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, written: true, staged: true, path: 'part.obj' });
    expect(fs.readFileSync(repo.file).equals(Buffer.from(bytes))).toBe(true);
    expect(unmergedCount(repo)).toBe(0);
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('part.obj');
    expect(repo.git('status', '--short').trim()).toBe('M  part.obj');
    expect(tempFiles(repo.dir)).toEqual([]);
    // The write it authorised is spent.
    const again = await save(r, { picks: { 0: 'theirs' }, expect: digest });
    expect(again.status).toBe(409);
    expect(JSON.parse(again.body).code).toBe('saved');
  });

  it('refuses a missing or wrong token, and a token anywhere but its header (§4.1, §4.3)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo);
    const { expect: digest } = await expected(r, ['0=theirs']);
    const body = { picks: { 0: 'theirs' }, expect: digest };
    const { 'x-polymerge-token': _token, ...noToken } = viewerHeaders(r);
    const attempts: [string, Promise<IResponse>][] = [
      ['no token', send(r.port, '/api/review/save', { method: 'POST', headers: noToken, body: JSON.stringify(body) })],
      ['wrong token', save(r, body, { 'x-polymerge-token': 'A'.repeat(43) })],
      ['token prefix', save(r, body, { 'x-polymerge-token': r.token.slice(0, 20) })],
      ['token in the query', send(r.port, `/api/review/save?token=${r.token}`, { method: 'POST', headers: noToken, body: JSON.stringify(body) })],
      ['token in the body', send(r.port, '/api/review/save', { method: 'POST', headers: noToken, body: JSON.stringify({ ...body, token: r.token }) })],
      ['token in a cookie', send(r.port, '/api/review/save', { method: 'POST', headers: { ...noToken, cookie: `token=${r.token}` }, body: JSON.stringify(body) })],
      ['token as a bearer', send(r.port, '/api/review/save', { method: 'POST', headers: { ...noToken, authorization: `Bearer ${r.token}` }, body: JSON.stringify(body) })],
      ['session info without token', send(r.port, '/api/review/session')],
    ];
    for (const [label, pending] of attempts) {
      const res = await pending;
      expect(res.status, label).toBe(403);
      expect(res.body).not.toContain(r.token);
    }
    expectUntouched(repo);
  });

  it('refuses a hostile Host (DNS rebinding) on POST and GET, even with the right token (§4.2)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo);
    const { expect: digest } = await expected(r, ['0=theirs']);
    const modelPath = new URL(r.url).searchParams.get('base')!;
    for (const host of [`evil.example:${r.port}`, `127.0.0.1.nip.io:${r.port}`, `localhost:${r.port + 1}`]) {
      expect((await save(r, { picks: { 0: 'theirs' }, expect: digest }, { host })).status, host).toBe(403);
      expect((await send(r.port, '/api/review/session', { headers: { host, 'x-polymerge-token': r.token } })).status, host).toBe(403);
      const model = await send(r.port, modelPath, { headers: { host } });
      expect(model.status, host).toBe(403);
      expect(model.body).not.toContain('v 2 2');
    }
    // A non-loopback IP literal may VIEW (--host 0.0.0.0 use) but never reaches the write routes.
    for (const host of [`10.0.0.5:${r.port}`, `0.0.0.0:${r.port}`, `[fe80::1]:${r.port}`]) {
      expect((await send(r.port, modelPath, { headers: { host } })).status, `view via ${host}`).toBe(200);
      expect((await save(r, { picks: { 0: 'theirs' }, expect: digest }, { host })).status, `save via ${host}`).toBe(403);
      expect((await send(r.port, '/api/review/session', { headers: { host, 'x-polymerge-token': r.token } })).status, host).toBe(403);
    }
    expectUntouched(repo);
  });

  it('refuses cross-origin requests and the shapes a cross-site page can send (§4.1)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo);
    const { expect: digest } = await expected(r, ['0=theirs']);
    const body = { picks: { 0: 'theirs' }, expect: digest };
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${r.port + 1}`, `https://127.0.0.1:${r.port}`]) {
      expect((await save(r, body, { origin })).status, origin).toBe(403);
    }
    const { origin: _o, ...noOrigin } = viewerHeaders(r);
    expect((await send(r.port, '/api/review/save', { method: 'POST', headers: noOrigin, body: JSON.stringify(body) })).status, 'no Origin').toBe(403);
    expect((await save(r, body, { 'sec-fetch-site': 'cross-site' })).status, 'Sec-Fetch-Site').toBe(403);
    // A form post: text/plain or urlencoded, no custom header.
    const form = await send(r.port, '/api/review/save', {
      method: 'POST',
      headers: { origin: 'http://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify(body),
    });
    expect(form.status).toBe(403);
    expect((await save(r, body, { 'content-type': 'text/plain' })).status, 'text/plain with the token').toBe(415);
    expect((await save(r, body, { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    // The CORS preflight a cross-origin fetch needs is never approved.
    const preflight = await send(r.port, '/api/review/save', {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-polymerge-token' },
    });
    expect(preflight.status).toBe(405);
    expect(Object.keys(preflight.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    expect((await send(r.port, '/api/review/save', { headers: { 'x-polymerge-token': r.token } })).status, 'GET on the save route').toBe(405);
    expectUntouched(repo);
  });

  it('refuses a body that names a path or carries file bytes, bad ids, bad JSON, oversize bodies (§4.5, §4.10)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo);
    const { expect: digest } = await expected(r, ['0=theirs']);
    const elsewhere = path.join(tmp, 'pwned.obj');
    const cases: [string, unknown, number][] = [
      ['a path', { picks: { 0: 'theirs' }, expect: digest, path: elsewhere }, 400],
      ['a relative path', { picks: { 0: 'theirs' }, expect: digest, file: '../../.bashrc' }, 400],
      ['file bytes', { picks: { 0: 'theirs' }, expect: digest, bytes: Buffer.from('v 0 0 0\n').toString('base64') }, 400],
      ['model text', { picks: { 0: 'theirs' }, expect: digest, content: 'v 0 0 0\nf 1 1 1\n' }, 400],
      ['a format', { picks: { 0: 'theirs' }, expect: digest, format: 'stl' }, 400],
      ['an unknown conflict id', { picks: { 0: 'theirs', 7: 'ours' }, expect: digest }, 400],
      ['a bad side', { picks: { 0: 'mine' }, expect: digest }, 400],
      ['no digest', { picks: { 0: 'theirs' } }, 400],
      ['a wrong digest', { picks: { 0: 'theirs' }, expect: sha256(new Uint8Array([1])) }, 409],
      ['a digest for other choices', { picks: { 0: 'ours' }, expect: digest }, 409],
    ];
    for (const [label, body, status] of cases) {
      const res = await save(r, body);
      expect(res.status, `${label}: ${res.body}`).toBe(status);
      expect(JSON.parse(res.body).written).toBe(false);
    }
    expect((await send(r.port, '/api/review/save', { method: 'POST', headers: viewerHeaders(r), body: '{"picks": ' })).status, 'invalid JSON').toBe(400);
    const big = JSON.stringify({ picks: { 0: 'theirs' }, expect: digest, pad: 'x'.repeat(100_000) });
    expect((await send(r.port, '/api/review/save', { method: 'POST', headers: viewerHeaders(r), body: big })).status, 'Content-Length too large').toBe(413);
    const chunked = await send(r.port, '/api/review/save', { method: 'POST', headers: { ...viewerHeaders(r), 'transfer-encoding': 'chunked' }, body: big });
    expect(chunked.status, 'chunked body too large').toBe(413);
    expect(fs.existsSync(elsewhere)).toBe(false);
    expectUntouched(repo);
  });

  it('never marks an unresolved merge resolved (§4.8)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo);
    const { expect: unresolvedDigest } = await expected(r, []);
    const res = await save(r, { picks: {}, expect: unresolvedDigest });
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'unresolved', written: false });
    expectUntouched(repo);
  });

  it('collision warnings need an explicit acknowledgement (§4.8, D18)', async () => {
    const repo = conflictRepo(SHEETS, 'part.stl');
    const r = await startReview(repo);
    const { bytes, expect: digest } = await expected(r, ['0=ours']);
    const refused = await save(r, { picks: { 0: 'ours' }, expect: digest });
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'warnings', written: false });
    expect(JSON.parse(refused.body).warnings).toHaveLength(1);
    expectUntouched(repo);
    const saved = await save(r, { picks: { 0: 'ours' }, expect: digest, acknowledgeWarnings: true });
    expect(saved.status, saved.body).toBe(200);
    expect(fs.readFileSync(repo.file).equals(Buffer.from(bytes))).toBe(true);
    expect(unmergedCount(repo)).toBe(0);
  });

  it('refuses when the target was replaced by a symlink after startup, and writes through nothing (§4.6)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo);
    const { expect: digest } = await expected(r, ['0=theirs']);
    const victim = path.join(tmp, `victim-${path.basename(repo.dir)}.txt`);
    fs.writeFileSync(victim, repo.before); // same bytes, so only the file type can give it away
    fs.rmSync(repo.file);
    fs.symlinkSync(victim, repo.file);
    const res = await save(r, { picks: { 0: 'theirs' }, expect: digest });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).code).toBe('not-regular');
    expect(fs.lstatSync(repo.file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(victim).equals(repo.before)).toBe(true);
    expect(unmergedCount(repo)).toBe(3);
    expect(tempFiles(repo.dir)).toEqual([]);
  });

  it('refuses when a parent directory was swapped for a symlink after startup (§4.6)', async () => {
    const repo = conflictRepo(GRID, 'models/part.obj');
    const r = await startReview(repo);
    const { expect: digest } = await expected(r, ['0=theirs']);
    const outside = fs.mkdtempSync(path.join(tmp, 'outside-'));
    fs.writeFileSync(path.join(outside, 'part.obj'), repo.before); // an identical copy, so the content check can't tell
    fs.renameSync(path.join(repo.dir, 'models'), path.join(repo.dir, 'models-real'));
    fs.symlinkSync(outside, path.join(repo.dir, 'models'));
    const res = await save(r, { picks: { 0: 'theirs' }, expect: digest });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).code).toBe('moved');
    expect(fs.readFileSync(path.join(outside, 'part.obj')).equals(repo.before)).toBe(true);
    expect(fs.readFileSync(path.join(repo.dir, 'models-real', 'part.obj')).equals(repo.before)).toBe(true);
    expect(tempFiles(outside)).toEqual([]);
    expect(tempFiles(path.join(repo.dir, 'models-real'))).toEqual([]);
  });

  it('never clobbers the file when it changed on disk after startup (§4.6)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo);
    const { expect: digest } = await expected(r, ['0=theirs']);
    fs.appendFileSync(repo.file, '# my own edit\n');
    const res = await save(r, { picks: { 0: 'theirs' }, expect: digest });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).code).toBe('changed');
    expect(fs.readFileSync(repo.file, 'utf8').endsWith('# my own edit\n')).toBe(true);
    expect(unmergedCount(repo)).toBe(3);
    expect(tempFiles(repo.dir)).toEqual([]);
  });

  it('refuses when the conflict was resolved elsewhere meanwhile (§4.6)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo);
    const { expect: digest } = await expected(r, ['0=theirs']);
    repo.git('add', '--', 'part.obj');
    const res = await save(r, { picks: { 0: 'theirs' }, expect: digest });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).code).toBe('not-conflicted');
    expect(fs.readFileSync(repo.file).equals(repo.before)).toBe(true);
  });

  it('when git add fails after the write: says so, and a retry succeeds (§4.7)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo);
    const { bytes, expect: digest } = await expected(r, ['0=theirs']);
    const lock = path.join(repo.dir, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const failed = await save(r, { picks: { 0: 'theirs' }, expect: digest });
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.body)).toMatchObject({ ok: false, written: true, staged: false, code: 'git-add' });
    expect(JSON.parse(failed.body).message).toMatch(/index\.lock/);
    expect(fs.readFileSync(repo.file).equals(Buffer.from(bytes))).toBe(true);
    expect(unmergedCount(repo)).toBe(3);
    fs.rmSync(lock);
    const retry = await save(r, { picks: { 0: 'theirs' }, expect: digest });
    expect(retry.status, retry.body).toBe(200);
    expect(unmergedCount(repo)).toBe(0);
  });

  it('a non-loopback bind never enables writes (§4.4)', async () => {
    const repo = conflictRepo(GRID);
    const r = await startReview(repo, { host: '0.0.0.0' });
    expect(r.writeRoutes).toBe(false);
    expect(r.url).not.toContain('#token=');
    const headers = { ...viewerHeaders(r), 'x-polymerge-token': r.session.token };
    expect((await send(r.port, '/api/review/session', { headers })).status).toBe(404);
    const { expect: digest } = await expected(r, ['0=theirs']);
    expect((await send(r.port, '/api/review/save', { method: 'POST', headers, body: JSON.stringify({ picks: { 0: 'theirs' }, expect: digest }) })).status).toBe(404);
    expectUntouched(repo);
  });

  it('an unwritable format, or a writer that throws, fails cleanly with nothing written', async () => {
    const ext = ['gltf', 'glb'].find((f) => !(WRITABLE_FORMATS as readonly string[]).includes(f)) ?? 'ply';
    const repo = conflictRepo(GRID, `part.${ext}`);
    const r = await startReview(repo);
    const info = JSON.parse((await send(r.port, '/api/review/session', { headers: { 'x-polymerge-token': r.token } })).body);
    expect(info).toMatchObject({ path: `part.${ext}`, writable: false });
    expect(info.reason).toMatch(/cannot write/);
    const res = await save(r, { picks: { 0: 'theirs' }, expect: 'a'.repeat(64) });
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).code).toBe('not-writable');
    expectUntouched(repo);

    const repo2 = conflictRepo(GRID);
    const r2 = await startReview(repo2, {
      resolve: () => {
        throw new Error('writing is not supported for this format');
      },
    });
    const res2 = await save(r2, { picks: { 0: 'theirs' }, expect: 'a'.repeat(64) });
    expect(res2.status).toBe(500);
    expect(JSON.parse(res2.body)).toMatchObject({ code: 'compute', written: false });
    expectUntouched(repo2);
  });

  it('one save at a time', async () => {
    const repo = conflictRepo(GRID);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = await startReview(repo, {
      resolve: async (stage, p, o) => {
        await gate;
        return resolveStages(stage, p, o);
      },
    });
    const { expect: digest } = await expected(r, ['0=theirs']);
    const first = save(r, { picks: { 0: 'theirs' }, expect: digest });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await save(r, { picks: { 0: 'theirs' }, expect: digest });
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body).code).toBe('busy');
    release();
    expect((await first).status).toBe(200);
  });

  it('opening: the path must be an unresolved conflict inside the work tree; a symlinked file is read-only (§4.6)', async () => {
    const repo = conflictRepo(GRID);
    await expect(ReviewWriteBack.open('../elsewhere.obj', repo.dir)).rejects.toThrow(/outside the repository/);
    fs.writeFileSync(path.join(repo.dir, 'clean.obj'), GRID[0]);
    repo.git('add', 'clean.obj');
    await expect(ReviewWriteBack.open('clean.obj', repo.dir)).rejects.toThrow(/unresolved merge conflict/);
    await expect(ReviewWriteBack.open('*.obj', repo.dir)).rejects.toThrow(/unresolved merge conflict/); // a pathspec glob is not a path
    await expect(ReviewWriteBack.open('PART.obj', repo.dir)).rejects.toThrow(/unresolved merge conflict/); // no case folding
    // From a subdirectory, the argument is relative to the current directory.
    fs.mkdirSync(path.join(repo.dir, 'sub'));
    expect((await ReviewWriteBack.open('../part.obj', path.join(repo.dir, 'sub'))).indexPath).toBe('part.obj');
    const target = path.join(tmp, `target-${path.basename(repo.dir)}.obj`);
    fs.writeFileSync(target, repo.before);
    fs.rmSync(repo.file);
    fs.symlinkSync(target, repo.file);
    const session = await ReviewWriteBack.open('part.obj', repo.dir);
    expect(session.info()).toMatchObject({ writable: false, reason: expect.stringMatching(/symbolic link/) });
  });
});
