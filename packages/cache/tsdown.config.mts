import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'index.ts' },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node20.19',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
});
