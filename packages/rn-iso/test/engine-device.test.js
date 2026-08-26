// engine/device.js -- the owned-device guarantee and the booted guarantee.
//
// Both halves live here now. `ensureOwnedDevice` used to be covered through
// commands/up.js and test/up.test.js; when v3 deleted that command, the
// ownership behaviours it pinned (CLAUDE.md item 2) were re-pinned here
// against the function directly, which is both the real home of the rule and
// a far smaller harness than driving a command was.
//
// The rule under test throughout is the ownership rule: a device that is not
// rn-iso's by name is never booted, only reported -- and, since v3 removed
// physical-device support, no path here ever issues a command at hardware.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceCapacityRefusal, deviceTypeMismatch, ensureBooted, ensureOwnedDevice } from '../src/engine/device.js';
import { getProject, setDevice, upsertProject } from '../src/config.js';
import { resetExecutor, setExecutor } from '../src/exec.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
  resetExecutor();
});

function simList(devices) {
  return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-2': devices } });
}

describe('ensureBooted: ios', () => {
  test('returns the udid without touching simctl boot when the sim is already Booted', async () => {
    const commands = [];
    setExecutor({
      run: (cmd) => { commands.push(cmd); return simList([{ udid: 'U1', name: 'rn-iso-app', state: 'Booted', isAvailable: true }]); },
      runQuiet: (cmd) => { commands.push(cmd); return ''; },
      runFile: () => '',
      spawn: () => null,
    });
    assert.deepEqual(await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1', owned: true } }), { ok: true, udid: 'U1' });
    assert.equal(commands.filter(c => c.includes('simctl boot')).length, 0);
  });

  test('boots a shut-down owned sim and waits for the Booted state', async () => {
    let listCalls = 0;
    const commands = [];
    setExecutor({
      run: (cmd) => {
        commands.push(cmd);
        if (cmd.includes('list devices')) {
          listCalls += 1;
          // Shutdown on the pre-boot resolve and the first poll, Booted after.
          const state = listCalls >= 3 ? 'Booted' : 'Shutdown';
          return simList([{ udid: 'U1', name: 'rn-iso-app', state, isAvailable: true }]);
        }
        return '';
      },
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => null,
    });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1', owned: true }, timeoutMs: 5000, pollMs: 5 });
    assert.deepEqual(result, { ok: true, udid: 'U1' });
    assert.equal(commands.filter(c => c === 'xcrun simctl boot U1').length, 1);
  });

  // The ownership rule: a sim renamed away from the rn-iso- prefix is
  // somebody's real simulator. Booting it would be exactly the mistake
  // resolveOwnedIosSim exists to prevent on the teardown side.
  test('refuses to boot a sim that is no longer rn-iso-owned by name', async () => {
    setExecutor({
      run: () => simList([{ udid: 'U1', name: 'My iPhone', state: 'Shutdown', isAvailable: true }]),
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => { throw new Error('must not boot a foreign sim'); },
    });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1' } });
    assert.equal(result.ok, undefined);
    assert.match(result.reason, /not rn-iso-owned/);
  });

  test('reports a sim that no longer exists rather than booting a stale udid', async () => {
    setExecutor({ run: () => simList([]), runQuiet: () => '', runFile: () => '', spawn: () => null });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'GONE' } });
    assert.match(result.reason, /no longer exists/);
    assert.match(result.reason, /rn-iso ios/);
  });

  test('times out with a reason instead of hanging when the sim never boots', async () => {
    setExecutor({
      run: (cmd) => (cmd.includes('list devices')
        ? simList([{ udid: 'U1', name: 'rn-iso-app', state: 'Booting', isAvailable: true }])
        : ''),
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => null,
    });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1' }, timeoutMs: 60, pollMs: 5 });
    assert.match(result.reason, /did not reach the Booted state/);
  });

  test('reports a missing record rather than throwing', async () => {
    setExecutor({ run: () => '', runQuiet: () => '', runFile: () => '', spawn: () => null });
    assert.match((await ensureBooted({ platform: 'ios', device: {} })).reason, /No iOS simulator is recorded/);
  });
});

