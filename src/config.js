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
  if (existing) return existing;
  const fresh = { version: 1, projects: {} };
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
    // iosClaims: udid -> { label, path }. androidClaims: consolePort ->
    // { label, path, avdName }. androidClaimsByAvd: avdName -> { label,
    // path, consolePort }. `path` is the absolute project path so take-
    // over flows can call clearDevice on the owning project.
    iosClaims: {},
    androidClaims: {},
    androidClaimsByAvd: {},
  };
  if (!cfg) return result;
  for (const [path, proj] of Object.entries(cfg.projects || {})) {
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
