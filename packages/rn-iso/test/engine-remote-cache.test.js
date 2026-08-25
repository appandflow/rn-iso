// engine/remote-cache.js -- the project's OWN Expo build-cache provider, used
// as level two behind rn-iso's local cache.
//
// What is pinned here is the part that is easy to get wrong in a way nobody
// notices: WHICH key the provider is read from (the SDK 53 experiments key is
// still a fallback), WHERE the plugin is loaded from (the project, never
// rn-iso), and -- the whole reason this module exists -- that a provider which
// throws, lies about a path, or never answers degrades to a local-only run
// with a note instead of failing the command or hanging the loop.
//
// A real provider is a real module on disk in these tests (a fixture .cjs
// written into a temp project), because the thing being asserted is that
// `createRequire` from the PROJECT resolves it. A stub object could not fail
// that way.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_TIMEOUT_MS,
  EAS_PROVIDER_PACKAGE,
  LOCAL_PROVIDER_PACKAGE,
  RESOLVE_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  dynamicConfigFile,
  isProviderPlugin,
  loadPlugin,
  loadProjectProvider,
  normalizeProvider,
  providerFromConfig,
  readProjectConfig,
  resolveRemote,
  runOptionsFor,
  uploadRemote,
} from '../src/engine/remote-cache.js';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-remote-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAppJson(config) {
  writeFileSync(join(root, 'app.json'), JSON.stringify(config, null, 2));
}

// A provider module the way a project would ship one: CommonJS, exported on
// `default` (which is what a compiled TypeScript provider produces, and what
// the Expo CLI unwraps).
function writeProviderModule(file, body) {
  writeFileSync(join(root, file), body);
  return file;
}

const RECORDING_PROVIDER = (log, appPath) => `
const fs = require('fs');
const log = ${JSON.stringify(log)};
function record(entry) { fs.appendFileSync(log, JSON.stringify(entry) + '\\n'); }
module.exports.default = {
  async resolveBuildCache(props) { record({ call: 'resolveBuildCache', props }); return ${JSON.stringify(appPath)}; },
  async uploadBuildCache(props) { record({ call: 'uploadBuildCache', props }); return 'https://example.test/build'; },
};
`;

// --- pure: which key, which shape -----------------------------------------

describe('providerFromConfig', () => {
  test('reads the top-level key out of an app.json (nested under expo)', () => {
    assert.equal(providerFromConfig({ expo: { buildCacheProvider: 'eas' } }), 'eas');
  });

  test('reads the same key out of `expo config --json` output, which is already unwrapped', () => {
    assert.equal(providerFromConfig({ name: 'app', buildCacheProvider: 'eas' }), 'eas');
  });

  // SDK 53 read ONLY experiments.buildCacheProvider, and the Expo CLI still
  // falls back to it (run/ios/options/resolveOptions.ts:52). A project pinned
  // there must not read as "no provider".
  test('falls back to the SDK 53 experiments key', () => {
    const raw = providerFromConfig({ expo: { experiments: { buildCacheProvider: { plugin: './p.cjs' } } } });
    assert.deepEqual(raw, { plugin: './p.cjs' });
  });

  test('the top-level key wins when both are present, as in the CLI', () => {
    assert.equal(providerFromConfig({
      expo: { buildCacheProvider: 'eas', experiments: { buildCacheProvider: { plugin: './p.cjs' } } },
    }), 'eas');
  });

  test('no provider is null, and so is a config that is not an object', () => {
    assert.equal(providerFromConfig({ expo: { name: 'app' } }), null);
    assert.equal(providerFromConfig(null), null);
  });
});

describe('normalizeProvider', () => {
  test("'eas' maps to the package the Expo CLI bundles for it", () => {
    assert.deepEqual(normalizeProvider('eas'), { name: 'eas', reference: EAS_PROVIDER_PACKAGE, options: {} });
  });

  test('{ plugin } carries its options through', () => {
    assert.deepEqual(normalizeProvider({ plugin: '@acme/cache', options: { bucket: 'x' } }), {
      name: '@acme/cache', reference: '@acme/cache', options: { bucket: 'x' },
    });
  });

  test('nothing configured is null; a shape the CLI would throw on is invalid', () => {
    assert.equal(normalizeProvider(undefined), null);
    assert.ok(normalizeProvider({ pluginn: 'typo' }).invalid);
    assert.ok(normalizeProvider('s3').invalid);
  });
});

