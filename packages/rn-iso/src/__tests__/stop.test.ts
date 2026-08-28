import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveConfig, getProject } from '../config.ts';
import { ensureWorkspaceStorage, supervisorPidFile, workspaceStateFile } from '../paths.ts';
import {
  clearCollectorState,
  clearSupervisorState,
  readCollectorState,
  readSupervisorState,
  resolveCollectorTargets,
  resolveSupervisorTarget,
  runStop,
} from '../commands/stop.ts';
import { makeConfig, makeError, makeMetroResolution } from './_factories.ts';

test('no supervisor recorded anywhere is "none", not an error', () => {
  const r = resolveSupervisorTarget({ state: null, record: null, reservedPort: 8083, isAlive: () => true });
  expect(r.status).toBe('none');
});

test('an alive pid whose recorded port matches the reservation is ours to signal', () => {
  const r = resolveSupervisorTarget({
    state: { pid: 4242, port: 8083, mode: 'bare-inproc', startedAt: '111' },
    record: { pid: 4242, port: 8083 },
    reservedPort: 8083,
    isAlive: (pid: number) => pid === 4242,
  });
  expect(r.status).toBe('ours');
  expect(r.pid).toBe(4242);
  expect(r.port).toBe(8083);
  expect(r.mode).toBe('bare-inproc');
});

test('a recorded pid that is not running is already stopped, not a failure', () => {
  const r = resolveSupervisorTarget({
    state: { pid: 4242, port: 8083 },
    record: { pid: 4242, port: 8083 },
    reservedPort: 8083,
    isAlive: () => false,
  });
  expect(r.status).toBe('stale');
  expect(r.pid).toBe(4242);
});

test('a live pid whose recorded port is not this project reservation is refused', () => {
  const r = resolveSupervisorTarget({
    state: { pid: 4242, port: 8099 },
    record: { pid: 4242, port: 8099 },
    reservedPort: 8083,
    isAlive: () => true,
  });
  expect(r.status).toBe('unverified');
  expect(r.reason).toMatch(/8099/);
  expect(r.reason).toMatch(/8083/);
});

test('state.json and the global registry disagreeing on the pid is refused', () => {
  const r = resolveSupervisorTarget({
    state: { pid: 4242, port: 8083 },
    record: { pid: 777, port: 8083 },
    reservedPort: 8083,
    isAlive: () => true,
  });
  expect(r.status).toBe('unverified');
  expect(r.reason).toMatch(/4242/);
  expect(r.reason).toMatch(/777/);
});

test('a registry record with no state.json is still actionable when the port matches', () => {
  const r = resolveSupervisorTarget({
    state: null,
    record: { pid: 4242, port: 8083, startedAt: '5' },
    reservedPort: 8083,
    isAlive: () => true,
  });
  expect(r.status).toBe('ours');
  expect(r.pid).toBe(4242);
});

test('no reservation left falls back to the in-workspace record', () => {
  const r = resolveSupervisorTarget({
    state: { pid: 4242, port: 8083 },
    record: null,
    reservedPort: null,
    isAlive: () => true,
  });
  expect(r.status).toBe('ours');
});

type TeardownCall =
  | { udid: string; opts: { del?: boolean; label?: string } }
  | { avd: string; opts: { del?: boolean } };

