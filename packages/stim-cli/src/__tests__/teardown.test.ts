import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { getProject, upsertProject } from '../config.ts';
import { setExecutor, resetExecutor } from '../exec.ts';
import { parkSim, readParked } from '../sim-pool.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.ts';

let savedAndroidHome: string | undefined;
let savedSdkRoot: string | undefined;

beforeEach(() => {
  savedAndroidHome = process.env.ANDROID_HOME;
  savedSdkRoot = process.env.ANDROID_SDK_ROOT;
  process.env.ANDROID_HOME = join(tmpdir(), 'stim-test-no-sdk-here');
  delete process.env.ANDROID_SDK_ROOT;
});

afterEach(() => {
  if (savedAndroidHome === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = savedAndroidHome;
  if (savedSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
  else process.env.ANDROID_SDK_ROOT = savedSdkRoot;
  resetExecutor();
});

interface IosExecutorOptions {
  sims?: unknown[];
  occupied?: string;
  throwOn?: string | null;
}

function iosExecutor({ sims = [], occupied = '', throwOn = null }: IosExecutorOptions = {}) {
  const calls: string[] = [];
  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': sims.map((sim) => ({
        deviceTypeIdentifier: 'iphone-17',
        ...(sim as object),
      })),
    },
  });
  const answer = (cmd: string) => {
    calls.push(cmd);
    if (throwOn && cmd.includes(throwOn)) throw new Error('boom');
    if (cmd.includes('simctl list devices --json')) return listJson;
    if (cmd.includes('simctl list devicetypes --json')) {
      return JSON.stringify({ devicetypes: [{ identifier: 'iphone-17', name: 'iPhone 17' }] });
    }
    if (/simctl spawn .* launchctl list/.test(cmd)) return occupied;
    return '';
  };
  return { calls, run: answer, runQuiet: answer, spawn: () => {} };
}

const OWNED = { udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true };

