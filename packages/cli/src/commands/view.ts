import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFormat, formatFromFileName } from 'polymerge-core';
import { handleReviewApi, REVIEW_API_PREFIX } from '../review-api.js';
import { hostAllowed, isLoopbackAddress, SECURITY_HEADERS, staticAllowlist, staticFile, urlHost } from '../serve-guard.js';
import { findOcct, occtMissingMessage, stepNotMergeable, type OcctLocation } from '../step.js';
import { ReviewWriteBack } from '../write-back.js';

/** Content types of the MODELS served: model types only, never e.g. text/html (docs/write-back-security.md §4.9). */
const MODEL_TYPES: Record<string, string> = {
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.step': 'model/step',
  '.stp': 'model/step',
  '.3mf': 'model/3mf',
  '.ply': 'application/octet-stream',
};

/**
 * Where the viewer finds the optional STEP reader (OpenCascade, occt-import-js), relative to the
 * page: served from the user's own install, so the browser never fetches it from elsewhere.
 */
export const OCCT_VENDOR_PREFIX = '/vendor/occt-import-js/';
const OCCT_VENDOR_FILES: Record<string, string> = {
  'occt-import-js.js': 'text/javascript; charset=utf-8',
  'occt-import-js.wasm': 'application/wasm',
  'license.occt-import-js.txt': 'text/plain; charset=utf-8',
  'license.occt.txt': 'text/plain; charset=utf-8',
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  ...MODEL_TYPES,
};

export interface ViewOptions {
  port?: string;
  host?: string;
  open?: boolean;
  webDist?: string;
  /**
   * Display name for every side (git passes temp files; --name gives the real path). In a
   * merge review it is also the path `polymerge resolve` is suggested for.
   */
  name?: string;
  /** Which model axis points up: y or z (default: the viewer decides, Z for STEP). */
  up?: string;
  /** standard or colorblind (default: the viewer's last choice in this browser). */
  palette?: string;
}

/** Check --up / --palette; returns the viewer's query parameters for them. */
export function viewParams(o: Pick<ViewOptions, 'up' | 'palette'>): Record<string, string> {
  const out: Record<string, string> = {};
  if (o.up !== undefined) {
    const up = o.up.toLowerCase();
    if (up !== 'y' && up !== 'z') throw new Error(`--up must be y or z (got "${o.up}")`);
    out.up = up;
  }
  if (o.palette !== undefined) {
    const p = o.palette.toLowerCase();
    if (p !== 'standard' && p !== 'colorblind') throw new Error(`--palette must be standard or colorblind (got "${o.palette}")`);
    out.palette = p;
  }
  return out;
}

/**
 * Locate the built viewer: --web-dist, $POLYMERGE_WEB_DIST, the monorepo's apps/web/dist (in a
 * clone, so a rebuilt viewer is picked up), or the copy bundled into the npm package (dist/viewer).
 */
export function resolveWebDist(explicit?: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    process.env.POLYMERGE_WEB_DIST,
    path.resolve(here, '../../../../apps/web/dist'),
    path.resolve(here, '../viewer'),
  ].filter((p): p is string => !!p);
  for (const dir of candidates) if (existsSync(path.join(dir, 'index.html'))) return dir;
  throw new Error(
    `Could not find the built web viewer (looked in: ${candidates.join(', ')}). In a clone, run "npm run build" first; otherwise pass --web-dist.`,
  );
}

interface ServedModel {
  urlPath: string;
  bytes: Uint8Array;
  contentType: string;
}

/** A model to serve: a file path, or bytes already in memory (git's index stages). */
export type ModelSource = string | { name: string; bytes: Uint8Array };

/**
 * Start a local server with the viewer and the models, then open the browser.
 *  - two files (base, target): the diff viewer, `/?base=/models/<id>/base/<name>&target=…`;
 *  - three files (base, ours, theirs): the merge review, `/?mode=merge&base=…&ours=…&theirs=…`.
 * Model bytes are read up front, so git may delete its temp files while the viewer is open.
 *
 * Every request must name this server in its Host header (DNS rebinding); static files come
 * from an allowlist built here; model URLs carry a random per-session segment. With `writeBack`
 * (`polymerge review`) and a loopback bind, the review's save routes are added and the URL
 * carries the session token in its fragment. See docs/write-back-security.md.
 */
