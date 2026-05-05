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
  sortAndroidCandidates,
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

// Mocks `emulator -list-avds`, `adb devices`, and `adb -s ... emu avd name`
// (used to map serial -> AVD name). avdByPort = { 5554: 'Pixel_6_API_34' }.
function mockExecutor({ avds, avdByPort = {} }) {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return avds.join('\n') + '\n';
      if (cmd === 'adb devices') {
        const lines = ['List of devices attached'];
        for (const port of Object.keys(avdByPort)) lines.push(`emulator-${port}\tdevice`);
        return lines.join('\n') + '\n';
      }
      throw new Error('unexpected run: ' + cmd);
    },
    runQuiet: (cmd) => {
      const m = cmd.match(/adb -s emulator-(\d+) emu avd name/);
      if (m) {
        const name = avdByPort[m[1]];
        return name ? `${name}\nOK\n` : null;
      }
      return null;
    },
    spawn: () => null,
  });
}

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

test('parseAdbDevices ignores offline emulators but reports them in unhealthy', () => {
  const out = `List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.emulators, [{ serial: 'emulator-5556', consolePort: 5556 }]);
  assert.deepEqual(result.unhealthy, [{ serial: 'emulator-5554', consolePort: 5554, status: 'offline' }]);
});

test('parseAdbDevices surfaces unauthorized emulators in unhealthy', () => {
  const out = `List of devices attached\nemulator-5554\tunauthorized\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.emulators, []);
  assert.deepEqual(result.unhealthy, [{ serial: 'emulator-5554', consolePort: 5554, status: 'unauthorized' }]);
});

test('nextConsolePort returns 5554 when none claimed', () => {
  assert.equal(nextConsolePort([]), 5554);
});

test('nextConsolePort returns next even port above max claimed', () => {
  assert.equal(nextConsolePort([5554, 5556]), 5558);
});

test('selectAndroidDevice prefers existing assignment when AVD still exists', () => {
  mockExecutor({ avds: ['Pixel_6_API_34'], avdByPort: {} });
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

test('selectAndroidDevice marks running and uses live port when AVD is running', () => {
  mockExecutor({ avds: ['Pixel_6_API_34'], avdByPort: { 5556: 'Pixel_6_API_34' } });
  const result = selectAndroidDevice({
    existingAvd: 'Pixel_6_API_34',
    existingConsolePort: 5554, // stale; the AVD is actually running on 5556
    claimedAvds: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.isRunning, true);
  assert.equal(result.consolePort, 5556);
});

test('selectAndroidDevice returns allocate with sorted unclaimed candidates', () => {
  mockExecutor({
    avds: ['Pixel_7_API_33', 'Pixel_6_API_34', 'Pixel_Tablet'],
    avdByPort: { 5556: 'Pixel_6_API_34' },
  });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingConsolePort: null,
    claimedAvds: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.kind, 'allocate');
  // Running AVD floats up; rest are alphabetical.
  assert.deepEqual(result.candidates.map(c => c.avdName), [
    'Pixel_6_API_34',
    'Pixel_7_API_33',
    'Pixel_Tablet',
  ]);
  assert.deepEqual(result.candidates.map(c => c.isRunning), [true, false, false]);
  assert.equal(result.candidates[0].consolePort, 5556);
});

test('selectAndroidDevice excludes claimed AVDs from candidates', () => {
  mockExecutor({ avds: ['Pixel_6', 'Pixel_7'], avdByPort: {} });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingConsolePort: null,
    claimedAvds: ['Pixel_6'],
    claimedConsolePorts: [5554],
  });
  assert.equal(result.kind, 'allocate');
  assert.deepEqual(result.candidates.map(c => c.avdName), ['Pixel_7']);
});

test('selectAndroidDevice returns allClaimed when AVDs exist but every one is claimed', () => {
  mockExecutor({ avds: ['Pixel_6', 'Pixel_7'], avdByPort: {} });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingConsolePort: null,
    claimedAvds: ['Pixel_6', 'Pixel_7'],
    claimedConsolePorts: [5554, 5556],
  });
  assert.equal(result.kind, 'allClaimed');
  assert.deepEqual(result.candidates.map(c => c.avdName).sort(), ['Pixel_6', 'Pixel_7']);
});

test('selectAndroidDevice returns noAvd when no AVDs exist', () => {
  mockExecutor({ avds: [], avdByPort: {} });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingConsolePort: null,
    claimedAvds: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.kind, 'noAvd');
});

test('sortAndroidCandidates puts running AVDs first, then alphabetical', () => {
  const sorted = sortAndroidCandidates([
    { avdName: 'Z_Tablet', isRunning: false, consolePort: null },
    { avdName: 'A_Phone', isRunning: false, consolePort: null },
    { avdName: 'M_Phone', isRunning: true, consolePort: 5554 },
  ]);
  assert.deepEqual(sorted.map(c => c.avdName), ['M_Phone', 'A_Phone', 'Z_Tablet']);
});
