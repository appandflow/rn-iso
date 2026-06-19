import { createHash } from 'crypto';
import { mkdirSync, existsSync, openSync, statSync } from 'fs';
import { join } from 'path';
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
