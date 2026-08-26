import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // These suites tap process.stdout/stderr directly (and were written for
    // `node --test`); let console output flow to the real streams unwrapped.
    disableConsoleIntercept: true,
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/__tests__/**/*.test.ts',
    ],
    // These tests spawn real processes, bind real ports and shell out to real
    // tools; keep them isolated in a forked child like `node --test` gave them.
    pool: 'forks',
  },
});
