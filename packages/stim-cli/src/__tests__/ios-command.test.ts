import assert from 'node:assert';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { collectorProcessTitle } from '../collector/ownership.ts';
import { getProject, upsertProject } from '../config.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { workspaceDir, workspaceLogsDir, workspaceStateFile } from '../paths.ts';
import type { WorkspaceState } from '../supervisor/run.ts';
import { readWorkspaceState, writeWorkspaceState } from '../supervisor/run.ts';
import {
  appNameFromPath,
  buildLogFile,
  cacheDescription,
  collectorEntry,
  deviceLabel,
  devClientScheme,
  formatDuration,
  iosConfigurationSetting,
  iosFacts,
  isReleaseConfiguration,
  lastBuildRecord,
  resolveConfiguration,
  phaseLine,
  podAction,
  ensureWorkspaceStorageSafely,
  registerIos,
  replaceCollector,
  resolveMetroWithRetry,
  gateShouldRetry,
  noMetroMessage,
  pickDevClientScheme,
  schemesFromInfoPlist,
  shortHash,
  shortUdid,
  writeLastBuild,
} from '../commands/ios.ts';
import { asProcessExit, makeChildProcess, makeError, makeExecutor, makeMetroResolution } from './_factories.ts';
import { RELEASE_VERIFY_WAIT_MS } from '../engine/app-install.ts';
import { DEVICECTL_INSTALL_TIMEOUT_MS, LAUNCH_PROBE_TIMEOUT_MS } from '../engine/ios-device.ts';
import { listLeaseFiles, takeLease } from '../engine/device-lease.ts';
import { DEBUG_VERIFY_STEP_MS, type RunLease } from '../engine/device-lease-run.ts';

const UDID = 'BF2A1C3D-4E5F-6071-8293-A4B5C6D7E8F9';
const FINGERPRINT = 'a3f9b1c2d3e4f5';
const DEVICE_PID = 4242;
const IDENTITY = { sha1: 'A'.repeat(40), name: 'Apple Development: Tester (TEAMID5678)' };
const PROFILE = {
  name: 'Stim Development',
  uuid: 'a-uuid',
  teamIdentifier: 'TEAMID5678',
  expirationDate: new Date('2099-01-01T00:00:00Z'),
  provisionedDevices: ['00008030-001A2B3C4D5E802E'],
  provisionsAllDevices: false,
  getTaskAllow: true,
  certificates: [],
};

type IosDeps = NonNullable<Parameters<typeof registerIos>[1]>;

type LooseDeps = {
  [K in keyof Required<IosDeps>]?: Required<IosDeps>[K] extends (...args: infer A) => unknown
    ? (...args: A) => unknown
    : Required<IosDeps>[K];
};

type ReplaceCollectorArgs = Parameters<typeof replaceCollector>[0];

type CheckEasAuthArgs = Parameters<NonNullable<IosDeps['checkEasAuth']>>[0];
type CheckDeviceCapacityArgs = Parameters<NonNullable<IosDeps['checkDeviceCapacity']>>[0];
type AcquireBuildSlotArgs = Parameters<NonNullable<IosDeps['acquireBuildSlot']>>[0];

let tmpHome: string;
let root: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function captureAction(register: typeof registerIos, deps: LooseDeps) {
  let captured: ((opts: Record<string, unknown>) => unknown) | undefined;
  const stub = {
    command() {
      return stub;
    },
    description() {
      return stub;
    },
    option() {
      return stub;
    },
    action(fn: (opts: Record<string, unknown>) => unknown) {
      captured = fn;
      return stub;
    },
  };
  register(stub as unknown as Parameters<typeof registerIos>[0], deps as unknown as IosDeps);
  return (opts: Record<string, unknown> = {}) => {
    assert(captured);
    return captured(opts);
  };
}

function parseRemoteOption(args: string[]): unknown {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerIos(program);
  const command = program.commands[0];
  assert(command);
  command.parseOptions(args);
  return command.opts().remote;
}

function parseFirst(lines: string[]) {
  const [first] = lines;
  assert(first);
  return JSON.parse(first);
}

interface RecordedArgs {
  [key: string]: unknown;
  installIosApp: { appPath?: unknown };
  launchIosApp: { devClientScheme?: unknown; metroPort?: unknown; bundleId?: unknown };
  buildIos: { configuration?: unknown; root?: unknown };
  swapJsBundle: { cachedAppPath?: unknown; isExpo?: unknown; root?: unknown };
  verifyReleaseLaunch: { pid?: unknown };
  readBundleId: unknown;
  storeBuild: { options?: unknown; platform?: unknown; path?: unknown; key?: unknown };
  resolveBuild: { key?: unknown };
  verifyLaunch: { since?: unknown; logsDir?: unknown; platform?: unknown };
  uploadRemote: { fingerprintHash?: unknown; buildPath?: unknown };
  resolveRemote: { projectRoot?: unknown; platform?: unknown; fingerprintHash?: unknown };
  replaceCollector: { udid?: unknown; bundleId?: unknown; appName?: unknown };
  loadProjectProvider: { isExpo?: unknown };
  acquireBuildLock: { root?: unknown; platform?: unknown; logFile?: unknown; key?: unknown };
  untrackedNativeFiles: { projectRoot?: unknown };
  ensureWorkspaceStorage: unknown;
}

function harness(overrides: LooseDeps = {}) {
  const calls: { order: string[]; args: RecordedArgs } = { order: [], args: {} as RecordedArgs };
  const record = (name: string, value: unknown) => {
    calls.order.push(name);
    calls.args[name] = value;
  };
  const appPath = join(root, 'build', 'Fixture.app');

  const deps: LooseDeps = {
    findProjectRoot: () => root,
    gitCommonDir: () => null,
    repoRoot: () => null,
    detectIsExpo: () => false,
    detectBundleId: () => 'com.example.app',
    devClientScheme: () => undefined,

    ensureOwnedDevice: async (args) => {
      record('ensureOwnedDevice', args);
      return { deviceUdid: UDID, deviceName: 'stim-fixture', owned: true };
    },
    ensureBooted: async (args) => {
      record('ensureBooted', args);
      return { ok: true, udid: UDID };
    },
    resolveProjectMetro: async (port, path) => {
      record('resolveProjectMetro', { port, path });
      return { metro: { pid: 1, leader: 1, cwd: root } };
    },
    fingerprintProject: async (path) => {
      record('fingerprintProject', path);
      return { hash: FINGERPRINT, sources: [] };
    },
    untrackedNativeFiles: (args) => {
      record('untrackedNativeFiles', args);
      return [];
    },
    resolveBuild: (platform, key) => {
      record('resolveBuild', { platform, key });
      return null;
    },
    storeBuild: (platform, key, path, options) => {
      record('storeBuild', { platform, key, path, options });
      return path;
    },
    loadProjectProvider: async (projectRoot, opts) => {
      record('loadProjectProvider', { projectRoot, ...opts });
      return { none: true };
    },
    checkEasAuth: (args) => {
      record('checkEasAuth', args);
      return { ok: true, account: 'janic' };
    },
    resolveRemote: async (args) => {
      record('resolveRemote', args);
      return null;
    },
    acquireBuildLock: (args) => {
      record('acquireBuildLock', args);
      return { acquired: true, path: join(tmpHome, 'build-locks', 'ios-k.lock'), lock: { pid: process.pid } };
    },
    releaseBuildLock: (handle) => {
      record('releaseBuildLock', handle);
      return true;
    },
    waitForBuild: async (args) => {
      record('waitForBuild', args);
      throw new Error('nothing should be waited for unless the lock was held');
    },
    uploadRemote: async (args) => {
      record('uploadRemote', args);
      return { uploaded: true };
    },
    needsPrebuild: () => false,
    runPrebuild: async (...args) => {
      record('runPrebuild', args);
      return { ok: true, durationMs: 42000 };
    },
    readPodState: () => ({ hasPodfile: false, lockText: null, manifestText: null }),
    runPodInstall: async (...args) => {
      record('runPodInstall', args);
      return { ok: true, durationMs: 18000 };
    },
    buildIos: async (args) => {
      record('buildIos', args);
      return { appPath, bundleId: 'com.example.app', durationMs: 161000, scheme: 'Fixture' };
    },
    readBundleId: (path) => {
      record('readBundleId', path);
      return 'com.example.app';
    },
    installIosApp: (args) => {
      record('installIosApp', args);
      return { ok: true };
    },
    launchIosApp: (args) => {
      record('launchIosApp', args);
      return { ok: true, mode: 'launch' };
    },
    replaceCollector: async (args) => {
      record('replaceCollector', args);
      return { killed: null, pid: 5150 };
    },
    stopPreviousCollector: async (args) => {
      record('stopPreviousCollector', args);
      return { killed: null };
    },
    resolveMetroWithRetry: (resolve, port, path, opts) =>
      resolveMetroWithRetry(resolve, port, path, { ...opts, sleep: async () => {} }),
    verifyLaunch: async (args) => {
      record('verifyLaunch', args);
      return { verified: true, waitedMs: 2500, record: { event: 'bundle_build_started' } };
    },
    swapJsBundle: async (args) => {
      record('swapJsBundle', args);
      return {
        ok: true,
        appPath: join(root, 'js-swap', 'Fixture.app'),
        tmpDir: join(root, 'js-swap'),
        hermes: true,
        durationMs: 1200,
      };
    },
    verifyReleaseLaunch: async (args) => {
      record('verifyReleaseLaunch', args);
      return { verified: true, waitedMs: 3000 };
    },
    hostLanCandidates: () => [{ interfaceName: 'en0', address: '192.168.1.5' }],
    ensureLanReachable: async (args) => {
      record('ensureLanReachable', args);
      return { ok: true as const };
    },
    gateProfileForDevice: (args) => {
      record('gateProfileForDevice', args);
      return { ok: true as const, profile: PROFILE };
    },
    sealAppForDevice: (args) => {
      record('sealAppForDevice', args);
      return { ok: true as const, identity: IDENTITY, mode: 'preserve-metadata' as const };
    },
    installIosDeviceApp: (args) => {
      record('installIosDeviceApp', args);
      return { ok: true, appPath: args.appPath };
    },
    awaitIosDeviceLaunch: async (args) => {
      record('awaitIosDeviceLaunch', args);
      return { pid: DEVICE_PID };
    },
    iosDeviceProcess: (args) => {
      record('iosDeviceProcess', args);
      return DEVICE_PID;
    },
    verifyIosDeviceReleaseLaunch: async (args) => {
      record('verifyIosDeviceReleaseLaunch', args);
      return { verified: true, waitedMs: 3000, pid: DEVICE_PID };
    },
    ensureWorkspaceStorage: async (dir) => {
      record('ensureWorkspaceStorage', dir);
    },
    ...overrides,
  };
  return { deps, calls, appPath };
}

async function run(opts: Record<string, unknown> = {}, overrides: LooseDeps = {}) {
  const { deps, calls, appPath } = harness(overrides);
  const action = captureAction(registerIos, deps);
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  let exitCode: string | number | null | undefined = null;
  console.log = (l) => logs.push(String(l));
  console.error = (l) => errs.push(String(l));
  process.exit = asProcessExit((c) => {
    exitCode = c;
  });
  try {
    await action(opts);
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exitCode, calls, appPath, stderr: errs.join('\n') };
}

function reserve(port = 8082) {
  upsertProject(root, { metroPort: port });
}

function buildRecords() {
  const file = buildLogFile(root);
  return existsSync(file) ? parseNdjsonText(readFileSync(file, 'utf-8')) : [];
}

describe('the Metro gate', () => {
  test('fires before the device, boot, and fingerprint: a dead port costs a second, not a build', async () => {
    reserve();
    const { errs, exitCode, calls } = await run(
      {},
      {
        resolveProjectMetro: async () => ({ missing: true }),
      },
    );
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('ensureOwnedDevice')).toBeTruthy();
    expect(!calls.order.includes('ensureBooted')).toBeTruthy();
    expect(!calls.order.includes('fingerprintProject')).toBeTruthy();
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/STIM_NO_METRO/);
    expect(errs.join('\n')).toMatch(/stim start/);
  });

  test('a foreign listener on the reserved port is refused, not built against', async () => {
    reserve();
    const { errs, exitCode } = await run(
      {},
      {
        resolveProjectMetro: async () => ({ notOurs: 'pid 42 on port 8082 runs from /elsewhere' }),
      },
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/NOT this workspace's dev server/);
    expect(errs.join('\n')).toMatch(/STIM_NO_METRO/);
  });

  test('no reservation at all is the same failure', async () => {
    const { errs, exitCode } = await run({});
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_NO_METRO/);
  });

  test('--no-metro-check proceeds without probing the port at all', async () => {
    reserve();
    const { exitCode, calls, logs } = await run({ metroCheck: false });
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('resolveProjectMetro')).toBeTruthy();
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(calls.args.launchIosApp.metroPort).toBe(8082);
    expect(logs[0]).toContain(phaseLine('metro', 'check skipped on port 8082'));
  });

  test('--no-metro-check with no reservation still wires the app to 8081', async () => {
    const { exitCode, calls } = await run({ metroCheck: false });
    expect(exitCode).toBe(null);
    expect(calls.args.launchIosApp.metroPort).toBe(8081);
  });

  test('--no-metro-check does not poll for a bundle it was told not to expect -- and does not claim one', async () => {
    reserve();
    const { logs, calls, errs } = await run({ json: true, metroCheck: false });
    expect(!calls.order.includes('verifyLaunch')).toBeTruthy();
    expect(parseFirst(logs).launched).toBe('unverified');
    expect(errs.join('\n')).toMatch(/skipped \(--no-metro-check\)/);
  });
});