function seams(over = {}) {
  const calls: {
    signals: (number | null | undefined)[];
    teardowns: TeardownCall[];
    freed: { root: string; port: number }[];
    cleared: number;
    stateCleared: number;
    killedMetro: (number | null | undefined)[];
    collectorSignals: number[];
    collectorsCleared: number;
  } = {
    signals: [],
    teardowns: [],
    freed: [],
    cleared: 0,
    stateCleared: 0,
    killedMetro: [],
    collectorSignals: [],
    collectorsCleared: 0,
  };
  const base = {
    root: '/proj/a',
    project: { metroPort: 8083, platforms: {} },
    state: null,
    collectors: {},
    signalCollector: (pid: number) => {
      calls.collectorSignals.push(pid);
    },
    clearCollectors: () => {
      calls.collectorsCleared += 1;
    },
    isAlive: () => false,
    killGroup: (pid: number | null | undefined) => {
      calls.signals.push(pid);
      return true;
    },
    waitForDeath: async () => true,
    resolveMetro: async () => makeMetroResolution.missing(),
    killMetro: (leader: number | null | undefined) => {
      calls.killedMetro.push(leader);
      return true;
    },
    findListener: () => null,
    teardownIos: (udid: string, opts: { del?: boolean; label?: string }) => {
      calls.teardowns.push({ udid, opts });
      return { status: 'torn-down', label: 'rn-iso-a' };
    },
    teardownAvd: (name: string, opts: { del?: boolean }) => {
      calls.teardowns.push({ avd: name, opts });
      return { status: 'torn-down', label: name };
    },
    freePort: (root: string, port: number) => {
      calls.freed.push({ root, port });
    },
    clearRegistration: async () => {
      calls.cleared += 1;
    },
    clearState: () => {
      calls.stateCleared += 1;
    },
    report: () => {},
  };
  return { calls, opts: { ...base, ...over } };
}

test('nothing running anywhere is a clean success', async () => {
  const { calls, opts } = seams();
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  expect(r.outcomes.supervisor.status).toBe('none');
  expect(r.outcomes.metro.status).toBe('missing');
  expect(r.outcomes.device.ios).toBe(null);
  expect(r.outcomes.port.status).toBe('freed');
  expect(r.outcomes.collectors.status).toBe('none');
  expect(calls.signals).toEqual([]);
  expect(calls.collectorSignals).toEqual([]);
});

