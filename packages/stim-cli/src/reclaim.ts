import { type ProjectRecord, getProject, removeProject } from './config.ts';
import { existsSync, rmSync } from 'node:fs';
import { resolveProjectMetro, killMetroTree, isPidAlive } from './metro.ts';
import { teardownOwnedIosSim, teardownOwnedAvd, type ParkedDevice, type ParkRequest } from './teardown.ts';
import { parkedMaxSetting } from './sim-pool.ts';
import { readCollectors } from './collector/state.ts';
import { verifyCollectorOwnership } from './collector/ownership.ts';
import { readProcessStartTime } from './process-args.ts';
import {
  clearManagedMetroTunnel,
  clearRemoteSession,
  readMetroTunnel,
  readRemoteSessionId,
  readWorkspaceState,
  type ManagedTunnelRecord,
} from './supervisor/state.ts';
import { endRecordedSession } from './engine/device-remote.ts';
import { releaseWorkspaceLeases, type ReleasedLease } from './engine/device-lease.ts';
import { resolveEasCliBin } from './engine/remote-cache.ts';
import { stopTunnel, type StopTunnelResult } from './engine/tunnel.ts';
import { workspaceDir } from './paths.ts';

// #183: fail closed toward "keep" for an unverified live pid unless its own start time proves
// it recycled the number. RECYCLED_PID_TOLERANCE_MS absorbs NTP steps and lstart's one-second
// truncation so a genuinely-ours collector never flips to "recycled" on a near-equal timestamp.
const RECYCLED_PID_TOLERANCE_MS = 5_000;

type StartTimeVerdict =
  | { recycled: true }
  | { recycled: false; cause: 'no-recorded-start' }
  | { recycled: false; cause: 'unreadable-live-start' }
  | { recycled: false; cause: 'started-at-or-before' };

function classifyPidAgainstRecord(
  recordedStartedAt: unknown,
  pid: number,
  readStartTime: (pid: number) => Date | null,
): StartTimeVerdict {
  if (typeof recordedStartedAt !== 'string') return { recycled: false, cause: 'no-recorded-start' };
  const recordedMs = Date.parse(recordedStartedAt);
  if (!Number.isFinite(recordedMs)) return { recycled: false, cause: 'no-recorded-start' };
  let liveStart: Date | null;
  try {
    liveStart = readStartTime(pid);
  } catch {
    liveStart = null;
  }
  if (!liveStart) return { recycled: false, cause: 'unreadable-live-start' };
  if (liveStart.getTime() > recordedMs + RECYCLED_PID_TOLERANCE_MS) return { recycled: true };
  return { recycled: false, cause: 'started-at-or-before' };
}

function keptReason(
  cause: 'no-recorded-start' | 'unreadable-live-start' | 'started-at-or-before',
  pid: number,
): string {
  if (cause === 'started-at-or-before') {
    return `it started at or before this record's startedAt, so it may still be ours; inspect it with \`ps -p ${pid}\` and retry`;
  }
  if (cause === 'unreadable-live-start') {
    return `pid ${pid}'s start time could not be read, so it may still be ours; inspect it with \`ps -p ${pid}\` and retry`;
  }
  return `this record has no usable startedAt to compare against, so pid ${pid} may still be ours; inspect it with \`ps -p ${pid}\` and retry`;
}

