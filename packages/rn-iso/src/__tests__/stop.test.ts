// test/stop.test.js
//
// `stop` is v3's inverse of `start`: halt the supervisor, shut the owned device
// DOWN (never delete), free the port. The parts that decide what may be
// signalled are pure and tested here without a live process; the sequencing is
// tested through runStop with every side effect injected, so nothing in this
// file kills anything, boots anything, or touches a real simulator.

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveConfig, getProject } from '../config.ts';
import { supervisorPidFile, workspaceStateFile } from '../paths.ts';
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
import { resetExecutor, setExecutor } from '../exec.ts';
import { endRecordedSession } from '../engine/device-remote.ts';

// --- resolveSupervisorTarget: who may be signalled --------------------------

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

// The identity rule: a pid is signalled only when it is provably this
// workspace's. A port that does not match the reservation is not proof, and
// killing on it repeats the Android console-port mistake in a new place.
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

// The workspace's state.json can be deleted (or never written) while the global
// registration survives -- that registration is precisely what `status`
// and `worktree remove` use to find a supervisor whose workspace vanished.
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

// A previous interrupted stop can free the port before clearing the
// registration. With no reservation left there is nothing to match against, so
// the in-workspace state file is the proof instead.
test('no reservation left falls back to the in-workspace record', () => {
  const r = resolveSupervisorTarget({
    state: { pid: 4242, port: 8083 },
    record: null,
    reservedPort: null,
    isAlive: () => true,
  });
  expect(r.status).toBe('ours');
});

// --- runStop: the sequence --------------------------------------------------

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

// Escalation is a REPORT, not a SIGKILL: a supervisor that ignores SIGTERM is
// mid-write on the log files, and a second signal is the caller's decision.
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

// With no supervisor, v2's path is unchanged: identity first, kill the group.
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

// --force guards the unproven-listener case only. It must never turn "nothing
// is listening" into a kill attempt.
test('--force with nothing listening still reports missing', async () => {
  const { calls, opts } = seams({ force: true });
  const r = await runStop(opts);
  expect(r.outcomes.metro.status).toBe('missing');
  expect(calls.killedMetro).toEqual([]);
});

// The whole point of v3 stop: the device survives, so returning to the branch
// costs a boot rather than a create, a provision and a reinstall.
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

// An occupied sim is spared, exactly as `shutdown` spares it: the device
// survives this command, so something still attached to it matters.
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

// --- state files and the registry, against a real temp workspace ------------

let tmpHome: string;
let tmpRoot: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  tmpRoot = mkdtempSync(join(tmpdir(), 'rn-iso-proj-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
  resetExecutor();
});

test('readSupervisorState reads the supervisor block, and tolerates corruption', () => {
  expect(readSupervisorState(tmpRoot)).toBe(null);
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
  writeFileSync(workspaceStateFile(tmpRoot), '{ not json');
  expect(readSupervisorState(tmpRoot)).toBe(null);
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ supervisor: { pid: 7, port: 8083 } }));
  expect(readSupervisorState(tmpRoot)).toEqual({ pid: 7, port: 8083 });
});

// Later steps put `lastBuild` beside `supervisor` in the same file, so clearing
// the supervisor must not take the rest of the file with it.
test('clearSupervisorState drops the supervisor key and keeps the rest of state.json', () => {
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
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
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ supervisor: { pid: 7 } }));
  clearSupervisorState(tmpRoot);
  expect(existsSync(workspaceStateFile(tmpRoot))).toBe(false);
});

