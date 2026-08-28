import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { upsertProject } from '../config.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { workspaceLogsDir, workspaceStateFile } from '../paths.ts';
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

const UDID = 'BF2A1C3D-4E5F-6071-8293-A4B5C6D7E8F9';
const FINGERPRINT = 'a3f9b1c2d3e4f5';

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
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-cli-test-'));
  process.env.STIM_CLI_HOME = tmpHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cli-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_CLI_HOME;
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
  verifyLaunch: { since?: unknown; logsDir?: unknown };
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
      return { deviceUdid: UDID, deviceName: 'stim-cli-fixture', owned: true };
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
  test('fires before the boot and before fingerprinting: a dead port costs a second, not a build', async () => {
    reserve();
    const { errs, exitCode, calls } = await run(
      {},
      {
        resolveProjectMetro: async () => ({ missing: true }),
      },
    );
    expect(exitCode).toBe(1);
    expect(calls.order.includes('ensureOwnedDevice')).toBeTruthy();
    expect(!calls.order.includes('ensureBooted')).toBeTruthy();
    expect(!calls.order.includes('fingerprintProject')).toBeTruthy();
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/STIM_CLI_NO_METRO/);
    expect(errs.join('\n')).toMatch(/stim-cli start/);
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
    expect(errs.join('\n')).toMatch(/STIM_CLI_NO_METRO/);
  });

  test('no reservation at all is the same failure', async () => {
    const { errs, exitCode } = await run({});
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_CLI_NO_METRO/);
  });

  test('--no-metro-check proceeds without probing the port at all', async () => {
    reserve();
    const { exitCode, calls } = await run({ metroCheck: false });
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('resolveProjectMetro')).toBeTruthy();
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(calls.args.launchIosApp.metroPort).toBe(8082);
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

describe('the Metro gate retries an indexing Metro', () => {
  test('a port that verifies on the third attempt is not refused', async () => {
    reserve();
    let attempts = 0;
    const { exitCode, calls } = await run(
      {},
      {
        resolveProjectMetro: async () => {
          attempts += 1;
          if (attempts < 3)
            return { notOurs: "pid 42 on port 8082 does not answer Metro's /status", kind: 'unresponsive' };
          return { metro: { pid: 42, leader: 42, cwd: root } };
        },
      },
    );
    expect(exitCode).toBe(null);
    expect(attempts).toBe(3);
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
    expect(text).toMatch(/stim-cli start --wait/);
    expect(text).not.toMatch(/Run `stim-cli start` first/);
  });

  test('with no supervisor record the refusal is the plain one', async () => {
    reserve();
    const { errs } = await run({}, { resolveProjectMetro: async () => ({ missing: true }) });
    const text = errs.join('\n');
    expect(text).toMatch(/Nothing is serving this workspace's dev server on port 8082/);
    expect(text).toMatch(/Run `stim-cli start` first/);
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

describe('launch verification', () => {
  test('a verified launch reports launched: true and says what it saw', async () => {
    reserve();
    const { logs, errs, exitCode, calls } = await run({ json: true });
    expect(exitCode).toBe(null);
    expect(parseFirst(logs).launched).toBe(true);
    expect(errs.join('\n')).toMatch(/verify.*bundle requested from Metro port 8082/);
    expect(calls.args.verifyLaunch.logsDir).toBe(workspaceLogsDir(root));
    expect(Number.isFinite(calls.args.verifyLaunch.since)).toBeTruthy();
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

  test('the alert stall: the warning carries the exact openurl to retry', async () => {
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
    expect(text).toMatch(/Open in/);
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
    expect(existsSync(join(project, '.stim-cli'))).toBe(false);
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

  test('an unresolvable fingerprint is STIM_CLI_NO_FINGERPRINT, never an unkeyed build', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({}, { fingerprintProject: async () => null });
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/STIM_CLI_NO_FINGERPRINT/);
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
      logFile: `${projectRoot}/.stim-cli/logs/build-ios.ndjson`,
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
        buildIos: async () => ({ failed: true, code: 'STIM_CLI_BUILD_FAILED', durationMs: 90000, diagnostics: [] }),
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
        runPrebuild: async () => ({ failed: true, code: 'STIM_CLI_PREBUILD_FAILED', reason: 'no' }),
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
            code: 'STIM_CLI_BUILD_WAIT_TIMEOUT',
            lockPath: '/home/build-locks/ios-key.lock',
          });
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/STIM_CLI_BUILD_WAIT_TIMEOUT/);
    expect(parseFirst(logs).code).toBe('STIM_CLI_BUILD_WAIT_TIMEOUT');
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
    expect(errs.join('\n')).toMatch(/^  pods {8}.*differ -> installed \(18s\)/m);
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

  test('a failed pod install stops the run with STIM_CLI_DEPS_FAILED', async () => {
    reserve();
    const { errs, exitCode, calls } = await run(
      {},
      {
        readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
        runPodInstall: async () => ({
          failed: true,
          code: 'STIM_CLI_DEPS_FAILED',
          reason: '`pod install` failed (exit code 1).',
          lastLines: ['[!] CocoaPods could not find compatible versions'],
        }),
      },
    );
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/STIM_CLI_DEPS_FAILED/);
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
          code: 'STIM_CLI_BUILD_FAILED',
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
    expect(payload.code).toBe('STIM_CLI_BUILD_FAILED');
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
    expect(text).toMatch(/^  failed {6}STIM_CLI_BUILD_FAILED/m);
  });

  test('--json puts one parseable {code, message, remedy} line on stdout when the gate refuses', async () => {
    const { logs, exitCode } = await run({ json: true });
    expect(exitCode).toBe(1);
    expect(logs.length).toBe(1);
    const payload = parseFirst(logs);
    expect(payload.code).toBe('STIM_CLI_NO_METRO');
    expect(payload.message).toMatch(/no dev server/);
    expect(payload.remedy).toMatch(/stim-cli start/);
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
          code: 'STIM_CLI_BUILD_FAILED',
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
          code: 'STIM_CLI_BUILD_FAILED',
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
    expect(lastBuild.errorCode).toBe('STIM_CLI_BUILD_FAILED');
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
    expect(errs.join('\n')).toMatch(/STIM_CLI_NO_DEVICE/);
  });

  test('a failed install is reported with its own code and a failed record', async () => {
    reserve();
    const { errs, exitCode } = await run(
      {},
      {
        installIosApp: () => ({ failed: true, code: 'STIM_CLI_INSTALL_FAILED', reason: 'simctl install failed' }),
      },
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/STIM_CLI_INSTALL_FAILED/);
    const stateAfterInstall = readWorkspaceState(root);
    assert(stateAfterInstall?.lastBuild);
    expect(stateAfterInstall.lastBuild.errorCode).toBe('STIM_CLI_INSTALL_FAILED');
  });
});

describe('success output', () => {
  test('the phase lines are stderr and the summary is the only line on stdout', async () => {
    reserve();
    const { logs, errs, exitCode } = await run({});
    expect(exitCode).toBe(null);
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/^OK: com\.example\.app on stim-cli-fixture \(BF2A\.\.\), Metro port 8082/);
    const text = errs.join('\n');
    expect(text).toMatch(/^  device {6}stim-cli-fixture \(BF2A\.\.\) booted \(\d+ms\)$/m);
    expect(text).toMatch(/^  fingerprint a3f9b1\.\. miss \(\d+ms\)$/m);
    expect(text).toMatch(/^  build {7}ok \(2m41s\)$/m);
    expect(text).toMatch(/^  install {5}-> stim-cli-fixture \(BF2A\.\.\) \(\d+ms\)$/m);
    expect(text).toMatch(/^  launch {6}com\.example\.app \(\d+ms\)$/m);
  });

  test('--json emits exactly one line of facts on stdout', async () => {
    reserve();
    const { logs, appPath } = await run({ json: true });
    expect(logs.length).toBe(1);
    const facts = parseFirst(logs);
    expect(facts.platform).toBe('ios');
    expect(facts.udid).toBe(UDID);
    expect(facts.deviceName).toBe('stim-cli-fixture');
    expect(facts.fingerprint).toBe(FINGERPRINT);
    expect(facts.cacheKey).toMatch(new RegExp(`^${FINGERPRINT}-debug-sim$`));
    expect(facts.cacheHit).toBe(false);
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

describe('the collector', () => {
  function collectorHarness({
    state = null,
    killImpl = null,
  }: {
    state?: WorkspaceState | null;
    killImpl?: ((pid: number, signal: NodeJS.Signals) => void) | null;
  } = {}) {
    if (state) writeWorkspaceState(root, state);
    const spawns: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[] = [];
    const kills: { pid: number; signal: NodeJS.Signals }[] = [];
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
      waitMs: 0,
    };
    return { spawns, kills, opts };
  }

  test('a previous collector is SIGTERMed and replaced, not duplicated', async () => {
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
    expect(deviceLabel({ deviceName: 'stim-cli-x' }, UDID)).toBe('stim-cli-x (BF2A..)');
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
    const dir = mkdtempSync(join(tmpdir(), 'stim-cli-scheme-'));
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
        deviceName: 'stim-cli-x',
        fingerprint: 'abc',
        cacheKey: 'abc-debug-sim',
        cacheHit: 'local',
        appPath: '/a/b.app',
        bundleId: 'com.x',
        metroPort: 8082,
        logsDir: '/w/.stim-cli/logs',
        durationMs: 1234,
      }),
    ).toEqual({
      platform: 'ios',
      udid: UDID,
      deviceName: 'stim-cli-x',
      fingerprint: 'abc',
      configuration: null,
      cacheKey: 'abc-debug-sim',
      cacheHit: 'local',
      cacheSkipped: false,
      waitedForBuild: null,
      appPath: '/a/b.app',
      bundleId: 'com.x',
      launched: true,
      metroPort: 8082,
      logs: { dir: '/w/.stim-cli/logs' },
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
        code: 'STIM_CLI_BUILD_FAILED',
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

  test('maxDevices at capacity refuses with STIM_CLI_AT_CAPACITY, before ensuring a device', async () => {
    reserve();
    const capacity: { args?: CheckDeviceCapacityArgs } = {};
    const { errs, exitCode, calls } = await run(
      {},
      {
        getConcurrencyLimits: () => ({ maxBuilds: 0, maxDevices: 2 }),
        checkDeviceCapacity: (args) => {
          capacity.args = args;
          return {
            code: 'STIM_CLI_AT_CAPACITY',
            message: 'at capacity',
            remedy: 'stop an environment (stim-cli stop) or raise concurrency.maxDevices',
          };
        },
      },
    );
    expect(exitCode).toBe(1);
    assert(capacity.args);
    expect(capacity.args.max).toBe(2);
    expect(errs.join('\n')).toMatch(/STIM_CLI_AT_CAPACITY/);
    expect(errs.join('\n')).toMatch(/stim-cli stop/);
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
    expect(remote.hits.includes('ensureOwnedDevice')).toBeTruthy();
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
    expect(stderr).toContain('STIM_CLI_BAD_ARG');
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
    expect(errs.join('\n')).not.toMatch(/STIM_CLI_NO_METRO/);
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

  test('a dead app process is launched: "unverified", with the device-log pointer', async () => {
    const { logs, errs } = await run(
      { configuration: 'Release', json: true },
      {
        verifyReleaseLaunch: async () => ({ verified: false, reason: 'exited', waitedMs: 3000 }),
      },
    );
    expect(parseFirst(logs).launched).toBe('unverified');
    expect(errs.join('\n')).toMatch(/process exited within/);
    expect(errs.join('\n')).toMatch(/stim-cli logs --errors/);
  });

  test('the ios.configuration setting is the repo default, and the flag overrides it back to Debug', async () => {
    const settings = { ios: { configuration: 'Release' } };
    const first = await run({}, { resolveSettings: () => settings });
    expect(!first.calls.order.includes('resolveProjectMetro')).toBeTruthy();
    expect(first.calls.args.launchIosApp.metroPort).toBe(null);
    const second = await run({ configuration: 'Debug' }, { resolveSettings: () => settings });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(/STIM_CLI_NO_METRO/);
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
            logFile: '/w/other/.stim-cli/logs/build-ios.ndjson',
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
