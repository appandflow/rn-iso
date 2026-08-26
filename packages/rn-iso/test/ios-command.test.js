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
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertProject } from '../src/config.js';
import { parseNdjsonText } from '../src/ndjson.js';
import { workspaceLogsDir, workspaceStateFile } from '../src/paths.js';
import { readWorkspaceState, writeWorkspaceState } from '../src/supervisor/run.js';
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
} from '../src/commands/ios.js';

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
    assert.equal(exitCode, 1);
    assert.ok(calls.order.includes('ensureOwnedDevice'), 'the device record is still established first');
    assert.ok(!calls.order.includes('ensureBooted'), 'no simulator is booted for a run that cannot proceed');
    assert.ok(!calls.order.includes('fingerprintProject'), 'nothing is fingerprinted');
    assert.ok(!calls.order.includes('buildIos'));
    assert.match(errs.join('\n'), /RN_ISO_NO_METRO/);
    assert.match(errs.join('\n'), /rn-iso start/);
  });

  test('a foreign listener on the reserved port is refused, not built against', async () => {
    reserve();
    const { errs, exitCode } = await run({}, {
      resolveProjectMetro: async () => ({ notOurs: 'pid 42 on port 8082 runs from /elsewhere' }),
    });
    assert.equal(exitCode, 1);
    assert.match(errs.join('\n'), /NOT this workspace's dev server/);
    assert.match(errs.join('\n'), /RN_ISO_NO_METRO/);
  });

  test('no reservation at all is the same failure', async () => {
    const { errs, exitCode } = await run({});
    assert.equal(exitCode, 1);
    assert.match(errs.join('\n'), /RN_ISO_NO_METRO/);
  });

  test('--no-metro-check proceeds without probing the port at all', async () => {
    reserve();
    const { exitCode, calls } = await run({ metroCheck: false });
    assert.equal(exitCode, null);
    assert.ok(!calls.order.includes('resolveProjectMetro'));
    assert.ok(calls.order.includes('buildIos'));
    assert.equal(calls.args.launchIosApp.metroPort, 8082);
  });

  test('--no-metro-check with no reservation still wires the app to 8081', async () => {
    const { exitCode, calls } = await run({ metroCheck: false });
    assert.equal(exitCode, null);
    assert.equal(calls.args.launchIosApp.metroPort, 8081);
  });

  test('--no-metro-check does not poll for a bundle it was told not to expect -- and does not claim one', async () => {
    reserve();
    const { logs, calls, errs } = await run({ json: true, metroCheck: false });
    assert.ok(!calls.order.includes('verifyLaunch'), 'no 20-second wait for a gate that was waived');
    assert.equal(JSON.parse(logs[0]).launched, 'unverified');
    assert.match(errs.join('\n'), /skipped \(--no-metro-check\)/);
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
    assert.equal(exitCode, null, 'the run proceeds');
    assert.equal(attempts, 3);
    assert.ok(calls.order.includes('buildIos'));
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
    assert.equal(exitCode, 1);
    assert.equal(attempts, 1, 'no backoff is spent on an answer that cannot change');
    assert.match(errs.join('\n'), /NOT this workspace's dev server/);
  });

  test('gateShouldRetry is the rule, stated once', () => {
    assert.equal(gateShouldRetry({ missing: true }), true);
    assert.equal(gateShouldRetry({ notOurs: 'x', kind: 'unresponsive' }), true);
    assert.equal(gateShouldRetry({ notOurs: 'x', kind: 'unreadable-cwd' }), true);
    assert.equal(gateShouldRetry({ notOurs: 'x', kind: 'foreign-cwd' }), false);
    assert.equal(gateShouldRetry({ metro: { pid: 1 } }), false);
  });

  test('the refusal distinguishes "our supervisor is still indexing" from a foreign listener', async () => {
    reserve();
    writeWorkspaceState(root, { supervisor: { pid: process.pid, port: 8082, mode: 'bare-inproc', startedAt: 'now' } });
    const { errs, exitCode } = await run({}, {
      resolveProjectMetro: async () => ({ notOurs: 'pid 4242 on port 8082 does not answer Metro\'s /status', kind: 'unresponsive' }),
    });
    assert.equal(exitCode, 1);
    const text = errs.join('\n');
    assert.match(text, /A supervisor record exists for port 8082/);
    assert.match(text, /still be indexing/);
    // And the remedy is the one that helps: wait, do not start a second one.
    assert.match(text, /rn-iso start --wait/);
    assert.doesNotMatch(text, /Run `rn-iso start` first/);
  });

  test('with no supervisor record the refusal is the plain one', async () => {
    reserve();
    const { errs } = await run({}, { resolveProjectMetro: async () => ({ missing: true }) });
    const text = errs.join('\n');
    assert.match(text, /Nothing is serving this workspace's dev server on port 8082/);
    assert.match(text, /Run `rn-iso start` first/);
  });

  test('noMetroMessage names a supervisor only when it is for THIS port and alive', () => {
    const supervisor = { pid: 7, port: 8082, mode: 'expo-child' };
    assert.match(noMetroMessage({ port: 8082, resolution: { missing: true }, supervisor, supervisorAlive: true }), /supervisor record exists/);
    assert.match(noMetroMessage({ port: 8082, resolution: { missing: true }, supervisor, supervisorAlive: false }), /Nothing is serving/);
    assert.match(noMetroMessage({ port: 8099, resolution: { missing: true }, supervisor, supervisorAlive: true }), /Nothing is serving/);
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
    assert.equal(exitCode, null);
    assert.equal(JSON.parse(logs[0]).launched, true);
    assert.match(errs.join('\n'), /verify.*bundle requested from Metro port 8082/);
    // It polls THIS workspace's timeline, from the launch onwards.
    assert.equal(calls.args.verifyLaunch.logsDir, workspaceLogsDir(root));
    assert.ok(Number.isFinite(calls.args.verifyLaunch.since));
  });

  test('the picker: an unverified launch is launched: "unverified", exit 0, and a loud warning', async () => {
    reserve();
    const { logs, errs, exitCode } = await run({ json: true }, {
      verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }),
      detectIsExpo: () => true,
    });
    // Exit 0: the app IS launched, and refusing here would break every slow
    // launch. What changes is the FACT, which is what an agent branches on.
    assert.equal(exitCode, null);
    assert.equal(JSON.parse(logs[0]).launched, 'unverified');
    const text = errs.join('\n');
    assert.match(text, /UNVERIFIED/);
    assert.match(text, /DEVELOPMENT SERVERS/);
    assert.match(text, /localhost:8082/);
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
    assert.match(text, /Open in/, 'the iOS 26 confirmation alert is named');
    assert.match(text, new RegExp(`xcrun simctl openurl ${UDID}`));
    assert.match(text, /fixture:\/\/expo-development-client/);
    assert.equal(JSON.parse(logs[0]).launched, 'unverified');
  });

  test('the collector is attached BEFORE the poll: its 20s are the ones worth logging', async () => {
    reserve();
    const { calls } = await run({});
    assert.ok(calls.order.indexOf('replaceCollector') < calls.order.indexOf('verifyLaunch'));
  });

  test('the outcome lands in the timeline, not only on stderr', async () => {
    reserve();
    await run({}, { verifyLaunch: async () => ({ verified: false, timedOut: true, waitedMs: 20000 }) });
    const record = buildRecords().find((r) => r.event === 'launch_unverified');
    assert.ok(record, 'an agent reading `rn-iso logs` must find it there too');
    assert.equal(record.level, 'warn');
    assert.match(record.msg, /no bundle request .* reached this workspace's Metro on port 8082/);

    // And the verified case says so at info.
    const fresh = await run({});
    assert.equal(fresh.exitCode, null);
    assert.ok(buildRecords().some((r) => r.event === 'launch_verified' && r.level === 'info'));
  });

  test('the outcome line on stdout says UNVERIFIED rather than a plain OK', async () => {
    reserve();
    const { logs } = await run({}, { verifyLaunch: async () => ({ verified: false, timedOut: true }) });
    assert.match(logs[0], /UNVERIFIED/);
  });
});

