// test/status.test.js
//
// Black-box exercise of `rn-iso status`: seed config.json with device-owning
// projects, run the command via Commander with a mocked executor, and assert
// what the printed lines say -- the "(owned)" tag, and what is reported when
// simctl itself cannot be read (pattern: test/shutdown.test.js).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../src/exec.js';
import {saveConfig} from '../src/config.js';
import statusCommand from '../src/commands/status.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;

  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'UDID-ABC', name: 'rn-iso-projA', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  setExecutor({
    run(cmd) {
      if (cmd.includes('simctl list devices --json')) return listJson;
      return '';
    },
    runQuiet(cmd) {
      if (cmd.includes('simctl list devices --json')) return listJson;
      return null;
    },
    spawn() { throw new Error('spawn should not be called from status'); },
  });
});

afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

async function runStatus() {
  const program = new Command();
  statusCommand(program);
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await program.parseAsync(['node', 'rn-iso', 'status']);
  } finally {
    console.log = originalLog;
  }
  return logs;
}

test('status tags owned devices and leaves unowned devices untagged', async () => {
  saveConfig({
    version: 2,
    projects: {
      '/proj/a': {
        label: 'agent-1',
        metroPort: 8083,
        platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } },
      },
      '/proj/b': {
        label: 'agent-2',
        metroPort: 8084,
        platforms: { android: { avdName: 'Pixel_6_API_34', consolePort: 5556 } },
      },
    },
  });

  const logs = await runStatus();

  const iosLine = logs.find(l => /ios:/.test(l));
  assert.ok(iosLine, 'expected an ios status line');
  assert.match(iosLine, /\(owned\)/);

  const androidLine = logs.find(l => /android:/.test(l));
  assert.ok(androidLine, 'expected an android status line');
  assert.doesNotMatch(androidLine, /\(owned\)/);
});


test('status says nothing extra for a project that has only a Metro port', async () => {
  saveConfig({
    version: 2,
    projects: {
      '/proj/a': {
        label: 'agent-1',
        metroPort: 8083,
        platforms: {},
      },
    },
  });

  const logs = await runStatus();

  assert.equal(logs.some(l => /!/.test(l)), false, 'a project with no device has nothing to warn about');
});

// "simctl did not answer" and "simctl answered with zero sims" are different
// facts. Only the second one proves a recorded sim is gone, so a failing
// simctl must not warn "no longer exists" once per project.
test('status reports simctl as unreadable instead of warning that every sim is gone', async () => {
  setExecutor({
    run(cmd) {
      if (cmd.includes('simctl list devices --json')) throw new Error('xcrun: simctl not found');
      return '';
    },
    runQuiet() { return null; },
    spawn() { throw new Error('spawn should not be called from status'); },
  });
  saveConfig({
    version: 2,
    projects: {
      '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } } },
      '/proj/b': { label: 'agent-2', platforms: { ios: { deviceUdid: 'UDID-DEF', owned: true } } },
    },
  });

  const logs = await runStatus();

  assert.equal(logs.some(l => /no longer exists/.test(l)), false, 'an unreadable simctl proves nothing about a recorded sim');
  const simctlLine = logs.find(l => /simctl could not be read/.test(l));
  assert.ok(simctlLine, 'expected one line saying simctl could not be read');
  assert.match(simctlLine, /simctl not found/);
  assert.ok(logs.some(l => /ios:.*unknown/.test(l)), 'the sim state is unknown, not missing');
});

// A simctl that DOES answer, with a listing that lacks the recorded sim, is
// proof: the record outlived the device, and that still warns.
test('status still warns about a recorded sim missing from a readable listing', async () => {
  saveConfig({
    version: 2,
    projects: {
      '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-GONE', owned: true } } },
    },
  });

  const logs = await runStatus();

  assert.ok(logs.some(l => /recorded sim UDID-GONE no longer exists/.test(l)));
});
