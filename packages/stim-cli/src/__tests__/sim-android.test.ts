import assert from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../exec.ts';
import {
  MAX_EMULATOR_FAILURE_LINES,
  androidToolPath,
  androidPoolNoCandidatesRefusal,
  buildToolsMajor,
  emulatorFailureRemedy,
  extractEmulatorFailure,
  findBuildTool,
  headlessEmulatorArgs,
  bootAndroidEmulator,
  configureNewOwnedAvd,
  listAvds,
  memoizeEmulatorProbe,
  parseAvdList,
  parseAdbDevices,
  nextConsolePort,
  parseAvdRootIni,
  pickDefaultSystemImage,
  hostSystemImageArch,
  ownedAvdDirectory,
  ownedAvdSystemImage,
  parseAvdSystemImage,
  deleteAvd,
  resolveOwnedAvdSerial,
  physicalDeviceModel,
  resolvePhysicalDevice,
  waitForAndroidEmulatorShutdown,
  waitForBoot,
  withAvdConfigOverrides,
  withAvdDataPartitionSize,
} from '../sim/android.ts';

let tmpHome: string;
let savedAndroidHome: string | undefined;
let savedSdkRoot: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  savedAndroidHome = process.env.ANDROID_HOME;
  savedSdkRoot = process.env.ANDROID_SDK_ROOT;
  process.env.ANDROID_HOME = join(tmpHome, 'no-sdk-here');
  delete process.env.ANDROID_SDK_ROOT;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
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

test('parseAvdRootIni keeps the content paths and ignores unrelated lines', () => {
  expect(
    parseAvdRootIni(
      'avd.ini.encoding=UTF-8\npath = /moved/stim-app.avd\npath.rel=avd/stim-app.avd\ntarget=android-36\n',
    ),
  ).toEqual({ path: '/moved/stim-app.avd', relativePath: 'avd/stim-app.avd' });
});