describe('the simulator boot gate', () => {
  test('waits for a new simulator to boot before fingerprinting and building', async () => {
    reserve();
    let booted = false;
    const { exitCode, calls } = await run(
      {},
      {
        ensureOwnedDevice: async () => ({
          deviceUdid: UDID,
          deviceName: 'stim-fixture',
          owned: true,
          created: true,
        }),
        ensureBooted: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          booted = true;
          return { ok: true, udid: UDID };
        },
        fingerprintProject: async () => {
          expect(booted).toBe(true);
          return { hash: FINGERPRINT, sources: [] };
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBe(true);
  });
});

describe('the Metro gate retries an indexing Metro', () => {
  test('a port that verifies after the 20-second indexing window is not refused', async () => {
    reserve();
    let attempts = 0;
    const { exitCode, calls } = await run(
      {},
      {
        resolveProjectMetro: async () => {
          attempts += 1;
          if (attempts < 4)
            return { notOurs: "pid 42 on port 8082 does not answer Metro's /status", kind: 'unresponsive' };
          return { metro: { pid: 42, leader: 42, cwd: root } };
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(attempts).toBe(4);
    expect(calls.order.includes('buildIos')).toBeTruthy();
  });

  test('a FOREIGN listener is refused immediately: waiting cannot make it ours', async () => {
    reserve();
    let attempts = 0;
    const { exitCode, errs } = await run(
      {},
      {
        resolveProjectMetro: async () => {
          attempts += 1;
          return { notOurs: 'pid 42 on port 8082 runs from /elsewhere, outside ' + root, kind: 'foreign-cwd' };
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(attempts).toBe(1);
    expect(errs.join('\n')).toMatch(/NOT this workspace's dev server/);
  });

  test('gateShouldRetry is the rule, stated once', () => {
    expect(gateShouldRetry(makeMetroResolution.missing())).toBe(true);
    expect(gateShouldRetry({ notOurs: 'x', kind: 'unresponsive' })).toBe(true);
    expect(gateShouldRetry({ notOurs: 'x', kind: 'unreadable-cwd' })).toBe(true);
    expect(gateShouldRetry({ notOurs: 'x', kind: 'foreign-cwd' })).toBe(false);
    expect(gateShouldRetry({ metro: { pid: 1 } })).toBe(false);
  });

  test('the refusal distinguishes "our supervisor is still indexing" from a foreign listener', async () => {
    reserve();
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port: 8082, mode: 'bare-inproc', startedAt: 'now' } });
    const { errs, exitCode } = await run(
      {},
      {
        resolveProjectMetro: async () => ({
          notOurs: "pid 4242 on port 8082 does not answer Metro's /status",
          kind: 'unresponsive',
        }),
      },
    );
    expect(exitCode).toBe(1);
    const text = errs.join('\n');
    expect(text).toMatch(/A supervisor record exists for port 8082/);
    expect(text).toMatch(/still be indexing/);
    expect(text).toMatch(/stim start --wait/);
    expect(text).not.toMatch(/Run `stim start` first/);
  });

  test('with no supervisor record the refusal is the plain one', async () => {
    reserve();
    const { errs } = await run({}, { resolveProjectMetro: async () => ({ missing: true }) });
    const text = errs.join('\n');
    expect(text).toMatch(/Nothing is serving this workspace's dev server on port 8082/);
    expect(text).toMatch(/Run `stim start` first/);
  });

  test('noMetroMessage names a supervisor only when it is for THIS port and alive', () => {
    const supervisor = { pid: 7, port: 8082, mode: 'expo-child' };
    expect(
      noMetroMessage({ port: 8082, resolution: makeMetroResolution.missing(), supervisor, supervisorAlive: true }),
    ).toMatch(/supervisor record exists/);
    expect(
      noMetroMessage({ port: 8082, resolution: makeMetroResolution.missing(), supervisor, supervisorAlive: false }),
    ).toMatch(/Nothing is serving/);
    expect(
      noMetroMessage({ port: 8099, resolution: makeMetroResolution.missing(), supervisor, supervisorAlive: true }),
    ).toMatch(/Nothing is serving/);
  });
});

describe('the device preparation step', () => {
  test('a slow preparation gets its own timed line, so the elapsed total is accounted for', async () => {
    reserve();
    let clock = 1_000_000;
    const { errs } = await run(
      {},
      {
        now: () => clock,
        ensureOwnedDevice: async () => {
          clock += 130_000;
          return { deviceUdid: UDID, deviceName: 'stim-fixture', owned: true };
        },
      },
    );
    expect(errs.join('\n')).toMatch(/device\s+stim-fixture \(BF2A\.\.\) prepared \(2m10s\)/);
  });

  test('a created simulator is named however fast it was', async () => {
    reserve();
    const { errs } = await run(
      {},
      {
        ensureOwnedDevice: async () => ({
          deviceUdid: UDID,
          deviceName: 'stim-fixture',
          owned: true,
          created: true,
        }),
      },
    );
    expect(errs.join('\n')).toMatch(/device\s+stim-fixture \(BF2A\.\.\) created \(/);
  });

  test('a preparation that costs nothing prints nothing of its own', async () => {
    reserve();
    const { errs } = await run();
    expect(errs.join('\n')).not.toMatch(/prepared \(/);
  });
});

describe('launch verification', () => {
  test('a verified launch reports launched: true and says what it saw', async () => {
    reserve();
    const { logs, errs, exitCode, calls } = await run({ json: true });
    expect(exitCode).toBe(null);
    expect(parseFirst(logs).launched).toBe(true);
    expect(errs.join('\n')).toMatch(/verify.*bundle loaded, stable for 3s -- the first screen may still be rendering/);
    expect(calls.args.verifyLaunch.logsDir).toBe(workspaceLogsDir(root));
    expect(Number.isFinite(calls.args.verifyLaunch.since)).toBeTruthy();
    expect(calls.args.verifyLaunch.platform).toBe('ios');
  });

  test('the ready line claims only what was proven, and says a paint is not part of it', async () => {
    reserve();
    const { errs } = await run(
      {},
      { verifyLaunch: async () => ({ verified: true, processAlive: true, waitedMs: 11_100 }) },
    );
    expect(errs.join('\n')).toMatch(
      /verify\s+bundle loaded, process alive, stable for 3s -- the first screen may still be rendering \(11\.1s total\)/,
    );
  });

  test('the picker: an unverified launch is launched: "unverified", exit 0, and a loud warning', async () => {
    reserve();
    const { logs, errs, exitCode } = await run(
      { json: true },
      {
        verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
        detectIsExpo: () => true,
      },
    );
    expect(exitCode).toBe(null);
    expect(parseFirst(logs).launched).toBe('unverified');
    const text = errs.join('\n');
    expect(text).toMatch(/UNVERIFIED/);
    expect(text).toMatch(/DEVELOPMENT SERVERS/);
    expect(text).toMatch(/localhost:8082/);
  });

  test('a dev-client stall carries the exact openurl to retry without an alert step', async () => {
    reserve();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { expo: '52.0.0', 'expo-dev-client': '5.0.0' },
      }),
    );
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fixture' } }));
    const { errs, logs } = await run(
      { json: true },
      {
        devClientScheme,
        verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
      },
    );
    const text = errs.join('\n');
    expect(text).not.toMatch(/Open in/);
    expect(text).toMatch(new RegExp(`xcrun simctl openurl ${UDID}`));
    expect(text).toMatch(/fixture:\/\/expo-development-client/);
    expect(parseFirst(logs).launched).toBe('unverified');
  });

  test('the collector is attached BEFORE the poll: its 20s are the ones worth logging', async () => {
    reserve();
    const { calls } = await run({});
    expect(calls.order.indexOf('replaceCollector') < calls.order.indexOf('verifyLaunch')).toBeTruthy();
  });

  test('the outcome lands in the timeline, not only on stderr', async () => {
    reserve();
    await run({}, { verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) });
    const record = buildRecords().find((r) => r.event === 'launch_unverified');
    expect(record).toBeTruthy();
    assert(record);
    expect(record.level).toBe('warn');
    expect(record.msg).toMatch(/no bundle request .* reached this workspace's Metro on port 8082/);

    const fresh = await run({});
    expect(fresh.exitCode).toBe(null);
    expect(buildRecords().some((r) => r.event === 'launch_verified' && r.level === 'info')).toBeTruthy();
  });

  test('the outcome line on stdout says UNVERIFIED rather than a plain OK', async () => {
    reserve();
    const { logs } = await run({}, { verifyLaunch: async () => ({ verified: false, timedOut: true }) });
    expect(logs[0]).toMatch(/UNVERIFIED/);
    expect(logs[0]).toContain(phaseLine('metro', 'state unverified on port 8082'));
  });
});

describe('global workspace storage', () => {
  test('workspace storage is prepared before the device, the gate or the build log', async () => {
    reserve();
    const { calls } = await run({});
    expect(calls.args.ensureWorkspaceStorage).toBe(root);
    expect(calls.order[0]).toBe('ensureWorkspaceStorage');
  });

  test('the default seam creates global storage without touching the project', async () => {
    const notes: string[] = [];
    const project = '/definitely/not/a/checkout';
    const result = await ensureWorkspaceStorageSafely(project, { note: (l) => notes.push(l) });
    expect(typeof result).toBe('string');
    expect(existsSync(join(project, '.stim'))).toBe(false);
    expect(notes).toEqual([]);
  });
});

describe('the cache', () => {
  test('a hit skips prebuild, pods AND xcodebuild entirely', async () => {
    reserve();
    const cachedApp = join(tmpHome, 'build-cache', 'ios', 'k', 'Fixture.app');
    const { exitCode, calls, logs } = await run(
      { json: true },
      {
        resolveBuild: () => cachedApp,
        needsPrebuild: () => true,
        readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
      },
    );
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('runPrebuild')).toBeTruthy();
    expect(!calls.order.includes('runPodInstall')).toBeTruthy();
    expect(!calls.order.includes('storeBuild')).toBeTruthy();
    expect(calls.args.installIosApp.appPath).toBe(cachedApp);
    const facts = parseFirst(logs);
    expect(facts.cacheHit).toBe('local');
    expect(facts.appPath).toBe(cachedApp);
  });

  test('a hit reads the bundle id from the cached binary, not from the config', async () => {
    reserve();
    const { calls } = await run(
      {},
      {
        resolveBuild: () => '/cache/Fixture.app',
        readBundleId: () => 'com.example.fromplist',
        detectBundleId: () => 'com.example.fromconfig',
      },
    );
    expect(calls.args.launchIosApp.bundleId).toBe('com.example.fromplist');
  });

  test('a miss runs prebuild, then pods, then a RE-fingerprint, then the build, then stores it', async () => {
    reserve();
    const { exitCode, calls, appPath } = await run(
      {},
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
      },
    );
    expect(exitCode).toBe(null);
    const order = calls.order.filter((c) =>
      [
        'fingerprintProject',
        'runPrebuild',
        'runPodInstall',
        'buildIos',
        'storeBuild',
        'installIosApp',
        'launchIosApp',
      ].includes(c),
    );
    expect(order).toEqual([
      'fingerprintProject',
      'runPrebuild',
      'runPodInstall',
      'fingerprintProject',
      'buildIos',
      'storeBuild',
      'installIosApp',
      'launchIosApp',
    ]);
    expect(calls.args.storeBuild.path).toBe(appPath);
    expect(calls.args.storeBuild.platform).toBe('ios');
  });

  test('an unresolvable fingerprint is STIM_NO_FINGERPRINT, never an unkeyed build', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({}, { fingerprintProject: async () => null });
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/STIM_NO_FINGERPRINT/);
  });

  test('--no-build-cache looks nothing up: not the local cache, not the provider', async () => {
    reserve();
    const cachedApp = join(tmpHome, 'build-cache', 'ios', 'k', 'Fixture.app');
    const { exitCode, calls, logs } = await run(
      { json: true, buildCache: false },
      {
        resolveBuild: () => {
          throw new Error('the local cache must not be consulted');
        },
        loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
        resolveRemote: () => {
          throw new Error('the provider must not be consulted');
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('resolveRemote')).toBeTruthy();
    const facts = parseFirst(logs);
    expect(facts.cacheHit).toBe(false);
    expect(facts.cacheSkipped).toBe(true);
    expect(!facts.appPath.startsWith(cachedApp)).toBeTruthy();
  });

  test('--no-build-cache still STORES -- over the entry it was told not to trust -- and still uploads', async () => {
    reserve();
    const { exitCode, calls } = await run(
      { buildCache: false },
      {
        loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.args.storeBuild.options).toEqual({ overwrite: true, sources: [] });
    expect(calls.order.includes('uploadRemote')).toBeTruthy();
  });

  test('a default run stores without overwriting: two worktrees at the same fingerprint agree', async () => {
    reserve();
    const { calls } = await run({});
    expect(calls.args.storeBuild.options).toEqual({ overwrite: false, sources: [] });
  });

  test('a build that follows a failed swap REPLACES the entry that just failed (Android form)', async () => {
    reserve();
    const cached = join(root, 'cached', 'Fixture.app');
    const { exitCode, calls } = await run(
      { configuration: 'Release' },
      {
        resolveBuild: () => cached,
        swapJsBundle: async () => ({ ok: false, step: 'codesign', reason: 'the seal would not take', lastLines: [] }),
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(calls.args.storeBuild.options).toEqual({ overwrite: true, sources: [] });
  });

  test('a cache store that fails does not fail a successful build', async () => {
    reserve();
    const { exitCode, errs, calls } = await run(
      {},
      {
        storeBuild: () => {
          throw new Error('no space left on device');
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.order.includes('launchIosApp')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/Could not store the build/);
  });
});

describe('the remote cache', () => {
  const provider = (name = 'eas') => ({ provider: { plugin: {}, options: {} }, name });

  test('a LOCAL hit never consults the provider at all', async () => {
    reserve();
    const { calls } = await run({}, { resolveBuild: () => '/cache/Fixture.app' });
    expect(!calls.order.includes('loadProjectProvider')).toBeTruthy();
    expect(!calls.order.includes('resolveRemote')).toBeTruthy();
  });

  test('a bare RN project never has its config read: the community CLI has no provider concept', async () => {
    reserve();
    const { calls } = await run({}, { detectIsExpo: () => false });
    expect(calls.args.loadProjectProvider.isExpo).toBe(false);
    expect(!calls.order.includes('resolveRemote')).toBeTruthy();
  });

  test('an Expo project with no provider configured builds exactly as before', async () => {
    reserve();
    const { exitCode, calls, errs } = await run({}, { detectIsExpo: () => true });
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('resolveRemote')).toBeTruthy();
    expect(!calls.order.includes('uploadRemote')).toBeTruthy();
    expect(!/cache/.test(errs.join('\n'))).toBeTruthy();
  });

  test('a remote HIT is stored into the local cache and installed, without building', async () => {
    reserve();
    const remoteApp = join(root, 'downloaded', 'Fixture.app');
    const storedApp = join(tmpHome, 'build-cache', 'ios', 'key', 'Fixture.app');
    const stored: { platform: unknown; key: unknown; path: unknown; options: unknown }[] = [];
    const { exitCode, calls, logs, errs } = await run(
      { json: true },
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => provider(),
        resolveRemote: async () => ({ appPath: remoteApp }),
        storeBuild: (platform, key, path, options) => {
          stored.push({ platform, key, path, options });
          return storedApp;
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('runPrebuild')).toBeTruthy();
    expect(stored.length).toBe(1);
    const storedEntry = stored[0];
    assert(storedEntry);
    expect(storedEntry.path).toBe(remoteApp);
    expect(storedEntry.key).toBe(calls.args.resolveBuild.key);
    expect(calls.args.installIosApp.appPath).toBe(storedApp);
    expect(errs.join('\n')).toMatch(/^  cache {7}remote hit \(eas\) -> stored locally \(\d+ms\)$/m);
    const facts = parseFirst(logs);
    expect(facts.cacheHit).toBe('remote');
    expect(facts.appPath).toBe(storedApp);
    const stateAfter = readWorkspaceState(root);
    assert(stateAfter?.lastBuild);
    expect(stateAfter.lastBuild.cacheHit).toBe('remote');
  });

  test("the provider is asked with this workspace's fingerprint and platform", async () => {
    reserve();
    const { calls } = await run({}, { detectIsExpo: () => true, loadProjectProvider: async () => provider('./p.cjs') });
    expect(calls.args.resolveRemote.platform).toBe('ios');
    expect(calls.args.resolveRemote.fingerprintHash).toBe(FINGERPRINT);
    expect(calls.args.resolveRemote.projectRoot).toBe(root);
  });

  test('a remote MISS builds, stores locally, and uploads the result', async () => {
    reserve();
    const { exitCode, calls, errs, appPath } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => provider(),
      },
    );
    expect(exitCode).toBe(null);
    const relevant = calls.order.filter((c) =>
      ['resolveBuild', 'resolveRemote', 'buildIos', 'storeBuild', 'uploadRemote', 'installIosApp'].includes(c),
    );
    expect(relevant).toEqual([
      'resolveBuild',
      'resolveRemote',
      'buildIos',
      'storeBuild',
      'uploadRemote',
      'installIosApp',
    ]);
    expect(calls.args.uploadRemote.buildPath).toBe(appPath);
    expect(calls.args.uploadRemote.fingerprintHash).toBe(FINGERPRINT);
    expect(errs.join('\n')).toMatch(/^  cache {7}uploaded \(eas\)$/m);
  });

  test('a provider that THROWS degrades to a local-only run with a note', async () => {
    reserve();
    const { exitCode, calls, errs } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => provider(),
        resolveRemote: async () => ({ failed: 'EAS session expired' }),
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/cache.*EAS session expired.*building instead/);
  });

  test('a provider that TIMES OUT does not stall the loop, and the command stops holding the process open', async () => {
    reserve();
    const exits: (string | number | null | undefined)[] = [];
    const originalExit = process.exit;
    process.exit = asProcessExit((code) => {
      exits.push(code);
    });
    let errs;
    let calls;
    try {
      ({ errs, calls } = await run(
        {},
        {
          detectIsExpo: () => true,
          loadProjectProvider: async () => provider(),
          resolveRemote: async () => ({ timedOut: true }),
        },
      ));
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.exit = originalExit;
    }
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/did not answer within 30s; building instead/);
    expect(exits).toEqual([0]);
  });

  test('a provider that cannot be loaded says so ONCE and builds', async () => {
    reserve();
    const { exitCode, calls, errs } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => ({
          unavailable: 'the EAS build cache needs the `eas-build-cache-provider` package',
        }),
      },
    );
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('resolveRemote')).toBeTruthy();
    expect(calls.order.includes('buildIos')).toBeTruthy();
    const lines = errs
      .join('\n')
      .split('\n')
      .filter((l) => /provider not usable/.test(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/eas-build-cache-provider/);
  });

  test('a remote hit that cannot be stored locally is still installed from where it landed', async () => {
    reserve();
    const remoteApp = join(root, 'downloaded', 'Fixture.app');
    const { exitCode, calls, errs } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => provider(),
        resolveRemote: async () => ({ appPath: remoteApp }),
        storeBuild: () => {
          throw new Error('no space left on device');
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.args.installIosApp.appPath).toBe(remoteApp);
    expect(errs.join('\n')).toMatch(/could not be stored locally/);
  });

  test('a logged-out EAS session skips the remote tier and says so, once', async () => {
    reserve();
    const { exitCode, calls, errs } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
        checkEasAuth: () => ({ failed: true, code: 'logged-out', reason: 'Not logged in' }),
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('resolveRemote')).toBeTruthy();
    expect(!calls.order.includes('uploadRemote')).toBeTruthy();
    const lines = errs
      .join('\n')
      .split('\n')
      .filter((l) => /eas is not authenticated/.test(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/eas login/);
    expect(lines[0]).toMatch(/EXPO_TOKEN/);
    expect(lines[0]).toMatch(/local cache only/);
  });

  test('the session is checked with the owner the config named, and only once', async () => {
    reserve();
    const asked: CheckEasAuthArgs[] = [];
    await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
        checkEasAuth: (args) => {
          asked.push(args);
          return { ok: true, account: 'janic' };
        },
      },
    );
    expect(asked.length).toBe(1);
    const askedEntry = asked[0];
    assert(askedEntry);
    expect(askedEntry.owner).toBe('th3rd-wave');
    expect(askedEntry.projectRoot).toBe(root);
  });

  test('a custom provider is never asked about EAS at all', async () => {
    reserve();
    let asked = false;
    const { calls } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => provider('./p.cjs'),
        checkEasAuth: () => {
          asked = true;
          return { failed: true, code: 'logged-out' };
        },
      },
    );
    expect(asked).toBe(false);
    expect(calls.order.includes('resolveRemote')).toBeTruthy();
  });

  test('a session that could not be established changes nothing', async () => {
    reserve();
    const { calls, errs } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => provider(),
        checkEasAuth: () => ({ unknown: 'eas whoami timed out after 15000ms' }),
      },
    );
    expect(calls.order.includes('resolveRemote')).toBeTruthy();
    expect(!/not authenticated/.test(errs.join('\n'))).toBeTruthy();
  });

  test('a session on the wrong account warns, naming both, and still consults the cache', async () => {
    reserve();
    const { calls, errs } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
        checkEasAuth: () => ({ failed: true, code: 'wrong-account', account: 'janic', owner: 'th3rd-wave' }),
      },
    );
    expect(calls.order.includes('resolveRemote')).toBeTruthy();
    const line = errs
      .join('\n')
      .split('\n')
      .find((l) => /janic/.test(l));
    expect(line).toMatch(/th3rd-wave/);
    expect(line).toMatch(/anyway/);
  });

  test('a provider failure that reads as auth gets the auth note, not the generic one', async () => {
    reserve();
    const { errs } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => provider(),
        checkEasAuth: () => ({ unknown: 'offline' }),
        resolveRemote: async () => ({ failed: 'Error: Not logged in' }),
      },
    );
    expect(errs.join('\n')).toMatch(/eas is not authenticated \(Error: Not logged in\)/);
    expect(!/could not be used/.test(errs.join('\n'))).toBeTruthy();
  });

  test('a failed upload is a note, never a failed run', async () => {
    reserve();
    const { exitCode, errs, logs } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => provider(),
        uploadRemote: async () => ({ failed: '403 forbidden' }),
      },
    );
    expect(exitCode).toBe(null);
    expect(logs.length).toBe(1);
    expect(errs.join('\n')).toMatch(/upload failed: 403 forbidden/);
  });
});

