import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createServer } from 'http';
import { buildFacts, registerUp } from '../src/commands/up.js';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { upsertProject, setDevice, getProject } from '../src/config.js';

let tmpHome;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});
afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

// --- buildFacts: pure shaping -------------------------------------------

test('buildFacts shapes the ios payload', () => {
  const facts = buildFacts({
    platform: 'ios',
    device: { deviceUdid: 'U1', owned: true, deviceName: 'rn-iso-app' },
    port: 8082,
    metro: { pid: 12, healthy: true, log: '/l.log' },
    bundleId: 'com.app',
    setup: { complete: true, commands: [] },
  });
  assert.deepEqual(facts, {
    platform: 'ios', udid: 'U1', owned: true, deviceName: 'rn-iso-app',
    metroPort: 8082, metroPid: 12, metroHealthy: true, metroLog: '/l.log',
    bundleId: 'com.app', setup: { complete: true, commands: [] },
  });
});

test('buildFacts shapes the android payload with serial and kind', () => {
  const facts = buildFacts({
    platform: 'android',
    device: { avdName: 'rn-iso-app', consolePort: 5554, owned: true },
    port: 8083,
    metro: { pid: 13, healthy: true, log: '/l.log' },
    bundleId: 'com.app',
    setup: null,
  });
  assert.equal(facts.serial, 'emulator-5554');
  assert.equal(facts.kind, 'emulator');
  assert.equal(facts.avdName, 'rn-iso-app');
  assert.equal(facts.consolePort, 5554);
  assert.equal(facts.udid, undefined);
});

test('buildFacts marks a physical android assignment', () => {
  const facts = buildFacts({
    platform: 'android',
    device: { serial: 'R5CT1234', owned: false },
    port: 8084,
    metro: { pid: null, healthy: false, log: null },
    bundleId: null,
    setup: null,
  });
  assert.equal(facts.kind, 'physical');
  assert.equal(facts.serial, 'R5CT1234');
  assert.equal(facts.owned, false);
});

// --- action-level: the wiring ------------------------------------------
//
// Real `xcrun simctl` mutation calls (create/boot/delete) cannot be run live
// on this machine (a wedged root daemon hangs them -- tracked separately),
// so the full pipeline is driven here with a mocked executor instead. Metro
// readiness is exercised for real: the mocked `spawn` starts an actual tiny
// HTTP server on the requested port that answers `/status`, so
// `ensureMetro`'s real polling (`waitForMetroReady`) resolves quickly
// instead of needing to fake network calls.

function captureAction(register) {
  let captured;
  const stub = {
    command() { return stub; },
    description() { return stub; },
    argument() { return stub; },
    option() { return stub; },
    action(fn) { captured = fn; return stub; },
  };
  register(stub);
  return (platform, opts = {}) => captured(platform, opts);
}

// findProjectRoot canonicalizes via realpath (so symlinked worktrees
// collapse to one key); macOS tmp dirs resolve through a symlink
// (/var -> /private/var), so the config key must be canonicalized the same
// way or a pre-registered project record will silently miss on lookup.
function canon(p) {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

function makeProjectDir() {
  const dir = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-proj-')));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch-app', dependencies: {} }));
  return dir;
}

// Same as makeProjectDir but with a bare-RN android/app/build.gradle so
// detectAndroidPackage resolves to a real value distinct from (null) iOS
// bundleId -- needed to prove the android payload uses the android package,
// not the iOS bundle id.
function makeAndroidProjectDir() {
  const dir = makeProjectDir();
  mkdirSync(join(dir, 'android', 'app'), { recursive: true });
  writeFileSync(
    join(dir, 'android', 'app', 'build.gradle'),
    'android {\n  defaultConfig {\n    applicationId "com.example.scratch"\n  }\n}\n'
  );
  return dir;
}

// A fake ANDROID_HOME with one installed arm64 system image, so
// createOwnedAvd's pickDefaultSystemImage has something to pick without
// needing --system-image.
function makeAndroidHome() {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-test-androidhome-'));
  mkdirSync(join(dir, 'system-images', 'android-34', 'google_apis', 'arm64-v8a'), { recursive: true });
  return dir;
}

// Spawns a real (tiny) HTTP server that answers Metro's /status probe, bound
// to whatever port the caller (ensureMetro) asked `npx ... start --port N`
// to use. Returns a fake child handle; the server is closed by the caller.
function fakeMetroSpawn(servers) {
  return (cmd, args) => {
    const idx = args.indexOf('--port');
    const port = Number(args[idx + 1]);
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('packager-status:running');
    });
    server.listen(port);
    servers.push(server);
    return { pid: 4242, unref() {} };
  };
}

const DEVICE_TYPES = JSON.stringify({
  devicetypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' }],
});
const RUNTIMES = JSON.stringify({
  runtimes: [{
    identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
    name: 'iOS 26.2',
    version: '26.2',
    isAvailable: true,
    platform: 'iOS',
    supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' }],
  }],
});

