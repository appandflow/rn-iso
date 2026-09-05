import { formatLongDuration, shortUdid } from '../../command-output.ts';
import { formatBytes } from '../../fs-util.ts';
import type { BuildLockInfo, BuildSlotInfo, GcSkip, OrphanedDevice } from '../../types.ts';
import type { GcCache } from './caches.ts';
import type { DeviceLeaseGarbage, ParkedSimReport, StaleDeviceRecord, StaleProjectDevice } from './devices.ts';
import type { EasSessionSweep } from './eas-sessions.ts';

export interface GcReport {
  skipped: GcSkip[];
  deadProjects: string[];
  invalidProjects: string[];
  parkedSims: ParkedSimReport[];
  orphanedDevices: OrphanedDevice[];
  staleDevices: StaleProjectDevice[];
  staleDeviceRecords: StaleDeviceRecord[];
  buildLocks: { stale: BuildLockInfo[]; live: BuildLockInfo[] };
  buildSlots: { stale: BuildSlotInfo[]; live: BuildSlotInfo[] };
  deviceLeases: DeviceLeaseGarbage;
  deviceSweepNotices: string[];
  easSessionSweep: EasSessionSweep;
  caches: GcCache[];
  cacheScope: string | null;
  olderThan: number | null;
  all: boolean;
}

function shortKey(key: unknown) {
  const text = String(key ?? '');
  return text.length > 6 ? `${text.slice(0, 6)}..` : text;
}

function parkedAge(parkedAt: string, now: number): string {
  const at = Date.parse(parkedAt);
  if (!Number.isFinite(at)) return 'parked at an unknown time';
  return `parked ${formatLongDuration(Math.max(0, now - at))} ago`;
}

function formatParkedSimReport(parkedSims: readonly ParkedSimReport[], now: number): string[] {
  if (parkedSims.length === 0) return [];
  const known = parkedSims.filter((sim) => sim.bytes !== null);
  const total = known.reduce((sum, sim) => sum + (sim.bytes ?? 0), 0);
  const size = known.length === parkedSims.length ? `, ${formatBytes(total)}` : '';
  const lines = [`Parked simulators (${parkedSims.length}${size}):`];
  for (const sim of parkedSims) {
    const model = [sim.model, sim.runtime].filter(Boolean).join(' ');
    const age = parkedAge(sim.parkedAt, now);
    const bytes = sim.bytes === null ? '' : ` ${formatBytes(sim.bytes)}`;
    const gone =
      sim.listed === false ? ' - not on this machine' : sim.listed === null ? ' - listing unavailable; kept' : '';
    lines.push(`  ios ${sim.name} (${shortUdid(sim.udid)})${model ? ` ${model}` : ''} ${age}${bytes}${gone}`);
  }
  lines.push('              --delete attempts verified deletions and keeps failures.');
  return lines;
}

function projectEntryLines(header: string, paths: string[]): string[] {
  return paths.length ? [header, ...paths.map((path) => `  ${path}`)] : [];
}