describe('the workspace directory is gitignored before anything is written into it', () => {
  test('ensureWorkspaceIgnored runs before the device, the gate or the build log', async () => {
    reserve();
    const { calls } = await run({});
    assert.equal(calls.args.ensureWorkspaceIgnored, root);
    assert.equal(calls.order[0], 'ensureWorkspaceIgnored');
  });

  test('the default seam tolerates a module that is missing or a file it cannot write', async () => {
    // It is one line of repo hygiene: a build must not fail over it, and the
    // wrapper is what guarantees that whether engine/workspace.js is there or
    // not.
    const notes = [];
    const result = await ensureWorkspaceIgnoredSafely('/definitely/not/a/checkout', { note: (l) => notes.push(l) });
    assert.ok(result === null || typeof result === 'object');
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
    assert.equal(exitCode, null);
    assert.ok(!calls.order.includes('buildIos'), 'nothing was compiled');
    assert.ok(!calls.order.includes('runPrebuild'), 'a hit does not prebuild');
    assert.ok(!calls.order.includes('runPodInstall'), 'a hit does not touch pods');
    assert.ok(!calls.order.includes('storeBuild'), 'a hit has nothing to store');
    assert.equal(calls.args.installIosApp.appPath, cachedApp);
    const facts = JSON.parse(logs[0]);
    assert.equal(facts.cacheHit, 'local');
    assert.equal(facts.appPath, cachedApp);
  });

  test('a hit reads the bundle id from the cached binary, not from the config', async () => {
    reserve();
    const { calls } = await run({}, {
      resolveBuild: () => '/cache/Fixture.app',
      readBundleId: () => 'com.example.fromplist',
      detectBundleId: () => 'com.example.fromconfig',
    });
    assert.equal(calls.args.launchIosApp.bundleId, 'com.example.fromplist');
  });

  test('a miss runs prebuild, then pods, then the build, then stores it', async () => {
    reserve();
    const { exitCode, calls, appPath } = await run({}, {
      detectIsExpo: () => true,
      needsPrebuild: () => true,
      readPodState: () => ({ hasPodfile: true, lockText: 'A', manifestText: 'B' }),
    });
    assert.equal(exitCode, null);
    const order = calls.order.filter((c) => ['fingerprintProject', 'runPrebuild', 'runPodInstall', 'buildIos', 'storeBuild', 'installIosApp', 'launchIosApp'].includes(c));
    assert.deepEqual(order, [
      'fingerprintProject', 'runPrebuild', 'runPodInstall', 'buildIos', 'storeBuild', 'installIosApp', 'launchIosApp',
    ]);
    assert.equal(calls.args.storeBuild.path, appPath);
    assert.equal(calls.args.storeBuild.platform, 'ios');
  });

  test('an unresolvable fingerprint is RN_ISO_NO_FINGERPRINT, never an unkeyed build', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({}, { fingerprintProject: async () => null });
    assert.equal(exitCode, 1);
    assert.ok(!calls.order.includes('buildIos'));
    assert.match(errs.join('\n'), /RN_ISO_NO_FINGERPRINT/);
  });

  test('--no-build-cache looks nothing up: not the local cache, not the provider', async () => {
    reserve();
    const cachedApp = join(tmpHome, 'build-cache', 'ios', 'k', 'Fixture.app');
    const { exitCode, calls, logs } = await run({ json: true, buildCache: false }, {
      resolveBuild: () => { throw new Error('the local cache must not be consulted'); },
      loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
      resolveRemote: () => { throw new Error('the provider must not be consulted'); },
    });
    assert.equal(exitCode, null);
    assert.ok(calls.order.includes('buildIos'), 'it builds fresh');
    assert.ok(!calls.order.includes('resolveRemote'));
    const facts = JSON.parse(logs[0]);
    assert.equal(facts.cacheHit, false);
    assert.equal(facts.cacheSkipped, true, 'an agent can tell "told not to look" from "found nothing"');
    assert.ok(!facts.appPath.startsWith(cachedApp));
  });

  // The whole reason to opt out is a cache entry you no longer trust. Keeping
  // the old entry would mean the very next run trusts it again.
  test('--no-build-cache still STORES -- over the entry it was told not to trust -- and still uploads', async () => {
    reserve();
    const { exitCode, calls } = await run({ buildCache: false }, {
      loadProjectProvider: async () => ({ provider: { plugin: {}, options: {} }, name: 'eas' }),
    });
    assert.equal(exitCode, null);
    assert.deepEqual(calls.args.storeBuild.options, { overwrite: true });
    assert.ok(calls.order.includes('uploadRemote'), '"do not trust the cache" is not "do not share my build"');
  });

  test('a default run stores without overwriting: two worktrees at the same fingerprint agree', async () => {
    reserve();
    const { calls } = await run({});
    assert.deepEqual(calls.args.storeBuild.options, { overwrite: false });
  });

  test('a cache store that fails does not fail a successful build', async () => {
    reserve();
    const { exitCode, errs, calls } = await run({}, {
      storeBuild: () => { throw new Error('no space left on device'); },
    });
    assert.equal(exitCode, null);
    assert.ok(calls.order.includes('launchIosApp'), 'the app is still installed and launched');
    assert.match(errs.join('\n'), /Could not store the build/);
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
    assert.ok(!calls.order.includes('loadProjectProvider'), 'level one answered; there is nothing to ask');
    assert.ok(!calls.order.includes('resolveRemote'));
  });

  test('a bare RN project never has its config read: the community CLI has no provider concept', async () => {
    reserve();
    const { calls } = await run({}, { detectIsExpo: () => false });
    assert.equal(calls.args.loadProjectProvider.isExpo, false, 'the engine is told, and it is what refuses');
    assert.ok(!calls.order.includes('resolveRemote'), 'no network on a bare project');
  });

  test('an Expo project with no provider configured builds exactly as before', async () => {
    reserve();
    const { exitCode, calls, errs } = await run({}, { detectIsExpo: () => true });
    assert.equal(exitCode, null);
    assert.ok(!calls.order.includes('resolveRemote'), 'nothing configured, nothing called');
    assert.ok(!calls.order.includes('uploadRemote'));
    assert.ok(!/cache/.test(errs.join('\n')), 'and nothing is said about it: it is not a problem');
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
    assert.equal(exitCode, null);
    assert.ok(!calls.order.includes('buildIos'), 'a remote hit skips the build like a local one');
    assert.ok(!calls.order.includes('runPrebuild'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].path, remoteApp, 'the download lands in the local cache');
    assert.equal(stored[0].key, calls.args.resolveBuild.key, 'under the key the local miss looked for');
    assert.equal(calls.args.installIosApp.appPath, storedApp, 'and the LOCAL copy is what gets installed');
    assert.match(errs.join('\n'), /^cache {7}remote hit \(eas\) -> stored locally$/m);
    const facts = JSON.parse(logs[0]);
    assert.equal(facts.cacheHit, 'remote');
    assert.equal(facts.appPath, storedApp);
    assert.equal(readWorkspaceState(root).lastBuild.cacheHit, 'remote');
  });

  test('the provider is asked with this workspace\'s fingerprint and platform', async () => {
    reserve();
    const { calls } = await run({}, { detectIsExpo: () => true, loadProjectProvider: async () => provider('./p.cjs') });
    assert.equal(calls.args.resolveRemote.platform, 'ios');
    assert.equal(calls.args.resolveRemote.fingerprintHash, FINGERPRINT);
    assert.equal(calls.args.resolveRemote.projectRoot, root);
  });

  test('a remote MISS builds, stores locally, and uploads the result', async () => {
    reserve();
    const { exitCode, calls, errs, appPath } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider(),
    });
    assert.equal(exitCode, null);
    const relevant = calls.order.filter((c) => ['resolveBuild', 'resolveRemote', 'buildIos', 'storeBuild', 'uploadRemote', 'installIosApp'].includes(c));
    assert.deepEqual(relevant, ['resolveBuild', 'resolveRemote', 'buildIos', 'storeBuild', 'uploadRemote', 'installIosApp'],
      'local, then remote, then build; the upload starts before the install and is collected after it');
    assert.equal(calls.args.uploadRemote.buildPath, appPath);
    assert.equal(calls.args.uploadRemote.fingerprintHash, FINGERPRINT);
    assert.match(errs.join('\n'), /^cache {7}uploaded \(eas\)$/m);
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
    assert.equal(exitCode, null, 'the run succeeds');
    assert.ok(calls.order.includes('buildIos'), 'it just builds');
    assert.match(errs.join('\n'), /cache.*EAS session expired.*building instead/);
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
    assert.ok(calls.order.includes('buildIos'));
    assert.match(errs.join('\n'), /did not answer within 30s; building instead/);
    assert.deepEqual(exits, [0], 'exit 0: everything this command does is done, and the abandoned call must not keep node alive');
  });

  test('a provider that cannot be loaded says so ONCE and builds', async () => {
    reserve();
    const { exitCode, calls, errs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => ({ unavailable: 'the EAS build cache needs the `eas-build-cache-provider` package' }),
    });
    assert.equal(exitCode, null);
    assert.ok(!calls.order.includes('resolveRemote'));
    assert.ok(calls.order.includes('buildIos'));
    const lines = errs.join('\n').split('\n').filter((l) => /provider not usable/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /eas-build-cache-provider/);
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
    assert.equal(exitCode, null);
    assert.equal(calls.args.installIosApp.appPath, remoteApp);
    assert.match(errs.join('\n'), /could not be stored locally/);
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
    assert.equal(exitCode, null, 'a broken session never fails a build: the local cache still works');
    assert.ok(calls.order.includes('buildIos'));
    assert.ok(!calls.order.includes('resolveRemote'), 'there is nothing to ask a session that cannot answer');
    assert.ok(!calls.order.includes('uploadRemote'), 'and nothing to upload with it either');
    const lines = errs.join('\n').split('\n').filter((l) => /eas is not authenticated/.test(l));
    assert.equal(lines.length, 1, 'ONE line');
    assert.match(lines[0], /eas login/);
    assert.match(lines[0], /EXPO_TOKEN/);
    assert.match(lines[0], /local cache only/);
  });

  test('the session is checked with the owner the config named, and only once', async () => {
    reserve();
    const asked = [];
    await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
      checkEasAuth: (args) => { asked.push(args); return { ok: true, account: 'janic' }; },
    });
    assert.equal(asked.length, 1, 'one whoami per run, not one per call site');
    assert.equal(asked[0].owner, 'th3rd-wave');
    assert.equal(asked[0].projectRoot, root);
  });

  test('a custom provider is never asked about EAS at all', async () => {
    reserve();
    let asked = false;
    const { calls } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider('./p.cjs'),
      checkEasAuth: () => { asked = true; return { failed: true, code: 'logged-out' }; },
    });
    assert.equal(asked, false, 'somebody else\'s provider does not authenticate against EAS');
    assert.ok(calls.order.includes('resolveRemote'));
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
    assert.ok(calls.order.includes('resolveRemote'), 'the provider is still asked');
    assert.ok(!/not authenticated/.test(errs.join('\n')));
  });

  test('a session on the wrong account warns, naming both, and still consults the cache', async () => {
    reserve();
    const { calls, errs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => ({ ...provider(), owner: 'th3rd-wave' }),
      checkEasAuth: () => ({ failed: true, code: 'wrong-account', account: 'janic', owner: 'th3rd-wave' }),
    });
    assert.ok(calls.order.includes('resolveRemote'), 'access is the server\'s decision, not a local list\'s');
    const line = errs.join('\n').split('\n').find((l) => /janic/.test(l));
    assert.match(line, /th3rd-wave/);
    assert.match(line, /anyway/);
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
    assert.match(errs.join('\n'), /eas is not authenticated \(Error: Not logged in\)/);
    assert.ok(!/could not be used/.test(errs.join('\n')));
  });

  test('a failed upload is a note, never a failed run', async () => {
    reserve();
    const { exitCode, errs, logs } = await run({}, {
      detectIsExpo: () => true,
      loadProjectProvider: async () => provider(),
      uploadRemote: async () => ({ failed: '403 forbidden' }),
    });
    assert.equal(exitCode, null);
    assert.equal(logs.length, 1, 'stdout still carries exactly one line');
    assert.match(errs.join('\n'), /upload failed: 403 forbidden/);
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
    assert.deepEqual(order, ['resolveBuild', 'resolveRemote', 'acquireBuildLock', 'buildIos', 'storeBuild', 'releaseBuildLock']);
    assert.equal(calls.args.acquireBuildLock.platform, 'ios');
    assert.equal(calls.args.acquireBuildLock.key, calls.args.resolveBuild.key);
    assert.equal(calls.args.acquireBuildLock.root, root);
    assert.equal(calls.args.acquireBuildLock.logFile, buildLogFile(root), 'the holder names the log a waiter should tail');
  });

  test('a local hit never takes the lock: there is nothing to build', async () => {
    reserve();
    const { calls } = await run({}, { resolveBuild: () => '/cache/Fixture.app' });
    assert.ok(!calls.order.includes('acquireBuildLock'));
    assert.ok(!calls.order.includes('waitForBuild'));
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
    assert.ok(!calls.order.includes('acquireBuildLock'));
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
    assert.ok(calls.order.includes('buildIos'), 'it still compiles fresh');
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
    assert.equal(exitCode, null);
    assert.ok(!calls.order.includes('buildIos'), 'the whole point: one compile, not two');
    assert.ok(!calls.order.includes('runPrebuild'));
    assert.ok(!calls.order.includes('runPodInstall'));
    assert.ok(!calls.order.includes('storeBuild'), 'the builder stored it already');
    assert.ok(!calls.order.includes('releaseBuildLock'), 'a waiter never held the lock');
    assert.equal(calls.args.installIosApp.appPath, waited);

    const facts = JSON.parse(logs[0]);
    assert.equal(facts.cacheHit, 'local', 'it came out of the local cache, like any other hit');
    assert.deepEqual(facts.waitedForBuild, { pid: 41233, ms: 761000 });
    assert.match(stderr, /waited 12m41s for \/w\/app-999's build -> installed from cache/);
  });

  test('a run that did not wait reports waitedForBuild: null', async () => {
    reserve();
    const { logs } = await run({ json: true });
    assert.equal(JSON.parse(logs[0]).waitedForBuild, null);
  });

  test('the wait is announced when it starts, naming who is building and what to tail', async () => {
    reserve();
    const { stderr } = await run({}, {
      acquireBuildLock: () => heldBy(41233, '/w/app-999'),
      waitForBuild: async () => ({ hit: '/cache/Fixture.app', waitedMs: 1000 }),
    });
    assert.match(stderr, /\/w\/app-999/);
    assert.match(stderr, /41233/);
    assert.match(stderr, /build-ios\.ndjson/, 'the waiter is told which log to tail');
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
    assert.match(stderr, /waiting on \/w\/app-999 \(pid 41233, 4m elapsed\)/);
    assert.equal(logs.length, 1, 'stdout still carries exactly one line');
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
    assert.equal(exitCode, null);
    assert.equal(acquires, 2, 'it takes the lock over rather than building beside a queue');
    assert.ok(calls.order.includes('buildIos'));
    assert.ok(calls.order.includes('releaseBuildLock'));
    assert.match(stderr, /without an artifact/);
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
    assert.equal(exitCode, null);
    assert.equal(waits, 1, 'it does not wait a second time');
    assert.ok(calls.order.includes('buildIos'));
    assert.ok(!calls.order.includes('releaseBuildLock'), 'it never held the lock, so it must not release one');
  });

  // The rule that keeps a machine from deadlocking: whatever happens to the
  // build, the lock goes. A failed build that kept it would leave every other
  // workspace on the fingerprint waiting for an artifact nobody is making.
  test('a FAILED build releases the lock', async () => {
    reserve();
    const { exitCode, calls } = await run({}, {
      buildIos: async () => ({ failed: true, code: 'RN_ISO_BUILD_FAILED', durationMs: 90000, diagnostics: [] }),
    });
    assert.equal(exitCode, 1);
    assert.ok(calls.order.includes('releaseBuildLock'), 'a failed build must free its waiters');
  });

  // An exception is not a failure the command formats -- it propagates -- so
  // `fail` never sees it and only the `finally` can free the waiters.
  test('a build that THROWS releases the lock on the way out', async () => {
    reserve();
    let released = null;
    await assert.rejects(() => run({}, {
      buildIos: async () => { throw new Error('xcodebuild exploded'); },
      releaseBuildLock: (handle) => { released = handle; return true; },
    }), /xcodebuild exploded/);
    assert.ok(released, 'the finally ran');
    assert.equal(released.lock.pid, process.pid);
  });

  test('a prebuild or pod failure releases the lock too', async () => {
    reserve();
    const { exitCode, calls } = await run({}, {
      detectIsExpo: () => true,
      needsPrebuild: () => true,
      runPrebuild: async () => ({ failed: true, code: 'RN_ISO_PREBUILD_FAILED', reason: 'no' }),
    });
    assert.equal(exitCode, 1);
    assert.ok(!calls.order.includes('buildIos'));
    assert.ok(calls.order.includes('releaseBuildLock'));
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
    assert.equal(exitCode, 1);
    assert.ok(!calls.order.includes('buildIos'));
    assert.match(errs.join('\n'), /RN_ISO_BUILD_WAIT_TIMEOUT/);
    assert.equal(JSON.parse(logs[0]).code, 'RN_ISO_BUILD_WAIT_TIMEOUT');
  });

  // Same containment rule the cache store and the provider follow: this is an
  // optimisation, and an optimisation that cannot run must not stop a build.
  test('a lock that cannot be created is a note, and the build proceeds', async () => {
    reserve();
    const { exitCode, calls, errs } = await run({}, {
      acquireBuildLock: () => { throw new Error('EROFS: read-only file system'); },
    });
    assert.equal(exitCode, null);
    assert.ok(calls.order.includes('buildIos'));
    assert.match(errs.join('\n'), /read-only file system/);
  });
});

