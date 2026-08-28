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
  type ProviderPlugin,
} from '../engine/remote-cache.ts';
import { makeError, makeWriter } from './_factories.ts';
import assert from 'node:assert';
import type { NdjsonRecord } from '../ndjson.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rn-iso-remote-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAppJson(config: unknown) {
  writeFileSync(join(root, 'app.json'), JSON.stringify(config, null, 2));
}

// A provider module the way a project would ship one: CommonJS, exported on
// `default` (which is what a compiled TypeScript provider produces, and what
// the Expo CLI unwraps).
function writeProviderModule(file: string, body: string) {
  writeFileSync(join(root, file), body);
  return file;
}

const RECORDING_PROVIDER = (log: string, appPath: string | null) => `
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
    expect(providerFromConfig({ expo: { buildCacheProvider: 'eas' } })).toBe('eas');
  });

  test('reads the same key out of `expo config --json` output, which is already unwrapped', () => {
    expect(providerFromConfig({ name: 'app', buildCacheProvider: 'eas' })).toBe('eas');
  });

  // SDK 53 read ONLY experiments.buildCacheProvider, and the Expo CLI still
  // falls back to it (run/ios/options/resolveOptions.ts:52). A project pinned
  // there must not read as "no provider".
  test('falls back to the SDK 53 experiments key', () => {
    const raw = providerFromConfig({ expo: { experiments: { buildCacheProvider: { plugin: './p.cjs' } } } });
    expect(raw).toEqual({ plugin: './p.cjs' });
  });

  test('the top-level key wins when both are present, as in the CLI', () => {
    expect(
      providerFromConfig({
        expo: { buildCacheProvider: 'eas', experiments: { buildCacheProvider: { plugin: './p.cjs' } } },
      }),
    ).toBe('eas');
  });

  test('no provider is null, and so is a config that is not an object', () => {
    expect(providerFromConfig({ expo: { name: 'app' } })).toBe(null);
    expect(providerFromConfig(null)).toBe(null);
  });
});

describe('normalizeProvider', () => {
  test("'eas' maps to the package the Expo CLI bundles for it", () => {
    expect(normalizeProvider('eas')).toEqual({ name: 'eas', reference: EAS_PROVIDER_PACKAGE, options: {} });
  });

  test('{ plugin } carries its options through', () => {
    expect(normalizeProvider({ plugin: '@acme/cache', options: { bucket: 'x' } })).toEqual({
      name: '@acme/cache',
      reference: '@acme/cache',
      options: { bucket: 'x' },
    });
  });

  test('nothing configured is null; a shape the CLI would throw on is invalid', () => {
    expect(normalizeProvider(undefined)).toBe(null);
    const typo = normalizeProvider({ pluginn: 'typo' });
    assert(typo);
    expect(typo.invalid).toBeTruthy();
    const bareString = normalizeProvider('s3');
    assert(bareString);
    expect(bareString.invalid).toBeTruthy();
  });
});

describe('runOptionsFor', () => {
  // Not decoration: eas-build-cache-provider reads these to decide whether to
  // ask EAS for a dev-client build.
  test('describes the debug simulator/emulator build rn-iso actually makes', () => {
    expect(runOptionsFor('ios')).toEqual({ configuration: 'Debug' });
    expect(runOptionsFor('android')).toEqual({ variant: 'debug' });
  });
});

describe('isProviderPlugin', () => {
  test('accepts the current pair and the deprecated one', () => {
    expect(isProviderPlugin({ resolveBuildCache() {}, uploadBuildCache() {} })).toBeTruthy();
    expect(isProviderPlugin({ resolveRemoteBuildCache() {}, uploadRemoteBuildCache() {} })).toBeTruthy();
  });

  test('rejects half a plugin', () => {
    expect(isProviderPlugin({ resolveBuildCache() {} })).toBe(false);
    expect(isProviderPlugin(null)).toBe(false);
  });
});

// --- the config read -------------------------------------------------------

describe('readProjectConfig', () => {
  test('a static app.json is parsed directly, with no child process at all', () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    let ran = false;
    const read = readProjectConfig(root, {
      run: () => {
        ran = true;
        return '{}';
      },
    });
    expect(ran).toBe(false);
    expect(read.source).toBe('app.json');
    expect(providerFromConfig(read.config)).toBe('eas');
  });

  test('no config at all is simply no config', () => {
    expect(readProjectConfig(root, { run: () => '{}' })).toEqual({ config: null, source: null });
  });

  test("a dynamic config is evaluated by the PROJECT's own expo binary, bounded", () => {
    writeAppJson({ expo: { name: 'ignored' } });
    writeProviderModule('app.config.js', 'module.exports = {};');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n');

    const calls: { file: string; args: string[]; opts?: { timeoutMs?: number } }[] = [];
    const read = readProjectConfig(root, {
      run: (file, args, opts) => {
        calls.push({ file, args, opts });
        return JSON.stringify({ name: 'app', buildCacheProvider: { plugin: './p.cjs' } });
      },
    });
    expect(calls.length).toBe(1);
    const call = calls[0];
    assert(call);
    expect(call.file).toBe(join(root, 'node_modules', '.bin', 'expo'));
    expect(call.args).toEqual(['config', '--json', root]);
    expect(call.opts?.timeoutMs).toBe(CONFIG_TIMEOUT_MS);
    expect(read.source).toBe('app.config.js');
    expect(providerFromConfig(read.config)).toEqual({ plugin: './p.cjs' });
  });

  test('a dynamic config with no installed expo is unavailable, never guessed from app.json', () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    writeProviderModule('app.config.ts', 'export default {};');
    const read = readProjectConfig(root, {
      run: () => {
        throw new Error('should not run');
      },
    });
    expect(read.unavailable).toMatch(/app\.config\.ts is code/);
    expect(read.unavailable).toMatch(/`expo` package is not resolvable/);
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

    const calls: { file: string; args: string[] }[] = [];
    const read = readProjectConfig(app, {
      run: (file, args) => {
        calls.push({ file, args });
        return JSON.stringify({ name: 'app', buildCacheProvider: 'eas' });
      },
    });
    expect(read.unavailable).toBe(undefined);
    const call = calls[0];
    assert(call);
    expect(call.file).toBe(join(root, 'node_modules', '.bin', 'expo'));
    expect(call.args).toEqual(['config', '--json', app]);
    expect(providerFromConfig(read.config)).toBe('eas');
  });

  test('an expo config that fails (or times out) is unavailable with the reason', () => {
    writeProviderModule('app.config.js', 'module.exports = {};');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n');
    const read = readProjectConfig(root, {
      run: () => {
        const e = new Error('ETIMEDOUT: expo config --json\nstack line');
        throw e;
      },
    });
    assert(read.unavailable);
    expect(read.unavailable).toMatch(/expo config --json` failed: ETIMEDOUT/);
    expect(!read.unavailable.includes('stack line')).toBeTruthy();
  });

  test('a malformed app.json is unavailable rather than a crash', () => {
    writeFileSync(join(root, 'app.json'), '{ not json');
    expect(readProjectConfig(root).unavailable).toMatch(/app\.json could not be parsed/);
  });
});

