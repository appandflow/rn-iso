import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../exec.ts';
import {
  MAX_EMULATOR_FAILURE_LINES,
  androidToolPath,
  buildToolsMajor,
  emulatorFailureRemedy,
  extractEmulatorFailure,
  findBuildTool,
  headlessEmulatorArgs,
  bootAndroidEmulator,
  listAvds,
  parseAvdList,
  parseAdbDevices,
  nextConsolePort,
  pickDefaultSystemImage,
  hostSystemImageArch,
  deleteAvd,
  resolveOwnedAvdSerial,
  waitForBoot,
} from '../sim/android.ts';

let tmpHome: string;
let savedAndroidHome: string | undefined;
let savedSdkRoot: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  savedAndroidHome = process.env.ANDROID_HOME;
  savedSdkRoot = process.env.ANDROID_SDK_ROOT;
  process.env.ANDROID_HOME = join(tmpHome, 'no-sdk-here');
  delete process.env.ANDROID_SDK_ROOT;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
  if (savedAndroidHome === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = savedAndroidHome;
  if (savedSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
  else process.env.ANDROID_SDK_ROOT = savedSdkRoot;
  resetExecutor();
});

function makeFakeSdk(root: string): string {
  const sdk = join(root, 'sdk');
  mkdirSync(join(sdk, 'emulator'), { recursive: true });
  writeFileSync(join(sdk, 'emulator', 'emulator'), '');
  mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
  writeFileSync(join(sdk, 'platform-tools', 'adb'), '');
  mkdirSync(join(sdk, 'cmdline-tools', 'latest', 'bin'), { recursive: true });
  writeFileSync(join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager'), '');
  return sdk;
}

test('parseAvdList strips header and blanks', () => {
  const out = `INFO    | Storing AVDs in...\nPixel_6_API_34\nPixel_7_API_33\n`;
  const avds = parseAvdList(out);
  expect(avds).toEqual(['Pixel_6_API_34', 'Pixel_7_API_33']);
});

test('parseAdbDevices extracts running emulator console ports and physical devices', () => {
  const out = `List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n0123456789ABCDEF\tdevice\n`;
  const result = parseAdbDevices(out);
  expect(result.emulators.toSorted((a, b) => a.consolePort - b.consolePort)).toEqual([
    { serial: 'emulator-5554', consolePort: 5554 },
    { serial: 'emulator-5556', consolePort: 5556 },
  ]);
  expect(result.physical).toEqual([{ serial: '0123456789ABCDEF' }]);
});

test('parseAdbDevices recognizes adb-over-TCP physical devices', () => {
  const out = `List of devices attached\n192.168.1.5:5555\tdevice\n`;
  const result = parseAdbDevices(out);
  expect(result.physical).toEqual([{ serial: '192.168.1.5:5555' }]);
  expect(result.emulators).toEqual([]);
});

test('parseAdbDevices ignores offline emulators but reports them in unhealthy', () => {
  const out = `List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n`;
  const result = parseAdbDevices(out);
  expect(result.emulators).toEqual([{ serial: 'emulator-5556', consolePort: 5556 }]);
  expect(result.unhealthy).toEqual([
    { serial: 'emulator-5554', kind: 'emulator', consolePort: 5554, status: 'offline' },
  ]);
});

test('parseAdbDevices surfaces unauthorized emulators in unhealthy', () => {
  const out = `List of devices attached\nemulator-5554\tunauthorized\n`;
  const result = parseAdbDevices(out);
  expect(result.emulators).toEqual([]);
  expect(result.unhealthy).toEqual([
    { serial: 'emulator-5554', kind: 'emulator', consolePort: 5554, status: 'unauthorized' },
  ]);
});

test('parseAdbDevices surfaces unauthorized physical devices in unhealthy', () => {
  const out = `List of devices attached\nR5CR70ABCDE\tunauthorized\n`;
  const result = parseAdbDevices(out);
  expect(result.physical).toEqual([]);
  expect(result.unhealthy).toEqual([{ serial: 'R5CR70ABCDE', kind: 'physical', status: 'unauthorized' }]);
});

test('nextConsolePort returns 5554 when none claimed', () => {
  expect(nextConsolePort([])).toBe(5554);
});

test('nextConsolePort returns next even port above max claimed', () => {
  expect(nextConsolePort([5554, 5556])).toBe(5558);
});

test('headlessEmulatorArgs is headless on displayless linux only', () => {
  expect(headlessEmulatorArgs({}, 'linux')).toEqual([
    '-no-window',
    '-noaudio',
    '-no-boot-anim',
    '-gpu',
    'swiftshader_indirect',
  ]);
  expect(headlessEmulatorArgs({ DISPLAY: ':0' }, 'linux')).toEqual([]);
  expect(headlessEmulatorArgs({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toEqual([]);
  expect(headlessEmulatorArgs({}, 'darwin')).toEqual([]);
});

test('pickDefaultSystemImage prefers highest api, then google_apis, arm64 only', () => {
  const images = [
    { api: 35, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-35;default;arm64-v8a' },
    { api: 36, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-36;default;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'arm64-v8a', pkg: 'system-images;android-36;google_apis;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'x86_64', pkg: 'system-images;android-36;google_apis;x86_64' },
  ];
  const picked = pickDefaultSystemImage(images, { hostArch: 'arm64-v8a' });
  assert(picked);
  expect(picked.pkg).toBe('system-images;android-36;google_apis;arm64-v8a');
});

test('pickDefaultSystemImage ranks a 16KB-page image below a plain one, api or no api', () => {
  const ps16k = {
    api: 36,
    tag: 'google_apis_playstore_ps16k',
    arch: 'arm64-v8a',
    pkg: 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a',
  };
  const plain = {
    api: 35,
    tag: 'google_apis',
    arch: 'arm64-v8a',
    pkg: 'system-images;android-35;google_apis;arm64-v8a',
  };
  const bothA = pickDefaultSystemImage([ps16k, plain], { hostArch: 'arm64-v8a' });
  assert(bothA);
  expect(bothA.pkg).toBe(plain.pkg);
  const bothB = pickDefaultSystemImage([plain, ps16k], { hostArch: 'arm64-v8a' });
  assert(bothB);
  expect(bothB.pkg).toBe(plain.pkg);
  const only16k = pickDefaultSystemImage([ps16k], { hostArch: 'arm64-v8a' });
  assert(only16k);
  expect(only16k.pkg).toBe(ps16k.pkg);
  const explicit = pickDefaultSystemImage([ps16k, plain], { systemImage: ps16k.pkg });
  assert(explicit);
  expect(explicit.pkg).toBe(ps16k.pkg);
});

test('pickDefaultSystemImage matches the host architecture by default', () => {
  const arm = { pkg: 'system-images;android-34;google_apis;arm64-v8a', api: 34, tag: 'google_apis', arch: 'arm64-v8a' };
  const x64 = { pkg: 'system-images;android-34;google_apis;x86_64', api: 34, tag: 'google_apis', arch: 'x86_64' };
  expect(pickDefaultSystemImage([arm, x64], { hostArch: 'x86_64' })).toBe(x64);
  expect(pickDefaultSystemImage([arm, x64], { hostArch: 'arm64-v8a' })).toBe(arm);
  expect(hostSystemImageArch('arm64')).toBe('arm64-v8a');
  expect(hostSystemImageArch('x64')).toBe('x86_64');
});

test('pickDefaultSystemImage honors an explicit package and returns null on no match', () => {
  const images = [{ api: 36, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-36;default;arm64-v8a' }];
  const first = images[0];
  assert(first);
  const honored = pickDefaultSystemImage(images, { systemImage: first.pkg });
  assert(honored);
  expect(honored.pkg).toBe(first.pkg);
  expect(pickDefaultSystemImage([], {})).toBe(null);
  expect(pickDefaultSystemImage(images, { systemImage: 'system-images;android-99;x;y' })).toBe(null);
});

test('deleteAvd refuses to delete an AVD not owned by rn-iso', () => {
  setExecutor({
    run: () => {
      throw new Error('should not be called');
    },
    runQuiet: () => {
      throw new Error('should not be called');
    },
    spawn: () => null,
  });
  expect(() => deleteAvd('Pixel_6_API_34')).toThrow(/rn-iso/);
});

test('deleteAvd deletes an rn-iso-owned AVD', () => {
  let ran = null;
  setExecutor({
    run: (cmd) => {
      ran = cmd;
      return null;
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  deleteAvd('rn-iso-my-project');
  expect(ran).toMatch(/delete avd -n "rn-iso-my-project"/);
});

test('deleteAvd propagates an avdmanager failure instead of swallowing it', () => {
  setExecutor({
    run: () => {
      throw new Error('avdmanager: could not delete');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(() => deleteAvd('rn-iso-my-project')).toThrow(/could not delete/);
});

test('resolveOwnedAvdSerial reports missing when the AVD does not exist at all', () => {
  setExecutor({
    run: (cmd) => (cmd === 'emulator -list-avds' ? '' : ''),
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(resolveOwnedAvdSerial('rn-iso-gone')).toEqual({ missing: true });
});

test('resolveOwnedAvdSerial reports notOwned for a non-rn-iso AVD name', () => {
  setExecutor({
    run: (cmd) => (cmd === 'emulator -list-avds' ? 'Pixel_6_API_34\n' : ''),
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(resolveOwnedAvdSerial('Pixel_6_API_34')).toEqual({ notOwned: true });
});

test('resolveOwnedAvdSerial resolves the live serial by AVD identity, not by port', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd === 'emulator -list-avds') return 'rn-iso-mine\n';
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n';
      return '';
    },
    runQuiet: (cmd) => {
      if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'rn-iso-mine\nOK';
      return null;
    },
    spawn: () => null,
  });
  expect(resolveOwnedAvdSerial('rn-iso-mine')).toEqual({ serial: 'emulator-5554' });
});

test('resolveOwnedAvdSerial reports notRunning when the recorded port is held by a foreign emulator', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd === 'emulator -list-avds') return 'rn-iso-mine\n';
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n';
      return '';
    },
    runQuiet: (cmd) => {
      if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'Android_Studio_Default\nOK';
      return null;
    },
    spawn: () => null,
  });
  expect(resolveOwnedAvdSerial('rn-iso-mine')).toEqual({ notRunning: true });
});

test('waitForBoot keeps polling while adb still fails', async () => {
  let calls = 0;
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => {
      if (!/getprop/.test(cmd)) return '';
      calls++;
      if (calls <= 2) return null;
      return /sys.boot_completed/.test(cmd) ? '1\n' : null;
    },
    spawn: () => null,
  });
  const result = await waitForBoot('emulator-5554', 5000);
  expect(result).toEqual({ ok: true });
  expect(calls > 2).toBeTruthy();
});

test('waitForBoot reports a timeout diagnostic when adb never answers', async () => {
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: () => null,
  });
  const result = await waitForBoot('emulator-5554', 10);
  expect(result.ok).toBe(false);
  expect(result.diagnostic).toEqual({ devices: '', sysBoot: '', devBoot: '', bootAnim: '' });
});

test('androidToolPath resolves each tool inside ANDROID_HOME when it exists', () => {
  const sdk = makeFakeSdk(tmpHome);
  process.env.ANDROID_HOME = sdk;
  expect(androidToolPath('emulator')).toBe(join(sdk, 'emulator', 'emulator'));
  expect(androidToolPath('adb')).toBe(join(sdk, 'platform-tools', 'adb'));
  expect(androidToolPath('avdmanager')).toBe(join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager'));
});

test('androidToolPath honours ANDROID_SDK_ROOT when ANDROID_HOME is unset', () => {
  const sdk = makeFakeSdk(tmpHome);
  delete process.env.ANDROID_HOME;
  process.env.ANDROID_SDK_ROOT = sdk;
  expect(androidToolPath('adb')).toBe(join(sdk, 'platform-tools', 'adb'));
});

test('androidToolPath falls back to the bare name when no SDK is on disk', () => {
  process.env.ANDROID_HOME = join(tmpHome, 'nowhere');
  expect(androidToolPath('emulator')).toBe('emulator');
  expect(androidToolPath('adb')).toBe('adb');
  expect(androidToolPath('avdmanager')).toBe('avdmanager');
});

test('listAvds runs the resolved emulator binary, quoted', () => {
  const sdk = makeFakeSdk(tmpHome);
  process.env.ANDROID_HOME = sdk;
  const calls: string[] = [];
  setExecutor({
    run: (cmd: string) => {
      calls.push(cmd);
      return 'Pixel_6_API_34\n';
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(listAvds()).toEqual(['Pixel_6_API_34']);
  expect(calls).toEqual([`"${join(sdk, 'emulator', 'emulator')}" -list-avds`]);
});

test('bootAndroidEmulator spawns the resolved emulator binary', () => {
  const sdk = makeFakeSdk(tmpHome);
  process.env.ANDROID_HOME = sdk;
  const savedDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':0';
  const spawned: Array<[string, string[]]> = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: (cmd: string, args: string[]) => {
      spawned.push([cmd, args]);
      return { unref: () => {} };
    },
  });
  try {
    bootAndroidEmulator('rn-iso-app', 5556);
  } finally {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  }
  expect(spawned).toEqual([[join(sdk, 'emulator', 'emulator'), ['-avd', 'rn-iso-app', '-port', '5556']]]);
});

test('listAvds keeps the bare command when resolution falls back to PATH', () => {
  process.env.ANDROID_HOME = join(tmpHome, 'nowhere');
  const calls: string[] = [];
  setExecutor({
    run: (cmd: string) => {
      calls.push(cmd);
      return '';
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  listAvds();
  expect(calls).toEqual(['emulator -list-avds']);
});

describe('findBuildTool', () => {
  test('takes the newest build-tools that actually has the tool', () => {
    const found = findBuildTool(['zipalign'], {
      home: '/sdk',
      readDir: () => ['34.0.0', '36.0.0', '35.0.0'],
      exists: (path) => path === join('/sdk', 'build-tools', '35.0.0', 'zipalign'),
    });
    expect(found).toEqual({
      path: join('/sdk', 'build-tools', '35.0.0', 'zipalign'),
      tool: 'zipalign',
      version: '35.0.0',
      major: 35,
    });
  });

  test('the tool ORDER within a version is the caller preference', () => {
    const found = findBuildTool(['aapt', 'aapt2'], {
      home: '/sdk',
      readDir: () => ['36.0.0'],
      exists: () => true,
    });
    expect(found?.tool).toBe('aapt');
  });

  test('no SDK, no build-tools, or no copy of the tool anywhere is null', () => {
    expect(
      findBuildTool(['zipalign'], {
        home: '/sdk',
        readDir: () => {
          throw new Error('ENOENT');
        },
        exists: () => false,
      }),
    ).toBe(null);
    expect(findBuildTool(['zipalign'], { home: '/sdk', readDir: () => ['36.0.0'], exists: () => false })).toBe(null);
    expect(findBuildTool(['zipalign'], { home: '/sdk', readDir: () => ['NOTICE.txt'], exists: () => true })).toBe(null);
  });

  test('the major is what a version-gated flag reads, and an unparseable one is 0', () => {
    expect(buildToolsMajor('36.0.0')).toBe(36);
    expect(buildToolsMajor('35.0.0-rc1')).toBe(35);
    expect(buildToolsMajor('nonsense')).toBe(0);
    expect(buildToolsMajor(undefined)).toBe(0);
  });
});

test('waitForBoot stops as soon as the emulator process is gone', async () => {
  let probes = 0;
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => {
      if (/getprop/.test(cmd)) probes++;
      return null;
    },
    spawn: () => null,
  });
  const started = Date.now();
  const result = await waitForBoot('emulator-5554', 60000, { aborted: () => true, pollMs: 5 });
  expect(result.ok).toBe(false);
  expect(result.exited).toBe(true);
  expect(Date.now() - started < 5000).toBeTruthy();
  expect(probes > 0).toBeTruthy();
});

test('waitForBoot keeps polling while the emulator process is alive', async () => {
  let probes = 0;
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => {
      if (!/getprop/.test(cmd)) return '';
      probes++;
      return probes >= 5 && /sys\.boot_completed/.test(cmd) ? '1' : null;
    },
    spawn: () => null,
  });
  const result = await waitForBoot('emulator-5554', 5000, { aborted: () => false, pollMs: 1 });
  expect(result).toEqual({ ok: true });
  expect(probes >= 5).toBeTruthy();
});

test('waitForBoot returns ok when the device booted even if the process reads as gone', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd: string) => (/sys\.boot_completed/.test(cmd) ? '1' : ''),
    spawn: () => null,
  });
  expect(await waitForBoot('emulator-5554', 5000, { aborted: () => true, pollMs: 1 })).toEqual({ ok: true });
});

test('bootAndroidEmulator writes stdout and stderr to the log file it is given', () => {
  const logFile = join(tmpHome, 'logs', 'emulator.log');
  const spawned: Array<Record<string, unknown>> = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      spawned.push(opts);
      return { pid: 4242, unref: () => {} };
    },
  });
  const pid = bootAndroidEmulator('rn-iso-app', 5556, { logFile });
  expect(pid).toBe(4242);
  expect(existsSync(logFile)).toBe(true);
  const opts = spawned[0];
  assert(opts);
  expect(opts.detached).toBe(true);
  const stdio = opts.stdio as [string, number, number];
  expect(stdio[0]).toBe('ignore');
  expect(typeof stdio[1]).toBe('number');
  expect(stdio[2]).toBe(stdio[1]);
  writeFileSync(logFile, 'FATAL | nope\n');
  expect(readFileSync(logFile, 'utf-8')).toContain('FATAL');
});

