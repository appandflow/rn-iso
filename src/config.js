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

export function ensureConfig() {
  const existing = loadConfig();
  if (existing) {
    if (!existing.reservations) {
      existing.reservations = { ios: [], android: [] };
      saveConfig(existing);
    }
    return existing;
  }
  const fresh = { version: 1, projects: {}, reservations: { ios: [], android: [] } };
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

export function allMetroPorts() {
  const cfg = loadConfig();
  if (!cfg?.projects) return [];
  return Object.values(cfg.projects)
    .map(p => p.metroPort)
    .filter(p => typeof p === 'number');
}

export function allClaimedDevices() {
  const cfg = loadConfig();
  const result = {
    iosUdids: [],
    androidAvds: [],
    androidConsolePorts: [],
    // iosClaims: udid -> { source: 'project'|'reservation', label, path? }
    // For 'project', `path` is the absolute project path (so callers can
    // release the prior claim via clearDevice). For 'reservation', the udid
    // itself is the key; pass to removeReservation to drop it.
    iosClaims: {},
  };
  if (!cfg) return result;
  for (const [path, proj] of Object.entries(cfg.projects || {})) {
    const ios = proj.platforms?.ios;
    if (ios?.deviceUdid) {
      result.iosUdids.push(ios.deviceUdid);
      result.iosClaims[ios.deviceUdid] = {
        source: 'project',
        label: path.split('/').pop() || path,
        path,
      };
    }
    const android = proj.platforms?.android;
    if (android?.avdName) result.androidAvds.push(android.avdName);
    if (typeof android?.consolePort === 'number') result.androidConsolePorts.push(android.consolePort);
  }
  for (const r of cfg.reservations?.ios || []) {
    if (r.udid) {
      result.iosUdids.push(r.udid);
      result.iosClaims[r.udid] = {
        source: 'reservation',
        label: r.label || 'reserved',
      };
    }
  }
  for (const r of cfg.reservations?.android || []) {
    if (r.avdName) result.androidAvds.push(r.avdName);
    if (typeof r.consolePort === 'number') result.androidConsolePorts.push(r.consolePort);
  }
  return result;
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

export function listReservations() {
  const cfg = loadConfig();
  return cfg?.reservations || { ios: [], android: [] };
}

// Find reservations matching either an identifier (UDID for iOS, serial for
// Android) or a label (the --label set via `rn-iso reserve`). Returns
// `[{ platform, id, label }]`. Pass platform to restrict the search.
export function findReservations(idOrLabel, platform = null) {
  const r = listReservations();
  const matches = [];
  if (!platform || platform === 'ios') {
    for (const e of r.ios || []) {
      if (e.udid === idOrLabel || e.label === idOrLabel) {
        matches.push({ platform: 'ios', id: e.udid, label: e.label });
      }
    }
  }
  if (!platform || platform === 'android') {
    for (const e of r.android || []) {
      if (e.serial === idOrLabel || e.label === idOrLabel) {
        matches.push({ platform: 'android', id: e.serial, label: e.label });
      }
    }
  }
  return matches;
}

export function addReservation(platform, fields) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(`Unknown platform: ${platform}`);
  }
  const cfg = ensureConfig();
  cfg.reservations = cfg.reservations || { ios: [], android: [] };
  const list = cfg.reservations[platform];
  const key = platform === 'ios' ? 'udid' : 'serial';
  const existing = list.find(r => r[key] === fields[key]);
  if (existing) {
    Object.assign(existing, fields);
  } else {
    list.push(fields);
  }
  saveConfig(cfg);
  return fields;
}

export function removeReservation(platform, identifier) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(`Unknown platform: ${platform}`);
  }
  const cfg = loadConfig();
  if (!cfg?.reservations?.[platform]) return false;
  const key = platform === 'ios' ? 'udid' : 'serial';
  const before = cfg.reservations[platform].length;
  cfg.reservations[platform] = cfg.reservations[platform].filter(r => r[key] !== identifier);
  saveConfig(cfg);
  return cfg.reservations[platform].length < before;
}

export function clearAllReservations() {
  const cfg = loadConfig();
  if (!cfg) return;
  cfg.reservations = { ios: [], android: [] };
  saveConfig(cfg);
}
