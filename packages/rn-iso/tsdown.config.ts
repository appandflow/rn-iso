import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    cli: 'bin/cli.ts',
    'cache-manifest': 'src/cache-manifest.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  outExtensions: () => ({ js: '.js' }),
});
