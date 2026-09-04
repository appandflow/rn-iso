import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
  resolve: {
    alias: {
      '@theme/CodeBlock': fileURLToPath(new URL('./website/src/test/CodeBlock.ts', import.meta.url)),
    },
  },
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
