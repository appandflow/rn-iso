import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isOnMountedVolume } from './fs-util.ts';
import { withDirLock } from './dir-lock.ts';

import type { Config, ConcurrencyLimits, DeviceRecord, ProjectRecord, RepoRecord, SupervisorRecord } from './types.ts';
export type { Config, ConcurrencyLimits, DeviceRecord, ProjectRecord, RepoRecord, SupervisorRecord };

export function getConfigDir(): string {
  return process.env.STIM_HOME || join(homedir(), '.stim');
}

function getConfigPath() {
  return join(getConfigDir(), 'config.json');
}

function ensureDir() {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const LOCK_DIR_NAME = 'config.lock';

function lockPath() {
  return join(getConfigDir(), LOCK_DIR_NAME);
}

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
    const corrupt = new Error(
      `Stim config at ${p} is not valid JSON: ${(err as Error).message}\n` +
        'It holds the records of the simulators and emulators Stim owns, so it is never reset automatically.\n' +
        `Repair the file, or move it aside to start over: mv "${p}" "${p}.broken"`,
    );
    (corrupt as Error & { code?: string }).code = 'STIM_CONFIG_CORRUPT';
    throw corrupt;
  }
}

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
    } catch {}
    throw err;
  }
}

const CONFIG_VERSION = 2;

export function ensureConfig(): Config {
  return withConfigLock(() => {
    const existing = loadConfig();
    if (existing) {
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

export function getConcurrencyLimits({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): ConcurrencyLimits {
  const cfg = loadConfig();
  const c = cfg?.concurrency || {};
  return {
    maxBuilds: resolveLimit(env.STIM_MAX_BUILDS, c.maxBuilds),
    maxDevices: resolveLimit(env.STIM_MAX_DEVICES, c.maxDevices),
  };
}

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

export function isPathPrefix(prefix: string, path: string): boolean {
  if (prefix === path) return true;
  const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(withSlash);
}

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
