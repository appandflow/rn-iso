import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import chalk from 'chalk';
import { clearDevice } from '../../config.ts';
import { plural } from '../../command-output.ts';
import { directorySize } from '../../fs-util.ts';
import { leaseIsExpired, listLeaseFiles, type LeaseFileEntry } from '../../engine/device-lease.ts';
import { listAllIosSims, listIosDeviceTypes, parseRuntimeVersion, type IosSimRecord } from '../../sim/ios.ts';
import { ownedAvdDirectory } from '../../sim/android.ts';
import { dropParked, readParked, type ParkedSim } from '../../sim-pool.ts';
import { teardownOwnedIosSim, teardownOwnedAvd, teardownParkedIosSim } from '../../teardown.ts';
import type { Config, OrphanedDevice } from '../../types.ts';

export interface StaleProjectDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  project: string;
  idleDays: number;
  bytes?: number;
}

export interface StaleDeviceRecord {
  kind: 'ios' | 'android';
  id: string;
  project: string;
  owned: boolean;
}

interface KeptDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  reason: string;
}

interface KeptLeaseFile {
  name: string;
  path: string;
  reason: string;
}

export interface DeviceLeaseGarbage {
  expired: LeaseFileEntry[];
  kept: KeptLeaseFile[];
}

export interface ParkedSimReport {
  udid: string;
  name: string;
  model: string | null;
  runtime: string | null;
  parkedAt: string;
  bytes: number | null;
  listed: boolean | null;
}

export interface GcDeviceDependencies {
  avdDirectory?: typeof ownedAvdDirectory;
  directorySize?: typeof directorySize;
  listAllIosSims?: typeof listAllIosSims;
  listIosDeviceTypes?: typeof listIosDeviceTypes;
  deleteParkedIosSim?: (udid: string) => void;
}

// simctl and emulator listings can exceed 10 seconds on loaded hosts; 30 seconds still bounds hangs.
export const DEVICE_LIST_TIMEOUT_MS = 30000;
const AVD_SIZE_TIMEOUT_MS = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

function describeKept(ref: { path: string; mounted: boolean }): string {
  return ref.mounted
    ? `referenced by ${ref.path}`
    : `referenced by ${ref.path} (volume not mounted; kept just in case)`;
}

export function findOrphanedDevices({
  sims = [],
  avds = [],
  config,
  isMounted,
  deadProjects = [],
}: {
  sims?: IosSimRecord[];
  avds?: string[];
  config: Config | null;
  isMounted?: (path: string) => boolean;
  deadProjects?: string[];
}): { orphaned: OrphanedDevice[]; kept: KeptDevice[] } {
  const dead = new Set(deadProjects);
  const referenced = new Map<string, { path: string; mounted: boolean }>();

  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path)) continue;
    const mounted = isMounted ? isMounted(path) : true;
    const ios = proj?.platforms?.ios;
    if (ios?.deviceUdid) {
      referenced.set(ios.deviceUdid, { path, mounted });
    }
    const android = proj?.platforms?.android;
    if (android?.avdName) {
      referenced.set(android.avdName, { path, mounted });
    }
  }
  for (const sim of readParked('ios', { config })) {
    referenced.set(sim.udid, { path: 'the simulator pool', mounted: true });
  }

  const orphaned: OrphanedDevice[] = [];
  const kept: KeptDevice[] = [];

  for (const sim of sims) {
    if (!sim?.name?.startsWith('stim-')) continue;
    const ref = referenced.get(sim.udid);
    if (!ref) {
      orphaned.push({ kind: 'ios', id: sim.udid, name: sim.name });
    } else {
      kept.push({ kind: 'ios', id: sim.udid, name: sim.name, reason: describeKept(ref) });
    }
  }

  for (const avdName of avds) {
    if (!avdName?.startsWith('stim-')) continue;
    const ref = referenced.get(avdName);
    if (!ref) {
      orphaned.push({ kind: 'android', id: avdName, name: avdName });
    } else {
      kept.push({ kind: 'android', id: avdName, name: avdName, reason: describeKept(ref) });
    }
  }

  return { orphaned, kept };
}