test('teardownOwnedIosSim shuts down and deletes an owned, unoccupied sim', () => {
  const exec = iosExecutor({ sims: [OWNED] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('torn-down');
  expect(r.label).toBe('stim-app');
  expect(exec.calls.some((c) => /simctl shutdown U1/.test(c))).toBeTruthy();
  expect(exec.calls.some((c) => /simctl delete U1/.test(c))).toBeTruthy();
});

test('teardownOwnedIosSim shuts down WITHOUT deleting when del is false', () => {
  const exec = iosExecutor({ sims: [OWNED] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: false });
  expect(r.status).toBe('torn-down');
  expect(exec.calls.some((c) => /simctl shutdown U1/.test(c))).toBeTruthy();
  expect(!exec.calls.some((c) => /simctl delete/.test(c))).toBeTruthy();
});

test('teardownOwnedIosSim refuses a sim renamed away from Stim ownership', () => {
  const exec = iosExecutor({ sims: [{ ...OWNED, name: 'My Real Sim' }] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('skipped');
  expect(r.reason).toMatch(/not Stim-owned/);
  expect(!exec.calls.some((c) => /simctl shutdown|simctl delete/.test(c))).toBeTruthy();
});

test('teardownOwnedIosSim reports missing without erroring', () => {
  setExecutor(iosExecutor({ sims: [] }));
  expect(teardownOwnedIosSim('U1', { del: true })).toEqual({ status: 'missing' });
});

test('teardownOwnedIosSim shuts down an owned sim without checking occupancy', () => {
  const exec = iosExecutor({
    sims: [OWNED],
    occupied: '\t123\t0\tUIKitApplication:com.example.thing.xctrunner[0x1][rb-legacy]\n',
  });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: false });
  expect(r.status).toBe('torn-down');
  expect(exec.calls.some((c) => /simctl shutdown U1/.test(c))).toBeTruthy();
  expect(exec.calls.some((c) => /launchctl list/.test(c))).toBe(false);
});

test('teardownOwnedIosSim does not check occupancy or shut down a sim that is not owned', () => {
  const exec = iosExecutor({
    sims: [{ ...OWNED, name: 'My Real Sim' }],
    occupied: '\t123\t0\tUIKitApplication:com.callstack.agentdevice.runner.uitests.xctrunner[0x1][rb-legacy]\n',
  });
  setExecutor(exec);

  const r = teardownOwnedIosSim('U1', { del: false });

  expect(r.kind).toBe('not-owned');
  expect(exec.calls.some((c) => /launchctl list/.test(c))).toBe(false);
  expect(exec.calls.some((c) => /simctl shutdown/.test(c))).toBe(false);
});

test('teardownOwnedIosSim deletes an occupied sim anyway, without needing force', () => {
  const exec = iosExecutor({
    sims: [OWNED],
    occupied: '\t123\t0\tUIKitApplication:com.example.thing.xctrunner[0x1][rb-legacy]\n',
  });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('torn-down');
  expect(exec.calls.some((c) => /simctl delete U1/.test(c))).toBeTruthy();
});

test('teardownOwnedIosSim still refuses a sim that is not Stim-owned, even when deleting', () => {
  const exec = iosExecutor({ sims: [{ udid: 'U1', name: 'My iPhone', state: 'Booted', isAvailable: true }] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('skipped');
  expect(r.kind).toBe('not-owned');
  expect(!exec.calls.some((c) => /simctl shutdown|simctl delete/.test(c))).toBeTruthy();
});

test('teardownOwnedIosSim reports a failed delete rather than torn-down', () => {
  const exec = iosExecutor({ sims: [OWNED], throwOn: 'simctl delete' });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('failed');
  expect(r.reason).toMatch(/boom/);
});

test('teardownOwnedIosSim contains a throw instead of propagating it', () => {
  setExecutor(iosExecutor({ sims: [OWNED], throwOn: 'simctl shutdown' }));
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('failed');
  expect(r.reason).toMatch(/boom/);
});

test('teardownOwnedIosSim parks an owned simulator and clears its project claim', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pool-teardown-'));
  process.env.STIM_HOME = home;
  try {
    const projectPath = '/tmp/pool-project';
    upsertProject(projectPath, {
      platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
    });
    const calls: string[][] = [];
    setExecutor({
      run(cmd) {
        if (cmd.includes('list devicetypes')) {
          return JSON.stringify({ devicetypes: [{ identifier: 'iphone-17', name: 'iPhone 17' }] });
        }
        if (cmd.includes('list devices')) {
          return JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                {
                  udid: 'U1',
                  name: 'stim-app',
                  state: 'Shutdown',
                  isAvailable: true,
                  deviceTypeIdentifier: 'iphone-17',
                  dataPath: join(home, 'device-data'),
                },
              ],
            },
          });
        }
        return '';
      },
      runFile(file, args = []) {
        calls.push([file, ...args]);
        return '';
      },
      runQuiet: () => '',
      spawn: () => null,
    });
    const result = teardownOwnedIosSim('U1', {
      del: true,
      park: { projectPath, max: 1, bundleId: 'com.example.app', cacheKey: 'hash-debug-sim' },
    });
    expect(result.status).toBe('torn-down');
    expect(result.parked?.name).toBe('stim-parked (iPhone 17 26.5) u1');
    expect(calls).toContainEqual(['xcrun', 'simctl', 'rename', 'U1', 'stim-parked (iPhone 17 26.5) u1']);
    expect(getProject(projectPath)?.platforms?.ios).toBeUndefined();
    expect(readParked('ios')).toMatchObject([{ udid: 'U1', bundleId: 'com.example.app', cacheKey: 'hash-debug-sim' }]);
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed overflow eviction retains its parked ownership record', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pool-teardown-'));
  process.env.STIM_HOME = home;
  try {
    const projectPath = '/tmp/pool-project';
    upsertProject('/tmp/old-project', {
      platforms: { ios: { deviceUdid: 'U0', deviceName: 'stim-old', owned: true } },
    });
    parkSim({
      platform: 'ios',
      projectPath: '/tmp/old-project',
      max: 1,
      record: {
        udid: 'U0',
        name: 'stim-parked (iPhone 17 26.5) u0',
        deviceTypeIdentifier: 'iphone-17',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        parkedAt: '2026-09-01T00:00:00.000Z',
        simslimManaged: false,
      },
    });
    upsertProject(projectPath, {
      platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
    });
    let shutdown = false;
    setExecutor({
      run(cmd) {
        if (cmd.includes('list devicetypes')) {
          return JSON.stringify({ devicetypes: [{ identifier: 'iphone-17', name: 'iPhone 17' }] });
        }
        if (cmd.includes('list devices')) {
          return JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                {
                  udid: 'U0',
                  name: 'stim-parked (iPhone 17 26.5) u0',
                  state: 'Shutdown',
                  isAvailable: true,
                  deviceTypeIdentifier: 'iphone-17',
                },
                {
                  udid: 'U1',
                  name: 'stim-app',
                  state: shutdown ? 'Shutdown' : 'Booted',
                  isAvailable: true,
                  deviceTypeIdentifier: 'iphone-17',
                },
              ],
            },
          });
        }
        return '';
      },
      runFile(_file, args = []) {
        if (args[1] === 'delete' && args[2] === 'U0') throw new Error('simctl busy');
        return '';
      },
      runQuiet(cmd) {
        if (cmd.includes('simctl shutdown U1')) shutdown = true;
        return '';
      },
      spawn: () => null,
    });

    const result = teardownOwnedIosSim('U1', { del: true, park: { projectPath, max: 1 } });

    expect(result.status).toBe('torn-down');
    expect(result.evictionFailures?.join('\n')).toMatch(/simctl busy/);
    expect(
      readParked('ios')
        .map((record) => record.udid)
        .toSorted(),
    ).toEqual(['U0', 'U1']);
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('teardownOwnedIosSim falls back to deletion when parking fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pool-teardown-'));
  process.env.STIM_HOME = home;
  try {
    const projectPath = '/tmp/pool-project';
    upsertProject(projectPath, {
      platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
    });
    const calls: string[] = [];
    setExecutor({
      run(cmd) {
        calls.push(cmd);
        if (cmd.includes('list devicetypes')) throw new Error('device types unavailable');
        if (cmd.includes('list devices')) {
          return JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                {
                  udid: 'U1',
                  name: 'stim-app',
                  state: 'Shutdown',
                  isAvailable: true,
                  deviceTypeIdentifier: 'iphone-17',
                },
              ],
            },
          });
        }
        return '';
      },
      runFile: () => '',
      runQuiet: () => '',
      spawn: () => null,
    });
    const result = teardownOwnedIosSim('U1', { del: true, park: { projectPath, max: 1 } });
    expect(result.status).toBe('torn-down');
    expect(result.parkFallback).toMatch(/device types unavailable/);
    expect(calls).toContain('xcrun simctl delete U1');
    expect(readParked('ios')).toEqual([]);
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('teardownOwnedIosSim deletes instead of parking when app data cannot be proven cleared', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pool-teardown-'));
  process.env.STIM_HOME = home;
  try {
    const projectPath = '/tmp/pool-project';
    const dataPath = join(home, 'device-data');
    const container = join(dataPath, 'Containers', 'Data', 'Application', 'APP-UUID');
    mkdirSync(container, { recursive: true });
    upsertProject(projectPath, {
      platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
    });
    const calls: string[] = [];
    setExecutor({
      run(cmd) {
        calls.push(cmd);
        if (cmd.includes('list devicetypes')) {
          return JSON.stringify({ devicetypes: [{ identifier: 'iphone-17', name: 'iPhone 17' }] });
        }
        if (cmd.includes('list devices')) {
          return JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                {
                  udid: 'U1',
                  name: 'stim-app',
                  state: 'Shutdown',
                  isAvailable: true,
                  deviceTypeIdentifier: 'iphone-17',
                  dataPath,
                },
              ],
            },
          });
        }
        return '';
      },
      runFile(file) {
        if (file === 'plutil') throw new Error('container metadata unreadable');
        return '';
      },
      runQuiet: () => '',
      spawn: () => null,
    });

    const result = teardownOwnedIosSim('U1', {
      del: true,
      park: { projectPath, max: 1, bundleId: 'com.example.app', cacheKey: 'hash-debug-sim' },
    });

    expect(result.status).toBe('torn-down');
    expect(result.parkFallback).toMatch(/container metadata unreadable/);
    expect(calls).toContain('xcrun simctl delete U1');
    expect(readParked('ios')).toEqual([]);
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('teardownOwnedIosSim deletes instead of parking when app cleanup has no simulator data path', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pool-teardown-'));
  process.env.STIM_HOME = home;
  try {
    const projectPath = '/tmp/pool-project';
    upsertProject(projectPath, {
      platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
    });
    const exec = iosExecutor({ sims: [{ ...OWNED, state: 'Shutdown' }] });
    setExecutor(exec);

    const result = teardownOwnedIosSim('U1', {
      del: true,
      park: { projectPath, max: 1, bundleId: 'com.example.app', cacheKey: 'hash-debug-sim' },
    });

    expect(result.status).toBe('torn-down');
    expect(result.parkFallback).toMatch(/did not report a data path/);
    expect(exec.calls).toContain('xcrun simctl delete U1');
    expect(readParked('ios')).toEqual([]);
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('parking fallback re-resolves ownership immediately before deletion', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pool-teardown-'));
  process.env.STIM_HOME = home;
  try {
    const projectPath = '/tmp/pool-project';
    upsertProject(projectPath, {
      platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
    });
    let lists = 0;
    const calls: string[] = [];
    setExecutor({
      run(cmd) {
        calls.push(cmd);
        if (cmd.includes('list devices')) {
          lists++;
          const name = lists < 3 ? 'stim-app' : 'My iPhone';
          return JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                {
                  udid: 'U1',
                  name,
                  state: lists === 1 ? 'Booted' : 'Shutdown',
                  isAvailable: true,
                  deviceTypeIdentifier: 'iphone-17',
                },
              ],
            },
          });
        }
        if (cmd.includes('list devicetypes')) throw new Error('device types unavailable');
        return '';
      },
      runFile: () => '',
      runQuiet: () => '',
      spawn: () => null,
    });

    const result = teardownOwnedIosSim('U1', { del: true, park: { projectPath, max: 1 } });

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/not a Stim-owned sim/);
    expect(calls.some((call) => call === 'xcrun simctl delete U1')).toBe(false);
    expect(getProject(projectPath)?.platforms?.ios?.deviceUdid).toBe('U1');
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('teardownOwnedIosSim does not park a simulator that remains booted', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pool-teardown-'));
  process.env.STIM_HOME = home;
  try {
    const projectPath = '/tmp/pool-project';
    upsertProject(projectPath, {
      platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
    });
    const calls: string[] = [];
    setExecutor({
      run(cmd) {
        calls.push(cmd);
        if (cmd.includes('list devices')) {
          return JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                {
                  udid: 'U1',
                  name: 'stim-app',
                  state: 'Booted',
                  isAvailable: true,
                  deviceTypeIdentifier: 'iphone-17',
                },
              ],
            },
          });
        }
        return '';
      },
      runFile(file, args = []) {
        calls.push([file, ...args].join(' '));
        return '';
      },
      runQuiet: () => '',
      spawn: () => null,
    });

    const result = teardownOwnedIosSim('U1', { del: true, park: { projectPath, max: 1 } });

    expect(result.status).toBe('torn-down');
    expect(result.parkFallback).toMatch(/still Booted/);
    expect(calls.some((call) => call.includes('simctl rename'))).toBe(false);
    expect(calls).toContain('xcrun simctl delete U1');
    expect(readParked('ios')).toEqual([]);
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

