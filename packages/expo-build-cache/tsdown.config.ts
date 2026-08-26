import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'index.ts' },
  format: 'cjs',
  dts: true,
  outDir: 'dist',
  target: 'node22',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  outExtensions: () => ({ js: '.js' }),
});
