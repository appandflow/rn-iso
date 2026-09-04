import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withDirLock } from '../dir-lock.ts';
import { ensureWorkspaceStorage, supervisorPidFile, workspaceStateFile, workspaceStateLock } from '../paths.ts';
import type { ManagedProvider } from '../engine/metro-reach.ts';

export const MODE_BARE = 'bare-inproc';
export const MODE_EXPO = 'expo-child';

export interface WorkspaceState {
  supervisor?: Record<string, unknown>;
  collectors?: Record<string, unknown>;
  lastBuild?: Record<string, unknown>;
  launches?: Partial<Record<WorkspaceLaunchPlatform, WorkspaceLaunchRecord>>;
  remoteDevice?: Record<string, unknown>;
  metroTunnel?: Record<string, unknown>;
  [key: string]: unknown;
}

export type WorkspaceLaunchPlatform = 'ios' | 'android';

export interface WorkspaceLaunchRecord {
  appId: string;
  deviceId: string;
  metroPort: number | null;
  release: boolean;
  deepLinkUrl: string | null;
  launchedAt: string;
}

interface ExpoTunnelRecord {
  kind: 'expo';
  url: string;
}

export interface ManagedTunnelRecord {
  kind: 'managed';
  provider: ManagedProvider;
  pid: number;
  url: string;
  port: number;
  startedAt: string;
  processToken: string | null;
  logFile?: string | null;
}

export type MetroTunnelRecord = ExpoTunnelRecord | ManagedTunnelRecord;

export interface RemoteSessionRecord {
  platform: 'ios' | 'android' | null;
  sessionId: string;
  startedAt: string | null;
}

export function readMetroTunnel(root: string): MetroTunnelRecord | null {
  const record = readWorkspaceState(root)?.metroTunnel;
  if (!record || typeof record !== 'object') return null;
  const kind = (record as { kind?: unknown }).kind;
  const url = (record as { url?: unknown }).url;
  if (typeof url !== 'string' || url.length === 0) return null;
  if (kind === 'expo') return { kind: 'expo', url };
  if (kind === 'managed') {
    const provider = (record as { provider?: unknown }).provider;
    const pid = (record as { pid?: unknown }).pid;
    const port = (record as { port?: unknown }).port;
    const startedAt = (record as { startedAt?: unknown }).startedAt;
    const processToken = (record as { processToken?: unknown }).processToken;
    const logFile = (record as { logFile?: unknown }).logFile;
    if ((provider !== 'ngrok' && provider !== 'cloudflared') || typeof pid !== 'number' || typeof port !== 'number') {
      return null;
    }
    return {
      kind: 'managed',
      provider,
      pid,
      url,
      port,
      startedAt: typeof startedAt === 'string' ? startedAt : '',
      processToken: typeof processToken === 'string' && processToken.length > 0 ? processToken : null,
      ...(typeof logFile === 'string' && logFile.length > 0 ? { logFile } : {}),
    };
  }
  return null;
}

export function readWorkspaceState(root: string): WorkspaceState | null {
  try {
    const parsed = JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as WorkspaceState;
  } catch {
    return null;
  }
}

function parseWorkspaceLaunchRecord(value: unknown): WorkspaceLaunchRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<WorkspaceLaunchRecord>;
  if (typeof record.appId !== 'string' || record.appId.length === 0) return null;
  if (typeof record.deviceId !== 'string' || record.deviceId.length === 0) return null;
  if (record.metroPort !== null && typeof record.metroPort !== 'number') return null;
  if (typeof record.release !== 'boolean') return null;
  if (record.deepLinkUrl !== null && typeof record.deepLinkUrl !== 'string') return null;
  if (typeof record.launchedAt !== 'string') return null;
  return record as WorkspaceLaunchRecord;
}

export function readWorkspaceLaunches(root: string): Partial<Record<WorkspaceLaunchPlatform, WorkspaceLaunchRecord>> {
  const launches = readWorkspaceState(root)?.launches;
  if (!launches || typeof launches !== 'object' || Array.isArray(launches)) return {};
  const ios = parseWorkspaceLaunchRecord(launches.ios);
  const android = parseWorkspaceLaunchRecord(launches.android);
  return { ...(ios ? { ios } : {}), ...(android ? { android } : {}) };
}

