import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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

export function loadConfig() {
  const p = getConfigPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function saveConfig(config) {
  ensureDir();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n');
}

const CONFIG_VERSION = 2;

export function ensureConfig() {
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
}

export function getProject(projectPath) {
  const cfg = loadConfig();
  return cfg?.projects?.[projectPath] || null;
}

export function upsertProject(projectPath, fields) {
  const cfg = ensureConfig();
  const existing = cfg.projects[projectPath] || {
    metroPort: null,
    metroPid: null,
    platforms: {},
  };
  cfg.projects[projectPath] = {
    ...existing,
    ...fields,
  };
  saveConfig(cfg);
  return cfg.projects[projectPath];
}

export function removeProject(projectPath) {
  const cfg = loadConfig();
  if (!cfg?.projects?.[projectPath]) return;
  delete cfg.projects[projectPath];
  saveConfig(cfg);
}

export function setMetro(projectPath, metroPort, metroPid) {
  const cfg = ensureConfig();
  if (!cfg.projects[projectPath]) {
    throw new Error(`Project not registered: ${projectPath}`);
  }
  cfg.projects[projectPath].metroPort = metroPort;
  cfg.projects[projectPath].metroPid = metroPid;
  saveConfig(cfg);
}

export function setDevice(projectPath, platform, deviceFields) {
  const cfg = ensureConfig();
  if (!cfg.projects[projectPath]) {
    throw new Error(`Project not registered: ${projectPath}`);
  }
  cfg.projects[projectPath].platforms = cfg.projects[projectPath].platforms || {};
  cfg.projects[projectPath].platforms[platform] = deviceFields;
  saveConfig(cfg);
}

export function clearDevice(projectPath, platform) {
  const cfg = loadConfig();
  if (!cfg?.projects?.[projectPath]?.platforms) return;
  delete cfg.projects[projectPath].platforms[platform];
  saveConfig(cfg);
}

// --- Per-project settings (scripts, package manager, ...) ---

export function getProjectSettings(projectPath) {
  return getProject(projectPath)?.settings || {};
}

export function getProjectSetting(projectPath, dottedKey) {
  return readNested(getProjectSettings(projectPath), dottedKey);
}

export function setProjectSetting(projectPath, dottedKey, value) {
  const cfg = ensureConfig();
  const proj = cfg.projects[projectPath];
  if (!proj) throw new Error(`Project not registered: ${projectPath}`);
  proj.settings = proj.settings || {};
  writeNested(proj.settings, dottedKey, value);
  saveConfig(cfg);
}

export function unsetProjectSetting(projectPath, dottedKey) {
  const cfg = loadConfig();
  const proj = cfg?.projects?.[projectPath];
  if (!proj?.settings) return false;
  const removed = deleteNested(proj.settings, dottedKey);
  if (removed) saveConfig(cfg);
  return removed;
}

// --- Per-repo settings (keyed by git common dir, shared across worktrees) ---

export function getRepoSettings(gitCommonDir) {
  const cfg = loadConfig();
  return cfg?.repos?.[gitCommonDir]?.settings || {};
}

export function setRepoSetting(gitCommonDir, dottedKey, value) {
  const cfg = ensureConfig();
  cfg.repos[gitCommonDir] = cfg.repos[gitCommonDir] || {};
  cfg.repos[gitCommonDir].settings = cfg.repos[gitCommonDir].settings || {};
  writeNested(cfg.repos[gitCommonDir].settings, dottedKey, value);
  saveConfig(cfg);
}

export function unsetRepoSetting(gitCommonDir, dottedKey) {
  const cfg = loadConfig();
  const settings = cfg?.repos?.[gitCommonDir]?.settings;
  if (!settings) return false;
  const removed = deleteNested(settings, dottedKey);
  if (removed) saveConfig(cfg);
  return removed;
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

export function allClaimedDevices() {
  const cfg = loadConfig();
  const result = {
    iosUdids: [],
    androidAvds: [],
    androidConsolePorts: [],
    androidPhysicalSerials: [],
    // iosClaims: udid -> { label, path }. androidClaims: consolePort ->
    // { label, path, avdName }. androidClaimsByAvd: avdName -> { label,
    // path, consolePort }. androidPhysicalClaimsBySerial: serial ->
    // { label, path }. `path` is the absolute project path so take-over
    // flows can call clearDevice on the owning project.
    iosClaims: {},
    androidClaims: {},
    androidClaimsByAvd: {},
    androidPhysicalClaimsBySerial: {},
  };
  if (!cfg) return result;
  for (const [path, proj] of Object.entries(cfg.projects || {})) {
    // Claims from project paths that no longer exist on disk are orphaned --
    // nothing can ever run from a deleted worktree again -- so pickers treat
    // those devices as free. `prune` removes the dead entries themselves.
    if (!existsSync(path)) continue;
    const label = path.split('/').pop() || path;
    const ios = proj.platforms?.ios;
    if (ios?.deviceUdid) {
      result.iosUdids.push(ios.deviceUdid);
      result.iosClaims[ios.deviceUdid] = { label, path };
    }
    const android = proj.platforms?.android;
    if (android?.avdName) {
      result.androidAvds.push(android.avdName);
      result.androidClaimsByAvd[android.avdName] = {
        label,
        path,
        consolePort: android.consolePort,
      };
    }
    if (typeof android?.consolePort === 'number') {
      result.androidConsolePorts.push(android.consolePort);
      result.androidClaims[android.consolePort] = {
        label,
        path,
        avdName: android.avdName,
      };
    }
    if (android?.serial && !android.avdName) {
      result.androidPhysicalSerials.push(android.serial);
      result.androidPhysicalClaimsBySerial[android.serial] = { label, path };
    }
  }
  return result;
}

// Remove project entries whose path no longer exists on disk (deleted
// worktrees). Returns the removed entries so callers can report what was
// freed and clean up any process still bound to their Metro ports.
export function pruneDeadProjects() {
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
}

export function recordSimUsage(platform, identifier) {
  if (platform !== 'ios' && platform !== 'android') return;
  const cfg = ensureConfig();
  cfg.simUsage = cfg.simUsage || { ios: {}, android: {} };
  cfg.simUsage[platform][identifier] = (cfg.simUsage[platform][identifier] || 0) + 1;
  saveConfig(cfg);
}

export function getSimUsage() {
  const cfg = loadConfig();
  return cfg?.simUsage || { ios: {}, android: {} };
}
