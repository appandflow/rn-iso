import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    cli: 'bin/cli.ts',
    'cache-manifest': 'src/cache-manifest.ts',
    'supervisor-run': 'src/supervisor/run.ts',
    'collector-run': 'src/collector/run.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node20.19',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
});