describe('pods', () => {
  test('a sandbox that does not match the lock is installed before the build', async () => {
    reserve();
    const { calls, errs } = await run({}, {
      readPodState: () => ({ hasPodfile: true, lockText: 'PODS: A', manifestText: 'PODS: B' }),
    });
    assert.ok(calls.order.includes('runPodInstall'));
    assert.ok(calls.order.indexOf('runPodInstall') < calls.order.indexOf('buildIos'));
    assert.match(errs.join('\n'), /^pods {8}.*differ -> installed \(18s\)/m);
  });

  test('a Podfile whose pods have never been installed is installed too', async () => {
    reserve();
    const { calls } = await run({}, {
      readPodState: () => ({ hasPodfile: true, lockText: null, manifestText: null }),
    });
    assert.ok(calls.order.includes('runPodInstall'), 'a fresh checkout must install its pods');
  });

  test('a project with no CocoaPods at all is skipped silently', async () => {
    reserve();
    const { calls, errs } = await run({}, {
      readPodState: () => ({ hasPodfile: false, lockText: null, manifestText: null }),
    });
    assert.ok(!calls.order.includes('runPodInstall'));
    assert.ok(!/^pods/m.test(errs.join('\n')), 'and prints nothing about pods');
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
    assert.equal(exitCode, 1);
    assert.ok(!calls.order.includes('buildIos'));
    assert.match(errs.join('\n'), /RN_ISO_DEPS_FAILED/);
    assert.match(errs.join('\n'), /could not find compatible versions/);
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
    assert.equal(exitCode, 1);
    // --json is a contract about stdout in BOTH directions: exactly one
    // parseable line, whether the run succeeded or failed. A caller capturing
    // it with `$(...)` and parsing the result got an empty string here, which
    // is the one answer a JSON parser cannot act on.
    assert.equal(logs.length, 1, 'exactly one line on stdout, even on failure');
    // The shape is `android`'s, and BOTH fields are populated: a payload
    // carrying only a code made `ios --json` the one command whose failure a
    // caller could not report without also parsing stderr prose.
    const payload = JSON.parse(logs[0]);
    assert.equal(payload.code, 'RN_ISO_BUILD_FAILED');
    assert.match(payload.message, /xcodebuild` failed/);
    assert.match(payload.message, /exit code 65/);
    assert.ok(payload.remedy, 'a build failure carries a remedy');
    assert.match(payload.remedy, /pod install/, 'the remedy of a diagnostic beats the generic one');
    const text = errs.join('\n');
    assert.match(text, /^build {7}FAILED after 2m41s/m);
    assert.match(text, /AppDelegate\.mm:12:4: use of undeclared identifier 'foo'/);
    assert.match(text, /The sandbox is not in sync/);
    assert.match(text, /and 3 more diagnostics in the log/);
    assert.match(text, new RegExp(`^log {9}${buildLogFile(root).replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'm'));
    assert.match(text, /^failed {6}RN_ISO_BUILD_FAILED/m);
  });

  // The same contract every other --json failure has, on the step an agent hits
  // most often. `ios` printed NOTHING on stdout here, so a caller could not
  // tell a failed build from a crashed CLI without reading stderr prose.
  test('--json puts one parseable {code, message, remedy} line on stdout when the gate refuses', async () => {
    const { logs, exitCode } = await run({ json: true });
    assert.equal(exitCode, 1);
    assert.equal(logs.length, 1);
    const payload = JSON.parse(logs[0]);
    assert.equal(payload.code, 'RN_ISO_NO_METRO');
    assert.match(payload.message, /no dev server/);
    assert.match(payload.remedy, /rn-iso start/);
  });

  // Without --json stdout stays untouched: the human path prints its diagnosis
  // on stderr and nothing captures stdout.
  test('without --json a failure still writes nothing to stdout', async () => {
    const { logs, exitCode } = await run({});
    assert.equal(exitCode, 1);
    assert.deepEqual(logs, []);
  });

  test('a build with no recognizable diagnostic falls back to the transcript tail', async () => {
    reserve();
    const { errs } = await run({}, {
      buildIos: async () => ({
        failed: true, code: 'RN_ISO_BUILD_FAILED', durationMs: 1000, truncated: 0,
        diagnostics: [], tail: ['xcodebuild: error: something inscrutable'],
      }),
    });
    assert.match(errs.join('\n'), /no recognizable diagnostic/);
    assert.match(errs.join('\n'), /something inscrutable/);
  });

  test('a failed build writes a Contract-4 record with the error code', async () => {
    reserve();
    await run({}, {
      buildIos: async () => ({ failed: true, code: 'RN_ISO_BUILD_FAILED', durationMs: 5000, diagnostics: [], tail: [] }),
    });
    const { lastBuild } = readWorkspaceState(root);
    assert.equal(lastBuild.status, 'failed');
    assert.equal(lastBuild.errorCode, 'RN_ISO_BUILD_FAILED');
    assert.equal(lastBuild.platform, 'ios');
    assert.equal(lastBuild.fingerprint, FINGERPRINT);
    assert.equal(lastBuild.cacheHit, false);
    assert.ok(lastBuild.startedAt);
  });

  test('a device that will not boot is refused before anything is fingerprinted or built', async () => {
    reserve();
    const { errs, exitCode, calls } = await run({}, {
      ensureBooted: async () => ({ failed: true, reason: 'Simulator BF2A no longer exists.' }),
    });
    assert.equal(exitCode, 1);
    assert.ok(!calls.order.includes('fingerprintProject'));
    assert.ok(!calls.order.includes('buildIos'));
    assert.match(errs.join('\n'), /no longer exists/);
  });

  test('a failed install is reported with its own code and a failed record', async () => {
    reserve();
    const { errs, exitCode } = await run({}, {
      installIosApp: () => ({ failed: true, code: 'RN_ISO_INSTALL_FAILED', reason: 'simctl install failed' }),
    });
    assert.equal(exitCode, 1);
    assert.match(errs.join('\n'), /RN_ISO_INSTALL_FAILED/);
    assert.equal(readWorkspaceState(root).lastBuild.errorCode, 'RN_ISO_INSTALL_FAILED');
  });
});

