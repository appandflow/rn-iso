// commands/android.js -- the flow, and the output that is the product.
//
// Nothing here boots an emulator, installs anything, or runs gradle: every
// side effect of the command is a seam and every one of them is injected. The
// config, the workspace state.json and the build log ARE real (under a temp
// RN_ISO_HOME and a temp project), because the two things most worth
// asserting -- that lastBuild merges into state.json instead of clobbering
// it, and that the launch marker lands in the build log -- are only true if
// the real writers are used.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertProject } from '../src/config.js';
import { parseNdjsonText } from '../src/ndjson.js';
import { workspaceLogsDir, workspaceStateFile } from '../src/paths.js';
import { writeWorkspaceState } from '../src/supervisor/run.js';
import { resolveMetroWithRetry } from '../src/commands/ios.js';
import {
  NO_DEVICE,
  NO_FINGERPRINT,
  NO_METRO,
  androidDevClientScheme,
  androidFacts,
  apkDevClientFacts,
  dumpApkManifest,
  findAapt,
  newestBuildTools,
  parseXmltree,
  displayPath,
  formatDuration,
  killPreviousCollector,
  lastBuildRecord,
  phaseLine,
  runAndroid,
  shortHash,
} from '../src/commands/android.js';
import { BUILD_ERROR } from '../src/engine/gradle.js';
import { PREBUILD_ERROR } from '../src/engine/prebuild.js';

const FINGERPRINT = 'a3f9b1c2d3e4f5a6b7c8d9e0f1a2b3c4';
const CACHE_KEY = `${FINGERPRINT}-debug-sim`;

let home;
let root;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rn-iso-home-'));
  process.env.RN_ISO_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'rn-iso-android-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', scripts: { android: 'react-native run-android' } }));
  mkdirSync(join(root, 'android', 'app'), { recursive: true });
  writeFileSync(join(root, 'android', 'app', 'build.gradle'), 'android {\n  namespace "com.example.app"\n}\n');
  upsertProject(root, { metroPort: 8082 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

// --- the harness -----------------------------------------------------------

function fakeApk(name = 'app-debug.apk') {
  const dir = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, 'apk');
  return path;
}

const never = (what) => () => { throw new Error(`${what} must not run in this case`); };

function harness(overrides = {}) {
  const calls = {
    ensureDevice: [], booted: [], metro: [], fingerprint: [], resolveCached: [], storeCached: [],
    prebuild: [], build: [], install: [], launch: [], scheme: [], spawn: [], kill: [],
    loadProvider: [], resolveRemoteBuild: [], uploadRemoteBuild: [], easAuth: [],
    acquireLock: [], releaseLock: [], waitForBuild: [],
    verify: [], ensureIgnored: [],
    // The sequence of the steps that decide who compiles, which is what the
    // single-flight tests below are actually about.
    order: [],
  };
  const stderr = [];
  const stdout = [];
  const options = {
    root,
    ensureDevice: async (args) => { calls.ensureDevice.push(args); return { avdName: 'rn-iso-app-412', consolePort: 5584, owned: true }; },
    ensureDeviceBooted: async (args) => { calls.booted.push(args); return { ok: true, serial: 'emulator-5584' }; },
    resolveMetro: async (port, path) => { calls.metro.push([port, path]); return { metro: { pid: 41233, leader: 41233, cwd: root } }; },
    fingerprint: async (path) => { calls.fingerprint.push(path); return FINGERPRINT; },
    resolveCached: (platform, key) => { calls.order.push('resolveCached'); calls.resolveCached.push([platform, key]); return null; },
    storeCached: (platform, key, path, opts) => { calls.order.push('storeCached'); calls.storeCached.push([platform, key, path, opts]); return path; },
    // Level two. The default is the ordinary case: no provider configured, so
    // nothing is asked and nothing is called.
    loadProvider: async (projectRoot, opts) => { calls.loadProvider.push([projectRoot, opts]); return { none: true }; },
    // Never the real one: it shells out to `eas whoami`, which is a network
    // call. The EAS-session tests override it with the state they are about.
    easAuth: (args) => { calls.easAuth.push(args); return { ok: true, account: 'janic' }; },
    resolveRemoteBuild: async (args) => { calls.order.push('resolveRemoteBuild'); calls.resolveRemoteBuild.push(args); return null; },
    // Single flight. The default is the ordinary case: nothing else on this
    // machine is building this fingerprint, so this run is the one builder.
    acquireLock: (args) => { calls.order.push('acquireLock'); calls.acquireLock.push(args); return { acquired: true, path: join(home, 'build-locks', 'android-k.lock'), lock: { pid: process.pid } }; },
    releaseLock: (handle) => { calls.order.push('releaseLock'); calls.releaseLock.push(handle); return true; },
    waitForBuild: async (args) => { calls.waitForBuild.push(args); throw new Error('nothing should be waited for unless the lock was held'); },
    uploadRemoteBuild: async (args) => { calls.uploadRemoteBuild.push(args); return { uploaded: true }; },
    prebuild: async (...args) => { calls.prebuild.push(args); return { ok: true, durationMs: 12000 }; },
    build: async (args) => { calls.order.push('build'); calls.build.push(args); return { ok: true, apkPath: fakeApk(), durationMs: 161000 }; },
    install: (args) => { calls.install.push(args); return { ok: true }; },
    // The default is what launchAndroidApp returns for a project with no
    // dev-client scheme: the launcher activity, both port mechanisms in
    // place. The dev-client shape has its own tests below.
    launch: (args) => { calls.launch.push(args); return { ok: true, mode: 'am-start', reversed: ['tcp:8081->tcp:8082', 'tcp:8082->tcp:8082'], debugHttpHost: '10.0.2.2:8082', debugHttpHostNote: null }; },
    // Reading the scheme out of the APK shells out to aapt; the resolver has
    // its own tests (against a real dump), so the flow injects the answer.
    resolveDevClientScheme: (projectRoot, apkPath) => { calls.scheme.push([projectRoot, apkPath]); return undefined; },
    spawn: (cmd, args, opts) => { calls.spawn.push({ cmd, args, opts }); return { pid: 9001, unref: () => { calls.spawn.at(-1).unrefed = true; } }; },
    kill: (pid, signal) => { calls.kill.push([pid, signal]); },
    // The retry is real (one test below is about it); only the sleep is
    // removed, so a refusal costs no wall time.
    resolveMetroRetrying: (resolve, port, path, opts) => resolveMetroWithRetry(resolve, port, path, { ...opts, sleep: async () => {} }),
    // The default is a launch that verified -- the app fetched a bundle from
    // THIS workspace's Metro. The picker case has its own tests.
    verifyLaunched: async (args) => { calls.verify.push(args); return { verified: true, waitedMs: 3100 }; },
    ensureIgnored: async (dir) => { calls.ensureIgnored.push(dir); },
    out: (line) => stderr.push(line),
    emit: (line) => stdout.push(line),
    ...overrides,
  };
  return { calls, stderr, stdout, run: () => runAndroid(options) };
}

const labelled = (lines, label) => lines.filter(l => l.startsWith(`  ${label}`));
const readState = () => JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));

// --- the flow --------------------------------------------------------------