test('bootAndroidEmulator keeps stdio ignored when no log file is given', () => {
  const spawned: Array<Record<string, unknown>> = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      spawned.push(opts);
      return { unref: () => {} };
    },
  });
  expect(bootAndroidEmulator('rn-iso-app', 5556)).toBe(null);
  expect(spawned[0]?.stdio).toBe('ignore');
});

test('bootAndroidEmulator still boots when the log file cannot be opened', () => {
  const spawned: Array<Record<string, unknown>> = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      spawned.push(opts);
      return { unref: () => {} };
    },
  });
  const blocker = join(tmpHome, 'blocker');
  writeFileSync(blocker, '');
  bootAndroidEmulator('rn-iso-app', 5556, { logFile: join(blocker, 'emulator.log') });
  expect(spawned.length).toBe(1);
  expect(spawned[0]?.stdio).toBe('ignore');
});

const REAL_DISK_LINE =
  'FATAL | Not enough space to create userdata partition. Available: 6341.54 MB at /Users/j/.android/avd, need 7372.80 MB';

test('extractEmulatorFailure lifts the real disk-space FATAL line', () => {
  const log = [
    'INFO    | Storing crashdata in: /tmp/AndroidEmulator/emu-crash.db',
    'INFO    | Android emulator version 35.2.10.0',
    REAL_DISK_LINE,
  ].join('\n');
  expect(extractEmulatorFailure(log)).toEqual([REAL_DISK_LINE]);
});

