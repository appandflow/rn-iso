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
  WHOAMI_TIMEOUT_MS,
  checkEasAuth,
  dynamicConfigFile,
  easAuthNote,
  isEasAuthFailureText,
  isProviderPlugin,
  loadPlugin,
  loadProjectProvider,
  normalizeProvider,
  ownerFromConfig,
  parseWhoami,
  providerFromConfig,
  resolveEasCliBin,
  resetEasAuthCache,
  readProjectConfig,
  resolveRemote,
  runOptionsFor,
  uploadDestination,
  uploadRemote,
} from '../src/engine/remote-cache.ts';

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
    assert.match(read.unavailable, /`expo` package is not resolvable/);
  });

  // The bug this pins was live on a real pnpm workspace: the app directory's
  // own node_modules holds no .bin/expo, so the ONLY check that existed here
  // ("does <root>/node_modules/.bin/expo exist?") said no on every hoisted
  // monorepo -- and the entire remote cache tier was dead there, behind a note
  // that read like a missing install. The binary is found by walking UP.
  test('a HOISTED monorepo evaluates the config with the workspace-root expo', () => {
    const app = join(root, 'apps', 'mobile');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'mobile' }));
    writeFileSync(join(app, 'app.config.ts'), 'export default {};');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n');

    const calls = [];
    const read = readProjectConfig(app, {
      run: (file, args) => {
        calls.push({ file, args });
        return JSON.stringify({ name: 'app', buildCacheProvider: 'eas' });
      },
    });
    assert.equal(read.unavailable, undefined, 'a hoisted install is an installed install');
    assert.equal(calls[0].file, join(root, 'node_modules', '.bin', 'expo'));
    assert.deepEqual(calls[0].args, ['config', '--json', app]);
    assert.equal(providerFromConfig(read.config), 'eas');
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

// --- the provider's stdout is not ours to give away ------------------------
//
// The provider plugin runs IN-PROCESS: `resolveBuildCache` is a function call,
// not a subprocess, so its `console.log` writes to the same fd 1 that carries
// `ios --json`'s single payload line. eas-build-cache-provider prints
// "Searching builds with matching fingerprint on EAS servers" on every lookup
// and "Uploading build to EAS" on every store, and both landed INTERLEAVED
// with the JSON payload -- one unparseable stdout on every cache miss, on both
// platforms. So while a provider function runs, rn-iso catches everything it
// writes to stdout and puts it where progress belongs.

// Replaces process.stdout.write and process.stderr.write with recorders BEFORE
// the call, so what is asserted is what would have reached the terminal: the
// capture installs itself over these, and a leak shows up as a line in `out`.
function tapStreams(fn) {
  const out = [];
  const err = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const originalLog = console.log;
  process.stdout.write = (chunk, enc, cb) => {
    out.push(String(chunk));
    if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
    return true;
  };
  process.stderr.write = (chunk, enc, cb) => {
    err.push(String(chunk));
    if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
    return true;
  };
  const restore = () => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    console.log = originalLog;
  };
  return Promise.resolve()
    .then(() => fn({ out, err }))
    .then((value) => { restore(); return { value, out, err }; }, (error) => { restore(); throw error; });
}

function records() {
  const written = [];
  return { written, writer: { write: (record) => { written.push(record); return true; } } };
}

