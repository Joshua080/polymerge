import { defineConfig } from 'vitest/config';
import { coreAlias } from './vitest.config.js';

/**
 * Performance tests (~100k-vertex meshes with time bounds). Run on their own — one file at a
 * time, nothing else in parallel — so the bounds measure the diff engine, not the scheduler.
 */
export default defineConfig({
  resolve: { alias: coreAlias },
  test: {
    include: ['packages/*/test/**/perf.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