function reapCollectors(
  root: string,
  {
    verify = verifyCollectorOwnership,
    readStartTime = readProcessStartTime,
  }: {
    verify?: typeof verifyCollectorOwnership;
    readStartTime?: (pid: number) => Date | null;
  } = {},
): { skippedDevices: SkippedDevice[]; failedDevices: SkippedDevice[] } {
  const skippedDevices: SkippedDevice[] = [];
  const failedDevices: SkippedDevice[] = [];
  for (const [platform, record] of Object.entries(readCollectors(root))) {
    const rec = record as { pid?: unknown; startedAt?: unknown } | null;
    const pid = rec?.pid;
    if (typeof pid !== 'number' || pid <= 0 || pid === process.pid || !isPidAlive(pid)) continue;
    const ownership = verify({ pid, platform, root });
    if (ownership.status === 'gone') continue;
    if (ownership.status === 'unverified') {
      const name = `${platform} log collector (pid ${pid})`;
      const platformLabel = platform === 'android' ? 'android' : 'ios';
      const verdict = classifyPidAgainstRecord(rec?.startedAt, pid, readStartTime);
      if (verdict.recycled) {
        skippedDevices.push({
          platform: platformLabel,
          name,
          reason: `${ownership.reason}, so it was not signalled -- inspect it with \`ps -p ${pid}\``,
        });
      } else {
        const entry: SkippedDevice = {
          platform: platformLabel,
          name,
          reason: `${ownership.reason}, so it was not signalled -- ${keptReason(verdict.cause, pid)}`,
        };
        skippedDevices.push(entry);
        failedDevices.push(entry);
      }
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  return { skippedDevices, failedDevices };
}

// eas simulator:stop needs a project cwd, so end the session before removing the worktree.
function reclaimRemoteSession(
  root: string,
  { stopSession = defaultStopSession }: { stopSession?: StopSession } = {},
): { stopped: string | null; failed: SkippedDevice | null } {
  const sessionId = readRemoteSessionId(root);
  if (!sessionId) return { stopped: null, failed: null };
  let result: { status: 'torn-down' | 'failed'; reason?: string };
  try {
    result = stopSession(root, sessionId);
  } catch (err) {
    result = { status: 'failed', reason: String((err as Error)?.message ?? err) };
  }
  if (result.status === 'torn-down') {
    if (result.reason) {
      return {
        stopped: sessionId,
        failed: {
          platform: 'ios',
          name: `remote session ${sessionId}`,
          reason: `${result.reason} The session is stopped. Re-run cleanup to reconcile its retained ownership claim.`,
        },
      };
    }
    clearRemoteSession(root, sessionId);
    return { stopped: sessionId, failed: null };
  }
  return {
    stopped: null,
    failed: {
      platform: 'ios',
      name: `remote session ${sessionId}`,
      reason:
        `${result.reason ?? 'stop failed'} -- it keeps billing until its max duration. ` +
        `Stop it by hand from any directory of this project: eas simulator:stop --id ${sessionId}`,
    },
  };
}

type StopSession = (root: string, sessionId: string) => { status: 'torn-down' | 'failed'; reason?: string };

function defaultStopSession(root: string, sessionId: string) {
  return endRecordedSession({ root, sessionId, easBin: resolveEasCliBin(root)?.file ?? null });
}

type StopMetroTunnelFn = (record: ManagedTunnelRecord) => Promise<StopTunnelResult>;

function defaultStopMetroTunnel(record: ManagedTunnelRecord): Promise<StopTunnelResult> {
  return stopTunnel(record);
}

async function reclaimMetroTunnel(
  root: string,
  { stopMetroTunnel = defaultStopMetroTunnel }: { stopMetroTunnel?: StopMetroTunnelFn } = {},
): Promise<{ stopped: string | null; failed: SkippedDevice | null }> {
  const record = readMetroTunnel(root);
  if (record?.kind !== 'managed') return { stopped: null, failed: null };
  let result: StopTunnelResult;
  try {
    result = await stopMetroTunnel(record);
  } catch (err) {
    result = { status: 'failed', reason: String((err as Error)?.message ?? err) };
  }
  if (result.status === 'failed') {
    return {
      stopped: null,
      failed: {
        platform: 'ios',
        name: `${record.provider} tunnel (pid ${record.pid})`,
        reason:
          `${result.reason ?? 'stop failed'} The process identity could not be verified or the stop could not be confirmed. ` +
          'The ownership record is kept. Inspect the process and retry `stim worktree remove`.',
      },
    };
  }
  if (!clearManagedMetroTunnel(root, record)) {
    return {
      stopped: null,
      failed: {
        platform: 'ios',
        name: 'replacement managed tunnel',
        reason: 'A replacement managed tunnel record appeared during cleanup and is retained for a later stop.',
      },
    };
  }
  return { stopped: record.provider, failed: null };
}

interface SkippedDevice {
  platform: 'ios' | 'android';
  name: string;
  udid?: string;
  reason: string;
}

export function describeDereferenced(project: ProjectRecord | null): string[] {
  const devices: string[] = [];
  const ios = project?.platforms?.ios;
  if (ios?.deviceUdid) devices.push(`ios sim ${ios.deviceUdid}`);
  const android = project?.platforms?.android;
  if (android?.avdName) devices.push(`android avd ${android.avdName}`);
  else if (android?.serial) devices.push(`android device ${android.serial}`);
  return devices;
}

function parkRequest(project: ProjectRecord | null, projectPath: string): ParkRequest | undefined {
  const { max, error } = parkedMaxSetting('ios');
  if (error || max <= 0) return undefined;
  const lastBuild = readWorkspaceState(projectPath)?.lastBuild as { cacheKey?: unknown } | undefined;
  const cacheKey = typeof lastBuild?.cacheKey === 'string' ? lastBuild.cacheKey : null;
  return {
    projectPath,
    max,
    bundleId: typeof project?.bundleId === 'string' ? project.bundleId : null,
    cacheKey,
    simslimManaged: Boolean(project?.platforms?.ios?.simslimManaged),
  };
}

function reclaimOwnedDevices(
  project: ProjectRecord | null,
  projectPath: string,
  { park = false }: { park?: boolean } = {},
): {
  deletedDevices: string[];
  parkedDevices: ParkedDevice[];
  evictedDevices: ParkedDevice[];
  poolNotes: string[];
  skippedDevices: SkippedDevice[];
  failedDevices: SkippedDevice[];
} {
  const deletedDevices: string[] = [];
  const parkedDevices: ParkedDevice[] = [];
  const evictedDevices: ParkedDevice[] = [];
  const poolNotes: string[] = [];
  const skippedDevices: SkippedDevice[] = [];
  const failedDevices: SkippedDevice[] = [];

  const ios = project?.platforms?.ios;
  if (ios?.owned && ios.deviceUdid) {
    const udid = ios.deviceUdid as string;
    const label = (ios.deviceName as string | undefined) || udid;
    const r = teardownOwnedIosSim(udid, {
      del: true,
      label,
      ...(park ? { park: parkRequest(project, projectPath) } : {}),
    });
    if (r.parkFallback) poolNotes.push(`could not park ${label}: ${r.parkFallback} -- deleted it instead`);
    for (const failure of r.evictionFailures ?? []) poolNotes.push(failure);
    if (r.parked) {
      parkedDevices.push(r.parked);
      evictedDevices.push(...(r.evicted ?? []));
    } else if (r.status === 'torn-down') deletedDevices.push(r.label as string);
    if (r.status === 'skipped') {
      skippedDevices.push({ platform: 'ios', name: label, udid, reason: `${r.reason} -- not touched` });
    } else if (r.status === 'failed') {
      const entry: SkippedDevice = { platform: 'ios', name: label, udid, reason: `teardown failed: ${r.reason}` };
      skippedDevices.push(entry);
      failedDevices.push(entry);
    }
  }

  const android = project?.platforms?.android;
  if (android?.owned && android.avdName) {
    const r = teardownOwnedAvd(android.avdName, { del: true });
    if (r.status === 'torn-down') deletedDevices.push(android.avdName);
    else if (r.status === 'skipped') {
      skippedDevices.push({ platform: 'android', name: android.avdName, reason: `${r.reason} -- not touched` });
    } else if (r.status === 'failed') {
      const entry: SkippedDevice = {
        platform: 'android',
        name: android.avdName,
        reason: `teardown failed: ${r.reason}`,
      };
      skippedDevices.push(entry);
      failedDevices.push(entry);
    }
  }

  return { deletedDevices, parkedDevices, evictedDevices, poolNotes, skippedDevices, failedDevices };
}

export interface ReclaimResult {
  path: string;
  dereferenced: string[];
  killedPid: number | null;
  skippedMetro: string | null;
  metroPort: number | null;
  deletedDevices: string[];
  parkedDevices: ParkedDevice[];
  evictedDevices: ParkedDevice[];
  poolNotes: string[];
  skippedDevices: SkippedDevice[];
  failedDevices: SkippedDevice[];
  keptEntry: boolean;
  stoppedSession: string | null;
  stoppedTunnel: string | null;
  releasedLeases: ReleasedLease[];
  removedWorkspaceDirs: string[];
  failedWorkspaceDirs: string[];
}

export async function reclaimProject(
  path: string,
  {
    deleteOwnedDevices = false,
    parkOwnedDevices = false,
    preserveProjectRecord = false,
    stopSession = defaultStopSession,
    stopMetroTunnel = defaultStopMetroTunnel,
    releaseLeases = releaseWorkspaceLeases,
    verifyCollector = verifyCollectorOwnership,
    readCollectorStartTime = readProcessStartTime,
  }: {
    deleteOwnedDevices?: boolean;
    parkOwnedDevices?: boolean;
    preserveProjectRecord?: boolean;
    stopSession?: StopSession;
    stopMetroTunnel?: StopMetroTunnelFn;
    releaseLeases?: (root: string) => ReleasedLease[];
    verifyCollector?: typeof verifyCollectorOwnership;
    readCollectorStartTime?: (pid: number) => Date | null;
  } = {},
): Promise<ReclaimResult> {
  const project = getProject(path);
  const dereferenced = describeDereferenced(project);

  const { skippedDevices: skippedCollectors, failedDevices: failedCollectors } = reapCollectors(path, {
    verify: verifyCollector,
    readStartTime: readCollectorStartTime,
  });

  const { deletedDevices, parkedDevices, evictedDevices, poolNotes, skippedDevices, failedDevices } = deleteOwnedDevices
    ? reclaimOwnedDevices(project, path, { park: parkOwnedDevices })
    : {
        deletedDevices: [] as string[],
        parkedDevices: [] as ParkedDevice[],
        evictedDevices: [] as ParkedDevice[],
        poolNotes: [] as string[],
        skippedDevices: [] as SkippedDevice[],
        failedDevices: [] as SkippedDevice[],
      };
  skippedDevices.push(...skippedCollectors);
  failedDevices.push(...failedCollectors);

  const remote = reclaimRemoteSession(path, { stopSession });
  if (remote.failed) {
    skippedDevices.push(remote.failed);
    failedDevices.push(remote.failed);
  }

  const tunnel = await reclaimMetroTunnel(path, { stopMetroTunnel });
  if (tunnel.failed) {
    skippedDevices.push(tunnel.failed);
    failedDevices.push(tunnel.failed);
  }

  let releasedLeases: ReleasedLease[] = [];
  try {
    releasedLeases = releaseLeases(path);
  } catch {
    releasedLeases = [];
  }

  let killedPid: number | null = null;
  let skippedMetro: string | null = null;
  if (typeof project?.metroPort === 'number') {
    const resolution = await resolveProjectMetro(project.metroPort, path);
    if (resolution.metro) {
      killedPid = killMetroTree(resolution.metro.leader, resolution.metro.pid) ? resolution.metro.pid : null;
      if (killedPid === null) skippedMetro = `could not kill pid ${resolution.metro.pid}`;
    } else if (resolution.notOurs) {
      skippedMetro = resolution.notOurs;
    }
  }

  const removedWorkspaceDirs: string[] = [];
  const failedWorkspaceDirs: string[] = [];
  if (failedDevices.length === 0) {
    const dir = workspaceDir(path);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removedWorkspaceDirs.push(dir);
      } catch {
        failedWorkspaceDirs.push(dir);
      }
    }
  }

  const keptEntry = failedDevices.length > 0 || failedWorkspaceDirs.length > 0;
  if (project && !keptEntry && !preserveProjectRecord) removeProject(path);

  return {
    path,
    dereferenced,
    killedPid,
    skippedMetro,
    metroPort: project?.metroPort ?? null,
    deletedDevices,
    parkedDevices,
    evictedDevices,
    poolNotes,
    skippedDevices,
    failedDevices,
    keptEntry,
    stoppedSession: remote.stopped,
    stoppedTunnel: tunnel.stopped,
    releasedLeases,
    removedWorkspaceDirs,
    failedWorkspaceDirs,
  };
}
