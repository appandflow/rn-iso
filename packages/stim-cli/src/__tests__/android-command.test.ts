import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { loadConfig, setProjectSetting, upsertProject } from '../config.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { emulatorLogFile, workspaceLogsDir, workspaceStateFile } from '../paths.ts';
import { writeWorkspaceState } from '../supervisor/run.ts';
import { resolveMetroWithRetry } from '../commands/ios.ts';
import {
  NO_DEVICE,
  NO_FINGERPRINT,
  NO_METRO,
  androidDevClientScheme,
  androidFacts,
  androidVariantSetting,
  collectorLogFile,
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
  noDeviceDiagnostic,
  startCollector,
  phaseLine,
  registerAndroid,
  runAndroid,
  shortHash,
} from '../commands/android.ts';
import { newestBuildTools } from '../sim/android.ts';
import { BUILD_ERROR } from '../engine/gradle.ts';
import { LAUNCH_UNVERIFIED } from '../engine/app-install.ts';
import type { AssetManifest } from '../engine/asset-manifest.ts';
import { PREBUILD_ERROR } from '../engine/prebuild.ts';
import { asProcessExit, makeChildProcess, makeError, makeExecutor } from './_factories.ts';

const FINGERPRINT = 'a3f9b1c2d3e4f5a6b7c8d9e0f1a2b3c4';
const CACHE_KEY = `${FINGERPRINT}-debug-sim`;
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
  home = mkdtempSync(join(tmpdir(), 'stim-home-'));
  process.env.STIM_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'stim-android-'));
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
  delete process.env.STIM_HOME;
});

function parseRemoteOption(args: string[]): unknown {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerAndroid(program);
  const command = program.commands[0];
  assert(command);
  command.parseOptions(args);
  return command.opts().remote;
}

describe('--remote', () => {
  test('the CLI parser accepts only an explicit proxy or eas backend', () => {
    expect(parseRemoteOption(['--remote', 'proxy'])).toBe('proxy');
    expect(parseRemoteOption(['--remote', 'eas'])).toBe('eas');
    expect(() => parseRemoteOption(['--remote'])).toThrow(/argument missing/i);
    expect(() => parseRemoteOption(['--remote', 'cloud'])).toThrow(/proxy.*eas/i);
  });
});

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
  serial?: string;
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
  serial?: string;
  physical?: boolean;
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
  metroPort?: string | number | null;
  platform?: string | null;
}

interface Calls {
  ensureDevice: unknown[];
  booted: unknown[];
  metro: unknown[][];
  fingerprint: unknown[];
  untracked: unknown[];
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
  ensureStorage: unknown[];
  readApkPackage: unknown[];
  order: string[];
}

function harness(overrides = {}) {
  const calls: Calls = {
    ensureDevice: [],
    booted: [],
    metro: [],
    fingerprint: [],
    untracked: [],
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
    ensureStorage: [],
    readApkPackage: [],
    order: [],
  };
  const stderr: string[] = [];
  const stdout: string[] = [];
  const options = {
    root,
    ensureDevice: async (args: unknown = {}) => {
      calls.ensureDevice.push(args);
      return { avdName: 'stim-app-412', consolePort: 5584, owned: true };
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
    untracked: (args: { projectRoot: string }) => {
      calls.untracked.push(args);
      return [];
    },
    resolveCached: (platform: string, key: string) => {
      calls.order.push('resolveCached');
      calls.resolveCached.push([platform, key]);
      return null;
    },
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
    loadProvider: async (projectRoot: string, opts: Record<string, unknown> = {}) => {
      calls.loadProvider.push([projectRoot, opts]);
      return { none: true as const };
    },
    easAuth: (args: EasAuthArgs = {}) => {
      calls.easAuth.push(args);
      return { ok: true as const, account: 'janic' };
    },
    resolveRemoteBuild: async (args: RemoteBuildArgs = {}) => {
      calls.order.push('resolveRemoteBuild');
      calls.resolveRemoteBuild.push(args);
      return null;
    },
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
    launch: (args: LaunchArgs = {}) => {
      calls.launch.push(args);
      return {
        ok: true,
        mode: 'am-start',
        component: 'com.example.app/.MainActivity',
        devClientNote: null,
        reversed: ['tcp:8082->tcp:8082'],
        debugHttpHost: '10.0.2.2:8082',
        debugHttpHostNote: null,
      };
    },
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
    resolveDevClientScheme: (projectRoot: string, apkPath: unknown) => {
      calls.scheme.push([projectRoot, apkPath]);
      return undefined;
    },
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
    resolveMetroRetrying: (
      resolve: Parameters<typeof resolveMetroWithRetry>[0],
      port: Parameters<typeof resolveMetroWithRetry>[1],
      path: Parameters<typeof resolveMetroWithRetry>[2],
      opts: Parameters<typeof resolveMetroWithRetry>[3],
    ) => resolveMetroWithRetry(resolve, port, path, { ...opts, sleep: async () => {} }),
    verifyLaunched: async (args: VerifyArgs = {}) => {
      calls.verify.push(args);
      return { verified: true, waitedMs: 3100, timedOut: false, mode: null };
    },
    ensureStorage: async (dir: string) => {
      calls.ensureStorage.push(dir);
    },
    out: (line: string) => stderr.push(line),
    emit: (line: string) => stdout.push(line),
    ...overrides,
  };
  return { calls, stderr, stdout, run: () => runAndroid(options) };
}

const labelled = (lines: string[], label: string) => lines.filter((l) => l.startsWith(`  ${label}`));
const readState = () => JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));

