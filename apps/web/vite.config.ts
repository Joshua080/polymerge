import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export default defineConfig({
  resolve: {
    // Consume @polymerge/core straight from source so the viewer never needs a core build.
    alias: { '@polymerge/core': path.join(repoRoot, 'packages/core/src/index.ts') },
  },
  server: { fs: { allow: [repoRoot] } },
});