describe('success output', () => {
  test('the phase lines are stderr and the summary is the only line on stdout', async () => {
    reserve();
    const { logs, errs, exitCode } = await run({});
    assert.equal(exitCode, null);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^OK: com\.example\.app on rn-iso-fixture \(BF2A\.\.\), Metro port 8082/);
    const text = errs.join('\n');
    assert.match(text, /^device {6}rn-iso-fixture \(BF2A\.\.\) booted$/m);
    assert.match(text, /^fingerprint a3f9b1\.\. miss$/m);
    assert.match(text, /^build {7}ok \(2m41s\)$/m);
    assert.match(text, /^install {5}-> rn-iso-fixture \(BF2A\.\.\)$/m);
    assert.match(text, /^launch {6}com\.example\.app$/m);
  });

  test('--json emits exactly one line of facts on stdout', async () => {
    reserve();
    const { logs, appPath } = await run({ json: true });
    assert.equal(logs.length, 1);
    const facts = JSON.parse(logs[0]);
    assert.equal(facts.platform, 'ios');
    assert.equal(facts.udid, UDID);
    assert.equal(facts.deviceName, 'rn-iso-fixture');
    assert.equal(facts.fingerprint, FINGERPRINT);
    assert.match(facts.cacheKey, new RegExp(`^${FINGERPRINT}-debug-sim$`));
    assert.equal(facts.cacheHit, false);
    assert.equal(facts.appPath, appPath);
    assert.equal(facts.bundleId, 'com.example.app');
    assert.equal(facts.launched, true);
    assert.equal(facts.metroPort, 8082);
    assert.deepEqual(facts.logs, { dir: workspaceLogsDir(root) });
    assert.equal(typeof facts.durationMs, 'number');
  });

  test('the launch is recorded in the build log as a marker, so `logs --errors` can bound the window', async () => {
    reserve();
    await run({});
    const marker = buildRecords().find((r) => r.marker);
    assert.ok(marker, 'a marker record is written');
    assert.equal(marker.src, 'build');
    assert.match(marker.msg, /launched com\.example\.app on BF2A.* against Metro port 8082/);
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
    assert.equal(calls.args.launchIosApp.devClientScheme, 'fixture');
  });

  test('is undefined when the app config has no scheme: a plain launch plus RCT_jsLocation works everywhere', async () => {
    reserve();
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fixture' } }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'fixture', dependencies: { 'expo-dev-client': '5.0.0' },
    }));
    const { calls } = await run({}, { devClientScheme });
    assert.equal(calls.args.launchIosApp.devClientScheme, undefined);
  });

  test('is undefined without expo-dev-client, whose launcher is what answers the deep link', async () => {
    reserve();
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { scheme: 'fixture' } }));
    const { calls } = await run({}, { devClientScheme });
    assert.equal(calls.args.launchIosApp.devClientScheme, undefined);
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
    assert.deepEqual(h.kills, [{ pid: 999, signal: 'SIGTERM' }]);
    assert.equal(result.killed, 999);
    assert.equal(h.spawns.length, 1, 'exactly one fresh collector');
    assert.equal(result.pid, 7001);
  });

  test('a previous collector that is already gone (ESRCH) is not an error', async () => {
    const h = collectorHarness({
      state: { collectors: { ios: { pid: 999 } } },
      killImpl: () => { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e; },
    });
    const result = await replaceCollector(h.opts);
    assert.equal(result.killed, null);
    assert.equal(h.spawns.length, 1, 'the fresh collector still starts');
  });

  test('the collector is spawned detached, unref-ed, with the REAL app name from the .app path', async () => {
    const h = collectorHarness();
    await replaceCollector(h.opts);
    const { cmd, args, opts } = h.spawns[0];
    assert.equal(cmd, process.execPath);
    assert.equal(args[0], collectorEntry());
    assert.ok(existsSync(collectorEntry()), 'the entry point is a file that ships');
    assert.deepEqual(args.slice(1), [
      '--platform', 'ios',
      '--root', root,
      '--udid', UDID,
      '--bundle', 'com.example.app',
      '--app-name', 'FixtureDev',
    ]);
    assert.equal(opts.detached, true);
    assert.equal(opts.cwd, root);
  });

  test('the command hands it the app name derived from the .app basename', async () => {
    reserve();
    const { calls } = await run({}, {
      buildIos: async () => ({ appPath: '/tmp/dd/Build/Products/Debug-iphonesimulator/FixtureDev.app', bundleId: 'com.example.app', durationMs: 1000 }),
    });
    assert.equal(calls.args.replaceCollector.appName, 'FixtureDev');
    assert.equal(calls.args.replaceCollector.bundleId, 'com.example.app');
    assert.equal(calls.args.replaceCollector.udid, UDID);
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
    assert.deepEqual(state.supervisor, { pid: 4242, port: 8082, mode: 'bare-inproc' });
    assert.deepEqual(state.collectors, { android: { pid: 111 } });
    assert.equal(state.lastBuild.status, 'ok');
    assert.equal(state.lastBuild.cacheKey, `${FINGERPRINT}-debug-sim`);
    assert.equal(state.lastBuild.bundleId, 'com.example.app');
    assert.ok(!('errorCode' in state.lastBuild), 'a successful build carries no error code');
  });

  test('writeLastBuild survives a workspace it cannot write', () => {
    const record = lastBuildRecord({ startedAt: 'T', status: 'ok' });
    const written = writeLastBuild(root, record, {
      write: () => { throw new Error('EROFS'); },
    });
    assert.equal(written, record);
  });
});

