import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createServer } from 'http';
import { buildFacts, registerUp } from '../src/commands/up.js';
import { isMetroRunning } from '../src/ports.js';
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
    metro: { healthy: true },
    bundleId: 'com.app',
  });
  assert.deepEqual(facts, {
    platform: 'ios', udid: 'U1', owned: true, deviceName: 'rn-iso-app',
    metroPort: 8082, metroHealthy: true, metroConflict: null,
    bundleId: 'com.app',
  });
});

test('buildFacts shapes the android payload with serial and kind', () => {
  const facts = buildFacts({
    platform: 'android',
    device: { avdName: 'rn-iso-app', consolePort: 5554, owned: true },
    port: 8083,
    metro: { pid: 13, healthy: true, log: '/l.log' },
    bundleId: 'com.app',
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
  });
  assert.equal(facts.kind, 'physical');
  assert.equal(facts.serial, 'R5CT1234');
  assert.equal(facts.owned, false);
});

// --- action-level: the wiring ------------------------------------------
//
// Real `xcrun simctl` mutation calls (create/boot/delete) cannot be run live
// on this machine (a wedged root daemon hangs them -- tracked separately),
// so the full pipeline is driven here with a mocked executor instead. `up` no
// longer starts Metro, so metroHealthy is false throughout these fixtures; the
// healthy path is pinned separately at the bottom of this file against a real
// listener, since metroHealthy is a real /status request.

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

// Returns a fake child handle for spawns. rn-iso no longer spawns Metro, so
// the only spawn reaching here is the Android emulator; the --port branch is
// kept so a caller that does ask for a port still gets a real /status
// responder rather than silently getting nothing.
function fakeMetroSpawn(servers) {
  return (cmd, args) => {
    const idx = args.indexOf('--port');
    if (idx === -1) return { pid: 4242, unref() {} };
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
  // Maps serial (e.g. "emulator-5554") -> the AVD name `adb emu avd name`
  // should report for it, so resolveOwnedAvdSerial's identity check can be
  // exercised (including a serial that answers with a DIFFERENT AVD name
  // than the caller expects -- the foreign-emulator regression case).
  emuAvdNames = {},
  // If set, `avdmanager create avd` throws this message instead of
  // succeeding -- used to exercise the "already exists" recovery path.
  createAvdError = null,
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
      if (/create avd/.test(cmd)) {
        if (createAvdError) throw new Error(createAvdError);
        return '';
      }
      if (cmd === 'adb devices') {
        return booted && adbDevicesAfterBoot != null ? adbDevicesAfterBoot : adbDevicesBeforeBoot;
      }
      const emuAvdNameMatch = cmd.match(/^adb -s (\S+) emu avd name$/);
      if (emuAvdNameMatch) {
        const name = emuAvdNames[emuAvdNameMatch[1]];
        return name ? `${name}\nOK` : '';
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
  assert.equal(facts.metroHealthy, false, 'up reserves the port but does not start Metro');
  assert.ok(exec.calls.run.some(c => /simctl create/.test(c)));
  assert.ok(exec.calls.run.some(c => /simctl boot/.test(c)));
});

// I5 regression: an owned record's udid must be re-verified by NAME
// against the live sim list before booting -- a raw udid lookup would boot
// whatever simulator that udid now resolves to, even a foreign one the
// user renamed away from rn-iso- ownership.
test('action: an owned record renamed away from rn-iso- ownership is not booted; a fresh owned sim is created instead', async () => {
  const root = makeProjectDir();
  upsertProject(root, { bundleId: null, androidPackage: null, isExpo: false });
  setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'rn-iso-old' });

  const simctlList = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
        // U1 is now named something the user renamed it to -- no longer
        // rn-iso-owned by name, even though the record says owned: true.
        { udid: 'U1', name: 'Renamed-By-User', state: 'Booted', isAvailable: true },
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
  // U1 (the renamed sim) must never be booted.
  assert.equal(exec.calls.run.some(c => c === 'xcrun simctl boot U1'), false, 'must never boot a sim no longer rn-iso-owned by name');
  // A fresh owned sim is created and booted instead.
  assert.ok(exec.calls.run.some(c => /simctl create/.test(c)));
  assert.ok(exec.calls.run.some(c => c === 'xcrun simctl boot NEW-UDID'));
  assert.ok(errs.some(e => /not rn-iso-owned by name/i.test(String(e))));

  assert.equal(logs.length, 1);
  const facts = JSON.parse(logs[0]);
  assert.equal(facts.udid, 'NEW-UDID');
  assert.equal(facts.owned, true);
});

