import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config.ts';
import { resolveBuild } from '../build-cache.ts';
import { isPidAlive } from '../metro.ts';

const LOCK_FILE_NAME = 'lock.json';
const LOCK_SUFFIX = '.lock';

export interface BuildLockRecord {
  pid: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
}

interface BuildLockSpec {
  platform: string;
  key: string;
}

interface AcquireBuildLockOptions {
  platform: string;
  key: string;
  root?: string | null;
  logFile?: string | null;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface BuildLockHandle {
  acquired?: true;
  path?: string;
  lock?: BuildLockRecord;
  held?: BuildLockRecord;
  tookOver?: BuildLockRecord;
  platform?: string;
  key?: string;
}

interface ListBuildLocksOptions {
  isAlive?: (pid: number) => boolean;
}

export interface BuildLockInfo {
  path: string;
  name: string;
  platform: string;
  key: string | null;
  pid: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
  alive: boolean;
}

interface WaitingLineArgs {
  projectRoot: string | null;
  pid: number | null;
  elapsedMs: number;
  logFile: string | null;
}

interface WaitForBuildOptions {
  platform: string;
  key: string;
  resolve?: (platform: string, key: string) => string | null;
  isAlive?: (pid: number) => boolean;
  intervalMs?: number;
  progressMs?: number;
  ceilingMs?: number;
  out?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForBuildResult {
  hit?: string;
  waitedMs?: number;
  builderFailed?: string;
  holder?: BuildLockRecord | null;
}

const RECORD_GRACE_MS = 5000;
const RECORD_POLL_MS = 25;
const ACQUIRE_DEADLINE_MS = 8000;

export const WAIT_POLL_MS = 1000;
export const WAIT_PROGRESS_MS = 30000;
export const WAIT_CEILING_MS: number = 90 * 60 * 1000;

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function segment(value: string): string {
  return (
    String(value)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^\.+/, '') || 'unknown'
  );
}

export function buildLocksDir(): string {
  return join(getConfigDir(), 'build-locks');
}

export function buildLockPath(platform: string, key: string): string {
  return join(buildLocksDir(), `${segment(platform)}-${segment(key)}${LOCK_SUFFIX}`);
}

export function readBuildLock(pathOrSpec: string | BuildLockSpec): BuildLockRecord | null {
  const path = typeof pathOrSpec === 'string' ? pathOrSpec : buildLockPath(pathOrSpec.platform, pathOrSpec.key);
  try {
    const parsed = JSON.parse(readFileSync(join(path, LOCK_FILE_NAME), 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number.isFinite(parsed.pid) ? parsed.pid : null,
      projectRoot: parsed.projectRoot ?? null,
      startedAt: parsed.startedAt ?? null,
      logFile: parsed.logFile ?? null,
    };
  } catch {
    return null;
  }
}

function dirAgeMs(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function reapStaleLock(path: string): void {
  const aside = `${path}.reap-${process.pid}`;
  try {
    rmSync(aside, { recursive: true, force: true });
    renameSync(path, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

export function acquireBuildLock({
  platform,
  key,
  root = null,
  logFile = null,
  isAlive = isPidAlive,
  now = Date.now,
}: AcquireBuildLockOptions): BuildLockHandle {
  const path = buildLockPath(platform, key);
  const deadline = now() + ACQUIRE_DEADLINE_MS;
  let reaped: BuildLockRecord | null = null;

  for (;;) {
    try {
      mkdirSync(buildLocksDir(), { recursive: true });
      mkdirSync(path);
      const lock: BuildLockRecord = {
        pid: process.pid,
        projectRoot: root,
        startedAt: new Date(now()).toISOString(),
        logFile,
      };
      writeFileSync(join(path, LOCK_FILE_NAME), JSON.stringify(lock));
      return reaped ? { acquired: true, path, lock, tookOver: reaped } : { acquired: true, path, lock };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }

    const info = readBuildLock(path);
    if (info && isAlive(info.pid!)) {
      return { held: info, path };
    }

    if (info) {
      reaped = info;
      reapStaleLock(path);
      continue;
    }

    const age = dirAgeMs(path, now());
    if (age === null) continue;
    if (age > RECORD_GRACE_MS) {
      reapStaleLock(path);
      continue;
    }
    if (now() >= deadline) {
      return { held: { pid: null, projectRoot: null, startedAt: null, logFile: null }, path };
    }
    sleepSync(RECORD_POLL_MS);
  }
}

export function releaseBuildLock(handle?: BuildLockHandle | null): boolean {
  if (!handle) return false;
  const path = handle.path || buildLockPath(handle.platform!, handle.key!);
  const ours = handle.lock?.pid ?? process.pid;
  const info = readBuildLock(path);
  if (info && info.pid !== ours) return false;
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function listBuildLocks({ isAlive = isPidAlive }: ListBuildLocksOptions = {}): BuildLockInfo[] {
  const dir = buildLocksDir();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const locks: BuildLockInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(LOCK_SUFFIX)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const stem = name.slice(0, -LOCK_SUFFIX.length);
    const cut = stem.indexOf('-');
    const info = readBuildLock(path);
    locks.push({
      path,
      name,
      platform: cut > 0 ? stem.slice(0, cut) : stem,
      key: cut > 0 ? stem.slice(cut + 1) : null,
      pid: info?.pid ?? null,
      projectRoot: info?.projectRoot ?? null,
      startedAt: info?.startedAt ?? null,
      logFile: info?.logFile ?? null,
      alive: Boolean(info?.pid) && isAlive(info!.pid!),
    });
  }
  return locks;
}

export function formatWaited(ms: number): string {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${Math.round(total)}s`;
  return `${Math.floor(total / 60)}m`;
}

export function waitingLine({ projectRoot, pid, elapsedMs, logFile }: WaitingLineArgs): string {
  const where = projectRoot || 'another workspace';
  const tail = logFile ? ` -- tail ${logFile}` : '';
  return `${'build'.padEnd(11)} waiting on ${where} (pid ${pid ?? '?'}, ${formatWaited(elapsedMs)} elapsed)${tail}`;
}

export function takeoverLine({
  projectRoot,
  pid,
  logFile,
  startedAt = null,
  now = Date.now,
}: {
  projectRoot: string | null;
  pid: number | null;
  logFile: string | null;
  startedAt?: string | null;
  now?: () => number;
}): string {
  const where = projectRoot || 'another workspace';
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const ago = Number.isFinite(started) ? ` (it started ${formatWaited(now() - started)} ago)` : '';
  const tail = logFile ? ` -- read ${logFile} before this one finishes` : '';
  return (
    `RETRY: ${where}'s build of this fingerprint (pid ${pid ?? '?'}) FAILED without an artifact${ago}, ` +
    `and this run rebuilds the SAME inputs, so expect the same failure unless something changed${tail}`
  );
}

export async function waitForBuild({
  platform,
  key,
  resolve = resolveBuild,
  isAlive = isPidAlive,
  intervalMs = WAIT_POLL_MS,
  progressMs = WAIT_PROGRESS_MS,
  ceilingMs = WAIT_CEILING_MS,
  out = () => {},
  now = Date.now,
  sleep = sleepAsync,
}: WaitForBuildOptions): Promise<WaitForBuildResult> {
  const path = buildLockPath(platform, key);
  const started = now();
  let lastProgress = started;
  let holder = readBuildLock(path);

  for (;;) {
    const hit = resolve(platform, key);
    if (hit) return { hit, waitedMs: now() - started };

    const info = readBuildLock(path);
    if (info) holder = info;

    if (!info) {
      return {
        builderFailed: 'the build lock was released without an artifact',
        holder,
        waitedMs: now() - started,
      };
    }
    if (!isAlive(info.pid!)) {
      return {
        builderFailed: `the builder (pid ${info.pid ?? '?'}) is gone`,
        holder,
        waitedMs: now() - started,
      };
    }

    const elapsed = now() - started;
    if (elapsed >= ceilingMs) {
      const err = new Error(
        `Waited ${formatWaited(elapsed)} for ${info.projectRoot || 'another workspace'}'s ${platform} build of ${key} ` +
          `without an artifact, and pid ${info.pid} is still alive. The lock is ${path}; ` +
          'remove that directory if that process is not really building.',
      ) as Error & { code?: string; lockPath?: string; holder?: BuildLockRecord };
      err.code = 'RN_ISO_BUILD_WAIT_TIMEOUT';
      err.lockPath = path;
      err.holder = info;
      throw err;
    }

    if (now() - lastProgress >= progressMs) {
      lastProgress = now();
      out(waitingLine({ projectRoot: info.projectRoot, pid: info.pid, elapsedMs: elapsed, logFile: info.logFile }));
    }

    await sleep(intervalMs);
  }
}
