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
import { ensureWorkspaceStorage, workspaceLogsDir, workspaceStateFile } from '../paths.ts';
import { deviceLeasePath, deviceLocksDir } from '../engine/device-lease.ts';
import { findProjectRoot } from '../project.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;

  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'UDID-ABC', name: 'stim-projA', state: 'Shutdown', isAvailable: true },
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
  delete process.env.STIM_HOME;
});

async function runStatus() {
  const program = new Command();
  statusCommand(program);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await program.parseAsync(['node', 'stim', 'status']);
  } finally {
    console.log = originalLog;
  }
  return logs;
}

test('status tags owned devices and leaves unowned devices untagged', async () => {
  saveConfig(
    makeConfig({
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
    }),
  );

  const logs = await runStatus();

  const iosLine = logs.find((l) => /ios:/.test(l));
  expect(iosLine).toBeTruthy();
  expect(iosLine).toMatch(/\(owned\)/);

  const androidLine = logs.find((l) => /android:/.test(l));
  expect(androidLine).toBeTruthy();
  expect(androidLine).not.toMatch(/\(owned\)/);
});

test('status says nothing extra for a project that has only a Metro port', async () => {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/proj/a': {
          label: 'agent-1',
          metroPort: 8083,
          platforms: {},
        },
      },
    }),
  );

  const logs = await runStatus();

  expect(logs.some((l) => /!/.test(l))).toBe(false);
});

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
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } } },
        '/proj/b': { label: 'agent-2', platforms: { ios: { deviceUdid: 'UDID-DEF', owned: true } } },
      },
    }),
  );

  const logs = await runStatus();

  expect(logs.some((l) => /no longer exists/.test(l))).toBe(false);
  const simctlLine = logs.find((l) => /simctl could not be read/.test(l));
  expect(simctlLine).toBeTruthy();
  expect(simctlLine).toMatch(/simctl not found/);
  expect(logs.some((l) => /ios:.*unknown/.test(l))).toBeTruthy();
});

test('status still warns about a recorded sim missing from a readable listing', async () => {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-GONE', owned: true } } },
      },
    }),
  );

  const logs = await runStatus();

  expect(logs.some((l) => /recorded sim UDID-GONE no longer exists/.test(l))).toBeTruthy();
});

test('status reports a parked simulator when no projects remain', async () => {
  process.env.STIM_POOL_IOS_PARKED_MAX = '3';
  saveConfig(
    makeConfig({
      parked: {
        ios: [
          {
            udid: 'PARKED-1',
            name: 'stim-parked (iPhone 17 26.5) park',
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
            parkedAt: '2026-09-03T00:00:00.000Z',
            simslimManaged: false,
          },
        ],
        android: [],
      },
    }),
  );

  try {
    const logs = await runStatus();
    expect(logs).toContain('pool: 1 parked iOS simulator (max 3)');
  } finally {
    delete process.env.STIM_POOL_IOS_PARKED_MAX;
  }
});

async function runStatusJson() {
  const program = new Command();
  statusCommand(program);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await program.parseAsync(['node', 'stim', 'status', '--json']);
  } finally {
    console.log = originalLog;
  }
  expect(logs.length).toBe(1);
  const [line] = logs;
  assert(line);
  expect(line).not.toContain('\n');
  return JSON.parse(line);
}

function writeLogs(root: string, records: NdjsonRecord[]) {
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeState(root: string, supervisor: { pid: number; port: number; mode: string; startedAt: number }) {
  ensureWorkspaceStorage(root);
  writeFileSync(workspaceStateFile(root), JSON.stringify({ supervisor }));
}

test('status reports a supervisor whose port answers as this project as healthy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  const server = createServer((_req, res) => res.end('packager-status:running'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const listenerPid = 999999901;
    setExecutor({
      run: () => '',
      runQuiet(cmd) {
        if (cmd.includes(`-iTCP:${port}`)) return String(listenerPid);
        if (cmd.includes('-d cwd -Fn')) return `p${listenerPid}\nfcwd\nn${root}`;
        if (cmd.startsWith('ps -o pgid=')) return String(listenerPid);
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
    saveConfig(
      makeConfig({
        version: 2,
        projects: {
          [root]: {
            label: 'agent-1',
            metroPort: port,
            supervisor: { pid: process.pid, port, startedAt: '1700000000000' },
            platforms: {},
          },
        },
      }),
    );

    const payload = await runStatusJson();
    const env = payload.environments[0];
    expect(env.supervisor).toEqual({
      pid: process.pid,
      mode: 'bare-inproc',
      startedAt: 1700000000000,
      healthy: true,
    });
    expect(env.logs.errorsSinceMarker).toBe(1);
    expect(env.logs.dir).toBe(workspaceLogsDir(root));
    expect(env.warnings).toEqual([]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('status counts a device-only noise storm as zero errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  try {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
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
    writeFileSync(join(workspaceLogsDir(root), 'device.ndjson'), storm.map((r) => JSON.stringify(r)).join('\n') + '\n');
    saveConfig(
      makeConfig({
        version: 2,
        projects: { [root]: { label: 'agent-1', metroPort: 8099, platforms: {} } },
      }),
    );

    const payload = await runStatusJson();
    expect(payload.environments[0].logs.errorsSinceMarker).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status warns about a supervisor record whose process is gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  try {
    writeState(root, { pid: 999999, port: 8083, mode: 'expo-child', startedAt: 5 });
    saveConfig(
      makeConfig({
        version: 2,
        projects: {
          [root]: { label: 'agent-1', metroPort: 8083, supervisor: { pid: 999999, port: 8083 }, platforms: {} },
        },
      }),
    );

    const logs = await runStatus();
    expect(logs.some((l) => /stale supervisor record/.test(l))).toBeTruthy();

    const payload = await runStatusJson();
    expect(payload.environments[0].supervisor.healthy).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace with no supervisor and no logs reports both as null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  try {
    saveConfig(makeConfig({ version: 2, projects: { [root]: { label: 'agent-1', platforms: {} } } }));
    const payload = await runStatusJson();
    expect(payload.environments[0].supervisor).toBe(null);
    expect(payload.environments[0].logs).toBe(null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the printed lines name the supervisor and the error count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
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

test('a label-only worktree root is flagged labelOnly in --json and relabelled in the human view', async () => {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/wt/agent-1': { label: 'agent-1', worktreeRoot: true, platforms: {} },
        '/wt/agent-1/apps/mobile': {
          label: 'agent-1',
          bundleId: 'com.acme.app',
          metroPort: 8083,
          platforms: {},
        },
      },
    }),
  );

  const payload = await runStatusJson();
  expect(payload.environments.length).toBe(2);
  const rootEntry = payload.environments.find((e: { path: string }) => e.path === '/wt/agent-1');
  const appEntry = payload.environments.find((e: { path: string }) => e.path === '/wt/agent-1/apps/mobile');
  assert(rootEntry);
  assert(appEntry);
  expect(rootEntry.labelOnly).toBe(true);
  expect('labelOnly' in appEntry).toBe(false);

  const logs = await runStatus();
  expect(logs.some((l) => /worktree root \(holds the label/.test(l))).toBeTruthy();
});

test('a worktree root that is itself the app is not flagged labelOnly', async () => {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/wt/agent-2': {
          label: 'agent-2',
          worktreeRoot: true,
          bundleId: 'com.acme.solo',
          metroPort: 8084,
          platforms: {},
        },
      },
    }),
  );

  const payload = await runStatusJson();
  expect(payload.environments.length).toBe(1);
  expect('labelOnly' in payload.environments[0]).toBe(false);
});

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
      const vol = m[1];
      assert(vol !== undefined);
      asked.push(vol);
      return byVolume[vol] ?? null;
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
  const v1 = volumes[1];
  assert(v1?.disk);
  expect(v1.disk.availableMb).toBe(1536 * 1024);
});

