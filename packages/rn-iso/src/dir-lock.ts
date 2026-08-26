// src/dir-lock.js -- a reentrant advisory lock: atomic mkdir + mtime staleness.
//
// The primitive is mkdirSync, for the reason src/config.js and
// src/engine/build-lock.js both give: directory creation is atomic on every
// filesystem rn-iso runs on, so the winner of a race is the kernel's decision
// rather than a check-then-act nobody can make safe.
//
// STALENESS IS THE LOCK DIRECTORY'S MTIME, and that is correct ONLY for a hold
// that is milliseconds long -- a read-modify-write of one small JSON file. A
// process killed mid-write leaves the directory behind, and the next waiter
// takes it over once it is older than the stale window. A hold that
// legitimately runs for minutes (a build) must use pid-liveness instead; that
// is engine/build-lock.js, and this helper is deliberately not it.
//
// This is the one copy of the mkdir-mtime discipline that withConfigLock (the
// global registry lock) and the per-workspace state.json lock both use. They
// were the same thing written twice.
import { mkdirSync, rmSync, statSync } from 'node:fs';

const DEFAULT_STALE_MS = 10000;
// Longer than the stale window so a lock left behind by a killed process is
// always taken over rather than reported as a timeout.
const DEFAULT_WAIT_MS = 12000;
const DEFAULT_POLL_MS = 25;

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Reentrancy is keyed on the lock PATH, not a single process-wide flag:
// mutators call each other (config's upsertProject -> ensureConfig -> saveConfig,
// the collector's registerCollector -> writeWorkspaceState), and one process can
// hold the config lock and a workspace-state lock at the same time. A nested
// acquire of a lock this process already holds must return straight to the body
// rather than deadlock against itself.
const depths = new Map<string, number>();

interface DirLockOptions {
  staleMs?: number;
  waitMs?: number;
  pollMs?: number;
  ensureParent?: () => void;
}

function acquire(
  lockPath: string,
  {
    staleMs,
    waitMs,
    pollMs,
    ensureParent,
  }: Required<Pick<DirLockOptions, 'staleMs' | 'waitMs' | 'pollMs'>> & Pick<DirLockOptions, 'ensureParent'>,
) {
  ensureParent?.();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }
    let ageMs: number | null = null;
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      // The holder released it between the mkdir and the stat: retry at once.
      continue;
    }
    if (ageMs > staleMs) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* another waiter took it over first */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      const err = new Error(
        `Timed out waiting for the lock at ${lockPath}. ` +
          'Another rn-iso process is holding it; if none is running, remove that directory.',
      );
      (err as Error & { code?: string; lockPath?: string }).code = 'RN_ISO_LOCK_TIMEOUT';
      (err as Error & { code?: string; lockPath?: string }).lockPath = lockPath;
      throw err;
    }
    sleepSync(pollMs);
  }
}

function release(lockPath: string) {
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    /* already taken over as stale */
  }
}

// Runs `fn` with the lock at `lockPath` held. Reentrant within this process per
// path. `fn` must be a short SYNCHRONOUS read-modify-write: the staleness guard
// is the lock directory's mtime, so a hold longer than `staleMs` can be taken
// over by another process. `ensureParent`, when given, creates the directory
// the lock lives in before the first mkdir.
export function withDirLock<T>(
  lockPath: string,
  fn: () => T,
  { staleMs = DEFAULT_STALE_MS, waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS, ensureParent }: DirLockOptions = {},
): T {
  const depth = depths.get(lockPath) || 0;
  if (depth > 0) {
    depths.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      depths.set(lockPath, (depths.get(lockPath) ?? 1) - 1);
    }
  }
  acquire(lockPath, { staleMs, waitMs, pollMs, ensureParent });
  depths.set(lockPath, 1);
  try {
    return fn();
  } finally {
    depths.set(lockPath, 0);
    release(lockPath);
  }
}
