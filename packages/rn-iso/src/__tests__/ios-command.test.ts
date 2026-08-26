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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertProject } from '../config.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { workspaceLogsDir, workspaceStateFile } from '../paths.ts';
import { readWorkspaceState, writeWorkspaceState } from '../supervisor/run.ts';
import {
  appNameFromPath,
  buildLogFile,
  cacheDescription,
  collectorEntry,
  deviceLabel,
  devClientScheme,
  formatDuration,
  iosFacts,
  lastBuildRecord,
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

const UDID = 'BF2A1C3D-4E5F-6071-8293-A4B5C6D7E8F9';
const FINGERPRINT = 'a3f9b1c2d3e4f5';

let tmpHome;
let root;

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

// The same commander stub the other command tests use.
function captureAction(register, deps) {
  let captured;
  const stub = {
    command() { return stub; },
    description() { return stub; },
    option() { return stub; },
    action(fn) { captured = fn; return stub; },
  };
  register(stub, deps);
  return (opts = {}) => captured(opts);
}

// Every engine call is a seam. The defaults describe the happy path with a
// cache MISS; each test overrides the one fact it is about.
function harness(overrides = {}) {
  const calls = { order: [], args: {} };
  const record = (name, value) => { calls.order.push(name); calls.args[name] = value; };
  const appPath = join(root, 'build', 'Fixture.app');

  const deps = {
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
      return FINGERPRINT;
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
    resolveMetroWithRetry: (resolve, port, path, opts) => resolveMetroWithRetry(resolve, port, path, { ...opts, sleep: async () => {} }),
    // The default is a launch that verified: the app fetched a bundle from
    // this workspace's Metro. The unverified path has its own tests.
    verifyLaunch: async (args) => {
      record('verifyLaunch', args);
      return { verified: true, waitedMs: 2500, record: { event: 'bundle_build_started' } };
    },
    ensureWorkspaceIgnored: async (dir) => { record('ensureWorkspaceIgnored', dir); },
    ...overrides,
  };
  return { deps, calls, appPath };
}

async function run(opts = {}, overrides = {}) {
  const { deps, calls, appPath } = harness(overrides);
  const action = captureAction(registerIos, deps);
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  let exitCode = null;
  console.log = (l) => logs.push(String(l));
  console.error = (l) => errs.push(String(l));
  process.exit = (c) => { exitCode = c; };
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
    const { errs, exitCode, calls } = await run({}, {
      resolveProjectMetro: async () => ({ missing: true }),
    });
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
    const { errs, exitCode } = await run({}, {
      resolveProjectMetro: async () => ({ notOurs: 'pid 42 on port 8082 runs from /elsewhere' }),
    });
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
    expect(JSON.parse(logs[0]).launched).toBe('unverified');
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
    const { exitCode, calls } = await run({}, {
      resolveProjectMetro: async () => {
        attempts += 1;
        // Listening, event loop blocked by the file-map crawl.
        if (attempts < 3) return { notOurs: 'pid 42 on port 8082 does not answer Metro\'s /status', kind: 'unresponsive' };
        return { metro: { pid: 42, leader: 42, cwd: root } };
      },
    });
    expect(exitCode).toBe(null);
    expect(attempts).toBe(3);
    expect(calls.order.includes('buildIos')).toBeTruthy();
  });

  test('a FOREIGN listener is refused immediately: waiting cannot make it ours', async () => {
    reserve();
    let attempts = 0;
    const { exitCode, errs } = await run({}, {
      resolveProjectMetro: async () => {
        attempts += 1;
        return { notOurs: 'pid 42 on port 8082 runs from /elsewhere, outside ' + root, kind: 'foreign-cwd' };
      },
    });
    expect(exitCode).toBe(1);
    expect(attempts).toBe(1);
    expect(errs.join('\n')).toMatch(/NOT this workspace's dev server/);
  });

  test('gateShouldRetry is the rule, stated once', () => {
    expect(gateShouldRetry({ missing: true })).toBe(true);
    expect(gateShouldRetry({ notOurs: 'x', kind: 'unresponsive' })).toBe(true);
    expect(gateShouldRetry({ notOurs: 'x', kind: 'unreadable-cwd' })).toBe(true);
    expect(gateShouldRetry({ notOurs: 'x', kind: 'foreign-cwd' })).toBe(false);
    expect(gateShouldRetry({ metro: { pid: 1 } })).toBe(false);
  });

  test('the refusal distinguishes "our supervisor is still indexing" from a foreign listener', async () => {
    reserve();
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port: 8082, mode: 'bare-inproc', startedAt: 'now' } });
    const { errs, exitCode } = await run({}, {
      resolveProjectMetro: async () => ({ notOurs: 'pid 4242 on port 8082 does not answer Metro\'s /status', kind: 'unresponsive' }),
    });
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
    expect(noMetroMessage({ port: 8082, resolution: { missing: true }, supervisor, supervisorAlive: true })).toMatch(/supervisor record exists/);
    expect(noMetroMessage({ port: 8082, resolution: { missing: true }, supervisor, supervisorAlive: false })).toMatch(/Nothing is serving/);
    expect(noMetroMessage({ port: 8099, resolution: { missing: true }, supervisor, supervisorAlive: true })).toMatch(/Nothing is serving/);
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
    expect(JSON.parse(logs[0]).launched).toBe(true);
    expect(errs.join('\n')).toMatch(/verify.*bundle requested from Metro port 8082/);
    // It polls THIS workspace's timeline, from the launch onwards.
    expect(calls.args.verifyLaunch.logsDir).toBe(workspaceLogsDir(root));
    expect(Number.isFinite(calls.args.verifyLaunch.since)).toBeTruthy();
  });

  test('the picker: an unverified launch is launched: "unverified", exit 0, and a loud warning', async () => {
    reserve();
    const { logs, errs, exitCode } = await run({ json: true }, {
      verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
      detectIsExpo: () => true,
    });
    // Exit 0: the app IS launched, and refusing here would break every slow
    // launch. What changes is the FACT, which is what an agent branches on.
    expect(exitCode).toBe(null);
    expect(JSON.parse(logs[0]).launched).toBe('unverified');
    const text = errs.join('\n');
    expect(text).toMatch(/UNVERIFIED/);
    expect(text).toMatch(/DEVELOPMENT SERVERS/);
    expect(text).toMatch(/localhost:8082/);
  });

  test('the alert stall: the warning carries the exact openurl to retry', async () => {
    reserve();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture', dependencies: { expo: '52.0.0', 'expo-dev-client': '5.0.0' },
    }));
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fixture' } }));
    const { errs, logs } = await run({ json: true }, {
      devClientScheme,
      verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
    });
    const text = errs.join('\n');
    expect(text).toMatch(/Open in/);
    expect(text).toMatch(new RegExp(`xcrun simctl openurl ${UDID}`));
    expect(text).toMatch(/fixture:\/\/expo-development-client/);
    expect(JSON.parse(logs[0]).launched).toBe('unverified');
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
    const { exitCode, calls, logs } = await run({ json: true }, {
      resolveBuild: () => cachedApp,
      needsPrebuild: () => true,
      readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
    });
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('runPrebuild')).toBeTruthy();
    expect(!calls.order.includes('runPodInstall')).toBeTruthy();
    expect(!calls.order.includes('storeBuild')).toBeTruthy();
    expect(calls.args.installIosApp.appPath).toBe(cachedApp);
    const facts = JSON.parse(logs[0]);
    expect(facts.cacheHit).toBe('local');
    expect(facts.appPath).toBe(cachedApp);
  });

  test('a hit reads the bundle id from the cached binary, not from the config', async () => {
    reserve();
    const { calls } = await run({}, {
      resolveBuild: () => '/cache/Fixture.app',
      readBundleId: () => 'com.example.fromplist',
      detectBundleId: () => 'com.example.fromconfig',
    });
    expect(calls.args.launchIosApp.bundleId).toBe('com.example.fromplist');
  });

  test('a miss runs prebuild, then pods, then the build, then stores it', async () => {
    reserve();
    const { exitCode, calls, appPath } = await run({}, {
      detectIsExpo: () => true,
      needsPrebuild: () => true,
      readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
    });
    expect(exitCode).toBe(null);
    const order = calls.order.filter((c) => ['fingerprintProject', 'runPrebuild', 'runPodInstall', 'buildIos', 'storeBuild', 'installIosApp', 'launchIosApp'].includes(c));
    expect(order).toEqual([
      'fingerprintProject', 'runPrebuild', 'runPodInstall', 'buildIos', 'storeBuild', 'installIosApp', 'launchIosApp',
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
    const { exitCode, calls, logs } = await run({ json: true, buildCache: false }, {
      resolveBuild: () => { throw new Error('the local cache must not be consulted'); },
      loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
      resolveRemote: () => { throw new Error('the provider must not be consulted'); },
    });
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('resolveRemote')).toBeTruthy();
    const facts = JSON.parse(logs[0]);
    expect(facts.cacheHit).toBe(false);
    expect(facts.cacheSkipped).toBe(true);
    expect(!facts.appPath.startsWith(cachedApp)).toBeTruthy();
  });

  // The whole reason to opt out is a cache entry you no longer trust. Keeping
  // the old entry would mean the very next run trusts it again.
  test('--no-build-cache still STORES -- over the entry it was told not to trust -- and still uploads', async () => {
    reserve();
    const { exitCode, calls } = await run({ buildCache: false }, {
      loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
    });
    expect(exitCode).toBe(null);
    expect(calls.args.storeBuild.options).toEqual({ overwrite: true });
    expect(calls.order.includes('uploadRemote')).toBeTruthy();
  });

  test('a default run stores without overwriting: two worktrees at the same fingerprint agree', async () => {
    reserve();
    const { calls } = await run({});
    expect(calls.args.storeBuild.options).toEqual({ overwrite: false });
  });

  test('a cache store that fails does not fail a successful build', async () => {
    reserve();
    const { exitCode, errs, calls } = await run({}, {
      storeBuild: () => { throw new Error('no space left on device'); },
    });
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
    const stored = [];
    const { exitCode, calls, logs, errs } = await run({ json: true }, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider(),
      resolveRemote: async () => ({ appPath: remoteApp }),
      storeBuild: (platform, key, path, options) => {
        stored.push({ platform, key, path, options });
        return storedApp;
      },
    });
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('runPrebuild')).toBeTruthy();
    expect(stored.length).toBe(1);
    expect(stored[0].path).toBe(remoteApp);
    expect(stored[0].key).toBe(calls.args.resolveBuild.key);
    expect(calls.args.installIosApp.appPath).toBe(storedApp);
    expect(errs.join('\n')).toMatch(/^cache {7}remote hit \(eas\) -> stored locally$/m);
    const facts = JSON.parse(logs[0]);
    expect(facts.cacheHit).toBe('remote');
    expect(facts.appPath).toBe(storedApp);
    expect(readWorkspaceState(root).lastBuild.cacheHit).toBe('remote');
  });

  test('the provider is asked with this workspace\'s fingerprint and platform', async () => {
    reserve();
    const { calls } = await run({}, { detectIsExpo: () => true, loadProjectProvider: async () => provider('./p.cjs') });
    expect(calls.args.resolveRemote.platform).toBe('ios');
    expect(calls.args.resolveRemote.fingerprintHash).toBe(FINGERPRINT);
    expect(calls.args.resolveRemote.projectRoot).toBe(root);
  });

  test('a remote MISS builds, stores locally, and uploads the result', async () => {
    reserve();
    const { exitCode, calls, errs, appPath } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider(),
    });
    expect(exitCode).toBe(null);
    const relevant = calls.order.filter((c) => ['resolveBuild', 'resolveRemote', 'buildIos', 'storeBuild', 'uploadRemote', 'installIosApp'].includes(c));
    expect(relevant).toEqual(['resolveBuild', 'resolveRemote', 'buildIos', 'storeBuild', 'uploadRemote', 'installIosApp']);
    expect(calls.args.uploadRemote.buildPath).toBe(appPath);
    expect(calls.args.uploadRemote.fingerprintHash).toBe(FINGERPRINT);
    expect(errs.join('\n')).toMatch(/^cache {7}uploaded \(eas\)$/m);
  });

  // Containment is the product here: a provider is someone else's network call
  // running inside an agent's dev loop.
  test('a provider that THROWS degrades to a local-only run with a note', async () => {
    reserve();
    const { exitCode, calls, errs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider(),
      resolveRemote: async () => ({ failed: 'EAS session expired' }),
    });
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/cache.*EAS session expired.*building instead/);
  });

  test('a provider that TIMES OUT does not stall the loop, and the command stops holding the process open', async () => {
    reserve();
    const exits = [];
    const originalExit = process.exit;
    process.exit = (code) => { exits.push(code); };
    let errs;
    let calls;
    try {
      ({ errs, calls } = await run({}, {
        detectIsExpo: () => true,
        loadProjectProvider: async () => provider(),
        resolveRemote: async () => ({ timedOut: true }),
      }));
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
    const { exitCode, calls, errs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => ({ unavailable: 'the EAS build cache needs the `eas-build-cache-provider` package' }),
    });
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('resolveRemote')).toBeTruthy();
    expect(calls.order.includes('buildIos')).toBeTruthy();
    const lines = errs.join('\n').split('\n').filter((l) => /provider not usable/.test(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/eas-build-cache-provider/);
  });

  test('a remote hit that cannot be stored locally is still installed from where it landed', async () => {
    reserve();
    const remoteApp = join(root, 'downloaded', 'Fixture.app');
    const { exitCode, calls, errs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider(),
      resolveRemote: async () => ({ appPath: remoteApp }),
      storeBuild: () => { throw new Error('no space left on device'); },
    });
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
    const { exitCode, calls, errs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
      checkEasAuth: () => ({ failed: true, code: 'logged-out', reason: 'Not logged in' }),
    });
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('resolveRemote')).toBeTruthy();
    expect(!calls.order.includes('uploadRemote')).toBeTruthy();
    const lines = errs.join('\n').split('\n').filter((l) => /eas is not authenticated/.test(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/eas login/);
    expect(lines[0]).toMatch(/EXPO_TOKEN/);
    expect(lines[0]).toMatch(/local cache only/);
  });

  test('the session is checked with the owner the config named, and only once', async () => {
    reserve();
    const asked = [];
    await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
      checkEasAuth: (args) => { asked.push(args); return { ok: true, account: 'janic' }; },
    });
    expect(asked.length).toBe(1);
    expect(asked[0].owner).toBe('th3rd-wave');
    expect(asked[0].projectRoot).toBe(root);
  });

  test('a custom provider is never asked about EAS at all', async () => {
    reserve();
    let asked = false;
    const { calls } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider('./p.cjs'),
      checkEasAuth: () => { asked = true; return { failed: true, code: 'logged-out' }; },
    });
    expect(asked).toBe(false);
    expect(calls.order.includes('resolveRemote')).toBeTruthy();
  });

  // Offline is not logged out. whoami reaches the network whenever a session
  // exists, so an unknown answer has to leave the run exactly as it was.
  test('a session that could not be established changes nothing', async () => {
    reserve();
    const { calls, errs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider(),
      checkEasAuth: () => ({ unknown: 'eas whoami timed out after 15000ms' }),
    });
    expect(calls.order.includes('resolveRemote')).toBeTruthy();
    expect(!/not authenticated/.test(errs.join('\n'))).toBeTruthy();
  });

  test('a session on the wrong account warns, naming both, and still consults the cache', async () => {
    reserve();
    const { calls, errs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
      checkEasAuth: () => ({ failed: true, code: 'wrong-account', account: 'janic', owner: 'th3rd-wave' }),
    });
    expect(calls.order.includes('resolveRemote')).toBeTruthy();
    const line = errs.join('\n').split('\n').find((l) => /janic/.test(l));
    expect(line).toMatch(/th3rd-wave/);
    expect(line).toMatch(/anyway/);
  });

  // The other half: when a provider DOES surface an error, an auth one gets the
  // same specific note rather than the generic "could not be used".
  test('a provider failure that reads as auth gets the auth note, not the generic one', async () => {
    reserve();
    const { errs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider(),
      checkEasAuth: () => ({ unknown: 'offline' }),
      resolveRemote: async () => ({ failed: 'Error: Not logged in' }),
    });
    expect(errs.join('\n')).toMatch(/eas is not authenticated \(Error: Not logged in\)/);
    expect(!/could not be used/.test(errs.join('\n'))).toBeTruthy();
  });

  test('a failed upload is a note, never a failed run', async () => {
    reserve();
    const { exitCode, errs, logs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider(),
      uploadRemote: async () => ({ failed: '403 forbidden' }),
    });
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
    held: { pid, projectRoot, startedAt: '2026-08-25T10:00:00.000Z', logFile: `${projectRoot}/.rn-iso/logs/build-ios.ndjson` },
    path: '/home/build-locks/ios-key.lock',
  });

  test('the lock is attempted only after BOTH cache levels have missed', async () => {
    reserve();
    const { calls } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
    });
    const order = calls.order.filter((c) => ['resolveBuild', 'resolveRemote', 'acquireBuildLock', 'buildIos', 'storeBuild', 'releaseBuildLock'].includes(c));
    expect(order).toEqual(['resolveBuild', 'resolveRemote', 'acquireBuildLock', 'buildIos', 'storeBuild', 'releaseBuildLock']);
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
    const { calls } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
      resolveRemote: async () => ({ appPath: '/downloads/Fixture.app' }),
    });
    expect(!calls.order.includes('acquireBuildLock')).toBeTruthy();
  });

  // --no-build-cache means "compile this yourself, now". Waiting for another
  // workspace's artifact is exactly what it was passed to avoid -- and taking
  // the lock would make every other workspace wait on a build whose result
  // they were not asking for.
  test('--no-build-cache neither waits nor acquires', async () => {
    reserve();
    const { calls } = await run({ buildCache: false }, {
      acquireBuildLock: () => { throw new Error('the lock must not be attempted'); },
      waitForBuild: () => { throw new Error('nothing may be waited for'); },
    });
    expect(calls.order.includes('buildIos')).toBeTruthy();
  });

  test('the loser waits, installs the artifact, and compiles nothing', async () => {
    reserve();
    const waited = '/cache/ios/key/Fixture.app';
    const { exitCode, calls, logs, stderr } = await run({ json: true }, {
      acquireBuildLock: () => heldBy(41233, '/w/app-999'),
      waitForBuild: async () => ({ hit: waited, waitedMs: 761000 }),
      needsPrebuild: () => true,
      readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
    });
    expect(exitCode).toBe(null);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(!calls.order.includes('runPrebuild')).toBeTruthy();
    expect(!calls.order.includes('runPodInstall')).toBeTruthy();
    expect(!calls.order.includes('storeBuild')).toBeTruthy();
    expect(!calls.order.includes('releaseBuildLock')).toBeTruthy();
    expect(calls.args.installIosApp.appPath).toBe(waited);

    const facts = JSON.parse(logs[0]);
    expect(facts.cacheHit).toBe('local');
    expect(facts.waitedForBuild).toEqual({ pid: 41233, ms: 761000 });
    expect(stderr).toMatch(/waited 12m41s for \/w\/app-999's build -> installed from cache/);
  });

  test('a run that did not wait reports waitedForBuild: null', async () => {
    reserve();
    const { logs } = await run({ json: true });
    expect(JSON.parse(logs[0]).waitedForBuild).toBe(null);
  });

  test('the wait is announced when it starts, naming who is building and what to tail', async () => {
    reserve();
    const { stderr } = await run({}, {
      acquireBuildLock: () => heldBy(41233, '/w/app-999'),
      waitForBuild: async () => ({ hit: '/cache/Fixture.app', waitedMs: 1000 }),
    });
    expect(stderr).toMatch(/\/w\/app-999/);
    expect(stderr).toMatch(/41233/);
    expect(stderr).toMatch(/build-ios\.ndjson/);
  });

  test('the wait gets the progress line onto stderr as it happens', async () => {
    reserve();
    const { stderr, logs } = await run({ json: true }, {
      acquireBuildLock: () => heldBy(),
      waitForBuild: async ({ out }) => {
        out('build       waiting on /w/app-999 (pid 41233, 4m elapsed) -- tail /w/app-999/x.ndjson');
        return { hit: '/cache/Fixture.app', waitedMs: 240000 };
      },
    });
    expect(stderr).toMatch(/waiting on \/w\/app-999 \(pid 41233, 4m elapsed\)/);
    expect(logs.length).toBe(1);
  });

  // The builder died, or its build failed and it released without storing.
  // Waiting longer would be waiting for nothing, so this run becomes the
  // builder -- and takes the lock, so a third workspace waits on IT.
  test('a builder that failed makes the waiter take over and build', async () => {
    reserve();
    let acquires = 0;
    const { exitCode, calls, stderr } = await run({}, {
      acquireBuildLock: () => (++acquires === 1 ? heldBy() : { acquired: true, path: '/lock', lock: { pid: process.pid } }),
      waitForBuild: async () => ({ builderFailed: 'the build lock was released without an artifact', waitedMs: 4000 }),
    });
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
    const { exitCode, calls } = await run({}, {
      acquireBuildLock: () => heldBy(),
      waitForBuild: async () => { waits++; return { builderFailed: 'the builder (pid 41233) is gone', waitedMs: 10 }; },
    });
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
    const { exitCode, calls } = await run({}, {
      buildIos: async () => ({ failed: true, code: 'RN_ISO_BUILD_FAILED', durationMs: 90000, diagnostics: [] }),
    });
    expect(exitCode).toBe(1);
    expect(calls.order.includes('releaseBuildLock')).toBeTruthy();
  });

  // An exception is not a failure the command formats -- it propagates -- so
  // `fail` never sees it and only the `finally` can free the waiters.
  test('a build that THROWS releases the lock on the way out', async () => {
    reserve();
    let released = null;
    await await expect(() => run({}, {
      buildIos: async () => { throw new Error('xcodebuild exploded'); },
      releaseBuildLock: (handle) => { released = handle; return true; },
    })).rejects.toThrow(/xcodebuild exploded/);
    expect(released).toBeTruthy();
    expect(released.lock.pid).toBe(process.pid);
  });

  test('a prebuild or pod failure releases the lock too', async () => {
    reserve();
    const { exitCode, calls } = await run({}, {
      detectIsExpo: () => true,
      needsPrebuild: () => true,
      runPrebuild: async () => ({ failed: true, code: 'RN_ISO_PREBUILD_FAILED', reason: 'no' }),
    });
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(calls.order.includes('releaseBuildLock')).toBeTruthy();
  });

  // A wedged builder is the one thing pid-liveness cannot see, so the wait has
  // a ceiling. It surfaces as an ordinary refusal with a code, not a stack.
  test('a wait that hits its ceiling is a refusal with a code, not a crash', async () => {
    reserve();
    const { exitCode, errs, logs, calls } = await run({ json: true }, {
      acquireBuildLock: () => heldBy(),
      waitForBuild: async () => {
        const err = new Error('Waited 90m ... The lock is /home/build-locks/ios-key.lock');
        err.code = 'RN_ISO_BUILD_WAIT_TIMEOUT';
        err.lockPath = '/home/build-locks/ios-key.lock';
        throw err;
      },
    });
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/RN_ISO_BUILD_WAIT_TIMEOUT/);
    expect(JSON.parse(logs[0]).code).toBe('RN_ISO_BUILD_WAIT_TIMEOUT');
  });

  // Same containment rule the cache store and the provider follow: this is an
  // optimisation, and an optimisation that cannot run must not stop a build.
  test('a lock that cannot be created is a note, and the build proceeds', async () => {
    reserve();
    const { exitCode, calls, errs } = await run({}, {
      acquireBuildLock: () => { throw new Error('EROFS: read-only file system'); },
    });
    expect(exitCode).toBe(null);
    expect(calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/read-only file system/);
  });
});

