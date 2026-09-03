import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
  occupyingApps,
  bootIosSim,
  clearAppDataContainer,
  deleteParkedIosSim,
  findAppDataContainer,
  listUserApps,
  parkedSimName,
  parseUserApps,
} from '../sim/ios.ts';
import assert from 'node:assert';
import { makeChildProcess, makeExitingChild } from './_factories.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  resetExecutor();
});

const SIMCTL_OUTPUT = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
      {
        udid: 'UDID-A',
        name: 'iPhone 15',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'iphone-15',
      },
      {
        udid: 'UDID-B',
        name: 'iPhone 15 Pro',
        state: 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'iphone-15-pro',
      },
      {
        udid: 'UDID-C',
        name: 'iPhone 14',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'iphone-14',
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-0': [
      {
        udid: 'UDID-OLD',
        name: 'iPhone 13',
        state: 'Shutdown',
        isAvailable: false,
        deviceTypeIdentifier: 'iphone-13',
      },
    ],
  },
});

test('parseSimctlList flattens devices and filters unavailable', () => {
  const sims = parseSimctlList(SIMCTL_OUTPUT);
  expect(sims.length).toBe(3);
  expect(sims.map((s) => s.udid).toSorted()).toEqual(['UDID-A', 'UDID-B', 'UDID-C']);
});

test('parseSimctlList rejects structurally invalid successful output', () => {
  for (const output of ['[]', '{}', '"ok"', '{"devices":[]}']) {
    expect(() => parseSimctlList(output)).toThrow(/devices object/);
  }
  expect(() => parseSimctlList('{"devices":{"ios":{}}}')).toThrow(/to be an array/);
});

test('parseSimctlList rejects incomplete or mistyped iOS device records', () => {
  const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
  const valid = {
    udid: 'U1',
    name: 'stim-app',
    state: 'Shutdown',
    isAvailable: true,
    deviceTypeIdentifier: 'iphone-17',
  };
  for (const bad of [
    { ...valid, udid: undefined },
    { ...valid, name: 42 },
    { ...valid, state: '' },
    { ...valid, deviceTypeIdentifier: null },
    { ...valid, isAvailable: 'yes' },
    { ...valid, dataPath: 42 },
    { ...valid, dataPathSize: Number.NaN },
  ]) {
    expect(() =>
      parseSimctlList(JSON.stringify({ devices: { [runtime]: [bad] } }), { includeUnavailable: true }),
    ).toThrow(/Expected simctl device field/);
  }
  expect(() => parseSimctlList(JSON.stringify({ devices: { [runtime]: ['corrupt'] } }))).toThrow(/every simctl device/);
});

test('parseSimctlList includes runtime in each entry', () => {
  const sims = parseSimctlList(SIMCTL_OUTPUT);
  const a = sims.find((s) => s.udid === 'UDID-A');
  assert(a);
  expect(a.runtime).toBe('com.apple.CoreSimulator.SimRuntime.iOS-17-2');
});

test('parseSimctlList can retain unavailable devices and their data sizes', () => {
  const out = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
        {
          udid: 'UDID-OLD',
          name: 'stim-old',
          state: 'Shutdown',
          isAvailable: false,
          dataPath: '/tmp/CoreSimulator/UDID-OLD/data',
          dataPathSize: 1234,
          deviceTypeIdentifier: 'iphone-15',
        },
      ],
    },
  });
  expect(parseSimctlList(out)).toEqual([]);
  expect(parseSimctlList(out, { includeUnavailable: true })).toEqual([
    {
      udid: 'UDID-OLD',
      name: 'stim-old',
      state: 'Shutdown',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-2',
      deviceTypeIdentifier: 'iphone-15',
      dataPath: '/tmp/CoreSimulator/UDID-OLD/data',
      dataPathSize: 1234,
      available: false,
    },
  ]);
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
  expect(booted.map((s) => s.udid).toSorted()).toEqual(['UDID-A', 'UDID-C']);
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
        {
          udid: 'IOS-1',
          name: 'iPhone 17',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: 'iphone-17',
        },
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
  expect(parseOccupyingApps(null as unknown as string)).toEqual([]);
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
  assert(pick);
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
  assert(pick);
  expect(pick.deviceTypeId).toBe('dt.iphone16');
  expect(pick.runtimeId).toBe('rt.26-2');
});

test('pickDefaultIosCreation returns null when nothing matches', () => {
  expect(pickDefaultIosCreation([], [], {})).toBe(null);
  const deviceTypes = [{ identifier: 'dt', name: 'iPhone 17' }];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  expect(pickDefaultIosCreation(deviceTypes, runtimes, { deviceType: 'iPhone 99' })).toBe(null);
});