interface AndroidExecutorOptions {
  avds?: string[];
  adb?: string;
  avdName?: string | null;
  throwOn?: string | null;
}

function androidExecutor({ avds = [], adb = '', avdName = null, throwOn = null }: AndroidExecutorOptions = {}) {
  const calls: string[] = [];
  const answer = (cmd: string) => {
    calls.push(cmd);
    if (throwOn && cmd.includes(throwOn)) throw new Error('boom');
    if (cmd === 'emulator -list-avds') return avds.join('\n');
    if (cmd === 'adb devices') return adb;
    if (/emu avd name/.test(cmd)) return avdName ? `${avdName}\nOK` : '';
    return '';
  };
  return { calls, run: answer, runQuiet: answer, spawn: () => {} };
}

test('teardownOwnedAvd shuts down the running emulator and deletes the AVD', () => {
  const exec = androidExecutor({
    avds: ['stim-app'],
    adb: 'List of devices attached\nemulator-5554\tdevice\n',
    avdName: 'stim-app',
  });
  setExecutor(exec);
  const r = teardownOwnedAvd('stim-app', {
    del: true,
    waitForShutdown: (_avdName, shutdown) => shutdown(),
  });
  expect(r.status).toBe('torn-down');
  expect(exec.calls.some((c) => /emu kill/.test(c))).toBeTruthy();
  expect(exec.calls.some((c) => /delete avd -n/.test(c))).toBeTruthy();
  expect(exec.calls.findIndex((c) => /emu kill/.test(c))).toBeLessThan(
    exec.calls.findIndex((c) => /delete avd -n/.test(c)),
  );
});

