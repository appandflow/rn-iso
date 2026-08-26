import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../exec.ts';
import {
  parseSimctlList,
  listAllIosSims,
  listBootedIosSims,
  parseOccupyingApps,
  pickDefaultIosCreation,
  sanitizeDeviceLabel,
  ownedSimName,
  deleteIosSim,
} from '../sim/ios.ts';

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
  expect(sims.length).toBe(3);
  expect(sims.map((s) => s.udid).sort()).toEqual(['UDID-A', 'UDID-B', 'UDID-C']);
});

test('parseSimctlList includes runtime in each entry', () => {
  const sims = parseSimctlList(SIMCTL_OUTPUT);
  const a = sims.find((s) => s.udid === 'UDID-A');
  expect(a.runtime).toBe('com.apple.CoreSimulator.SimRuntime.iOS-17-2');
});

test('listAllIosSims uses simctl via executor', () => {
  setExecutor({
    run: (cmd) => {
      expect(cmd).toMatch(/xcrun simctl list devices --json/);
      return SIMCTL_OUTPUT;
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const sims = listAllIosSims();
  expect(sims.length).toBe(3);
});

test('listBootedIosSims filters by state', () => {
  setExecutor({
    run: () => SIMCTL_OUTPUT,
    runQuiet: () => null,
    spawn: () => null,
  });
  const booted = listBootedIosSims();
  expect(booted.map((s) => s.udid).sort()).toEqual(['UDID-A', 'UDID-C']);
});

test('parseRuntimeVersion extracts major.minor from runtime id', async () => {
  const { parseRuntimeVersion } = await import('../sim/ios.ts');
  expect(parseRuntimeVersion('com.apple.CoreSimulator.SimRuntime.iOS-26-2')).toBe('26.2');
  expect(parseRuntimeVersion('com.apple.CoreSimulator.SimRuntime.iOS-18')).toBe('18');
  expect(parseRuntimeVersion('weird-id')).toBe('weird-id');
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
  expect(sims.map((s) => s.udid)).toEqual(['IOS-1']);
});

test('parseOccupyingApps finds xctrunner bundles', () => {
  const out = [
    '507e\t0\tUIKitApplication:com.apple.Spotlight[507e][rb-legacy]',
    '082a\t0\tUIKitApplication:com.callstack.agentdevice.runner.uitests.xctrunner[082a][rb-legacy]',
  ].join('\n');
  expect(parseOccupyingApps(out)).toEqual(['com.callstack.agentdevice.runner.uitests.xctrunner']);
});

test('parseOccupyingApps ignores apple system apps', () => {
  const out = '507e\t0\tUIKitApplication:com.apple.Spotlight[507e][rb-legacy]';
  expect(parseOccupyingApps(out)).toEqual([]);
});

test('parseOccupyingApps fails open on unparseable output', () => {
  expect(parseOccupyingApps('')).toEqual([]);
  expect(parseOccupyingApps(null)).toEqual([]);
});

test('pickDefaultIosCreation picks the newest iPhone on the newest runtime', () => {
  const deviceTypes = [
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro', name: 'iPad Pro' },
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', name: 'iPhone 16' },
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' },
  ];
  const runtimes = [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
      name: 'iOS 26.2',
      version: '26.2',
      supportedDeviceTypes: deviceTypes,
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      name: 'iOS 26.5',
      version: '26.5',
      supportedDeviceTypes: deviceTypes,
    },
  ];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, {});
  expect(pick.runtimeId).toBe('com.apple.CoreSimulator.SimRuntime.iOS-26-5');
  expect(pick.deviceTypeId).toBe('com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro');
});

test('pickDefaultIosCreation honors explicit deviceType and runtime by name', () => {
  const deviceTypes = [{ identifier: 'dt.iphone16', name: 'iPhone 16' }];
  const runtimes = [
    { identifier: 'rt.26-2', name: 'iOS 26.2', version: '26.2', supportedDeviceTypes: deviceTypes },
    { identifier: 'rt.26-5', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes },
  ];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, { deviceType: 'iPhone 16', runtime: '26.2' });
  expect(pick.deviceTypeId).toBe('dt.iphone16');
  expect(pick.runtimeId).toBe('rt.26-2');
});

test('pickDefaultIosCreation returns null when nothing matches', () => {
  expect(pickDefaultIosCreation([], [], {})).toBe(null);
  const deviceTypes = [{ identifier: 'dt', name: 'iPhone 17' }];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  expect(pickDefaultIosCreation(deviceTypes, runtimes, { deviceType: 'iPhone 99' })).toBe(null);
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
  const runtimes = [{ identifier: 'rt.26-5', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, {});
  expect(pick.deviceTypeId).toBe('dt.17pm');
});

test('pickDefaultIosCreation compares iPhone generations numerically, not lexically', () => {
  const deviceTypes = [
    { identifier: 'dt.9', name: 'iPhone 9' },
    { identifier: 'dt.17', name: 'iPhone 17' },
  ];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  expect(pickDefaultIosCreation(deviceTypes, runtimes, {}).deviceTypeId).toBe('dt.17');
});

test('pickDefaultIosCreation picks the base model over Pro/Pro Max of the same generation', () => {
  const deviceTypes = [
    { identifier: 'dt.17pm', name: 'iPhone 17 Pro Max' },
    { identifier: 'dt.17pro', name: 'iPhone 17 Pro' },
    { identifier: 'dt.17', name: 'iPhone 17' },
  ];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  expect(pickDefaultIosCreation(deviceTypes, runtimes, {}).deviceTypeId).toBe('dt.17');
});

test('pickDefaultIosCreation still picks a lettered model when it is the only iPhone', () => {
  const deviceTypes = [{ identifier: 'dt.se3', name: 'iPhone SE (3rd generation)' }];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  expect(pickDefaultIosCreation(deviceTypes, runtimes, {}).deviceTypeId).toBe('dt.se3');
});

test('sanitizeDeviceLabel strips characters simctl names should not carry', () => {
  expect(sanitizeDeviceLabel('feat-a/tlon-mobile')).toBe('feat-a-tlon-mobile');
  expect(sanitizeDeviceLabel('x  y"z`$')).toBe('x-y-z');
});

test('deleteIosSim refuses to delete a sim not owned by rn-iso', () => {
  setExecutor({
    run: () =>
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
            { udid: 'UDID-A', name: 'iPhone 15', state: 'Shutdown', isAvailable: true },
          ],
        },
      }),
    runQuiet: () => {
      throw new Error('should not be called');
    },
    spawn: () => null,
  });
  expect(() => deleteIosSim('UDID-A')).toThrow(/rn-iso/);
});

