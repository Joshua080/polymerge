import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'fixtures/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
