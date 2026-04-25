import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import {
  parseAvdList,
  parseAdbDevices,
  selectAndroidDevice,
  nextConsolePort,
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

test('parseAdbDevices extracts running emulator console ports', () => {
  const out = `List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n0123456789ABCDEF\tdevice\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.emulators.sort((a, b) => a.consolePort - b.consolePort), [
    { serial: 'emulator-5554', consolePort: 5554 },
    { serial: 'emulator-5556', consolePort: 5556 },
  ]);
});

test('parseAdbDevices ignores offline emulators', () => {
  const out = `List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.emulators, [{ serial: 'emulator-5556', consolePort: 5556 }]);
});

test('nextConsolePort returns 5554 when none claimed', () => {
  assert.equal(nextConsolePort([]), 5554);
});

test('nextConsolePort returns next even port above max claimed', () => {
  assert.equal(nextConsolePort([5554, 5556]), 5558);
});

test('selectAndroidDevice prefers existing assignment when AVD still exists', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return 'Pixel_6_API_34\n';
      if (cmd.includes('adb devices')) return 'List of devices attached\n';
      throw new Error('unexpected: ' + cmd);
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const result = selectAndroidDevice({
    existingAvd: 'Pixel_6_API_34',
    existingConsolePort: 5554,
    claimedAvds: [],
    claimedConsolePorts: [],
  });
  assert.deepEqual(result, {
    kind: 'reuse',
    avdName: 'Pixel_6_API_34',
    consolePort: 5554,
    isRunning: false,
  });
});

test('selectAndroidDevice marks running when serial present in adb devices', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return 'Pixel_6_API_34\n';
      if (cmd.includes('adb devices')) return 'List of devices attached\nemulator-5554\tdevice\n';
      throw new Error('unexpected');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const result = selectAndroidDevice({
    existingAvd: 'Pixel_6_API_34',
    existingConsolePort: 5554,
    claimedAvds: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.isRunning, true);
});

test('selectAndroidDevice allocates first unclaimed AVD with next console port', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return 'Pixel_6_API_34\nPixel_7_API_33\n';
      if (cmd.includes('adb devices')) return 'List of devices attached\n';
      throw new Error('unexpected');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingConsolePort: null,
    claimedAvds: ['Pixel_6_API_34'],
    claimedConsolePorts: [5554],
  });
  assert.deepEqual(result, {
    kind: 'allocate',
    avdName: 'Pixel_7_API_33',
    consolePort: 5556,
    isRunning: false,
  });
});

test('selectAndroidDevice returns noAvd when no AVDs exist', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return '';
      if (cmd.includes('adb devices')) return 'List of devices attached\n';
      throw new Error('unexpected');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingConsolePort: null,
    claimedAvds: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.kind, 'noAvd');
});
