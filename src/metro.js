import { createHash } from 'crypto';
import { mkdirSync, existsSync, openSync, statSync, realpathSync } from 'fs';
import { join, sep } from 'path';
import { getExecutor } from './exec.js';
import { getConfigDir } from './config.js';
import { isMetroRunning } from './ports.js';

export function projectHash(projectPath) {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
}

export function logFileFor(projectPath) {
  const dir = join(getConfigDir(), 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${projectHash(projectPath)}.log`);
}

export function buildMetroSpawnArgs({ isExpo, port, extras = [] }) {
  const base = isExpo
    ? ['expo', 'start', '--port', String(port)]
    : ['react-native', 'start', '--port', String(port)];
  return {
    cmd: 'npx',
    args: [...base, ...extras],
  };
}

export async function ensureMetro({ projectPath, isExpo, port, extras = [], detach = true, readyTimeoutMs = 30000 }) {
  if (await isMetroRunning(port)) return { alreadyRunning: true, pid: null, ready: true };

  const log = logFileFor(projectPath);
  const fd = openSync(log, 'a');

  const { cmd, args } = buildMetroSpawnArgs({ isExpo, port, extras });
  const exec = getExecutor();
  const child = exec.spawn(cmd, args, {
    cwd: projectPath,
    detached: detach,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, RCT_METRO_PORT: String(port) },
  });
  if (detach) child.unref();

  // Wait until the dev server answers /status. The build CLI's "a Metro is
  // already on this port, reuse it" detection only fires once the port is
  // bound, so returning before that races the build into spawning a second
  // Metro. readyTimeoutMs <= 0 skips the wait.
  const ready = readyTimeoutMs > 0 ? await waitForMetroReady(port, readyTimeoutMs) : false;
  return { alreadyRunning: false, pid: child.pid, ready };
}

export async function waitForMetroReady(port, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isMetroRunning(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export function killMetroByPid(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export function findPidListeningOnPort(port) {
  const out = getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
  if (!out) return null;
  const pid = parseInt(out.split('\n')[0], 10);
  return Number.isFinite(pid) ? pid : null;
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function logFileExists(projectPath) {
  const path = logFileFor(projectPath);
  try {
    statSync(path);
    return path;
  } catch {
    return null;
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
export function parseLsofPids(out) {
  if (!out) return [];
  return String(out)
    .split('\n')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

// lsof -Fn field output looks like "p<pid>\nfcwd\nn<path>". Only the n-line
// following fcwd carries the directory.
export function parseLsofCwd(out) {
  if (!out) return null;
  const lines = String(out).split('\n');
  const idx = lines.findIndex((l) => l === 'fcwd');
  if (idx === -1) return null;
  const nLine = lines.slice(idx + 1).find((l) => l.startsWith('n'));
  return nLine ? nLine.slice(1) : null;
}

export function parsePsPgid(out) {
  if (!out) return null;
  const n = parseInt(String(out).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

export function processCwd(pid) {
  return parseLsofCwd(getExecutor().runQuiet(`lsof -a -p ${pid} -d cwd -Fn`));
}

export function processGroupLeader(pid) {
  return parsePsPgid(getExecutor().runQuiet(`ps -o pgid= -p ${pid}`));
}

// Canonicalize both sides before comparing: worktrees, and this machine's
// /Users -> /Volumes symlink, both make a plain textual prefix check wrong.
export function isInsideProject(cwd, projectPath) {
  if (!cwd || !projectPath) return false;
  const canon = (p) => {
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
//   { notOurs: <reason> }          listening but unproven; report, never kill
export async function resolveProjectMetro(port, projectPath, { probe = isMetroRunning } = {}) {
  const pids = parseLsofPids(getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`));
  if (pids.length === 0) return { missing: true };
  const pid = pids[0];

  if (!(await probe(port))) {
    return { notOurs: `pid ${pid} on port ${port} does not answer Metro's /status` };
  }
  const cwd = processCwd(pid);
  if (!cwd) {
    return { notOurs: `pid ${pid} on port ${port}: working directory could not be read` };
  }
  if (!isInsideProject(cwd, projectPath)) {
    return { notOurs: `pid ${pid} on port ${port} runs from ${cwd}, outside ${projectPath}` };
  }
  const leader = processGroupLeader(pid) ?? pid;
  return { metro: { pid, leader, cwd } };
}