test('extractEmulatorFailure recognizes the ERROR and PANIC shapes too', () => {
  expect(extractEmulatorFailure('ERROR | Unknown AVD name [nope], use -list-avds to see valid list.')).toEqual([
    'ERROR | Unknown AVD name [nope], use -list-avds to see valid list.',
  ]);
  expect(extractEmulatorFailure("PANIC: Missing emulator engine program for 'arm64' CPU.")).toEqual([
    "PANIC: Missing emulator engine program for 'arm64' CPU.",
  ]);
  expect(extractEmulatorFailure('FATAL   | out of memory')).toEqual(['FATAL   | out of memory']);
  expect(extractEmulatorFailure('emulator: ERROR | could not open the AVD config')).toEqual([
    'emulator: ERROR | could not open the AVD config',
  ]);
});

test('extractEmulatorFailure returns nothing for a log with no severity markers', () => {
  const log = [
    'INFO    | Android emulator version 35.2.10.0',
    'WARNING | System image is out of date',
    'Successfully loaded snapshot default_boot',
    '',
  ].join('\n');
  expect(extractEmulatorFailure(log)).toEqual([]);
  expect(extractEmulatorFailure('')).toEqual([]);
  expect(extractEmulatorFailure(null)).toEqual([]);
});

test('extractEmulatorFailure dedupes repeated lines', () => {
  const log = [REAL_DISK_LINE, 'INFO | retrying', REAL_DISK_LINE, REAL_DISK_LINE].join('\n');
  expect(extractEmulatorFailure(log)).toEqual([REAL_DISK_LINE]);
});

