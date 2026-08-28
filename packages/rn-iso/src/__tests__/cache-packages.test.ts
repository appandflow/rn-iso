import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { readManifest } from '../cache-manifest.ts';
import { sharedBuildCache, sharedMetroCache } from '../paths.ts';
import { hasStoreAt } from '../supervisor/metro-store.ts';

const PACKAGES = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

async function waitForRegistration(dir: string, timeoutMs = 5000) {
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

    await provider.resolveBuildCache({ platform: 'ios', fingerprintHash: 'nothing', runOptions: {} });

    const record = await waitForRegistration(cacheRoot);
    expect(record).toBeTruthy();
    assert(record);
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
    class FakeStore {
      root: string;
      constructor(options: { root: string }) {
        this.root = options.root;
      }
    }
    const stores = sharedCacheStores('demo', { FileStore: FakeStore });
    expect((stores[0] as { root: string }).root).toBe(cacheRoot);
    expect(hasStoreAt(stores, cacheRoot)).toBe(true);

    const record = await waitForRegistration(cacheRoot);
    expect(record).toBeTruthy();
    assert(record);
    expect(record.entriesDepth).toBe(2);
    expect(record.prune).toBe('entries');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
    delete process.env.RN_ISO_METRO_CACHE;
  }
});

test('neither package reaches rn-iso as a module; the shared primitives live in @rn-iso/core', () => {
  for (const pkg of ['expo-build-cache', 'metro']) {
    const source = readFileSync(join(PACKAGES, pkg, 'index.ts'), 'utf-8');
    expect(source).not.toMatch(/require\(\s*['"]rn-iso/);
    expect(source).not.toMatch(/import\(\s*['"]rn-iso/);
    expect(source).toMatch(/@rn-iso\/core/);
  }
  const core = readFileSync(join(PACKAGES, 'core', 'index.ts'), 'utf-8');
  expect(core).toMatch(/caches\.json/);
  expect(core).not.toMatch(/require\(\s*['"]rn-iso/);
});

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

    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ caches: { buildCache: join(home, 'cfg-build'), metroCache: join(home, 'cfg-metro') } }),
    );
    expect(provider.cacheRoot()).toBe(sharedBuildCache());
    expect(provider.cacheRoot()).toBe(join(home, 'cfg-build'));
    expect(metro.cacheRoot('demo')).toBe(sharedMetroCache('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'cfg-metro'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ caches: { buildCache: 'relative/nope' } }));
    expect(provider.cacheRoot()).toBe(join(home, 'build-cache'));

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
