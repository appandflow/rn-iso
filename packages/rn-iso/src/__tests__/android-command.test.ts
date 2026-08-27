// commands/android.js -- the flow, and the output that is the product.
//
// Nothing here boots an emulator, installs anything, or runs gradle: every
// side effect of the command is a seam and every one of them is injected. The
// config, the workspace state.json and the build log ARE real (under a temp
// RN_ISO_HOME and a temp project), because the two things most worth
// asserting -- that lastBuild merges into state.json instead of clobbering
// it, and that the launch marker lands in the build log -- are only true if
// the real writers are used.
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setProjectSetting, upsertProject } from '../config.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { workspaceLogsDir, workspaceStateFile } from '../paths.ts';
import { writeWorkspaceState } from '../supervisor/run.ts';
import { resolveMetroWithRetry } from '../commands/ios.ts';
import {
  NO_DEVICE,
  NO_FINGERPRINT,
  NO_METRO,
  androidDevClientScheme,
  androidFacts,
  androidVariantSetting,
  isReleaseVariant,
  resolveVariant,
  apkPackage,
  apkDevClientFacts,
  dumpApkManifest,
  findAapt,
  parseXmltree,
  displayPath,
  formatDuration,
  killPreviousCollector,
  lastBuildRecord,
  phaseLine,
  runAndroid,
  shortHash,
} from '../commands/android.ts';
import { newestBuildTools } from '../sim/android.ts';
import { BUILD_ERROR } from '../engine/gradle.ts';
import type { AssetManifest } from '../engine/asset-manifest.ts';
import { PREBUILD_ERROR } from '../engine/prebuild.ts';
import { asProcessExit, makeChildProcess, makeError, makeExecutor } from './_factories.ts';

const FINGERPRINT = 'a3f9b1c2d3e4f5a6b7c8d9e0f1a2b3c4';
const CACHE_KEY = `${FINGERPRINT}-debug-sim`;
// What a cache entry's stored asset manifest and a fresh build's captured one
// look like; the gate itself is tested in engine-asset-manifest.test.ts.
const STORED_ASSETS: AssetManifest = {
  version: 1,
  assets: [{ path: 'drawable-mdpi/logo.png', sha256: 'a'.repeat(64) }],
};
const CAPTURED_ASSETS: AssetManifest = {
  version: 1,
  assets: [{ path: 'drawable-mdpi/logo.png', sha256: 'e'.repeat(64) }],
};

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rn-iso-home-'));
  process.env.RN_ISO_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'rn-iso-android-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', scripts: { android: 'react-native run-android' } }),
  );
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

const never = (what: string) => () => {
  throw new Error(`${what} must not run in this case`);
};

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: Record<string, unknown>;
  unrefed?: boolean;
}

// The read-shapes below are the SUBSET of each seam's real argument object that
// the assertions read back. The production interfaces (which have no index
// signature) are assignable to these subsets, so they double as the mock
// parameter types.
interface AcquireLockArgs {
  platform?: string;
  key?: string;
  root?: string | null;
  logFile?: string | null;
}
interface BuildArgs {
  root?: string;
  logWriter?: unknown;
  variant?: string | null;
}
interface InstallArgs {
  apkPath?: string | null;
  packageName?: string | null;
  allowUninstall?: boolean;
}
interface SwapArgs {
  root?: string;
  isExpo?: boolean;
  cachedApkPath?: string;
  keystore?: { path?: string; pass?: string };
  storedAssets?: AssetManifest | null;
}
interface LaunchArgs {
  metroPort?: string | number;
  devClientScheme?: string | null;
  packageName?: string;
}
interface RemoteBuildArgs {
  platform?: string | null;
  fingerprintHash?: string | null;
  projectRoot?: string | null;
  runOptions?: Record<string, unknown> | null;
}
interface UploadArgs {
  buildPath?: string | null;
  fingerprintHash?: string | null;
  runOptions?: Record<string, unknown> | null;
}
interface EasAuthArgs {
  owner?: string | null;
  projectRoot?: string | null;
}
interface VerifyArgs {
  logsDir?: string;
  since?: string | number;
}

interface Calls {
  ensureDevice: unknown[];
  booted: unknown[];
  metro: unknown[][];
  fingerprint: unknown[];
  resolveCached: unknown[][];
  storeCached: unknown[][];
  storedAssets: unknown[][];
  captureAssets: unknown[][];
  prebuild: unknown[][];
  build: BuildArgs[];
  install: InstallArgs[];
  launch: LaunchArgs[];
  launchRelease: LaunchArgs[];
  verifyRelease: unknown[];
  swapApk: SwapArgs[];
  scheme: unknown[][];
  spawn: SpawnCall[];
  kill: unknown[][];
  loadProvider: unknown[][];
  resolveRemoteBuild: RemoteBuildArgs[];
  uploadRemoteBuild: UploadArgs[];
  easAuth: EasAuthArgs[];
  acquireLock: AcquireLockArgs[];
  releaseLock: unknown[];
  waitForBuild: unknown[];
  verify: VerifyArgs[];
  ensureIgnored: unknown[];
  readApkPackage: unknown[];
  order: string[];
}

function harness(overrides = {}) {
  const calls: Calls = {
    ensureDevice: [],
    booted: [],
    metro: [],
    fingerprint: [],
    resolveCached: [],
    storeCached: [],
    storedAssets: [],
    captureAssets: [],
    prebuild: [],
    build: [],
    install: [],
    launch: [],
    launchRelease: [],
    verifyRelease: [],
    swapApk: [],
    scheme: [],
    spawn: [],
    kill: [],
    loadProvider: [],
    resolveRemoteBuild: [],
    uploadRemoteBuild: [],
    easAuth: [],
    acquireLock: [],
    releaseLock: [],
    waitForBuild: [],
    verify: [],
    ensureIgnored: [],
    readApkPackage: [],
    // The sequence of the steps that decide who compiles, which is what the
    // single-flight tests below are actually about.
    order: [],
  };
  const stderr: string[] = [];
  const stdout: string[] = [];
  const options = {
    root,
    ensureDevice: async (args: unknown = {}) => {
      calls.ensureDevice.push(args);
      return { avdName: 'rn-iso-app-412', consolePort: 5584, owned: true };
    },
    ensureDeviceBooted: async (args: unknown = {}) => {
      calls.booted.push(args);
      return { ok: true, serial: 'emulator-5584' };
    },
    resolveMetro: async (port: number, path: string) => {
      calls.metro.push([port, path]);
      return { metro: { pid: 41233, leader: 41233, cwd: root } };
    },
    fingerprint: async (path: string) => {
      calls.fingerprint.push(path);
      return { hash: FINGERPRINT, sources: [] };
    },
    resolveCached: (platform: string, key: string) => {
      calls.order.push('resolveCached');
      calls.resolveCached.push([platform, key]);
      return null;
    },
    // THE ASSET GATE's stored side. The default is a real manifest, which is
    // what makes the default release cache hit swap; a test that wants the
    // manifest-less entry overrides it with () => null.
    storedAssets: (platform: string, key: string) => {
      calls.order.push('storedAssets');
      calls.storedAssets.push([platform, key]);
      return STORED_ASSETS;
    },
    captureAssets: (projectRoot: string, opts: unknown = {}) => {
      calls.order.push('captureAssets');
      calls.captureAssets.push([projectRoot, opts]);
      return CAPTURED_ASSETS;
    },
    storeCached: (platform: string, key: string, path: string, opts: unknown = {}) => {
      calls.order.push('storeCached');
      calls.storeCached.push([platform, key, path, opts]);
      return path;
    },
    // Level two. The default is the ordinary case: no provider configured, so
    // nothing is asked and nothing is called.
    loadProvider: async (projectRoot: string, opts: Record<string, unknown> = {}) => {
      calls.loadProvider.push([projectRoot, opts]);
      return { none: true as const };
    },
    // Never the real one: it shells out to `eas whoami`, which is a network
    // call. The EAS-session tests override it with the state they are about.
    easAuth: (args: EasAuthArgs = {}) => {
      calls.easAuth.push(args);
      return { ok: true as const, account: 'janic' };
    },
    resolveRemoteBuild: async (args: RemoteBuildArgs = {}) => {
      calls.order.push('resolveRemoteBuild');
      calls.resolveRemoteBuild.push(args);
      return null;
    },
    // Single flight. The default is the ordinary case: nothing else on this
    // machine is building this fingerprint, so this run is the one builder.
    acquireLock: (args: AcquireLockArgs = {}) => {
      calls.order.push('acquireLock');
      calls.acquireLock.push(args);
      return {
        acquired: true as const,
        path: join(home, 'build-locks', 'android-k.lock'),
        lock: {
          pid: process.pid,
          projectRoot: root,
          startedAt: new Date().toISOString(),
          logFile: join(home, 'build-locks', 'android-k.log'),
        },
      };
    },
    releaseLock: (handle: unknown) => {
      calls.order.push('releaseLock');
      calls.releaseLock.push(handle);
      return true;
    },
    waitForBuild: async (args: unknown) => {
      calls.waitForBuild.push(args);
      throw new Error('nothing should be waited for unless the lock was held');
    },
    uploadRemoteBuild: async (args: UploadArgs = {}) => {
      calls.uploadRemoteBuild.push(args);
      return { uploaded: true as const };
    },
    prebuild: async (...args: unknown[]) => {
      calls.prebuild.push(args);
      return { ok: true, durationMs: 12000, nativeDir: join(root, 'android') };
    },
    build: async (args: BuildArgs = {}) => {
      calls.order.push('build');
      calls.build.push(args);
      return { ok: true, apkPath: fakeApk(), durationMs: 161000, lastLines: [] };
    },
    install: (args: InstallArgs = {}) => {
      calls.install.push(args);
      return { ok: true, apkPath: args.apkPath ?? '' };
    },
    // The default is what launchAndroidApp returns for a project with no
    // dev-client scheme: the launcher activity, both port mechanisms in
    // place. The dev-client shape has its own tests below.
    launch: (args: LaunchArgs = {}) => {
      calls.launch.push(args);
      return {
        ok: true,
        mode: 'am-start',
        component: 'com.example.app/.MainActivity',
        devClientNote: null,
        reversed: ['tcp:8081->tcp:8082', 'tcp:8082->tcp:8082'],
        debugHttpHost: '10.0.2.2:8082',
        debugHttpHostNote: null,
      };
    },
    // Release-only seams; a debug run must never reach any of them. The
    // defaults are the ordinary release case: the swap succeeded, the app
    // started, its process is alive.
    launchRelease: (args: LaunchArgs = {}) => {
      calls.order.push('launchRelease');
      calls.launchRelease.push(args);
      return { ok: true, mode: 'am-start', component: 'com.example.app/.MainActivity' };
    },
    verifyReleaseLaunched: async (args: unknown = {}) => {
      calls.order.push('verifyReleaseLaunched');
      calls.verifyRelease.push(args);
      return { verified: true, waitedMs: 3000, pid: 4242 };
    },
    swapApk: async (args: SwapArgs = {}) => {
      calls.order.push('swapApk');
      calls.swapApk.push(args);
      return {
        ok: true,
        apkPath: join(root, 'apk-swap', 'app-production-release.apk'),
        tmpDir: join(root, 'apk-swap'),
        hermes: true,
        durationMs: 4100,
      };
    },
    // Reading the scheme out of the APK shells out to aapt; the resolver has
    // its own tests (against a real dump), so the flow injects the answer.
    resolveDevClientScheme: (projectRoot: string, apkPath: unknown) => {
      calls.scheme.push([projectRoot, apkPath]);
      return undefined;
    },
    // Same reason: apkPackage(dumpApkManifest(..)) shells out to aapt. Null is
    // "the APK could not be read", which falls back to project detection.
    readApkPackage: (apkPath: string | null) => {
      calls.readApkPackage.push(apkPath);
      return null;
    },
    spawn: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
      calls.spawn.push({ cmd, args, opts });
      return makeChildProcess({
        pid: 9001,
        unref: () => {
          const last = calls.spawn.at(-1);
          if (last) last.unrefed = true;
          return makeChildProcess();
        },
      });
    },
    kill: (pid: number, signal: NodeJS.Signals) => {
      calls.kill.push([pid, signal]);
      return true;
    },
    // The retry is real (one test below is about it); only the sleep is
    // removed, so a refusal costs no wall time.
    resolveMetroRetrying: (
      resolve: Parameters<typeof resolveMetroWithRetry>[0],
      port: Parameters<typeof resolveMetroWithRetry>[1],
      path: Parameters<typeof resolveMetroWithRetry>[2],
      opts: Parameters<typeof resolveMetroWithRetry>[3],
    ) => resolveMetroWithRetry(resolve, port, path, { ...opts, sleep: async () => {} }),
    // The default is a launch that verified -- the app fetched a bundle from
    // THIS workspace's Metro. The picker case has its own tests.
    verifyLaunched: async (args: VerifyArgs = {}) => {
      calls.verify.push(args);
      return { verified: true, waitedMs: 3100, timedOut: false, mode: null };
    },
    ensureIgnored: async (dir: string) => {
      calls.ensureIgnored.push(dir);
    },
    out: (line: string) => stderr.push(line),
    emit: (line: string) => stdout.push(line),
    ...overrides,
  };
  return { calls, stderr, stdout, run: () => runAndroid(options) };
}

