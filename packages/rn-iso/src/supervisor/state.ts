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
import { ensureWorkspaceStorage, supervisorPidFile, workspaceStateFile, workspaceStateLock } from '../paths.ts';

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
  [key: string]: unknown;
}

// --- Contract 2: the workspace state file --------------------------------
//
// global workspace state.json, written temp+rename so a reader never sees half a
// file. Merged rather than overwritten: later steps put `lastBuild` beside
// `supervisor`, and a supervisor shutting down must not take it with it.

export function readWorkspaceState(root: string): WorkspaceState | null {
  try {
    const parsed = JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as WorkspaceState;
  } catch {
    // Absent, unreadable, or half-written. The global registry is the other
    // copy of the live ownership facts, so one bad file is not a reason for
    // every command to fail.
    return null;
  }
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
    ensureParent: () => {
      ensureWorkspaceStorage(root);
      mkdirSync(dirname(file), { recursive: true });
    },
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

// Removes only OUR key. The file goes when nothing else is left in it, so a
// stopped workspace has no state.json rather than an empty one -- but a
// workspace that has recorded something else keeps it.
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