describe('pods', () => {
  test('a sandbox that does not match the lock is installed before the build', async () => {
    reserve();
    const { calls, errs } = await run({}, {
      readPodState: () => ({ hasPodfile: true, lockText: 'PODS: A', manifestText: 'PODS: B' }),
    });
    expect(calls.order.includes('runPodInstall')).toBeTruthy();
    expect(calls.order.indexOf('runPodInstall') < calls.order.indexOf('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/^pods {8}.*differ -> installed \(18s\)/m);
  });

  test('a Podfile whose pods have never been installed is installed too', async () => {
    reserve();
    const { calls } = await run({}, {
      readPodState: () => ({ hasPodfile: true, lockText: null, manifestText: null }),
    });
    expect(calls.order.includes('runPodInstall')).toBeTruthy();
  });

  test('a project with no CocoaPods at all is skipped silently', async () => {
    reserve();
    const { calls, errs } = await run({}, {
      readPodState: () => ({ hasPodfile: false, lockText: null, manifestText: null }),
    });
    expect(!calls.order.includes('runPodInstall')).toBeTruthy();
    expect(!/^pods/m.test(errs.join('\n'))).toBeTruthy();
  });

  test('a failed pod install stops the run with RN_ISO_DEPS_FAILED', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({}, {
      readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
      runPodInstall: async () => ({
        failed: true,
        code: 'RN_ISO_DEPS_FAILED',
        reason: '`pod install` failed (exit code 1).',
        lastLines: ['[!] CocoaPods could not find compatible versions'],
      }),
    });
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/RN_ISO_DEPS_FAILED/);
    expect(errs.join('\n')).toMatch(/could not find compatible versions/);
  });
});

