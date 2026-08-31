import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config.ts';
import { isPidAlive } from '../metro.ts';
import { formatWaited } from './build-lock.ts';

const SLOT_FILE_NAME = 'slot.json';
const SLOT_PREFIX = 'slot-';

export interface BuildSlotRecord {
  pid: number | null;
  index: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
}

interface TryAcquireBuildSlotOptions {
  max: number;
  root?: string | null;
  logFile?: string | null;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

interface AcquireBuildSlotOptions extends TryAcquireBuildSlotOptions {
  out?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  progressMs?: number;
  ceilingMs?: number;
}

export interface BuildSlotHandle {
  acquired?: true;
  unlimited?: true;
  path?: string;
  index?: number;
  slot?: BuildSlotRecord;
}

interface ListBuildSlotsOptions {
  isAlive?: (pid: number) => boolean;
}

export interface BuildSlotInfo {
  path: string;
  name: string;
  index: number | null;
  pid: number | null;
  projectRoot: string | null;
  startedAt: string | null;
  logFile: string | null;
  alive: boolean;
}

const RECORD_GRACE_MS = 5000;

export const SLOT_POLL_MS = 1000;
export const SLOT_PROGRESS_MS = 30000;
export const SLOT_CEILING_MS: number = 90 * 60 * 1000;

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildSlotsDir(): string {
  return join(getConfigDir(), 'build-slots');
}

export function buildSlotPath(index: number): string {
  return join(buildSlotsDir(), `${SLOT_PREFIX}${index}`);
}

export function readBuildSlot(path: string): BuildSlotRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(path, SLOT_FILE_NAME), 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number.isFinite(parsed.pid) ? parsed.pid : null,
      index: Number.isFinite(parsed.index) ? parsed.index : null,
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

function claimSlot(path: string, { isAlive, now }: { isAlive: (pid: number) => boolean; now: () => number }): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
  }
  const info = readBuildSlot(path);
  if (info && isAlive(info.pid!)) return false;
  if (!info) {
    const age = dirAgeMs(path, now());
    if (age !== null && age <= RECORD_GRACE_MS) return false;
  }
  const aside = `${path}.reap-${process.pid}`;
  try {
    rmSync(aside, { recursive: true, force: true });
    renameSync(path, aside);
    rmSync(aside, { recursive: true, force: true });
  } catch {}
  try {
    mkdirSync(path);
    return true;
  } catch {
    return false;
  }
}

export function tryAcquireBuildSlot({
  max,
  root = null,
  logFile = null,
  isAlive = isPidAlive,
  now = Date.now,
}: TryAcquireBuildSlotOptions): BuildSlotHandle | null {
  if (!max || max <= 0) return { acquired: true, unlimited: true };
  mkdirSync(buildSlotsDir(), { recursive: true });
  for (let index = 0; index < max; index++) {
    const path = buildSlotPath(index);
    if (!claimSlot(path, { isAlive, now })) continue;
    const slot: BuildSlotRecord = {
      pid: process.pid,
      index,
      projectRoot: root,
      startedAt: new Date(now()).toISOString(),
      logFile,
    };
    writeFileSync(join(path, SLOT_FILE_NAME), JSON.stringify(slot));
    return { acquired: true, path, index, slot };
  }
  return null;
}

export function slotWaitingLine({ max, elapsedMs }: { max: number; elapsedMs: number }): string {
  return `${'build'.padEnd(11)} waiting for a build slot (all ${max} in use, ${formatWaited(elapsedMs)} elapsed)`;
}

export async function acquireBuildSlot({
  max,
  root = null,
  logFile = null,
  isAlive = isPidAlive,
  now = Date.now,
  out = () => {},
  sleep = sleepAsync,
  intervalMs = SLOT_POLL_MS,
  progressMs = SLOT_PROGRESS_MS,
  ceilingMs = SLOT_CEILING_MS,
}: AcquireBuildSlotOptions): Promise<BuildSlotHandle> {
  if (!max || max <= 0) return { acquired: true, unlimited: true };
  const started = now();
  let lastProgress = started;
  for (;;) {
    const got = tryAcquireBuildSlot({ max, root, logFile, isAlive, now });
    if (got) return got;

    const elapsed = now() - started;
    if (elapsed >= ceilingMs) {
      const err = new Error(
        `Waited ${formatWaited(elapsed)} for one of ${max} build slots, and every slot is held by a ` +
          'process that is still alive. Slots live under ' +
          buildSlotsDir() +
          '; ' +
          'remove a slot directory whose builder is not really building, or raise concurrency.maxBuilds.',
      ) as Error & { code?: string };
      err.code = 'STIM_BUILD_SLOT_TIMEOUT';
      throw err;
    }
    if (now() - lastProgress >= progressMs) {
      lastProgress = now();
      out(slotWaitingLine({ max, elapsedMs: elapsed }));
    }
    await sleep(intervalMs);
  }
}

export function releaseBuildSlot(handle?: BuildSlotHandle | null): boolean {
  if (!handle || handle.unlimited) return false;
  const path = handle.path || (handle.index != null ? buildSlotPath(handle.index) : null);
  if (!path) return false;
  const ours = handle.slot?.pid ?? process.pid;
  const info = readBuildSlot(path);
  if (info && info.pid !== ours) return false;
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function listBuildSlots({ isAlive = isPidAlive }: ListBuildSlotsOptions = {}): BuildSlotInfo[] {
  const dir = buildSlotsDir();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const slots: BuildSlotInfo[] = [];
  for (const name of names) {
    if (!name.startsWith(SLOT_PREFIX)) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const info = readBuildSlot(path);
    const index = Number(name.slice(SLOT_PREFIX.length));
    slots.push({
      path,
      name,
      index: Number.isFinite(index) ? index : null,
      pid: info?.pid ?? null,
      projectRoot: info?.projectRoot ?? null,
      startedAt: info?.startedAt ?? null,
      logFile: info?.logFile ?? null,
      alive: Boolean(info?.pid) && isAlive(info!.pid!),
    });
  }
  return slots;
}
