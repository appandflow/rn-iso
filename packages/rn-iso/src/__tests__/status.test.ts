// test/status.test.js
//
// Black-box exercise of `rn-iso status`: seed config.json with device-owning
// projects, run the command via Commander with a mocked executor, and assert
// what the printed lines say -- the "(owned)" tag, and what is reported when
// simctl itself cannot be read (pattern: test/shutdown.test.js).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../exec.ts';
import { saveConfig } from '../config.ts';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert';
import { makeConfig } from './_factories.ts';
import statusCommand, { readVolumes } from '../commands/status.ts';
import type { NdjsonRecord } from '../ndjson.ts';

let tmpHome: string;

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
    spawn() {
      throw new Error('spawn should not be called from status');
    },
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
  const logs: string[] = [];
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
  saveConfig(makeConfig({
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
  }));

  const logs = await runStatus();

  const iosLine = logs.find((l) => /ios:/.test(l));
  expect(iosLine).toBeTruthy();
  expect(iosLine).toMatch(/\(owned\)/);

  const androidLine = logs.find((l) => /android:/.test(l));
  expect(androidLine).toBeTruthy();
  expect(androidLine).not.toMatch(/\(owned\)/);
});

test('status says nothing extra for a project that has only a Metro port', async () => {
  saveConfig(makeConfig({
    version: 2,
    projects: {
      '/proj/a': {
        label: 'agent-1',
        metroPort: 8083,
        platforms: {},
      },
    },
  }));

  const logs = await runStatus();

  expect(logs.some((l) => /!/.test(l))).toBe(false);
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
    runQuiet() {
      return null;
    },
    spawn() {
      throw new Error('spawn should not be called from status');
    },
  });
  saveConfig(makeConfig({
    version: 2,
    projects: {
      '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } } },
      '/proj/b': { label: 'agent-2', platforms: { ios: { deviceUdid: 'UDID-DEF', owned: true } } },
    },
  }));

  const logs = await runStatus();

  expect(logs.some((l) => /no longer exists/.test(l))).toBe(false);
  const simctlLine = logs.find((l) => /simctl could not be read/.test(l));
  expect(simctlLine).toBeTruthy();
  expect(simctlLine).toMatch(/simctl not found/);
  expect(logs.some((l) => /ios:.*unknown/.test(l))).toBeTruthy();
});

// A simctl that DOES answer, with a listing that lacks the recorded sim, is
// proof: the record outlived the device, and that still warns.
test('status still warns about a recorded sim missing from a readable listing', async () => {
  saveConfig(makeConfig({
    version: 2,
    projects: {
      '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-GONE', owned: true } } },
    },
  }));

  const logs = await runStatus();

  expect(logs.some((l) => /recorded sim UDID-GONE no longer exists/.test(l))).toBeTruthy();
});

// --- v3: supervisor and logs ------------------------------------------------

async function runStatusJson() {
  const program = new Command();
  statusCommand(program);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await program.parseAsync(['node', 'rn-iso', 'status', '--json']);
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(logs.join('\n'));
}

