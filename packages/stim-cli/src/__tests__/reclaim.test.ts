import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { upsertProject, setDevice, getProject } from '../config.ts';
import { describeDereferenced, reclaimProject } from '../reclaim.ts';
import { endRecordedSession } from '../engine/device-remote.ts';
import { ensureWorkspaceStorage, workspaceStateFile } from '../paths.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  resetExecutor();
});

test('describeDereferenced lists ios and android device records', () => {
  const devices = describeDereferenced({
    platforms: { ios: { deviceUdid: 'U1' }, android: { avdName: 'Pixel_6' } },
  });
  expect(devices).toEqual(['ios sim U1', 'android avd Pixel_6']);
});

test('describeDereferenced reports a physical android device when there is no avd', () => {
  expect(describeDereferenced({ platforms: { android: { serial: 'R5CT' } } })).toEqual(['android device R5CT']);
});

test('describeDereferenced returns an empty list when nothing is claimed', () => {
  expect(describeDereferenced({ platforms: {} })).toEqual([]);
  expect(describeDereferenced({})).toEqual([]);
});

test('reclaimProject removes the config entry', async () => {
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1' });

  const result = await reclaimProject('/proj', { deleteOwnedDevices: false });
  expect(result.path).toBe('/proj');
  expect(result.dereferenced).toEqual(['ios sim U1']);
  expect(getProject('/proj')).toBe(null);
});

test('reclaimProject scans and sizes no build output at all', async () => {
  const calls: string[] = [];
  setExecutor({
    run: (cmd) => {
      calls.push(cmd);
      return '';
    },
    runQuiet: (cmd) => {
      calls.push(cmd);
      return null;
    },
    spawn: () => {},
  });
  upsertProject('/proj', { metroPort: 8082 });

  await reclaimProject('/proj');
  expect(calls.some((c) => c.startsWith('du -sk'))).toBe(false);
  expect(calls.some((c) => c.startsWith('plutil'))).toBe(false);
});

test('reclaimProject keeps the config entry when an owned device delete fails', async () => {
  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
        { udid: 'U1', name: 'stim-proj', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('simctl list devices --json')) return listJson;
      if (cmd.includes('simctl delete')) throw new Error('Unable to delete device');
      return '';
    },
    runQuiet: (cmd) => (cmd.includes('simctl list devices --json') ? listJson : null),
    spawn: () => {},
  });
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1', owned: true });

  const result = await reclaimProject('/proj', { deleteOwnedDevices: true });
  expect(result.keptEntry).toBe(true);
  expect(result.deletedDevices.length).toBe(0);
  expect(result.failedDevices[0]?.reason).toMatch(/Unable to delete device/);
  expect(getProject('/proj')).toBeTruthy();
});

test('reclaimProject removes the entry when the owned device really is deleted', async () => {
  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
        { udid: 'U1', name: 'stim-proj', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  setExecutor({
    run: (cmd) => (cmd.includes('simctl list devices --json') ? listJson : ''),
    runQuiet: (cmd) => (cmd.includes('simctl list devices --json') ? listJson : null),
    spawn: () => {},
  });
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1', owned: true });

  const result = await reclaimProject('/proj', { deleteOwnedDevices: true });
  expect(result.keptEntry).toBe(false);
  expect(result.deletedDevices).toEqual(['U1']);
  expect(getProject('/proj')).toBe(null);
});

test('reclaimProject refuses to kill an unidentified process on the port', async () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => (cmd.includes('-sTCP:LISTEN') ? '4242' : ''),
    spawn: () => {},
  });
  upsertProject('/nonexistent/project', { metroPort: 8082 });

  const result = await reclaimProject('/nonexistent/project', { deleteOwnedDevices: false });
  expect(result.killedPid).toBe(null);
  expect(result.skippedMetro).toBeTruthy();
  resetExecutor();
});

