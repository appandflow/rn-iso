// test/shutdown.test.js
//
// Black-box exercise of `rn-iso shutdown`: seed config.json with two
// projects (one iOS-claimed, one Android-claimed, both with Metros), run
// the command via Commander with a mocked executor, and assert that:
//   1. Metro pids are SIGTERM'd (we capture process.kill calls).
//   2. simctl shutdown / adb emu kill are issued for the claimed devices.
//   3. metroPid is cleared and platforms.{ios,android} are removed from
//      the persisted config.
//
// We don't try to assert prompt behavior — the test runs with stdin not a
// TTY so the command takes the auto path (no prompt).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { saveConfig, loadConfig } from '../src/config.js';
import shutdownCommand from '../src/commands/shutdown.js';

let tmpHome;
let originalKill;
let killedPids;
let execCalls;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;

  // Capture process.kill targets without actually signalling anything.
  killedPids = [];
  originalKill = process.kill;
  process.kill = (pid, sig) => {
    killedPids.push({ pid, sig });
    // signal 0 in killMetroByPid is a liveness probe — return truthy.
    return true;
  };

  // Capture exec invocations. The list command answers with a device set
  // naming the owned fixtures rn-iso-* so the ownership probe verifies
  // them; the probe fails CLOSED on an unanswerable list, so a bare ''
  // here would silently skip every shutdown.
  execCalls = [];
  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'UDID-ABC', name: 'rn-iso-projA', state: 'Booted', isAvailable: true },
        { udid: 'UDID-OCC', name: 'rn-iso-occ', state: 'Booted', isAvailable: true },
      ],
    },
  });
  setExecutor({
    run(cmd) {
      execCalls.push({ kind: 'run', cmd });
      if (cmd.includes('simctl list devices --json')) return listJson;
      return '';
    },
    runQuiet(cmd) {
      execCalls.push({ kind: 'runQuiet', cmd });
      if (cmd.includes('simctl list devices --json')) return listJson;
      return null;
    },
    spawn() { throw new Error('spawn should not be called from shutdown'); },
  });
});

afterEach(() => {
  process.kill = originalKill;
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

async function runShutdown(args = []) {
  const program = new Command();
  shutdownCommand(program);
  await program.parseAsync(['node', 'rn-iso', 'shutdown', ...args]);
}

test('shutdown kills Metros, shuts down sims/emulators, clears assignments', async () => {
  saveConfig({
    version: 1,
    projects: {
      '/proj/a': {
        metroPort: 8083,
        metroPid: 11111,
        platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } },
      },
      '/proj/b': {
        metroPort: 8084,
        metroPid: 22222,
        platforms: { android: { avdName: 'Pixel_6_API_34', consolePort: 5556, owned: true } },
      },
    },
  });

  await runShutdown(['--yes']);

  // Both Metro pids were signalled with SIGTERM.
  const sigtermPids = killedPids.filter(k => k.sig === 'SIGTERM').map(k => k.pid).sort();
  assert.deepEqual(sigtermPids, [11111, 22222]);

  // simctl + adb were both invoked for the claimed devices.
  const simctlCalls = execCalls.filter(c => c.cmd.startsWith('xcrun simctl shutdown'));
  const adbCalls = execCalls.filter(c => c.cmd.includes('emu kill'));
  assert.equal(simctlCalls.length, 1);
  assert.match(simctlCalls[0].cmd, /UDID-ABC/);
  assert.equal(adbCalls.length, 1);
  assert.match(adbCalls[0].cmd, /emulator-5556/);

  // Config: metroPid cleared, platforms emptied. Project entries themselves
  // remain so labels / metroPort allocations survive a restart.
  const cfg = loadConfig();
  assert.equal(cfg.projects['/proj/a'].metroPid, null);
  assert.equal(cfg.projects['/proj/a'].metroPort, 8083);
  assert.equal(cfg.projects['/proj/a'].platforms.ios, undefined);
  assert.equal(cfg.projects['/proj/b'].metroPid, null);
  assert.equal(cfg.projects['/proj/b'].metroPort, 8084);
  assert.equal(cfg.projects['/proj/b'].platforms.android, undefined);
});

test('shutdown --keep-sims kills Metros but leaves sims booted (still clears assignments)', async () => {
  saveConfig({
    version: 1,
    projects: {
      '/proj/a': {
        metroPort: 8083,
        metroPid: 11111,
        platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } },
      },
    },
  });

  await runShutdown(['--yes', '--keep-sims']);

  const sigtermPids = killedPids.filter(k => k.sig === 'SIGTERM').map(k => k.pid);
  assert.deepEqual(sigtermPids, [11111]);

  // No simctl / adb shutdown calls — but formatIosLabel may still run
  // simctl list, so filter strictly on shutdown verbs.
  assert.equal(execCalls.filter(c => c.cmd.startsWith('xcrun simctl shutdown')).length, 0);
  assert.equal(execCalls.filter(c => c.cmd.includes('emu kill')).length, 0);

  // Assignments still cleared.
  const cfg = loadConfig();
  assert.equal(cfg.projects['/proj/a'].platforms.ios, undefined);
});

test('shutdown is a no-op when nothing is tracked', async () => {
  saveConfig({ version: 1, projects: {} });
  await runShutdown(['--yes']);
  assert.equal(killedPids.length, 0);
  assert.equal(execCalls.length, 0);
});