export function formatGcReport(
  {
    skipped = [],
    deadProjects = [],
    invalidProjects = [],
    parkedSims = [],
    orphanedDevices = [],
    staleDevices = [],
    staleDeviceRecords = [],
    buildLocks = { stale: [], live: [] },
    buildSlots = { stale: [], live: [] },
    deviceLeases = { expired: [], kept: [] },
    deviceSweepNotices = [],
    easSessionSweep = { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
    caches = [],
    cacheScope = null,
    olderThan = null,
  }: Partial<GcReport>,
  { now = Date.now() }: { now?: number } = {},
): string[] {
  const lines: string[] = [];
  const staleLocks = buildLocks?.stale ?? [];
  const liveLocks = buildLocks?.live ?? [];
  const staleSlots = buildSlots?.stale ?? [];
  const expiredLeases = deviceLeases?.expired ?? [];

  if (cacheScope) {
    lines.push(`Cache scope: "${cacheScope}". Devices, project entries and locks were not inspected.`);
  } else if (
    deadProjects.length === 0 &&
    invalidProjects.length === 0 &&
    parkedSims.length === 0 &&
    orphanedDevices.length === 0 &&
    staleDevices.length === 0 &&
    staleDeviceRecords.length === 0 &&
    staleLocks.length === 0 &&
    staleSlots.length === 0 &&
    expiredLeases.length === 0 &&
    easSessionSweep.orphaned.length === 0
  ) {
    const reasons = [];
    if (skipped.length > 0) {
      reasons.push(`${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} could not be checked`);
    }
    if (deviceSweepNotices.length > 0) {
      reasons.push('device sweep incomplete');
    }
    if (easSessionSweep.notices.length > 0) {
      reasons.push('EAS session sweep incomplete');
    }
    if (reasons.length > 0) {
      lines.push(`Nothing to reclaim (${reasons.join('; ')}; see below).`);
    } else {
      lines.push('Nothing to reclaim.');
    }
  }

  lines.push(...projectEntryLines(`Dead project entries (${deadProjects.length}):`, deadProjects));
  lines.push(
    ...projectEntryLines(
      `Invalid project entries (${invalidProjects.length}) - the key is not an absolute path:`,
      invalidProjects,
    ),
  );

  lines.push(...formatParkedSimReport(parkedSims, now));

  if (orphanedDevices.length) {
    lines.push(`Orphaned devices (${orphanedDevices.length}):`);
    for (const d of orphanedDevices) lines.push(`  ${d.kind} ${d.name} (${d.id})${deviceSizeSuffix(d)}`);
  }

  if (staleDevices.length) {
    lines.push(`Stale owned devices (${staleDevices.length}) - project untouched for ${olderThan ?? '?'}d or more:`);
    for (const d of staleDevices) {
      lines.push(`  ${d.kind} ${d.name} (${d.id})${deviceSizeSuffix(d)}`);
      lines.push(`              ${d.project} (idle ${d.idleDays}d)`);
    }
  }

  if (staleDeviceRecords.length) {
    lines.push(`Stale device records (${staleDeviceRecords.length}) - the device is gone, the project is not:`);
    for (const r of staleDeviceRecords) {
      lines.push(`  ${r.kind} ${r.id} is not on this machine`);
      lines.push(`              recorded by ${r.project}`);
    }
    lines.push('              --delete clears the RECORD only; there is no device left to touch.');
  }

  if (easSessionSweep.orphaned.length) {
    lines.push(`Orphaned EAS sessions (${easSessionSweep.orphaned.length}) - current EAS project only:`);
    for (const session of easSessionSweep.orphaned) {
      const details = [session.platform, session.status].filter(Boolean).join(', ');
      lines.push(`  ${session.name} (${session.id})${details ? ` [${details}]` : ''}`);
      lines.push(`              project scope: ${session.projectScope}`);
      lines.push(`              remedy: eas simulator:stop --id ${session.id}`);
    }
  }

  if (staleLocks.length) {
    lines.push(`Stale build locks (${staleLocks.length}) - the process that was building is gone:`);
    for (const lock of staleLocks) {
      lines.push(`  ${lock.platform} ${shortKey(lock.key)} (pid ${lock.pid ?? '?'} is not running)`);
      lines.push(`              started by ${lock.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  if (staleSlots.length) {
    lines.push(`Stale build slots (${staleSlots.length}) - the process that was building is gone:`);
    for (const slot of staleSlots) {
      lines.push(`  slot ${slot.index ?? '?'} (pid ${slot.pid ?? '?'} is not running)`);
      lines.push(`              held by ${slot.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  if (liveLocks.length) {
    lines.push(`Builds in progress (${liveLocks.length}) - NOT touched, by anything:`);
    for (const lock of liveLocks) {
      lines.push(`  ${lock.platform} ${shortKey(lock.key)} (pid ${lock.pid})`);
      lines.push(`              building in ${lock.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  lines.push(...leaseGarbageLines(deviceLeases));

  if (deviceSweepNotices.length) {
    lines.push(`Device sweep notices (${deviceSweepNotices.length}):`);
    for (const notice of deviceSweepNotices) lines.push(`  ${notice}`);
  }

  if (easSessionSweep.notices.length) {
    lines.push(`EAS session sweep notices (${easSessionSweep.notices.length}):`);
    for (const notice of easSessionSweep.notices) lines.push(`  ${notice}`);
  }

  if (skipped.length) {
    lines.push(`Skipped (${skipped.length}) - not classified as dead:`);
    for (const entry of skipped) lines.push(`  ${entry.dir}: ${entry.reason}`);
  }

  if (caches.length) {
    const total = caches.reduce((n, c) => n + (c.bytes ?? 0), 0);
    lines.push(`Shared build caches (${caches.length}) - alive, not garbage:`);
    for (const c of caches) {
      const tag = c.source ? ` (${c.source})` : '';
      lines.push(`  ${formatBytes(c.bytes ?? 0).padStart(10)}  ${c.name}${tag}`);
      lines.push(`              ${c.dir}`);
      if (c.note) lines.push(`              ${c.note}`);
      if (c.willEmpty) lines.push('              would be EMPTIED');
      else if (c.emptySkipped) lines.push(`              would be left alone: ${c.emptySkipped}`);
    }
    lines.push(`  total: ${formatBytes(total)}`);
    const doomed = caches.filter((c) => c.willEmpty);
    if (doomed.length) {
      const doomedBytes = doomed.reduce((n, c) => n + (c.bytes ?? 0), 0);
      lines.push(`  would empty ${doomed.length} of these (${formatBytes(doomedBytes)})`);
    }
  }

  return lines;
}

function leaseGarbageLines({ expired, kept }: DeviceLeaseGarbage): string[] {
  const lines: string[] = [];
  if (expired.length) {
    lines.push(`Expired device leases (${expired.length}) - the device is already free:`);
    for (const entry of expired) {
      const name = entry.lease?.deviceName ? ` (${entry.lease.deviceName})` : '';
      lines.push(`  ${entry.platform} ${entry.id ?? entry.name}${name}`);
      lines.push(
        `              held by ${entry.lease?.holder ?? 'an unrecorded workspace'} until ${entry.lease?.expiresAt}`,
      );
    }
    lines.push('              --delete removes the FILE only; an expired lease already holds nothing.');
  }
  if (kept.length) {
    lines.push(`Device lease files kept (${kept.length}) - reported, never deleted:`);
    for (const entry of kept) lines.push(`  ${entry.name}: ${entry.reason}`);
  }
  return lines;
}

function deviceSizeSuffix(device: { kind: 'ios' | 'android'; bytes?: number }): string {
  return device.kind === 'android' && device.bytes !== undefined ? ` - ${formatBytes(device.bytes)} on disk` : '';
}