describe('failure output', () => {
  test('a failed build prints the extracted diagnostics and the log path, never the transcript', async () => {
    reserve();
    const { errs, logs, exitCode } = await run({ json: true }, {
      buildIos: async () => ({
        failed: true,
        code: 'RN_ISO_BUILD_FAILED',
        durationMs: 161000,
        truncated: 3,
        exitCode: 65,
        diagnostics: [
          { file: '/w/ios/AppDelegate.mm', line: 12, column: 4, message: "use of undeclared identifier 'foo'" },
          { message: 'The sandbox is not in sync with the Podfile.lock', remedy: 'Run `pod install` in ios/ and build again.' },
        ],
        tail: ['** BUILD FAILED **'],
      }),
    });
    expect(exitCode).toBe(1);
    // --json is a contract about stdout in BOTH directions: exactly one
    // parseable line, whether the run succeeded or failed. A caller capturing
    // it with `$(...)` and parsing the result got an empty string here, which
    // is the one answer a JSON parser cannot act on.
    expect(logs.length).toBe(1);
    // The shape is `android`'s, and BOTH fields are populated: a payload
    // carrying only a code made `ios --json` the one command whose failure a
    // caller could not report without also parsing stderr prose.
    const payload = JSON.parse(logs[0]);
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
    const payload = JSON.parse(logs[0]);
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
    const { errs } = await run({}, {
      buildIos: async () => ({
        failed: true, code: 'RN_ISO_BUILD_FAILED', durationMs: 1000, truncated: 0,
        diagnostics: [], tail: ['xcodebuild: error: something inscrutable'],
      }),
    });
    expect(errs.join('\n')).toMatch(/no recognizable diagnostic/);
    expect(errs.join('\n')).toMatch(/something inscrutable/);
  });

  test('a failed build writes a Contract-4 record with the error code', async () => {
    reserve();
    await run({}, {
      buildIos: async () => ({ failed: true, code: 'RN_ISO_BUILD_FAILED', durationMs: 5000, diagnostics: [], tail: [] }),
    });
    const { lastBuild } = readWorkspaceState(root);
    expect(lastBuild.status).toBe('failed');
    expect(lastBuild.errorCode).toBe('RN_ISO_BUILD_FAILED');
    expect(lastBuild.platform).toBe('ios');
    expect(lastBuild.fingerprint).toBe(FINGERPRINT);
    expect(lastBuild.cacheHit).toBe(false);
    expect(lastBuild.startedAt).toBeTruthy();
  });

  test('a device that will not boot is refused before anything is fingerprinted or built', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({}, {
      ensureBooted: async () => ({ failed: true, reason: 'Simulator BF2A no longer exists.' }),
    });
    expect(exitCode).toBe(1);
    expect(!calls.order.includes('fingerprintProject')).toBeTruthy();
    expect(!calls.order.includes('buildIos')).toBeTruthy();
    expect(errs.join('\n')).toMatch(/no longer exists/);
  });

  test('a failed install is reported with its own code and a failed record', async () => {
    reserve();
    const { errs, exitCode } = await run({}, {
      installIosApp: () => ({ failed: true, code: 'RN_ISO_INSTALL_FAILED', reason: 'simctl install failed' }),
    });
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/RN_ISO_INSTALL_FAILED/);
    expect(readWorkspaceState(root).lastBuild.errorCode).toBe('RN_ISO_INSTALL_FAILED');
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
    expect(text).toMatch(/^device {6}rn-iso-fixture \(BF2A\.\.\) booted$/m);
    expect(text).toMatch(/^fingerprint a3f9b1\.\. miss$/m);
    expect(text).toMatch(/^build {7}ok \(2m41s\)$/m);
    expect(text).toMatch(/^install {5}-> rn-iso-fixture \(BF2A\.\.\)$/m);
    expect(text).toMatch(/^launch {6}com\.example\.app$/m);
  });

  test('--json emits exactly one line of facts on stdout', async () => {
    reserve();
    const { logs, appPath } = await run({ json: true });
    expect(logs.length).toBe(1);
    const facts = JSON.parse(logs[0]);
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
    expect(marker.src).toBe('build');
    expect(marker.msg).toMatch(/launched com\.example\.app on BF2A.* against Metro port 8082/);
  });
});

