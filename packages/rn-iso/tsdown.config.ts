import { defineConfig } from 'tsdown';

export default defineConfig({
  // Four SEPARATE outputs, one per independently-runnable root:
  //   cli            -> dist/cli.js            the commander entry (shebang, chmod +x)
  //   cache-manifest -> dist/cache-manifest.js the public `rn-iso/cache-manifest` export
  //   supervisor-run -> dist/supervisor-run.js the spawnable per-workspace daemon
  //   collector-run  -> dist/collector-run.js  the spawnable per-platform log collector
  // Keeping the two spawnable daemons as their own entries (rather than letting
  // them be inlined into cli.js) is what keeps each independently runnable AND
  // keeps their `if (invokedDirectly()) main()` tails out of the CLI's own
  // module identity: when cli.js reaches a collector helper it imports the
  // collector-run.js chunk, whose import.meta.url is its own, so the guard sees
  // argv[1] !== its url and never fires a daemon out of `rn-iso --version`.
  entry: {
    cli: 'bin/cli.ts',
    'cache-manifest': 'src/cache-manifest.ts',
    'supervisor-run': 'src/supervisor/run.ts',
    'collector-run': 'src/collector/run.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  // node builtins and node_modules deps (chalk, commander, @rn-iso/metro, and
  // every project-first dynamic require like @expo/fingerprint) resolve at
  // runtime and must stay external -- `platform: 'node'` externalizes builtins
  // and tsdown externalizes package.json deps/peerDeps by default. The dynamic
  // `createRequire(projectRoot)('@expo/fingerprint')` sites are runtime requires
  // rolldown never statically bundles regardless.
  outExtensions: () => ({ js: '.js' }),
});
