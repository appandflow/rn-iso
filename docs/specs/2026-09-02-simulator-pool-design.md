# Simulator pool

Date: 2026-09-02. Status: proposed. Issue: #273.

## Summary

Stim keeps a bounded pool of parked simulators. When `worktree remove` gives
up a workspace's owned simulator, Stim parks it instead of deleting it: shut
down, clear the app's data on disk while keeping the app installed, rename,
record. When a workspace needs a simulator, Stim adopts a parked one of the
same model and runtime before creating a new one, and finishes cleaning it
after the boot it pays anyway: privacy grants, keychain, and every app that
is not this workspace's. The pool holds at most a configured number of
simulators (default 3); beyond that the oldest parked one is deleted. `gc`
reports the pool and `gc --delete` empties it.

## Motivation

Measured on 2026-09-02 (the cache-hit run-time investigation): a fresh
worktree's cache-hit run takes 72.6 s, of which the first boot of a newly
created simulator is about 30 s. `simctl create` is 0.3 s. A simulator that
has booted before boots in about 9 s; after `simctl erase` it boots in about
21 s, so erasing costs most of what parking saves. Not erasing keeps the
previous workspace's app data, privacy grants, keychain items, and apps,
which is why parking and adoption remove those explicitly. Keeping the app
itself installed lets a workspace whose build is the one already on the
simulator skip the install (measured 4.5-16 s) through the existing
installed-container proof.

Which `simctl` subcommands work on a shut-down simulator decides where each
cleaning step runs. Probed on 2026-09-03 against a scratch simulator
(iPhone 17, iOS 26.5): `rename` works while shut down (0.13 s);
`get_app_container`, `listapps`, `uninstall`, `privacy reset`, and
`keychain reset` all refuse with `SimError 405, Unable to lookup in current
state: Shutdown`. Clearing the data container's directories on disk while
shut down took 39 ms, and the app relaunched cleanly after the next boot
(8.9 s). Since `stop` normally precedes `worktree remove`, the simulator is
shut down at park time, so the steps that need a booted simulator move to
adoption, after the boot the adopter pays anyway.

## Scope

In: owned iOS simulators (phase 1) and owned Android emulators (phase 2; the
Android park recipe and its measurements are decided by the running Android
cache-hit investigation, not here). Out: user-created devices (invariant 2),
a booted pool (parked simulators are shut down; keeping one booted is a later
setting), physical devices, remote devices.

## The pool record

Parked simulators are machine state under the global config lock, in
`$STIM_HOME/config.json` beside the project registry, under a `parked` key
that holds records only:

    "parked": {
      "ios": [
        { "udid": "...", "name": "stim-parked (<model> <runtime>) <4 hex>",
          "deviceTypeIdentifier": "...", "runtimeIdentifier": "...",
          "parkedAt": "...", "bundleId": "com.example.app",
          "cacheKey": "<hash>-debug-sim", "simslimManaged": false }
      ],
      "android": []
    }

`bundleId` and `cacheKey` describe the app left installed (both absent when
the workspace never installed one). `simslimManaged` carries the workspace's
SimSlim state so adoption can reconcile it. Every parked simulator is
Stim-created, carries the `stim-` prefix, and is listed here. Orphan: a
`stim-` simulator that neither the pool nor any project record names; `gc`
reports it and `--delete` removes it, as today (invariant 8: reported, not
deleted, until `--delete`).

## Settings

`pool.iosParkedMax` (default 3) and `pool.androidParkedMax` (default 3,
phase 2) are read like the concurrency caps: a top-level `pool` key in the
machine's `$STIM_HOME/config.json`, overridden by `STIM_POOL_IOS_PARKED_MAX`
(and the Android twin). Absent means 3. `0` disables parking and adoption:
`worktree remove` deletes the simulator as today, `ios` never adopts, and an
existing pool stays where it is until `gc --delete`. A value that is not a
non-negative integer is `STIM_BAD_ARG` in `worktree remove` and `ios`, and a warning
in `status`, `gc`, and `doctor`.

When `STIM_HOME` is set in the environment, parking and adoption are off
unless the environment variable is set explicitly. Test suites and the
harness redirect `STIM_HOME` and would otherwise leave parked simulators on
the machine; a redirected home that wants a pool says so.

## Naming

An owned simulator's name carries its model and runtime so `simctl list`
and the Simulator app show what a workspace runs on:

    stim-<label> (<model> <runtime>)            e.g. stim-feat-login (iPhone 17 26.5)
    stim-parked (<model> <runtime>) <4 hex>     e.g. stim-parked (iPad Pro 13-inch (M4) 26.5) a1f3

