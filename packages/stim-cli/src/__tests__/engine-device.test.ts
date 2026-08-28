import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { deviceCapacityRefusal, deviceTypeMismatch, ensureBooted, ensureOwnedDevice } from '../engine/device.ts';
import { getProject, setDevice, upsertProject } from '../config.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeAdbDevices, makeConfig, makeIosSim } from './_factories.ts';

type SimEntry = { udid: string; name: string; state: string; isAvailable: boolean };

let tmpHome: string;
let savedAndroidHome: string | undefined;
let savedSdkRoot: string | undefined;
let savedDisplay: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-cli-test-'));
  process.env.STIM_CLI_HOME = tmpHome;
  savedAndroidHome = process.env.ANDROID_HOME;
  savedSdkRoot = process.env.ANDROID_SDK_ROOT;
  process.env.ANDROID_HOME = join(tmpHome, 'no-sdk-here');
  delete process.env.ANDROID_SDK_ROOT;
  savedDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':0';
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_CLI_HOME;
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
        return simList([{ udid: 'U1', name: 'stim-cli-app', state: 'Booted', isAvailable: true }]);
      },
      runQuiet: (cmd) => {
        commands.push(cmd);
        return '';
      },
      runFile: () => '',
      spawn: () => null,
    });
    expect(await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1', owned: true } })).toEqual({
      ok: true,
      udid: 'U1',
    });
    expect(commands.filter((c) => c.includes('simctl boot')).length).toBe(0);
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
          return simList([{ udid: 'U1', name: 'stim-cli-app', state, isAvailable: true }]);
        }
        return '';
      },
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => null,
    });
    const result = await ensureBooted({
      platform: 'ios',
      device: { deviceUdid: 'U1', owned: true },
      timeoutMs: 5000,
      pollMs: 5,
    });
    expect(result).toEqual({ ok: true, udid: 'U1' });
    expect(commands.filter((c) => c === 'xcrun simctl boot U1').length).toBe(1);
  });

  test('refuses to boot a sim that is no longer stim-cli-owned by name', async () => {
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
    expect(result.reason).toMatch(/not stim-cli-owned/);
  });

  test('reports a sim that no longer exists rather than booting a stale udid', async () => {
    setExecutor({ run: () => simList([]), runQuiet: () => '', runFile: () => '', spawn: () => null });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'GONE' } });
    expect(result.reason).toMatch(/no longer exists/);
    expect(result.reason).toMatch(/stim-cli ios/);
  });

  test('times out with a reason instead of hanging when the sim never boots', async () => {
    setExecutor({
      run: (cmd) =>
        cmd.includes('list devices')
          ? simList([{ udid: 'U1', name: 'stim-cli-app', state: 'Booting', isAvailable: true }])
          : '',
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => null,
    });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'U1' }, timeoutMs: 60, pollMs: 5 });
    expect(result.reason).toMatch(/did not reach the Booted state/);
  });

  test('reports a missing record rather than throwing', async () => {
    setExecutor({ run: () => '', runQuiet: () => '', runFile: () => '', spawn: () => null });
    expect((await ensureBooted({ platform: 'ios', device: {} })).reason).toMatch(/No iOS simulator is recorded/);
  });
});

