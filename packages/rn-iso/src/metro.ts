import { getExecutor } from './exec.ts';
import { isMetroRunning } from './ports.ts';
import { realpathSync } from 'fs';
import { sep } from 'path';

export function findPidListeningOnPort(port: number): number | null {
  const out = getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
  if (!out) return null;
  const pid = parseInt(out.split('\n')[0], 10);
  return Number.isFinite(pid) ? pid : null;
}

export function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- port-to-process identity ------------------------------------------------
//
// rn-iso no longer starts Metro, so a recorded port is no longer proof of who
// holds it. Everything below exists to re-establish that proof at teardown
// time, before anything is killed.

// lsof -t prints one pid per line. Several processes can hold the same
// listening socket (a package-manager wrapper and the node child it spawned),
// so this returns all of them and the caller decides which one matters.
export function parseLsofPids(out: unknown): number[] {
  if (!out) return [];
  return String(out)
    .split('\n')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

// lsof -Fn field output looks like "p<pid>\nfcwd\nn<path>". Only the n-line
// following fcwd carries the directory.
export function parseLsofCwd(out: unknown): string | null {
  if (!out) return null;
  const lines = String(out).split('\n');
  const idx = lines.findIndex((l) => l === 'fcwd');
  if (idx === -1) return null;
  const nLine = lines.slice(idx + 1).find((l) => l.startsWith('n'));
  return nLine ? nLine.slice(1) : null;
}

export function parsePsPgid(out: unknown): number | null {
  if (!out) return null;
  const n = parseInt(String(out).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

export function processCwd(pid: number): string | null {
  return parseLsofCwd(getExecutor().runQuiet(`lsof -a -p ${pid} -d cwd -Fn`));
}

export function processGroupLeader(pid: number): number | null {
  return parsePsPgid(getExecutor().runQuiet(`ps -o pgid= -p ${pid}`));
}

// Canonicalize both sides before comparing: worktrees, and this machine's
// /Users -> /Volumes symlink, both make a plain textual prefix check wrong.
export function isInsideProject(cwd: string | null | undefined, projectPath: string | null | undefined): boolean {
  if (!cwd || !projectPath) return false;
  const canon = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const a = canon(cwd);
  const b = canon(projectPath);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

// Three outcomes, mirroring resolveOwnedIosSim. A port is NOT identity: the
// final 0.7.0 review's one Critical finding was Android teardown trusting a
// console port that a foreign emulator could occupy. Killing by port alone
// repeats that mistake, so identity is proven before anything dies.
//   { metro: {pid, leader, cwd} }  proven to be this project's Metro
//   { missing: true }              nothing listening; already gone, not an error
//   { notOurs: <reason>, kind }    listening but unproven; report, never kill
//
// `kind` exists so callers branch on data rather than on the prose of
// `notOurs` (the same reason teardown.js's skips carry one):
//   'unresponsive'   holds the port but did not answer /status. TRANSIENT --
//                    a bare Metro blocks its event loop for ~20s crawling the
//                    file map right after it starts listening, which is
//                    exactly when `rn-iso start` returns and `rn-iso ios`
//                    probes. The build gate retries this one.
//   'unreadable-cwd' answered, but its working directory could not be read
//   'foreign-cwd'    answered from OUTSIDE this project. Terminal: another
//                    workspace's bundler will not become ours by waiting.
export const NOT_OURS_UNRESPONSIVE = 'unresponsive';
export const NOT_OURS_UNREADABLE_CWD = 'unreadable-cwd';
export const NOT_OURS_FOREIGN_CWD = 'foreign-cwd';

// A flat interface rather than a discriminated union: every consumer today
// reads these fields defensively (a port that vanished mid-teardown is normal),
// and a union would force an `in`/narrowing dance at every read site for no
// added safety here. Exactly one group of fields is ever populated at a time.
export interface MetroResolution {
  missing?: true;
  notOurs?: string;
  kind?: string;
  pid?: number;
  metro?: { pid: number; leader: number; cwd: string };
}

export async function resolveProjectMetro(
  port: number,
  projectPath: string,
  { probe = isMetroRunning }: { probe?: (port: number) => Promise<boolean> | boolean } = {},
): Promise<MetroResolution> {
  const pids = parseLsofPids(getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`));
  if (pids.length === 0) return { missing: true };
  const pid = pids[0];

  if (!(await probe(port))) {
    return { notOurs: `pid ${pid} on port ${port} does not answer Metro's /status`, kind: NOT_OURS_UNRESPONSIVE, pid };
  }
  const cwd = processCwd(pid);
  if (!cwd) {
    return {
      notOurs: `pid ${pid} on port ${port}: working directory could not be read`,
      kind: NOT_OURS_UNREADABLE_CWD,
      pid,
    };
  }
  if (!isInsideProject(cwd, projectPath)) {
    return {
      notOurs: `pid ${pid} on port ${port} runs from ${cwd}, outside ${projectPath}`,
      kind: NOT_OURS_FOREIGN_CWD,
      pid,
    };
  }
  const leader = processGroupLeader(pid) ?? pid;
  return { metro: { pid, leader, cwd } };
}

// The process group rn-iso itself runs in. A Metro backgrounded by a
// non-interactive script (`npm start & rn-iso ios`) shares its shell's
// process group with rn-iso, so signalling that group would kill the shell
// and rn-iso along with it.
function ownProcessGroup(): number | null {
  return processGroupLeader(process.pid);
}

// Kills the process GROUP. lsof reports whoever holds the socket, which for a
// bundler started through a package manager is the node child, not the wrapper
// (observed on member-app: `npm exec react-native start` as pid 59806 with the
// node child 59914 actually holding the port). Killing only the listener
// orphans the wrapper. The one exception is a group rn-iso is itself a member
// of: there the bare pid is signalled instead.
export function killMetroTree(leader: number | null | undefined): boolean {
  if (!leader) return false;
  if (leader === ownProcessGroup()) {
    try {
      process.kill(leader, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-leader, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(leader, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}
