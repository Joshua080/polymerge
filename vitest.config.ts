import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export const coreAlias = { 'polymerge-core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)) };

export default defineConfig({
  resolve: {
    // Tests always exercise core from source (no build step needed).
    alias: coreAlias,
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'fixtures/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'action/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    // Timing-bounded perf tests run separately (vitest.perf.config.ts), alone, so their bounds
    // measure the engine rather than contention with other test files running in parallel.
    exclude: [...configDefaults.exclude, '**/perf.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