test('extractEmulatorFailure drops ERROR lines when a fatal-class line is present', () => {
  const log = [
    'ERROR | could not read the config',
    'FATAL | the actual cause',
    'INFO  | chatter',
    'PANIC: and the abort',
  ].join('\n');
  expect(extractEmulatorFailure(log)).toEqual(['FATAL | the actual cause', 'PANIC: and the abort']);
});

test('extractEmulatorFailure keeps the newest three, in log order', () => {
  const log = ['ERROR | first error', 'ERROR | second error', 'ERROR | third error', 'ERROR | fourth error'].join('\n');
  const found = extractEmulatorFailure(log);
  expect(found.length).toBe(MAX_EMULATOR_FAILURE_LINES);
  expect(found).toEqual(['ERROR | second error', 'ERROR | third error', 'ERROR | fourth error']);
});

test('extractEmulatorFailure keeps the emulator order: cause first, notes after', () => {
  const log = [
    'INFO         | Android emulator version 36.4.9.0 (build_id 14788078) (CL:N/A)',
    'INFO         | Graphics backend: gfxstream',
    'ERROR        | Unknown AVD name [rn-iso-does-not-exist-64], use -list-avds to see valid list.',
    'ERROR        | HOME is defined but there is no file rn-iso-does-not-exist-64.ini in $HOME/.android/avd',
    'ERROR        | (Note: Directories are searched in the order $ANDROID_AVD_HOME, $ANDROID_SDK_HOME/avd and $HOME/.android/avd)',
  ].join('\n');
  const found = extractEmulatorFailure(log);
  expect(found[0]).toMatch(/Unknown AVD name \[rn-iso-does-not-exist-64\]/);
  expect(found.length).toBe(3);
});

test('emulatorFailureRemedy answers the disk case with free-space instructions', () => {
  expect(emulatorFailureRemedy([REAL_DISK_LINE])).toMatch(/Free disk space at the AVD directory/);
  expect(emulatorFailureRemedy(["PANIC: Missing emulator engine program for 'arm64' CPU."])).toMatch(
    /Fix what the emulator reported above/,
  );
  expect(emulatorFailureRemedy([])).toMatch(/Fix what the emulator reported above/);
});
