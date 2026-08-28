// `rn-iso ios`.
//
// The engine modules are tested elsewhere (engine-xcode, engine-deps,
// engine-prebuild, engine-app-install, build-cache). What is pinned HERE is
// the thing only the command can get wrong: the ORDER of the steps, and what
// reaches the two output streams.
//
// The order is the product:
//   - the Metro gate fires BEFORE fingerprinting and before any build work,
//     so "no dev server" costs a second rather than four minutes;
//   - a cache hit skips prebuild, pods and xcodebuild ENTIRELY -- that is the
//     whole reason a second worktree is fast;
//   - the collector is REPLACED, never duplicated, and the state file is
//     MERGED, never overwritten, so `stop` can still find the supervisor.
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
  ensureWorkspaceIgnoredSafely,
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

// The seam registerIos accepts: Partial<typeof DEFAULT_DEPS>. Deriving it from
// the exported function lets every override object be contextually typed
// without DEFAULT_DEPS itself being exported.
type IosDeps = NonNullable<Parameters<typeof registerIos>[1]>;

// The mocks intentionally return partial shapes (the command reads only the
// fields it needs), so the seam's real RETURN types must not be enforced. This
// keeps each mock's parameter types (from the real signature, so a callback
// like `(platform, key, path)` is typed) while leaving returns free.
type LooseDeps = {
  [K in keyof Required<IosDeps>]?: Required<IosDeps>[K] extends (...args: infer A) => unknown
    ? (...args: A) => unknown
    : Required<IosDeps>[K];
};

// The replaceCollector seam, derived from the exported function so its spawn/
// kill callbacks are typed without ReplaceCollectorArgs being exported.
type ReplaceCollectorArgs = Parameters<typeof replaceCollector>[0];

// Argument shapes for the seams the tests below record, derived the same way.
type CheckEasAuthArgs = Parameters<NonNullable<IosDeps['checkEasAuth']>>[0];
type CheckDeviceCapacityArgs = Parameters<NonNullable<IosDeps['checkDeviceCapacity']>>[0];
type AcquireBuildSlotArgs = Parameters<NonNullable<IosDeps['acquireBuildSlot']>>[0];

let tmpHome: string;
let root: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  // realpath: every path rn-iso records is canonical, and on macOS /var is a
  // symlink to /private/var.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

// The same commander stub the other command tests use. `register` is the real
// registerIos, but the stub is a partial commander mock; typing register as its
// exact signature would demand a full Command here, so it stays loose.
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
  // The stub is a partial commander mock and deps are partial engine seams;
  // registerIos wants a full Command and full deps, so cast at this one seam.
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

// Every engine call is a seam. The defaults describe the happy path with a
// cache MISS; each test overrides the one fact it is about.
// The first NDJSON payload a --json command put on stdout, parsed. Asserts it
// is present (noUncheckedIndexedAccess) then parses; the parsed value stays
// JSON.parse-shaped, read one field at a time by the caller.
function parseFirst(lines: string[]) {
  const [first] = lines;
  assert(first);
  return JSON.parse(first);
}

