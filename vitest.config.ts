import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/__tests__/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
    ],
    // These tests spawn real processes, bind real ports and shell out to real
    // tools; keep them isolated in a forked child like `node --test` gave them.
    pool: 'forks',
  },
});