describe('single-flight builds', () => {
  const heldBy = (pid = 41233, projectRoot = '/w/app-999') => ({
    held: {
      pid,
      projectRoot,
      startedAt: '2026-08-25T10:00:00.000Z',
      logFile: `${projectRoot}/.stim/logs/build-ios.ndjson`,
    },
    path: '/home/build-locks/ios-key.lock',
  });

  test('the lock is attempted only after BOTH cache levels have missed', async () => {
    reserve();
    const { calls } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
      },
    );
    const order = calls.order.filter((c) =>
      ['resolveBuild', 'resolveRemote', 'acquireBuildLock', 'buildIos', 'storeBuild', 'releaseBuildLock'].includes(c),
    );
    expect(order).toEqual([
      'resolveBuild',
      'resolveRemote',
      'acquireBuildLock',
      'buildIos',
      'storeBuild',
      'releaseBuildLock',
    ]);
    expect(calls.args.acquireBuildLock.platform).toBe('ios');
    expect(calls.args.acquireBuildLock.key).toBe(calls.args.resolveBuild.key);
    expect(calls.args.acquireBuildLock.root).toBe(root);
    expect(calls.args.acquireBuildLock.logFile).toBe(buildLogFile(root));
  });

  test('a local hit never takes the lock: there is nothing to build', async () => {
    reserve();
    const { calls } = await run({}, { resolveBuild: () => '/cache/Fixture.app' });
    expect(!calls.order.includes('acquireBuildLock')).toBeTruthy();
    expect(!calls.order.includes('waitForBuild')).toBeTruthy();
  });

  test('a remote hit never takes the lock either', async () => {
    reserve();
    const { calls } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
        resolveRemote: async () => ({ appPath: '/downloads/Fixture.app' }),
      },
    );
    expect(!calls.order.includes('acquireBuildLock')).toBeTruthy();
  });

  test('--no-build-cache neither waits nor acquires', async () => {
    reserve();
    const { calls } = await run(
      { buildCache: false },
      {
        acquireBuildLock: () => {
          throw new Error('the lock must not be attempted');
        },
        waitForBuild: () => {
          throw new Error('nothing may be waited for');
        },
      },
    );
    expect(calls.order.includes('buildIos')).toBeTruthy();
  });

  test('the loser waits, installs the artifact, and compiles nothing', async () => {
    reserve();
    const waited = '/cache/ios/key/Fixture.app';
    const { exitCode, calls, logs, stderr } = await run(
      { json: true },
      {
        acquireBuildLock: () => heldBy(41233, '/w/app-999'),
        waitForBuild: async () => ({ hit: waited, waitedMs: 761000 }),
        needsPrebuild: () => true,
        readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
      },
    );
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('runPrebuild')).toBeTruthy();
    expect(!calls.order.includes('runPodInstall')).toBeTruthy();
    expect(!calls.order.includes('storeBuild')).toBeTruthy();
    expect(!calls.order.includes('releaseBuildLock')).toBeTruthy();
    expect(calls.args.installIosApp.appPath).toBe(waited);

    const facts = parseFirst(logs);
    expect(facts.cacheHit).toBe('local');
    expect(facts.waitedForBuild).toEqual({ pid: 41233, ms: 761000 });
    expect(stderr).toMatch(/waited 12m41s for \/w\/app-999's build -> installed from cache/);
  });

  test('a run that did not wait reports waitedForBuild: null', async () => {
    reserve();
    const { logs } = await run({ json: true });
    expect(parseFirst(logs).waitedForBuild).toBe(null);
  });

  test('the wait is announced when it starts, naming who is building and what to tail', async () => {
    reserve();
    const { stderr } = await run(
      {},
      {
        acquireBuildLock: () => heldBy(41233, '/w/app-999'),
        waitForBuild: async () => ({ hit: '/cache/Fixture.app', waitedMs: 1000 }),
      },
    );
    expect(stderr).toMatch(/\/w\/app-999/);
    expect(stderr).toMatch(/41233/);
    expect(stderr).toMatch(/build-ios\.ndjson/);
  });

  test('the wait gets the progress line onto stderr as it happens', async () => {
    reserve();
    const { stderr, logs } = await run(
      { json: true },
      {
        acquireBuildLock: () => heldBy(),
        waitForBuild: async ({ out }) => {
          out?.('build       waiting on /w/app-999 (pid 41233, 4m elapsed) -- tail /w/app-999/x.ndjson');
          return { hit: '/cache/Fixture.app', waitedMs: 240000 };
        },
      },
    );
    expect(stderr).toMatch(/waiting on \/w\/app-999 \(pid 41233, 4m elapsed\)/);
    expect(logs.length).toBe(1);
  });

  test('a builder that failed makes the waiter take over and build', async () => {
    reserve();
    let acquires = 0;
    const { exitCode, calls, stderr } = await run(
      {},
      {
        acquireBuildLock: () =>
          ++acquires === 1 ? heldBy() : { acquired: true, path: '/lock', lock: { pid: process.pid } },
        waitForBuild: async () => ({
          builderFailed: 'the build lock was released without an artifact',
          waitedMs: 4000,
        }),
      },
    );
    expect(exitCode).toBe(null);
    expect(acquires).toBe(2);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(calls.order.includes('releaseBuildLock')).toBeTruthy();
    expect(stderr).toMatch(/without an artifact/);
  });

  test('losing the takeover race builds anyway rather than queueing again', async () => {
    reserve();
    let waits = 0;
    const { exitCode, calls } = await run(
      {},
      {
        acquireBuildLock: () => heldBy(),
        waitForBuild: async () => {
          waits++;
          return { builderFailed: 'the builder (pid 41233) is gone', waitedMs: 10 };
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(waits).toBe(1);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('releaseBuildLock')).toBeTruthy();
  });

  test('a FAILED build releases the lock', async () => {
    reserve();
    const { exitCode, calls } = await run(
      {},
      {
        buildIos: async () => ({ failed: true, code: 'STIM_BUILD_FAILED', durationMs: 90000, diagnostics: [] }),
      },
    );
    expect(exitCode).toBe(1);
    expect(calls.order.includes('releaseBuildLock')).toBeTruthy();
  });

  test('a build that THROWS releases the lock on the way out', async () => {
    reserve();
    const released: { handle?: { lock?: { pid?: number | null } } | null } = {};
    await expect(() =>
      run(
        {},
        {
          buildIos: async () => {
            throw new Error('xcodebuild exploded');
          },
          releaseBuildLock: (handle) => {
            released.handle = handle;
            return true;
          },
        },
      ),
    ).rejects.toThrow(/xcodebuild exploded/);
    expect(released.handle).toBeTruthy();
    assert(released.handle?.lock);
    expect(released.handle.lock.pid).toBe(process.pid);
  });

  test('a prebuild or pod failure releases the lock too', async () => {
    reserve();
    const { exitCode, calls } = await run(
      {},
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        runPrebuild: async () => ({ failed: true, code: 'STIM_PREBUILD_FAILED', reason: 'no' }),
      },
    );
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(calls.order.includes('releaseBuildLock')).toBeTruthy();
  });

  test('a wait that hits its ceiling is a refusal with a code, not a crash', async () => {
    reserve();
    const { exitCode, errs, logs, calls } = await run(
      { json: true },
      {
        acquireBuildLock: () => heldBy(),
        waitForBuild: async () => {
          throw makeError('Waited 90m ... The lock is /home/build-locks/ios-key.lock', {
            code: 'STIM_BUILD_WAIT_TIMEOUT',
            lockPath: '/home/build-locks/ios-key.lock',
          });
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/STIM_BUILD_WAIT_TIMEOUT/);
    expect(parseFirst(logs).code).toBe('STIM_BUILD_WAIT_TIMEOUT');
  });

  test('a lock that cannot be created is a note, and the build proceeds', async () => {
    reserve();
    const { exitCode, calls, errs } = await run(
      {},
      {
        acquireBuildLock: () => {
          throw new Error('EROFS: read-only file system');
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/read-only file system/);
  });
});

describe('pods', () => {
  test('a sandbox that does not match the lock is installed before the build', async () => {
    reserve();
    const { calls, errs } = await run(
      {},
      {
        readPodState: () => ({ hasPodfile: true, lockText: 'PODS: A', manifestText: 'PODS: B' }),
      },
    );
    expect(calls.order.includes('runPodInstall')).toBeTruthy();
    expect(calls.order.indexOf('runPodInstall') < calls.order.indexOf('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/^  pods {8}.*differ -> installed with `pod install` \(18s\)/m);
  });

  test('the pods phase names the bundler command and prints the engine notes', async () => {
    reserve();
    const { errs } = await run(
      {},
      {
        readPodState: () => ({ hasPodfile: true, lockText: 'PODS: A', manifestText: 'PODS: B' }),
        runPodInstall: async () => ({
          ok: true,
          durationMs: 18000,
          command: 'bundle exec pod install',
          notes: ['`bundle` is not on PATH'],
        }),
      },
    );
    const stderr = errs.join('\n');
    expect(stderr).toMatch(/^  pods {8}.*-> installed with `bundle exec pod install` \(18s\)/m);
    expect(stderr).toMatch(/^  pods {8}`bundle` is not on PATH/m);
  });

  test('a Podfile whose pods have never been installed is installed too', async () => {
    reserve();
    const { calls } = await run(
      {},
      {
        readPodState: () => ({ hasPodfile: true, lockText: null, manifestText: null }),
      },
    );
    expect(calls.order.includes('runPodInstall')).toBeTruthy();
  });

  test('a project with no CocoaPods at all is skipped silently', async () => {
    reserve();
    const { calls, errs } = await run(
      {},
      {
        readPodState: () => ({ hasPodfile: false, lockText: null, manifestText: null }),
      },
    );
    expect(!calls.order.includes('runPodInstall')).toBeTruthy();
    expect(!/^pods/m.test(errs.join('\n'))).toBeTruthy();
  });

  test('a failed pod install stops the run with STIM_DEPS_FAILED', async () => {
    reserve();
    const { errs, exitCode, calls } = await run(
      {},
      {
        readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
        runPodInstall: async () => ({
          failed: true,
          code: 'STIM_DEPS_FAILED',
          reason: '`pod install` failed (exit code 1).',
          lastLines: ['[!] CocoaPods could not find compatible versions'],
        }),
      },
    );
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/STIM_DEPS_FAILED/);
    expect(errs.join('\n')).toMatch(/could not find compatible versions/);
  });
});

describe('failure output', () => {
  test('a failed build prints the extracted diagnostics and the log path, never the transcript', async () => {
    reserve();
    const { errs, logs, exitCode } = await run(
      { json: true },
      {
        buildIos: async () => ({
          failed: true,
          code: 'STIM_BUILD_FAILED',
          durationMs: 161000,
          truncated: 3,
          exitCode: 65,
          diagnostics: [
            { file: '/w/ios/AppDelegate.mm', line: 12, column: 4, message: "use of undeclared identifier 'foo'" },
            {
              message: 'The sandbox is not in sync with the Podfile.lock',
              remedy: 'Run `pod install` in ios/ and build again.',
            },
          ],
          tail: ['** BUILD FAILED **'],
        }),
      },
    );
    expect(exitCode).toBe(1);
    expect(logs.length).toBe(1);
    const payload = parseFirst(logs);
    expect(payload.code).toBe('STIM_BUILD_FAILED');
    expect(payload.message).toMatch(/xcodebuild` failed/);
    expect(payload.message).toMatch(/exit code 65/);
    expect(payload.remedy).toBeTruthy();
    expect(payload.remedy).toMatch(/pod install/);
    const text = errs.join('\n');
    expect(text).toMatch(/^  build {7}FAILED after 2m41s/m);
    expect(text).toMatch(/AppDelegate\.mm:12:4: use of undeclared identifier 'foo'/);
    expect(text).toMatch(/The sandbox is not in sync/);
    expect(text).toMatch(/and 3 more diagnostics in the log/);
    expect(text).toMatch(new RegExp(`^  log {9}${buildLogFile(root).replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'm'));
    expect(text).toMatch(/^  failed {6}STIM_BUILD_FAILED/m);
  });

  test('--json puts one parseable {code, message, remedy} line on stdout when the gate refuses', async () => {
    const { logs, exitCode } = await run({ json: true });
    expect(exitCode).toBe(1);
    expect(logs.length).toBe(1);
    const payload = parseFirst(logs);
    expect(payload.code).toBe('STIM_NO_METRO');
    expect(payload.message).toMatch(/no dev server/);
    expect(payload.remedy).toMatch(/stim start/);
  });

  test('without --json a failure still writes nothing to stdout', async () => {
    const { logs, exitCode } = await run({});
    expect(exitCode).toBe(1);
    expect(logs).toEqual([]);
  });

  test('a build with no recognizable diagnostic falls back to the transcript tail', async () => {
    reserve();
    const { errs } = await run(
      {},
      {
        buildIos: async () => ({
          failed: true,
          code: 'STIM_BUILD_FAILED',
          durationMs: 1000,
          truncated: 0,
          diagnostics: [],
          tail: ['xcodebuild: error: something inscrutable'],
        }),
      },
    );
    expect(errs.join('\n')).toMatch(/no recognizable diagnostic/);
    expect(errs.join('\n')).toMatch(/something inscrutable/);
  });

  test('a failed build writes a Contract-4 record with the error code', async () => {
    reserve();
    await run(
      {},
      {
        buildIos: async () => ({
          failed: true,
          code: 'STIM_BUILD_FAILED',
          durationMs: 5000,
          diagnostics: [],
          tail: [],
        }),
      },
    );
    const stateAfterFail = readWorkspaceState(root);
    assert(stateAfterFail?.lastBuild);
    const { lastBuild } = stateAfterFail;
    expect(lastBuild.status).toBe('failed');
    expect(lastBuild.errorCode).toBe('STIM_BUILD_FAILED');
    expect(lastBuild.platform).toBe('ios');
    expect(lastBuild.fingerprint).toBe(FINGERPRINT);
    expect(lastBuild.cacheHit).toBe(false);
    expect(lastBuild.startedAt).toBeTruthy();
  });

  test('a device that will not boot is refused at install, after the build has been stored', async () => {
    reserve();
    const { errs, exitCode, calls } = await run(
      {},
      {
        ensureBooted: async () => ({ failed: true, reason: 'Simulator BF2A no longer exists.' }),
      },
    );
    expect(exitCode).toBe(1);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('installIosApp')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/no longer exists/);
    expect(errs.join('\n')).toMatch(/STIM_NO_DEVICE/);
  });

  test('a failed install is reported with its own code and a failed record', async () => {
    reserve();
    const { errs, exitCode } = await run(
      {},
      {
        installIosApp: () => ({ failed: true, code: 'STIM_INSTALL_FAILED', reason: 'simctl install failed' }),
      },
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_INSTALL_FAILED/);
    const stateAfterInstall = readWorkspaceState(root);
    assert(stateAfterInstall?.lastBuild);
    expect(stateAfterInstall.lastBuild.errorCode).toBe('STIM_INSTALL_FAILED');
  });
});

describe('success output', () => {
  test('the phase lines stream on stderr and the final stdout block has complete agent facts', async () => {
    reserve();
    const { logs, errs, exitCode } = await run({});
    expect(exitCode).toBe(null);
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/^OK: com\.example\.app on stim-fixture \(BF2A\.\.\), Metro port 8082/);
    expect(logs[0]).toContain(phaseLine('device', `stim-fixture (${UDID})`));
    expect(logs[0]).toContain(phaseLine('app', 'com.example.app'));
    expect(logs[0]).toContain(phaseLine('metro', 'running on port 8082'));
    expect(logs[0]).toContain(phaseLine('cache', 'built'));
    expect(logs[0]).toContain(phaseLine('compilation cache', 'unavailable; Xcode did not report reliable statistics'));
    expect(logs[0]).toContain(phaseLine('logs', workspaceLogsDir(root)));
    const text = errs.join('\n');
    expect(text).toMatch(/^  device {6}stim-fixture \(BF2A\.\.\) booted \(\d+ms\)$/m);
    expect(text).toMatch(/^  fingerprint a3f9b1\.\. miss \(\d+ms\)$/m);
    expect(text).toMatch(/^  build {7}compiling Debug with xcodebuild$/m);
    expect(text).toMatch(/^  build {7}ok \(2m41s\)$/m);
    expect(text).toMatch(/^  install {5}-> stim-fixture \(BF2A\.\.\) \(\d+ms\)$/m);
    expect(text).toMatch(/^  launch {6}com\.example\.app \(\d+ms\)$/m);
  });

  test('--json emits exactly one line of facts on stdout', async () => {
    reserve();
    const { logs, appPath } = await run({ json: true });
    expect(logs.length).toBe(1);
    const facts = parseFirst(logs);
    expect(facts.platform).toBe('ios');
    expect(facts.udid).toBe(UDID);
    expect(facts.deviceName).toBe('stim-fixture');
    expect(facts.fingerprint).toBe(FINGERPRINT);
    expect(facts.cacheKey).toMatch(new RegExp(`^${FINGERPRINT}-debug-sim$`));
    expect(facts.cacheHit).toBe(false);
    expect(facts.compilationCache).toEqual({
      status: 'unavailable',
      hits: null,
      cacheableTasks: null,
      hitRatePercent: null,
    });
    expect(facts.appPath).toBe(appPath);
    expect(facts.bundleId).toBe('com.example.app');
    expect(facts.launched).toBe(true);
    expect(facts.metroPort).toBe(8082);
    expect(facts.logs).toEqual({ dir: workspaceLogsDir(root) });
    expect(typeof facts.durationMs).toBe('number');
  });

  test('the launch is recorded in the build log as a marker, so `logs --errors` can bound the window', async () => {
    reserve();
    await run({});
    const marker = buildRecords().find((r) => r.marker);
    expect(marker).toBeTruthy();
    assert(marker);
    expect(marker.src).toBe('build');
    expect(marker.msg).toMatch(/launched com\.example\.app on BF2A.* against Metro port 8082/);
  });
});

describe('Contract 6: the dev-client scheme', () => {
  test('is passed when the app config has one and the dev client is installed', async () => {
    reserve();
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fixture' } }));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { expo: '52.0.0', 'expo-dev-client': '5.0.0' },
      }),
    );
    const { calls } = await run({}, { devClientScheme });
    expect(calls.args.launchIosApp.devClientScheme).toBe('fixture');
  });

  test('is undefined when the app config has no scheme: a plain launch plus RCT_jsLocation works everywhere', async () => {
    reserve();
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fixture' } }));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        dependencies: { 'expo-dev-client': '5.0.0' },
      }),
    );
    const { calls } = await run({}, { devClientScheme });
    expect(calls.args.launchIosApp.devClientScheme).toBe(undefined);
  });

  test('is undefined without expo-dev-client, whose launcher is what answers the deep link', async () => {
    reserve();
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fixture' } }));
    const { calls } = await run({}, { devClientScheme });
    expect(calls.args.launchIosApp.devClientScheme).toBe(undefined);
  });
});

