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

  // Capture exec invocations.
  execCalls = [];
  setExecutor({
    run(cmd) { execCalls.push({ kind: 'run', cmd }); return ''; },
    runQuiet(cmd) { execCalls.push({ kind: 'runQuiet', cmd }); return null; },
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
        platforms: { ios: { deviceUdid: 'UDID-ABC' } },
      },
      '/proj/b': {
        metroPort: 8084,
        metroPid: 22222,
        platforms: { android: { avdName: 'Pixel_6_API_34', consolePort: 5556 } },
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
        platforms: { ios: { deviceUdid: 'UDID-ABC' } },
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
