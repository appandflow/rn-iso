import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withDirLock } from '../dir-lock.ts';
import { ensureWorkspaceStorage, supervisorPidFile, workspaceStateFile, workspaceStateLock } from '../paths.ts';

export const MODE_BARE = 'bare-inproc';
export const MODE_EXPO = 'expo-child';

export interface WorkspaceState {
  supervisor?: Record<string, unknown>;
  collectors?: Record<string, unknown>;
  lastBuild?: Record<string, unknown>;
  [key: string]: unknown;
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
  clearWorkspaceStateKeys(root, ['supervisor']);
}

export function clearWorkspaceStateKeys(root: string, keys: string[]): void {
  withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    if (!state || !keys.some((key) => key in state)) return;
    for (const key of keys) delete state[key];
    const file = workspaceStateFile(root);
    if (Object.keys(state).length === 0) {
      rmSync(file, { force: true });
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
