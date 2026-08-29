import { resolveOwnedIosSim, shutdownIosSim, deleteIosSim } from './sim/ios.ts';
import { resolveOwnedAvdSerial, shutdownAndroidEmulator, deleteAvd } from './sim/android.ts';

export interface TeardownOutcome {
  status: 'torn-down' | 'missing' | 'skipped' | 'failed';
  label?: string;
  kind?: string;
  reason?: string;
  serial?: string | null;
  holders?: string[];
}

export function teardownOwnedIosSim(
  udid: string,
  { del = false, label }: { del?: boolean; label?: string } = {},
): TeardownOutcome {
  try {
    const resolved = resolveOwnedIosSim(udid);
    if (resolved.notOwned) {
      return {
        status: 'skipped',
        kind: 'not-owned',
        reason: `sim is now named "${resolved.notOwned}", not stim-cli-owned by name`,
      };
    }
    if (resolved.missing) return { status: 'missing' };
    shutdownIosSim(udid);
    if (del) deleteIosSim(udid);
    return { status: 'torn-down', label: label ?? resolved.sim?.name ?? udid };
  } catch (e) {
    return { status: 'failed', reason: String((e as Error)?.message || e) };
  }
}

export function teardownOwnedAvd(avdName: string, { del = false }: { del?: boolean } = {}): TeardownOutcome {
  try {
    const resolved = resolveOwnedAvdSerial(avdName);
    if (resolved.notOwned) {
      return { status: 'skipped', kind: 'not-owned', reason: `AVD ${avdName} is not stim-cli-owned by name` };
    }
    if (resolved.missing) return { status: 'missing' };
    if (resolved.serial) shutdownAndroidEmulator(resolved.serial);
    if (del) deleteAvd(avdName);
    return { status: 'torn-down', label: avdName, serial: resolved.serial ?? null };
  } catch (e) {
    return { status: 'failed', reason: String((e as Error)?.message || e) };
  }
}
