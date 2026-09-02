import { formatElapsed } from '../command-output.ts';
import { STABILITY_WINDOW_MS, VERIFY_TIMEOUT_MS } from './app-install.ts';
import {
  deviceLeasePath,
  fileLeaseIo,
  leaseIsExpired,
  parseLease,
  raiseLease,
  releaseRunLease,
  takeLease,
  type DeviceLease,
  type LeaseIo,
  type LeaseKind,
  type LeasePlatform,
} from './device-lease.ts';

export const LEASE_STEP_FLOOR_MS = 60_000;
export const DEBUG_VERIFY_STEP_MS: number = VERIFY_TIMEOUT_MS + STABILITY_WINDOW_MS;
export const DEFAULT_DEVICE_WAIT_SECONDS = 60;
export const DEVICE_WAIT_POLL_MS = 2_000;
const DEVICE_WAIT_LINE_MS = 30_000;

const DEVICE_BUSY = 'STIM_DEVICE_BUSY';
const DEVICE_LOST = 'STIM_DEVICE_LOST';

export function leaseStepMs(boundMs = 0): number {
  return Math.max(LEASE_STEP_FLOOR_MS, boundMs);
}

export function parseDeviceWait(value: unknown): { seconds: number } | { error: string } {
  if (value === undefined || value === null) return { seconds: DEFAULT_DEVICE_WAIT_SECONDS };
  const seconds = String(value).trim() === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(seconds) || seconds < 0) {
    return { error: `Invalid --wait value ${JSON.stringify(value)}. Pass a whole number of seconds, e.g. --wait 90.` };
  }
  return { seconds };
}

export function waitFlagConflict(argv: readonly string[]): boolean {
  const named = argv.some((arg) => arg === '--wait' || arg.startsWith('--wait='));
  return named && argv.includes('--no-wait');
}

export interface LeaseFacts {
  platform: string | null;
  id: string | null;
  deviceName: string | null;
  holder: string | null;
  expiresAt: string | null;
}

export interface RunLeaseRefusal {
  code: string;
  message: string;
  remedy: string;
  lease: LeaseFacts | null;
}

function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function leaseExpiryText(expiresAt: string, now: number): string {
  const remaining = Date.parse(expiresAt) - now;
  return `${clockTime(expiresAt)} (${formatElapsed(Math.max(0, remaining))} from now)`;
}

function describeDevice(lease: DeviceLease): string {
  return lease.deviceName ? `${lease.deviceName} (${lease.id})` : lease.id;
}

function facts(lease: DeviceLease): LeaseFacts {
  return {
    platform: lease.platform,
    id: lease.id,
    deviceName: lease.deviceName,
    holder: lease.holder,
    expiresAt: lease.expiresAt,
  };
}

function waitingLine(lease: DeviceLease, now: number): string {
  return (
    `waiting for ${lease.holder} to release ${describeDevice(lease)}; ` +
    `its lease runs until ${leaseExpiryText(lease.expiresAt, now)}`
  );
}

export type AppIdMatch = 'same' | 'different' | 'unknown';

export function appIdMatch(ours: string | null, theirs: string | null): AppIdMatch {
  if (!ours || !theirs) return 'unknown';
  return ours === theirs ? 'same' : 'different';
}

function bypassLines(lease: DeviceLease, now: number, match: AppIdMatch): string[] {
  const consequence = {
    same: 'Both workspaces build the same app id, so this install terminates the app that workspace is running.',
    different: "The other workspace's app id differs, so the launch below backgrounds it rather than ending it.",
    unknown:
      'Stim cannot tell whether the two workspaces build the same app id; if they do, this install terminates ' +
      "the holder's running app.",
  }[match];
  return [
    `--no-wait: ${lease.holder} holds ${describeDevice(lease)} until ${leaseExpiryText(lease.expiresAt, now)}, ` +
      'and this run is proceeding without a lease.',
    consequence,
  ];
}

function busyRefusal({
  lease,
  now,
  idLabel,
  waitSeconds,
}: {
  lease: DeviceLease;
  now: number;
  idLabel: string;
  waitSeconds: number;
}): RunLeaseRefusal {
  return {
    code: DEVICE_BUSY,
    message:
      `${lease.holder} holds ${describeDevice(lease)} until ${leaseExpiryText(lease.expiresAt, now)}` +
      (waitSeconds > 0 ? `, and this command waited ${waitSeconds}s for it.` : '.'),
    remedy:
      `Wait longer with \`--wait <seconds>\`, pick another device with \`--device <${idLabel}>\`, or pass ` +
      '`--no-wait` to install anyway -- which takes no lease and, when both workspaces build the same app id, ' +
      "terminates the holder's running app.",
    lease: facts(lease),
  };
}