function workspaceWithSession(sessionId: string): string {
  const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  ensureWorkspaceStorage(root);
  writeFileSync(workspaceStateFile(root), JSON.stringify({ remoteDevice: { platform: 'ios', sessionId } }));
  upsertProject(root, { label: 'agent-1' });
  return root;
}

test('reclaim ends the remote session recorded for the workspace', async () => {
  const root = workspaceWithSession('drs_42');
  const stopped: string[] = [];
  const r = await reclaimProject(root, {
    stopSession: (_root, id) => {
      stopped.push(id);
      return { status: 'torn-down' };
    },
  });
  expect(stopped).toEqual(['drs_42']);
  expect(r.stoppedSession).toBe('drs_42');
  rmSync(root, { recursive: true, force: true });
});

test('the session is ended even without deleteOwnedDevices', async () => {
  const root = workspaceWithSession('drs_7');
  let called = false;
  await reclaimProject(root, {
    deleteOwnedDevices: false,
    stopSession: () => {
      called = true;
      return { status: 'torn-down' };
    },
  });
  expect(called).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test('a session that could not be stopped keeps the entry and names the manual fix', async () => {
  const root = workspaceWithSession('drs_99');
  const r = await reclaimProject(root, {
    stopSession: () => ({ status: 'failed', reason: 'offline' }),
  });
  expect(r.stoppedSession).toBeNull();
  expect(r.keptEntry).toBe(true);
  expect(getProject(root)).toBeTruthy();
  const reported = r.failedDevices[0]?.reason ?? '';
  expect(reported).toContain('eas simulator:stop --id drs_99');
  expect(reported).toContain('billing');
  rmSync(root, { recursive: true, force: true });
});

test('a stopped session with an unreconciled claim keeps the workspace retry handle', async () => {
  const root = workspaceWithSession('drs_43');
  const result = await reclaimProject(root, {
    stopSession: () => ({
      status: 'torn-down',
      reason: 'The ownership claim could not be removed. Re-run cleanup to reconcile it.',
    }),
  });

  expect(result.stoppedSession).toBe('drs_43');
  expect(result.keptEntry).toBe(true);
  expect(result.failedDevices[0]?.reason).toMatch(/session is stopped/i);
  expect(result.failedDevices[0]?.reason).toMatch(/ownership claim.*could not be removed/i);
  expect(getProject(root)).toBeTruthy();
  expect(JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8')).remoteDevice.sessionId).toBe('drs_43');
  rmSync(root, { recursive: true, force: true });
});

test('a throwing stop is contained, so the caller still removes the tree', async () => {
  const root = workspaceWithSession('drs_5');
  const r = await reclaimProject(root, {
    stopSession: () => {
      throw new Error('eas exploded');
    },
  });
  expect(r.stoppedSession).toBeNull();
  expect(r.failedDevices[0]?.reason).toContain('eas exploded');
  rmSync(root, { recursive: true, force: true });
});

test('a workspace with no session never reaches for eas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  upsertProject(root, { label: 'agent-1' });
  let called = false;
  const r = await reclaimProject(root, {
    stopSession: () => {
      called = true;
      return { status: 'torn-down' };
    },
  });
  expect(called).toBe(false);
  expect(r.stoppedSession).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

function realStoredSessionStop(sessionOutput: string, calls: string[]) {
  setExecutor({
    runFile: (_file: string, args: string[]) => {
      calls.push(args[0] ?? '');
      if (args[0] === 'simulator:get') return sessionOutput;
      if (args[0] === 'simulator:stop') return JSON.stringify({ id: 'drs_42', status: 'STOPPED' });
      return '';
    },
    run: () => '',
    runQuiet: () => null,
    spawn: () => {},
  });
  return (root: string, sessionId: string) =>
    endRecordedSession({
      root,
      sessionId,
      easBin: '/bin/eas',
      lookupAgentDevice: () => '/bin/agent-device',
      ledgerRoot: tmpHome,
    });
}

test.each([
  ['unowned session', JSON.stringify({ id: 'drs_42', name: 'other-tool', status: 'IN_PROGRESS' })],
  ['unowned terminal session', JSON.stringify({ id: 'drs_42', name: 'other-tool', status: 'STOPPED' })],
  ['unnamed terminal session', JSON.stringify({ id: 'drs_42', status: 'STOPPED' })],
  ['malformed output', 'not json'],
  ['unknown status', JSON.stringify({ id: 'drs_42', name: 'stim-wt', status: 'PAUSED' })],
])('reclaim retains the session record after an unverifiable %s', async (_name, sessionOutput) => {
  const root = workspaceWithSession('drs_42');
  const calls: string[] = [];
  const result = await reclaimProject(root, { stopSession: realStoredSessionStop(sessionOutput, calls) });
  expect(result.keptEntry).toBe(true);
  expect(calls).not.toContain('simulator:stop');
  const state = JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));
  expect(state.remoteDevice.sessionId).toBe('drs_42');
  rmSync(root, { recursive: true, force: true });
});

test('reclaim clears a verified terminal record without issuing stop', async () => {
  const root = workspaceWithSession('drs_42');
  const calls: string[] = [];
  const result = await reclaimProject(root, {
    stopSession: realStoredSessionStop(JSON.stringify({ id: 'drs_42', name: 'stim-wt', status: 'STOPPED' }), calls),
  });
  expect(result.keptEntry).toBe(false);
  expect(calls).not.toContain('simulator:stop');
  expect(existsSync(workspaceStateFile(root))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

function workspaceWithManagedTunnel(pid: number): string {
  const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  ensureWorkspaceStorage(root);
  writeFileSync(
    workspaceStateFile(root),
    JSON.stringify({
      metroTunnel: {
        kind: 'managed',
        provider: 'ngrok',
        pid,
        url: 'https://abc.ngrok.app',
        port: 8082,
        startedAt: 'T',
        processToken: 'linux:100',
      },
    }),
  );
  upsertProject(root, { label: 'agent-1' });
  return root;
}

test('reclaim ends the managed tunnel recorded for the workspace', async () => {
  const root = workspaceWithManagedTunnel(4242);
  const stopped: number[] = [];
  const r = await reclaimProject(root, {
    stopMetroTunnel: async (record) => {
      stopped.push(record.pid);
      return { status: 'stopped' };
    },
  });
  expect(stopped).toEqual([4242]);
  expect(r.stoppedTunnel).toBe('ngrok');
  rmSync(root, { recursive: true, force: true });
});

test('reclaim clears the exact managed tunnel record after a successful stop', async () => {
  const root = workspaceWithManagedTunnel(4242);
  await reclaimProject(root, {
    stopMetroTunnel: async () => ({ status: 'stopped' }),
  });
  expect(existsSync(workspaceStateFile(root))).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

test('reclaim preserves a replacement managed tunnel record', async () => {
  const root = workspaceWithManagedTunnel(4242);
  const replacement = {
    kind: 'managed',
    provider: 'ngrok',
    pid: 4242,
    url: 'https://abc.ngrok.app',
    port: 8082,
    startedAt: 'T',
    processToken: 'linux:200',
  } as const;
  const result = await reclaimProject(root, {
    stopMetroTunnel: async () => {
      writeFileSync(workspaceStateFile(root), JSON.stringify({ metroTunnel: replacement }));
      return { status: 'stopped' };
    },
  });
  const state = JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));
  expect(state.metroTunnel).toEqual(replacement);
  expect(result.keptEntry).toBe(true);
  expect(result.stoppedTunnel).toBeNull();
  expect(result.failedDevices[0]?.reason).toMatch(/replacement.*retained/i);
  rmSync(root, { recursive: true, force: true });
});

test('the tunnel is stopped even without deleteOwnedDevices', async () => {
  const root = workspaceWithManagedTunnel(4242);
  let called = false;
  await reclaimProject(root, {
    deleteOwnedDevices: false,
    stopMetroTunnel: async () => {
      called = true;
      return { status: 'stopped' };
    },
  });
  expect(called).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test('a tunnel that could not be verified keeps the entry and gives a safe retry remedy', async () => {
  const root = workspaceWithManagedTunnel(4242);
  const r = await reclaimProject(root, {
    stopMetroTunnel: async () => ({ status: 'failed', reason: 'pid 4242 did not exit within 5000ms.' }),
  });
  expect(r.stoppedTunnel).toBeNull();
  expect(r.keptEntry).toBe(true);
  expect(getProject(root)).toBeTruthy();
  const reported = r.failedDevices[0]?.reason ?? '';
  expect(reported).toMatch(/identity could not be verified/i);
  expect(reported).toMatch(/inspect.*retry/i);
  expect(reported).not.toMatch(/kill\s+4242/);
  rmSync(root, { recursive: true, force: true });
});

test('a throwing tunnel stop is contained, so the caller still removes the tree', async () => {
  const root = workspaceWithManagedTunnel(4242);
  const r = await reclaimProject(root, {
    stopMetroTunnel: async () => {
      throw new Error('kill exploded');
    },
  });
  expect(r.stoppedTunnel).toBeNull();
  expect(r.failedDevices[0]?.reason).toContain('kill exploded');
  rmSync(root, { recursive: true, force: true });
});

test('a workspace with no recorded tunnel never calls stopMetroTunnel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  upsertProject(root, { label: 'agent-1' });
  let called = false;
  const r = await reclaimProject(root, {
    stopMetroTunnel: async () => {
      called = true;
      return { status: 'stopped' };
    },
  });
  expect(called).toBe(false);
  expect(r.stoppedTunnel).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test('an Expo-hosted tunnel has no process of its own -- reclaim never calls stopMetroTunnel for it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  ensureWorkspaceStorage(root);
  writeFileSync(
    workspaceStateFile(root),
    JSON.stringify({ metroTunnel: { kind: 'expo', url: 'exp://abc123.exp.direct' } }),
  );
  upsertProject(root, { label: 'agent-1' });
  let called = false;
  const r = await reclaimProject(root, {
    stopMetroTunnel: async () => {
      called = true;
      return { status: 'stopped' };
    },
  });
  expect(called).toBe(false);
  expect(r.stoppedTunnel).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test('an operator-supplied tunnel (metro.publicUrl) is never recorded, so reclaim never touches it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  upsertProject(root, { label: 'agent-1' });
  let called = false;
  const r = await reclaimProject(root, {
    stopMetroTunnel: async () => {
      called = true;
      return { status: 'stopped' };
    },
  });
  expect(called).toBe(false);
  expect(r.stoppedTunnel).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

function workspaceWithCollector(pid: number, platform = 'ios'): string {
  const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  ensureWorkspaceStorage(root);
  writeFileSync(
    workspaceStateFile(root),
    JSON.stringify({ collectors: { [platform]: { pid, startedAt: '2026-01-01T00:00:00.000Z' } } }),
  );
  upsertProject(root, { label: 'agent-1' });
  return root;
}

function processCommand(pid: number): string {
  try {
    return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

async function spawnFakeProcess(title: string | null): Promise<ChildProcess> {
  const rename = title ? `process.title = ${JSON.stringify(title)};` : '';
  const child = spawn(process.execPath, ['-e', `${rename} setInterval(() => {}, 1000);`], { stdio: 'ignore' });
  const expected = title ?? process.execPath;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !processCommand(child.pid as number).startsWith(expected)) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return child;
}

function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exits(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test('reclaim SIGTERMs a live pid whose command proves it is this workspace collector', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  const child = await spawnFakeProcess(`stim-collector-ios --root ${root}`);
  ensureWorkspaceStorage(root);
  writeFileSync(
    workspaceStateFile(root),
    JSON.stringify({ collectors: { ios: { pid: child.pid, startedAt: '2026-01-01T00:00:00.000Z' } } }),
  );
  upsertProject(root, { label: 'agent-1' });

  const died = exits(child);
  const r = await reclaimProject(root);
  expect(await died).toBe(true);
  expect(r.skippedDevices).toEqual([]);
  rmSync(root, { recursive: true, force: true });
}, 20_000);

test('reclaim leaves a live pid it cannot prove running, says so, and -- since it started after the recorded startedAt -- drops the now-stale record', async () => {
  const child = await spawnFakeProcess(null);
  // workspaceWithCollector's startedAt (2026-01-01) predates this real process, which just
  // started: the live pid is a newer, unrelated process that recycled the number.
  const root = workspaceWithCollector(child.pid as number);

  const r = await reclaimProject(root);
  expect(stillRunning(child.pid as number)).toBe(true);
  expect(r.skippedDevices).toEqual([
    {
      platform: 'ios',
      name: `ios log collector (pid ${child.pid})`,
      reason: expect.stringContaining("does not run this workspace's ios log collector"),
    },
  ]);
  expect(r.skippedDevices[0]?.reason).toMatch(/not signalled/);
  expect(r.failedDevices).toEqual([]);
  expect(r.keptEntry).toBe(false);
  expect(getProject(root)).toBe(null);
  child.kill('SIGKILL');
  await exits(child);
  rmSync(root, { recursive: true, force: true });
}, 20_000);

test('reclaim leaves a collector recorded for another root alone and, since it started after the recorded startedAt, drops the record', async () => {
  const other = mkdtempSync(join(tmpdir(), 'stim-other-'));
  const child = await spawnFakeProcess(`stim-collector-ios --root ${other}`);
  const root = workspaceWithCollector(child.pid as number);

  const r = await reclaimProject(root);
  expect(stillRunning(child.pid as number)).toBe(true);
  expect(r.skippedDevices.map((d) => d.name)).toEqual([`ios log collector (pid ${child.pid})`]);
  expect(r.keptEntry).toBe(false);
  expect(getProject(root)).toBe(null);
  child.kill('SIGKILL');
  await exits(child);
  rmSync(other, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}, 20_000);

test('reclaim says nothing about a collector pid that is already gone', async () => {
  const child = await spawnFakeProcess(null);
  const pid = child.pid as number;
  child.kill('SIGKILL');
  await exits(child);
  const root = workspaceWithCollector(pid);

  const r = await reclaimProject(root);
  expect(r.skippedDevices).toEqual([]);
  expect(r.keptEntry).toBe(false);
  expect(getProject(root)).toBe(null);
  rmSync(root, { recursive: true, force: true });
}, 20_000);

test("reclaim keeps the record and routes it to failedDevices when a live, unverified pid started at or before the record's startedAt -- it may still be ours", async () => {
  const child = await spawnFakeProcess(null);
  const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
  ensureWorkspaceStorage(root);
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(
    workspaceStateFile(root),
    JSON.stringify({ collectors: { ios: { pid: child.pid, startedAt: future } } }),
  );
  upsertProject(root, { label: 'agent-1' });

  const r = await reclaimProject(root);
  expect(stillRunning(child.pid as number)).toBe(true);
  expect(r.failedDevices.map((d) => d.name)).toEqual([`ios log collector (pid ${child.pid})`]);
  expect(r.failedDevices[0]?.reason).toMatch(/not signalled/);
  expect(r.keptEntry).toBe(true);
  expect(getProject(root)).toBeTruthy();
  child.kill('SIGKILL');
  await exits(child);
  rmSync(root, { recursive: true, force: true });
}, 20_000);

describe('the unverified-collector start-time split (mocked verify and start time, real pid for liveness)', () => {
  test('recycled: the live process started after the record -- drop the record, as today', async () => {
    const child = await spawnFakeProcess(null);
    const root = workspaceWithCollector(child.pid as number); // startedAt: 2026-01-01T00:00:00.000Z
    const r = await reclaimProject(root, {
      verifyCollector: () => ({ status: 'unverified', reason: 'stubbed' }),
      readCollectorStartTime: () => new Date(),
    });
    expect(r.keptEntry).toBe(false);
    expect(r.failedDevices).toEqual([]);
    expect(r.skippedDevices.length).toBe(1);
    expect(getProject(root)).toBe(null);
    child.kill('SIGKILL');
    await exits(child);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test('possibly ours: the live process started before the record -- keep it for retry', async () => {
    const child = await spawnFakeProcess(null);
    const root = workspaceWithCollector(child.pid as number); // startedAt: 2026-01-01T00:00:00.000Z
    const r = await reclaimProject(root, {
      verifyCollector: () => ({ status: 'unverified', reason: 'stubbed' }),
      readCollectorStartTime: () => new Date('2025-01-01T00:00:00.000Z'),
    });
    expect(r.keptEntry).toBe(true);
    expect(r.failedDevices.length).toBe(1);
    expect(r.failedDevices[0]?.reason).toMatch(/not signalled/);
    expect(getProject(root)).toBeTruthy();
    child.kill('SIGKILL');
    await exits(child);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test("possibly ours: the live process started at exactly the record's startedAt -- keep it (boundary is inclusive)", async () => {
    const child = await spawnFakeProcess(null);
    const root = workspaceWithCollector(child.pid as number);
    const r = await reclaimProject(root, {
      verifyCollector: () => ({ status: 'unverified', reason: 'stubbed' }),
      readCollectorStartTime: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(r.keptEntry).toBe(true);
    child.kill('SIGKILL');
    await exits(child);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test('a record with no startedAt at all fails closed to keep', async () => {
    const child = await spawnFakeProcess(null);
    const root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
    ensureWorkspaceStorage(root);
    writeFileSync(workspaceStateFile(root), JSON.stringify({ collectors: { ios: { pid: child.pid } } }));
    upsertProject(root, { label: 'agent-1' });
    const r = await reclaimProject(root, {
      verifyCollector: () => ({ status: 'unverified', reason: 'stubbed' }),
      readCollectorStartTime: () => new Date(),
    });
    expect(r.keptEntry).toBe(true);
    child.kill('SIGKILL');
    await exits(child);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test('an unreadable live start time fails closed to keep, even against a stale-looking record', async () => {
    const child = await spawnFakeProcess(null);
    const root = workspaceWithCollector(child.pid as number);
    const r = await reclaimProject(root, {
      verifyCollector: () => ({ status: 'unverified', reason: 'stubbed' }),
      readCollectorStartTime: () => null,
    });
    expect(r.keptEntry).toBe(true);
    child.kill('SIGKILL');
    await exits(child);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test('gone never consults the start time and never signals', async () => {
    const child = await spawnFakeProcess(null);
    const root = workspaceWithCollector(child.pid as number);
    let readStartTimeCalls = 0;
    const r = await reclaimProject(root, {
      verifyCollector: () => ({ status: 'gone' }),
      readCollectorStartTime: () => {
        readStartTimeCalls += 1;
        return new Date();
      },
    });
    expect(r.skippedDevices).toEqual([]);
    expect(r.failedDevices).toEqual([]);
    expect(readStartTimeCalls).toBe(0);
    expect(stillRunning(child.pid as number)).toBe(true);
    child.kill('SIGKILL');
    await exits(child);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  test('ours signals the pid without consulting the start time', async () => {
    const child = await spawnFakeProcess(null);
    const root = workspaceWithCollector(child.pid as number);
    let readStartTimeCalls = 0;
    const died = exits(child);
    const r = await reclaimProject(root, {
      verifyCollector: () => ({ status: 'ours' }),
      readCollectorStartTime: () => {
        readStartTimeCalls += 1;
        return new Date();
      },
    });
    expect(await died).toBe(true);
    expect(readStartTimeCalls).toBe(0);
    expect(r.skippedDevices).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  }, 20_000);
});
