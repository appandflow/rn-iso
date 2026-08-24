// test/status.test.js
//
// Black-box exercise of `rn-iso status`: seed config.json with an
// owned-device project and a project with an incomplete setup pipeline, run
// the command via Commander with a mocked executor, and assert the printed
// lines carry the "(owned)" tag and the "setup incomplete: ..." line
// (pattern: test/shutdown.test.js).

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


test('status says nothing extra for a project with complete setup', async () => {
  saveConfig({
    version: 2,
    projects: {
      '/proj/a': {
        label: 'agent-1',
        metroPort: 8083,
        platforms: {},
        setup: { complete: true, commands: [{ command: 'npm install', ok: true }] },
      },
    },
  });

  const logs = await runStatus();

  assert.equal(logs.some(l => /setup incomplete/.test(l)), false);
});
