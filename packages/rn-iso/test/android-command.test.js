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
import {
  NO_DEVICE,
  NO_FINGERPRINT,
  NO_METRO,
  androidFacts,
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
    prebuild: [], build: [], install: [], launch: [], spawn: [], kill: [],
    loadProvider: [], resolveRemoteBuild: [], uploadRemoteBuild: [],
  };
  const stderr = [];
  const stdout = [];
  const options = {
    root,
    ensureDevice: async (args) => { calls.ensureDevice.push(args); return { avdName: 'rn-iso-app-412', consolePort: 5584, owned: true }; },
    ensureDeviceBooted: async (args) => { calls.booted.push(args); return { ok: true, serial: 'emulator-5584' }; },
    resolveMetro: async (port, path) => { calls.metro.push([port, path]); return { metro: { pid: 41233, leader: 41233, cwd: root } }; },
    fingerprint: async (path) => { calls.fingerprint.push(path); return FINGERPRINT; },
    resolveCached: (platform, key) => { calls.resolveCached.push([platform, key]); return null; },
    storeCached: (platform, key, path, opts) => { calls.storeCached.push([platform, key, path, opts]); return path; },
    // Level two. The default is the ordinary case: no provider configured, so
    // nothing is asked and nothing is called.
    loadProvider: async (projectRoot, opts) => { calls.loadProvider.push([projectRoot, opts]); return { none: true }; },
    resolveRemoteBuild: async (args) => { calls.resolveRemoteBuild.push(args); return null; },
    uploadRemoteBuild: async (args) => { calls.uploadRemoteBuild.push(args); return { uploaded: true }; },
    prebuild: async (...args) => { calls.prebuild.push(args); return { ok: true, durationMs: 12000 }; },
    build: async (args) => { calls.build.push(args); return { ok: true, apkPath: fakeApk(), durationMs: 161000 }; },
    install: (args) => { calls.install.push(args); return { ok: true }; },
    launch: (args) => { calls.launch.push(args); return { ok: true, mode: 'am-start' }; },
    spawn: (cmd, args, opts) => { calls.spawn.push({ cmd, args, opts }); return { pid: 9001, unref: () => { calls.spawn.at(-1).unrefed = true; } }; },
    kill: (pid, signal) => { calls.kill.push([pid, signal]); },
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
      fingerprint: FINGERPRINT,
      cacheHit: 'local',
      cacheSkipped: false,
      appPath: '/cache/app-debug.apk',
      bundleId: 'com.example.app',
      launched: true,
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
    assert.match(result.error.message, /reserved port 8082/);
    assert.match(result.error.remedy, /rn-iso start/);
    assert.match(result.error.remedy, /--no-metro-check/);
    assert.match(h.stderr.at(-2), /RN_ISO_NO_METRO/);
    // Nothing was built, so there is nothing to record.
    assert.equal(existsSync(workspaceStateFile(root)), false);
  });

  test('a foreign holder of the port is named rather than built against', async () => {
    const h = harness({ resolveMetro: async () => ({ notOurs: 'pid 900 runs from /elsewhere' }), build: never('the build') });
    const result = await h.run();
    assert.equal(result.error.code, NO_METRO);
    assert.match(result.error.message, /pid 900 runs from \/elsewhere/);
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
      platform: 'android', serial: null, fingerprint: null, cacheHit: false, cacheSkipped: false,
      appPath: null, bundleId: null, launched: false, logs: null,
    });
    // cacheHit is a LEVEL, not a boolean: 'local' | 'remote' | false.
    assert.equal(androidFacts({ cacheHit: 'remote' }).cacheHit, 'remote');
    assert.equal(androidFacts({ cacheHit: true }).cacheHit, false);
    const record = lastBuildRecord({ startedAt: 'now', status: 'ok' });
    assert.deepEqual(Object.keys(record), ['platform', 'fingerprint', 'cacheKey', 'cacheHit', 'cacheSkipped', 'durationMs', 'appPath', 'bundleId', 'startedAt', 'status']);
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
