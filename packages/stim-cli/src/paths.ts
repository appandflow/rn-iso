import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'path';
import { workspaceName, workspaceStateDir as workspaceDir } from '@stim-cli/core';
import { getConfigDir } from './config.ts';
import { withDirLock } from './dir-lock.ts';

export {
  buildCacheRoot as sharedBuildCache,
  metroCacheRoot as sharedMetroCache,
  workspaceId,
  workspaceSlug,
} from '@stim-cli/core';
export { workspaceName, workspaceDir };

const WORKSPACE_METADATA_FILE_NAME = 'workspace.json';

export function workspaceMetadataFile(projectRoot: string): string {
  return join(workspaceDir(projectRoot), WORKSPACE_METADATA_FILE_NAME);
}

interface WorkspaceMetadata {
  projectRoot: string;
  workspace: string;
  version: 1;
}

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
    } catch {}
    const error = new Error(
      `Stim workspace collision at ${dir}: its workspace.json does not belong to ${canonicalRoot}.`,
    ) as Error & { code?: string };
    error.code = 'STIM_WORKSPACE_COLLISION';
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

export function workspaceStateLock(projectRoot: string): string {
  return join(workspaceDir(projectRoot), 'state.lock');
}

export function supervisorLogFile(projectRoot: string): string {
  return join(workspaceLogsDir(projectRoot), 'supervisor.log');
}

export function emulatorLogFile(projectRoot: string): string {
  return join(workspaceLogsDir(projectRoot), 'emulator.log');
}

export function sharedCompilationCache(): string {
  return join(getConfigDir(), 'compilation-cache');
}

export function sharedCcache(): string {
  return join(getConfigDir(), 'ccache');
}

export function sharedGradle(): string {
  return join(getConfigDir(), 'gradle');
}

export function sharedPods(): string {
  return join(getConfigDir(), 'pods');
}
