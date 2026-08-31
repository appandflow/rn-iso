import {
  METRO_UPLOAD_CONCURRENCY,
  METRO_UPLOAD_MAX_BYTES,
  METRO_UPLOAD_MAX_ITEMS,
  METRO_READ_TIMEOUT_MS,
  METRO_WRITE_TIMEOUT_MS,
  createTieredMetroStore,
  metroCapabilityFromStore,
  type MetroCacheStore,
  type TieredMetroStoreOptions,
} from '../metro.ts';
import type { LoadCacheProviderResult, MetroCacheCapability } from '../provider.ts';

function memoryStore(): MetroCacheStore & { entries: Map<string, unknown>; cleared: number } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    cleared: 0,
    async get(key: Buffer) {
      return entries.has(key.toString('hex')) ? entries.get(key.toString('hex')) : null;
    },
    async set(key: Buffer, value: unknown) {
      entries.set(key.toString('hex'), value);
    },
    clear() {
      this.cleared += 1;
    },
  };
}

function tracked(capability: Partial<MetroCacheCapability> = {}) {
  const calls = { get: 0, set: 0 };
  const entries = new Map<string, unknown>();
  const provider: MetroCacheCapability = {
    get: async (input) => {
      calls.get += 1;
      if (capability.get) return capability.get(input);
      return entries.get(input.key.toString('hex')) ?? null;
    },
    set: async (input) => {
      calls.set += 1;
      if (capability.set) return capability.set(input);
      entries.set(input.key.toString('hex'), input.value);
    },
  };
  return { provider, calls, entries };
}

function store(
  options: Partial<TieredMetroStoreOptions> & {
    local: MetroCacheStore;
    loadProvider: () => Promise<LoadCacheProviderResult>;
  },
) {
  const warnings: Array<{ code: string; message: string }> = [];
  const tiered = createTieredMetroStore({
    projectRoot: '/repo/app',
    cacheName: 'app',
    warn: (code, message) => warnings.push({ code, message }),
    ...options,
  });
  return { tiered, warnings };
}

const KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

test('the pinned queue and timeout limits stay put', () => {
  expect(METRO_READ_TIMEOUT_MS).toBe(2_000);
  expect(METRO_WRITE_TIMEOUT_MS).toBe(10_000);
  expect(METRO_UPLOAD_CONCURRENCY).toBe(4);
  expect(METRO_UPLOAD_MAX_ITEMS).toBe(128);
  expect(METRO_UPLOAD_MAX_BYTES).toBe(32 * 1024 * 1024);
});

test('a local hit does not load or call the provider', async () => {
  const local = memoryStore();
  await local.set(KEY, Buffer.from('cached'));
  let loads = 0;
  const { tiered } = store({
    local,
    loadProvider: async () => {
      loads += 1;
      return { none: true };
    },
  });

  expect(await tiered.get(KEY)).toEqual(Buffer.from('cached'));
  expect(loads).toBe(0);
});

test('a provider hit is written locally before it is returned', async () => {
  const local = memoryStore();
  const provider = tracked();
  await provider.provider.set({
    key: KEY,
    value: Buffer.from('remote'),
    projectRoot: '/repo/app',
    cacheName: 'app',
    signal: new AbortController().signal,
  });
  const { tiered } = store({
    local,
    loadProvider: async () => ({ name: './cache.cjs', provider: { metro: provider.provider } }),
  });

  expect(await tiered.get(KEY)).toEqual(Buffer.from('remote'));
  expect(local.entries.get(KEY.toString('hex'))).toEqual(Buffer.from('remote'));
});

test('a total miss returns null and loads the provider once', async () => {
  const local = memoryStore();
  const provider = tracked();
  let loads = 0;
  const { tiered } = store({
    local,
    loadProvider: async () => {
      loads += 1;
      return { name: './cache.cjs', provider: { metro: provider.provider } };
    },
  });

  expect(await tiered.get(KEY)).toBeNull();
  expect(await tiered.get(Buffer.from('ff', 'hex'))).toBeNull();
  expect(loads).toBe(1);
  expect(provider.calls.get).toBe(2);
});

test('set waits for the local write but not the provider write', async () => {
  const local = memoryStore();
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const provider = tracked({ set: async () => blocked });
  const { tiered } = store({ local, loadProvider: async () => ({ provider: { metro: provider.provider } }) });

  await tiered.set(KEY, Buffer.from('fresh'));
  expect(local.entries.get(KEY.toString('hex'))).toEqual(Buffer.from('fresh'));
  expect(provider.calls.set).toBe(1);

  release();
  await tiered.flush();
});

