import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isOnMountedVolume } from './fs-util.js';

export function getConfigDir() {
  return process.env.RN_ISO_HOME || join(homedir(), '.rn-iso');
}

function getConfigPath() {
  return join(getConfigDir(), 'config.json');
}

function ensureDir() {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// --- advisory write lock -----------------------------------------------
//
// Every mutator below is a read-modify-write of one JSON file, and several
// rn-iso commands can run at once (a `worktree create` per agent, each
// followed by its own `up`). Two of them interleaving lose one side's
// device record entirely, so the read, the modify and the write happen
// while this lock is held.
//
// mkdirSync is the primitive: directory creation is atomic on every
// filesystem rn-iso runs on, and needs no cleanup handler to be correct --
// a process that dies holding the lock leaves a directory whose mtime ages
// out, and the next waiter takes it over.
const LOCK_DIR_NAME = 'config.lock';
const LOCK_STALE_MS = 10000;
// Longer than LOCK_STALE_MS so a lock left behind by a killed process is
// always taken over rather than reported as a timeout.
const LOCK_WAIT_MS = 12000;
const LOCK_POLL_MS = 25;

// Depth, not a boolean: mutators call each other (upsertProject -> ensureConfig
// -> saveConfig), and a nested acquire of a lock this process already holds
// would deadlock against itself.
let lockDepth = 0;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPath() {
  return join(getConfigDir(), LOCK_DIR_NAME);
}

function acquireLock() {
  ensureDir();
  const lock = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    let ageMs = null;
    try {
      ageMs = Date.now() - statSync(lock).mtimeMs;
    } catch {
      // The holder released it between the mkdir and the stat: retry at once.
      continue;
    }
    if (ageMs > LOCK_STALE_MS) {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch { /* another waiter took it over first */ }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the rn-iso config lock at ${lock}. ` +
        'Another rn-iso command is holding it; if none is running, remove that directory.'
      );
    }
    sleepSync(LOCK_POLL_MS);
  }
}

function releaseLock() {
  try {
    rmSync(lockPath(), { recursive: true, force: true });
  } catch { /* already taken over as stale */ }
}

// Runs `fn` with the config lock held. Reentrant within this process. `fn`
// must be a short read-modify-write: the staleness check is the lock
// directory's creation time, so a hold longer than LOCK_STALE_MS can be taken
// over by another process.
export function withConfigLock(fn) {
  if (lockDepth > 0) {
    lockDepth++;
    try {
      return fn();
    } finally {
      lockDepth--;
    }
  }
  acquireLock();
  lockDepth = 1;
  try {
    return fn();
  } finally {
    lockDepth = 0;
    releaseLock();
  }
}

export function loadConfig() {
  const p = getConfigPath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    // The config records which simulators and emulators rn-iso owns. Resetting
    // it to {} here would orphan every owned device: nothing would reference
    // them, and `gc --delete` would destroy live environments. Fail loudly and
    // let the user decide instead.
    const corrupt = new Error(
      `rn-iso config at ${p} is not valid JSON: ${err.message}\n` +
      'It holds the records of the simulators and emulators rn-iso owns, so it is never reset automatically.\n' +
      `Repair the file, or move it aside to start over: mv "${p}" "${p}.broken"`
    );
    // Flagged so bin/cli.js prints the message alone: this is a state the user
    // has to fix, not a bug whose stack trace helps anyone.
    corrupt.code = 'RN_ISO_CONFIG_CORRUPT';
    throw corrupt;
  }
}

// Write to a temp file in the same directory, then rename over the target.
// rename is atomic, so a crash mid-write leaves the previous config intact
// instead of a truncated file that makes every later command fail to parse.
export function saveConfig(config) {
  ensureDir();
  const target = getConfigPath();
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch { /* nothing to clean up */ }
    throw err;
  }
}

const CONFIG_VERSION = 2;

export function ensureConfig() {
  return withConfigLock(() => {
    const existing = loadConfig();
    if (existing) {
      // Migration is additive: add `repos` and bump the version, never rewrite
      // `projects`. A v1 config carries live device claims we must not lose.
      let changed = false;
      if (!existing.repos) {
        existing.repos = {};
        changed = true;
      }
      if (existing.version !== CONFIG_VERSION) {
        existing.version = CONFIG_VERSION;
        changed = true;
      }
      if (changed) saveConfig(existing);
      return existing;
    }
    const fresh = { version: CONFIG_VERSION, projects: {}, repos: {} };
    saveConfig(fresh);
    return fresh;
  });
}

export function getProject(projectPath) {
  const cfg = loadConfig();
  return cfg?.projects?.[projectPath] || null;
}

export function upsertProject(projectPath, fields) {
  return withConfigLock(() => {
    const cfg = ensureConfig();
    const existing = cfg.projects[projectPath] || {
      metroPort: null,
      platforms: {},
    };
    cfg.projects[projectPath] = {
      ...existing,
      ...fields,
    };
    saveConfig(cfg);
    return cfg.projects[projectPath];
  });
}

export function removeProject(projectPath) {
  withConfigLock(() => {
    const cfg = loadConfig();
    if (!cfg?.projects?.[projectPath]) return;
    delete cfg.projects[projectPath];
    saveConfig(cfg);
  });
}

// Records `port` for this project only if the config, read under the lock,
// still shows it unclaimed by another project. Returns the recorded port, or
// null when another project claimed it in the meantime -- two `up` runs can
// probe the same free port at the same time, and the probe result is stale by
// the time either writes. The caller allocates again on null, which sees the
// winner's claim and moves on to the next port.
export function claimMetroPort(projectPath, port) {
  return withConfigLock(() => {
    const cfg = ensureConfig();
    if (!cfg.projects[projectPath]) {
      throw new Error(`Project not registered: ${projectPath}`);
    }
    for (const [path, proj] of Object.entries(cfg.projects)) {
      if (path !== projectPath && proj?.metroPort === port) return null;
    }
    cfg.projects[projectPath].metroPort = port;
    saveConfig(cfg);
    return port;
  });
}

export function setDevice(projectPath, platform, deviceFields) {
  withConfigLock(() => {
    const cfg = ensureConfig();
    if (!cfg.projects[projectPath]) {
      throw new Error(`Project not registered: ${projectPath}`);
    }
    cfg.projects[projectPath].platforms = cfg.projects[projectPath].platforms || {};
    cfg.projects[projectPath].platforms[platform] = deviceFields;
    saveConfig(cfg);
  });
}

export function clearDevice(projectPath, platform) {
  withConfigLock(() => {
    const cfg = loadConfig();
    if (!cfg?.projects?.[projectPath]?.platforms) return;
    delete cfg.projects[projectPath].platforms[platform];
    saveConfig(cfg);
  });
}

// --- Per-project settings (scripts, package manager, ...) ---

export function getProjectSettings(projectPath) {
  return getProject(projectPath)?.settings || {};
}

export function getProjectSetting(projectPath, dottedKey) {
  return readNested(getProjectSettings(projectPath), dottedKey);
}

export function setProjectSetting(projectPath, dottedKey, value) {
  withConfigLock(() => {
    const cfg = ensureConfig();
    const proj = cfg.projects[projectPath];
    if (!proj) throw new Error(`Project not registered: ${projectPath}`);
    proj.settings = proj.settings || {};
    writeNested(proj.settings, dottedKey, value);
    saveConfig(cfg);
  });
}

export function unsetProjectSetting(projectPath, dottedKey) {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const proj = cfg?.projects?.[projectPath];
    if (!proj?.settings) return false;
    const removed = deleteNested(proj.settings, dottedKey);
    if (removed) saveConfig(cfg);
    return removed;
  });
}

// --- Per-repo settings (keyed by git common dir, shared across worktrees) ---

export function getRepoSettings(gitCommonDir) {
  const cfg = loadConfig();
  return cfg?.repos?.[gitCommonDir]?.settings || {};
}

export function setRepoSetting(gitCommonDir, dottedKey, value) {
  withConfigLock(() => {
    const cfg = ensureConfig();
    cfg.repos[gitCommonDir] = cfg.repos[gitCommonDir] || {};
    cfg.repos[gitCommonDir].settings = cfg.repos[gitCommonDir].settings || {};
    writeNested(cfg.repos[gitCommonDir].settings, dottedKey, value);
    saveConfig(cfg);
  });
}

export function unsetRepoSetting(gitCommonDir, dottedKey) {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const settings = cfg?.repos?.[gitCommonDir]?.settings;
    if (!settings) return false;
    const removed = deleteNested(settings, dottedKey);
    if (removed) saveConfig(cfg);
    return removed;
  });
}

function readNested(obj, dottedKey) {
  if (!obj) return undefined;
  const keys = dottedKey.split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function writeNested(obj, dottedKey, value) {
  const keys = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function deleteNested(obj, dottedKey) {
  const keys = dottedKey.split('.');
  const chain = [obj];
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') return false;
    cur = cur[keys[i]];
    chain.push(cur);
  }
  const leaf = keys[keys.length - 1];
  if (!(leaf in cur)) return false;
  delete cur[leaf];
  // Prune any intermediate objects left empty by the deletion, so e.g.
  // removing the only key under `worktree.baseRef` also drops `worktree`.
  for (let i = chain.length - 2; i >= 0; i--) {
    const parent = chain[i];
    const key = keys[i];
    if (Object.keys(chain[i + 1]).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
  return true;
}

// True path-segment prefix, not a bare startsWith: "/a/foo-worktrees/x" must
// not match "/a/foo-worktrees/xy" just because the strings share a prefix.
export function isPathPrefix(prefix, path) {
  if (prefix === path) return true;
  const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(withSlash);
}

// Given any project path, find the enclosing worktree-root entry: the
// longest registered key with `worktreeRoot: true` that is a path-segment
// prefix of the given path. A monorepo has several app dirs (tlon-mobile,
// tlon-web, tlon-desktop) registered under the same worktree, so this walks
// up by matching against every registered key rather than guessing one app
// dir at `worktree create` time. Returns the registered key, or null.
export function findEnclosingWorktreeRoot(projectPath) {
  const cfg = loadConfig();
  if (!cfg?.projects) return null;
  let best = null;
  for (const [path, proj] of Object.entries(cfg.projects)) {
    if (!proj?.worktreeRoot) continue;
    if (!isPathPrefix(path, projectPath)) continue;
    if (!best || path.length > best.length) best = path;
  }
  return best;
}

export function allMetroPorts() {
  const cfg = loadConfig();
  if (!cfg?.projects) return [];
  return Object.values(cfg.projects)
    .map(p => p.metroPort)
    .filter(p => typeof p === 'number');
}

export function findProjectByMetroPort(port) {
  const cfg = loadConfig();
  for (const [path, proj] of Object.entries(cfg?.projects || {})) {
    if (proj.metroPort === port) return path;
  }
  return null;
}

// Ownership (not claims/reservations) is the model now: `up` records a
// device directly on the owning project. The only thing that still needs a
// cross-project view is avoiding console-port / physical-serial collisions
// when creating a new owned Android device.
export function allConsolePortsAndSerials({ isMounted = isOnMountedVolume } = {}) {
  const cfg = loadConfig();
  const result = {
    androidConsolePorts: [],
    androidPhysicalSerials: [],
  };
  if (!cfg) return result;
  for (const [path, proj] of Object.entries(cfg.projects || {})) {
    // Entries from project paths that no longer exist on disk are orphaned --
    // nothing can ever run from a deleted worktree again -- so their ports
    // and serials are free to reuse. `gc --delete` removes the dead entries.
    // A path on a volume that is not mounted right now only looks gone (this
    // machine's repos live on an external SSD), and its emulator may well be
    // running: handing its console port to a second emulator would collide,
    // so it keeps its claim, the same direction gc fails in.
    if (!existsSync(path) && isMounted(path)) continue;
    const android = proj.platforms?.android;
    if (typeof android?.consolePort === 'number') {
      result.androidConsolePorts.push(android.consolePort);
    }
    if (android?.serial && !android.avdName) {
      result.androidPhysicalSerials.push(android.serial);
    }
  }
  return result;
}

// Remove project entries whose path no longer exists on disk (deleted
// worktrees). Returns the removed entries so callers can report what was
// freed and clean up any process still bound to their Metro ports.
export function pruneDeadProjects() {
  return withConfigLock(() => {
    const cfg = loadConfig();
    if (!cfg?.projects) return [];
    const removed = [];
    for (const [path, proj] of Object.entries(cfg.projects)) {
      if (existsSync(path)) continue;
      removed.push({ path, project: proj });
      delete cfg.projects[path];
    }
    if (removed.length) saveConfig(cfg);
    return removed;
  });
}