// --- pure helpers ---------------------------------------------------------

describe('formatting', () => {
  test('durations read the way a build feels', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(18000), '18s');
    assert.equal(formatDuration(59400), '59s');
    assert.equal(formatDuration(161000), '2m41s');
    assert.equal(formatDuration(119600), '2m0s');
    assert.equal(formatDuration(undefined), '0s');
  });

  test('the short forms are recognizably abbreviations', () => {
    assert.equal(shortHash('a3f9b1c2d3'), 'a3f9b1..');
    assert.equal(shortHash('abc'), 'abc');
    assert.equal(shortUdid(UDID), 'BF2A..');
    assert.equal(deviceLabel({ deviceName: 'rn-iso-x' }, UDID), 'rn-iso-x (BF2A..)');
    assert.equal(deviceLabel(null, UDID), 'BF2A..');
  });

  test('every phase line starts its text at the same column', () => {
    assert.equal(phaseLine('device', 'x'), 'device      x');
    assert.equal(phaseLine('fingerprint', 'x'), 'fingerprint x');
    assert.equal(phaseLine('build', 'x'), 'build       x');
  });

  test('the app name comes from the .app basename, not the bundle id', () => {
    assert.equal(appNameFromPath('/a/b/MyAppDev.app'), 'MyAppDev');
    assert.equal(appNameFromPath('/a/b/My App.app'), 'My App');
    assert.equal(appNameFromPath(null), null);
    assert.equal(appNameFromPath(''), null);
  });
});