function writeLogs(root: string, records: NdjsonRecord[]) {
  mkdirSync(join(root, '.rn-iso', 'logs'), { recursive: true });
  writeFileSync(join(root, '.rn-iso', 'logs', 'metro.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeState(root: string, supervisor: { pid: number; port: number; mode: string; startedAt: number }) {
  mkdirSync(join(root, '.rn-iso'), { recursive: true });
  writeFileSync(join(root, '.rn-iso', 'state.json'), JSON.stringify({ supervisor }));
}

// Health is Contract 3: the identity check, never a bare /status probe. This
// stands up a real server on a real port and mocks only the process lookups, so
// the HTTP half is genuinely exercised.
test('status reports a supervisor whose port answers as this project as healthy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-proj-'));
  const server = createServer((req, res) => res.end('packager-status:running'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    setExecutor({
      run: () => '',
      runQuiet(cmd) {
        if (cmd.includes(`-iTCP:${port}`)) return String(process.pid);
        if (cmd.includes('-d cwd -Fn')) return `p${process.pid}\nfcwd\nn${root}`;
        if (cmd.startsWith('ps -o pgid=')) return String(process.pid);
        return null;
      },
      spawn() {
        throw new Error('spawn should not be called from status');
      },
    });
    writeState(root, { pid: process.pid, port, mode: 'bare-inproc', startedAt: 1700000000000 });
    writeLogs(root, [
      { ts: 1, src: 'metro', level: 'error', msg: 'before the marker' },
      { ts: 2, src: 'metro', level: 'info', msg: 'bundle built', marker: true },
      { ts: 3, src: 'metro', level: 'error', msg: 'after the marker' },
    ]);
    saveConfig(makeConfig({
      version: 2,
      projects: {
        [root]: {
          label: 'agent-1',
          metroPort: port,
          supervisor: { pid: process.pid, port, startedAt: '1700000000000' },
          platforms: {},
        },
      },
    }));

    const payload = await runStatusJson();
    const env = payload.environments[0];
    expect(env.supervisor).toEqual({
      pid: process.pid,
      mode: 'bare-inproc',
      startedAt: 1700000000000,
      healthy: true,
    });
    expect(env.logs.errorsSinceMarker).toBe(1);
    expect(env.logs.dir).toMatch(/\.rn-iso\/logs$/);
    expect(env.warnings).toEqual([]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

// FIELD CASE. `status` reported "3004 errors since the last marker" on an app
// that was working: every one of those records was iOS syslog from inside the
// app's process. status counts with queryLogs({ errorsOnly: true }), the same
// call `logs --errors` makes, so it inherits the same scope -- which is the
// point: the two must never disagree about whether this workspace is failing.
test('status counts a device-only noise storm as zero errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-proj-'));
  try {
    mkdirSync(join(root, '.rn-iso', 'logs'), { recursive: true });
    const storm = [];
    for (let i = 0; i < 3004; i += 1) {
      storm.push({
        ts: 1700000000000 + i,
        src: 'device',
        level: 'error',
        proc: 'MyApp',
        msg: `nw_socket_handle_socket_event [C${i}:1] Socket SO_ERROR [54: Connection reset by peer]`,
      });
    }
    writeFileSync(
      join(root, '.rn-iso', 'logs', 'device.ndjson'),
      storm.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    saveConfig(makeConfig({
      version: 2,
      projects: { [root]: { label: 'agent-1', metroPort: 8099, platforms: {} } },
    }));

    const payload = await runStatusJson();
    expect(payload.environments[0].logs.errorsSinceMarker).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status warns about a supervisor record whose process is gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-proj-'));
  try {
    writeState(root, { pid: 999999, port: 8083, mode: 'expo-child', startedAt: 5 });
    saveConfig(makeConfig({
      version: 2,
      projects: {
        [root]: { label: 'agent-1', metroPort: 8083, supervisor: { pid: 999999, port: 8083 }, platforms: {} },
      },
    }));

    const logs = await runStatus();
    expect(logs.some((l) => /stale supervisor record/.test(l))).toBeTruthy();

    const payload = await runStatusJson();
    expect(payload.environments[0].supervisor.healthy).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace with no supervisor and no logs reports both as null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-proj-'));
  try {
    saveConfig(makeConfig({ version: 2, projects: { [root]: { label: 'agent-1', platforms: {} } } }));
    const payload = await runStatusJson();
    expect(payload.environments[0].supervisor).toBe(null);
    expect(payload.environments[0].logs).toBe(null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The human output is what an agent reads when it does not ask for --json.
test('the printed lines name the supervisor and the error count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-proj-'));
  try {
    writeState(root, { pid: 999999, port: 8083, mode: 'expo-child', startedAt: 5 });
    writeLogs(root, [{ ts: 3, src: 'metro', level: 'error', msg: 'boom' }]);
    saveConfig(makeConfig({ version: 2, projects: { [root]: { label: 'agent-1', metroPort: 8083, platforms: {} } } }));

    const logs = await runStatus();
    expect(logs.some((l) => /supervisor: pid 999999/.test(l))).toBeTruthy();
    expect(logs.some((l) => /1 error/.test(l))).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the disk report --------------------------------------------------
//
// It read `df -k /` and nothing else. On a machine whose repos live on an
// external SSD that number describes a volume nothing is building on, while the
// volume that can actually fill up -- build output is workspace-local -- went
// unmentioned. `volumeRootFor` decides which volumes are in play, so this is
// checked with an explicit path rather than against wherever the suite runs.
function dfOutput({ totalKb, availableKb }: { totalKb: number; availableKb: number }) {
  const usedKb = totalKb - availableKb;
  const capacity = Math.round((usedKb / totalKb) * 100);
  return (
    `Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n` +
    `/dev/disk3s5 ${totalKb} ${usedKb} ${availableKb} ${capacity}% 100 200 1% /somewhere\n`
  );
}

function dfExecutor(byVolume: Record<string, string>) {
  const asked: string[] = [];
  setExecutor({
    run() {
      return '';
    },
    runQuiet(cmd) {
      const m = /^df -k '(.*)'$/.exec(cmd);
      if (!m) return null;
      asked.push(m[1]);
      return byVolume[m[1]] ?? null;
    },
    spawn() {
      throw new Error('spawn should not be called from status');
    },
  });
  return asked;
}

test('a project on the boot volume reports one volume', async () => {
  const asked = dfExecutor({ '/': dfOutput({ totalKb: 926 * 1024 * 1024, availableKb: 38 * 1024 * 1024 }) });
  const volumes = readVolumes('/Users/someone/code/app');
  expect(asked).toEqual(['/']);
  expect(volumes.map((v) => v.volume)).toEqual(['/']);
});

test('a project on another volume reports that volume alongside the boot one', async () => {
  const asked = dfExecutor({
    '/': dfOutput({ totalKb: 926 * 1024 * 1024, availableKb: 38 * 1024 * 1024 }),
    '/Volumes/ExternalSSD': dfOutput({ totalKb: 2048 * 1024 * 1024, availableKb: 1536 * 1024 * 1024 }),
  });
  const volumes = readVolumes('/Volumes/ExternalSSD/Developer/app');
  expect(asked).toEqual(['/', '/Volumes/ExternalSSD']);
  expect(volumes.map((v) => v.volume)).toEqual(['/', '/Volumes/ExternalSSD']);
  assert(volumes[1].disk);
  expect(volumes[1].disk.availableMb).toBe(1536 * 1024);
});

// A df that cannot be read is a missing line, never a crash and never a zero.
test('a volume df cannot answer for is dropped, not reported as empty', async () => {
  dfExecutor({ '/': dfOutput({ totalKb: 926 * 1024 * 1024, availableKb: 38 * 1024 * 1024 }) });
  const volumes = readVolumes('/Volumes/Unplugged/app');
  expect(volumes.map((v) => v.volume)).toEqual(['/']);
});