describe('runOptionsFor', () => {
  // Not decoration: eas-build-cache-provider reads these to decide whether to
  // ask EAS for a dev-client build.
  test('describes the debug simulator/emulator build rn-iso actually makes', () => {
    assert.deepEqual(runOptionsFor('ios'), { configuration: 'Debug' });
    assert.deepEqual(runOptionsFor('android'), { variant: 'debug' });
  });
});

describe('isProviderPlugin', () => {
  test('accepts the current pair and the deprecated one', () => {
    assert.ok(isProviderPlugin({ resolveBuildCache() {}, uploadBuildCache() {} }));
    assert.ok(isProviderPlugin({ resolveRemoteBuildCache() {}, uploadRemoteBuildCache() {} }));
  });

  test('rejects half a plugin', () => {
    assert.equal(isProviderPlugin({ resolveBuildCache() {} }), false);
    assert.equal(isProviderPlugin(null), false);
  });
});

// --- the config read -------------------------------------------------------

describe('readProjectConfig', () => {
  test('a static app.json is parsed directly, with no child process at all', () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    let ran = false;
    const read = readProjectConfig(root, { run: () => { ran = true; return '{}'; } });
    assert.equal(ran, false, 'a static config never shells out');
    assert.equal(read.source, 'app.json');
    assert.equal(providerFromConfig(read.config), 'eas');
  });

  test('no config at all is simply no config', () => {
    assert.deepEqual(readProjectConfig(root, { run: () => '{}' }), { config: null, source: null });
  });

  test('a dynamic config is evaluated by the PROJECT\'s own expo binary, bounded', () => {
    writeAppJson({ expo: { name: 'ignored' } });
    writeProviderModule('app.config.js', 'module.exports = {};');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n');

    const calls = [];
    const read = readProjectConfig(root, {
      run: (file, args, opts) => {
        calls.push({ file, args, opts });
        return JSON.stringify({ name: 'app', buildCacheProvider: { plugin: './p.cjs' } });
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, join(root, 'node_modules', '.bin', 'expo'));
    assert.deepEqual(calls[0].args, ['config', '--json', root]);
    assert.equal(calls[0].opts.timeoutMs, CONFIG_TIMEOUT_MS);
    assert.equal(read.source, 'app.config.js');
    assert.deepEqual(providerFromConfig(read.config), { plugin: './p.cjs' });
  });

  test('a dynamic config with no installed expo is unavailable, never guessed from app.json', () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    writeProviderModule('app.config.ts', 'export default {};');
    const read = readProjectConfig(root, { run: () => { throw new Error('should not run'); } });
    assert.match(read.unavailable, /app\.config\.ts is code/);
    assert.match(read.unavailable, /node_modules\/\.bin\/expo does not exist/);
  });

  test('an expo config that fails (or times out) is unavailable with the reason', () => {
    writeProviderModule('app.config.js', 'module.exports = {};');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n');
    const read = readProjectConfig(root, {
      run: () => { const e = new Error('ETIMEDOUT: expo config --json\nstack line'); throw e; },
    });
    assert.match(read.unavailable, /expo config --json` failed: ETIMEDOUT/);
    assert.ok(!read.unavailable.includes('stack line'), 'a note is one line');
  });

  test('a malformed app.json is unavailable rather than a crash', () => {
    writeFileSync(join(root, 'app.json'), '{ not json');
    assert.match(readProjectConfig(root).unavailable, /app\.json could not be parsed/);
  });
});

// --- loading the plugin ----------------------------------------------------

describe('loadPlugin', () => {
  test('resolves a relative module reference against the PROJECT, and unwraps .default', async () => {
    writeProviderModule('fake-provider.cjs', RECORDING_PROVIDER(join(root, 'calls.log'), '/tmp/x.app'));
    const plugin = await loadPlugin(root, './fake-provider.cjs');
    assert.equal(typeof plugin.resolveBuildCache, 'function');
    assert.equal(typeof plugin.uploadBuildCache, 'function');
  });

  test('a module that is not a provider is refused by name', async () => {
    writeProviderModule('not-a-provider.cjs', 'module.exports = { hello: 1 };');
    await assert.rejects(
      () => loadPlugin(root, './not-a-provider.cjs'),
      /does not export resolveBuildCache and uploadBuildCache/
    );
  });
});

describe('loadProjectProvider', () => {
  test('a bare RN project is never asked: no config read, no plugin load', async () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    let ran = false;
    const result = await loadProjectProvider(root, {
      isExpo: false,
      run: () => { ran = true; return '{}'; },
      requireFrom: () => { throw new Error('should not resolve a plugin'); },
    });
    assert.deepEqual(result, { none: true });
    assert.equal(ran, false);
  });

  test('an Expo project with no provider configured is `none`, which is not a problem', async () => {
    writeAppJson({ expo: { name: 'app' } });
    assert.deepEqual(await loadProjectProvider(root), { none: true });
  });

  test('a { plugin } provider is loaded from the project and named for the phase line', async () => {
    writeProviderModule('fake-provider.cjs', RECORDING_PROVIDER(join(root, 'calls.log'), null));
    writeAppJson({ expo: { buildCacheProvider: { plugin: './fake-provider.cjs', options: { a: 1 } } } });
    const result = await loadProjectProvider(root);
    assert.equal(result.name, './fake-provider.cjs');
    assert.deepEqual(result.provider.options, { a: 1 });
    assert.equal(typeof result.provider.plugin.resolveBuildCache, 'function');
  });

  test("'eas' without the package installed is a REASON, never an install", async () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    const result = await loadProjectProvider(root);
    assert.match(result.unavailable, new RegExp(EAS_PROVIDER_PACKAGE));
    assert.match(result.unavailable, /not installed/);
  });

  // rn-iso's own provider addresses the same directory with the same keys as
  // the local cache that just missed. Consulting it can only miss again.
  test("rn-iso's own provider package is treated as level one, not as a remote", async () => {
    writeAppJson({ expo: { buildCacheProvider: { plugin: LOCAL_PROVIDER_PACKAGE } } });
    assert.deepEqual(await loadProjectProvider(root), { none: true });
  });

  test('a provider that cannot be loaded is unavailable, with the reason', async () => {
    writeAppJson({ expo: { buildCacheProvider: { plugin: './missing.cjs' } } });
    const result = await loadProjectProvider(root);
    assert.match(result.unavailable, /could not be loaded/);
  });

  test('an invalid provider value is reported, not thrown', async () => {
    writeAppJson({ expo: { buildCacheProvider: 'my-bucket' } });
    const result = await loadProjectProvider(root);
    assert.match(result.unavailable, /not "eas" or \{ plugin/);
  });
});

// --- calling it ------------------------------------------------------------

function plugin(overrides = {}) {
  return { provider: { plugin: { resolveBuildCache: async () => null, uploadBuildCache: async () => null, ...overrides }, options: { o: 1 } } };
}

describe('resolveRemote', () => {
  test('hands the provider the Expo CLI\'s exact props, and returns the path it answers with', async () => {
    const appPath = join(root, 'Fixture.app');
    mkdirSync(appPath);
    let seen = null;
    const { provider } = plugin({
      resolveBuildCache: async (props, options) => { seen = { props, options }; return appPath; },
    });
    const result = await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'abc' });
    assert.deepEqual(result, { appPath });
    assert.deepEqual(seen.props, {
      fingerprintHash: 'abc', platform: 'ios', runOptions: { configuration: 'Debug' }, projectRoot: root,
    });
    assert.deepEqual(seen.options, { o: 1 });
  });

  test('a plugin that computes its own fingerprint hash is preferred, as in the CLI', async () => {
    const appPath = join(root, 'Fixture.app');
    mkdirSync(appPath);
    let hash = null;
    const { provider } = plugin({
      calculateFingerprintHash: async () => 'eas-side-hash',
      resolveBuildCache: async (props) => { hash = props.fingerprintHash; return appPath; },
    });
    await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'ours' });
    assert.equal(hash, 'eas-side-hash');
  });

  test('a calculateFingerprintHash that fails falls back to the fingerprint rn-iso already has', async () => {
    const appPath = join(root, 'Fixture.app');
    mkdirSync(appPath);
    let hash = null;
    const { provider } = plugin({
      calculateFingerprintHash: async () => { throw new Error('not logged in'); },
      resolveBuildCache: async (props) => { hash = props.fingerprintHash; return appPath; },
    });
    await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'ours' });
    assert.equal(hash, 'ours');
  });

  test('the deprecated resolveRemoteBuildCache is still called when it is what the plugin has', async () => {
    const appPath = join(root, 'Fixture.app');
    mkdirSync(appPath);
    const provider = {
      plugin: { resolveRemoteBuildCache: async () => appPath, uploadRemoteBuildCache: async () => null },
      options: {},
    };
    assert.deepEqual(await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a' }), { appPath });
  });

  test('a miss is null', async () => {
    const { provider } = plugin();
    assert.equal(await resolveRemote({ provider, platform: 'android', projectRoot: root, fingerprintHash: 'a' }), null);
  });

  test('a provider that throws is a note, not a failure', async () => {
    const { provider } = plugin({ resolveBuildCache: async () => { throw new Error('EAS session expired\ndetail'); } });
    const result = await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a' });
    assert.deepEqual(result, { failed: 'EAS session expired' });
  });

  test('a path the provider returned that does not exist is refused', async () => {
    const { provider } = plugin({ resolveBuildCache: async () => join(root, 'gone.app') });
    const result = await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a' });
    assert.match(result.failed, /does not exist/);
  });

  // The failure this module exists for: an agent loop must not stall on a
  // network call that will never answer.
  test('a provider that never answers times out instead of hanging the loop', async () => {
    const { provider } = plugin({ resolveBuildCache: () => new Promise(() => {}) });
    const started = Date.now();
    const result = await resolveRemote({
      provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', timeoutMs: 30,
    });
    assert.deepEqual(result, { timedOut: true });
    assert.ok(Date.now() - started < 5000, 'it returned at the bound, not at the provider');
  });

  test('no provider and no fingerprint are both plain nulls', async () => {
    assert.equal(await resolveRemote({ provider: null, platform: 'ios', fingerprintHash: 'a' }), null);
    assert.equal(await resolveRemote({ ...plugin(), platform: 'ios', fingerprintHash: null }), null);
  });
});

describe('uploadRemote', () => {
  test('hands the provider the built path with the CLI\'s props', async () => {
    let seen = null;
    const { provider } = plugin({ uploadBuildCache: async (props, options) => { seen = { props, options }; } });
    const result = await uploadRemote({
      provider, platform: 'android', projectRoot: root, fingerprintHash: 'abc', buildPath: '/b/app.apk',
    });
    assert.deepEqual(result, { uploaded: true });
    assert.deepEqual(seen.props, {
      projectRoot: root, platform: 'android', fingerprintHash: 'abc', buildPath: '/b/app.apk',
      runOptions: { variant: 'debug' },
    });
  });

  test('the deprecated uploadRemoteBuildCache is still called when it is what the plugin has', async () => {
    let called = false;
    const provider = {
      plugin: { resolveRemoteBuildCache: async () => null, uploadRemoteBuildCache: async () => { called = true; } },
      options: {},
    };
    await uploadRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', buildPath: '/b.app' });
    assert.equal(called, true);
  });

  test('a throwing upload is a note', async () => {
    const { provider } = plugin({ uploadBuildCache: async () => { throw new Error('403 forbidden'); } });
    assert.deepEqual(
      await uploadRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', buildPath: '/b.app' }),
      { failed: '403 forbidden' }
    );
  });

  test('an upload that never finishes is abandoned at the bound', async () => {
    const { provider } = plugin({ uploadBuildCache: () => new Promise(() => {}) });
    assert.deepEqual(
      await uploadRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', buildPath: '/b.app', timeoutMs: 30 }),
      { timedOut: true }
    );
  });

  test('nothing to upload is skipped without calling the provider', async () => {
    let called = false;
    const { provider } = plugin({ uploadBuildCache: async () => { called = true; } });
    assert.deepEqual(await uploadRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', buildPath: null }), { skipped: true });
    assert.equal(called, false);
  });
});

describe('the budgets', () => {
  // Constants, not settings (see the module header). Pinned so a change is a
  // deliberate one.
  test('are bounded and ordered: a resolve blocks the loop, an upload runs beside it', () => {
    assert.equal(RESOLVE_TIMEOUT_MS, 30_000);
    assert.equal(UPLOAD_TIMEOUT_MS, 60_000);
    assert.equal(CONFIG_TIMEOUT_MS, 30_000);
  });
});

describe('dynamicConfigFile', () => {
  test('finds each supported dynamic config, and nothing when there is none', () => {
    assert.equal(dynamicConfigFile(root), null);
    writeProviderModule('app.config.ts', '');
    assert.equal(dynamicConfigFile(root), 'app.config.ts');
  });
});
