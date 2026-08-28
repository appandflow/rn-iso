import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isOnMountedVolume } from './fs-util.ts';
import { withDirLock } from './dir-lock.ts';

// The config records are a defensive, loosely-typed bag written across many
// commands and read back by more; every reader guards for absence, so the
// shapes are modelled as flat records of optional keys with an index signature
// rather than closed interfaces. They live in the shared vocabulary
// (src/types.ts) now, and are re-exported here so existing importers of
// `./config.ts` are unaffected.
import type { Config, ConcurrencyLimits, DeviceRecord, ProjectRecord, RepoRecord, SupervisorRecord } from './types.ts';
export type { Config, ConcurrencyLimits, DeviceRecord, ProjectRecord, RepoRecord, SupervisorRecord };

export function getConfigDir(): string {
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
// followed by its own `start` and `ios`). Two of them interleaving lose one
// side's device record entirely, so the read, the modify and the write happen
// while this lock is held. The mkdir-mtime discipline is shared with the
// per-workspace state.json lock; see src/dir-lock.js.
const LOCK_DIR_NAME = 'config.lock';

function lockPath() {
  return join(getConfigDir(), LOCK_DIR_NAME);
}

// Runs `fn` with the config lock held. Reentrant within this process. `fn`
// must be a short read-modify-write: the staleness check is the lock
// directory's mtime, so a hold longer than the stale window can be taken over
// by another process.
export function withConfigLock<T>(fn: () => T): T {
  return withDirLock(lockPath(), fn, { ensureParent: ensureDir });
}

export function loadConfig(): Config | null {
  const p = getConfigPath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf-8');
  try {
    return JSON.parse(raw) as Config;
  } catch (err) {
    // The config records which simulators and emulators rn-iso owns. Resetting
    // it to {} here would orphan every owned device: nothing would reference
    // them, and `gc --delete` would destroy live environments. Fail loudly and
    // let the user decide instead.
    const corrupt = new Error(
      `rn-iso config at ${p} is not valid JSON: ${(err as Error).message}\n` +
        'It holds the records of the simulators and emulators rn-iso owns, so it is never reset automatically.\n' +
        `Repair the file, or move it aside to start over: mv "${p}" "${p}.broken"`,
    );
    // Flagged so bin/cli.js prints the message alone: this is a state the user
    // has to fix, not a bug whose stack trace helps anyone.
    (corrupt as Error & { code?: string }).code = 'RN_ISO_CONFIG_CORRUPT';
    throw corrupt;
  }
}

// Write to a temp file in the same directory, then rename over the target.
// rename is atomic, so a crash mid-write leaves the previous config intact
// instead of a truncated file that makes every later command fail to parse.
export function saveConfig(config: Config): void {
  ensureDir();
  const target = getConfigPath();
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

const CONFIG_VERSION = 2;

export function ensureConfig(): Config {
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

export function getProject(projectPath: string): ProjectRecord | null {
  const cfg = loadConfig();
  return cfg?.projects?.[projectPath] || null;
}

export function upsertProject(projectPath: string, fields: Partial<ProjectRecord>): ProjectRecord {
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

export function removeProject(projectPath: string): void {
  withConfigLock(() => {
    const cfg = loadConfig();
    if (!cfg?.projects?.[projectPath]) return;
    delete cfg.projects[projectPath];
    saveConfig(cfg);
  });
}

// Records `port` for this project only if the config, read under the lock,
// still shows it unclaimed by another project. Returns the recorded port, or
// null when another project claimed it in the meantime -- two `start` runs can
// probe the same free port at the same time, and the probe result is stale by
// the time either writes. The caller allocates again on null, which sees the
// winner's claim and moves on to the next port.
export function claimMetroPort(projectPath: string, port: number): number | null {
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

export function setDevice(projectPath: string, platform: string, deviceFields: DeviceRecord): void {
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

export function clearDevice(projectPath: string, platform: string): void {
  withConfigLock(() => {
    const cfg = loadConfig();
    if (!cfg?.projects?.[projectPath]?.platforms) return;
    delete cfg.projects[projectPath].platforms[platform];
    saveConfig(cfg);
  });
}

// --- The supervisor registration --------------------------------------
//
// The workspace already records its supervisor in <root>/.rn-iso/state.json,
// which is where `stop` and `status` read it from. This second copy is the
// GLOBAL one, and it exists for the case the workspace copy cannot cover: a
// worktree deleted out from under a running supervisor takes state.json with
// it, and without an entry here the process is unfindable -- it keeps holding
// a port and a watchman subscription with nothing left that names it. Same
// reasoning as the device records: the registry outlives the workspace.
//
// Unlike setDevice, an unregistered project is CREATED rather than rejected.
// The registration is written before the server starts, so refusing it because
// nobody ran a broker command first would trade the one record that makes a
// crashed supervisor findable for a consistency rule with nothing behind it.
// metroPort is deliberately left alone: the port belongs to the reservation
// logic (claimMetroPort), and inventing a claim here could take a port another
// project already reserved.
export function setSupervisor(projectPath: string, { pid, port, startedAt }: SupervisorRecord): SupervisorRecord {
  return withConfigLock(() => {
    const cfg = ensureConfig();
    if (!cfg.projects[projectPath]) {
      cfg.projects[projectPath] = { metroPort: null, platforms: {} };
    }
    cfg.projects[projectPath].supervisor = { pid, port, startedAt };
    saveConfig(cfg);
    return cfg.projects[projectPath].supervisor;
  });
}

export function clearSupervisor(projectPath: string): void {
  withConfigLock(() => {
    const cfg = loadConfig();
    if (!cfg?.projects?.[projectPath]?.supervisor) return;
    delete cfg.projects[projectPath].supervisor;
    saveConfig(cfg);
  });
}

// --- Machine-level concurrency limits (opt-in; unlimited by default) --------
//
// rn-iso imposes no limits of its own: an unset cap is exactly the current
// behaviour. When a machine cannot host as many parallel builds or devices as
// there are agents, these cap them. They are MACHINE-level (a top-level
// `concurrency` key in ~/.rn-iso/config.json, NOT per-project), because the
// resource being shared -- cores, RAM, booted simulators -- is the machine's,
// not any one checkout's. RN_ISO_MAX_BUILDS / RN_ISO_MAX_DEVICES override the
// file. Absent, 0, or anything that is not a positive integer means NO
// enforcement -- the direction a broken value must fail is "do not limit",
// never "block every build".
export function getConcurrencyLimits({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): ConcurrencyLimits {
  const cfg = loadConfig();
  const c = cfg?.concurrency || {};
  return {
    maxBuilds: resolveLimit(env.RN_ISO_MAX_BUILDS, c.maxBuilds),
    maxDevices: resolveLimit(env.RN_ISO_MAX_DEVICES, c.maxDevices),
  };
}

// --- Machine-level cache switches -------------------------------------------
//
// `caches` in ~/.rn-iso/config.json already holds the two relocation keys
// (`buildCache` / `metroCache`, read by @rn-iso/core so every process agrees).
// `injectMetroStore` joins them as the KILL SWITCH for the Metro transform
// store rn-iso installs on the dev servers it hosts.
//
// It is machine-level ON PURPOSE, and that is the whole point of the feature:
// evaluating rn-iso in a real repo must need no change to that repo, so the
// way to turn a piece of it off must not be a change to that repo either. A
// committed .rn-iso.json would be exactly the PR this exists to avoid.
//
// Default ON. Only the literal `false` turns it off -- a malformed value must
// not silently disable a cache, and the direction a broken config fails is
// "behave as documented".
export function metroStoreInjectionEnabled(): boolean {
  const cfg = loadConfig();
  const caches = cfg?.caches;
  if (!caches || typeof caches !== 'object' || Array.isArray(caches)) return true;
  return (caches as Record<string, unknown>).injectMetroStore !== false;
}

function resolveLimit(envVal: unknown, cfgVal: unknown): number {
  const hasEnv = envVal !== undefined && envVal !== null && envVal !== '';
  const raw = hasEnv ? Number(envVal) : typeof cfgVal === 'number' ? cfgVal : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

// --- Per-project settings (scripts, package manager, ...) ---

export function getProjectSettings(projectPath: string): Record<string, unknown> {
  return getProject(projectPath)?.settings || {};
}

export function getProjectSetting(projectPath: string, dottedKey: string): unknown {
  return readNested(getProjectSettings(projectPath), dottedKey);
}

export function setProjectSetting(projectPath: string, dottedKey: string, value: unknown): void {
  withConfigLock(() => {
    const cfg = ensureConfig();
    const proj = cfg.projects[projectPath];
    if (!proj) throw new Error(`Project not registered: ${projectPath}`);
    proj.settings = proj.settings || {};
    writeNested(proj.settings, dottedKey, value);
    saveConfig(cfg);
  });
}

export function unsetProjectSetting(projectPath: string, dottedKey: string): boolean {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const proj = cfg?.projects?.[projectPath];
    if (!proj?.settings) return false;
    const removed = deleteNested(proj.settings, dottedKey);
    if (removed && cfg) saveConfig(cfg);
    return removed;
  });
}

// --- Per-repo settings (keyed by git common dir, shared across worktrees) ---

export function getRepoSettings(gitCommonDir: string): Record<string, unknown> {
  const cfg = loadConfig();
  return cfg?.repos?.[gitCommonDir]?.settings || {};
}

export function setRepoSetting(gitCommonDir: string, dottedKey: string, value: unknown): void {
  withConfigLock(() => {
    const cfg = ensureConfig();
    cfg.repos[gitCommonDir] = cfg.repos[gitCommonDir] || {};
    cfg.repos[gitCommonDir].settings = cfg.repos[gitCommonDir].settings || {};
    writeNested(cfg.repos[gitCommonDir].settings, dottedKey, value);
    saveConfig(cfg);
  });
}

export function unsetRepoSetting(gitCommonDir: string, dottedKey: string): boolean {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const settings = cfg?.repos?.[gitCommonDir]?.settings;
    if (!settings) return false;
    const removed = deleteNested(settings, dottedKey);
    if (removed && cfg) saveConfig(cfg);
    return removed;
  });
}

function readNested(obj: unknown, dottedKey: string): unknown {
  if (!obj) return undefined;
  const keys = dottedKey.split('.');
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function writeNested(obj: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const keys = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (k === undefined) continue;
    const next = cur[k];
    if (typeof next !== 'object' || next === null) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1];
  if (leaf !== undefined) cur[leaf] = value;
}

function deleteNested(obj: Record<string, unknown>, dottedKey: string): boolean {
  const keys = dottedKey.split('.');
  const chain: Record<string, unknown>[] = [obj];
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (k === undefined) return false;
    const next = cur[k];
    if (next == null || typeof next !== 'object') return false;
    cur = next as Record<string, unknown>;
    chain.push(cur);
  }
  const leaf = keys[keys.length - 1];
  if (leaf === undefined) return false;
  if (!(leaf in cur)) return false;
  delete cur[leaf];
  // Prune any intermediate objects left empty by the deletion, so e.g.
  // removing the only key under `worktree.baseRef` also drops `worktree`.
  for (let i = chain.length - 2; i >= 0; i--) {
    const parent = chain[i];
    const key = keys[i];
    const child = chain[i + 1];
    if (parent === undefined || key === undefined || child === undefined) break;
    if (Object.keys(child).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
  return true;
}

// True path-segment prefix, not a bare startsWith: "/a/foo-worktrees/x" must
// not match "/a/foo-worktrees/xy" just because the strings share a prefix.
export function isPathPrefix(prefix: string, path: string): boolean {
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
export function findEnclosingWorktreeRoot(projectPath: string): string | null {
  const cfg = loadConfig();
  if (!cfg?.projects) return null;
  let best: string | null = null;
  for (const [path, proj] of Object.entries(cfg.projects)) {
    if (!proj?.worktreeRoot) continue;
    if (!isPathPrefix(path, projectPath)) continue;
    if (!best || path.length > best.length) best = path;
  }
  return best;
}

export function allMetroPorts(): number[] {
  const cfg = loadConfig();
  if (!cfg?.projects) return [];
  return Object.values(cfg.projects)
    .map((p) => p.metroPort)
    .filter((p) => typeof p === 'number');
}

export function findProjectByMetroPort(port: number): string | null {
  const cfg = loadConfig();
  for (const [path, proj] of Object.entries(cfg?.projects || {})) {
    if (proj.metroPort === port) return path;
  }
  return null;
}

// Ownership (not claims/reservations) is the model now: `ios` / `android` record a
// device directly on the owning project. The only thing that still needs a
// cross-project view is avoiding console-port / physical-serial collisions
// when creating a new owned Android device.
export function allConsolePortsAndSerials({
  isMounted = isOnMountedVolume,
}: { isMounted?: (p: string) => boolean } = {}): { androidConsolePorts: number[]; androidPhysicalSerials: string[] } {
  const cfg = loadConfig();
  const result: { androidConsolePorts: number[]; androidPhysicalSerials: string[] } = {
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