const OWNED_SIM_LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
      { udid: 'UDID-B', name: 'rn-iso-my-project', state: 'Shutdown', isAvailable: true },
    ],
  },
});

test('deleteIosSim deletes an rn-iso-owned sim', () => {
  const ran = [];
  setExecutor({
    run: (cmd) => {
      ran.push(cmd);
      return cmd.includes('list devices') ? OWNED_SIM_LIST : null;
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  deleteIosSim('UDID-B');
  expect(ran.some((c) => /xcrun simctl delete UDID-B/.test(c))).toBeTruthy();
});

// A failed simctl delete leaves the sim on disk. It must reach the caller as a
// throw (teardown.js turns it into { status: 'failed' }), not be swallowed into
// a report of a device that was never actually deleted.
test('deleteIosSim propagates a simctl failure instead of swallowing it', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list devices')) return OWNED_SIM_LIST;
      throw new Error('simctl: Unable to delete device');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(() => deleteIosSim('UDID-B')).toThrow(/Unable to delete device/);
});

test('deleteIosSim no-ops quietly when the udid is already gone', () => {
  let ranQuiet = false;
  setExecutor({
    run: () => JSON.stringify({ devices: {} }),
    runQuiet: () => {
      ranQuiet = true;
      return null;
    },
    spawn: () => null,
  });
  expect(() => deleteIosSim('UDID-GONE')).not.toThrow();
  expect(ranQuiet).toBe(false);
});

// Fails CLOSED: an unanswerable occupancy probe must report "occupied", so a
// teardown site skips the sim instead of deleting one that may still be driven
// by a foreign UI-test runner. This failed OPEN until 0.9.0, on a rationale
// (never block device selection) whose model was deleted in 0.7.
test('isSimOccupied reports occupied when the probe cannot answer', async () => {
  const { setExecutor, resetExecutor } = await import('../exec.ts');
  const { isSimOccupied } = await import('../sim/ios.ts');
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  expect(isSimOccupied('UDID-X')).toBe(true);
  resetExecutor();
});

test('isSimOccupied reports not-occupied when the probe answers with nothing', async () => {
  const { setExecutor, resetExecutor } = await import('../exec.ts');
  const { isSimOccupied } = await import('../sim/ios.ts');
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  expect(isSimOccupied('UDID-X')).toBe(false);
  resetExecutor();
});

// A shut-down device cannot be occupied, and `simctl spawn` cannot answer for
// one -- it exits non-zero with "device is not booted", which the probe alone
// reads as occupied. That left a shut-down orphan permanently unreapable: gc
// reported it and skipped it every run. The state check has to come first.
test('isSimOccupied reports not-occupied for a shut-down device without probing', async () => {
  const { setExecutor, resetExecutor } = await import('../exec.ts');
  const { isSimOccupied } = await import('../sim/ios.ts');
  const devices = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
        { udid: 'UDID-X', name: 'rn-iso-x', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  let probed = false;
  setExecutor({
    run: () => devices,
    runQuiet: () => {
      probed = true;
      return null;
    },
    spawn: () => {},
  });
  expect(isSimOccupied('UDID-X')).toBe(false);
  expect(probed).toBe(false);
  resetExecutor();
});

// The state check must not weaken the guard for a device that IS booted: an
// unanswerable probe there is still doubt, and doubt still means occupied.
test('isSimOccupied still fails closed for a booted device whose probe cannot answer', async () => {
  const { setExecutor, resetExecutor } = await import('../exec.ts');
  const { isSimOccupied } = await import('../sim/ios.ts');
  const devices = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
        { udid: 'UDID-X', name: 'rn-iso-x', state: 'Booted', isAvailable: true },
      ],
    },
  });
  setExecutor({ run: () => devices, runQuiet: () => null, spawn: () => {} });
  expect(isSimOccupied('UDID-X')).toBe(true);
  resetExecutor();
});

// A worktree named `rn-iso-test-dialogue` used to become the simulator
// `rn-iso-rn-iso-test-dialogue`. The prefix is the ownership marker, so it must
// still be there exactly once.
test('ownedSimName does not double the ownership prefix', () => {
  expect(ownedSimName('rn-iso-test-dialogue')).toBe('rn-iso-test-dialogue');
  expect(ownedSimName('test-dialogue')).toBe('rn-iso-test-dialogue');
  expect(ownedSimName('feat-a/tlon-mobile')).toBe('rn-iso-feat-a-tlon-mobile');
  expect(ownedSimName('rn-iso-x').startsWith('rn-iso-')).toBeTruthy();
  expect(ownedSimName('rn-iso').startsWith('rn-iso-')).toBeTruthy();
});