function writeAvdRoot(root: string, name: string, contents: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${name}.ini`), contents);
}

test('ownedAvdDirectory uses AVD_HOME, SDK_HOME, then HOME precedence', () => {
  const avdHome = join(tmpHome, 'avd-home');
  const sdkHome = join(tmpHome, 'android-sdk-home');
  const home = join(tmpHome, 'home');
  const candidates: [string, string, string] = [
    join(tmpHome, 'custom.avd'),
    join(tmpHome, 'user.avd'),
    join(tmpHome, 'default.avd'),
  ];
  for (const candidate of candidates) mkdirSync(candidate, { recursive: true });
  writeAvdRoot(avdHome, 'stim-app', `path=${candidates[0]}\n`);
  writeAvdRoot(join(sdkHome, 'avd'), 'stim-app', `path=${candidates[1]}\n`);
  writeAvdRoot(join(home, '.android', 'avd'), 'stim-app', `path=${candidates[2]}\n`);

  expect(ownedAvdDirectory('stim-app', { env: { ANDROID_AVD_HOME: avdHome, ANDROID_SDK_HOME: sdkHome }, home })).toBe(
    realpathSync(candidates[0]),
  );
  expect(ownedAvdDirectory('stim-app', { env: { ANDROID_SDK_HOME: sdkHome }, home })).toBe(realpathSync(candidates[1]));
  expect(ownedAvdDirectory('stim-app', { env: {}, home })).toBe(realpathSync(candidates[2]));
});

test('ownedAvdDirectory resolves moved, relative, and symlinked content directories', () => {
  const sdkHome = join(tmpHome, 'android-sdk-home');
  const root = join(sdkHome, 'avd');
  const moved = join(tmpHome, 'moved', 'stim-moved.avd');
  const relative = join(sdkHome, 'elsewhere', 'stim-relative.avd');
  const target = join(tmpHome, 'target', 'stim-linked.avd');
  const link = join(tmpHome, 'linked.avd');
  for (const dir of [moved, relative, target]) mkdirSync(dir, { recursive: true });
  symlinkSync(target, link, 'dir');
  writeAvdRoot(root, 'stim-moved', `path=${moved}\n`);
  writeAvdRoot(root, 'stim-relative', `path=${join(tmpHome, 'missing.avd')}\npath.rel=elsewhere/stim-relative.avd\n`);
  writeAvdRoot(root, 'stim-linked', `path=${link}\n`);
  const options = { env: { ANDROID_SDK_HOME: sdkHome }, home: join(tmpHome, 'home') };

  expect(ownedAvdDirectory('stim-moved', options)).toBe(realpathSync(moved));
  expect(ownedAvdDirectory('stim-relative', options)).toBe(realpathSync(relative));
  expect(ownedAvdDirectory('stim-linked', options)).toBe(realpathSync(target));
});

test('ownedAvdDirectory fails closed for invalid names and a malformed selected root', () => {
  const avdHome = join(tmpHome, 'avd-home');
  const fallbackRoot = join(tmpHome, 'home', '.android', 'avd');
  const fallback = join(tmpHome, 'fallback.avd');
  mkdirSync(fallback, { recursive: true });
  writeAvdRoot(avdHome, 'stim-app', 'target=android-36\n');
  writeAvdRoot(fallbackRoot, 'stim-app', `path=${fallback}\n`);
  const options = { env: { ANDROID_AVD_HOME: avdHome }, home: join(tmpHome, 'home') };

  expect(ownedAvdDirectory('stim-app', options)).toBe(null);
  expect(ownedAvdDirectory('Pixel_7', options)).toBe(null);
  expect(ownedAvdDirectory('stim-../../outside', options)).toBe(null);
});

test('ownedAvdDirectory returns null when every emulator root is missing and ignores USER_HOME', () => {
  const userHome = join(tmpHome, 'android-user-home');
  const content = join(tmpHome, 'unsupported-user-home.avd');
  mkdirSync(content, { recursive: true });
  writeAvdRoot(join(userHome, 'avd'), 'stim-app', `path=${content}\n`);

  expect(
    ownedAvdDirectory('stim-app', {
      env: {
        ANDROID_AVD_HOME: join(tmpHome, 'missing-avd-home'),
        ANDROID_SDK_HOME: join(tmpHome, 'missing-sdk-home'),
        ANDROID_USER_HOME: userHome,
      },
      home: join(tmpHome, 'missing-home'),
    }),
  ).toBe(null);
});

test('withAvdDataPartitionSize replaces duplicates and preserves unrelated config', () => {
  expect(
    withAvdDataPartitionSize(
      'hw.cpu.ncore=4\r\ndisk.dataPartition.size=10G\r\ntag.id=google_apis\r\ndisk.dataPartition.size=8G\r\n',
      6 * 1024 ** 3,
    ),
  ).toBe('hw.cpu.ncore=4\r\ndisk.dataPartition.size=6442450944\r\ntag.id=google_apis\r\n');
});

test('withAvdDataPartitionSize appends a missing value without changing newline termination', () => {
  expect(withAvdDataPartitionSize('hw.cpu.ncore=4', 8 * 1024 ** 3)).toBe(
    'hw.cpu.ncore=4\ndisk.dataPartition.size=8589934592',
  );
});

test('withAvdConfigOverrides replaces duplicates once and preserves protected generated values', () => {
  expect(
    withAvdConfigOverrides(
      'image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\nhw.keyboard=no\nhw.keyboard=no\n',
      { 'hw.keyboard': 'yes', 'hw.ramSize': '3072' },
    ),
  ).toBe('image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\nhw.keyboard=yes\nhw.ramSize=3072\n');
});

test('configureNewOwnedAvd atomically writes and verifies managed and user settings', () => {
  const content = join(tmpHome, 'stim-app.avd');
  mkdirSync(content, { recursive: true });
  const config = join(content, 'config.ini');
  writeFileSync(config, 'hw.cpu.ncore=4\ndisk.dataPartition.size=10G\n');

  expect(
    configureNewOwnedAvd(
      'stim-app',
      { dataPartitionSizeGb: 6, avdConfig: { 'hw.keyboard': 'yes', 'hw.ramSize': '3072' } },
      { avdDirectory: () => content },
    ),
  ).toBe(config);
  expect(readFileSync(config, 'utf8')).toBe(
    'hw.cpu.ncore=4\ndisk.dataPartition.size=6442450944\nhw.keyboard=yes\nhw.ramSize=3072\n',
  );
  expect(readdirSync(content).filter((name) => name.includes('.stim-'))).toEqual([]);
});

test('configureNewOwnedAvd removes its temporary file when replacement fails', () => {
  const content = join(tmpHome, 'stim-app.avd');
  mkdirSync(content, { recursive: true });
  const config = join(content, 'config.ini');
  writeFileSync(config, 'disk.dataPartition.size=10G\n');

  expect(() =>
    configureNewOwnedAvd(
      'stim-app',
      { dataPartitionSizeGb: 6 },
      {
        avdDirectory: () => content,
        rename: () => {
          throw new Error('rename failed');
        },
      },
    ),
  ).toThrow(/rename failed/);
  expect(readFileSync(config, 'utf8')).toBe('disk.dataPartition.size=10G\n');
  expect(readdirSync(content).filter((name) => name.includes('.stim-'))).toEqual([]);
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

test('deleteAvd refuses to delete an AVD not owned by Stim', () => {
  setExecutor({
    run: () => {
      throw new Error('should not be called');
    },
    runQuiet: () => {
      throw new Error('should not be called');
    },
    spawn: () => null,
  });
  expect(() => deleteAvd('Pixel_6_API_34')).toThrow(/Stim/);
});

test('deleteAvd deletes a Stim-owned AVD', () => {
  let ran = null;
  setExecutor({
    run: (cmd) => {
      ran = cmd;
      return null;
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  deleteAvd('stim-my-project');
  expect(ran).toMatch(/delete avd -n "stim-my-project"/);
});

test('deleteAvd propagates an avdmanager failure instead of swallowing it', () => {
  setExecutor({
    run: () => {
      throw new Error('avdmanager: could not delete');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(() => deleteAvd('stim-my-project')).toThrow(/could not delete/);
});

test('resolveOwnedAvdSerial reports missing when the AVD does not exist at all', () => {
  setExecutor({
    run: (cmd) => (cmd === 'emulator -list-avds' ? '' : ''),
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(resolveOwnedAvdSerial('stim-gone')).toEqual({ missing: true });
});

test('resolveOwnedAvdSerial reports notOwned for a non-Stim AVD name', () => {
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
      if (cmd === 'emulator -list-avds') return 'stim-mine\n';
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n';
      return '';
    },
    runQuiet: (cmd) => {
      if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'stim-mine\nOK';
      return null;
    },
    spawn: () => null,
  });
  expect(resolveOwnedAvdSerial('stim-mine')).toEqual({ serial: 'emulator-5554' });
});

test('resolveOwnedAvdSerial reports notRunning when the recorded port is held by a foreign emulator', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd === 'emulator -list-avds') return 'stim-mine\n';
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n';
      return '';
    },
    runQuiet: (cmd) => {
      if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'Android_Studio_Default\nOK';
      return null;
    },
    spawn: () => null,
  });
  expect(resolveOwnedAvdSerial('stim-mine')).toEqual({ notRunning: true });
});

test('waitForAndroidEmulatorShutdown waits for the owned AVD process lock to disappear', () => {
  let locked = true;
  const sleeps: number[] = [];
  const calls: string[] = [];

  waitForAndroidEmulatorShutdown('stim-app', () => calls.push('shutdown'), {
    resolveDirectory: () => '/avds/stim-app.avd',
    readProcessId: () => 123,
    processAlive: () => locked,
    directoryExists: () => true,
    sleep: (ms) => {
      calls.push('wait');
      sleeps.push(ms);
      locked = false;
    },
  });

  expect(sleeps).toEqual([100]);
  expect(calls).toEqual(['shutdown', 'wait']);
});

test('waitForAndroidEmulatorShutdown reads Android emulator lock PIDs on Unix and Windows', () => {
  const avdDirectory = join(tmpHome, 'stim-app.avd');
  for (const [platform, lockPath] of [
    ['darwin', join(avdDirectory, 'hardware-qemu.ini.lock')],
    ['win32', join(avdDirectory, 'hardware-qemu.ini.lock', 'pid')],
  ] as const) {
    rmSync(avdDirectory, { recursive: true, force: true });
    mkdirSync(join(lockPath, '..'), { recursive: true });
    writeFileSync(lockPath, '412503\0');
    let observedPid: number | null = null;

    waitForAndroidEmulatorShutdown('stim-app', () => {}, {
      platform,
      resolveDirectory: () => avdDirectory,
      processAlive: (pid) => {
        observedPid = pid;
        return false;
      },
    });

    expect(observedPid).toBe(412503);
  }
});

test('waitForAndroidEmulatorShutdown prefers the active process lock over the legacy fallback', () => {
  const paths: string[] = [];
  let observedPid: number | null = null;

  waitForAndroidEmulatorShutdown('stim-app', () => {}, {
    resolveDirectory: () => '/avds/stim-app.avd',
    readProcessId: (path) => {
      paths.push(path);
      return path.endsWith('hardware-qemu.ini.lock') ? 123 : 456;
    },
    processAlive: (pid) => {
      observedPid = pid;
      return false;
    },
    directoryExists: () => true,
  });

  expect(paths).toEqual(['/avds/stim-app.avd/hardware-qemu.ini.lock']);
  expect(observedPid).toBe(123);
});

test('waitForAndroidEmulatorShutdown falls back to the legacy process lock', () => {
  const paths: string[] = [];
  let observedPid: number | null = null;

  waitForAndroidEmulatorShutdown('stim-app', () => {}, {
    resolveDirectory: () => '/avds/stim-app.avd',
    readProcessId: (path) => {
      paths.push(path);
      return path.endsWith('userdata-qemu.img.lock') ? 456 : null;
    },
    processAlive: (pid) => {
      observedPid = pid;
      return false;
    },
    directoryExists: () => true,
  });

  expect(paths).toEqual(['/avds/stim-app.avd/hardware-qemu.ini.lock', '/avds/stim-app.avd/userdata-qemu.img.lock']);
  expect(observedPid).toBe(456);
});

test('waitForAndroidEmulatorShutdown times out while the owned AVD process lock remains', () => {
  let elapsed = 0;

  expect(() =>
    waitForAndroidEmulatorShutdown('stim-app', () => {}, {
      timeoutMs: 250,
      pollMs: 100,
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => 123,
      processAlive: () => true,
      directoryExists: () => true,
      now: () => elapsed,
      sleep: (ms) => {
        elapsed += ms;
      },
    }),
  ).toThrow(/did not finish shutting down within 1s/);
});

test('waitForAndroidEmulatorShutdown refuses to signal a process without an AVD lock', () => {
  const shutdown = vi.fn<() => void>();

  expect(() =>
    waitForAndroidEmulatorShutdown('stim-app', shutdown, {
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => null,
      processAlive: () => false,
      directoryExists: () => true,
    }),
  ).toThrow(/Could not find the emulator process lock/);
  expect(shutdown).not.toHaveBeenCalled();
});

test('waitForAndroidEmulatorShutdown verifies the AVD directory remains available', () => {
  let locked = true;

  expect(() =>
    waitForAndroidEmulatorShutdown('stim-app', () => {}, {
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => 123,
      processAlive: () => {
        const result = locked;
        locked = false;
        return result;
      },
      directoryExists: () => false,
      sleep: () => {},
    }),
  ).toThrow(/Could not verify the content directory/);
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
    bootAndroidEmulator('stim-app', 5556);
  } finally {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  }
  expect(spawned).toEqual([[join(sdk, 'emulator', 'emulator'), ['-avd', 'stim-app', '-port', '5556']]]);
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
  const pid = bootAndroidEmulator('stim-app', 5556, { logFile });
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
  expect(bootAndroidEmulator('stim-app', 5556)).toBe(null);
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
  bootAndroidEmulator('stim-app', 5556, { logFile: join(blocker, 'emulator.log') });
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
    'ERROR        | Unknown AVD name [stim-does-not-exist-64], use -list-avds to see valid list.',
    'ERROR        | HOME is defined but there is no file stim-does-not-exist-64.ini in $HOME/.android/avd',
    'ERROR        | (Note: Directories are searched in the order $ANDROID_AVD_HOME, $ANDROID_SDK_HOME/avd and $HOME/.android/avd)',
  ].join('\n');
  const found = extractEmulatorFailure(log);
  expect(found[0]).toMatch(/Unknown AVD name \[stim-does-not-exist-64\]/);
  expect(found.length).toBe(3);
});

test('emulatorFailureRemedy answers the disk case with free-space instructions', () => {
  expect(emulatorFailureRemedy([REAL_DISK_LINE])).toMatch(/Free disk space/);
  expect(emulatorFailureRemedy([REAL_DISK_LINE])).toMatch(/~\/.android\/avd/);
  expect(emulatorFailureRemedy(["PANIC: Missing emulator engine program for 'arm64' CPU."])).toMatch(
    /Fix what the emulator reported above/,
  );
  expect(emulatorFailureRemedy([])).toMatch(/Fix what the emulator reported above/);
});

test('resolvePhysicalDevice picks the only connected physical device when none is requested', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n`);
  expect(resolvePhysicalDevice(null, adb)).toEqual({ serial: 'RFCR7081Q9L' });
});

