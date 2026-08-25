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
import { basename, dirname, join } from 'path';
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
//
// THE TWO CACHE ROOTS BELOW EXIST THREE TIMES. The copies are in
// packages/metro-cache/index.js and packages/expo-build-cache/index.js, which
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
function cacheNameSegment(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '') || 'app';
}

export function sharedMetroCache(name) {
  if (process.env.RN_ISO_METRO_CACHE) return process.env.RN_ISO_METRO_CACHE;
  const root = join(getConfigDir(), 'metro-cache');
  return name === undefined || name === null || name === '' ? root : join(root, cacheNameSegment(name));
}

export function sharedBuildCache() {
  return process.env.RN_ISO_BUILD_CACHE || join(getConfigDir(), 'build-cache');
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

// --- where the caches used to live ------------------------------------
//
// Nothing reads a cache from these any more. They exist so `init` can rename
// one into place and `doctor` can report one that is still sitting there: they
// run to many GB, and stranding one costs the disk twice AND a cold rebuild in
// every project on the machine.
//
// The build cache is expressed as the SIBLING of the config dir rather than as
// a literal ~/.rn-iso-build-cache. In production the two are the same thing --
// getConfigDir() is ~/.rn-iso -- but it also means RN_ISO_HOME sandboxes the
// whole migration, so a test or a dry run can never reach the real one.
export function legacyBuildCache() {
  return join(dirname(getConfigDir()), '.rn-iso-build-cache');
}

// The Metro half cannot be derived the same way: the old directory was named
// after the app (`~/.<name>-metro-cache`), so the only record of where it
// actually is comes from the cache manifest. This maps such a directory back to
// the name, and returns null for anything that is not one.
const LEGACY_METRO_DIR = /^\.(.+)-metro-cache$/;

export function legacyMetroCacheName(dir) {
  const m = LEGACY_METRO_DIR.exec(basename(String(dir || '')));
  return m ? m[1] : null;
}

// The `name` @rn-iso/metro-cache registers itself under. A hand-wired FileStore
// registered through `rn-iso/cache-manifest` carries whatever name its owner
// chose, and must never be moved: its metro.config.js still points at the old
// directory, so moving it would take away a cache nothing knows how to find.
export const METRO_CACHE_REGISTRATION_NAME = 'Metro transform cache';
