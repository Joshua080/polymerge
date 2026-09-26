import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
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
}

/** Locate the built viewer: --web-dist, $POLYMERGE_WEB_DIST, or the monorepo's apps/web/dist. */
export function resolveWebDist(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.POLYMERGE_WEB_DIST,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/dist'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/web/dist'),
  ].filter((p): p is string => !!p);
  for (const dir of candidates) if (existsSync(path.join(dir, 'index.html'))) return dir;
  throw new Error(
    `Could not find the built web viewer (looked in: ${candidates.join(', ')}). Run "npm run build" first or pass --web-dist.`,
  );
}

interface ServedModel {
  urlPath: string;
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Start a local server with the viewer and the models, then open the browser.
 *  - two files (base, target): the diff viewer, `/?base=/models/base/<name>&target=…`;
 *  - three files (base, ours, theirs): the merge review, `/?mode=merge&base=…&ours=…&theirs=…`.
 * Model bytes are read up front, so git may delete its temp files while the viewer is open.
 */
export async function startViewServer(files: string[], o: ViewOptions): Promise<{ server: http.Server; url: string }> {
  if (files.length !== 2 && files.length !== 3) throw new Error(`view needs 2 files (diff) or 3 (merge), got ${files.length}`);
  const webDist = resolveWebDist(o.webDist);
  const sides = files.length === 3 ? ['base', 'ours', 'theirs'] : ['base', 'target'];
  const model = async (side: string, filePath: string): Promise<ServedModel> => {
    const display = path.basename(o.name ?? filePath);
    return {
      urlPath: `/models/${side}/${encodeURIComponent(display)}`,
      bytes: new Uint8Array(await readFile(filePath)),
      contentType: CONTENT_TYPES[path.extname(display).toLowerCase()] ?? 'application/octet-stream',
    };
  };
  const models = await Promise.all(files.map((f, i) => model(sides[i], f)));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const hit = models.find((m) => m.urlPath === url.pathname);
      if (hit) {
        res.writeHead(200, { 'content-type': hit.contentType, 'cache-control': 'no-store' });
        res.end(hit.bytes);
        return;
      }
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = path.resolve(webDist, '.' + rel);
      if (!file.startsWith(path.resolve(webDist) + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  const host = o.host ?? '127.0.0.1';
  const port = o.port !== undefined ? Number(o.port) : 5178;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      // Preferred port busy → fall back to any free port.
      if (err.code === 'EADDRINUSE' && o.port === undefined) {
        server.off('error', onError);
        server.listen(0, host, () => resolve());
      } else reject(err);
    };
    server.on('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const { port: actualPort } = server.address() as AddressInfo;
  const query = new URLSearchParams(files.length === 3 ? { mode: 'merge' } : {});
  sides.forEach((side, i) => query.set(side, models[i].urlPath));
  if (files.length === 3 && o.name) query.set('path', o.name);
  return { server, url: `http://${host}:${actualPort}/?${query.toString()}` };
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
 * viewer offers the `polymerge resolve <path> --pick …` command that finishes the merge.
 */
export async function runReview(repoPath: string, o: ViewOptions, stage: (n: 1 | 2 | 3, repoPath: string) => Uint8Array): Promise<number> {
  const dir = mkdtempSync(path.join(tmpdir(), 'polymerge-review-'));
  try {
    const files = ([1, 2, 3] as const).map((n) => {
      const file = path.join(dir, `${n}-${path.basename(repoPath)}`);
      writeFileSync(file, stage(n, repoPath));
      return file;
    });
    return await runView(files, { ...o, name: repoPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `polymerge view <base> <target>` / `polymerge view <base> <ours> <theirs>` — serve until interrupted. */
export async function runView(files: string[], o: ViewOptions): Promise<number> {
  const { server, url } = await startViewServer(files, o);
  process.stdout.write(`polymerge viewer running at ${url}\nPress Ctrl+C to stop.\n`);
  if (o.open !== false) openBrowser(url);
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}
