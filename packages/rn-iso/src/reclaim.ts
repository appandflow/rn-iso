import { type ProjectRecord, getProject, removeProject } from './config.ts';
import { existsSync, rmSync } from 'node:fs';
import { resolveProjectMetro, killMetroTree, isPidAlive } from './metro.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from './teardown.ts';
import { readCollectors } from './collector/state.ts';
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
  removedWorkspaceDirs: string[];
  failedWorkspaceDirs: string[];
}

export async function reclaimProject(
  path: string,
  { deleteOwnedDevices = false }: { deleteOwnedDevices?: boolean } = {},
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
    removedWorkspaceDirs,
    failedWorkspaceDirs,
  };
}