test('resolvePhysicalDevice ignores emulators when picking the only physical device', () => {
  const adb = parseAdbDevices(`List of devices attached\nemulator-5554\tdevice\nRFCR7081Q9L\tdevice\n`);
  expect(resolvePhysicalDevice(null, adb)).toEqual({ serial: 'RFCR7081Q9L' });
});

test('resolvePhysicalDevice refuses when no physical device is connected', () => {
  const adb = parseAdbDevices(`List of devices attached\nemulator-5554\tdevice\n`);
  const result = resolvePhysicalDevice(null, adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/No physical Android device is connected/);
  expect(result.remedy).toMatch(/adb devices/);
});

test('resolvePhysicalDevice refuses an ambiguous choice and names every candidate', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n0123456789ABCDEF\tdevice\n`);
  const result = resolvePhysicalDevice(null, adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toContain('RFCR7081Q9L');
  expect(result.error).toContain('0123456789ABCDEF');
  expect(result.remedy).toMatch(/--device <serial>/);
});

test('resolvePhysicalDevice accepts a requested serial that is connected', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n0123456789ABCDEF\tdevice\n`);
  expect(resolvePhysicalDevice('0123456789ABCDEF', adb)).toEqual({ serial: '0123456789ABCDEF' });
});

test('resolvePhysicalDevice refuses a requested serial that is not connected', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n`);
  const result = resolvePhysicalDevice('NOPE', adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/NOPE is not connected/);
  expect(result.error).toContain('RFCR7081Q9L');
});

test('resolvePhysicalDevice refuses an emulator serial', () => {
  const adb = parseAdbDevices(`List of devices attached\nemulator-5554\tdevice\n`);
  const result = resolvePhysicalDevice('emulator-5554', adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/emulator-5554 is an emulator/);
  expect(result.remedy).toMatch(/without --device/);
});

test('resolvePhysicalDevice reports an unauthorized device instead of calling it absent', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tunauthorized\n`);
  const result = resolvePhysicalDevice(null, adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/RFCR7081Q9L is connected but unauthorized/);
  expect(result.remedy).toMatch(/USB debugging/);
});

