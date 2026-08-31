import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_PROVIDER_API_VERSION,
  CACHE_PROVIDER_ENV,
  CACHE_PROVIDER_ENV_NONE,
  PROVIDER_LOAD_TIMEOUT_ENV,
  PROVIDER_LOAD_TIMEOUT_MS,
  cacheProviderEnvIsSet,
  timeoutFromEnv,
  cacheProviderConfigFromEnv,
  cacheProviderEnv,
  callWithTimeout,
  createWarnOnce,
  loadCacheProvider,
  type CacheProviderConfig,
} from '../provider.ts';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'stim-cache-provider-'));
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function config(provider: string, options: Record<string, unknown> = {}): CacheProviderConfig {
  return { provider, options, baseDir: projectRoot };
}

function writeModule(file: string, source: string): void {
  writeFileSync(join(projectRoot, file), source);
}

test('an absent configuration reports no provider', async () => {
  expect(await loadCacheProvider({ projectRoot, config: null })).toEqual({ none: true });
  expect(await loadCacheProvider({ projectRoot, config: config('   ') })).toEqual({ none: true });
});

test('loads a CommonJS provider from the project root', async () => {
  writeModule(
    'cache.cjs',
    `exports.apiVersion = 1;
exports.createCacheProvider = ({ projectRoot, options }) => ({
  metro: {
    get: () => null,
    set: () => {},
  },
  builds: {
    resolve: () => null,
    store: () => {},
  },
  seen: { projectRoot, options },
});
`,
  );

  const loaded = await loadCacheProvider({ projectRoot, config: config('./cache.cjs', { bucket: 'mobile' }) });
  expect(loaded.name).toBe('./cache.cjs');
  expect(loaded.unavailable).toBeUndefined();
  expect(typeof loaded.provider?.metro?.get).toBe('function');
  expect(typeof loaded.provider?.builds?.resolve).toBe('function');
  expect((loaded.provider as unknown as { seen: unknown }).seen).toEqual({
    projectRoot,
    options: { bucket: 'mobile' },
  });
});

test('loads an ESM provider and passes the project root and options to the factory', async () => {
  writeModule(
    'cache.mjs',
    `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const apiVersion = 1;

export function createCacheProvider({ projectRoot, options }) {
  writeFileSync(join(projectRoot, 'factory.json'), JSON.stringify({ projectRoot, options }));
  return { metro: { get: () => null, set: () => {} } };
}
`,
  );

  const loaded = await loadCacheProvider({ projectRoot, config: config('./cache.mjs', { bucket: 'team' }) });
  expect(loaded.unavailable).toBeUndefined();
  expect(JSON.parse(readFileSync(join(projectRoot, 'factory.json'), 'utf-8'))).toEqual({
    projectRoot,
    options: { bucket: 'team' },
  });
});

test('unwraps a default export only when the namespace carries no apiVersion', async () => {
  writeModule(
    'default.mjs',
    `export default {
  apiVersion: 1,
  createCacheProvider: () => ({ builds: { resolve: () => null, store: () => {} } }),
};
`,
  );

  const loaded = await loadCacheProvider({ projectRoot, config: config('./default.mjs') });
  expect(loaded.unavailable).toBeUndefined();
  expect(typeof loaded.provider?.builds?.store).toBe('function');
});

test('resolves a package name from the base directory', async () => {
  const packageDir = join(projectRoot, 'node_modules', 'team-cache');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'team-cache', main: 'index.cjs' }));
  writeFileSync(
    join(packageDir, 'index.cjs'),
    `exports.apiVersion = 1;
exports.createCacheProvider = () => ({ metro: { get: () => null, set: () => {} } });
`,
  );

  const loaded = await loadCacheProvider({ projectRoot, config: config('team-cache') });
  expect(loaded.unavailable).toBeUndefined();
  expect(loaded.name).toBe('team-cache');
});

test('accepts providers with only one capability', async () => {
  writeModule(
    'metro-only.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => ({ metro: { get: () => null, set: () => {} } });
`,
  );
  writeModule(
    'builds-only.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => ({ builds: { resolve: () => null, store: () => {} } });
`,
  );

  const metroOnly = await loadCacheProvider({ projectRoot, config: config('./metro-only.mjs') });
  expect(metroOnly.provider?.metro).toBeDefined();
  expect(metroOnly.provider?.builds).toBeUndefined();

  const buildsOnly = await loadCacheProvider({ projectRoot, config: config('./builds-only.mjs') });
  expect(buildsOnly.provider?.builds).toBeDefined();
  expect(buildsOnly.provider?.metro).toBeUndefined();
});

test('rejects an unsupported API version without throwing', async () => {
  writeModule(
    'old.mjs',
    `export const apiVersion = 2;
export const createCacheProvider = () => ({ metro: { get: () => null, set: () => {} } });
`,
  );

  const loaded = await loadCacheProvider({ projectRoot, config: config('./old.mjs') });
  expect(loaded.provider).toBeUndefined();
  expect(loaded.unavailable).toMatch(/apiVersion/);
  expect(CACHE_PROVIDER_API_VERSION).toBe(1);
});

test('rejects a module without a factory', async () => {
  writeModule('no-factory.mjs', 'export const apiVersion = 1;\n');

  const loaded = await loadCacheProvider({ projectRoot, config: config('./no-factory.mjs') });
  expect(loaded.unavailable).toMatch(/createCacheProvider/);
});