describe('a cache hit', () => {
  test('skips the build entirely and installs the cached artifact', async () => {
    const cached = join(home, 'build-cache', 'android', CACHE_KEY, 'app-debug.apk');
    const h = harness({
      resolveCached: () => cached,
      build: never('the build'),
      prebuild: never('prebuild'),
      storeCached: never('storeBuild'),
    });
    const result = await h.run();

    assert.equal(result.ok, true);
    assert.equal(h.calls.install[0].apkPath, cached);
    assert.equal(result.facts.cacheHit, 'local');
    assert.equal(result.facts.appPath, cached);
    assert.match(labelled(h.stderr, 'fingerprint')[0], /a3f9b1\.\. hit/);
    assert.match(labelled(h.stderr, 'install')[0], /from local cache/);
    assert.equal(labelled(h.stderr, 'build').length, 0);
  });

  test('prints the phases the spec\'s worked example prints, and one line on stdout', async () => {
    const h = harness({ resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    await h.run();

    assert.match(labelled(h.stderr, 'device')[0], /rn-iso-app-412 \(emulator-5584\) booted/);
    assert.match(labelled(h.stderr, 'metro')[0], /port 8082 \(pid 41233\)/);
    assert.match(labelled(h.stderr, 'launch')[0], /com\.example\.app/);
    assert.match(labelled(h.stderr, 'logs')[0], /collector pid 9001/);
    // Output discipline: everything above is stderr, and stdout carries the
    // single outcome line an agent reads.
    assert.equal(h.stdout.length, 1);
    assert.match(h.stdout[0], /OK: com\.example\.app launched on emulator-5584/);
    assert.ok(h.stderr.length <= 9, `expected about eight phase lines, got ${h.stderr.length}`);
  });

  test('--json puts the facts on stdout and nothing else', async () => {
    const h = harness({ json: true, resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    const result = await h.run();
    assert.equal(h.stdout.length, 1);
    assert.deepEqual(JSON.parse(h.stdout[0]), {
      platform: 'android',
      serial: 'emulator-5584',
      avdName: 'rn-iso-app-412',
      deviceName: 'rn-iso-app-412',
      fingerprint: FINGERPRINT,
      cacheHit: 'local',
      cacheSkipped: false,
      waitedForBuild: null,
      appPath: '/cache/app-debug.apk',
      bundleId: 'com.example.app',
      launched: true,
      debugHttpHost: '10.0.2.2:8082',
      debugHttpHostNote: null,
      devClientUrl: null,
      logs: workspaceLogsDir(root),
    });
    assert.deepEqual(JSON.parse(h.stdout[0]), result.facts);
  });
});

describe('a cache miss', () => {
  test('builds, stores the result under the fingerprint key, and installs what it built', async () => {
    const h = harness();
    const result = await h.run();

    assert.equal(result.ok, true);
    assert.equal(h.calls.build.length, 1);
    assert.equal(h.calls.build[0].root, root);
    assert.ok(h.calls.build[0].logWriter, 'the build streams into the build log');
    assert.deepEqual(h.calls.storeCached[0].slice(0, 2), ['android', CACHE_KEY]);
    assert.equal(h.calls.install[0].apkPath, h.calls.storeCached[0][2]);
    assert.match(labelled(h.stderr, 'fingerprint')[0], /miss/);
    assert.match(labelled(h.stderr, 'build')[0], /app-debug\.apk \(2m41s\)/);
    assert.equal(result.facts.cacheHit, false);
  });

  test('a cache that cannot be written is a warning, not a failed run', async () => {
    const h = harness({ storeCached: () => { throw new Error('disk full'); } });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.match(labelled(h.stderr, 'cache')[0], /disk full/);
  });

  test('an Expo project with no android/ prebuilds first, then builds', async () => {
    rmSync(join(root, 'android'), { recursive: true, force: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '54.0.0' } }));
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: 'app', android: { package: 'com.example.app' } } }));
    const order = [];
    const h = harness({
      prebuild: async (...args) => { order.push('prebuild'); return { ok: true, durationMs: 12000 }; },
      build: async () => { order.push('build'); return { ok: true, apkPath: fakeApk(), durationMs: 1000 }; },
    });
    const result = await h.run();

    assert.equal(result.ok, true);
    assert.deepEqual(order, ['prebuild', 'build']);
    assert.match(labelled(h.stderr, 'prebuild')[0], /android\/ generated \(12\.0s\)/);
  });

  test('a bare project that already has android/ never prebuilds', async () => {
    const h = harness({ prebuild: never('prebuild') });
    assert.equal((await h.run()).ok, true);
  });
});

describe('metro is verified before any build work', () => {
  test('an unhealthy reserved port fails fast with RN_ISO_NO_METRO', async () => {
    const h = harness({
      resolveMetro: async () => ({ missing: true }),
      fingerprint: never('the fingerprint'),
      resolveCached: never('the cache lookup'),
      build: never('the build'),
      install: never('the install'),
    });
    const result = await h.run();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, NO_METRO);
    assert.match(result.error.message, /port 8082/);
    assert.match(result.error.remedy, /rn-iso start/);
    assert.match(result.error.remedy, /--no-metro-check/);
    assert.match(h.stderr.at(-2), /RN_ISO_NO_METRO/);
    // Nothing was built, so there is nothing to record.
    assert.equal(existsSync(workspaceStateFile(root)), false);
  });

  test('a foreign holder of the port is named rather than built against', async () => {
    const h = harness({ resolveMetro: async () => ({ notOurs: 'pid 900 runs from /elsewhere', kind: 'foreign-cwd' }), build: never('the build') });
    const result = await h.run();
    assert.equal(result.error.code, NO_METRO);
    assert.match(result.error.message, /pid 900 runs from \/elsewhere/);
  });

  // Same race as iOS: `start` returns at listening, and a bare Metro then
  // blocks its event loop crawling a monorepo's file map for ~20s.
  test('an indexing Metro is retried rather than refused', async () => {
    let attempts = 0;
    const h = harness({
      resolveMetro: async () => {
        attempts += 1;
        if (attempts < 3) return { notOurs: 'pid 42 on port 8082 does not answer Metro\'s /status', kind: 'unresponsive' };
        return { metro: { pid: 42, leader: 42, cwd: root } };
      },
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
  });

  test('a refusal names our own supervisor when there is a record for this port', async () => {
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port: 8082, mode: 'bare-inproc', startedAt: 'now' } });
    const h = harness({
      resolveMetro: async () => ({ notOurs: 'pid 4242 on port 8082 does not answer Metro\'s /status', kind: 'unresponsive' }),
      build: never('the build'),
    });
    const result = await h.run();
    assert.equal(result.error.code, NO_METRO);
    assert.match(result.error.message, /A supervisor record exists for port 8082/);
    assert.match(result.error.message, /still be indexing/);
    assert.match(result.error.remedy, /--wait/);
  });

  test('no reservation at all is the same refusal', async () => {
    upsertProject(root, { metroPort: null });
    const h = harness({ resolveMetro: never('the metro probe'), build: never('the build') });
    const result = await h.run();
    assert.equal(result.error.code, NO_METRO);
    assert.match(result.error.message, /No Metro port is reserved/);
  });

  test('--no-metro-check proceeds without probing anything', async () => {
    const h = harness({ metroCheck: false, resolveMetro: never('the metro probe') });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.match(labelled(h.stderr, 'metro')[0], /not checked/);
    // The reservation is still what the app is wired to.
    assert.equal(h.calls.launch[0].metroPort, 8082);
  });

  test('in --json mode a refusal is the error contract, on stdout, alone', async () => {
    const h = harness({ json: true, resolveMetro: async () => ({ missing: true }), build: never('the build') });
    await h.run();
    assert.equal(h.stdout.length, 1);
    const payload = JSON.parse(h.stdout[0]);
    assert.equal(payload.code, NO_METRO);
    assert.ok(payload.message && payload.remedy);
  });
});