test('resolvePhysicalDevice reports an offline requested device instead of calling it absent', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\toffline\n`);
  const result = resolvePhysicalDevice('RFCR7081Q9L', adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/RFCR7081Q9L is connected but offline/);
});

test('physicalDeviceModel passes the serial as an argument, never through a shell string', () => {
  const calls: { file: string; args: string[] }[] = [];
  setExecutor({
    runFile: (file: string, args: string[] = []) => {
      calls.push({ file, args });
      return 'SM-G996W\n';
    },
    run: () => {
      throw new Error('a shell string must not be built from a device serial');
    },
    runQuiet: () => {
      throw new Error('a shell string must not be built from a device serial');
    },
  } as never);
  expect(physicalDeviceModel('RFCR7081Q9L')).toBe('SM-G996W');
  expect(calls[0]?.args).toEqual(['-s', 'RFCR7081Q9L', 'shell', 'getprop', 'ro.product.model']);
  resetExecutor();
});

test('physicalDeviceModel returns null when adb cannot answer', () => {
  setExecutor({
    runFile: () => {
      throw new Error('device offline');
    },
  } as never);
  expect(physicalDeviceModel('RFCR7081Q9L')).toBeNull();
  resetExecutor();
});

test('resolvePhysicalDevice refuses a network-attached emulator that adb reports as physical', () => {
  const adb = parseAdbDevices(`List of devices attached\n192.168.56.101:5555\tdevice\n`);
  const result = resolvePhysicalDevice(null, adb, () => true);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/is an emulator/);
});

test('resolvePhysicalDevice accepts a genuine device over adb-over-TCP', () => {
  const adb = parseAdbDevices(`List of devices attached\n192.168.1.5:5555\tdevice\n`);
  expect(resolvePhysicalDevice(null, adb, () => false)).toEqual({ serial: '192.168.1.5:5555' });
});

test('resolvePhysicalDevice reports the whole adb status, not its first word', () => {
  const adb = parseAdbDevices(`List of devices attached\n1234567890\tno permissions; see [http://x]\n`);
  const result = resolvePhysicalDevice(null, adb);
  expect(result.error).toMatch(/no permissions/);
  expect(result.error).not.toMatch(/but no,/);
});

