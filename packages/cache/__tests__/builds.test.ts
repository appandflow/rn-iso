import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILD_RESOLVE_TIMEOUT_ENV,
  BUILD_RESOLVE_TIMEOUT_MS,
  BUILD_UPLOAD_TIMEOUT_ENV,
  BUILD_UPLOAD_TIMEOUT_MS,
  buildResolveTimeoutMs,
  buildUploadTimeoutMs,
  resolveTieredBuild,
  storeTieredBuild,
} from '../builds.ts';
import type { BuildCacheCapability, BuildCacheTarget } from '../provider.ts';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'stim-cache-builds-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function artifact(name: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'app.apk');
  writeFileSync(path, name);
  return path;
}

const target: BuildCacheTarget = { projectRoot: '/repo/app', platform: 'android', key: 'fingerprint-debug-sim' };

function capability(overrides: Partial<BuildCacheCapability> = {}) {
  const calls = { resolve: 0, store: 0 };
  const inputs: { resolve: unknown[]; store: unknown[] } = { resolve: [], store: [] };
  const cap: BuildCacheCapability = {
    resolve: (input) => {
      calls.resolve += 1;
      inputs.resolve.push(input);
      return overrides.resolve ? overrides.resolve(input) : null;
    },
    store: (input) => {
      calls.store += 1;
      inputs.store.push(input);
      return overrides.store ? overrides.store(input) : undefined;
    },
  };
  return { cap, calls, inputs };
}

test('the pinned build timeouts stay put', () => {
  expect(BUILD_RESOLVE_TIMEOUT_MS).toBe(30_000);
  expect(BUILD_UPLOAD_TIMEOUT_MS).toBe(60_000);
});

test('a local hit does not call the provider', async () => {
  const local = capability({ resolve: () => '/cache/android/key/app.apk' });
  const provider = capability();

  const found = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({ name: './cache.cjs', provider: { builds: provider.cap } }),
    target,
    destinationDir: workDir,
  });

  expect(found).toEqual({ path: '/cache/android/key/app.apk', tier: 'local' });
  expect(provider.calls.resolve).toBe(0);
});

test('a provider hit is stored locally and reports the provider tier', async () => {
  const downloaded = artifact('downloaded');
  const stored = artifact('stored');
  const local = capability({ resolve: () => null, store: () => stored });
  const provider = capability({ resolve: () => downloaded });

  const found = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({ name: './cache.cjs', provider: { builds: provider.cap } }),
    target,
    destinationDir: workDir,
  });

  expect(found).toEqual({ path: stored, tier: 'provider', providerName: './cache.cjs', storedLocally: true });
  expect(local.inputs.store[0]).toMatchObject({ sourcePath: downloaded, overwrite: false, key: target.key });
  expect(provider.inputs.resolve[0]).toMatchObject({ destinationDir: workDir, key: target.key, platform: 'android' });
});

test('a local backfill failure still returns the downloaded artifact', async () => {
  const downloaded = artifact('downloaded');
  const local = capability({
    resolve: () => null,
    store: () => {
      throw new Error('disk full');
    },
  });
  const provider = capability({ resolve: () => downloaded });
  const warnings: string[] = [];

  const found = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({ name: 'team-cache', provider: { builds: provider.cap } }),
    target,
    destinationDir: workDir,
    warn: (code, message) => warnings.push(`${code}: ${message}`),
  });

  expect(found).toEqual({ path: downloaded, tier: 'provider', providerName: 'team-cache', storedLocally: false });
  expect(warnings[0]).toMatch(/provider-backfill: a team-cache hit could not be stored locally: disk full/);
});

test('skipRead bypasses both tiers', async () => {
  const local = capability({ resolve: () => '/cache/hit.apk' });
  const provider = capability({ resolve: () => '/remote/hit.apk' });

  expect(
    await resolveTieredBuild({
      local: local.cap,
      loadProvider: () => ({ provider: { builds: provider.cap } }),
      target,
      destinationDir: workDir,
      skipRead: true,
    }),
  ).toBeNull();
  expect(local.calls.resolve).toBe(0);
  expect(provider.calls.resolve).toBe(0);
});

test('a provider miss, timeout, failure, or missing path returns a miss', async () => {
  const local = capability({ resolve: () => null });

  const miss = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({ provider: { builds: capability({ resolve: () => null }).cap } }),
    target,
    destinationDir: workDir,
  });
  expect(miss).toBeNull();

  const timedOutWarnings: string[] = [];
  const timedOut = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({
      name: 'team-cache',
      provider: { builds: capability({ resolve: () => new Promise(() => {}) }).cap },
    }),
    target,
    destinationDir: workDir,
    timeoutMs: 5,
    warn: (_code, message) => timedOutWarnings.push(message),
  });
  expect(timedOut).toBeNull();
  expect(timedOutWarnings[0]).toBe('team-cache did not answer within 5ms; building instead');

  const failureWarnings: string[] = [];
  const failed = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({
      name: 'team-cache',
      provider: {
        builds: capability({
          resolve: () => {
            throw new Error('unauthorized');
          },
        }).cap,
      },
    }),
    target,
    destinationDir: workDir,
    warn: (_code, message) => failureWarnings.push(message),
  });
  expect(failed).toBeNull();
  expect(failureWarnings[0]).toBe('team-cache could not be used: unauthorized; building instead');

  const missingWarnings: string[] = [];
  const missing = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({
      name: 'team-cache',
      provider: { builds: capability({ resolve: () => join(workDir, 'nope.apk') }).cap },
    }),
    target,
    destinationDir: workDir,
    warn: (_code, message) => missingWarnings.push(message),
  });
  expect(missing).toBeNull();
  expect(missingWarnings[0]).toMatch(/which does not exist/);
});

