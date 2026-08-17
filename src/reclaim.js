import { rmSync } from 'fs';
import { getProject, removeProject } from './config.js';
import { findPidListeningOnPort } from './metro.js';
import { directorySize, findDerivedDataFor } from './artifacts.js';
import { isSimOccupied, listAllIosSims, shutdownIosSim, deleteIosSim } from './sim/ios.js';
import { listAvds, shutdownAndroidEmulator, deleteAvd } from './sim/android.js';

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
// deleteIosSim/deleteAvd are a backstop, not the primary gate. iOS gets an
// occupancy check first (a foreign UI-test runner may still be attached);
// there is no equivalent Android probe, so owned AVDs are always reclaimed.
// An occupied owned sim is left alone -- its deletion is deferred to `gc`
// once whatever is using it lets go -- and reported back as skipped rather
// than deleted.
function reclaimOwnedDevices(project) {
  const deletedDevices = [];
  const skippedDevices = [];

  const ios = project?.platforms?.ios;
  if (ios?.owned && ios.deviceUdid) {
    const label = ios.deviceName || ios.deviceUdid;
    if (isSimOccupied(ios.deviceUdid)) {
      skippedDevices.push({ platform: 'ios', name: label, reason: 'in use by another process (occupied)' });
    } else {
      // Check existence before the (idempotent, no-op-on-missing) delete so
      // the report is honest: a sim that is already gone was not "deleted"
      // just now.
      const existed = listAllIosSims().some(s => s.udid === ios.deviceUdid);
      shutdownIosSim(ios.deviceUdid);
      deleteIosSim(ios.deviceUdid);
      if (existed) deletedDevices.push(label);
    }
  }

  const android = project?.platforms?.android;
  if (android?.owned && android.avdName) {
    const existed = listAvds().includes(android.avdName);
    if (typeof android.consolePort === 'number') {
      shutdownAndroidEmulator(`emulator-${android.consolePort}`);
    }
    deleteAvd(android.avdName);
    if (existed) deletedDevices.push(android.avdName);
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