describe('ensureBooted: android', () => {
  // "adb sees it" is not "the framework is up": `adb install` against an
  // emulator mid-boot fails with "Can't find service: package", so a running
  // emulator is still waited on.
  test('waits for boot completion on an already-running owned AVD', async () => {
    const commands = [];
    setExecutor({
      run: (cmd) => {
        commands.push(cmd);
        if (cmd === 'emulator -list-avds') return 'rn-iso-app';
        if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice';
        return '';
      },
      runQuiet: (cmd) => {
        commands.push(cmd);
        if (cmd.includes('emu avd name')) return 'rn-iso-app\nOK';
        if (cmd.includes('sys.boot_completed')) return '1';
        return '';
      },
      runFile: () => '',
      spawn: () => { throw new Error('must not boot an emulator that is already running'); },
    });
    const result = await ensureBooted({ platform: 'android', device: { avdName: 'rn-iso-app', consolePort: 5554, owned: true } });
    assert.deepEqual(result, { ok: true, serial: 'emulator-5554' });
  });

  test('boots a stopped owned AVD on its recorded port and waits', async () => {
    const spawned = [];
    let booted = false;
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'rn-iso-app';
        if (cmd === 'adb devices') return booted
          ? 'List of devices attached\nemulator-5556\tdevice'
          : 'List of devices attached';
        return '';
      },
      runQuiet: (cmd) => {
        if (cmd.includes('sys.boot_completed')) return booted ? '1' : '';
        return '';
      },
      runFile: () => '',
      spawn: (cmd, args) => { spawned.push([cmd, ...args]); booted = true; return { unref() {} }; },
    });
    const result = await ensureBooted({ platform: 'android', device: { avdName: 'rn-iso-app', consolePort: 5556, owned: true }, timeoutMs: 5000 });
    assert.deepEqual(result, { ok: true, serial: 'emulator-5556' });
    assert.deepEqual(spawned, [['emulator', '-avd', 'rn-iso-app', '-port', '5556']]);
  });

  // A console port is a slot, not an identity: Android Studio's default
  // emulator starts at 5554 too. Booting onto an occupied port silently
  // attaches this workspace to a foreign emulator.
  test('allocates a fresh console port when the recorded one is taken by a foreign emulator', async () => {
    const spawned = [];
    let ourSerial = null;
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'rn-iso-app';
        if (cmd === 'adb devices') {
          const rows = ['List of devices attached', 'emulator-5554\tdevice'];
          if (ourSerial) rows.push(`${ourSerial}\tdevice`);
          return rows.join('\n');
        }
        return '';
      },
      runQuiet: (cmd) => {
        if (cmd.includes('emu avd name')) return cmd.includes('5554') ? 'Pixel_7_API_35\nOK' : 'rn-iso-app\nOK';
        if (cmd.includes('sys.boot_completed')) return ourSerial ? '1' : '';
        return '';
      },
      runFile: () => '',
      spawn: (cmd, args) => {
        spawned.push([cmd, ...args]);
        ourSerial = `emulator-${args[args.indexOf('-port') + 1]}`;
        return { unref() {} };
      },
    });
    const result = await ensureBooted({ platform: 'android', device: { avdName: 'rn-iso-app', consolePort: 5554, owned: true }, timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.notEqual(result.serial, 'emulator-5554');
    assert.equal(spawned[0][4], result.serial.replace('emulator-', ''));
  });

  test('refuses an AVD that is not rn-iso-owned by name', async () => {
    setExecutor({
      run: (cmd) => (cmd === 'emulator -list-avds' ? 'Pixel_7_API_35' : ''),
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => { throw new Error('must not boot a foreign AVD'); },
    });
    const result = await ensureBooted({ platform: 'android', device: { avdName: 'Pixel_7_API_35' } });
    assert.match(result.reason, /not rn-iso-owned/);
  });

  // Hardware cannot be spawned: a physical record is reported, never booted.
  // v3 removed physical-device support entirely. A legacy record that names a
  // serial instead of an AVD must resolve to a refusal, and -- the part that
  // matters -- must issue NOTHING at that serial: no adb probe, no boot.
  test('refuses a legacy physical record without issuing a single command at it', async () => {
    setExecutor({
      run: (cmd) => { throw new Error(`rn-iso must not run "${cmd}" for a physical record`); },
      runQuiet: () => { throw new Error('rn-iso must not probe hardware'); },
      runFile: () => { throw new Error('rn-iso must not probe hardware'); },
      spawn: () => { throw new Error('rn-iso must never try to boot hardware'); },
    });
    const result = await ensureBooted({ platform: 'android', device: { serial: 'R5CT10', kind: 'physical', owned: false } });
    assert.equal(result.failed, true);
    assert.match(result.reason, /No owned Android emulator is recorded/);
  });
});

