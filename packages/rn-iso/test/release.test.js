import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { saveConfig, loadConfig } from '../src/config.js';
import releaseCommand from '../src/commands/release.js';

// --- Action-level: per-platform containment (I2) and ordering -----------

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  resetExecutor();
  // A kept device record makes `release` exit non-zero; clear it so one test's
  // expected failure does not fail the whole file.
  process.exitCode = 0;
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

async function runRelease(args = []) {
  const program = new Command();
  releaseCommand(program);
  await program.parseAsync(['node', 'rn-iso', 'release', ...args]);
}

test('a throwing iOS ownership probe is contained: reported, the ios record is kept, and android still processes', async () => {
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
  // The iOS sim may well still exist, so its record survives: dropping it
  // would leave a simulator nothing references. The android device really was
  // deleted, so its assignment is cleared.
  assert.ok(cfg.projects['/proj/a'].platforms.ios, 'a failed teardown must keep its device record');
  assert.equal(cfg.projects['/proj/a'].platforms.android, undefined);
});

// The delete itself failing is the same fact as a failing probe: the sim is
// still on the machine, so the record that names it stays.
test('release keeps the ios record when the simctl delete fails', async () => {
  saveConfig({
    version: 2,
    projects: {
      '/proj/a': {
        metroPort: 8083,
        platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } },
      },
    },
  });
  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'UDID-ABC', name: 'rn-iso-app', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  setExecutor({
    run(cmd) {
      if (cmd.includes('simctl list devices --json')) return listJson;
      if (cmd.includes('simctl delete')) throw new Error('Unable to delete device');
      return '';
    },
    runQuiet(cmd) {
      if (cmd.includes('simctl list devices --json')) return listJson;
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

  assert.ok(logs.some(l => /Unable to delete device/.test(l)), 'the failure must be reported');
  assert.ok(loadConfig().projects['/proj/a'].platforms.ios, 'the undeleted sim must stay tracked');
  assert.equal(process.exitCode, 1, 'a device left behind is not a success');
  process.exitCode = 0;
});

test('release verifies iOS ownership before any destructive command reaches the udid', async () => {
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

  // release deletes, and a device being deleted is no longer occupancy-gated --
  // so the command that must not precede the ownership check is the destructive
  // one itself. Issuing shutdown/delete first would already have hit whatever
  // real simulator that udid resolves to.
  const listIndex = execCalls.findIndex(c => c.includes('simctl list devices --json'));
  const destructiveIndex = execCalls.findIndex(c => /simctl (shutdown|delete)/.test(c));
  assert.ok(listIndex !== -1, 'ownership must be verified via a live listing');
  assert.ok(destructiveIndex !== -1, 'release must actually tear the device down');
  assert.ok(listIndex < destructiveIndex, 'ownership must be verified BEFORE anything destructive shells at the udid');
});