// --- loading the plugin ----------------------------------------------------

describe('loadPlugin', () => {
  test('resolves a relative module reference against the PROJECT, and unwraps .default', async () => {
    writeProviderModule('fake-provider.cjs', RECORDING_PROVIDER(join(root, 'calls.log'), '/tmp/x.app'));
    const loadedPlugin = await loadPlugin(root, './fake-provider.cjs');
    expect(typeof loadedPlugin.resolveBuildCache).toBe('function');
    expect(typeof loadedPlugin.uploadBuildCache).toBe('function');
  });

  test('a module that is not a provider is refused by name', async () => {
    writeProviderModule('not-a-provider.cjs', 'module.exports = { hello: 1 };');
    await expect(() => loadPlugin(root, './not-a-provider.cjs')).rejects.toThrow(
      /does not export resolveBuildCache and uploadBuildCache/,
    );
  });
});

describe('loadProjectProvider', () => {
  test('a bare RN project is never asked: no config read, no plugin load', async () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    let ran = false;
    const result = await loadProjectProvider(root, {
      isExpo: false,
      run: () => {
        ran = true;
        return '{}';
      },
      requireFrom: () => {
        throw new Error('should not resolve a plugin');
      },
    });
    expect(result).toEqual({ none: true });
    expect(ran).toBe(false);
  });

  test('an Expo project with no provider configured is `none`, which is not a problem', async () => {
    writeAppJson({ expo: { name: 'app' } });
    expect(await loadProjectProvider(root)).toEqual({ none: true });
  });

  test('a { plugin } provider is loaded from the project and named for the phase line', async () => {
    writeProviderModule('fake-provider.cjs', RECORDING_PROVIDER(join(root, 'calls.log'), null));
    writeAppJson({ expo: { buildCacheProvider: { plugin: './fake-provider.cjs', options: { a: 1 } } } });
    const result = await loadProjectProvider(root);
    expect(result.name).toBe('./fake-provider.cjs');
    assert(result.provider);
    expect(result.provider.options).toEqual({ a: 1 });
    expect(typeof result.provider.plugin.resolveBuildCache).toBe('function');
  });

  test("'eas' without the package installed is a REASON, never an install", async () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    const result = await loadProjectProvider(root);
    expect(result.unavailable).toMatch(new RegExp(EAS_PROVIDER_PACKAGE));
    expect(result.unavailable).toMatch(/not installed/);
  });

  // rn-iso's own provider addresses the same directory with the same keys as
  // the local cache that just missed. Consulting it can only miss again.
  test("rn-iso's own provider package is treated as level one, not as a remote", async () => {
    writeAppJson({ expo: { buildCacheProvider: { plugin: LOCAL_PROVIDER_PACKAGE } } });
    expect(await loadProjectProvider(root)).toEqual({ none: true });
  });

  test('a provider that cannot be loaded is unavailable, with the reason', async () => {
    writeAppJson({ expo: { buildCacheProvider: { plugin: './missing.cjs' } } });
    const result = await loadProjectProvider(root);
    expect(result.unavailable).toMatch(/could not be loaded/);
  });

  test('an invalid provider value is reported, not thrown', async () => {
    writeAppJson({ expo: { buildCacheProvider: 'my-bucket' } });
    const result = await loadProjectProvider(root);
    expect(result.unavailable).toMatch(/not "eas" or \{ plugin/);
  });
});

