import { join } from 'node:path';
import { getConfigDir } from '../config.ts';
import { withWorkspaceProcessLock, type WorkspaceProcessLockOptions } from './workspace-process-lock.ts';

const EAS_PROJECT_LOCK_WAIT_MS = 4 * 60_000;

function easProjectLockRoot(): string {
  // Dynamic Expo configs do not expose their EAS project ID without running
  // project code. One host-wide lock coordinates every clone and worktree.
  return join(getConfigDir(), 'process-locks', 'eas-projects');
}

export function withEasProjectLock<T>(
  _root: string,
  fn: () => Promise<T>,
  options: WorkspaceProcessLockOptions = {},
): Promise<T> {
  return withWorkspaceProcessLock(easProjectLockRoot(), 'eas-project', fn, {
    waitMs: EAS_PROJECT_LOCK_WAIT_MS,
    ...options,
    external: true,
  });
}
