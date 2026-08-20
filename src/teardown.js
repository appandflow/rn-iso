// src/teardown.js
//
// The single implementation of "tear down a device rn-iso owns". Before this
// the resolve -> occupancy -> shutdown -> delete sequence existed inline four
// times (reclaim, release, shutdown, gc) and CLAUDE.md simultaneously claimed
// reclaim.js was "the one place" and admitted the other three re-implemented
// it. Only discipline kept them consistent, and they had begun to drift.
//
// The invariants this centralizes, in order:
//   1. Re-resolve against the LIVE sim/AVD list immediately before issuing any
//      destructive command. A recorded udid/AVD name is not proof: the sim may
//      have been renamed away from rn-iso- ownership, or the record may be
//      stale, and firing shutdown first would land on whatever real device
//      that identifier now resolves to.
//   2. Check occupancy (iOS only -- Android has no probe) and skip an occupied
//      device rather than destroying it. `force` is the sole override.
//   3. Only then shut down, and delete only if asked.
//   4. Contain failures: a throw becomes a reported outcome, never an
//      exception that aborts a batch (worktree remove reaping several nested
//      projects, gc sweeping many orphans).
//
// Outcomes:
//   { status: 'torn-down', label }   shut down, and deleted when del was set
//   { status: 'missing' }            already gone; not an error
//   { status: 'skipped', kind, reason }  not ours ('not-owned') or busy
//                                    ('occupied') -- untouched. `kind` is there
//                                    so callers can branch without matching on
//                                    prose (shutdown reports the two cases
//                                    differently).
//   { status: 'failed', reason }     threw; nothing further attempted
import { isSimOccupied, resolveOwnedIosSim, shutdownIosSim, deleteIosSim } from './sim/ios.js';
import { resolveOwnedAvdSerial, shutdownAndroidEmulator, deleteAvd } from './sim/android.js';

export function teardownOwnedIosSim(udid, { del = false, force = false, label } = {}) {
  try {
    const resolved = resolveOwnedIosSim(udid);
    if (resolved.notOwned) {
      return { status: 'skipped', kind: 'not-owned', reason: `sim is now named "${resolved.notOwned}", not rn-iso-owned by name` };
    }
    if (resolved.missing) return { status: 'missing' };
    if (!force && isSimOccupied(udid)) {
      return { status: 'skipped', kind: 'occupied', reason: 'in use by another process (occupied)' };
    }
    shutdownIosSim(udid);
    if (del) deleteIosSim(udid);
    return { status: 'torn-down', label: label ?? resolved.sim?.name ?? udid };
  } catch (e) {
    return { status: 'failed', reason: String(e?.message || e) };
  }
}

// Android has no occupancy probe, so `force` is accepted and ignored for
// signature symmetry with the iOS side rather than silently implying one.
export function teardownOwnedAvd(avdName, { del = false } = {}) {
  try {
    const resolved = resolveOwnedAvdSerial(avdName);
    if (resolved.notOwned) {
      return { status: 'skipped', kind: 'not-owned', reason: `AVD ${avdName} is not rn-iso-owned by name` };
    }
    if (resolved.missing) return { status: 'missing' };
    // resolved.notRunning is a live AVD that simply is not booted: there is
    // nothing to shut down, but it still exists and is still ours to delete.
    if (resolved.serial) shutdownAndroidEmulator(resolved.serial);
    if (del) deleteAvd(avdName);
    return { status: 'torn-down', label: avdName, serial: resolved.serial ?? null };
  } catch (e) {
    return { status: 'failed', reason: String(e?.message || e) };
  }
}
