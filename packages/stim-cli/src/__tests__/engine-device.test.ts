import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import {
  claimAndroidConsolePort,
  clearIosAdoptionPending,
  deviceCapacityRefusal,
  deviceTypeMismatch,
  ensureBooted,
  ensureOwnedDevice,
  unknownAndroidSystemImageRefusal,
  unknownIosDeviceTypeRefusal,
  unknownIosRuntimeRefusal,
} from '../engine/device.ts';
import { allConsolePortsAndSerials, getProject, setDevice, upsertProject } from '../config.ts';
import type { DeviceRecord } from '../types.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { parkSim, readParked } from '../sim-pool.ts';
import { makeAdbDevices, makeChildProcess, makeConfig, makeExitingChild, makeIosSim } from './_factories.ts';

type SimEntry = {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  deviceTypeIdentifier?: string;
};

let tmpHome: string;
let savedAndroidHome: string | undefined;
let savedSdkRoot: string | undefined;
let savedDisplay: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  savedAndroidHome = process.env.ANDROID_HOME;
  savedSdkRoot = process.env.ANDROID_SDK_ROOT;
  process.env.ANDROID_HOME = join(tmpHome, 'no-sdk-here');
  delete process.env.ANDROID_SDK_ROOT;
  savedDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':0';
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  if (savedAndroidHome === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = savedAndroidHome;
  if (savedSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
  else process.env.ANDROID_SDK_ROOT = savedSdkRoot;
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
  resetExecutor();
});

function simList(devices: SimEntry[]) {
  return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-2': devices } });
}

describe('ensureBooted: ios', () => {
  test('returns the udid without touching simctl boot when the sim is already Booted', async () => {
    const commands: string[] = [];
    setExecutor({
      run: (cmd) => {
        commands.push(cmd);
        return simList([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]);
      },
      runQuiet: (cmd) => {
        commands.push(cmd);
        return '';
      },
      runFile: () => '',
      spawn: (cmd: string, args: readonly string[] = []) => {
        commands.push([cmd, ...args].join(' '));
        return makeExitingChild();
      },
    });
    expect(await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1', owned: true } })).toEqual({
      ok: true,
      udid: 'U1',
    });
    expect(commands.filter((c) => c.includes('simctl boot')).length).toBe(0);
    expect(commands.some((c) => c.includes('simctl bootstatus'))).toBe(false);
  });

  test('boots a shut-down owned sim and waits for the Booted state', async () => {
    let listCalls = 0;
    const commands: string[] = [];
    setExecutor({
      run: (cmd) => {
        commands.push(cmd);
        if (cmd.includes('list devices')) {
          listCalls += 1;
          const state = listCalls >= 3 ? 'Booted' : 'Shutdown';
          return simList([{ udid: 'U1', name: 'stim-app', state, isAvailable: true }]);
        }
        return '';
      },
      runQuiet: () => '',
      runFile: () => '',
      spawn: (cmd: string, args: readonly string[] = []) => {
        commands.push([cmd, ...args].join(' '));
        return makeExitingChild();
      },
    });
    const result = await ensureBooted({
      platform: 'ios',
      device: { deviceUdid: 'U1', owned: true },
      timeoutMs: 5000,
      pollMs: 5,
    });
    expect(result).toEqual({ ok: true, udid: 'U1' });
    expect(commands.filter((c) => c === 'xcrun simctl boot U1').length).toBe(1);
    expect(commands.indexOf('xcrun simctl boot U1')).toBeLessThan(commands.indexOf('xcrun simctl bootstatus U1 -b'));
  });

  test('an explicit ensureBooted timeout bounds the whole iOS boot wait', async () => {
    setExecutor({
      run: (cmd) => {
        if (cmd.includes('list devices')) {
          return simList([{ udid: 'U1', name: 'stim-app', state: 'Booting', isAvailable: true }]);
        }
        return '';
      },
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => makeChildProcess(),
    });

    const result = await ensureBooted({
      platform: 'ios',
      device: { deviceUdid: 'U1', owned: true },
      timeoutMs: 1200,
      pollMs: 5,
    });

    expect(result.ok).toBeUndefined();
    expect(result.reason).toMatch(/did not finish booting within 1s/);
  });

  test('reports boot setup failures instead of treating the Booted state as ready', async () => {
    setExecutor({
      run: (cmd) => {
        if (cmd.includes('list devices')) {
          return simList([{ udid: 'U1', name: 'stim-app', state: 'Shutdown', isAvailable: true }]);
        }
        return '';
      },
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => makeExitingChild(1, 'CoreLocationMigrator failed'),
    });

    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1', owned: true } });

    expect(result.ok).toBeUndefined();
    expect(result.reason).toMatch(/Could not boot simulator U1/);
    expect(result.reason).toMatch(/CoreLocationMigrator failed/);
  });

  test('refuses to boot a sim that is no longer Stim-owned by name', async () => {
    setExecutor({
      run: () => simList([{ udid: 'U1', name: 'My iPhone', state: 'Shutdown', isAvailable: true }]),
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => {
        throw new Error('must not boot a foreign sim');
      },
    });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1' } });
    expect(result.ok).toBe(undefined);
    expect(result.reason).toMatch(/not Stim-owned/);
  });

  test('reports a sim that no longer exists rather than booting a stale udid', async () => {
    setExecutor({ run: () => simList([]), runQuiet: () => '', runFile: () => '', spawn: () => null });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'GONE' } });
    expect(result.reason).toMatch(/no longer exists/);
    expect(result.reason).toMatch(/stim ios/);
  });

  test('times out with a reason instead of hanging when the sim never boots', async () => {
    setExecutor({
      run: (cmd) =>
        cmd.includes('list devices')
          ? simList([{ udid: 'U1', name: 'stim-app', state: 'Booting', isAvailable: true }])
          : '',
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => makeExitingChild(),
    });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1' }, timeoutMs: 60, pollMs: 5 });
    expect(result.reason).toMatch(/did not reach the Booted state/);
  });

  test('reports a missing record rather than throwing', async () => {
    setExecutor({ run: () => '', runQuiet: () => '', runFile: () => '', spawn: () => null });
    expect((await ensureBooted({ platform: 'ios', device: {} })).reason).toMatch(/No iOS simulator is recorded/);
  });

  test('joins the boot this run started instead of listing simulators again', async () => {
    const commands: string[] = [];
    setExecutor({
      run: (cmd: string) => {
        commands.push(cmd);
        throw new Error(`unexpected run: ${cmd}`);
      },
      runQuiet: (cmd: string) => {
        commands.push(cmd);
        return '';
      },
      runFile: () => '',
      spawn: () => null,
    });
    let finished = false;
    const done = new Promise<void>((resolve) =>
      setTimeout(() => {
        finished = true;
        resolve();
      }, 5),
    );
    const result = await ensureBooted({
      platform: 'ios',
      device: { deviceUdid: 'U1', owned: true, booting: { udid: 'U1', done } },
    });
    expect(result).toEqual({ ok: true, udid: 'U1' });
    expect(finished).toBe(true);
    expect(commands).toEqual([]);
  });

  test('reports the failure of the boot this run started, before anything is installed', async () => {
    setExecutor({
      run: () => simList([{ udid: 'U1', name: 'stim-app', state: 'Shutdown', isAvailable: true }]),
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => null,
    });
    const done = Promise.reject(new Error('CoreLocationMigrator failed'));
    const result = await ensureBooted({
      platform: 'ios',
      device: { deviceUdid: 'U1', owned: true, booting: { udid: 'U1', done } },
    });
    expect(result.ok).toBeUndefined();
    expect(result.reason).toMatch(/Could not boot simulator U1/);
    expect(result.reason).toMatch(/CoreLocationMigrator failed/);
  });

  test('still lists a reused sim, which can have been shut down since it was resolved', async () => {
    const commands: string[] = [];
    setExecutor({
      run: (cmd: string) => {
        commands.push(cmd);
        return simList([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]);
      },
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => null,
    });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1', owned: true } });
    expect(result).toEqual({ ok: true, udid: 'U1' });
    expect(commands.filter((c) => c.includes('list devices')).length).toBe(1);
  });

  test('a boot recorded for another sim does not vouch for this one', async () => {
    const commands: string[] = [];
    setExecutor({
      run: (cmd: string) => {
        commands.push(cmd);
        return simList([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]);
      },
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => null,
    });
    const result = await ensureBooted({
      platform: 'ios',
      device: { deviceUdid: 'U1', owned: true, booting: { udid: 'U2', done: Promise.resolve() } },
    });
    expect(result).toEqual({ ok: true, udid: 'U1' });
    expect(commands.filter((c) => c.includes('list devices')).length).toBe(1);
  });
});

