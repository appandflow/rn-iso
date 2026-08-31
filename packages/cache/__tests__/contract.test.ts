import { cpSync, mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runCacheProviderContract } from '../contract.ts';
import type { CacheProvider } from '../provider.ts';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'stim-cache-contract-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function memoryProvider(): CacheProvider {
  const transforms = new Map<string, unknown>();
  const builds = new Map<string, string>();
  return {
    metro: {
      get: ({ key }) => transforms.get(key.toString('hex')) ?? null,
      set: ({ key, value }) => {
        transforms.set(key.toString('hex'), value);
      },
    },
    builds: {
      resolve: ({ key, destinationDir }) => {
        const source = builds.get(key);
        if (!source) return null;
        const target = join(destinationDir, basename(source));
        cpSync(source, target, { recursive: true });
        return target;
      },
      store: ({ key, sourcePath, overwrite }) => {
        if (builds.has(key) && !overwrite) return;
        const kept = join(workDir, `kept-${key}`);
        mkdirSync(kept, { recursive: true });
        const target = join(kept, basename(sourcePath));
        cpSync(sourcePath, target, { recursive: true });
        builds.set(key, target);
      },
    },
  };
}

test('the contract passes for a provider that honors both capabilities', async () => {
  const results = await runCacheProviderContract({
    provider: memoryProvider(),
    projectRoot: workDir,
    workDir,
  });

  expect(results.length).toBe(12);
  expect(results.filter((result) => !result.passed)).toEqual([]);
  expect(new Set(results.map((result) => result.capability))).toEqual(new Set(['metro', 'builds']));
});

test('the contract covers an iOS artifact directory', async () => {
  const results = await runCacheProviderContract({
    provider: memoryProvider(),
    projectRoot: workDir,
    workDir,
    platform: 'ios',
  });

  expect(results.filter((result) => !result.passed)).toEqual([]);
});

test('the contract only checks the capabilities a provider advertises', async () => {
  const provider = memoryProvider();
  delete provider.builds;

  const results = await runCacheProviderContract({ provider, projectRoot: workDir, workDir });
  expect(new Set(results.map((result) => result.capability))).toEqual(new Set(['metro']));
});

test('the contract reports violations instead of throwing', async () => {
  const results = await runCacheProviderContract({
    provider: {
      metro: {
        get: () => Buffer.from('always the same'),
        set: () => {},
      },
      builds: {
        resolve: ({ destinationDir }) => join(destinationDir, 'missing.apk'),
        store: () => {},
      },
    },
    projectRoot: workDir,
    workDir,
  });

  const failed = results.filter((result) => !result.passed);
  expect(failed.map((result) => result.name)).toEqual([
    'metro get returns null or undefined for an unknown key',
    'metro set then get returns the stored buffer',
    'metro set then get returns the stored object',
    'metro keys do not collide',
    'builds resolve returns null for an unknown key',
    'builds store then resolve returns the same artifact',
    'builds store honors overwrite',
    'builds store keeps unrelated keys separate',
  ]);
  expect(failed[0]?.error).toMatch(/expected a miss/);
  expect(existsSync(workDir)).toBe(true);
});

test('a capability that ignores its abort signal fails the contract', async () => {
  const results = await runCacheProviderContract({
    provider: {
      metro: { get: () => new Promise(() => {}), set: () => {} },
    },
    projectRoot: workDir,
    workDir,
    checkTimeoutMs: 400,
    abortSettleMs: 100,
  });

  const aborting = results.find((result) => result.name === 'metro get settles when its signal aborts');
  expect(aborting?.passed).toBe(false);
  expect(aborting?.error).toMatch(/did not settle within \d+ms/);
}, 30_000);

test('the runner loads a module reference the way Stim does', async () => {
  writeFileSync(
    join(workDir, 'package.json'),
    JSON.stringify({ name: 'contract-fixture', version: '1.0.0', type: 'module' }),
  );
  writeFileSync(
    join(workDir, 'cache.mjs'),
    `export const apiVersion = 1;
export function createCacheProvider() {
  const transforms = new Map();
  return {
    metro: {
      get: ({ key }) => transforms.get(key.toString('hex')) ?? null,
      set: ({ key, value }) => {
        transforms.set(key.toString('hex'), value);
      },
    },
  };
}
`,
  );

  const passing = await runCacheProviderContract({
    providerModule: './cache.mjs',
    projectRoot: workDir,
    workDir,
  });
  expect(passing.filter((result) => !result.passed)).toEqual([]);
  expect(new Set(passing.map((result) => result.capability))).toEqual(new Set(['metro']));

  writeFileSync(join(workDir, 'old.mjs'), 'export const apiVersion = 2;\n');
  const rejected = await runCacheProviderContract({
    providerModule: './old.mjs',
    projectRoot: workDir,
    workDir,
  });
  expect(rejected.length).toBe(1);
  expect(rejected[0]).toMatchObject({ capability: 'module', passed: false });
  expect(rejected[0]?.error).toMatch(/apiVersion/);
});
