import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isPidAlive } from '../metro.ts';

const LOCK_RECORD = 'owner.json';
const DEFAULT_WAIT_MS = 60_000;
const POLL_MS = 25;
const RECORD_GRACE_MS = 5_000;

interface LockRecord {
  pid: number;
  token: string;
  purpose?: string;
}

export interface WorkspaceProcessLockOptions {
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  ownerPurpose?: string;
  rejectOwnerPurposes?: readonly string[];
  external?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function workspaceProcessLockError(err: unknown): 'refused' | 'timeout' | null {
  const code = (err as Error & { code?: string })?.code;
  if (code === 'STIM_CLI_LOCK_REFUSED') return 'refused';
  if (code === 'STIM_CLI_LOCK_TIMEOUT') return 'timeout';
  return null;
}

function readLock(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(path, LOCK_RECORD), 'utf-8')) as Partial<LockRecord>;
    return typeof parsed.pid === 'number' && typeof parsed.token === 'string'
      ? {
          pid: parsed.pid,
          token: parsed.token,
          purpose: typeof parsed.purpose === 'string' ? parsed.purpose : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

function lockAge(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function reapLock(path: string): void {
  const aside = `${path}.reap-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

export async function withWorkspaceProcessLock<T>(
  root: string,
  name: string,
  fn: () => Promise<T>,
  {
    isAlive = isPidAlive,
    now = Date.now,
    sleep = defaultSleep,
    waitMs = DEFAULT_WAIT_MS,
    ownerPurpose,
    rejectOwnerPurposes = [],
    external = false,
  }: WorkspaceProcessLockOptions = {},
): Promise<T> {
  const path = external ? join(root, `${name}.lock`) : join(root, '.stim-cli', `${name}.lock`);
  const deadline = now() + waitMs;
  let owned: LockRecord | null = null;

  while (!owned) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      mkdirSync(path);
      owned = { pid: process.pid, token: randomUUID(), purpose: ownerPurpose };
      writeFileSync(join(path, LOCK_RECORD), JSON.stringify(owned));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        if (owned) rmSync(path, { recursive: true, force: true });
        throw err;
      }
    }

    const holder = readLock(path);
    if (holder && !isAlive(holder.pid)) {
      reapLock(path);
      continue;
    }
    if (holder?.purpose && rejectOwnerPurposes.includes(holder.purpose)) {
      const error = new Error(`The ${name} lock at ${path} is held for ${holder.purpose}.`);
      (error as Error & { code?: string }).code = 'STIM_CLI_LOCK_REFUSED';
      throw error;
    }
    if (!holder) {
      const age = lockAge(path, now());
      if (age === null) continue;
      if (age > RECORD_GRACE_MS) {
        reapLock(path);
        continue;
      }
    }
    if (now() >= deadline) {
      const error = new Error(`Timed out waiting for the ${name} lock at ${path}.`);
      (error as Error & { code?: string }).code = 'STIM_CLI_LOCK_TIMEOUT';
      throw error;
    }
    await sleep(POLL_MS);
  }

  try {
    return await fn();
  } finally {
    if (readLock(path)?.token === owned.token) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}
