import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config.ts';
import { withDirLock } from '../dir-lock.ts';
import { clearWorkspaceStateKeys, readWorkspaceState, writeWorkspaceState } from '../supervisor/state.ts';
import { segment } from './build-lock.ts';

export const LEASE_VERSION = 1;
export const DEFAULT_LEASE_MS: number = 5 * 60 * 1000;
export const MIN_LEASE_MS: number = 10 * 1000;
export const MAX_LEASE_MS: number = 30 * 60 * 1000;

const LEASE_SUFFIX = '.json';
const LOCK_SUFFIX = '.lock';
const DURATION = /^[1-9][0-9]*(s|m)$/;

export type LeasePlatform = 'ios' | 'android';
export type LeaseKind = 'declared' | 'run';

export interface DeviceLease {
  version: number;
  platform: LeasePlatform;
  id: string;
  deviceName: string | null;
  holder: string;
  token: string;
  grantedAt: string | null;
  expiresAt: string;
}

export interface WorkspaceLeaseRecord {
  id: string;
  token: string;
  kind: LeaseKind;
}

export type WorkspaceLeases = Partial<Record<LeasePlatform, WorkspaceLeaseRecord>>;

export interface LeaseIo {
  now: () => number;
  readLease: (path: string) => string | null;
  writeLease: (path: string, text: string) => void;
  removeLease: (path: string) => void;
  listLeaseNames: () => string[];
  withLeaseLock: <T>(lockPath: string, fn: () => T) => T;
  readHolder: (root: string) => WorkspaceLeases;
  writeHolder: (root: string, leases: WorkspaceLeases) => void;
}

export function deviceLocksDir(): string {
  return join(getConfigDir(), 'device-locks');
}

function leaseStem(platform: string, id: string): string {
  return `${segment(platform)}-${segment(id)}`;
}

export function deviceLeasePath(platform: string, id: string): string {
  return join(deviceLocksDir(), `${leaseStem(platform, id)}${LEASE_SUFFIX}`);
}

export function deviceLeaseLockPath(platform: string, id: string): string {
  return join(deviceLocksDir(), `${leaseStem(platform, id)}${LOCK_SUFFIX}`);
}

