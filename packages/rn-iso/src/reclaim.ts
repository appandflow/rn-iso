import { type ProjectRecord, getProject, removeProject } from './config.ts';
import { resolveProjectMetro, killMetroTree, isPidAlive } from './metro.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from './teardown.ts';
import { readCollectors } from './collector/state.ts';

// Stop this workspace's device-log collectors. Their record in state.json is
// the only thing that names them, so they must be reaped before the entry (and,
// for `worktree remove`, the whole tree) is removed: a collector left running
// leaks, and its own exit path rewrites state.json -- resurrecting a zombie
// `.rn-iso` under a directory that was just deleted. `stop` reaps them the same
// way; the shared reclaim path did not, relying on device teardown to end the
// `log stream` / `logcat` indirectly, which a failed or already-stopped device
// does not do.
function reapCollectors(root: string): void {
  for (const record of Object.values(readCollectors(root))) {
    const pid = (record as { pid?: unknown } | null)?.pid;
    if (typeof pid !== 'number' || pid === process.pid || !isPidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone between the read and the signal */
    }
  }
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

// The devices this project's entry stops referencing. Dropping the reference
// is all that happens to them here: destroying a device is the separate,
// opt-in `deleteOwnedDevices` path, and what it destroys is reported as
// `deletedDevices`. So callers must describe this list as de-referenced, not
// as freed hardware.
export function describeDereferenced(project: ProjectRecord | null): string[] {
  const devices: string[] = [];
  const ios = project?.platforms?.ios;
  if (ios?.deviceUdid) devices.push(`ios sim ${ios.deviceUdid}`);
  const android = project?.platforms?.android;
  if (android?.avdName) devices.push(`android avd ${android.avdName}`);
  else if (android?.serial) devices.push(`android device ${android.serial}`);
  return devices;
}

// Shut down + delete a project's owned devices. Only records with
// `owned: true` are touched -- the device-level name-prefix guards inside
// deleteIosSim/deleteAvd are a backstop, not the primary gate. iOS is
// resolved against the live sim list BEFORE any command is issued at it
// (resolveOwnedIosSim): a udid that no longer names an rn-iso-owned sim
// (renamed by the user, or a stale/mistyped record) must never be shut
// down, only reported as a skip -- shutting it down first and only
// catching the mismatch at delete time would already have hit whatever
// real simulator that udid resolves to. A device that is being deleted is
// not occupancy-checked: it goes away even while a foreign UI-test runner
// is attached, so the only skip reported here is a device rn-iso does not
// own.
//
// Each device's teardown is wrapped in its own try/catch: an exec throw
// (emulator not on PATH so listAvds() throws, or a guard throwing) must
// never propagate out of here. A propagated throw would abort the whole
// reclaim before the caller's removal step (e.g. `git worktree remove`)
// ever runs, and re-running would hit the same throw forever. A failed
// teardown is recorded with its reason instead, and the loop (and the
// caller's removal) always proceeds.
function reclaimOwnedDevices(project: ProjectRecord | null): {
  deletedDevices: string[];
  skippedDevices: SkippedDevice[];
  failedDevices: SkippedDevice[];
} {
  const deletedDevices: string[] = [];
  const skippedDevices: SkippedDevice[] = [];
  // Devices whose delete FAILED, so they are still on the machine.
  const failedDevices: SkippedDevice[] = [];

  const ios = project?.platforms?.ios;
  if (ios?.owned && ios.deviceUdid) {
    // `deviceUdid` / `deviceName` reach DeviceRecord's index signature rather
    // than a declared field, hence the casts: both are strings wherever this
    // codebase writes them.
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
    // 'missing' is already gone: nothing to shut down, delete, or report.
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

// Drop a project's rn-iso state and, optionally, its owned devices. Shared by
// `gc` and `worktree remove` so the two cannot drift.
//
// There is no build-output step here any more. Build output lives inside the
// workspace (`<root>/.rn-iso/`), so it is reclaimed by whatever removes the
// directory itself and never needs to be found by reverse-mapping a global
// DerivedData tree back to a project.
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
}

export async function reclaimProject(
  path: string,
  { deleteOwnedDevices = false }: { deleteOwnedDevices?: boolean } = {},
): Promise<ReclaimResult> {
  const project = getProject(path);
  const dereferenced = describeDereferenced(project);

  // Reap collectors first: they hold the device open via `log stream`/`logcat`,
  // and their state.json record is about to be removed.
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

  // A device whose delete FAILED is still on the machine, and this entry is
  // the only record naming it. Dropping the entry here is what turns a failed
  // teardown into a simulator nothing references, so the entry stays and the
  // caller reports it as still tracked.
  const keptEntry = failedDevices.length > 0;
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
  };
}