describe('ensureBooted: android', () => {
  test('waits for boot completion on an already-running owned AVD', async () => {
    const commands: string[] = [];
    setExecutor({
      run: (cmd) => {
        commands.push(cmd);
        if (cmd === 'emulator -list-avds') return 'stim-app';
        if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice';
        return '';
      },
      runQuiet: (cmd) => {
        commands.push(cmd);
        if (cmd.includes('emu avd name')) return 'stim-app\nOK';
        if (cmd.includes('sys.boot_completed')) return '1';
        return '';
      },
      runFile: () => '',
      spawn: () => {
        throw new Error('must not boot an emulator that is already running');
      },
    });
    const result = await ensureBooted({
      platform: 'android',
      device: { avdName: 'stim-app', consolePort: 5554, owned: true },
    });
    expect(result).toEqual({ ok: true, serial: 'emulator-5554' });
  });

  test('boots a stopped owned AVD on its recorded port and waits', async () => {
    const spawned: string[][] = [];
    let booted = false;
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-app';
        if (cmd === 'adb devices')
          return booted ? 'List of devices attached\nemulator-5556\tdevice' : 'List of devices attached';
        return '';
      },
      runQuiet: (cmd) => {
        if (cmd.includes('sys.boot_completed')) return booted ? '1' : '';
        return '';
      },
      runFile: () => '',
      spawn: (cmd, args) => {
        spawned.push([cmd, ...args]);
        booted = true;
        return { unref() {} };
      },
    });
    const result = await ensureBooted({
      platform: 'android',
      device: { avdName: 'stim-app', consolePort: 5556, owned: true },
      timeoutMs: 5000,
    });
    expect(result).toEqual({ ok: true, serial: 'emulator-5556' });
    expect(spawned).toEqual([
      ['emulator', '-avd', 'stim-app', '-port', '5556', '-no-snapshot-save', '-no-snapshot-load'],
    ]);
  });

  test('reuses the serial returned by a fresh owned AVD boot when adb listing briefly misses it', async () => {
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-app';
        if (cmd === 'adb devices') return 'List of devices attached';
        return '';
      },
      runQuiet: (cmd) => (cmd.includes('sys.boot_completed') ? '1' : ''),
      runFile: () => '',
      spawn: () => {
        throw new Error('must not boot the fresh AVD a second time');
      },
    });
    const result = await ensureBooted({
      platform: 'android',
      device: {
        avdName: 'stim-app',
        consolePort: 5556,
        serial: 'emulator-5556',
        owned: true,
      },
      timeoutMs: 5000,
    });
    expect(result).toEqual({ ok: true, serial: 'emulator-5556' });
  });

  test('allocates a fresh console port when the recorded one is taken by a foreign emulator', async () => {
    const spawned: string[][] = [];
    let ourSerial: string | null = null;
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-app';
        if (cmd === 'adb devices') {
          const rows = ['List of devices attached', 'emulator-5554\tdevice'];
          if (ourSerial) rows.push(`${ourSerial}\tdevice`);
          return rows.join('\n');
        }
        return '';
      },
      runQuiet: (cmd) => {
        if (cmd.includes('emu avd name')) return cmd.includes('5554') ? 'Pixel_7_API_35\nOK' : 'stim-app\nOK';
        if (cmd.includes('sys.boot_completed')) return ourSerial ? '1' : '';
        return '';
      },
      runFile: () => '',
      spawn: (cmd, args) => {
        spawned.push([cmd, ...args]);
        ourSerial = `emulator-${args[args.indexOf('-port') + 1]}`;
        return { unref() {} };
      },
    });
    const result = await ensureBooted({
      platform: 'android',
      device: { avdName: 'stim-app', consolePort: 5554, owned: true },
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.serial).not.toBe('emulator-5554');
    assert(result.serial);
    const call = spawned[0];
    assert(call);
    expect(call[4]).toBe(result.serial.replace('emulator-', ''));
  });

  test('ensureBooted stops the moment the spawned emulator process is gone', async () => {
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-app';
        if (cmd === 'adb devices') return 'List of devices attached';
        return '';
      },
      runQuiet: () => null,
      runFile: () => '',
      spawn: () => ({ pid: 987654, unref() {} }),
    });
    const started = Date.now();
    const result = await ensureBooted({
      platform: 'android',
      device: { avdName: 'stim-app', consolePort: 5556, owned: true },
      timeoutMs: 240000,
      alive: () => false,
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/exited before the device finished booting/);
    expect(Date.now() - started < 10000).toBeTruthy();
  });

  test('ensureBooted keeps polling while the emulator process is alive', async () => {
    let probes = 0;
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-app';
        if (cmd === 'adb devices') return 'List of devices attached';
        return '';
      },
      runQuiet: (cmd) => {
        if (!cmd.includes('getprop')) return '';
        probes++;
        return probes >= 5 && cmd.includes('sys.boot_completed') ? '1' : null;
      },
      runFile: () => '',
      spawn: () => ({ pid: 987654, unref() {} }),
    });
    const result = await ensureBooted({
      platform: 'android',
      device: { avdName: 'stim-app', consolePort: 5556, owned: true },
      timeoutMs: 20000,
      alive: () => true,
    });
    expect(result).toEqual({ ok: true, serial: 'emulator-5556' });
    expect(probes >= 5).toBeTruthy();
  });

  test('ensureBooted hands the caller log file to the emulator spawn', async () => {
    const logFile = join(tmpHome, 'ws', '.stim', 'logs', 'emulator.log');
    const opts: Array<Record<string, unknown>> = [];
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-app';
        if (cmd === 'adb devices') return 'List of devices attached';
        return '';
      },
      runQuiet: (cmd) => (cmd.includes('sys.boot_completed') ? '1' : ''),
      runFile: () => '',
      spawn: (_cmd: string, _args: string[], o: Record<string, unknown>) => {
        opts.push(o);
        return { pid: 4242, unref() {} };
      },
    });
    const result = await ensureBooted({
      platform: 'android',
      device: { avdName: 'stim-app', consolePort: 5556, owned: true },
      timeoutMs: 5000,
      logFile,
    });
    expect(result.ok).toBe(true);
    const stdio = opts[0]?.stdio as [string, number, number];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe(stdio[1]);
    expect(existsSync(logFile)).toBe(true);
  });

  test('refuses an AVD that is not Stim-owned by name', async () => {
    setExecutor({
      run: (cmd) => (cmd === 'emulator -list-avds' ? 'Pixel_7_API_35' : ''),
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => {
        throw new Error('must not boot a foreign AVD');
      },
    });
    const result = await ensureBooted({ platform: 'android', device: { avdName: 'Pixel_7_API_35' } });
    expect(result.reason).toMatch(/not Stim-owned/);
  });

  test('refuses a legacy physical record without issuing a single command at it', async () => {
    setExecutor({
      run: (cmd) => {
        throw new Error(`Stim must not run "${cmd}" for a physical record`);
      },
      runQuiet: () => {
        throw new Error('Stim must not probe hardware');
      },
      runFile: () => {
        throw new Error('Stim must not probe hardware');
      },
      spawn: () => {
        throw new Error('Stim must never try to boot hardware');
      },
    });
    const physical = { serial: 'R5CT10', kind: 'physical', owned: false };
    const result = await ensureBooted({ platform: 'android', device: physical });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/No owned Android emulator is recorded/);
  });
});