function collectorProcessCommand(pid: number): string {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

// Spawns a real detached process so the default `verifyCollectorOwnership` reads its actual
// live command (via ps on darwin, via /proc/[pid]/cmdline on linux) instead of a mocked
// executor, which only exercises the darwin ps path and fails closed for the wrong reason on
// Linux CI.
async function spawnFakeCollector(title: string | null): Promise<ChildProcess> {
  const rename = title ? `process.title = ${JSON.stringify(title)};` : '';
  const child = spawn(process.execPath, ['-e', `${rename} setInterval(() => {}, 1000);`], { stdio: 'ignore' });
  const expected = title ?? process.execPath;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !collectorProcessCommand(child.pid as number).startsWith(expected)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return child;
}

function collectorExits(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe('the collector', () => {
  function collectorHarness({
    state = null,
    killImpl = null,
    verify = () => ({ status: 'ours' as const }),
  }: {
    state?: WorkspaceState | null;
    killImpl?: ((pid: number, signal: NodeJS.Signals) => void) | null;
    verify?: NonNullable<ReplaceCollectorArgs['verify']>;
  } = {}) {
    if (state) writeWorkspaceState(root, state);
    const spawns: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
    const notes: string[] = [];
    const opts: ReplaceCollectorArgs = {
      root,
      udid: UDID,
      bundleId: 'com.example.app',
      appName: 'FixtureDev',
      spawn: (cmd, args, spawnOptions) => {
        spawns.push({ cmd, args, opts: spawnOptions });
        return makeChildProcess({ pid: 7001 });
      },
      kill: (pid, signal) => {
        kills.push({ pid, signal });
        if (killImpl) killImpl(pid, signal);
        return true;
      },
      alive: () => false,
      verify,
      waitMs: 0,
      note: (line) => notes.push(line),
    };
    return { spawns, kills, notes, opts };
  }

  test('a previous collector proven ours is SIGTERMed and replaced, not duplicated', async () => {
    const h = collectorHarness({ state: { collectors: { ios: { pid: 999, startedAt: 'T' } } } });
    const result = await replaceCollector(h.opts);
    expect(h.kills).toEqual([{ pid: 999, signal: 'SIGTERM' }]);
    expect(result.killed).toBe(999);
    expect(h.spawns.length).toBe(1);
    expect(result.pid).toBe(7001);
  });

  test('a previous collector that is already gone (ESRCH) is not an error', async () => {
    const h = collectorHarness({
      state: { collectors: { ios: { pid: 999 } } },
      killImpl: () => {
        throw makeError('kill ESRCH', { code: 'ESRCH' });
      },
    });
    const result = await replaceCollector(h.opts);
    expect(result.killed).toBe(null);
    expect(h.spawns.length).toBe(1);
  });

  test('a previous collector proven gone is left alone, never signalled, and not noted', async () => {
    const h = collectorHarness({
      state: { collectors: { ios: { pid: 999 } } },
      verify: () => ({ status: 'gone' }),
    });
    const result = await replaceCollector(h.opts);
    expect(h.kills).toEqual([]);
    expect(result.killed).toBe(null);
    expect(h.notes).toEqual([]);
    expect(h.spawns.length).toBe(1);
    expect(result.pid).toBe(7001);
  });

  test('a previous collector that cannot be proven ours is left running, noted once, and replaced anyway', async () => {
    const h = collectorHarness({
      state: { collectors: { ios: { pid: 999 } } },
      verify: () => ({ status: 'unverified', reason: "pid 999 does not run this workspace's ios log collector" }),
    });
    const result = await replaceCollector(h.opts);
    expect(h.kills).toEqual([]);
    expect(result.killed).toBe(null);
    expect(h.notes.length).toBe(1);
    expect(h.notes[0]).toMatch(/pid 999/);
    expect(h.notes[0]).toMatch(/not signalled/);
    expect(h.spawns.length).toBe(1);
    expect(result.pid).toBe(7001);
  });

  test('the default ownership check is wired through: a live process titled for this workspace is signalled', async () => {
    const child = await spawnFakeCollector(collectorProcessTitle('ios', root));
    try {
      const h = collectorHarness({ state: { collectors: { ios: { pid: child.pid, startedAt: 'T' } } } });
      h.opts.verify = undefined;
      const result = await replaceCollector(h.opts);
      expect(h.kills).toEqual([{ pid: child.pid, signal: 'SIGTERM' }]);
      expect(result.killed).toBe(child.pid);
    } finally {
      child.kill('SIGKILL');
      await collectorExits(child);
    }
  }, 20_000);

  test('the default ownership check is wired through: a live process that cannot be proven is left running and noted', async () => {
    const child = await spawnFakeCollector(null);
    try {
      const h = collectorHarness({ state: { collectors: { ios: { pid: child.pid, startedAt: 'T' } } } });
      h.opts.verify = undefined;
      h.opts.alive = () => true;
      const result = await replaceCollector(h.opts);
      expect(h.kills).toEqual([]);
      expect(result.killed).toBe(null);
      expect(h.notes.length).toBe(1);
      expect(h.notes[0]).toMatch(/not signalled/);
    } finally {
      child.kill('SIGKILL');
      await collectorExits(child);
    }
  }, 20_000);

  test('the collector is spawned detached, unref-ed, with the REAL app name from the .app path', async () => {
    const h = collectorHarness();
    await replaceCollector(h.opts);
    const firstSpawn = h.spawns[0];
    assert(firstSpawn);
    const { cmd, args, opts } = firstSpawn;
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toBe(collectorEntry());
    expect(existsSync(collectorEntry())).toBeTruthy();
    expect(args.slice(1)).toEqual([
      '--platform',
      'ios',
      '--root',
      root,
      '--udid',
      UDID,
      '--bundle',
      'com.example.app',
      '--app-name',
      'FixtureDev',
    ]);
    expect(opts.detached).toBe(true);
    expect(opts.cwd).toBe(root);
  });

  test('the command hands it the app name derived from the .app basename', async () => {
    reserve();
    const { calls } = await run(
      {},
      {
        buildIos: async () => ({
          appPath: '/tmp/dd/Build/Products/Debug-iphonesimulator/FixtureDev.app',
          bundleId: 'com.example.app',
          durationMs: 1000,
        }),
      },
    );
    expect(calls.args.replaceCollector.appName).toBe('FixtureDev');
    expect(calls.args.replaceCollector.bundleId).toBe('com.example.app');
    expect(calls.args.replaceCollector.udid).toBe(UDID);
  });
});

describe('Contract 4: the state file', () => {
  test('lastBuild is MERGED beside the supervisor and the collectors, never over them', async () => {
    reserve();
    writeWorkspaceState(root, {
      supervisor: { pid: 4242, port: 8082, mode: 'bare-inproc' },
      collectors: { android: { pid: 111 } },
    });
    await run({});
    const state = JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));
    expect(state.supervisor).toEqual({ pid: 4242, port: 8082, mode: 'bare-inproc' });
    expect(state.collectors).toEqual({ android: { pid: 111 } });
    expect(state.lastBuild.status).toBe('ok');
    expect(state.lastBuild.cacheKey).toBe(`${FINGERPRINT}-debug-sim`);
    expect(state.lastBuild.bundleId).toBe('com.example.app');
    expect(!('errorCode' in state.lastBuild)).toBeTruthy();
  });

  test('writeLastBuild survives a workspace it cannot write', () => {
    const record = lastBuildRecord({ startedAt: 'T', status: 'ok' });
    const written = writeLastBuild(root, record, {
      write: () => {
        throw new Error('EROFS');
      },
    });
    expect(written).toBe(record);
  });
});

describe('formatting', () => {
  test('durations read the way a build feels', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(18000)).toBe('18s');
    expect(formatDuration(59400)).toBe('59.4s');
    expect(formatDuration(161000)).toBe('2m41s');
    expect(formatDuration(119600)).toBe('2m00s');
    expect(formatDuration(undefined)).toBe('unknown');
  });

  test('the short forms are recognizably abbreviations', () => {
    expect(shortHash('a3f9b1c2d3')).toBe('a3f9b1..');
    expect(shortHash('abc')).toBe('abc');
    expect(shortUdid(UDID)).toBe('BF2A..');
    expect(deviceLabel({ deviceName: 'stim-x' }, UDID)).toBe('stim-x (BF2A..)');
    expect(deviceLabel(null, UDID)).toBe('BF2A..');
  });

  test('every phase line starts its text at the same column', () => {
    expect(phaseLine('device', 'x')).toBe('  device      x');
    expect(phaseLine('fingerprint', 'x')).toBe('  fingerprint x');
    expect(phaseLine('build', 'x')).toBe('  build       x');
  });

  test('the app name comes from the .app basename, not the bundle id', () => {
    expect(appNameFromPath('/a/b/MyAppDev.app')).toBe('MyAppDev');
    expect(appNameFromPath('/a/b/My App.app')).toBe('My App');
    expect(appNameFromPath(null)).toBe(null);
    expect(appNameFromPath('')).toBe(null);
  });
});

describe('podAction', () => {
  test('stale means install, and carries the reason to print', () => {
    expect(podAction({ hasPodfile: true }, { stale: true, reason: 'they differ' })).toEqual({
      install: true,
      reason: 'they differ',
    });
  });

  test('no pods AND a Podfile is a fresh checkout: install', () => {
    expect(podAction({ hasPodfile: true }, { noPods: true, stale: false }).install).toBe(true);
  });

  test('no pods and no Podfile is a project without CocoaPods: skip', () => {
    expect(podAction({ hasPodfile: false }, { noPods: true, stale: false })).toEqual({ install: false });
  });

  test('in sync is a skip', () => {
    expect(podAction({ hasPodfile: true }, { stale: false })).toEqual({ install: false });
  });
});

describe('devClientScheme', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function project(app: unknown, pkg?: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'stim-scheme-'));
    dirs.push(dir);
    if (app) writeFileSync(join(dir, 'app.json'), JSON.stringify(app));
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg || { name: 'x' }));
    return dir;
  }

  const withDevClient = { name: 'x', dependencies: { 'expo-dev-client': '5.0.0' } };

  test('reads expo.scheme', () => {
    expect(devClientScheme(project({ expo: { scheme: 'myapp' } }, withDevClient))).toBe('myapp');
  });

  test('takes the first of an array of schemes', () => {
    expect(devClientScheme(project({ expo: { scheme: ['myapp', 'other'] } }, withDevClient))).toBe('myapp');
  });

  test('is undefined when there is no app.json at all', () => {
    expect(devClientScheme(project(null, withDevClient))).toBe(undefined);
  });

  test('is undefined without expo-dev-client', () => {
    expect(devClientScheme(project({ expo: { scheme: 'myapp' } }, { name: 'x' }))).toBe(undefined);
  });

  test("prefers the built app's Info.plist over app.json", () => {
    const dir = project({ expo: { scheme: 'from-app-json' } }, withDevClient);
    const exec = makeExecutor({
      runFile: (cmd, args) => {
        expect(cmd).toBe('plutil');
        expect(args?.slice(0, 4)).toEqual(['-convert', 'json', '-o', '-']);
        expect(args?.[4]).toMatch(/Fixture\.app\/Info\.plist$/);
        return JSON.stringify({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['io.tlon.groups'] }] });
      },
    });
    expect(devClientScheme(dir, '/b/Fixture.app', { exec })).toBe('io.tlon.groups');
  });

  test('falls back to app.json when the bundle cannot be read', () => {
    const dir = project({ expo: { scheme: 'from-app-json' } }, withDevClient);
    const exec = makeExecutor({
      runFile: () => {
        throw new Error('plutil: file does not exist');
      },
    });
    expect(devClientScheme(dir, '/b/Fixture.app', { exec })).toBe('from-app-json');
  });

  test('reads CFBundleURLTypes the way @expo/config-plugins does', () => {
    expect(
      schemesFromInfoPlist({
        CFBundleURLTypes: [
          { CFBundleURLSchemes: ['a'] },
          { CFBundleTypeRole: 'Editor' },
          { CFBundleURLSchemes: ['b', 'c'] },
        ],
      }),
    ).toEqual(['a', 'b', 'c']);
    expect(schemesFromInfoPlist({})).toEqual([]);
    expect(schemesFromInfoPlist(null)).toEqual([]);
  });

  describe('pickDevClientScheme', () => {
    test("prefers exp+<slug>, as Expo's own CLI does", () => {
      expect(pickDevClientScheme(['myapp', 'exp+my-app'])).toBe('exp+my-app');
    });

    test('drops third-party callback schemes rather than deep-linking through them', () => {
      const real = [
        'th3rdwave',
        'fb555544564655381',
        'com.googleusercontent.apps.869857856617-96dju1hh2u2361k8o6becusfvq74tv80',
      ];
      expect(pickDevClientScheme(real)).toBe('th3rdwave');
    });

    test("otherwise the longest, which is Expo's uniqueness tie-break", () => {
      expect(pickDevClientScheme(['a', 'io.tlon.groups'])).toBe('io.tlon.groups');
      expect(pickDevClientScheme(['https', 'mailto'])).toBe(null);
      expect(pickDevClientScheme([])).toBe(null);
      expect(pickDevClientScheme(null)).toBe(null);
    });
  });
});

describe('iosFacts', () => {
  test('launched is three-valued: true, or the string "unverified"', () => {
    const base = {
      udid: UDID,
      fingerprint: 'abc',
      cacheKey: 'k',
      cacheHit: false,
      appPath: '/a.app',
      bundleId: 'com.x',
      metroPort: 8082,
      logsDir: '/l',
      durationMs: 1,
    };
    expect(iosFacts(base).launched).toBe(true);
    expect(iosFacts({ ...base, launched: 'unverified' }).launched).toBe('unverified');
  });

  test('is the shape an agent parses', () => {
    expect(
      iosFacts({
        udid: UDID,
        deviceName: 'stim-x',
        fingerprint: 'abc',
        cacheKey: 'abc-debug-sim',
        cacheHit: 'local',
        appPath: '/a/b.app',
        bundleId: 'com.x',
        metroPort: 8082,
        logsDir: '/w/.stim/logs',
        durationMs: 1234,
      }),
    ).toEqual({
      platform: 'ios',
      udid: UDID,
      deviceName: 'stim-x',
      fingerprint: 'abc',
      configuration: null,
      cacheKey: 'abc-debug-sim',
      cacheHit: 'local',
      cacheSkipped: false,
      compilationCache: { status: 'not-run', hits: null, cacheableTasks: null, hitRatePercent: null },
      waitedForBuild: null,
      appPath: '/a/b.app',
      bundleId: 'com.x',
      installSkipped: false,
      launched: true,
      metroPort: 8082,
      logs: { dir: '/w/.stim/logs' },
      durationMs: 1234,
    });
  });

  test('waitedForBuild names the builder waited on and what the wait cost', () => {
    const facts = iosFacts({ udid: UDID, cacheHit: 'local', waitedForBuild: { pid: 41233, ms: 761000 } });
    expect(facts.cacheHit).toBe('local');
    expect(facts.waitedForBuild).toEqual({ pid: 41233, ms: 761000 });
  });

  test('cacheHit is a LEVEL, and an unknown value is a miss rather than a truthy string', () => {
    expect(iosFacts({ udid: UDID, cacheHit: 'remote' }).cacheHit).toBe('remote');
    expect(iosFacts({ udid: UDID, cacheHit: true }).cacheHit).toBe(false);
    expect(iosFacts({ udid: UDID, cacheHit: false }).cacheHit).toBe(false);
  });

  test('cacheSkipped separates "found nothing" from "was told not to look"', () => {
    expect(iosFacts({ udid: UDID, cacheHit: false }).cacheSkipped).toBe(false);
    expect(iosFacts({ udid: UDID, cacheHit: false, cacheSkipped: true }).cacheSkipped).toBe(true);
  });
});

describe('cacheDescription', () => {
  test('names the level the app came from, and the provider when it was the remote one', () => {
    expect(cacheDescription(false)).toBe('built');
    expect(cacheDescription('local')).toBe('from cache');
    expect(cacheDescription('remote', 'eas')).toBe('from eas');
    expect(cacheDescription('remote', null)).toBe('from the remote cache');
  });
});

test('ios fingerprints with platforms scoped to ios', async () => {
  reserve();
  const seen: { path: unknown; options?: { platform?: unknown } }[] = [];
  await run(
    {},
    {
      fingerprintProject: async (path, options) => {
        seen.push({ path, options });
        return { hash: FINGERPRINT, sources: [] };
      },
    },
  );
  expect(seen.length).toBe(1);
  const seenEntry = seen[0];
  assert(seenEntry);
  expect(seenEntry.path).toBe(root);
  expect(seenEntry.options?.platform).toBe('ios');
});

test('--json says so when a build failed with no recognizable diagnostic', async () => {
  reserve();
  const { logs, exitCode } = await run(
    { json: true },
    {
      buildIos: async () => ({
        failed: true,
        code: 'STIM_BUILD_FAILED',
        durationMs: 1000,
        truncated: 0,
        exitCode: 70,
        diagnostics: [],
        tail: ['xcodebuild: error: something inscrutable'],
      }),
    },
  );
  expect(exitCode).toBe(1);
  const payload = parseFirst(logs);
  expect(payload.message).toMatch(/no recognizable diagnostic/);
  expect(payload.remedy).toMatch(/build-ios\.ndjson/);
});

