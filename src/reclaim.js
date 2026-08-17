import { rmSync } from 'fs';
import { getProject, removeProject } from './config.js';
import { findPidListeningOnPort } from './metro.js';
import { directorySize, findDerivedDataFor } from './artifacts.js';
import { isSimOccupied, resolveOwnedIosSim, shutdownIosSim, deleteIosSim } from './sim/ios.js';
import { resolveOwnedAvdSerial, shutdownAndroidEmulator, deleteAvd } from './sim/android.js';

export function describeFreed(project) {
  const freed = [];
  const ios = project?.platforms?.ios;
  if (ios?.deviceUdid) freed.push(`ios sim ${ios.deviceUdid}`);
  const android = project?.platforms?.android;
  if (android?.avdName) freed.push(`android avd ${android.avdName}`);
  else if (android?.serial) freed.push(`android device ${android.serial}`);
  return freed;
}

// Shut down + delete a project's owned devices. Only records with
// `owned: true` are touched -- the device-level name-prefix guards inside
// deleteIosSim/deleteAvd are a backstop, not the primary gate. iOS is
// resolved against the live sim list BEFORE any command is issued at it
// (resolveOwnedIosSim): a udid that no longer names an rn-iso-owned sim
// (renamed by the user, or a stale/mistyped record) must never be shut
// down, only reported as a skip -- shutting it down first and only
// catching the mismatch at delete time would already have hit whatever
// real simulator that udid resolves to. iOS also gets an occupancy check
// (a foreign UI-test runner may still be attached); there is no equivalent
// Android probe, so owned AVDs are always reclaimed. An occupied owned sim
// is left alone -- its deletion is deferred to `gc` once whatever is using
// it lets go -- and reported back as skipped rather than deleted.
//
// Each device's teardown is wrapped in its own try/catch: an exec throw
// (emulator not on PATH so listAvds() throws, or a guard throwing) must
// never propagate out of here. A propagated throw would abort the whole
// reclaim before the caller's removal step (e.g. `git worktree remove`)
// ever runs, and re-running would hit the same throw forever. A failed
// teardown is recorded as a skip with its reason instead, and the loop
// (and the caller's removal) always proceeds.
function reclaimOwnedDevices(project) {
  const deletedDevices = [];
  const skippedDevices = [];

  const ios = project?.platforms?.ios;
  if (ios?.owned && ios.deviceUdid) {
    const label = ios.deviceName || ios.deviceUdid;
    try {
      const resolved = resolveOwnedIosSim(ios.deviceUdid);
      if (resolved.notOwned) {
        skippedDevices.push({
          platform: 'ios',
          name: label,
          udid: ios.deviceUdid,
          reason: `sim is now named "${resolved.notOwned}", not rn-iso-owned -- not touched`,
        });
      } else if (resolved.missing) {
        // Already gone: nothing to shut down or delete, and not a failure.
      } else if (isSimOccupied(ios.deviceUdid)) {
        skippedDevices.push({ platform: 'ios', name: label, udid: ios.deviceUdid, reason: 'in use by another process (occupied)' });
      } else {
        shutdownIosSim(ios.deviceUdid);
        deleteIosSim(ios.deviceUdid);
        deletedDevices.push(label);
      }
    } catch (e) {
      skippedDevices.push({ platform: 'ios', name: label, udid: ios.deviceUdid, reason: `teardown failed: ${String(e?.message || e)}` });
    }
  }

  const android = project?.platforms?.android;
  if (android?.owned && android.avdName) {
    try {
      // Verify identity against the LIVE adb list before shutting anything
      // down: the recorded consolePort is a slot, not an identity, and may
      // now be held by a foreign emulator (see resolveOwnedAvdSerial).
      const resolved = resolveOwnedAvdSerial(android.avdName, android.consolePort);
      if (resolved.notOwned) {
        skippedDevices.push({
          platform: 'android',
          name: android.avdName,
          reason: 'AVD name is not rn-iso-owned by name -- not touched',
        });
      } else if (resolved.missing) {
        // Already gone: nothing to shut down or delete, and not a failure.
      } else {
        if (resolved.serial) shutdownAndroidEmulator(resolved.serial);
        deleteAvd(android.avdName);
        deletedDevices.push(android.avdName);
      }
    } catch (e) {
      skippedDevices.push({ platform: 'android', name: android.avdName, reason: `teardown failed: ${String(e?.message || e)}` });
    }
  }

  return { deletedDevices, skippedDevices };
}

// Drop a project's rn-iso state and, optionally, its external build output
// and its owned devices. Shared by `prune`, `gc`, and `worktree remove` so
// the three cannot drift.
//
// Callers who also delete the project directory itself (e.g. `worktree
// remove`) must call this first: findDerivedDataFor matches on WorkspacePath
// prefixes, which only resolve while the project directory still exists.
export function reclaimProject(path, { deleteArtifacts = false, deleteOwnedDevices = false } = {}) {
  const project = getProject(path);
  const freed = describeFreed(project);

  const artifacts = findDerivedDataFor(path).map(entry => ({
    dir: entry.dir,
    bytes: directorySize(entry.dir),
  }));

  if (deleteArtifacts) {
    for (const artifact of artifacts) {
      rmSync(artifact.dir, { recursive: true, force: true });
    }
  }

  const { deletedDevices, skippedDevices } = deleteOwnedDevices
    ? reclaimOwnedDevices(project)
    : { deletedDevices: [], skippedDevices: [] };

  // A Metro started from a deleted directory can outlive it and squat on the
  // port, so the port is not genuinely free until the process is gone.
  let killedPid = null;
  if (typeof project?.metroPort === 'number') {
    const pid = findPidListeningOnPort(project.metroPort);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        killedPid = pid;
      } catch {
        killedPid = null;
      }
    }
  }

  if (project) removeProject(path);

  return {
    path,
    freed,
    artifacts,
    killedPid,
    metroPort: project?.metroPort ?? null,
    deletedDevices,
    skippedDevices,
  };
}