test('shutdown <target> scopes to a single project (by label) and leaves the others alone', async () => {
  saveConfig({
    version: 1,
    projects: {
      '/proj/a': {
        label: 'agent-1',
        metroPort: 8083,
        metroPid: 11111,
        platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } },
      },
      '/proj/b': {
        label: 'agent-2',
        metroPort: 8084,
        metroPid: 22222,
        platforms: { android: { avdName: 'Pixel_6_API_34', consolePort: 5556, owned: true } },
      },
    },
  });

  await runShutdown(['agent-1', '--yes']);

  // Only proj/a's Metro pid was signalled.
  const sigtermPids = killedPids.filter(k => k.sig === 'SIGTERM').map(k => k.pid);
  assert.deepEqual(sigtermPids, [11111]);

  // Only the iOS shutdown ran; android was untouched.
  assert.equal(execCalls.filter(c => c.cmd.startsWith('xcrun simctl shutdown')).length, 1);
  assert.equal(execCalls.filter(c => c.cmd.includes('emu kill')).length, 0);

  // proj/a is cleaned; proj/b is intact.
  const cfg = loadConfig();
  assert.equal(cfg.projects['/proj/a'].metroPid, null);
  assert.equal(cfg.projects['/proj/a'].platforms.ios, undefined);
  assert.equal(cfg.projects['/proj/b'].metroPid, 22222);
  assert.deepEqual(cfg.projects['/proj/b'].platforms.android, {
    avdName: 'Pixel_6_API_34',
    consolePort: 5556,
    owned: true,
  });
});

test('shutdown skips a legacy (non-owned) device and reports it, without issuing simctl shutdown', async () => {
  saveConfig({
    version: 1,
    projects: {
      '/proj/a': {
        metroPort: 8083,
        metroPid: 11111,
        // owned absent -- rn-iso did not create this sim and must never
        // shut it down, even though a claim for it is recorded.
        platforms: { ios: { deviceUdid: 'UDID-LEGACY' } },
      },
    },
  });

  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await runShutdown(['--yes']);
  } finally {
    console.log = originalLog;
  }

  assert.equal(execCalls.filter(c => c.cmd.startsWith('xcrun simctl shutdown')).length, 0);
  assert.ok(logs.some(l => /Skipped ios device UDID-LEGACY/.test(l)));

  // Assignment is still cleared even though the device itself was untouched.
  const cfg = loadConfig();
  assert.equal(cfg.projects['/proj/a'].platforms.ios, undefined);
});

test('shutdown skips an occupied owned iOS sim and reports it, without issuing simctl shutdown', async () => {
  saveConfig({
    version: 1,
    projects: {
      '/proj/a': {
        metroPort: 8083,
        metroPid: 11111,
        platforms: { ios: { deviceUdid: 'UDID-OCC', owned: true } },
      },
    },
  });

  // A foreign .xctrunner UI-test runner is attached -- isSimOccupied must
  // report true, and shutdown must leave the sim alone.
  setExecutor({
    run(cmd) { execCalls.push({ kind: 'run', cmd }); return ''; },
    runQuiet(cmd) {
      execCalls.push({ kind: 'runQuiet', cmd });
      if (/simctl spawn UDID-OCC launchctl list/.test(cmd)) {
        return '082a\t0\tUIKitApplication:com.example.MyAppUITests.xctrunner[082a][rb-legacy]';
      }
      return null;
    },
    spawn() { throw new Error('spawn should not be called from shutdown'); },
  });

  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await runShutdown(['--yes']);
  } finally {
    console.log = originalLog;
  }

  assert.equal(execCalls.filter(c => c.cmd.startsWith('xcrun simctl shutdown')).length, 0);
  assert.ok(logs.some(l => /Skipped ios device/.test(l) && /in use/i.test(l)));

  // Assignment is still cleared even though the device itself was left running.
  const cfg = loadConfig();
  assert.equal(cfg.projects['/proj/a'].platforms.ios, undefined);
});

test('shutdown <unknown-target> errors and exits without touching anything', async () => {
  saveConfig({
    version: 1,
    projects: {
      '/proj/a': { metroPort: 8083, metroPid: 11111, platforms: {} },
    },
  });
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (c) => { exitCode = c; throw new Error('process.exit called'); };
  try {
    await runShutdown(['no-such-project', '--yes']);
  } catch (e) {
    if (!/process\.exit/.test(e.message)) throw e;
  } finally {
    process.exit = originalExit;
  }
  assert.equal(exitCode, 1);
  assert.equal(killedPids.length, 0);
  assert.equal(execCalls.length, 0);
});

test('shutdown fails closed when ownership cannot be verified: no simctl shutdown issued', async () => {
  saveConfig({
    version: 2,
    projects: {
      '/proj/a': { metroPort: 8083, metroPid: null, platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } } },
    },
  });
  // Break the ownership probe: the list command now returns garbage, so
  // resolveOwnedIosSim throws. The probe is the only guard on this path
  // (no deleteIosSim backstop), so shutdown must SKIP, not proceed.
  setExecutor({
    run(cmd) { execCalls.push({ kind: 'run', cmd }); return 'not json'; },
    runQuiet(cmd) { execCalls.push({ kind: 'runQuiet', cmd }); return 'not json'; },
    spawn() { throw new Error('spawn should not be called from shutdown'); },
  });

  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await runShutdown(['--yes']);
  } finally {
    console.log = originalLog;
  }

  assert.equal(execCalls.filter(c => c.cmd.includes('simctl shutdown')).length, 0);
  assert.ok(logs.some(l => /Skipped ios device/.test(l) && /could not be verified/i.test(l)));
});