describe('the other refusals', () => {
  test('an unresolvable @expo/fingerprint names the package to install', async () => {
    const h = harness({ fingerprint: async () => null, resolveCached: never('the cache lookup'), build: never('the build') });
    const result = await h.run();
    assert.equal(result.error.code, NO_FINGERPRINT);
    assert.match(result.error.remedy, /npm i -D @expo\/fingerprint/);
  });

  test('a fingerprint that throws is reported, not propagated', async () => {
    const h = harness({ fingerprint: async () => { throw new Error('bad app.json'); }, build: never('the build') });
    const result = await h.run();
    assert.equal(result.error.code, NO_FINGERPRINT);
    assert.match(result.error.message, /bad app\.json/);
  });

  // The boot now happens AFTER the Metro gate, so the gate has already passed
  // by the time this fires -- the point is only that no build work follows.
  test('a device that cannot be booted refuses with RN_ISO_NO_DEVICE', async () => {
    const h = harness({
      ensureDeviceBooted: async () => ({ failed: true, reason: 'AVD rn-iso-app-412 no longer exists.' }),
      fingerprint: never('the fingerprint'),
      build: never('the build'),
    });
    const result = await h.run();
    assert.equal(result.error.code, NO_DEVICE);
    assert.match(result.error.message, /no longer exists/);
  });

  test('a prebuild failure carries its own code and transcript tail', async () => {
    const h = harness({
      needsPrebuildFor: () => true,
      prebuild: async () => ({ failed: true, code: PREBUILD_ERROR, reason: 'expo prebuild failed (exit code 1).', remedy: 'Run npm install.', lastLines: ['boom'] }),
      build: never('the build'),
    });
    const result = await h.run();
    assert.equal(result.error.code, PREBUILD_ERROR);
    assert.ok(h.stderr.some(l => /boom/.test(l)));
    assert.equal(readState().lastBuild.status, 'failed');
    assert.equal(readState().lastBuild.errorCode, PREBUILD_ERROR);
  });

  test('an install failure is reported with the device in the remedy', async () => {
    const h = harness({ install: () => ({ failed: true, code: 'RN_ISO_INSTALL_FAILED', reason: 'adb install failed: INSTALL_FAILED_INSUFFICIENT_STORAGE' }), launch: never('the launch') });
    const result = await h.run();
    assert.equal(result.error.code, 'RN_ISO_INSTALL_FAILED');
    assert.match(result.error.remedy, /emulator-5584/);
    assert.equal(readState().lastBuild.errorCode, 'RN_ISO_INSTALL_FAILED');
  });

  test('a launch failure is reported after a successful install', async () => {
    const h = harness({ launch: () => ({ failed: true, code: 'RN_ISO_LAUNCH_FAILED', reason: 'am start failed' }) });
    const result = await h.run();
    assert.equal(result.error.code, 'RN_ISO_LAUNCH_FAILED');
    assert.equal(readState().lastBuild.status, 'failed');
  });
});

describe('a failed build', () => {
  const failingBuild = async () => ({
    failed: true,
    code: BUILD_ERROR,
    reason: '`./gradlew assembleDebug` failed (exit code 1).',
    diagnostics: [
      { message: 'Task :app:compileDebugKotlin FAILED' },
      { file: '/p/android/app/src/main/java/com/app/MainActivity.kt', line: 23, column: 9, message: "Unresolved reference 'Foo'." },
    ],
    truncated: 3,
    lastLines: ['> Task :app:compileDebugKotlin FAILED', 'BUILD FAILED in 2m41s'],
    durationMs: 161000,
  });

  test('prints the extracted diagnostic and the log path, never the transcript', async () => {
    const h = harness({ build: failingBuild, install: never('the install') });
    const result = await h.run();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, BUILD_ERROR);
    assert.match(labelled(h.stderr, 'build')[0], /FAILED after 2m41s/);
    const errors = labelled(h.stderr, 'error');
    assert.ok(errors.some(l => /MainActivity\.kt:23:9: Unresolved reference 'Foo'\./.test(l)));
    assert.ok(errors.some(l => /and 3 more diagnostic/.test(l)));
    // The spec's shape: the log path relative to the workspace, not absolute.
    assert.match(labelled(h.stderr, 'log')[0], /^ {2}log {9}\.rn-iso\/logs\/build-android\.ndjson$/);
  });

  test('falls back to the last transcript lines when nothing could be extracted', async () => {
    const h = harness({
      build: async () => ({ ...(await failingBuild()), diagnostics: [], truncated: 0 }),
      install: never('the install'),
    });
    await h.run();
    assert.ok(h.stderr.some(l => /BUILD FAILED in 2m41s/.test(l)));
    assert.match(labelled(h.stderr, 'log')[0], /build-android\.ndjson/);
  });

  test('writes the diagnostics into the build log as level error', async () => {
    const h = harness({ build: failingBuild, install: never('the install') });
    await h.run();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    const errors = records.filter(r => r.level === 'error');
    assert.equal(errors.length, 2);
    assert.equal(errors[0].src, 'build');
    assert.match(errors[1].msg, /MainActivity\.kt:23:9/);
  });

  test('records lastBuild as failed, with the code and what it knew', async () => {
    const h = harness({ build: failingBuild, install: never('the install') });
    await h.run();
    const { lastBuild } = readState();
    assert.equal(lastBuild.status, 'failed');
    assert.equal(lastBuild.errorCode, BUILD_ERROR);
    assert.equal(lastBuild.platform, 'android');
    assert.equal(lastBuild.fingerprint, FINGERPRINT);
    assert.equal(lastBuild.cacheKey, CACHE_KEY);
    assert.equal(lastBuild.cacheHit, false);
    assert.equal(lastBuild.appPath, null);
    assert.ok(typeof lastBuild.startedAt === 'string');
  });
});

