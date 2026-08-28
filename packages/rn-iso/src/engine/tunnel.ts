// src/engine/tunnel.ts -- the lifecycle of a tunnel rn-iso starts for itself:
// launch the provider named by engine/metro-reach.ts's `{ start: provider }`
// plan, read the provider's own address back out of its (untrusted) output,
// optionally prove that address serves, and reap the process again on `stop`.
//
// A provider PRINTING its URL is not the same fact as that URL being routable.
// A cloudflared quick tunnel can take minutes to register with Cloudflare's
// edge after its connection log appears. `requireReachable` selects the
// startup contract: URL-only when Metro is not running yet, or a reachable URL
// when it is.
//
// Parsing is kept pure and separate from invocation (CLAUDE.md item 3):
// `parseCloudflaredLine` / `parseNgrokLine` take one line of a provider's
// output and return a URL or null, with no process, no clock and no network
// in sight, so the untrusted-output handling is tested without spawning
// anything.
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { isPidAlive } from '../metro.ts';
import { createLineReader } from '../supervisor/server-expo.ts';
import type { ManagedProvider } from './metro-reach.ts';

// The signature every spawn-injection seam in this module accepts:
// getExecutor().spawn's shape, loosened to a plain options bag so callers do
// not have to import SpawnOptions (same seam as engine/gradle.ts and
// engine/deps.ts).
type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

/** What `stop` needs to reap a tunnel this module started. */
export interface TunnelRecord {
  provider: ManagedProvider;
  pid: number;
  url: string;
  port: number;
  startedAt: string;
}

// --- pure: argv and the untrusted-output parsers ---------------------------

/** PURE. The argv rn-iso runs for a managed provider's own binary. */
export function tunnelArgv(
  provider: ManagedProvider,
  port: number,
  ngrokUrl?: string | null,
): { bin: string; args: string[] } {
  if (provider === 'cloudflared') {
    return { bin: 'cloudflared', args: ['tunnel', '--url', `http://127.0.0.1:${port}`] };
  }
  return {
    bin: 'ngrok',
    args: ['http', String(port), '--log=stdout', '--log-format=json', ...(ngrokUrl ? ['--url', ngrokUrl] : [])],
  };
}

const CLOUDFLARED_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * PURE. cloudflared prints its quick-tunnel URL on STDERR inside a banner
 * line, not as a line of its own, so this matches the URL anywhere in the
 * line rather than requiring the whole line to be the URL.
 */
export function parseCloudflaredLine(line: string): string | null {
  const match = line.match(CLOUDFLARED_URL_RE);
  return match ? match[0] : null;
}

/**
 * PURE. ngrok's `--log-format=json` prints one JSON object per line; the
 * tunnel's address is whichever line carries a `url` field. Parsed
 * defensively -- this is untrusted third-party output, and a provider
 * version bump that changes the schema must not throw.
 */
