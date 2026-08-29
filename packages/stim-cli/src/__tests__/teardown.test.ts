import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.ts';

let savedAndroidHome: string | undefined;
let savedSdkRoot: string | undefined;

beforeEach(() => {
  savedAndroidHome = process.env.ANDROID_HOME;
  savedSdkRoot = process.env.ANDROID_SDK_ROOT;
  process.env.ANDROID_HOME = join(tmpdir(), 'stim-cli-test-no-sdk-here');
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
    devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': sims },
  });
  const answer = (cmd: string) => {
    calls.push(cmd);
    if (throwOn && cmd.includes(throwOn)) throw new Error('boom');
    if (cmd.includes('simctl list devices --json')) return listJson;
    if (/simctl spawn .* launchctl list/.test(cmd)) return occupied;
    return '';
  };
  return { calls, run: answer, runQuiet: answer, spawn: () => {} };
}

const OWNED = { udid: 'U1', name: 'stim-cli-app', state: 'Booted', isAvailable: true };

test('teardownOwnedIosSim shuts down and deletes an owned, unoccupied sim', () => {
  const exec = iosExecutor({ sims: [OWNED] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('torn-down');
  expect(r.label).toBe('stim-cli-app');
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

test('teardownOwnedIosSim refuses a sim renamed away from stim-cli ownership', () => {
  const exec = iosExecutor({ sims: [{ ...OWNED, name: 'My Real Sim' }] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('skipped');
  expect(r.reason).toMatch(/not stim-cli-owned/);
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

test('teardownOwnedIosSim still refuses a sim that is not stim-cli-owned, even when deleting', () => {
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
    avds: ['stim-cli-app'],
    adb: 'List of devices attached\nemulator-5554\tdevice\n',
    avdName: 'stim-cli-app',
  });
  setExecutor(exec);
  const r = teardownOwnedAvd('stim-cli-app', { del: true });
  expect(r.status).toBe('torn-down');
  expect(exec.calls.some((c) => /emu kill/.test(c))).toBeTruthy();
  expect(exec.calls.some((c) => /delete avd -n/.test(c))).toBeTruthy();
});

test('teardownOwnedAvd refuses an AVD that is not stim-cli-owned by name', () => {
  const exec = androidExecutor({ avds: ['Pixel_6_API_34'], adb: 'List of devices attached\n' });
  setExecutor(exec);
  const r = teardownOwnedAvd('Pixel_6_API_34', { del: true });
  expect(r.status).toBe('skipped');
  expect(!exec.calls.some((c) => /emu kill|avdmanager delete/.test(c))).toBeTruthy();
});

test('teardownOwnedAvd reports missing for an AVD that no longer exists', () => {
  setExecutor(androidExecutor({ avds: [], adb: 'List of devices attached\n' }));
  expect(teardownOwnedAvd('stim-cli-gone', { del: true }).status).toEqual('missing');
});

test('teardownOwnedAvd contains a throw instead of propagating it', () => {
  setExecutor(
    androidExecutor({
      avds: ['stim-cli-app'],
      adb: 'List of devices attached\nemulator-5554\tdevice\n',
      avdName: 'stim-cli-app',
      throwOn: 'delete avd',
    }),
  );
  const r = teardownOwnedAvd('stim-cli-app', { del: true });
  expect(r.status).toBe('failed');
  expect(r.reason).toMatch(/boom/);
});

test('ownership skip outcomes carry a machine-readable kind', () => {
  setExecutor(iosExecutor({ sims: [{ ...OWNED, name: 'My Real Sim' }] }));
  expect(teardownOwnedIosSim('U1', { del: true }).kind).toBe('not-owned');
  resetExecutor();

  setExecutor(androidExecutor({ avds: ['Pixel_6'], adb: 'List of devices attached\n' }));
  expect(teardownOwnedAvd('Pixel_6', { del: true }).kind).toBe('not-owned');
});