// --- level two: the project's own build cache provider ---------------------
//
// rn-iso's local cache is level one. The project's OWN configured provider
// ("buildCacheProvider": "eas", or a module of its own) is level two, and a hit
// there is copied into level one on the way past so the next worktree does not
// pay for it either. engine-remote-cache.test.js covers the module; what is
// pinned here is that the command asks in the right order and that nothing a
// provider does can fail or stall the run.
describe('the remote cache', () => {
  const provider = (name = 'eas') => ({ provider: { plugin: {}, options: {} }, name });

  test('a LOCAL hit never consults the provider at all', async () => {
    const h = harness({ resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    await h.run();
    assert.equal(h.calls.loadProvider.length, 0, 'level one answered; there is nothing to ask');
    assert.equal(h.calls.resolveRemoteBuild.length, 0);
  });

  test('a bare RN project never has its config read: the community CLI has no provider concept', async () => {
    // The fixture package.json's `android` script is `react-native run-android`,
    // which is what detectIsExpo reads.
    const h = harness();
    await h.run();
    assert.deepEqual(h.calls.loadProvider[0][1], { isExpo: false }, 'the engine is told, and it is what refuses');
    assert.equal(h.calls.resolveRemoteBuild.length, 0, 'no network on a bare project');
  });

  test('an Expo project with no provider configured builds exactly as before', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'app', scripts: { ios: 'expo run:ios' }, dependencies: { expo: '54.0.0' },
    }));
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: 'app' } }));
    const h = harness();
    const result = await h.run();
    assert.deepEqual(h.calls.loadProvider[0][1], { isExpo: true }, 'an Expo project IS asked');
    assert.equal(result.ok, true);
    assert.equal(h.calls.resolveRemoteBuild.length, 0);
    assert.equal(h.calls.uploadRemoteBuild.length, 0);
    assert.equal(labelled(h.stderr, 'cache').length, 0, 'and nothing is said: it is not a problem');
  });

  test('a remote HIT is stored into the local cache and installed, without building', async () => {
    const downloaded = '/tmp/eas-download/app-debug.apk';
    const stored = join(home, 'build-cache', 'android', CACHE_KEY, 'app-debug.apk');
    const h = harness({
      loadProvider: async () => provider(),
      resolveRemoteBuild: async () => ({ appPath: downloaded }),
      storeCached: (platform, key, path, opts) => { h_calls.push([platform, key, path, opts]); return stored; },
      build: never('the build'),
      prebuild: never('prebuild'),
    });
    const h_calls = [];
    const result = await h.run();

    assert.equal(result.ok, true);
    assert.deepEqual(h_calls[0].slice(0, 3), ['android', CACHE_KEY, downloaded], 'the download lands in the local cache under the key that just missed');
    assert.equal(h.calls.install[0].apkPath, stored, 'and the LOCAL copy is what gets installed');
    assert.equal(result.facts.cacheHit, 'remote');
    assert.match(labelled(h.stderr, 'cache')[0], /remote hit \(eas\) -> stored locally/);
    assert.equal(readState().lastBuild.cacheHit, 'remote');
  });

  test('the provider is asked with this workspace\'s fingerprint and platform', async () => {
    const h = harness({ loadProvider: async () => provider('./p.cjs') });
    await h.run();
    assert.equal(h.calls.resolveRemoteBuild[0].platform, 'android');
    assert.equal(h.calls.resolveRemoteBuild[0].fingerprintHash, FINGERPRINT);
    assert.equal(h.calls.resolveRemoteBuild[0].projectRoot, root);
  });

  test('a remote MISS builds, stores locally, and uploads the result', async () => {
    const h = harness({ loadProvider: async () => provider() });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(h.calls.build.length, 1);
    assert.equal(h.calls.storeCached.length, 1);
    assert.equal(h.calls.uploadRemoteBuild[0].buildPath, h.calls.storeCached[0][2]);
    assert.equal(h.calls.uploadRemoteBuild[0].fingerprintHash, FINGERPRINT);
    assert.match(labelled(h.stderr, 'cache').at(-1), /uploaded \(eas\)/);
  });

  test('a provider that THROWS degrades to a local-only run with a note', async () => {
    const h = harness({
      loadProvider: async () => provider(),
      resolveRemoteBuild: async () => ({ failed: 'EAS session expired' }),
    });
    const result = await h.run();
    assert.equal(result.ok, true, 'the run succeeds');
    assert.equal(h.calls.build.length, 1, 'it just builds');
    assert.match(labelled(h.stderr, 'cache')[0], /EAS session expired.*building instead/);
  });

  test('a provider that TIMES OUT does not stall the loop, and the command stops holding the process open', async () => {
    const exits = [];
    const originalExit = process.exit;
    process.exit = (code) => { exits.push(code); };
    let h;
    try {
      h = harness({
        loadProvider: async () => provider(),
        resolveRemoteBuild: async () => ({ timedOut: true }),
      });
      await h.run();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.exit = originalExit;
    }
    assert.equal(h.calls.build.length, 1);
    assert.match(labelled(h.stderr, 'cache')[0], /did not answer within 30\.0s; building instead/);
    assert.deepEqual(exits, [0], 'the abandoned call must not keep node alive after the app launched');
  });

  test('a provider that cannot be loaded says so ONCE and builds', async () => {
    const h = harness({
      loadProvider: async () => ({ unavailable: 'the EAS build cache needs the `eas-build-cache-provider` package' }),
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(h.calls.resolveRemoteBuild.length, 0);
    assert.equal(h.calls.build.length, 1);
    const lines = h.stderr.filter((l) => /provider not usable/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /eas-build-cache-provider/);
  });

  // eas-build-cache-provider catches every error from `npx eas-cli` and returns
  // null, so a logged-out machine gets a clean MISS on every build and nothing
  // says why. The pre-flight is what turns that silence into one line.
  test('a logged-out EAS session skips the remote tier and says so, once', async () => {
    const h = harness({
      loadProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
      easAuth: () => ({ failed: true, code: 'logged-out', reason: 'Not logged in' }),
      resolveRemoteBuild: never('the provider'),
      uploadRemoteBuild: never('the provider'),
    });
    const result = await h.run();
    assert.equal(result.ok, true, 'a broken session never fails a build');
    assert.equal(h.calls.build.length, 1);
    const lines = h.stderr.filter((l) => /eas is not authenticated/.test(l));
    assert.equal(lines.length, 1, 'ONE line');
    assert.match(lines[0], /eas login/);
    assert.match(lines[0], /EXPO_TOKEN/);
    assert.match(lines[0], /local cache only/);
  });

  test('the session is checked with the owner the config named, and only once', async () => {
    const h = harness({
      loadProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
    });
    await h.run();
    assert.equal(h.calls.easAuth.length, 1, 'one whoami per run, not one per call site');
    assert.equal(h.calls.easAuth[0].owner, 'th3rd-wave');
    assert.equal(h.calls.easAuth[0].projectRoot, root);
  });

  test('a custom provider is never asked about EAS at all', async () => {
    const h = harness({ loadProvider: async () => provider('./p.cjs') });
    await h.run();
    assert.equal(h.calls.easAuth.length, 0);
    assert.equal(h.calls.resolveRemoteBuild.length, 1);
  });

  test('a session that could not be established changes nothing', async () => {
    const h = harness({
      loadProvider: async () => provider(),
      easAuth: () => ({ unknown: 'eas whoami timed out after 15000ms' }),
    });
    await h.run();
    assert.equal(h.calls.resolveRemoteBuild.length, 1, 'the provider is still asked');
    assert.ok(!h.stderr.some((l) => /not authenticated/.test(l)));
  });

  test('a session on the wrong account warns, naming both, and still consults the cache', async () => {
    const h = harness({
      loadProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
      easAuth: () => ({ failed: true, code: 'wrong-account', account: 'janic', owner: 'th3rd-wave' }),
    });
    await h.run();
    assert.equal(h.calls.resolveRemoteBuild.length, 1);
    const line = h.stderr.find((l) => /janic/.test(l));
    assert.match(line, /th3rd-wave/);
    assert.match(line, /anyway/);
  });

  test('a provider failure that reads as auth gets the auth note, not the generic one', async () => {
    const h = harness({
      loadProvider: async () => provider(),
      easAuth: () => ({ unknown: 'offline' }),
      resolveRemoteBuild: async () => ({ failed: 'Error: Not logged in' }),
    });
    await h.run();
    assert.match(labelled(h.stderr, 'cache')[0], /eas is not authenticated \(Error: Not logged in\)/);
    assert.ok(!h.stderr.some((l) => /could not be used/.test(l)));
  });

  test('a failed upload is a note, never a failed run', async () => {
    const h = harness({
      loadProvider: async () => provider(),
      uploadRemoteBuild: async () => ({ failed: '403 forbidden' }),
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(h.stdout.length, 1, 'stdout still carries exactly one line');
    assert.match(labelled(h.stderr, 'cache').at(-1), /upload failed: 403 forbidden/);
  });
});

describe('--no-build-cache', () => {
  test('looks nothing up: not the local cache, not the provider', async () => {
    const h = harness({
      useBuildCache: false,
      resolveCached: never('the local cache'),
      loadProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
      resolveRemoteBuild: never('the provider'),
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(h.calls.build.length, 1, 'it builds fresh');
    assert.equal(result.facts.cacheHit, false);
    assert.equal(result.facts.cacheSkipped, true, 'an agent can tell "told not to look" from "found nothing"');
    assert.match(labelled(h.stderr, 'fingerprint')[0], /miss \(--no-build-cache\)/);
  });

  // The whole reason to opt out is an entry you no longer trust. Keeping it
  // would mean the next run trusts it again.
  test('still STORES -- over the entry it was told not to trust -- and still uploads', async () => {
    const h = harness({
      useBuildCache: false,
      loadProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
    });
    await h.run();
    assert.deepEqual(h.calls.storeCached[0][3], { overwrite: true });
    assert.equal(h.calls.uploadRemoteBuild.length, 1, '"do not trust the cache" is not "do not share my build"');
  });

  test('a default run stores without overwriting: two worktrees at the same fingerprint agree', async () => {
    const h = harness();
    await h.run();
    assert.deepEqual(h.calls.storeCached[0][3], { overwrite: false });
  });
});

// --- single-flight builds ---------------------------------------------------
//
// The iOS command's wiring, on the Android half: both caches missed, so this
// run is about to spend minutes in gradle -- and if another workspace on this
// machine is already spending them on the same fingerprint, waiting for its
// APK beats compiling the same one beside it. engine/build-lock.js is tested
// on its own; what is pinned here is WHEN the lock is attempted, that a waiter
// never builds, and that a builder always releases.
describe('single-flight builds', () => {
  const heldBy = (pid = 41233, projectRoot = '/w/app-999') => ({
    held: { pid, projectRoot, startedAt: '2026-08-25T10:00:00.000Z', logFile: `${projectRoot}/.rn-iso/logs/build-android.ndjson` },
    path: '/home/build-locks/android-key.lock',
  });

  test('the lock is attempted only after BOTH cache levels have missed, and released after the store', async () => {
    const h = harness({ loadProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }) });
    await h.run();
    assert.deepEqual(h.calls.order.filter(o => ['resolveCached', 'resolveRemoteBuild', 'acquireLock', 'build', 'storeCached', 'releaseLock'].includes(o)),
      ['resolveCached', 'resolveRemoteBuild', 'acquireLock', 'build', 'storeCached', 'releaseLock']);
    assert.equal(h.calls.acquireLock[0].platform, 'android');
    assert.equal(h.calls.acquireLock[0].key, CACHE_KEY);
    assert.equal(h.calls.acquireLock[0].root, root);
    assert.match(h.calls.acquireLock[0].logFile, /build-android\.ndjson$/, 'the holder names the log a waiter should tail');
  });

  test('a cache hit at either level never takes the lock', async () => {
    const local = harness({ resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    await local.run();
    assert.equal(local.calls.acquireLock.length, 0);

    const remote = harness({
      loadProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
      resolveRemoteBuild: async () => ({ appPath: '/downloads/app-debug.apk' }),
      build: never('the build'),
    });
    await remote.run();
    assert.equal(remote.calls.acquireLock.length, 0);
  });

  test('--no-build-cache neither waits nor acquires', async () => {
    const h = harness({
      useBuildCache: false,
      acquireLock: never('the lock'),
      waitForBuild: never('the wait'),
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(h.calls.build.length, 1, 'it still compiles fresh');
  });

  test('the loser waits, installs the artifact, and compiles nothing', async () => {
    const waited = join(home, 'build-cache', 'android', CACHE_KEY, 'app-debug.apk');
    const h = harness({
      acquireLock: () => heldBy(41233, '/w/app-999'),
      waitForBuild: async () => ({ hit: waited, waitedMs: 761000 }),
      build: never('the build'),
      prebuild: never('prebuild'),
      storeCached: never('the store'),
      needsPrebuildFor: () => true,
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(h.calls.releaseLock.length, 0, 'a waiter never held the lock');
    assert.equal(h.calls.install[0].apkPath, waited);
    assert.equal(result.facts.cacheHit, 'local', 'it came out of the local cache, like any other hit');
    assert.deepEqual(result.facts.waitedForBuild, { pid: 41233, ms: 761000 });
    assert.match(h.stderr.join('\n'), /waited 12m41s for \/w\/app-999's build -> installed from cache/);
  });

  test('a run that did not wait reports waitedForBuild: null', async () => {
    const h = harness();
    assert.equal((await h.run()).facts.waitedForBuild, null);
  });

  test('the wait is announced, and its progress reaches stderr as it happens', async () => {
    const h = harness({
      acquireLock: () => heldBy(),
      waitForBuild: async ({ out }) => {
        out('build       waiting on /w/app-999 (pid 41233, 4m elapsed) -- tail /w/app-999/x.ndjson');
        return { hit: '/cache/app-debug.apk', waitedMs: 240000 };
      },
    });
    await h.run();
    const err = h.stderr.join('\n');
    assert.match(err, /\/w\/app-999 is already building/);
    assert.match(err, /waiting on \/w\/app-999 \(pid 41233, 4m elapsed\)/);
    assert.equal(h.stdout.length, 1, 'stdout still carries exactly one line');
  });

  test('a builder that failed makes the waiter take over and build', async () => {
    let acquires = 0;
    const h = harness({
      acquireLock: () => (++acquires === 1 ? heldBy() : { acquired: true, path: '/lock', lock: { pid: process.pid } }),
      waitForBuild: async () => ({ builderFailed: 'the build lock was released without an artifact', waitedMs: 4000 }),
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(acquires, 2, 'it takes the lock over rather than building beside a queue');
    assert.equal(h.calls.build.length, 1);
    assert.equal(h.calls.releaseLock.length, 1);
    assert.match(h.stderr.join('\n'), /without an artifact/);
  });

  test('losing the takeover race builds anyway rather than queueing again', async () => {
    let waits = 0;
    const h = harness({
      acquireLock: () => heldBy(),
      waitForBuild: async () => { waits++; return { builderFailed: 'the builder (pid 41233) is gone', waitedMs: 10 }; },
    });
    assert.equal((await h.run()).ok, true);
    assert.equal(waits, 1, 'it does not wait a second time');
    assert.equal(h.calls.releaseLock.length, 0, 'it never held the lock, so it must not release one');
  });

  // A failed build that kept its lock would leave every other workspace on the
  // fingerprint waiting for an APK nobody is making.
  test('a FAILED build releases the lock', async () => {
    const h = harness({
      build: async () => ({ failed: true, code: BUILD_ERROR, reason: 'gradle said no', diagnostics: [], lastLines: [] }),
    });
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(h.calls.releaseLock.length, 1, 'a failed build must free its waiters');
  });

  test('a build that THROWS releases the lock on the way out', async () => {
    const h = harness({ build: async () => { throw new Error('gradle exploded'); } });
    await assert.rejects(() => h.run(), /gradle exploded/);
    assert.equal(h.calls.releaseLock.length, 1);
  });

  test('a wait that hits its ceiling is a refusal with a code, not a crash', async () => {
    const h = harness({
      acquireLock: () => heldBy(),
      waitForBuild: async () => {
        const err = new Error('Waited 90m ... The lock is /home/build-locks/android-key.lock');
        err.code = 'RN_ISO_BUILD_WAIT_TIMEOUT';
        err.lockPath = '/home/build-locks/android-key.lock';
        throw err;
      },
    });
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'RN_ISO_BUILD_WAIT_TIMEOUT');
    assert.equal(h.calls.build.length, 0);
  });

  // The lock is an optimisation, and one that cannot run must never stop a
  // build -- the same containment the cache store and the provider get.
  test('a lock that cannot be created is a note, and the build proceeds', async () => {
    const h = harness({ acquireLock: () => { throw new Error('EROFS: read-only file system'); } });
    assert.equal((await h.run()).ok, true);
    assert.equal(h.calls.build.length, 1);
    assert.match(h.stderr.join('\n'), /read-only file system/);
  });
});

// --- contracts 4, 5 and 1 --------------------------------------------------

describe('Contract 4: state.json.lastBuild', () => {
  test('is written on success with every field the contract names', async () => {
    const h = harness();
    const result = await h.run();
    const { lastBuild } = readState();
    assert.equal(lastBuild.status, 'ok');
    assert.equal(lastBuild.errorCode, undefined);
    assert.equal(lastBuild.platform, 'android');
    assert.equal(lastBuild.fingerprint, FINGERPRINT);
    assert.equal(lastBuild.cacheKey, CACHE_KEY);
    assert.equal(lastBuild.cacheHit, false);
    assert.equal(lastBuild.appPath, result.facts.appPath);
    assert.equal(lastBuild.bundleId, 'com.example.app');
    assert.ok(Number.isFinite(lastBuild.durationMs));
  });

  test('MERGES: the supervisor and collector keys survive the write', async () => {
    writeWorkspaceState(root, {
      supervisor: { pid: 41233, port: 8082, mode: 'bare-inproc', startedAt: 'then' },
      collectors: { ios: { pid: 777, startedAt: 'then' } },
    });
    await harness().run();
    const state = readState();
    assert.deepEqual(state.supervisor, { pid: 41233, port: 8082, mode: 'bare-inproc', startedAt: 'then' });
    assert.deepEqual(state.collectors, { ios: { pid: 777, startedAt: 'then' } });
    assert.equal(state.lastBuild.status, 'ok');
  });

  test('a state file that cannot be written is a warning, not a failed run', async () => {
    const h = harness({ writeState: () => { throw new Error('read-only volume'); } });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.ok(h.stderr.some(l => /read-only volume/.test(l)));
  });
});

describe('Contract 5: the device-log collector', () => {
  test('is spawned detached and unreferenced with this platform\'s identity', async () => {
    const h = harness();
    await h.run();
    assert.equal(h.calls.spawn.length, 1);
    const { args, opts, unrefed } = h.calls.spawn[0];
    assert.match(args[0], /collector\/run\.js$/);
    assert.deepEqual(args.slice(1), ['--platform', 'android', '--root', root, '--serial', 'emulator-5584', '--package', 'com.example.app']);
    assert.equal(opts.detached, true);
    assert.equal(opts.stdio, 'ignore');
    assert.equal(opts.cwd, root);
    assert.equal(unrefed, true);
  });

  test('the previous android collector is killed first -- replaced, not duplicated', async () => {
    writeWorkspaceState(root, { collectors: { android: { pid: 4242, startedAt: 'then' }, ios: { pid: 777, startedAt: 'then' } } });
    const h = harness();
    await h.run();
    assert.deepEqual(h.calls.kill, [[4242, 'SIGTERM']]);
    assert.equal(h.calls.spawn.length, 1);
  });

  test('the ios collector is left alone', async () => {
    writeWorkspaceState(root, { collectors: { ios: { pid: 777, startedAt: 'then' } } });
    const h = harness();
    await h.run();
    assert.deepEqual(h.calls.kill, []);
  });

  test('a collector that cannot be spawned does not fail the run', async () => {
    const h = harness({ spawn: () => { throw new Error('EAGAIN'); } });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.match(labelled(h.stderr, 'logs')[0], /EAGAIN/);
  });
});

describe('Contract 1: the launch marker', () => {
  test('a launch writes a marker record into the build log', async () => {
    await harness().run();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    const marker = records.find(r => r.marker === true);
    assert.ok(marker, 'expected a marker record so `logs --errors` can close the previous window');
    assert.equal(marker.src, 'build');
    assert.equal(marker.event, 'app_launched');
    assert.match(marker.msg, /com\.example\.app on emulator-5584 against Metro port 8082/);
  });
});

// --- the pure parts --------------------------------------------------------

describe('the pure parts', () => {
  test('phaseLine lines the values up in one column', () => {
    assert.equal(phaseLine('device', 'x'), '  device      x');
    assert.equal(phaseLine('fingerprint', 'x'), '  fingerprint x');
  });

  test('displayPath shortens a workspace path and leaves a foreign one alone', () => {
    assert.equal(displayPath(root, join(root, '.rn-iso', 'logs')), '.rn-iso/logs');
    assert.equal(displayPath(root, '/elsewhere/build.ndjson'), '/elsewhere/build.ndjson');
  });

  test('shortHash keeps the prefix an agent actually reads', () => {
    assert.equal(shortHash(FINGERPRINT), 'a3f9b1..');
    assert.equal(shortHash('abc'), 'abc');
    assert.equal(shortHash(null), '');
  });

  test('formatDuration reads at a glance', () => {
    assert.equal(formatDuration(410), '410ms');
    assert.equal(formatDuration(3100), '3.1s');
    assert.equal(formatDuration(161000), '2m41s');
    assert.equal(formatDuration(605000), '10m05s');
    assert.equal(formatDuration(undefined), 'unknown');
  });

  test('androidFacts and lastBuildRecord fill every field of their contracts', () => {
    assert.deepEqual(androidFacts({}), {
      platform: 'android', serial: null, avdName: null, deviceName: null, fingerprint: null,
      cacheHit: false, cacheSkipped: false, waitedForBuild: null, appPath: null, bundleId: null, launched: false,
      debugHttpHost: null, debugHttpHostNote: null, devClientUrl: null, logs: null,
    });
    // A device tool is addressed by AVD name, not by console-port slot, and
    // deviceName falls back to it rather than being separately null.
    assert.deepEqual(
      { avdName: androidFacts({ avdName: 'rn-iso-app-412' }).avdName, deviceName: androidFacts({ avdName: 'rn-iso-app-412' }).deviceName },
      { avdName: 'rn-iso-app-412', deviceName: 'rn-iso-app-412' }
    );
    // cacheHit is a LEVEL, not a boolean: 'local' | 'remote' | false.
    assert.equal(androidFacts({ cacheHit: 'remote' }).cacheHit, 'remote');
    assert.equal(androidFacts({ cacheHit: true }).cacheHit, false);
    // A wait is reported ALONGSIDE cacheHit: 'local', never instead of it: the
    // APK did come from the local cache, it just was not there yet when the
    // run started.
    assert.deepEqual(androidFacts({ cacheHit: 'local', waitedForBuild: { pid: 41233, ms: 761000 } }).waitedForBuild, { pid: 41233, ms: 761000 });
    const record = lastBuildRecord({ startedAt: 'now', status: 'ok' });
    assert.deepEqual(Object.keys(record), ['platform', 'avdName', 'deviceName', 'fingerprint', 'cacheKey', 'cacheHit', 'cacheSkipped', 'durationMs', 'appPath', 'bundleId', 'startedAt', 'status']);
    assert.equal(lastBuildRecord({ startedAt: 'now', status: 'failed', errorCode: BUILD_ERROR }).errorCode, BUILD_ERROR);
  });

  test('killPreviousCollector signals a recorded pid and tolerates a dead one', () => {
    const signalled = [];
    assert.equal(killPreviousCollector(root, { collectors: { android: { pid: 4242 } }, kill: (pid, sig) => signalled.push([pid, sig]) }), 4242);
    assert.deepEqual(signalled, [[4242, 'SIGTERM']]);
    assert.equal(killPreviousCollector(root, { collectors: { android: { pid: 4242 } }, kill: () => { throw new Error('ESRCH'); } }), null);
    assert.equal(killPreviousCollector(root, { collectors: {}, kill: () => { throw new Error('must not be called'); } }), null);
    // Never our own pid: the collector helpers share this process in tests.
    assert.equal(killPreviousCollector(root, { collectors: { android: { pid: process.pid } }, kill: () => { throw new Error('must not be called'); } }), null);
  });
});


// The launch is not the proof: an expo-dev-client app that opens its
// DEVELOPMENT SERVERS picker has fetched nothing, and `am start` returned 0
// all the same.
describe('launch verification', () => {
  test('a verified launch reports launched: true and polls this workspace\'s timeline', async () => {
    const h = harness();
    const result = await h.run();
    assert.equal(result.facts.launched, true);
    assert.equal(h.calls.verify[0].logsDir, workspaceLogsDir(root));
    assert.ok(Number.isFinite(h.calls.verify[0].since));
    assert.ok(h.stderr.some(l => /verify.*bundle requested from Metro port 8082/.test(l)));
  });

  test('the picker: no bundle request makes it launched: "unverified", still exit ok', async () => {
    const h = harness({ verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) });
    const result = await h.run();
    // ok stays true: the app IS launched. What changes is the fact an agent
    // branches on, and the warning that says what to do about it.
    assert.equal(result.ok, true);
    assert.equal(result.facts.launched, 'unverified');
    const text = h.stderr.join('\n');
    assert.match(text, /UNVERIFIED/);
    assert.match(text, /DEVELOPMENT SERVERS/);
    assert.match(text, /adb -s emulator-5584 shell monkey -p com\.example\.app 1/);
    assert.doesNotMatch(text, /simctl/, 'the iOS remedies belong to the other platform');
    assert.match(h.stdout.join('\n'), /UNVERIFIED/);
  });
});

describe('the launch outcome reaches the timeline', () => {
  test('an unverified launch is a warn record in the build log', async () => {
    const h = harness({ verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) });
    await h.run();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    const record = records.find(r => r.event === 'launch_unverified');
    assert.ok(record);
    assert.equal(record.level, 'warn');
  });
});

describe('the workspace directory is gitignored first', () => {
  test('ensureWorkspaceIgnored runs before the build log is opened', async () => {
    const h = harness();
    await h.run();
    assert.deepEqual(h.calls.ensureIgnored, [root]);
  });
});

// --- Contract 6, REPORTED (the result used to be invisible) ----------------
//
// launchAndroidApp has always returned debugHttpHost and debugHttpHostNote,
// and until now every caller dropped them on the floor. That is how a
// debug_http_host write that emitted an INVALID SHELL SCRIPT, and so had
// never once succeeded, produced output identical to one that worked: the
// launch survives on the adb reverse alone, and nothing printed the
// difference. These tests are the consumer.
describe('the port wiring is reported', () => {
  test('a successful debug_http_host write is a phase line and two facts', async () => {
    const h = harness();
    const result = await h.run();
    assert.match(labelled(h.stderr, 'wired')[0], /debug_http_host 10\.0\.2\.2:8082 \+ adb reverse tcp:8081 -> tcp:8082/);
    assert.equal(result.facts.debugHttpHost, '10.0.2.2:8082');
    assert.equal(result.facts.debugHttpHostNote, null);
  });

  test('a failed one is a WARNING, a note in the facts, and a record in the timeline', async () => {
    const h = harness({
      launch: () => ({ ok: true, mode: 'am-start', reversed: ['tcp:8081->tcp:8082'], debugHttpHost: null, debugHttpHostNote: 'debug_http_host not written (run-as: package not debuggable); relying on adb reverse' }),
    });
    const result = await h.run();
    // The run still succeeds -- the reverse covers the 8081 path on its own.
    assert.equal(result.ok, true);
    const wired = labelled(h.stderr, 'wired')[0];
    assert.match(wired, /not debuggable/);
    assert.match(wired, /adb reverse tcp:8081 -> tcp:8082/, 'what DID work is still named');
    assert.equal(result.facts.debugHttpHost, null);
    assert.match(result.facts.debugHttpHostNote, /relying on adb reverse/);
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    const record = records.find(r => r.event === 'debug_http_host_failed');
    assert.ok(record, 'the note belongs in the timeline, where `logs --errors` finds it');
    assert.equal(record.level, 'warn');
  });
});

// --- the dev-client deep link (F7) -----------------------------------------
describe('the dev-client deep link', () => {
  test('the scheme is read from the APK that was just installed, and passed to the launch', async () => {
    const asked = [];
    const h = harness({ resolveDevClientScheme: (projectRoot, apkPath) => { asked.push([projectRoot, apkPath]); return 'exp+app'; } });
    await h.run();
    assert.equal(asked.length, 1);
    assert.equal(h.calls.launch[0].devClientScheme, 'exp+app');
    // The apk the resolver is pointed at is the one that was installed, not
    // a source tree it would have to guess a build output path in.
    assert.deepEqual(asked[0], [root, h.calls.install[0].apkPath]);
  });

  test('the deep-link launch says so, and the url is in the facts', async () => {
    const url = 'exp+app://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8082';
    const h = harness({
      resolveDevClientScheme: () => 'exp+app',
      launch: () => ({ ok: true, mode: 'deep-link', devClientUrl: url, reversed: [], debugHttpHost: '10.0.2.2:8082' }),
    });
    const result = await h.run();
    assert.match(labelled(h.stderr, 'launch')[0], /expo-dev-client deep link/);
    assert.equal(result.facts.devClientUrl, url);
  });

  test('a deep link that resolved nothing is a warning, not a failure', async () => {
    const h = harness({
      resolveDevClientScheme: () => 'exp+app',
      launch: () => ({ ok: true, mode: 'am-start', devClientNote: 'am start -d exp+app://... did not start anything on emulator-5584: Error: Activity not started, unable to resolve Intent; fell back to the launcher activity', reversed: [], debugHttpHost: '10.0.2.2:8082' }),
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.ok(labelled(h.stderr, 'wired').some(l => /unable to resolve Intent/.test(l)));
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    assert.ok(records.find(r => r.event === 'dev_client_link_failed'));
  });

  test('an unverified launch names the deep link FIRST, as a command that can be pasted', async () => {
    const h = harness({
      resolveDevClientScheme: () => 'exp+app',
      verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
    });
    await h.run();
    const steps = h.stderr.filter(l => /^\s+\d+\./.test(l.replace(/^\s{2}\s*/, '  ')));
    const text = h.stderr.join('\n');
    const link = text.indexOf('am start -a android.intent.action.VIEW');
    const picker = text.indexOf('DEVELOPMENT SERVERS');
    assert.ok(link > 0, 'the deep link is in the guidance');
    assert.ok(link < picker, 'and it comes before the picker advice');
    // The exact command, with the exact url: 10.0.2.2, this workspace's port,
    // percent-encoded, quoted for the shell it is pasted into.
    assert.match(text, /adb -s emulator-5584 shell am start -a android\.intent\.action\.VIEW -d 'exp\+app:\/\/expo-development-client\/\?url=http%3A%2F%2F10\.0\.2\.2%3A8082'/);
    assert.ok(steps.length >= 2);
  });

  test('no scheme, no deep link in the guidance', async () => {
    const h = harness({ verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) });
    await h.run();
    const text = h.stderr.join('\n');
    assert.doesNotMatch(text, /expo-development-client/);
    assert.match(text, /DEVELOPMENT SERVERS/);
  });
});

// --- F15: the emulator's NAME, not just its console-port slot --------------
describe('the device identity is recorded', () => {
  test('avdName and deviceName reach the facts and state.json lastBuild', async () => {
    const h = harness();
    const result = await h.run();
    assert.equal(result.facts.avdName, 'rn-iso-app-412');
    assert.equal(result.facts.deviceName, 'rn-iso-app-412');
    assert.equal(result.facts.serial, 'emulator-5584');
    const lastBuild = readState().lastBuild;
    assert.equal(lastBuild.avdName, 'rn-iso-app-412');
    assert.equal(lastBuild.deviceName, 'rn-iso-app-412');
  });

  test('a failure after the device is resolved still records which emulator it was', async () => {
    const h = harness({ install: () => ({ failed: true, reason: 'adb install failed' }) });
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(readState().lastBuild.avdName, 'rn-iso-app-412');
  });
});

// --- reading the dev-client scheme out of the BUILT APK ---------------------
//
// The fixture is a real `aapt dump xmltree` of a real expo-dev-client debug
// APK (see its header). Everything below is asserted against that rather than
// against a hand-written manifest, because the two things that make this hard
// are both properties of real output: the scheme can be an UNRESOLVED
// resource reference, and the manifest of a dev client declares a dozen
// schemes belonging to other people's SDKs.
describe('the APK dev-client scheme', () => {
  const dump = () => readFileSync(join(import.meta.dirname, 'fixtures', 'aapt-xmltree-devclient.txt'), 'utf-8');

  test('the scheme is the launchable activity\'s, not the longest in the manifest', () => {
    const facts = apkDevClientFacts(dump());
    assert.equal(facts.devClient, true);
    assert.deepEqual(facts.schemes, ['th3rdwave']);
    // The trap: these ARE in the manifest, on other activities.
    assert.doesNotMatch(JSON.stringify(facts.schemes), /expo-dev-launcher|stripe/);
  });

  test('aapt2\'s namespace-qualified spelling parses to the same thing', () => {
    const aapt2 = dump().replace(/A: android:/g, 'A: http://schemas.android.com/apk/res/android:');
    assert.deepEqual(apkDevClientFacts(aapt2), apkDevClientFacts(dump()));
  });

  test('an unresolved @0x resource reference is not a scheme', () => {
    // MainActivity's first VIEW filter carries `android:scheme=@0x7f1300c6`.
    const tree = parseXmltree(dump());
    const values = [];
    const walk = (n) => { if ('android:scheme' in n.attrs) values.push(n.attrs['android:scheme']); n.children.forEach(walk); };
    walk(tree);
    assert.ok(values.includes(null), 'the reference is parsed, as null');
    assert.ok(!apkDevClientFacts(dump()).schemes.includes(null));
  });

  test('an app with no expo-dev-launcher in it is not a dev client', () => {
    const plain = dump().split('\n').filter(l => !l.includes('devlauncher')).join('\n');
    assert.equal(apkDevClientFacts(plain).devClient, false);
  });

  test('a manifest with no launchable activity yields no schemes rather than the wrong one', () => {
    const noMain = dump().replace(/android\.intent\.action\.MAIN/g, 'android.intent.action.SEND');
    assert.deepEqual(apkDevClientFacts(noMain).schemes, []);
  });

  test('androidDevClientScheme: the APK answers, in both directions', () => {
    assert.equal(androidDevClientScheme(root, '/x/app.apk', { dump: () => dump() }), 'th3rdwave');
    // A readable APK that is not a dev client is a plain launch -- NOT a
    // fall through to app.json, which would deep-link an app with no
    // launcher to handle it.
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fromconfig' } }));
    const plain = dump().split('\n').filter(l => !l.includes('devlauncher')).join('\n');
    assert.equal(androidDevClientScheme(root, '/x/app.apk', { dump: () => plain }), undefined);
  });

  test('an unreadable APK falls back to the project config, exactly as iOS does', () => {
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fromconfig' } }));
    // No expo-dev-client in this fixture project's dependencies, so the
    // config reader refuses too: a plain launch, not a link nothing answers.
    assert.equal(androidDevClientScheme(root, '/x/app.apk', { dump: () => null }), undefined);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'expo-dev-client': '^5.0.0' } }));
    assert.equal(androidDevClientScheme(root, '/x/app.apk', { dump: () => null }), 'fromconfig');
  });

  test('newestBuildTools sorts by version, not by string', () => {
    assert.equal(newestBuildTools(['34.0.0', '36.0.0', '9.0.0', '35.0.0']), '36.0.0');
    assert.equal(newestBuildTools(['36.0.0', '36.0.1']), '36.0.1');
    assert.equal(newestBuildTools(['source.properties', 'NOTICE.txt']), null);
    assert.equal(newestBuildTools([]), null);
  });

  test('findAapt takes the newest build-tools that actually has one', () => {
    const found = findAapt('/sdk', {
      readDir: () => ['35.0.0', '36.0.0'],
      exists: (path) => path === join('/sdk', 'build-tools', '35.0.0', 'aapt2'),
    });
    assert.deepEqual(found, { path: join('/sdk', 'build-tools', '35.0.0', 'aapt2'), tool: 'aapt2', version: '35.0.0' });
    assert.equal(findAapt('/sdk', { readDir: () => { throw new Error('ENOENT'); }, exists: () => false }), null);
    assert.equal(findAapt('/sdk', { readDir: () => ['36.0.0'], exists: () => false }), null);
  });

  test('dumpApkManifest spells the dump the way each tool wants, and swallows failures', () => {
    const calls = [];
    const exec = { runFile: (file, args) => { calls.push([file, ...args]); return 'E: manifest (line=2)\n'; } };
    dumpApkManifest('/x/app.apk', { exec, aapt: { path: '/sdk/aapt', tool: 'aapt' } });
    dumpApkManifest('/x/app.apk', { exec, aapt: { path: '/sdk/aapt2', tool: 'aapt2' } });
    assert.deepEqual(calls, [
      ['/sdk/aapt', 'dump', 'xmltree', '/x/app.apk', 'AndroidManifest.xml'],
      ['/sdk/aapt2', 'dump', 'xmltree', '--file', 'AndroidManifest.xml', '/x/app.apk'],
    ]);
    const throwing = { runFile: () => { throw new Error('Invalid file'); } };
    assert.equal(dumpApkManifest('/x/app.apk', { exec: throwing, aapt: { path: '/sdk/aapt', tool: 'aapt' } }), null);
    // Output that is not a manifest tree is not a manifest tree.
    assert.equal(dumpApkManifest('/x/app.apk', { exec: { runFile: () => 'ERROR: dump failed' }, aapt: { path: '/sdk/aapt', tool: 'aapt' } }), null);
    assert.equal(dumpApkManifest(null, { exec: throwing }), null);
  });
});

// The fingerprint is scoped to Android. Unscoped, the iOS tree hashes into the
// ANDROID key -- and a podspec that bakes an absolute path into
// ios/Podfile.lock then makes every cross-worktree android build a cache miss.
// See the field note above fingerprintProject in src/build-cache.js.
test('android fingerprints with platforms scoped to android', async () => {
  const seen = [];
  const h = harness({ fingerprint: async (path, options) => { seen.push({ path, options }); return FINGERPRINT; } });
  await h.run();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, root);
  assert.equal(seen[0].options?.platform, 'android');
});
