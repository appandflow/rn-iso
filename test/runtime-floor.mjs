import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = join(import.meta.dirname, '..');
const require = createRequire(join(repositoryRoot, 'packages', 'stim-cli', 'package.json'));
const packageDirs = ['stim-cli', 'core', 'cache', 'metro', 'expo-build-cache'];

for (const directory of packageDirs) {
  const root = join(repositoryRoot, 'packages', directory);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module', `${pkg.name} must declare ESM`);
  assert.equal(pkg.engines.node, '^20.19.4 || >=22.12.0', `${pkg.name} must declare the runtime range`);

  const distFiles = readdirSync(join(root, 'dist'));
  assert.equal(
    distFiles.some((file) => file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.cts')),
    false,
    `${pkg.name} dist must contain only ESM JavaScript and ESM declarations`,
  );
}

const entrypoints = [
  ['@stim-cli/core', 'configDir'],
  ['@stim-cli/cache', 'loadCacheProvider'],
  ['@stim-cli/expo-build-cache', 'cacheRoot'],
  ['@stim-cli/metro', 'sharedCacheStores'],
  ['stim-cli/cache-manifest', 'readManifest'],
];

for (const [specifier, exportName] of entrypoints) {
  assert.equal(typeof require(specifier)[exportName], 'function', `require(${specifier}) must load ESM synchronously`);
  const resolved = pathToFileURL(require.resolve(specifier)).href;
  assert.equal(typeof (await import(resolved))[exportName], 'function', `import(${specifier}) must load ESM`);
}

const version = execFileSync(process.execPath, ['packages/stim-cli/dist/cli.mjs', '--version'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
const cliPackage = JSON.parse(readFileSync(join(repositoryRoot, 'packages', 'stim-cli', 'package.json'), 'utf8'));
assert.equal(version, cliPackage.version);