describe('podAction', () => {
  test('stale means install, and carries the reason to print', () => {
    assert.deepEqual(
      podAction({ hasPodfile: true }, { stale: true, reason: 'they differ' }),
      { install: true, reason: 'they differ' }
    );
  });

  test('no pods AND a Podfile is a fresh checkout: install', () => {
    assert.equal(podAction({ hasPodfile: true }, { noPods: true, stale: false }).install, true);
  });

  test('no pods and no Podfile is a project without CocoaPods: skip', () => {
    assert.deepEqual(podAction({ hasPodfile: false }, { noPods: true, stale: false }), { install: false });
  });

  test('in sync is a skip', () => {
    assert.deepEqual(podAction({ hasPodfile: true }, { stale: false }), { install: false });
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
    assert.equal(devClientScheme(project({ expo: { scheme: 'myapp' } }, withDevClient)), 'myapp');
  });

  test('takes the first of an array of schemes', () => {
    assert.equal(devClientScheme(project({ expo: { scheme: ['myapp', 'other'] } }, withDevClient)), 'myapp');
  });

  test('is undefined when there is no app.json at all', () => {
    assert.equal(devClientScheme(project(null, withDevClient)), undefined);
  });

  test('is undefined without expo-dev-client', () => {
    assert.equal(devClientScheme(project({ expo: { scheme: 'myapp' } }, { name: 'x' })), undefined);
  });

  // The BUILT app is the truth. app.json alone was the source, and a project
  // with a dynamic config (app.config.ts) has no scheme there at all -- so the
  // deep link was skipped and the app opened the dev-launcher's server picker.
  test('prefers the built app\'s Info.plist over app.json', () => {
    const dir = project({ expo: { scheme: 'from-app-json' } }, withDevClient);
    const exec = {
      runFile: (cmd, args) => {
        assert.equal(cmd, 'plutil');
        assert.deepEqual(args.slice(0, 4), ['-convert', 'json', '-o', '-']);
        assert.match(args[4], /Fixture\.app\/Info\.plist$/);
        return JSON.stringify({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['io.tlon.groups'] }] });
      },
    };
    assert.equal(devClientScheme(dir, '/b/Fixture.app', { exec }), 'io.tlon.groups');
  });

  test('falls back to app.json when the bundle cannot be read', () => {
    const dir = project({ expo: { scheme: 'from-app-json' } }, withDevClient);
    const exec = { runFile: () => { throw new Error('plutil: file does not exist'); } };
    assert.equal(devClientScheme(dir, '/b/Fixture.app', { exec }), 'from-app-json');
  });

  test('reads CFBundleURLTypes the way @expo/config-plugins does', () => {
    assert.deepEqual(
      schemesFromInfoPlist({ CFBundleURLTypes: [{ CFBundleURLSchemes: ['a'] }, { CFBundleTypeRole: 'Editor' }, { CFBundleURLSchemes: ['b', 'c'] }] }),
      ['a', 'b', 'c']
    );
    assert.deepEqual(schemesFromInfoPlist({}), []);
    assert.deepEqual(schemesFromInfoPlist(null), []);
  });

  describe('pickDevClientScheme', () => {
    test('prefers exp+<slug>, as Expo\'s own CLI does', () => {
      assert.equal(pickDevClientScheme(['myapp', 'exp+my-app']), 'exp+my-app');
    });

    test('drops third-party callback schemes rather than deep-linking through them', () => {
      // Verbatim from a real app's Info.plist. Expo's rule (longest wins)
      // picks the Google one; `fb...` is also declared by the Facebook app, so
      // which app iOS opens depends on what else is installed.
      const real = ['th3rdwave', 'fb555544564655381', 'com.googleusercontent.apps.869857856617-96dju1hh2u2361k8o6becusfvq74tv80'];
      assert.equal(pickDevClientScheme(real), 'th3rdwave');
    });

    test('otherwise the longest, which is Expo\'s uniqueness tie-break', () => {
      assert.equal(pickDevClientScheme(['a', 'io.tlon.groups']), 'io.tlon.groups');
      assert.equal(pickDevClientScheme(['https', 'mailto']), null);
      assert.equal(pickDevClientScheme([]), null);
      assert.equal(pickDevClientScheme(null), null);
    });
  });
});

