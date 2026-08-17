import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import {
  parseAvdList,
  parseAdbDevices,
  nextConsolePort,
  pickDefaultSystemImage,
  deleteAvd,
  resolveOwnedAvdSerial,
} from '../src/sim/android.js';

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

test('parseAvdList strips header and blanks', () => {
  const out = `INFO    | Storing AVDs in...\nPixel_6_API_34\nPixel_7_API_33\n`;
  const avds = parseAvdList(out);
  assert.deepEqual(avds, ['Pixel_6_API_34', 'Pixel_7_API_33']);
});

test('parseAdbDevices extracts running emulator console ports and physical devices', () => {
  const out = `List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n0123456789ABCDEF\tdevice\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.emulators.sort((a, b) => a.consolePort - b.consolePort), [
    { serial: 'emulator-5554', consolePort: 5554 },
    { serial: 'emulator-5556', consolePort: 5556 },
  ]);
  assert.deepEqual(result.physical, [{ serial: '0123456789ABCDEF' }]);
});

test('parseAdbDevices recognizes adb-over-TCP physical devices', () => {
  const out = `List of devices attached\n192.168.1.5:5555\tdevice\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.physical, [{ serial: '192.168.1.5:5555' }]);
  assert.deepEqual(result.emulators, []);
});

test('parseAdbDevices ignores offline emulators but reports them in unhealthy', () => {
  const out = `List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.emulators, [{ serial: 'emulator-5556', consolePort: 5556 }]);
  assert.deepEqual(result.unhealthy, [{ serial: 'emulator-5554', kind: 'emulator', consolePort: 5554, status: 'offline' }]);
});

test('parseAdbDevices surfaces unauthorized emulators in unhealthy', () => {
  const out = `List of devices attached\nemulator-5554\tunauthorized\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.emulators, []);
  assert.deepEqual(result.unhealthy, [{ serial: 'emulator-5554', kind: 'emulator', consolePort: 5554, status: 'unauthorized' }]);
});

test('parseAdbDevices surfaces unauthorized physical devices in unhealthy', () => {
  const out = `List of devices attached\nR5CR70ABCDE\tunauthorized\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.physical, []);
  assert.deepEqual(result.unhealthy, [{ serial: 'R5CR70ABCDE', kind: 'physical', status: 'unauthorized' }]);
});

test('nextConsolePort returns 5554 when none claimed', () => {
  assert.equal(nextConsolePort([]), 5554);
});

test('nextConsolePort returns next even port above max claimed', () => {
  assert.equal(nextConsolePort([5554, 5556]), 5558);
});

test('pickDefaultSystemImage prefers highest api, then google_apis, arm64 only', () => {
  const images = [
    { api: 35, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-35;default;arm64-v8a' },
    { api: 36, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-36;default;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'arm64-v8a', pkg: 'system-images;android-36;google_apis;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'x86_64', pkg: 'system-images;android-36;google_apis;x86_64' },
  ];
  assert.equal(pickDefaultSystemImage(images, {}).pkg, 'system-images;android-36;google_apis;arm64-v8a');
});

test('pickDefaultSystemImage honors an explicit package and returns null on no match', () => {
  const images = [{ api: 36, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-36;default;arm64-v8a' }];
  assert.equal(pickDefaultSystemImage(images, { systemImage: images[0].pkg }).pkg, images[0].pkg);
  assert.equal(pickDefaultSystemImage([], {}), null);
  assert.equal(pickDefaultSystemImage(images, { systemImage: 'system-images;android-99;x;y' }), null);
});

test('deleteAvd refuses to delete an AVD not owned by rn-iso', () => {
  setExecutor({
    run: () => { throw new Error('should not be called'); },
    runQuiet: () => { throw new Error('should not be called'); },
    spawn: () => null,
  });
  assert.throws(() => deleteAvd('Pixel_6_API_34'), /rn-iso/);
});

test('deleteAvd deletes an rn-iso-owned AVD', () => {
  let ran = null;
  setExecutor({
    run: () => null,
    runQuiet: (cmd) => { ran = cmd; return null; },
    spawn: () => null,
  });
  deleteAvd('rn-iso-my-project');
  assert.match(ran, /delete avd -n "rn-iso-my-project"/);
});

// --- resolveOwnedAvdSerial: identity verification, not port trust --------

test('resolveOwnedAvdSerial reports missing when the AVD does not exist at all', () => {
  setExecutor({
    run: (cmd) => (cmd === 'emulator -list-avds' ? '' : ''),
    runQuiet: () => null,
    spawn: () => null,
  });
  assert.deepEqual(resolveOwnedAvdSerial('rn-iso-gone', 5554), { missing: true });
});

test('resolveOwnedAvdSerial reports notOwned for a non-rn-iso AVD name', () => {
  setExecutor({
    run: (cmd) => (cmd === 'emulator -list-avds' ? 'Pixel_6_API_34\n' : ''),
    runQuiet: () => null,
    spawn: () => null,
  });
  assert.deepEqual(resolveOwnedAvdSerial('Pixel_6_API_34', 5554), { notOwned: true });
});

test('resolveOwnedAvdSerial resolves the live serial by AVD identity, not by port', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd === 'emulator -list-avds') return 'rn-iso-mine\n';
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n';
      return '';
    },
    runQuiet: (cmd) => {
      if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'rn-iso-mine\nOK';
      return null;
    },
    spawn: () => null,
  });
  assert.deepEqual(resolveOwnedAvdSerial('rn-iso-mine', 5554), { serial: 'emulator-5554' });
});

// The regression this fix exists for: the recorded consolePort is held by a
// FOREIGN emulator (a different AVD name answers on it), and our own AVD is
// not running anywhere else. Must report notRunning, never the foreign
// serial -- a caller that shuts down "whatever answers on the recorded
// port" would kill the user's own emulator.
test('resolveOwnedAvdSerial reports notRunning when the recorded port is held by a foreign emulator', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd === 'emulator -list-avds') return 'rn-iso-mine\n';
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n';
      return '';
    },
    runQuiet: (cmd) => {
      // The device on the recorded port identifies as a DIFFERENT AVD --
      // the user's own emulator took the slot.
      if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'Android_Studio_Default\nOK';
      return null;
    },
    spawn: () => null,
  });
  assert.deepEqual(resolveOwnedAvdSerial('rn-iso-mine', 5554), { notRunning: true });
});
