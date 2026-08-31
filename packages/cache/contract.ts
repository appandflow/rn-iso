import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { loadCacheProvider, type CacheProvider } from './provider.ts';

export interface CacheContractCheck {
  name: string;
  capability: 'metro' | 'builds';
  run(): Promise<void>;
}

export interface CacheContractResult {
  name: string;
  capability: 'metro' | 'builds' | 'module';
  passed: boolean;
  error?: string;
}

export interface CacheContractOptions {
  provider: CacheProvider;
  projectRoot: string;
  workDir: string;
  cacheName?: string;
  platform?: 'ios' | 'android';
  checkTimeoutMs?: number;
  abortSettleMs?: number;
}

/**
 * Loads the provider the way Stim does, from a module reference, so a provider
 * author exercises `apiVersion` and factory validation as well as the
 * capability checks.
 */
export interface CacheContractModuleOptions extends Omit<CacheContractOptions, 'provider'> {
  providerModule: string;
  options?: Record<string, unknown>;
  baseDir?: string;
}

export const CACHE_CONTRACT_CHECK_TIMEOUT_MS = 30_000;

const ABORT_SETTLE_MS = 1_000;

async function settlesAfterAbort(start: (signal: AbortSignal) => unknown, settleMs: number): Promise<void> {
  const controller = new AbortController();
  const call = Promise.resolve()
    .then(() => start(controller.signal))
    .then(
      () => 'settled',
      () => 'settled',
    );
  controller.abort();
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    call,
    new Promise<'ignored'>((resolve) => {
      timer = setTimeout(() => resolve('ignored'), settleMs);
    }),
  ]);
  clearTimeout(timer);
  assert(outcome === 'settled', `the call did not settle within ${settleMs}ms of its signal aborting`);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..';
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function metroChecks({
  provider,
  projectRoot,
  cacheName = 'app',
  abortSettleMs = ABORT_SETTLE_MS,
}: Required<Pick<CacheContractOptions, 'provider' | 'projectRoot'>> & {
  cacheName?: string;
  abortSettleMs?: number;
}): CacheContractCheck[] {
  const metro = provider.metro;
  if (!metro) return [];
  const context = { projectRoot, cacheName, signal: neverAborted() };

  return [
    {
      name: 'metro get returns null or undefined for an unknown key',
      capability: 'metro',
      async run() {
        const value = await metro.get({ ...context, key: randomBytes(32) });
        assert(value === null || value === undefined, `expected a miss, received ${JSON.stringify(value)}`);
      },
    },
    {
      name: 'metro set then get returns the stored buffer',
      capability: 'metro',
      async run() {
        const key = randomBytes(32);
        const value = randomBytes(64);
        await metro.set({ ...context, key, value });
        const stored = await metro.get({ ...context, key });
        assert(Buffer.isBuffer(stored), `expected a Buffer, received ${typeof stored}`);
        assert(Buffer.compare(stored as Buffer, value) === 0, 'the stored buffer does not match the written buffer');
      },
    },
    {
      name: 'metro set then get returns the stored object',
      capability: 'metro',
      async run() {
        const key = randomBytes(32);
        const value = { code: `contract-${randomUUID()}`, map: [1, 2, 3] };
        await metro.set({ ...context, key, value });
        const stored = await metro.get({ ...context, key });
        assert(
          JSON.stringify(stored) === JSON.stringify(value),
          `expected ${JSON.stringify(value)}, received ${JSON.stringify(stored)}`,
        );
      },
    },
    {
      name: 'metro get settles when its signal aborts',
      capability: 'metro',
      async run() {
        await settlesAfterAbort(
          (signal) => metro.get({ projectRoot, cacheName, key: randomBytes(32), signal }),
          abortSettleMs,
        );
      },
    },
    {
      name: 'metro keys do not collide',
      capability: 'metro',
      async run() {
        const first = randomBytes(32);
        const second = randomBytes(32);
        await metro.set({ ...context, key: first, value: Buffer.from('first') });
        await metro.set({ ...context, key: second, value: Buffer.from('second') });
        const stored = await metro.get({ ...context, key: first });
        assert(
          Buffer.isBuffer(stored) && stored.toString() === 'first',
          'the second write overwrote the value of an unrelated key',
        );
      },
    },
  ];
}