// --- calling it ------------------------------------------------------------

function plugin(overrides: Partial<ProviderPlugin> = {}) {
  return {
    provider: {
      plugin: { resolveBuildCache: async () => null, uploadBuildCache: async () => null, ...overrides },
      options: { o: 1 },
    },
  };
}

describe('resolveRemote', () => {
  test("hands the provider the Expo CLI's exact props, and returns the path it answers with", async () => {
    const appPath = join(root, 'Fixture.app');
    mkdirSync(appPath);
    let seen: { props: unknown; options: unknown } | undefined;
    const { provider } = plugin({
      resolveBuildCache: async (props, options) => {
        seen = { props, options };
        return appPath;
      },
    });
    const result = await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'abc' });
    expect(result).toEqual({ appPath });
    assert(seen);
    expect(seen.props).toEqual({
      fingerprintHash: 'abc',
      platform: 'ios',
      runOptions: { configuration: 'Debug' },
      projectRoot: root,
    });
    expect(seen.options).toEqual({ o: 1 });
  });

  test('a plugin that computes its own fingerprint hash is preferred, as in the CLI', async () => {
    const appPath = join(root, 'Fixture.app');
    mkdirSync(appPath);
    let hash = null;
    const { provider } = plugin({
      calculateFingerprintHash: async () => 'eas-side-hash',
      resolveBuildCache: async (props) => {
        hash = (props as { fingerprintHash?: unknown }).fingerprintHash;
        return appPath;
      },
    });
    await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'ours' });
    expect(hash).toBe('eas-side-hash');
  });

  test('a calculateFingerprintHash that fails falls back to the fingerprint rn-iso already has', async () => {
    const appPath = join(root, 'Fixture.app');
    mkdirSync(appPath);
    let hash = null;
    const { provider } = plugin({
      calculateFingerprintHash: async () => {
        throw new Error('not logged in');
      },
      resolveBuildCache: async (props) => {
        hash = (props as { fingerprintHash?: unknown }).fingerprintHash;
        return appPath;
      },
    });
    await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'ours' });
    expect(hash).toBe('ours');
  });

  test('the deprecated resolveRemoteBuildCache is still called when it is what the plugin has', async () => {
    const appPath = join(root, 'Fixture.app');
    mkdirSync(appPath);
    const provider = {
      plugin: { resolveRemoteBuildCache: async () => appPath, uploadRemoteBuildCache: async () => null },
      options: {},
    };
    expect(await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a' })).toEqual({
      appPath,
    });
  });

  test('a miss is null', async () => {
    const { provider } = plugin();
    expect(await resolveRemote({ provider, platform: 'android', projectRoot: root, fingerprintHash: 'a' })).toBe(null);
  });

  test('a provider that throws is a note, not a failure', async () => {
    const { provider } = plugin({
      resolveBuildCache: async () => {
        throw new Error('EAS session expired\ndetail');
      },
    });
    const result = await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a' });
    expect(result).toEqual({ failed: 'EAS session expired' });
  });

  test('a path the provider returned that does not exist is refused', async () => {
    const { provider } = plugin({ resolveBuildCache: async () => join(root, 'gone.app') });
    const result = await resolveRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a' });
    assert(result);
    expect(result.failed).toMatch(/does not exist/);
  });

  // The failure this module exists for: an agent loop must not stall on a
  // network call that will never answer.
  test('a provider that never answers times out instead of hanging the loop', async () => {
    const { provider } = plugin({ resolveBuildCache: () => new Promise(() => {}) });
    const started = Date.now();
    const result = await resolveRemote({
      provider,
      platform: 'ios',
      projectRoot: root,
      fingerprintHash: 'a',
      timeoutMs: 30,
    });
    expect(result).toEqual({ timedOut: true });
    expect(Date.now() - started < 5000).toBeTruthy();
  });

  test('no provider and no fingerprint are both plain nulls', async () => {
    expect(await resolveRemote({ provider: null, platform: 'ios', fingerprintHash: 'a' })).toBe(null);
    expect(await resolveRemote({ ...plugin(), platform: 'ios', fingerprintHash: null })).toBe(null);
  });
});