test('a live supervisor is SIGTERMed as a group and its Metro is left to it', async () => {
  const { calls, opts } = seams({
    state: { pid: 4242, port: 8083, mode: 'expo-child' },
    isAlive: (pid: number) => pid === 4242,
    resolveMetro: async () => {
      throw new Error('the metro fallback must not run for a live supervisor');
    },
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  expect(r.outcomes.supervisor.status).toBe('stopped');
  expect(r.outcomes.supervisor.pid).toBe(4242);
  expect(calls.signals).toEqual([4242]);
  expect(r.outcomes.metro.status).toBe('skipped');
  expect(calls.cleared).toBe(1);
  expect(calls.stateCleared).toBe(1);
});

test('a supervisor that outlives the wait is reported, never SIGKILLed', async () => {
  const { calls, opts } = seams({
    state: { pid: 4242, port: 8083 },
    isAlive: (pid: number) => pid === 4242,
    waitForDeath: async () => false,
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(false);
  expect(r.outcomes.supervisor.status).toBe('timeout');
  expect(calls.signals).toEqual([4242]);
  expect(r.outcomes.port.status).toBe('kept');
  expect(calls.cleared).toBe(0);
  expect(calls.stateCleared).toBe(0);
});

test('a stale supervisor record is a success with a note, and the rest still runs', async () => {
  const { calls, opts } = seams({
    state: { pid: 4242, port: 8083 },
    isAlive: () => false,
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  expect(r.outcomes.supervisor.status).toBe('already-stopped');
  const ios = r.outcomes.device.ios;
  assert(ios);
  expect(ios.status).toBe('shut-down');
  expect(r.outcomes.port.status).toBe('freed');
  expect(calls.stateCleared).toBe(1);
});

test('an unverified supervisor record is refused without signalling anything', async () => {
  const { calls, opts } = seams({
    state: { pid: 4242, port: 8099 },
    isAlive: () => true,
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(false);
  expect(r.outcomes.supervisor.status).toBe('unverified');
  expect(calls.signals).toEqual([]);
  expect(calls.freed.length).toBe(0);
});

test('no supervisor but our own Metro on the port kills the group', async () => {
  const { calls, opts } = seams({
    resolveMetro: async () => makeMetroResolution.identified({ metro: { pid: 90, leader: 88, cwd: '/proj/a' } }),
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  expect(r.outcomes.metro.status).toBe('stopped');
  expect(r.outcomes.metro.pid).toBe(90);
  expect(calls.killedMetro).toEqual([88]);
});

test('an unproven listener is refused and named, and --force overrides it', async () => {
  const { opts } = seams({
    resolveMetro: async () => makeMetroResolution.notOurs({ notOurs: 'pid 99 runs from /elsewhere' }),
  });
  const refused = await runStop(opts);
  expect(refused.ok).toBe(false);
  expect(refused.outcomes.metro.status).toBe('refused');
  expect(refused.outcomes.metro.reason).toMatch(/elsewhere/);
  expect(refused.outcomes.port.status).toBe('kept');

  const forced = seams({
    resolveMetro: async () => makeMetroResolution.notOurs({ notOurs: 'pid 99 runs from /elsewhere' }),
    findListener: () => 99,
    force: true,
  });
  const r = await runStop(forced.opts);
  expect(r.ok).toBe(true);
  expect(r.outcomes.metro.status).toBe('forced');
  expect(forced.calls.killedMetro).toEqual([99]);
});

test('--force with nothing listening still reports missing', async () => {
  const { calls, opts } = seams({ force: true });
  const r = await runStop(opts);
  expect(r.outcomes.metro.status).toBe('missing');
  expect(calls.killedMetro).toEqual([]);
});

test('owned devices are shut down with del:false, never deleted', async () => {
  const { calls, opts } = seams({
    project: {
      metroPort: 8083,
      platforms: {
        ios: { deviceUdid: 'U1', owned: true },
        android: { avdName: 'rn-iso-a', owned: true },
      },
    },
  });
  const r = await runStop(opts);
  const ios = r.outcomes.device.ios;
  const android = r.outcomes.device.android;
  assert(ios);
  assert(android);
  expect(ios.status).toBe('shut-down');
  expect(android.status).toBe('shut-down');
  for (const c of calls.teardowns) expect(c.opts.del).toBe(false);
});

test('a device rn-iso does not own is left alone', async () => {
  const { calls, opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: false } } },
  });
  const r = await runStop(opts);
  const ios = r.outcomes.device.ios;
  assert(ios);
  expect(ios.status).toBe('skipped');
  expect(ios.kind).toBe('not-owned');
  expect(calls.teardowns).toEqual([]);
});

test('an occupied sim is reported as skipped and does not fail the run', async () => {
  const { opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    teardownIos: () => ({ status: 'skipped', kind: 'occupied', reason: 'in use by another process (occupied)' }),
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  const ios = r.outcomes.device.ios;
  assert(ios);
  expect(ios.status).toBe('skipped');
  expect(ios.kind).toBe('occupied');
});

test('a failed device teardown fails the run and says why', async () => {
  const { opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    teardownIos: () => ({ status: 'failed', reason: 'simctl exploded' }),
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(false);
  const ios = r.outcomes.device.ios;
  assert(ios);
  expect(ios.reason).toMatch(/simctl exploded/);
});

test('a project with no reserved port has nothing to free', async () => {
  const { calls, opts } = seams({ project: { platforms: {} } });
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  expect(r.outcomes.metro.status).toBe('none');
  expect(r.outcomes.port.status).toBe('none');
  expect(calls.freed).toEqual([]);
});

let tmpHome: string;
let tmpRoot: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  tmpRoot = mkdtempSync(join(tmpdir(), 'rn-iso-proj-'));
  ensureWorkspaceStorage(tmpRoot);
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('readSupervisorState reads the supervisor block, and tolerates corruption', () => {
  expect(readSupervisorState(tmpRoot)).toBe(null);
  writeFileSync(workspaceStateFile(tmpRoot), '{ not json');
  expect(readSupervisorState(tmpRoot)).toBe(null);
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ supervisor: { pid: 7, port: 8083 } }));
  expect(readSupervisorState(tmpRoot)).toEqual({ pid: 7, port: 8083 });
});

test('clearSupervisorState drops the supervisor key and keeps the rest of state.json', () => {
  writeFileSync(supervisorPidFile(tmpRoot), '7');
  writeFileSync(
    workspaceStateFile(tmpRoot),
    JSON.stringify({ supervisor: { pid: 7 }, lastBuild: { fingerprint: 'abc' } }),
  );

  clearSupervisorState(tmpRoot);

  expect(existsSync(supervisorPidFile(tmpRoot))).toBe(false);
  const left = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(left).toEqual({ lastBuild: { fingerprint: 'abc' } });
});

test('clearSupervisorState removes a state file that held only the supervisor', () => {
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ supervisor: { pid: 7 } }));
  clearSupervisorState(tmpRoot);
  expect(existsSync(workspaceStateFile(tmpRoot))).toBe(false);
});

test('stopping frees the reserved port in the registry and keeps the device record', async () => {
  saveConfig(
    makeConfig({
      projects: {
        [tmpRoot]: {
          label: 'agent-1',
          metroPort: 8083,
          platforms: { ios: { deviceUdid: 'U1', owned: true } },
        },
      },
    }),
  );
  writeFileSync(supervisorPidFile(tmpRoot), '4242');
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ supervisor: { pid: 4242, port: 8083 } }));

  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    teardownIos: () => ({ status: 'torn-down', label: 'rn-iso-a' }),
    clearRegistration: async () => {},
    report: () => {},
  });

  expect(r.ok).toBe(true);
  const after = getProject(tmpRoot);
  assert(after);
  assert(after.platforms);
  expect(after.metroPort).toBe(null);
  expect(after.platforms.ios).toEqual({ deviceUdid: 'U1', owned: true });
  expect(existsSync(workspaceStateFile(tmpRoot))).toBe(false);
  expect(existsSync(supervisorPidFile(tmpRoot))).toBe(false);
});

