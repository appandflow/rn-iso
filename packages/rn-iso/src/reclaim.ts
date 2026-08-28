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

// End the remote session this workspace created, while the workspace still
// exists.
//
// TIMING IS THE WHOLE CONSTRAINT. The session id lives in global workspace
// state, and `eas simulator:stop` needs a project
// directory to run in (its contextDefinition includes ProjectDir). Both are
// gone the moment `git worktree remove` runs, so this must happen HERE, in
// the shared reclaim that precedes the caller's removal step -- not in the
// caller afterwards.
//
// Unlike a local simulator, a remote session is not occupancy-checked and is
// never spared: it bills until its max duration, and the project that owned
// it is going away.
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
    // Contained for the same reason every teardown here is: a throw would
    // abort the reclaim before the caller's removal step, and re-running
    // would hit it forever.
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

// End a tunnel `ios`/`android --remote` started for itself (a managed
// provider; engine/tunnel.ts), for the same timing reason reclaimRemoteSession
// runs here rather than in the caller: the record lives in the global
// workspace directory, which `worktree remove` deletes.
//
// Unconditional, like the remote session -- not gated by deleteOwnedDevices.
// That flag guards DESTROYING a local device, a real choice because a
// shut-down simulator can be booted again; a tunnel process left running here
// is simply leaked, since nothing else will ever reap it once its workspace
// is gone. An Expo-hosted tunnel (kind 'expo') has no process of its own: it
// dies with the expo child, which stopping the supervisor already ends.
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
    // Contained for the same reason every teardown here is: a throw would
    // abort the reclaim before the caller's removal step, and re-running
    // would hit it forever.
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
          'The ownership record is kept. Inspect the process and retry `rn-iso worktree remove`.',
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

// A device this function skipped or failed to tear down: reported alongside
// `deletedDevices` so a caller can tell what happened to every owned device,
// not just the ones that went cleanly.
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
  // The remote session this reclaim ended, if there was one.
  stoppedSession: string | null;
  // The managed tunnel (ngrok/cloudflared) this reclaim ended, if there was
  // one -- the provider name. null when there was none, or it was an
  // Expo-hosted tunnel with no process of its own.
  stoppedTunnel: string | null;
  removedWorkspaceDirs: string[];
  failedWorkspaceDirs: string[];
}

export async function reclaimProject(
  path: string,
  {
    deleteOwnedDevices = false,
    stopSession = defaultStopSession,
    stopMetroTunnel = defaultStopMetroTunnel,
  }: { deleteOwnedDevices?: boolean; stopSession?: StopSession; stopMetroTunnel?: StopMetroTunnelFn } = {},
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

  // Always, not only under deleteOwnedDevices. That flag guards DESTROYING a
  // local device, which is a real choice because a shut-down simulator can be
  // booted again. A remote session cannot be handed back: the workspace that
  // holds its id is going away, so the choice is between ending it now and
  // paying for it until its cap.
  const remote = reclaimRemoteSession(path, { stopSession });
  if (remote.failed) {
    skippedDevices.push(remote.failed);
    failedDevices.push(remote.failed);
  }

  // Same unconditional treatment for a tunnel this workspace started for
  // itself: it is not a local device deleteOwnedDevices guards, just a
  // process nothing else will ever reap once the workspace is gone.
  const tunnel = await reclaimMetroTunnel(path, { stopMetroTunnel });
  if (tunnel.failed) {
    skippedDevices.push(tunnel.failed);
    failedDevices.push(tunnel.failed);
  }

  // A Metro started from a deleted directory can outlive it and squat on the
  // port, so the port is not genuinely free until the process is gone. Killing
  // by port alone would repeat the Android console-port mistake, so identity is
  // proven first and an unidentified listener is reported, never killed.
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
  if (project && !keptEntry) removeProject(path);

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