test('androidPoolNoCandidatesRefusal names each emulator-only physical serial with its own reason, not the count message', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n0123456789ABCDEF\tdevice\n`);
  const result = androidPoolNoCandidatesRefusal(adb, () => true);
  expect(result.serial).toBeUndefined();
  expect(result.error).toContain(resolvePhysicalDevice('RFCR7081Q9L', adb, () => true).error);
  expect(result.error).toContain(resolvePhysicalDevice('0123456789ABCDEF', adb, () => true).error);
  expect(result.error).not.toMatch(/Several physical devices are connected/);
  expect(result.remedy).toMatch(/without --device/);
});

test('androidPoolNoCandidatesRefusal falls back to the resolver when a physical device is genuine', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n`);
  expect(androidPoolNoCandidatesRefusal(adb, () => false)).toEqual(resolvePhysicalDevice(null, adb, () => false));
  const none = parseAdbDevices(`List of devices attached\n`);
  expect(androidPoolNoCandidatesRefusal(none)).toEqual(resolvePhysicalDevice(null, none));
});

test('memoizeEmulatorProbe probes a serial once and reuses the result across repeated calls', () => {
  const calls: string[] = [];
  const probe = memoizeEmulatorProbe((serial) => {
    calls.push(serial);
    return serial === 'emulator-5554';
  });
  expect(probe('emulator-5554')).toBe(true);
  expect(probe('RFCR7081Q9L')).toBe(false);
  expect(probe('emulator-5554')).toBe(true);
  expect(probe('RFCR7081Q9L')).toBe(false);
  expect(calls).toEqual(['emulator-5554', 'RFCR7081Q9L']);
});

