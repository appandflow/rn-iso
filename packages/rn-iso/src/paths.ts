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

export function workspaceDir(projectRoot: string): string {
  return join(projectRoot, WORKSPACE_DIR_NAME);
}

export function workspaceLogsDir(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'logs');
}

export function workspaceDerivedData(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'derived-data');
}

export function workspaceGradleBuild(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'gradle-build');
}

export function supervisorPidFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'supervisor.pid');
}

export function workspaceStateFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'state.json');
}

// The advisory lock guarding state.json's multi-writer read-modify-write (the
// supervisor, each collector, and ios/android's lastBuild all patch this one
// file). mkdir-mtime, like the config lock -- these writes are milliseconds, so
// the staleness guard is age, not pid-liveness. See src/dir-lock.js.
export function workspaceStateLock(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'state.lock');
}

// The supervisor's own stdio, raw rather than NDJSON: it is what a spawn that
// died before it could write a single structured record leaves behind, so it
// is the one file `start` quotes when a supervisor never comes up.
export function supervisorLogFile(projectRoot: string): string {
  return join(workspaceLogsDir(projectRoot), 'supervisor.log');
}

// Shared caches derive from getConfigDir() rather than homedir() so that
// RN_ISO_HOME redirects them along with the registry, which is what lets a
// test run against a temp directory without touching the real machine.
//
// THE TWO CACHE ROOTS BELOW EXIST THREE TIMES. The copies are in
// packages/metro/index.js and packages/expo-build-cache/index.js, which
// cannot import this module: both have to work on a machine with no rn-iso
// installed at all. Change one and you must change all three, or the CLI stores
// a build in one directory while the provider looks for it in another and
// neither says so. test/cache-packages.test.js is what holds them together.
// CLAUDE.md records the same rule for buildCacheKey.
//
// RN_ISO_BUILD_CACHE / RN_ISO_METRO_CACHE come first in all three: both were
// honoured before this layout existed, and quietly ignoring an override someone
// already set reads as an empty cache rather than as an error.

// A name only distinguishes one app's Metro cache from another's. Metro keys
// entries by content, so one store shared between unrelated projects would be
// correct but pointlessly large. Anything that is not a plain path segment is
// replaced, and leading dots go, so a scoped package name cannot climb out of
// the cache root.
function cacheNameSegment(name: string | null | undefined): string {
  return (
    String(name)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^\.+/, '') || 'app'
  );
}

export function sharedMetroCache(name?: string | null): string {
  if (process.env.RN_ISO_METRO_CACHE) return process.env.RN_ISO_METRO_CACHE;
  const root = join(getConfigDir(), 'metro-cache');
  return name === undefined || name === null || name === '' ? root : join(root, cacheNameSegment(name));
}

export function sharedBuildCache(): string {
  return process.env.RN_ISO_BUILD_CACHE || join(getConfigDir(), 'build-cache');
}

export function sharedCompilationCache(): string {
  return join(getConfigDir(), 'compilation-cache');
}

export function sharedGradle(): string {
  return join(getConfigDir(), 'gradle');
}

export function sharedPods(): string {
  return join(getConfigDir(), 'pods');
}
