# Simulator pool

Date: 2026-09-02. Status: proposed. Issue: #273.

## Summary

Stim keeps a bounded pool of parked simulators. When a workspace gives up
its owned simulator, Stim parks it instead of deleting it: shut down, clear
the workspace's app data while keeping the app installed, reset the app's
privacy grants and the keychain, rename, record. When a workspace needs a simulator, Stim adopts a
parked one of the same model and runtime before creating a new one. The pool
holds at most a configured number of simulators (default 3); beyond that the
oldest parked one is deleted. `gc` reports the pool and `gc --delete`
empties it.

## Motivation

Measured on 2026-09-02 (the cache-hit run-time investigation): a fresh
worktree's cache-hit run takes 72.6 s, of which the first boot of a newly
created simulator is about 30 s. `simctl create` is 0.3 s. A simulator
that has booted before boots in about 9 s; after `simctl erase` it boots in
about 21 s, so erasing costs most of what parking saves. Not erasing keeps the previous workspace's app data, privacy grants, and
keychain items, which is why parking clears those three things explicitly.
Keeping the app itself installed lets a workspace whose build is the one
already on the simulator skip the install (measured 5-19 s) through the
existing installed-container proof.

## Scope

In: owned iOS simulators (phase 1) and owned Android emulators (phase 2,
same rules, `avdmanager`/`adb` equivalents). Out: user-created devices
(invariant 2), a booted pool (parked simulators are shut down; keeping one
booted is a later setting), physical devices, remote devices.

## The pool record

The pool is machine state under the global config lock, in
`~/.stim/config.json` beside the project registry:

    "pool": {
      "ios": [
        { "udid": "...", "name": "stim-parked (<model> <runtime>) <4 hex>", "deviceTypeIdentifier": "...",
          "runtimeIdentifier": "...", "parkedAt": "...", "parkedFrom": "/canonical/root",
          "bundleId": "com.example.app", "cacheKey": "<hash>-debug-sim" }
      ],
      "android": []
    }

Every parked simulator is Stim-created, carries the `stim-` prefix, and is
listed here; a `stim-parked-*` simulator that is not listed is an orphan
that `gc` reports (invariant 8: reported, not deleted, until `--delete`).

## Settings

`pool.iosParkedMax` (default 3) and `pool.androidParkedMax` (default 3,
phase 2) are machine-level settings, read like the concurrency caps: the
environment variable (`STIM_POOL_IOS_PARKED_MAX`) wins over the machine
config. `0` disables parking: `worktree remove` deletes the simulator as
today and nothing is adopted. A value that is not a whole number is
`STIM_BAD_ARG` at the command that reads it.

## Naming

An owned simulator's name carries its model and runtime so `simctl list`
and the Simulator app show what a workspace runs on:

    stim-<label> (<model> <runtime>)            e.g. stim-feat-login (iPhone 17 26.5)
    stim-parked (<model> <runtime>) <4 hex>     e.g. stim-parked (iPad Pro 13-inch (M4) 26.5) a1f3

The model is the device type's display name as simctl reports it; the
runtime is its version. The label is the text between `stim-` and ` (`.
Names are capped at 60 characters: the label is shortened first (keeping its
start), then the model, never the `stim-` prefix or the runtime; a shortened
name is still unique per machine because ownership is recorded by udid, not
by name. Ownership checks match the `stim-` prefix and the registry's udid,
as today. Android AVD names cannot carry spaces or parentheses
(`avdmanager` allows `[A-Za-z0-9._-]`), so AVDs use
`stim-<label>-api<level>-<abi>`, e.g. `stim-feat-login-api36-arm64`.

## Park

Parking replaces deletion inside `teardown.ts`'s owned-device removal
(invariant 4: one place), so `worktree remove` and `gc --delete` of an
orphaned workspace both park when the pool has room:

1. Shut the simulator down if booted.
2. Clear the workspace's recorded app's data while keeping it installed:
   empty the contents of `Documents`, `Library`, `tmp`, and `SystemData` in
   the app's data container (`simctl get_app_container <udid> <bundleId>
