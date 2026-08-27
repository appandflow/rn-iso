// src/commands/stop.js
//
// `stop` is the inverse of `start`, and nothing more: it halts the
// supervisor, reaps this workspace's device-log collectors, shuts the owned
// device DOWN, and frees the port. It is not
// destructive and it never deletes a device, because destruction lives in
// exactly two commands -- `worktree remove` and `gc --delete`. An agent
// reaching for `stop` to reclaim memory must not have a `--delete` within
// reach of a typo, so there is no flag here that could become one.
//
// The identity discipline lives in two places:
//   1. A supervisor pid is signalled only when it is ALIVE and PROVABLY ours --
//      recorded in this workspace's state.json (or in the global registration
//      for this exact path) and holding the port this project reserved. A pid
//      is a number the OS reuses; a port is a slot anyone can occupy. Neither
//      alone is proof.
//   2. With no supervisor, the fallback is the `resolveProjectMetro` check
//      before killing whatever answers the reserved port, with `--force` still
//      the only way past an unproven listener. That flag guards THAT case; it
//      has nothing to do with the supervisor, and it destroys nothing.
//
// Already-stopped is a success at every step. `stop` runs after a crash as
// often as after a session, and an agent that reads a non-zero exit as "still
// running" would loop on a workspace where nothing is left to stop.
import chalk from 'chalk';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import type { Command } from 'commander';
import { clearSupervisor, getProject, upsertProject } from '../config.ts';
import type { ProjectRecord, SupervisorRecord } from '../config.ts';
import { findProjectRoot } from '../project.ts';
import { supervisorPidFile, workspaceStateFile } from '../paths.ts';
import { findPidListeningOnPort, isPidAlive, killMetroTree, resolveProjectMetro } from '../metro.ts';
import type { MetroResolution } from '../metro.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.ts';
import { endRecordedSession } from '../engine/device-remote.ts';
import { resolveEasCliBin } from '../engine/remote-cache.ts';

const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 100;

// config.ts's SupervisorRecord does not declare `mode` (start.ts writes it
// alongside pid/port/startedAt); extended locally rather than editing the
// shared type.
type SupervisorRecordExt = SupervisorRecord & { mode?: string | null };

// The workspace state.json's `supervisor` block, as this file reads it back.
// Flat and defensive like SupervisorRecord: written by the supervisor process
// itself, in src/supervisor/run.js.
interface SupervisorStateRecord {
  pid?: number;
  port?: number;
  mode?: string | null;
  startedAt?: string | null;
  [key: string]: unknown;
}

interface CollectorStateRecord {
  pid?: number | string;
  [key: string]: unknown;
}

type CollectorStateMap = Record<string, CollectorStateRecord | undefined>;

// Local, flat view of teardown.ts's outcomes -- deliberately looser (status as
// a bare string) than the exported TeardownOutcome, reading only the fields
// stop branches on.
interface TeardownResult {
  status: string;
  kind?: string;
  reason?: string;
  label?: string;
  serial?: string | null;
  holders?: string[];
}

// --- workspace state (Contract 2) -------------------------------------------
//
// Reading and clearing live here rather than in src/supervisor/ so that `stop`
// and `status` depend on nothing the supervisor half owns: both must work on a
// workspace whose supervisor died, or was never started by this rn-iso at all.

export function readSupervisorState(root: string): SupervisorStateRecord | null {
  const file = workspaceStateFile(root);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const sup = parsed?.supervisor;
    return sup && typeof sup === 'object' ? sup : null;
  } catch {
    // No file, or a half-written one from a supervisor killed mid-rename.
    // Neither is a reason to refuse to stop anything.
    return null;
  }
}

// Contract 5. The same file, under its own key, written by `ios` / `android`'s
// detached collectors. Read here rather than through src/collector/run.js for
// the reason above the section: `stop` must work on a workspace whose
// collectors are gone, or were never this rn-iso's.
export function readCollectorState(root: string): CollectorStateMap {
  const file = workspaceStateFile(root);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const collectors = parsed?.collectors;
    return collectors && typeof collectors === 'object' ? collectors : {};
  } catch {
    return {};
  }
}