export const fileLeaseIo: LeaseIo = {
  now: () => Date.now(),
  readLease(path) {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  },
  writeLease(path, body) {
    mkdirSync(deviceLocksDir(), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, body);
    try {
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  },
  removeLease(path) {
    rmSync(path, { force: true });
  },
  listLeaseNames() {
    try {
      return readdirSync(deviceLocksDir());
    } catch {
      return [];
    }
  },
  withLeaseLock(lockPath, fn) {
    return withDirLock(lockPath, fn, { ensureParent: () => mkdirSync(deviceLocksDir(), { recursive: true }) });
  },
  readHolder(root) {
    return parseWorkspaceLeases(readWorkspaceState(root)?.deviceLeases);
  },
  writeHolder(root, leases) {
    if (Object.keys(leases).length === 0) clearWorkspaceStateKeys(root, ['deviceLeases']);
    else writeWorkspaceState(root, { deviceLeases: leases });
  },
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isPlatform(value: unknown): value is LeasePlatform {
  return value === 'ios' || value === 'android';
}

export function parseLease(raw: string | null): DeviceLease | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entry = parsed as Record<string, unknown>;
  if (entry.version !== LEASE_VERSION || !isPlatform(entry.platform)) return null;
  const id = text(entry.id);
  const holder = text(entry.holder);
  const token = text(entry.token);
  const expiresAt = text(entry.expiresAt);
  if (!id || !holder || !token || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  return {
    version: LEASE_VERSION,
    platform: entry.platform,
    id,
    deviceName: text(entry.deviceName),
    holder,
    token,
    grantedAt: text(entry.grantedAt),
    expiresAt,
  };
}

export function parseWorkspaceLeases(value: unknown): WorkspaceLeases {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const leases: WorkspaceLeases = {};
  for (const [platform, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isPlatform(platform) || !entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = text(record.id);
    const token = text(record.token);
    if (!id || !token) continue;
    leases[platform] = { id, token, kind: record.kind === 'run' ? 'run' : 'declared' };
  }
  return leases;
}

export function leaseIsExpired(lease: DeviceLease, now: number): boolean {
  return Date.parse(lease.expiresAt) <= now;
}

export function parseLeaseDuration(value: string): { ms: number } | { error: string } {
  const raw = String(value ?? '').trim();
  const match = DURATION.exec(raw);
  if (!match) {
    return { error: `--for must be a whole number of seconds or minutes, such as 90s or 5m (got "${raw}").` };
  }
  const ms = Number(raw.slice(0, -1)) * (match[1] === 's' ? 1000 : 60 * 1000);
  if (ms < MIN_LEASE_MS || ms > MAX_LEASE_MS) {
    return { error: `--for must be between 10s and 30m (got "${raw}").` };
  }
  return { ms };
}

export interface LeaseFileEntry {
  path: string;
  name: string;
  platform: string;
  id: string | null;
  lease: DeviceLease | null;
}

export function listLeaseFiles(io: LeaseIo = fileLeaseIo): LeaseFileEntry[] {
  const dir = deviceLocksDir();
  const entries: LeaseFileEntry[] = [];
  for (const name of io.listLeaseNames().toSorted()) {
    if (!name.endsWith(LEASE_SUFFIX)) continue;
    const path = join(dir, name);
    const lease = parseLease(io.readLease(path));
    const stem = name.slice(0, -LEASE_SUFFIX.length);
    const cut = stem.indexOf('-');
    entries.push({
      path,
      name,
      platform: lease?.platform ?? (cut > 0 ? stem.slice(0, cut) : stem),
      id: lease?.id ?? (cut > 0 ? stem.slice(cut + 1) : null),
      lease,
    });
  }
  return entries;
}

function writeLease(lease: DeviceLease, io: LeaseIo): DeviceLease {
  io.writeLease(deviceLeasePath(lease.platform, lease.id), `${JSON.stringify(lease, null, 2)}\n`);
  return lease;
}

export type TakeLeaseResult =
  | { status: 'taken'; lease: DeviceLease }
  | { status: 'set'; lease: DeviceLease }
  | { status: 'held'; lease: DeviceLease }
  | { status: 'unreadable'; path: string };

export function takeLease(
  {
    root,
    platform,
    id,
    deviceName = null,
    kind,
    durationMs = DEFAULT_LEASE_MS,
  }: {
    root: string;
    platform: LeasePlatform;
    id: string;
    deviceName?: string | null;
    kind: LeaseKind;
    durationMs?: number;
  },
  io: LeaseIo = fileLeaseIo,
): TakeLeaseResult {
  const previous = io.readHolder(root)[platform];
  if (previous && previous.id !== id) releaseHeld(root, platform, previous, io);
  for (const entry of listLeaseFiles(io)) {
    const other = entry.lease;
    if (!other || other.platform !== platform || other.holder !== root || other.id === id) continue;
    releaseByRoot(root, platform, other.id, io);
  }

  const declared = previous?.kind === 'declared' && previous.id === id;
  const path = deviceLeasePath(platform, id);
  const result = io.withLeaseLock(deviceLeaseLockPath(platform, id), (): TakeLeaseResult => {
    const now = io.now();
    const raw = io.readLease(path);
    const current = parseLease(raw);
    if (raw !== null && !current) return { status: 'unreadable', path };
    const asked = now + durationMs;
    if (current && !leaseIsExpired(current, now)) {
      if (current.holder !== root) return { status: 'held', lease: current };
      const floor = declared && kind === 'run' ? Math.max(asked, Date.parse(current.expiresAt)) : asked;
      const kept = {
        ...current,
        deviceName: deviceName ?? current.deviceName,
        expiresAt: new Date(floor).toISOString(),
      };
      return { status: 'set', lease: writeLease(kept, io) };
    }
    const expiresAt = new Date(asked).toISOString();
    const granted: DeviceLease = {
      version: LEASE_VERSION,
      platform,
      id,
      deviceName,
      holder: root,
      token: randomBytes(12).toString('hex'),
      grantedAt: new Date(now).toISOString(),
      expiresAt,
    };
    return { status: 'taken', lease: writeLease(granted, io) };
  });

  if (result.status === 'taken' || result.status === 'set') {
    const recorded = result.status === 'set' && declared ? 'declared' : kind;
    io.writeHolder(root, { ...io.readHolder(root), [platform]: { id, token: result.lease.token, kind: recorded } });
  }
  return result;
}

export type RaiseLeaseResult =
  | { status: 'raised'; lease: DeviceLease }
  | { status: 'none' }
  | { status: 'lost'; lease: DeviceLease | null };

export function raiseLease(
  { root, platform, minMs }: { root: string; platform: LeasePlatform; minMs: number },
  io: LeaseIo = fileLeaseIo,
): RaiseLeaseResult {
  const record = io.readHolder(root)[platform];
  if (!record) return { status: 'none' };
  const path = deviceLeasePath(platform, record.id);
  return io.withLeaseLock(deviceLeaseLockPath(platform, record.id), (): RaiseLeaseResult => {
    const current = parseLease(io.readLease(path));
    if (!current || current.token !== record.token) return { status: 'lost', lease: current };
    const floor = io.now() + minMs;
    if (Date.parse(current.expiresAt) >= floor) return { status: 'raised', lease: current };
    const raised = { ...current, expiresAt: new Date(floor).toISOString() };
    return { status: 'raised', lease: writeLease(raised, io) };
  });
}

export interface ReleasedLease {
  platform: LeasePlatform;
  id: string;
  deviceName: string | null;
  expiresAt: string;
}

function summarize(lease: DeviceLease): ReleasedLease {
  return { platform: lease.platform, id: lease.id, deviceName: lease.deviceName, expiresAt: lease.expiresAt };
}

function releaseHeld(
  root: string,
  platform: LeasePlatform,
  record: WorkspaceLeaseRecord,
  io: LeaseIo,
): DeviceLease | null {
  const path = deviceLeasePath(platform, record.id);
  const released = io.withLeaseLock(deviceLeaseLockPath(platform, record.id), (): DeviceLease | null => {
    const current = parseLease(io.readLease(path));
    if (!current || current.token !== record.token) return null;
    io.removeLease(path);
    return current;
  });
  const held = io.readHolder(root);
  if (held[platform]?.token === record.token) {
    delete held[platform];
    io.writeHolder(root, held);
  }
  return released;
}

function releaseByRoot(root: string, platform: LeasePlatform, id: string, io: LeaseIo): DeviceLease | null {
  const path = deviceLeasePath(platform, id);
  return io.withLeaseLock(deviceLeaseLockPath(platform, id), (): DeviceLease | null => {
    const current = parseLease(io.readLease(path));
    if (!current || current.holder !== root) return null;
    io.removeLease(path);
    return current;
  });
}

export function releaseRunLease(
  { root, platform }: { root: string; platform: LeasePlatform },
  io: LeaseIo = fileLeaseIo,
): ReleasedLease | null {
  const record = io.readHolder(root)[platform];
  if (!record || record.kind !== 'run') return null;
  const released = releaseHeld(root, platform, record, io);
  return released ? summarize(released) : null;
}

export function releaseWorkspaceLeases(
  root: string,
  { platform = null }: { platform?: LeasePlatform | null } = {},
  io: LeaseIo = fileLeaseIo,
): ReleasedLease[] {
  const released: ReleasedLease[] = [];
  for (const [name, record] of Object.entries(io.readHolder(root))) {
    if (!isPlatform(name) || (platform && name !== platform)) continue;
    const lease = releaseHeld(root, name, record, io);
    if (lease) released.push(summarize(lease));
  }
  for (const entry of listLeaseFiles(io)) {
    const lease = entry.lease;
    if (!lease || lease.holder !== root) continue;
    if (platform && lease.platform !== platform) continue;
    const byRoot = releaseByRoot(root, lease.platform, lease.id, io);
    if (byRoot) released.push(summarize(byRoot));
  }
  return released;
}

export function removeExpiredLease(entry: LeaseFileEntry, io: LeaseIo = fileLeaseIo): boolean {
  const lease = entry.lease;
  if (!lease) return false;
  return io.withLeaseLock(deviceLeaseLockPath(lease.platform, lease.id), (): boolean => {
    const current = parseLease(io.readLease(entry.path));
    if (!current || !leaseIsExpired(current, io.now())) return false;
    io.removeLease(entry.path);
    return true;
  });
}

export interface PoolCandidate {
  id: string;
  name?: string | null;
}

export interface PoolHolder {
  id: string;
  holder: string;
  expiresAt: string;
}

export type PoolSelection =
  | { status: 'selected'; candidate: PoolCandidate }
  | { status: 'held-disconnected'; id: string }
  | { status: 'busy'; holders: PoolHolder[] }
  | { status: 'none' };

export function selectPoolDevice({
  candidates,
  leases,
  held = null,
  now,
}: {
  candidates: readonly PoolCandidate[];
  leases: readonly DeviceLease[];
  held?: string | null;
  now: number;
}): PoolSelection {
  const ordered = candidates.toSorted((a, b) => {
    const left = a.id.toLowerCase();
    const right = b.id.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (held) {
    const mine = ordered.find((candidate) => candidate.id === held);
    return mine ? { status: 'selected', candidate: mine } : { status: 'held-disconnected', id: held };
  }
  if (ordered.length === 0) return { status: 'none' };
  const byId = new Map(leases.map((lease) => [lease.id, lease]));
  const holders: PoolHolder[] = [];
  for (const candidate of ordered) {
    const lease = byId.get(candidate.id);
    if (!lease || leaseIsExpired(lease, now)) return { status: 'selected', candidate };
    holders.push({ id: lease.id, holder: lease.holder, expiresAt: lease.expiresAt });
  }
  return { status: 'busy', holders };
}