export function writeWorkspaceLaunch(
  root: string,
  platform: WorkspaceLaunchPlatform,
  record: WorkspaceLaunchRecord,
): void {
  withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root) ?? {};
    const launches = state.launches && typeof state.launches === 'object' ? state.launches : {};
    replaceWorkspaceState(root, { ...state, launches: { ...launches, [platform]: record } });
  });
}

export function readRemoteSession(root: string): RemoteSessionRecord | null {
  const record = readWorkspaceState(root)?.remoteDevice;
  if (!record || typeof record !== 'object') return null;
  const id = (record as { sessionId?: unknown }).sessionId;
  if (typeof id !== 'string' || id.length === 0) return null;
  const platform = (record as { platform?: unknown }).platform;
  const startedAt = (record as { startedAt?: unknown }).startedAt;
  return {
    platform: platform === 'ios' || platform === 'android' ? platform : null,
    sessionId: id,
    startedAt: typeof startedAt === 'string' ? startedAt : null,
  };
}

export function readRemoteSessionId(root: string): string | null {
  return readRemoteSession(root)?.sessionId ?? null;
}

export function clearRemoteSession(root: string, expectedSessionId: string): void {
  clearWorkspaceStateKey(root, 'remoteDevice', (value) => {
    if (typeof value !== 'object' || value === null) return false;
    return (value as { sessionId?: unknown }).sessionId === expectedSessionId;
  });
}

export function withWorkspaceStateLock<T>(root: string, fn: () => T): T {
  const file = workspaceStateFile(root);
  return withDirLock(workspaceStateLock(root), fn, {
    ensureParent: () => {
      ensureWorkspaceStorage(root);
      mkdirSync(dirname(file), { recursive: true });
    },
  });
}

export function writeWorkspaceState(root: string, patch: WorkspaceState): WorkspaceState {
  return withWorkspaceStateLock(root, () => replaceWorkspaceState(root, { ...readWorkspaceState(root), ...patch }));
}

function replaceWorkspaceState(root: string, state: WorkspaceState): WorkspaceState {
  const file = workspaceStateFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
  return state;
}

export function clearWorkspaceSupervisor(root: string): void {
  clearWorkspaceStateKey(root, 'supervisor', () => true);
}

export function clearExpoMetroTunnel(root: string): void {
  clearWorkspaceStateKey(root, 'metroTunnel', (value) => {
    return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'expo';
  });
}

export function clearManagedMetroTunnel(root: string, expected: Omit<ManagedTunnelRecord, 'kind'>): boolean {
  if (!existsSync(workspaceStateFile(root))) return true;
  return clearWorkspaceStateKey(root, 'metroTunnel', (value) => {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Partial<ManagedTunnelRecord>;
    return (
      record.kind === 'managed' &&
      record.provider === expected.provider &&
      record.pid === expected.pid &&
      record.url === expected.url &&
      record.port === expected.port &&
      record.startedAt === expected.startedAt &&
      (record.processToken ?? null) === (expected.processToken ?? null) &&
      (record.logFile ?? null) === (expected.logFile ?? null)
    );
  });
}

export function clearWorkspaceStateKeys(root: string, keys: readonly string[]): void {
  if (!existsSync(workspaceStateFile(root))) return;
  withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    const file = workspaceStateFile(root);
    if (!state) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* already gone */
      }
      return;
    }
    let changed = false;
    for (const key of keys) {
      if (!(key in state)) continue;
      delete state[key];
      changed = true;
    }
    if (!changed) return;
    if (Object.keys(state).length === 0) {
      rmSync(file, { force: true });
      return;
    }
    replaceWorkspaceState(root, state);
  });
}

function clearWorkspaceStateKey(root: string, key: string, shouldClear: (value: unknown) => boolean): boolean {
  return withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    if (!state || !(key in state)) return true;
    if (!shouldClear(state[key])) return false;
    delete state[key];
    const file = workspaceStateFile(root);
    if (Object.keys(state).length === 0) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* already gone */
      }
      return true;
    }
    replaceWorkspaceState(root, state);
    return true;
  });
}

export function writePidFile(root: string, pid: number): string {
  const file = supervisorPidFile(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${pid}\n`);
  return file;
}

export function readPidFile(root: string): number | null {
  try {
    const pid = parseInt(readFileSync(supervisorPidFile(root), 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