// The remote session this workspace created, if any. Written by `ios --remote`
// the moment the session exists, so a build that failed later still leaves a
// handle here. Only the session id: the token is never persisted.
interface RemoteDeviceRecord {
  platform?: string;
  sessionId?: string;
}
function readRemoteDeviceState(root: string): RemoteDeviceRecord | null {
  const file = workspaceStateFile(root);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const record = parsed?.remoteDevice;
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

// Drops the named top-level keys from state.json. NOT a delete of the file:
// `ios` / `android` write `lastBuild` beside `supervisor` and `collectors`,
// and taking the build fingerprint away with a pid would turn every stop into
// a guaranteed cache miss on the next build.
function dropStateKeys(root: string, keys: string[]): void {
  const file = workspaceStateFile(root);
  if (!existsSync(file)) return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    // Unparseable: nothing in it can be preserved anyway, and a corrupt file
    // left in place would fail every later read.
    rmSync(file, { force: true });
    return;
  }
  if (!parsed || typeof parsed !== 'object') {
    rmSync(file, { force: true });
    return;
  }
  for (const key of keys) delete parsed[key];
  if (Object.keys(parsed).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  // Same temp-then-rename as saveConfig: a reader must never see a partial file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2));
  renameSync(tmp, file);
}

// Drops the supervisor block and the pid file.
export function clearSupervisorState(root: string): void {
  const pidFile = supervisorPidFile(root);
  try {
    rmSync(pidFile, { force: true });
  } catch {
    // A read-only workspace is not a reason to fail a teardown.
  }
  dropStateKeys(root, ['supervisor']);
}

// Drops the collectors block. Separate from clearSupervisorState because it is
// cleared at a different point in the sequence: collectors are reaped even
// when the supervisor could not be stopped, so their record must go with them
// rather than waiting on the bookkeeping step that a live process suppresses.
export function clearCollectorState(root: string): void {
  dropStateKeys(root, ['collectors']);
}

// --- identity ---------------------------------------------------------------

// Pure. Decides whether a recorded supervisor may be signalled at all, given
// the two records that describe it and the port this project actually reserved.
//
//   { status: 'none' }                    nothing recorded
//   { status: 'stale', pid }              recorded, not running: already stopped
//   { status: 'unverified', pid, reason } running but not proven ours: never signalled
//   { status: 'ours', pid, port, mode, startedAt }
interface SupervisorTarget {
  status: string;
  pid?: number;
  reason?: string;
  port?: number | null;
  mode?: string | null;
  startedAt?: string | null;
}

export function resolveSupervisorTarget({
  state,
  record,
  reservedPort,
  isAlive = isPidAlive,
}: {
  state?: SupervisorStateRecord | null;
  record?: SupervisorRecordExt | null;
  reservedPort?: number | null;
  isAlive?: (pid: number) => boolean;
} = {}): SupervisorTarget {
  const statePid = numberOrNull(state?.pid);
  const recordPid = numberOrNull(record?.pid);
  const pid = statePid ?? recordPid;
  if (!pid) return { status: 'none' };

  // Two records naming different pids means one of them outlived its process
  // and the number has since been reused. There is no way to tell which, so
  // neither is signalled.
  if (statePid && recordPid && statePid !== recordPid) {
    return {
      status: 'unverified',
      pid,
      reason: `workspace state.json records supervisor pid ${statePid} but the registry records pid ${recordPid}`,
    };
  }

  if (!isAlive(pid)) return { status: 'stale', pid };

  const port = numberOrNull(state?.port) ?? numberOrNull(record?.port);
  // The port is the second half of the proof. When this project holds no
  // reservation at all -- an earlier stop freed it and then failed -- the
  // in-workspace record is what is left, and it is still a record written
  // inside THIS workspace.
  if (reservedPort !== null && reservedPort !== undefined && port !== null && port !== reservedPort) {
    return {
      status: 'unverified',
      pid,
      reason: `supervisor pid ${pid} records port ${port}, but this project reserved port ${reservedPort}`,
    };
  }
  if (reservedPort !== null && reservedPort !== undefined && port === null) {
    return {
      status: 'unverified',
      pid,
      reason: `supervisor pid ${pid} has no recorded port, so it cannot be matched against reserved port ${reservedPort}`,
    };
  }

  return {
    status: 'ours',
    pid,
    port,
    mode: state?.mode ?? record?.mode ?? null,
    startedAt: state?.startedAt ?? record?.startedAt ?? null,
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

// Pure. Contract 5's collectors, turned into a signal list.
//
// The identity discipline is the supervisor's, minus the port half a collector
// does not have: a pid is signalled only when it is recorded in THIS
// workspace's state.json and is actually running. That record is the whole
// proof, which is why nothing else -- not a pid file, not a process name -- is
// consulted, and why our own pid is refused outright: a state file that
// somehow named this process would otherwise make `stop` SIGTERM itself.
//
//   { platform, pid, status: 'running' }   alive and ours: signal it
//   { platform, pid, status: 'stale' }     recorded, not running
//   { platform, pid, status: 'invalid' }   unusable record (no pid, or ours)
interface CollectorTarget {
  platform: string;
  pid: number | null;
  status: string;
}

export function resolveCollectorTargets({
  collectors,
  isAlive = isPidAlive,
  selfPid = process.pid,
}: {
  collectors?: CollectorStateMap | null;
  isAlive?: (pid: number) => boolean;
  selfPid?: number;
} = {}): CollectorTarget[] {
  const targets: CollectorTarget[] = [];
  for (const [platform, record] of Object.entries(collectors || {})) {
    const pid = numberOrNull(Number(record?.pid));
    if (!pid || pid === selfPid) {
      targets.push({ platform, pid: pid ?? null, status: 'invalid' });
      continue;
    }
    targets.push({ platform, pid, status: isAlive(pid) ? 'running' : 'stale' });
  }
  return targets;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Polls rather than waiting on the process, because it is not our child: a
// detached supervisor is reparented to init, so there is no exit event to
// listen for.
async function waitForExit(
  pid: number,
  {
    timeoutMs = DEFAULT_WAIT_MS,
    intervalMs = POLL_MS,
    isAlive = isPidAlive,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    isAlive?: (pid: number) => boolean;
  } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(intervalMs);
  }
  return !isAlive(pid);
}

// --- the sequence -----------------------------------------------------------

// Outcomes, one per step, are the `--json` payload. Flat, all-optional shapes
// rather than discriminated unions: every field this module reads is guarded
// defensively at the read site already (`outcomes.metro.reason` on a status
// that has none is simply undefined), matching MetroResolution's convention.
interface SupervisorOutcome {
  status: string; // none | stopped | already-stopped | unverified | timeout | failed
  pid?: number;
  reason?: string;
  port?: number | null;
  mode?: string | null;
}

interface CollectorEntry {
  platform: string;
  pid: number | null;
  status: string;
}

interface CollectorsOutcome {
  status: string; // none | stopped
  entries: CollectorEntry[];
}

interface MetroOutcome {
  status: string; // none | missing | stopped | forced | refused | failed | skipped
  port?: number | null;
  pid?: number | null;
  reason?: string;
}

interface DeviceOutcomeEntry {
  status: string; // shut-down | missing | skipped | failed
  label?: string;
  reason?: string;
  kind?: string | null;
}

interface DeviceOutcome {
  ios: DeviceOutcomeEntry | null;
  android: DeviceOutcomeEntry | null;
  // Only set when this workspace created a remote session. Unlike ios and
  // android, its `torn-down` means DESTROYED, not shut down: see the device
  // step in runStop for why remote is the one exception to "stop never
  // deletes".
  remote?: DeviceOutcomeEntry | null;
}

interface PortOutcome {
  status: string; // none | freed | kept
  port?: number | null;
  reason?: string;
}

interface StopOutcomes {
  supervisor: SupervisorOutcome;
  collectors: CollectorsOutcome;
  metro: MetroOutcome;
  device: DeviceOutcome;
  port: PortOutcome;
}

// Every side effect is injected so the ORDER -- which is the part that can
// strand a live process or free a port out from under one -- is testable
// without signalling anything.
// The real teardown: resolve eas-cli against the project, then end the
// session. Injected in tests so `stop`'s own suite never shells out.
function defaultTeardownRemoteSession(
  root: string,
  sessionId: string,
): { status: 'torn-down' | 'failed'; reason?: string } {
  return endRecordedSession({ root, sessionId, easBin: resolveEasCliBin(root)?.file ?? null });
}

export async function runStop({
  root,
  force = false,
  project = undefined,
  state = undefined,
  collectors = undefined,
  signalCollector = (pid: number) => process.kill(pid, 'SIGTERM'),
  clearCollectors = clearCollectorState,
  isAlive = isPidAlive,
  killGroup = killMetroTree,
  waitForDeath = undefined,
  waitMs = DEFAULT_WAIT_MS,
  resolveMetro = resolveProjectMetro,
  killMetro = killMetroTree,
  findListener = findPidListeningOnPort,
  teardownIos = teardownOwnedIosSim,
  teardownAvd = teardownOwnedAvd,
  remoteDevice = undefined,
  teardownRemoteSession = defaultTeardownRemoteSession,
  freePort = defaultFreePort,
  clearRegistration = defaultClearRegistration,
  clearState = clearSupervisorState,
  report = (line: string) => console.error(line),
}: {
  root: string;
  force?: boolean;
  project?: ProjectRecord | null;
  state?: SupervisorStateRecord | null;
  collectors?: CollectorStateMap | null;
  signalCollector?: (pid: number) => void;
  clearCollectors?: (root: string) => void;
  isAlive?: (pid: number) => boolean;
  killGroup?: (leader: number | null | undefined) => boolean;
  waitForDeath?: ((pid: number) => Promise<boolean>) | undefined;
  waitMs?: number;
  resolveMetro?: (port: number, root: string) => Promise<MetroResolution>;
  killMetro?: (leader: number | null | undefined, listenerPid?: number | null) => boolean;
  findListener?: (port: number) => number | null;
  teardownIos?: (udid: string, opts: { del?: boolean; label?: string }) => TeardownResult;
  teardownAvd?: (avdName: string, opts: { del?: boolean }) => TeardownResult;
  remoteDevice?: RemoteDeviceRecord | null;
  teardownRemoteSession?: (root: string, sessionId: string) => { status: 'torn-down' | 'failed'; reason?: string };
  freePort?: (root: string, port: number) => void;
  clearRegistration?: (root: string) => Promise<void>;
  clearState?: (root: string) => void;
  report?: (line: string) => void;
}): Promise<{ ok: boolean; outcomes: StopOutcomes; summary: string }> {
  const proj = project === undefined ? getProject(root) : project;
  const sup = state === undefined ? readSupervisorState(root) : state;
  const collectorRecords = collectors === undefined ? readCollectorState(root) : collectors;
  const reservedPort = typeof proj?.metroPort === 'number' ? proj.metroPort : null;
  const waiter = waitForDeath ?? ((pid: number) => waitForExit(pid, { timeoutMs: waitMs, isAlive }));

  const outcomes: StopOutcomes = {
    supervisor: { status: 'none' },
    collectors: { status: 'none', entries: [] },
    metro: { status: 'none' },
    device: { ios: null, android: null },
    port: { status: 'none', port: reservedPort },
  };
  let ok = true;
  // Set when something this command could not stop is still holding the port.
  // The reservation is then KEPT: it is the only record a retry can find that
  // process by, and dropping it strands a live supervisor no command can name.
  let stillHolding: string | null | undefined = null;

  // Step 1: the supervisor.
  const target = resolveSupervisorTarget({ state: sup, record: proj?.supervisor ?? null, reservedPort, isAlive });
  if (target.status === 'none') {
    report(chalk.dim('supervisor: none recorded'));
  } else if (target.status === 'stale') {
    outcomes.supervisor = {
      status: 'already-stopped',
      pid: target.pid,
      reason: `recorded pid ${target.pid} is not running`,
    };
    report(chalk.dim(`supervisor: pid ${target.pid} is already gone (stale record)`));
  } else if (target.status === 'unverified') {
    outcomes.supervisor = { status: 'unverified', pid: target.pid, reason: target.reason };
    report(chalk.yellow(`supervisor: refusing to signal pid ${target.pid}: ${target.reason}`));
    ok = false;
    stillHolding = `supervisor pid ${target.pid} could not be verified`;
  } else {
    outcomes.supervisor = await stopSupervisor(target, { killGroup, waiter, report });
    if (outcomes.supervisor.status !== 'stopped') {
      ok = false;
      stillHolding = outcomes.supervisor.reason;
    }
  }

  // Step 2: the device-log collectors (Contract 5). Reaped whether or not the
  // supervisor went down, and BEFORE the device is shut down: a collector is a
  // `simctl log stream` / `adb logcat` attached to the device step 4 is about
  // to stop, and one left running there outlives the workspace it belongs to
  // with nothing left that can name it. They hold no contended resource, so
  // unlike the device there is nothing for a stuck supervisor to make unsafe.
  outcomes.collectors = reapCollectors(collectorRecords, { isAlive, signal: signalCollector, report });
  if (outcomes.collectors.entries.length) clearCollectors(root);

  // Step 3: Metro. Only when no live supervisor was involved -- the supervisor
  // hosts the dev server, so with one running (or refusing to die) the port is
  // accounted for, and racing a second killer at it can only take out the wrong
  // process.
  const supervisorHandled =
    outcomes.supervisor.status === 'stopped' ||
    outcomes.supervisor.status === 'timeout' ||
    outcomes.supervisor.status === 'unverified' ||
    outcomes.supervisor.status === 'failed';
  if (supervisorHandled) {
    outcomes.metro = { status: 'skipped', reason: 'the supervisor owns the dev server on this port' };
  } else if (reservedPort === null) {
    report(chalk.dim('metro: no port reserved'));
  } else {
    outcomes.metro = await stopMetro(reservedPort, root, { force, resolveMetro, killMetro, findListener, report });
    if (outcomes.metro.status === 'refused' || outcomes.metro.status === 'failed') {
      ok = false;
      stillHolding = outcomes.metro.reason;
    }
  }

  // Step 4: the device. Shut down, never deleted, and only when rn-iso owns it.
  // Skipped entirely while something is still holding the port: the supervisor
  // that ignored our SIGTERM is very likely still driving that simulator.
  if (stillHolding) {
    report(chalk.dim('device: left alone (something is still running)'));
  } else {
    outcomes.device = shutDownDevices(proj, { teardownIos, teardownAvd, report });
    if (outcomes.device.ios?.status === 'failed' || outcomes.device.android?.status === 'failed') ok = false;

    // A remote session is the ONE device rn-iso stops by DESTROYING. Locally
    // `stop` never deletes, because a shut-down simulator costs nothing to
    // keep. A cloud session bills until its max duration, so leaving one up
    // is the worse failure -- and `ios --remote` creates a fresh one anyway.
    const remote = remoteDevice === undefined ? readRemoteDeviceState(root) : remoteDevice;
    const sessionId = typeof remote?.sessionId === 'string' ? remote.sessionId : null;
    if (sessionId) {
      const result = teardownRemoteSession(root, sessionId);
      outcomes.device.remote = { status: result.status, label: sessionId, reason: result.reason };
      if (result.status === 'failed') {
        ok = false;
        report(chalk.red(`remote: ${result.reason ?? `could not stop session ${sessionId}`}`));
      } else {
        report(chalk.dim(`remote: stopped session ${sessionId}`));
        dropStateKeys(root, ['remoteDevice']);
      }
    }
  }

  // Step 5: the port, and step 6: the records. Both are bookkeeping, and both
  // are wrong while a process this command failed to stop is still holding on.
  if (stillHolding) {
    outcomes.port = { status: 'kept', port: reservedPort, reason: stillHolding };
    report(chalk.yellow(`port: keeping reservation ${reservedPort ?? '(none)'} -- ${stillHolding}`));
  } else {
    if (reservedPort !== null) {
      freePort(root, reservedPort);
      outcomes.port = { status: 'freed', port: reservedPort };
      report(chalk.dim(`port: released ${reservedPort}`));
    }
    clearState(root);
    await clearRegistration(root);
  }

  return { ok, outcomes, summary: summarize(root, outcomes, ok) };
}

// SIGTERM each recorded collector, tolerating a pid that is already gone.
//
// No wait, and deliberately no escalation: a collector's SIGTERM handler
// closes its NDJSON writer and unregisters itself, which is exactly the work a
// second signal would interrupt mid-file. A dead pid is the NORMAL case -- the
// app was killed, the collector noticed and exited -- so ESRCH is not a
// failure and never makes `stop` non-zero.
function reapCollectors(
  collectors: CollectorStateMap | null | undefined,
  {
    isAlive,
    signal,
    report,
  }: {
    isAlive: (pid: number) => boolean;
    signal: (pid: number) => void;
    report: (line: string) => void;
  },
): CollectorsOutcome {
  const targets = resolveCollectorTargets({ collectors, isAlive });
  const entries: CollectorEntry[] = [];
  for (const target of targets) {
    if (target.status === 'invalid') {
      entries.push({ platform: target.platform, pid: target.pid, status: 'invalid' });
      report(chalk.dim(`collectors: ignoring an unusable ${target.platform} record`));
      continue;
    }
    if (target.status === 'stale') {
      entries.push({ platform: target.platform, pid: target.pid, status: 'already-stopped' });
      report(chalk.dim(`collectors: ${target.platform} pid ${target.pid} is already gone`));
      continue;
    }
    try {
      // Only a 'running' target reaches here, and resolveCollectorTargets only
      // gives that status a non-null pid; the flat CollectorTarget shape just
      // doesn't encode that link.
      signal(target.pid as number);
      entries.push({ platform: target.platform, pid: target.pid, status: 'stopped' });
      report(chalk.green(`collectors: stopped ${target.platform} pid ${target.pid}`));
    } catch {
      // Raced with its own exit between the liveness check and the signal.
      entries.push({ platform: target.platform, pid: target.pid, status: 'already-stopped' });
      report(chalk.dim(`collectors: ${target.platform} pid ${target.pid} exited before it could be signalled`));
    }
  }
  if (entries.length === 0) {
    report(chalk.dim('collectors: none recorded'));
    return { status: 'none', entries };
  }
  return { status: 'stopped', entries };
}

async function stopSupervisor(
  target: SupervisorTarget,
  {
    killGroup,
    waiter,
    report,
  }: {
    killGroup: (leader: number | null | undefined) => boolean;
    waiter: (pid: number) => Promise<boolean>;
    report: (line: string) => void;
  },
): Promise<SupervisorOutcome> {
  report(chalk.dim(`supervisor: sending SIGTERM to process group ${target.pid}`));
  let signalled = false;
  try {
    signalled = killGroup(target.pid);
  } catch (e) {
    signalled = false;
    report(chalk.red(`supervisor: could not signal pid ${target.pid}: ${String((e as Error)?.message || e)}`));
  }
  if (!signalled) {
    const reason = `could not signal supervisor pid ${target.pid}`;
    report(chalk.red(`supervisor: ${reason}`));
    return { status: 'failed', pid: target.pid, port: target.port ?? null, reason };
  }
  // stopSupervisor is only ever called with an 'ours' target, which always
  // carries a real pid; SupervisorTarget itself keeps it optional because
  // 'none' and 'stale' targets do not.
  const died = await waiter(target.pid as number);
  if (died) {
    report(chalk.green(`supervisor: stopped (pid ${target.pid})`));
    return { status: 'stopped', pid: target.pid, port: target.port ?? null, mode: target.mode ?? null };
  }
  // Deliberately NOT escalating to SIGKILL. A supervisor mid-write on the log
  // files is exactly what SIGTERM handling exists to finish, and a second
  // signal from here would corrupt the timeline the agent is about to read.
  // Escalation is the caller's call, so it gets the pid and the reason.
  const reason = `supervisor pid ${target.pid} did not exit within ${Math.round(DEFAULT_WAIT_MS / 1000)}s of SIGTERM`;
  report(chalk.red(`supervisor: ${reason}`));
  report(chalk.dim(`  inspect it with \`ps -p ${target.pid}\`, or signal it yourself: kill -9 -${target.pid}`));
  return { status: 'timeout', pid: target.pid, port: target.port ?? null, reason };
}

async function stopMetro(
  port: number,
  root: string,
  {
    force,
    resolveMetro,
    killMetro,
    findListener,
    report,
  }: {
    force: boolean;
    resolveMetro: (port: number, root: string) => Promise<MetroResolution>;
    killMetro: (leader: number | null | undefined, listenerPid?: number | null) => boolean;
    findListener: (port: number) => number | null;
    report: (line: string) => void;
  },
): Promise<MetroOutcome> {
  const resolution = await resolveMetro(port, root);
  if (resolution.missing) {
    report(chalk.dim(`metro: nothing listening on port ${port}`));
    return { status: 'missing', port };
  }
  if (resolution.notOurs && !force) {
    report(chalk.yellow(`metro: refusing to kill port ${port}: ${resolution.notOurs}`));
    report(chalk.dim('  pass --force to kill it anyway'));
    return { status: 'refused', port, reason: resolution.notOurs };
  }
  const identified = Boolean(resolution.metro);
  const pid = identified ? resolution.metro!.pid : findListener(port);
  const leader = identified ? (resolution.metro!.leader ?? pid) : pid;
  if (!leader) {
    report(chalk.dim(`metro: nothing listening on port ${port}`));
    return { status: 'missing', port };
  }
  if (!killMetro(leader, pid)) {
    const reason = `could not kill the process on port ${port}`;
    report(chalk.red(`metro: ${reason}`));
    return { status: 'failed', port, pid, reason };
  }
  if (identified) {
    report(chalk.green(`metro: stopped (pid ${pid} on port ${port})`));
    return { status: 'stopped', port, pid };
  }
  report(chalk.yellow(`metro: killed pid ${pid} on port ${port} (forced, identity unverified)`));
  return { status: 'forced', port, pid };
}

// --- who is holding an occupied sim ----------------------------------------
//
// teardownOwnedIosSim spares a sim something else is attached to (CLAUDE.md
// item 4). The occupancy DECIDER counts only foreign .xctrunner bundles, and
// the outcome now carries exactly that list, so the skip names what counted
// and nothing else. (An earlier version scanned `ps` for any command line
// carrying the udid, which named the sim's own runtime and the app rn-iso
// itself launched alongside the one process that decided the skip.)
//
// The probe also fails CLOSED, so an 'occupied' skip with no holder list does
// not prove a holder exists -- the generic hint is still better than nothing:
// it is very nearly always one of two things.
const OCCUPANCY_HINT = 'often a UI-test runner or device tool still attached';

// PURE. The occupied skip, with whoever can be named appended to it.
function occupiedSkipReason(reason: string, holders: string[] | null | undefined): string {
  const named = (holders || []).filter(Boolean);
  return named.length ? `${reason} -- held by UI-test runner ${named.join(', ')}` : `${reason} -- ${OCCUPANCY_HINT}`;
}

// Owned devices only, and always with del:false. `stop` shutting a device down
// rather than deleting it is what makes returning to a branch cost a boot
// instead of a create, a provision and a reinstall.
function shutDownDevices(
  project: ProjectRecord | null | undefined,
  {
    teardownIos,
    teardownAvd,
    report,
  }: {
    teardownIos: (udid: string, opts: { del?: boolean; label?: string }) => TeardownResult;
    teardownAvd: (avdName: string, opts: { del?: boolean }) => TeardownResult;
    report: (line: string) => void;
  },
): DeviceOutcome {
  const device: DeviceOutcome = { ios: null, android: null };

  const ios = project?.platforms?.ios;
  // `deviceUdid` / `deviceName` reach DeviceRecord's index signature (the
  // interface only names the fields it declares up front) rather than typed
  // fields, hence the casts: the values are strings wherever this codebase
  // writes them (see src/status.ts for the same convention).
  const iosUdid = ios?.deviceUdid as string | undefined;
  const iosName = ios?.deviceName as string | undefined;
  if (iosUdid) {
    if (!ios?.owned) {
      device.ios = { status: 'skipped', kind: 'not-owned', label: iosUdid, reason: 'rn-iso does not own this device' };
      report(chalk.dim(`ios: ${iosUdid} is not rn-iso-owned, leaving it running`));
    } else {
      device.ios = reportDevice('ios', iosUdid, teardownIos(iosUdid, { del: false, label: iosName }), report);
    }
  }

  const android = project?.platforms?.android;
  if (android?.avdName) {
    if (!android.owned) {
      device.android = {
        status: 'skipped',
        kind: 'not-owned',
        label: android.avdName,
        reason: 'rn-iso does not own this device',
      };
      report(chalk.dim(`android: ${android.avdName} is not rn-iso-owned, leaving it running`));
    } else {
      // Android has no occupancy probe, so there is no occupied skip to
      // explain -- see teardownOwnedAvd.
      device.android = reportDevice('android', android.avdName, teardownAvd(android.avdName, { del: false }), report);
    }
  }

  return device;
}

function reportDevice(
  platform: string,
  label: string,
  r: TeardownResult,
  report: (line: string) => void,
): DeviceOutcomeEntry {
  if (r.status === 'torn-down') {
    report(chalk.green(`${platform}: shut down ${r.label ?? label}`));
    return { status: 'shut-down', label: r.label ?? label };
  }
  if (r.status === 'missing') {
    report(chalk.dim(`${platform}: ${label} is already gone`));
    return { status: 'missing', label };
  }
  if (r.status === 'skipped') {
    const reason = r.kind === 'occupied' ? occupiedSkipReason(r.reason as string, r.holders) : r.reason;
    report(chalk.yellow(`${platform}: skipped ${label}: ${reason}`));
    return { status: 'skipped', kind: r.kind ?? null, label, reason };
  }
  report(chalk.red(`${platform}: failed to shut down ${label}: ${r.reason}`));
  return { status: 'failed', label, reason: r.reason };
}

function summarize(root: string, outcomes: StopOutcomes, ok: boolean): string {
  const parts: string[] = [];
  if (outcomes.supervisor.status === 'stopped') parts.push(`supervisor pid ${outcomes.supervisor.pid} stopped`);
  if (outcomes.supervisor.status === 'already-stopped') parts.push('supervisor already stopped');
  if (outcomes.supervisor.status === 'timeout') parts.push(`supervisor pid ${outcomes.supervisor.pid} still running`);
  if (outcomes.supervisor.status === 'unverified') parts.push(`supervisor pid ${outcomes.supervisor.pid} unverified`);
  if (outcomes.supervisor.status === 'failed')
    parts.push(`supervisor pid ${outcomes.supervisor.pid} could not be signalled`);
  const reaped = outcomes.collectors.entries.filter((e) => e.status === 'stopped').length;
  if (reaped) parts.push(`${reaped} collector${reaped === 1 ? '' : 's'} stopped`);
  if (outcomes.metro.status === 'stopped') parts.push(`metro on port ${outcomes.metro.port} stopped`);
  if (outcomes.metro.status === 'forced') parts.push(`port ${outcomes.metro.port} killed (forced)`);
  if (outcomes.metro.status === 'refused') parts.push(`port ${outcomes.metro.port} refused`);
  if (outcomes.metro.status === 'failed') parts.push(`port ${outcomes.metro.port} could not be freed`);
  const devicesByPlatform: [string, DeviceOutcomeEntry | null][] = [
    ['ios', outcomes.device.ios],
    ['android', outcomes.device.android],
  ];
  for (const [platform, o] of devicesByPlatform) {
    if (!o) continue;
    if (o.status === 'shut-down') parts.push(`${platform} ${o.label} shut down`);
    if (o.status === 'skipped') parts.push(`${platform} ${o.label} skipped`);
    if (o.status === 'failed') parts.push(`${platform} ${o.label} failed`);
  }
  if (outcomes.port.status === 'freed') parts.push(`port ${outcomes.port.port} freed`);
  if (outcomes.port.status === 'kept') parts.push(`port ${outcomes.port.port} kept`);
  const what = parts.length ? parts.join(', ') : 'nothing was running';
  return `${ok ? 'Stopped' : 'Stopped with problems'}: ${what} (${root})`;
}

// upsertProject spreads its fields over the existing record inside the config
// lock, so this clears the reservation the same race-safe way claimMetroPort
// takes it. There is no dedicated releaseMetroPort mutator in config.js; if one
// is added, this is the single site to move onto it.
function defaultFreePort(root: string, _port: number): void {
  if (!getProject(root)) return;
  upsertProject(root, { metroPort: null });
}

// The global registration is what makes a supervisor findable after its
// workspace is gone (`status`, `worktree remove`), so it is the last
// thing dropped and only once the process is provably down. A failure to clear
// it is contained: `status` then reports a stale supervisor record, which is
// recoverable, whereas failing the stop over bookkeeping is not.
async function defaultClearRegistration(root: string): Promise<void> {
  try {
    clearSupervisor(root);
  } catch {
    // See above: a registry that cannot be written is not this command's
    // failure to report.
  }
}

interface StopOptions {
  force?: boolean;
  json?: boolean;
}

export default function stopCommand(program: Command): void {
  program
    .command('stop')
    .description(
      "The inverse of `start`: halt this workspace's supervisor, shut the owned device down (never deleted), and free the reserved port. Non-destructive -- the device stays assigned, so coming back costs a boot. Acts on the current workspace.",
    )
    .option(
      '--force',
      "Kill whatever listens on the reserved port even if it cannot be identified as this project's dev server (only reachable when no supervisor is recorded)",
    )
    .option('--json', 'print the per-step outcomes as JSON')
    .action(async (opts: StopOptions) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not inside a project (no package.json found above the current directory).'));
        process.exit(1);
      }

      const { ok, outcomes, summary } = await runStop({ root, force: Boolean(opts.force) });

      if (opts.json) {
        console.log(JSON.stringify({ root, ok, ...outcomes }, null, 2));
      } else {
        console.log(ok ? chalk.green(summary) : chalk.yellow(summary));
      }
      if (!ok) process.exit(1);
    });
}
