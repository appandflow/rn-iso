import chalk from 'chalk';
import { rmSync } from 'fs';
import type { Command } from 'commander';
import { clearSupervisor, getProject, upsertProject } from '../config.ts';
import type { ProjectRecord, SupervisorRecord } from '../config.ts';
import { findProjectRoot } from '../project.ts';
import { supervisorPidFile } from '../paths.ts';
import { findPidListeningOnPort, isPidAlive, killMetroTree, resolveProjectMetro } from '../metro.ts';
import type { MetroResolution } from '../metro.ts';
import {
  clearManagedMetroTunnel,
  clearRemoteSession,
  clearWorkspaceStateKeys,
  readMetroTunnel,
  readRemoteSession,
  readWorkspaceState,
} from '../supervisor/state.ts';
import { verifyCollectorOwnership } from '../collector/ownership.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.ts';
import { endRecordedSession } from '../engine/device-remote.ts';
import { releaseWorkspaceLeases, type ReleasedLease } from '../engine/device-lease.ts';
import { resolveEasCliBin } from '../engine/remote-cache.ts';
import { stopTunnel } from '../engine/tunnel.ts';

const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 100;

type SupervisorRecordExt = SupervisorRecord & { mode?: string | null };

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

interface TeardownResult {
  status: string;
  kind?: string;
  reason?: string;
  label?: string;
  serial?: string | null;
  holders?: string[];
}

export function readSupervisorState(root: string): SupervisorStateRecord | null {
  const sup = readWorkspaceState(root)?.supervisor;
  return sup && typeof sup === 'object' ? (sup as SupervisorStateRecord) : null;
}

export function readCollectorState(root: string): CollectorStateMap {
  const collectors = readWorkspaceState(root)?.collectors;
  return collectors && typeof collectors === 'object' ? (collectors as CollectorStateMap) : {};
}

interface RemoteDeviceRecord {
  platform?: string | null;
  sessionId?: string;
}
function readRemoteDeviceState(root: string): RemoteDeviceRecord | null {
  return readRemoteSession(root);
}

function dropStateKeys(root: string, keys: string[]): void {
  clearWorkspaceStateKeys(root, keys);
}

export function clearSupervisorState(root: string): void {
  try {
    rmSync(supervisorPidFile(root), { force: true });
  } catch {}
  clearWorkspaceStateKeys(root, ['supervisor']);
}

export function clearCollectorState(root: string): void {
  clearWorkspaceStateKeys(root, ['collectors']);
}

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

  if (statePid && recordPid && statePid !== recordPid) {
    return {
      status: 'unverified',
      pid,
      reason: `workspace state.json records supervisor pid ${statePid} but the registry records pid ${recordPid}`,
    };
  }

  if (!isAlive(pid)) return { status: 'stale', pid };

  const port = numberOrNull(state?.port) ?? numberOrNull(record?.port);
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

interface CollectorTarget {
  platform: string;
  pid: number | null;
  status: string;
  reason?: string;
}