test('state-key cleanup waits for a concurrent state writer and retains its new session', async () => {
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ supervisor: { pid: 7 } }));
  const script = join(tmpRoot, 'write-session-under-lock.mjs');
  const stateModule = new URL('../supervisor/state.ts', import.meta.url).href;
  writeFileSync(
    script,
    `import { withWorkspaceStateLock, writeWorkspaceState } from ${JSON.stringify(stateModule)};
withWorkspaceStateLock(process.argv[2], () => {
  process.stdout.write('LOCKED\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  writeWorkspaceState(process.argv[2], { remoteDevice: { platform: 'ios', sessionId: 'drs_B' } });
});
`,
  );
  const writer = spawn(process.execPath, ['--experimental-strip-types', script, tmpRoot], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    writer.once('error', reject);
    writer.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('LOCKED')) resolve();
    });
  });

  const startedAt = Date.now();
  clearSupervisorState(tmpRoot);
  const elapsedMs = Date.now() - startedAt;
  await new Promise<void>((resolve, reject) => {
    writer.once('error', reject);
    writer.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`state writer exited ${code}`))));
  });

  expect(elapsedMs).toBeGreaterThanOrEqual(150);
  const state = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(state.supervisor).toBeUndefined();
  expect(state.remoteDevice.sessionId).toBe('drs_B');
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
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
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

// The global registration is what `status` and `worktree remove` use to
// find a supervisor whose workspace is gone, so a stop that leaves one behind
// leaves a permanent ghost.
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

// --- Contract 5: the collectors ---------------------------------------------
//
// A collector is a detached `simctl log stream` / `adb logcat` this workspace
// spawned. Nothing else on the machine can name it once state.json is gone, so
// `stop` reaping it is the only thing standing between a workspace teardown and
// a log stream that outlives the device it was reading.

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

// A dead collector pid is the NORMAL case: the app was killed, the collector
// noticed and exited on its own. It must never make `stop` non-zero.
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

// The device step is skipped while something still holds the port, but the
// collectors are not: they hold nothing contended, and a stuck supervisor is
// exactly the case where a leaked log stream would never be reaped by anything.
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
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
  writeFileSync(workspaceStateFile(tmpRoot), '{ not json');
  expect(readCollectorState(tmpRoot)).toEqual({});
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ collectors: { ios: { pid: 9 } } }));
  expect(readCollectorState(tmpRoot)).toEqual({ ios: { pid: 9 } });
});

// Same rule as clearSupervisorState: `lastBuild` lives in this file, and taking
// the fingerprint away with a collector pid would make the next build a
// guaranteed cache miss.
test('clearCollectorState drops only the collectors key', () => {
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
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

// --- the occupied-sim skip names its holder --------------------------------
//
// "in use by another process (occupied)" told a reader that something is
// holding the sim and nothing about what. The occupancy decider counts only
// foreign .xctrunner bundles, and the teardown outcome carries exactly that
// list -- so the skip names what counted, never the sim's own runtime or the
// app rn-iso itself launched (which a ps-over-the-udid scan used to drag in).

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

// --- the remote session ----------------------------------------------------
//
// A remote session is the ONE device `stop` destroys rather than shuts down.
// Locally that would be wrong (a shut-down sim costs nothing to keep); a
// cloud session bills until its max duration, so leaving one up is worse.

function withRemoteSession(sessionId: string) {
  saveConfig(
    makeConfig({
      projects: { [tmpRoot]: { label: 'agent-1', metroPort: 8083, platforms: {} } },
    }),
  );
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
  writeFileSync(
    workspaceStateFile(tmpRoot),
    JSON.stringify({ remoteDevice: { platform: 'ios', sessionId }, lastBuild: { hash: 'keepme' } }),
  );
}

test('stopping ends the remote session this workspace created', async () => {
  withRemoteSession('drs_42');
  const stopped: string[] = [];
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    teardownRemoteSession: (_root, sessionId) => {
      stopped.push(sessionId);
      return { status: 'torn-down' };
    },
    report: () => {},
  });

  expect(r.ok).toBe(true);
  expect(stopped).toEqual(['drs_42']);
  expect(r.outcomes.device.remote?.status).toBe('torn-down');
});