test('pickDefaultIosCreation prefers a numbered iPhone over lettered models (SE, Air)', () => {
  const deviceTypes = [
    { identifier: 'dt.se3', name: 'iPhone SE (3rd generation)' },
    { identifier: 'dt.air', name: 'iPhone Air' },
    { identifier: 'dt.17pm', name: 'iPhone 17 Pro Max' },
    { identifier: 'dt.16', name: 'iPhone 16' },
  ];
  const runtimes = [{ identifier: 'rt.26-5', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, {});
  assert(pick);
  expect(pick.deviceTypeId).toBe('dt.17pm');
});

test('pickDefaultIosCreation compares iPhone generations numerically, not lexically', () => {
  const deviceTypes = [
    { identifier: 'dt.9', name: 'iPhone 9' },
    { identifier: 'dt.17', name: 'iPhone 17' },
  ];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, {});
  assert(pick);
  expect(pick.deviceTypeId).toBe('dt.17');
});

test('pickDefaultIosCreation picks the base model over Pro/Pro Max of the same generation', () => {
  const deviceTypes = [
    { identifier: 'dt.17pm', name: 'iPhone 17 Pro Max' },
    { identifier: 'dt.17pro', name: 'iPhone 17 Pro' },
    { identifier: 'dt.17', name: 'iPhone 17' },
  ];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, {});
  assert(pick);
  expect(pick.deviceTypeId).toBe('dt.17');
});

test('pickDefaultIosCreation still picks a lettered model when it is the only iPhone', () => {
  const deviceTypes = [{ identifier: 'dt.se3', name: 'iPhone SE (3rd generation)' }];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, {});
  assert(pick);
  expect(pick.deviceTypeId).toBe('dt.se3');
});

test('sanitizeDeviceLabel strips characters simctl names should not carry', () => {
  expect(sanitizeDeviceLabel('feat-a/tlon-mobile')).toBe('feat-a-tlon-mobile');
  expect(sanitizeDeviceLabel('x  y"z`$')).toBe('x-y-z');
});

test('deleteIosSim refuses to delete a sim not owned by Stim', () => {
  setExecutor({
    run: () =>
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
            {
              udid: 'UDID-A',
              name: 'iPhone 15',
              state: 'Shutdown',
              isAvailable: true,
              deviceTypeIdentifier: 'iphone-15',
            },
          ],
        },
      }),
    runQuiet: () => {
      throw new Error('should not be called');
    },
    spawn: () => null,
  });
  expect(() => deleteIosSim('UDID-A')).toThrow(/Stim/);
});

const OWNED_SIM_LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
      {
        udid: 'UDID-B',
        name: 'stim-my-project',
        state: 'Shutdown',
        isAvailable: true,
        deviceTypeIdentifier: 'iphone-15',
      },
    ],
  },
});

test('deleteIosSim deletes a Stim-owned sim', () => {
  const ran: string[] = [];
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

test('occupyingApps returns null (doubt, read as occupied) when the probe cannot answer', async () => {
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  expect(occupyingApps('UDID-X')).toBe(null);
  resetExecutor();
});

test('occupyingApps returns the counted xctrunner bundles, and [] for a free sim', async () => {
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  expect(occupyingApps('UDID-X')).toEqual([]);
  setExecutor({
    run: () => '',
    runQuiet: () => '1\t0\tUIKitApplication:com.example.app.xctrunner[a][rb-legacy]',
    spawn: () => {},
  });
  expect(occupyingApps('UDID-X')).toEqual(['com.example.app.xctrunner']);
  resetExecutor();
});

test('occupyingApps reports a shut-down device free without probing', async () => {
  const devices = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
        {
          udid: 'UDID-X',
          name: 'stim-x',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: 'iphone-17',
        },
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
  expect(occupyingApps('UDID-X')).toEqual([]);
  expect(probed).toBe(false);
  resetExecutor();
});

test('occupyingApps still returns null (doubt) for a booted device whose probe cannot answer', async () => {
  const devices = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [
        {
          udid: 'UDID-X',
          name: 'stim-x',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: 'iphone-17',
        },
      ],
    },
  });
  setExecutor({ run: () => devices, runQuiet: () => null, spawn: () => {} });
  expect(occupyingApps('UDID-X')).toBe(null);
  resetExecutor();
});

test('ownedSimName does not double the ownership prefix', () => {
  expect(ownedSimName('stim-test-dialogue')).toBe('stim-test-dialogue');
  expect(ownedSimName('test-dialogue')).toBe('stim-test-dialogue');
  expect(ownedSimName('feat-a/tlon-mobile')).toBe('stim-feat-a-tlon-mobile');
  expect(ownedSimName('stim-x').startsWith('stim-')).toBeTruthy();
  expect(ownedSimName('Stim').startsWith('stim-')).toBeTruthy();
});

