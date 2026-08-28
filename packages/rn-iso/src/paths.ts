// The single source of truth for every path rn-iso writes.
//
// The rule that decides which half a path belongs in: CONTENT-ADDRESSED
// artifacts are shared across workspaces, while LOCATION-ADDRESSED artifacts
// get one directory per canonical project path. Both live under RN_ISO_HOME;
// rn-iso never writes generated state into the project it is operating on.
//
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'path';
import {
  buildCacheRoot,
  metroCacheRoot,
  workspaceId as coreWorkspaceId,
  workspaceName as coreWorkspaceName,
  workspaceSlug as coreWorkspaceSlug,
  workspaceStateDir,
} from '@rn-iso/core';
import { getConfigDir } from './config.ts';
import { withDirLock } from './dir-lock.ts';

const WORKSPACE_METADATA_FILE_NAME = 'workspace.json';

export function workspaceSlug(projectRoot: string): string {
  return coreWorkspaceSlug(projectRoot);
}

export function workspaceId(projectRoot: string): string {
  return coreWorkspaceId(projectRoot);
}

export function workspaceName(projectRoot: string): string {
  return coreWorkspaceName(projectRoot);
}

export function workspaceDir(projectRoot: string): string {
  return workspaceStateDir(projectRoot);
}

export function workspaceMetadataFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), WORKSPACE_METADATA_FILE_NAME);
}

interface WorkspaceMetadata {
  projectRoot: string;
  workspace: string;
  version: 1;
}

// The one impure path helper. Commands call this before their first write so
// every global workspace directory says which canonical project path owns it.
// The digest collision check fails closed rather than letting two projects
// share state. Temp+rename keeps concurrent starts from exposing partial JSON.
export function ensureWorkspaceStorage(projectRoot: string): string {
  const canonicalRoot = resolve(projectRoot);
  const dir = workspaceDir(canonicalRoot);
  const file = workspaceMetadataFile(canonicalRoot);
  mkdirSync(dir, { recursive: true });
  return withDirLock(join(dir, 'metadata.lock'), () => {
    if (!existsSync(file)) {
      const metadata: WorkspaceMetadata = {
        projectRoot: canonicalRoot,
        workspace: workspaceName(canonicalRoot),
        version: 1,
      };
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(metadata, null, 2)}\n`);
      try {
        renameSync(tmp, file);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
      return dir;
    }
    try {
      const current = JSON.parse(readFileSync(file, 'utf-8')) as Partial<WorkspaceMetadata>;
      if (current.projectRoot === canonicalRoot) return dir;
    } catch {
      // An unreadable ownership record is not safe to overwrite.
    }
    const error = new Error(
      `rn-iso workspace collision at ${dir}: its workspace.json does not belong to ${canonicalRoot}.`,
    ) as Error & { code?: string };
    error.code = 'RN_ISO_WORKSPACE_COLLISION';
    throw error;
  });
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

// The emulator's own stdout/stderr, raw rather than NDJSON, for the same
// reason supervisorLogFile exists: an emulator that refuses to start says so
// immediately and then exits, and with its stdio dropped that line was gone.
// TRUNCATED per boot (the supervisor's is appended), because a boot's log
// describes that boot -- the same doctrine as the per-run build transcript.
// NOT .ndjson, so the k-way merge in logs-query never tries to parse it.
export function emulatorLogFile(projectRoot: string): string {
  return join(workspaceLogsDir(projectRoot), 'emulator.log');
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
// already set reads as an empty cache rather than as an error. Next comes the
// machine config (`caches.buildCache` / `caches.metroCache` in
// <configDir>/config.json -- same no-CLI, config-plus-env pattern as the
// concurrency limits), which every process finds regardless of shell profile;
// the default layout under the config dir is last.

export function sharedMetroCache(name?: string | null): string {
  return metroCacheRoot(name);
}

export function sharedBuildCache(): string {
  return buildCacheRoot();
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
