import { setExecutor, resetExecutor } from '../exec.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.ts';

afterEach(() => resetExecutor());

function iosExecutor({ sims = [], occupied = '', throwOn = null } = {}) {
  const calls = [];
  const listJson = JSON.stringify({
    devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': sims },
  });
  const answer = (cmd) => {
    calls.push(cmd);
    if (throwOn && cmd.includes(throwOn)) throw new Error('boom');
    if (cmd.includes('simctl list devices --json')) return listJson;
    if (/simctl spawn .* launchctl list/.test(cmd)) return occupied;
    return '';
  };
  return { calls, run: answer, runQuiet: answer, spawn: () => {} };
}

const OWNED = { udid: 'U1', name: 'rn-iso-app', state: 'Booted', isAvailable: true };

test('teardownOwnedIosSim shuts down and deletes an owned, unoccupied sim', () => {
  const exec = iosExecutor({ sims: [OWNED] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('torn-down');
  expect(r.label).toBe('rn-iso-app');
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

test('teardownOwnedIosSim refuses a sim renamed away from rn-iso ownership', () => {
  const exec = iosExecutor({ sims: [{ ...OWNED, name: 'My Real Sim' }] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('skipped');
  expect(r.reason).toMatch(/not rn-iso-owned/);
  expect(!exec.calls.some((c) => /simctl shutdown|simctl delete/.test(c))).toBeTruthy();
});

test('teardownOwnedIosSim reports missing without erroring', () => {
  setExecutor(iosExecutor({ sims: [] }));
  expect(teardownOwnedIosSim('U1', { del: true })).toEqual({ status: 'missing' });
});

// Occupancy protects a device that will SURVIVE. `shutdown` spares an occupied
// sim because it is still there to come back to.
test('teardownOwnedIosSim skips an occupied sim it is only shutting down', () => {
  const exec = iosExecutor({
    sims: [OWNED],
    occupied: '\t123\t0\tUIKitApplication:com.example.thing.xctrunner[0x1][rb-legacy]\n',
  });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: false });
  expect(r.status).toBe('skipped');
  expect(r.reason).toMatch(/occupied/);
  expect(!exec.calls.some((c) => /simctl shutdown|simctl delete/.test(c))).toBeTruthy();
});

// ...but a sim being DELETED is going away regardless: it is one rn-iso
// created, for a project that is going away, and the holder is almost always
// the caller's own UI-test runner. Skipping here leaked booted sims out of
// `worktree remove` and only deferred the same decision to gc.
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

// Ownership is still absolute: aggression applies to what rn-iso created, and
// a sim renamed out of the prefix is not that, occupied or not.
test('teardownOwnedIosSim still refuses a sim that is not rn-iso-owned, even when deleting', () => {
  const exec = iosExecutor({ sims: [{ udid: 'U1', name: 'My iPhone', state: 'Booted', isAvailable: true }] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('skipped');
  expect(r.kind).toBe('not-owned');
  expect(!exec.calls.some((c) => /simctl shutdown|simctl delete/.test(c))).toBeTruthy();
});

// A delete that fails leaves the sim on disk. The outcome must be 'failed', so
// callers report a leak instead of a device they never destroyed.
test('teardownOwnedIosSim reports a failed delete rather than torn-down', () => {
  const exec = iosExecutor({ sims: [OWNED], throwOn: 'simctl delete' });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('failed');
  expect(r.reason).toMatch(/boom/);
});

// Containment: a throw must become a reported outcome, never propagate and
// abort a batch teardown (worktree remove, gc sweeping many orphans).
test('teardownOwnedIosSim contains a throw instead of propagating it', () => {
  setExecutor(iosExecutor({ sims: [OWNED], throwOn: 'simctl shutdown' }));
  const r = teardownOwnedIosSim('U1', { del: true });
  expect(r.status).toBe('failed');
  expect(r.reason).toMatch(/boom/);
});

function androidExecutor({ avds = [], adb = '', avdName = null, throwOn = null } = {}) {
  const calls = [];
  const answer = (cmd) => {
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
    avds: ['rn-iso-app'],
    adb: 'List of devices attached\nemulator-5554\tdevice\n',
    avdName: 'rn-iso-app',
  });
  setExecutor(exec);
  const r = teardownOwnedAvd('rn-iso-app', { del: true });
  expect(r.status).toBe('torn-down');
  expect(exec.calls.some((c) => /emu kill/.test(c))).toBeTruthy();
  expect(exec.calls.some((c) => /delete avd -n/.test(c))).toBeTruthy();
});

test('teardownOwnedAvd refuses an AVD that is not rn-iso-owned by name', () => {
  const exec = androidExecutor({ avds: ['Pixel_6_API_34'], adb: 'List of devices attached\n' });
  setExecutor(exec);
  const r = teardownOwnedAvd('Pixel_6_API_34', { del: true });
  expect(r.status).toBe('skipped');
  expect(!exec.calls.some((c) => /emu kill|avdmanager delete/.test(c))).toBeTruthy();
});

test('teardownOwnedAvd reports missing for an AVD that no longer exists', () => {
  setExecutor(androidExecutor({ avds: [], adb: 'List of devices attached\n' }));
  expect(teardownOwnedAvd('rn-iso-gone', { del: true }).status).toEqual('missing');
});

test('teardownOwnedAvd contains a throw instead of propagating it', () => {
  setExecutor(
    androidExecutor({
      avds: ['rn-iso-app'],
      adb: 'List of devices attached\nemulator-5554\tdevice\n',
      avdName: 'rn-iso-app',
      throwOn: 'delete avd',
    }),
  );
  const r = teardownOwnedAvd('rn-iso-app', { del: true });
  expect(r.status).toBe('failed');
  expect(r.reason).toMatch(/boom/);
});

test('skip outcomes carry a machine-readable kind, so callers need not match prose', () => {
  setExecutor(iosExecutor({ sims: [{ ...OWNED, name: 'My Real Sim' }] }));
  expect(teardownOwnedIosSim('U1', { del: true }).kind).toBe('not-owned');
  resetExecutor();

  // del:false -- the occupied skip only exists for a device that will survive.
  setExecutor(iosExecutor({ sims: [OWNED], occupied: '\t1\t0\tUIKitApplication:com.x.xctrunner[0x1]\n' }));
  expect(teardownOwnedIosSim('U1', { del: false }).kind).toBe('occupied');
  resetExecutor();

  setExecutor(androidExecutor({ avds: ['Pixel_6'], adb: 'List of devices attached\n' }));
  expect(teardownOwnedAvd('Pixel_6', { del: true }).kind).toBe('not-owned');
});