test('rejects malformed capability methods without throwing', async () => {
  writeModule(
    'bad-metro.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => ({ metro: { get: () => null } });
`,
  );
  writeModule(
    'bad-builds.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => ({ builds: { store: () => {} } });
`,
  );
  writeModule(
    'empty.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => ({});
`,
  );

  expect((await loadCacheProvider({ projectRoot, config: config('./bad-metro.mjs') })).unavailable).toMatch(
    /metro.*get\(\) and set\(\)/,
  );
  expect((await loadCacheProvider({ projectRoot, config: config('./bad-builds.mjs') })).unavailable).toMatch(
    /builds.*resolve\(\) and store\(\)/,
  );
  expect((await loadCacheProvider({ projectRoot, config: config('./empty.mjs') })).unavailable).toMatch(
    /neither a metro nor a builds capability/,
  );
});

test('reports a missing module and a failing factory as unavailable', async () => {
  const missing = await loadCacheProvider({ projectRoot, config: config('./nope.cjs') });
  expect(missing.provider).toBeUndefined();
  expect(missing.unavailable).toBeTruthy();

  writeModule(
    'throws.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => {
  throw new Error('missing credentials\\nsecond line');
};
`,
  );
  const failed = await loadCacheProvider({ projectRoot, config: config('./throws.mjs') });
  expect(failed.unavailable).toBe('createCacheProvider() failed: missing credentials');
});

test('the environment transport round-trips a configuration', () => {
  const original: CacheProviderConfig = {
    provider: './cache.cjs',
    options: { bucket: 'mobile' },
    baseDir: projectRoot,
  };
  const env = { [CACHE_PROVIDER_ENV]: cacheProviderEnv(original) };
  expect(cacheProviderConfigFromEnv(env)).toEqual(original);
});

test('the environment transport rejects malformed payloads', () => {
  expect(cacheProviderConfigFromEnv({})).toBeNull();
  expect(cacheProviderConfigFromEnv({ [CACHE_PROVIDER_ENV]: 'not json' })).toBeNull();
  expect(cacheProviderConfigFromEnv({ [CACHE_PROVIDER_ENV]: '{"provider":"./x.cjs"}' })).toBeNull();
  expect(cacheProviderConfigFromEnv({ [CACHE_PROVIDER_ENV]: '{"baseDir":"/tmp"}' })).toBeNull();
  expect(cacheProviderConfigFromEnv({ [CACHE_PROVIDER_ENV]: '{"provider":"./x.cjs","baseDir":"/tmp"}' })).toEqual({
    provider: './x.cjs',
    options: {},
    baseDir: '/tmp',
  });
});

test('a bounded call returns the value, the failure, or a timeout', async () => {
  expect(await callWithTimeout(() => 'value', 1000)).toEqual({ value: 'value' });
  expect(await callWithTimeout(() => Promise.reject(new Error('boom\ndetail')), 1000)).toEqual({ failed: 'boom' });

  let aborted = false;
  const outcome = await callWithTimeout(
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve('late');
        });
      }),
    5,
  );
  expect(outcome).toEqual({ timedOut: true });
  expect(aborted).toBe(true);
});

test('a warning class is emitted once', () => {
  const lines: string[] = [];
  const warn = createWarnOnce((line) => lines.push(line));
  warn('read', 'first read failure');
  warn('read', 'second read failure');
  warn('write', 'first write failure');
  expect(lines).toEqual(['first read failure', 'first write failure']);
});

test('a factory that never settles becomes unavailable instead of hanging', async () => {
  writeModule(
    'hangs.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => new Promise(() => {});
`,
  );

  const started = Date.now();
  const loaded = await loadCacheProvider({ projectRoot, config: config('./hangs.mjs'), timeoutMs: 25 });
  expect(loaded.provider).toBeUndefined();
  expect(loaded.unavailable).toBe('the module did not load within 25ms');
  expect(Date.now() - started).toBeLessThan(2_000);
});

test('a module whose top level never settles becomes unavailable instead of hanging', async () => {
  writeModule('top-level-hang.mjs', 'await new Promise(() => {});\nexport const apiVersion = 1;\n');

  const loaded = await loadCacheProvider({ projectRoot, config: config('./top-level-hang.mjs'), timeoutMs: 25 });
  expect(loaded.unavailable).toBe('the module did not load within 25ms');
});

test('the load timeout is tunable through the environment', () => {
  expect(timeoutFromEnv(PROVIDER_LOAD_TIMEOUT_ENV, PROVIDER_LOAD_TIMEOUT_MS, {})).toBe(PROVIDER_LOAD_TIMEOUT_MS);
  expect(timeoutFromEnv(PROVIDER_LOAD_TIMEOUT_ENV, 10, { [PROVIDER_LOAD_TIMEOUT_ENV]: '250' })).toBe(250);
  expect(timeoutFromEnv(PROVIDER_LOAD_TIMEOUT_ENV, 10, { [PROVIDER_LOAD_TIMEOUT_ENV]: '0' })).toBe(10);
  expect(timeoutFromEnv(PROVIDER_LOAD_TIMEOUT_ENV, 10, { [PROVIDER_LOAD_TIMEOUT_ENV]: 'soon' })).toBe(10);
});

test('the environment transport carries an explicit none decision', () => {
  expect(cacheProviderEnv(null)).toBe(CACHE_PROVIDER_ENV_NONE);
  const env = { [CACHE_PROVIDER_ENV]: cacheProviderEnv(null) };
  expect(cacheProviderConfigFromEnv(env)).toBeNull();
  expect(cacheProviderEnvIsSet(env)).toBe(true);
  expect(cacheProviderEnvIsSet({})).toBe(false);
  expect(cacheProviderEnvIsSet({ [CACHE_PROVIDER_ENV]: '   ' })).toBe(false);
});