test('ensureBooted reports an unknown platform rather than throwing', async () => {
  expect((await ensureBooted({ platform: 'web', device: {} })).reason).toMatch(/Unknown platform/);
});

const TYPES = [
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', name: 'iPhone 16' },
];
const [TYPE_17_PRO, TYPE_16] = TYPES;
assert(TYPE_17_PRO);
assert(TYPE_16);

test('deviceTypeMismatch returns null when nothing was requested', () => {
  expect(deviceTypeMismatch(TYPE_17_PRO.identifier, undefined, TYPES)).toBe(null);
});

test('deviceTypeMismatch returns null when the recorded sim is the requested type', () => {
  expect(deviceTypeMismatch(TYPE_17_PRO.identifier, 'iPhone 17 Pro', TYPES)).toBe(null);
});

test('deviceTypeMismatch describes the mismatch when the recorded sim is a different model', () => {
  const msg = deviceTypeMismatch(TYPE_16.identifier, 'iPhone 17 Pro', TYPES);
  expect(msg).toMatch(/iPhone 16/);
  expect(msg).toMatch(/iPhone 17 Pro/);
});

test('deviceTypeMismatch returns null when the requested type is unknown, leaving creation to error', () => {
  expect(deviceTypeMismatch(TYPE_17_PRO.identifier, 'iPhone 99 Ultra', TYPES)).toBe(null);
});

test('deviceTypeMismatch returns null when the recorded type is unknown', () => {
  expect(deviceTypeMismatch(undefined, 'iPhone 17 Pro', TYPES)).toBe(null);
});

const DEVICE_TYPES_JSON = JSON.stringify({ devicetypes: TYPES });
const RUNTIMES_JSON = JSON.stringify({
  runtimes: [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
      name: 'iOS 26.2',
      version: '26.2',
      isAvailable: true,
      platform: 'iOS',
      supportedDeviceTypes: TYPES,
    },
  ],
});

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), 'stim-test-proj-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch-app' }));
  upsertProject(dir, { bundleId: undefined, androidPackage: undefined, isExpo: false });
  return dir;
}

function iosExecutor(devices: SimEntry[]) {
  const run: string[] = [];
  const files: string[][] = [];
  const spawned: string[] = [];
  return {
    run,
    files,
    spawned,
    exec: {
      run(cmd: string) {
        run.push(cmd);
        if (/simctl list devicetypes --json/.test(cmd)) return DEVICE_TYPES_JSON;
        if (/simctl list runtimes --json/.test(cmd)) return RUNTIMES_JSON;
        if (/simctl list devices --json/.test(cmd)) return simList(devices);
        if (/simctl create/.test(cmd)) return 'NEW-UDID';
        if (/simctl boot/.test(cmd)) return '';
        throw new Error(`unexpected run: ${cmd}`);
      },
      runQuiet(cmd: string) {
        try {
          return this.run(cmd);
        } catch {
          return null;
        }
      },
      runFile(file: string, args: string[] = []) {
        files.push([file, ...args]);
        return '';
      },
      spawn(cmd: string, args: readonly string[] = []) {
        spawned.push([cmd, ...args].join(' '));
        return makeExitingChild();
      },
    },
  };
}

