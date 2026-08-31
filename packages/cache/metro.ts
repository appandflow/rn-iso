import { callWithTimeout, type LoadCacheProviderResult, type MetroCacheCapability, type WarnOnce } from './provider.ts';

export const METRO_READ_TIMEOUT_MS = 2_000;
export const METRO_WRITE_TIMEOUT_MS = 10_000;
export const METRO_UPLOAD_CONCURRENCY = 4;
export const METRO_UPLOAD_MAX_ITEMS = 128;
export const METRO_UPLOAD_MAX_BYTES: number = 32 * 1024 * 1024;

/**
 * Metro's structural cache-store contract: `get` returns the value or `null`,
 * `set` stores it, and `clear` empties the store.
 */
export interface MetroCacheStore {
  get(key: Buffer): unknown;
  set(key: Buffer, value: unknown): unknown;
  clear(): unknown;
}

export interface TieredMetroStore extends MetroCacheStore {
  get(key: Buffer): Promise<unknown>;
  set(key: Buffer, value: unknown): Promise<void>;
  clear(): unknown;
  flush(): Promise<void>;
}

export interface MetroTierLimits {
  concurrency?: number;
  maxItems?: number;
  maxBytes?: number;
}

export interface MetroTierTimeouts {
  readMs?: number;
  writeMs?: number;
}

export interface TieredMetroStoreOptions {
  local: MetroCacheStore;
  projectRoot: string;
  cacheName: string;
  loadProvider: () => Promise<LoadCacheProviderResult>;
  warn?: WarnOnce;
  limits?: MetroTierLimits;
  timeouts?: MetroTierTimeouts;
}

export function metroCapabilityFromStore(store: MetroCacheStore): MetroCacheCapability {
  return {
    get: ({ key }) => store.get(key),
    set: async ({ key, value }) => {
      await store.set(key, value);
    },
  };
}

const defaultWarn: WarnOnce = (_code, message) => {
  process.stderr.write(`${message}\n`);
};

function onceByCode(warn: WarnOnce): WarnOnce {
  const seen = new Set<string>();
  return (code, message) => {
    if (seen.has(code)) return;
    seen.add(code);
    warn(code, message);
  };
}

function valueBytes(value: unknown): number | null {
  if (Buffer.isBuffer(value)) return value.length;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : Buffer.byteLength(json);
  } catch {
    return null;
  }
}

interface UploadQueue {
  add(bytes: number, run: () => Promise<void>): boolean;
  idle(): Promise<void>;
}

function createUploadQueue({ concurrency, maxItems, maxBytes }: Required<MetroTierLimits>): UploadQueue {
  const pending: Array<{ bytes: number; run: () => Promise<void> }> = [];
  const waiters: Array<() => void> = [];
  let active = 0;
  let items = 0;
  let bytes = 0;

  function settle(): void {
    if (active > 0 || pending.length > 0) return;
    while (waiters.length) waiters.shift()?.();
  }

  function pump(): void {
    while (active < concurrency && pending.length > 0) {
      const task = pending.shift()!;
      active += 1;
      void task
        .run()
        .catch(() => {})
        .finally(() => {
          active -= 1;
          items -= 1;
          bytes -= task.bytes;
          pump();
          settle();
        });
    }
  }

  return {
    add(size, run) {
      if (items + 1 > maxItems || bytes + size > maxBytes) return false;
      items += 1;
      bytes += size;
      pending.push({ bytes: size, run });
      pump();
      return true;
    },
    idle() {
      if (active === 0 && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

export function createTieredMetroStore({
  local,
  projectRoot,
  cacheName,
  loadProvider,
  warn: emit = defaultWarn,
  limits = {},
  timeouts = {},
}: TieredMetroStoreOptions): TieredMetroStore {
  const warn = onceByCode(emit);
  const localCapability = metroCapabilityFromStore(local);
  const readMs = timeouts.readMs ?? METRO_READ_TIMEOUT_MS;
  const writeMs = timeouts.writeMs ?? METRO_WRITE_TIMEOUT_MS;
  const queue = createUploadQueue({
    concurrency: limits.concurrency ?? METRO_UPLOAD_CONCURRENCY,
    maxItems: limits.maxItems ?? METRO_UPLOAD_MAX_ITEMS,
    maxBytes: limits.maxBytes ?? METRO_UPLOAD_MAX_BYTES,
  });

  let loading: Promise<MetroCacheCapability | null> | null = null;

  function providerCapability(): Promise<MetroCacheCapability | null> {
    loading ??= loadProvider().then((loaded) => {
      if (loaded?.unavailable) {
        warn(
          'provider-load',
          `cache provider ${loaded.name} is not usable: ${loaded.unavailable}; using local transforms`,
        );
        return null;
      }
      return loaded?.provider?.metro ?? null;
    });
    return loading;
  }

  return {
    async get(key) {
      const hit = await localCapability.get({ key, projectRoot, cacheName, signal: neverAborted() });
      if (hit !== null && hit !== undefined) return hit;

      const capability = await providerCapability();
      if (!capability) return null;

      const outcome = await callWithTimeout(
        (signal) => capability.get({ key, projectRoot, cacheName, signal }),
        readMs,
      );
      if (outcome.timedOut) {
        warn(
          'provider-read',
          `the cache provider did not answer a transform read within ${readMs}ms; using local transforms`,
        );
        return null;
      }
      if (outcome.failed) {
        warn(
          'provider-read',
          `the cache provider could not read a transform: ${outcome.failed}; using local transforms`,
        );
        return null;
      }
      const value = outcome.value;
      if (value === null || value === undefined) return null;

      try {
        await localCapability.set({ key, value, projectRoot, cacheName, signal: neverAborted() });
      } catch (error) {
        warn(
          'provider-backfill',
          `a provider transform could not be written locally: ${String((error as Error)?.message || error)}`,
        );
      }
      return value;
    },

    async set(key, value) {
      await localCapability.set({ key, value, projectRoot, cacheName, signal: neverAborted() });

      const capability = await providerCapability();
      if (!capability) return;

      const bytes = valueBytes(value);
      if (bytes === null) {
        warn('provider-write', 'a transform could not be measured for the cache provider; it stays local');
        return;
      }
      const queued = queue.add(bytes, async () => {
        const outcome = await callWithTimeout(
          (signal) => capability.set({ key, value, projectRoot, cacheName, signal }),
          writeMs,
        );
        if (outcome.timedOut) {
          warn(
            'provider-write',
            `the cache provider did not accept a transform within ${writeMs}ms; later transforms stay local until it answers`,
          );
        } else if (outcome.failed) {
          warn('provider-write', `the cache provider could not store a transform: ${outcome.failed}`);
        }
      });
      if (!queued) {
        warn('provider-queue', 'the cache provider upload queue is full; those transforms stay local');
      }
    },

    clear() {
      return local.clear();
    },

    flush() {
      return queue.idle();
    },
  };
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}
