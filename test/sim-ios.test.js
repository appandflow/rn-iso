import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { parseSimctlList, listAllIosSims, listBootedIosSims, parseOccupyingApps, pickDefaultIosCreation, sanitizeDeviceLabel, deleteIosSim } from '../src/sim/ios.js';

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

const SIMCTL_OUTPUT = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
      { udid: 'UDID-A', name: 'iPhone 15', state: 'Booted', isAvailable: true },
      { udid: 'UDID-B', name: 'iPhone 15 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'UDID-C', name: 'iPhone 14', state: 'Booted', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-0': [
      { udid: 'UDID-OLD', name: 'iPhone 13', state: 'Shutdown', isAvailable: false },
    ],
  },
});

test('parseSimctlList flattens devices and filters unavailable', () => {
  const sims = parseSimctlList(SIMCTL_OUTPUT);
  assert.equal(sims.length, 3);
  assert.deepEqual(sims.map(s => s.udid).sort(), ['UDID-A', 'UDID-B', 'UDID-C']);
});

test('parseSimctlList includes runtime in each entry', () => {
  const sims = parseSimctlList(SIMCTL_OUTPUT);
  const a = sims.find(s => s.udid === 'UDID-A');
  assert.equal(a.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-17-2');
});

test('listAllIosSims uses simctl via executor', () => {
  setExecutor({
    run: (cmd) => {
      assert.match(cmd, /xcrun simctl list devices --json/);
      return SIMCTL_OUTPUT;
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const sims = listAllIosSims();
  assert.equal(sims.length, 3);
});

test('listBootedIosSims filters by state', () => {
  setExecutor({
    run: () => SIMCTL_OUTPUT,
    runQuiet: () => null,
    spawn: () => null,
  });
  const booted = listBootedIosSims();
  assert.deepEqual(booted.map(s => s.udid).sort(), ['UDID-A', 'UDID-C']);
});

test('parseRuntimeVersion extracts major.minor from runtime id', async () => {
  const { parseRuntimeVersion } = await import('../src/sim/ios.js');
  assert.equal(parseRuntimeVersion('com.apple.CoreSimulator.SimRuntime.iOS-26-2'), '26.2');
  assert.equal(parseRuntimeVersion('com.apple.CoreSimulator.SimRuntime.iOS-18'), '18');
  assert.equal(parseRuntimeVersion('weird-id'), 'weird-id');
});

test('parseSimctlList drops non-iOS runtimes (watchOS, tvOS, visionOS)', () => {
  const out = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
        { udid: 'IOS-1', name: 'iPhone 17', state: 'Booted', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
        { udid: 'WATCH-1', name: 'Apple Watch S10', state: 'Booted', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
        { udid: 'TV-1', name: 'Apple TV 4K', state: 'Booted', isAvailable: true },
      ],
      'com.apple.CoreSimulator.SimRuntime.xrOS-2-0': [
        { udid: 'VISION-1', name: 'Apple Vision Pro', state: 'Booted', isAvailable: true },
      ],
    },
  });
  const sims = parseSimctlList(out);
  assert.deepEqual(sims.map(s => s.udid), ['IOS-1']);
});

test('parseOccupyingApps finds xctrunner bundles', () => {
  const out = [
    '507e\t0\tUIKitApplication:com.apple.Spotlight[507e][rb-legacy]',
    '082a\t0\tUIKitApplication:com.callstack.agentdevice.runner.uitests.xctrunner[082a][rb-legacy]',
  ].join('\n');
  assert.deepEqual(parseOccupyingApps(out), ['com.callstack.agentdevice.runner.uitests.xctrunner']);
});

test('parseOccupyingApps ignores apple system apps', () => {
  const out = '507e\t0\tUIKitApplication:com.apple.Spotlight[507e][rb-legacy]';
  assert.deepEqual(parseOccupyingApps(out), []);
});

test('parseOccupyingApps fails open on unparseable output', () => {
  assert.deepEqual(parseOccupyingApps(''), []);
  assert.deepEqual(parseOccupyingApps(null), []);
});

test('pickDefaultIosCreation picks the newest iPhone on the newest runtime', () => {
  const deviceTypes = [
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro', name: 'iPad Pro' },
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', name: 'iPhone 16' },
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' },
  ];
  const runtimes = [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2', name: 'iOS 26.2', version: '26.2',
      supportedDeviceTypes: deviceTypes },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', name: 'iOS 26.5', version: '26.5',
      supportedDeviceTypes: deviceTypes },
  ];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, {});
  assert.equal(pick.runtimeId, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5');
  assert.equal(pick.deviceTypeId, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro');
});

test('pickDefaultIosCreation honors explicit deviceType and runtime by name', () => {
  const deviceTypes = [{ identifier: 'dt.iphone16', name: 'iPhone 16' }];
  const runtimes = [
    { identifier: 'rt.26-2', name: 'iOS 26.2', version: '26.2', supportedDeviceTypes: deviceTypes },
    { identifier: 'rt.26-5', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes },
  ];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, { deviceType: 'iPhone 16', runtime: '26.2' });
  assert.equal(pick.deviceTypeId, 'dt.iphone16');
  assert.equal(pick.runtimeId, 'rt.26-2');
});