test('a session that could not be stopped fails the command, so it is not reported as clean', async () => {
  // The failure mode this guards: a session nothing stopped keeps billing,
  // and a green `stop` is how nobody finds out.
  withRemoteSession('drs_99');
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    teardownRemoteSession: () => ({ status: 'failed', reason: 'eas simulator:stop drs_99 failed: offline' }),
    report: () => {},
  });

  expect(r.ok).toBe(false);
  expect(r.outcomes.device.remote?.status).toBe('failed');
  // The record SURVIVES a failed stop, for the same reason a failed local
  // teardown keeps its device record: it is the only handle left to retry.
  const state = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(state.remoteDevice.sessionId).toBe('drs_99');
});

test('a successful stop drops the record but keeps lastBuild', async () => {
  withRemoteSession('drs_7');
  await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    teardownRemoteSession: () => ({ status: 'torn-down' }),
    report: () => {},
  });
  const state = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(state.remoteDevice).toBeUndefined();
  // Taking the fingerprint away would make the next build a guaranteed miss.
  expect(state.lastBuild.hash).toBe('keepme');
});

function verifiedTeardown(sessionOutput: string, calls: string[]) {
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
    endRecordedSession({ root, sessionId, easBin: '/bin/eas', lookupAgentDevice: () => '/bin/agent-device' });
}

test.each([
  ['unowned session', JSON.stringify({ id: 'drs_42', name: 'other-tool', status: 'IN_PROGRESS' })],
  ['unowned terminal session', JSON.stringify({ id: 'drs_42', name: 'other-tool', status: 'STOPPED' })],
  ['unnamed terminal session', JSON.stringify({ id: 'drs_42', status: 'STOPPED' })],
  ['malformed output', 'not json'],
  ['unknown status', JSON.stringify({ id: 'drs_42', name: 'rn-iso-wt', status: 'PAUSED' })],
])('stop retains the session record after an unverifiable %s', async (_name, sessionOutput) => {
  withRemoteSession('drs_42');
  const calls: string[] = [];
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    teardownRemoteSession: verifiedTeardown(sessionOutput, calls),
    report: () => {},
  });
  expect(r.ok).toBe(false);
  expect(calls).not.toContain('simulator:stop');
  const state = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(state.remoteDevice.sessionId).toBe('drs_42');
});

test('stop clears the record for a verified terminal session without issuing stop', async () => {
  withRemoteSession('drs_42');
  const calls: string[] = [];
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    teardownRemoteSession: verifiedTeardown(
      JSON.stringify({ id: 'drs_42', name: 'rn-iso-wt', status: 'STOPPED' }),
      calls,
    ),
    report: () => {},
  });
  expect(r.ok).toBe(true);
  expect(calls).not.toContain('simulator:stop');
  const state = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(state.remoteDevice).toBeUndefined();
});

test('a workspace with no remote session never calls the remote teardown', async () => {
  saveConfig(makeConfig({ projects: { [tmpRoot]: { label: 'agent-1', metroPort: 8083, platforms: {} } } }));
  let called = false;
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    teardownRemoteSession: () => {
      called = true;
      return { status: 'torn-down' };
    },
    report: () => {},
  });
  expect(called).toBe(false);
  expect(r.outcomes.device.remote).toBeUndefined();
});

test('a remote session is stopped even when something still holds the port', async () => {
  // The stillHolding guard spares a LOCAL device from being yanked out from
  // under a supervisor that ignored SIGTERM. A session in a datacenter is not
  // what that supervisor is holding, and it bills by the minute regardless --
  // so leaving it up because something else refused to die is the one outcome
  // that costs money.
  const stopped: string[] = [];
  const r = await runStop({
    root: tmpRoot,
    // A supervisor that will not die is what sets stillHolding.
    isAlive: () => true,
    killGroup: () => false,
    resolveMetro: async () => ({ missing: true }),
    remoteDevice: { platform: 'ios', sessionId: 'drs_42' },
    teardownRemoteSession: (_root: string, id: string) => {
      stopped.push(id);
      return { status: 'torn-down' as const };
    },
    report: () => {},
  });
  expect(stopped).toEqual(['drs_42']);
  expect(r.outcomes.device?.remote?.status).toBe('torn-down');
});

