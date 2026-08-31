import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CacheProvider } from './provider.ts';

export interface CacheContractCheck {
  name: string;
  capability: 'metro' | 'builds';
  run(): Promise<void>;
}

export interface CacheContractResult {
  name: string;
  capability: 'metro' | 'builds';
  passed: boolean;
  error?: string;
}

export interface CacheContractOptions {
  provider: CacheProvider;
  projectRoot: string;
  workDir: string;
  cacheName?: string;
  platform?: 'ios' | 'android';
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
}: Required<Pick<CacheContractOptions, 'provider' | 'projectRoot'>> & { cacheName?: string }): CacheContractCheck[] {
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
}: Required<Pick<CacheContractOptions, 'provider' | 'projectRoot' | 'workDir'>> & {
  platform?: 'ios' | 'android';
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

export function cacheProviderContractChecks(options: CacheContractOptions): CacheContractCheck[] {
  return [
    ...metroChecks({
      provider: options.provider,
      projectRoot: options.projectRoot,
      ...(options.cacheName ? { cacheName: options.cacheName } : {}),
    }),
    ...buildChecks({
      provider: options.provider,
      projectRoot: options.projectRoot,
      workDir: options.workDir,
      ...(options.platform ? { platform: options.platform } : {}),
    }),
  ];
}

export async function runCacheProviderContract(options: CacheContractOptions): Promise<CacheContractResult[]> {
  const results: CacheContractResult[] = [];
  for (const check of cacheProviderContractChecks(options)) {
    try {
      await check.run();
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