test('parseAvdSystemImage turns the config.ini image directory back into an sdkmanager package id', () => {
  expect(
    parseAvdSystemImage(
      'avd.ini.encoding=UTF-8\nimage.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\ntag.id=google_apis\n',
    ),
  ).toBe('system-images;android-36;google_apis;arm64-v8a');
  expect(parseAvdSystemImage('image.sysdir.1 = system-images/android-35/default/x86_64')).toBe(
    'system-images;android-35;default;x86_64',
  );
  expect(parseAvdSystemImage('image.sysdir.1=\n')).toBe(null);
  expect(parseAvdSystemImage('hw.cpu.arch=arm64\n')).toBe(null);
  expect(parseAvdSystemImage('')).toBe(null);
});

test('ownedAvdSystemImage reads the AVD Stim owns and stays null when it cannot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-avd-image-'));
  try {
    writeFileSync(join(dir, 'config.ini'), 'image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n');
    expect(ownedAvdSystemImage('stim-app', { avdDirectory: () => dir })).toBe(
      'system-images;android-36;google_apis;arm64-v8a',
    );
    expect(ownedAvdSystemImage('stim-app', { avdDirectory: () => null })).toBe(null);
    expect(ownedAvdSystemImage('stim-app', { avdDirectory: () => join(dir, 'gone') })).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
