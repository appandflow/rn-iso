import { rmSync } from 'fs';
import { getProject, removeProject } from './config.js';
import { findPidListeningOnPort } from './metro.js';
import { directorySize, findDerivedDataFor } from './artifacts.js';

export function describeFreed(project) {
  const freed = [];
  const ios = project?.platforms?.ios;
  if (ios?.deviceUdid) freed.push(`ios sim ${ios.deviceUdid}`);
  const android = project?.platforms?.android;
  if (android?.avdName) freed.push(`android avd ${android.avdName}`);
  else if (android?.serial) freed.push(`android device ${android.serial}`);
  return freed;
}

// Drop a project's rn-iso state and, optionally, its external build output.
// Shared by `prune`, `gc`, and `worktree remove` so the three cannot drift.
//
// Callers who also delete the project directory itself (e.g. `worktree
// remove`) must call this first: findDerivedDataFor matches on WorkspacePath
// prefixes, which only resolve while the project directory still exists.
export function reclaimProject(path, { deleteArtifacts = false } = {}) {
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

  return { path, freed, artifacts, killedPid, metroPort: project?.metroPort ?? null };
}
