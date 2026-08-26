import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    'bin/cli': 'bin/cli.ts',
    'cache-manifest': 'src/cache-manifest.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node20',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  outExtensions: () => ({ js: '.js' }),
});