describe('provider output containment', () => {
  test('a provider that logs never reaches stdout: it goes to stderr and into the build log', async () => {
    const appPath = join(root, 'Fixture.app');
    mkdirSync(appPath);
    const log = records();
    const { provider } = plugin({
      resolveBuildCache: async () => {
        console.log('Searching builds with matching fingerprint on EAS servers');
        process.stdout.write('half a line');
        process.stdout.write(' and the rest\n');
        return appPath;
      },
    });
    const { value, out, err } = await tapStreams(() => resolveRemote({
      provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', logWriter: log.writer,
    }));
    assert.deepEqual(value, { appPath }, 'the hit still comes back');
    assert.deepEqual(out, [], 'nothing at all on stdout');
    assert.match(err.join(''), /Searching builds with matching fingerprint/);
    assert.match(err.join(''), /half a line and the rest/);
    assert.deepEqual(
      log.written.map(r => ({ src: r.src, level: r.level, event: r.event })),
      [
        { src: 'build', level: 'debug', event: 'provider' },
        { src: 'build', level: 'debug', event: 'provider' },
      ]
    );
    assert.equal(log.written[1].msg, 'half a line and the rest', 'chunks are joined into lines');
  });

  test('stdout is restored when the provider returns, throws, or is abandoned', async () => {
    const LEAK = 'provider-line-that-must-never-reach-stdout';
    const cases = [
      plugin({ resolveBuildCache: async () => { console.log(LEAK); return null; } }),
      plugin({ resolveBuildCache: async () => { console.log(LEAK); throw new Error('boom'); } }),
      plugin({ resolveBuildCache: () => { console.log(LEAK); return new Promise(() => {}); } }),
    ];
    for (const { provider } of cases) {
      const { out } = await tapStreams(async () => {
        await resolveRemote({
          provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', timeoutMs: 30,
          logWriter: records().writer,
        });
        // The command's own payload, written the moment the call is over.
        console.log('{"payload":true}');
      });
      // The tap sees every stdout write in the process, and node --test's own
      // reporter is one of them, so this is about the two lines that matter.
      assert.ok(out.join('').includes('{"payload":true}'), 'the payload reaches the real stdout');
      assert.ok(!out.join('').includes(LEAK), 'and the provider line never did');
    }
  });

  test('an abandoned provider that prints after its budget still cannot reach stdout', async () => {
    let release;
    const done = new Promise((resolve) => { release = resolve; });
    const { provider } = plugin({
      resolveBuildCache: async () => {
        await done;
        console.log('late line from a call nothing is waiting for');
        return null;
      },
    });
    const { out, err } = await tapStreams(async () => {
      const result = await resolveRemote({
        provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', timeoutMs: 20,
        logWriter: records().writer,
      });
      assert.deepEqual(result, { timedOut: true });
      console.log('{"payload":true}');
      release();
      await done;
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.ok(out.join('').includes('{"payload":true}'), 'the payload reaches the real stdout');
    assert.ok(!out.join('').includes('late line from a call'), 'the abandoned call still cannot');
    assert.match(err.join(''), /late line from a call nothing is waiting for/);
  });

  test('nested provider calls restore in order, and the inner one does not free stdout early', async () => {
    const inner = plugin({ resolveBuildCache: async () => { console.log('inner'); return null; } }).provider;
    const { provider } = plugin({
      resolveBuildCache: async () => {
        await resolveRemote({
          provider: inner, platform: 'ios', projectRoot: root, fingerprintHash: 'a',
          logWriter: records().writer,
        });
        console.log('outer, after the inner call returned');
        return null;
      },
    });
    const { out, err } = await tapStreams(async () => {
      await resolveRemote({
        provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', logWriter: records().writer,
      });
      console.log('{"payload":true}');
    });
    assert.ok(out.join('').includes('{"payload":true}'));
    assert.ok(!out.join('').includes('outer, after the inner call returned'));
    assert.match(err.join(''), /inner/);
    assert.match(err.join(''), /outer, after the inner call returned/);
  });

  test('an upload names where it is going when the provider printed it', async () => {
    const notes = [];
    const { provider } = plugin({
      uploadBuildCache: async () => {
        console.log('Uploading build to https://expo.dev/accounts/acme/projects/app/builds/abc');
      },
    });
    const result = await tapStreams(() => uploadRemote({
      provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', buildPath: '/b.app',
      logWriter: records().writer, note: (line) => notes.push(line),
    }));
    assert.deepEqual(result.value, {
      uploaded: true,
      destination: 'https://expo.dev/accounts/acme/projects/app/builds/abc',
    });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^cache {7}uploading to https:\/\/expo\.dev\/accounts\/acme/);
  });

  test('an upload that names no destination says nothing extra', async () => {
    const notes = [];
    const { provider } = plugin({ uploadBuildCache: async () => { console.log('Uploading build to EAS'); } });
    const result = await tapStreams(() => uploadRemote({
      provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', buildPath: '/b.app',
      logWriter: records().writer, note: (line) => notes.push(line),
    }));
    assert.deepEqual(result.value, { uploaded: true }, 'no destination key when there is no destination');
    assert.deepEqual(notes, []);
  });
});

describe('uploadDestination', () => {
  test('prefers a URL, falls back to an owner/slug, and is null otherwise', () => {
    assert.equal(
      uploadDestination(['Uploading build to https://expo.dev/accounts/acme/projects/app (2.1 MB)']),
      'https://expo.dev/accounts/acme/projects/app'
    );
    assert.equal(uploadDestination(['Uploading build to acme/my-app']), 'acme/my-app');
    assert.equal(uploadDestination(['Uploading build to @acme/my-app...']), '@acme/my-app');
    assert.equal(uploadDestination(['Uploading build to EAS']), null);
    assert.equal(uploadDestination([]), null);
    assert.equal(uploadDestination(null), null);
  });

  test('reads through the colour codes a provider prints', () => {
    assert.equal(
      uploadDestination(['\u001b[2mUploading build to\u001b[22m https://expo.dev/x/y']),
      'https://expo.dev/x/y'
    );
  });
});

// --- EAS authentication ------------------------------------------------------
//
// The outputs below are VERBATIM from `eas whoami` on this machine
// (eas-cli 18.0.3, 2026-08-25), captured both ways: logged in, and logged out
// by pointing HOME at an empty directory rather than by logging anybody out.
//
//   logged in   exit 0, stdout:  "janic\n\nAccounts:\n<bullet> janic (Role: Owner)\n
//                                 <bullet> fin-tech (Role: Viewer)\n<bullet> th3rd-wave (Role: Owner)\n"
//                (the bullet is U+2022; it is written as an escape below,
//                 because these files are ASCII)
//               stderr held only the "eas-cli@22.4.0 is now available" upgrade notice.
//   logged out  exit 1, stdout:  "Not logged in\n", stderr empty.
describe('parseWhoami', () => {
  const LOGGED_IN = 'janic\n\nAccounts:\n\u2022 janic (Role: Owner)\n'
    + '\u2022 fin-tech (Role: Viewer)\n\u2022 th3rd-wave (Role: Owner)\n';

  test('reads the actor and every account out of a logged-in whoami', () => {
    const parsed = parseWhoami({ stdout: LOGGED_IN, exitCode: 0 });
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.account, 'janic');
    assert.deepEqual(parsed.accounts, ['janic', 'fin-tech', 'th3rd-wave']);
    assert.equal(parsed.viaToken, false);
  });

  // account/view.js only prints the Accounts block when the actor belongs to an
  // account that is NOT its personal one, so a single-account user's whole
  // output is the username -- which IS the one account they have.
  test('a user with only a personal account still yields that account', () => {
    const parsed = parseWhoami({ stdout: 'janic\n', exitCode: 0 });
    assert.deepEqual(parsed.accounts, ['janic']);
  });

  test('the EXPO_TOKEN suffix is stripped off the actor and recorded', () => {
    const parsed = parseWhoami({ stdout: 'janic (authenticated using EXPO_TOKEN)\n', exitCode: 0 });
    assert.equal(parsed.account, 'janic');
    assert.equal(parsed.viaToken, true);
  });

  // getActorDisplayName prints "robot" / "Name (robot)" for a robot actor, and
  // a robot has no username at all -- so the display name is not an account
  // name, and enumeration is UNKNOWN rather than "one account called robot".
  test('a robot actor with no Accounts block leaves the accounts unknown', () => {
    const parsed = parseWhoami({ stdout: 'CI (robot) (authenticated using EXPO_TOKEN)\n', exitCode: 0 });
    assert.equal(parsed.loggedIn, true);
    assert.equal(parsed.accounts, null, 'a display name is not an account name');
  });

  test('"Not logged in" plus a non-zero exit is the definitive logged-out answer', () => {
    const parsed = parseWhoami({ stdout: 'Not logged in\n', exitCode: 1 });
    assert.equal(parsed.loggedOut, true);
  });

  // The whole point of the distinction: whoami hits the network when a session
  // exists, so a failure that is not "Not logged in" may be a plane, a VPN or a
  // DNS hiccup, and none of those mean the user has to log in.
  test('any other failure is unknown, never logged out', () => {
    const parsed = parseWhoami({
      stdout: '',
      stderr: 'request to https://api.expo.dev/graphql failed, reason: getaddrinfo ENOTFOUND api.expo.dev',
      exitCode: 1,
    });
    assert.equal(parsed.loggedOut, undefined);
    assert.match(parsed.unknown, /ENOTFOUND/);
  });

  test('a clean exit that printed nothing is unknown too', () => {
    assert.ok(parseWhoami({ stdout: '   \n', exitCode: 0 }).unknown);
  });
});