describe('ensureOwnedDevice: ios', () => {
  test('adopts a matching parked simulator and resets it inside the deferred boot', async () => {
    const root = projectDir();
    process.env.STIM_POOL_IOS_PARKED_MAX = '3';
    try {
      parkSim({
        platform: 'ios',
        projectPath: root,
        max: 3,
        record: {
          udid: 'U1',
          name: 'stim-parked (iPhone 17 Pro 26.2) u1',
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
          parkedAt: '2026-09-01T10:00:00.000Z',
          simslimManaged: false,
          cacheKey: 'fingerprint-debug-sim',
        },
      });
      const { run, files, exec } = iosExecutor([
        {
          udid: 'U1',
          name: 'stim-parked (iPhone 17 Pro 26.2) u1',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
        },
      ]);
      setExecutor(exec);
      const device = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
      });
      expect(device).toMatchObject({
        deviceUdid: 'U1',
        deviceName: 'stim-app (iPhone 17 Pro 26.2)',
        adopted: true,
        adoptionPending: true,
        parkedCacheKey: 'fingerprint-debug-sim',
      });
      expect(readParked('ios')).toEqual([]);
      expect(run).toContain('xcrun simctl boot U1');
      expect(files).toContainEqual(['xcrun', 'simctl', 'rename', 'U1', 'stim-app (iPhone 17 Pro 26.2)']);
      expect(files.some((call) => call.includes('privacy'))).toBe(false);
      await device.booting?.done;
      expect(files).toContainEqual(['xcrun', 'simctl', 'privacy', 'U1', 'reset', 'all']);
      expect(files).toContainEqual(['xcrun', 'simctl', 'keychain', 'U1', 'reset']);
    } finally {
      delete process.env.STIM_POOL_IOS_PARKED_MAX;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('drops a gone parked record and creates a fresh simulator', async () => {
    const root = projectDir();
    process.env.STIM_POOL_IOS_PARKED_MAX = '3';
    try {
      parkSim({
        platform: 'ios',
        projectPath: root,
        max: 3,
        record: {
          udid: 'GONE',
          name: 'stim-parked (iPhone 17 Pro 26.2) gone',
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
          parkedAt: '2026-09-01T10:00:00.000Z',
          simslimManaged: false,
        },
      });
      const { exec } = iosExecutor([]);
      setExecutor(exec);
      const device = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
      });
      expect(device).toMatchObject({ deviceUdid: 'NEW-UDID', created: true });
      await device.booting?.done;
      expect(readParked('ios')).toEqual([]);
    } finally {
      delete process.env.STIM_POOL_IOS_PARKED_MAX;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a pending adoption retries privacy and keychain cleanup on reuse', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', {
        deviceUdid: 'U1',
        owned: true,
        deviceName: 'stim-app (iPhone 17 Pro 26.2)',
        adopted: true,
        adoptionPending: true,
      });
      const { files, exec } = iosExecutor([
        {
          udid: 'U1',
          name: 'stim-app (iPhone 17 Pro 26.2)',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
        },
      ]);
      setExecutor(exec);
      await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
      });
      expect(files).toContainEqual(['xcrun', 'simctl', 'privacy', 'U1', 'reset', 'all']);
      expect(files).toContainEqual(['xcrun', 'simctl', 'keychain', 'U1', 'reset']);
      expect(getProject(root)?.platforms?.ios?.adoptionPending).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('completing adoption clears both transient adoption fields', () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', {
        deviceUdid: 'U1',
        owned: true,
        deviceName: 'stim-app (iPhone 17 Pro 26.2)',
        adopted: true,
        adoptionPending: true,
        parkedCacheKey: 'fingerprint-debug-sim',
      });

      clearIosAdoptionPending(root);

      expect(getProject(root)?.platforms?.ios).toEqual({
        deviceUdid: 'U1',
        owned: true,
        deviceName: 'stim-app (iPhone 17 Pro 26.2)',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reuse heals a legacy simulator name before returning it', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-old' });
      const { files, exec } = iosExecutor([
        {
          udid: 'U1',
          name: 'stim-old',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
        },
      ]);
      setExecutor(exec);
      const device = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
      });
      expect(device.deviceName).toBe('stim-app (iPhone 17 Pro 26.2)');
      expect(files).toContainEqual(['xcrun', 'simctl', 'rename', 'U1', 'stim-app (iPhone 17 Pro 26.2)']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an invalid SimSlim profile before creating or booting a simulator', async () => {
    const root = projectDir();
    try {
      const { run, exec } = iosExecutor([]);
      setExecutor(exec);

      await expect(
        ensureOwnedDevice({
          platform: 'ios',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: { ios: { simslimProfile: 'missing.json' } },
        }),
      ).rejects.toThrow('Could not read ios.simslimProfile missing.json');

      expect(run).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('applies the configured SimSlim profile to an owned simulator and records management', async () => {
    const root = projectDir();
    try {
      const profilePath = join(root, 'simslim.json');
      writeFileSync(profilePath, '{}\n');
      const profile = realpathSync(profilePath);
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      const { exec } = iosExecutor([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]);
      setExecutor(exec);
      const calls: unknown[] = [];

      await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: { ios: { simslimProfile: 'simslim.json' } },
        reconcileIosSimulator: async (args) => {
          calls.push(args);
          return { managed: true, profile };
        },
      });

      expect(calls).toMatchObject([{ udid: 'U1', profile, previouslyManaged: false }]);
      expect(getProject(root)?.platforms?.ios?.simslimManaged).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records SimSlim management before profile application can fail', async () => {
    const root = projectDir();
    try {
      const profilePath = join(root, 'simslim.json');
      writeFileSync(profilePath, '{}\n');
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      const { exec } = iosExecutor([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]);
      setExecutor(exec);
      let managedBeforeRun = false;

      await expect(
        ensureOwnedDevice({
          platform: 'ios',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: { ios: { simslimProfile: 'simslim.json' } },
          reconcileIosSimulator: async () => {
            managedBeforeRun = getProject(root)?.platforms?.ios?.simslimManaged === true;
            throw new Error('partial SimSlim failure');
          },
        }),
      ).rejects.toThrow('partial SimSlim failure');

      expect(managedBeforeRun).toBe(true);
      expect(getProject(root)?.platforms?.ios?.simslimManaged).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restores stock services when Stim previously managed SimSlim and the setting is removed', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', {
        deviceUdid: 'U1',
        owned: true,
        deviceName: 'stim-app',
        simslimManaged: true,
      });
      const { exec } = iosExecutor([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]);
      setExecutor(exec);
      const calls: unknown[] = [];

      await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        reconcileIosSimulator: async (args) => {
          calls.push(args);
          return { managed: false, profile: null };
        },
      });

      expect(calls).toMatchObject([{ udid: 'U1', profile: null, previouslyManaged: true }]);
      expect(getProject(root)?.platforms?.ios?.simslimManaged).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an owned record renamed away from stim- ownership is never booted; a fresh owned sim is created', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-old' });
      const { run, exec } = iosExecutor([
        { udid: 'U1', name: 'Renamed-By-User', state: 'Shutdown', isAvailable: true },
      ]);
      setExecutor(exec);
      const notes: string[] = [];
      const result = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        note: (l) => notes.push(String(l)),
      });
      expect(run.some((c) => c === 'xcrun simctl boot U1')).toBe(false);
      expect(run.some((c) => /simctl create/.test(c))).toBeTruthy();
      expect(result.deviceUdid).toBe('NEW-UDID');
      expect(result.owned).toBe(true);
      expect(result.created).toBe(true);
      expect(notes.some((n) => /not Stim-owned by name/i.test(n))).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a created sim is registered and its boot handed back, not waited out', async () => {
    const root = projectDir();
    try {
      const { run, spawned, exec } = iosExecutor([]);
      setExecutor(exec);
      const result = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
      });
      expect(result.created).toBe(true);
      expect(result.booting?.udid).toBe('NEW-UDID');
      expect(run).toContain('xcrun simctl boot NEW-UDID');
      expect(getProject(root)?.platforms?.ios).toEqual({
        deviceUdid: 'NEW-UDID',
        owned: true,
        deviceName: 'stim-app (iPhone 17 Pro 26.2)',
      });
      await result.booting?.done;
      expect(spawned).toEqual(['xcrun simctl bootstatus NEW-UDID -b']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the SimSlim reconcile rides on the deferred boot, so nothing installs before it', async () => {
    const root = projectDir();
    try {
      const profilePath = join(root, 'simslim.json');
      writeFileSync(profilePath, '{}\n');
      const profile = realpathSync(profilePath);
      const { exec } = iosExecutor([]);
      setExecutor(exec);
      const calls: unknown[] = [];
      const result = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: { ios: { simslimProfile: 'simslim.json' } },
        reconcileIosSimulator: async (args) => {
          calls.push(args);
          return { managed: true, profile };
        },
      });
      expect(calls).toEqual([]);
      await result.booting?.done;
      expect(calls).toMatchObject([{ udid: 'NEW-UDID', profile, previouslyManaged: false }]);
      expect(getProject(root)?.platforms?.ios?.simslimManaged).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a reused sim hands back a boot only when it had to start one', async () => {
    const shutdown = projectDir();
    const booted = projectDir();
    try {
      setDevice(shutdown, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      setExecutor(iosExecutor([{ udid: 'U1', name: 'stim-app', state: 'Shutdown', isAvailable: true }]).exec);
      const afterBoot = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(shutdown),
        projectPath: shutdown,
        label: 'app',
        settings: {},
      });
      expect(afterBoot.booting?.udid).toBe('U1');
      await afterBoot.booting?.done;

      setDevice(booted, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      setExecutor(iosExecutor([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]).exec);
      const alreadyBooted = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(booted),
        projectPath: booted,
        label: 'app',
        settings: {},
      });
      expect(alreadyBooted.booting).toBeUndefined();
    } finally {
      rmSync(shutdown, { recursive: true, force: true });
      rmSync(booted, { recursive: true, force: true });
    }
  });

  test('a legacy shut-down sim (no owned flag) is reported, never booted', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1' });
      const { run, exec } = iosExecutor([{ udid: 'U1', name: 'iPhone 16', state: 'Shutdown', isAvailable: true }]);
      setExecutor(exec);
      const notes: string[] = [];
      const result = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        note: (l) => notes.push(String(l)),
      });
      expect(run.some((c) => /simctl boot/.test(c))).toBe(false);
      expect(run.some((c) => /simctl create/.test(c))).toBe(false);
      expect(result.deviceUdid).toBe('U1');
      expect(!result.owned).toBeTruthy();
      expect(notes.some((n) => /not owned by Stim/i.test(n))).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureOwnedDevice: android', () => {
  let androidHome: string;
  let prevAndroidHome: string | undefined;
  let prevAndroidAvdHome: string | undefined;

  beforeEach(() => {
    androidHome = mkdtempSync(join(tmpdir(), 'stim-test-sdk-'));
    mkdirSync(join(androidHome, 'system-images', 'android-36', 'google_apis', 'arm64-v8a'), { recursive: true });
    mkdirSync(join(androidHome, 'system-images', 'android-36', 'google_apis', 'x86_64'), { recursive: true });
    prevAndroidHome = process.env.ANDROID_HOME;
    prevAndroidAvdHome = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_HOME = androidHome;
    process.env.ANDROID_AVD_HOME = join(androidHome, 'avd');
  });

  afterEach(() => {
    rmSync(androidHome, { recursive: true, force: true });
    if (prevAndroidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = prevAndroidHome;
    if (prevAndroidAvdHome === undefined) delete process.env.ANDROID_AVD_HOME;
    else process.env.ANDROID_AVD_HOME = prevAndroidAvdHome;
  });

  function androidExecutor({
    avds = [],
    createAvdError = null,
    writeAvdFiles = true,
    beforeCreateAvdError = () => {},
    bootCompletes = true,
    runningAvdName = '',
    onSpawn = () => {},
  }: {
    avds?: string[];
    createAvdError?: string | null;
    writeAvdFiles?: boolean;
    beforeCreateAvdError?: () => void;
    bootCompletes?: boolean;
    runningAvdName?: string;
    onSpawn?: () => void;
  } = {}) {
    const run: string[] = [];
    const spawn: { cmd: string; args: readonly string[]; opts?: object }[] = [];
    return {
      run,
      spawn,
      exec: {
        run(cmd: string) {
          run.push(cmd);
          if (cmd === 'emulator -list-avds') return avds.length ? `${avds.join('\n')}\n` : '';
          if (/create avd/.test(cmd)) {
            if (createAvdError) {
              beforeCreateAvdError();
              throw new Error(createAvdError);
            }
            const name = / -n "([^"]+)"/.exec(cmd)?.[1];
            assert(name);
            avds.push(name);
            if (writeAvdFiles) {
              const root = process.env.ANDROID_AVD_HOME!;
              const content = join(root, `${name}.avd`);
              mkdirSync(content, { recursive: true });
              writeFileSync(join(root, `${name}.ini`), `path=${content}\n`);
              writeFileSync(join(content, 'config.ini'), 'hw.cpu.ncore=4\ndisk.dataPartition.size=10G\n');
            }
            return '';
          }
          if (/delete avd/.test(cmd)) return '';
          if (cmd === 'adb devices') return 'List of devices attached\n';
          if (/emu avd name/.test(cmd)) return runningAvdName;
          if (/getprop sys\.boot_completed/.test(cmd)) return bootCompletes ? '1' : '';
          if (/getprop /.test(cmd)) return '';
          throw new Error(`unexpected run: ${cmd}`);
        },
        runQuiet(cmd: string) {
          try {
            return this.run(cmd);
          } catch {
            return null;
          }
        },
        runFile() {
          return '';
        },
        spawn(cmd: string, args: readonly string[], opts?: object) {
          onSpawn();
          spawn.push({ cmd, args, opts });
          return { pid: 9999, unref() {} };
        },
      },
    };
  }

  test('a legacy physical assignment is reported and replaced by an owned AVD, with nothing issued at the serial', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'android', { serial: 'R5CT10', kind: 'physical', owned: false });
      const { run, exec } = androidExecutor();
      setExecutor(exec);
      const notes: string[] = [];
      const result = await ensureOwnedDevice({
        platform: 'android',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        note: (l) => notes.push(String(l)),
      });
      expect(run.some((c) => c.includes('R5CT10'))).toBe(false);
      expect(result.avdName).toBe('stim-app');
      expect(result.owned).toBe(true);
      expect(notes.some((n) => /stored assignment to physical device R5CT10/i.test(n))).toBeTruthy();
      expect(readFileSync(join(process.env.ANDROID_AVD_HOME!, 'stim-app.avd', 'config.ini'), 'utf8')).toContain(
        'disk.dataPartition.size=8589934592',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a fresh owned AVD uses the configured integer GiB override', async () => {
    const root = projectDir();
    try {
      const { exec } = androidExecutor();
      setExecutor(exec);
      await ensureOwnedDevice({
        platform: 'android',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: { android: { dataPartitionSizeGb: 10 } },
      });
      expect(readFileSync(join(process.env.ANDROID_AVD_HOME!, 'stim-app.avd', 'config.ini'), 'utf8')).toContain(
        'disk.dataPartition.size=10737418240',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a fresh owned AVD merges a repository INI fragment and inline hardware overrides before boot', async () => {
    const root = projectDir();
    try {
      writeFileSync(join(root, 'android-avd.ini'), 'hw.ramSize=3072\nhw.keyboard=no\n');
      const { exec } = androidExecutor();
      setExecutor(exec);
      await ensureOwnedDevice({
        platform: 'android',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {
          android: {
            avdConfigFile: 'android-avd.ini',
            avdConfig: { 'hw.keyboard': true, 'vm.heapSize': 512 },
          },
        },
      });
      expect(readFileSync(join(process.env.ANDROID_AVD_HOME!, 'stim-app.avd', 'config.ini'), 'utf8')).toBe(
        'hw.cpu.ncore=4\ndisk.dataPartition.size=8589934592\nhw.ramSize=3072\nhw.keyboard=yes\nvm.heapSize=512\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalid AVD overrides fail before creating, cleaning, or booting a device', async () => {
    const root = projectDir();
    try {
      const { run, spawn, exec } = androidExecutor();
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: { android: { avdConfig: { 'disk.dataPartition.path': '/tmp/outside' } } },
        }),
      ).rejects.toThrow(/Unsupported android\.avdConfig key/);
      expect(run).toEqual([]);
      expect(spawn).toEqual([]);
      expect(getProject(root)?.platforms?.android).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed new-AVD configuration is centrally deleted and never booted', async () => {
    const root = projectDir();
    try {
      const { run, spawn, exec } = androidExecutor({ writeAvdFiles: false });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
        }),
      ).rejects.toThrow(/could not configure its AVD settings/i);
      expect(run.some((cmd) => /delete avd -n "stim-app"/.test(cmd))).toBe(true);
      expect(spawn).toEqual([]);
      expect(getProject(root)?.platforms?.android).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed configuration rollback stays tracked and cannot be recovered or booted', async () => {
    const root = projectDir();
    try {
      const { run, spawn, exec } = androidExecutor();
      setExecutor(exec);
      const configureAvd = () => {
        throw new Error('EEXIST: file already exists');
      };
      const teardownAvd = () => ({ status: 'failed' as const, reason: 'delete failed' });
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
          configureAvd,
          teardownAvd,
        }),
      ).rejects.toThrow(/could not configure.*already exists.*tracked for cleanup/i);
      expect(getProject(root)?.platforms?.android).toMatchObject({
        avdName: 'stim-app',
        owned: true,
        setupIncomplete: true,
      });
      expect(spawn).toEqual([]);
      expect(run.filter((cmd) => /create avd/.test(cmd))).toHaveLength(1);

      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
          configureAvd,
          teardownAvd,
        }),
      ).rejects.toThrow(/incomplete setup.*could not be deleted/i);
      expect(spawn).toEqual([]);
      expect(run.filter((cmd) => /create avd/.test(cmd))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unrecorded existing owned AVD is recovered without resizing it', async () => {
    const root = projectDir();
    const avdRoot = process.env.ANDROID_AVD_HOME!;
    const content = join(avdRoot, 'stim-app.avd');
    mkdirSync(content, { recursive: true });
    writeFileSync(join(avdRoot, 'stim-app.ini'), `path=${content}\n`);
    writeFileSync(join(content, 'config.ini'), 'disk.dataPartition.size=10G\n');
    try {
      const { exec } = androidExecutor({
        avds: ['stim-app'],
        createAvdError: 'Error: AVD stim-app already exists.',
      });
      setExecutor(exec);
      await ensureOwnedDevice({
        platform: 'android',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: { android: { dataPartitionSizeGb: 6, avdConfig: { 'hw.keyboard': true } } },
        configureAvd: () => {
          throw new Error('must not configure a recovered AVD');
        },
      });
      expect(readFileSync(join(content, 'config.ini'), 'utf8')).toBe('disk.dataPartition.size=10G\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a stale project snapshot cannot recover an AVD another concurrent run just recorded', async () => {
    const root = projectDir();
    try {
      const staleProject = getProject(root);
      const { spawn, exec } = androidExecutor({
        avds: ['stim-app'],
        createAvdError: 'Error: AVD stim-app already exists.',
        beforeCreateAvdError: () => {
          setDevice(root, 'android', { avdName: 'stim-app', owned: true, setupIncomplete: true });
        },
      });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: staleProject,
          projectPath: root,
          label: 'app',
          settings: {},
        }),
      ).rejects.toThrow(/incomplete setup.*concurrent Stim run/i);
      expect(spawn).toEqual([]);
      expect(getProject(root)?.platforms?.android).toMatchObject({
        avdName: 'stim-app',
        setupIncomplete: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an existing AVD owned by ANOTHER project errors instead of being hijacked', async () => {
    const other = projectDir();
    const root = projectDir();
    try {
      setDevice(other, 'android', { avdName: 'stim-app', consolePort: 5554, owned: true });
      const { exec } = androidExecutor({
        avds: ['stim-app'],
        createAvdError: 'Error: AVD stim-app already exists.',
      });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
        }),
      ).rejects.toThrow(/owned by another project/);
    } finally {
      rmSync(other, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the console port is recorded before the emulator process is spawned', async () => {
    const root = projectDir();
    try {
      let recordedAtSpawn: DeviceRecord | undefined;
      const { spawn, exec } = androidExecutor({
        onSpawn: () => {
          recordedAtSpawn = getProject(root)?.platforms?.android;
        },
      });
      setExecutor(exec);
      const result = await ensureOwnedDevice({
        platform: 'android',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
      });
      expect(result.consolePort).toBe(5554);
      expect(recordedAtSpawn).toMatchObject({ avdName: 'stim-app', consolePort: 5554, owned: true });
      expect(spawn[0]?.args).toContain('5554');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed boot releases the port claim and keeps the owned AVD recorded for gc', async () => {
    const root = projectDir();
    try {
      const { exec } = androidExecutor({ bootCompletes: false });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
          alive: () => false,
        }),
      ).rejects.toThrow(/exited before the device finished booting/);
      const record = getProject(root)?.platforms?.android;
      expect(record).toMatchObject({ avdName: 'stim-app', owned: true });
      expect(record?.consolePort).toBeUndefined();
      expect(allConsolePortsAndSerials().androidConsolePorts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an emulator that booted another AVD on the claimed serial is refused and the claim released', async () => {
    const root = projectDir();
    try {
      const { exec } = androidExecutor({ runningAvdName: 'Pixel_7_API_35\nOK' });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
        }),
      ).rejects.toThrow(/emulator-5554 is running AVD Pixel_7_API_35, not this workspace's owned AVD stim-app/);
      expect(getProject(root)?.platforms?.android?.consolePort).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('claimAndroidConsolePort', () => {
  function fakeRegistry() {
    const ports = new Map<string, number>();
    let depth = 0;
    const seenDepths: number[] = [];
    return {
      ports,
      seenDepths,
      lock: <T>(fn: () => T): T => {
        expect(depth).toBe(0);
        depth += 1;
        try {
          return fn();
        } finally {
          depth -= 1;
        }
      },
      recordedPorts: () => {
        seenDepths.push(depth);
        return [...ports.values()];
      },
      record: (projectPath: string, _platform: string, fields: DeviceRecord) => {
        seenDepths.push(depth);
        ports.set(projectPath, fields.consolePort as number);
      },
    };
  }

  test('two workspaces claiming at once take distinct ports because the read and the record share one lock', () => {
    const registry = fakeRegistry();
    const deps = { lock: registry.lock, recordedPorts: registry.recordedPorts, record: registry.record };
    const first = claimAndroidConsolePort({ projectPath: '/w/a', avdName: 'stim-a' }, deps);
    const second = claimAndroidConsolePort({ projectPath: '/w/b', avdName: 'stim-b' }, deps);
    expect(first.consolePort).toBe(5554);
    expect(second.consolePort).toBe(5556);
    expect([...registry.ports]).toEqual([
      ['/w/a', 5554],
      ['/w/b', 5556],
    ]);
    expect(registry.seenDepths).toEqual([1, 1, 1, 1]);
  });

  test('live emulator ports outside the registry are claimed too', () => {
    const registry = fakeRegistry();
    const claim = claimAndroidConsolePort(
      { projectPath: '/w/a', avdName: 'stim-a', deviceName: 'stim-a', livePorts: [5554, 5556] },
      { lock: registry.lock, recordedPorts: registry.recordedPorts, record: registry.record },
    );
    expect(claim.consolePort).toBe(5558);
    expect(registry.ports.get('/w/a')).toBe(5558);
  });
});

describe('deviceCapacityRefusal', () => {
  const booted = (udid: string, name: string) => makeIosSim({ udid, name, state: 'Booted' });
  const shutdown = (udid: string, name: string) => makeIosSim({ udid, name, state: 'Shutdown' });

  test('unlimited (max 0) never refuses', () => {
    const sims = [booted('u1', 'stim-a'), booted('u2', 'stim-b')];
    expect(
      deviceCapacityRefusal({
        platform: 'ios',
        project: {},
        max: 0,
        sims,
        adb: makeAdbDevices({ emulators: [] }),
        config: makeConfig(),
      }),
    ).toBe(null);
  });

  test('at the cap, a fresh workspace is refused with STIM_AT_CAPACITY', () => {
    const sims = [booted('u1', 'stim-a'), booted('u2', 'stim-b')];
    const refusal = deviceCapacityRefusal({
      platform: 'ios',
      project: { platforms: {} },
      max: 2,
      sims,
      adb: makeAdbDevices({ emulators: [] }),
      config: makeConfig(),
    });
    assert(refusal);
    expect(refusal.code).toBe('STIM_AT_CAPACITY');
    expect(refusal.remedy).toMatch(/stim stop|maxDevices/);
  });

  test('a workspace whose OWN sim is already booted is never refused', () => {
    const sims = [booted('u1', 'stim-a'), booted('u2', 'stim-b')];
    const project = { platforms: { ios: { deviceUdid: 'u1', owned: true } } };
    expect(
      deviceCapacityRefusal({
        platform: 'ios',
        project,
        max: 2,
        sims,
        adb: makeAdbDevices({ emulators: [] }),
        config: makeConfig(),
      }),
    ).toBe(null);
  });

  test('only BOOTED Stim sims count toward the cap', () => {
    const sims = [booted('u1', 'stim-a'), shutdown('u2', 'stim-b'), booted('u3', 'someone-else')];
    expect(
      deviceCapacityRefusal({
        platform: 'ios',
        project: { platforms: {} },
        max: 2,
        sims,
        adb: makeAdbDevices({ emulators: [] }),
        config: makeConfig(),
      }),
    ).toBe(null);
  });

  test('a running owned Android emulator counts via the registry', () => {
    const config = makeConfig({
      projects: { '/w/x': { platforms: { android: { avdName: 'stim-x', consolePort: 5556, owned: true } } } },
    });
    const adb = makeAdbDevices({ emulators: [{ serial: 'emulator-5556', consolePort: 5556 }] });
    const refusal = deviceCapacityRefusal({
      platform: 'android',
      project: { platforms: {} },
      max: 1,
      sims: [],
      adb,
      config,
    });
    assert(refusal);
    expect(refusal.code).toBe('STIM_AT_CAPACITY');
  });
});

const RUNTIMES = [
  {
    identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
    name: 'iOS 26.2',
    version: '26.2',
    supportedDeviceTypes: TYPES,
  },
];

const VISION_PRO = { identifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro', name: 'Apple Vision Pro' };
const SIMCTL_DEVICE_TYPES = [...TYPES, VISION_PRO];

const IMAGES = [
  { api: 36, tag: 'google_apis', arch: 'arm64-v8a', pkg: 'system-images;android-36;google_apis;arm64-v8a' },
];

describe('the unknown-name refusals', () => {
  test('a device type an installed runtime supports passes, and nothing is refused when none was asked for', () => {
    expect(unknownIosDeviceTypeRefusal('iPhone 17 Pro', RUNTIMES)).toBe(null);
    expect(unknownIosDeviceTypeRefusal(null, RUNTIMES)).toBe(null);
    expect(unknownIosDeviceTypeRefusal(undefined, [])).toBe(null);
  });

  test('a device type simctl lists but no iOS runtime can create is refused, not left to fail at creation', () => {
    expect(SIMCTL_DEVICE_TYPES.some((d) => d.name === VISION_PRO.name)).toBe(true);
    const refusal = unknownIosDeviceTypeRefusal(VISION_PRO.name, RUNTIMES);
    assert(refusal);
    expect(refusal.message).toMatch(
      /No device type named "Apple Vision Pro" can be created on any installed simulator runtime/,
    );
    expect(refusal.message).toMatch(/Device types the installed runtimes support: iPhone 17 Pro, iPhone 16\./);
    expect(refusal.message).not.toMatch(/Apple Vision Pro\./);
    expect(refusal.remedy).toMatch(/--device-type/);
    expect(refusal.remedy).toMatch(/watchOS, tvOS and visionOS/);
  });

  test('the printed set narrows to the requested runtime, and a pair no runtime offers is refused', () => {
    const runtimes = [
      ...RUNTIMES,
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
        name: 'iOS 18.5',
        version: '18.5',
        supportedDeviceTypes: [TYPE_16],
      },
    ];
    expect(unknownIosDeviceTypeRefusal('iPhone 17 Pro', runtimes, '26.2')).toBe(null);
    const refusal = unknownIosDeviceTypeRefusal('iPhone 17 Pro', runtimes, '18.5');
    assert(refusal);
    expect(refusal.message).toMatch(/No device type named "iPhone 17 Pro" can be created on runtime 18\.5/);
    expect(refusal.message).toMatch(/Device types runtime 18\.5 supports: iPhone 16\./);
  });

  test('a machine with nothing installed says so rather than printing an empty list', () => {
    const refusal = unknownIosDeviceTypeRefusal('iPhone 17 Pro', []);
    assert(refusal);
    expect(refusal.message).toMatch(/Device types the installed runtimes support: none\./);
  });

  test('a runtime matches by exact version or exact name, never by suffix', () => {
    expect(unknownIosRuntimeRefusal('26.2', RUNTIMES)).toBe(null);
    expect(unknownIosRuntimeRefusal('iOS 26.2', RUNTIMES)).toBe(null);
    expect(unknownIosRuntimeRefusal('6.2', RUNTIMES)).not.toBe(null);
    expect(unknownIosRuntimeRefusal('2', RUNTIMES)).not.toBe(null);
    const refusal = unknownIosRuntimeRefusal('18.5', RUNTIMES);
    assert(refusal);
    expect(refusal.message).toMatch(/No installed simulator runtime matches "18\.5"\. Installed runtimes: 26\.2\./);
    expect(refusal.remedy).toMatch(/ios\.runtime/);
    expect(refusal.remedy).toMatch(/"iOS 26\.5"/);
  });

  test('an Android system image is matched on the exact sdkmanager package id', () => {
    expect(unknownAndroidSystemImageRefusal('system-images;android-36;google_apis;arm64-v8a', IMAGES)).toBe(null);
    expect(unknownAndroidSystemImageRefusal(null, IMAGES)).toBe(null);
    const refusal = unknownAndroidSystemImageRefusal('system-images;android-99;google_apis;arm64-v8a', IMAGES);
    assert(refusal);
    expect(refusal.message).toMatch(/No installed Android system image is named/);
    expect(refusal.message).toMatch(/Installed system images: system-images;android-36;google_apis;arm64-v8a\./);
    expect(refusal.remedy).toMatch(/android\.systemImage/);
  });
});

describe('ensureOwnedDevice: the requested model against the sim this workspace already owns', () => {
  test('a different model refuses with the reap-then-rerun remedy and boots nothing', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      const { run, exec } = iosExecutor([
        {
          udid: 'U1',
          name: 'stim-app',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: TYPE_16.identifier,
        },
      ]);
      setExecutor(exec);

      await expect(
        ensureOwnedDevice({
          platform: 'ios',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
          flags: { deviceType: 'iPhone 17 Pro' },
        }),
      ).rejects.toThrow(
        /this project's sim is iPhone 16, but --device-type asked for iPhone 17 Pro\. Stim will not silently boot a different model\. Run `stim worktree remove` \(or `stim gc --delete`\) to reap the current sim, then `stim ios` again to create the requested one\./,
      );

      expect(run.some((cmd) => /simctl boot/.test(cmd))).toBe(false);
      expect(run.some((cmd) => /simctl create/.test(cmd))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a matching model reuses the sim and reports its model and runtime', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      const { exec } = iosExecutor([
        {
          udid: 'U1',
          name: 'stim-app',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: TYPE_16.identifier,
        },
      ]);
      setExecutor(exec);

      const device = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        flags: { deviceType: 'iPhone 16' },
      });

      expect(device.deviceType).toBe('iPhone 16');
      expect(device.runtime).toBe('26.2');
      expect(getProject(root)?.platforms?.ios?.deviceType).toBe(undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a created sim reports the model and runtime it was created with', async () => {
    const root = projectDir();
    try {
      const { run, exec } = iosExecutor([]);
      setExecutor(exec);

      const device = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        flags: { deviceType: 'iPhone 16', runtime: '26.2' },
      });

      expect(device.deviceType).toBe('iPhone 16');
      expect(device.runtime).toBe('26.2');
      expect(run.some((cmd) => cmd.includes(`simctl create "stim-app (iPhone 16 26.2)" "${TYPE_16.identifier}"`))).toBe(
        true,
      );
      expect(getProject(root)?.platforms?.ios?.runtime).toBe(undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