// --- a tunnel `ios`/`android --remote` started for itself -------------------
//
// engine/tunnel.ts's own process (a managed provider), unrelated to the
// supervisor or to any local device -- reaped unconditionally, the same
// reasoning as the remote session above.

function withManagedTunnel() {
  saveConfig(makeConfig({ projects: { [tmpRoot]: { label: 'agent-1', metroPort: 8083, platforms: {} } } }));
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
  writeFileSync(
    workspaceStateFile(tmpRoot),
    JSON.stringify({
      metroTunnel: {
        kind: 'managed',
        provider: 'ngrok',
        pid: 4242,
        url: 'https://abc.ngrok.app',
        port: 8083,
        startedAt: 'T',
        processToken: 'linux:100',
      },
      lastBuild: { hash: 'keepme' },
    }),
  );
}

test('stopping reaps a managed tunnel this workspace started', async () => {
  withManagedTunnel();
  const stopped: unknown[] = [];
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    stopMetroTunnel: async (record) => {
      stopped.push(record);
      return { status: 'stopped' };
    },
    report: () => {},
  });

  expect(r.ok).toBe(true);
  expect(stopped).toEqual([
    {
      kind: 'managed',
      provider: 'ngrok',
      pid: 4242,
      url: 'https://abc.ngrok.app',
      port: 8083,
      startedAt: 'T',
      processToken: 'linux:100',
    },
  ]);
  expect(r.outcomes.metroTunnel).toEqual({ status: 'stopped', provider: 'ngrok', reason: undefined });
  const state = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(state.metroTunnel).toBeUndefined();
  // Taking the fingerprint away would make the next build a guaranteed miss.
  expect(state.lastBuild.hash).toBe('keepme');
});

test('stopping clears only the tunnel record that it verified', async () => {
  withManagedTunnel();
  const replacement = {
    kind: 'managed',
    provider: 'ngrok',
    pid: 4242,
    url: 'https://abc.ngrok.app',
    port: 8083,
    startedAt: 'T',
    processToken: 'linux:200',
  } as const;
  const result = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    stopMetroTunnel: async () => {
      writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ metroTunnel: replacement }));
      return { status: 'stopped' };
    },
    report: () => {},
  });

  const state = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(state.metroTunnel).toEqual(replacement);
  expect(result.ok).toBe(false);
  expect(result.outcomes.port.status).toBe('kept');
  expect(getProject(tmpRoot)?.metroPort).toBe(8083);
});

test('a tunnel that fails to stop fails the command and keeps its record', async () => {
  withManagedTunnel();
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    stopMetroTunnel: async () => ({ status: 'failed', reason: 'pid 4242 did not exit within 5000ms.' }),
    report: () => {},
  });

  expect(r.ok).toBe(false);
  expect(r.outcomes.metroTunnel.status).toBe('failed');
  expect(r.outcomes.port).toEqual({
    status: 'kept',
    port: 8083,
    reason: 'pid 4242 did not exit within 5000ms.',
  });
  expect(getProject(tmpRoot)?.metroPort).toBe(8083);
  const state = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(state.metroTunnel.pid).toBe(4242);
});

test('a workspace with no recorded tunnel never calls stopMetroTunnel', async () => {
  saveConfig(makeConfig({ projects: { [tmpRoot]: { label: 'agent-1', metroPort: 8083, platforms: {} } } }));
  let called = false;
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    stopMetroTunnel: async () => {
      called = true;
      return { status: 'stopped' };
    },
    report: () => {},
  });
  expect(called).toBe(false);
  expect(r.outcomes.metroTunnel.status).toBe('none');
});