describe('uploadRemote', () => {
  test("hands the provider the built path with the CLI's props", async () => {
    let seen: { props: unknown; options: unknown } | undefined;
    const { provider } = plugin({
      uploadBuildCache: async (props, options) => {
        seen = { props, options };
      },
    });
    const result = await uploadRemote({
      provider,
      platform: 'android',
      projectRoot: root,
      fingerprintHash: 'abc',
      buildPath: '/b/app.apk',
    });
    expect(result).toEqual({ uploaded: true });
    assert(seen);
    expect(seen.props).toEqual({
      projectRoot: root,
      platform: 'android',
      fingerprintHash: 'abc',
      buildPath: '/b/app.apk',
      runOptions: { variant: 'debug' },
    });
  });

  test('the deprecated uploadRemoteBuildCache is still called when it is what the plugin has', async () => {
    let called = false;
    const provider = {
      plugin: {
        resolveRemoteBuildCache: async () => null,
        uploadRemoteBuildCache: async () => {
          called = true;
        },
      },
      options: {},
    };
    await uploadRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', buildPath: '/b.app' });
    expect(called).toBe(true);
  });

  test('a throwing upload is a note', async () => {
    const { provider } = plugin({
      uploadBuildCache: async () => {
        throw new Error('403 forbidden');
      },
    });
    expect(
      await uploadRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', buildPath: '/b.app' }),
    ).toEqual({ failed: '403 forbidden' });
  });

  test('an upload that never finishes is abandoned at the bound', async () => {
    const { provider } = plugin({ uploadBuildCache: () => new Promise(() => {}) });
    expect(
      await uploadRemote({
        provider,
        platform: 'ios',
        projectRoot: root,
        fingerprintHash: 'a',
        buildPath: '/b.app',
        timeoutMs: 30,
      }),
    ).toEqual({ timedOut: true });
  });

  test('nothing to upload is skipped without calling the provider', async () => {
    let called = false;
    const { provider } = plugin({
      uploadBuildCache: async () => {
        called = true;
      },
    });
    expect(
      await uploadRemote({ provider, platform: 'ios', projectRoot: root, fingerprintHash: 'a', buildPath: null }),
    ).toEqual({ skipped: true });
    expect(called).toBe(false);
  });
});