export async function startViewServer(
  files: ModelSource[],
  o: ViewOptions,
  /** With no files: the query the viewer opens with (a built-in example). */
  landing: Record<string, string> = {},
  writeBack?: ReviewWriteBack,
): Promise<{ server: http.Server; url: string; writeRoutes: boolean }> {
  if (files.length !== 0 && files.length !== 2 && files.length !== 3) {
    throw new Error(`view needs 2 files (diff) or 3 (merge), got ${files.length}`);
  }
  viewParams(o); // a bad --up / --palette fails before anything starts
  const webDist = resolveWebDist(o.webDist);
  const staticFiles = staticAllowlist(webDist);
  const sides = files.length === 3 ? ['base', 'ours', 'theirs'] : ['base', 'target'];
  const modelPrefix = `/models/${randomBytes(12).toString('hex')}`;
  const model = async (side: string, src: ModelSource): Promise<ServedModel> => {
    const display = path.basename(o.name ?? (typeof src === 'string' ? src : src.name));
    return {
      urlPath: `${modelPrefix}/${side}/${encodeURIComponent(display)}`,
      bytes: typeof src === 'string' ? new Uint8Array(await readFile(src)) : src.bytes,
      contentType: MODEL_TYPES[path.extname(display).toLowerCase()] ?? 'application/octet-stream',
    };
  };
  const models = await Promise.all(files.map((f, i) => model(sides[i], f)));
  // STEP: view and diff only (D51), and only with the reader installed.
  const stepSide = models.findIndex((m) => isStep(m.bytes, decodeURIComponent(m.urlPath.split('/').pop() ?? '')));
  if (stepSide >= 0 && files.length === 3) throw stepNotMergeable(displayName(files[stepSide], o));
  let occt: OcctLocation | null = null;
  try {
    occt = findOcct();
  } catch (err) {
    if (stepSide >= 0) throw err; // a broken $POLYMERGE_OCCT matters only when there is STEP to read
  }
  if (stepSide >= 0 && !occt) throw new Error(occtMissingMessage(displayName(files[stepSide], o)));
  const vendor = new Map<string, { file: string; type: string }>();
  if (occt) {
    for (const [name, type] of Object.entries(OCCT_VENDOR_FILES)) {
      const file = path.join(occt.dir, 'dist', name);
      if (existsSync(file)) vendor.set(`${OCCT_VENDOR_PREFIX}${name}`, { file, type });
    }
  }

  let port = 0;
  let api: ReviewWriteBack | null = null;
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!hostAllowed(req.headers.host, port)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden: unexpected Host header');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith(REVIEW_API_PREFIX)) {
      if (api) return handleReviewApi(req, res, url.pathname, port, api);
      res.writeHead(404, { connection: 'close' }).end('not found');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
      return;
    }
    const hit = models.find((m) => m.urlPath === url.pathname);
    if (hit) {
      res.writeHead(200, { 'content-type': hit.contentType, 'cache-control': 'no-store' });
      res.end(hit.bytes);
      return;
    }
    const lib = vendor.get(url.pathname);
    if (lib) {
      const body = await readFile(lib.file).catch(() => null);
      if (!body) return void res.writeHead(404).end('not found');
      res.writeHead(200, { 'content-type': lib.type });
      res.end(body);
      return;
    }
    const file = staticFile(staticFiles, url.pathname);
    const body = file ? await readFile(file).catch(() => null) : null;
    if (!file || !body) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const host = o.host ?? '127.0.0.1';
  const preferred = o.port !== undefined ? Number(o.port) : 5178;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      // Preferred port busy → fall back to any free port.
      if (err.code === 'EADDRINUSE' && o.port === undefined) {
        server.off('error', onError);
        server.listen(0, host, () => resolve());
      } else reject(err);
    };
    server.on('error', onError);
    server.listen(preferred, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const bound = server.address() as AddressInfo;
  port = bound.port;
  // Writes only ever on a loopback socket: decided by the address actually bound, not by how
  // --host was spelled, and with no override (docs/write-back-security.md §4.4).
  if (writeBack && isLoopbackAddress(bound.address)) api = writeBack;
  const query = new URLSearchParams(files.length === 0 ? landing : files.length === 3 ? { mode: 'merge' } : {});
  models.forEach((m, i) => query.set(sides[i], m.urlPath));
  if (files.length === 3 && o.name) query.set('path', o.name);
  for (const [k, v] of Object.entries(viewParams(o))) query.set(k, v);
  // The token travels in the fragment: never sent to a server, logged or put in a Referer (§4.3).
  const fragment = api ? `#token=${api.token}` : '';
  return { server, url: `http://${urlHost(host)}:${port}/?${query.toString()}${fragment}`, writeRoutes: api !== null };
}

