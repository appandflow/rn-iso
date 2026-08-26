// The two cache packages are CommonJS on purpose: an Expo config and a
// metro.config.js both `require()` them. rn-iso is an ES module, so the bridge
// between them is the one line most likely to break silently -- `require` of an
// ESM module throws ERR_REQUIRE_ESM on Node before 20.19, and registration is
// best-effort, so the throw was swallowed and the caches simply never appeared
// in gc's cache report on those versions.
//
// These tests exercise the real packages, from this Node, through the real
// manifest. Each package is imported exactly once per process (CommonJS caches
// the module), but its cache root is resolved per call rather than at load
// time -- which is what lets a test set the environment after importing, and
// what keeps an override from being frozen into a long-lived Metro process.
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../cache-manifest.ts';
import { sharedBuildCache, sharedMetroCache } from '../paths.ts';

const PACKAGES = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

// Registration is deliberately fire-and-forget, so the caller returns before the
// import resolves. Poll rather than sleep: it lands within a tick or two.
async function waitForRegistration(dir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = readManifest().caches.find((c) => c.dir === dir);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

test('the Expo build cache provider registers itself on this Node, at the right depth', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rn-iso-pkg-home-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'rn-iso-pkg-bc-'));
  process.env.RN_ISO_HOME = home;
  process.env.RN_ISO_BUILD_CACHE = cacheRoot;
  try {
    const provider = await import('@rn-iso/expo-build-cache');
    expect(provider.cacheRoot()).toBe(cacheRoot);

    // A miss is enough: registration happens on every resolve, hit or not.
    await provider.resolveBuildCache({ platform: 'ios', fingerprintHash: 'nothing', runOptions: {} });

    const record = await waitForRegistration(cacheRoot);
    expect(record).toBeTruthy();
    expect(record.entriesDepth).toBe(2);
    expect(record.prune).toBe('entries');
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
    const { sharedCacheStores } = await import('@rn-iso/metro');
    // Metro's own FileStore is not a dependency of rn-iso, and the store object
    // is not what is under test here.
    class FakeStore {
      constructor(options) {
        (this as any).root = options.root;
      }
    }
    const stores = sharedCacheStores('demo', { FileStore: FakeStore });
    expect((stores[0] as { root: string }).root).toBe(cacheRoot);

    const record = await waitForRegistration(cacheRoot);
    expect(record).toBeTruthy();
    expect(record.entriesDepth).toBe(2);
    expect(record.prune).toBe('entries');
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
  for (const pkg of ['expo-build-cache', 'metro']) {
    const source = readFileSync(join(PACKAGES, pkg, 'index.ts'), 'utf-8');
    expect(source).not.toMatch(/require\(\s*['"]rn-iso/);
    expect(source).not.toMatch(/import\(\s*['"]rn-iso/);
    expect(source).toMatch(/caches\.json/);
  }
});

// The three implementations of the cache-root resolution are duplicated on
// purpose -- both packages have to work with no rn-iso installed, so neither
// may import src/paths.js. Nothing but this test holds them together, and the
// failure when they drift is silent: the CLI stores a build in one directory
// and the provider looks in another, and neither says so.
test('both packages resolve the same cache roots the CLI does', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rn-iso-pkg-home3-'));
  process.env.RN_ISO_HOME = home;
  try {
    const provider = await import('@rn-iso/expo-build-cache');
    const metro = await import('@rn-iso/metro');

    expect(provider.cacheRoot()).toBe(sharedBuildCache());
    expect(provider.cacheRoot()).toBe(join(home, 'build-cache'));
    expect(metro.cacheRoot()).toBe(sharedMetroCache());
    expect(metro.cacheRoot('demo')).toBe(sharedMetroCache('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'metro-cache', 'demo'));

    // The env overrides have to move all three together too.
    process.env.RN_ISO_BUILD_CACHE = join(home, 'elsewhere-build');
    process.env.RN_ISO_METRO_CACHE = join(home, 'elsewhere-metro');
    expect(provider.cacheRoot()).toBe(sharedBuildCache());
    expect(provider.cacheRoot()).toBe(join(home, 'elsewhere-build'));
    expect(metro.cacheRoot('demo')).toBe(sharedMetroCache('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'elsewhere-metro'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
    delete process.env.RN_ISO_BUILD_CACHE;
    delete process.env.RN_ISO_METRO_CACHE;
  }
});