The model is the device type's display name as simctl reports it; the
runtime is its version. The 4 hex characters come from the udid and may
repeat among parked simulators of one model and runtime; identity is the
udid. Names are capped at 60 characters: the label is shortened first
(keeping its start), then the model, never the `stim-` prefix or the
runtime, so the label segment is the workspace's label or a prefix of it.
Names are not parseable (labels may contain `.` and `-`, models contain `-`,
runtimes contain `.`): `gc` and `status` print model and runtime from
`simctl list`, never from the name. Ownership checks match the `stim-`
prefix and the registry's udid, as today.

The rename is idempotent: on every reuse, when the owned simulator's name is
not the name this workspace would give it, `ios` renames it before booting
(`simctl rename` works while shut down). That heals the adoption crash
window below and renames simulators created before this change on their
next run. EAS remote sessions keep their `stim-<label>` name.

Android AVD names cannot carry spaces or parentheses (`avdmanager` allows
`[A-Za-z0-9._-]`; `sanitizeAvdLabel` already uses that set), so AVDs use
`stim-<label>-api<level>-<abi>`, e.g. `stim-feat-login-api36-arm64`. The
level is the second segment of the system image package minus `android-`,
verbatim (`android-35-ext15` gives `api35-ext15`); the abi maps
`arm64-v8a` to `arm64` and `x86_64` to `x86_64`. The "AVD already exists"
recovery reconstructs the name with the picked image
(`ownedAvdName(label, { apiLevel, abi })`) or it stops detecting
collisions. Whether phase 2 renames an AVD (`avdmanager move avd -n <old>
-r <new>`) or recreates it is decided with the Android recipe.

## Park

Only `worktree remove` parks; `gc --delete` deletes as today. Parking lives
in `teardown.ts`'s owned-device removal (invariant 4: one place). The entry
point takes the project path and bundle id; `reclaimOwnedDevices` passes
them.

1. Shut the simulator down if booted.
2. Clear the app's data on disk: under the device's `dataPath` (reported
   per device by `simctl list devices --json`; `parseSimctlList` keeps it),
   find the data container by reading `MCMMetadataIdentifier` from each
   `Containers/Data/Application/*/.com.apple.mobile_container_manager.metadata.plist`
   (`plutil -extract ... raw`), then empty the contents of `Documents`,
   `Library`, `tmp`, and `SystemData` (39 ms measured). This removes
   `NSUserDefaults`, AsyncStorage, SQLite, and the dev-menu keys stim wrote in
   the app's domain. No bundle id recorded, or no container found, is not a
   failure: there is nothing to clear.
3. `simctl rename <udid> "stim-parked (<model> <runtime>) <4 hex>"`.
4. Under the config lock: append the record, clear the workspace's
   `platforms.ios` device record, and if the pool now exceeds the maximum
   remove the oldest record by `parkedAt`; write once. `removeProject` still
   removes the project entry at the end of the remove, as today.
5. Outside the lock, `simctl delete` the evicted simulator through the
   teardown delete path.

A crash between 3 and 4 leaves a workspace-owned simulator with a parked
name, which the next `worktree remove` parks again; a crash between 4 and 5
leaves a `stim-parked` simulator no record names, which is the orphan class
`gc` reports and `--delete` removes. A step that fails falls back to
deletion, as today, and prints the failed step. `stop` is unchanged: it shuts
the owned simulator down and keeps it owned; parking is a consequence of
giving the workspace up.

Park removes the previous workspace's app data, and adoption removes its
privacy grants, the keychain, and its other apps. A parked simulator keeps
its system state: pasteboard, Safari cookies and website data, photos,
contacts and calendars, installed profiles, Simulator settings, app-group
containers (`Containers/Shared/AppGroup`, which the metadata cannot map to
one app), and device-level defaults such as the scheme approvals stim
rewrites on every install. A project that needs a clean system image sets the maximum to 0; an
erase-and-prewarm option is deferred.

## Adopt

When `ensureOwnedIosDevice` finds no owned simulator for the workspace:

