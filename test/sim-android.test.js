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