describe('concurrency limits', () => {
  test('unset limits change nothing: no slot is taken, no capacity check refuses', async () => {
    reserve();
    let slotAcquired = 0;
    const { exitCode, calls } = await run(
      {},
      {
        getConcurrencyLimits: () => ({ maxBuilds: 0, maxDevices: 0 }),
        acquireBuildSlot: async () => {
          slotAcquired++;
          return { acquired: true };
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(slotAcquired).toBe(0);
    expect(calls.order.includes('buildIos')).toBeTruthy();
  });

  test('maxDevices at capacity refuses with STIM_AT_CAPACITY, before ensuring a device', async () => {
    reserve();
    const capacity: { args?: CheckDeviceCapacityArgs } = {};
    const { errs, exitCode, calls } = await run(
      {},
      {
        getConcurrencyLimits: () => ({ maxBuilds: 0, maxDevices: 2 }),
        checkDeviceCapacity: (args) => {
          capacity.args = args;
          return {
            code: 'STIM_AT_CAPACITY',
            message: 'at capacity',
            remedy: 'stop an environment (stim stop) or raise concurrency.maxDevices',
          };
        },
      },
    );
    expect(exitCode).toBe(1);
    assert(capacity.args);
    expect(capacity.args.max).toBe(2);
    expect(errs.join('\n')).toMatch(/STIM_AT_CAPACITY/);
    expect(errs.join('\n')).toMatch(/stim stop/);
    expect(!calls.order.includes('ensureOwnedDevice')).toBeTruthy();
  });

  test('maxBuilds takes a slot AFTER the single-flight lock and releases it after the build', async () => {
    reserve();
    const seq: string[] = [];
    const slot: { args?: AcquireBuildSlotArgs } = {};
    const { exitCode } = await run(
      {},
      {
        getConcurrencyLimits: () => ({ maxBuilds: 2, maxDevices: 0 }),
        acquireBuildLock: () => {
          seq.push('lock');
          return { acquired: true, path: '/lock', lock: { pid: process.pid } };
        },
        releaseBuildLock: () => {
          seq.push('releaseLock');
          return true;
        },
        acquireBuildSlot: async (args) => {
          seq.push('slot');
          slot.args = args;
          return { acquired: true, path: '/slot', index: 0, slot: { pid: process.pid } };
        },
        releaseBuildSlot: () => {
          seq.push('releaseSlot');
          return true;
        },
        buildIos: async () => {
          seq.push('build');
          return {
            appPath: join(root, 'build', 'Fixture.app'),
            bundleId: 'com.example.app',
            durationMs: 1000,
            scheme: 'Fixture',
          };
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(seq).toEqual(['lock', 'slot', 'build', 'releaseLock', 'releaseSlot']);
    assert(slot.args);
    expect(slot.args.max).toBe(2);
    expect(slot.args.root).toBe(root);
  });

  test("a waiter that installs another workspace's artifact never consumes a slot", async () => {
    reserve();
    let slotAcquired = 0;
    let built = 0;
    const { exitCode } = await run(
      {},
      {
        getConcurrencyLimits: () => ({ maxBuilds: 2, maxDevices: 0 }),
        acquireBuildLock: () => ({ held: { pid: 41233, projectRoot: '/w/other', logFile: null } }),
        waitForBuild: async () => ({ hit: join(root, 'build', 'Fixture.app'), waitedMs: 5000 }),
        acquireBuildSlot: async () => {
          slotAcquired++;
          return { acquired: true };
        },
        buildIos: async () => {
          built++;
          return {
            appPath: join(root, 'build', 'Fixture.app'),
            bundleId: 'com.example.app',
            durationMs: 1,
            scheme: 'F',
          };
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(slotAcquired).toBe(0);
    expect(built).toBe(0);
  });
});

describe('--remote', () => {
  test('the CLI parser accepts only an explicit proxy or eas backend', () => {
    expect(parseRemoteOption(['--remote', 'proxy'])).toBe('proxy');
    expect(parseRemoteOption(['--remote', 'eas'])).toBe('eas');
    expect(() => parseRemoteOption(['--remote'])).toThrow(/argument missing/i);
    expect(() => parseRemoteOption(['--remote', 'cloud'])).toThrow(/proxy.*eas/i);
  });

  function remoteStub(createdSessionId: string | null = 'drs_42') {
    const hits: string[] = [];
    const backends: unknown[] = [];
    return {
      hits,
      backends,
      deps: {
        resolveRemoteContext: (args: { backend?: unknown }) => {
          backends.push(args.backend);
          return {
            ctx: {
              root,
              label: 'fixture',
              backend: args.backend,
              easBin: '/bin/eas',
              agentDeviceBin: '/bin/agent-device',
            },
          };
        },
        ensureMetroReachable: async () => ({ ok: true as const }),
        detectProviders: () => [],
        remoteIosDeps: () => ({
          ctx: { root, label: 'fixture', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
          checkDeviceCapacity: () => {
            hits.push('checkDeviceCapacity');
            return null;
          },
          ensureOwnedDevice: async () => {
            hits.push('ensureOwnedDevice');
            return { deviceName: 'EAS Simulator', owned: true, remote: true };
          },
          ensureBooted: async () => {
            hits.push('ensureBooted');
            return { ok: true, udid: 'drs_42' };
          },
          installIosApp: () => {
            hits.push('installIosApp');
            return { ok: true };
          },
          launchIosApp: () => {
            hits.push('launchIosApp');
            return { ok: true, mode: 'launch' };
          },
          createdSessionId: () => createdSessionId,
          webPreviewUrl: () => null,
        }),
      },
    };
  }

  test('the device phases run against the remote implementation', async () => {
    const remote = remoteStub();
    reserve();
    const { calls, exitCode } = await run({ remote: 'eas' }, remote.deps);
    expect(exitCode).toBeFalsy();
    expect(remote.hits).toEqual([
      'checkDeviceCapacity',
      'ensureOwnedDevice',
      'ensureBooted',
      'installIosApp',
      'launchIosApp',
    ]);
    expect(remote.backends).toEqual(['eas']);
    expect(calls.order.includes('ensureOwnedDevice')).toBeFalsy();
    expect(calls.order.includes('installIosApp')).toBeFalsy();
  });

  test('the build still happens locally -- only the device moved', async () => {
    const remote = remoteStub();
    reserve();
    const { calls } = await run({ remote: 'eas' }, remote.deps);
    expect(calls.order.includes('fingerprintProject')).toBeTruthy();
    expect(calls.order.includes('resolveBuild')).toBeTruthy();
    expect(calls.order.includes('buildIos')).toBeTruthy();
  });

  test('a reused EAS session keeps its original ownership timestamp', async () => {
    writeWorkspaceState(root, {
      remoteDevice: { platform: 'ios', sessionId: 'drs_old', startedAt: '2026-08-27T12:00:00.000Z' },
    });
    const remote = remoteStub(null);
    reserve();

    const { exitCode } = await run({ remote: 'eas' }, remote.deps);
    expect(exitCode).toBeNull();
    expect(readWorkspaceState(root)?.remoteDevice).toEqual({
      platform: 'ios',
      sessionId: 'drs_old',
      startedAt: '2026-08-27T12:00:00.000Z',
    });
  });

  test('the Metro gate still runs BEFORE the session is created', async () => {
    const remote = remoteStub();
    reserve();
    const { exitCode } = await run(
      { remote: 'eas' },
      { ...remote.deps, resolveProjectMetro: async () => ({ metro: null }) },
    );
    expect(exitCode).toBe(1);
    expect(remote.hits.includes('ensureOwnedDevice')).toBeFalsy();
    expect(remote.hits.includes('ensureBooted')).toBeFalsy();
  });

  test('an unusable remote setup refuses before any build work', async () => {
    const { exitCode, calls, stderr } = await run(
      { remote: 'eas' },
      {
        resolveRemoteContext: () => ({ failed: 'agent-device is not on PATH.', remedy: 'Install it.' }),
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('agent-device is not on PATH.');
    expect(calls.order.includes('fingerprintProject')).toBeFalsy();
  });

  test('without the flag nothing remote is consulted', async () => {
    let asked = false;
    reserve();
    const { calls, exitCode } = await run(
      {},
      {
        resolveRemoteContext: () => {
          asked = true;
          return { failed: 'should not be called', remedy: '' };
        },
      },
    );
    expect(exitCode).toBeFalsy();
    expect(asked).toBe(false);
    expect(calls.order.includes('ensureOwnedDevice')).toBeTruthy();
  });

  test('the ios.remote setting does the same thing as the flag', async () => {
    const remote = remoteStub();
    reserve();
    const { exitCode } = await run({}, { ...remote.deps, resolveSettings: () => ({ ios: { remote: 'proxy' } }) });
    expect(exitCode).toBeFalsy();
    expect(remote.hits.includes('ensureBooted')).toBeTruthy();
    expect(remote.backends).toEqual(['proxy']);
  });

  test('a wrong-typed known setting is refused before any device work, with nothing on stdout', async () => {
    let asked = false;
    const { exitCode, stderr, logs } = await run(
      {},
      {
        resolveSettings: () => ({ ios: { configuration: {} } }),
        resolveRemoteContext: () => {
          asked = true;
          return { failed: 'x', remedy: '' };
        },
      },
    );
    expect(asked).toBe(false);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('STIM_BAD_ARG');
    expect(stderr).toContain('Invalid ios.configuration setting {}. Expected a string.');
    expect(stderr).not.toContain('not read by Stim');
    expect(logs).toEqual([]);
  });

  test('an invalid ios.remote value is a structured refusal', async () => {
    let asked = false;
    const { exitCode, stderr } = await run(
      {},
      {
        resolveSettings: () => ({ ios: { remote: 'yes' } }),
        resolveRemoteContext: () => {
          asked = true;
          return { failed: 'x', remedy: '' };
        },
      },
    );
    expect(asked).toBe(false);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('STIM_BAD_ARG');
    expect(stderr).toContain('Invalid ios.remote setting');
  });

  test('the reach step gets the RESERVED port, and runs after the Metro gate', async () => {
    const remote = remoteStub();
    reserve(8092);
    let seenPort: unknown = null;
    const order: string[] = [];
    await run(
      { remote: 'eas' },
      {
        ...remote.deps,
        resolveMetroWithRetry: async () => {
          order.push('metroGate');
          return { metro: { pid: 1, leader: 1 } };
        },
        ensureMetroReachable: async (args: { metroPort: unknown }) => {
          order.push('reach');
          seenPort = args.metroPort;
          return { ok: true as const };
        },
      },
    );
    expect(seenPort).toBe(8092);
    expect(order).toEqual(['metroGate', 'reach']);
  });

  test('a remote build targets the simulator platform, not a udid', async () => {
    const remote = remoteStub();
    reserve();
    let seen = null as Record<string, unknown> | null;
    await run(
      { remote: 'eas' },
      {
        ...remote.deps,
        buildIos: async (args: Record<string, unknown>) => {
          seen = args;
          return { ok: true, appPath: join(root, 'build', 'Fixture.app'), bundleId: 'com.example.app', durationMs: 1 };
        },
      },
    );
    expect(seen?.destination).toBe('generic/platform=iOS Simulator');
  });

  test('a local build still targets its own device', async () => {
    reserve();
    let seen = null as Record<string, unknown> | null;
    await run(
      {},
      {
        buildIos: async (args: Record<string, unknown>) => {
          seen = args;
          return { ok: true, appPath: join(root, 'build', 'Fixture.app'), bundleId: 'com.example.app', durationMs: 1 };
        },
      },
    );
    expect(seen?.destination).toBeFalsy();
    expect(seen?.udid).toBe(UDID);
  });
});

test('a miss with a prior stored entry appends the changed-sources suffix and logs fingerprint_diff', async () => {
  reserve();
  writeWorkspaceState(root, {
    lastBuild: { platform: 'ios', fingerprint: 'oldhash', cacheKey: 'old-key' },
  });
  const entry = join(tmpHome, 'build-cache', 'ios', 'old-key');
  mkdirSync(entry, { recursive: true });
  writeFileSync(
    join(entry, 'fingerprint-sources.json'),
    JSON.stringify([
      { type: 'file', filePath: 'ios/Podfile.lock', hash: 'aa' },
      { type: 'contents', id: 'expoConfig', hash: 'bb' },
    ]),
  );

  const { errs } = await run(
    {},
    {
      fingerprintProject: async () => ({
        hash: FINGERPRINT,
        sources: [
          { type: 'file', filePath: 'ios/Podfile.lock', hash: 'a2' },
          { type: 'contents', id: 'expoConfig', hash: 'bb' },
        ],
      }),
    },
  );

  const line = errs.find((e) => e.startsWith('  fingerprint'));
  assert(line);
  expect(line).toMatch(/miss/);
  expect(line).toMatch(/ -- 1 source changed: ios\/Podfile\.lock$/);

  const record = buildRecords().find((r) => r.event === 'fingerprint_diff');
  assert(record, 'expected a fingerprint_diff record in the build log');
  expect(record.level).toBe('info');
  expect(record.src).toBe('build');
  expect(record.changed).toBe(1);
  expect(record.sources).toEqual(['ios/Podfile.lock']);
  expect(record.msg).toMatch(/oldhash -> a3f9b1c2d3e4f5/);
});

test('a miss with no prior entry (or a first build) prints the plain miss line, no suffix', async () => {
  reserve();
  const { errs } = await run();
  const line = errs.find((e) => e.startsWith('  fingerprint'));
  assert(line);
  expect(line).toMatch(/miss \(\d+ms\)$/);
  expect(buildRecords().some((r) => r.event === 'fingerprint_diff')).toBe(false);
});

describe('configuration resolution', () => {
  test('flag > setting > default', () => {
    expect(resolveConfiguration('Release', { ios: { configuration: 'Staging' } })).toBe('Release');
    expect(resolveConfiguration(null, { ios: { configuration: 'Release' } })).toBe('Release');
    expect(resolveConfiguration('  ', { ios: { configuration: 'Release' } })).toBe('Release');
    expect(resolveConfiguration(null, {})).toBe(null);
    expect(resolveConfiguration(null, null)).toBe(null);
  });

  test('iosConfigurationSetting reads ios.configuration and nothing shaped differently', () => {
    expect(iosConfigurationSetting({ ios: { configuration: ' Release ' } })).toBe('Release');
    expect(iosConfigurationSetting({ ios: { configuration: '' } })).toBe(null);
    expect(iosConfigurationSetting({ ios: [] })).toBe(null);
    expect(iosConfigurationSetting({})).toBe(null);
    expect(iosConfigurationSetting(null)).toBe(null);
  });

  test('only Debug (case-insensitive) is the dev flow; everything else embeds its JS', () => {
    expect(isReleaseConfiguration('Release')).toBe(true);
    expect(isReleaseConfiguration('Staging')).toBe(true);
    expect(isReleaseConfiguration('Debug')).toBe(false);
    expect(isReleaseConfiguration('debug')).toBe(false);
    expect(isReleaseConfiguration(null)).toBe(false);
    expect(isReleaseConfiguration('')).toBe(false);
  });
});

describe('release skips Metro entirely', () => {
  test('no gate, no reservation needed, no port wiring, plain launch', async () => {
    const { exitCode, calls, errs } = await run({ configuration: 'Release' });
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('resolveProjectMetro')).toBeTruthy();
    expect(errs.join('\n')).not.toMatch(/STIM_NO_METRO/);
    expect(errs.join('\n')).toMatch(/skipped \(Release: the JS bundle is embedded/);
    expect(calls.args.launchIosApp.metroPort).toBe(null);
    expect(calls.args.launchIosApp.devClientScheme).toBeUndefined();
    expect(!calls.order.includes('verifyLaunch')).toBeTruthy();
    expect(calls.order.includes('verifyReleaseLaunch')).toBeTruthy();
    expect(calls.order.includes('replaceCollector')).toBeTruthy();
  });

  test('the payload says metroPort null, configuration Release, launched true', async () => {
    const { logs } = await run({ configuration: 'Release', json: true });
    const facts = parseFirst(logs);
    expect(facts.platform).toBe('ios');
    expect(facts.configuration).toBe('Release');
    expect(facts.metroPort).toBe(null);
    expect(facts.launched).toBe(true);
    expect(facts.cacheKey).toBe(`${FINGERPRINT}-release-sim`);
  });

  test('a dead app process fails the readiness check with the device-log pointer', async () => {
    const { logs, errs, exitCode } = await run(
      { configuration: 'Release', json: true },
      {
        verifyReleaseLaunch: async () => ({ verified: false, reason: 'exited', waitedMs: 3000 }),
      },
    );
    expect(exitCode).toBe(1);
    expect(parseFirst(logs).code).toBe('STIM_LAUNCH_FAILED');
    expect(errs.join('\n')).toMatch(/process exited within/);
    expect(errs.join('\n')).toMatch(/stim logs --errors/);
  });

  test('the ios.configuration setting is the repo default, and the flag overrides it back to Debug', async () => {
    const settings = { ios: { configuration: 'Release' } };
    const first = await run({}, { resolveSettings: () => settings });
    expect(!first.calls.order.includes('resolveProjectMetro')).toBeTruthy();
    expect(first.calls.args.launchIosApp.metroPort).toBe(null);
    const second = await run({ configuration: 'Debug' }, { resolveSettings: () => settings });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(/STIM_NO_METRO/);
  });
});

describe('the release cache key and the JS swap', () => {
  test('the key differs from debug: -release-sim vs -debug-sim', async () => {
    reserve();
    const debugRun = await run({});
    expect(debugRun.calls.args.resolveBuild.key).toBe(`${FINGERPRINT}-debug-sim`);
    const releaseRun = await run({ configuration: 'Release' });
    expect(releaseRun.calls.args.resolveBuild.key).toBe(`${FINGERPRINT}-release-sim`);
    expect(releaseRun.calls.args.storeBuild.platform).toBe('ios');
    expect((releaseRun.calls.args.storeBuild as { key?: unknown }).key).toBe(`${FINGERPRINT}-release-sim`);
  });

  test('a fresh release build passes the configuration to xcodebuild and needs no swap', async () => {
    const { calls } = await run({ configuration: 'Release' });
    expect(calls.args.buildIos.configuration).toBe('Release');
    expect(!calls.order.includes('swapJsBundle')).toBeTruthy();
  });

  test('a release cache hit swaps: cached app in, temp copy out, THAT copy installed', async () => {
    const cached = '/cache/ios/entry/Fixture.app';
    const { exitCode, calls, errs } = await run({ configuration: 'Release' }, { resolveBuild: () => cached });
    expect(exitCode).toBe(null);
    const order = calls.order;
    expect(order.indexOf('swapJsBundle')).toBeGreaterThan(order.indexOf('resolveBuild'));
    expect(order.indexOf('installIosApp')).toBeGreaterThan(order.indexOf('swapJsBundle'));
    expect(!order.includes('buildIos')).toBeTruthy();
    expect(!order.includes('runPodInstall')).toBeTruthy();
    expect(calls.args.swapJsBundle.cachedAppPath).toBe(cached);
    expect(calls.args.installIosApp.appPath).toBe(join(root, 'js-swap', 'Fixture.app'));
    expect(calls.args.readBundleId).toBe(join(root, 'js-swap', 'Fixture.app'));
    expect(errs.join('\n')).toMatch(/js swap/);
  });

  test('a debug cache hit never swaps', async () => {
    reserve();
    const cached = '/cache/ios/entry/Fixture.app';
    const { calls } = await run({}, { resolveBuild: () => cached });
    expect(!calls.order.includes('swapJsBundle')).toBeTruthy();
    expect(calls.args.installIosApp.appPath).toBe(cached);
  });

  test('a swap failure falls back to a FULL build with a note -- stale JS is never installed', async () => {
    const cached = '/cache/ios/entry/Fixture.app';
    const { exitCode, calls, errs, logs, appPath } = await run(
      { configuration: 'Release', json: true },
      {
        resolveBuild: () => cached,
        swapJsBundle: async () => ({ failed: true, step: 'bundle', reason: 'expo export:embed failed (exit code 1)' }),
      },
    );
    expect(exitCode).toBe(null);
    expect(errs.join('\n')).toMatch(/js swap/);
    expect(errs.join('\n')).toMatch(/building fresh instead/);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(calls.args.installIosApp.appPath).toBe(appPath);
    expect(parseFirst(logs).cacheHit).toBe(false);
  });
});

describe('the remote browser preview', () => {
  function previewStub(url: string | null) {
    return {
      resolveRemoteContext: () => ({
        ctx: { root, label: 'fixture', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
      }),
      ensureMetroReachable: async () => ({ ok: true as const }),
      detectProviders: () => [],
      remoteIosDeps: () => ({
        ctx: { root, label: 'fixture', backend: 'eas', easBin: '/bin/eas', agentDeviceBin: '/bin/agent-device' },
        checkDeviceCapacity: () => null,
        ensureOwnedDevice: async () => ({ deviceName: 'EAS Simulator', owned: true, remote: true }),
        ensureBooted: async () => ({ ok: true, udid: 'drs_42' }),
        installIosApp: () => ({ ok: true }),
        launchIosApp: () => ({ ok: true, mode: 'launch' }),
        createdSessionId: () => 'drs_42',
        webPreviewUrl: () => url,
      }),
    };
  }

  test('the --json payload carries the preview url', async () => {
    reserve();
    const { logs } = await run({ remote: 'eas', json: true }, previewStub('https://preview.example/abc'));
    expect(parseFirst(logs).webPreviewUrl).toBe('https://preview.example/abc');
  });

  test('the human summary prints it too', async () => {
    reserve();
    const { stderr } = await run({ remote: 'eas' }, previewStub('https://preview.example/abc'));
    expect(stderr).toContain('Watch this device: https://preview.example/abc');
  });

  test('a device with no preview omits the key rather than carrying null', async () => {
    reserve();
    const { logs } = await run({ remote: 'eas', json: true }, previewStub(null));
    expect('webPreviewUrl' in parseFirst(logs)).toBe(false);
  });

  test('a local run has no preview url at all', async () => {
    reserve();
    const { logs } = await run({ json: true });
    expect('webPreviewUrl' in parseFirst(logs)).toBe(false);
  });
});
describe('re-fingerprint after the steps that rewrite fingerprinted files', () => {
  const COLD = 'aaaaaa1111';
  const WARM = 'bbbbbb2222';

  function shifting() {
    let call = 0;
    return async () => ({ hash: call++ === 0 ? COLD : WARM, sources: [{ type: 'dir', filePath: 'ios' }] });
  }

  test('the store key is the key the NEXT run looks up across a prebuild boundary', async () => {
    reserve();
    const lookedUp: string[] = [];
    const cold = await run(
      {},
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
        fingerprintProject: shifting(),
        resolveBuild: (_platform, key) => {
          lookedUp.push(key);
          return null;
        },
      },
    );
    expect(cold.exitCode).toBe(null);
    const storedKey = cold.calls.args.storeBuild.key;
    expect(lookedUp[0]).toMatch(new RegExp(`^${COLD}`));
    expect(String(storedKey)).toMatch(new RegExp(`^${WARM}`));

    const warm = await run({}, { fingerprintProject: async () => ({ hash: WARM, sources: [] }) });
    expect(warm.calls.args.resolveBuild.key).toBe(storedKey);
  });

  test('the shift is one dim line naming both short hashes, and the payload reports what was stored', async () => {
    reserve();
    const { logs, errs, calls } = await run(
      { json: true },
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
        fingerprintProject: shifting(),
      },
    );
    const shift = errs.find((line) => /^  fingerprint\s+\S+ -> /.test(line));
    assert(shift, 'expected a fingerprint shift line on stderr');
    expect(shift).toMatch(/aaaaaa\.\. -> bbbbbb\.\./);
    expect(shift).toMatch(/prebuild \+ pod install/);

    const facts = parseFirst(logs);
    expect(facts.fingerprint).toBe(WARM);
    expect(facts.cacheKey).toBe(calls.args.storeBuild.key);

    const state = readWorkspaceState(root) as WorkspaceState;
    expect((state.lastBuild as Record<string, unknown>).fingerprint).toBe(WARM);
    expect((state.lastBuild as Record<string, unknown>).cacheKey).toBe(calls.args.storeBuild.key);
  });

  test('a post-shift hit installs the cached app and compiles nothing', async () => {
    reserve();
    const cachedApp = join(tmpHome, 'build-cache', 'ios', `${WARM}-debug-sim`, 'Fixture.app');
    const { logs, errs, calls } = await run(
      { json: true },
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        fingerprintProject: shifting(),
        resolveBuild: (_platform, key) => (key.startsWith(WARM) ? cachedApp : null),
      },
    );
    expect(calls.order.includes('runPrebuild')).toBe(true);
    expect(calls.order.includes('buildIos')).toBe(false);
    expect(calls.order.includes('storeBuild')).toBe(false);
    expect(calls.args.installIosApp.appPath).toBe(cachedApp);
    expect(errs.join('\n')).toMatch(/hit under the post-prebuild key \(this tree was cold/);

    const facts = parseFirst(logs);
    expect(facts.cacheHit).toBe('local');
    expect(facts.fingerprint).toBe(WARM);
    expect(facts.cacheKey).toBe(`${WARM}-debug-sim`);
  });

  test('a post-shift hit on a Release build swaps the JS in, exactly as a first-pass hit does', async () => {
    reserve();
    const cachedApp = join(tmpHome, 'build-cache', 'ios', `${WARM}-release-sim`, 'Fixture.app');
    const { calls } = await run(
      { configuration: 'Release' },
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        fingerprintProject: shifting(),
        resolveBuild: (_platform, key) => (key.startsWith(WARM) ? cachedApp : null),
      },
    );
    expect(calls.args.swapJsBundle.cachedAppPath).toBe(cachedApp);
    expect(calls.order.includes('buildIos')).toBe(false);
    expect(calls.args.installIosApp.appPath).toBe(join(root, 'js-swap', 'Fixture.app'));
  });

  test('a post-shift hit whose swap fails falls back to a build, as a first-pass failure does', async () => {
    reserve();
    const cachedApp = join(tmpHome, 'build-cache', 'ios', `${WARM}-release-sim`, 'Fixture.app');
    const { calls } = await run(
      { configuration: 'Release' },
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        fingerprintProject: shifting(),
        resolveBuild: (_platform, key) => (key.startsWith(WARM) ? cachedApp : null),
        swapJsBundle: async () => ({ ok: false, step: 'bundle', reason: 'hermesc not found' }),
      },
    );
    expect(calls.order.includes('buildIos')).toBe(true);
    expect(String(calls.args.storeBuild.key)).toBe(`${WARM}-release-sim`);
  });

  test('a post-shift MISS builds and stores under the new key', async () => {
    reserve();
    const lookedUp: string[] = [];
    const { calls } = await run(
      {},
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        fingerprintProject: shifting(),
        resolveBuild: (_platform, key) => {
          lookedUp.push(key);
          return null;
        },
      },
    );
    expect(lookedUp.length).toBe(2);
    expect(lookedUp[1]).toBe(`${WARM}-debug-sim`);
    expect(calls.order.includes('buildIos')).toBe(true);
    expect(calls.args.storeBuild.key).toBe(`${WARM}-debug-sim`);
  });

  test('a hash that does not move costs no line and stores under the key it looked up', async () => {
    reserve();
    const { errs, calls } = await run(
      {},
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
      },
    );
    expect(errs.some((line) => /^  fingerprint\s+\S+ -> /.test(line))).toBe(false);
    expect(calls.args.storeBuild.key).toBe(calls.args.resolveBuild.key);
    expect(calls.order.filter((c) => c === 'resolveBuild').length).toBe(1);
  });

  test('a warm tree runs no mutating step, so the fingerprint is computed exactly once', async () => {
    reserve();
    const { calls } = await run();
    expect(calls.order.filter((c) => c === 'fingerprintProject').length).toBe(1);
  });
});

test('a first miss lists untracked files under the native dirs and points at .fingerprintignore', async () => {
  reserve();
  const asked: unknown[] = [];
  const { errs } = await run(
    {},
    {
      untrackedNativeFiles: (args) => {
        asked.push(args);
        return ['ios/scratch.txt', 'android/local.properties'];
      },
    },
  );
  expect(asked).toEqual([{ projectRoot: root }]);
  const line = errs.find((e) => e.includes('untracked'));
  assert(line, 'expected the untracked-files note on stderr');
  expect(line).toMatch(/ios\/scratch\.txt, android\/local\.properties/);
  expect(line).toMatch(/\.fingerprintignore/);
});

test('a miss that CAN be diffed says what changed instead of guessing at untracked files', async () => {
  reserve();
  writeWorkspaceState(root, { lastBuild: { platform: 'ios', fingerprint: 'oldhash', cacheKey: 'old-key' } });
  const entry = join(tmpHome, 'build-cache', 'ios', 'old-key');
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, 'fingerprint-sources.json'), JSON.stringify([{ type: 'contents', id: 'expoConfig' }]));
  const asked: unknown[] = [];
  const { errs } = await run(
    {},
    {
      untrackedNativeFiles: (args) => {
        asked.push(args);
        return ['ios/scratch.txt'];
      },
      fingerprintProject: async () => ({ hash: FINGERPRINT, sources: [{ type: 'contents', id: 'other' }] }),
    },
  );
  expect(asked.length).toBe(0);
  expect(errs.some((e) => e.includes('untracked'))).toBe(false);
});

describe('launch verification: bundling vs unverified', () => {
  test('a request that arrived reports launched: "bundling" and prints no remedy list', async () => {
    reserve();
    const { logs, errs, exitCode } = await run(
      { json: true },
      { verifyLaunch: async () => ({ verified: false, timedOut: true, requested: true, waitedMs: 20000 }) },
    );
    expect(exitCode).toBe(null);
    expect(parseFirst(logs).launched).toBe('bundling');
    const text = errs.join('\n');
    expect(text).toMatch(/BUNDLING: the app asked port 8082 for its bundle/);
    expect(text).not.toMatch(/DEVELOPMENT SERVERS picker/);
    expect(text).not.toMatch(/Open in <app>\?/);

    const record = buildRecords().find((r) => r.event === 'launch_bundling');
    assert(record, 'expected a launch_bundling record in the build log');
    expect(record.level).toBe('info');
    expect(record.msg).toMatch(/still being built/);
  });

  test('no request at all is still "unverified", with the remedy list', async () => {
    reserve();
    const { logs, errs } = await run(
      { json: true },
      { verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) },
    );
    expect(parseFirst(logs).launched).toBe('unverified');
    expect(errs.join('\n')).toMatch(/DEVELOPMENT SERVERS picker/);
    expect(buildRecords().some((r) => r.event === 'launch_unverified')).toBe(true);
  });

  test("verifyLaunch is told this workspace's port, which is what the device log is matched on", async () => {
    reserve(8099);
    const { calls } = await run();
    expect((calls.args.verifyLaunch as { metroPort?: unknown }).metroPort).toBe(8099);
  });
});

describe('single-flight takeover says the previous build failed', () => {
  test('taking the lock over from a dead holder names it and says the inputs are the same', async () => {
    reserve();
    const { errs } = await run(
      {},
      {
        acquireBuildLock: () => ({
          acquired: true,
          path: join(tmpHome, 'build-locks', 'ios-k.lock'),
          lock: { pid: process.pid },
          tookOver: {
            pid: 4242,
            projectRoot: '/w/other',
            startedAt: new Date(Date.now() - 120000).toISOString(),
            logFile: '/w/other/.stim/logs/build-ios.ndjson',
          },
        }),
      },
    );
    const line = errs.find((e) => e.includes('RETRY:'));
    assert(line, 'expected the takeover retry line on stderr');
    expect(line).toMatch(/\/w\/other/);
    expect(line).toMatch(/pid 4242/);
    expect(line).toMatch(/SAME inputs/);
    expect(line).toMatch(/build-ios\.ndjson/);
  });

  test('a builder that died mid-wait produces the same line before this run rebuilds', async () => {
    reserve();
    let attempt = 0;
    const { errs, calls } = await run(
      {},
      {
        acquireBuildLock: () =>
          attempt++ === 0
            ? { held: { pid: 999, projectRoot: '/w/other', startedAt: null, logFile: '/w/other/build.ndjson' } }
            : { acquired: true, path: join(tmpHome, 'build-locks', 'ios-k.lock'), lock: { pid: process.pid } },
        waitForBuild: async () => ({ builderFailed: 'the builder (pid 999) is gone', waitedMs: 1200 }),
      },
    );
    expect(calls.order.includes('buildIos')).toBe(true);
    const line = errs.find((e) => e.includes('RETRY:'));
    assert(line, 'expected the takeover retry line on stderr');
    expect(line).toMatch(/pid 999/);
    expect(line).toMatch(/build\.ndjson/);
  });
});

describe('the project cache provider', () => {
  function providerConfig() {
    return { provider: './cache.cjs', options: { bucket: 'mobile' }, baseDir: root };
  }

  function downloaded(name = 'Fixture.app') {
    const dir = join(root, 'provider-download');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, 'binary');
    return path;
  }

  function providerDeps(
    builds: Record<string, unknown>,
    record: (name: string, value: unknown) => void = () => {},
  ): LooseDeps {
    return {
      resolveCacheProviderConfig: () => providerConfig(),
      loadCacheProvider: async (input) => {
        record('loadCacheProvider', input);
        return { name: './cache.cjs', provider: { builds } };
      },
    } as LooseDeps;
  }

  test('no configured provider never loads one and keeps the existing order', async () => {
    reserve();
    let loads = 0;
    const { exitCode, calls, errs } = await run(
      {},
      {
        loadCacheProvider: async () => {
          loads += 1;
          return { none: true };
        },
      },
    );

    expect(exitCode).toBe(null);
    expect(loads).toBe(0);
    expect(calls.order.filter((c) => ['resolveBuild', 'storeBuild'].includes(c))).toEqual([
      'resolveBuild',
      'storeBuild',
    ]);
    expect(errs.join('\n')).not.toMatch(/provider/);
  });

  test('a local hit does not load either second tier', async () => {
    reserve();
    let loads = 0;
    const { calls } = await run(
      {},
      {
        resolveBuild: () => '/cache/Fixture.app',
        ...providerDeps({
          resolve: () => {
            throw new Error('the provider must not be consulted after a local hit');
          },
          store: () => {},
        }),
        loadCacheProvider: async () => {
          loads += 1;
          return { name: './cache.cjs', provider: { builds: { resolve: () => null, store: () => {} } } };
        },
      },
    );

    expect(loads).toBe(0);
    expect(calls.order.includes('loadProjectProvider')).toBe(false);
    expect(calls.order.includes('buildIos')).toBe(false);
  });

  test('a provider hit is stored locally and never reaches the Expo provider', async () => {
    reserve();
    const artifact = downloaded();
    const seen: Array<{ name: string; value: unknown }> = [];
    const { exitCode, calls, errs, logs } = await run(
      { json: true },
      providerDeps(
        {
          resolve: (input: { key: string; platform: string; destinationDir: string }) => {
            seen.push({ name: 'resolve', value: input });
            return artifact;
          },
          store: () => {},
        },
        (name, value) => seen.push({ name, value }),
      ),
    );

    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBe(false);
    expect(calls.order.includes('loadProjectProvider')).toBe(false);
    expect(calls.args.storeBuild.path).toBe(artifact);
    expect(errs.join('\n')).toMatch(/^ {2}cache {7}provider hit \(\.\/cache\.cjs\) -> stored locally$/m);
    expect(parseFirst(logs).cacheHit).toBe('remote');
    expect(seen[0]).toEqual({ name: 'loadCacheProvider', value: { projectRoot: root, config: providerConfig() } });
    expect(seen[1]?.value).toMatchObject({ platform: 'ios', key: `${FINGERPRINT}-debug-sim` });
  });

  test('the summary names the provider a hit came from', async () => {
    reserve();
    const artifact = downloaded();
    const { logs } = await run({}, providerDeps({ resolve: () => artifact, store: () => {} }));

    expect(logs.join('\n')).toMatch(/OK: [^\n]*from \.\/cache\.cjs/);
    expect(logs.join('\n')).toMatch(/^ {2}cache {7}from \.\/cache\.cjs$/m);
    expect(logs.join('\n')).not.toMatch(/the remote cache/);
  });

  test('a provider miss falls through to the Expo provider, the build lock, then the build', async () => {
    reserve();
    const { exitCode, calls } = await run(
      {},
      {
        detectIsExpo: () => true,
        ...providerDeps({ resolve: () => null, store: () => {} }),
      },
    );

    expect(exitCode).toBe(null);
    expect(
      calls.order.filter((c) =>
        ['resolveBuild', 'loadProjectProvider', 'acquireBuildLock', 'buildIos', 'storeBuild'].includes(c),
      ),
    ).toEqual(['resolveBuild', 'loadProjectProvider', 'acquireBuildLock', 'buildIos', 'storeBuild']);
  });

  test('a fresh build uploads to the provider and the Expo provider independently', async () => {
    reserve();
    const uploads: unknown[] = [];
    const { exitCode, errs, calls } = await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
        ...providerDeps({
          resolve: () => null,
          store: (input: unknown) => {
            uploads.push(input);
          },
        }),
      },
    );

    expect(exitCode).toBe(null);
    expect(calls.order.includes('uploadRemote')).toBe(true);
    expect(uploads.length).toBe(1);
    expect(uploads[0]).toMatchObject({ platform: 'ios', key: `${FINGERPRINT}-debug-sim`, overwrite: false });
    expect(errs.join('\n')).toMatch(/^ {2}cache {7}uploaded \(\.\/cache\.cjs\)$/m);
  });

  test('--no-build-cache skips the provider read and still uploads', async () => {
    reserve();
    const uploads: unknown[] = [];
    const { exitCode, calls } = await run(
      { buildCache: false },
      providerDeps({
        resolve: () => {
          throw new Error('the provider must not be read with --no-build-cache');
        },
        store: (input: unknown) => {
          uploads.push(input);
        },
      }),
    );

    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBe(true);
    expect(uploads.length).toBe(1);
    expect(uploads[0]).toMatchObject({ overwrite: true });
  });

  test('an unusable provider reports once and the build still succeeds', async () => {
    reserve();
    const { exitCode, errs, calls } = await run(
      {},
      {
        resolveCacheProviderConfig: () => providerConfig(),
        loadCacheProvider: async () => ({ name: './cache.cjs', unavailable: 'missing credentials' }),
      },
    );

    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBe(true);
    const notices = errs.filter((line) => /provider not usable/.test(line));
    expect(notices.length).toBe(1);
    expect(notices[0]).toMatch(/provider not usable \(\.\/cache\.cjs\): missing credentials; using local cache/);
  });

  test('a provider read failure and an upload failure keep the build successful', async () => {
    reserve();
    const { exitCode, errs, calls } = await run(
      {},
      providerDeps({
        resolve: () => {
          throw new Error('unauthorized');
        },
        store: () => {
          throw new Error('upload denied');
        },
      }),
    );

    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBe(true);
    expect(errs.join('\n')).toMatch(/\.\/cache\.cjs could not be used: unauthorized; building instead/);
    expect(errs.join('\n')).toMatch(/\.\/cache\.cjs upload failed: upload denied/);
  });
});

test('an unusable cache.provider value is reported once and the run continues', async () => {
  reserve();
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ cache: { provider: '  ' } }));
  const { exitCode, errs, calls } = await run(
    {},
    {
      repoRoot: () => root,
      loadCacheProvider: async () => {
        throw new Error('an invalid setting must not reach the loader');
      },
    },
  );

  expect(exitCode).toBe(null);
  expect(calls.order.includes('buildIos')).toBe(true);
  const notices = errs.filter((line) => line.includes('Invalid cache.provider setting'));
  expect(notices.length).toBe(1);
  expect(notices[0]).toMatch(/Using the local cache\./);
});

