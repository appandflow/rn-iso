import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { saveConfig, loadConfig } from '../src/config.js';
import releaseCommand, { releaseAction } from '../src/commands/release.js';

test('owned device is deleted', () => {
  assert.deepEqual(releaseAction({ record: { owned: true }, occupied: false, force: false }),
    { action: 'delete', reason: null });
});

test('occupied owned device is cleared, not deleted, without --force', () => {
  const r = releaseAction({ record: { owned: true }, occupied: true, force: false });
  assert.equal(r.action, 'clear');
  assert.match(r.reason, /in use/i);
});

test('--force deletes an occupied owned device', () => {
  assert.equal(releaseAction({ record: { owned: true }, occupied: true, force: true }).action, 'delete');
});

test('legacy and physical assignments are cleared, never deleted', () => {
  assert.equal(releaseAction({ record: { deviceUdid: 'U' }, occupied: false, force: false }).action, 'clear');
  assert.equal(releaseAction({ record: { serial: 'R5', owned: false }, occupied: false, force: true }).action, 'clear');
});

// --- Action-level: per-platform containment (I2) and ordering -----------

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

async function runRelease(args = []) {
  const program = new Command();
  releaseCommand(program);
  await program.parseAsync(['node', 'rn-iso', 'release', ...args]);
}

test('a throwing iOS ownership probe is contained: reported as a skip, the assignment is still cleared, and android still processes', async () => {
  saveConfig({
    version: 2,
    projects: {
      '/proj/a': {
        metroPort: 8083,
        platforms: {
          ios: { deviceUdid: 'UDID-ABC', owned: true },
          android: { avdName: 'rn-iso-app', consolePort: 5554, owned: true },
        },
      },
    },
  });
  const execCalls = [];
  setExecutor({
    run(cmd) {
      execCalls.push(cmd);
      // Simulate a wedged simctl daemon: listAllIosSims (used by
      // resolveOwnedIosSim) never answers.
      if (cmd.includes('simctl list devices --json')) throw new Error('simctl timed out');
      if (cmd === 'emulator -list-avds') return 'rn-iso-app\n';
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n';
      return '';
    },
    runQuiet(cmd) {
      execCalls.push(cmd);
      if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'rn-iso-app\nOK';
      return null;
    },
    spawn() { throw new Error('spawn should not be called from release'); },
  });

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await runRelease(['/proj/a']);
  } finally {
    console.log = originalLog;
  }

  // The iOS probe's throw was contained -- reported, not propagated.
  assert.ok(logs.some(l => /could not tear down the ios device/i.test(l)));
  // Android was still processed (deleted, since it's owned and identity
  // verified) -- proof the iOS throw didn't abort the whole command.
  assert.ok(execCalls.some(c => /delete avd -n "rn-iso-app"/.test(c)));
  const cfg = loadConfig();
  // Both assignments are cleared regardless of the iOS teardown failure.
  assert.equal(cfg.projects['/proj/a'].platforms.ios, undefined);
  assert.equal(cfg.projects['/proj/a'].platforms.android, undefined);
});

test('release verifies iOS ownership before probing occupancy', async () => {
  saveConfig({
    version: 2,
    projects: {
      '/proj/a': {
        metroPort: 8083,
        platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } },
      },
    },
  });
  const execCalls = [];
  // Booted on purpose: isSimOccupied short-circuits to "not occupied" for a
  // device that is not booted, so a shut-down fixture would never reach the
  // probe this test is asserting the ordering of.
  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'UDID-ABC', name: 'rn-iso-app', state: 'Booted', isAvailable: true },
      ],
    },
  });
  setExecutor({
    run(cmd) {
      execCalls.push(cmd);
      if (cmd.includes('simctl list devices --json')) return listJson;
      return '';
    },
    runQuiet(cmd) {
      execCalls.push(cmd);
      if (cmd.includes('simctl list devices --json')) return listJson;
      return null;
    },
    spawn() { throw new Error('spawn should not be called from release'); },
  });

  await runRelease(['/proj/a']);

  const listIndex = execCalls.findIndex(c => c.includes('simctl list devices --json'));
  const occupancyIndex = execCalls.findIndex(c => c.includes('launchctl list'));
  assert.ok(listIndex !== -1, 'ownership must be verified via a live listing');
  assert.ok(occupancyIndex !== -1, 'occupancy must still be probed once ownership is confirmed');
  assert.ok(listIndex < occupancyIndex, 'ownership must be verified BEFORE the occupancy probe shells at the udid');
});