data`, taken before shutdown), measured at 28 ms with the app relaunching
   cleanly afterwards; skip silently when no app is recorded. Any other app
   the workspace installed is uninstalled (`simctl listapps` filtered to
   non-system apps that are not the recorded one).
3. `simctl privacy <udid> reset all <bundleId>` and
   `simctl keychain <udid> reset`.
4. `simctl rename <udid> "stim-parked (<model> <runtime>) <4 hex>"` (the
   hex from the udid).
5. Under the config lock: append the record, carrying the recorded app's
   bundle id and the cache key of the artifact installed on it; if the pool now exceeds the
   maximum, delete the oldest by `parkedAt` (`simctl delete`) and drop
   its record. Removing the device record from the project registry happens
   in the same locked write, so a crash between steps leaves either a
   workspace-owned simulator (retried by the next remove) or a parked one,
   never a simulator no record names.

A step that fails after 1 falls back to deletion, as today, and prints the
failed step. `stop` is unchanged: it shuts the owned simulator down and
keeps it owned; parking is a consequence of giving the workspace up.

## Adopt

When `ensureOwnedIosDevice` finds no owned simulator for the workspace:

1. Resolve the wanted model and runtime as today (flag, setting, default).
2. Under the config lock, take the parked simulator whose
   `deviceTypeIdentifier` and `runtimeIdentifier` both match, oldest
   first; remove its record from the pool and record it as this workspace's
   owned device in the same write, with `adopted: true`.
3. `simctl rename <udid> "stim-<label> (<model> <runtime>)"` (0.2 s) so the
   ownership naming rule holds without exception.
4. Boot and configure as today (SimSlim profile, dev-menu preferences,
   scheme preapproval). The `device` phase line reads
   `stim-<label> (<udid>) adopted (<time>)` instead of `created`.
5. Install as today: when the run's cache key equals the parked record's
   and the installed-container proof passes, the install is skipped
   (`install     unchanged`); otherwise the cached app is installed over
   the parked one, which is an upgrade install onto cleared data.

A parked simulator whose `simctl list` state is missing or unavailable is
dropped from the pool and reported; adoption then falls through to creation.
No match (model or runtime differs) creates a new simulator as today; the
pool is never a reason to boot a different model than requested.

## gc and status

`gc` lists the pool: count, each simulator's model, runtime, age, and
disk use (`du` of its data directory). `gc --delete` deletes every parked
simulator and clears the list; it also deletes orphaned `stim-parked-*`
simulators it reported. `status` prints one line per platform:
`pool: 2 parked iOS simulators (max 3)`, omitted when the pool is empty and
parking is disabled.

## Hermetic suites

The native e2e harness asserts a device-free machine and runs with
`STIM_POOL_IOS_PARKED_MAX=0` (and the Android twin) so its rows neither
adopt nor park; the pool is exercised by its own e2e row (create, remove,
create again, assert `adopted`, assert the count and the bound).

## Guidance deltas

`guide`: the pool in the lifecycle topic (what park removes and what it
keeps, that adoption matches model and runtime exactly, the bound and the
setting, the `adopted` phase line), the settings entries, `gc`'s report
and `--delete` effect, and `status`'s line. Skill: the permanent rule
under ownership: a parked simulator is Stim-owned; never delete one by hand,
`gc --delete` does. AGENTS.md invariant 2 gains: "Stim parks an owned
simulator it no longer needs instead of deleting it, up to a configured
maximum, and adopts a parked one before creating; parked simulators are
listed in the pool record and are the only devices `gc --delete` removes
without a workspace." Invariant 4: park is a teardown flow.

## Testing

- Pure: pool selection (exact model and runtime match, oldest first), the
  bound (oldest deleted), the settings parse and the `0` case, the
  orphan classification.
- Real simctl once (invariant 9): the park recipe (data-container clear,
  `privacy reset all`, `keychain reset`, `rename`), the adopt rename, and an
  adopted run that skips the install because the parked build matches; the
  measured boot time after the recipe recorded in the PR (expected about
  10 s, measured 10 s on 2026-09-02, not the erase path's 21 s).
- Command tests with `STIM_HOME` redirected: `worktree remove` parks
  and evicts; `ios` adopts and prints `adopted`; `gc` reports and
  `--delete` empties; `status` line; parking disabled by `0`.
- The e2e pool row above.
- Hardware/simulator field check: a cache-hit run in a fresh worktree with
  a parked match must land near 20-30 s (investigation: 20.3-32.5 s) against
  the 72.6 s baseline; quote both.

## Decisions

| Question         | Decision                                                         | Why                                                                 |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Erase on park    | No; uninstall the app, reset its privacy grants and the keychain | Erase costs a 12 s boot penalty; the three resets remove what leaks |
| Bound            | Configurable, default 3, oldest evicted                          | Bounded disk (about 2.5 GB per parked simulator)                    |
| Where park lives | `teardown.ts`                                                    | Invariant 4                                                         |
| Booted pool      | Not now                                                          | 2.6 GB RAM per booted simulator; a later setting                    |
| Match rule       | Model and runtime identifiers, exact                             | A ticket that asks for an iPad must never get an iPhone             |
| Suites           | Pool disabled by environment                                     | Rows stay device-free and hermetic                                  |
