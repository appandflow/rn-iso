// src/engine/build-lock.js -- SINGLE-FLIGHT BUILDS.
//
// The premise of this whole CLI is several agents on one machine, often on one
// commit. The build cache already means the SECOND workspace to ask for a
// fingerprint installs in seconds instead of compiling -- but only if the
// first one has finished. Three agents starting within the same minute all
// miss the cache, all compile, and the machine pays for the same 19-minute
// xcodebuild three times over, with three toolchains fighting for the same
// cores. This is the piece that makes exactly one of them compile it.
//
// THE PRIMITIVE IS mkdirSync, for the reason src/config.js gives for
// withConfigLock: directory creation is atomic on every filesystem rn-iso runs
// on, so the winner of a race is decided by the kernel rather than by a
// check-then-act nobody can make safe. The record (`lock.json`) is written
// AFTER the mkdir -- it describes the holder, it does not decide who is one.
//
// STALENESS IS PID-LIVENESS, NOT AGE, and that is the one place this departs
// from the config lock. A config mutation is a read-modify-write of one small
// file, so a hold longer than ten seconds means a dead holder. A BUILD
// legitimately runs for twenty minutes or more; ageing a lock out would hand
// the second workspace the lock halfway through the first one's build and
// produce exactly the duplicated compile this exists to prevent. So a lock is
// stale when, and only when, `process.kill(pid, 0)` says nobody is there.
// (The one exception is a lock directory with no record at all -- a process
// killed between the mkdir and the write. There is no pid to ask about, so it
// ages out instead, on a grace measured in seconds because that gap is
// microseconds wide.)
//
// THE ARTIFACT IS THE COMPLETION SIGNAL, not the lock's disappearance. The
// builder stores into the cache and THEN releases, so a waiter polls
// `resolveBuild` first and only asks about the lock when there is still
// nothing there. A released lock with no artifact means the build FAILED, and
// the waiter takes over rather than waiting for something that is not coming.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config.js';
import { resolveBuild } from '../build-cache.js';
import { isPidAlive } from '../metro.ts';

const LOCK_FILE_NAME = 'lock.json';
const LOCK_SUFFIX = '.lock';

// How long a lock directory holding no record may exist before it is treated
// as the debris of a process killed between the mkdir and the write. The real
// gap is microseconds; seconds of grace is already orders of magnitude of
// margin, and the poll below usually resolves it on the first retry.
const RECORD_GRACE_MS = 5000;
const RECORD_POLL_MS = 25;
// The overall budget for `acquireBuildLock` itself. It is not a wait for the
// BUILD (that is waitForBuild's job) -- only for the microseconds a holder
// needs to write its record, or for a takeover to settle.
const ACQUIRE_DEADLINE_MS = 8000;

// How often a waiter asks the cache whether the artifact has appeared. A build
// is minutes long, so a second of latency on the answer is free, and it keeps
// a dozen waiting agents from stat-ing the cache a thousand times a second.
export const WAIT_POLL_MS = 1000;
// How often the waiter says something. Silence for nineteen minutes is
// indistinguishable from a hang.
export const WAIT_PROGRESS_MS = 30000;
// Not a timeout on the build: pid-liveness is the guard, and a dead builder is
// noticed within one poll however long it took to die. This is the ceiling for
// a builder that is ALIVE and wedged -- the one case liveness cannot see --
// and it is deliberately longer than any build this tool has ever measured.
export const WAIT_CEILING_MS = 90 * 60 * 1000;

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A lock path is a filesystem write, and both halves of the name are composed
// by this codebase -- but a separator that ever reached either one would climb
// out of the lock directory, so it cannot get there. Same rule, and the same
// reason, as cacheNameSegment in src/paths.js.
function segment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '') || 'unknown';
}

export function buildLocksDir() {
  return join(getConfigDir(), 'build-locks');
}

export function buildLockPath(platform, key) {
  return join(buildLocksDir(), `${segment(platform)}-${segment(key)}${LOCK_SUFFIX}`);
}