function buildChecks({
  provider,
  projectRoot,
  workDir,
  platform = 'android',
  abortSettleMs = ABORT_SETTLE_MS,
}: Required<Pick<CacheContractOptions, 'provider' | 'projectRoot' | 'workDir'>> & {
  platform?: 'ios' | 'android';
  abortSettleMs?: number;
}): CacheContractCheck[] {
  const builds = provider.builds;
  if (!builds) return [];
  const signal = neverAborted();

  function artifact(): { sourcePath: string; contents: Buffer } {
    const dir = join(workDir, `source-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const sourcePath = join(dir, platform === 'ios' ? 'Contract.app' : 'contract.apk');
    const contents = randomBytes(128);
    if (platform === 'ios') {
      mkdirSync(sourcePath, { recursive: true });
      writeFileSync(join(sourcePath, 'contract.bin'), contents);
    } else {
      writeFileSync(sourcePath, contents);
    }
    return { sourcePath, contents };
  }

  function destination(): string {
    const dir = join(workDir, `destination-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function storedContents(path: string): Buffer {
    return readFileSync(platform === 'ios' ? join(path, 'contract.bin') : path);
  }

  return [
    {
      name: 'builds resolve returns null for an unknown key',
      capability: 'builds',
      async run() {
        const found = await builds.resolve({
          projectRoot,
          platform,
          key: `contract-miss-${randomUUID()}`,
          destinationDir: destination(),
          signal,
        });
        assert(found === null || found === undefined, `expected a miss, received ${String(found)}`);
      },
    },
    {
      name: 'builds store then resolve returns the same artifact',
      capability: 'builds',
      async run() {
        const key = `contract-${randomUUID()}`;
        const { sourcePath, contents } = artifact();
        await builds.store({ projectRoot, platform, key, sourcePath, overwrite: false, signal });
        const found = await builds.resolve({ projectRoot, platform, key, destinationDir: destination(), signal });
        assert(typeof found === 'string' && found !== '', 'the stored key did not resolve');
        assert(
          Buffer.compare(storedContents(found as string), contents) === 0,
          'the resolved artifact does not match the stored artifact',
        );
      },
    },
    {
      name: 'builds resolve settles when its signal aborts',
      capability: 'builds',
      async run() {
        await settlesAfterAbort(
          (aborting) =>
            builds.resolve({
              projectRoot,
              platform,
              key: `contract-abort-${randomUUID()}`,
              destinationDir: destination(),
              signal: aborting,
            }),
          abortSettleMs,
        );
      },
    },
    {
      name: 'builds resolve leaves the destination directory empty on a miss',
      capability: 'builds',
      async run() {
        const dir = destination();
        await builds.resolve({
          projectRoot,
          platform,
          key: `contract-miss-${randomUUID()}`,
          destinationDir: dir,
          signal,
        });
        assert(readdirSync(dir).length === 0, `a miss left ${readdirSync(dir).join(', ')} in the destination`);
      },
    },
    {
      name: 'builds resolve returns a path it owns or one inside the destination',
      capability: 'builds',
      async run() {
        const key = `contract-${randomUUID()}`;
        const { sourcePath, contents } = artifact();
        await builds.store({ projectRoot, platform, key, sourcePath, overwrite: false, signal });
        const dir = destination();
        const found = await builds.resolve({ projectRoot, platform, key, destinationDir: dir, signal });
        assert(typeof found === 'string' && found !== '', 'the stored key did not resolve');
        const path = found as string;
        assert(
          isInside(dir, path) || Buffer.compare(storedContents(path), contents) === 0,
          `${path} is neither inside the destination nor a copy the capability owns`,
        );
      },
    },
    {
      name: 'builds store honors overwrite',
      capability: 'builds',
      async run() {
        const key = `contract-${randomUUID()}`;
        const first = artifact();
        const second = artifact();
        await builds.store({ projectRoot, platform, key, sourcePath: first.sourcePath, overwrite: false, signal });
        await builds.store({ projectRoot, platform, key, sourcePath: second.sourcePath, overwrite: false, signal });
        const kept = await builds.resolve({ projectRoot, platform, key, destinationDir: destination(), signal });
        assert(typeof kept === 'string', 'the stored key did not resolve');
        assert(
          Buffer.compare(storedContents(kept as string), first.contents) === 0,
          'overwrite: false replaced an entry that already existed',
        );

        await builds.store({ projectRoot, platform, key, sourcePath: second.sourcePath, overwrite: true, signal });
        const replaced = await builds.resolve({ projectRoot, platform, key, destinationDir: destination(), signal });
        assert(typeof replaced === 'string', 'the overwritten key did not resolve');
        assert(
          Buffer.compare(storedContents(replaced as string), second.contents) === 0,
          'overwrite: true kept the previous entry',
        );
      },
    },
    {
      name: 'builds store keeps unrelated keys separate',
      capability: 'builds',
      async run() {
        const first = `contract-${randomUUID()}`;
        const second = `contract-${randomUUID()}`;
        const one = artifact();
        const two = artifact();
        await builds.store({ projectRoot, platform, key: first, sourcePath: one.sourcePath, overwrite: false, signal });
        await builds.store({
          projectRoot,
          platform,
          key: second,
          sourcePath: two.sourcePath,
          overwrite: false,
          signal,
        });
        const found = await builds.resolve({
          projectRoot,
          platform,
          key: first,
          destinationDir: destination(),
          signal,
        });
        assert(typeof found === 'string' && found !== '', 'the first key stopped resolving after the second store');
        assert(
          Buffer.compare(storedContents(found as string), one.contents) === 0,
          'the second store replaced the artifact of an unrelated key',
        );
      },
    },
  ];
}

const MODULE_CHECK = 'the module loads through loadCacheProvider()';

async function loadContractProvider(
  options: CacheContractModuleOptions,
): Promise<CacheContractOptions | { failure: CacheContractResult }> {
  const loaded = await loadCacheProvider({
    projectRoot: options.projectRoot,
    config: {
      provider: options.providerModule,
      options: options.options ?? {},
      baseDir: options.baseDir ?? options.projectRoot,
    },
  });
  if (!loaded.provider) {
    return {
      failure: {
        name: MODULE_CHECK,
        capability: 'module',
        passed: false,
        error: loaded.unavailable ?? 'the reference selected no provider',
      },
    };
  }
  return { ...options, provider: loaded.provider };
}

export function cacheProviderContractChecks(options: CacheContractOptions): CacheContractCheck[] {
  return [
    ...metroChecks({
      provider: options.provider,
      projectRoot: options.projectRoot,
      ...(options.cacheName ? { cacheName: options.cacheName } : {}),
      ...(options.abortSettleMs ? { abortSettleMs: options.abortSettleMs } : {}),
    }),
    ...buildChecks({
      provider: options.provider,
      projectRoot: options.projectRoot,
      workDir: options.workDir,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.abortSettleMs ? { abortSettleMs: options.abortSettleMs } : {}),
    }),
  ];
}

export async function runCacheProviderContract(
  options: CacheContractOptions | CacheContractModuleOptions,
): Promise<CacheContractResult[]> {
  const resolved = 'providerModule' in options ? await loadContractProvider(options) : options;
  if ('failure' in resolved) return [resolved.failure];

  const checkTimeoutMs = resolved.checkTimeoutMs ?? CACHE_CONTRACT_CHECK_TIMEOUT_MS;
  const results: CacheContractResult[] = [];
  for (const check of cacheProviderContractChecks(resolved)) {
    try {
      await withDeadline(check.run(), checkTimeoutMs);
      results.push({ name: check.name, capability: check.capability, passed: true });
    } catch (error) {
      results.push({
        name: check.name,
        capability: check.capability,
        passed: false,
        error: String((error as Error)?.message || error),
      });
    }
  }
  return results;
}

async function withDeadline(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the check did not finish within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
