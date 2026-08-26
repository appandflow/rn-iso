// engine/device.js -- the owned-device guarantee and the booted guarantee.
//
// Both halves live here now. `ensureOwnedDevice` used to be covered through
// commands/up.js and test/up.test.js; when v3 deleted that command, the
// ownership behaviours it pinned (CLAUDE.md item 2) were re-pinned here
// against the function directly, which is both the real home of the rule and
// a far smaller harness than driving a command was.
//
// The rule under test throughout is the ownership rule: a device that is not
// rn-iso's by name is never booted, only reported -- and, since v3 removed
// physical-device support, no path here ever issues a command at hardware.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  // Pin Android tool resolution to the bare-name fallback: the machine's
  // real SDK (if any) must not leak absolute paths into the command strings
  // the executor mocks below match exactly.
  savedAndroidHome = process.env.ANDROID_HOME;
  savedSdkRoot = process.env.ANDROID_SDK_ROOT;
  process.env.ANDROID_HOME = join(tmpHome, 'no-sdk-here');
  delete process.env.ANDROID_SDK_ROOT;
  // Pin a display so the exact-argv emulator-boot assertions hold on a
  // headless CI runner too (displayless linux appends the headless flags;
  // that behaviour has its own pure test in sim-android.test.ts).
  savedDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':0';
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
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
        return simList([{ udid: 'U1', name: 'rn-iso-app', state: 'Booted', isAvailable: true }]);
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
          // Shutdown on the pre-boot resolve and the first poll, Booted after.
          const state = listCalls >= 3 ? 'Booted' : 'Shutdown';
          return simList([{ udid: 'U1', name: 'rn-iso-app', state, isAvailable: true }]);
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

  // The ownership rule: a sim renamed away from the rn-iso- prefix is
  // somebody's real simulator. Booting it would be exactly the mistake
  // resolveOwnedIosSim exists to prevent on the teardown side.
  test('refuses to boot a sim that is no longer rn-iso-owned by name', async () => {
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
    expect(result.reason).toMatch(/not rn-iso-owned/);
  });

  test('reports a sim that no longer exists rather than booting a stale udid', async () => {
    setExecutor({ run: () => simList([]), runQuiet: () => '', runFile: () => '', spawn: () => null });
    const result = await ensureBooted({ platform: 'ios', device: { deviceUdid: 'GONE' } });
    expect(result.reason).toMatch(/no longer exists/);
    expect(result.reason).toMatch(/rn-iso ios/);
  });

  test('times out with a reason instead of hanging when the sim never boots', async () => {
    setExecutor({
      run: (cmd) =>
        cmd.includes('list devices')
          ? simList([{ udid: 'U1', name: 'rn-iso-app', state: 'Booting', isAvailable: true }])
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
  // "adb sees it" is not "the framework is up": `adb install` against an
  // emulator mid-boot fails with "Can't find service: package", so a running
  // emulator is still waited on.
  test('waits for boot completion on an already-running owned AVD', async () => {
    const commands: string[] = [];
    setExecutor({
      run: (cmd) => {
        commands.push(cmd);
        if (cmd === 'emulator -list-avds') return 'rn-iso-app';
        if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice';
        return '';
      },
      runQuiet: (cmd) => {
        commands.push(cmd);
        if (cmd.includes('emu avd name')) return 'rn-iso-app\nOK';
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
      device: { avdName: 'rn-iso-app', consolePort: 5554, owned: true },
    });
    expect(result).toEqual({ ok: true, serial: 'emulator-5554' });
  });

  test('boots a stopped owned AVD on its recorded port and waits', async () => {
    const spawned: string[][] = [];
    let booted = false;
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'rn-iso-app';
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
      device: { avdName: 'rn-iso-app', consolePort: 5556, owned: true },
      timeoutMs: 5000,
    });
    expect(result).toEqual({ ok: true, serial: 'emulator-5556' });
    expect(spawned).toEqual([['emulator', '-avd', 'rn-iso-app', '-port', '5556']]);
  });

  // A console port is a slot, not an identity: Android Studio's default
  // emulator starts at 5554 too. Booting onto an occupied port silently
  // attaches this workspace to a foreign emulator.
  test('allocates a fresh console port when the recorded one is taken by a foreign emulator', async () => {
    const spawned: string[][] = [];
    let ourSerial: string | null = null;
    setExecutor({
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'rn-iso-app';
        if (cmd === 'adb devices') {
          const rows = ['List of devices attached', 'emulator-5554\tdevice'];
          if (ourSerial) rows.push(`${ourSerial}\tdevice`);
          return rows.join('\n');
        }
        return '';
      },
      runQuiet: (cmd) => {
        if (cmd.includes('emu avd name')) return cmd.includes('5554') ? 'Pixel_7_API_35\nOK' : 'rn-iso-app\nOK';
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
      device: { avdName: 'rn-iso-app', consolePort: 5554, owned: true },
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.serial).not.toBe('emulator-5554');
    assert(result.serial);
    const call = spawned[0];
    assert(call);
    expect(call[4]).toBe(result.serial.replace('emulator-', ''));
  });

  test('refuses an AVD that is not rn-iso-owned by name', async () => {
    setExecutor({
      run: (cmd) => (cmd === 'emulator -list-avds' ? 'Pixel_7_API_35' : ''),
      runQuiet: () => '',
      runFile: () => '',
      spawn: () => {
        throw new Error('must not boot a foreign AVD');
      },
    });
    const result = await ensureBooted({ platform: 'android', device: { avdName: 'Pixel_7_API_35' } });
    expect(result.reason).toMatch(/not rn-iso-owned/);
  });

  // Hardware cannot be spawned: a physical record is reported, never booted.
  // v3 removed physical-device support entirely. A legacy record that names a
  // serial instead of an AVD must resolve to a refusal, and -- the part that
  // matters -- must issue NOTHING at that serial: no adb probe, no boot.
  test('refuses a legacy physical record without issuing a single command at it', async () => {
    setExecutor({
      run: (cmd) => {
        throw new Error(`rn-iso must not run "${cmd}" for a physical record`);
      },
      runQuiet: () => {
        throw new Error('rn-iso must not probe hardware');
      },
      runFile: () => {
        throw new Error('rn-iso must not probe hardware');
      },
      spawn: () => {
        throw new Error('rn-iso must never try to boot hardware');
      },
    });
    // A legacy physical record still carries `kind` (CLAUDE.md item 2); bind it
    // to a local so the extra field is structurally accepted without a cast.
    const physical = { serial: 'R5CT10', kind: 'physical', owned: false };
    const result = await ensureBooted({ platform: 'android', device: physical });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/No owned Android emulator is recorded/);
  });
});

test('ensureBooted reports an unknown platform rather than throwing', async () => {
  expect((await ensureBooted({ platform: 'web', device: {} })).reason).toMatch(/Unknown platform/);
});

// --- deviceTypeMismatch: pure --------------------------------------------
//
// Honouring the requested device type on REUSE, not just on creation: before
// this existed, asking for a different model against an existing environment
// silently booted the old one and the setting looked broken.

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

// --- ensureOwnedDevice: the ownership rule --------------------------------

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
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-test-proj-'));
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
  test('an owned record renamed away from rn-iso- ownership is never booted; a fresh owned sim is created', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'rn-iso-old' });
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
      expect(notes.some((n) => /not rn-iso-owned by name/i.test(n))).toBeTruthy();
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
      expect(notes.some((n) => /not owned by rn-iso/i.test(n))).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureOwnedDevice: android', () => {
  let androidHome: string;
  let prevAndroidHome: string | undefined;

  beforeEach(() => {
    androidHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-sdk-'));
    // Both architectures, so image resolution succeeds whatever the host
    // running this suite is (the pick matches the host arch).
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

  // v3 removed physical-device support. A legacy `--serial` assignment must
  // resolve toward creating an owned emulator -- never toward a command aimed
  // at the hardware the record names.
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
      expect(result.avdName).toBe('rn-iso-app');
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
      setDevice(other, 'android', { avdName: 'rn-iso-app', consolePort: 5554, owned: true });
      const { exec } = androidExecutor({
        avds: ['rn-iso-app'],
        createAvdError: 'Error: AVD rn-iso-app already exists.',
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

// --- device concurrency cap (opt-in) ---
// maxDevices refuses a NEW device once the machine is at the cap, but never
// refuses a workspace that already has a live device of its own (idempotent).
describe('deviceCapacityRefusal', () => {
  const booted = (udid: string, name: string) => makeIosSim({ udid, name, state: 'Booted' });
  const shutdown = (udid: string, name: string) => makeIosSim({ udid, name, state: 'Shutdown' });

  test('unlimited (max 0) never refuses', () => {
    const sims = [booted('u1', 'rn-iso-a'), booted('u2', 'rn-iso-b')];
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

  test('at the cap, a fresh workspace is refused with RN_ISO_AT_CAPACITY', () => {
    const sims = [booted('u1', 'rn-iso-a'), booted('u2', 'rn-iso-b')];
    const refusal = deviceCapacityRefusal({
      platform: 'ios',
      project: { platforms: {} },
      max: 2,
      sims,
      adb: makeAdbDevices({ emulators: [] }),
      config: makeConfig(),
    });
    assert(refusal);
    expect(refusal.code).toBe('RN_ISO_AT_CAPACITY');
    expect(refusal.remedy).toMatch(/rn-iso stop|maxDevices/);
  });

  test('a workspace whose OWN sim is already booted is never refused', () => {
    const sims = [booted('u1', 'rn-iso-a'), booted('u2', 'rn-iso-b')];
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

  test('only BOOTED rn-iso sims count toward the cap', () => {
    const sims = [booted('u1', 'rn-iso-a'), shutdown('u2', 'rn-iso-b'), booted('u3', 'someone-else')];
    // One booted rn-iso sim, cap of 2 -> under cap, a fresh workspace is allowed.
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
      projects: { '/w/x': { platforms: { android: { avdName: 'rn-iso-x', consolePort: 5556, owned: true } } } },
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
    expect(refusal.code).toBe('RN_ISO_AT_CAPACITY');
  });
});