describe('ownerFromConfig', () => {
  test('reads expo.owner out of either config shape', () => {
    assert.equal(ownerFromConfig({ expo: { owner: 'th3rd-wave' } }), 'th3rd-wave');
    assert.equal(ownerFromConfig({ owner: 'th3rd-wave' }), 'th3rd-wave');
    assert.equal(ownerFromConfig({ expo: {} }), null);
    assert.equal(ownerFromConfig(null), null);
  });
});

describe('isEasAuthFailureText', () => {
  test('recognises what eas-cli says when a session is missing or rejected', () => {
    assert.equal(isEasAuthFailureText('Not logged in'), true);
    assert.equal(isEasAuthFailureText('Either log in with eas login or set the EXPO_TOKEN environment variable'), true);
    assert.equal(isEasAuthFailureText('GraphQL request failed: Unauthorized'), true);
    assert.equal(isEasAuthFailureText('Entity not authorized: Account'), true);
    assert.equal(isEasAuthFailureText('ETIMEDOUT'), false);
    assert.equal(isEasAuthFailureText(''), false);
    assert.equal(isEasAuthFailureText(null), false);
  });
});

describe('checkEasAuth', () => {
  beforeEach(() => resetEasAuthCache());
  afterEach(() => resetEasAuthCache());

  const whoami = (stdout, exitCode = 0, stderr = '') => () => {
    if (exitCode === 0) return stdout;
    const err = new Error('Command failed');
    err.status = exitCode;
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  };

  test('a logged-in session whose accounts include the owner is ok', () => {
    const status = checkEasAuth({
      projectRoot: root,
      owner: 'th3rd-wave',
      resolveBin: () => ({ file: '/bin/eas', source: 'project' }),
      run: whoami('janic\n\nAccounts:\n\u2022 janic (Role: Owner)\n\u2022 th3rd-wave (Role: Owner)\n'),
    });
    assert.equal(status.ok, true);
    assert.equal(status.account, 'janic');
  });

  test('no eas binary anywhere is its own code, with an install remedy', () => {
    const status = checkEasAuth({ projectRoot: root, resolveBin: () => null, run: whoami('') });
    assert.equal(status.code, 'no-cli');
    assert.match(status.remedy, /eas-cli/);
  });

  test('a logged-out session is a definitive failure naming both ways back in', () => {
    const status = checkEasAuth({
      projectRoot: root,
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: whoami('Not logged in\n', 1),
    });
    assert.equal(status.code, 'logged-out');
    assert.match(status.remedy, /eas login/);
    assert.match(status.remedy, /EXPO_TOKEN/);
  });

  test('an owner no account covers is a wrong-account failure naming both', () => {
    const status = checkEasAuth({
      projectRoot: root,
      owner: 'th3rd-wave',
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: whoami('janic\n'),
    });
    assert.equal(status.code, 'wrong-account');
    assert.equal(status.account, 'janic');
    assert.equal(status.owner, 'th3rd-wave');
  });

  // Enumeration is only as good as what whoami prints, and for a robot it
  // prints a display name that is not an account. Guessing there would fail a
  // build that was configured perfectly well.
  test('an owner is never contradicted by an account list that could not be read', () => {
    const status = checkEasAuth({
      projectRoot: root,
      owner: 'th3rd-wave',
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: whoami('CI (robot) (authenticated using EXPO_TOKEN)\n'),
    });
    assert.equal(status.ok, true);
  });

  test('a timeout is unknown, not an auth failure -- offline must not read as logged out', () => {
    const status = checkEasAuth({
      projectRoot: root,
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: () => {
        const err = new Error('Command failed');
        err.code = 'ETIMEDOUT';
        err.killed = true;
        throw err;
      },
    });
    assert.equal(status.failed, undefined);
    assert.match(status.unknown, /timed out|ETIMEDOUT/);
  });

  test('whoami runs ONCE per command run, however many times it is asked', () => {
    let runs = 0;
    const args = {
      projectRoot: root,
      owner: 'janic',
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: () => { runs += 1; return 'janic\n'; },
    };
    checkEasAuth(args);
    checkEasAuth(args);
    checkEasAuth(args);
    assert.equal(runs, 1);
  });

  test('it is bounded, and it asks the binary it resolved', () => {
    const seen = [];
    checkEasAuth({
      projectRoot: root,
      resolveBin: () => ({ file: '/p/node_modules/.bin/eas', source: 'project' }),
      run: (file, args, opts) => { seen.push({ file, args, opts }); return 'janic\n'; },
    });
    assert.equal(seen[0].file, '/p/node_modules/.bin/eas');
    assert.deepEqual(seen[0].args, ['whoami']);
    assert.equal(seen[0].opts.timeoutMs, WHOAMI_TIMEOUT_MS);
  });
});

