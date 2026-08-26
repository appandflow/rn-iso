// src/engine/build-slots.js -- the OPT-IN build concurrency limit.
//
// rn-iso imposes no limit by default (an unset cap is the current behaviour).
// When concurrency.maxBuilds is set, this is the N-ary semaphore that enforces
// it: getConfigDir()/build-slots/slot-{0..N-1}, one directory per slot, taken
// by atomic mkdir. A build acquires ANY free slot; a full slate WAITS.
//
// TWO THINGS MAKE IT A SIBLING OF build-lock.js, NOT A SECOND COPY:
//   - The primitive is the same mkdirSync race, decided by the kernel.
//   - Staleness is PID-LIVENESS, never mtime. A slot is held for the whole
//     duration of a build -- twenty minutes is normal -- so ageing one out
//     would hand a second builder a slot the first is still using, which is
//     the over-subscription this exists to prevent. A slot frees when its
//     builder frees it, or when that builder dies (liveness notices within
//     one poll). The one age-based case is a directory with NO record yet: a
//     process killed between the mkdir and the write, a microsecond-wide gap
//     given seconds of grace.
//
// It is acquired AFTER single-flight dedup (engine/build-lock.js): a workspace
// waiting to install another's identical artifact must not burn a slot. So the
// order in ios.js/android.js is: miss both caches -> take the single-flight
// lock (decides WHO compiles) -> take a build slot (limits HOW MANY compile at
// once) -> build. The slot is released process.exit-safe, exactly as the build
// lock is.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config.js';
import { isPidAlive } from '../metro.js';
import { formatWaited } from './build-lock.js';

const SLOT_FILE_NAME = 'slot.json';
const SLOT_PREFIX = 'slot-';

// The grace for a slot directory that holds no record: a builder killed
// between its mkdir and its write. Microseconds wide in reality; seconds of
// margin, matching build-lock's RECORD_GRACE_MS.
const RECORD_GRACE_MS = 5000;

// How often a waiter re-probes the slate, and how often it says something.
export const SLOT_POLL_MS = 1000;
export const SLOT_PROGRESS_MS = 30000;
// The ceiling for a slot held by an ALIVE-but-wedged builder -- the one case
// liveness cannot see -- deliberately longer than any build this tool has
// measured, exactly as waitForBuild's ceiling.
export const SLOT_CEILING_MS = 90 * 60 * 1000;

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildSlotsDir() {
  return join(getConfigDir(), 'build-slots');
}

export function buildSlotPath(index) {
  return join(buildSlotsDir(), `${SLOT_PREFIX}${index}`);
}

// The holder's record, or null when there is none (yet, or ever). Never throws.
export function readBuildSlot(path) {
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

function dirAgeMs(path, now) {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// Returns true when this call now owns the slot directory at `path` (creating
// it, or reclaiming a stale one and re-creating it), false when a LIVE builder
// holds it.
function claimSlot(path, { isAlive, now }) {
  try {
    mkdirSync(path);
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  const info = readBuildSlot(path);
  if (info && isAlive(info.pid)) return false; // a live builder holds it
  if (!info) {
    // No record: a holder between its mkdir and its write, or one that died in
    // that gap. Age is the only thing left to ask.
    const age = dirAgeMs(path, now());
    if (age !== null && age <= RECORD_GRACE_MS) return false;
  }
  // Stale (dead pid, or an aged-out recordless directory): reclaim and retry.
  try {
    rmSync(path, { recursive: true, force: true });
  } catch { /* another taker-over got there first */ }
  try {
    mkdirSync(path);
    return true;
  } catch {
    return false; // someone else re-created it between the rm and here
  }
}

// One non-blocking pass over the slate. Returns the handle on success, or null
// when every slot is held by a live builder. Seams (`isAlive`, `now`) for tests.
export function tryAcquireBuildSlot({ max, root = null, logFile = null, isAlive = isPidAlive, now = Date.now } = {}) {
  if (!max || max <= 0) return { acquired: true, unlimited: true };
  mkdirSync(buildSlotsDir(), { recursive: true });
  for (let index = 0; index < max; index++) {
    const path = buildSlotPath(index);
    if (!claimSlot(path, { isAlive, now })) continue;
    const slot = {
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

// PURE. The progress line, in the same column as every other phase line.
export function slotWaitingLine({ max, elapsedMs }) {
  return `${'build'.padEnd(11)} waiting for a build slot (all ${max} in use, ${formatWaited(elapsedMs)} elapsed)`;
}

/**
 * Acquire a build slot, WAITING when the slate is full. A no-op fast path when
 * `max` is falsy (unlimited): returns `{ acquired: true, unlimited: true }`
 * without touching the disk, so an unset cap costs nothing.
 *
 * Outcomes:
 *   { acquired: true, path, index, slot }   a slot is held; release it
 *   { acquired: true, unlimited: true }     no cap; nothing to release
 *   throws RN_ISO_BUILD_SLOT_TIMEOUT        the ceiling, all slots alive-wedged
 */
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
} = {}) {
  if (!max || max <= 0) return { acquired: true, unlimited: true };
  const started = now();
  let lastProgress = started;
  for (;;) {
    const got = tryAcquireBuildSlot({ max, root, logFile, isAlive, now });
    if (got) return got;

    const elapsed = now() - started;
    if (elapsed >= ceilingMs) {
      const err = new Error(
        `Waited ${formatWaited(elapsed)} for one of ${max} build slots, and every slot is held by a `
        + 'process that is still alive. Slots live under ' + buildSlotsDir() + '; '
        + 'remove a slot directory whose builder is not really building, or raise concurrency.maxBuilds.'
      );
      err.code = 'RN_ISO_BUILD_SLOT_TIMEOUT';
      throw err;
    }
    if (now() - lastProgress >= progressMs) {
      lastProgress = now();
      out(slotWaitingLine({ max, elapsedMs: elapsed }));
    }
    await sleep(intervalMs);
  }
}

/**
 * Give up a slot. ALWAYS called in a `finally` / process.exit-safe path, like
 * releaseBuildLock: a build that failed or threw must free its slot so a
 * waiter can compile.
 *
 * Refuses to remove a slot another pid now holds -- once this slot was declared
 * stale and re-created, a blind rmSync would delete the NEW holder's slot and
 * over-subscribe the machine, the exact failure this module prevents.
 */
export function releaseBuildSlot(handle) {
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

// Every slot currently on disk, classified by whether its builder still
// exists. `gc` reports these the way it reports build locks: a live slot is a
// build in progress and is never touched; a stale one is debris from a reboot
// or a SIGKILL, and only those are removable.
export function listBuildSlots({ isAlive = isPidAlive } = {}) {
  const dir = buildSlotsDir();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const slots = [];
  for (const name of names) {
    if (!name.startsWith(SLOT_PREFIX)) continue;
    const path = join(dir, name);
    // A slot IS a directory -- that is the primitive. `gc --delete` acts on
    // this list, so anything else with this prefix is not proposed for removal.
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue; // released between the readdir and the stat
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
      alive: Boolean(info?.pid) && isAlive(info.pid),
    });
  }
  return slots;
}
