import {
  clearAppDataContainer,
  deleteParkedIosSim,
  deleteIosSim,
  findAppDataContainer,
  listIosDeviceTypes,
  parkedSimName,
  parseRuntimeVersion,
  renameIosSim,
  resolveOwnedIosSim,
  shutdownIosSim,
  type IosSimRecord,
} from './sim/ios.ts';
import { resolveOwnedAvdSerial, shutdownAndroidEmulator, deleteAvd } from './sim/android.ts';
import { parkSim, type ParkedSim } from './sim-pool.ts';

export interface ParkedDevice {
  udid: string;
  name: string;
}

export interface TeardownOutcome {
  status: 'torn-down' | 'missing' | 'skipped' | 'failed';
  label?: string;
  kind?: string;
  reason?: string;
  serial?: string | null;
  holders?: string[];
  parked?: ParkedDevice;
  evicted?: ParkedDevice[];
  evictionFailures?: string[];
  parkFallback?: string;
}

export interface ParkRequest {
  projectPath: string;
  max: number;
  bundleId?: string | null;
  cacheKey?: string | null;
  simslimManaged?: boolean;
}

function parkOwnedIosSim(udid: string, park: ParkRequest): { record: ParkedSim; evicted: ParkedSim[] } {
  const resolved = resolveOwnedIosSim(udid);
  if (resolved.missing) throw new Error(`simulator ${udid} disappeared after shutdown`);
  if (resolved.notOwned) throw new Error(`simulator ${udid} is now named ${JSON.stringify(resolved.notOwned)}`);
  const sim = resolved.sim as IosSimRecord;
  if (sim.state !== 'Shutdown') throw new Error(`simulator ${udid} is still ${sim.state} after shutdown`);
  const model = listIosDeviceTypes().find((d) => d.identifier === sim.deviceTypeIdentifier)?.name ?? null;
  const runtime = parseRuntimeVersion(sim.runtime);
  if (park.bundleId && sim.dataPath) {
    const container = findAppDataContainer(sim.dataPath, park.bundleId);
    if (container) clearAppDataContainer(container);
  }
  const name = parkedSimName(sim.udid, { model, runtime });
  renameIosSim(sim.udid, name);
  const record: ParkedSim = {
    udid: sim.udid,
    name,
    deviceTypeIdentifier: sim.deviceTypeIdentifier,
    runtimeIdentifier: sim.runtime,
    parkedAt: new Date().toISOString(),
    simslimManaged: Boolean(park.simslimManaged),
    ...(park.bundleId ? { bundleId: park.bundleId } : {}),
    ...(park.cacheKey ? { cacheKey: park.cacheKey } : {}),
  };
  const evicted = parkSim({ platform: 'ios', projectPath: park.projectPath, record, max: park.max });
  return { record, evicted };
}

export function teardownOwnedIosSim(
  udid: string,
  { del = false, label, park }: { del?: boolean; label?: string; park?: ParkRequest } = {},
): TeardownOutcome {
  let parkFallback: string | undefined;
  try {
    const resolved = resolveOwnedIosSim(udid);
    if (resolved.notOwned) {
      return {
        status: 'skipped',
        kind: 'not-owned',
        reason: `sim is now named "${resolved.notOwned}", not Stim-owned by name`,
      };
    }
    if (resolved.missing) return { status: 'missing' };
    shutdownIosSim(udid);
    const sim = resolved.sim as IosSimRecord;
    if (del && park && park.max > 0) {
      try {
        const { record, evicted } = parkOwnedIosSim(udid, park);
        const removed: ParkedDevice[] = [];
        const failures: string[] = [];
        for (const entry of evicted) {
          try {
            deleteParkedIosSim(entry.udid);
            removed.push({ udid: entry.udid, name: entry.name });
          } catch (e) {
            failures.push(
              `could not delete evicted ${entry.name} (${entry.udid}): ${String((e as Error)?.message || e)}`,
            );
          }
        }
        return {
          status: 'torn-down',
          label: label ?? sim.name ?? udid,
          parked: { udid: record.udid, name: record.name },
          evicted: removed,
          ...(failures.length ? { evictionFailures: failures } : {}),
        };
      } catch (e) {
        parkFallback = String((e as Error)?.message || e);
      }
    }
    if (del) deleteIosSim(udid);
    return { status: 'torn-down', label: label ?? sim.name ?? udid, ...(parkFallback ? { parkFallback } : {}) };
  } catch (e) {
    return {
      status: 'failed',
      reason: String((e as Error)?.message || e),
      ...(parkFallback ? { parkFallback } : {}),
    };
  }
}

export function teardownOwnedAvd(avdName: string, { del = false }: { del?: boolean } = {}): TeardownOutcome {
  try {
    const resolved = resolveOwnedAvdSerial(avdName);
    if (resolved.notOwned) {
      return { status: 'skipped', kind: 'not-owned', reason: `AVD ${avdName} is not Stim-owned by name` };
    }
    if (resolved.missing) return { status: 'missing' };
    if (resolved.serial) shutdownAndroidEmulator(resolved.serial);
    if (del) deleteAvd(avdName);
    return { status: 'torn-down', label: avdName, serial: resolved.serial ?? null };
  } catch (e) {
    return { status: 'failed', reason: String((e as Error)?.message || e) };
  }
}
