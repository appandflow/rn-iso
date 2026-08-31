import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expoMetroConfigPath, metroStoreConfirmedRoot } from '../supervisor/metro-store.ts';

let project: string;
let adapter: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'stim-expo-config-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'adapter-test' }));

  const expo = join(project, 'node_modules', 'expo');
  mkdirSync(expo, { recursive: true });
  writeFileSync(join(expo, 'package.json'), JSON.stringify({ name: 'expo', version: '54.0.0' }));
  writeFileSync(
    join(expo, 'metro-config.js'),
    `class DefaultStore { constructor() { this._root = '/expo/default/store'; } }
     exports.getDefaultConfig = () => ({ cacheStores: [new DefaultStore()], resolver: { sourceExts: ['js'] } });\n`,
  );

  const found = expoMetroConfigPath();
  if (!found) throw new Error('the Expo Metro config adapter is missing from this checkout');
  adapter = found;
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

const driver = `
  class FileStore { constructor(options) { this._root = options.root; } }
  Promise.resolve(require(process.env.ADAPTER)).then((config) => {
    const stores = config.cacheStores({ FileStore });
    console.log(JSON.stringify({ roots: stores.map((store) => store && store._root), sourceExts: config.resolver?.sourceExts }));
  });
`;

function run(extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['-e', driver], {
    cwd: project,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ADAPTER: adapter,
      STIM_PROJECT_ROOT: project,
      STIM_METRO_STORE: '/cache/adapter-test',
      ...extraEnv,
    },
  });
}

describe('the Expo Metro config adapter', () => {
  test('ships with Stim and is discoverable from source builds', () => {
    expect(adapter.endsWith(join('shim', 'expo-metro-config.cjs'))).toBe(true);
    expect(expoMetroConfigPath('file:///nowhere/at/all/x.js')).toBe(null);
  });

  test('keeps Expo default stores when the project has no Metro config', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      roots: ['/expo/default/store', '/cache/adapter-test'],
    });
    expect(result.stderr.trim()).toBe('stim-metro-store: sharing Metro transforms through /cache/adapter-test');
  });

  test("keeps the project's config and cache stores, then appends Stim's", () => {
    writeFileSync(
      join(project, 'metro.config.cjs'),
      `module.exports = {
         resolver: { sourceExts: ['js', 'svg'] },
         cacheStores: [{ _root: '/project/store' }],
       };\n`,
    );
    const result = run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      roots: ['/project/store', '/cache/adapter-test'],
      sourceExts: ['js', 'svg'],
    });
  });

  test('composes a caller-provided Expo override', () => {
    const custom = join(project, 'custom-metro.cjs');
    writeFileSync(custom, `module.exports = { cacheStores: [{ _root: '/custom/store' }] };\n`);
    const result = run({ STIM_EXPO_METRO_CONFIG: custom });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).roots).toEqual(['/custom/store', '/cache/adapter-test']);
  });

  test('supports function and promise configs', () => {
    writeFileSync(
      join(project, 'metro.config.cjs'),
      `module.exports = async (defaults) => ({
         resolver: defaults.resolver,
         cacheStores: [{ _root: '/async/store' }],
       });\n`,
    );
    const result = run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      roots: ['/async/store', '/cache/adapter-test'],
      sourceExts: ['js'],
    });
  });

  test('a missing FileStore is a warning and leaves the project stores usable', () => {
    writeFileSync(
      join(project, 'metro.config.cjs'),
      `module.exports = { cacheStores: [{ _root: '/project/store' }] };\n`,
    );
    const script = `
      Promise.resolve(require(process.env.ADAPTER)).then((config) => {
        const stores = config.cacheStores({});
        console.log(JSON.stringify(stores.map((store) => store && store._root)));
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: project,
      encoding: 'utf-8',
      env: {
        ...process.env,
        ADAPTER: adapter,
        STIM_PROJECT_ROOT: project,
        STIM_METRO_STORE: '/cache/adapter-test',
      },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['/project/store']);
    expect(result.stderr).toContain('warning: Stim could not share');
    expect(result.stderr).not.toContain('stim-metro-store:');
  });

  test('the supervisor parser recognizes the adapter confirmation line', () => {
    expect(metroStoreConfirmedRoot('stim-metro-store: sharing Metro transforms through /cache/app')).toBe('/cache/app');
    expect(metroStoreConfirmedRoot('stim-metro-store: sharing Metro transforms through ')).toBe(null);
  });
});