const labelled = (lines: string[], label: string) => lines.filter((l) => l.startsWith(`  ${label}`));
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

    expect(result.ok).toBe(true);
    expect(h.calls.install[0]?.apkPath).toBe(cached);
    assert(result.facts);
    expect(result.facts.cacheHit).toBe('local');
    expect(result.facts.appPath).toBe(cached);
    expect(labelled(h.stderr, 'fingerprint')[0]).toMatch(/a3f9b1\.\. hit/);
    expect(labelled(h.stderr, 'install')[0]).toMatch(/from local cache/);
    expect(labelled(h.stderr, 'build').length).toBe(0);
  });

  test("prints the phases the spec's worked example prints, and one line on stdout", async () => {
    const h = harness({ resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    await h.run();

    expect(labelled(h.stderr, 'device')[0]).toMatch(/rn-iso-app-412 \(emulator-5584\) booted/);
    expect(labelled(h.stderr, 'metro')[0]).toMatch(/port 8082 \(pid 41233\)/);
    expect(labelled(h.stderr, 'launch')[0]).toMatch(/com\.example\.app/);
    expect(labelled(h.stderr, 'logs')[0]).toMatch(/collector pid 9001/);
    // Every timed phase line carries its own duration, in formatDuration's
    // shape ("4s", "1m4s"), at the end of the line.
    expect(labelled(h.stderr, 'fingerprint')[0]).toMatch(/\(\d+m?\d*s\)$/);
    expect(labelled(h.stderr, 'device')[0]).toMatch(/booted \(\d+m?\d*s\)$/);
    expect(labelled(h.stderr, 'install')[0]).toMatch(/from local cache \(\d+m?\d*s\)$/);
    expect(labelled(h.stderr, 'launch')[0]).toMatch(/\(\d+m?\d*s\)$/);
    // Output discipline: everything above is stderr, and stdout carries the
    // single outcome line an agent reads.
    expect(h.stdout.length).toBe(1);
    expect(h.stdout[0]).toMatch(/OK: com\.example\.app launched on emulator-5584/);
    expect(h.stderr.length <= 9).toBeTruthy();
  });

  test('--json puts the facts on stdout and nothing else', async () => {
    const h = harness({ json: true, resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    const result = await h.run();
    expect(h.stdout.length).toBe(1);
    const stdout0 = h.stdout[0];
    assert(stdout0);
    expect(JSON.parse(stdout0)).toEqual({
      platform: 'android',
      serial: 'emulator-5584',
      avdName: 'rn-iso-app-412',
      deviceName: 'rn-iso-app-412',
      fingerprint: FINGERPRINT,
      // Payload parity with the iOS one, which has carried the key since it
      // shipped: this is what addresses the entry the run hit or stored.
      cacheKey: CACHE_KEY,
      variant: null,
      metroPort: 8082,
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
    assert(result.facts);
    expect(JSON.parse(stdout0)).toEqual(result.facts);
  });
});

describe('a cache miss', () => {
  test('builds, stores the result under the fingerprint key, and installs what it built', async () => {
    const h = harness();
    const result = await h.run();

    expect(result.ok).toBe(true);
    expect(h.calls.build.length).toBe(1);
    expect(h.calls.build[0]?.root).toBe(root);
    expect(h.calls.build[0]?.logWriter).toBeTruthy();
    expect(h.calls.storeCached[0]?.slice(0, 2)).toEqual(['android', CACHE_KEY]);
    expect(h.calls.install[0]?.apkPath).toBe(h.calls.storeCached[0]?.[2]);
    expect(labelled(h.stderr, 'fingerprint')[0]).toMatch(/miss/);
    expect(labelled(h.stderr, 'build')[0]).toMatch(/app-debug\.apk \(2m41s\)/);
    assert(result.facts);
    expect(result.facts.cacheHit).toBe(false);
  });

  test('a cache that cannot be written is a warning, not a failed run', async () => {
    const h = harness({
      storeCached: () => {
        throw new Error('disk full');
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(labelled(h.stderr, 'cache')[0]).toMatch(/disk full/);
  });

  test('an Expo project with no android/ prebuilds first, then builds', async () => {
    rmSync(join(root, 'android'), { recursive: true, force: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '54.0.0' } }));
    writeFileSync(
      join(root, 'app.json'),
      JSON.stringify({ expo: { name: 'app', android: { package: 'com.example.app' } } }),
    );
    const order: string[] = [];
    const h = harness({
      prebuild: async (..._args: unknown[]) => {
        order.push('prebuild');
        return { ok: true, durationMs: 12000 };
      },
      build: async () => {
        order.push('build');
        return { ok: true, apkPath: fakeApk(), durationMs: 1000 };
      },
    });
    const result = await h.run();

    expect(result.ok).toBe(true);
    expect(order).toEqual(['prebuild', 'build']);
    expect(labelled(h.stderr, 'prebuild')[0]).toMatch(/android\/ generated \(12\.0s\)/);
  });

  test('a bare project that already has android/ never prebuilds', async () => {
    const h = harness({ prebuild: never('prebuild') });
    expect((await h.run()).ok).toBe(true);
  });
});

describe('product flavors (--variant / android.variant)', () => {
  const FLAVORED_KEY = `${FINGERPRINT}-productiondebug-sim`;

  function flavoredApk() {
    const dir = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'production', 'debug');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'app-production-debug.apk');
    writeFileSync(path, 'apk');
    return path;
  }

  test('the android.variant setting drives the build variant, the flavored APK and a variant-scoped cache key', async () => {
    setProjectSetting(root, 'android.variant', 'productionDebug');
    const h = harness({
      build: async (args: BuildArgs = {}) => {
        h.calls.build.push(args);
        return { ok: true, apkPath: flavoredApk(), durationMs: 494000, lastLines: [] };
      },
    });
    const result = await h.run();

    expect(result.ok).toBe(true);
    // The variant reaches the gradle engine (which turns it into
    // assembleProductionDebug -- engine-gradle.test.ts pins that), and the APK
    // installed is the flavor's.
    expect(h.calls.build[0]?.variant).toBe('productionDebug');
    expect(h.calls.install[0]?.apkPath).toMatch(/apk\/production\/debug\/app-production-debug\.apk$/);
    // The cache key carries the variant, so productionDebug and plain debug
    // never share an entry.
    expect(h.calls.resolveCached[0]).toEqual(['android', FLAVORED_KEY]);
    expect(h.calls.storeCached[0]?.slice(0, 2)).toEqual(['android', FLAVORED_KEY]);
    expect(FLAVORED_KEY).not.toBe(CACHE_KEY);
    assert(result.facts);
    expect(result.facts.variant).toBe('productionDebug');
  });

  test('the --variant flag beats the android.variant setting', async () => {
    setProjectSetting(root, 'android.variant', 'previewDebug');
    const h = harness({ variant: 'productionDebug' });
    const result = await h.run();
    expect(h.calls.build[0]?.variant).toBe('productionDebug');
    expect(h.calls.resolveCached[0]).toEqual(['android', FLAVORED_KEY]);
    assert(result.facts);
    expect(result.facts.variant).toBe('productionDebug');
  });

  test('unset, the key and the payload are exactly the old defaults', async () => {
    const h = harness();
    const result = await h.run();
    expect(h.calls.build[0]?.variant).toBe(null);
    expect(h.calls.resolveCached[0]).toEqual(['android', CACHE_KEY]);
    assert(result.facts);
    expect(result.facts.variant).toBe(null);
  });

  test("a variant reaches the provider's runOptions, so a flavored resolve is never answered with plain debug", async () => {
    setProjectSetting(root, 'android.variant', 'productionDebug');
    const h = harness({
      loadProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
      resolveRemoteBuild: async (args: RemoteBuildArgs = {}) => {
        h.calls.resolveRemoteBuild.push(args);
        return null;
      },
    });
    await h.run();
    expect(h.calls.resolveRemoteBuild[0]?.runOptions).toEqual({ variant: 'productionDebug' });
    expect(h.calls.uploadRemoteBuild[0]?.runOptions).toEqual({ variant: 'productionDebug' });
  });
});

describe('the applicationId comes from the built APK', () => {
  test('the APK is authoritative when it answers, even when project detection disagrees', async () => {
    // build.gradle says com.example.app (the base applicationId); the flavor
    // that was actually built and installed is io.tlon.groups.
    const h = harness({ readApkPackage: () => 'io.tlon.groups' });
    const result = await h.run();

    expect(result.ok).toBe(true);
    // The launch (and through it the run-as debug_http_host write and the
    // monkey remedy, which engine/app-install derives from packageName) all
    // target the package that is actually on the device.
    expect(h.calls.launch[0]?.packageName).toBe('io.tlon.groups');
    assert(result.facts);
    expect(result.facts.bundleId).toBe('io.tlon.groups');
    expect(h.stdout[0]).toMatch(/io\.tlon\.groups/);
    // The disagreement is said out loud, once.
    expect(h.stderr.join('\n')).toMatch(/io\.tlon\.groups \(from the APK; project files say com\.example\.app\)/);
  });

  test('an unreadable APK falls back to project detection', async () => {
    const h = harness();
    const result = await h.run();
    expect(h.calls.readApkPackage.length).toBe(1);
    expect(h.calls.launch[0]?.packageName).toBe('com.example.app');
    assert(result.facts);
    expect(result.facts.bundleId).toBe('com.example.app');
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

    expect(result.ok).toBe(false);
    assert(result.error);
    expect(result.error.code).toBe(NO_METRO);
    expect(result.error.message).toMatch(/port 8082/);
    expect(result.error.remedy).toMatch(/rn-iso start/);
    expect(result.error.remedy).toMatch(/--no-metro-check/);
    expect(h.stderr.at(-2)).toMatch(/RN_ISO_NO_METRO/);
    // Nothing was built, so there is nothing to record.
    expect(existsSync(workspaceStateFile(root))).toBe(false);
  });

  test('a foreign holder of the port is named rather than built against', async () => {
    const h = harness({
      resolveMetro: async () => ({ notOurs: 'pid 900 runs from /elsewhere', kind: 'foreign-cwd' }),
      build: never('the build'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_METRO);
    expect(result.error.message).toMatch(/pid 900 runs from \/elsewhere/);
  });

  // Same race as iOS: `start` returns at listening, and a bare Metro then
  // blocks its event loop crawling a monorepo's file map for ~20s.
  test('an indexing Metro is retried rather than refused', async () => {
    let attempts = 0;
    const h = harness({
      resolveMetro: async () => {
        attempts += 1;
        if (attempts < 3)
          return { notOurs: "pid 42 on port 8082 does not answer Metro's /status", kind: 'unresponsive' };
        return { metro: { pid: 42, leader: 42, cwd: root } };
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  test('a refusal names our own supervisor when there is a record for this port', async () => {
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port: 8082, mode: 'bare-inproc', startedAt: 'now' } });
    const h = harness({
      resolveMetro: async () => ({
        notOurs: "pid 4242 on port 8082 does not answer Metro's /status",
        kind: 'unresponsive',
      }),
      build: never('the build'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_METRO);
    expect(result.error.message).toMatch(/A supervisor record exists for port 8082/);
    expect(result.error.message).toMatch(/still be indexing/);
    expect(result.error.remedy).toMatch(/--wait/);
  });

  test('no reservation at all is the same refusal', async () => {
    upsertProject(root, { metroPort: null });
    const h = harness({ resolveMetro: never('the metro probe'), build: never('the build') });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_METRO);
    expect(result.error.message).toMatch(/No Metro port is reserved/);
  });

  test('--no-metro-check proceeds without probing anything', async () => {
    const h = harness({ metroCheck: false, resolveMetro: never('the metro probe') });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(labelled(h.stderr, 'metro')[0]).toMatch(/not checked/);
    // The reservation is still what the app is wired to.
    expect(h.calls.launch[0]?.metroPort).toBe(8082);
  });

  test('in --json mode a refusal is the error contract, on stdout, alone', async () => {
    const h = harness({ json: true, resolveMetro: async () => ({ missing: true }), build: never('the build') });
    await h.run();
    expect(h.stdout.length).toBe(1);
    const stdout0 = h.stdout[0];
    assert(stdout0);
    const payload = JSON.parse(stdout0);
    expect(payload.code).toBe(NO_METRO);
    expect(payload.message && payload.remedy).toBeTruthy();
  });
});

describe('the other refusals', () => {
  test('an unresolvable @expo/fingerprint names the package to install', async () => {
    const h = harness({
      fingerprint: async () => null,
      resolveCached: never('the cache lookup'),
      build: never('the build'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_FINGERPRINT);
    expect(result.error.remedy).toMatch(/npm i -D @expo\/fingerprint/);
  });

  test('a fingerprint that throws is reported, not propagated', async () => {
    const h = harness({
      fingerprint: async () => {
        throw new Error('bad app.json');
      },
      build: never('the build'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_FINGERPRINT);
    expect(result.error.message).toMatch(/bad app\.json/);
  });

  // Boot runs BESIDE the fingerprint/cache/build work now (gradle needs no
  // device), so the refusal surfaces at install -- after the build has run
  // and been stored for the retry -- not ahead of it.
  test('a device that cannot be booted refuses with RN_ISO_NO_DEVICE, after the build', async () => {
    const h = harness({
      ensureDeviceBooted: async () => ({ failed: true, reason: 'AVD rn-iso-app-412 no longer exists.' }),
      install: never('the install'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_DEVICE);
    expect(result.error.message).toMatch(/no longer exists/);
  });

  test('a prebuild failure carries its own code and transcript tail', async () => {
    const h = harness({
      needsPrebuildFor: () => true,
      prebuild: async () => ({
        failed: true,
        code: PREBUILD_ERROR,
        reason: 'expo prebuild failed (exit code 1).',
        remedy: 'Run npm install.',
        lastLines: ['boom'],
      }),
      build: never('the build'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(PREBUILD_ERROR);
    expect(h.stderr.some((l) => /boom/.test(l))).toBeTruthy();
    expect(readState().lastBuild.status).toBe('failed');
    expect(readState().lastBuild.errorCode).toBe(PREBUILD_ERROR);
  });

  test('an install failure is reported with the device in the remedy', async () => {
    const h = harness({
      install: () => ({
        failed: true,
        code: 'RN_ISO_INSTALL_FAILED',
        reason: 'adb install failed: INSTALL_FAILED_INSUFFICIENT_STORAGE',
      }),
      launch: never('the launch'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe('RN_ISO_INSTALL_FAILED');
    expect(result.error.remedy).toMatch(/emulator-5584/);
    expect(readState().lastBuild.errorCode).toBe('RN_ISO_INSTALL_FAILED');
  });

  test('a launch failure is reported after a successful install', async () => {
    const h = harness({ launch: () => ({ failed: true, code: 'RN_ISO_LAUNCH_FAILED', reason: 'am start failed' }) });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe('RN_ISO_LAUNCH_FAILED');
    expect(readState().lastBuild.status).toBe('failed');
  });
});

describe('a failed build', () => {
  const failingBuild = async () => ({
    failed: true,
    code: BUILD_ERROR,
    reason: '`./gradlew assembleDebug` failed (exit code 1).',
    diagnostics: [
      { message: 'Task :app:compileDebugKotlin FAILED' },
      {
        file: '/p/android/app/src/main/java/com/app/MainActivity.kt',
        line: 23,
        column: 9,
        message: "Unresolved reference 'Foo'.",
      },
    ],
    truncated: 3,
    lastLines: ['> Task :app:compileDebugKotlin FAILED', 'BUILD FAILED in 2m41s'],
    durationMs: 161000,
  });

  test('prints the extracted diagnostic and the log path, never the transcript', async () => {
    const h = harness({ build: failingBuild, install: never('the install') });
    const result = await h.run();

    expect(result.ok).toBe(false);
    assert(result.error);
    expect(result.error.code).toBe(BUILD_ERROR);
    expect(labelled(h.stderr, 'build')[0]).toMatch(/FAILED after 2m41s/);
    const errors = labelled(h.stderr, 'error');
    expect(errors.some((l) => /MainActivity\.kt:23:9: Unresolved reference 'Foo'\./.test(l))).toBeTruthy();
    expect(errors.some((l) => /and 3 more diagnostic/.test(l))).toBeTruthy();
    // The spec's shape: the log path relative to the workspace, not absolute.
    expect(labelled(h.stderr, 'log')[0]).toMatch(/^ {2}log {9}\.rn-iso\/logs\/build-android\.ndjson$/);
  });

  test('falls back to the last transcript lines when nothing could be extracted', async () => {
    const h = harness({
      build: async () => ({ ...(await failingBuild()), diagnostics: [], truncated: 0 }),
      install: never('the install'),
    });
    await h.run();
    expect(h.stderr.some((l) => /BUILD FAILED in 2m41s/.test(l))).toBeTruthy();
    expect(labelled(h.stderr, 'log')[0]).toMatch(/build-android\.ndjson/);
  });

  test('writes the diagnostics into the build log as level error', async () => {
    const h = harness({ build: failingBuild, install: never('the install') });
    await h.run();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    const errors = records.filter((r) => r.level === 'error');
    expect(errors.length).toBe(2);
    expect(errors[0]?.src).toBe('build');
    expect(errors[1]?.msg).toMatch(/MainActivity\.kt:23:9/);
  });

  test('records lastBuild as failed, with the code and what it knew', async () => {
    const h = harness({ build: failingBuild, install: never('the install') });
    await h.run();
    const { lastBuild } = readState();
    expect(lastBuild.status).toBe('failed');
    expect(lastBuild.errorCode).toBe(BUILD_ERROR);
    expect(lastBuild.platform).toBe('android');
    expect(lastBuild.fingerprint).toBe(FINGERPRINT);
    expect(lastBuild.cacheKey).toBe(CACHE_KEY);
    expect(lastBuild.cacheHit).toBe(false);
    expect(lastBuild.appPath).toBe(null);
    expect(typeof lastBuild.startedAt === 'string').toBeTruthy();
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
    expect(h.calls.loadProvider.length).toBe(0);
    expect(h.calls.resolveRemoteBuild.length).toBe(0);
  });

  test('a bare RN project never has its config read: the community CLI has no provider concept', async () => {
    // The fixture package.json's `android` script is `react-native run-android`,
    // which is what detectIsExpo reads.
    const h = harness();
    await h.run();
    expect(h.calls.loadProvider[0]?.[1]).toEqual({ isExpo: false });
    expect(h.calls.resolveRemoteBuild.length).toBe(0);
  });

  test('an Expo project with no provider configured builds exactly as before', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'app',
        scripts: { ios: 'expo run:ios' },
        dependencies: { expo: '54.0.0' },
      }),
    );
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: 'app' } }));
    const h = harness();
    const result = await h.run();
    expect(h.calls.loadProvider[0]?.[1]).toEqual({ isExpo: true });
    expect(result.ok).toBe(true);
    expect(h.calls.resolveRemoteBuild.length).toBe(0);
    expect(h.calls.uploadRemoteBuild.length).toBe(0);
    expect(labelled(h.stderr, 'cache').length).toBe(0);
  });

  test('a remote HIT is stored into the local cache and installed, without building', async () => {
    const downloaded = '/tmp/eas-download/app-debug.apk';
    const stored = join(home, 'build-cache', 'android', CACHE_KEY, 'app-debug.apk');
    const h = harness({
      loadProvider: async () => provider(),
      resolveRemoteBuild: async () => ({ appPath: downloaded }),
      storeCached: (platform: string, key: string, path: string, opts: unknown) => {
        h_calls.push([platform, key, path, opts]);
        return stored;
      },
      build: never('the build'),
      prebuild: never('prebuild'),
    });
    const h_calls: unknown[][] = [];
    const result = await h.run();

    expect(result.ok).toBe(true);
    expect(h_calls[0]?.slice(0, 3)).toEqual(['android', CACHE_KEY, downloaded]);
    expect(h.calls.install[0]?.apkPath).toBe(stored);
    assert(result.facts);
    expect(result.facts.cacheHit).toBe('remote');
    expect(labelled(h.stderr, 'cache')[0]).toMatch(/remote hit \(eas\) -> stored locally/);
    expect(readState().lastBuild.cacheHit).toBe('remote');
  });

  test("the provider is asked with this workspace's fingerprint and platform", async () => {
    const h = harness({ loadProvider: async () => provider('./p.cjs') });
    await h.run();
    expect(h.calls.resolveRemoteBuild[0]?.platform).toBe('android');
    expect(h.calls.resolveRemoteBuild[0]?.fingerprintHash).toBe(FINGERPRINT);
    expect(h.calls.resolveRemoteBuild[0]?.projectRoot).toBe(root);
  });

  test('a remote MISS builds, stores locally, and uploads the result', async () => {
    const h = harness({ loadProvider: async () => provider() });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.build.length).toBe(1);
    expect(h.calls.storeCached.length).toBe(1);
    expect(h.calls.uploadRemoteBuild[0]?.buildPath).toBe(h.calls.storeCached[0]?.[2]);
    expect(h.calls.uploadRemoteBuild[0]?.fingerprintHash).toBe(FINGERPRINT);
    expect(labelled(h.stderr, 'cache').at(-1)).toMatch(/uploaded \(eas\)/);
  });

  test('a provider that THROWS degrades to a local-only run with a note', async () => {
    const h = harness({
      loadProvider: async () => provider(),
      resolveRemoteBuild: async () => ({ failed: 'EAS session expired' }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.build.length).toBe(1);
    expect(labelled(h.stderr, 'cache')[0]).toMatch(/EAS session expired.*building instead/);
  });

  test('a provider that TIMES OUT does not stall the loop, and the command stops holding the process open', async () => {
    const exits: Array<string | number | null | undefined> = [];
    const originalExit = process.exit;
    process.exit = asProcessExit((code) => {
      exits.push(code);
    });
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
    expect(h.calls.build.length).toBe(1);
    expect(labelled(h.stderr, 'cache')[0]).toMatch(/did not answer within 30\.0s; building instead/);
    expect(exits).toEqual([0]);
  });

  test('a provider that cannot be loaded says so ONCE and builds', async () => {
    const h = harness({
      loadProvider: async () => ({ unavailable: 'the EAS build cache needs the `eas-build-cache-provider` package' }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.resolveRemoteBuild.length).toBe(0);
    expect(h.calls.build.length).toBe(1);
    const lines = h.stderr.filter((l) => /provider not usable/.test(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/eas-build-cache-provider/);
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
    expect(result.ok).toBe(true);
    expect(h.calls.build.length).toBe(1);
    const lines = h.stderr.filter((l) => /eas is not authenticated/.test(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/eas login/);
    expect(lines[0]).toMatch(/EXPO_TOKEN/);
    expect(lines[0]).toMatch(/local cache only/);
  });

  test('the session is checked with the owner the config named, and only once', async () => {
    const h = harness({
      loadProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
    });
    await h.run();
    expect(h.calls.easAuth.length).toBe(1);
    expect(h.calls.easAuth[0]?.owner).toBe('th3rd-wave');
    expect(h.calls.easAuth[0]?.projectRoot).toBe(root);
  });

  test('a custom provider is never asked about EAS at all', async () => {
    const h = harness({ loadProvider: async () => provider('./p.cjs') });
    await h.run();
    expect(h.calls.easAuth.length).toBe(0);
    expect(h.calls.resolveRemoteBuild.length).toBe(1);
  });

  test('a session that could not be established changes nothing', async () => {
    const h = harness({
      loadProvider: async () => provider(),
      easAuth: () => ({ unknown: 'eas whoami timed out after 15000ms' }),
    });
    await h.run();
    expect(h.calls.resolveRemoteBuild.length).toBe(1);
    expect(!h.stderr.some((l) => /not authenticated/.test(l))).toBeTruthy();
  });

  test('a session on the wrong account warns, naming both, and still consults the cache', async () => {
    const h = harness({
      loadProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
      easAuth: () => ({ failed: true, code: 'wrong-account', account: 'janic', owner: 'th3rd-wave' }),
    });
    await h.run();
    expect(h.calls.resolveRemoteBuild.length).toBe(1);
    const line = h.stderr.find((l) => /janic/.test(l));
    expect(line).toMatch(/th3rd-wave/);
    expect(line).toMatch(/anyway/);
  });

  test('a provider failure that reads as auth gets the auth note, not the generic one', async () => {
    const h = harness({
      loadProvider: async () => provider(),
      easAuth: () => ({ unknown: 'offline' }),
      resolveRemoteBuild: async () => ({ failed: 'Error: Not logged in' }),
    });
    await h.run();
    expect(labelled(h.stderr, 'cache')[0]).toMatch(/eas is not authenticated \(Error: Not logged in\)/);
    expect(!h.stderr.some((l) => /could not be used/.test(l))).toBeTruthy();
  });

  test('a failed upload is a note, never a failed run', async () => {
    const h = harness({
      loadProvider: async () => provider(),
      uploadRemoteBuild: async () => ({ failed: '403 forbidden' }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.stdout.length).toBe(1);
    expect(labelled(h.stderr, 'cache').at(-1)).toMatch(/upload failed: 403 forbidden/);
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
    expect(result.ok).toBe(true);
    expect(h.calls.build.length).toBe(1);
    assert(result.facts);
    expect(result.facts.cacheHit).toBe(false);
    expect(result.facts.cacheSkipped).toBe(true);
    expect(labelled(h.stderr, 'fingerprint')[0]).toMatch(/miss \(--no-build-cache\)/);
  });

  // The whole reason to opt out is an entry you no longer trust. Keeping it
  // would mean the next run trusts it again.
  test('still STORES -- over the entry it was told not to trust -- and still uploads', async () => {
    const h = harness({
      useBuildCache: false,
      loadProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
    });
    await h.run();
    // A debug build emits no asset tree, so there is no manifest to record.
    expect(h.calls.storeCached[0]?.[3]).toEqual({ overwrite: true, sources: [], assetManifest: null });
    expect(h.calls.uploadRemoteBuild.length).toBe(1);
  });

  test('a default run stores without overwriting: two worktrees at the same fingerprint agree', async () => {
    const h = harness();
    await h.run();
    expect(h.calls.storeCached[0]?.[3]).toEqual({ overwrite: false, sources: [], assetManifest: null });
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
    held: {
      pid,
      projectRoot,
      startedAt: '2026-08-25T10:00:00.000Z',
      logFile: `${projectRoot}/.rn-iso/logs/build-android.ndjson`,
    },
    path: '/home/build-locks/android-key.lock',
  });

  test('the lock is attempted only after BOTH cache levels have missed, and released after the store', async () => {
    const h = harness({ loadProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }) });
    await h.run();
    expect(
      h.calls.order.filter((o) =>
        ['resolveCached', 'resolveRemoteBuild', 'acquireLock', 'build', 'storeCached', 'releaseLock'].includes(o),
      ),
    ).toEqual(['resolveCached', 'resolveRemoteBuild', 'acquireLock', 'build', 'storeCached', 'releaseLock']);
    expect(h.calls.acquireLock[0]?.platform).toBe('android');
    expect(h.calls.acquireLock[0]?.key).toBe(CACHE_KEY);
    expect(h.calls.acquireLock[0]?.root).toBe(root);
    expect(h.calls.acquireLock[0]?.logFile).toMatch(/build-android\.ndjson$/);
  });

  test('a cache hit at either level never takes the lock', async () => {
    const local = harness({ resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    await local.run();
    expect(local.calls.acquireLock.length).toBe(0);

    const remote = harness({
      loadProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
      resolveRemoteBuild: async () => ({ appPath: '/downloads/app-debug.apk' }),
      build: never('the build'),
    });
    await remote.run();
    expect(remote.calls.acquireLock.length).toBe(0);
  });

  test('--no-build-cache neither waits nor acquires', async () => {
    const h = harness({
      useBuildCache: false,
      acquireLock: never('the lock'),
      waitForBuild: never('the wait'),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.build.length).toBe(1);
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
    expect(result.ok).toBe(true);
    expect(h.calls.releaseLock.length).toBe(0);
    expect(h.calls.install[0]?.apkPath).toBe(waited);
    assert(result.facts);
    expect(result.facts.cacheHit).toBe('local');
    expect(result.facts.waitedForBuild).toEqual({ pid: 41233, ms: 761000 });
    expect(h.stderr.join('\n')).toMatch(/waited 12m41s for \/w\/app-999's build -> installed from cache/);
  });

  test('a run that did not wait reports waitedForBuild: null', async () => {
    const h = harness();
    const facts = (await h.run()).facts;
    assert(facts);
    expect(facts.waitedForBuild).toBe(null);
  });

  test('the wait is announced, and its progress reaches stderr as it happens', async () => {
    const h = harness({
      acquireLock: () => heldBy(),
      waitForBuild: async ({ out }: { out: (line: string) => void }) => {
        out('build       waiting on /w/app-999 (pid 41233, 4m elapsed) -- tail /w/app-999/x.ndjson');
        return { hit: '/cache/app-debug.apk', waitedMs: 240000 };
      },
    });
    await h.run();
    const err = h.stderr.join('\n');
    expect(err).toMatch(/\/w\/app-999 is already building/);
    expect(err).toMatch(/waiting on \/w\/app-999 \(pid 41233, 4m elapsed\)/);
    expect(h.stdout.length).toBe(1);
  });

  test('a builder that failed makes the waiter take over and build', async () => {
    let acquires = 0;
    const h = harness({
      acquireLock: () => (++acquires === 1 ? heldBy() : { acquired: true, path: '/lock', lock: { pid: process.pid } }),
      waitForBuild: async () => ({ builderFailed: 'the build lock was released without an artifact', waitedMs: 4000 }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(acquires).toBe(2);
    expect(h.calls.build.length).toBe(1);
    expect(h.calls.releaseLock.length).toBe(1);
    expect(h.stderr.join('\n')).toMatch(/without an artifact/);
  });

  test('losing the takeover race builds anyway rather than queueing again', async () => {
    let waits = 0;
    const h = harness({
      acquireLock: () => heldBy(),
      waitForBuild: async () => {
        waits++;
        return { builderFailed: 'the builder (pid 41233) is gone', waitedMs: 10 };
      },
    });
    expect((await h.run()).ok).toBe(true);
    expect(waits).toBe(1);
    expect(h.calls.releaseLock.length).toBe(0);
  });

  // A failed build that kept its lock would leave every other workspace on the
  // fingerprint waiting for an APK nobody is making.
  test('a FAILED build releases the lock', async () => {
    const h = harness({
      build: async () => ({
        failed: true,
        code: BUILD_ERROR,
        reason: 'gradle said no',
        diagnostics: [],
        lastLines: [],
      }),
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(h.calls.releaseLock.length).toBe(1);
  });

  test('a build that THROWS releases the lock on the way out', async () => {
    const h = harness({
      build: async () => {
        throw new Error('gradle exploded');
      },
    });
    await expect(() => h.run()).rejects.toThrow(/gradle exploded/);
    expect(h.calls.releaseLock.length).toBe(1);
  });

  test('a wait that hits its ceiling is a refusal with a code, not a crash', async () => {
    const h = harness({
      acquireLock: () => heldBy(),
      waitForBuild: async () => {
        throw makeError('Waited 90m ... The lock is /home/build-locks/android-key.lock', {
          code: 'RN_ISO_BUILD_WAIT_TIMEOUT',
          lockPath: '/home/build-locks/android-key.lock',
        });
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    assert(result.error);
    expect(result.error.code).toBe('RN_ISO_BUILD_WAIT_TIMEOUT');
    expect(h.calls.build.length).toBe(0);
  });

  // The lock is an optimisation, and one that cannot run must never stop a
  // build -- the same containment the cache store and the provider get.
  test('a lock that cannot be created is a note, and the build proceeds', async () => {
    const h = harness({
      acquireLock: () => {
        throw new Error('EROFS: read-only file system');
      },
    });
    expect((await h.run()).ok).toBe(true);
    expect(h.calls.build.length).toBe(1);
    expect(h.stderr.join('\n')).toMatch(/read-only file system/);
  });
});

// --- contracts 4, 5 and 1 --------------------------------------------------

describe('Contract 4: state.json.lastBuild', () => {
  test('is written on success with every field the contract names', async () => {
    const h = harness();
    const result = await h.run();
    const { lastBuild } = readState();
    expect(lastBuild.status).toBe('ok');
    expect(lastBuild.errorCode).toBe(undefined);
    expect(lastBuild.platform).toBe('android');
    expect(lastBuild.fingerprint).toBe(FINGERPRINT);
    expect(lastBuild.cacheKey).toBe(CACHE_KEY);
    expect(lastBuild.cacheHit).toBe(false);
    assert(result.facts);
    expect(lastBuild.appPath).toBe(result.facts.appPath);
    expect(lastBuild.bundleId).toBe('com.example.app');
    expect(Number.isFinite(lastBuild.durationMs)).toBeTruthy();
  });

  test('MERGES: the supervisor and collector keys survive the write', async () => {
    writeWorkspaceState(root, {
      supervisor: { pid: 41233, port: 8082, mode: 'bare-inproc', startedAt: 'then' },
      collectors: { ios: { pid: 777, startedAt: 'then' } },
    });
    await harness().run();
    const state = readState();
    expect(state.supervisor).toEqual({ pid: 41233, port: 8082, mode: 'bare-inproc', startedAt: 'then' });
    expect(state.collectors).toEqual({ ios: { pid: 777, startedAt: 'then' } });
    expect(state.lastBuild.status).toBe('ok');
  });

  test('a state file that cannot be written is a warning, not a failed run', async () => {
    const h = harness({
      writeState: () => {
        throw new Error('read-only volume');
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.stderr.some((l) => /read-only volume/.test(l))).toBeTruthy();
  });
});

describe('Contract 5: the device-log collector', () => {
  test("is spawned detached and unreferenced with this platform's identity", async () => {
    const h = harness();
    await h.run();
    expect(h.calls.spawn.length).toBe(1);
    const spawn0 = h.calls.spawn[0];
    assert(spawn0);
    const { args, opts, unrefed } = spawn0;
    expect(args[0]).toMatch(/collector\/run\.ts$/);
    expect(args.slice(1)).toEqual([
      '--platform',
      'android',
      '--root',
      root,
      '--serial',
      'emulator-5584',
      '--package',
      'com.example.app',
    ]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.cwd).toBe(root);
    expect(unrefed).toBe(true);
  });

  test('the previous android collector is killed first -- replaced, not duplicated', async () => {
    writeWorkspaceState(root, {
      collectors: { android: { pid: 4242, startedAt: 'then' }, ios: { pid: 777, startedAt: 'then' } },
    });
    const h = harness();
    await h.run();
    expect(h.calls.kill).toEqual([[4242, 'SIGTERM']]);
    expect(h.calls.spawn.length).toBe(1);
  });

  test('the ios collector is left alone', async () => {
    writeWorkspaceState(root, { collectors: { ios: { pid: 777, startedAt: 'then' } } });
    const h = harness();
    await h.run();
    expect(h.calls.kill).toEqual([]);
  });

  test('a collector that cannot be spawned does not fail the run', async () => {
    const h = harness({
      spawn: () => {
        throw new Error('EAGAIN');
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(labelled(h.stderr, 'logs')[0]).toMatch(/EAGAIN/);
  });
});

describe('Contract 1: the launch marker', () => {
  test('a launch writes a marker record into the build log', async () => {
    await harness().run();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    const marker = records.find((r) => r.marker === true);
    expect(marker).toBeTruthy();
    assert(marker);
    expect(marker.src).toBe('build');
    expect(marker.event).toBe('app_launched');
    expect(marker.msg).toMatch(/com\.example\.app on emulator-5584 against Metro port 8082/);
  });
});

// --- the pure parts --------------------------------------------------------

describe('the pure parts', () => {
  test('phaseLine lines the values up in one column', () => {
    expect(phaseLine('device', 'x')).toBe('  device      x');
    expect(phaseLine('fingerprint', 'x')).toBe('  fingerprint x');
  });

  test('displayPath shortens a workspace path and leaves a foreign one alone', () => {
    expect(displayPath(root, join(root, '.rn-iso', 'logs'))).toBe('.rn-iso/logs');
    expect(displayPath(root, '/elsewhere/build.ndjson')).toBe('/elsewhere/build.ndjson');
  });

  test('shortHash keeps the prefix an agent actually reads', () => {
    expect(shortHash(FINGERPRINT)).toBe('a3f9b1..');
    expect(shortHash('abc')).toBe('abc');
    expect(shortHash(null)).toBe('');
  });

  test('formatDuration reads at a glance', () => {
    expect(formatDuration(410)).toBe('410ms');
    expect(formatDuration(3100)).toBe('3.1s');
    expect(formatDuration(161000)).toBe('2m41s');
    expect(formatDuration(605000)).toBe('10m05s');
    expect(formatDuration(undefined)).toBe('unknown');
  });

  test('androidFacts and lastBuildRecord fill every field of their contracts', () => {
    expect(androidFacts({})).toEqual({
      platform: 'android',
      serial: null,
      avdName: null,
      deviceName: null,
      fingerprint: null,
      cacheKey: null,
      variant: null,
      metroPort: null,
      cacheHit: false,
      cacheSkipped: false,
      waitedForBuild: null,
      appPath: null,
      bundleId: null,
      launched: false,
      debugHttpHost: null,
      debugHttpHostNote: null,
      devClientUrl: null,
      logs: null,
    });
    expect(androidFacts({ variant: 'productionDebug' }).variant).toBe('productionDebug');
    // Payload parity with iOS: the key that addresses the cache entry.
    expect(androidFacts({ cacheKey: `${FINGERPRINT}-productionrelease-sim` }).cacheKey).toBe(
      `${FINGERPRINT}-productionrelease-sim`,
    );
    // A device tool is addressed by AVD name, not by console-port slot, and
    // deviceName falls back to it rather than being separately null.
    expect({
      avdName: androidFacts({ avdName: 'rn-iso-app-412' }).avdName,
      deviceName: androidFacts({ avdName: 'rn-iso-app-412' }).deviceName,
    }).toEqual({ avdName: 'rn-iso-app-412', deviceName: 'rn-iso-app-412' });
    // cacheHit is a LEVEL, not a boolean: 'local' | 'remote' | false.
    expect(androidFacts({ cacheHit: 'remote' }).cacheHit).toBe('remote');
    expect(androidFacts({ cacheHit: true }).cacheHit).toBe(false);
    // A wait is reported ALONGSIDE cacheHit: 'local', never instead of it: the
    // APK did come from the local cache, it just was not there yet when the
    // run started.
    expect(androidFacts({ cacheHit: 'local', waitedForBuild: { pid: 41233, ms: 761000 } }).waitedForBuild).toEqual({
      pid: 41233,
      ms: 761000,
    });
    const record = lastBuildRecord({ startedAt: 'now', status: 'ok' });
    expect(Object.keys(record)).toEqual([
      'platform',
      'avdName',
      'deviceName',
      'fingerprint',
      'cacheKey',
      'cacheHit',
      'cacheSkipped',
      'durationMs',
      'appPath',
      'bundleId',
      'startedAt',
      'status',
    ]);
    expect(lastBuildRecord({ startedAt: 'now', status: 'failed', errorCode: BUILD_ERROR }).errorCode).toBe(BUILD_ERROR);
  });

  test('killPreviousCollector signals a recorded pid and tolerates a dead one', () => {
    const signalled: Array<[number, NodeJS.Signals]> = [];
    expect(
      killPreviousCollector(root, {
        collectors: { android: { pid: 4242 } },
        kill: (pid, sig) => {
          signalled.push([pid, sig]);
          return true;
        },
      }),
    ).toBe(4242);
    expect(signalled).toEqual([[4242, 'SIGTERM']]);
    expect(
      killPreviousCollector(root, {
        collectors: { android: { pid: 4242 } },
        kill: () => {
          throw new Error('ESRCH');
        },
      }),
    ).toBe(null);
    expect(
      killPreviousCollector(root, {
        collectors: {},
        kill: () => {
          throw new Error('must not be called');
        },
      }),
    ).toBe(null);
    // Never our own pid: the collector helpers share this process in tests.
    expect(
      killPreviousCollector(root, {
        collectors: { android: { pid: process.pid } },
        kill: () => {
          throw new Error('must not be called');
        },
      }),
    ).toBe(null);
  });
});

// The launch is not the proof: an expo-dev-client app that opens its
// DEVELOPMENT SERVERS picker has fetched nothing, and `am start` returned 0
// all the same.
describe('launch verification', () => {
  test("a verified launch reports launched: true and polls this workspace's timeline", async () => {
    const h = harness();
    const result = await h.run();
    assert(result.facts);
    expect(result.facts.launched).toBe(true);
    expect(h.calls.verify[0]?.logsDir).toBe(workspaceLogsDir(root));
    expect(Number.isFinite(h.calls.verify[0]?.since)).toBeTruthy();
    expect(h.stderr.some((l) => /verify.*bundle requested from Metro port 8082/.test(l))).toBeTruthy();
  });

  test('the picker: no bundle request makes it launched: "unverified", still exit ok', async () => {
    const h = harness({ verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) });
    const result = await h.run();
    // ok stays true: the app IS launched. What changes is the fact an agent
    // branches on, and the warning that says what to do about it.
    expect(result.ok).toBe(true);
    assert(result.facts);
    expect(result.facts.launched).toBe('unverified');
    const text = h.stderr.join('\n');
    expect(text).toMatch(/UNVERIFIED/);
    expect(text).toMatch(/DEVELOPMENT SERVERS/);
    expect(text).toMatch(/adb -s emulator-5584 shell monkey -p com\.example\.app 1/);
    expect(text).not.toMatch(/simctl/);
    expect(h.stdout.join('\n')).toMatch(/UNVERIFIED/);
  });
});

describe('the launch outcome reaches the timeline', () => {
  test('an unverified launch is a warn record in the build log', async () => {
    const h = harness({ verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) });
    await h.run();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    const record = records.find((r) => r.event === 'launch_unverified');
    expect(record).toBeTruthy();
    assert(record);
    expect(record.level).toBe('warn');
  });
});

describe('the workspace directory is gitignored first', () => {
  test('ensureWorkspaceIgnored runs before the build log is opened', async () => {
    const h = harness();
    await h.run();
    expect(h.calls.ensureIgnored).toEqual([root]);
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
    expect(labelled(h.stderr, 'wired')[0]).toMatch(
      /debug_http_host 10\.0\.2\.2:8082 \+ adb reverse tcp:8081 -> tcp:8082/,
    );
    assert(result.facts);
    expect(result.facts.debugHttpHost).toBe('10.0.2.2:8082');
    expect(result.facts.debugHttpHostNote).toBe(null);
  });

  test('a failed one is a WARNING, a note in the facts, and a record in the timeline', async () => {
    const h = harness({
      launch: () => ({
        ok: true,
        mode: 'am-start',
        reversed: ['tcp:8081->tcp:8082'],
        debugHttpHost: null,
        debugHttpHostNote: 'debug_http_host not written (run-as: package not debuggable); relying on adb reverse',
      }),
    });
    const result = await h.run();
    // The run still succeeds -- the reverse covers the 8081 path on its own.
    expect(result.ok).toBe(true);
    const wired = labelled(h.stderr, 'wired')[0];
    expect(wired).toMatch(/not debuggable/);
    expect(wired).toMatch(/adb reverse tcp:8081 -> tcp:8082/);
    assert(result.facts);
    expect(result.facts.debugHttpHost).toBe(null);
    expect(result.facts.debugHttpHostNote).toMatch(/relying on adb reverse/);
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    const record = records.find((r) => r.event === 'debug_http_host_failed');
    expect(record).toBeTruthy();
    assert(record);
    expect(record.level).toBe('warn');
  });
});

// --- the dev-client deep link (F7) -----------------------------------------
describe('the dev-client deep link', () => {
  test('the scheme is read from the APK that was just installed, and passed to the launch', async () => {
    const asked: unknown[][] = [];
    const h = harness({
      resolveDevClientScheme: (projectRoot: string, apkPath: unknown) => {
        asked.push([projectRoot, apkPath]);
        return 'exp+app';
      },
    });
    await h.run();
    expect(asked.length).toBe(1);
    expect(h.calls.launch[0]?.devClientScheme).toBe('exp+app');
    // The apk the resolver is pointed at is the one that was installed, not
    // a source tree it would have to guess a build output path in.
    expect(asked[0]).toEqual([root, h.calls.install[0]?.apkPath]);
  });

  test('the deep-link launch says so, and the url is in the facts', async () => {
    const url = 'exp+app://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8082';
    const h = harness({
      resolveDevClientScheme: () => 'exp+app',
      launch: () => ({ ok: true, mode: 'deep-link', devClientUrl: url, reversed: [], debugHttpHost: '10.0.2.2:8082' }),
    });
    const result = await h.run();
    expect(labelled(h.stderr, 'launch')[0]).toMatch(/expo-dev-client deep link/);
    assert(result.facts);
    expect(result.facts.devClientUrl).toBe(url);
  });

  test('a deep link that resolved nothing is a warning, not a failure', async () => {
    const h = harness({
      resolveDevClientScheme: () => 'exp+app',
      launch: () => ({
        ok: true,
        mode: 'am-start',
        devClientNote:
          'am start -d exp+app://... did not start anything on emulator-5584: Error: Activity not started, unable to resolve Intent; fell back to the launcher activity',
        reversed: [],
        debugHttpHost: '10.0.2.2:8082',
      }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(labelled(h.stderr, 'wired').some((l) => /unable to resolve Intent/.test(l))).toBeTruthy();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    expect(records.find((r) => r.event === 'dev_client_link_failed')).toBeTruthy();
  });

  test('an unverified launch names the deep link FIRST, as a command that can be pasted', async () => {
    const h = harness({
      resolveDevClientScheme: () => 'exp+app',
      verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
    });
    await h.run();
    const steps = h.stderr.filter((l) => /^\s+\d+\./.test(l.replace(/^\s{2}\s*/, '  ')));
    const text = h.stderr.join('\n');
    const link = text.indexOf('am start -a android.intent.action.VIEW');
    const picker = text.indexOf('DEVELOPMENT SERVERS');
    expect(link > 0).toBeTruthy();
    expect(link < picker).toBeTruthy();
    // The exact command, with the exact url: 10.0.2.2, this workspace's port,
    // percent-encoded, quoted for the shell it is pasted into.
    expect(text).toMatch(
      /adb -s emulator-5584 shell am start -a android\.intent\.action\.VIEW -d 'exp\+app:\/\/expo-development-client\/\?url=http%3A%2F%2F10\.0\.2\.2%3A8082'/,
    );
    expect(steps.length >= 2).toBeTruthy();
  });

  test('no scheme, no deep link in the guidance', async () => {
    const h = harness({ verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) });
    await h.run();
    const text = h.stderr.join('\n');
    expect(text).not.toMatch(/expo-development-client/);
    expect(text).toMatch(/DEVELOPMENT SERVERS/);
  });
});

// --- F15: the emulator's NAME, not just its console-port slot --------------
describe('the device identity is recorded', () => {
  test('avdName and deviceName reach the facts and state.json lastBuild', async () => {
    const h = harness();
    const result = await h.run();
    assert(result.facts);
    expect(result.facts.avdName).toBe('rn-iso-app-412');
    expect(result.facts.deviceName).toBe('rn-iso-app-412');
    expect(result.facts.serial).toBe('emulator-5584');
    const lastBuild = readState().lastBuild;
    expect(lastBuild.avdName).toBe('rn-iso-app-412');
    expect(lastBuild.deviceName).toBe('rn-iso-app-412');
  });

  test('a failure after the device is resolved still records which emulator it was', async () => {
    const h = harness({ install: () => ({ failed: true, reason: 'adb install failed' }) });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(readState().lastBuild.avdName).toBe('rn-iso-app-412');
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

  test("the scheme is the launchable activity's, not the longest in the manifest", () => {
    const facts = apkDevClientFacts(dump());
    expect(facts.devClient).toBe(true);
    expect(facts.schemes).toEqual(['th3rdwave']);
    // The trap: these ARE in the manifest, on other activities.
    expect(JSON.stringify(facts.schemes)).not.toMatch(/expo-dev-launcher|stripe/);
  });

  test("aapt2's namespace-qualified spelling parses to the same thing", () => {
    const aapt2 = dump().replace(/A: android:/g, 'A: http://schemas.android.com/apk/res/android:');
    expect(apkDevClientFacts(aapt2)).toEqual(apkDevClientFacts(dump()));
  });

  test('an unresolved @0x resource reference is not a scheme', () => {
    // MainActivity's first VIEW filter carries `android:scheme=@0x7f1300c6`.
    const tree = parseXmltree(dump());
    const values: (string | null)[] = [];
    const walk = (n: ReturnType<typeof parseXmltree>) => {
      if ('android:scheme' in n.attrs) values.push(n.attrs['android:scheme']);
      n.children.forEach(walk);
    };
    walk(tree);
    expect(values.includes(null)).toBeTruthy();
    const schemes: readonly (string | null)[] = apkDevClientFacts(dump()).schemes;
    expect(!schemes.includes(null)).toBeTruthy();
  });

  test('an app with no expo-dev-launcher in it is not a dev client', () => {
    const plain = dump()
      .split('\n')
      .filter((l) => !l.includes('devlauncher'))
      .join('\n');
    expect(apkDevClientFacts(plain).devClient).toBe(false);
  });

  test('a manifest with no launchable activity yields no schemes rather than the wrong one', () => {
    const noMain = dump().replace(/android\.intent\.action\.MAIN/g, 'android.intent.action.SEND');
    expect(apkDevClientFacts(noMain).schemes).toEqual([]);
  });

  test('androidDevClientScheme: the APK answers, in both directions', () => {
    expect(androidDevClientScheme(root, '/x/app.apk', { dump: () => dump() })).toBe('th3rdwave');
    // A readable APK that is not a dev client is a plain launch -- NOT a
    // fall through to app.json, which would deep-link an app with no
    // launcher to handle it.
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fromconfig' } }));
    const plain = dump()
      .split('\n')
      .filter((l) => !l.includes('devlauncher'))
      .join('\n');
    expect(androidDevClientScheme(root, '/x/app.apk', { dump: () => plain })).toBe(undefined);
  });

  test('an unreadable APK falls back to the project config, exactly as iOS does', () => {
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fromconfig' } }));
    // No expo-dev-client in this fixture project's dependencies, so the
    // config reader refuses too: a plain launch, not a link nothing answers.
    expect(androidDevClientScheme(root, '/x/app.apk', { dump: () => null })).toBe(undefined);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { 'expo-dev-client': '^5.0.0' } }),
    );
    expect(androidDevClientScheme(root, '/x/app.apk', { dump: () => null })).toBe('fromconfig');
  });

  test('newestBuildTools sorts by version, not by string', () => {
    expect(newestBuildTools(['34.0.0', '36.0.0', '9.0.0', '35.0.0'])).toBe('36.0.0');
    expect(newestBuildTools(['36.0.0', '36.0.1'])).toBe('36.0.1');
    expect(newestBuildTools(['source.properties', 'NOTICE.txt'])).toBe(null);
    expect(newestBuildTools([])).toBe(null);
  });

  test('findAapt takes the newest build-tools that actually has one', () => {
    const found = findAapt('/sdk', {
      readDir: () => ['35.0.0', '36.0.0'],
      exists: (path) => path === join('/sdk', 'build-tools', '35.0.0', 'aapt2'),
    });
    expect(found).toEqual({ path: join('/sdk', 'build-tools', '35.0.0', 'aapt2'), tool: 'aapt2', version: '35.0.0' });
    expect(
      findAapt('/sdk', {
        readDir: () => {
          throw new Error('ENOENT');
        },
        exists: () => false,
      }),
    ).toBe(null);
    expect(findAapt('/sdk', { readDir: () => ['36.0.0'], exists: () => false })).toBe(null);
  });

  test('dumpApkManifest spells the dump the way each tool wants, and swallows failures', () => {
    const calls: unknown[][] = [];
    const exec = makeExecutor({
      runFile: (file, args = []) => {
        calls.push([file, ...args]);
        return 'E: manifest (line=2)\n';
      },
    });
    dumpApkManifest('/x/app.apk', { exec, aapt: { path: '/sdk/aapt', tool: 'aapt', version: '36.0.0' } });
    dumpApkManifest('/x/app.apk', { exec, aapt: { path: '/sdk/aapt2', tool: 'aapt2', version: '36.0.0' } });
    expect(calls).toEqual([
      ['/sdk/aapt', 'dump', 'xmltree', '/x/app.apk', 'AndroidManifest.xml'],
      ['/sdk/aapt2', 'dump', 'xmltree', '--file', 'AndroidManifest.xml', '/x/app.apk'],
    ]);
    const throwing = makeExecutor({
      runFile: () => {
        throw new Error('Invalid file');
      },
    });
    expect(
      dumpApkManifest('/x/app.apk', { exec: throwing, aapt: { path: '/sdk/aapt', tool: 'aapt', version: '36.0.0' } }),
    ).toBe(null);
    // Output that is not a manifest tree is not a manifest tree.
    expect(
      dumpApkManifest('/x/app.apk', {
        exec: makeExecutor({ runFile: () => 'ERROR: dump failed' }),
        aapt: { path: '/sdk/aapt', tool: 'aapt', version: '36.0.0' },
      }),
    ).toBe(null);
    expect(dumpApkManifest(null, { exec: throwing })).toBe(null);
  });
});

// The fingerprint is scoped to Android. Unscoped, the iOS tree hashes into the
// ANDROID key -- and a podspec that bakes an absolute path into
// ios/Podfile.lock then makes every cross-worktree android build a cache miss.
// See the field note above fingerprintProject in src/build-cache.js.
test('android fingerprints with platforms scoped to android', async () => {
  const seen: Array<{ path: string; options?: Record<string, unknown> }> = [];
  const h = harness({
    fingerprint: async (path: string, options?: Record<string, unknown>) => {
      seen.push({ path, options });
      return { hash: FINGERPRINT, sources: [] };
    },
  });
  await h.run();
  expect(seen.length).toBe(1);
  expect(seen[0]?.path).toBe(root);
  expect(seen[0]?.options?.platform).toBe('android');
});

// --- opt-in concurrency (unlimited by default) ---
describe('concurrency limits', () => {
  test('unset limits change nothing: no slot is taken, no capacity refuses', async () => {
    let slotAcquired = 0;
    const h = harness({
      getLimits: () => ({ maxBuilds: 0, maxDevices: 0 }),
      acquireSlot: async () => {
        slotAcquired++;
        return { acquired: true };
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(slotAcquired).toBe(0);
  });

  test('maxDevices at capacity refuses with RN_ISO_AT_CAPACITY, before ensuring a device', async () => {
    const capacityCalls: Record<string, unknown>[] = [];
    const h = harness({
      getLimits: () => ({ maxBuilds: 0, maxDevices: 3 }),
      checkCapacity: (args: Record<string, unknown>) => {
        capacityCalls.push(args);
        return {
          code: 'RN_ISO_AT_CAPACITY',
          message: 'at capacity',
          remedy: 'stop an environment (rn-iso stop) or raise concurrency.maxDevices',
        };
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    assert(result.error);
    expect(result.error.code).toBe('RN_ISO_AT_CAPACITY');
    const capacityArgs = capacityCalls[0];
    assert(capacityArgs);
    expect(capacityArgs.max).toBe(3);
    expect(h.calls.ensureDevice.length).toBe(0);
    expect(h.stderr.join('\n')).toMatch(/rn-iso stop/);
  });

  test('maxBuilds takes a slot to build and releases it, with the right args', async () => {
    const slotCalls: Record<string, unknown>[] = [];
    let released = 0;
    const h = harness({
      getLimits: () => ({ maxBuilds: 2, maxDevices: 0 }),
      acquireSlot: async (args: Record<string, unknown>) => {
        slotCalls.push(args);
        return { acquired: true, path: '/slot', index: 0, slot: { pid: process.pid } };
      },
      releaseSlot: () => {
        released++;
        return true;
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    const slotArgs = slotCalls[0];
    expect(slotArgs).toBeTruthy();
    assert(slotArgs);
    expect(slotArgs.max).toBe(2);
    expect(slotArgs.root).toBe(root);
    expect(released).toBe(1);
  });

  test("a waiter that installs another workspace's artifact never consumes a slot", async () => {
    let slotAcquired = 0;
    let built = 0;
    const h = harness({
      getLimits: () => ({ maxBuilds: 2, maxDevices: 0 }),
      acquireLock: () => ({ held: { pid: 41233, projectRoot: '/w/other', logFile: null } }),
      waitForBuild: async () => ({ hit: fakeApk(), waitedMs: 5000 }),
      acquireSlot: async () => {
        slotAcquired++;
        return { acquired: true };
      },
      build: async () => {
        built++;
        return { ok: true, apkPath: fakeApk(), durationMs: 1 };
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(slotAcquired).toBe(0);
    expect(built).toBe(0);
  });
});

// The package attribute lives on the manifest ROOT, not on any child element.
test('apkPackage reads the manifest root package and null on garbage', () => {
  const dump =
    'N: android=http://schemas.android.com/apk/res/android\nE: manifest (line=1)\n  A: package="com.example.blank" (Raw: "com.example.blank")\n  E: application (line=5)\n';
  expect(apkPackage(dump)).toBe('com.example.blank');
  expect(apkPackage('')).toBe(null);
  expect(apkPackage(null)).toBe(null);
});

// --- release builds (--variant ...Release, issue #57 phase 2) --------------
//
// A release-shaped variant is a different product: AGP's bundle task embeds
// the JS, so Metro is not part of the run at all -- and a native-keyed cache
// hit is an APK carrying its BUILDER's JS, which is why the hit path re-packs
// a fresh bundle into a COPY rather than installing the artifact as-is. What
// is pinned here is the command's side of that: the gate that does not run,
// the launch that is a plain am start, the swap-then-install order, the ASSET
// GATE's fallback, and the uninstall the re-signing makes inevitable.

describe('variant resolution', () => {
  test('flag > setting > default', () => {
    expect(resolveVariant('productionRelease', { android: { variant: 'productionDebug' } })).toBe('productionRelease');
    expect(resolveVariant(null, { android: { variant: 'productionRelease' } })).toBe('productionRelease');
    expect(resolveVariant('  ', { android: { variant: 'productionRelease' } })).toBe('productionRelease');
    expect(resolveVariant(null, {})).toBe(null);
    expect(resolveVariant(null, null)).toBe(null);
  });

  test('androidVariantSetting reads android.variant and nothing shaped differently', () => {
    expect(androidVariantSetting({ android: { variant: ' productionRelease ' } })).toBe('productionRelease');
    expect(androidVariantSetting({ android: { variant: '' } })).toBe(null);
    expect(androidVariantSetting({ android: [] })).toBe(null);
    expect(androidVariantSetting(null)).toBe(null);
  });

  test('a variant is release-shaped exactly when its BUILD TYPE suffix is release', () => {
    // A gradle variant is <flavor><BuildType>, so the build type is the
    // SUFFIX -- the mirror image of an Xcode configuration, which IS the
    // build type.
    expect(isReleaseVariant('release')).toBe(true);
    expect(isReleaseVariant('Release')).toBe(true);
    expect(isReleaseVariant('productionRelease')).toBe(true);
    expect(isReleaseVariant(' previewRelease ')).toBe(true);
    expect(isReleaseVariant('debug')).toBe(false);
    expect(isReleaseVariant('productionDebug')).toBe(false);
    // Not a suffix: a flavor that merely CONTAINS the word.
    expect(isReleaseVariant('releaseCandidateDebug')).toBe(false);
    expect(isReleaseVariant(null)).toBe(false);
    expect(isReleaseVariant('')).toBe(false);
  });
});

describe('release skips Metro entirely', () => {
  test('no gate, no reservation needed, no port wiring, plain am start', async () => {
    const h = harness({ variant: 'productionRelease', resolveMetro: never('the metro probe') });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.metro.length).toBe(0);
    expect(h.stderr.join('\n')).not.toMatch(/RN_ISO_NO_METRO/);
    expect(labelled(h.stderr, 'metro')[0]).toMatch(/skipped \(productionRelease: the JS bundle is embedded/);
    // The release launch, and NOT the wired one.
    expect(h.calls.launch.length).toBe(0);
    expect(h.calls.launchRelease[0]?.packageName).toBe('com.example.app');
    // No `wired` line at all: nothing was reversed and no preference written.
    expect(labelled(h.stderr, 'wired').length).toBe(0);
    // Verification is process-alive, not bundle-fetch.
    expect(h.calls.verify.length).toBe(0);
    expect(h.calls.verifyRelease.length).toBe(1);
    expect(labelled(h.stderr, 'verify')[0]).toMatch(/process alive/);
    // The collector still attaches, so `logs --errors` works in release.
    expect(h.calls.spawn.length).toBe(1);
  });

  test('a workspace with NO Metro reservation still runs a release build', async () => {
    upsertProject(root, { metroPort: undefined });
    const h = harness({ variant: 'productionRelease', resolveMetro: never('the metro probe') });
    const result = await h.run();
    expect(result.ok).toBe(true);
  });

  test('the payload says metroPort null, variant productionRelease, launched true', async () => {
    const h = harness({ json: true, variant: 'productionRelease' });
    const result = await h.run();
    assert(result.facts);
    expect(result.facts.variant).toBe('productionRelease');
    expect(result.facts.metroPort).toBe(null);
    expect(result.facts.launched).toBe(true);
    expect(result.facts.debugHttpHost).toBe(null);
    expect(result.facts.devClientUrl).toBe(null);
    // And the cache key carries the variant, so a release APK and a debug one
    // are never the same entry.
    expect(h.calls.resolveCached[0]?.[1]).toBe(`${FINGERPRINT}-productionrelease-sim`);
  });

  test('the outcome line names the variant instead of a port nothing used', async () => {
    const h = harness({ variant: 'productionRelease' });
    await h.run();
    expect(h.stdout[0]).toMatch(/productionRelease \(embedded JS, no Metro\)/);
  });

  test('a dead app process is launched: "unverified", with the device-log pointer', async () => {
    const h = harness({
      variant: 'productionRelease',
      verifyReleaseLaunched: async () => ({ verified: false, reason: 'exited', waitedMs: 3000, pid: null }),
    });
    const result = await h.run();
    assert(result.facts);
    expect(result.facts.launched).toBe('unverified');
    expect(h.stderr.join('\n')).toMatch(/UNVERIFIED: no com\.example\.app process/);
    expect(h.stderr.join('\n')).toMatch(/rn-iso logs --errors/);
  });

  test('the android.variant setting is the repo default, and the flag overrides it back to debug', async () => {
    setProjectSetting(root, 'android.variant', 'productionRelease');
    const fromSetting = harness({ resolveMetro: never('the metro probe') });
    expect((await fromSetting.run()).ok).toBe(true);
    expect(fromSetting.calls.launchRelease.length).toBe(1);
    // The flag beats the setting: the ordinary gated debug flow.
    const overridden = harness({ variant: 'productionDebug' });
    expect((await overridden.run()).ok).toBe(true);
    expect(overridden.calls.launch.length).toBe(1);
    expect(overridden.calls.launchRelease.length).toBe(0);
  });

  test('a debug run never touches any release seam', async () => {
    const h = harness({
      swapApk: never('the APK swap'),
      launchRelease: never('the release launch'),
      verifyReleaseLaunched: never('the release process check'),
    });
    expect((await h.run()).ok).toBe(true);
  });
});

describe('the release APK swap', () => {
  const cached = '/cache/android/entry/app-production-release.apk';

  test('a release cache hit re-packs: cached APK in, temp copy out, THAT copy installed', async () => {
    const h = harness({
      variant: 'productionRelease',
      resolveCached: (_platform: string, _key: string) => cached,
      build: never('the build'),
      prebuild: never('prebuild'),
      storeCached: never('storeBuild'),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    // Order: resolve the cache, swap, then install -- never a build.
    expect(h.calls.order.indexOf('swapApk')).toBeGreaterThan(h.calls.order.indexOf('resolveCached'));
    expect(h.calls.order.includes('build')).toBe(false);
    // The swap starts from the cached artifact, with the resolved keystore.
    expect(h.calls.swapApk[0]?.cachedApkPath).toBe(cached);
    expect(h.calls.swapApk[0]?.keystore).toEqual({
      path: join(root, 'android', 'app', 'debug.keystore'),
      pass: 'pass:android',
    });
    // The INSTALL gets the re-packed temp copy, never the cache entry itself.
    expect(h.calls.install[0]?.apkPath).toBe(join(root, 'apk-swap', 'app-production-release.apk'));
    assert(result.facts);
    expect(result.facts.appPath).toBe(join(root, 'apk-swap', 'app-production-release.apk'));
    expect(result.facts.cacheHit).toBe('local');
    expect(labelled(h.stderr, 'apk swap')[1]).toMatch(/hermes bytecode repacked \(store\), zipaligned and re-signed/);
    // And the temp dir is reaped once the APK is on the device.
    expect(existsSync(join(root, 'apk-swap'))).toBe(false);
  });

  test('android.keystore / android.keystorePassword reach the swap', async () => {
    setProjectSetting(root, 'android.keystore', 'android/app/release.jks');
    setProjectSetting(root, 'android.keystorePassword', 'env:MY_KS');
    const h = harness({ variant: 'productionRelease', resolveCached: () => cached, build: never('the build') });
    await h.run();
    expect(h.calls.swapApk[0]?.keystore).toEqual({
      path: join(root, 'android', 'app', 'release.jks'),
      pass: 'env:MY_KS',
    });
  });

  test('a debug cache hit never swaps', async () => {
    const h = harness({
      resolveCached: () => '/cache/app-debug.apk',
      build: never('the build'),
      swapApk: never('the APK swap'),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.install[0]?.apkPath).toBe('/cache/app-debug.apk');
  });

  test('a fresh release build needs no swap: it embedded THIS workspace JS already', async () => {
    const h = harness({ variant: 'productionRelease', swapApk: never('the APK swap') });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.build[0]?.variant).toBe('productionRelease');
  });

  test("the gate's stored side is the ENTRY's manifest, read at the cache key this run hit", async () => {
    const h = harness({ variant: 'productionRelease', resolveCached: () => cached, build: never('the build') });
    await h.run();
    expect(h.calls.storedAssets[0]).toEqual(['android', `${FINGERPRINT}-productionrelease-sim`]);
    expect(h.calls.swapApk[0]?.storedAssets).toEqual(STORED_ASSETS);
    // Read BEFORE the swap runs, and only for a release hit.
    expect(h.calls.order.indexOf('storedAssets')).toBeLessThan(h.calls.order.indexOf('swapApk'));
  });

  test('a debug cache hit never reads an asset manifest', async () => {
    const h = harness({ resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    await h.run();
    expect(h.calls.storedAssets.length).toBe(0);
  });

  test('THE ASSET GATE: an asset difference falls back to a FULL build with a note naming it', async () => {
    const h = harness({
      variant: 'productionRelease',
      resolveCached: () => cached,
      swapApk: async () => ({
        assetMismatch: true,
        reason:
          'this workspace emits a different asset set than the cached build did (0 added, 1 changed, 0 removed; e.g. changed drawable-mdpi/logo.png)',
        assetDiff: {
          same: false,
          added: [],
          removed: [],
          changed: ['drawable-mdpi/logo.png'],
          example: 'drawable-mdpi/logo.png',
        },
      }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    const errs = h.stderr.join('\n');
    expect(errs).toMatch(/apk swap/);
    expect(errs).toMatch(/changed drawable-mdpi\/logo\.png/);
    expect(errs).toMatch(/building fresh instead/);
    expect(errs).toMatch(/an APK cannot be made to carry an asset AAPT did not package/);
    // The fallback compiled, stored, and installed ITS artifact.
    expect(h.calls.build.length).toBe(1);
    expect(h.calls.install[0]?.apkPath).toBe(
      join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    );
    assert(result.facts);
    // The payload reports what actually happened: not a cache hit.
    expect(result.facts.cacheHit).toBe(false);
  });

  test('an entry with NO manifest never swaps, and the note says so without blaming AAPT', async () => {
    const h = harness({
      variant: 'productionRelease',
      resolveCached: () => cached,
      storedAssets: () => null,
      // What swapApkBundle answers for a null stored manifest: a refusal with
      // no assetDiff, because there was nothing to diff against.
      swapApk: async (args: SwapArgs = {}) => {
        expect(args.storedAssets).toBe(null);
        return {
          assetMismatch: true,
          reason:
            'this cache entry predates asset tracking (no assets-manifest.json beside the artifact), ' +
            'so its asset set cannot be proven to match this one',
        };
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    const errs = h.stderr.join('\n');
    expect(errs).toMatch(/predates asset tracking/);
    expect(errs).toMatch(/building fresh instead/);
    // That suffix belongs to a real asset DIFFERENCE; there was none to name.
    expect(errs).not.toMatch(/an APK cannot be made to carry an asset AAPT did not package/);
    expect(h.calls.build.length).toBe(1);
  });

  test('the fallback build REPLACES the entry that caused it -- otherwise the refusal repeats forever', async () => {
    const h = harness({
      variant: 'productionRelease',
      resolveCached: () => cached,
      swapApk: async () => ({ assetMismatch: true, reason: 'the sets differ', assetDiff: undefined }),
    });
    await h.run();
    // overwrite: true even though --no-build-cache was NOT passed. storeBuild
    // is idempotent by default, so without this the poisoned entry survives
    // the build that replaced it and refuses the next run identically.
    expect(h.calls.storeCached[0]?.[3]).toEqual({
      overwrite: true,
      sources: [],
      assetManifest: CAPTURED_ASSETS,
    });
  });

  test('a swap FAILURE replaces the entry the same way a refusal does', async () => {
    const h = harness({
      variant: 'productionRelease',
      resolveCached: () => cached,
      swapApk: async () => ({ failed: true, step: 'zipalign', reason: 'zipalign blew up', lastLines: [] }),
    });
    await h.run();
    expect((h.calls.storeCached[0]?.[3] as { overwrite?: boolean })?.overwrite).toBe(true);
  });

  test('a release build with no fallback stores WITHOUT overwriting, and carries its captured manifest', async () => {
    const h = harness({ variant: 'productionRelease', swapApk: never('the APK swap') });
    await h.run();
    // The capture reads THIS variant's generated asset directory.
    expect(h.calls.captureAssets[0]).toEqual([root, { variant: 'productionRelease' }]);
    expect(h.calls.storeCached[0]?.[3]).toEqual({
      overwrite: false,
      sources: [],
      assetManifest: CAPTURED_ASSETS,
    });
  });

  test('a DEBUG build captures no manifest: it never ran the bundle task', async () => {
    const h = harness({ captureAssets: never('the asset capture') });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.storeCached[0]?.[3]).toEqual({ overwrite: false, sources: [], assetManifest: null });
  });

  test('a swap failure falls back to a full build too -- stale JS is never installed', async () => {
    const h = harness({
      variant: 'productionRelease',
      resolveCached: () => cached,
      swapApk: async () => ({
        failed: true,
        step: 'apksigner',
        reason: 'apksigner sign failed: keystore password was incorrect',
        lastLines: [],
      }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.stderr.join('\n')).toMatch(/failed at apksigner/);
    expect(h.stderr.join('\n')).toMatch(/carries its builder's JS; it is never installed after a failed swap/);
    expect(h.calls.build.length).toBe(1);
    assert(result.facts);
    expect(result.facts.cacheHit).toBe(false);
  });
});

describe('installing a re-signed release APK', () => {
  test('a release run opts into the uninstall-and-retry; a debug run never does', async () => {
    const release = harness({ variant: 'productionRelease' });
    await release.run();
    expect(release.calls.install[0]?.allowUninstall).toBe(true);
    expect(release.calls.install[0]?.packageName).toBe('com.example.app');

    const debug = harness({});
    await debug.run();
    expect(debug.calls.install[0]?.allowUninstall).toBe(false);
  });

  test('the uninstall note reaches stderr and the build log, so the lost data is never silent', async () => {
    const h = harness({
      variant: 'productionRelease',
      install: (args: InstallArgs = {}) => ({
        ok: true,
        apkPath: args.apkPath ?? '',
        uninstalled: true,
        note: 'com.example.app was already installed with a different signer, so it was uninstalled (its data went with it) before this APK could be installed',
      }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(labelled(h.stderr, 'install').some((l) => /different signer/.test(l))).toBe(true);
    const log = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8'));
    expect(log.some((r) => r.event === 'install_uninstalled_first')).toBe(true);
  });
});