describe('iosFacts', () => {
  test('launched is three-valued: true, or the string "unverified"', () => {
    const base = {
      udid: UDID, fingerprint: 'abc', cacheKey: 'k', cacheHit: false, appPath: '/a.app',
      bundleId: 'com.x', metroPort: 8082, logsDir: '/l', durationMs: 1,
    };
    assert.equal(iosFacts(base).launched, true);
    assert.equal(iosFacts({ ...base, launched: 'unverified' }).launched, 'unverified');
  });

  test('is the shape an agent parses', () => {
    assert.deepEqual(
      iosFacts({
        udid: UDID, deviceName: 'rn-iso-x', fingerprint: 'abc', cacheKey: 'abc-debug-sim',
        cacheHit: 'local', appPath: '/a/b.app', bundleId: 'com.x', metroPort: 8082,
        logsDir: '/w/.rn-iso/logs', durationMs: 1234,
      }),
      {
        platform: 'ios', udid: UDID, deviceName: 'rn-iso-x', fingerprint: 'abc',
        cacheKey: 'abc-debug-sim', cacheHit: 'local', cacheSkipped: false, waitedForBuild: null,
        appPath: '/a/b.app',
        bundleId: 'com.x', launched: true, metroPort: 8082, logs: { dir: '/w/.rn-iso/logs' },
        durationMs: 1234,
      }
    );
  });

  // A wait is reported ALONGSIDE cacheHit: 'local', never instead of it. The
  // artifact really did come from the local cache; what this adds is that it
  // was not there when the run started, and what it cost to get it.
  test('waitedForBuild names the builder waited on and what the wait cost', () => {
    const facts = iosFacts({ cacheHit: 'local', waitedForBuild: { pid: 41233, ms: 761000 } });
    assert.equal(facts.cacheHit, 'local');
    assert.deepEqual(facts.waitedForBuild, { pid: 41233, ms: 761000 });
  });

  // The enum is the point: an agent that reads `true` cannot tell a free
  // install from one that cost a download, and those are not the same thing to
  // plan around. Anything that is not a level rendered as `false`.
  test('cacheHit is a LEVEL, and an unknown value is a miss rather than a truthy string', () => {
    assert.equal(iosFacts({ cacheHit: 'remote' }).cacheHit, 'remote');
    assert.equal(iosFacts({ cacheHit: true }).cacheHit, false);
    assert.equal(iosFacts({ cacheHit: false }).cacheHit, false);
  });

  test('cacheSkipped separates "found nothing" from "was told not to look"', () => {
    assert.equal(iosFacts({ cacheHit: false }).cacheSkipped, false);
    assert.equal(iosFacts({ cacheHit: false, cacheSkipped: true }).cacheSkipped, true);
  });
});