1. Resolve the wanted model and runtime as today: `--device-type` and
   `--runtime`, then `ios.deviceType` and `ios.runtime`, then the default,
   which always resolves to concrete identifiers (the newest installed
   runtime that supports the model). A parked simulator is adopted only when
   its `deviceTypeIdentifier` and `runtimeIdentifier` both equal the wanted
   ones; a ticket that asks for an iPad never gets an iPhone, and a request
   for iOS 18.5 never gets 26.5. After a runtime upgrade, parked simulators
   on the old runtime are never adopted and leave by eviction or
   `gc --delete`. (The reuse path today checks the model only; that
   asymmetry is unchanged here.)
2. Under the config lock, take the oldest matching parked record; remove it
   from the pool and record it as this workspace's owned device in the same
   write, carrying `simslimManaged`, `adopted: true`, and
   `adoptionPending: true`.
3. `simctl rename <udid> "stim-<label> (<model> <runtime>)"`.
4. Boot as today, then, still inside the boot the run already waits on
   (#269 overlaps it with the fingerprint): `simctl privacy <udid> reset all`
   with no bundle id, so every app's grants are reset, and
   `simctl keychain <udid> reset`. Then configure as today:
   `reconcileSimSlim` with the carried `simslimManaged` as `previouslyManaged`
   turns SimSlim off when this workspace has no profile and on when it has
   one, exactly as reuse does. The `device` phase line reads
   `  device      <full name> (<udid short>) adopted (<time>)`; its time
   includes the two resets, so it runs longer than a plain `booted`.
5. On the adoption run only, at install, before the existing proof:
   `simctl listapps`, and uninstall every `ApplicationType == User` app
   whose bundle id is not this run's. Completing this step clears
   `adoptionPending`. Then as today: the parked record's cache key is
   checked first so the proof's hashing is skipped when it cannot match, and
   the installed-container proof decides; a pass skips the install
   (`install     unchanged`), otherwise the cached app is installed over the
   parked one, an upgrade install onto cleared data.

While `adoptionPending` is set, the reuse path runs steps 4 and 5 too, so a
crash, a boot failure, or a build failure between the record write and the
end of the install cannot leave the next run booting with the previous
workspace's grants, keychain, or apps. A run on a simulator without the
marker never lists or uninstalls apps: what a workspace installs by hand on
its own simulator is not stim's to remove.

A parked record whose simulator `simctl list` does not report, or reports
unavailable (its runtime removed), is deleted (`simctl delete` accepts an
unavailable device) and its record dropped, with a line saying so: a listed
record proves the simulator is Stim's, and dropping the record alone would
hide 2.5 GB from every sweep. This check needs a listing that keeps
`isAvailable: false` entries, which `parseSimctlList` filters out today.
Adoption then falls through to creation.
No match creates a new simulator as today; the pool is never a reason to
boot a different model than requested, and the new simulator is parked
normally when its workspace is removed.

## gc and status

`gc` adds a section mirroring the existing ones:

    Parked simulators (2, 5.1 GB):
      ios stim-parked (iPhone 17 26.5) a1f3 (A7A4..) iPhone 17 26.5 parked 3d ago 2.6 GB

with the `--delete` effect line the other sections carry; size is the
`dataPathSize` the same listing reports. `gc --delete` deletes every parked
simulator and clears the list, even when `STIM_HOME` is set: the sweep for
unlisted `stim-` devices stays refused under `STIM_HOME` as today, because a
scoped config cannot prove an unlisted device stale, but a parked record in
this config proves that simulator is Stim's and parked by this home. Orphaned `stim-parked` simulators
appear under `Orphaned devices`, as today. `status` prints one line per
platform whenever the pool is not empty: `pool: 2 parked iOS simulators
(max 3)`, or `pool: 2 parked iOS simulators (parking off; gc --delete
removes them)` when the maximum is 0.

`worktree remove` prints `  device      parked <name> (<udid short>)`
instead of `deleted`, and `  device      deleted <name> (pool over 3)` for
an eviction.

## Hermetic suites

The native e2e harness asserts at `verifyCleanup` (the end of each row)
that no `stim-` device remains. It redirects `STIM_HOME`, so parking is off
under the rule above, and it sets `STIM_POOL_IOS_PARKED_MAX=0` (and the
Android twin) explicitly so the rule is not the only thing keeping rows
hermetic. The pool is exercised by its own e2e row, which sets the variable
to 1: create two workspaces and run `ios` in both (the pool is empty, both
create); remove the first, assert `parked`; remove the second, assert
`parked` and `deleted ... (pool over 1)`; create a third, assert `adopted`;
remove it, assert `parked`; `gc --delete`, assert the pool is empty and no
`stim-` device remains.

## Guidance deltas

`guide`: the pool in the lifecycle topic (what park and adoption remove and
what a parked simulator keeps, that adoption matches model and runtime
exactly, the bound and the setting, the `adopted`, `parked`, and
`pool over` lines), the settings entries, `gc`'s section and `--delete`
effect, and `status`'s line. Skill: the permanent rule under ownership: a
parked simulator is Stim-owned; never delete one by hand, `gc --delete`
does. AGENTS.md invariant 2 gains: "Stim parks an owned simulator it no
longer needs instead of deleting it, up to a configured maximum, and adopts
a parked one before creating. Parked simulators are Stim-owned, listed in
the pool record, and deleted only by eviction or `gc --delete`." Invariant
4: park is a teardown flow.

Every site that quotes or reconstructs `stim-<label>` changes to the new
shape: AGENTS.md invariant 2 (line 145), `skill/SKILL.md` (line 99),
`commands/guide.ts` (lines 240 and 359), and `doctor.ts` (line 516, EAS
sessions excepted) in phase 1. AVD names change in phase 2, together with
Android's "already exists" recovery (`engine/device.ts` line 409,
`sim/android.ts` line 204). Prefix checks
(`resolveOwnedIosSim`, `resolveOwnedAvdSerial`, `deleteIosSim`,
`deleteAvd`, `findOrphanedDevices`, `liveOwnedDeviceCount`, the harness
`/stim-/` greps) survive unchanged.

