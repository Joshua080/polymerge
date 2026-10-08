import { defineConfig, type Connect, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const fixturesDir = path.join(repoRoot, 'fixtures');

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.mtl': 'model/mtl',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.3mf': 'model/3mf',
  '.ply': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * Map a URL path below `/fixtures/` to a file inside `root`, or null when the path is
 * malformed, hidden (dot-segments / dotfiles) or escapes `root` (also via symlinks).
 */
function resolveFixtureFile(root: string, relUrlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(relUrlPath);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s.startsWith('.'))) return null;
  const abs = path.resolve(root, ...segments);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const realAbs = fs.realpathSync(abs);
    if (!realAbs.startsWith(realRoot + path.sep)) return null;
    if (!fs.statSync(realAbs).isFile()) return null;
    return realAbs;
  } catch {
    return null;
  }
}

/** Connect middleware serving the repo's fixtures/ directory at /fixtures/*. */
function fixturesMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const pathname = (req.url ?? '').split(/[?#]/)[0];
    if (!pathname.startsWith('/fixtures/')) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const file = resolveFixtureFile(fixturesDir, pathname.slice('/fixtures/'.length));
    if (!file) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Not found: ${pathname}`);
      return;
    }
    const stat = fs.statSync(file);
    res.statusCode = 200;
    res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file)
      .on('error', (err) => {
        if (!res.headersSent) res.statusCode = 500;
        res.end(String(err));
      })
      .pipe(res);
  };
}

/**
 * Serves fixtures/ in `vite` (dev) and `vite preview`, and copies fixtures/manifest.json +
 * fixtures/cases/** into dist/fixtures/ on `vite build` so examples work from a static host.
 */
function polymergeFixtures(): Plugin {
  let outDir = '';
  return {
    name: 'polymerge-fixtures',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(fixturesMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(fixturesMiddleware());
    },
    writeBundle() {
      const manifest = path.join(fixturesDir, 'manifest.json');
      const cases = path.join(fixturesDir, 'cases');
      const dest = path.join(outDir, 'fixtures');
      let copied = 0;
      if (fs.existsSync(manifest)) {
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(manifest, path.join(dest, 'manifest.json'));
        copied++;
      }
      if (fs.existsSync(cases) && fs.statSync(cases).isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(cases, path.join(dest, 'cases'), { recursive: true });
        copied++;
      }
      this.info(copied > 0 ? `copied fixtures into ${path.relative(repoRoot, dest)}` : 'no fixtures to copy');
    },
  };
}

/** The version users see (the polymerge CLI's), for the pages the viewer writes. */
const version = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/cli/package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  // Relative asset URLs so dist/ can be served from any path (e.g. by `polymerge view`).
  base: './',
  define: { __POLYMERGE_VERSION__: JSON.stringify(version) },
  resolve: {
    // Consume polymerge-core straight from source so the viewer never needs a core build.
    alias: { 'polymerge-core': path.join(repoRoot, 'packages/core/src/index.ts') },
  },
  plugins: [polymergeFixtures()],
  server: { fs: { allow: [repoRoot] } },
  build: {
    target: 'es2022',
    // three.js + its loaders are one large chunk by nature.
    chunkSizeWarningLimit: 2000,
  },
});
