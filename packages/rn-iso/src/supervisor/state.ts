// src/supervisor/state.ts -- the workspace state + pid helpers, guard-free.
//
// Split out of supervisor/run.ts so that the importable state helpers live in a
// module with NO top-level main() and NO server imports: `ios`, `android`,
// `start` and the collector all read and write state.json through here, and
// bundling any of them must never drag the spawnable daemon entry (or Metro)
// in behind it. run.ts re-exports this surface for callers that still reach for
// it there.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withDirLock } from '../dir-lock.ts';
import { supervisorPidFile, workspaceStateFile, workspaceStateLock } from '../paths.ts';
import type { ManagedProvider } from '../engine/metro-reach.ts';

export const MODE_BARE = 'bare-inproc';
export const MODE_EXPO = 'expo-child';

// The workspace state file is a defensive, loosely-typed bag: each writer
// patches its own key (`supervisor`, `collectors.<platform>`, `lastBuild`) and
// every reader guards for absence, so the shape is best modelled as a flat
// record of optional keys rather than a closed interface.
export interface WorkspaceState {
  supervisor?: Record<string, unknown>;
  collectors?: Record<string, unknown>;
  lastBuild?: Record<string, unknown>;
  // Written by `ios --remote` the moment the session exists. The session id
  // ONLY: the daemon token is never persisted anywhere.
  remoteDevice?: Record<string, unknown>;
  // The address a remote device reaches this workspace's Metro through, when
  // rn-iso set one up itself: an Expo-hosted tunnel (`start`, kind 'expo') or
  // a managed provider (`ios`/`android` --remote, kind 'managed'). Never
  // written for an operator-supplied metro.publicUrl -- rn-iso only records
  // what it can also reap.
  metroTunnel?: Record<string, unknown>;
  [key: string]: unknown;
}

// The Expo dev server tunnelling itself (`expo start --tunnel`). Nothing to
// reap: the tunnel dies with the expo child, which `stop` already kills.
// Not exported on its own: nothing names it directly, only through the
// MetroTunnelRecord union readMetroTunnel returns.
interface ExpoTunnelRecord {
  kind: 'expo';
  url: string;
}

// A tunnel rn-iso started and owns the process of (engine/tunnel.ts's
// TunnelRecord, plus the discriminant). `stop`, `gc` and `worktree remove`
// reap this one by pid.
export interface ManagedTunnelRecord {
  kind: 'managed';
  provider: ManagedProvider;
  pid: number;
  url: string;
  port: number;
  startedAt: string;
}

export type MetroTunnelRecord = ExpoTunnelRecord | ManagedTunnelRecord;

export interface RemoteSessionRecord {
  platform: 'ios' | 'android' | null;
  sessionId: string;
  startedAt: string | null;
}

// The tunnel this workspace's Metro is reachable through, if rn-iso set one
// up. A narrow reader for the same reason readRemoteSessionId is one: every
// site that reads or reaps this record must agree on its shape and on what a
// malformed one means.
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
    if ((provider !== 'ngrok' && provider !== 'cloudflared') || typeof pid !== 'number' || typeof port !== 'number') {
      return null;
    }
    return { kind: 'managed', provider, pid, url, port, startedAt: typeof startedAt === 'string' ? startedAt : '' };
  }
  return null;
}

// --- Contract 2: the workspace state file --------------------------------
//
// <root>/.rn-iso/state.json, written temp+rename so a reader never sees half a
// file. Merged rather than overwritten: later steps put `lastBuild` beside
// `supervisor`, and a supervisor shutting down must not take it with it.

export function readWorkspaceState(root: string): WorkspaceState | null {
  try {
    const parsed = JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Absent, unreadable, or half-written: the file is a cache of facts that
    // are also in the config, so an unusable one reads as "no state".
    return null;
  }
}

// The remote session this workspace created, or null.
//
// A narrow reader rather than a raw readWorkspaceState at each call site: the
// three places that end a session (`stop`, `worktree remove` and `gc`, the
// last two through reclaim) must all agree on where the id lives and on what
// a malformed record means, and a session they disagree about is one that
// keeps billing.
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

// Runs `fn` with the state.json lock held (reentrant within this process).
// EVERY read-modify-write of state.json goes through here so the whole cycle
// is atomic: the supervisor patches `supervisor`, each collector patches its
// own `collectors.<platform>`, ios/android patch `lastBuild`, and these run at
// once (the detached collector registers during the launch-verify window right
// before writeLastBuild). renameSync stops a torn file, not a lost update --
// two writers that both read the old state and rename their own version over it
// drop one side's key, and a dropped `collectors.<platform>` leaks a log stream
// `stop` can never reap. The lock is the thing that closes that window.
export function withWorkspaceStateLock<T>(root: string, fn: () => T): T {
  const file = workspaceStateFile(root);
  return withDirLock(workspaceStateLock(root), fn, {
    ensureParent: () => mkdirSync(dirname(file), { recursive: true }),
  });
}

export function writeWorkspaceState(root: string, patch: WorkspaceState): WorkspaceState {
  return withWorkspaceStateLock(root, () => replaceWorkspaceState(root, { ...readWorkspaceState(root), ...patch }));
}

// The whole file, not a merge. Kept separate because clearing a key through
// the merging writer above would read the key back in and write it out again
// -- the state would never actually clear.
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

export function clearManagedMetroTunnel(root: string, expected: Omit<ManagedTunnelRecord, 'kind'>): void {
  clearWorkspaceStateKey(root, 'metroTunnel', (value) => {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Partial<ManagedTunnelRecord>;
    return (
      record.kind === 'managed' &&
      record.provider === expected.provider &&
      record.pid === expected.pid &&
      record.url === expected.url &&
      record.port === expected.port &&
      record.startedAt === expected.startedAt
    );
  });
}

// Removes only the selected key. The file goes when nothing else is left in
// it, so a stopped workspace has no state.json rather than an empty one.
function clearWorkspaceStateKey(root: string, key: string, shouldClear: (value: unknown) => boolean): void {
  withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    if (!state || !(key in state) || !shouldClear(state[key])) return;
    delete state[key];
    const file = workspaceStateFile(root);
    if (Object.keys(state).length === 0) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* already gone */
      }
      return;
    }
    replaceWorkspaceState(root, state);
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