test('clear calls only the local store', async () => {
  const local = memoryStore();
  const provider = tracked();
  const { tiered } = store({ local, loadProvider: async () => ({ provider: { metro: provider.provider } }) });

  tiered.clear();
  expect(local.cleared).toBe(1);
  expect(provider.calls.get + provider.calls.set).toBe(0);
});

test('a provider timeout returns a local miss and warns once', async () => {
  const local = memoryStore();
  const provider = tracked({ get: () => new Promise(() => {}) });
  const { tiered, warnings } = store({
    local,
    loadProvider: async () => ({ provider: { metro: provider.provider } }),
    timeouts: { readMs: 5 },
  });

  expect(await tiered.get(KEY)).toBeNull();
  expect(await tiered.get(KEY)).toBeNull();
  expect(warnings.map((w) => w.code)).toEqual(['provider-read']);
  expect(warnings[0]?.message).toMatch(/within 5ms/);
});

test('one warning is emitted per failure class', async () => {
  const local = memoryStore();
  const provider = tracked({
    get: () => {
      throw new Error('read denied');
    },
    set: () => {
      throw new Error('write denied');
    },
  });
  const { tiered, warnings } = store({ local, loadProvider: async () => ({ provider: { metro: provider.provider } }) });

  await tiered.get(KEY);
  await tiered.get(KEY);
  await tiered.set(KEY, Buffer.from('a'));
  await tiered.set(KEY, Buffer.from('b'));
  await tiered.flush();

  expect(warnings.map((w) => w.code)).toEqual(['provider-read', 'provider-write']);
  expect(warnings[0]?.message).toMatch(/read denied/);
  expect(warnings[1]?.message).toMatch(/write denied/);
});

test('an unusable provider warns once and keeps the local tier', async () => {
  const local = memoryStore();
  const { tiered, warnings } = store({
    local,
    loadProvider: async () => ({ name: './cache.cjs', unavailable: 'missing credentials' }),
  });

  expect(await tiered.get(KEY)).toBeNull();
  await tiered.set(KEY, Buffer.from('fresh'));
  expect(local.entries.get(KEY.toString('hex'))).toEqual(Buffer.from('fresh'));
  expect(warnings).toEqual([
    {
      code: 'provider-load',
      message: 'cache provider ./cache.cjs is not usable: missing credentials; using local transforms',
    },
  ]);
});

test('the queue enforces item and byte limits', async () => {
  const local = memoryStore();
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const provider = tracked({ set: async () => blocked });
  const { tiered, warnings } = store({
    local,
    loadProvider: async () => ({ provider: { metro: provider.provider } }),
    limits: { concurrency: 1, maxItems: 2, maxBytes: 1024 },
  });

  await tiered.set(Buffer.from('01', 'hex'), Buffer.alloc(8));
  await tiered.set(Buffer.from('02', 'hex'), Buffer.alloc(8));
  await tiered.set(Buffer.from('03', 'hex'), Buffer.alloc(8));
  expect(warnings.map((w) => w.code)).toEqual(['provider-queue']);
  expect(provider.calls.set).toBe(1);

  release();
  await tiered.flush();
  expect(provider.calls.set).toBe(2);

  await tiered.set(Buffer.from('04', 'hex'), Buffer.alloc(2048));
  expect(provider.calls.set).toBe(2);
  expect(local.entries.size).toBe(4);
});

test('a value that cannot be measured stays local', async () => {
  const local = memoryStore();
  const provider = tracked();
  const { tiered, warnings } = store({ local, loadProvider: async () => ({ provider: { metro: provider.provider } }) });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await tiered.set(KEY, cyclic);
  await tiered.flush();

  expect(local.entries.get(KEY.toString('hex'))).toBe(cyclic);
  expect(provider.calls.set).toBe(0);
  expect(warnings.map((w) => w.code)).toEqual(['provider-write']);
});

test('a Metro store adapts to the capability contract', async () => {
  const local = memoryStore();
  const capability = metroCapabilityFromStore(local);
  await capability.set({
    key: KEY,
    value: Buffer.from('x'),
    projectRoot: '/repo',
    cacheName: 'app',
    signal: new AbortController().signal,
  });
  expect(
    await capability.get({ key: KEY, projectRoot: '/repo', cacheName: 'app', signal: new AbortController().signal }),
  ).toEqual(Buffer.from('x'));
});
