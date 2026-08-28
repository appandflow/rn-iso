import { withWorkspaceProcessLock, type WorkspaceProcessLockOptions } from './workspace-process-lock.ts';
import { easMachineStateRoot } from './eas-session-ledger.ts';

const EAS_PROJECT_LOCK_WAIT_MS = 4 * 60_000;

interface EasProjectLockOptions extends WorkspaceProcessLockOptions {
  machineRoot?: string;
}

export function withEasProjectLock<T>(
  _root: string,
  fn: () => Promise<T>,
  options: EasProjectLockOptions = {},
): Promise<T> {
  const { machineRoot = easMachineStateRoot(), ...lockOptions } = options;
  return withWorkspaceProcessLock(machineRoot, 'eas-project', fn, {
    waitMs: EAS_PROJECT_LOCK_WAIT_MS,
    ...lockOptions,
    external: true,
  });
}