// The holder's record, or null when there is none (yet, or ever). Never
// throws: an unreadable or half-written record means "nobody identifiable
// holds this", which every caller already has a branch for.
export function readBuildLock(pathOrSpec) {
  const path = typeof pathOrSpec === 'string'
    ? pathOrSpec
    : buildLockPath(pathOrSpec?.platform, pathOrSpec?.key);
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

function dirAgeMs(path, now) {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Try to become the one process compiling `key`.
 *
 * Returns `{ acquired: true, path, lock }` when this process owns the build,
 * and `{ held, path }` -- the holder's record -- when another one does. The
 * caller does exactly one of two things with that: build, or wait.
 *
 * `isAlive` and `now` are seams; nothing else about this is injectable,
 * because the atomicity being relied on is the real mkdir's.
 */
export function acquireBuildLock({ platform, key, root = null, logFile = null, isAlive = isPidAlive, now = Date.now } = {}) {
  const path = buildLockPath(platform, key);
  const deadline = now() + ACQUIRE_DEADLINE_MS;

  for (;;) {
    try {
      mkdirSync(buildLocksDir(), { recursive: true });
      mkdirSync(path);
      const lock = {
        pid: process.pid,
        projectRoot: root,
        startedAt: new Date(now()).toISOString(),
        logFile,
      };
      // After the mkdir, deliberately: the directory decides ownership, the
      // record only describes it. A reader that arrives between the two sees a
      // lock it cannot identify, which is the RECORD_GRACE_MS case below.
      writeFileSync(join(path, LOCK_FILE_NAME), JSON.stringify(lock));
      return { acquired: true, path, lock };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const info = readBuildLock(path);
    if (info && isAlive(info.pid)) {
      // Someone is building this. Twenty minutes in is still building.
      return { held: info, path };
    }

    if (info) {
      // A dead pid is the only kind of stale lock. Removing it may race with
      // another waiter doing the same thing -- whoever's mkdir lands next
      // wins, and the loop re-reads.
      try {
        rmSync(path, { recursive: true, force: true });
      } catch { /* another taker-over got there first */ }
      continue;
    }

    // No record: either a holder is between its mkdir and its write, or a
    // process died in that gap. Age is the only thing left to ask.
    const age = dirAgeMs(path, now());
    if (age === null) continue; // released underneath us; retry the mkdir
    if (age > RECORD_GRACE_MS) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch { /* same race as above */ }
      continue;
    }
    if (now() >= deadline) {
      // Unidentifiable and not yet aged out. Reported as held with no pid,
      // which `waitForBuild` reads as a dead builder and takes over from --
      // the same self-healing path a crashed holder takes.
      return { held: { pid: null, projectRoot: null, startedAt: null, logFile: null }, path };
    }
    sleepSync(RECORD_POLL_MS);
  }
}

/**
 * Give up the lock. ALWAYS called in a `finally`: a build that failed or threw
 * must free its waiters immediately, or every other workspace on the
 * fingerprint sits there until the process dies.
 *
 * It refuses to remove a lock another pid now holds. That is not paranoia:
 * once a holder has been declared stale and the lock re-created, a blind
 * rmSync on the way out would delete the NEW holder's lock, and two builders
 * would compile the same fingerprint -- the exact failure this module exists
 * to prevent, reintroduced by its own cleanup.
 */
export function releaseBuildLock(handle) {
  if (!handle) return false;
  const path = handle.path || buildLockPath(handle.platform, handle.key);
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

// Every lock currently on disk, classified by whether its builder still
// exists. This is what `gc` reports: a live lock is a build in progress and is
// never touched, a stale one is debris from a machine that was rebooted or a
// process that was killed, and only those are removable.
export function listBuildLocks({ isAlive = isPidAlive } = {}) {
  const dir = buildLocksDir();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const locks = [];
  for (const name of names) {
    if (!name.endsWith(LOCK_SUFFIX)) continue;
    const path = join(dir, name);
    // A lock IS a directory -- that is the primitive. Anything else with this
    // suffix is not something rn-iso wrote, and `gc --delete` acts on this
    // list, so it must never propose removing a file it does not recognize.
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue; // released between the readdir and the stat
    }
    const stem = name.slice(0, -LOCK_SUFFIX.length);
    // `<platform>-<key>`, and the key contains dashes of its own, so the split
    // is at the FIRST one.
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
      // A lock nothing can be proven to hold is stale: there is no pid to ask
      // about, so it can only be debris.
      alive: Boolean(info?.pid) && isAlive(info.pid),
    });
  }
  return locks;
}

// PURE. "8m", "30s". Whole minutes once there is a minute to report: this
// answers "how long have I been waiting", where seconds of precision are
// noise.
export function formatWaited(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${Math.round(total)}s`;
  return `${Math.floor(total / 60)}m`;
}

// PURE. The progress line, in the same column as every other phase line (the
// padding matches phaseLine in commands/ios.js; it is repeated rather than
// imported because an engine module never imports a command).
export function waitingLine({ projectRoot, pid, elapsedMs, logFile }) {
  const where = projectRoot || 'another workspace';
  const tail = logFile ? ` -- tail ${logFile}` : '';
  return `${'build'.padEnd(11)} waiting on ${where} (pid ${pid ?? '?'}, ${formatWaited(elapsedMs)} elapsed)${tail}`;
}

/**
 * Wait for whoever holds the lock to produce the artifact.
 *
 * Outcomes, and there are only three:
 *   { hit, waitedMs }            the artifact appeared -- install it
 *   { builderFailed, waitedMs }  the builder is gone and produced nothing --
 *                                the caller takes the lock and builds
 *   throws RN_ISO_BUILD_WAIT_TIMEOUT   the ceiling, naming the lock path
 *
 * The order inside the loop is the important part: the CACHE is asked first,
 * every time, including after the lock is found gone. The builder stores and
 * then releases, so those two states overlap, and a waiter that asked about
 * the lock first would report a failed build for one that had just succeeded.
 */
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
} = {}) {
  const path = buildLockPath(platform, key);
  const started = now();
  let lastProgress = started;
  let holder = readBuildLock(path);

  for (;;) {
    const hit = resolve(platform, key);
    if (hit) return { hit, waitedMs: now() - started };

    const info = readBuildLock(path);
    if (info) holder = info;

    // The lock is gone, or nobody is behind it. Either way the artifact check
    // above just failed, so there is nothing coming: the caller takes over.
    if (!info) {
      return {
        builderFailed: 'the build lock was released without an artifact',
        holder,
        waitedMs: now() - started,
      };
    }
    if (!isAlive(info.pid)) {
      return {
        builderFailed: `the builder (pid ${info.pid ?? '?'}) is gone`,
        holder,
        waitedMs: now() - started,
      };
    }

    const elapsed = now() - started;
    if (elapsed >= ceilingMs) {
      const err = new Error(
        `Waited ${formatWaited(elapsed)} for ${info.projectRoot || 'another workspace'}'s ${platform} build of ${key} `
        + `without an artifact, and pid ${info.pid} is still alive. The lock is ${path}; `
        + 'remove that directory if that process is not really building.'
      );
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