test('a fresh build stores locally before the provider upload starts', async () => {
  const built = artifact('built');
  const stored = artifact('stored');
  const order: string[] = [];
  const local = capability({
    store: () => {
      order.push('local');
      return stored;
    },
  });
  const provider = capability({
    store: async () => {
      order.push('provider');
    },
  });

  const result = await storeTieredBuild({
    local: local.cap,
    loadProvider: () => ({ provider: { builds: provider.cap } }),
    target,
    sourcePath: built,
    overwrite: false,
  });

  expect(result.localPath).toBe(stored);
  expect(order).toEqual(['local', 'provider']);
  expect(await result.providerUpload).toEqual({ value: undefined });
  expect(local.inputs.store[0]).toMatchObject({ sourcePath: built, overwrite: false });
});

test('a provider upload failure or timeout is reported without throwing', async () => {
  const built = artifact('built');
  const local = capability({ store: () => built });

  const failed = await storeTieredBuild({
    local: local.cap,
    loadProvider: () => ({
      provider: {
        builds: capability({
          store: () => {
            throw new Error('upload denied');
          },
        }).cap,
      },
    }),
    target,
    sourcePath: built,
    overwrite: true,
  });
  expect(await failed.providerUpload).toEqual({ failed: 'upload denied' });

  const timedOut = await storeTieredBuild({
    local: local.cap,
    loadProvider: () => ({ provider: { builds: capability({ store: () => new Promise(() => {}) }).cap } }),
    target,
    sourcePath: built,
    overwrite: true,
    timeoutMs: 5,
  });
  expect(await timedOut.providerUpload).toEqual({ timedOut: true });
});

test('without a provider the store reports the local path and no upload', async () => {
  const built = artifact('built');
  const local = capability({ store: () => built });

  const result = await storeTieredBuild({ local: local.cap, target, sourcePath: built, overwrite: false });
  expect(result).toEqual({ localPath: built, providerUpload: null, providerName: null });
});

test('an unusable provider warns once and keeps the local tier', async () => {
  const built = artifact('built');
  const local = capability({ resolve: () => null, store: () => built });
  const warnings: string[] = [];
  const loadProvider = () => ({ name: './cache.cjs', unavailable: 'missing credentials' });

  const found = await resolveTieredBuild({
    local: local.cap,
    loadProvider,
    target,
    destinationDir: workDir,
    warn: (code, message) => warnings.push(`${code}: ${message}`),
  });
  const stored = await storeTieredBuild({
    local: local.cap,
    loadProvider,
    target,
    sourcePath: built,
    overwrite: false,
    warn: (code, message) => warnings.push(`${code}: ${message}`),
  });

  expect(found).toBeNull();
  expect(stored).toEqual({ localPath: built, providerUpload: null, providerName: null });
  expect(warnings).toEqual([
    'provider-load: provider not usable (./cache.cjs): missing credentials; using local cache',
    'provider-load: provider not usable (./cache.cjs): missing credentials; using local cache',
  ]);
});

test('a Metro-only provider adds no build tier', async () => {
  const built = artifact('built');
  const local = capability({ resolve: () => null, store: () => built });
  const loadProvider = () => ({ name: './cache.cjs', provider: { metro: { get: () => null, set: () => {} } } });

  expect(await resolveTieredBuild({ local: local.cap, loadProvider, target, destinationDir: workDir })).toBeNull();
  expect(
    await storeTieredBuild({ local: local.cap, loadProvider, target, sourcePath: built, overwrite: false }),
  ).toEqual({ localPath: built, providerUpload: null, providerName: null });
});

test('the build budgets accept an environment override', () => {
  expect(buildResolveTimeoutMs({})).toBe(BUILD_RESOLVE_TIMEOUT_MS);
  expect(buildUploadTimeoutMs({})).toBe(BUILD_UPLOAD_TIMEOUT_MS);
  expect(buildResolveTimeoutMs({ [BUILD_RESOLVE_TIMEOUT_ENV]: '1500' })).toBe(1500);
  expect(buildUploadTimeoutMs({ [BUILD_UPLOAD_TIMEOUT_ENV]: '1500' })).toBe(1500);
  expect(buildUploadTimeoutMs({ [BUILD_UPLOAD_TIMEOUT_ENV]: '-1' })).toBe(BUILD_UPLOAD_TIMEOUT_MS);
});

test('the destination is only prepared when a provider is about to be asked', async () => {
  const prepared: string[] = [];
  const localHit = capability({ resolve: () => '/cache/app.apk' });
  const localMiss = capability({ resolve: () => null });
  const downloaded = artifact('downloaded');
  const loadProvider = () => ({
    name: './cache.cjs',
    provider: { builds: capability({ resolve: () => downloaded }).cap },
  });

  await resolveTieredBuild({
    local: localHit.cap,
    loadProvider,
    target,
    destinationDir: workDir,
    ensureDestination: (dir) => prepared.push(dir),
  });
  expect(prepared).toEqual([]);

  await resolveTieredBuild({
    local: localMiss.cap,
    loadProvider,
    target,
    destinationDir: workDir,
    ensureDestination: (dir) => prepared.push(dir),
    skipRead: true,
  });
  expect(prepared).toEqual([]);

  await resolveTieredBuild({
    local: localMiss.cap,
    loadProvider,
    target,
    destinationDir: workDir,
    ensureDestination: (dir) => prepared.push(dir),
  });
  expect(prepared).toEqual([workDir]);
});
