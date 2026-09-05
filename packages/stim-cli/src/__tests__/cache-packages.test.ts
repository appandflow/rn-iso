import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { METRO_NAMED_CACHE_LAYOUT } from '@stim-cli/core';
import { readManifest } from '../cache-manifest.ts';
import { sharedBuildCache, sharedMetroCache } from '../paths.ts';
import { hasStoreAt } from '../supervisor/metro-store.ts';

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
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-home-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'stim-pkg-bc-'));
  process.env.STIM_HOME = home;
  process.env.STIM_BUILD_CACHE = cacheRoot;
  try {
    const provider = await import('@stim-cli/expo-build-cache');
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
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
  }
});

test('the standalone Expo build cache provider separates Android ABIs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-home-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'stim-pkg-bc-'));
  const universalApk = join(home, 'universal.apk');
  const arm64Apk = join(home, 'arm64.apk');
  process.env.STIM_HOME = home;
  process.env.STIM_BUILD_CACHE = cacheRoot;
  writeFileSync(universalApk, 'universal');
  writeFileSync(arm64Apk, 'arm64');
  try {
    const provider = await import('@stim-cli/expo-build-cache');
    await provider.uploadBuildCache({
      platform: 'android',
      fingerprintHash: 'fingerprint',
      buildPath: universalApk,
      runOptions: { variant: 'debug' },
    });
    await provider.uploadBuildCache({
      platform: 'android',
      fingerprintHash: 'fingerprint',
      buildPath: arm64Apk,
      runOptions: { variant: 'debug', abi: 'arm64-v8a' },
    });

    const universal = await provider.resolveBuildCache({
      platform: 'android',
      fingerprintHash: 'fingerprint',
      runOptions: { variant: 'debug' },
    });
    const arm64 = await provider.resolveBuildCache({
      platform: 'android',
      fingerprintHash: 'fingerprint',
      runOptions: { variant: 'debug', abi: 'arm64-v8a' },
    });
    assert(universal);
    assert(arm64);
    expect(universal).not.toBe(arm64);
    expect(readFileSync(universal, 'utf8')).toBe('universal');
    expect(readFileSync(arm64, 'utf8')).toBe('arm64');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
  }
});

test('the Metro cache store registers itself on this Node, at the shard depth', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-home2-'));
  const cacheRoot = join(tmpdir(), `stim-pkg-metro-${process.pid}`);
  const namedRoot = join(cacheRoot, 'demo');
  mkdirSync(cacheRoot, { recursive: true });
  process.env.STIM_HOME = home;
  process.env.STIM_METRO_CACHE = cacheRoot;
  writeFileSync(
    join(home, 'caches.json'),
    JSON.stringify({
      version: 1,
      caches: [
        { dir: cacheRoot, name: 'Metro transform cache', prune: 'entries', entriesDepth: 2 },
        {
          dir: cacheRoot,
          name: 'Metro transform cache',
          prune: 'entries',
          entriesDepth: 2,
          layout: METRO_NAMED_CACHE_LAYOUT,
        },
        { dir: cacheRoot, name: 'Unrelated same-root cache', prune: 'entries' },
        { dir: join(home, 'unrelated'), name: 'Unrelated cache', prune: 'entries' },
      ],
    }),
  );
  try {
    const { sharedCacheStores } = await import('@stim-cli/metro');
    class FakeStore {
      root: string;
      constructor(options: { root: string }) {
        this.root = options.root;
      }
    }
    const stores = sharedCacheStores('demo', { FileStore: FakeStore });
    expect((stores[0] as { root: string }).root).toBe(namedRoot);
    expect(hasStoreAt(stores, namedRoot)).toBe(true);

    const record = await waitForRegistration(namedRoot);
    expect(record).toBeTruthy();
    assert(record);
    expect(record.entriesDepth).toBe(2);
    expect(record.prune).toBe('entries');
    expect(record.layout).toBe(METRO_NAMED_CACHE_LAYOUT);
    expect(
      readManifest().caches.some(
        (cache) => cache.dir === cacheRoot && cache.name === 'Metro transform cache' && cache.layout === undefined,
      ),
    ).toBe(false);
    expect(
      readManifest().caches.some((cache) => cache.dir === cacheRoot && cache.layout === METRO_NAMED_CACHE_LAYOUT),
    ).toBe(true);
    expect(readManifest().caches.some((cache) => cache.name === 'Unrelated same-root cache')).toBe(true);
    expect(readManifest().caches.some((cache) => cache.dir === join(home, 'unrelated'))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_METRO_CACHE;
  }
});

test('both packages resolve the same cache roots the CLI does', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-home3-'));
  process.env.STIM_HOME = home;
  try {
    const provider = await import('@stim-cli/expo-build-cache');
    const metro = await import('@stim-cli/metro');

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
    expect(metro.cacheRoot()).toBe(join(home, 'cfg-metro'));
    expect(metro.cacheRoot('demo')).toBe(sharedMetroCache('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'cfg-metro', 'demo'));
    expect(metro.cacheRoot('@scope/app')).toBe(join(home, 'cfg-metro', '-scope-app'));

    process.env.STIM_BUILD_CACHE = join(home, 'elsewhere-build');
    process.env.STIM_METRO_CACHE = join(home, 'elsewhere-metro');
    expect(provider.cacheRoot()).toBe(sharedBuildCache());
    expect(provider.cacheRoot()).toBe(join(home, 'elsewhere-build'));
    expect(metro.cacheRoot()).toBe(join(home, 'elsewhere-metro'));
    expect(metro.cacheRoot('demo')).toBe(sharedMetroCache('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'elsewhere-metro', 'demo'));

    delete process.env.STIM_BUILD_CACHE;
    delete process.env.STIM_METRO_CACHE;
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ caches: { buildCache: 'relative/nope', metroCache: 'relative/nope' } }),
    );
    expect(provider.cacheRoot()).toBe(join(home, 'build-cache'));
    expect(metro.cacheRoot()).toBe(join(home, 'metro-cache'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'metro-cache', 'demo'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
    delete process.env.STIM_METRO_CACHE;
  }
});