test('a wrong-typed cache.provider setting is refused before the build', async () => {
  reserve();
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ cache: { provider: 42 } }));
  const { exitCode, errs, calls } = await run(
    {},
    {
      repoRoot: () => root,
      loadCacheProvider: async () => {
        throw new Error('an invalid setting must not reach the loader');
      },
    },
  );

  expect(exitCode).toBe(1);
  expect(calls.order.includes('buildIos')).toBe(false);
  expect(errs.join('\n')).toContain('Invalid cache.provider setting 42. Expected a string.');
});

test('a local hit leaves no provider download directory behind', async () => {
  reserve();
  const { exitCode } = await run(
    {},
    {
      resolveBuild: () => '/cache/Fixture.app',
      resolveCacheProviderConfig: () => ({ provider: './cache.cjs', options: {}, baseDir: root }),
      loadCacheProvider: async () => ({
        name: './cache.cjs',
        provider: { builds: { resolve: () => null, store: () => {} } },
      }),
    },
  );

  expect(exitCode).toBe(null);
  expect(existsSync(join(workspaceDir(root), 'cache-provider'))).toBe(false);
});

describe('an app the simulator already holds', () => {
  test('the skip is named on the install line and carried in the facts', async () => {
    reserve();
    const { logs, stderr } = await run(
      { json: true },
      { installIosApp: (args) => ({ ok: true, appPath: args.appPath, skipped: true }) },
    );

    expect(stderr).toMatch(/skipped; .*already holds this app/);
    expect(parseFirst(logs).installSkipped).toBe(true);
  });

  test('an install that really ran reports installSkipped false', async () => {
    reserve();
    const { logs, stderr } = await run({ json: true });

    expect(stderr).not.toMatch(/skipped/);
    expect(parseFirst(logs).installSkipped).toBe(false);
  });
});