describe('resolveEasCliBin', () => {
  // Same hoisting bug as the expo binary, and the same fix: an app directory in
  // a pnpm/yarn workspace has an EMPTY node_modules of its own, and the eas
  // shim is at the workspace root. Joining <root>/node_modules/.bin would find
  // nothing and report a CLI that is installed as missing.
  test('finds a hoisted eas shim by walking up, never by joining', () => {
    const app = join(root, 'apps', 'mobile');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'mobile' }));
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'eas'), '#!/bin/sh\n');

    const found = resolveEasCliBin(app, { lookupPath: () => { throw new Error('PATH must not be consulted'); } });
    assert.equal(found.file, join(root, 'node_modules', '.bin', 'eas'));
    assert.equal(found.source, 'project');
  });

  test('falls back to `eas` on PATH, which is where a session usually lives', () => {
    const found = resolveEasCliBin(root, { lookupPath: () => '/opt/homebrew/bin/eas\n' });
    assert.deepEqual(found, { file: '/opt/homebrew/bin/eas', source: 'path' });
  });

  test('nothing anywhere is null, which is a finding rather than an npx', () => {
    assert.equal(resolveEasCliBin(root, { lookupPath: () => null }), null);
  });
});

describe('easAuthNote', () => {
  test('the logged-out note names the two remedies and what the build will do', () => {
    const note = easAuthNote({ code: 'logged-out' });
    assert.match(note, /eas is not authenticated/);
    assert.match(note, /eas login/);
    assert.match(note, /EXPO_TOKEN/);
    assert.match(note, /local cache only/);
  });

  test('the wrong-account note names both accounts and says the run continues', () => {
    const note = easAuthNote({ code: 'wrong-account', account: 'janic', owner: 'th3rd-wave' });
    assert.match(note, /janic/);
    assert.match(note, /th3rd-wave/);
    assert.match(note, /anyway/);
  });

  // The upload is collected AFTER the build and the launch, so "building with
  // the local cache only" would be describing something that already happened.
  test('the same failure at upload time says what it cost instead', () => {
    const note = easAuthNote({ code: 'logged-out', reason: '403', phase: 'upload' });
    assert.match(note, /stayed in the local cache/);
    assert.ok(!/building with/.test(note));
  });

  test('anything else has no note of its own', () => {
    assert.equal(easAuthNote({ code: 'unknown' }), null);
    assert.equal(easAuthNote(null), null);
  });
});

describe('loadProjectProvider owner', () => {
  test('carries the project owner alongside the provider, for the auth check', async () => {
    writeProviderModule('owned-provider.cjs', RECORDING_PROVIDER(join(root, 'calls.log'), null));
    writeAppJson({ expo: { owner: 'th3rd-wave', buildCacheProvider: { plugin: './owned-provider.cjs' } } });
    const loaded = await loadProjectProvider(root);
    assert.equal(loaded.owner, 'th3rd-wave');
  });
});