function mockExecutor({ simctlList = '{"devices":{}}', adbDevices = 'List of devices attached\n', spawnServers = [] } = {}) {
  const runCalls = [];
  return {
    calls: { run: runCalls },
    run(cmd) {
      runCalls.push(cmd);
      if (/git .*rev-parse/.test(cmd)) throw new Error('not a git repo');
      if (/simctl list devicetypes --json/.test(cmd)) return DEVICE_TYPES;
      if (/simctl list runtimes --json/.test(cmd)) return RUNTIMES;
      if (/simctl list devices --json/.test(cmd)) return simctlList;
      if (/simctl create/.test(cmd)) return 'NEW-UDID';
      if (/simctl boot/.test(cmd)) return '';
      if (/adb devices/.test(cmd)) return adbDevices;
      if (/adb .*reverse/.test(cmd)) return '';
      throw new Error('unexpected run: ' + cmd);
    },
    runQuiet(cmd) {
      try { return this.run(cmd); } catch { return null; }
    },
    spawn: fakeMetroSpawn(spawnServers),
  };
}

// Android action-level mock: unlike simctl, `adb`/`avdmanager`/`emulator`
// only touch the executor (never a wedged local daemon), so the Android
// half of `up` can be driven end to end here. `adbDevicesAfterBoot`, if
// given, is what `adb devices` reports once the boot-completed getprop call
// has fired once -- this lets a single mock simulate "adb sees nothing
// until the emulator finishes booting" for the reverse-after-boot
// assertion. `onBootCheck` fires the first time boot-completed is polled,
// so a test can inspect config state at exactly the moment the mocked boot
// call runs (proving the ownership record was written before boot, not
// after).
function mockAndroidExecutor({
  avds = [],
  adbDevicesBeforeBoot = 'List of devices attached\n',
  adbDevicesAfterBoot = null,
  spawnServers = [],
  onBootCheck = () => {},
} = {}) {
  const runCalls = [];
  const spawnCalls = [];
  let booted = false;
  const metroSpawn = fakeMetroSpawn(spawnServers);
  return {
    calls: { run: runCalls, spawn: spawnCalls },
    run(cmd) {
      runCalls.push(cmd);
      if (/git .*rev-parse/.test(cmd)) throw new Error('not a git repo');
      if (cmd === 'emulator -list-avds') return avds.length ? avds.join('\n') + '\n' : '';
      if (/create avd/.test(cmd)) return '';
      if (cmd === 'adb devices') {
        return booted && adbDevicesAfterBoot != null ? adbDevicesAfterBoot : adbDevicesBeforeBoot;
      }
      if (/shell getprop sys\.boot_completed/.test(cmd)) {
        if (!booted) {
          onBootCheck();
          booted = true;
        }
        return '1';
      }
      if (/shell getprop dev\.bootcomplete/.test(cmd)) return '0';
      if (/shell getprop init\.svc\.bootanim/.test(cmd)) return '';
      if (/adb .*reverse/.test(cmd)) return '';
      throw new Error('unexpected run: ' + cmd);
    },
    runQuiet(cmd) {
      try { return this.run(cmd); } catch { return null; }
    },
    spawn(cmd, args, opts) {
      spawnCalls.push({ cmd, args, opts });
      if (cmd === 'npx') return metroSpawn(cmd, args);
      return { pid: 9999, unref() {} };
    },
  };
}

test('action: --json prints exactly one parseable stdout line matching buildFacts shape (new owned ios device)', async () => {
  const root = makeProjectDir();
  const servers = [];
  const exec = mockExecutor({ spawnServers: servers });
  setExecutor(exec);

  const logs = [];
  const errs = [];
  const origLog = console.log, origErr = console.error, origExit = process.exit;
  console.log = (line) => logs.push(line);
  console.error = (line) => errs.push(line);
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('exit'); };

  try {
    const run = captureAction(registerUp);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await run('ios', { json: true });
    } finally {
      process.chdir(cwd);
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(exitCode, null);
  assert.equal(logs.length, 1, `expected exactly one stdout line, got: ${JSON.stringify(logs)}`);
  const facts = JSON.parse(logs[0]);
  assert.equal(facts.platform, 'ios');
  assert.equal(facts.owned, true);
  assert.match(facts.deviceName, /^rn-iso-/);
  assert.equal(typeof facts.metroPort, 'number');
  assert.equal(facts.metroHealthy, true);
  assert.ok(exec.calls.run.some(c => /simctl create/.test(c)));
  assert.ok(exec.calls.run.some(c => /simctl boot/.test(c)));
});