test('the tunnel is stopped even when something still holds the port', async () => {
  // Same stillHolding setup as "a supervisor that outlives the wait is
  // reported, never SIGKILLed" above: a recorded supervisor that ignores
  // SIGTERM. The guard that spares a LOCAL device from being yanked out from
  // under it does not apply here -- a tunnel is engine/tunnel.ts's own
  // detached process, independent of the supervisor.
  const stopped: number[] = [];
  const { calls, opts } = seams({
    state: { pid: 4242, port: 8083 },
    isAlive: (pid: number) => pid === 4242,
    waitForDeath: async () => false,
    metroTunnel: {
      kind: 'managed',
      provider: 'cloudflared',
      pid: 999,
      url: 'https://x.trycloudflare.com',
      port: 8083,
      startedAt: 'T',
    },
    stopMetroTunnel: async (record: { pid: number }) => {
      stopped.push(record.pid);
      return { status: 'stopped' };
    },
  });
  const r = await runStop(opts);
  expect(r.outcomes.port.status).toBe('kept');
  expect(calls.stateCleared).toBe(0);
  expect(stopped).toEqual([999]);
  expect(r.outcomes.metroTunnel.status).toBe('stopped');
});

test('an Expo-hosted tunnel has no process of its own -- stopMetroTunnel is never called for it', async () => {
  let called = false;
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    metroTunnel: { kind: 'expo', url: 'exp://abc123.exp.direct' },
    stopMetroTunnel: async () => {
      called = true;
      return { status: 'stopped' };
    },
    report: () => {},
  });
  expect(called).toBe(false);
  expect(r.outcomes.metroTunnel.status).toBe('not-managed');
});

test('an Expo tunnel record is dropped once the port is freed, not left stale for the next run', async () => {
  saveConfig(makeConfig({ projects: { [tmpRoot]: { label: 'agent-1', metroPort: 8083, platforms: {} } } }));
  mkdirSync(join(tmpRoot, '.rn-iso'), { recursive: true });
  writeFileSync(
    workspaceStateFile(tmpRoot),
    JSON.stringify({ metroTunnel: { kind: 'expo', url: 'exp://abc123.exp.direct' } }),
  );
  await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    report: () => {},
  });
  // Nothing else was in the file, so clearing the last key removes it.
  expect(existsSync(workspaceStateFile(tmpRoot))).toBe(false);
});

test('an Expo tunnel record survives while something still holds the port', async () => {
  // The expo child that fronts it is very likely still running -- the same
  // reason the local device shutdown step is skipped in this case. Proven by
  // the bookkeeping step (the only place that drops the record) never
  // running at all: a supervisor that outlives the wait is what sets
  // stillHolding, the same setup as the "outlives the wait" test above.
  const { calls, opts } = seams({
    state: { pid: 4242, port: 8083 },
    isAlive: (pid: number) => pid === 4242,
    waitForDeath: async () => false,
    metroTunnel: { kind: 'expo', url: 'exp://abc123.exp.direct' },
  });
  const r = await runStop(opts);
  expect(r.outcomes.port.status).toBe('kept');
  expect(calls.stateCleared).toBe(0);
  // 'not-managed': there is a recorded tunnel, but no process of its own to
  // stop, and the record was left alone rather than dropped.
  expect(r.outcomes.metroTunnel.status).toBe('not-managed');
});

test('an operator-supplied tunnel (metro.publicUrl) is never recorded, so `stop` never touches it', async () => {
  // rn-iso only reaps what it created (CLAUDE.md item 2's ownership rule,
  // applied to tunnels): an operator's own tunnel is used through
  // metro.publicUrl and is never written to state.json's metroTunnel key,
  // so there is nothing here for `stop` to find, let alone kill.
  saveConfig(makeConfig({ projects: { [tmpRoot]: { label: 'agent-1', metroPort: 8083, platforms: {} } } }));
  let called = false;
  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    clearRegistration: async () => {},
    stopMetroTunnel: async () => {
      called = true;
      return { status: 'stopped' };
    },
    report: () => {},
  });
  expect(called).toBe(false);
  expect(r.outcomes.metroTunnel.status).toBe('none');
});