test('owned and parked simulator names show model and runtime and stay within 60 characters', () => {
  expect(ownedSimName('feat-login', { model: 'iPhone 17', runtime: '26.5' })).toBe('stim-feat-login (iPhone 17 26.5)');
  const long = parkedSimName('A1F3-0000', {
    model: 'iPad Pro 13-inch (M4) with a deliberately very long qualifier',
    runtime: '26.5',
  });
  expect(long.startsWith('stim-parked (')).toBe(true);
  expect(long.endsWith(' 26.5) a1f3')).toBe(true);
  expect(long.length).toBeLessThanOrEqual(60);
});

test('parseUserApps keeps only user applications', () => {
  expect(
    parseUserApps(
      JSON.stringify({
        'com.example.one': { ApplicationType: 'User' },
        'com.apple.Preferences': { ApplicationType: 'System' },
        'com.example.two': { ApplicationType: 'User' },
      }),
    ),
  ).toEqual(['com.example.one', 'com.example.two']);
  expect(() => parseUserApps('not json')).toThrow(/JSON/);
  expect(() => parseUserApps('[]')).toThrow(/JSON object/);
  expect(() => parseUserApps(JSON.stringify({ 'com.example.old': 'corrupt' }))).toThrow(/to be an object/);
  expect(() => parseUserApps(JSON.stringify({ 'com.example.old': {} }))).toThrow(/known ApplicationType/);
  expect(() => parseUserApps(JSON.stringify({ 'com.example.old': { ApplicationType: 'Unknown' } }))).toThrow(
    /known ApplicationType/,
  );
});

test('listUserApps passes the udid as one argv element and converts the property list', () => {
  const calls: string[][] = [];
  setExecutor({
    run: () => {
      throw new Error('must not invoke a shell');
    },
    runFile(file, args = []) {
      calls.push([file, ...args]);
      if (file === 'xcrun') return '{ "com.example.app" = { ApplicationType = User; }; }';
      return JSON.stringify({ 'com.example.app': { ApplicationType: 'User' } });
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(listUserApps('UDID WITH SPACES')).toEqual(['com.example.app']);
  expect(calls[0]).toEqual(['xcrun', 'simctl', 'listapps', 'UDID WITH SPACES']);
  expect(calls[1]?.slice(0, 5)).toEqual(['plutil', '-convert', 'json', '-o', '-']);
});

test('the parked app data lookup reads metadata and clearing preserves the container directories', () => {
  const dataPath = join(tmpHome, 'device-data');
  const app = join(dataPath, 'Containers', 'Data', 'Application', 'APP-UUID');
  for (const dir of ['Documents', 'Library', 'tmp', 'SystemData']) {
    mkdirSync(join(app, dir), { recursive: true });
    writeFileSync(join(app, dir, 'state.txt'), 'old');
  }
  writeFileSync(join(app, '.com.apple.mobile_container_manager.metadata.plist'), 'metadata');
  setExecutor({
    run: () => '',
    runFile(file, args = []) {
      expect(file).toBe('plutil');
      expect(args.at(-1)).toBe(join(app, '.com.apple.mobile_container_manager.metadata.plist'));
      return 'com.example.app';
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(findAppDataContainer(dataPath, 'com.example.app')).toBe(app);
  clearAppDataContainer(app);
  for (const dir of ['Documents', 'Library', 'tmp', 'SystemData']) {
    expect(existsSync(join(app, dir))).toBe(true);
    expect(existsSync(join(app, dir, 'state.txt'))).toBe(false);
  }
});

test('parked app data cleanup fails closed on unreadable metadata and invalid container directories', () => {
  const dataPath = join(tmpHome, 'bad-device-data');
  const app = join(dataPath, 'Containers', 'Data', 'Application', 'APP-UUID');
  mkdirSync(app, { recursive: true });
  setExecutor({
    run: () => '',
    runFile() {
      throw new Error('metadata unreadable');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(() => findAppDataContainer(dataPath, 'com.example.app')).toThrow(/metadata unreadable/);

  const container = join(tmpHome, 'bad-container');
  mkdirSync(container, { recursive: true });
  writeFileSync(join(container, 'Library'), 'not a directory');
  expect(() => clearAppDataContainer(container)).toThrow(/to be a directory/);
});

test('deleteParkedIosSim bounds ownership revalidation and deletion', () => {
  const calls: Array<{ kind: 'run' | 'runFile'; timeoutMs?: number }> = [];
  setExecutor({
    run(_cmd, options) {
      calls.push({ kind: 'run', timeoutMs: options?.timeoutMs });
      return JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
            {
              udid: 'U1',
              name: 'stim-parked (iPhone 17 26.5) u1',
              state: 'Shutdown',
              isAvailable: true,
              deviceTypeIdentifier: 'iphone-17',
            },
          ],
        },
      });
    },
    runFile(_file, _args, options) {
      calls.push({ kind: 'runFile', timeoutMs: options?.timeoutMs });
      return '';
    },
    runQuiet: () => null,
    spawn: () => null,
  });

  deleteParkedIosSim('U1');

  expect(calls).toEqual([
    { kind: 'run', timeoutMs: 30000 },
    { kind: 'runFile', timeoutMs: 30000 },
  ]);
});

test('deleteParkedIosSim re-resolves the name before deletion', () => {
  const calls: string[][] = [];
  setExecutor({
    run: () =>
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
            {
              udid: 'U1',
              name: 'My renamed simulator',
              state: 'Shutdown',
              isAvailable: true,
              deviceTypeIdentifier: 'iphone-17',
            },
          ],
        },
      }),
    runFile(file, args = []) {
      calls.push([file, ...args]);
      return '';
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(() => deleteParkedIosSim('U1')).toThrow(/not Stim-owned/);
  expect(calls).toEqual([]);
});

function bootSimList(state: string) {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
        { udid: 'UDID-A', name: 'stim-app', state, isAvailable: true, deviceTypeIdentifier: 'iphone-15' },
      ],
    },
  });
}

