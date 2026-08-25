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
  collectorEntry,
  deviceLabel,
  devClientScheme,
  formatDuration,
  iosFacts,
  lastBuildRecord,
  phaseLine,
  podAction,
  registerIos,
  replaceCollector,
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
    storeBuild: (platform, key, path) => {
      record('storeBuild', { platform, key, path });
      return path;
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
    assert.equal(facts.cacheHit, true);
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
        diagnostics: [
          { file: '/w/ios/AppDelegate.mm', line: 12, column: 4, message: "use of undeclared identifier 'foo'" },
          { message: 'The sandbox is not in sync with the Podfile.lock' },
        ],
        tail: ['** BUILD FAILED **'],
      }),
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(logs, [], 'stdout stays empty on failure, even in --json mode');
    const text = errs.join('\n');
    assert.match(text, /^build {7}FAILED after 2m41s/m);
    assert.match(text, /AppDelegate\.mm:12:4: use of undeclared identifier 'foo'/);
    assert.match(text, /The sandbox is not in sync/);
    assert.match(text, /and 3 more diagnostics in the log/);
    assert.match(text, new RegExp(`^log {9}${buildLogFile(root).replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}`, 'm'));
    assert.match(text, /^failed {6}RN_ISO_BUILD_FAILED/m);
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
});

describe('iosFacts', () => {
  test('is the shape an agent parses', () => {
    assert.deepEqual(
      iosFacts({
        udid: UDID, deviceName: 'rn-iso-x', fingerprint: 'abc', cacheKey: 'abc-debug-sim',
        cacheHit: true, appPath: '/a/b.app', bundleId: 'com.x', metroPort: 8082,
        logsDir: '/w/.rn-iso/logs', durationMs: 1234,
      }),
      {
        platform: 'ios', udid: UDID, deviceName: 'rn-iso-x', fingerprint: 'abc',
        cacheKey: 'abc-debug-sim', cacheHit: true, appPath: '/a/b.app', bundleId: 'com.x',
        launched: true, metroPort: 8082, logs: { dir: '/w/.rn-iso/logs' }, durationMs: 1234,
      }
    );
  });
});