test('action: a legacy shut-down device is not booted, and the port is reserved without starting Metro', async () => {
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
  assert.equal(facts.metroHealthy, false, 'up reserves the port but does not start Metro');
  assert.ok(errs.some(e => /shut down|not owned|not booted/i.test(String(e))), 'expected a stderr note about the unbooted legacy device');
});

// --- Android action-level: the wiring -----------------------------------
//
// `adb`/`avdmanager`/`emulator` only touch the executor, so unlike simctl
// (wedged root daemon on this machine) the full Android pipeline can be
// mocked and driven here.

test('action: a legacy AVD not seen by adb is not booted, and the port is reserved without starting Metro', async () => {
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
  assert.equal(facts.metroHealthy, false, 'up reserves the port but does not start Metro');
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
  assert.equal(facts.metroHealthy, false, 'up reserves the port but does not start Metro');
});

// I6: an owned Android record must be reused by verifying the running
// emulator's IDENTITY (adb emu avd name), not just by trusting the
// recorded console port.

test('action: an owned AVD genuinely running at the recorded port is reused by identity, without rebooting', async () => {
  const root = makeAndroidProjectDir();
  upsertProject(root, { bundleId: null, androidPackage: 'com.example.scratch', isExpo: false });
  setDevice(root, 'android', { avdName: 'rn-iso-app', consolePort: 5554, owned: true, deviceName: 'rn-iso-app' });

  const servers = [];
  const exec = mockAndroidExecutor({
    avds: ['rn-iso-app'],
    adbDevicesBeforeBoot: 'List of devices attached\nemulator-5554\tdevice\n',
    emuAvdNames: { 'emulator-5554': 'rn-iso-app' },
    spawnServers: servers,
  });
  setExecutor(exec);

  const logs = [];
  const origLog = console.log, origExit = process.exit;
  console.log = (line) => logs.push(line);
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
    process.exit = origExit;
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(exitCode, null);
  assert.ok(!exec.calls.spawn.some(c => c.cmd === 'emulator'), 'must not boot an already-running owned emulator');
  assert.equal(logs.length, 1);
  const facts = JSON.parse(logs[0]);
  assert.equal(facts.owned, true);
  assert.equal(facts.avdName, 'rn-iso-app');
  assert.equal(facts.serial, 'emulator-5554');
  assert.equal(facts.consolePort, 5554);
});

test('action: recorded port held by a foreign emulator is treated as not running; ours boots on a freshly allocated port', async () => {
  const root = makeAndroidProjectDir();
  upsertProject(root, { bundleId: null, androidPackage: 'com.example.scratch', isExpo: false });
  setDevice(root, 'android', { avdName: 'rn-iso-app', consolePort: 5554, owned: true, deviceName: 'rn-iso-app' });

  const servers = [];
  let recordAtBootCheck;
  const exec = mockAndroidExecutor({
    avds: ['rn-iso-app'],
    // The recorded port (5554) is occupied, but by a FOREIGN emulator --
    // its identity does not match our owned AVD name.
    adbDevicesBeforeBoot: 'List of devices attached\nemulator-5554\tdevice\n',
    adbDevicesAfterBoot: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n',
    emuAvdNames: { 'emulator-5554': 'Android_Studio_Default', 'emulator-5556': 'rn-iso-app' },
    spawnServers: servers,
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
  }

  assert.equal(exitCode, null);
  // Never told to boot on the recorded (foreign-held) port.
  assert.ok(
    !exec.calls.spawn.some(c => c.cmd === 'emulator' && c.args.includes('5554')),
    'must never boot our AVD onto a port a foreign emulator holds'
  );
  // Booted on a freshly allocated port instead (5556, the next free one
  // given 5554 is already live).
  assert.ok(
    exec.calls.spawn.some(c => c.cmd === 'emulator' && c.args.includes('5556')),
    'expected our AVD to boot on a freshly allocated port'
  );
  assert.ok(recordAtBootCheck, 'expected an ownership record to exist by the time boot is first polled');
  assert.equal(recordAtBootCheck.avdName, 'rn-iso-app');
  assert.equal(recordAtBootCheck.consolePort, 5556);

  assert.equal(logs.length, 1);
  const facts = JSON.parse(logs[0]);
  assert.equal(facts.owned, true);
  assert.equal(facts.avdName, 'rn-iso-app');
  assert.equal(facts.serial, 'emulator-5556');
  assert.equal(facts.consolePort, 5556);
});

// Label-collision guard: avdmanager's "already exists" recovery path exists
// for a project's own abandoned AVD from a prior run, not for silently
// adopting a DIFFERENT project's AVD just because an unset --label
// sanitized to the same name.
test('action: creating an AVD that already exists AND is owned by another project errors instead of hijacking it', async () => {
  const root = makeAndroidProjectDir();
  const androidHome = makeAndroidHome();
  const prevAndroidHome = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = androidHome;

  upsertProject(root, { label: 'shared', bundleId: null, androidPackage: 'com.example.scratch', isExpo: false });
  upsertProject('/other/proj', { label: 'other', platforms: { android: { avdName: 'rn-iso-shared', consolePort: 5554, owned: true } } });

  const servers = [];
  const exec = mockAndroidExecutor({
    avds: ['rn-iso-shared'],
    createAvdError: 'Error: AVD name "rn-iso-shared" already exists.',
    spawnServers: servers,
  });
  setExecutor(exec);

  const errs = [];
  const origErr = console.error, origExit = process.exit;
  console.error = (line) => errs.push(line);
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('exit'); };

  try {
    const run = captureAction(registerUp);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await run('android', { json: true });
    } catch (e) {
      if (!/exit/.test(e.message)) throw e;
    } finally {
      process.chdir(cwd);
    }
  } finally {
    console.error = origErr;
    process.exit = origExit;
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(androidHome, { recursive: true, force: true });
    if (prevAndroidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = prevAndroidHome;
  }

  assert.equal(exitCode, 1);
  assert.ok(errs.some(e => /already exists and is owned by another project/i.test(String(e)) && /--label/.test(String(e))));
  // The AVD was never adopted for this project.
  assert.equal(getProject(root)?.platforms?.android, undefined);
});