test('ensureBooted reports an unknown platform rather than throwing', async () => {
  assert.match((await ensureBooted({ platform: 'web', device: {} })).reason, /Unknown platform/);
});


// --- deviceTypeMismatch: pure --------------------------------------------
//
// Honouring the requested device type on REUSE, not just on creation: before
// this existed, asking for a different model against an existing environment
// silently booted the old one and the setting looked broken.

const TYPES = [
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', name: 'iPhone 16' },
];

test('deviceTypeMismatch returns null when nothing was requested', () => {
  assert.equal(deviceTypeMismatch(TYPES[0].identifier, undefined, TYPES), null);
});

test('deviceTypeMismatch returns null when the recorded sim is the requested type', () => {
  assert.equal(deviceTypeMismatch(TYPES[0].identifier, 'iPhone 17 Pro', TYPES), null);
});

test('deviceTypeMismatch describes the mismatch when the recorded sim is a different model', () => {
  const msg = deviceTypeMismatch(TYPES[1].identifier, 'iPhone 17 Pro', TYPES);
  assert.match(msg, /iPhone 16/);
  assert.match(msg, /iPhone 17 Pro/);
});

test('deviceTypeMismatch returns null when the requested type is unknown, leaving creation to error', () => {
  assert.equal(deviceTypeMismatch(TYPES[0].identifier, 'iPhone 99 Ultra', TYPES), null);
});

test('deviceTypeMismatch returns null when the recorded type is unknown', () => {
  assert.equal(deviceTypeMismatch(undefined, 'iPhone 17 Pro', TYPES), null);
});

// --- ensureOwnedDevice: the ownership rule --------------------------------

const DEVICE_TYPES_JSON = JSON.stringify({ devicetypes: TYPES });
const RUNTIMES_JSON = JSON.stringify({
  runtimes: [{
    identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
    name: 'iOS 26.2',
    version: '26.2',
    isAvailable: true,
    platform: 'iOS',
    supportedDeviceTypes: TYPES,
  }],
});

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-test-proj-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch-app' }));
  upsertProject(dir, { bundleId: null, androidPackage: null, isExpo: false });
  return dir;
}

function iosExecutor(devices) {
  const run = [];
  return {
    run,
    exec: {
      run(cmd) {
        run.push(cmd);
        if (/simctl list devicetypes --json/.test(cmd)) return DEVICE_TYPES_JSON;
        if (/simctl list runtimes --json/.test(cmd)) return RUNTIMES_JSON;
        if (/simctl list devices --json/.test(cmd)) return simList(devices);
        if (/simctl create/.test(cmd)) return 'NEW-UDID';
        if (/simctl boot/.test(cmd)) return '';
        throw new Error(`unexpected run: ${cmd}`);
      },
      runQuiet(cmd) { try { return this.run(cmd); } catch { return null; } },
      runFile() { return ''; },
      spawn() { return { pid: 1, unref() {} }; },
    },
  };
}