// The seam arguments each recorded call carries. Every field the assertions
// read is modelled as `unknown` (compared one at a time); the index signature
// keeps the recorder's `args[name] = value` write untyped.
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
  ensureWorkspaceIgnored: unknown;
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
      return { deviceUdid: UDID, deviceName: 'rn-iso-fixture', owned: true };
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
    // Issue #60's miss diagnostic shells out to git; the default is a project
    // with nothing untracked, so only the tests that are about it pay for it.
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
    // Level two. The default is the ordinary case: a project with no provider
    // configured, which asks nothing and calls nothing.
    loadProjectProvider: async (projectRoot, opts) => {
      record('loadProjectProvider', { projectRoot, ...opts });
      return { none: true };
    },
    // Never the real one: it shells out to `eas whoami`, which is a network
    // call. The EAS-session tests below override it with the state they are about.
    checkEasAuth: (args) => {
      record('checkEasAuth', args);
      return { ok: true, account: 'janic' };
    },
    resolveRemote: async (args) => {
      record('resolveRemote', args);
      return null;
    },
    // Single flight. The default is the ordinary case: nothing else on this
    // machine is building this fingerprint, so the lock is free and this run
    // is the one builder.
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
    // podsAreStale is deliberately NOT stubbed: it is the real pure decision,
    // fed by readPodState above, so these tests exercise the composition the
    // command actually ships.
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
    // The gate's retry is REAL here (it is the thing under test in one case
    // below); only its sleep is removed, so a refusal costs no wall time.
    resolveMetroWithRetry: (resolve, port, path, opts) =>
      resolveMetroWithRetry(resolve, port, path, { ...opts, sleep: async () => {} }),
    // The default is a launch that verified: the app fetched a bundle from
    // this workspace's Metro. The unverified path has its own tests.
    verifyLaunch: async (args) => {
      record('verifyLaunch', args);
      return { verified: true, waitedMs: 2500, record: { event: 'bundle_build_started' } };
    },
    // Release-only seams; a Debug run must never reach either.
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
    ensureWorkspaceIgnored: async (dir) => {
      record('ensureWorkspaceIgnored', dir);
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

// --- the order ------------------------------------------------------------

describe('the Metro gate', () => {
  // The gate sits between ensureOwnedDevice (whose record the rest of the
  // command reads) and ensureBooted (the first expensive step). So a dead port
  // costs the device RECORD, and not the ~10s boot poll behind it.
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
    expect(errs.join('\n')).toMatch(/RN_ISO_NO_METRO/);
    expect(errs.join('\n')).toMatch(/rn-iso start/);
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
    expect(errs.join('\n')).toMatch(/RN_ISO_NO_METRO/);
  });

  test('no reservation at all is the same failure', async () => {
    const { errs, exitCode } = await run({});
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/RN_ISO_NO_METRO/);
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

// The start -> ios race, seen on a yarn-workspaces monorepo: `start` returns
// when the server is LISTENING, and the bare in-process Metro then blocks its
// event loop for ~20s crawling the file map. The single 2s /status probe timed
// out inside that window and the gate refused with "run rn-iso start first" --
// about a supervisor `start` had just spawned.
describe('the Metro gate retries an indexing Metro', () => {
  test('a port that verifies on the third attempt is not refused', async () => {
    reserve();
    let attempts = 0;
    const { exitCode, calls } = await run(
      {},
      {
        resolveProjectMetro: async () => {
          attempts += 1;
          // Listening, event loop blocked by the file-map crawl.
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
    // And the remedy is the one that helps: wait, do not start a second one.
    expect(text).toMatch(/rn-iso start --wait/);
    expect(text).not.toMatch(/Run `rn-iso start` first/);
  });

  test('with no supervisor record the refusal is the plain one', async () => {
    reserve();
    const { errs } = await run({}, { resolveProjectMetro: async () => ({ missing: true }) });
    const text = errs.join('\n');
    expect(text).toMatch(/Nothing is serving this workspace's dev server on port 8082/);
    expect(text).toMatch(/Run `rn-iso start` first/);
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

// The launch is not the proof. rn-iso reported launched: true while the app
// sat on expo-dev-launcher's DEVELOPMENT SERVERS picker listing every other
// workspace's Metro -- one tap from loading another project's bundle onto
// this device.
describe('launch verification', () => {
  test('a verified launch reports launched: true and says what it saw', async () => {
    reserve();
    const { logs, errs, exitCode, calls } = await run({ json: true });
    expect(exitCode).toBe(null);
    expect(parseFirst(logs).launched).toBe(true);
    expect(errs.join('\n')).toMatch(/verify.*bundle requested from Metro port 8082/);
    // It polls THIS workspace's timeline, from the launch onwards.
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
    // Exit 0: the app IS launched, and refusing here would break every slow
    // launch. What changes is the FACT, which is what an agent branches on.
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

    // And the verified case says so at info.
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

describe('the workspace directory is gitignored before anything is written into it', () => {
  test('ensureWorkspaceIgnored runs before the device, the gate or the build log', async () => {
    reserve();
    const { calls } = await run({});
    expect(calls.args.ensureWorkspaceIgnored).toBe(root);
    expect(calls.order[0]).toBe('ensureWorkspaceIgnored');
  });

  test('the default seam tolerates a module that is missing or a file it cannot write', async () => {
    // It is one line of repo hygiene: a build must not fail over it, and the
    // wrapper is what guarantees that whether engine/workspace.js is there or
    // not.
    const notes = [];
    const result = await ensureWorkspaceIgnoredSafely('/definitely/not/a/checkout', { note: (l) => notes.push(l) });
    expect(result === null || typeof result === 'object').toBeTruthy();
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
      // The second fingerprint is issue #59: prebuild and pod install rewrite
      // fingerprinted inputs, so what the artifact is STORED under is computed
      // after them, never before.
      'fingerprintProject',
      'buildIos',
      'storeBuild',
      'installIosApp',
      'launchIosApp',
    ]);
    expect(calls.args.storeBuild.path).toBe(appPath);
    expect(calls.args.storeBuild.platform).toBe('ios');
  });

  test('an unresolvable fingerprint is RN_ISO_NO_FINGERPRINT, never an unkeyed build', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({}, { fingerprintProject: async () => null });
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/RN_ISO_NO_FINGERPRINT/);
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

  // The whole reason to opt out is a cache entry you no longer trust. Keeping
  // the old entry would mean the very next run trusts it again.
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

// --- level two: the project's own build cache provider --------------------
//
// rn-iso's local cache is level one. The project's OWN configured provider --
// `"buildCacheProvider": "eas"`, or a module of its own -- is level two, and a
// hit there is copied into level one on the way past so the NEXT worktree does
// not pay for it either. The engine module is tested in
// engine-remote-cache.test.js; what is pinned here is that the command asks in
// the right order, and that nothing a provider does can fail or stall the run.
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
    expect(errs.join('\n')).toMatch(/^cache {7}remote hit \(eas\) -> stored locally \(\d+m?\d*s\)$/m);
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
    expect(errs.join('\n')).toMatch(/^cache {7}uploaded \(eas\)$/m);
  });

  // Containment is the product here: a provider is someone else's network call
  // running inside an agent's dev loop.
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
      // The exit is scheduled behind a stdout flush.
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

  // The EAS provider is the one that cannot report its own failures:
  // eas-build-cache-provider catches every error from `npx eas-cli` and returns
  // null, so a logged-out machine gets a clean MISS on every build and no line
  // anywhere says why. The pre-flight is what turns that into one line.
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

  // Offline is not logged out. whoami reaches the network whenever a session
  // exists, so an unknown answer has to leave the run exactly as it was.
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

  // The other half: when a provider DOES surface an error, an auth one gets the
  // same specific note rather than the generic "could not be used".
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

// --- single-flight builds -------------------------------------------------
//
// Level one misses, level two missed or is not there, and the run is about to
// spend nineteen minutes in xcodebuild. If another workspace on this machine
// is ALREADY spending them on the same fingerprint, the answer is to wait for
// its artifact, not to compile the same thing beside it. What is pinned here
// is the wiring: WHEN the lock is attempted, that a loser never builds, that a
// winner always releases, and that --no-build-cache is outside all of it.
describe('single-flight builds', () => {
  const heldBy = (pid = 41233, projectRoot = '/w/app-999') => ({
    held: {
      pid,
      projectRoot,
      startedAt: '2026-08-25T10:00:00.000Z',
      logFile: `${projectRoot}/.rn-iso/logs/build-ios.ndjson`,
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

  // A remote hit is an artifact in hand. Queueing behind someone else's
  // compile of the same fingerprint would be slower than what we already have.
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

  // --no-build-cache means "compile this yourself, now". Waiting for another
  // workspace's artifact is exactly what it was passed to avoid -- and taking
  // the lock would make every other workspace wait on a build whose result
  // they were not asking for.
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

  // The builder died, or its build failed and it released without storing.
  // Waiting longer would be waiting for nothing, so this run becomes the
  // builder -- and takes the lock, so a third workspace waits on IT.
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

  // Losing the takeover race too means a third workspace is now building. One
  // wait is a good bet; queueing again after a failure could repeat forever,
  // so this run just builds. A redundant build is the cheap failure here.
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

  // The rule that keeps a machine from deadlocking: whatever happens to the
  // build, the lock goes. A failed build that kept it would leave every other
  // workspace on the fingerprint waiting for an artifact nobody is making.
  test('a FAILED build releases the lock', async () => {
    reserve();
    const { exitCode, calls } = await run(
      {},
      {
        buildIos: async () => ({ failed: true, code: 'RN_ISO_BUILD_FAILED', durationMs: 90000, diagnostics: [] }),
      },
    );
    expect(exitCode).toBe(1);
    expect(calls.order.includes('releaseBuildLock')).toBeTruthy();
  });

  // An exception is not a failure the command formats -- it propagates -- so
  // `fail` never sees it and only the `finally` can free the waiters.
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
        runPrebuild: async () => ({ failed: true, code: 'RN_ISO_PREBUILD_FAILED', reason: 'no' }),
      },
    );
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(calls.order.includes('releaseBuildLock')).toBeTruthy();
  });

  // A wedged builder is the one thing pid-liveness cannot see, so the wait has
  // a ceiling. It surfaces as an ordinary refusal with a code, not a stack.
  test('a wait that hits its ceiling is a refusal with a code, not a crash', async () => {
    reserve();
    const { exitCode, errs, logs, calls } = await run(
      { json: true },
      {
        acquireBuildLock: () => heldBy(),
        waitForBuild: async () => {
          throw makeError('Waited 90m ... The lock is /home/build-locks/ios-key.lock', {
            code: 'RN_ISO_BUILD_WAIT_TIMEOUT',
            lockPath: '/home/build-locks/ios-key.lock',
          });
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/RN_ISO_BUILD_WAIT_TIMEOUT/);
    expect(parseFirst(logs).code).toBe('RN_ISO_BUILD_WAIT_TIMEOUT');
  });

  // Same containment rule the cache store and the provider follow: this is an
  // optimisation, and an optimisation that cannot run must not stop a build.
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
    expect(errs.join('\n')).toMatch(/^pods {8}.*differ -> installed \(18s\)/m);
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

  test('a failed pod install stops the run with RN_ISO_DEPS_FAILED', async () => {
    reserve();
    const { errs, exitCode, calls } = await run(
      {},
      {
        readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
        runPodInstall: async () => ({
          failed: true,
          code: 'RN_ISO_DEPS_FAILED',
          reason: '`pod install` failed (exit code 1).',
          lastLines: ['[!] CocoaPods could not find compatible versions'],
        }),
      },
    );
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/RN_ISO_DEPS_FAILED/);
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
          code: 'RN_ISO_BUILD_FAILED',
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
    // --json is a contract about stdout in BOTH directions: exactly one
    // parseable line, whether the run succeeded or failed. A caller capturing
    // it with `$(...)` and parsing the result got an empty string here, which
    // is the one answer a JSON parser cannot act on.
    expect(logs.length).toBe(1);
    // The shape is `android`'s, and BOTH fields are populated: a payload
    // carrying only a code made `ios --json` the one command whose failure a
    // caller could not report without also parsing stderr prose.
    const payload = parseFirst(logs);
    expect(payload.code).toBe('RN_ISO_BUILD_FAILED');
    expect(payload.message).toMatch(/xcodebuild` failed/);
    expect(payload.message).toMatch(/exit code 65/);
    expect(payload.remedy).toBeTruthy();
    expect(payload.remedy).toMatch(/pod install/);
    const text = errs.join('\n');
    expect(text).toMatch(/^build {7}FAILED after 2m41s/m);
    expect(text).toMatch(/AppDelegate\.mm:12:4: use of undeclared identifier 'foo'/);
    expect(text).toMatch(/The sandbox is not in sync/);
    expect(text).toMatch(/and 3 more diagnostics in the log/);
    expect(text).toMatch(new RegExp(`^log {9}${buildLogFile(root).replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'm'));
    expect(text).toMatch(/^failed {6}RN_ISO_BUILD_FAILED/m);
  });

  // The same contract every other --json failure has, on the step an agent hits
  // most often. `ios` printed NOTHING on stdout here, so a caller could not
  // tell a failed build from a crashed CLI without reading stderr prose.
  test('--json puts one parseable {code, message, remedy} line on stdout when the gate refuses', async () => {
    const { logs, exitCode } = await run({ json: true });
    expect(exitCode).toBe(1);
    expect(logs.length).toBe(1);
    const payload = parseFirst(logs);
    expect(payload.code).toBe('RN_ISO_NO_METRO');
    expect(payload.message).toMatch(/no dev server/);
    expect(payload.remedy).toMatch(/rn-iso start/);
  });

  // Without --json stdout stays untouched: the human path prints its diagnosis
  // on stderr and nothing captures stdout.
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
          code: 'RN_ISO_BUILD_FAILED',
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
          code: 'RN_ISO_BUILD_FAILED',
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
    expect(lastBuild.errorCode).toBe('RN_ISO_BUILD_FAILED');
    expect(lastBuild.platform).toBe('ios');
    expect(lastBuild.fingerprint).toBe(FINGERPRINT);
    expect(lastBuild.cacheHit).toBe(false);
    expect(lastBuild.startedAt).toBeTruthy();
  });

  test('a device that will not boot is refused at install, after the build has been stored', async () => {
    // Boot runs BESIDE the fingerprint/cache/build work, not ahead of it: a
    // cold boot used to add its whole duration in front of a multi-minute
    // compile, and install is the first step that needs a live device. The
    // trade on this rare failure is deliberate -- the build that ran anyway
    // went into the shared cache, so the retry after fixing the device
    // installs it instead of compiling again.
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
    expect(errs.join('\n')).toMatch(/RN_ISO_NO_DEVICE/);
  });

  test('a failed install is reported with its own code and a failed record', async () => {
    reserve();
    const { errs, exitCode } = await run(
      {},
      {
        installIosApp: () => ({ failed: true, code: 'RN_ISO_INSTALL_FAILED', reason: 'simctl install failed' }),
      },
    );
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/RN_ISO_INSTALL_FAILED/);
    const stateAfterInstall = readWorkspaceState(root);
    assert(stateAfterInstall?.lastBuild);
    expect(stateAfterInstall.lastBuild.errorCode).toBe('RN_ISO_INSTALL_FAILED');
  });
});

describe('success output', () => {
  test('the phase lines are stderr and the summary is the only line on stdout', async () => {
    reserve();
    const { logs, errs, exitCode } = await run({});
    expect(exitCode).toBe(null);
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/^OK: com\.example\.app on rn-iso-fixture \(BF2A\.\.\), Metro port 8082/);
    const text = errs.join('\n');
    // Every phase line carries its own duration, in formatDuration's shape.
    expect(text).toMatch(/^device {6}rn-iso-fixture \(BF2A\.\.\) booted \(\d+m?\d*s\)$/m);
    expect(text).toMatch(/^fingerprint a3f9b1\.\. miss \(\d+m?\d*s\)$/m);
    expect(text).toMatch(/^build {7}ok \(2m41s\)$/m);
    expect(text).toMatch(/^install {5}-> rn-iso-fixture \(BF2A\.\.\) \(\d+m?\d*s\)$/m);
    expect(text).toMatch(/^launch {6}com\.example\.app \(\d+m?\d*s\)$/m);
  });

  test('--json emits exactly one line of facts on stdout', async () => {
    reserve();
    const { logs, appPath } = await run({ json: true });
    expect(logs.length).toBe(1);
    const facts = parseFirst(logs);
    expect(facts.platform).toBe('ios');
    expect(facts.udid).toBe(UDID);
    expect(facts.deviceName).toBe('rn-iso-fixture');
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

// --- Contract 5 -----------------------------------------------------------

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
      spawn: (cmd, args, opts) => {
        spawns.push({ cmd, args, opts });
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

// --- pure helpers ---------------------------------------------------------

describe('formatting', () => {
  test('durations read the way a build feels', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(18000)).toBe('18s');
    expect(formatDuration(59400)).toBe('59s');
    expect(formatDuration(161000)).toBe('2m41s');
    expect(formatDuration(119600)).toBe('2m0s');
    expect(formatDuration(undefined)).toBe('0s');
  });

  test('the short forms are recognizably abbreviations', () => {
    expect(shortHash('a3f9b1c2d3')).toBe('a3f9b1..');
    expect(shortHash('abc')).toBe('abc');
    expect(shortUdid(UDID)).toBe('BF2A..');
    expect(deviceLabel({ deviceName: 'rn-iso-x' }, UDID)).toBe('rn-iso-x (BF2A..)');
    expect(deviceLabel(null, UDID)).toBe('BF2A..');
  });

  test('every phase line starts its text at the same column', () => {
    expect(phaseLine('device', 'x')).toBe('device      x');
    expect(phaseLine('fingerprint', 'x')).toBe('fingerprint x');
    expect(phaseLine('build', 'x')).toBe('build       x');
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
    const dir = mkdtempSync(join(tmpdir(), 'rn-iso-scheme-'));
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

  // The BUILT app is the truth. app.json alone was the source, and a project
  // with a dynamic config (app.config.ts) has no scheme there at all -- so the
  // deep link was skipped and the app opened the dev-launcher's server picker.
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
      // Verbatim from a real app's Info.plist. Expo's rule (longest wins)
      // picks the Google one; `fb...` is also declared by the Facebook app, so
      // which app iOS opens depends on what else is installed.
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
        deviceName: 'rn-iso-x',
        fingerprint: 'abc',
        cacheKey: 'abc-debug-sim',
        cacheHit: 'local',
        appPath: '/a/b.app',
        bundleId: 'com.x',
        metroPort: 8082,
        logsDir: '/w/.rn-iso/logs',
        durationMs: 1234,
      }),
    ).toEqual({
      platform: 'ios',
      udid: UDID,
      deviceName: 'rn-iso-x',
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
      logs: { dir: '/w/.rn-iso/logs' },
      durationMs: 1234,
    });
  });

  // A wait is reported ALONGSIDE cacheHit: 'local', never instead of it. The
  // artifact really did come from the local cache; what this adds is that it
  // was not there when the run started, and what it cost to get it.
  test('waitedForBuild names the builder waited on and what the wait cost', () => {
    const facts = iosFacts({ udid: UDID, cacheHit: 'local', waitedForBuild: { pid: 41233, ms: 761000 } });
    expect(facts.cacheHit).toBe('local');
    expect(facts.waitedForBuild).toEqual({ pid: 41233, ms: 761000 });
  });

  // The enum is the point: an agent that reads `true` cannot tell a free
  // install from one that cost a download, and those are not the same thing to
  // plan around. Anything that is not a level rendered as `false`.
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

// The fingerprint is scoped to iOS, so a change under android/ cannot move the
// iOS cache key. See the field note above fingerprintProject in
// src/build-cache.js for why this is not cosmetic.
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

// The generic half of the same contract: nothing recognizable in the
// transcript still has to produce a sentence and a next step, because the
// `--json` payload is all an unattended caller sees.
test('--json says so when a build failed with no recognizable diagnostic', async () => {
  reserve();
  const { logs, exitCode } = await run(
    { json: true },
    {
      buildIos: async () => ({
        failed: true,
        code: 'RN_ISO_BUILD_FAILED',
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

// --- opt-in concurrency (unlimited by default) ---
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

  test('maxDevices at capacity refuses with RN_ISO_AT_CAPACITY, before ensuring a device', async () => {
    reserve();
    const capacity: { args?: CheckDeviceCapacityArgs } = {};
    const { errs, exitCode, calls } = await run(
      {},
      {
        getConcurrencyLimits: () => ({ maxBuilds: 0, maxDevices: 2 }),
        checkDeviceCapacity: (args) => {
          capacity.args = args;
          return {
            code: 'RN_ISO_AT_CAPACITY',
            message: 'at capacity',
            remedy: 'stop an environment (rn-iso stop) or raise concurrency.maxDevices',
          };
        },
      },
    );
    expect(exitCode).toBe(1);
    assert(capacity.args);
    expect(capacity.args.max).toBe(2);
    expect(errs.join('\n')).toMatch(/RN_ISO_AT_CAPACITY/);
    expect(errs.join('\n')).toMatch(/rn-iso stop/);
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
    // Slot comes after the single-flight lock, before the compile, and is
    // released with the lock once the artifact is stored.
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

// --- the remote device ------------------------------------------------------
//
// `--remote` swaps FOUR entries in the dep seam and nothing else. These tests
// are about that boundary: which implementation each phase reached for, and
// that the local path is untouched when the flag is absent.
describe('--remote', () => {
  test('the CLI parser accepts only an explicit proxy or eas backend', () => {
    expect(parseRemoteOption(['--remote', 'proxy'])).toBe('proxy');
    expect(parseRemoteOption(['--remote', 'eas'])).toBe('eas');
    expect(() => parseRemoteOption(['--remote'])).toThrow(/argument missing/i);
    expect(() => parseRemoteOption(['--remote', 'cloud'])).toThrow(/proxy.*eas/i);
  });

  // A stand-in for engine/device-remote's return value. Records which device
  // calls went through the remote implementation rather than the local one.
  function remoteStub() {
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
        // The reach step runs between the Metro gate and the boot; these
        // tests are about the device phases, not about tunnels.
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
          createdSessionId: () => 'drs_42',
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
    // The local implementations were never reached for those phases.
    expect(calls.order.includes('ensureOwnedDevice')).toBeFalsy();
    expect(calls.order.includes('installIosApp')).toBeFalsy();
  });

  test('the build still happens locally -- only the device moved', async () => {
    const remote = remoteStub();
    reserve();
    const { calls } = await run({ remote: 'eas' }, remote.deps);
    // The whole premise of remote mode: the fingerprint, the cache and the
    // build are untouched, because none of them care where the device is.
    expect(calls.order.includes('fingerprintProject')).toBeTruthy();
    expect(calls.order.includes('resolveBuild')).toBeTruthy();
    expect(calls.order.includes('buildIos')).toBeTruthy();
  });

  test('the Metro gate still runs BEFORE the session is created', async () => {
    // Remote inverts which device step is expensive: creating a billable
    // cloud session happens in ensureBooted, so a dead port must still refuse
    // before it. Same ordering property as local, opposite mechanics.
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
    expect(stderr).toContain('RN_ISO_BAD_ARG');
    expect(stderr).toContain('Invalid ios.remote setting');
  });

  test('the reach step gets the RESERVED port, and runs after the Metro gate', async () => {
    // The bug this pins: resolving reach with the dep overrides meant no port
    // was passed, so it defaulted to 8081 -- a managed tunnel got built to
    // whatever was on 8081, routinely a DIFFERENT workspace's Metro, which is
    // the exact failure the gate exists to prevent.
    const remote = remoteStub();
    // A port that is deliberately NOT 8081, so defaulting is visible.
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
    // And the local gate answers "is there a dev server at all" first, so an
    // absent one reports RN_ISO_NO_METRO rather than "serving a different
    // dev server".
    expect(order).toEqual(['metroGate', 'reach']);
  });

  test('a remote build targets the simulator platform, not a udid', async () => {
    // Live-verified failure this pins: `id=<session-id>` makes xcodebuild exit
    // 70 with "Unable to find a device matching the provided destination
    // specifier", because a remote device is not on this machine.
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

// --- a diagnosed MISS: what changed since this workspace's previous build ---
//
// The fingerprint line alone says only "the hash moved". When the previous
// build's cache entry stored its sources (fingerprint-sources.json, written by
// storeBuild), a miss can NAME the inputs that moved: up to three on the phase
// line, the capped full list in the build log as a fingerprint_diff record.
test('a miss with a prior stored entry appends the changed-sources suffix and logs fingerprint_diff', async () => {
  reserve();
  // The previous build (Contract 4), pointing at an entry in the shared cache.
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

  const line = errs.find((e) => e.startsWith('fingerprint'));
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
  const line = errs.find((e) => e.startsWith('fingerprint'));
  assert(line);
  expect(line).toMatch(/miss \(\d+m?\d*s\)$/);
  expect(buildRecords().some((r) => r.event === 'fingerprint_diff')).toBe(false);
});

// --- release builds (--configuration, issue #57 phase 1) --------------------
//
// A non-Debug configuration is a different product: the JS is embedded by the
// xcodebuild phase, so Metro is not part of the run at all -- and a
// native-keyed cache hit is an app carrying its BUILDER's JS, which is why
// the hit path swaps a fresh bundle in rather than installing the artifact
// as-is. What is pinned here is the command's side of that: the gate that
// does not run, the key that differs, the swap-then-install order, and the
// fallback that never installs stale JS.

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
    // Deliberately NO reserve(): a release run must not care.
    const { exitCode, calls, errs } = await run({ configuration: 'Release' });
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('resolveProjectMetro')).toBeTruthy();
    expect(errs.join('\n')).not.toMatch(/RN_ISO_NO_METRO/);
    expect(errs.join('\n')).toMatch(/skipped \(Release: the JS bundle is embedded/);
    // A plain simctl launch: no port, no dev-client deep link.
    expect(calls.args.launchIosApp.metroPort).toBe(null);
    expect(calls.args.launchIosApp.devClientScheme).toBeUndefined();
    // Verification is process-alive, not bundle-fetch.
    expect(!calls.order.includes('verifyLaunch')).toBeTruthy();
    expect(calls.order.includes('verifyReleaseLaunch')).toBeTruthy();
    // The collector still attaches, so `logs --errors` works in release.
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
    expect(errs.join('\n')).toMatch(/rn-iso logs --errors/);
  });

  test('the ios.configuration setting is the repo default, and the flag overrides it back to Debug', async () => {
    // Setting alone: release-shaped.
    const settings = { ios: { configuration: 'Release' } };
    const first = await run({}, { resolveSettings: () => settings });
    expect(!first.calls.order.includes('resolveProjectMetro')).toBeTruthy();
    expect(first.calls.args.launchIosApp.metroPort).toBe(null);
    // Flag Debug beats the setting: the ordinary gated flow, which refuses
    // here because nothing is reserved.
    const second = await run({ configuration: 'Debug' }, { resolveSettings: () => settings });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(/RN_ISO_NO_METRO/);
  });
});

describe('the release cache key and the JS swap', () => {
  test('the key differs from debug: -release-sim vs -debug-sim', async () => {
    reserve();
    const debugRun = await run({});
    expect(debugRun.calls.args.resolveBuild.key).toBe(`${FINGERPRINT}-debug-sim`);
    const releaseRun = await run({ configuration: 'Release' });
    expect(releaseRun.calls.args.resolveBuild.key).toBe(`${FINGERPRINT}-release-sim`);
    // And the fresh release artifact stores under it, exactly like Debug ones.
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
    // Order: resolve the cache, swap, then install -- never a build.
    const order = calls.order;
    expect(order.indexOf('swapJsBundle')).toBeGreaterThan(order.indexOf('resolveBuild'));
    expect(order.indexOf('installIosApp')).toBeGreaterThan(order.indexOf('swapJsBundle'));
    expect(!order.includes('buildIos')).toBeTruthy();
    expect(!order.includes('runPodInstall')).toBeTruthy();
    // The swap starts from the cached artifact and the INSTALL gets the
    // re-signed temp copy, never the cache entry itself.
    expect(calls.args.swapJsBundle.cachedAppPath).toBe(cached);
    expect(calls.args.installIosApp.appPath).toBe(join(root, 'js-swap', 'Fixture.app'));
    // The bundle id is read from the copy that will be installed.
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
    // The fallback compiled, stored, and installed ITS artifact.
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(calls.args.installIosApp.appPath).toBe(appPath);
    // The payload reports what actually happened: not a cache hit.
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
    // A person cannot see a device in a datacenter. This is the handle a
    // caller gives them.
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
    // An always-present key invites a caller to print an empty link.
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
// --- issue #59: the artifact is stored under the POST-mutation key ----------
//
// `expo prebuild` generates ios/ and rewrites package.json's scripts and the
// app config; `pod install` writes ios/Podfile.lock. All of them are
// fingerprint SOURCES, so the hash a cold run looked up is not the hash its
// tree has by the time there is an artifact. Storing under the lookup key
// produced an entry no later run in that tree could ever hit -- field-measured
// as 104 MB of cache nothing would ever look up.
describe('re-fingerprint after the steps that rewrite fingerprinted files', () => {
  const COLD = 'aaaaaa1111';
  const WARM = 'bbbbbb2222';

  // Two hashes, in the order the run computes them: the cold tree's, then the
  // one the same tree has once prebuild and pod install have run.
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
    // The FIRST lookup was the cold hash (the second is the post-shift one
    // below); the store is the warm one.
    expect(lookedUp[0]).toMatch(new RegExp(`^${COLD}`));
    expect(String(storedKey)).toMatch(new RegExp(`^${WARM}`));

    // The next run in this tree: prebuild is done, pods are current, so it
    // computes the warm hash and looks THAT up. Same key, so it is a hit.
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
    const shift = errs.find((line) => /^fingerprint\s+\S+ -> /.test(line));
    assert(shift, 'expected a fingerprint shift line on stderr');
    expect(shift).toMatch(/aaaaaa\.\. -> bbbbbb\.\./);
    expect(shift).toMatch(/prebuild \+ pod install/);

    const facts = parseFirst(logs);
    expect(facts.fingerprint).toBe(WARM);
    expect(facts.cacheKey).toBe(calls.args.storeBuild.key);

    // Contract 4 records the same thing, because the next run's miss diff
    // reads the entry by that key.
    const state = readWorkspaceState(root) as WorkspaceState;
    expect((state.lastBuild as Record<string, unknown>).fingerprint).toBe(WARM);
    expect((state.lastBuild as Record<string, unknown>).cacheKey).toBe(calls.args.storeBuild.key);
  });

  // The point of the whole feature: a fresh worktree or clone of a CNG app is
  // COLD, so its first lookup uses a hash that predates ios/. The entry another
  // workspace stored is keyed on the hash this run only learns after prebuild
  // -- and asking again is the difference between an install and a full
  // xcodebuild.
  test('a post-shift hit installs the cached app and compiles nothing', async () => {
    reserve();
    const cachedApp = join(tmpHome, 'build-cache', 'ios', `${WARM}-debug-sim`, 'Fixture.app');
    const { logs, errs, calls } = await run(
      { json: true },
      {
        detectIsExpo: () => true,
        needsPrebuild: () => true,
        fingerprintProject: shifting(),
        // Cold key: nothing. Post-shift key: the entry a warm tree left.
        resolveBuild: (_platform, key) => (key.startsWith(WARM) ? cachedApp : null),
      },
    );
    // prebuild still runs -- it is what produces the tree the new hash
    // describes -- but nothing after it does.
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

  // Release is not a special case: the post-shift hit goes through the SAME
  // step a first-pass hit does, so the cached app's JS is replaced with this
  // tree's before it is installed.
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
    // The SWAPPED copy is what reaches the device, never the cache entry.
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
    expect(errs.some((line) => /^fingerprint\s+\S+ -> /.test(line))).toBe(false);
    expect(calls.args.storeBuild.key).toBe(calls.args.resolveBuild.key);
    // And NO second lookup: there is no new key to ask about.
    expect(calls.order.filter((c) => c === 'resolveBuild').length).toBe(1);
  });

  test('a warm tree runs no mutating step, so the fingerprint is computed exactly once', async () => {
    reserve();
    const { calls } = await run();
    expect(calls.order.filter((c) => c === 'fingerprintProject').length).toBe(1);
  });
});

// --- issue #60: a miss with no prior entry names the untracked native files -
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

// --- issue #53: a bundle that is still building is its own state ------------
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
    // The alert/picker list is for a launch that did NOT work. Printing it
    // over one that demonstrably did is what sent an agent chasing a fault.
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

// --- issue #54: a takeover after a builder that FAILED ----------------------
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
            logFile: '/w/other/.rn-iso/logs/build-ios.ndjson',
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