test('an STIM_HOME on another volume is reported even when the project is on the boot volume', () => {
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = '/Volumes/StateSSD/Stim';
  try {
    const asked = dfExecutor({
      '/': dfOutput({ totalKb: 926 * 1024 * 1024, availableKb: 38 * 1024 * 1024 }),
      '/Volumes/StateSSD': dfOutput({ totalKb: 2048 * 1024 * 1024, availableKb: 1536 * 1024 * 1024 }),
    });
    const volumes = readVolumes('/Users/someone/code/app');
    expect(asked).toEqual(['/', '/Volumes/StateSSD']);
    expect(volumes.map((v) => v.volume)).toEqual(['/', '/Volumes/StateSSD']);
  } finally {
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
  }
});

test('a volume df cannot answer for is dropped, not reported as empty', async () => {
  dfExecutor({ '/': dfOutput({ totalKb: 926 * 1024 * 1024, availableKb: 38 * 1024 * 1024 }) });
  const volumes = readVolumes('/Volumes/Unplugged/app');
  expect(volumes.map((v) => v.volume)).toEqual(['/']);
});

function writeLease({
  platform = 'ios',
  id,
  holder,
  expiresInMs,
  body = null,
}: {
  platform?: string;
  id: string;
  holder?: string;
  expiresInMs?: number;
  body?: string | null;
}) {
  mkdirSync(deviceLocksDir(), { recursive: true });
  writeFileSync(
    deviceLeasePath(platform, id),
    body ??
      JSON.stringify({
        version: 1,
        platform,
        id,
        deviceName: 'Old iPhone',
        holder,
        token: `token-${id}`,
        grantedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + (expiresInMs ?? 60_000)).toISOString(),
      }),
  );
}

describe('the device lease section', () => {
  test('lists every lease file, whose it is and whether it expired', async () => {
    saveConfig(makeConfig({ version: 2, projects: {} }));
    const mine = findProjectRoot(process.cwd());
    assert(mine);
    writeLease({ id: 'UDID-MINE', holder: mine, expiresInMs: 60_000 });
    writeLease({ platform: 'android', id: 'R5CT', holder: '/gone/workspace', expiresInMs: -5000 });

    const logs = await runStatus();
    const text = logs.join('\n');
    expect(text).toMatch(/Device leases \(2\)/);
    expect(text).toMatch(/ios UDID-MINE \(Old iPhone\)[^\n]*\[this workspace\]/);
    expect(text).toMatch(/android R5CT[^\n]*\/gone\/workspace expired at/);

    const payload = await runStatusJson();
    expect(payload.deviceLeases).toHaveLength(2);
    const [android, ios] = payload.deviceLeases;
    expect(ios).toMatchObject({ platform: 'ios', id: 'UDID-MINE', holder: mine, mine: true, expired: false });
    expect(android).toMatchObject({
      platform: 'android',
      id: 'R5CT',
      holder: '/gone/workspace',
      mine: false,
      expired: true,
    });
    expect(typeof ios.expiresAt).toBe('string');
  });

  test('an unreadable lease file still shows, so nothing looks free that is not', async () => {
    saveConfig(makeConfig({ version: 2, projects: {} }));
    writeLease({ id: 'UDID-BROKEN', body: '{ not a lease' });

    const logs = await runStatus();
    expect(logs.join('\n')).toMatch(/unreadable lease file/);
    const payload = await runStatusJson();
    expect(payload.deviceLeases[0]).toMatchObject({ parsed: false, holder: null, mine: false, expired: false });
  });
});