export function resolveCollectorTargets({
  root,
  collectors,
  isAlive = isPidAlive,
  selfPid = process.pid,
  verify = verifyCollectorOwnership,
}: {
  root: string;
  collectors?: CollectorStateMap | null;
  isAlive?: (pid: number) => boolean;
  selfPid?: number;
  verify?: typeof verifyCollectorOwnership;
}): CollectorTarget[] {
  const targets: CollectorTarget[] = [];
  for (const [platform, record] of Object.entries(collectors || {})) {
    const pid = numberOrNull(Number(record?.pid));
    if (!pid || pid === selfPid) {
      targets.push({ platform, pid: pid ?? null, status: 'invalid' });
      continue;
    }
    if (!isAlive(pid)) {
      targets.push({ platform, pid, status: 'stale' });
      continue;
    }
    const ownership = verify({ pid, platform, root, isAlive });
    if (ownership.status === 'gone') {
      targets.push({ platform, pid, status: 'stale' });
      continue;
    }
    if (ownership.status === 'unverified') {
      targets.push({ platform, pid, status: 'unverified', reason: ownership.reason });
      continue;
    }
    targets.push({ platform, pid, status: 'running' });
  }
  return targets;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

interface SupervisorOutcome {
  status: string;
  pid?: number;
  reason?: string;
  port?: number | null;
  mode?: string | null;
}

interface CollectorEntry {
  platform: string;
  pid: number | null;
  status: string;
  reason?: string;
}

interface CollectorsOutcome {
  status: string;
  entries: CollectorEntry[];
}

interface MetroOutcome {
  status: string;
  port?: number | null;
  pid?: number | null;
  reason?: string;
}

interface DeviceOutcomeEntry {
  status: string;
  label?: string;
  reason?: string;
  kind?: string | null;
}

interface DeviceOutcome {
  ios: DeviceOutcomeEntry | null;
  android: DeviceOutcomeEntry | null;
  remote?: DeviceOutcomeEntry | null;
}

interface PortOutcome {
  status: string;
  port?: number | null;
  reason?: string;
}

interface StopOutcomes {
  supervisor: SupervisorOutcome;
  collectors: CollectorsOutcome;
  metro: MetroOutcome;
  device: DeviceOutcome;
  port: PortOutcome;
  metroTunnel: TunnelOutcome;
  releasedLeases: ReleasedLease[];
}

interface TunnelOutcome {
  status: string;
  provider?: string;
  reason?: string;
}

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
  verifyCollector = verifyCollectorOwnership,
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
  metroTunnel = undefined,
  stopMetroTunnel = stopTunnel,
  releaseLeases = releaseWorkspaceLeases,
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
  verifyCollector?: typeof verifyCollectorOwnership;
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
  metroTunnel?: ReturnType<typeof readMetroTunnel> | undefined;
  stopMetroTunnel?: typeof stopTunnel;
  releaseLeases?: (root: string) => ReleasedLease[];
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
    metroTunnel: { status: 'none' },
    releasedLeases: [],
  };
  let ok = true;
  let stillHolding: string | null | undefined = null;

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

  outcomes.collectors = reapCollectors(root, collectorRecords, {
    isAlive,
    signal: signalCollector,
    report,
    verify: verifyCollector,
  });
  const unverifiedCollectors = outcomes.collectors.entries.filter((e) => e.status === 'unverified');
  if (unverifiedCollectors.length) {
    report(
      chalk.dim(
        `collectors: keeping the records; ${unverifiedCollectors.length} pid(s) could not be verified, and a later \`ios\` / \`android\` run replaces them`,
      ),
    );
  } else if (outcomes.collectors.entries.length) clearCollectors(root);

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

  if (stillHolding) {
    report(chalk.dim('device: left alone (something is still running)'));
  } else {
    outcomes.device = shutDownDevices(proj, { teardownIos, teardownAvd, report });
    if (outcomes.device.ios?.status === 'failed' || outcomes.device.android?.status === 'failed') ok = false;
  }

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
      if (result.reason) {
        ok = false;
        report(chalk.yellow(`remote: ${result.reason}`));
      } else {
        clearRemoteSession(root, sessionId);
      }
    }
  }

  const tunnel = metroTunnel === undefined ? readMetroTunnel(root) : metroTunnel;
  let tunnelHolding: string | null = null;
  if (tunnel?.kind === 'managed') {
    const result = await stopMetroTunnel(tunnel);
    outcomes.metroTunnel = { status: result.status, provider: tunnel.provider, reason: result.reason };
    if (result.status === 'failed') {
      ok = false;
      tunnelHolding = result.reason ?? `could not stop the ${tunnel.provider} tunnel`;
      if (!stillHolding) stillHolding = tunnelHolding;
      report(chalk.red(`tunnel: ${tunnelHolding}`));
    } else {
      if (!clearManagedMetroTunnel(root, tunnel)) {
        tunnelHolding = 'a replacement managed tunnel record appeared during cleanup and remains active';
        stillHolding = stillHolding ?? tunnelHolding;
        ok = false;
        outcomes.metroTunnel = { status: 'failed', provider: tunnel.provider, reason: tunnelHolding };
        report(chalk.red(`tunnel: ${tunnelHolding}`));
      } else {
        report(
          chalk.dim(
            result.status === 'missing' ? 'tunnel: already gone' : `tunnel: stopped the ${tunnel.provider} tunnel`,
          ),
        );
      }
    }
  } else if (tunnel?.kind === 'expo') {
    outcomes.metroTunnel = { status: 'not-managed' };
  }

  outcomes.releasedLeases = releaseLeases(root);
  for (const lease of outcomes.releasedLeases) {
    report(chalk.dim(`leases: released the ${lease.platform} lease on ${lease.id} (it ran until ${lease.expiresAt})`));
  }

  if (stillHolding) {
    outcomes.port = { status: 'kept', port: reservedPort, reason: stillHolding };
    report(chalk.yellow(`port: keeping reservation ${reservedPort ?? '(none)'} -- ${stillHolding}`));
    const supervisorIsDown =
      outcomes.supervisor.status === 'none' ||
      outcomes.supervisor.status === 'already-stopped' ||
      outcomes.supervisor.status === 'stopped';
    if (tunnelHolding && supervisorIsDown) {
      clearState(root);
      await clearRegistration(root);
    }
  } else {
    if (reservedPort !== null) {
      freePort(root, reservedPort);
      outcomes.port = { status: 'freed', port: reservedPort };
      report(chalk.dim(`port: released ${reservedPort}`));
    }
    clearState(root);
    await clearRegistration(root);
    if (tunnel?.kind === 'expo') dropStateKeys(root, ['metroTunnel']);
  }

  return { ok, outcomes, summary: summarize(root, outcomes, ok) };
}