export function findStaleProjectDevices({
  config,
  sims = [],
  avds = [],
  olderThanDays,
  now = Date.now(),
  lastTouched,
  deadProjects = [],
}: {
  config: Config | null;
  sims?: IosSimRecord[];
  avds?: string[];
  olderThanDays?: number;
  now?: number;
  lastTouched?: (path: string) => number;
  deadProjects?: string[];
}): StaleProjectDevice[] {
  if (!Number.isFinite(olderThanDays) || typeof lastTouched !== 'function') return [];
  const cutoff = now - (olderThanDays as number) * DAY_MS;
  const dead = new Set(deadProjects);

  const liveSims = new Map<string, string>(
    sims.filter((s) => s?.name?.startsWith('stim-')).map((s) => [s.udid, s.name] as [string, string]),
  );
  const liveAvds = new Set(avds.filter((a) => typeof a === 'string' && a.startsWith('stim-')));

  const stale: StaleProjectDevice[] = [];
  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path) || !isAbsolute(path)) continue;
    const touched = lastTouched(path);
    if (!Number.isFinite(touched) || touched >= cutoff) continue;
    const idleDays = Math.floor((now - touched) / DAY_MS);

    const ios = proj?.platforms?.ios;
    if (ios?.owned && ios.deviceUdid && liveSims.has(ios.deviceUdid)) {
      stale.push({
        kind: 'ios',
        id: ios.deviceUdid,
        name: liveSims.get(ios.deviceUdid) as string,
        project: path,
        idleDays,
      });
    }
    const android = proj?.platforms?.android;
    if (android?.owned && android.avdName && liveAvds.has(android.avdName)) {
      stale.push({ kind: 'android', id: android.avdName, name: android.avdName, project: path, idleDays });
    }
  }
  return stale;
}

export function findStaleDeviceRecords({
  config,
  sims = [],
  avds = [],
  deadProjects = [],
  simsChecked = true,
  avdsChecked = true,
}: {
  config: Config | null;
  sims?: IosSimRecord[];
  avds?: string[];
  deadProjects?: string[];
  simsChecked?: boolean;
  avdsChecked?: boolean;
}): StaleDeviceRecord[] {
  const dead = new Set(deadProjects);
  const liveSims = new Set(sims.map((s) => s?.udid).filter(Boolean));
  const liveAvds = new Set(avds.filter((a) => typeof a === 'string'));

  const stale: StaleDeviceRecord[] = [];
  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path)) continue;

    const ios = proj?.platforms?.ios;
    if (simsChecked && ios?.deviceUdid && !liveSims.has(ios.deviceUdid)) {
      stale.push({ kind: 'ios', id: ios.deviceUdid, project: path, owned: Boolean(ios.owned) });
    }
    const android = proj?.platforms?.android;
    if (avdsChecked && android?.avdName && !liveAvds.has(android.avdName)) {
      stale.push({ kind: 'android', id: android.avdName, project: path, owned: Boolean(android.owned) });
    }
  }
  return stale;
}

export function describeUnverifiableDevices(
  simNames: string[] = [],
  avdNames: string[] = [],
  { reason = 'no Stim config found' }: { reason?: string } = {},
): string[] {
  const ours = [...simNames, ...avdNames].filter((n) => typeof n === 'string' && n.startsWith('stim-'));
  if (ours.length === 0) return [`${reason}; device sweep skipped`];
  return [
    `${reason}, so ${ours.length} stim-created device(s) cannot be verified as orphaned: ${ours.join(', ')}`,
    'they were NOT touched. If they are stale, delete them with `xcrun simctl delete <udid>` or `avdmanager delete avd -n <name>`',
  ];
}

export function withAndroidAvdSizes<T extends { kind: 'ios' | 'android'; id: string; bytes?: number }>(
  devices: T[],
  {
    avdDirectory = ownedAvdDirectory,
    size = directorySize,
  }: { avdDirectory?: typeof ownedAvdDirectory; size?: typeof directorySize } = {},
): T[] {
  return devices.map((device) => {
    if (device.kind !== 'android') return device;
    const dir = avdDirectory(device.id);
    if (!dir) return device;
    try {
      const bytes = size(dir, { timeoutMs: AVD_SIZE_TIMEOUT_MS });
      return bytes > 0 ? { ...device, bytes } : device;
    } catch {
      return device;
    }
  });
}

export function describeParkedSims(
  records: readonly ParkedSim[],
  sims: readonly IosSimRecord[],
  deviceTypes: readonly { identifier: string; name: string }[],
  { simsChecked = true }: { simsChecked?: boolean } = {},
): ParkedSimReport[] {
  const listed = new Map(sims.map((sim) => [sim.udid, sim]));
  return records.map((record) => {
    const sim = listed.get(record.udid);
    return {
      udid: record.udid,
      name: sim?.name ?? record.name,
      model: deviceTypes.find((d) => d.identifier === record.deviceTypeIdentifier)?.name ?? null,
      runtime: sim ? parseRuntimeVersion(sim.runtime) : parseRuntimeVersion(record.runtimeIdentifier),
      parkedAt: record.parkedAt,
      bytes: typeof sim?.dataPathSize === 'number' ? sim.dataPathSize : null,
      listed: simsChecked ? Boolean(sim) : null,
    };
  });
}

