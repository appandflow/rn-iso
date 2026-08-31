import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_PROVIDER_ENV,
  cacheProviderEnv,
  metroCapabilityFromStore,
  runCacheProviderContract,
  type CacheProviderConfig,
  type LoadCacheProviderResult,
  type MetroCacheStore,
} from '@stim-cli/cache';
import { sharedStoreRoot } from '@stim-cli/core';
import { sharedCacheStores } from '../index.ts';

const require = createRequire(import.meta.url);
const { FileStore } = require('metro-cache') as { FileStore: new (options: { root: string }) => MetroCacheStore };

let home: string;
let cacheDir: string;
let projectRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-metro-home-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'stim-metro-cache-'));
  projectRoot = mkdtempSync(join(tmpdir(), 'stim-metro-project-'));
  process.env.STIM_HOME = home;
  process.env.STIM_METRO_CACHE = cacheDir;
});

afterEach(() => {
  madeStores.length = 0;
  rmSync(home, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_METRO_CACHE;
});

const madeStores: FakeStore[] = [];

class FakeStore {
  root: string;
  entries = new Map<string, unknown>();
  cleared = 0;

  constructor(options: { root: string }) {
    this.root = options.root;
    madeStores.push(this);
  }

  get(key: Buffer): unknown {
    return this.entries.get(key.toString('hex')) ?? null;
  }

  set(key: Buffer, value: unknown): void {
    this.entries.set(key.toString('hex'), value);
  }

  clear(): void {
    this.cleared += 1;
  }
}

const KEY = Buffer.from('a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4', 'hex');

test('without a configured provider the store is the plain file store', () => {
  const stores = sharedCacheStores('demo', { FileStore: FakeStore, cwd: projectRoot, env: {} });

  expect(stores.length).toBe(1);
  expect(stores[0]).toBeInstanceOf(FakeStore);
  expect((stores[0] as FakeStore).root).toBe(join(cacheDir, 'demo'));
  expect(sharedStoreRoot(stores[0])).toBe(join(cacheDir, 'demo'));
});

test('the supervisor environment adds one tiered store on the same root', async () => {
  const config: CacheProviderConfig = { provider: './cache.cjs', options: { bucket: 'mobile' }, baseDir: projectRoot };
  const seen: Array<{ projectRoot: string; config: CacheProviderConfig }> = [];
  const remote = new Map<string, unknown>([[KEY.toString('hex'), Buffer.from('from the provider')]]);

  const stores = sharedCacheStores('demo', {
    FileStore: FakeStore,
    cwd: projectRoot,
    env: { [CACHE_PROVIDER_ENV]: cacheProviderEnv(config) },
    loadProvider: async (input): Promise<LoadCacheProviderResult> => {
      seen.push(input);
      return {
        name: input.config.provider,
        provider: {
          metro: {
            get: ({ key }) => remote.get(key.toString('hex')) ?? null,
            set: ({ key, value }) => {
              remote.set(key.toString('hex'), value);
            },
          },
        },
      };
    },
  });

  const tiered = stores[0] as unknown as MetroCacheStore & { flush(): Promise<void> };
  expect(tiered).not.toBeInstanceOf(FakeStore);
  expect(sharedStoreRoot(tiered)).toBe(join(cacheDir, 'demo'));
  expect(await tiered.get(KEY)).toEqual(Buffer.from('from the provider'));
  expect(seen).toEqual([{ projectRoot, config }]);

  await tiered.set(Buffer.from('ff'.repeat(16), 'hex'), Buffer.from('fresh'));
  await tiered.flush();
  expect(remote.get('ff'.repeat(16))).toEqual(Buffer.from('fresh'));
});

test('Metro running outside Stim reads the nearest committed provider', async () => {
  const app = join(projectRoot, 'apps', 'mobile');
  mkdirSync(app, { recursive: true });
  mkdirSync(join(projectRoot, '.git'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.stim.json'),
    JSON.stringify({ cache: { provider: './tools/cache.cjs', options: { bucket: 'team' } } }),
  );
  const seen: Array<{ projectRoot: string; config: CacheProviderConfig }> = [];

  const stores = sharedCacheStores('demo', {
    FileStore: FakeStore,
    cwd: app,
    env: {},
    loadProvider: async (input) => {
      seen.push(input);
      return { none: true };
    },
  });

  await (stores[0] as unknown as MetroCacheStore).get(KEY);
  expect(seen).toEqual([
    {
      projectRoot: app,
      config: { provider: './tools/cache.cjs', options: { bucket: 'team' }, baseDir: projectRoot },
    },
  ]);
});

test('clear only clears the local tier', async () => {
  let providerCalls = 0;
  const stores = sharedCacheStores('demo', {
    FileStore: FakeStore,
    cwd: projectRoot,
    env: {
      [CACHE_PROVIDER_ENV]: cacheProviderEnv({ provider: './cache.cjs', options: {}, baseDir: projectRoot }),
    },
    loadProvider: async () => {
      providerCalls += 1;
      return { none: true };
    },
  });

  (stores[0] as unknown as MetroCacheStore).clear();
  expect(madeStores.length).toBe(1);
  expect(madeStores[0]?.cleared).toBe(1);
  expect(providerCalls).toBe(0);
});

test('the built-in filesystem store satisfies the provider contract', async () => {
  const results = await runCacheProviderContract({
    provider: { metro: metroCapabilityFromStore(new FileStore({ root: join(cacheDir, 'contract') })) },
    projectRoot,
    workDir: projectRoot,
  });

  expect(results.length).toBeGreaterThan(0);
  expect(results.filter((result) => !result.passed)).toEqual([]);
});

test('the committed search stops at the repository root', async () => {
  const repo = join(projectRoot, 'repo');
  const app = join(repo, 'apps', 'mobile');
  mkdirSync(app, { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(projectRoot, '.stim.json'), JSON.stringify({ cache: { provider: './outside-the-repo.cjs' } }));
  const seen: unknown[] = [];

  const stores = sharedCacheStores('demo', {
    FileStore: FakeStore,
    cwd: app,
    env: {},
    loadProvider: async (input) => {
      seen.push(input);
      return { none: true };
    },
  });

  await (stores[0] as unknown as MetroCacheStore).get(KEY);
  expect(seen).toEqual([]);
  expect(stores[0]).toBeInstanceOf(FakeStore);
});

test('outside a repository only the starting directory is read', async () => {
  const app = join(projectRoot, 'apps', 'mobile');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(projectRoot, '.stim.json'), JSON.stringify({ cache: { provider: './parent.cjs' } }));

  expect(sharedCacheStores('demo', { FileStore: FakeStore, cwd: app, env: {} })[0]).toBeInstanceOf(FakeStore);

  writeFileSync(join(app, '.stim.json'), JSON.stringify({ cache: { provider: './here.cjs' } }));
  const seen: Array<{ config: CacheProviderConfig }> = [];
  const stores = sharedCacheStores('demo', {
    FileStore: FakeStore,
    cwd: app,
    env: {},
    loadProvider: async (input) => {
      seen.push(input);
      return { none: true };
    },
  });
  await (stores[0] as unknown as MetroCacheStore).get(KEY);
  expect(seen[0]?.config).toEqual({ provider: './here.cjs', options: {}, baseDir: app });
});

test('an explicit none from the supervisor stops the committed search', async () => {
  mkdirSync(join(projectRoot, '.git'), { recursive: true });
  writeFileSync(join(projectRoot, '.stim.json'), JSON.stringify({ cache: { provider: './committed.cjs' } }));
  const seen: unknown[] = [];

  const stores = sharedCacheStores('demo', {
    FileStore: FakeStore,
    cwd: projectRoot,
    env: { [CACHE_PROVIDER_ENV]: cacheProviderEnv(null) },
    loadProvider: async (input) => {
      seen.push(input);
      return { none: true };
    },
  });

  expect(stores[0]).toBeInstanceOf(FakeStore);
  await (stores[0] as unknown as MetroCacheStore).get(KEY);
  expect(seen).toEqual([]);
});
