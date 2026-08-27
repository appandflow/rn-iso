// src/engine/tunnel.ts -- the lifecycle of a tunnel rn-iso starts for itself:
// launch the provider named by engine/metro-reach.ts's `{ start: provider }`
// plan, read the provider's own address back out of its (untrusted) output,
// prove that address actually serves before calling it ready, and reap the
// process again on `stop`.
//
// CRITICAL, and the reason step three exists at all: a provider PRINTING its
// URL is not the same fact as that URL being routable. A cloudflared quick
// tunnel can take MINUTES to register with Cloudflare's edge even after its
// own log says the connection came up -- confirmed live, and it cost hours of
// misdiagnosis here, because everything downstream (the Metro gate, the
// device) looked like it was talking to a dead tunnel when the tunnel was
// simply not up yet. So `startTunnel` never reports success on the URL alone;
// it polls the URL itself until something answers, with a generous and
// injectable timeout, and only then hands the URL back.
//
// Parsing is kept pure and separate from invocation (CLAUDE.md item 3):
// `parseCloudflaredLine` / `parseNgrokLine` take one line of a provider's
// output and return a URL or null, with no process, no clock and no network
// in sight, so the untrusted-output handling is tested without spawning
// anything.
import type { ChildProcess } from 'node:child_process';
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
export function tunnelArgv(provider: ManagedProvider, port: number): { bin: string; args: string[] } {
  if (provider === 'cloudflared') {
    return { bin: 'cloudflared', args: ['tunnel', '--url', `http://127.0.0.1:${port}`] };
  }
  return { bin: 'ngrok', args: ['http', String(port), '--log=stdout', '--log-format=json'] };
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
    const finish = (url: string | null, exited = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url, exited });
    };
    const onLine = (line: string) => {
      if (settled) return;
      const url = parseLine(line);
      if (url) finish(url);
    };
    const outReader = createLineReader(onLine);
    const errReader = createLineReader(onLine);
    child.stdout?.setEncoding?.('utf-8');
    child.stderr?.setEncoding?.('utf-8');
    child.stdout?.on('data', (chunk: unknown) => outReader.push(chunk));
    child.stderr?.on('data', (chunk: unknown) => errReader.push(chunk));
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null, true));
    const timer = setTimeout(() => finish(null), timeoutMs);
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
}

export type StartTunnelResult = { url: string; pid: number } | { failed: true; reason: string };

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
}: StartTunnelOptions): Promise<StartTunnelResult> {
  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const { bin, args } = tunnelArgv(provider, port);

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
  if (!url) {
    killChild(child);
    return {
      failed: true,
      reason: exited
        ? `${provider} exited before printing a tunnel URL.`
        : `${provider} did not print a tunnel URL within ${urlTimeoutMs}ms.`,
    };
  }

  // CRITICAL (see header): printing the URL is not the same as the URL being
  // routable, so success is never reported on it alone.
  const reachable = await waitUntilReachable({
    url,
    now,
    sleep,
    probe: probeReachable,
    timeoutMs: reachableTimeoutMs,
  });
  if (!reachable) {
    killChild(child);
    return {
      failed: true,
      reason: `${url} did not become reachable within ${reachableTimeoutMs}ms; ${provider} may still be registering, or the network path is blocked.`,
    };
  }

  const pid = child.pid;
  if (!pid) {
    killChild(child);
    return { failed: true, reason: `${provider} started but reported no pid.` };
  }
  child.unref?.();
  return { url, pid };
}

// Aborts a tunnel attempt that is not going to succeed. Uses the ChildProcess
// handle directly (rather than process.kill by pid, as stopTunnel below
// does) because this runs inside the same call that spawned it and already
// holds the handle.
function killChild(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
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