function displayName(src: ModelSource, o: ViewOptions): string {
  return path.basename(o.name ?? (typeof src === 'string' ? src : src.name));
}

function isStep(bytes: Uint8Array, name: string): boolean {
  try {
    return detectFormat(bytes, name) === 'step';
  } catch {
    return false; // the viewer reports unknown formats itself
  }
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser launcher available; the URL is printed anyway.
  }
}

/**
 * `polymerge review <path>` — open the merge review on a conflicted git merge of <path>: git's
 * index stages (:1 ancestor, :2 ours, :3 theirs) are served as base / ours / theirs, and the
 * viewer offers the `polymerge resolve <path> --pick …` command that finishes the merge. On a
 * loopback address the review can also save the result to <path> and stage it (write-back.ts;
 * docs/write-back-security.md).
 */
export async function runReview(repoPath: string, o: ViewOptions): Promise<number> {
  if (formatFromFileName(repoPath) === 'step') throw stepNotMergeable(repoPath);
  const session = await ReviewWriteBack.open(repoPath);
  const files = ([1, 2, 3] as const).map((n) => ({ name: path.basename(repoPath), bytes: session.stages[n] }));
  return runView(files, { ...o, name: repoPath }, undefined, session);
}

/** The merge review's built-in examples (apps/web/src/dev/merge-demos.ts). */
export const MERGE_DEMOS = ['boss-height', 'thin-wall', 'parts', 'mixed-choices', 'clean'];

/**
 * `polymerge demo [example]` — open the viewer on a built-in example, no files needed: a merge
 * review example (MERGE_DEMOS) or one of the diff fixture cases bundled with the viewer.
 */
export async function runDemo(example: string | undefined, o: ViewOptions): Promise<number> {
  const id = example ?? MERGE_DEMOS[0];
  const landing: Record<string, string> = MERGE_DEMOS.includes(id) ? { mode: 'merge', demo: id } : { case: id };
  return runView([], o, landing);
}

/** `polymerge view <base> <target>` / `polymerge view <base> <ours> <theirs>` — serve until interrupted. */
export async function runView(files: ModelSource[], o: ViewOptions, landing?: Record<string, string>, writeBack?: ReviewWriteBack): Promise<number> {
  const { server, url, writeRoutes } = await startViewServer(files, o, landing, writeBack);
  process.stdout.write(`polymerge viewer running at ${url}\nPress Ctrl+C to stop.\n`);
  if (writeBack) process.stdout.write(saveNotice(writeBack, writeRoutes, o.host) + '\n');
  if (o.open !== false) openBrowser(url);
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

/** What `review` prints about saving to the repository. */
function saveNotice(session: ReviewWriteBack, enabled: boolean, host?: string): string {
  if (!enabled) return `Save to repository: off. The server is not bound to a loopback address (--host ${host}), so the review is read-only.`;
  const info = session.info();
  if (!info.writable) return `Save to repository: unavailable (${info.reason}). Download the result or use polymerge resolve.`;
  return `Save to repository: on for ${info.path} (writes it and stages it with git add; never commits). The URL carries this session's token; don't share it.`;
}