describe('ensureBooted: android', () => {
  test('waits for boot completion on an already-running owned AVD', async () => {
    const commands: string[] = [];
    setExecutor({
      run: (cmd) => {
        commands.push(cmd);
        if (cmd === 'emulator -list-avds') return 'stim-cli-app';
        if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice';
        return '';
      },
      runQuiet: (cmd) => {
        commands.push(cmd);
        if (cmd.includes('emu avd name')) return 'stim-cli-app\nOK';
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
      device: { avdName: 'stim-cli-app', consolePort: 5554, owned: true },
    });
    expect(result).toEqual({ ok: true, serial: 'emulator-5554' });
  });

  test('boots a stopped owned AVD on its recorded port and waits', async () => {
    const spawned: string[][] = [];
    let booted = false;
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-cli-app';
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
      device: { avdName: 'stim-cli-app', consolePort: 5556, owned: true },
      timeoutMs: 5000,
    });
    expect(result).toEqual({ ok: true, serial: 'emulator-5556' });
    expect(spawned).toEqual([['emulator', '-avd', 'stim-cli-app', '-port', '5556']]);
  });

  test('reuses the serial returned by a fresh owned AVD boot when adb listing briefly misses it', async () => {
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-cli-app';
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
        avdName: 'stim-cli-app',
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
        if (cmd === 'emulator -list-avds') return 'stim-cli-app';
        if (cmd === 'adb devices') {
          const rows = ['List of devices attached', 'emulator-5554\tdevice'];
          if (ourSerial) rows.push(`${ourSerial}\tdevice`);
          return rows.join('\n');
        }
        return '';
      },
      runQuiet: (cmd) => {
        if (cmd.includes('emu avd name')) return cmd.includes('5554') ? 'Pixel_7_API_35\nOK' : 'stim-cli-app\nOK';
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
      device: { avdName: 'stim-cli-app', consolePort: 5554, owned: true },
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
        if (cmd === 'emulator -list-avds') return 'stim-cli-app';
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
      device: { avdName: 'stim-cli-app', consolePort: 5556, owned: true },
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
        if (cmd === 'emulator -list-avds') return 'stim-cli-app';
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
      device: { avdName: 'stim-cli-app', consolePort: 5556, owned: true },
      timeoutMs: 20000,
      alive: () => true,
    });
    expect(result).toEqual({ ok: true, serial: 'emulator-5556' });
    expect(probes >= 5).toBeTruthy();
  });

  test('ensureBooted hands the caller log file to the emulator spawn', async () => {
    const logFile = join(tmpHome, 'ws', '.stim-cli', 'logs', 'emulator.log');
    const opts: Array<Record<string, unknown>> = [];
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-cli-app';
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
      device: { avdName: 'stim-cli-app', consolePort: 5556, owned: true },
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

  test('refuses an AVD that is not stim-cli-owned by name', async () => {
    setExecutor({
      run: (cmd) => (cmd === 'emulator -list-avds' ? 'Pixel_7_API_35' : ''),
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => {
        throw new Error('must not boot a foreign AVD');
      },
    });
    const result = await ensureBooted({ platform: 'android', device: { avdName: 'Pixel_7_API_35' } });
    expect(result.reason).toMatch(/not stim-cli-owned/);
  });

  test('refuses a legacy physical record without issuing a single command at it', async () => {
    setExecutor({
      run: (cmd) => {
        throw new Error(`stim-cli must not run "${cmd}" for a physical record`);
      },
      runQuiet: () => {
        throw new Error('stim-cli must not probe hardware');
      },
      runFile: () => {
        throw new Error('stim-cli must not probe hardware');
      },
      spawn: () => {
        throw new Error('stim-cli must never try to boot hardware');
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
  const dir = mkdtempSync(join(tmpdir(), 'stim-cli-test-proj-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch-app' }));
  upsertProject(dir, { bundleId: undefined, androidPackage: undefined, isExpo: false });
  return dir;
}

function iosExecutor(devices: SimEntry[]) {
  const run: string[] = [];
  return {
    run,
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
      runFile() {
        return '';
      },
      spawn() {
        return { pid: 1, unref() {} };
      },
    },
  };
}

describe('ensureOwnedDevice: ios', () => {
  test('an owned record renamed away from stim-cli- ownership is never booted; a fresh owned sim is created', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-cli-old' });
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
      expect(notes.some((n) => /not stim-cli-owned by name/i.test(n))).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
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
      expect(notes.some((n) => /not owned by stim-cli/i.test(n))).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureOwnedDevice: android', () => {
  let androidHome: string;
  let prevAndroidHome: string | undefined;

  beforeEach(() => {
    androidHome = mkdtempSync(join(tmpdir(), 'stim-cli-test-sdk-'));
    mkdirSync(join(androidHome, 'system-images', 'android-36', 'google_apis', 'arm64-v8a'), { recursive: true });
    mkdirSync(join(androidHome, 'system-images', 'android-36', 'google_apis', 'x86_64'), { recursive: true });
    prevAndroidHome = process.env.ANDROID_HOME;
    process.env.ANDROID_HOME = androidHome;
  });

  afterEach(() => {
    rmSync(androidHome, { recursive: true, force: true });
    if (prevAndroidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = prevAndroidHome;
  });

  function androidExecutor({
    avds = [],
    createAvdError = null,
  }: { avds?: string[]; createAvdError?: string | null } = {}) {
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
            if (createAvdError) throw new Error(createAvdError);
            return '';
          }
          if (cmd === 'adb devices') return 'List of devices attached\n';
          if (/emu avd name/.test(cmd)) return '';
          if (/getprop sys\.boot_completed/.test(cmd)) return '1';
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
      expect(result.avdName).toBe('stim-cli-app');
      expect(result.owned).toBe(true);
      expect(notes.some((n) => /no longer supports physical devices/i.test(n))).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an existing AVD owned by ANOTHER project errors instead of being hijacked', async () => {
    const other = projectDir();
    const root = projectDir();
    try {
      setDevice(other, 'android', { avdName: 'stim-cli-app', consolePort: 5554, owned: true });
      const { exec } = androidExecutor({
        avds: ['stim-cli-app'],
        createAvdError: 'Error: AVD stim-cli-app already exists.',
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
});

describe('deviceCapacityRefusal', () => {
  const booted = (udid: string, name: string) => makeIosSim({ udid, name, state: 'Booted' });
  const shutdown = (udid: string, name: string) => makeIosSim({ udid, name, state: 'Shutdown' });

  test('unlimited (max 0) never refuses', () => {
    const sims = [booted('u1', 'stim-cli-a'), booted('u2', 'stim-cli-b')];
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

  test('at the cap, a fresh workspace is refused with STIM_CLI_AT_CAPACITY', () => {
    const sims = [booted('u1', 'stim-cli-a'), booted('u2', 'stim-cli-b')];
    const refusal = deviceCapacityRefusal({
      platform: 'ios',
      project: { platforms: {} },
      max: 2,
      sims,
      adb: makeAdbDevices({ emulators: [] }),
      config: makeConfig(),
    });
    assert(refusal);
    expect(refusal.code).toBe('STIM_CLI_AT_CAPACITY');
    expect(refusal.remedy).toMatch(/stim-cli stop|maxDevices/);
  });

  test('a workspace whose OWN sim is already booted is never refused', () => {
    const sims = [booted('u1', 'stim-cli-a'), booted('u2', 'stim-cli-b')];
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

  test('only BOOTED stim-cli sims count toward the cap', () => {
    const sims = [booted('u1', 'stim-cli-a'), shutdown('u2', 'stim-cli-b'), booted('u3', 'someone-else')];
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
      projects: { '/w/x': { platforms: { android: { avdName: 'stim-cli-x', consolePort: 5556, owned: true } } } },
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
    expect(refusal.code).toBe('STIM_CLI_AT_CAPACITY');
  });
});