describe('the budgets', () => {
  // Constants, not settings (see the module header). Pinned so a change is a
  // deliberate one.
  test('are bounded and ordered: a resolve blocks the loop, an upload runs beside it', () => {
    expect(RESOLVE_TIMEOUT_MS).toBe(30_000);
    expect(UPLOAD_TIMEOUT_MS).toBe(60_000);
    expect(CONFIG_TIMEOUT_MS).toBe(30_000);
  });
});

describe('dynamicConfigFile', () => {
  test('finds each supported dynamic config, and nothing when there is none', () => {
    expect(dynamicConfigFile(root)).toBe(null);
    writeProviderModule('app.config.ts', '');
    expect(dynamicConfigFile(root)).toBe('app.config.ts');
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
function tapStreams(fn: (streams: { out: string[]; err: string[] }) => unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const originalLog = console.log;
  process.stdout.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    out.push(String(chunk));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    err.push(String(chunk));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  }) as typeof process.stderr.write;
  const restore = () => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    console.log = originalLog;
  };
  return Promise.resolve()
    .then(() => fn({ out, err }))
    .then(
      (value) => {
        restore();
        return { value, out, err };
      },
      (error) => {
        restore();
        throw error;
      },
    );
}

function records() {
  // makeWriter's write receives `record: unknown` (the NdjsonWriter contract),
  // and the captured frames are read structurally below (r.src / written[1].msg);
  // `any[]` keeps those reads working without a per-read cast.
  const written: NdjsonRecord[] = [];
  return {
    written,
    writer: makeWriter({
      write: (record) => {
        written.push(record as NdjsonRecord);
        return true;
      },
    }),
  };
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
    const { value, out, err } = await tapStreams(() =>
      resolveRemote({
        provider,
        platform: 'ios',
        projectRoot: root,
        fingerprintHash: 'a',
        logWriter: log.writer,
      }),
    );
    expect(value).toEqual({ appPath });
    expect(out).toEqual([]);
    expect(err.join('')).toMatch(/Searching builds with matching fingerprint/);
    expect(err.join('')).toMatch(/half a line and the rest/);
    expect(log.written.map((r) => ({ src: r.src, level: r.level, event: r.event }))).toEqual([
      { src: 'build', level: 'debug', event: 'provider' },
      { src: 'build', level: 'debug', event: 'provider' },
    ]);
    expect(log.written[1]?.msg).toBe('half a line and the rest');
  });

  test('stdout is restored when the provider returns, throws, or is abandoned', async () => {
    const LEAK = 'provider-line-that-must-never-reach-stdout';
    const cases = [
      plugin({
        resolveBuildCache: async () => {
          console.log(LEAK);
          return null;
        },
      }),
      plugin({
        resolveBuildCache: async () => {
          console.log(LEAK);
          throw new Error('boom');
        },
      }),
      plugin({
        resolveBuildCache: () => {
          console.log(LEAK);
          return new Promise(() => {});
        },
      }),
    ];
    for (const { provider } of cases) {
      const { out } = await tapStreams(async () => {
        await resolveRemote({
          provider,
          platform: 'ios',
          projectRoot: root,
          fingerprintHash: 'a',
          timeoutMs: 30,
          logWriter: records().writer,
        });
        // The command's own payload, written the moment the call is over.
        console.log('{"payload":true}');
      });
      // The tap sees every stdout write in the process, and node --test's own
      // reporter is one of them, so this is about the two lines that matter.
      expect(out.join('').includes('{"payload":true}')).toBeTruthy();
      expect(!out.join('').includes(LEAK)).toBeTruthy();
    }
  });

  test('an abandoned provider that prints after its budget still cannot reach stdout', async () => {
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider } = plugin({
      resolveBuildCache: async () => {
        await done;
        console.log('late line from a call nothing is waiting for');
        return null;
      },
    });
    const { out, err } = await tapStreams(async () => {
      const result = await resolveRemote({
        provider,
        platform: 'ios',
        projectRoot: root,
        fingerprintHash: 'a',
        timeoutMs: 20,
        logWriter: records().writer,
      });
      expect(result).toEqual({ timedOut: true });
      console.log('{"payload":true}');
      release();
      await done;
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(out.join('').includes('{"payload":true}')).toBeTruthy();
    expect(!out.join('').includes('late line from a call')).toBeTruthy();
    expect(err.join('')).toMatch(/late line from a call nothing is waiting for/);
  });

  test('nested provider calls restore in order, and the inner one does not free stdout early', async () => {
    const inner = plugin({
      resolveBuildCache: async () => {
        console.log('inner');
        return null;
      },
    }).provider;
    const { provider } = plugin({
      resolveBuildCache: async () => {
        await resolveRemote({
          provider: inner,
          platform: 'ios',
          projectRoot: root,
          fingerprintHash: 'a',
          logWriter: records().writer,
        });
        console.log('outer, after the inner call returned');
        return null;
      },
    });
    const { out, err } = await tapStreams(async () => {
      await resolveRemote({
        provider,
        platform: 'ios',
        projectRoot: root,
        fingerprintHash: 'a',
        logWriter: records().writer,
      });
      console.log('{"payload":true}');
    });
    expect(out.join('').includes('{"payload":true}')).toBeTruthy();
    expect(!out.join('').includes('outer, after the inner call returned')).toBeTruthy();
    expect(err.join('')).toMatch(/inner/);
    expect(err.join('')).toMatch(/outer, after the inner call returned/);
  });

  test('an upload names where it is going when the provider printed it', async () => {
    const notes: string[] = [];
    const { provider } = plugin({
      uploadBuildCache: async () => {
        console.log('Uploading build to https://expo.dev/accounts/acme/projects/app/builds/abc');
      },
    });
    const result = await tapStreams(() =>
      uploadRemote({
        provider,
        platform: 'ios',
        projectRoot: root,
        fingerprintHash: 'a',
        buildPath: '/b.app',
        logWriter: records().writer,
        note: (line) => notes.push(line),
      }),
    );
    expect(result.value).toEqual({
      uploaded: true,
      destination: 'https://expo.dev/accounts/acme/projects/app/builds/abc',
    });
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/^cache {7}uploading to https:\/\/expo\.dev\/accounts\/acme/);
  });

  test('an upload that names no destination says nothing extra', async () => {
    const notes: string[] = [];
    const { provider } = plugin({
      uploadBuildCache: async () => {
        console.log('Uploading build to EAS');
      },
    });
    const result = await tapStreams(() =>
      uploadRemote({
        provider,
        platform: 'ios',
        projectRoot: root,
        fingerprintHash: 'a',
        buildPath: '/b.app',
        logWriter: records().writer,
        note: (line) => notes.push(line),
      }),
    );
    expect(result.value).toEqual({ uploaded: true });
    expect(notes).toEqual([]);
  });
});

