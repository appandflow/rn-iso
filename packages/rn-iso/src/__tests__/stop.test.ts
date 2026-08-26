// test/stop.test.js
//
// `stop` is v3's inverse of `start`: halt the supervisor, shut the owned device
// DOWN (never delete), free the port. The parts that decide what may be
// signalled are pure and tested here without a live process; the sequencing is
// tested through runStop with every side effect injected, so nothing in this
// file kills anything, boots anything, or touches a real simulator.

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
  parseSimHolders,
  resolveCollectorTargets,
  resolveSupervisorTarget,
  runStop,
} from '../commands/stop.ts';

// --- resolveSupervisorTarget: who may be signalled --------------------------

test('no supervisor recorded anywhere is "none", not an error', () => {
  const r = resolveSupervisorTarget({ state: null, record: null, reservedPort: 8083, isAlive: () => true });
  expect(r.status).toBe('none');
});

test('an alive pid whose recorded port matches the reservation is ours to signal', () => {
  const r = resolveSupervisorTarget({
    state: { pid: 4242, port: 8083, mode: 'bare-inproc', startedAt: 111 },
    record: { pid: 4242, port: 8083 },
    reservedPort: 8083,
    isAlive: (pid) => pid === 4242,
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
    record: { pid: 4242, port: 8083, startedAt: 5 },
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

function seams(over = {}) {
  const calls = { signals: [], teardowns: [], freed: [], cleared: 0, stateCleared: 0, killedMetro: [], collectorSignals: [], collectorsCleared: 0 };
  const base = {
    root: '/proj/a',
    project: { metroPort: 8083, platforms: {} },
    state: null,
    collectors: {},
    signalCollector: (pid) => { calls.collectorSignals.push(pid); },
    clearCollectors: () => { calls.collectorsCleared += 1; },
    isAlive: () => false,
    killGroup: (pid) => { calls.signals.push(pid); return true; },
    waitForDeath: async () => true,
    resolveMetro: async () => ({ missing: true }),
    killMetro: (leader) => { calls.killedMetro.push(leader); return true; },
    findListener: () => null,
    teardownIos: (udid, opts) => { calls.teardowns.push({ udid, opts }); return { status: 'torn-down', label: 'rn-iso-a' }; },
    teardownAvd: (name, opts) => { calls.teardowns.push({ avd: name, opts }); return { status: 'torn-down', label: name }; },
    freePort: (root, port) => { calls.freed.push({ root, port }); },
    clearRegistration: async () => { calls.cleared += 1; },
    clearState: () => { calls.stateCleared += 1; },
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
    isAlive: (pid) => pid === 4242,
    resolveMetro: async () => { throw new Error('the metro fallback must not run for a live supervisor'); },
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
    isAlive: (pid) => pid === 4242,
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
  expect(r.outcomes.device.ios.status).toBe('shut-down');
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
    resolveMetro: async () => ({ metro: { pid: 90, leader: 88, cwd: '/proj/a' } }),
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(true);
  expect(r.outcomes.metro.status).toBe('stopped');
  expect(r.outcomes.metro.pid).toBe(90);
  expect(calls.killedMetro).toEqual([88]);
});

test('an unproven listener is refused and named, and --force overrides it', async () => {
  const { opts } = seams({ resolveMetro: async () => ({ notOurs: 'pid 99 runs from /elsewhere' }) });
  const refused = await runStop(opts);
  expect(refused.ok).toBe(false);
  expect(refused.outcomes.metro.status).toBe('refused');
  expect(refused.outcomes.metro.reason).toMatch(/elsewhere/);
  expect(refused.outcomes.port.status).toBe('kept');

  const forced = seams({
    resolveMetro: async () => ({ notOurs: 'pid 99 runs from /elsewhere' }),
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
  expect(r.outcomes.device.ios.status).toBe('shut-down');
  expect(r.outcomes.device.android.status).toBe('shut-down');
  for (const c of calls.teardowns) expect(c.opts.del).toBe(false);
});

test('a device rn-iso does not own is left alone', async () => {
  const { calls, opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: false } } },
  });
  const r = await runStop(opts);
  expect(r.outcomes.device.ios.status).toBe('skipped');
  expect(r.outcomes.device.ios.kind).toBe('not-owned');
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
  expect(r.outcomes.device.ios.status).toBe('skipped');
  expect(r.outcomes.device.ios.kind).toBe('occupied');
});

test('a failed device teardown fails the run and says why', async () => {
  const { opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    teardownIos: () => ({ status: 'failed', reason: 'simctl exploded' }),
  });
  const r = await runStop(opts);
  expect(r.ok).toBe(false);
  expect(r.outcomes.device.ios.reason).toMatch(/simctl exploded/);
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

let tmpHome;
let tmpRoot;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
  tmpRoot = mkdtempSync(join(tmpdir(), 'rn-iso-proj-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
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
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({ supervisor: { pid: 7 }, lastBuild: { fingerprint: 'abc' } }));

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

test('stopping frees the reserved port in the registry and keeps the device record', async () => {
  saveConfig({
    version: 2,
    projects: {
      [tmpRoot]: {
        label: 'agent-1',
        metroPort: 8083,
        platforms: { ios: { deviceUdid: 'U1', owned: true } },
      },
    },
  });
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
  expect(after.metroPort).toBe(null);
  expect(after.platforms.ios).toEqual({ deviceUdid: 'U1', owned: true });
  expect(existsSync(workspaceStateFile(tmpRoot))).toBe(false);
  expect(existsSync(supervisorPidFile(tmpRoot))).toBe(false);
});

// The global registration is what `status` and `worktree remove` use to
// find a supervisor whose workspace is gone, so a stop that leaves one behind
// leaves a permanent ghost.
test('stopping clears the global supervisor registration', async () => {
  saveConfig({
    version: 2,
    projects: {
      [tmpRoot]: {
        label: 'agent-1',
        metroPort: 8083,
        supervisor: { pid: 4242, port: 8083, startedAt: 5 },
        platforms: {},
      },
    },
  });

  const r = await runStop({
    root: tmpRoot,
    isAlive: () => false,
    resolveMetro: async () => ({ missing: true }),
    report: () => {},
  });

  expect(r.ok).toBe(true);
  expect(r.outcomes.supervisor.status).toBe('already-stopped');
  expect(getProject(tmpRoot).supervisor).toBe(undefined);
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
    signalCollector: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; },
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
  writeFileSync(workspaceStateFile(tmpRoot), JSON.stringify({
    supervisor: { pid: 7 },
    collectors: { ios: { pid: 9 } },
    lastBuild: { fingerprint: 'abc' },
  }));
  clearCollectorState(tmpRoot);
  const left = JSON.parse(readFileSync(workspaceStateFile(tmpRoot), 'utf-8'));
  expect(left).toEqual({ supervisor: { pid: 7 }, lastBuild: { fingerprint: 'abc' } });
});

// --- the occupied-sim skip names its holder --------------------------------
//
// "in use by another process (occupied)" told a reader that something is
// holding the sim and nothing about what, which is a dead end when the answer
// is almost always one process they can see. `ps` can usually name it, because
// whatever attached to a simulator names its udid on the command line.

test('parseSimHolders names the processes whose command line carries the udid', () => {
  const ps = [
    '  501 /usr/bin/xcodebuild test-without-building -destination id=UDID-1',
    '  777 /usr/bin/some-device-tool --udid UDID-2',
    ' 9001 /bin/zsh',
  ].join('\n');
  expect(parseSimHolders(ps, 'UDID-1')).toEqual(['xcodebuild (pid 501)']);
  expect(parseSimHolders(ps, 'UDID-2')).toEqual(['some-device-tool (pid 777)']);
  expect(parseSimHolders(ps, 'UDID-3')).toEqual([]);
  expect(parseSimHolders(null, 'UDID-1')).toEqual([]);
});

test('parseSimHolders never names rn-iso own processes', () => {
  const ps = [
    `${process.pid} /usr/local/bin/node rn-iso stop UDID-1`,
    '  502 /usr/local/bin/node /pkg/src/collector/run.js --udid UDID-1',
    '  503 /usr/bin/xcodebuild -destination id=UDID-1',
  ].join('\n');
  expect(parseSimHolders(ps, 'UDID-1')).toEqual(['xcodebuild (pid 503)']);
});

test('an occupied sim names the process holding it', async () => {
  const reports = [];
  const { opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    teardownIos: () => ({ status: 'skipped', kind: 'occupied', reason: 'in use by another process (occupied)' }),
    simHolders: (udid) => (udid === 'U1' ? ['xcodebuild (pid 4242)'] : []),
    report: (l) => reports.push(String(l)),
  });
  const r = await runStop(opts);
  expect(r.outcomes.device.ios.status).toBe('skipped');
  expect(r.outcomes.device.ios.reason).toMatch(/xcodebuild \(pid 4242\)/);
  expect(reports.join('\n')).toMatch(/xcodebuild \(pid 4242\)/);
});

test('an occupied sim nothing can identify still gets a hint about who it usually is', async () => {
  const { opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    teardownIos: () => ({ status: 'skipped', kind: 'occupied', reason: 'in use by another process (occupied)' }),
    simHolders: () => [],
  });
  const r = await runStop(opts);
  expect(r.outcomes.device.ios.reason).toMatch(/UI-test runner or device tool/);
});

test('a not-owned skip is not given an occupancy hint', async () => {
  const { opts } = seams({
    project: { metroPort: 8083, platforms: { ios: { deviceUdid: 'U1', owned: true } } },
    teardownIos: () => ({ status: 'skipped', kind: 'not-owned', reason: 'sim is now named "other"' }),
    simHolders: () => ['xcodebuild (pid 1)'],
  });
  const r = await runStop(opts);
  expect(!/UI-test runner/.test(r.outcomes.device.ios.reason)).toBeTruthy();
  expect(!/pid 1/.test(r.outcomes.device.ios.reason)).toBeTruthy();
});