describe('ios --device: selecting a phone and building the device slice', () => {
  const PHONE = '00008030-001A2B3C4D5E802E';

  // The device path copies the bundle aside with the real `cp`, so the fixture
  // has to exist on disk.
  beforeEach(() => {
    mkdirSync(join(root, 'build', 'Fixture.app'), { recursive: true });
  });

  function connected(devices: Array<Record<string, unknown>> = [{ udid: PHONE, name: 'Test Phone' }]) {
    return {
      listIosDevices: () =>
        devices.map((d) => ({
          udid: PHONE,
          name: 'Test Phone',
          bootState: 'booted',
          developerModeStatus: 'enabled',
          pairingState: 'paired',
          transportType: 'wired',
          ...d,
        })),
    };
  }

  test('--device with an empty udid refuses before anything is spawned', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({ device: '' }, connected());
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_BAD_ARG/);
    expect(errs.join('\n')).toMatch(/empty UDID/);
    expect(calls.order.includes('fingerprintProject')).toBe(false);
  });

  test('--device and --remote together refuse, because they name two different devices', async () => {
    reserve();
    const { errs, exitCode } = await run({ device: true, remote: 'proxy' }, connected());
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_BAD_ARG/);
    expect(errs.join('\n')).toMatch(/Pass only one of --device and --remote/);
  });

  test('no connected phone is STIM_NO_DEVICE, and nothing is created to make one', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({ device: true }, { listIosDevices: () => [] });
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_NO_DEVICE/);
    expect(errs.join('\n')).toMatch(/Developer Mode/);
    expect(calls.order.includes('ensureOwnedDevice')).toBe(false);
    expect(calls.order.includes('checkDeviceCapacity')).toBe(false);
  });

  test('several connected phones no longer refuse: the first free one in id order is taken', async () => {
    reserve();
    const { errs, exitCode, logs } = await run(
      { device: true, json: true },
      connected([{ udid: '00008120-000A11223C44201E', name: 'Second' }, { udid: PHONE }]),
    );
    expect(exitCode).toBe(null);
    expect(errs.join('\n')).not.toMatch(/STIM_NO_DEVICE/);
    expect(parseFirst(logs).udid).toBe(PHONE);
    expect(parseFirst(logs).deviceName).toBe('Test Phone');
  });

  test('two unhealthy cabled phones refuse with each one own reason, not the count message', async () => {
    reserve();
    const SECOND = '00008120-000A11223C44201E';
    const { errs, exitCode } = await run(
      { device: true },
      connected([
        { udid: PHONE, developerModeStatus: 'disabled' },
        { udid: SECOND, name: 'Second', pairingState: 'unpaired' },
      ]),
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_NO_DEVICE/);
    expect(errs.join('\n')).toMatch(new RegExp(`${PHONE} \\(Test Phone\\) has Developer Mode disabled`));
    expect(errs.join('\n')).toMatch(new RegExp(`${SECOND} \\(Second\\) is connected but unpaired`));
    expect(errs.join('\n')).not.toMatch(/Several devices are connected/);
    expect(errs.join('\n')).not.toMatch(/Name the one to build for/);
  });

  test('a phone another workspace leases is skipped for the free one, whatever the order', async () => {
    reserve();
    takeLease({ root: '/worktree/theirs', platform: 'ios', id: PHONE, kind: 'declared' });
    const { exitCode, logs } = await run(
      { device: true, json: true },
      connected([{ udid: PHONE }, { udid: '00008120-000A11223C44201E', name: 'Second' }]),
    );
    expect(exitCode).toBe(null);
    expect(parseFirst(logs).udid).toBe('00008120-000A11223C44201E');
  });

  test('the phone this workspace leases wins even when another sorts first', async () => {
    reserve();
    const mine = takeLease({ root, platform: 'ios', id: '00008120-000A11223C44201E', kind: 'declared' });
    assert(mine.status === 'taken');
    const { exitCode, logs } = await run(
      { device: true, json: true },
      connected([{ udid: PHONE }, { udid: '00008120-000A11223C44201E', name: 'Second' }]),
    );
    expect(exitCode).toBe(null);
    expect(parseFirst(logs).udid).toBe('00008120-000A11223C44201E');
    expect(parseFirst(logs).lease).toEqual({ kind: 'declared', expiresAt: expect.any(String) });
  });

  test('a leased phone that is not connected refuses rather than silently using another', async () => {
    reserve();
    takeLease({ root, platform: 'ios', id: 'GONE-PHONE', kind: 'declared' });
    const { errs, exitCode, calls } = await run({ device: true }, connected());
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_NO_DEVICE/);
    expect(errs.join('\n')).toMatch(/This workspace leases GONE-PHONE, and it is not connected/);
    expect(errs.join('\n')).toMatch(/stim device unlock/);
    expect(calls.order.includes('buildIos')).toBe(false);
  });

  test('every connected phone leased elsewhere refuses with all of them named', async () => {
    reserve();
    takeLease({ root: '/worktree/one', platform: 'ios', id: PHONE, deviceName: 'Test Phone', kind: 'declared' });
    takeLease({ root: '/worktree/two', platform: 'ios', id: '00008120-000A11223C44201E', kind: 'declared' });
    const { errs, exitCode, logs } = await run(
      { device: true, json: true, wait: '0' },
      connected([{ udid: PHONE }, { udid: '00008120-000A11223C44201E', name: 'Second' }]),
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_DEVICE_BUSY/);
    expect(errs.join('\n')).toMatch(/\/worktree\/one/);
    expect(errs.join('\n')).toMatch(/\/worktree\/two/);
    expect(parseFirst(logs).lease).toMatchObject({ platform: 'ios', id: PHONE, holder: '/worktree/one' });
  });

  test('--no-wait with every connected phone leased installs on the first, without a lease', async () => {
    reserve();
    takeLease({ root: '/worktree/one', platform: 'ios', id: PHONE, deviceName: 'Test Phone', kind: 'declared' });
    takeLease({ root: '/worktree/two', platform: 'ios', id: '00008120-000A11223C44201E', kind: 'declared' });
    const { errs, exitCode, logs, calls } = await run(
      { device: true, json: true, wait: false },
      connected([{ udid: PHONE }, { udid: '00008120-000A11223C44201E', name: 'Second' }]),
    );

    expect(exitCode).toBe(null);
    expect(calls.order.includes('installIosDeviceApp')).toBe(true);
    expect(parseFirst(logs).udid).toBe(PHONE);
    expect(parseFirst(logs).lease).toBe(null);
    expect(errs.join('\n')).toMatch(/--no-wait: \/worktree\/one holds Test Phone/);
    expect(listLeaseFiles()).toHaveLength(2);
  });

  test('no connected phone at all still refuses with the resolver own message', async () => {
    reserve();
    const { errs, exitCode } = await run({ device: true }, { listIosDevices: () => [] });
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/No physical iOS device is connected/);
    expect(errs.join('\n')).toMatch(/Developer Mode/);
  });

  test('a named udid still goes through the resolver, not the pool', async () => {
    reserve();
    const { errs, exitCode } = await run({ device: '00008120-000A11223C44201E' }, connected([{ udid: PHONE }]));
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/is not connected\. devicectl reports these cabled devices/);
  });

  test('the one connected phone is used, never owned, and never booted', async () => {
    reserve();
    const { calls } = await run({ device: true }, connected());
    expect(calls.order.includes('ensureOwnedDevice')).toBe(false);
    expect(calls.order.includes('ensureBooted')).toBe(false);
    expect(calls.order.includes('checkDeviceCapacity')).toBe(false);
    expect(getProject(root)?.deviceUdid ?? null).toBe(null);
  });

  test('the build is the iphoneos slice, keyed -device, and carries no signing flag', async () => {
    reserve();
    const { calls } = await run({ device: true, configuration: 'Release' }, connected());
    const build = calls.args.buildIos as Record<string, unknown>;
    expect(build?.sdk).toBe('iphoneos');
    expect(build?.udid).toBe(PHONE);
    expect(build?.destination).toBe(null);
    expect(build?.configuration).toBe('Release');
    const store = calls.args.storeBuild as { key: string };
    expect(store.key).toBe(`${FINGERPRINT}-release-device`);
    const lookup = calls.args.resolveBuild as { key: string };
    expect(lookup.key).toBe(`${FINGERPRINT}-release-device`);
  });

  test('the simulator path is unchanged and still keys -sim, so no cache entry moves', async () => {
    reserve();
    const { calls } = await run({ configuration: 'Release' });
    const store = calls.args.storeBuild as { key: string };
    expect(store.key).toBe(`${FINGERPRINT}-release-sim`);
    const build = calls.args.buildIos as Record<string, unknown>;
    expect(build?.sdk).toBe(undefined);
  });

  test('it installs and launches with devicectl, never with simctl', async () => {
    reserve();
    const { errs, exitCode, calls, logs } = await run({ device: true, json: true }, connected());
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBe(true);
    expect(calls.order.includes('storeBuild')).toBe(true);
    expect(calls.order.includes('installIosDeviceApp')).toBe(true);
    expect(calls.order.includes('installIosApp')).toBe(false);
    expect(calls.order.includes('launchIosApp')).toBe(false);
    expect(calls.order.includes('replaceCollector')).toBe(true);
    expect(errs.join('\n')).not.toMatch(/STIM_BAD_ARG/);
    const facts = parseFirst(logs);
    expect(facts.udid).toBe(PHONE);
    expect(facts.launched).toBe(true);
    expect(facts.cacheKey).toBe(`${FINGERPRINT}-debug-device`);
  });

  test('the collector is the launch: it carries --physical and the run reads the device pid', async () => {
    reserve();
    const { calls } = await run({ device: true }, connected());
    const collector = calls.args.replaceCollector as Record<string, unknown>;
    expect(collector.physical).toBe(true);
    expect(collector.udid).toBe(PHONE);
    const launch = calls.args.awaitIosDeviceLaunch as Record<string, unknown>;
    expect(launch.udid).toBe(PHONE);
    expect(calls.order.indexOf('replaceCollector')).toBeLessThan(calls.order.indexOf('awaitIosDeviceLaunch'));
  });

  // An upgrade install terminates the running app, which ends the console the
  // previous collector holds: stopping it first keeps a normal reinstall from
  // recording a failure.
  test('the previous collector is stopped BEFORE the install, not as part of the launch', async () => {
    reserve();
    const { calls } = await run({ device: true }, connected());
    expect(calls.order.indexOf('stopPreviousCollector')).toBeLessThan(calls.order.indexOf('installIosDeviceApp'));
    expect(calls.order.indexOf('installIosDeviceApp')).toBeLessThan(calls.order.indexOf('replaceCollector'));
  });

  test('the simulator path does not stop its collector early: nothing there holds a console', async () => {
    reserve();
    const { calls } = await run({});
    expect(calls.order.includes('stopPreviousCollector')).toBe(false);
    expect(calls.order.includes('replaceCollector')).toBe(true);
  });

  test('a dev-client app is launched on the LAN payload URL and its ip.txt is left alone', async () => {
    reserve();
    const { calls, errs } = await run(
      { device: true },
      { ...connected(), detectIsExpo: () => true, devClientScheme: () => 'com.example.app' },
    );
    const collector = calls.args.replaceCollector as Record<string, unknown>;
    expect(collector.payloadUrl).toBe(
      `com.example.app://expo-development-client/?url=${encodeURIComponent('http://192.168.1.5:8082')}`,
    );
    expect(calls.order.includes('sealAppForDevice')).toBe(false);
    expect(calls.order.includes('gateProfileForDevice')).toBe(true);
    expect(errs.join('\n')).not.toMatch(/ip\.txt/);
  });

  test('a bare app gets <addr>:<port> in ip.txt on a copy, re-sealed, and no payload URL', async () => {
    reserve();
    let sealedIpTxt: string | null = null;
    const { calls, errs } = await run(
      { device: true },
      {
        ...connected(),
        sealAppForDevice: (args) => {
          sealedIpTxt = readFileSync(join(args.appPath, 'ip.txt'), 'utf-8');
          return { ok: true as const, identity: IDENTITY, mode: 'preserve-metadata' as const };
        },
      },
    );
    expect(sealedIpTxt).toBe('192.168.1.5:8082\n');
    const sealed = calls.args.installIosDeviceApp as Record<string, unknown>;
    expect(String(sealed.appPath)).not.toBe(join(root, 'build', 'Fixture.app'));
    expect(String(sealed.appPath).endsWith('Fixture.app')).toBe(true);
    const collector = calls.args.replaceCollector as Record<string, unknown>;
    expect(collector.payloadUrl).toBe(null);
    expect(errs.join('\n')).toMatch(/ip\.txt\s+192\.168\.1\.5:8082 written into the install copy/);
  });

  test('the pristine artifact is stored before the copy is mutated, and the copy is deleted', async () => {
    reserve();
    const { calls } = await run({ device: true }, connected());
    expect(calls.order.indexOf('storeBuild')).toBeLessThan(calls.order.indexOf('sealAppForDevice'));
    const stored = calls.args.storeBuild as { path: string };
    expect(stored.path).toBe(join(root, 'build', 'Fixture.app'));
    expect(existsSync(join(root, 'build', 'Fixture.app', 'ip.txt'))).toBe(false);
    const installed = calls.args.installIosDeviceApp as { appPath: string };
    expect(existsSync(installed.appPath)).toBe(false);
  });

  test('a malformed ios.lanHost refuses the run before the phone is looked for', async () => {
    reserve();
    const { errs, exitCode, calls } = await run(
      { device: true },
      { ...connected(), resolveSettings: () => ({ ios: { lanHost: 'http://192.168.1.42' } }) },
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_BAD_ARG/);
    expect(errs.join('\n')).toMatch(/Invalid ios\.lanHost/);
    expect(calls.order.includes('fingerprintProject')).toBe(false);
  });

  test('a device run never touches the Expo provider, in either direction', async () => {
    reserve();
    let loadProjectProviderCalls = 0;
    let resolveRemoteCalls = 0;
    let uploadCalls = 0;
    const { calls, errs } = await run(
      { device: true, configuration: 'Release' },
      {
        ...connected(),
        detectIsExpo: () => true,
        loadProjectProvider: async () => {
          loadProjectProviderCalls += 1;
          return { provider: { plugin: {}, options: {} }, name: 'eas' };
        },
        resolveRemote: async () => {
          resolveRemoteCalls += 1;
          return { appPath: join(root, 'downloaded', 'Fixture.app') };
        },
        uploadRemote: async () => {
          uploadCalls += 1;
          return { uploaded: true };
        },
      },
    );
    expect(loadProjectProviderCalls).toBe(0);
    expect(resolveRemoteCalls).toBe(0);
    expect(uploadCalls).toBe(0);
    expect(calls.order.includes('buildIos')).toBe(true);
    expect((calls.args.storeBuild as { key: string }).key).toBe(`${FINGERPRINT}-release-device`);
    expect(errs.join('\n')).not.toMatch(/local-tier only/);
  });

  test('a device run never loads the build-cache provider, for the read or the upload', async () => {
    reserve();
    let loads = 0;
    const { calls, errs } = await run(
      { device: true },
      {
        ...connected(),
        resolveCacheProviderConfig: () => ({ provider: './cache.cjs', options: {}, baseDir: root }),
        loadCacheProvider: async () => {
          loads += 1;
          return { name: './cache.cjs', provider: { builds: {} } };
        },
      },
    );
    expect(loads).toBe(0);
    expect(calls.order.filter((c) => ['resolveBuild', 'storeBuild'].includes(c))).toEqual([
      'resolveBuild',
      'storeBuild',
    ]);
    expect(errs.filter((line) => line.includes('local-tier only'))).toHaveLength(1);
  });

  test('a device run with no provider configured says nothing about providers', async () => {
    reserve();
    const { errs } = await run({ device: true }, connected());
    expect(errs.join('\n')).not.toMatch(/local-tier only/);
    expect(errs.join('\n')).not.toMatch(/provider/);
  });

  test('a cached device app installs without building, and the cache entry is not the copy', async () => {
    reserve();
    const cached = join(root, 'cached', 'Fixture.app');
    mkdirSync(cached, { recursive: true });
    const { calls, exitCode } = await run({ device: true }, { ...connected(), resolveBuild: () => cached });
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBe(false);
    const sealed = calls.args.sealAppForDevice as { appPath: string };
    expect(sealed.appPath).not.toBe(cached);
    expect(existsSync(join(cached, 'ip.txt'))).toBe(false);
    expect(calls.order.includes('installIosDeviceApp')).toBe(true);
  });

  test('the same providers ARE consulted without --device, so the gate is not vacuous', async () => {
    reserve();
    let loadProjectProviderCalls = 0;
    let resolveRemoteCalls = 0;
    await run(
      {},
      {
        detectIsExpo: () => true,
        loadProjectProvider: async () => {
          loadProjectProviderCalls += 1;
          return { provider: { plugin: {}, options: {} }, name: 'eas' };
        },
        resolveRemote: async () => {
          resolveRemoteCalls += 1;
          return null;
        },
      },
    );
    expect(loadProjectProviderCalls).toBe(1);
    expect(resolveRemoteCalls).toBe(1);

    let loads = 0;
    await run(
      {},
      {
        resolveCacheProviderConfig: () => ({ provider: './cache.cjs', options: {}, baseDir: root }),
        loadCacheProvider: async () => {
          loads += 1;
          return { none: true };
        },
      },
    );
    expect(loads).toBeGreaterThan(0);
  });

  test('a device release cache hit is refused and rebuilt, so no builder JS reaches the phone', async () => {
    reserve();
    let swaps = 0;
    const { calls, errs } = await run(
      { device: true, configuration: 'Release' },
      {
        ...connected(),
        resolveBuild: () => join(root, 'cached', 'Fixture.app'),
        swapJsBundle: async () => {
          swaps += 1;
          return { ok: true, appPath: join(root, 'js-swap', 'Fixture.app'), tmpDir: null, hermes: true, durationMs: 1 };
        },
      },
    );
    expect(swaps).toBe(0);
    expect(calls.order.includes('buildIos')).toBe(true);
    expect(calls.order.includes('installIosApp')).toBe(false);
    expect(calls.order.includes('installIosDeviceApp')).toBe(true);
    expect(errs.join('\n')).toMatch(/carries its builder's JS[\s\S]*building fresh instead/);
  });

  test('a release device run proves the launch with a device process, never a host pid', async () => {
    reserve();
    const { calls, logs } = await run({ device: true, configuration: 'Release', json: true }, connected());
    expect(calls.order.includes('verifyReleaseLaunch')).toBe(false);
    const verified = calls.args.verifyIosDeviceReleaseLaunch as Record<string, unknown>;
    expect(verified.udid).toBe(PHONE);
    expect(verified.appName).toBe('Fixture');
    const facts = parseFirst(logs);
    expect(facts.launched).toBe(true);
    expect(facts.metroPort).toBe(null);
    const collector = calls.args.replaceCollector as Record<string, unknown>;
    expect(collector.payloadUrl).toBe(null);
  });

  test('a phone is used, never recorded: no device claim survives a full install and launch', async () => {
    reserve();
    const { exitCode } = await run({ device: true }, connected());
    expect(exitCode).toBe(null);
    expect(getProject(root)?.deviceUdid ?? null).toBe(null);
    expect(getProject(root)?.deviceName ?? null).toBe(null);
  });

  test('an install refusal keeps its remedy, and a signer conflict is reported as a data loss', async () => {
    reserve();
    const refused = await run(
      { device: true },
      {
        ...connected(),
        installIosDeviceApp: () => ({
          failed: true,
          code: 'STIM_INSTALL_FAILED',
          reason: 'devicectl could not install the app: the device is locked',
          remedy: 'Unlock the phone and keep it awake, then run the command again.',
        }),
      },
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.errs.join('\n')).toMatch(/STIM_INSTALL_FAILED/);
    expect(refused.errs.join('\n')).toMatch(/Unlock the phone/);
    expect(refused.calls.order.includes('replaceCollector')).toBe(false);

    const retried = await run(
      { device: true },
      {
        ...connected(),
        installIosDeviceApp: (args) => ({
          ok: true,
          appPath: args.appPath,
          uninstalled: true,
          note: 'com.example.app was already installed on the phone under a different team, so it was uninstalled (its data went with it) before this app could be installed',
        }),
      },
    );
    expect(retried.exitCode).toBe(null);
    expect(retried.errs.join('\n')).toMatch(/its data went with it/);
  });

  test('a launch the phone refuses fails with the trust remedy and the devicectl evidence', async () => {
    reserve();
    const { errs, exitCode } = await run(
      { device: true },
      {
        ...connected(),
        awaitIosDeviceLaunch: async () => ({
          failed: true,
          reason: 'devicectl could not keep com.example.app running on the phone.',
          remedy:
            "The phone has not trusted this build's developer certificate. On the phone open Settings > General > VPN & Device Management, tap the developer profile under DEVELOPER APP, tap Trust, then run the command again.",
          lines: ['ERROR: FBSOpenApplicationErrorDomain error 3 (Security)'],
        }),
      },
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_LAUNCH_FAILED/);
    expect(errs.join('\n')).toMatch(/VPN & Device Management/);
    expect(errs.join('\n')).toMatch(/FBSOpenApplicationErrorDomain error 3/);
  });

  test('no LAN address refuses before the build, and names the shared network', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({ device: true }, { ...connected(), hostLanCandidates: () => [] });
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_NO_LAN_ADDRESS/);
    expect(errs.join('\n')).toMatch(/Join a Wi-Fi or Ethernet network/);
    expect(calls.order.includes('fingerprintProject')).toBe(false);
  });

  test('a LAN origin that is not this workspace Metro refuses before the build', async () => {
    reserve();
    const { errs, exitCode, calls } = await run(
      { device: true },
      {
        ...connected(),
        ensureLanReachable: async () => ({
          failed: 'http://192.168.1.5:8082 answered 200, but the request never reached THIS workspace Metro.',
          remedy: '`stim start` prints the port it reserved.',
        }),
      },
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_LAN_METRO_UNREACHABLE/);
    expect(calls.order.includes('fingerprintProject')).toBe(false);
  });

  test('ios.lanHost pins the address written into ip.txt and gated', async () => {
    reserve();
    let sealedIpTxt: string | null = null;
    const { calls, errs } = await run(
      { device: true },
      {
        ...connected(),
        resolveSettings: () => ({ ios: { lanHost: '10.0.0.9' } }),
        sealAppForDevice: (args) => {
          sealedIpTxt = readFileSync(join(args.appPath, 'ip.txt'), 'utf-8');
          return { ok: true as const, identity: IDENTITY, mode: 'preserve-metadata' as const };
        },
      },
    );
    const gate = calls.args.ensureLanReachable as Record<string, unknown>;
    expect(gate.origin).toBe('http://10.0.0.9:8082');
    expect(sealedIpTxt).toBe('10.0.0.9:8082\n');
    expect(errs.join('\n')).toMatch(/lan\s+http:\/\/10\.0\.0\.9:8082 \(ios\.lanHost\)/);
  });

  test('a refused signing gate on a fresh build exits on its own code instead of building again', async () => {
    reserve();
    let builds = 0;
    const { errs, exitCode } = await run(
      { device: true },
      {
        ...connected(),
        buildIos: async () => {
          builds += 1;
          return { appPath: join(root, 'build', 'Fixture.app'), bundleId: 'com.example.app', durationMs: 1000 };
        },
        sealAppForDevice: () => ({
          ok: false as const,
          code: 'STIM_PROFILE_MISMATCH',
          reason: 'The development profile lists 1 device and this phone is not one of them.',
          remedy: 'Register the UDID at developer.apple.com, regenerate the profile, then build once from Xcode.',
          lastLines: [],
        }),
      },
    );
    expect(builds).toBe(1);
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_PROFILE_MISMATCH/);
    expect(errs.join('\n')).toMatch(/developer\.apple\.com/);
  });

  test('a refused signing gate on a CACHED app falls back to a full build', async () => {
    reserve();
    let seals = 0;
    const cached = join(root, 'cached', 'Fixture.app');
    mkdirSync(cached, { recursive: true });
    const { calls, errs, exitCode } = await run(
      { device: true },
      {
        ...connected(),
        resolveBuild: () => cached,
        sealAppForDevice: (args) => {
          seals += 1;
          if (seals === 1) {
            return {
              ok: false as const,
              code: 'STIM_NO_SIGNING_IDENTITY',
              reason: 'The app was signed by "Apple Development: Someone Else", which is not in this keychain.',
              remedy: 'Open Xcode > Settings > Accounts and download your certificates.',
              lastLines: [],
            };
          }
          return { ok: true as const, identity: IDENTITY, mode: 'preserve-metadata' as const, appPath: args.appPath };
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBe(true);
    expect(errs.join('\n')).toMatch(/not in this keychain[\s\S]*building fresh instead/);
  });

  // The install path routes on the dev-client scheme, so the remedy has to as
  // well: an Expo project without expo-dev-client takes ip.txt and needs the
  // stale-fallback warning, not the server picker.
  // The LAN gate fetches the bundle URL from the HOST, which lands in the same
  // Metro timeline verifyLaunch reads. If the launch window opened before that
  // fetch, the gate's own record would prove the phone had launched.
  test('the launch window opens after the LAN gate and after the install', async () => {
    reserve();
    let clock = 1_000_000;
    let gatedAt = 0;
    let installedAt = 0;
    const { calls } = await run(
      { device: true },
      {
        ...connected(),
        now: () => (clock += 1000),
        ensureLanReachable: async () => {
          gatedAt = clock;
          return { ok: true as const };
        },
        installIosDeviceApp: (args) => {
          installedAt = clock;
          return { ok: true, appPath: args.appPath };
        },
      },
    );
    const since = Number((calls.args.verifyLaunch as { since?: unknown }).since);
    expect(gatedAt).toBeGreaterThan(0);
    expect(installedAt).toBeGreaterThan(gatedAt);
    expect(since).toBeGreaterThan(installedAt);
  });

  test('an Expo app WITHOUT a dev client gets the bare remedy, not the picker', async () => {
    reserve();
    const { errs, calls } = await run(
      { device: true },
      {
        ...connected(),
        detectIsExpo: () => true,
        devClientScheme: () => undefined,
        verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
      },
    );
    const out = errs.join('\n');
    expect(calls.order.includes('sealAppForDevice')).toBe(true);
    expect(out).toMatch(/carries the JS bundle baked in/);
    expect(out).not.toMatch(/DEVELOPMENT SERVERS picker/);
    expect(out).not.toMatch(/Retry the deep link/);
  });

  test('a dev-client app gets the picker and the deep-link retry, not the bare warning', async () => {
    reserve();
    const { errs } = await run(
      { device: true },
      {
        ...connected(),
        detectIsExpo: () => true,
        devClientScheme: () => 'com.example.app',
        verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
      },
    );
    const out = errs.join('\n');
    expect(out).toMatch(/DEVELOPMENT SERVERS picker/);
    expect(out).toMatch(/Retry the deep link: xcrun devicectl device process launch/);
    expect(out).not.toMatch(/carries the JS bundle baked in/);
  });

  test('the unverified remedy names all three causes the LAN gate cannot tell apart', async () => {
    reserve();
    const { errs } = await run(
      { device: true },
      { ...connected(), verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) },
    );
    const out = errs.join('\n');
    expect(out).toMatch(/UNVERIFIED/);
    expect(out).toMatch(/Local Network/);
    expect(out).toMatch(/same Wi-Fi SSID/);
    expect(out).toMatch(/socketfilterfw --getglobalstate/);
    expect(out).toMatch(/ios\.lanHost/);
    expect(out).toMatch(/carries the JS bundle baked in/);
  });

  function writeLocalNetworkDeviceLog(pid = DEVICE_PID) {
    const dir = workspaceLogsDir(root);
    mkdirSync(dir, { recursive: true });
    const lines = readFileSync(new URL('./fixtures/ios-device/local-network-pending.txt', import.meta.url), 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((msg) =>
        JSON.stringify({ ts: Date.now() + 60_000, src: 'device', level: 'info', msg, proc: `Fixture(${pid})` }),
      );
    writeFileSync(join(dir, 'device.ndjson'), `${lines.join('\n')}\n`);
  }

  test('a dev-client launch with the Local Network signature gets the routed remedy', async () => {
    reserve();
    writeLocalNetworkDeviceLog();
    const { errs } = await run(
      { device: true },
      {
        ...connected(),
        detectIsExpo: () => true,
        devClientScheme: () => 'com.example.app',
        verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
      },
    );
    const out = errs.join('\n');
    expect(out).toMatch(/THE PHONE'S LOCAL NETWORK PERMISSION IS NOT GRANTED/);
    expect(out).toContain('unsatisfied (Local network prohibited)');
    expect(out).toMatch(/unanswered OR was answered Don't Allow earlier/);
    expect(out).toMatch(/If the FIRST `alert get` already finds no alert/);
    expect(out).toContain(`agent-device press 'label="Close"' --platform ios --udid ${PHONE}`);
    expect(out).toContain(`agent-device alert get --platform ios --udid ${PHONE}`);
    expect(out).toContain(`agent-device alert accept --platform ios --udid ${PHONE}`);
    expect(out).toContain(`agent-device snapshot -i --platform ios --udid ${PHONE}`);
    expect(out).toContain(`agent-device press 'label="Reload"' --platform ios --udid ${PHONE}`);
    expect(out).toMatch(/--terminate-existing --payload-url/);
    expect(out).toMatch(/`stim logs --source device` stops for the rest of this run/);
    expect(out).toMatch(/`agent-device metro reload` does NOT recover either screen/);
    expect(out).not.toMatch(/same Wi-Fi SSID/);
    expect(out).not.toMatch(/socketfilterfw/);
  });

  test('a bare launch with the same signature gets the RedBox and the ip.txt relaunch', async () => {
    reserve();
    writeLocalNetworkDeviceLog();
    const { errs } = await run(
      { device: true },
      {
        ...connected(),
        detectIsExpo: () => true,
        devClientScheme: () => undefined,
        verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
      },
    );
    const out = errs.join('\n');
    expect(out).toMatch(/THE PHONE'S LOCAL NETWORK PERMISSION IS NOT GRANTED/);
    expect(out).toContain(`agent-device alert accept --platform ios --udid ${PHONE}`);
    expect(out).toMatch(/Could not connect to development server/);
    expect(out).toMatch(/NOT VERIFIED ON HARDWARE/);
    expect(out).toMatch(/re-reads ip\.txt/);
    expect(out).not.toMatch(/--payload-url/);
    expect(out).not.toMatch(/label="Reload"/);
  });

  test('a device log from another process leaves the network list in place', async () => {
    reserve();
    writeLocalNetworkDeviceLog(DEVICE_PID + 1);
    const { errs } = await run(
      { device: true },
      { ...connected(), verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) },
    );
    const out = errs.join('\n');
    expect(out).not.toMatch(/LOCAL NETWORK PERMISSION IS NOT GRANTED/);
    expect(out).toMatch(/socketfilterfw --getglobalstate/);
    expect(out).toMatch(/cannot be PRE-granted from this machine/);
    expect(out).toMatch(/agent-device alert get, then agent-device alert accept/);
  });

  test('a malformed ios.signingIdentitySha1 refuses the same way', async () => {
    reserve();
    const { errs, exitCode } = await run(
      { device: true },
      { ...connected(), resolveSettings: () => ({ ios: { signingIdentitySha1: 'ABCDEF' } }) },
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/Invalid ios\.signingIdentitySha1/);
  });
});

describe('ios --device: the lease on the phone', () => {
  const PHONE = '00008030-001A2B3C4D5E802E';
  const OTHER_ROOT = '/worktree/theirs';

  beforeEach(() => {
    mkdirSync(join(root, 'build', 'Fixture.app'), { recursive: true });
  });

  function connected() {
    return {
      listIosDevices: () => [
        {
          udid: PHONE,
          name: 'Test Phone',
          bootState: 'booted',
          developerModeStatus: 'enabled',
          pairingState: 'paired',
          transportType: 'wired',
        },
      ],
    };
  }

  function fakeLease(over: Partial<RunLease> = {}) {
    const raises: number[] = [];
    const released: number[] = [];
    const lease: RunLease = {
      kind: 'run',
      expiresAt: '2026-09-02T12:05:00.000Z',
      lost: false,
      raise: (boundMs: number) => {
        raises.push(boundMs);
        return { ok: true, holder: root, expiresAt: lease.expiresAt };
      },
      release: () => {
        released.push(1);
      },
      facts: () => ({ kind: 'run', expiresAt: lease.expiresAt as string }),
      ...over,
    };
    return { lease, raises, released };
  }

  function leaseDeps(lease: RunLease, acquired: Record<string, unknown> = {}) {
    return {
      ...connected(),
      acquireRunLease: async () => ({ status: 'leased', kind: 'run', expiresAt: lease.expiresAt, ...acquired }),
      runLease: () => lease,
    };
  }

  test('a successful device run reports the lease it held, and a simulator run reports none', async () => {
    reserve();
    const { lease } = fakeLease();
    const { logs, exitCode } = await run({ device: true, json: true }, leaseDeps(lease));
    expect(exitCode).toBe(null);
    expect(parseFirst(logs).lease).toEqual({ kind: 'run', expiresAt: lease.expiresAt });

    const sim = await run({ json: true });
    expect(parseFirst(sim.logs)).not.toHaveProperty('lease');
  });

  test('every device step raises the lease to its own bound, in order', async () => {
    reserve();
    const { lease, raises } = fakeLease();
    await run({ device: true }, leaseDeps(lease));
    expect(raises).toEqual([DEVICECTL_INSTALL_TIMEOUT_MS, 2000 + LAUNCH_PROBE_TIMEOUT_MS, DEBUG_VERIFY_STEP_MS]);
  });

  test('a release build raises for the release probe instead of the bundle deadline', async () => {
    reserve();
    const { lease, raises } = fakeLease();
    await run({ device: true, configuration: 'Release' }, leaseDeps(lease));
    expect(raises.at(-1)).toBe(RELEASE_VERIFY_WAIT_MS);
  });

  test('the lease is released on success, on failure, and on an exception', async () => {
    reserve();
    const ok = fakeLease();
    await run({ device: true }, leaseDeps(ok.lease));
    expect(ok.released).toHaveLength(1);

    const failed = fakeLease();
    const failure = await run(
      { device: true },
      {
        ...leaseDeps(failed.lease),
        installIosDeviceApp: () => ({ failed: true, reason: 'devicectl said no' }),
      },
    );
    expect(failure.exitCode).toBe(1);
    expect(failed.released).toHaveLength(1);

    const threw = fakeLease();
    await expect(
      run(
        { device: true },
        {
          ...leaseDeps(threw.lease),
          replaceCollector: () => {
            throw new Error('the collector blew up');
          },
        },
      ),
    ).rejects.toThrow(/collector blew up/);
    expect(threw.released).toHaveLength(1);
  });

  test('a lease lost before the install refuses with STIM_DEVICE_LOST and installs nothing', async () => {
    reserve();
    const { lease } = fakeLease({
      raise: () => ({ ok: false, holder: OTHER_ROOT, expiresAt: '2026-09-02T12:30:00.000Z' }),
      facts: () => null,
    });
    const { errs, logs, exitCode, calls } = await run({ device: true, json: true }, leaseDeps(lease));

    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_DEVICE_LOST/);
    expect(errs.join('\n')).toMatch(new RegExp(`${OTHER_ROOT} took this device's lease`));
    expect(calls.order.includes('installIosDeviceApp')).toBe(false);
    expect(parseFirst(logs).lease).toBe(null);
  });

  test('a lease lost after the install warns once and finishes with lease null', async () => {
    reserve();
    let raised = 0;
    const { lease } = fakeLease({
      raise: () => {
        raised += 1;
        return raised === 1
          ? { ok: true, holder: root, expiresAt: '2026-09-02T12:05:00.000Z' }
          : { ok: false, holder: OTHER_ROOT, expiresAt: null };
      },
      facts: () => null,
    });
    const { errs, logs, exitCode, calls } = await run({ device: true, json: true }, leaseDeps(lease));

    expect(exitCode).toBe(null);
    expect(calls.order.includes('installIosDeviceApp')).toBe(true);
    const warnings = errs.filter((line) => line.includes('took this device'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/The app is already installed, so this run continues without one/);
    expect(parseFirst(logs).lease).toBe(null);
  });

  test('a device another workspace leases refuses with the holder in the JSON', async () => {
    reserve();
    const taken = takeLease({
      root: OTHER_ROOT,
      platform: 'ios',
      id: PHONE,
      deviceName: 'Test Phone',
      kind: 'declared',
    });
    assert(taken.status === 'taken');
    const { errs, logs, exitCode, calls } = await run({ device: true, json: true, wait: '0' }, connected());

    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_DEVICE_BUSY/);
    expect(calls.order.includes('installIosDeviceApp')).toBe(false);
    expect(parseFirst(logs).lease).toEqual({
      platform: 'ios',
      id: PHONE,
      deviceName: 'Test Phone',
      holder: OTHER_ROOT,
      expiresAt: taken.lease.expiresAt,
    });
  });

  test('--no-wait installs on a leased phone without taking one', async () => {
    reserve();
    takeLease({ root: OTHER_ROOT, platform: 'ios', id: PHONE, deviceName: 'Test Phone', kind: 'declared' });
    const { errs, logs, exitCode, calls } = await run({ device: true, json: true, wait: false }, connected());

    expect(exitCode).toBe(null);
    expect(calls.order.includes('installIosDeviceApp')).toBe(true);
    expect(errs.join('\n')).toMatch(/--no-wait: \/worktree\/theirs holds Test Phone/);
    expect(parseFirst(logs).lease).toBe(null);
    expect(listLeaseFiles()).toHaveLength(1);
  });

  test('a free phone is leased by the run and released at the end', async () => {
    reserve();
    const { exitCode, errs } = await run({ device: true }, connected());
    expect(exitCode).toBe(null);
    expect(errs.join('\n')).toMatch(new RegExp(`run lease on ${PHONE} until`));
    expect(listLeaseFiles()).toEqual([]);
  });

  test('--wait without --device, an unusable value, and both flags at once are all STIM_BAD_ARG', async () => {
    reserve();
    const noDevice = await run({ wait: '30' });
    expect(noDevice.exitCode).toBe(1);
    expect(noDevice.errs.join('\n')).toMatch(/--wait and --no-wait only apply to a `--device` run/);

    const bypassNoDevice = await run({ wait: false });
    expect(bypassNoDevice.errs.join('\n')).toMatch(/only apply to a `--device` run/);

    const bad = await run({ device: true, wait: 'soon' }, connected());
    expect(bad.exitCode).toBe(1);
    expect(bad.errs.join('\n')).toMatch(/Invalid --wait value/);

    const argv = process.argv;
    process.argv = ['node', 'stim', 'ios', '--device', '--wait', '30', '--no-wait'];
    try {
      const both = await run({ device: true, wait: false }, connected());
      expect(both.exitCode).toBe(1);
      expect(both.errs.join('\n')).toMatch(/--wait and --no-wait ask for opposite things/);
    } finally {
      process.argv = argv;
    }
  });
});