export function collectParkedSims(deps: GcDeviceDependencies): ParkedSimReport[] {
  const records = readParked('ios');
  if (records.length === 0) return [];
  let sims: IosSimRecord[];
  let deviceTypes: { identifier: string; name: string }[] = [];
  try {
    sims = (deps.listAllIosSims ?? listAllIosSims)({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, includeUnavailable: true });
  } catch {
    return describeParkedSims(records, [], [], { simsChecked: false });
  }
  try {
    deviceTypes = (deps.listIosDeviceTypes ?? listIosDeviceTypes)();
  } catch {}
  return describeParkedSims(records, sims, deviceTypes);
}

export function deleteParkedSims(parkedSims: readonly ParkedSimReport[], deps: GcDeviceDependencies = {}): number {
  let failures = 0;
  let emptied = 0;
  for (const sim of parkedSims) {
    if (sim.listed === null) {
      failures++;
      console.log(chalk.red(`Could not verify parked ios sim ${sim.name} (${sim.udid}); its pool record was kept.`));
      continue;
    }
    try {
      const teardown = sim.listed
        ? teardownParkedIosSim(sim.udid, { label: sim.name, deleteSim: deps.deleteParkedIosSim })
        : null;
      const removed = sim.listed ? teardown?.status === 'torn-down' : dropParked('ios', sim.udid);
      if (!removed) {
        if (teardown?.status === 'failed') {
          failures++;
          console.log(chalk.red(`Failed to delete parked ios sim ${sim.name}: ${teardown.reason}`));
        } else {
          console.log(chalk.dim(`Skipped ${sim.name} (${sim.udid}); it is no longer parked.`));
        }
        continue;
      }
      emptied++;
      console.log(
        chalk.green(
          sim.listed
            ? `Deleted parked ios sim ${sim.name} (${sim.udid})`
            : `Dropped the parked record for ${sim.name} (${sim.udid}); it is not on this machine.`,
        ),
      );
    } catch (err) {
      failures++;
      console.log(chalk.red(`Failed to delete parked ios sim ${sim.name}: ${(err as Error)?.message || err}`));
    }
  }
  if (emptied) console.log(chalk.dim(`  emptied ${plural(emptied, 'parked simulator')} from the pool`));
  return failures;
}

export function deviceSweepIsScoped(unsafeAllowScopedDeviceSweep?: boolean): boolean {
  return Boolean(process.env.STIM_HOME) && !unsafeAllowScopedDeviceSweep;
}

export function collectDeviceLeases(now: number): DeviceLeaseGarbage {
  const expired: LeaseFileEntry[] = [];
  const kept: KeptLeaseFile[] = [];
  for (const entry of listLeaseFiles()) {
    const lease = entry.lease;
    if (!lease) {
      kept.push({
        name: entry.name,
        path: entry.path,
        reason: 'it does not parse as a lease, so no run may take that device',
      });
      continue;
    }
    if (leaseIsExpired(lease, now)) {
      expired.push(entry);
      continue;
    }
    if (!existsSync(lease.holder)) {
      kept.push({
        name: entry.name,
        path: entry.path,
        reason: `${lease.holder} is not on this machine, but the lease runs until ${lease.expiresAt}`,
      });
    }
  }
  return { expired, kept };
}

export function deleteProjectDevices(
  orphanedDevices: OrphanedDevice[],
  staleDevices: StaleProjectDevice[],
  staleDeviceRecords: StaleDeviceRecord[],
): number {
  let deleteFailures = 0;
  function reap(d: OrphanedDevice | StaleProjectDevice) {
    const r =
      d.kind === 'ios'
        ? teardownOwnedIosSim(d.id, { del: true, label: d.name })
        : teardownOwnedAvd(d.name, { del: true });
    const what = d.kind === 'ios' ? `ios sim ${d.name} (${d.id})` : `android avd ${d.name}`;
    if (r.status === 'torn-down') {
      console.log(chalk.green(`Deleted ${what}`));
    } else if (r.status === 'missing') {
      console.log(chalk.dim(`${what} is already gone; nothing to delete.`));
    } else if (r.status === 'skipped') {
      console.log(chalk.yellow(`Skipped ${what}: ${r.reason} -- left for a later gc`));
    } else {
      deleteFailures++;
      console.log(chalk.red(`Failed to delete ${d.kind} device ${d.name}: ${r.reason}`));
    }
    return r.status;
  }

  for (const d of orphanedDevices) reap(d);

  for (const d of staleDevices) {
    const status = reap(d);
    if (status === 'torn-down' || status === 'missing') {
      clearDevice(d.project, d.kind);
      console.log(chalk.dim(`  cleared the ${d.kind} record for ${d.project}`));
    }
  }

  for (const r of staleDeviceRecords) {
    clearDevice(r.project, r.kind);
    console.log(chalk.green(`Cleared the ${r.kind} record for ${r.project} (${r.id} is not on this machine)`));
  }

  return deleteFailures;
}