## Testing

- Pure: pool selection (exact model and runtime match, oldest first), the
  bound (oldest evicted), the settings parse (absent, `0`, invalid, the
  `STIM_HOME` rule), the orphan classification, the name cap and the
  Android name mapping.
- Real simctl once (invariant 9): the park recipe on a shut-down simulator
  (container lookup through the metadata plist, the on-disk clear, the
  60-character rename with dots and parentheses), the adoption steps after a
  boot (`privacy reset all` without a bundle id, `keychain reset`,
  `listapps` parsing, uninstall of a second app), an adopted run that skips
  the install because the parked build matches, and the SimSlim carry-over
  (parked managed, adopted by a workspace without a profile). The measured
  boot time after the recipe goes in the PR (expected about 9 s; the probe
  measured 8.9 s).
- Command tests with `STIM_HOME` redirected and the variable set explicitly:
  `worktree remove` parks and evicts (delete outside the lock); `ios` adopts,
  renames, and prints `adopted`; the idempotent rename on reuse; `gc` reports
  and `--delete` empties, including under `STIM_HOME`; `status` lines;
  parking disabled by `0` with a non-empty pool; `gc --delete` never parks;
  an adoption that crashes after the record write, where the next run
  finishes the resets and the uninstall and clears `adoptionPending`; an
  unavailable parked simulator deleted and dropped.
- The e2e pool row above.
- Field check: a cache-hit run in a fresh worktree with a parked match is
  expected at 20-30 s against the 72.6 s baseline (runs B/E measured
  20.3-32.5 s with the app retained, which this recipe matches, before the
  adoption resets); the PR records the measured `device ... adopted`,
  `install`, and total times.

## Decisions

| Question         | Decision                                                                                                       | Why                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Erase on park    | No; keep the app installed, clear its data on disk at park, reset grants, keychain, and other apps at adoption | Erase costs a 12 s boot penalty; the on-disk clear is 39 ms; of the cleaning subcommands only `rename` works on a shut-down simulator |
| Bound            | Configurable, default 3, oldest evicted                                                                        | Bounded disk (about 2.5 GB per parked simulator)                                                                                      |
| Where park lives | `teardown.ts`, `worktree remove` only                                                                          | Invariant 4; `gc --delete` must not park what it is deleting                                                                          |
| Booted pool      | Not now                                                                                                        | 2.6 GB RAM per booted simulator; a later setting                                                                                      |
| Match rule       | Model and runtime identifiers, exact                                                                           | A ticket that asks for an iPad must never get an iPhone                                                                               |
| Suites           | Pool off under a redirected `STIM_HOME` unless the variable is explicit                                        | Rows stay device-free and hermetic without every harness opting out                                                                   |
| System state     | Kept on a parked simulator; erase-and-prewarm deferred                                                         | Isolation of app data, grants, keychain, and apps is what agents need; a clean image costs the boot penalty                           |
| Names            | `stim-<label> (<model> <runtime>)`, 60 characters, label shortened first                                       | Readable in simctl and the Simulator app; identity stays the udid                                                                     |