function unreadableRefusal(path: string): RunLeaseRefusal {
  return {
    code: DEVICE_BUSY,
    message: `The lease file at ${path} does not parse, so Stim cannot tell who holds that device.`,
    remedy: `Read ${path} and, once you know no run depends on it, delete it. \`stim gc\` reports it on every run.`,
    lease: { platform: null, id: null, deviceName: null, holder: null, expiresAt: null },
  };
}

function untokenedRefusal(lease: DeviceLease, now: number): RunLeaseRefusal {
  return {
    code: DEVICE_BUSY,
    message:
      `This workspace holds ${describeDevice(lease)} until ${leaseExpiryText(lease.expiresAt, now)}, ` +
      'but its own record of that lease is gone, so this run cannot prove the lease is still its own.',
    remedy: 'Run `stim device unlock`, which releases by holder, then run this command again.',
    lease: facts(lease),
  };
}

function otherDeviceRefusal(leasedId: string, requestedId: string): RunLeaseRefusal {
  return {
    code: 'STIM_NO_DEVICE',
    message: `This workspace already leases ${leasedId}, and this run asked for ${requestedId}.`,
    remedy: `Run \`stim device unlock\` to give up ${leasedId}, or use it with \`--device ${leasedId}\`.`,
    lease: null,
  };
}

export function lostLine(holder: string | null, expiresAt: string | null, now: number): string {
  const who = holder ?? 'another workspace';
  const until = expiresAt ? ` until ${leaseExpiryText(expiresAt, now)}` : '';
  return `${who} took this device's lease${until}. The app is already installed, so this run continues without one.`;
}

export function lostRefusal(holder: string | null, expiresAt: string | null, now: number): RunLeaseRefusal {
  const who = holder ?? 'another workspace';
  const until = expiresAt ? ` until ${leaseExpiryText(expiresAt, now)}` : '';
  return {
    code: DEVICE_LOST,
    message: `${who} took this device's lease${until} before this run could install.`,
    remedy: 'Run this command again; it waits for that lease with `--wait <seconds>`.',
    lease: null,
  };
}

interface RunLeaseStep {
  ok: boolean;
  holder: string | null;
  expiresAt: string | null;
}

export interface RunLease {
  kind: LeaseKind | null;
  expiresAt: string | null;
  lost: boolean;
  raise: (boundMs: number) => RunLeaseStep;
  release: () => void;
  facts: () => { kind: LeaseKind; expiresAt: string } | null;
}

export function runLease({
  root,
  platform,
  kind,
  expiresAt,
  io = fileLeaseIo,
}: {
  root: string;
  platform: LeasePlatform;
  kind: LeaseKind | null;
  expiresAt: string | null;
  io?: LeaseIo;
}): RunLease {
  const handle: RunLease = {
    kind,
    expiresAt,
    lost: false,
    raise(boundMs) {
      if (handle.kind === null || handle.lost) {
        return { ok: !handle.lost, holder: null, expiresAt: handle.expiresAt };
      }
      const result = raiseLease({ root, platform, minMs: leaseStepMs(boundMs) }, io);
      if (result.status === 'raised') {
        handle.expiresAt = result.lease.expiresAt;
        return { ok: true, holder: result.lease.holder, expiresAt: result.lease.expiresAt };
      }
      handle.lost = true;
      const taken = result.status === 'lost' ? result.lease : null;
      return { ok: false, holder: taken?.holder ?? null, expiresAt: taken?.expiresAt ?? null };
    },
    release() {
      if (handle.kind === null) return;
      releaseRunLease({ root, platform }, io);
    },
    facts() {
      if (handle.kind === null || handle.lost || handle.expiresAt === null) return null;
      return { kind: handle.kind, expiresAt: handle.expiresAt };
    },
  };
  return handle;
}

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

export function releaseLeaseOnSignal(
  release: () => void,
  {
    on = (signal, handler) => {
      process.once(signal as NodeJS.Signals, handler);
    },
    off = (signal, handler) => {
      process.off(signal as NodeJS.Signals, handler);
    },
    exit = (code) => process.exit(code),
  }: {
    on?: (signal: string, handler: () => void) => void;
    off?: (signal: string, handler: () => void) => void;
    exit?: (code: number) => void;
  } = {},
): () => void {
  const installed: Array<[string, () => void]> = [];
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    const handler = () => {
      release();
      exit(SIGNAL_EXIT_CODES[signal] as number);
    };
    installed.push([signal, handler]);
    on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of installed) off(signal, handler);
    installed.length = 0;
  };
}

export type AcquireRunLeaseResult =
  | { status: 'leased'; kind: LeaseKind; expiresAt: string }
  | { status: 'unleased' }
  | { status: 'refused'; refusal: RunLeaseRefusal };

