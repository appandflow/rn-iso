// The single source of truth for every path rn-iso writes.
//
// The rule that decides which half a path belongs in: CONTENT-ADDRESSED
// artifacts are shared, LOCATION-ADDRESSED artifacts are workspace-local. A
// build cache entry keyed on a fingerprint is meaningful to any workspace on
// the same commit, so it is shared. A DerivedData tree is meaningful only to
// the checkout that produced it, so it lives inside that checkout and dies
// with it -- which is what removes the need to ever reverse-map a global
// build directory back to a workspace.
//
// Pure: nothing here creates a directory. Callers mkdir when they write.
import { join } from 'path';
import { getConfigDir } from './config.js';

export const WORKSPACE_DIR_NAME = '.rn-iso';

export function workspaceDir(projectRoot) {
  return join(projectRoot, WORKSPACE_DIR_NAME);
}

export function workspaceLogsDir(projectRoot) {
  return join(workspaceDir(projectRoot), 'logs');
}

export function workspaceDerivedData(projectRoot) {
  return join(workspaceDir(projectRoot), 'derived-data');
}

export function workspaceGradleBuild(projectRoot) {
  return join(workspaceDir(projectRoot), 'gradle-build');
}

export function supervisorPidFile(projectRoot) {
  return join(workspaceDir(projectRoot), 'supervisor.pid');
}

export function workspaceStateFile(projectRoot) {
  return join(workspaceDir(projectRoot), 'state.json');
}

// Shared caches derive from getConfigDir() rather than homedir() so that
// RN_ISO_HOME redirects them along with the registry, which is what lets a
// test run against a temp directory without touching the real machine.
export function sharedMetroCache() {
  return join(getConfigDir(), 'metro-cache');
}

export function sharedBuildCache() {
  return join(getConfigDir(), 'build-cache');
}

export function sharedCompilationCache() {
  return join(getConfigDir(), 'compilation-cache');
}

export function sharedGradle() {
  return join(getConfigDir(), 'gradle');
}

export function sharedPods() {
  return join(getConfigDir(), 'pods');
}
