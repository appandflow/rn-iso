import {
  deviceLeasePath,
  fileLeaseIo,
  leaseIsExpired,
  parseLease,
  selectPoolDevice,
  type DeviceLease,
  type LeaseIo,
  type LeasePlatform,
  type PoolCandidate,
  type PoolHolder,
} from './device-lease.ts';
import {
  DEVICE_BUSY,
  DEVICE_WAIT_LINE_MS,
  DEVICE_WAIT_POLL_MS,
  leaseExpiryText,
  type RunLeaseRefusal,
} from './device-lease-run.ts';

export interface PoolRefusalText {
  message: string;
  remedy: string;
}

export type PoolResult =
  | { status: 'selected'; candidate: PoolCandidate }
  | { status: 'refused'; refusal: RunLeaseRefusal };

export function heldPoolId(
  root: string,
  platform: LeasePlatform,
  now: number,
  io: LeaseIo = fileLeaseIo,
): string | null {
  const record = io.readHolder(root)[platform];
  if (!record) return null;
  const lease = parseLease(io.readLease(deviceLeasePath(platform, record.id)));
  if (!lease || lease.token !== record.token || leaseIsExpired(lease, now)) return null;
  return record.id;
}

function candidateLeases(platform: LeasePlatform, candidates: readonly PoolCandidate[], io: LeaseIo): DeviceLease[] {
  const leases: DeviceLease[] = [];
  for (const candidate of candidates) {
    const lease = parseLease(io.readLease(deviceLeasePath(platform, candidate.id)));
    if (lease) leases.push(lease);
  }
  return leases;
}

function disconnectedHeldRefusal(id: string, idLabel: string): RunLeaseRefusal {
  return {
    code: 'STIM_NO_DEVICE',
    message: `This workspace leases ${id}, and it is not connected.`,
    remedy:
      'Run `stim device unlock` to give it up, then run this command again. Naming another ' +
      `\`--device <${idLabel}>\` refuses the same way while this lease is held.`,
    lease: null,
  };
}

function poolBusyRefusal(
  holders: readonly PoolHolder[],
  leases: readonly DeviceLease[],
  now: number,
  waitSeconds: number,
): RunLeaseRefusal {
  const named = holders.map(
    (holder) => `${holder.id} (${holder.holder}, until ${leaseExpiryText(holder.expiresAt, now)})`,
  );
  const first = holders[0];
  const lease = first ? leases.find((entry) => entry.id === first.id) : undefined;
  return {
    code: DEVICE_BUSY,
    message:
      `Every connected device is leased by another workspace${waitSeconds > 0 ? `, and this run waited ${waitSeconds}s for one` : ''}: ` +
      `${named.join('; ')}.`,
    remedy:
      'Wait longer with `--wait <seconds>`, connect another device, or pass `--no-wait` to install anyway -- ' +
      "which takes no lease and, when both workspaces build the same app id, terminates the holder's running app.",
    lease: first
      ? {
          platform: lease?.platform ?? null,
          id: first.id,
          deviceName: lease?.deviceName ?? null,
          holder: first.holder,
          expiresAt: first.expiresAt,
        }
      : null,
  };
}

export async function selectFromPool({
  root,
  platform,
  idLabel,
  list,
  noCandidates,
  waitSeconds,
  deadline,
  noWait = false,
  now = Date.now,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  warn = () => {},
  io = fileLeaseIo,
}: {
  root: string;
  platform: LeasePlatform;
  idLabel: string;
  list: () => PoolCandidate[];
  noCandidates: () => PoolRefusalText;
  waitSeconds: number;
  deadline?: number;
  noWait?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (line: string) => void;
  io?: LeaseIo;
}): Promise<PoolResult> {
  const held = heldPoolId(root, platform, now(), io);
  const until = deadline ?? now() + waitSeconds * 1000;
  let lastLine: number | null = null;

  for (;;) {
    const candidates = list();
    const leases = candidateLeases(platform, candidates, io);
    const selection = selectPoolDevice({ candidates, leases, held, now: now() });

    if (selection.status === 'selected') return selection;
    if (selection.status === 'held-disconnected') {
      return { status: 'refused', refusal: disconnectedHeldRefusal(selection.id, idLabel) };
    }
    if (selection.status === 'none') {
      const { message, remedy } = noCandidates();
      return { status: 'refused', refusal: { code: 'STIM_NO_DEVICE', message, remedy, lease: null } };
    }

    const first = selection.holders[0];
    if (noWait && first) {
      const candidate = candidates.find((entry) => entry.id === first.id);
      if (candidate) return { status: 'selected', candidate };
    }
    if (now() >= until) {
      return { status: 'refused', refusal: poolBusyRefusal(selection.holders, leases, now(), waitSeconds) };
    }
    if (lastLine === null || now() - lastLine >= DEVICE_WAIT_LINE_MS) {
      lastLine = now();
      const holders = selection.holders
        .map((holder) => `${holder.id} (${holder.holder}, until ${leaseExpiryText(holder.expiresAt, now())})`)
        .join('; ');
      warn(`waiting for a free device; every connected one is leased: ${holders}`);
    }
    await sleep(DEVICE_WAIT_POLL_MS);
  }
}