test('teardownOwnedAvd refuses an AVD that is not Stim-owned by name', () => {
  const exec = androidExecutor({ avds: ['Pixel_6_API_34'], adb: 'List of devices attached\n' });
  setExecutor(exec);
  const r = teardownOwnedAvd('Pixel_6_API_34', { del: true });
  expect(r.status).toBe('skipped');
  expect(!exec.calls.some((c) => /emu kill|avdmanager delete/.test(c))).toBeTruthy();
});

test('teardownOwnedAvd reports missing for an AVD that no longer exists', () => {
  setExecutor(androidExecutor({ avds: [], adb: 'List of devices attached\n' }));
  expect(teardownOwnedAvd('stim-gone', { del: true }).status).toEqual('missing');
});

test('teardownOwnedAvd contains a throw instead of propagating it', () => {
  setExecutor(
    androidExecutor({
      avds: ['stim-app'],
      adb: 'List of devices attached\nemulator-5554\tdevice\n',
      avdName: 'stim-app',
      throwOn: 'delete avd',
    }),
  );
  const r = teardownOwnedAvd('stim-app', {
    del: true,
    waitForShutdown: (_avdName, shutdown) => shutdown(),
  });
  expect(r.status).toBe('failed');
  expect(r.reason).toMatch(/boom/);
});

