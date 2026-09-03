import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    disableConsoleIntercept: true,
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/__tests__/**/*.test.ts',
      'packages/*/__tests__/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'website/src/**/*.test.ts',
    ],
    pool: 'forks',
  },
});
