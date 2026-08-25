// engine/device.js -- the booted guarantee.
//
// ensureOwnedDevice itself moved here verbatim from commands/up.js and is
// still covered by test/up.test.js through that module's re-export; what is
// new, and tested here, is ensureBooted: the wait that `ios` / `android` need
// because `simctl install` against a sim that is still "Booting" fails.
//
// The rule under test throughout is the ownership rule: a device that is not
// rn-iso's by name is never booted, only reported.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBooted } from '../src/engine/device.js';
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
    assert.match(result.reason, /rn-iso up ios/);
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
  test('never boots a physical device, only reports whether it is connected', async () => {
    setExecutor({
      run: (cmd) => (cmd === 'adb devices' ? 'List of devices attached' : ''),
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => { throw new Error('rn-iso must never try to boot hardware'); },
    });
    const result = await ensureBooted({ platform: 'android', device: { serial: 'R5CT10', kind: 'physical', owned: false } });
    assert.match(result.reason, /never boots hardware/);
  });
});

test('ensureBooted reports an unknown platform rather than throwing', async () => {
  assert.match((await ensureBooted({ platform: 'web', device: {} })).reason, /Unknown platform/);
});