describe('ensureOwnedDevice: ios', () => {
  test('an owned record renamed away from rn-iso- ownership is never booted; a fresh owned sim is created', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'rn-iso-old' });
      const { run, exec } = iosExecutor([{ udid: 'U1', name: 'Renamed-By-User', state: 'Shutdown', isAvailable: true }]);
      setExecutor(exec);
      const notes = [];
      const result = await ensureOwnedDevice({
        platform: 'ios', project: getProject(root), projectPath: root, label: 'app',
        settings: {}, note: (l) => notes.push(String(l)),
      });
      assert.equal(run.some(c => c === 'xcrun simctl boot U1'), false, 'must never boot a sim no longer rn-iso-owned by name');
      assert.ok(run.some(c => /simctl create/.test(c)));
      assert.equal(result.deviceUdid, 'NEW-UDID');
      assert.equal(result.owned, true);
      assert.ok(notes.some(n => /not rn-iso-owned by name/i.test(n)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a legacy shut-down sim (no owned flag) is reported, never booted', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1' });
      const { run, exec } = iosExecutor([{ udid: 'U1', name: 'iPhone 16', state: 'Shutdown', isAvailable: true }]);
      setExecutor(exec);
      const notes = [];
      const result = await ensureOwnedDevice({
        platform: 'ios', project: getProject(root), projectPath: root, label: 'app',
        settings: {}, note: (l) => notes.push(String(l)),
      });
      assert.equal(run.some(c => /simctl boot/.test(c)), false, 'must never boot a legacy device');
      assert.equal(run.some(c => /simctl create/.test(c)), false, 'a live legacy record is reused, not replaced');
      assert.equal(result.deviceUdid, 'U1');
      assert.ok(!result.owned);
      assert.ok(notes.some(n => /not owned by rn-iso/i.test(n)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureOwnedDevice: android', () => {
  let androidHome;
  let prevAndroidHome;

  beforeEach(() => {
    androidHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-sdk-'));
    mkdirSync(join(androidHome, 'system-images', 'android-36', 'google_apis', 'arm64-v8a'), { recursive: true });
    prevAndroidHome = process.env.ANDROID_HOME;
    process.env.ANDROID_HOME = androidHome;
  });

  afterEach(() => {
    rmSync(androidHome, { recursive: true, force: true });
    if (prevAndroidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = prevAndroidHome;
  });

  function androidExecutor({ avds = [], createAvdError = null } = {}) {
    const run = [];
    const spawn = [];
    return {
      run,
      spawn,
      exec: {
        run(cmd) {
          run.push(cmd);
          if (cmd === 'emulator -list-avds') return avds.length ? `${avds.join('\n')}\n` : '';
          if (/create avd/.test(cmd)) {
            if (createAvdError) throw new Error(createAvdError);
            return '';
          }
          if (cmd === 'adb devices') return 'List of devices attached\n';
          if (/emu avd name/.test(cmd)) return '';
          if (/getprop sys\.boot_completed/.test(cmd)) return '1';
          if (/getprop /.test(cmd)) return '';
          throw new Error(`unexpected run: ${cmd}`);
        },
        runQuiet(cmd) { try { return this.run(cmd); } catch { return null; } },
        runFile() { return ''; },
        spawn(cmd, args, opts) { spawn.push({ cmd, args, opts }); return { pid: 9999, unref() {} }; },
      },
    };
  }

  // v3 removed physical-device support. A legacy `--serial` assignment must
  // resolve toward creating an owned emulator -- never toward a command aimed
  // at the hardware the record names.
  test('a legacy physical assignment is reported and replaced by an owned AVD, with nothing issued at the serial', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'android', { serial: 'R5CT10', kind: 'physical', owned: false });
      const { run, exec } = androidExecutor();
      setExecutor(exec);
      const notes = [];
      const result = await ensureOwnedDevice({
        platform: 'android', project: getProject(root), projectPath: root, label: 'app',
        settings: {}, note: (l) => notes.push(String(l)),
      });
      assert.equal(run.some(c => c.includes('R5CT10')), false, 'no command may name the physical serial');
      assert.equal(result.avdName, 'rn-iso-app');
      assert.equal(result.owned, true);
      assert.ok(notes.some(n => /no longer supports physical devices/i.test(n)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an existing AVD owned by ANOTHER project errors instead of being hijacked', async () => {
    const other = projectDir();
    const root = projectDir();
    try {
      setDevice(other, 'android', { avdName: 'rn-iso-app', consolePort: 5554, owned: true });
      const { exec } = androidExecutor({ avds: ['rn-iso-app'], createAvdError: 'Error: AVD rn-iso-app already exists.' });
      setExecutor(exec);
      await assert.rejects(
        ensureOwnedDevice({
          platform: 'android', project: getProject(root), projectPath: root, label: 'app',
          settings: {},
        }),
        /owned by another project/
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- device concurrency cap (opt-in) ---
// maxDevices refuses a NEW device once the machine is at the cap, but never
// refuses a workspace that already has a live device of its own (idempotent).
describe('deviceCapacityRefusal', () => {
  const booted = (udid, name) => ({ udid, name, state: 'Booted' });
  const shutdown = (udid, name) => ({ udid, name, state: 'Shutdown' });

  test('unlimited (max 0) never refuses', () => {
    const sims = [booted('u1', 'rn-iso-a'), booted('u2', 'rn-iso-b')];
    assert.equal(deviceCapacityRefusal({ platform: 'ios', project: {}, max: 0, sims, adb: { emulators: [] }, config: { projects: {} } }), null);
  });

  test('at the cap, a fresh workspace is refused with RN_ISO_AT_CAPACITY', () => {
    const sims = [booted('u1', 'rn-iso-a'), booted('u2', 'rn-iso-b')];
    const refusal = deviceCapacityRefusal({ platform: 'ios', project: { platforms: {} }, max: 2, sims, adb: { emulators: [] }, config: { projects: {} } });
    assert.equal(refusal.code, 'RN_ISO_AT_CAPACITY');
    assert.match(refusal.remedy, /rn-iso stop|maxDevices/);
  });

  test('a workspace whose OWN sim is already booted is never refused', () => {
    const sims = [booted('u1', 'rn-iso-a'), booted('u2', 'rn-iso-b')];
    const project = { platforms: { ios: { deviceUdid: 'u1', owned: true } } };
    assert.equal(deviceCapacityRefusal({ platform: 'ios', project, max: 2, sims, adb: { emulators: [] }, config: { projects: {} } }), null);
  });

  test('only BOOTED rn-iso sims count toward the cap', () => {
    const sims = [booted('u1', 'rn-iso-a'), shutdown('u2', 'rn-iso-b'), booted('u3', 'someone-else')];
    // One booted rn-iso sim, cap of 2 -> under cap, a fresh workspace is allowed.
    assert.equal(deviceCapacityRefusal({ platform: 'ios', project: { platforms: {} }, max: 2, sims, adb: { emulators: [] }, config: { projects: {} } }), null);
  });

  test('a running owned Android emulator counts via the registry', () => {
    const config = { projects: { '/w/x': { platforms: { android: { avdName: 'rn-iso-x', consolePort: 5556, owned: true } } } } };
    const adb = { emulators: [{ consolePort: 5556 }] };
    const refusal = deviceCapacityRefusal({ platform: 'android', project: { platforms: {} }, max: 1, sims: [], adb, config });
    assert.equal(refusal.code, 'RN_ISO_AT_CAPACITY');
  });
});