function reapCollectors(
  root: string,
  collectors: CollectorStateMap | null | undefined,
  {
    isAlive,
    signal,
    report,
    verify = verifyCollectorOwnership,
  }: {
    isAlive: (pid: number) => boolean;
    signal: (pid: number) => void;
    report: (line: string) => void;
    verify?: typeof verifyCollectorOwnership;
  },
): CollectorsOutcome {
  const targets = resolveCollectorTargets({ root, collectors, isAlive, verify });
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
    if (target.status === 'unverified') {
      entries.push({ platform: target.platform, pid: target.pid, status: 'unverified', reason: target.reason });
      report(chalk.yellow(`collectors: refusing to signal ${target.platform} pid ${target.pid}: ${target.reason}`));
      continue;
    }
    try {
      signal(target.pid as number);
      entries.push({ platform: target.platform, pid: target.pid, status: 'stopped' });
      report(chalk.green(`collectors: stopped ${target.platform} pid ${target.pid}`));
    } catch {
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
  const died = await waiter(target.pid as number);
  if (died) {
    report(chalk.green(`supervisor: stopped (pid ${target.pid})`));
    return { status: 'stopped', pid: target.pid, port: target.port ?? null, mode: target.mode ?? null };
  }
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

const OCCUPANCY_HINT = 'often a UI-test runner or device tool still attached';

function occupiedSkipReason(reason: string, holders: string[] | null | undefined): string {
  const named = (holders || []).filter(Boolean);
  return named.length ? `${reason} -- held by UI-test runner ${named.join(', ')}` : `${reason} -- ${OCCUPANCY_HINT}`;
}

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
  const iosUdid = ios?.deviceUdid as string | undefined;
  const iosName = ios?.deviceName as string | undefined;
  if (iosUdid) {
    if (!ios?.owned) {
      device.ios = {
        status: 'skipped',
        kind: 'not-owned',
        label: iosUdid,
        reason: 'Stim does not own this device',
      };
      report(chalk.dim(`ios: ${iosUdid} is not Stim-owned, leaving it running`));
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
        reason: 'Stim does not own this device',
      };
      report(chalk.dim(`android: ${android.avdName} is not Stim-owned, leaving it running`));
    } else {
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
  const unverified = outcomes.collectors.entries.filter((e) => e.status === 'unverified').length;
  if (unverified) parts.push(`${unverified} collector${unverified === 1 ? '' : 's'} left unsignalled`);
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
  if (outcomes.metroTunnel.status === 'stopped') parts.push(`${outcomes.metroTunnel.provider} tunnel stopped`);
  if (outcomes.metroTunnel.status === 'failed')
    parts.push(`${outcomes.metroTunnel.provider} tunnel could not be stopped`);
  for (const lease of outcomes.releasedLeases) parts.push(`${lease.platform} lease on ${lease.id} released`);
  const what = parts.length ? parts.join(', ') : 'nothing was running';
  return `${ok ? 'Stopped' : 'Stopped with problems'}: ${what} (${root})`;
}

function defaultFreePort(root: string, _port: number): void {
  if (!getProject(root)) return;
  upsertProject(root, { metroPort: null });
}

async function defaultClearRegistration(root: string): Promise<void> {
  try {
    clearSupervisor(root);
  } catch {}
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
        console.log(JSON.stringify({ root, ok, ...outcomes }));
      } else {
        console.log(ok ? chalk.green(summary) : chalk.yellow(summary));
      }
      if (!ok) process.exit(1);
    });
}
