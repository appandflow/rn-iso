import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../exec.ts';
import {
  androidToolPath,
  bootAndroidEmulator,
  listAvds,
  parseAvdList,
  parseAdbDevices,
  nextConsolePort,
  pickDefaultSystemImage,
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
  // Pin tool resolution to the bare-name fallback: the machine's real SDK
  // (if any) must not leak absolute paths into the command strings the
  // executor mocks below match on.
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

// Lays a fake SDK on disk with every tool the resolver knows, and returns its
// root. Plain files are enough: resolution is an existence check, not an
// executable check.
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
  expect(result.emulators.sort((a, b) => a.consolePort - b.consolePort)).toEqual([
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

test('pickDefaultSystemImage prefers highest api, then google_apis, arm64 only', () => {
  const images = [
    { api: 35, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-35;default;arm64-v8a' },
    { api: 36, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-36;default;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'arm64-v8a', pkg: 'system-images;android-36;google_apis;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'x86_64', pkg: 'system-images;android-36;google_apis;x86_64' },
  ];
  const picked = pickDefaultSystemImage(images, {});
  assert(picked);
  expect(picked.pkg).toBe('system-images;android-36;google_apis;arm64-v8a');
});

// The 16KB-page images break exactly what an RN app is: a native module
// built against an older NDK will not dlopen on one. When both are installed
// the plain image wins even at a LOWER api, because a p_align crash at
// startup is a worse thing to hand an agent than an api level.
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
  const bothA = pickDefaultSystemImage([ps16k, plain], {});
  assert(bothA);
  expect(bothA.pkg).toBe(plain.pkg);
  const bothB = pickDefaultSystemImage([plain, ps16k], {});
  assert(bothB);
  expect(bothB.pkg).toBe(plain.pkg);
  // ...and with nothing else installed it is still a working emulator, which
  // is what rn-iso creates rather than refusing.
  const only16k = pickDefaultSystemImage([ps16k], {});
  assert(only16k);
  expect(only16k.pkg).toBe(ps16k.pkg);
  // An explicit choice is still honoured, 16KB or not.
  const explicit = pickDefaultSystemImage([ps16k, plain], { systemImage: ps16k.pkg });
  assert(explicit);
  expect(explicit.pkg).toBe(ps16k.pkg);
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

// A failed avdmanager delete leaves the AVD on disk. It must reach the caller
// as a throw (teardown.js turns it into { status: 'failed' }), not be swallowed
// into a report of a device that was never actually deleted.
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

// --- resolveOwnedAvdSerial: identity verification, not port trust --------

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

// The regression this fix exists for: the recorded consolePort is held by a
// FOREIGN emulator (a different AVD name answers on it), and our own AVD is
// not running anywhere else. Must report notRunning, never the foreign
// serial -- a caller that shuts down "whatever answers on the recorded
// port" would kill the user's own emulator.
test('resolveOwnedAvdSerial reports notRunning when the recorded port is held by a foreign emulator', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd === 'emulator -list-avds') return 'rn-iso-mine\n';
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n';
      return '';
    },
    runQuiet: (cmd) => {
      // The device on the recorded port identifies as a DIFFERENT AVD --
      // the user's own emulator took the slot.
      if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'Android_Studio_Default\nOK';
      return null;
    },
    spawn: () => null,
  });
  expect(resolveOwnedAvdSerial('rn-iso-mine')).toEqual({ notRunning: true });
});

// --- waitForBoot: adb fails for most of a boot -------------------------

// runQuiet returns null whenever the command fails, and `adb shell getprop`
// fails ("device offline", "device not found") until the emulator registers.
// Calling .trim() on that null threw a TypeError out of the v2 `up` command, reported
// as a bogus "Failed to ensure android device".
test('waitForBoot keeps polling while adb still fails', async () => {
  let calls = 0;
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => {
      if (!/getprop/.test(cmd)) return '';
      calls++;
      // Both getprop calls fail on the first pass, then sys.boot_completed
      // answers on the second.
      if (calls <= 2) return null;
      return /sys.boot_completed/.test(cmd) ? '1\n' : null;
    },
    spawn: () => null,
  });
  const result = await waitForBoot('emulator-5554', 5000);
  expect(result).toEqual({ ok: true });
  expect(calls > 2).toBeTruthy();
});

// The timeout path reads the same properties for its diagnostic, so it must
// survive adb failing there too.
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

// --- SDK tool resolution (issue #18) ---------------------------------------
//
// A non-interactive shell spawned by a Node process never reads the rc file
// that puts the SDK on PATH, so a bare `emulator` fails in exactly the shells
// rn-iso runs from -- teardown reported failed and the registry entry outlived
// its worktree. The resolver is pure path logic over androidHome(), so it is
// tested directly against a fake SDK on disk.

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

// A resolved path is embedded QUOTED in shell commands: an SDK root chosen by
// the user (ANDROID_HOME) can carry a space, and run() goes through /bin/sh.
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

// spawn() takes argv directly (no shell), so the emulator boot gets the
// resolved path unquoted.
test('bootAndroidEmulator spawns the resolved emulator binary', () => {
  const sdk = makeFakeSdk(tmpHome);
  process.env.ANDROID_HOME = sdk;
  const spawned: Array<[string, string[]]> = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: (cmd: string, args: string[]) => {
      spawned.push([cmd, args]);
      return { unref: () => {} };
    },
  });
  bootAndroidEmulator('rn-iso-app', 5556);
  expect(spawned).toEqual([[join(sdk, 'emulator', 'emulator'), ['-avd', 'rn-iso-app', '-port', '5556']]]);
});

// The PATH-only setup keeps working: with no SDK on disk the command is the
// bare name, exactly what it was before resolution existed.
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