export function parseNgrokLine(line: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const url = (data as Record<string, unknown>).url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

function parserFor(provider: ManagedProvider): (line: string) => string | null {
  return provider === 'cloudflared' ? parseCloudflaredLine : parseNgrokLine;
}

// --- starting a tunnel -------------------------------------------------

// Long enough for a slow-starting binary to print its banner, short enough
// that a provider which will never print a URL (wrong version, no account
// configured) is reported as a failure rather than left hanging.
const URL_TIMEOUT_MS = 15_000;

// A cloudflared quick tunnel is the case that needs minutes, not seconds; see
// the header. ngrok routes immediately, but the same generous timeout is
// applied to both rather than branching per provider, because a slow network
// path can make either one late.
const REACHABLE_TIMEOUT_MS = 4 * 60_000;
const REACHABLE_POLL_MS = 2_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- serializing one managed acquisition per workspace --------------------

const TUNNEL_LOCK_RECORD = 'owner.json';
const TUNNEL_LOCK_WAIT_MS = 60_000;
const TUNNEL_LOCK_POLL_MS = 25;
const TUNNEL_LOCK_RECORD_GRACE_MS = 5_000;

interface TunnelLockRecord {
  pid: number;
  token: string;
}

interface ManagedTunnelLockOptions {
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

function managedTunnelLockPath(root: string): string {
  return join(root, '.rn-iso', 'metro-tunnel.lock');
}

function readTunnelLock(path: string): TunnelLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(join(path, TUNNEL_LOCK_RECORD), 'utf-8')) as Partial<TunnelLockRecord>;
    return typeof parsed.pid === 'number' && typeof parsed.token === 'string'
      ? { pid: parsed.pid, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

function tunnelLockAge(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function reapTunnelLock(path: string): void {
  const aside = `${path}.reap-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  rmSync(aside, { recursive: true, force: true });
}

export async function withManagedTunnelLock<T>(
  root: string,
  fn: () => Promise<T>,
  {
    isAlive = isPidAlive,
    now = Date.now,
    sleep = defaultSleep,
    waitMs = TUNNEL_LOCK_WAIT_MS,
  }: ManagedTunnelLockOptions = {},
): Promise<T> {
  const path = managedTunnelLockPath(root);
  const deadline = now() + waitMs;
  let owned: TunnelLockRecord | null = null;

  while (!owned) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      mkdirSync(path);
      owned = { pid: process.pid, token: randomUUID() };
      writeFileSync(join(path, TUNNEL_LOCK_RECORD), JSON.stringify(owned));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        if (owned) rmSync(path, { recursive: true, force: true });
        throw err;
      }
    }

    const holder = readTunnelLock(path);
    if (holder && !isAlive(holder.pid)) {
      reapTunnelLock(path);
      continue;
    }
    if (!holder) {
      const age = tunnelLockAge(path, now());
      if (age === null) continue;
      if (age > TUNNEL_LOCK_RECORD_GRACE_MS) {
        reapTunnelLock(path);
        continue;
      }
    }
    if (now() >= deadline) {
      const error = new Error(`Timed out waiting for the managed tunnel lock at ${path}.`);
      (error as Error & { code?: string }).code = 'RN_ISO_LOCK_TIMEOUT';
      throw error;
    }
    await sleep(TUNNEL_LOCK_POLL_MS);
  }

  try {
    return await fn();
  } finally {
    if (readTunnelLock(path)?.token === owned?.token) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

// Any HTTP response -- even a 404 from Metro's own router -- proves the
// tunnel forwards traffic to something behind it; only a connection failure
// means it is not routable yet.
async function defaultProbeReachable(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(url, { signal, redirect: 'follow' });
    return res.status > 0;
  } catch {
    return false;
  }
}

// Races the child's own stdout/stderr against its exit and a bounded
// timeout. A provider that dies, or that never prints a matching line, ends
// this the same way: url is null.
function waitForUrl(
  child: ChildProcess,
  parseLine: (line: string) => string | null,
  timeoutMs: number,
): Promise<{ url: string | null; exited: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let onOut: (chunk: unknown) => void;
    let onErr: (chunk: unknown) => void;
    let onError: () => void;
    let onExit: () => void;
    const finish = (url: string | null, exited = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener('data', onOut);
      child.stderr?.removeListener('data', onErr);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      resolve({ url, exited });
    };
    const onLine = (line: string) => {
      if (settled) return;
      const url = parseLine(line);
      if (url) finish(url);
    };
    const outReader = createLineReader(onLine);
    const errReader = createLineReader(onLine);
    onOut = (chunk: unknown) => outReader.push(chunk);
    onErr = (chunk: unknown) => errReader.push(chunk);
    onError = () => finish(null);
    onExit = () => finish(null, true);
    child.stdout?.setEncoding?.('utf-8');
    child.stderr?.setEncoding?.('utf-8');
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onErr);
    child.on('error', onError);
    child.on('exit', onExit);
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

// Polls `url` until something answers or `timeoutMs` runs out. `now`/`sleep`
// are the same clock-injection seam engine/metro-gate.ts uses, so a test
// drives a four-minute timeout without spending four minutes.
async function waitUntilReachable({
  url,
  now,
  sleep,
  probe,
  timeoutMs,
}: {
  url: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  probe: (url: string, signal: AbortSignal) => Promise<boolean>;
  timeoutMs: number;
}): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const controller = new AbortController();
    const ok = await probe(url, controller.signal).catch(() => false);
    if (ok) return true;
    if (now() >= deadline) return false;
    await sleep(REACHABLE_POLL_MS);
  }
}

export interface StartTunnelOptions {
  provider: ManagedProvider;
  port: number;
  spawnFn?: SpawnFn | null;
  urlTimeoutMs?: number;
  reachableTimeoutMs?: number;
  probeReachable?: (url: string, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ngrokUrl?: string | null;
  requireReachable?: boolean;
  cleanupTimeoutMs?: number;
  isChildAlive?: (pid: number) => boolean;
}

interface TunnelCleanupResult {
  status: 'stopped' | 'failed';
  reason?: string;
}

export type StartTunnelResult =
  | { url: string; pid: number; cleanup: () => Promise<TunnelCleanupResult> }
  | { failed: true; reason: string; cleanupFailed?: true };

const CLEANUP_TIMEOUT_MS = 1_000;
const CLEANUP_POLL_MS = 25;

/**
 * Start `provider`'s own binary against `port`, wait for it to print its
 * URL, then prove the URL actually serves before reporting success. Never
 * throws: every failure path (the binary would not start, it never printed a
 * URL, the URL never became reachable) is a returned `{ failed, reason }`.
 *
 * The process is left running, detached from this one, on success -- it is
 * `stopTunnel`'s job to reap it, not this call's caller exiting.
 */
export async function startTunnel({
  provider,
  port,
  spawnFn = null,
  urlTimeoutMs = URL_TIMEOUT_MS,
  reachableTimeoutMs = REACHABLE_TIMEOUT_MS,
  probeReachable = defaultProbeReachable,
  now = Date.now,
  sleep = defaultSleep,
  ngrokUrl = null,
  requireReachable = true,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  isChildAlive = isPidAlive,
}: StartTunnelOptions): Promise<StartTunnelResult> {
  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const { bin, args } = tunnelArgv(provider, port, ngrokUrl);

  let child: ChildProcess;
  try {
    child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detached: the tunnel outlives this call, exactly like the
      // supervisor it fronts, and leads its own process group so `stopTunnel`
      // can signal it without reaching whatever spawned it.
      detached: true,
    });
  } catch (err) {
    return { failed: true, reason: `Could not start ${provider}: ${describe(err)}` };
  }

  const { url, exited } = await waitForUrl(child, parserFor(provider), urlTimeoutMs);
  const cleanup = async (alreadyExited = false): Promise<TunnelCleanupResult> => {
    const stopped = await terminateChild(child, {
      alreadyExited,
      timeoutMs: cleanupTimeoutMs,
      now,
      sleep,
      isAlive: isChildAlive,
    });
    return stopped
      ? { status: 'stopped' }
      : {
          status: 'failed',
          reason: `Sent SIGKILL but could not confirm that pid ${child.pid ?? 'unknown'} exited.`,
        };
  };
  const failAfterCleanup = async (reason: string, alreadyExited = false): Promise<StartTunnelResult> => {
    const stopped = await cleanup(alreadyExited);
    return stopped.status === 'stopped'
      ? { failed: true, reason }
      : {
          failed: true,
          reason: `${reason} ${stopped.reason}`,
          cleanupFailed: true,
        };
  };
  if (!url) {
    return failAfterCleanup(
      exited
        ? `${provider} exited before printing a tunnel URL.`
        : `${provider} did not print a tunnel URL within ${urlTimeoutMs}ms.`,
      exited,
    );
  }
  resumeChildPipes(child);

  // Reachable startup proves that the discovered URL forwards traffic.
  if (requireReachable) {
    const reachable = await waitUntilReachable({
      url,
      now,
      sleep,
      probe: probeReachable,
      timeoutMs: reachableTimeoutMs,
    });
    if (!reachable) {
      return failAfterCleanup(
        `${url} did not become reachable within ${reachableTimeoutMs}ms; ${provider} may still be registering, or the network path is blocked.`,
      );
    }
  }

  const pid = child.pid;
  if (!pid) {
    return failAfterCleanup(`${provider} started but reported no pid.`);
  }
  unrefChildPipes(child);
  child.unref?.();
  return { url, pid, cleanup: () => cleanup() };
}

export interface StartTunnelSequenceOptions {
  providers: readonly ManagedProvider[];
  port: number;
  ngrokUrl?: string | null;
  requireReachable?: boolean;
  start?: (options: StartTunnelOptions) => Promise<StartTunnelResult>;
}

export type StartTunnelSequenceResult =
  | { provider: ManagedProvider; url: string; pid: number; cleanup: () => Promise<TunnelCleanupResult> }
  | { failed: true; reason: string };

/** Try the selected providers in order until one returns a public URL. */
export async function startTunnelSequence({
  providers,
  port,
  ngrokUrl = null,
  requireReachable = true,
  start = startTunnel,
}: StartTunnelSequenceOptions): Promise<StartTunnelSequenceResult> {
  const failures: string[] = [];
  for (const provider of providers) {
    const result = await start({
      provider,
      port,
      ngrokUrl: provider === 'ngrok' ? ngrokUrl : null,
      requireReachable,
    });
    if (!('failed' in result)) return { provider, ...result };
    failures.push(`${provider}: ${result.reason}`);
    if (result.cleanupFailed) return { failed: true, reason: failures.join(' ') };
  }
  return { failed: true, reason: failures.join(' ') || 'No managed tunnel provider was selected.' };
}

function closeChildPipes(child: ChildProcess): void {
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
}

function unrefChildPipes(child: ChildProcess): void {
  resumeChildPipes(child);
  for (const stream of [child.stdout, child.stderr]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }
}

function resumeChildPipes(child: ChildProcess): void {
  child.stdout?.resume?.();
  child.stderr?.resume?.();
}

async function signalAndWaitForExit(
  child: ChildProcess,
  signal: NodeJS.Signals,
  {
    timeoutMs,
    now,
    sleep,
    isAlive,
  }: {
    timeoutMs: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    isAlive: (pid: number) => boolean;
  },
): Promise<boolean> {
  let exited = false;
  const onExit = () => {
    exited = true;
  };
  child.once('exit', onExit);
  try {
    child.kill(signal);
  } catch (err) {
    child.removeListener('exit', onExit);
    return isEsrch(err);
  }
  const hasExited = () => exited;
  const deadline = now() + timeoutMs;
  while (!hasExited() && now() < deadline) {
    await sleep(CLEANUP_POLL_MS);
  }
  if (!hasExited() && child.pid && !isAlive(child.pid)) exited = true;
  child.removeListener('exit', onExit);
  return hasExited();
}

async function terminateChild(
  child: ChildProcess,
  {
    alreadyExited,
    timeoutMs,
    now,
    sleep,
    isAlive,
  }: {
    alreadyExited: boolean;
    timeoutMs: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    isAlive: (pid: number) => boolean;
  },
): Promise<boolean> {
  if (alreadyExited) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    closeChildPipes(child);
    return true;
  }
  const terminated = await signalAndWaitForExit(child, 'SIGTERM', { timeoutMs, now, sleep, isAlive });
  if (terminated) {
    closeChildPipes(child);
    return true;
  }
  const killed = await signalAndWaitForExit(child, 'SIGKILL', { timeoutMs, now, sleep, isAlive });
  closeChildPipes(child);
  return killed;
}

function describe(err: unknown): string {
  return (err as Error)?.message || String(err);
}

// --- stopping a tunnel -------------------------------------------------

export interface StopTunnelOptions {
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface StopTunnelResult {
  status: 'stopped' | 'missing' | 'failed';
  reason?: string;
}

const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 100;

function defaultKill(pid: number): void {
  process.kill(pid, 'SIGTERM');
}

function isEsrch(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ESRCH';
}

/**
 * Reap a tunnel `startTunnel` started. Idempotent and never throws: a
 * missing or already-dead pid is `missing`, not an error, and a signal that
 * does not take effect is a returned `failed` status rather than a thrown
 * one (CLAUDE.md item 4's containment rule).
 */
export async function stopTunnel(
  record: TunnelRecord | null | undefined,
  {
    isAlive = isPidAlive,
    kill = defaultKill,
    now = Date.now,
    sleep = defaultSleep,
    timeoutMs = STOP_TIMEOUT_MS,
  }: StopTunnelOptions = {},
): Promise<StopTunnelResult> {
  const pid = record?.pid;
  if (!pid || !isAlive(pid)) return { status: 'missing' };

  try {
    kill(pid);
  } catch (err) {
    return isEsrch(err) ? { status: 'missing' } : { status: 'failed', reason: describe(err) };
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline && isAlive(pid)) {
    await sleep(STOP_POLL_MS);
  }
  if (isAlive(pid)) return { status: 'failed', reason: `pid ${pid} did not exit within ${timeoutMs}ms.` };
  return { status: 'stopped' };
}