type BootstatusOutcome = 'hang' | { exitCode: number; stderr?: string };

function bootstatusExecutor(outcomes: BootstatusOutcome[], list: () => string) {
  const spawned: string[] = [];
  const quiet: string[] = [];
  setExecutor({
    run: (cmd: string) => {
      if (cmd.includes('list devices')) return list();
      return '';
    },
    runQuiet: (cmd: string) => {
      quiet.push(cmd);
      return '';
    },
    runFile: () => '',
    spawn: (cmd: string, args: readonly string[] = []) => {
      spawned.push([cmd, ...args].join(' '));
      const outcome = outcomes[spawned.length - 1] ?? outcomes[outcomes.length - 1] ?? 'hang';
      if (outcome === 'hang') return makeChildProcess();
      return makeExitingChild(outcome.exitCode, outcome.stderr);
    },
  });
  return { spawned, quiet };
}

test('bootIosSim waits on `simctl bootstatus -b` as a child process, so the caller can work meanwhile', async () => {
  const { spawned, quiet } = bootstatusExecutor([{ exitCode: 0 }], () => bootSimList('Booted'));
  await bootIosSim('UDID-A');
  expect(spawned).toEqual(['xcrun simctl bootstatus UDID-A -b']);
  expect(quiet).toContain('open -a Simulator');
});

test('bootIosSim re-enters bootstatus after a timed-out attempt while the sim is still Booting', async () => {
  const { spawned, quiet } = bootstatusExecutor(['hang', { exitCode: 0 }], () => bootSimList('Booting'));
  await bootIosSim('UDID-A', { attemptMs: 20 });
  expect(spawned.length).toBe(2);
  expect(quiet).toContain('open -a Simulator');
});

test('bootIosSim treats a timed-out attempt as success when the sim reports Booted', async () => {
  const { spawned } = bootstatusExecutor(['hang'], () => bootSimList('Booted'));
  await bootIosSim('UDID-A', { attemptMs: 20 });
  expect(spawned.length).toBe(1);
});

test('bootIosSim names the udid and the wait when the deadline expires while Booting', async () => {
  bootstatusExecutor(['hang'], () => bootSimList('Booting'));
  await expect(bootIosSim('UDID-A', { timeoutMs: 1200, attemptMs: 300 })).rejects.toThrow(
    /UDID-A did not finish booting within 1s/,
  );
});

test('bootIosSim reports a sim that vanished from the device list', async () => {
  bootstatusExecutor(['hang'], () => JSON.stringify({ devices: {} }));
  await expect(bootIosSim('UDID-A', { attemptMs: 20 })).rejects.toThrow(/UDID-A reports "missing"/);
});

test('bootIosSim keeps waiting through a failing device list and still hits the deadline', async () => {
  bootstatusExecutor(['hang'], () => {
    throw new Error('CoreSimulatorService connection interrupted');
  });
  await expect(bootIosSim('UDID-A', { timeoutMs: 1200, attemptMs: 300 })).rejects.toThrow(
    /UDID-A did not finish booting within 1s/,
  );
});

test('bootIosSim reports a sim that left the boot path instead of retrying forever', async () => {
  bootstatusExecutor(['hang'], () => bootSimList('Shutdown'));
  await expect(bootIosSim('UDID-A', { attemptMs: 20 })).rejects.toThrow(/UDID-A reports "Shutdown"/);
});

test('bootIosSim rethrows a bootstatus failure that is not a timeout', async () => {
  const { spawned } = bootstatusExecutor([{ exitCode: 1, stderr: 'CoreLocationMigrator failed' }], () =>
    bootSimList('Booting'),
  );
  await expect(bootIosSim('UDID-A')).rejects.toThrow(/CoreLocationMigrator failed/);
  expect(spawned.length).toBe(1);
});