test('teardownOwnedAvd does not delete an AVD when emulator shutdown times out', () => {
  const exec = androidExecutor({
    avds: ['stim-app'],
    adb: 'List of devices attached\nemulator-5554\tdevice\n',
    avdName: 'stim-app',
  });
  setExecutor(exec);

  const r = teardownOwnedAvd('stim-app', {
    del: true,
    waitForShutdown: (_avdName, shutdown) => {
      shutdown();
      throw new Error('shutdown timed out');
    },
  });

  expect(r.status).toBe('failed');
  expect(r.reason).toMatch(/shutdown timed out/);
  expect(exec.calls.some((c) => /emu kill/.test(c))).toBeTruthy();
  expect(exec.calls.some((c) => /delete avd -n/.test(c))).toBeFalsy();
});

test('ownership skip outcomes carry a machine-readable kind', () => {
  setExecutor(iosExecutor({ sims: [{ ...OWNED, name: 'My Real Sim' }] }));
  expect(teardownOwnedIosSim('U1', { del: true }).kind).toBe('not-owned');
  resetExecutor();

  setExecutor(androidExecutor({ avds: ['Pixel_6'], adb: 'List of devices attached\n' }));
  expect(teardownOwnedAvd('Pixel_6', { del: true }).kind).toBe('not-owned');
});