describe('Contract 6: the dev-client scheme', () => {
  test('is passed when the app config has one and the dev client is installed', async () => {
    reserve();
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fixture' } }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture', dependencies: { expo: '52.0.0', 'expo-dev-client': '5.0.0' },
    }));
    const { calls } = await run({}, { devClientScheme });
    expect(calls.args.launchIosApp.devClientScheme).toBe('fixture');
  });

  test('is undefined when the app config has no scheme: a plain launch plus RCT_jsLocation works everywhere', async () => {
    reserve();
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fixture' } }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture', dependencies: { 'expo-dev-client': '5.0.0' },
    }));
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
  function collectorHarness({ state = null, killImpl = null } = {}) {
    if (state) writeWorkspaceState(root, state);
    const spawns = [];
    const kills = [];
    return {
      spawns,
      kills,
      opts: {
        root,
        udid: UDID,
        bundleId: 'com.example.app',
        appName: 'FixtureDev',
        spawn: (cmd, args, opts) => {
          spawns.push({ cmd, args, opts });
          return { pid: 7001, unref() {} };
        },
        kill: (pid, signal) => {
          kills.push({ pid, signal });
          if (killImpl) killImpl(pid, signal);
        },
        alive: () => false,
        waitMs: 0,
      },
    };
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
      killImpl: () => { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e; },
    });
    const result = await replaceCollector(h.opts);
    expect(result.killed).toBe(null);
    expect(h.spawns.length).toBe(1);
  });

  test('the collector is spawned detached, unref-ed, with the REAL app name from the .app path', async () => {
    const h = collectorHarness();
    await replaceCollector(h.opts);
    const { cmd, args, opts } = h.spawns[0];
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toBe(collectorEntry());
    expect(existsSync(collectorEntry())).toBeTruthy();
    expect(args.slice(1)).toEqual([
      '--platform', 'ios',
      '--root', root,
      '--udid', UDID,
      '--bundle', 'com.example.app',
      '--app-name', 'FixtureDev',
    ]);
    expect(opts.detached).toBe(true);
    expect(opts.cwd).toBe(root);
  });

  test('the command hands it the app name derived from the .app basename', async () => {
    reserve();
    const { calls } = await run({}, {
      buildIos: async () => ({ appPath: '/tmp/dd/Build/Products/Debug-iphonesimulator/FixtureDev.app', bundleId: 'com.example.app', durationMs: 1000 }),
    });
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
      write: () => { throw new Error('EROFS'); },
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
    expect(podAction({ hasPodfile: true }, { stale: true, reason: 'they differ' })).toEqual({ install: true, reason: 'they differ' });
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
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function project(app, pkg) {
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
  test('prefers the built app\'s Info.plist over app.json', () => {
    const dir = project({ expo: { scheme: 'from-app-json' } }, withDevClient);
    const exec = {
      runFile: (cmd, args) => {
        expect(cmd).toBe('plutil');
        expect(args.slice(0, 4)).toEqual(['-convert', 'json', '-o', '-']);
        expect(args[4]).toMatch(/Fixture\.app\/Info\.plist$/);
        return JSON.stringify({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['io.tlon.groups'] }] });
      },
    };
    expect(devClientScheme(dir, '/b/Fixture.app', { exec })).toBe('io.tlon.groups');
  });

  test('falls back to app.json when the bundle cannot be read', () => {
    const dir = project({ expo: { scheme: 'from-app-json' } }, withDevClient);
    const exec = { runFile: () => { throw new Error('plutil: file does not exist'); } };
    expect(devClientScheme(dir, '/b/Fixture.app', { exec })).toBe('from-app-json');
  });

  test('reads CFBundleURLTypes the way @expo/config-plugins does', () => {
    expect(schemesFromInfoPlist({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['a'] }, { CFBundleTypeRole: 'Editor' }, { CFBundleURLSchemes: ['b', 'c'] }] })).toEqual(['a', 'b', 'c']);
    expect(schemesFromInfoPlist({})).toEqual([]);
    expect(schemesFromInfoPlist(null)).toEqual([]);
  });

  describe('pickDevClientScheme', () => {
    test('prefers exp+<slug>, as Expo\'s own CLI does', () => {
      expect(pickDevClientScheme(['myapp', 'exp+my-app'])).toBe('exp+my-app');
    });

    test('drops third-party callback schemes rather than deep-linking through them', () => {
      // Verbatim from a real app's Info.plist. Expo's rule (longest wins)
      // picks the Google one; `fb...` is also declared by the Facebook app, so
      // which app iOS opens depends on what else is installed.
      const real = ['th3rdwave', 'fb555544564655381', 'com.googleusercontent.apps.869857856617-96dju1hh2u2361k8o6becusfvq74tv80'];
      expect(pickDevClientScheme(real)).toBe('th3rdwave');
    });

    test('otherwise the longest, which is Expo\'s uniqueness tie-break', () => {
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
      udid: UDID, fingerprint: 'abc', cacheKey: 'k', cacheHit: false, appPath: '/a.app',
      bundleId: 'com.x', metroPort: 8082, logsDir: '/l', durationMs: 1,
    };
    expect(iosFacts(base).launched).toBe(true);
    expect(iosFacts({ ...base, launched: 'unverified' }).launched).toBe('unverified');
  });

  test('is the shape an agent parses', () => {
    expect(iosFacts({
        udid: UDID, deviceName: 'rn-iso-x', fingerprint: 'abc', cacheKey: 'abc-debug-sim',
        cacheHit: 'local', appPath: '/a/b.app', bundleId: 'com.x', metroPort: 8082,
        logsDir: '/w/.rn-iso/logs', durationMs: 1234,
      })).toEqual({
        platform: 'ios', udid: UDID, deviceName: 'rn-iso-x', fingerprint: 'abc',
        cacheKey: 'abc-debug-sim', cacheHit: 'local', cacheSkipped: false, waitedForBuild: null,
        appPath: '/a/b.app',
        bundleId: 'com.x', launched: true, metroPort: 8082, logs: { dir: '/w/.rn-iso/logs' },
        durationMs: 1234,
      });
  });

  // A wait is reported ALONGSIDE cacheHit: 'local', never instead of it. The
  // artifact really did come from the local cache; what this adds is that it
  // was not there when the run started, and what it cost to get it.
  test('waitedForBuild names the builder waited on and what the wait cost', () => {
    const facts = iosFacts({ cacheHit: 'local', waitedForBuild: { pid: 41233, ms: 761000 } });
    expect(facts.cacheHit).toBe('local');
    expect(facts.waitedForBuild).toEqual({ pid: 41233, ms: 761000 });
  });

  // The enum is the point: an agent that reads `true` cannot tell a free
  // install from one that cost a download, and those are not the same thing to
  // plan around. Anything that is not a level rendered as `false`.
  test('cacheHit is a LEVEL, and an unknown value is a miss rather than a truthy string', () => {
    expect(iosFacts({ cacheHit: 'remote' }).cacheHit).toBe('remote');
    expect(iosFacts({ cacheHit: true }).cacheHit).toBe(false);
    expect(iosFacts({ cacheHit: false }).cacheHit).toBe(false);
  });

  test('cacheSkipped separates "found nothing" from "was told not to look"', () => {
    expect(iosFacts({ cacheHit: false }).cacheSkipped).toBe(false);
    expect(iosFacts({ cacheHit: false, cacheSkipped: true }).cacheSkipped).toBe(true);
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
  const seen = [];
  await run({}, { fingerprintProject: async (path, options) => { seen.push({ path, options }); return FINGERPRINT; } });
  expect(seen.length).toBe(1);
  expect(seen[0].path).toBe(root);
  expect(seen[0].options?.platform).toBe('ios');
});

// The generic half of the same contract: nothing recognizable in the
// transcript still has to produce a sentence and a next step, because the
// `--json` payload is all an unattended caller sees.
test('--json says so when a build failed with no recognizable diagnostic', async () => {
  reserve();
  const { logs, exitCode } = await run({ json: true }, {
    buildIos: async () => ({
      failed: true, code: 'RN_ISO_BUILD_FAILED', durationMs: 1000, truncated: 0,
      exitCode: 70, diagnostics: [], tail: ['xcodebuild: error: something inscrutable'],
    }),
  });
  expect(exitCode).toBe(1);
  const payload = JSON.parse(logs[0]);
  expect(payload.message).toMatch(/no recognizable diagnostic/);
  expect(payload.remedy).toMatch(/build-ios\.ndjson/);
});

// --- opt-in concurrency (unlimited by default) ---
describe('concurrency limits', () => {
  test('unset limits change nothing: no slot is taken, no capacity check refuses', async () => {
    reserve();
    let slotAcquired = 0;
    const { exitCode, calls } = await run({}, {
      getConcurrencyLimits: () => ({ maxBuilds: 0, maxDevices: 0 }),
      acquireBuildSlot: async () => { slotAcquired++; return { acquired: true }; },
    });
    expect(exitCode).toBe(null);
    expect(slotAcquired).toBe(0);
    expect(calls.order.includes('buildIos')).toBeTruthy();
  });

  test('maxDevices at capacity refuses with RN_ISO_AT_CAPACITY, before ensuring a device', async () => {
    reserve();
    let capacityArgs = null;
    const { errs, exitCode, calls } = await run({}, {
      getConcurrencyLimits: () => ({ maxBuilds: 0, maxDevices: 2 }),
      checkDeviceCapacity: (args) => {
        capacityArgs = args;
        return { code: 'RN_ISO_AT_CAPACITY', message: 'at capacity', remedy: 'stop an environment (rn-iso stop) or raise concurrency.maxDevices' };
      },
    });
    expect(exitCode).toBe(1);
    expect(capacityArgs.max).toBe(2);
    expect(errs.join('\n')).toMatch(/RN_ISO_AT_CAPACITY/);
    expect(errs.join('\n')).toMatch(/rn-iso stop/);
    expect(!calls.order.includes('ensureOwnedDevice')).toBeTruthy();
  });

  test('maxBuilds takes a slot AFTER the single-flight lock and releases it after the build', async () => {
    reserve();
    const seq = [];
    let slotArgs = null;
    const { exitCode } = await run({}, {
      getConcurrencyLimits: () => ({ maxBuilds: 2, maxDevices: 0 }),
      acquireBuildLock: () => { seq.push('lock'); return { acquired: true, path: '/lock', lock: { pid: process.pid } }; },
      releaseBuildLock: () => { seq.push('releaseLock'); return true; },
      acquireBuildSlot: async (args) => { seq.push('slot'); slotArgs = args; return { acquired: true, path: '/slot', index: 0, slot: { pid: process.pid } }; },
      releaseBuildSlot: () => { seq.push('releaseSlot'); return true; },
      buildIos: async () => { seq.push('build'); return { appPath: join(root, 'build', 'Fixture.app'), bundleId: 'com.example.app', durationMs: 1000, scheme: 'Fixture' }; },
    });
    expect(exitCode).toBe(null);
    // Slot comes after the single-flight lock, before the compile, and is
    // released with the lock once the artifact is stored.
    expect(seq).toEqual(['lock', 'slot', 'build', 'releaseLock', 'releaseSlot']);
    expect(slotArgs.max).toBe(2);
    expect(slotArgs.root).toBe(root);
  });

  test('a waiter that installs another workspace\'s artifact never consumes a slot', async () => {
    reserve();
    let slotAcquired = 0;
    let built = 0;
    const { exitCode } = await run({}, {
      getConcurrencyLimits: () => ({ maxBuilds: 2, maxDevices: 0 }),
      acquireBuildLock: () => ({ held: { pid: 41233, projectRoot: '/w/other', logFile: null } }),
      waitForBuild: async () => ({ hit: join(root, 'build', 'Fixture.app'), waitedMs: 5000 }),
      acquireBuildSlot: async () => { slotAcquired++; return { acquired: true }; },
      buildIos: async () => { built++; return { appPath: join(root, 'build', 'Fixture.app'), bundleId: 'com.example.app', durationMs: 1, scheme: 'F' }; },
    });
    expect(exitCode).toBe(null);
    expect(slotAcquired).toBe(0);
    expect(built).toBe(0);
  });
});