test('stopping clears the global supervisor registration', async () => {
  saveConfig(
    makeConfig({
      projects: {
        [tmpRoot]: {
          label: 'agent-1',
          metroPort: 8083,
          supervisor: { pid: 4242, port: 8083, startedAt: '5' },
          platforms: {},
        },
      },
    }),
  );

  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    report: () => {},
  });

  expect(r.ok).toBe(true);
  expect(r.outcomes.supervisor.status).toBe('already-stopped');
  const proj = getProject(tmpRoot);
  assert(proj);
  expect(proj.supervisor).toBe(undefined);
});

test('resolveCollectorTargets signals only live pids recorded for this workspace', () => {
  const targets = resolveCollectorTargets({
    collectors: { ios: { pid: 111 }, android: { pid: 222 } },
    isAlive: (pid) => pid === 111,
  });
  expect(targets).toEqual([
    { platform: 'ios', pid: 111, status: 'running' },
    { platform: 'android', pid: 222, status: 'stale' },
  ]);
});

test('resolveCollectorTargets refuses a record with no usable pid, and refuses our own', () => {
  const targets = resolveCollectorTargets({
    collectors: { ios: { pid: 'nope' }, android: { pid: process.pid } },
    isAlive: () => true,
  });
  expect(targets.map((t) => t.status)).toEqual(['invalid', 'invalid']);
});

