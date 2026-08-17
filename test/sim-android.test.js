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
  pickDefaultSystemImage,
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
// physicalSerials = ['R5CR70XXXXX'] surface as connected hardware devices.
function mockExecutor({ avds, avdByPort = {}, physicalSerials = [] }) {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return avds.join('\n') + '\n';
      if (cmd === 'adb devices') {
        const lines = ['List of devices attached'];
        for (const port of Object.keys(avdByPort)) lines.push(`emulator-${port}\tdevice`);
        for (const s of physicalSerials) lines.push(`${s}\tdevice`);
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

test('selectAndroidDevice prefers existing assignment when AVD still exists', () => {
  mockExecutor({ avds: ['Pixel_6_API_34'], avdByPort: {} });
  const result = selectAndroidDevice({
    existingAvd: 'Pixel_6_API_34',
    existingSerial: null,
    existingConsolePort: 5554,
    claimedAvds: [],
    claimedSerials: [],
    claimedConsolePorts: [],
  });
  assert.deepEqual(result, {
    kind: 'reuse',
    deviceKind: 'avd',
    avdName: 'Pixel_6_API_34',
    consolePort: 5554,
    isRunning: false,
  });
});

test('selectAndroidDevice marks running and uses live port when AVD is running', () => {
  mockExecutor({ avds: ['Pixel_6_API_34'], avdByPort: { 5556: 'Pixel_6_API_34' } });
  const result = selectAndroidDevice({
    existingAvd: 'Pixel_6_API_34',
    existingSerial: null,
    existingConsolePort: 5554, // stale; the AVD is actually running on 5556
    claimedAvds: [],
    claimedSerials: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.deviceKind, 'avd');
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
    existingSerial: null,
    existingConsolePort: null,
    claimedAvds: [],
    claimedSerials: [],
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
    existingSerial: null,
    existingConsolePort: null,
    claimedAvds: ['Pixel_6'],
    claimedSerials: [],
    claimedConsolePorts: [5554],
  });
  assert.equal(result.kind, 'allocate');
  assert.deepEqual(result.candidates.map(c => c.avdName), ['Pixel_7']);
});

test('selectAndroidDevice returns allClaimed when AVDs exist but every one is claimed', () => {
  mockExecutor({ avds: ['Pixel_6', 'Pixel_7'], avdByPort: {} });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingSerial: null,
    existingConsolePort: null,
    claimedAvds: ['Pixel_6', 'Pixel_7'],
    claimedSerials: [],
    claimedConsolePorts: [5554, 5556],
  });
  assert.equal(result.kind, 'allClaimed');
  assert.deepEqual(result.candidates.map(c => c.avdName).sort(), ['Pixel_6', 'Pixel_7']);
});

test('selectAndroidDevice returns noAvd when no AVDs and no physical devices exist', () => {
  mockExecutor({ avds: [], avdByPort: {} });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingSerial: null,
    existingConsolePort: null,
    claimedAvds: [],
    claimedSerials: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.kind, 'noAvd');
});

test('selectAndroidDevice includes physical devices in candidates', () => {
  mockExecutor({
    avds: ['Pixel_6'],
    avdByPort: {},
    physicalSerials: ['R5CR70XXXXX'],
  });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingSerial: null,
    existingConsolePort: null,
    claimedAvds: [],
    claimedSerials: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.kind, 'allocate');
  // Physical (always running) floats above the shutdown AVD.
  assert.deepEqual(result.candidates.map(c => c.kind), ['physical', 'avd']);
  assert.equal(result.candidates[0].serial, 'R5CR70XXXXX');
  assert.equal(result.candidates[1].avdName, 'Pixel_6');
});

test('selectAndroidDevice surfaces physical devices even when no AVDs exist', () => {
  mockExecutor({
    avds: [],
    avdByPort: {},
    physicalSerials: ['R5CR70XXXXX'],
  });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingSerial: null,
    existingConsolePort: null,
    claimedAvds: [],
    claimedSerials: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.kind, 'allocate');
  assert.deepEqual(result.candidates.map(c => c.kind), ['physical']);
  assert.equal(result.candidates[0].serial, 'R5CR70XXXXX');
});

test('selectAndroidDevice reuses existing physical-device assignment', () => {
  mockExecutor({
    avds: [],
    avdByPort: {},
    physicalSerials: ['R5CR70XXXXX'],
  });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingSerial: 'R5CR70XXXXX',
    existingConsolePort: null,
    claimedAvds: [],
    claimedSerials: [],
    claimedConsolePorts: [],
  });
  assert.deepEqual(result, {
    kind: 'reuse',
    deviceKind: 'physical',
    serial: 'R5CR70XXXXX',
    isRunning: true,
  });
});

test('selectAndroidDevice excludes claimed physical serials from candidates', () => {
  mockExecutor({
    avds: [],
    avdByPort: {},
    physicalSerials: ['R5CR70AAA', 'R5CR70BBB'],
  });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingSerial: null,
    existingConsolePort: null,
    claimedAvds: [],
    claimedSerials: ['R5CR70AAA'],
    claimedConsolePorts: [],
  });
  assert.equal(result.kind, 'allocate');
  assert.deepEqual(result.candidates.map(c => c.serial), ['R5CR70BBB']);
});

test('sortAndroidCandidates puts running AVDs first, then alphabetical', () => {
  const sorted = sortAndroidCandidates([
    { kind: 'avd', avdName: 'Z_Tablet', isRunning: false, consolePort: null },
    { kind: 'avd', avdName: 'A_Phone', isRunning: false, consolePort: null },
    { kind: 'avd', avdName: 'M_Phone', isRunning: true, consolePort: 5554 },
  ]);
  assert.deepEqual(sorted.map(c => c.avdName), ['M_Phone', 'A_Phone', 'Z_Tablet']);
});

test('sortAndroidCandidates floats physical devices above non-running AVDs', () => {
  const sorted = sortAndroidCandidates([
    { kind: 'avd', avdName: 'Pixel_6', isRunning: false, consolePort: null },
    { kind: 'physical', serial: 'R5CR70XXX', isRunning: true, consolePort: null },
    { kind: 'avd', avdName: 'Pixel_7_running', isRunning: true, consolePort: 5554 },
  ]);
  // Running first (physical and running AVD), shutdown AVDs last. Physical
  // floats above running AVDs within the running group.
  assert.deepEqual(sorted.map(c => c.kind === 'physical' ? c.serial : c.avdName), [
    'R5CR70XXX',
    'Pixel_7_running',
    'Pixel_6',
  ]);
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
