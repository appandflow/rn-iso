import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { buildIosCommand, buildAndroidCommand, buildMetroCommand, resolveSimNameByUdid } from '../src/runner.js';

afterEach(() => resetExecutor());

test('buildIosCommand uses expo run:ios when isExpo', () => {
  const cmd = buildIosCommand({ isExpo: true, udid: 'UDID-1', port: 8083, simName: 'iPhone 15' });
  assert.equal(cmd, 'npx expo run:ios --device UDID-1 --port 8083');
});

test('buildIosCommand uses react-native run-ios when bare and resolves sim name', () => {
  const cmd = buildIosCommand({ isExpo: false, udid: 'UDID-1', port: 8083, simName: 'iPhone 15' });
  assert.equal(cmd, 'npx react-native run-ios --simulator "iPhone 15" --port 8083');
});

test('buildAndroidCommand for expo uses --device serial', () => {
  const cmd = buildAndroidCommand({ isExpo: true, serial: 'emulator-5554', port: 8083 });
  assert.equal(cmd, 'npx expo run:android --device emulator-5554 --port 8083');
});

test('buildAndroidCommand for bare uses --deviceId and RCT_METRO_PORT env prefix', () => {
  const cmd = buildAndroidCommand({ isExpo: false, serial: 'emulator-5554', port: 8083 });
  assert.equal(cmd, 'RCT_METRO_PORT=8083 npx react-native run-android --deviceId emulator-5554');
});

test('buildMetroCommand picks expo or react-native', () => {
  assert.equal(buildMetroCommand({ isExpo: true, port: 8083 }), 'npx expo start --port 8083');
  assert.equal(buildMetroCommand({ isExpo: false, port: 8083 }), 'npx react-native start --port 8083');
});

test('resolveSimNameByUdid returns name from simctl JSON', () => {
  setExecutor({
    run: () => JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
          { udid: 'UDID-1', name: 'iPhone 15', state: 'Booted', isAvailable: true },
        ],
      },
    }),
    runQuiet: () => null,
    spawn: () => null,
  });
  assert.equal(resolveSimNameByUdid('UDID-1'), 'iPhone 15');
});

test('resolveSimNameByUdid throws when ambiguous', () => {
  setExecutor({
    run: () => JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
          { udid: 'UDID-1', name: 'iPhone 15', state: 'Booted', isAvailable: true },
          { udid: 'UDID-2', name: 'iPhone 15', state: 'Shutdown', isAvailable: true },
        ],
      },
    }),
    runQuiet: () => null,
    spawn: () => null,
  });
  assert.throws(
    () => resolveSimNameByUdid('UDID-1'),
    /ambiguous/i
  );
});
