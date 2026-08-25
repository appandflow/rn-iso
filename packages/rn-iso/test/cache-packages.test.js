// The two cache packages are CommonJS on purpose: an Expo config and a
// metro.config.js both `require()` them. rn-iso is an ES module, so the bridge
// between them is the one line most likely to break silently -- `require` of an
// ESM module throws ERR_REQUIRE_ESM on Node before 20.19, and registration is
// best-effort, so the throw was swallowed and the caches simply never appeared
// in `gc --caches` on those versions.
//
// These tests exercise the real packages, from this Node, through the real
// manifest. Each package is imported exactly once per process (CommonJS caches
// the module, and its cache root is read at load time), so each one gets a
// single test and sets its environment before importing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../src/cache-manifest.js';

const PACKAGES = join(fileURLToPath(import.meta.url), '..', '..', '..');

// Registration is deliberately fire-and-forget, so the caller returns before the
// import resolves. Poll rather than sleep: it lands within a tick or two.
async function waitForRegistration(dir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = readManifest().caches.find(c => c.dir === dir);
    if (found) return found;
    await new Promise(r => setTimeout(r, 10));
  }
  return null;
}

test('the Expo build cache provider registers itself on this Node, at the right depth', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rn-iso-pkg-home-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'rn-iso-pkg-bc-'));
  process.env.RN_ISO_HOME = home;
  process.env.RN_ISO_BUILD_CACHE = cacheRoot;
  try {
    const provider = await import('../../expo-build-cache/index.js');
    assert.equal(provider.CACHE_ROOT, cacheRoot);

    // A miss is enough: registration happens on every resolve, hit or not.
    await provider.resolveBuildCache({ platform: 'ios', fingerprintHash: 'nothing', runOptions: {} });

    const record = await waitForRegistration(cacheRoot);
    assert.ok(record, 'the provider has to reach the manifest');
    assert.equal(record.entriesDepth, 2, 'the entries are <root>/<platform>/<key>, not the platform directories');
    assert.equal(record.prune, 'entries');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
    delete process.env.RN_ISO_BUILD_CACHE;
  }
});

test('the Metro cache store registers itself on this Node, at the shard depth', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rn-iso-pkg-home2-'));
  const cacheRoot = join(tmpdir(), `rn-iso-pkg-metro-${process.pid}`);
  mkdirSync(cacheRoot, { recursive: true });
  process.env.RN_ISO_HOME = home;
  process.env.RN_ISO_METRO_CACHE = cacheRoot;
  try {
    const { sharedCacheStores } = await import('../../metro-cache/index.js');
    // Metro's own FileStore is not a dependency of rn-iso, and the store object
    // is not what is under test here.
    class FakeStore {
      constructor(options) {
        this.root = options.root;
      }
    }
    const stores = sharedCacheStores('demo', { FileStore: FakeStore });
    assert.equal(stores[0].root, cacheRoot);

    const record = await waitForRegistration(cacheRoot);
    assert.ok(record, 'the store has to reach the manifest');
    assert.equal(record.entriesDepth, 2, 'FileStore shards one level above its entries');
    assert.equal(record.prune, 'entries');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
    delete process.env.RN_ISO_METRO_CACHE;
  }
});

// Reaching rn-iso at all was the bug. `require` of it throws ERR_REQUIRE_ESM on
// Node before 20.19, and a dynamic import fixes only that half: the documented
// way to use the CLI is `npx rn-iso`, so it is usually not a dependency of the
// project and the specifier does not resolve on any Node version. Both packages
// write the manifest themselves, so neither may name rn-iso as a module.
test('neither package reaches rn-iso as a module', () => {
  for (const pkg of ['expo-build-cache', 'metro-cache']) {
    const source = readFileSync(join(PACKAGES, pkg, 'index.js'), 'utf-8');
    assert.doesNotMatch(source, /require\(\s*['"]rn-iso/, `${pkg} must not require rn-iso`);
    assert.doesNotMatch(source, /import\(\s*['"]rn-iso/, `${pkg} must not import rn-iso either`);
    assert.match(source, /caches\.json/, `${pkg} must write the manifest itself`);
  }
});
