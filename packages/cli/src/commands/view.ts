import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  /** Display names (e.g. real file names when git passes temp files). */
  baseName?: string;
  targetName?: string;
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
 * Start a local server with the viewer and the two models, then open the browser at
 * `/?base=/models/base/<name>&target=/models/target/<name>`. Model bytes are read
 * up front, so git difftool may delete its temp files while the viewer is open.
 */
export async function startViewServer(basePath: string, targetPath: string, o: ViewOptions): Promise<{ server: http.Server; url: string }> {
  const webDist = resolveWebDist(o.webDist);
  const model = async (side: 'base' | 'target', filePath: string, name?: string): Promise<ServedModel> => {
    const display = path.basename(name ?? filePath);
    return {
      urlPath: `/models/${side}/${encodeURIComponent(display)}`,
      bytes: new Uint8Array(await readFile(filePath)),
      contentType: CONTENT_TYPES[path.extname(display).toLowerCase()] ?? 'application/octet-stream',
    };
  };
  const models = [await model('base', basePath, o.baseName), await model('target', targetPath, o.targetName)];

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
  const query = new URLSearchParams({ base: models[0].urlPath, target: models[1].urlPath });
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

/** `polymerge view <base> <target>` — serve until interrupted. */
export async function runView(basePath: string, targetPath: string, o: ViewOptions): Promise<number> {
  const { server, url } = await startViewServer(basePath, targetPath, o);
  process.stdout.write(`polymerge viewer running at ${url}\nPress Ctrl+C to stop.\n`);
  if (o.open !== false) openBrowser(url);
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}