describe('cacheDescription', () => {
  test('names the level the app came from, and the provider when it was the remote one', () => {
    assert.equal(cacheDescription(false), 'built');
    assert.equal(cacheDescription('local'), 'from cache');
    assert.equal(cacheDescription('remote', 'eas'), 'from eas');
    assert.equal(cacheDescription('remote', null), 'from the remote cache');
  });
});

// The fingerprint is scoped to iOS, so a change under android/ cannot move the
// iOS cache key. See the field note above fingerprintProject in
// src/build-cache.js for why this is not cosmetic.
test('ios fingerprints with platforms scoped to ios', async () => {
  reserve();
  const seen = [];
  await run({}, { fingerprintProject: async (path, options) => { seen.push({ path, options }); return FINGERPRINT; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, root);
  assert.equal(seen[0].options?.platform, 'ios');
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
  assert.equal(exitCode, 1);
  const payload = JSON.parse(logs[0]);
  assert.match(payload.message, /no recognizable diagnostic/);
  assert.match(payload.remedy, /build-ios\.ndjson/, 'with no diagnostic remedy, the log path is the next step');
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
    assert.equal(exitCode, null, 'a normal build succeeds');
    assert.equal(slotAcquired, 0, 'no slot is acquired when maxBuilds is unset');
    assert.ok(calls.order.includes('buildIos'));
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
    assert.equal(exitCode, 1);
    assert.equal(capacityArgs.max, 2);
    assert.match(errs.join('\n'), /RN_ISO_AT_CAPACITY/);
    assert.match(errs.join('\n'), /rn-iso stop/);
    assert.ok(!calls.order.includes('ensureOwnedDevice'), 'the refusal fires before any device is created/booted');
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
    assert.equal(exitCode, null);
    // Slot comes after the single-flight lock, before the compile, and is
    // released with the lock once the artifact is stored.
    assert.deepEqual(seq, ['lock', 'slot', 'build', 'releaseLock', 'releaseSlot']);
    assert.equal(slotArgs.max, 2);
    assert.equal(slotArgs.root, root);
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
    assert.equal(exitCode, null);
    assert.equal(slotAcquired, 0, 'a waiter must not take a build slot');
    assert.equal(built, 0, 'the waiter installs the cached artifact, it does not compile');
  });
});