test('buildFacts no longer reports metroPid or metroLog', () => {
  const facts = buildFacts({
    platform: 'ios',
    device: { owned: true, deviceUdid: 'ABC', deviceName: 'rn-iso-x' },
    port: 8082,
    metro: { healthy: false },
    bundleId: 'io.example.app',
  });
  assert.equal(facts.metroPort, 8082);
  assert.equal(facts.metroHealthy, false);
  assert.equal('metroPid' in facts, false);
  assert.equal('metroLog' in facts, false);
});

test('buildFacts reports metroHealthy true when the probe found Metro', () => {
  const facts = buildFacts({
    platform: 'ios',
    device: { owned: true, deviceUdid: 'ABC' },
    port: 8082,
    metro: { healthy: true },
    bundleId: null,
  });
  assert.equal(facts.metroHealthy, true);
});

// The assertions above pin "up does not start Metro". This pins the other half
// of the contract: when the agent HAS started Metro on the reserved port, up
// reports it healthy. Uses a real listener, since metroHealthy is a real
// /status request.
test('action: up reports metroHealthy true when a real Metro is already on the reserved port', async () => {
  const { createServer } = await import('node:http');
  const port = 8137;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('packager-status:running');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    const healthy = await isMetroRunning(port);
    assert.equal(healthy, true, 'sanity: the probe must see the real listener');
    const facts = buildFacts({
      platform: 'ios',
      device: { owned: true, deviceUdid: 'U1' },
      port,
      metro: { healthy },
      bundleId: null,
    });
    assert.equal(facts.metroHealthy, true);
    assert.equal(facts.metroPort, port);
  } finally {
    server.close();
  }
});

// Finding 1: metroHealthy must not treat the port as identity. A foreign
// listener that answers /status on our reserved port made up report healthy,
// and SKILL tells agents to build once healthy -- so the agent would have
// built against someone else's bundler.
test('buildFacts reports a conflict when something else holds the reserved port', () => {
  const facts = buildFacts({
    platform: 'ios',
    device: { owned: true, deviceUdid: 'U1' },
    port: 8082,
    metro: { healthy: false, conflict: 'pid 9 on port 8082 runs from /elsewhere, outside /p' },
    bundleId: null,
  });
  assert.equal(facts.metroHealthy, false);
  assert.match(facts.metroConflict, /elsewhere/);
});

test('buildFacts reports metroConflict null when the port is ours or free', () => {
  const ours = buildFacts({
    platform: 'ios', device: { owned: true, deviceUdid: 'U1' }, port: 8082,
    metro: { healthy: true }, bundleId: null, setup: null,
  });
  assert.equal(ours.metroHealthy, true);
  assert.equal(ours.metroConflict, null);

  const free = buildFacts({
    platform: 'ios', device: { owned: true, deviceUdid: 'U1' }, port: 8082,
    metro: { healthy: false }, bundleId: null, setup: null,
  });
  assert.equal(free.metroHealthy, false);
  assert.equal(free.metroConflict, null);
});