test('pickDefaultIosCreation returns null when nothing matches', () => {
  assert.equal(pickDefaultIosCreation([], [], {}), null);
  const deviceTypes = [{ identifier: 'dt', name: 'iPhone 17' }];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  assert.equal(pickDefaultIosCreation(deviceTypes, runtimes, { deviceType: 'iPhone 99' }), null);
});

// Regression: every real Xcode install ships lettered models (SE, Air) beside
// the numbered ones. localeCompare sorts letters after digits, so "iPhone SE"
// beat "iPhone 17 Pro Max" and every default sim spawned as an SE. The fixture
// above missed it by containing numbered models only.
test('pickDefaultIosCreation prefers a numbered iPhone over lettered models (SE, Air)', () => {
  const deviceTypes = [
    { identifier: 'dt.se3', name: 'iPhone SE (3rd generation)' },
    { identifier: 'dt.air', name: 'iPhone Air' },
    { identifier: 'dt.17pm', name: 'iPhone 17 Pro Max' },
    { identifier: 'dt.16', name: 'iPhone 16' },
  ];
  const runtimes = [
    { identifier: 'rt.26-5', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes },
  ];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, {});
  assert.equal(pick.deviceTypeId, 'dt.17pm');
});

test('pickDefaultIosCreation compares iPhone generations numerically, not lexically', () => {
  const deviceTypes = [
    { identifier: 'dt.9', name: 'iPhone 9' },
    { identifier: 'dt.17', name: 'iPhone 17' },
  ];
  const runtimes = [
    { identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes },
  ];
  assert.equal(pickDefaultIosCreation(deviceTypes, runtimes, {}).deviceTypeId, 'dt.17');
});

test('pickDefaultIosCreation picks the base model over Pro/Pro Max of the same generation', () => {
  const deviceTypes = [
    { identifier: 'dt.17pm', name: 'iPhone 17 Pro Max' },
    { identifier: 'dt.17pro', name: 'iPhone 17 Pro' },
    { identifier: 'dt.17', name: 'iPhone 17' },
  ];
  const runtimes = [
    { identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes },
  ];
  assert.equal(pickDefaultIosCreation(deviceTypes, runtimes, {}).deviceTypeId, 'dt.17');
});

test('pickDefaultIosCreation still picks a lettered model when it is the only iPhone', () => {
  const deviceTypes = [{ identifier: 'dt.se3', name: 'iPhone SE (3rd generation)' }];
  const runtimes = [
    { identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes },
  ];
  assert.equal(pickDefaultIosCreation(deviceTypes, runtimes, {}).deviceTypeId, 'dt.se3');
});

test('sanitizeDeviceLabel strips characters simctl names should not carry', () => {
  assert.equal(sanitizeDeviceLabel('feat-a/tlon-mobile'), 'feat-a-tlon-mobile');
  assert.equal(sanitizeDeviceLabel('x  y"z`$'), 'x-y-z');
});

test('deleteIosSim refuses to delete a sim not owned by rn-iso', () => {
  setExecutor({
    run: () => JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
          { udid: 'UDID-A', name: 'iPhone 15', state: 'Shutdown', isAvailable: true },
        ],
      },
    }),
    runQuiet: () => { throw new Error('should not be called'); },
    spawn: () => null,
  });
  assert.throws(() => deleteIosSim('UDID-A'), /rn-iso/);
});

test('deleteIosSim deletes an rn-iso-owned sim', () => {
  let ran = null;
  setExecutor({
    run: () => JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
          { udid: 'UDID-B', name: 'rn-iso-my-project', state: 'Shutdown', isAvailable: true },
        ],
      },
    }),
    runQuiet: (cmd) => { ran = cmd; return null; },
    spawn: () => null,
  });
  deleteIosSim('UDID-B');
  assert.match(ran, /xcrun simctl delete UDID-B/);
});

test('deleteIosSim no-ops quietly when the udid is already gone', () => {
  let ranQuiet = false;
  setExecutor({
    run: () => JSON.stringify({ devices: {} }),
    runQuiet: () => { ranQuiet = true; return null; },
    spawn: () => null,
  });
  assert.doesNotThrow(() => deleteIosSim('UDID-GONE'));
  assert.equal(ranQuiet, false);
});