test('action: a legacy shut-down device is not booted, but Metro is still ensured', async () => {
  const root = makeProjectDir();
  upsertProject(root, { bundleId: null, androidPackage: null, isExpo: false });
  setDevice(root, 'ios', { deviceUdid: 'U1' }); // legacy: no `owned: true`
  assert.equal(getProject(root).platforms.ios.owned, undefined);

  const simctlList = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
        { udid: 'U1', name: 'iPhone 15', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  const servers = [];
  const exec = mockExecutor({ simctlList, spawnServers: servers });
  setExecutor(exec);

  const logs = [];
  const errs = [];
  const origLog = console.log, origErr = console.error, origExit = process.exit;
  console.log = (line) => logs.push(line);
  console.error = (line) => errs.push(line);
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('exit'); };

  try {
    const run = captureAction(registerUp);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await run('ios', { json: true });
    } finally {
      process.chdir(cwd);
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(exitCode, null);
  assert.ok(!exec.calls.run.some(c => /simctl boot/.test(c)), 'must never boot a legacy device');
  assert.equal(logs.length, 1);
  const facts = JSON.parse(logs[0]);
  assert.equal(facts.udid, 'U1');
  assert.equal(facts.owned, false);
  assert.equal(facts.metroHealthy, true);
  assert.ok(errs.some(e => /shut down|not owned|not booted/i.test(String(e))), 'expected a stderr note about the unbooted legacy device');
});

// --- Android action-level: the wiring -----------------------------------
//
// `adb`/`avdmanager`/`emulator` only touch the executor, so unlike simctl
// (wedged root daemon on this machine) the full Android pipeline can be
// mocked and driven here.

test('action: a legacy AVD not seen by adb is not booted, but Metro is still ensured', async () => {
  const root = makeAndroidProjectDir();
  upsertProject(root, { bundleId: null, androidPackage: 'com.example.scratch', isExpo: false });
  setDevice(root, 'android', { avdName: 'rn-iso-app', consolePort: 5554 }); // legacy: no `owned: true`
  assert.equal(getProject(root).platforms.android.owned, undefined);

  const servers = [];
  const exec = mockAndroidExecutor({ avds: ['rn-iso-app'], spawnServers: servers });
  setExecutor(exec);

  const logs = [];
  const errs = [];
  const origLog = console.log, origErr = console.error, origExit = process.exit;
  console.log = (line) => logs.push(line);
  console.error = (line) => errs.push(line);
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('exit'); };

  try {
    const run = captureAction(registerUp);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await run('android', { json: true });
    } finally {
      process.chdir(cwd);
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(exitCode, null);
  assert.ok(!exec.calls.spawn.some(c => c.cmd === 'emulator'), 'must never spawn the emulator for an unowned, not-running legacy AVD');
  assert.equal(logs.length, 1);
  const facts = JSON.parse(logs[0]);
  assert.equal(facts.avdName, 'rn-iso-app');
  assert.equal(facts.serial, 'emulator-5554');
  assert.equal(facts.owned, false);
  assert.equal(facts.metroHealthy, true);
  assert.ok(errs.some(e => /not owned/i.test(String(e))), 'expected a stderr note about the unbooted legacy AVD');
  assert.ok(errs.some(e => /skipping adb reverse/i.test(String(e))), 'expected a stderr note skipping adb reverse');
});

test('action: fresh project creates and records an owned AVD before boot, then reverses after boot', async () => {
  const root = makeAndroidProjectDir();
  const androidHome = makeAndroidHome();
  const prevAndroidHome = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = androidHome;

  const servers = [];
  let recordAtBootCheck;
  const exec = mockAndroidExecutor({
    avds: [],
    adbDevicesBeforeBoot: 'List of devices attached\n',
    adbDevicesAfterBoot: 'List of devices attached\nemulator-5554\tdevice\n',
    spawnServers: servers,
    // Fires the first time boot status is polled: proves the ownership
    // record exists BEFORE boot succeeds (fix 1), not just after.
    onBootCheck: () => {
      recordAtBootCheck = getProject(root)?.platforms?.android ?? null;
    },
  });
  setExecutor(exec);

  const logs = [];
  const errs = [];
  const origLog = console.log, origErr = console.error, origExit = process.exit;
  console.log = (line) => logs.push(line);
  console.error = (line) => errs.push(line);
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('exit'); };

  try {
    const run = captureAction(registerUp);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await run('android', { json: true });
    } finally {
      process.chdir(cwd);
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(androidHome, { recursive: true, force: true });
    if (prevAndroidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = prevAndroidHome;
  }

  assert.equal(exitCode, null);
  assert.ok(recordAtBootCheck, 'expected an ownership record to exist by the time boot is first polled');
  assert.equal(recordAtBootCheck.owned, true);
  assert.match(recordAtBootCheck.avdName, /^rn-iso-/);
  assert.equal(recordAtBootCheck.consolePort, 5554);

  assert.ok(exec.calls.run.some(c => /create avd/.test(c)), 'expected an avdmanager create avd call');
  assert.ok(
    exec.calls.spawn.some(c => c.cmd === 'emulator' && c.args.includes('-avd')),
    'expected an emulator -avd spawn'
  );
  assert.ok(
    exec.calls.run.some(c => /^adb -s emulator-5554 reverse tcp:\d+ tcp:\d+$/.test(c)),
    'expected adb reverse issued after boot'
  );

  assert.equal(logs.length, 1);
  const facts = JSON.parse(logs[0]);
  assert.equal(facts.platform, 'android');
  assert.equal(facts.kind, 'emulator');
  assert.equal(facts.owned, true);
  assert.equal(facts.serial, 'emulator-5554');
  assert.equal(facts.consolePort, 5554);
  assert.match(facts.avdName, /^rn-iso-/);
  assert.equal(facts.bundleId, 'com.example.scratch');
  assert.equal(facts.metroHealthy, true);
});