describe('uploadDestination', () => {
  test('prefers a URL, falls back to an owner/slug, and is null otherwise', () => {
    expect(uploadDestination(['Uploading build to https://expo.dev/accounts/acme/projects/app (2.1 MB)'])).toBe(
      'https://expo.dev/accounts/acme/projects/app',
    );
    expect(uploadDestination(['Uploading build to acme/my-app'])).toBe('acme/my-app');
    expect(uploadDestination(['Uploading build to @acme/my-app...'])).toBe('@acme/my-app');
    expect(uploadDestination(['Uploading build to EAS'])).toBe(null);
    expect(uploadDestination([])).toBe(null);
    expect(uploadDestination(null)).toBe(null);
  });

  test('reads through the colour codes a provider prints', () => {
    expect(uploadDestination(['\u001b[2mUploading build to\u001b[22m https://expo.dev/x/y'])).toBe(
      'https://expo.dev/x/y',
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
  const LOGGED_IN =
    'janic\n\nAccounts:\n\u2022 janic (Role: Owner)\n' +
    '\u2022 fin-tech (Role: Viewer)\n\u2022 th3rd-wave (Role: Owner)\n';

  test('reads the actor and every account out of a logged-in whoami', () => {
    const parsed = parseWhoami({ stdout: LOGGED_IN, exitCode: 0 });
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.account).toBe('janic');
    expect(parsed.accounts).toEqual(['janic', 'fin-tech', 'th3rd-wave']);
    expect(parsed.viaToken).toBe(false);
  });

  // account/view.js only prints the Accounts block when the actor belongs to an
  // account that is NOT its personal one, so a single-account user's whole
  // output is the username -- which IS the one account they have.
  test('a user with only a personal account still yields that account', () => {
    const parsed = parseWhoami({ stdout: 'janic\n', exitCode: 0 });
    expect(parsed.accounts).toEqual(['janic']);
  });

  test('the EXPO_TOKEN suffix is stripped off the actor and recorded', () => {
    const parsed = parseWhoami({ stdout: 'janic (authenticated using EXPO_TOKEN)\n', exitCode: 0 });
    expect(parsed.account).toBe('janic');
    expect(parsed.viaToken).toBe(true);
  });

  // getActorDisplayName prints "robot" / "Name (robot)" for a robot actor, and
  // a robot has no username at all -- so the display name is not an account
  // name, and enumeration is UNKNOWN rather than "one account called robot".
  test('a robot actor with no Accounts block leaves the accounts unknown', () => {
    const parsed = parseWhoami({ stdout: 'CI (robot) (authenticated using EXPO_TOKEN)\n', exitCode: 0 });
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.accounts).toBe(null);
  });

  test('"Not logged in" plus a non-zero exit is the definitive logged-out answer', () => {
    const parsed = parseWhoami({ stdout: 'Not logged in\n', exitCode: 1 });
    expect(parsed.loggedOut).toBe(true);
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
    expect(parsed.loggedOut).toBe(undefined);
    expect(parsed.unknown).toMatch(/ENOTFOUND/);
  });

  test('a clean exit that printed nothing is unknown too', () => {
    expect(parseWhoami({ stdout: '   \n', exitCode: 0 }).unknown).toBeTruthy();
  });
});

describe('ownerFromConfig', () => {
  test('reads expo.owner out of either config shape', () => {
    expect(ownerFromConfig({ expo: { owner: 'th3rd-wave' } })).toBe('th3rd-wave');
    expect(ownerFromConfig({ owner: 'th3rd-wave' })).toBe('th3rd-wave');
    expect(ownerFromConfig({ expo: {} })).toBe(null);
    expect(ownerFromConfig(null)).toBe(null);
  });
});

describe('isEasAuthFailureText', () => {
  test('recognises what eas-cli says when a session is missing or rejected', () => {
    expect(isEasAuthFailureText('Not logged in')).toBe(true);
    expect(isEasAuthFailureText('Either log in with eas login or set the EXPO_TOKEN environment variable')).toBe(true);
    expect(isEasAuthFailureText('GraphQL request failed: Unauthorized')).toBe(true);
    expect(isEasAuthFailureText('Entity not authorized: Account')).toBe(true);
    expect(isEasAuthFailureText('ETIMEDOUT')).toBe(false);
    expect(isEasAuthFailureText('')).toBe(false);
    expect(isEasAuthFailureText(null)).toBe(false);
  });
});

describe('checkEasAuth', () => {
  beforeEach(() => resetEasAuthCache());
  afterEach(() => resetEasAuthCache());

  const whoami =
    (stdout: string, exitCode = 0, stderr = '') =>
    () => {
      if (exitCode === 0) return stdout;
      throw makeError('Command failed', { status: exitCode, stdout, stderr });
    };

  test('a logged-in session whose accounts include the owner is ok', () => {
    const status = checkEasAuth({
      projectRoot: root,
      owner: 'th3rd-wave',
      resolveBin: () => ({ file: '/bin/eas', source: 'project' }),
      run: whoami('janic\n\nAccounts:\n\u2022 janic (Role: Owner)\n\u2022 th3rd-wave (Role: Owner)\n'),
    });
    expect(status.ok).toBe(true);
    expect(status.account).toBe('janic');
  });

  test('no eas binary anywhere is its own code, with an install remedy', () => {
    const status = checkEasAuth({ projectRoot: root, resolveBin: () => null, run: whoami('') });
    expect(status.code).toBe('no-cli');
    expect(status.remedy).toMatch(/eas-cli/);
  });

  test('a logged-out session is a definitive failure naming both ways back in', () => {
    const status = checkEasAuth({
      projectRoot: root,
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: whoami('Not logged in\n', 1),
    });
    expect(status.code).toBe('logged-out');
    expect(status.remedy).toMatch(/eas login/);
    expect(status.remedy).toMatch(/EXPO_TOKEN/);
  });

  test('an owner no account covers is a wrong-account failure naming both', () => {
    const status = checkEasAuth({
      projectRoot: root,
      owner: 'th3rd-wave',
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: whoami('janic\n'),
    });
    expect(status.code).toBe('wrong-account');
    expect(status.account).toBe('janic');
    expect(status.owner).toBe('th3rd-wave');
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
    expect(status.ok).toBe(true);
  });

  test('a timeout is unknown, not an auth failure -- offline must not read as logged out', () => {
    const status = checkEasAuth({
      projectRoot: root,
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: () => {
        throw makeError('Command failed', { code: 'ETIMEDOUT', killed: true });
      },
    });
    expect(status.failed).toBe(undefined);
    expect(status.unknown).toMatch(/timed out|ETIMEDOUT/);
  });

  test('whoami runs ONCE per command run, however many times it is asked', () => {
    let runs = 0;
    const args = {
      projectRoot: root,
      owner: 'janic',
      resolveBin: () => ({ file: 'eas', source: 'path' as const }),
      run: () => {
        runs += 1;
        return 'janic\n';
      },
    };
    checkEasAuth(args);
    checkEasAuth(args);
    checkEasAuth(args);
    expect(runs).toBe(1);
  });

  test('it is bounded, and it asks the binary it resolved', () => {
    const seen: { file: string; args: string[]; opts?: { timeoutMs?: number } }[] = [];
    checkEasAuth({
      projectRoot: root,
      resolveBin: () => ({ file: '/p/node_modules/.bin/eas', source: 'project' }),
      run: (file, args, opts) => {
        seen.push({ file, args, opts });
        return 'janic\n';
      },
    });
    const call = seen[0];
    assert(call);
    expect(call.file).toBe('/p/node_modules/.bin/eas');
    expect(call.args).toEqual(['whoami']);
    expect(call.opts?.timeoutMs).toBe(WHOAMI_TIMEOUT_MS);
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

    const found = resolveEasCliBin(app, {
      lookupPath: () => {
        throw new Error('PATH must not be consulted');
      },
    });
    assert(found);
    expect(found.file).toBe(join(root, 'node_modules', '.bin', 'eas'));
    expect(found.source).toBe('project');
  });

  test('falls back to `eas` on PATH, which is where a session usually lives', () => {
    const found = resolveEasCliBin(root, { lookupPath: () => '/opt/homebrew/bin/eas\n' });
    expect(found).toEqual({ file: '/opt/homebrew/bin/eas', source: 'path' });
  });

  test('nothing anywhere is null, which is a finding rather than an npx', () => {
    expect(resolveEasCliBin(root, { lookupPath: () => null })).toBe(null);
  });
});

describe('easAuthNote', () => {
  test('the logged-out note names the two remedies and what the build will do', () => {
    const note = easAuthNote({ code: 'logged-out' });
    expect(note).toMatch(/eas is not authenticated/);
    expect(note).toMatch(/eas login/);
    expect(note).toMatch(/EXPO_TOKEN/);
    expect(note).toMatch(/local cache only/);
  });

  test('the wrong-account note names both accounts and says the run continues', () => {
    const note = easAuthNote({ code: 'wrong-account', account: 'janic', owner: 'th3rd-wave' });
    expect(note).toMatch(/janic/);
    expect(note).toMatch(/th3rd-wave/);
    expect(note).toMatch(/anyway/);
  });

  // The upload is collected AFTER the build and the launch, so "building with
  // the local cache only" would be describing something that already happened.
  test('the same failure at upload time says what it cost instead', () => {
    const note = easAuthNote({ code: 'logged-out', reason: '403', phase: 'upload' });
    assert(note);
    expect(note).toMatch(/stayed in the local cache/);
    expect(!/building with/.test(note)).toBeTruthy();
  });

  test('anything else has no note of its own', () => {
    expect(easAuthNote({ code: 'unknown' })).toBe(null);
    expect(easAuthNote(null)).toBe(null);
  });
});

describe('loadProjectProvider owner', () => {
  test('carries the project owner alongside the provider, for the auth check', async () => {
    writeProviderModule('owned-provider.cjs', RECORDING_PROVIDER(join(root, 'calls.log'), null));
    writeAppJson({ expo: { owner: 'th3rd-wave', buildCacheProvider: { plugin: './owned-provider.cjs' } } });
    const loaded = await loadProjectProvider(root);
    expect(loaded.owner).toBe('th3rd-wave');
  });
});
