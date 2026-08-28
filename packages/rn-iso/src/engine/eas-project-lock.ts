import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getConfigDir } from '../config.ts';
import { gitCommonDir } from '../worktree.ts';
import { withWorkspaceProcessLock, type WorkspaceProcessLockOptions } from './workspace-process-lock.ts';

const EAS_PROJECT_LOCK_WAIT_MS = 4 * 60_000;

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function staticEasProjectId(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'app.json'), 'utf-8')) as Record<string, unknown>;
    const config = parsed.expo && typeof parsed.expo === 'object' ? (parsed.expo as Record<string, unknown>) : parsed;
    const extra = config.extra;
    if (!extra || typeof extra !== 'object') return null;
    const eas = (extra as Record<string, unknown>).eas;
    if (!eas || typeof eas !== 'object') return null;
    const projectId = (eas as Record<string, unknown>).projectId;
    return typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null;
  } catch {
    return null;
  }
}

function easProjectLockRoots(root: string): string[] {
  const projectId = staticEasProjectId(root);
  // Dynamic Expo configs cannot be evaluated without running project code.
  // The Git common directory lock serializes every worktree in the repo.
  // The project ID lock also serializes separate checkouts with the same ID.
  const commonDir = gitCommonDir(root);
  const scopes = commonDir
    ? [`git-repository:${canonicalPath(commonDir)}`, ...(projectId ? [`eas-project:${projectId}`] : [])]
    : projectId
      ? [`eas-project:${projectId}`]
      : [`project-root:${canonicalPath(root)}`];
  return [
    ...new Set(
      scopes.map((scope) => {
        const key = createHash('sha256').update(scope).digest('hex');
        return join(getConfigDir(), 'process-locks', 'eas-projects', key);
      }),
    ),
  ].toSorted();
}

export function withEasProjectLock<T>(
  root: string,
  fn: () => Promise<T>,
  options: WorkspaceProcessLockOptions = {},
): Promise<T> {
  const lockRoots = easProjectLockRoots(root);
  const acquire = (index: number): Promise<T> => {
    const lockRoot = lockRoots[index];
    if (!lockRoot) return fn();
    return withWorkspaceProcessLock(lockRoot, 'eas-project', () => acquire(index + 1), {
      waitMs: EAS_PROJECT_LOCK_WAIT_MS,
      ...options,
      external: true,
    });
  };
  return acquire(0);
}