describe('explicit remote backend behavior', () => {
  function remoteHarness(backend: 'proxy' | 'eas', overrides: Record<string, unknown> = {}) {
    const selected: unknown[] = [];
    const remoteCalls: string[] = [];
    const h = harness({
      remoteDevice: backend,
      resolveRemoteDeviceContext: async (args: { backend?: unknown }) => {
        selected.push(args.backend);
        return {
          ctx: {
            root,
            label: 'app',
            backend: args.backend,
            easBin: '/bin/eas',
            agentDeviceBin: '/bin/agent-device',
          },
        };
      },
      ensureMetroReachable: async () => ({ ok: true as const }),
      remoteDeviceDeps: () => ({
        ctx: { root, label: 'app', backend, easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        checkCapacity: () => null,
        ensureDevice: async () => {
          remoteCalls.push('ensureDevice');
          return { deviceName: 'remote device', owned: true, remote: true };
        },
        ensureDeviceBooted: async () => {
          remoteCalls.push('ensureDeviceBooted');
          return { ok: true, serial: 'remote-42' };
        },
        install: (args: InstallArgs = {}) => {
          remoteCalls.push('install');
          return { ok: true, apkPath: args.apkPath ?? '' };
        },
        launch: () => {
          remoteCalls.push('launch');
          return { ok: true, mode: 'remote' };
        },
        createdSessionId: () => null,
        webPreviewUrl: () => null,
      }),
      resolveEasBin: () => ({ file: '/bin/eas', args: [] }),
      ...overrides,
    });
    return { h, selected, remoteCalls };
  }

  test.each(['proxy', 'eas'] as const)(
    '%s selects that backend and replaces only device operations',
    async (backend) => {
      const { h, selected, remoteCalls } = remoteHarness(backend);
      const result = await h.run();
      expect(result.ok).toBe(true);
      expect(selected).toEqual([backend]);
      expect(remoteCalls).toEqual(['ensureDevice', 'ensureDeviceBooted', 'install', 'launch']);
      expect(h.calls.ensureDevice).toEqual([]);
      expect(h.calls.fingerprint.length).toBe(1);
    },
  );

  test('a remote ENOSPC boot failure keeps the remote-device remedy', async () => {
    const { h } = remoteHarness('proxy', {
      remoteDeviceDeps: () => ({
        ctx: { root, label: 'app', backend: 'proxy', easBin: null, agentDeviceBin: '/bin/agent-device' },
        checkCapacity: () => null,
        ensureDevice: async () => ({ deviceName: 'remote device', owned: true, remote: true }),
        ensureDeviceBooted: async () => ({ failed: true, reason: 'ENOSPC: remote profile write failed' }),
        install: never('install'),
        launch: never('launch'),
        createdSessionId: () => null,
        webPreviewUrl: () => null,
      }),
    });

    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('ENOSPC');
    expect(result.error?.remedy).toMatch(/stim status/);
    expect(result.error?.remedy).not.toMatch(/~\/\.android\/avd|several GB/);
  });

  test('android.remote selects the same explicit backend as the CLI', async () => {
    const selected: unknown[] = [];
    const h = harness({
      resolveSettingsFor: () => ({ android: { remote: 'proxy' } }),
      resolveRemoteDeviceContext: async (args: { backend?: unknown }) => {
        selected.push(args.backend);
        return { failed: 'stop after selection', remedy: 'test', code: 'TEST' };
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(selected).toEqual(['proxy']);
  });

  test('an invalid android.remote setting is a structured refusal', async () => {
    let resolved = false;
    const h = harness({
      resolveSettingsFor: () => ({ android: { remote: true } }),
      resolveRemoteDeviceContext: async () => {
        resolved = true;
        return { failed: 'must not run', remedy: '' };
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STIM_BAD_ARG');
    expect(result.error?.message).toContain('Invalid android.remote setting');
    expect(resolved).toBe(false);
  });

  test('an invalid Android data partition size is refused before device work', async () => {
    const h = harness({
      resolveSettingsFor: () => ({ android: { dataPartitionSizeGb: 5 } }),
      ensureDevice: never('the device'),
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STIM_BAD_ARG');
    expect(result.error?.message).toContain('Invalid android.dataPartitionSizeGb setting');
    expect(result.error?.remedy).toContain('whole number of GiB');
    expect(h.calls.ensureDevice).toEqual([]);
  });

  test('an unsafe Android AVD config key is refused before device work', async () => {
    const h = harness({
      resolveSettingsFor: () => ({ android: { avdConfig: { 'image.sysdir.1': '/tmp/image' } } }),
      ensureDevice: never('the device'),
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STIM_BAD_ARG');
    expect(result.error?.message).toContain('Unsupported android.avdConfig key');
    expect(result.error?.remedy).toContain('documented android.avdConfig keys');
    expect(h.calls.ensureDevice).toEqual([]);
  });

  test('the local path does not resolve a remote backend', async () => {
    let resolved = false;
    const h = harness({
      resolveRemoteDeviceContext: async () => {
        resolved = true;
        return { failed: 'must not run', remedy: '' };
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(resolved).toBe(false);
    expect(h.calls.ensureDevice.length).toBe(1);
  });

  test('remote debug validates local and public Metro before creating a session', async () => {
    const order: string[] = [];
    const h = harness({
      remoteDevice: 'eas',
      resolveMetroRetrying: async () => {
        order.push('localMetro');
        return { metro: { pid: 41233, leader: 41233, cwd: root } };
      },
      resolveRemoteDeviceContext: async () => {
        order.push('resolveBackend');
        return {
          ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        };
      },
      ensureMetroReachable: async () => {
        order.push('publicMetro');
        return { ok: true as const };
      },
      remoteDeviceDeps: () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        checkCapacity: () => null,
        ensureDevice: async () => {
          order.push('ensureDevice');
          return { deviceName: 'EAS Simulator', owned: true, remote: true };
        },
        ensureDeviceBooted: async () => {
          order.push('ensureDeviceBooted');
          return { ok: true, serial: 'drs_42' };
        },
        install: (args: InstallArgs = {}) => ({ ok: true, apkPath: args.apkPath ?? '' }),
        launch: () => ({ ok: true, mode: 'remote' }),
        createdSessionId: () => 'drs_42',
        webPreviewUrl: () => null,
      }),
      resolveEasBin: () => ({ file: '/bin/eas', args: [] }),
      fingerprint: async () => {
        order.push('fingerprint');
        return { hash: FINGERPRINT, sources: [] };
      },
    });

    expect((await h.run()).ok).toBe(true);
    expect(order.slice(0, 6)).toEqual([
      'localMetro',
      'resolveBackend',
      'publicMetro',
      'ensureDevice',
      'ensureDeviceBooted',
      'fingerprint',
    ]);
  });

  test('a failed public Metro gate starts no remote session or device operation', async () => {
    const remoteCalls: string[] = [];
    const h = harness({
      remoteDevice: 'eas',
      resolveRemoteDeviceContext: async () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
      }),
      ensureMetroReachable: async () => ({
        failed: 'The public Metro origin is unavailable.',
        remedy: 'Run `stim start --remote`.',
        code: 'STIM_REMOTE_METRO_UNREACHABLE',
      }),
      remoteDeviceDeps: () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        checkCapacity: () => null,
        ensureDevice: async () => {
          remoteCalls.push('ensureDevice');
          return { deviceName: 'EAS Simulator', owned: true, remote: true };
        },
        ensureDeviceBooted: async () => {
          remoteCalls.push('ensureDeviceBooted');
          return { ok: true, serial: 'drs_42' };
        },
        install: () => {
          remoteCalls.push('install');
          return { ok: true };
        },
        launch: () => {
          remoteCalls.push('launch');
          return { ok: true, mode: 'remote' };
        },
        createdSessionId: () => 'drs_42',
        webPreviewUrl: () => null,
      }),
      resolveEasBin: () => ({ file: '/bin/eas', args: [] }),
      fingerprint: never('fingerprint'),
    });

    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STIM_REMOTE_METRO_UNREACHABLE');
    expect(remoteCalls).toEqual([]);
    expect(existsSync(workspaceStateFile(root)) ? readState().remoteDevice : undefined).toBeUndefined();
  });

  test('an EAS session is recorded after boot and survives a later build failure', async () => {
    const order: string[] = [];
    const h = harness({
      remoteDevice: 'eas',
      resolveRemoteDeviceContext: async () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
      }),
      ensureMetroReachable: async () => ({ ok: true as const }),
      remoteDeviceDeps: () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        checkCapacity: () => null,
        ensureDevice: async () => ({ deviceName: 'EAS Simulator', owned: true, remote: true }),
        ensureDeviceBooted: async () => {
          order.push('boot');
          return { ok: true, serial: 'drs_42' };
        },
        install: never('install'),
        launch: never('launch'),
        createdSessionId: () => {
          order.push('sessionId');
          return 'drs_42';
        },
        webPreviewUrl: () => null,
      }),
      resolveEasBin: () => ({ file: '/bin/eas', args: [] }),
      writeState: (projectRoot: string, patch: Record<string, unknown>) => {
        if ('remoteDevice' in patch) order.push('writeSession');
        return writeWorkspaceState(projectRoot, patch);
      },
      fingerprint: async () => {
        order.push('fingerprint');
        return { hash: FINGERPRINT, sources: [] };
      },
      build: async () => {
        order.push('build');
        return { failed: true, code: BUILD_ERROR, reason: 'Gradle failed.', durationMs: 1, lastLines: [] };
      },
    });

    expect((await h.run()).ok).toBe(false);
    expect(order.slice(0, 5)).toEqual(['boot', 'sessionId', 'writeSession', 'fingerprint', 'build']);
    expect(readState().remoteDevice).toMatchObject({ platform: 'android', sessionId: 'drs_42' });
  });

  test('a state write failure stops only the EAS session created by this run', async () => {
    const abandoned: string[] = [];
    const h = harness({
      remoteDevice: 'eas',
      resolveRemoteDeviceContext: async () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
      }),
      ensureMetroReachable: async () => ({ ok: true as const }),
      remoteDeviceDeps: () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        checkCapacity: () => null,
        ensureDevice: async () => ({ deviceName: 'EAS Simulator', owned: true, remote: true }),
        ensureDeviceBooted: async () => ({ ok: true, serial: 'drs_42' }),
        install: never('install'),
        launch: never('launch'),
        createdSessionId: () => 'drs_42',
        abandonCreatedSession: () => {
          abandoned.push('drs_42');
          return { ok: true as const, sessionId: 'drs_42' };
        },
        webPreviewUrl: () => null,
      }),
      resolveEasBin: () => ({ file: '/bin/eas', args: [] }),
      writeState: () => {
        throw new Error('disk full');
      },
      fingerprint: never('fingerprint'),
    });

    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STIM_REMOTE_SESSION_STATE');
    expect(result.error?.message).toContain('drs_42');
    expect(result.error?.message).toContain('stopped');
    expect(abandoned).toEqual(['drs_42']);
  });

  test('an unconfirmed cleanup reports the unmanaged EAS session and manual remedy', async () => {
    const h = harness({
      remoteDevice: 'eas',
      resolveRemoteDeviceContext: async () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
      }),
      ensureMetroReachable: async () => ({ ok: true as const }),
      remoteDeviceDeps: () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        checkCapacity: () => null,
        ensureDevice: async () => ({ deviceName: 'EAS Simulator', owned: true, remote: true }),
        ensureDeviceBooted: async () => ({ ok: true, serial: 'drs_unmanaged' }),
        install: never('install'),
        launch: never('launch'),
        createdSessionId: () => 'drs_unmanaged',
        abandonCreatedSession: () => ({
          failed: true as const,
          code: 'STIM_REMOTE_SESSION_CLEANUP',
          reason: 'Session drs_unmanaged still bills.',
          remedy: 'Run `eas simulator:stop --id drs_unmanaged`.',
          sessionId: 'drs_unmanaged',
        }),
        webPreviewUrl: () => null,
      }),
      resolveEasBin: () => ({ file: '/bin/eas', args: [] }),
      writeState: () => {
        throw new Error('disk full');
      },
      fingerprint: never('fingerprint'),
    });

    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      code: 'STIM_REMOTE_SESSION_CLEANUP',
      message: expect.stringContaining('drs_unmanaged'),
      remedy: 'Run `eas simulator:stop --id drs_unmanaged`.',
    });
  });

  test('concurrent remote runs create one durable EAS session', async () => {
    let creations = 0;
    let deviceEntries = 0;
    let releaseFirst!: () => void;
    let firstCreated!: () => void;
    let bothAtDevice!: () => void;
    const firstCreatedPromise = new Promise<void>((resolve) => {
      firstCreated = resolve;
    });
    const bothAtDevicePromise = new Promise<void>((resolve) => {
      bothAtDevice = resolve;
    });
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const makeRun = () => {
      let created: string | null = null;
      return harness({
        remoteDevice: 'eas',
        resolveRemoteDeviceContext: async () => ({
          ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        }),
        ensureMetroReachable: async () => ({ ok: true as const }),
        remoteDeviceDeps: () => ({
          ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
          checkCapacity: () => null,
          ensureDevice: async () => {
            deviceEntries += 1;
            if (deviceEntries === 2) bothAtDevice();
            return { deviceName: 'EAS Simulator', owned: true, remote: true };
          },
          ensureDeviceBooted: async () => {
            const state = existsSync(workspaceStateFile(root)) ? readState() : null;
            const existing = state?.remoteDevice?.sessionId as string | undefined;
            if (existing) {
              created = null;
              return { ok: true, serial: existing };
            }
            creations += 1;
            created = `drs_${creations}`;
            if (creations === 1) {
              firstCreated();
              await releaseFirstPromise;
            }
            return { ok: true, serial: created };
          },
          install: (args: InstallArgs = {}) => ({ ok: true, apkPath: args.apkPath ?? '' }),
          launch: () => ({ ok: true, mode: 'remote' }),
          createdSessionId: () => created,
          abandonCreatedSession: () => ({ ok: true as const, sessionId: created ?? '' }),
          webPreviewUrl: () => null,
        }),
        resolveEasBin: () => ({ file: '/bin/eas', args: [] }),
        resolveCached: () => '/cache/app-debug.apk',
        build: never('build'),
      }).run();
    };

    const first = makeRun();
    await firstCreatedPromise;
    const second = makeRun();
    await bothAtDevicePromise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(creations).toBe(1);

    releaseFirst();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(creations).toBe(1);
    expect(readState().remoteDevice).toMatchObject({ platform: 'android', sessionId: 'drs_1' });
  });

  test('the proxy backend creates no owned EAS session record', async () => {
    const { h } = remoteHarness('proxy');
    expect((await h.run()).ok).toBe(true);
    expect(readState().remoteDevice).toBeUndefined();
  });

  test('a reused EAS session keeps its original ownership timestamp', async () => {
    writeWorkspaceState(root, {
      remoteDevice: { platform: 'android', sessionId: 'drs_old', startedAt: '2026-08-27T12:00:00.000Z' },
    });
    const { h } = remoteHarness('eas', { writeState: never('a new ownership-state write') });

    expect((await h.run()).ok).toBe(true);
    expect(readState().remoteDevice).toEqual({
      platform: 'android',
      sessionId: 'drs_old',
      startedAt: '2026-08-27T12:00:00.000Z',
    });
  });

  test('remote release skips Metro and launches with the remote adapter', async () => {
    const remoteLaunches: LaunchArgs[] = [];
    const options = {
      remoteDevice: 'eas',
      variant: 'productionRelease',
      resolveMetro: never('the local Metro gate'),
      ensureMetroReachable: never('the public Metro gate'),
      resolveRemoteDeviceContext: async () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
      }),
      remoteDeviceDeps: () => ({
        ctx: { root, label: 'app', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        checkCapacity: () => null,
        ensureDevice: async () => ({ deviceName: 'EAS Simulator', owned: true, remote: true }),
        ensureDeviceBooted: async () => ({ ok: true, serial: 'drs_42' }),
        install: (args: InstallArgs = {}) => ({ ok: true, apkPath: args.apkPath ?? '' }),
        launch: (args: LaunchArgs = {}) => {
          remoteLaunches.push(args);
          return { ok: true, mode: 'remote' };
        },
        createdSessionId: () => 'drs_42',
        webPreviewUrl: () => null,
      }),
      resolveEasBin: () => ({ file: '/bin/eas', args: [] }),
      launchRelease: never('the local release launcher'),
      spawn: never('the local adb collector'),
      verifyReleaseLaunched: never('the local release verifier'),
    };
    const h = harness(options);

    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(remoteLaunches).toEqual([{ serial: 'drs_42', packageName: 'com.example.app', metroPort: null }]);
    expect(result.facts?.logs).toBeNull();
    expect(result.facts?.launched).toBe(LAUNCH_UNVERIFIED);
    expect(h.stderr.join('\n')).toContain('UNVERIFIED');
    expect(h.stdout[0]).toContain('-- launch UNVERIFIED');

    const json = harness({ ...options, json: true });
    expect((await json.run()).ok).toBe(true);
    expect(JSON.parse(json.stdout[0] ?? '{}')).toMatchObject({ launched: LAUNCH_UNVERIFIED, logs: null });
  });
});

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

  test('prints the phases and one complete agent-facts block on stdout', async () => {
    const h = harness({ resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    await h.run();

    expect(labelled(h.stderr, 'device')[0]).toMatch(/stim-app-412 \(emulator-5584\) booted/);
    expect(labelled(h.stderr, 'metro')[0]).toMatch(/port 8082 \(pid 41233\)/);
    expect(labelled(h.stderr, 'launch')[0]).toMatch(/com\.example\.app/);
    expect(labelled(h.stderr, 'logs')[0]).toMatch(/collector pid 9001/);
    expect(labelled(h.stderr, 'fingerprint')[0]).toMatch(/\(\d+m?\d*s\)$/);
    expect(labelled(h.stderr, 'device')[0]).toMatch(/booted \(\d+m?\d*s\)$/);
    expect(labelled(h.stderr, 'install')[0]).toMatch(/from local cache \(\d+m?\d*s\)$/);
    expect(labelled(h.stderr, 'launch')[0]).toMatch(/\(\d+m?\d*s\)$/);
    expect(h.stdout.length).toBe(1);
    expect(h.stdout[0]).toMatch(/OK: com\.example\.app launched on emulator-5584/);
    expect(h.stdout[0]).toContain(phaseLine('device', 'stim-app-412 (emulator-5584)'));
    expect(h.stdout[0]).toContain(phaseLine('app', 'com.example.app'));
    expect(h.stdout[0]).toContain(phaseLine('metro', 'running on port 8082'));
    expect(h.stdout[0]).toContain(phaseLine('cache', 'cache hit'));
    expect(h.stdout[0]).toContain(phaseLine('logs', workspaceLogsDir(root)));
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
      avdName: 'stim-app-412',
      deviceName: 'stim-app-412',
      fingerprint: FINGERPRINT,
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
    expect(labelled(h.stderr, 'build')[0]).toMatch(/compiling debug with Gradle/);
    expect(labelled(h.stderr, 'build')[1]).toMatch(/app-debug\.apk \(2m41s\)/);
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
    expect(labelled(h.stderr, 'prebuild')[0]).toMatch(/android\/ generated \(12s\)/);
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
    expect(h.calls.build[0]?.variant).toBe('productionDebug');
    expect(h.calls.install[0]?.apkPath).toMatch(/apk\/production\/debug\/app-production-debug\.apk$/);
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
    const h = harness({ readApkPackage: () => 'io.tlon.groups' });
    const result = await h.run();

    expect(result.ok).toBe(true);
    expect(h.calls.launch[0]?.packageName).toBe('io.tlon.groups');
    assert(result.facts);
    expect(result.facts.bundleId).toBe('io.tlon.groups');
    expect(h.stdout[0]).toMatch(/io\.tlon\.groups/);
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
  test('an unhealthy reserved port fails fast with STIM_NO_METRO', async () => {
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
    expect(result.error.remedy).toMatch(/stim start/);
    expect(result.error.remedy).toMatch(/--no-metro-check/);
    expect(h.stderr.at(-2)).toMatch(/STIM_NO_METRO/);
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
    expect(h.calls.launch[0]?.metroPort).toBe(8082);
    expect(h.stdout[0]).toContain(phaseLine('metro', 'check skipped on port 8082'));
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
  test('a fingerprint with no hash refuses without a package-install remedy', async () => {
    const h = harness({
      fingerprint: async () => null,
      resolveCached: never('the cache lookup'),
      build: never('the build'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_FINGERPRINT);
    expect(result.error.remedy).not.toMatch(/npm i -D @expo\/fingerprint/);
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

  test('a device that cannot be booted refuses with STIM_NO_DEVICE, after the build', async () => {
    const h = harness({
      ensureDeviceBooted: async () => ({ failed: true, reason: 'AVD stim-app-412 no longer exists.' }),
      install: never('the install'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_DEVICE);
    expect(result.error.message).toMatch(/no longer exists/);
  });

  const DISK_FATAL =
    'FATAL | Not enough space to create userdata partition. Available: 6341.54 MB at /Users/j/.android/avd, need 7372.80 MB';

  function writeEmulatorLog(lines: string[]) {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    writeFileSync(emulatorLogFile(root), `${lines.join('\n')}\n`);
  }

  test("a boot failure lifts the emulator's own FATAL line into the diagnostic", async () => {
    writeEmulatorLog(['INFO    | Android emulator version 35.2.10.0', DISK_FATAL]);
    const h = harness({
      ensureDeviceBooted: async () => ({
        failed: true,
        reason: 'The emulator process for emulator-5584 exited before the device finished booting.',
      }),
      install: never('the install'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_DEVICE);
    expect(result.error.message).toMatch(/Not enough space to create userdata partition/);
    expect(result.error.remedy).toMatch(/Free disk space/);
    expect(result.error.remedy).toMatch(/~\/.android\/avd/);
    expect(result.error.remedy).not.toMatch(/JAVA_HOME|stim status/);
    expect(h.stderr.some((l) => l.includes(emulatorLogFile(root)))).toBeTruthy();
  });

  test('an ensureDevice throw is diagnosed from emulator.log too', async () => {
    writeEmulatorLog(["PANIC: Missing emulator engine program for 'arm64' CPU."]);
    const h = harness({
      ensureDevice: async () => {
        throw new Error('Emulator emulator-5554 did not finish booting within 120s.');
      },
      build: never('the build'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_DEVICE);
    expect(result.error.message).toMatch(/Missing emulator engine program/);
    expect(result.error.remedy).not.toMatch(/JAVA_HOME/);
  });

  test('an ENOSPC ensureDevice throw uses the disk-space remedy without an emulator log', async () => {
    const h = harness({
      ensureDevice: async () => {
        throw new Error('ENOSPC: no space left on device, write');
      },
      build: never('the build'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe(NO_DEVICE);
    expect(result.error.message).toMatch(/ENOSPC/);
    expect(result.error.remedy).toMatch(/~\/.android\/avd/);
    expect(result.error.remedy).not.toMatch(/JAVA_HOME|ANDROID_HOME|sdkmanager/);
  });

  test('the generic remedy stands when emulator.log has no severity markers', async () => {
    writeEmulatorLog(['INFO    | Android emulator version 35.2.10.0', 'WARNING | System image is out of date']);
    const h = harness({
      ensureDeviceBooted: async () => ({ failed: true, reason: 'AVD stim-app-412 no longer exists.' }),
      install: never('the install'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.message).toBe('AVD stim-app-412 no longer exists.');
    expect(result.error.remedy).toMatch(/stim status/);
    expect(h.stderr.some((l) => l.includes(emulatorLogFile(root)))).toBeTruthy();
  });

  test('the emulator log path is threaded into both device seams', async () => {
    const h = harness({});
    await h.run();
    const ensured = h.calls.ensureDevice[0] as { logFile?: string };
    const booted = h.calls.booted[0] as { logFile?: string };
    expect(ensured.logFile).toBe(emulatorLogFile(root));
    expect(booted.logFile).toBe(emulatorLogFile(root));
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
        code: 'STIM_INSTALL_FAILED',
        reason: 'adb install failed: INSTALL_FAILED_INSUFFICIENT_STORAGE',
      }),
      launch: never('the launch'),
    });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe('STIM_INSTALL_FAILED');
    expect(result.error.remedy).toMatch(/emulator-5584/);
    expect(readState().lastBuild.errorCode).toBe('STIM_INSTALL_FAILED');
  });

  test('a launch failure is reported after a successful install', async () => {
    const h = harness({ launch: () => ({ failed: true, code: 'STIM_LAUNCH_FAILED', reason: 'am start failed' }) });
    const result = await h.run();
    assert(result.error);
    expect(result.error.code).toBe('STIM_LAUNCH_FAILED');
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
    expect(labelled(h.stderr, 'build')[0]).toMatch(/compiling debug with Gradle/);
    expect(labelled(h.stderr, 'build')[1]).toMatch(/FAILED after 2m41s/);
    const errors = labelled(h.stderr, 'error');
    expect(errors.some((l) => /MainActivity\.kt:23:9: Unresolved reference 'Foo'\./.test(l))).toBeTruthy();
    expect(errors.some((l) => /and 3 more diagnostic/.test(l))).toBeTruthy();
    expect(labelled(h.stderr, 'log')[0]).toBe(phaseLine('log', join(workspaceLogsDir(root), 'build-android.ndjson')));
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

describe('the remote cache', () => {
  const provider = (name = 'eas') => ({ provider: { plugin: {}, options: {} }, name });

  test('a LOCAL hit never consults the provider at all', async () => {
    const h = harness({ resolveCached: () => '/cache/app-debug.apk', build: never('the build') });
    await h.run();
    expect(h.calls.loadProvider.length).toBe(0);
    expect(h.calls.resolveRemoteBuild.length).toBe(0);
  });

  test('a bare RN project never has its config read: the community CLI has no provider concept', async () => {
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
    expect(labelled(h.stderr, 'cache')[0]).toMatch(/did not answer within 30s; building instead/);
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

  test('still STORES -- over the entry it was told not to trust -- and still uploads', async () => {
    const h = harness({
      useBuildCache: false,
      loadProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
    });
    await h.run();
    expect(h.calls.storeCached[0]?.[3]).toEqual({ overwrite: true, sources: [], assetManifest: null });
    expect(h.calls.uploadRemoteBuild.length).toBe(1);
  });

  test('a default run stores without overwriting: two worktrees at the same fingerprint agree', async () => {
    const h = harness();
    await h.run();
    expect(h.calls.storeCached[0]?.[3]).toEqual({ overwrite: false, sources: [], assetManifest: null });
  });
});

describe('single-flight builds', () => {
  const heldBy = (pid = 41233, projectRoot = '/w/app-999') => ({
    held: {
      pid,
      projectRoot,
      startedAt: '2026-08-25T10:00:00.000Z',
      logFile: `${projectRoot}/.stim/logs/build-android.ndjson`,
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
          code: 'STIM_BUILD_WAIT_TIMEOUT',
          lockPath: '/home/build-locks/android-key.lock',
        });
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    assert(result.error);
    expect(result.error.code).toBe('STIM_BUILD_WAIT_TIMEOUT');
    expect(h.calls.build.length).toBe(0);
  });

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
    expect(Array.isArray(opts.stdio)).toBe(true);
    expect((opts.stdio as unknown[])[0]).toBe('ignore');
    expect(existsSync(collectorLogFile(root))).toBe(true);
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

describe('the pure parts', () => {
  test('noDeviceDiagnostic prefers the emulator over the generic remedy, and names the log either way', () => {
    const fatal = 'FATAL | Not enough space to create userdata partition. Available: 1 MB, need 2 MB';
    const lifted = noDeviceDiagnostic({
      reason: 'The emulator exited.',
      logFile: '/ws/.stim/logs/emulator.log',
      remedy: 'Check JAVA_HOME.',
      readLog: () => `INFO | starting\n${fatal}\nFATAL | giving up`,
    });
    expect(lifted.message).toBe(`The emulator exited. The emulator reported: ${fatal}`);
    expect(lifted.remedy).toMatch(/Free disk space/);
    expect(lifted.lines).toEqual(['FATAL | giving up']);
    expect(lifted.logPath).toBe('/ws/.stim/logs/emulator.log');

    const unrecognized = noDeviceDiagnostic({
      reason: 'The emulator exited.',
      logFile: '/ws/.stim/logs/emulator.log',
      remedy: 'Check JAVA_HOME.',
      readLog: () => 'INFO | nothing to see',
    });
    expect(unrecognized.message).toBe('The emulator exited.');
    expect(unrecognized.remedy).toBe('Check JAVA_HOME.');
    expect(unrecognized.lines).toEqual([]);
    expect(unrecognized.logPath).toBe('/ws/.stim/logs/emulator.log');

    const noLog = noDeviceDiagnostic({
      reason: 'The emulator exited.',
      logFile: '/ws/.stim/logs/emulator.log',
      remedy: 'Check JAVA_HOME.',
      readLog: () => '',
    });
    expect(noLog.logPath).toBe(null);
    expect(noLog.remedy).toBe('Check JAVA_HOME.');

    const noSpace = noDeviceDiagnostic({
      reason: 'ENOSPC: no space left on device, write',
      logFile: '/ws/.stim/logs/emulator.log',
      remedy: 'Check JAVA_HOME.',
      readLog: () => '',
    });
    expect(noSpace.remedy).toMatch(/~\/.android\/avd/);
    expect(noSpace.remedy).toMatch(/several GB/);
    expect(noSpace.remedy).not.toMatch(/JAVA_HOME/);

    const noSpaceWithUnrelatedFatal = noDeviceDiagnostic({
      reason: 'ENOSPC: no space left on device, write',
      logFile: '/ws/.stim/logs/emulator.log',
      remedy: 'Check JAVA_HOME.',
      readLog: () => "PANIC: Missing emulator engine program for 'arm64' CPU.",
    });
    expect(noSpaceWithUnrelatedFatal.remedy).toMatch(/~\/.android\/avd/);
    expect(noSpaceWithUnrelatedFatal.remedy).not.toMatch(/JAVA_HOME|Fix what the emulator reported/);

    const remoteNoSpace = noDeviceDiagnostic({
      reason: 'ENOSPC: remote profile write failed',
      logFile: '/ws/.stim/logs/emulator.log',
      remedy: 'Inspect the remote device.',
      localEmulator: false,
      readLog: () => 'FATAL | Not enough space to create userdata partition.',
    });
    expect(remoteNoSpace.remedy).toBe('Inspect the remote device.');
    expect(remoteNoSpace.logPath).toBe(null);
  });

  test('phaseLine lines the values up in one column', () => {
    expect(phaseLine('device', 'x')).toBe('  device      x');
    expect(phaseLine('fingerprint', 'x')).toBe('  fingerprint x');
  });

  test('displayPath shortens a workspace path and leaves a foreign one alone', () => {
    expect(displayPath(root, join(root, '.stim', 'logs'))).toBe('.stim/logs');
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
    expect(androidFacts({ cacheKey: `${FINGERPRINT}-productionrelease-sim` }).cacheKey).toBe(
      `${FINGERPRINT}-productionrelease-sim`,
    );
    expect({
      avdName: androidFacts({ avdName: 'stim-app-412' }).avdName,
      deviceName: androidFacts({ avdName: 'stim-app-412' }).deviceName,
    }).toEqual({ avdName: 'stim-app-412', deviceName: 'stim-app-412' });
    expect(androidFacts({ cacheHit: 'remote' }).cacheHit).toBe('remote');
    expect(androidFacts({ cacheHit: true }).cacheHit).toBe(false);
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

describe('launch verification', () => {
  test("a verified launch reports launched: true and polls this workspace's timeline", async () => {
    const h = harness();
    const result = await h.run();
    assert(result.facts);
    expect(result.facts.launched).toBe(true);
    expect(h.calls.verify[0]?.logsDir).toBe(workspaceLogsDir(root));
    expect(Number.isFinite(h.calls.verify[0]?.since)).toBeTruthy();
    expect(h.calls.verify[0]?.platform).toBe('android');
    expect(h.stderr.some((l) => /verify.*bundle loaded, stable for 3s/.test(l))).toBeTruthy();
  });

  test('the picker: no bundle request makes it launched: "unverified", still exit ok', async () => {
    const h = harness({ verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) });
    const result = await h.run();
    expect(result.ok).toBe(true);
    assert(result.facts);
    expect(result.facts.launched).toBe('unverified');
    const text = h.stderr.join('\n');
    expect(text).toMatch(/UNVERIFIED/);
    expect(text).toMatch(/DEVELOPMENT SERVERS/);
    expect(text).toMatch(/adb -s emulator-5584 shell monkey -p com\.example\.app 1/);
    expect(text).not.toMatch(/simctl/);
    expect(h.stdout.join('\n')).toMatch(/UNVERIFIED/);
    expect(h.stdout[0]).toContain(phaseLine('metro', 'state unverified on port 8082'));
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
  test('workspace storage is prepared before the build log is opened', async () => {
    const h = harness();
    await h.run();
    expect(h.calls.ensureStorage).toEqual([root]);
  });
});

describe('the port wiring is reported', () => {
  test('a successful debug_http_host write is a phase line and two facts', async () => {
    const h = harness();
    const result = await h.run();
    expect(labelled(h.stderr, 'wired')[0]).toMatch(
      /debug_http_host 10\.0\.2\.2:8082 \+ adb reverse tcp:8082->tcp:8082/,
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
    expect(result.ok).toBe(true);
    const wired = labelled(h.stderr, 'wired')[0];
    expect(wired).toMatch(/not debuggable/);
    expect(wired).toMatch(/adb reverse tcp:8081->tcp:8082/);
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

describe('the device identity is recorded', () => {
  test('avdName and deviceName reach the facts and state.json lastBuild', async () => {
    const h = harness();
    const result = await h.run();
    assert(result.facts);
    expect(result.facts.avdName).toBe('stim-app-412');
    expect(result.facts.deviceName).toBe('stim-app-412');
    expect(result.facts.serial).toBe('emulator-5584');
    const lastBuild = readState().lastBuild;
    expect(lastBuild.avdName).toBe('stim-app-412');
    expect(lastBuild.deviceName).toBe('stim-app-412');
  });

  test('a failure after the device is resolved still records which emulator it was', async () => {
    const h = harness({ install: () => ({ failed: true, reason: 'adb install failed' }) });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(readState().lastBuild.avdName).toBe('stim-app-412');
  });
});

describe('the APK dev-client scheme', () => {
  const dump = () => readFileSync(join(import.meta.dirname, 'fixtures', 'aapt-xmltree-devclient.txt'), 'utf-8');

  test("the scheme is the launchable activity's, not the longest in the manifest", () => {
    const facts = apkDevClientFacts(dump());
    expect(facts.devClient).toBe(true);
    expect(facts.schemes).toEqual(['th3rdwave']);
    expect(JSON.stringify(facts.schemes)).not.toMatch(/expo-dev-launcher|stripe/);
  });

  test("aapt2's namespace-qualified spelling parses to the same thing", () => {
    const aapt2 = dump().replace(/A: android:/g, 'A: http://schemas.android.com/apk/res/android:');
    expect(apkDevClientFacts(aapt2)).toEqual(apkDevClientFacts(dump()));
  });

  test('an unresolved @0x resource reference is not a scheme', () => {
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
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fromconfig' } }));
    const plain = dump()
      .split('\n')
      .filter((l) => !l.includes('devlauncher'))
      .join('\n');
    expect(androidDevClientScheme(root, '/x/app.apk', { dump: () => plain })).toBe(undefined);
  });

  test('an unreadable APK falls back to the project config, exactly as iOS does', () => {
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fromconfig' } }));
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
    expect(
      dumpApkManifest('/x/app.apk', {
        exec: makeExecutor({ runFile: () => 'ERROR: dump failed' }),
        aapt: { path: '/sdk/aapt', tool: 'aapt', version: '36.0.0' },
      }),
    ).toBe(null);
    expect(dumpApkManifest(null, { exec: throwing })).toBe(null);
  });
});

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

  test('maxDevices at capacity refuses with STIM_AT_CAPACITY, before ensuring a device', async () => {
    const capacityCalls: Record<string, unknown>[] = [];
    const h = harness({
      getLimits: () => ({ maxBuilds: 0, maxDevices: 3 }),
      checkCapacity: (args: Record<string, unknown>) => {
        capacityCalls.push(args);
        return {
          code: 'STIM_AT_CAPACITY',
          message: 'at capacity',
          remedy: 'stop an environment (stim stop) or raise concurrency.maxDevices',
        };
      },
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    assert(result.error);
    expect(result.error.code).toBe('STIM_AT_CAPACITY');
    const capacityArgs = capacityCalls[0];
    assert(capacityArgs);
    expect(capacityArgs.max).toBe(3);
    expect(h.calls.ensureDevice.length).toBe(0);
    expect(h.stderr.join('\n')).toMatch(/stim stop/);
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

test('apkPackage reads the manifest root package and null on garbage', () => {
  const dump =
    'N: android=http://schemas.android.com/apk/res/android\nE: manifest (line=1)\n  A: package="com.example.blank" (Raw: "com.example.blank")\n  E: application (line=5)\n';
  expect(apkPackage(dump)).toBe('com.example.blank');
  expect(apkPackage('')).toBe(null);
  expect(apkPackage(null)).toBe(null);
});

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
    expect(isReleaseVariant('release')).toBe(true);
    expect(isReleaseVariant('Release')).toBe(true);
    expect(isReleaseVariant('productionRelease')).toBe(true);
    expect(isReleaseVariant(' previewRelease ')).toBe(true);
    expect(isReleaseVariant('debug')).toBe(false);
    expect(isReleaseVariant('productionDebug')).toBe(false);
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
    expect(h.stderr.join('\n')).not.toMatch(/STIM_NO_METRO/);
    expect(labelled(h.stderr, 'metro')[0]).toMatch(/skipped \(productionRelease: the JS bundle is embedded/);
    expect(h.calls.launch.length).toBe(0);
    expect(h.calls.launchRelease[0]?.packageName).toBe('com.example.app');
    expect(labelled(h.stderr, 'wired').length).toBe(0);
    expect(h.calls.verify.length).toBe(0);
    expect(h.calls.verifyRelease.length).toBe(1);
    expect(labelled(h.stderr, 'verify')[0]).toMatch(/process alive/);
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
    expect(h.calls.resolveCached[0]?.[1]).toBe(`${FINGERPRINT}-productionrelease-sim`);
  });

  test('the outcome line names the variant instead of a port nothing used', async () => {
    const h = harness({ variant: 'productionRelease' });
    await h.run();
    expect(h.stdout[0]).toMatch(/productionRelease \(embedded JS, no Metro\)/);
  });

  test('a dead app process fails the readiness check with the device-log pointer', async () => {
    const h = harness({
      variant: 'productionRelease',
      verifyReleaseLaunched: async () => ({ verified: false, reason: 'exited', waitedMs: 3000, pid: null }),
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STIM_LAUNCH_FAILED');
    expect(h.stderr.join('\n')).toMatch(/UNVERIFIED: no com\.example\.app process/);
    expect(h.stderr.join('\n')).toMatch(/stim logs --errors/);
  });

  test('a failed release process probe stays unverified without claiming an exit', async () => {
    const h = harness({
      variant: 'productionRelease',
      verifyReleaseLaunched: async () => ({ verified: false, reason: 'probe-failed', waitedMs: 3000 }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(result.facts?.launched).toBe('unverified');
    expect(h.stderr.join('\n')).toMatch(/UNVERIFIED: the app process check failed/);
    expect(h.stderr.join('\n')).not.toMatch(/no com\.example\.app process/);
  });

  test('the android.variant setting is the repo default, and the flag overrides it back to debug', async () => {
    setProjectSetting(root, 'android.variant', 'productionRelease');
    const fromSetting = harness({ resolveMetro: never('the metro probe') });
    expect((await fromSetting.run()).ok).toBe(true);
    expect(fromSetting.calls.launchRelease.length).toBe(1);
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
    expect(h.calls.order.indexOf('swapApk')).toBeGreaterThan(h.calls.order.indexOf('resolveCached'));
    expect(h.calls.order.includes('build')).toBe(false);
    expect(h.calls.swapApk[0]?.cachedApkPath).toBe(cached);
    expect(h.calls.swapApk[0]?.keystore).toEqual({
      path: join(root, 'android', 'app', 'debug.keystore'),
      pass: 'pass:android',
    });
    expect(h.calls.install[0]?.apkPath).toBe(join(root, 'apk-swap', 'app-production-release.apk'));
    assert(result.facts);
    expect(result.facts.appPath).toBe(join(root, 'apk-swap', 'app-production-release.apk'));
    expect(result.facts.cacheHit).toBe('local');
    expect(labelled(h.stderr, 'apk swap')[1]).toMatch(/hermes bytecode repacked \(store\), zipaligned and re-signed/);
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
    expect(h.calls.build.length).toBe(1);
    expect(h.calls.install[0]?.apkPath).toBe(
      join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    );
    assert(result.facts);
    expect(result.facts.cacheHit).toBe(false);
  });

  test('an entry with NO manifest never swaps, and the note says so without blaming AAPT', async () => {
    const h = harness({
      variant: 'productionRelease',
      resolveCached: () => cached,
      storedAssets: () => null,
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

describe('re-fingerprint after prebuild', () => {
  const COLD = 'cccccc1111';
  const WARM = 'wwwwww2222';

  function shifting() {
    let call = 0;
    return async () => ({ hash: call++ === 0 ? COLD : WARM, sources: [{ type: 'dir', filePath: 'android' }] });
  }

  function cngProject() {
    rmSync(join(root, 'android'), { recursive: true, force: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '54.0.0' } }));
    writeFileSync(
      join(root, 'app.json'),
      JSON.stringify({ expo: { name: 'app', android: { package: 'com.example.app' } } }),
    );
  }

  test('the store key is the key the NEXT run looks up across a prebuild boundary', async () => {
    cngProject();
    const cold = harness({ fingerprint: shifting() });
    const result = await cold.run();
    expect(result.ok).toBe(true);
    expect(cold.calls.prebuild.length).toBe(1);
    const [, storedKey] = cold.calls.storeCached[0] ?? [];
    const [, lookedUp] = cold.calls.resolveCached[0] ?? [];
    expect(String(lookedUp)).toMatch(new RegExp(`^${COLD}`));
    expect(String(storedKey)).toMatch(new RegExp(`^${WARM}`));

    mkdirSync(join(root, 'android', 'app'), { recursive: true });
    const warm = harness({ fingerprint: async () => ({ hash: WARM, sources: [] }) });
    await warm.run();
    expect(warm.calls.resolveCached[0]?.[1]).toBe(storedKey);
  });

  test('the shift is one dim line naming both short hashes, and the payload reports what was stored', async () => {
    cngProject();
    const h = harness({ fingerprint: shifting() });
    const result = await h.run();
    const shift = h.stderr.find((line) => /fingerprint\s+\S+ -> /.test(line));
    assert(shift, 'expected a fingerprint shift line on stderr');
    expect(shift).toMatch(/cccccc\.\. -> wwwwww\.\./);
    expect(shift).toMatch(/after prebuild/);
    expect(result.facts?.fingerprint).toBe(WARM);
    expect(result.facts?.cacheKey).toBe(h.calls.storeCached[0]?.[1]);
    expect(readState().lastBuild.cacheKey).toBe(h.calls.storeCached[0]?.[1]);
  });

  test('a post-shift hit installs the cached APK and runs no gradle build', async () => {
    cngProject();
    const cachedApk = join(home, 'build-cache', 'android', `${WARM}-debug-sim`, 'app-debug.apk');
    const h = harness({
      fingerprint: shifting(),
      resolveCached: (_platform: string, key: string) => (key.startsWith(WARM) ? cachedApk : null),
      build: never('gradle'),
      storeCached: never('the store'),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.prebuild.length).toBe(1);
    expect(h.calls.install[0]?.apkPath).toBe(cachedApk);
    expect(h.stderr.some((l) => /hit under the post-prebuild key \(this tree was cold/.test(l))).toBe(true);
    expect(result.facts?.cacheHit).toBe('local');
    expect(result.facts?.fingerprint).toBe(WARM);
    expect(result.facts?.cacheKey).toBe(`${WARM}-debug-sim`);
  });

  test('a post-shift hit on a release variant swaps the APK, gated on THAT entry manifest', async () => {
    cngProject();
    const cachedApk = join(home, 'build-cache', 'android', `${WARM}-productionrelease-sim`, 'app.apk');
    const h = harness({
      variant: 'productionRelease',
      resolveMetro: never('the metro probe'),
      fingerprint: shifting(),
      resolveCached: (_platform: string, key: string) => (key.startsWith(WARM) ? cachedApk : null),
      build: never('gradle'),
      storeCached: never('the store'),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.swapApk[0]?.cachedApkPath).toBe(cachedApk);
    expect(h.calls.storedAssets.at(-1)?.[1]).toBe(`${WARM}-productionrelease-sim`);
    expect(h.calls.install[0]?.apkPath).toBe(join(root, 'apk-swap', 'app-production-release.apk'));
  });

  test('a post-shift hit the asset gate REFUSES falls back to gradle and replaces the entry', async () => {
    cngProject();
    const cachedApk = join(home, 'build-cache', 'android', `${WARM}-productionrelease-sim`, 'app.apk');
    const h = harness({
      variant: 'productionRelease',
      resolveMetro: never('the metro probe'),
      fingerprint: shifting(),
      resolveCached: (_platform: string, key: string) => (key.startsWith(WARM) ? cachedApk : null),
      swapApk: async () => ({
        ok: false,
        assetMismatch: true,
        reason: 'the cached APK was built with a different asset set',
        assetDiff: { added: ['drawable-mdpi/new.png'], removed: [], changed: [] },
      }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.build.length).toBe(1);
    const [, key, , opts] = h.calls.storeCached[0] ?? [];
    expect(key).toBe(`${WARM}-productionrelease-sim`);
    expect((opts as { overwrite?: boolean }).overwrite).toBe(true);
  });

  test('a post-shift MISS builds and stores under the new key', async () => {
    cngProject();
    const lookedUp: string[] = [];
    const h = harness({
      fingerprint: shifting(),
      resolveCached: (_platform: string, key: string) => {
        lookedUp.push(key);
        return null;
      },
    });
    await h.run();
    expect(lookedUp.length).toBe(2);
    expect(lookedUp[1]).toBe(`${WARM}-debug-sim`);
    expect(h.calls.build.length).toBe(1);
    expect(h.calls.storeCached[0]?.[1]).toBe(`${WARM}-debug-sim`);
  });

  test('a tree that needs no prebuild fingerprints exactly once and prints no shift line', async () => {
    const h = harness();
    await h.run();
    expect(h.calls.fingerprint.length).toBe(1);
    expect(h.stderr.some((line) => /fingerprint\s+\S+ -> /.test(line))).toBe(false);
    expect(h.calls.storeCached[0]?.[1]).toBe(h.calls.resolveCached[0]?.[1]);
    expect(h.calls.resolveCached.length).toBe(1);
  });
});

test('a first miss lists untracked files under the native dirs and points at .fingerprintignore', async () => {
  const asked: unknown[] = [];
  const h = harness({
    untracked: (args: unknown) => {
      asked.push(args);
      return ['android/local.properties', 'ios/scratch.txt'];
    },
  });
  await h.run();
  expect(asked).toEqual([{ projectRoot: root }]);
  const line = h.stderr.find((l) => l.includes('untracked'));
  assert(line, 'expected the untracked-files note on stderr');
  expect(line).toMatch(/android\/local\.properties, ios\/scratch\.txt/);
  expect(line).toMatch(/\.fingerprintignore/);
});

describe('launch verification: bundling vs unverified', () => {
  test('a request that arrived reports launched: "bundling" and prints no remedy list', async () => {
    const h = harness({
      verifyLaunched: async () => ({ verified: false, timedOut: true, requested: true, waitedMs: 20000, mode: null }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(result.facts?.launched).toBe('bundling');
    const text = h.stderr.join('\n');
    expect(text).toMatch(/BUNDLING: the app asked port 8082 for its bundle/);
    expect(text).not.toMatch(/DEVELOPMENT SERVERS picker/);
    const record = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), 'utf-8')).find(
      (r) => r.event === 'launch_bundling',
    );
    assert(record, 'expected a launch_bundling record in the build log');
    expect(record.level).toBe('info');
  });

  test('no request at all is still "unverified", with the remedy list', async () => {
    const h = harness({
      verifyLaunched: async () => ({ verified: false, timedOut: true, waitedMs: 20000, mode: null }),
    });
    const result = await h.run();
    expect(result.facts?.launched).toBe('unverified');
    expect(h.stderr.join('\n')).toMatch(/DEVELOPMENT SERVERS picker/);
  });

  test("verifyLaunch is told this workspace's port, which is what the device log is matched on", async () => {
    const h = harness();
    await h.run();
    expect(h.calls.verify[0]?.metroPort).toBe(8082);
  });
});

test('taking the build lock over from a dead holder says this run repeats its inputs', async () => {
  const h = harness({
    acquireLock: () => ({
      acquired: true as const,
      path: join(home, 'build-locks', 'android-k.lock'),
      lock: { pid: process.pid, projectRoot: root, startedAt: new Date().toISOString(), logFile: null },
      tookOver: {
        pid: 4242,
        projectRoot: '/w/other',
        startedAt: new Date(Date.now() - 60000).toISOString(),
        logFile: '/w/other/.stim/logs/build-android.ndjson',
      },
    }),
  });
  await h.run();
  const line = h.stderr.find((l) => l.includes('RETRY:'));
  assert(line, 'expected the takeover retry line on stderr');
  expect(line).toMatch(/pid 4242/);
  expect(line).toMatch(/SAME inputs/);
  expect(line).toMatch(/build-android\.ndjson/);
});

test('a builder that died mid-wait produces the same line before this run rebuilds', async () => {
  let attempt = 0;
  const h = harness({
    acquireLock: () =>
      attempt++ === 0
        ? { held: { pid: 999, projectRoot: '/w/other', startedAt: null, logFile: '/w/other/build.ndjson' } }
        : {
            acquired: true as const,
            path: join(home, 'build-locks', 'android-k.lock'),
            lock: { pid: process.pid, projectRoot: root, startedAt: new Date().toISOString(), logFile: null },
          },
    waitForBuild: async () => ({ builderFailed: 'the builder (pid 999) is gone', waitedMs: 1200 }),
  });
  await h.run();
  expect(h.calls.build.length).toBe(1);
  const line = h.stderr.find((l) => l.includes('RETRY:'));
  assert(line, 'expected the takeover retry line on stderr');
  expect(line).toMatch(/pid 999/);
});

test('a new android collector waits for the previous one to exit before it is spawned', async () => {
  writeWorkspaceState(root, { collectors: { android: { pid: 4242, startedAt: 'then' } } });
  const order: string[] = [];
  let liveChecks = 0;
  const pid = await startCollector({
    root,
    serial: 'emulator-5584',
    packageName: 'com.example.app',
    spawn: (_cmd, _args, _opts) => {
      order.push('spawn');
      return makeChildProcess({ pid: 9001 });
    },
    kill: (target: number, signal: NodeJS.Signals) => {
      order.push(`kill ${target} ${signal}`);
      return true;
    },
    alive: () => {
      liveChecks += 1;
      order.push('alive');
      return liveChecks < 3;
    },
    sleep: async () => {},
    out: () => {},
  });
  expect(pid).toBe(9001);
  expect(order[0]).toBe('kill 4242 SIGTERM');
  expect(order.at(-1)).toBe('spawn');
  expect(order.filter((o) => o === 'alive').length).toBe(3);
});

test('nothing recorded means nothing to wait for: the collector starts immediately', async () => {
  const order: string[] = [];
  await startCollector({
    root,
    serial: 'emulator-5584',
    packageName: 'com.example.app',
    spawn: () => {
      order.push('spawn');
      return makeChildProcess({ pid: 9002 });
    },
    kill: () => true,
    alive: () => {
      order.push('alive');
      return true;
    },
    sleep: async () => {},
    out: () => {},
  });
  expect(order).toEqual(['spawn']);
});

describe('the project cache provider', () => {
  const providerConfig = () => ({ provider: './cache.cjs', options: { bucket: 'mobile' }, baseDir: root });

  function downloadedApk() {
    const dir = join(root, 'provider-download');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'app-debug.apk');
    writeFileSync(path, 'binary');
    return path;
  }

  function providerOptions(builds: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      resolveCacheProvider: () => providerConfig(),
      loadCacheProviderModule: async () => ({ name: './cache.cjs', provider: { builds } }),
      ...extra,
    };
  }

  test('no configured provider never loads one', async () => {
    let loads = 0;
    const h = harness({
      loadCacheProviderModule: async () => {
        loads += 1;
        return { none: true };
      },
    });

    expect((await h.run()).ok).toBe(true);
    expect(loads).toBe(0);
    expect(h.stderr.join('\n')).not.toMatch(/provider/);
  });

  test('a local hit does not load either second tier', async () => {
    let loads = 0;
    const h = harness({
      resolveCached: () => join(home, 'build-cache', 'android', CACHE_KEY, 'app-debug.apk'),
      build: never('the build'),
      storeCached: never('storeBuild'),
      resolveCacheProvider: () => providerConfig(),
      loadCacheProviderModule: async () => {
        loads += 1;
        return { name: './cache.cjs', provider: { builds: { resolve: () => null, store: () => {} } } };
      },
    });

    expect((await h.run()).ok).toBe(true);
    expect(loads).toBe(0);
    expect(h.calls.loadProvider.length).toBe(0);
  });

  test('local, project provider, Expo provider, build lock, build is the order', async () => {
    const timeline: string[] = [];
    const h = harness(
      providerOptions(
        {
          resolve: () => {
            timeline.push('project provider');
            return null;
          },
          store: () => {},
        },
        {
          resolveCached: () => {
            timeline.push('local');
            return null;
          },
          loadProvider: async () => {
            timeline.push('expo provider');
            return { provider: { plugin: {}, options: {} }, name: 'eas' };
          },
          acquireLock: () => {
            timeline.push('build lock');
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
        },
      ),
    );

    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(timeline).toEqual(['local', 'project provider', 'expo provider', 'build lock']);
    expect(h.calls.build.length).toBe(1);
  });

  test('a provider hit installs the locally stored artifact without building', async () => {
    const artifact = downloadedApk();
    const h = harness(
      providerOptions({
        resolve: (input: { platform: string; key: string }) => {
          expect(input).toMatchObject({ platform: 'android', key: CACHE_KEY });
          return artifact;
        },
        store: () => {},
      }),
    );

    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(result.facts?.cacheHit).toBe('remote');
    expect(h.calls.build.length).toBe(0);
    expect(h.calls.loadProvider.length).toBe(0);
    expect(h.calls.storeCached[0]?.[2]).toBe(artifact);
    expect(labelled(h.stderr, 'cache')[0]).toMatch(/provider hit \(\.\/cache\.cjs\) -> stored locally/);
    expect(h.stdout.join('\n')).toMatch(/cache hit from \.\/cache\.cjs/);
    expect(h.stdout.join('\n')).not.toMatch(/from the remote cache/);
  });

  test('a bare React Native project uses the provider without reading Expo config', async () => {
    const artifact = downloadedApk();
    const h = harness(providerOptions({ resolve: () => artifact, store: () => {} }));

    expect((await h.run()).ok).toBe(true);
    expect(h.calls.loadProvider.length).toBe(0);
  });

  test('a fresh build uploads to the provider and reports it', async () => {
    const uploads: unknown[] = [];
    const h = harness(
      providerOptions({
        resolve: () => null,
        store: (input: unknown) => {
          uploads.push(input);
        },
      }),
    );

    expect((await h.run()).ok).toBe(true);
    expect(uploads.length).toBe(1);
    expect(uploads[0]).toMatchObject({ platform: 'android', key: CACHE_KEY, overwrite: false });
    expect(labelled(h.stderr, 'cache').some((line) => line.includes('uploaded (./cache.cjs)'))).toBe(true);
  });

  test('an unusable provider reports once and the build still succeeds', async () => {
    const h = harness({
      resolveCacheProvider: () => providerConfig(),
      loadCacheProviderModule: async () => ({ name: './cache.cjs', unavailable: 'missing credentials' }),
    });

    expect((await h.run()).ok).toBe(true);
    const notices = h.stderr.filter((line) => line.includes('provider not usable'));
    expect(notices.length).toBe(1);
    expect(notices[0]).toMatch(/provider not usable \(\.\/cache\.cjs\): missing credentials; using local cache/);
  });

  test('provider read and upload failures keep the build successful', async () => {
    const h = harness(
      providerOptions({
        resolve: () => {
          throw new Error('unauthorized');
        },
        store: () => {
          throw new Error('upload denied');
        },
      }),
    );

    expect((await h.run()).ok).toBe(true);
    expect(h.stderr.join('\n')).toMatch(/\.\/cache\.cjs could not be used: unauthorized; building instead/);
    expect(h.stderr.join('\n')).toMatch(/\.\/cache\.cjs upload failed: upload denied/);
  });

  test('--no-build-cache skips the provider read and still uploads', async () => {
    const uploads: unknown[] = [];
    const h = harness(
      providerOptions(
        {
          resolve: never('the provider read'),
          store: (input: unknown) => {
            uploads.push(input);
          },
        },
        { useBuildCache: false },
      ),
    );

    expect((await h.run()).ok).toBe(true);
    expect(uploads.length).toBe(1);
    expect(uploads[0]).toMatchObject({ overwrite: true });
  });
});

function parseDeviceOption(args: string[]): unknown {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerAndroid(program);
  const command = program.commands[0];
  assert(command);
  command.parseOptions(args);
  return command.opts().device;
}

describe('--device (a physical Android device)', () => {
  const CONNECTED = {
    emulators: [],
    physical: [{ serial: 'RFCR7081Q9L' }],
    unhealthy: [],
  };

  function physicalHarness(overrides: Record<string, unknown> = {}) {
    return harness({
      device: true,
      listDevices: () => CONNECTED,
      deviceModel: () => 'SM-G996W',
      isEmulatorDevice: () => false,
      checkCapacity: never('the device-capacity check'),
      ensureDevice: never('the owned-device path'),
      ensureDeviceBooted: never('the emulator boot'),
      ...overrides,
    });
  }

  test('the CLI parser accepts --device bare and with a serial', () => {
    expect(parseDeviceOption(['--device'])).toBe(true);
    expect(parseDeviceOption(['--device', 'RFCR7081Q9L'])).toBe('RFCR7081Q9L');
    expect(parseDeviceOption([])).toBeUndefined();
  });

  test('a physical run installs and launches on the resolved serial', async () => {
    const h = physicalHarness();
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.install[0]?.serial).toBe('RFCR7081Q9L');
    expect(h.calls.launch[0]?.serial).toBe('RFCR7081Q9L');
  });

  test('a physical run launches against localhost, not the emulator loopback', async () => {
    const h = physicalHarness();
    await h.run();
    expect(h.calls.launch[0]?.physical).toBe(true);
  });

  test('an emulator run still launches against the emulator loopback', async () => {
    const h = harness();
    await h.run();
    expect(h.calls.launch[0]?.physical).toBeFalsy();
  });

  test('a physical run honours an explicit serial', async () => {
    const h = physicalHarness({
      device: 'RFCR7081Q9L',
      listDevices: () => ({
        emulators: [],
        physical: [{ serial: 'OTHER' }, { serial: 'RFCR7081Q9L' }],
        unhealthy: [],
      }),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.install[0]?.serial).toBe('RFCR7081Q9L');
  });

  test('a physical run refuses with the resolver error and remedy when no device is connected', async () => {
    const h = physicalHarness({
      listDevices: () => ({ emulators: [], physical: [], unhealthy: [] }),
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(NO_DEVICE);
    expect(result.error?.message).toMatch(/No physical Android device is connected/);
    expect(result.error?.remedy).toMatch(/USB debugging/);
  });

  test('a physical run records no device in the global config, so gc and stop cannot reach it', async () => {
    const h = physicalHarness();
    await h.run();
    expect(loadConfig()?.projects?.[root]?.platforms?.android).toBeUndefined();
  });

  test('--device and --remote together are refused before any build work', async () => {
    const h = harness({
      device: true,
      remoteDevice: 'proxy',
      listDevices: () => CONNECTED,
      deviceModel: () => 'SM-G996W',
      isEmulatorDevice: () => false,
      fingerprint: never('the fingerprint'),
      resolveRemoteDeviceContext: never('the remote session'),
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/--device.*--remote|--remote.*--device/);
  });

  test('the summary names the device model and marks it physical', async () => {
    const h = physicalHarness();
    await h.run();
    expect(labelled(h.stdout.join('\n').split('\n'), 'device').join(' ')).toMatch(/SM-G996W.*RFCR7081Q9L/);
  });
});

describe('--device refusals found in review', () => {
  const CONNECTED2 = { emulators: [], physical: [{ serial: 'RFCR7081Q9L' }], unhealthy: [] };

  test('an empty --device value is refused, never silently run on the emulator', async () => {
    const h = harness({
      device: '',
      listDevices: () => CONNECTED2,
      deviceModel: () => 'SM-G996W',
      isEmulatorDevice: () => false,
      checkCapacity: never('the device-capacity check'),
      ensureDevice: never('the owned-device path'),
      ensureDeviceBooted: never('the emulator boot'),
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STIM_BAD_ARG');
    expect(result.error?.message).toMatch(/--device/);
  });

  test('an explicit --device wins over the android.remote setting instead of refusing', async () => {
    setProjectSetting(root, 'android', { remote: 'proxy' });
    const h = harness({
      device: true,
      listDevices: () => CONNECTED2,
      deviceModel: () => 'SM-G996W',
      isEmulatorDevice: () => false,
      checkCapacity: never('the device-capacity check'),
      ensureDevice: never('the owned-device path'),
      ensureDeviceBooted: never('the emulator boot'),
      resolveRemoteDeviceContext: never('the remote session'),
    });
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(h.calls.install[0]?.serial).toBe('RFCR7081Q9L');
  });

  test('--device with an explicit --remote is a bad-argument refusal', async () => {
    const h = harness({
      device: true,
      remoteDevice: 'proxy',
      listDevices: () => CONNECTED2,
      deviceModel: () => 'SM-G996W',
      isEmulatorDevice: () => false,
      fingerprint: never('the fingerprint'),
      resolveRemoteDeviceContext: never('the remote session'),
    });
    const result = await h.run();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STIM_BAD_ARG');
  });

  test('a physical run leaves no serial in the workspace state either', async () => {
    const h = harness({
      device: true,
      listDevices: () => CONNECTED2,
      deviceModel: () => 'SM-G996W',
      isEmulatorDevice: () => false,
      checkCapacity: never('the device-capacity check'),
      ensureDevice: never('the owned-device path'),
      ensureDeviceBooted: never('the emulator boot'),
    });
    await h.run();
    const state = JSON.stringify(readState());
    expect(state).not.toContain('RFCR7081Q9L');
    expect(loadConfig()?.projects?.[root]?.platforms?.android).toBeUndefined();
  });
});

test('a signature conflict on install names the conflict instead of blaming the cable', async () => {
  const h = harness({
    device: true,
    listDevices: () => ({ emulators: [], physical: [{ serial: 'RFCR7081Q9L' }], unhealthy: [] }),
    deviceModel: () => 'SM-G996W',
    isEmulatorDevice: () => false,
    checkCapacity: never('the device-capacity check'),
    ensureDevice: never('the owned-device path'),
    ensureDeviceBooted: never('the emulator boot'),
    install: () => ({
      failed: true,
      code: 'STIM_INSTALL_FAILED',
      reason: 'adb install failed for app.apk: INSTALL_FAILED_UPDATE_INCOMPATIBLE',
    }),
  });
  const result = await h.run();
  expect(result.ok).toBe(false);
  expect(result.error?.remedy).toMatch(/signer|uninstall/i);
  expect(result.error?.remedy).not.toMatch(/still connected/);
});

test('the wired line reports the reverses that were actually registered', async () => {
  const h = harness({
    launch: (args: LaunchArgs = {}) => ({
      ok: true,
      mode: 'am-start',
      component: 'com.example.app/.MainActivity',
      devClientNote: null,
      reversed: ['tcp:8082->tcp:8082'],
      debugHttpHost: '10.0.2.2:8082',
      debugHttpHostNote: null,
      ...args,
    }),
  });
  await h.run();
  const wired = labelled(h.stderr, 'wired').join(' ');
  expect(wired).toContain('tcp:8082->tcp:8082');
  expect(wired).not.toContain('tcp:8081');
});
