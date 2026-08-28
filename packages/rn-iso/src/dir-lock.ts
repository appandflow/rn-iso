import { mkdirSync, rmSync, statSync } from 'node:fs';

const DEFAULT_STALE_MS = 10000;
const DEFAULT_WAIT_MS = 12000;
const DEFAULT_POLL_MS = 25;

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
      continue;
    }
    if (ageMs > staleMs) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {}
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
  } catch {}
}

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