export type LeaseWaitOutcome =
  | { status: 'free' }
  | { status: 'ours'; lease: DeviceLease }
  | { status: 'bypassed'; lease: DeviceLease }
  | { status: 'refused'; refusal: RunLeaseRefusal };

export async function waitForDevice({
  root,
  platform,
  id,
  idLabel,
  waitSeconds,
  noWait = false,
  appId = null,
  holderAppId = () => null,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  warn = () => {},
  io = fileLeaseIo,
  deadline,
  lastLine,
}: {
  root: string;
  platform: LeasePlatform;
  id: string;
  idLabel: string;
  waitSeconds: number;
  noWait?: boolean;
  appId?: string | null;
  holderAppId?: (holder: string) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (line: string) => void;
  io?: LeaseIo;
  deadline: number;
  lastLine: { at: number | null };
}): Promise<LeaseWaitOutcome> {
  const path = deviceLeasePath(platform, id);
  for (;;) {
    const raw = io.readLease(path);
    const current = parseLease(raw);
    if (raw !== null && !current) return { status: 'refused', refusal: unreadableRefusal(path) };
    if (!current || leaseIsExpired(current, now())) return { status: 'free' };
    if (current.holder === root) return { status: 'ours', lease: current };
    if (noWait) {
      for (const line of bypassLines(current, now(), appIdMatch(appId, holderAppId(current.holder)))) warn(line);
      return { status: 'bypassed', lease: current };
    }
    if (now() >= deadline) {
      return { status: 'refused', refusal: busyRefusal({ lease: current, now: now(), idLabel, waitSeconds }) };
    }
    if (lastLine.at === null || now() - lastLine.at >= DEVICE_WAIT_LINE_MS) {
      lastLine.at = now();
      warn(waitingLine(current, now()));
    }
    await sleep(DEVICE_WAIT_POLL_MS);
  }
}

export async function acquireRunLease({
  root,
  platform,
  id,
  deviceName = null,
  idLabel,
  waitSeconds,
  noWait,
  installBoundMs,
  appId = null,
  holderAppId = () => null,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  warn = () => {},
  io = fileLeaseIo,
}: {
  root: string;
  platform: LeasePlatform;
  id: string;
  deviceName?: string | null;
  idLabel: string;
  waitSeconds: number;
  noWait: boolean;
  installBoundMs: number;
  appId?: string | null;
  holderAppId?: (holder: string) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (line: string) => void;
  io?: LeaseIo;
}): Promise<AcquireRunLeaseResult> {
  const recorded = io.readHolder(root)[platform];
  let held = recorded;
  if (recorded && recorded.id !== id) {
    const other = parseLease(io.readLease(deviceLeasePath(platform, recorded.id)));
    if (other && other.token === recorded.token && !leaseIsExpired(other, now())) {
      return { status: 'refused', refusal: otherDeviceRefusal(recorded.id, id) };
    }
    held = undefined;
  }

  const path = deviceLeasePath(platform, id);
  const deadline = now() + waitSeconds * 1000;
  const lastLine: { at: number | null } = { at: null };

  for (;;) {
    const current = parseLease(io.readLease(path));
    const mine = current && held && current.token === held.token ? { lease: current, record: held } : null;
    if (mine && (mine.record.kind === 'run' || !leaseIsExpired(mine.lease, now()))) {
      const raised = raiseLease({ root, platform, minMs: leaseStepMs(installBoundMs) }, io);
      if (raised.status === 'raised') {
        return { status: 'leased', kind: mine.record.kind, expiresAt: raised.lease.expiresAt };
      }
    }

    const outcome = await waitForDevice({
      root,
      platform,
      id,
      idLabel,
      waitSeconds,
      noWait,
      appId,
      holderAppId,
      now,
      sleep,
      warn,
      io,
      deadline,
      lastLine,
    });
    if (outcome.status === 'refused') return outcome;
    if (outcome.status === 'bypassed') return { status: 'unleased' };
    if (outcome.status === 'ours') return { status: 'refused', refusal: untokenedRefusal(outcome.lease, now()) };

    const taken = takeLease(
      { root, platform, id, deviceName, kind: 'run', durationMs: leaseStepMs(installBoundMs) },
      io,
    );
    if (taken.status === 'unreadable') return { status: 'refused', refusal: unreadableRefusal(taken.path) };
    if (taken.status === 'taken' || taken.status === 'set') {
      return {
        status: 'leased',
        kind: taken.status === 'set' ? (held?.kind ?? 'run') : 'run',
        expiresAt: taken.lease.expiresAt,
      };
    }
  }
}
