import { getExecutor } from './exec.ts';
import { isMetroRunning } from './ports.ts';
import { readlinkSync, realpathSync } from 'fs';
import { sep } from 'path';

export function findPidListeningOnPort(port: number): number | null {
  const out = getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
  if (!out) return null;
  const first = out.split('\n')[0];
  if (!first) return null;
  const pid = parseInt(first, 10);
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

export function parseLsofPids(out: unknown): number[] {
  if (!out) return [];
  return String(out)
    .split('\n')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

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
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
  }
  return parseLsofCwd(getExecutor().runQuiet(`lsof -a -p ${pid} -d cwd -Fn`));
}

export function processGroupLeader(pid: number): number | null {
  return parsePsPgid(getExecutor().runQuiet(`ps -o pgid= -p ${pid}`));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isInsideProject(cwd: string | null | undefined, projectPath: string | null | undefined): boolean {
  if (!cwd || !projectPath) return false;
  const a = canonicalPath(cwd);
  const b = canonicalPath(projectPath);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

export const NOT_OURS_UNRESPONSIVE = 'unresponsive';
const NOT_OURS_UNREADABLE_CWD = 'unreadable-cwd';
export const NOT_OURS_FOREIGN_CWD = 'foreign-cwd';

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
  const pid = pids[0];
  if (pid === undefined) return { missing: true };

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

function ownProcessGroup(): number | null {
  return processGroupLeader(process.pid);
}

export function killMetroTree(leader: number | null | undefined, listenerPid?: number | null): boolean {
  if (!leader) return false;
  if (leader === ownProcessGroup()) {
    const target = listenerPid ?? leader;
    try {
      process.kill(target, 'SIGTERM');
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
      process.kill(listenerPid ?? leader, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}