test('stop SIGTERMs every recorded collector and clears the key', async () => {
  const { calls, opts } = seams({
    collectors: { ios: { pid: 111, startedAt: 'a' }, android: { pid: 222, startedAt: 'b' } },
    isAlive: () => true,
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  expect(calls.collectorSignals).toEqual([111, 222]);
  expect(calls.collectorsCleared).toBe(1);
  expect(r.outcomes.collectors.status).toBe('stopped');
  expect(r.outcomes.collectors.entries).toEqual([
    { platform: 'ios', pid: 111, status: 'stopped' },
    { platform: 'android', pid: 222, status: 'stopped' },
  ]);
  expect(r.summary).toMatch(/2 collectors stopped/);
});

test('an already-dead collector is a success, not a failure', async () => {
  const { calls, opts } = seams({
    collectors: { ios: { pid: 111 } },
    isAlive: () => false,
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  expect(calls.collectorSignals).toEqual([]);
  expect(r.outcomes.collectors.entries).toEqual([{ platform: 'ios', pid: 111, status: 'already-stopped' }]);
});

test('a collector that exits between the liveness check and the signal is not an error', async () => {
  const { opts } = seams({
    collectors: { ios: { pid: 111 } },
    isAlive: () => true,
    signalCollector: () => {
      throw makeError('ESRCH', { code: 'ESRCH' });
    },
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  expect(r.outcomes.collectors.entries).toEqual([{ platform: 'ios', pid: 111, status: 'already-stopped' }]);
});

test('collectors are still reaped when the supervisor could not be verified', async () => {
  const { calls, opts } = seams({
    state: { pid: 4242, port: 8099 },
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    collectors: { ios: { pid: 111 } },
    isAlive: () => true,
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(false);
  expect(r.outcomes.supervisor.status).toBe('unverified');
  expect(calls.collectorSignals).toEqual([111]);
  expect(calls.collectorsCleared).toBe(1);
  expect(calls.teardowns).toEqual([]);
});

test('nothing recorded means no clear and no signal', async () => {
  const { calls, opts } = seams({ collectors: {} });
  const r = await runStop(opts);
  expect(r.outcomes.collectors.status).toBe('none');
  expect(calls.collectorsCleared).toBe(0);
});

test('readCollectorState reads the collectors block and tolerates corruption', () => {
  expect(readCollectorState(tmpRoot)).toEqual({});
  writeFileSync(workspaceStateFile(tmpRoot), '{ not json');
  expect(readCollectorState(tmpRoot)).toEqual({});
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ collectors: { ios: { pid: 9 } } }));
  expect(readCollectorState(tmpRoot)).toEqual({ ios: { pid: 9 } });
});

test('clearCollectorState drops only the collectors key', () => {
  writeFileSync(
    workspaceStateFile(tmpRoot),
    JSON.stringify({
      supervisor: { pid: 7 },
      collectors: { ios: { pid: 9 } },
      lastBuild: { fingerprint: 'abc' },
    }),
  );
  clearCollectorState(tmpRoot);
  const left = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(left).toEqual({ supervisor: { pid: 7 }, lastBuild: { fingerprint: 'abc' } });
});

test('an occupied sim names the UI-test runner that decided the skip', async () => {
  const reports: string[] = [];
  const { opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    teardownIos: () => ({
      status: 'skipped',
      kind: 'occupied',
      reason: 'in use by another process (occupied)',
      holders: ['com.example.app.xctrunner'],
    }),
    report: (l: string) => reports.push(String(l)),
  });
  const r = await runStop(opts);
  const ios = r.outcomes.device.ios;
  assert(ios);
  expect(ios.status).toBe('skipped');
  expect(ios.reason).toMatch(/held by UI-test runner com\.example\.app\.xctrunner/);
  expect(reports.join('\n')).toMatch(/com\.example\.app\.xctrunner/);
});

test('an occupied skip with no holder list (fail-closed probe) still gets the generic hint', async () => {
  const { opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    teardownIos: () => ({ status: 'skipped', kind: 'occupied', reason: 'in use by another process (occupied)' }),
  });
  const r = await runStop(opts);
  const ios = r.outcomes.device.ios;
  assert(ios);
  expect(ios.reason).toMatch(/UI-test runner or device tool/);
});

test('a not-owned skip is not given an occupancy hint', async () => {
  const { opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    teardownIos: () => ({ status: 'skipped', kind: 'not-owned', reason: 'sim is now named "other"' }),
  });
  const r = await runStop(opts);
  const ios = r.outcomes.device.ios;
  assert(ios);
  const reason = ios.reason;
  assert(reason);
  expect(!/UI-test runner/.test(reason)).toBeTruthy();
  expect(!/pid 1/.test(reason)).toBeTruthy();
});
