import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../src/teardown.js';

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
  assert.equal(r.status, 'torn-down');
  assert.equal(r.label, 'rn-iso-app');
  assert.ok(exec.calls.some(c => /simctl shutdown U1/.test(c)), 'expected a shutdown');
  assert.ok(exec.calls.some(c => /simctl delete U1/.test(c)), 'expected a delete');
});

test('teardownOwnedIosSim shuts down WITHOUT deleting when del is false', () => {
  const exec = iosExecutor({ sims: [OWNED] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: false });
  assert.equal(r.status, 'torn-down');
  assert.ok(exec.calls.some(c => /simctl shutdown U1/.test(c)));
  assert.ok(!exec.calls.some(c => /simctl delete/.test(c)), 'must not delete');
});

test('teardownOwnedIosSim refuses a sim renamed away from rn-iso ownership', () => {
  const exec = iosExecutor({ sims: [{ ...OWNED, name: 'My Real Sim' }] });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /not rn-iso-owned/);
  assert.ok(!exec.calls.some(c => /simctl shutdown|simctl delete/.test(c)), 'must not touch it');
});

test('teardownOwnedIosSim reports missing without erroring', () => {
  setExecutor(iosExecutor({ sims: [] }));
  assert.deepEqual(teardownOwnedIosSim('U1', { del: true }), { status: 'missing' });
});

test('teardownOwnedIosSim skips an occupied sim and never shuts it down', () => {
  const exec = iosExecutor({ sims: [OWNED], occupied: '\t123\t0\tUIKitApplication:com.example.thing.xctrunner[0x1][rb-legacy]\n' });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /occupied/);
  assert.ok(!exec.calls.some(c => /simctl shutdown|simctl delete/.test(c)));
});

test('teardownOwnedIosSim force overrides occupancy', () => {
  const exec = iosExecutor({ sims: [OWNED], occupied: '\t123\t0\tUIKitApplication:com.example.thing.xctrunner[0x1][rb-legacy]\n' });
  setExecutor(exec);
  const r = teardownOwnedIosSim('U1', { del: true, force: true });
  assert.equal(r.status, 'torn-down');
  assert.ok(exec.calls.some(c => /simctl delete U1/.test(c)));
});

// Containment: a throw must become a reported outcome, never propagate and
// abort a batch teardown (worktree remove, gc sweeping many orphans).
test('teardownOwnedIosSim contains a throw instead of propagating it', () => {
  setExecutor(iosExecutor({ sims: [OWNED], throwOn: 'simctl shutdown' }));
  const r = teardownOwnedIosSim('U1', { del: true });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /boom/);
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
  assert.equal(r.status, 'torn-down');
  assert.ok(exec.calls.some(c => /emu kill/.test(c)), 'expected an emu kill');
  assert.ok(exec.calls.some(c => /delete avd -n/.test(c)), 'expected a delete');
});

test('teardownOwnedAvd refuses an AVD that is not rn-iso-owned by name', () => {
  const exec = androidExecutor({ avds: ['Pixel_6_API_34'], adb: 'List of devices attached\n' });
  setExecutor(exec);
  const r = teardownOwnedAvd('Pixel_6_API_34', { del: true });
  assert.equal(r.status, 'skipped');
  assert.ok(!exec.calls.some(c => /emu kill|avdmanager delete/.test(c)));
});

test('teardownOwnedAvd reports missing for an AVD that no longer exists', () => {
  setExecutor(androidExecutor({ avds: [], adb: 'List of devices attached\n' }));
  assert.deepEqual(teardownOwnedAvd('rn-iso-gone', { del: true }).status, 'missing');
});

test('teardownOwnedAvd contains a throw instead of propagating it', () => {
  setExecutor(androidExecutor({
    avds: ['rn-iso-app'],
    adb: 'List of devices attached\nemulator-5554\tdevice\n',
    avdName: 'rn-iso-app',
    throwOn: 'delete avd',
  }));
  const r = teardownOwnedAvd('rn-iso-app', { del: true });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /boom/);
});

test('skip outcomes carry a machine-readable kind, so callers need not match prose', () => {
  setExecutor(iosExecutor({ sims: [{ ...OWNED, name: 'My Real Sim' }] }));
  assert.equal(teardownOwnedIosSim('U1', { del: true }).kind, 'not-owned');
  resetExecutor();

  setExecutor(iosExecutor({ sims: [OWNED], occupied: '\t1\t0\tUIKitApplication:com.x.xctrunner[0x1]\n' }));
  assert.equal(teardownOwnedIosSim('U1', { del: true }).kind, 'occupied');
  resetExecutor();

  setExecutor(androidExecutor({ avds: ['Pixel_6'], adb: 'List of devices attached\n' }));
  assert.equal(teardownOwnedAvd('Pixel_6', { del: true }).kind, 'not-owned');
});
