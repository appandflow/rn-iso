import { type ProjectRecord, getProject, removeProject } from './config.ts';
import { existsSync, rmSync } from 'node:fs';
import { resolveProjectMetro, killMetroTree, isPidAlive } from './metro.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from './teardown.ts';
import { readCollectors } from './collector/state.ts';
import {
  clearManagedMetroTunnel,
  clearRemoteSession,
  readMetroTunnel,
  readRemoteSessionId,
  type ManagedTunnelRecord,
} from './supervisor/state.ts';
import { endRecordedSession } from './engine/device-remote.ts';
import { resolveEasCliBin } from './engine/remote-cache.ts';
import { stopTunnel, type StopTunnelResult } from './engine/tunnel.ts';
import { workspaceDir } from './paths.ts';

function reapCollectors(root: string): void {
  for (const record of Object.values(readCollectors(root))) {
    const pid = (record as { pid?: unknown } | null)?.pid;
    if (typeof pid !== 'number' || pid <= 0 || pid === process.pid || !isPidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
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

function reclaimOwnedDevices(project: ProjectRecord | null): {
  deletedDevices: string[];
  skippedDevices: SkippedDevice[];
  failedDevices: SkippedDevice[];
} {
  const deletedDevices: string[] = [];
  const skippedDevices: SkippedDevice[] = [];
  const failedDevices: SkippedDevice[] = [];

  const ios = project?.platforms?.ios;
  if (ios?.owned && ios.deviceUdid) {
    const udid = ios.deviceUdid as string;
    const label = (ios.deviceName as string | undefined) || udid;
    const r = teardownOwnedIosSim(udid, { del: true, label });
    if (r.status === 'torn-down') deletedDevices.push(r.label as string);
    else if (r.status === 'skipped') {
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

  return { deletedDevices, skippedDevices, failedDevices };
}

export interface ReclaimResult {
  path: string;
  dereferenced: string[];
  killedPid: number | null;
  skippedMetro: string | null;
  metroPort: number | null;
  deletedDevices: string[];
  skippedDevices: SkippedDevice[];
  failedDevices: SkippedDevice[];
  keptEntry: boolean;
  stoppedSession: string | null;
  stoppedTunnel: string | null;
  removedWorkspaceDirs: string[];
  failedWorkspaceDirs: string[];
}

export async function reclaimProject(
  path: string,
  {
    deleteOwnedDevices = false,
    preserveProjectRecord = false,
    stopSession = defaultStopSession,
    stopMetroTunnel = defaultStopMetroTunnel,
  }: {
    deleteOwnedDevices?: boolean;
    preserveProjectRecord?: boolean;
    stopSession?: StopSession;
    stopMetroTunnel?: StopMetroTunnelFn;
  } = {},
): Promise<ReclaimResult> {
  const project = getProject(path);
  const dereferenced = describeDereferenced(project);

  reapCollectors(path);

  const {
    deletedDevices,
    skippedDevices,
    failedDevices,
  }: {
    deletedDevices: string[];
    skippedDevices: SkippedDevice[];
    failedDevices: SkippedDevice[];
  } = deleteOwnedDevices ? reclaimOwnedDevices(project) : { deletedDevices: [], skippedDevices: [], failedDevices: [] };

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
    skippedDevices,
    failedDevices,
    keptEntry,
    stoppedSession: remote.stopped,
    stoppedTunnel: tunnel.stopped,
    removedWorkspaceDirs,
    failedWorkspaceDirs,
  };
}
