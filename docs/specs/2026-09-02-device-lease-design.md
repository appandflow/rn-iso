# Physical device leases

Date: 2026-09-02. Status: implemented (phases 1 to 4 merged 2026-09-02);
hardware-verified on one phone, see the device-lease checklist in
`docs/field-test-protocol.md`. Issue: #221.

## Summary

A workspace can hold a timed lease on a physical device. `stim device lock`
grants one for a declared duration, `stim device unlock` releases it, and
`ios --device` / `android --device` take a run-scoped lease of their own,
wait for a device held by another workspace, or proceed without one on
request. With several devices connected, `--device` with no id takes the
first free one. A lease lasts as long as it was declared, plus the remainder of a run that
overlapped its end (each device step raises it; none lowers it), so an
interrupted or forgetful
agent costs the device a bounded time, and the expiry is printed wherever the
lease is mentioned.

## Motivation

Two workspaces sharing one phone install over each other. When the app ids
match, `devicectl install` and `adb install -r` both terminate the running
app; when they differ, the second launch backgrounds the first. An agent that
expects contention has no way to say "this phone is mine for the next ten
minutes", and an agent that finds the phone busy has no way to wait or to
know how long.

## Scope

In: physical iOS devices reached through `ios --device` and physical Android
devices reached through `android --device`, on one machine, under one
`STIM_HOME`.

Out: owned simulators and emulators (one per workspace already), remote and
EAS devices, leases shared across machines, and any per-agent identity. A
lease belongs to a workspace, identified by its canonical project root,
because a workspace is the unit every other piece of Stim state uses and an
agent has no stable process of its own. A workspace holds at most one lease
per platform.

## Commands

    stim device lock <ios|android> [id] [--for <duration>] [--wait <seconds>] [--json]
    stim device unlock [ios|android] [--json]

Both commands need a project: they resolve the workspace root the way `stop`
does and refuse outside one with `STIM_NO_PROJECT`.

`lock` grants the lease to the current workspace. `id` is a UDID or a serial;
without it the pool rule below picks a device. The device must pass the
existing resolver (connected, paired, Developer Mode on) before a lease is
written; a device that fails it is refused with the resolver's own code.
`--for` matches `^[1-9][0-9]*(s|m)$`: `90s`, `5m`, `10m`. The default is `5m`,
the minimum `10s`, the maximum `30m`; anything else is `STIM_BAD_ARG`.
`--wait` bounds how long `lock` waits for a device held by another workspace,
parsed like `start --wait`, default 60, `0` refuses at once. Running `lock`
while this workspace already holds the device sets the expiry to now plus
`--for`, which can shorten it. Running `lock` for a different device of the
same platform releases the old lease first.

`unlock` releases every lease the workspace holds, or only the platform
named. Releasing nothing is not an error: a note goes to stderr and `--json`
prints an empty list.

`lock` prints one line to stdout, and `--json` prints one payload:

    locked Old iPhone (00008101-000A10913C89001E) for /path/to/ws until
    12:09:31 (5m). Renew: stim device lock ios --for 5m. Release: stim device
    unlock.

    { "platform": "ios", "id": "00008101-...", "deviceName": "Old iPhone",
      "holder": "/path/to/ws", "kind": "declared", "grantedAt": "...",
      "expiresAt": "...", "leaseSeconds": 300 }

## Lease state

A lease is a file under `$STIM_HOME/device-locks/<platform>-<segment(id)>.json`,
where `segment` is the build lock's file-name sanitizer (an adb TCP serial
contains `:`):

    { "version": 1, "platform": "ios", "id": "...", "deviceName": "...",
      "holder": "/canonical/root", "token": "<random>",
      "grantedAt": "...", "expiresAt": "..." }

The holder keeps its side in the workspace state file, `state.json` under
`$STIM_HOME/workspaces/<slug>--<id>/`, written under the workspace state
lock and created with the workspace storage if needed (a `lock` before
`start` works): `deviceLeases: { ios?: { id, token, kind }, android?: ... }`
where `kind` is `declared` or `run`.

The token identifies a grant, not a workspace: it stops a stale release from
deleting a newer lease (run 1 dies, its lease expires, `lock` grants a new
one, run 1's deferred release must do nothing). It is not a secret and not a
security boundary.

## Lease protocol

Every read-modify-write of a lease file (take, renew, release, reap) runs
under the directory lock on `$STIM_HOME/device-locks/<platform>-<segment(id)>.lock`,
the primitive that already guards `state.json`. Under the lock the command
re-reads the file, applies one rule, and writes with a temp file and rename.
Rules:

1. A lease whose `expiresAt` is in the past is free. A file that does not parse, or lacks `expiresAt`, is not free: `gc` reports
   it and leaves it alone, and a run treats it as held by an unknown holder
   and refuses at once with `STIM_DEVICE_BUSY` naming the file.
2. A free device is taken by deleting any expired file and writing a new one
   with a fresh token.
3. Renew and release compare the file's `token` with the caller's and do
   nothing when they differ. `unlock` with no known token (the workspace
   directory was recreated) releases by holder root instead; a run's
   deferred release is token-only.
4. The writers of `expiresAt` are `lock` (now plus `--for`, which can shorten
   a lease) and a device run, which raises it before each device step and
   never lowers it. Nothing else touches it: the app running afterwards,
   device-tool work, and `status` do not.
5. Clocks are this machine's; there is no cross-machine case.

## ios and android

A device run needs the device from install to launch verification; the build
before it does not touch the device and stays under the build lock. So the
lease step sits after the build and before install.

Child processes are synchronous, so a run cannot renew on a timer. Instead,
before each device step the run raises the expiry to now plus the larger of
60 seconds and that step's upper bound, and releases a run-scoped lease when
the command exits. The bounds: install, its timeout (five minutes on both
platforms); launch on iOS, the collector exit wait plus the 45-second launch
probe; verification, the bundle deadline plus the stability window in Debug
(`VERIFY_TIMEOUT_MS + STABILITY_WINDOW_MS`, 23 seconds today) and the release
probe otherwise. The 60-second floor absorbs poll granularity and constant
changes. The iOS install timeout is the existing five minutes;
`adb install` gains the same timeout, which also ends the hang a stuck adb
causes today. A run killed with SIGKILL leaves the device leased for at most the current
step's bound, never less than 60 seconds.

- If the workspace holds a lease on the chosen device (matched by token), the
  run raises its expiry as above and leaves it where that lands at exit: a declared lease that would have expired during the run ends after the
  run's last device step instead; a declared lease longer than the run is
  untouched. A run
  never converts a declared lease into a run-scoped one.
- If nobody holds the device, the run takes a run-scoped lease and releases
  it at command exit, whatever the exit path. The iOS collector and the app
  outlive the command; they need no lease, and the lease says nothing about
  them.
- If another workspace holds the device, the run waits up to `--wait
<seconds>` (default 60), polling every 2 seconds and printing a waiting
  line to stderr every 30 seconds with the holder, the device, and the
  holder's expiry. It waits even when that expiry lies beyond its own
  deadline, because the holder can `unlock` early. When the wait runs out it
  refuses with `STIM_DEVICE_BUSY`. `--wait 0` refuses at once.
- A raise that finds the lease gone or held under another token fails.
  Before the install the run refuses with `STIM_DEVICE_LOST` naming the new
  holder; after the install has started it continues, prints one warning, and reports
  `lease: null` in `--json`, because the app is already on the phone.
- A run with an id that differs from this workspace's leased device of that
  platform refuses with `STIM_NO_DEVICE` naming the leased device; `unlock`
  first, or use it.
- A lease whose holder is this root but whose token is unknown (the workspace
  directory was recreated) refuses at once with `STIM_DEVICE_BUSY` and the
  remedy `stim device unlock`, which releases by holder root.
- A raise on an expired file that still carries the run's own token succeeds
  and revives the lease: nobody took it under the lock.
- `--no-wait` changes only what happens when another workspace holds the
  device: instead of waiting, the run proceeds without a lease and prints
  one warning line to stderr naming the holder and its expiry, and, when the
  app ids match, that the install terminates the holder's app. A free device
  is leased as usual.

`--wait` and `--no-wait` together are `STIM_BAD_ARG`. Both flags apply only
with `--device`; on a simulator or emulator run they are refused with
`STIM_BAD_ARG`, since owned devices have no contention. A successful device
run adds `lease: { kind, expiresAt }` to its `--json` payload.

## Pool

With no id, on `lock` or on a `--device` run:

1. Candidates are the connected physical devices of that platform that the
   existing resolver accepts: iOS devices with a wired transport that are
   paired with Developer Mode on; Android devices adb lists in the `device`
   state that are not emulators, TCP serials included.
2. If this workspace leases a device of that platform, that device wins when
   it is a candidate. When it is not connected, an id-less run refuses with
   `STIM_NO_DEVICE` naming it; `unlock` first, or use that device.
3. Otherwise the first candidate not leased, or leased and expired, wins, in
   id order (case-folded). Names are printed, never sorted on: adb has none
   without one `getprop` per serial, and models repeat.
4. With candidates but none free, the command waits under `--wait` as above,
   re-listing devices on each poll, then refuses with `STIM_DEVICE_BUSY`
   naming every holder.
5. With no candidates it refuses with the existing `STIM_NO_DEVICE`.

The chosen device is printed and returned in `--json` (`udid` or `serial`,
`deviceName`) so the agent can hand the same id to its device tool.

**Amendment, 2026-09-02 (#233).** Rule 2 said "an id selects another device",
which contradicts "ios and android": a run whose id differs from this
workspace's leased device of that platform refuses with `STIM_NO_DEVICE`
naming the leased one. Naming an id does not escape a lease this workspace
holds, so the remedy is `unlock` first, or use the device already leased.

## Other commands

- `status` gains a top-level section listing every lease file: device,
  holder, expiry, and whether it is this workspace's and whether it has
  expired. JSON adds a top-level `deviceLeases` array. Leases held by roots
  that are not registered or no longer exist still show.
- `stop` releases the workspace's leases and lists them in its summary and
  JSON (`releasedLeases`). What the lease protected is gone: this workspace's
  Metro and, on iOS, its app. On Android the app stays where it is.
- `worktree remove` releases the workspace's leases through the same reclaim
  path as its remote session and tunnel.
- `gc` reports expired lease files; `gc --delete` removes them under the
  lease lock after re-checking the expiry. An unparseable file, and an
  unexpired lease whose holder path does not exist, are kept and reported.
  This is hygiene: rule 1 already treats an expired lease as free.
- `doctor` says nothing new.

## Refusal codes

- `STIM_DEVICE_BUSY`: the device (or every pool candidate) is leased by
  another workspace and the wait ran out. The message names the holder root,
  the device name and id, and the expiry as a clock time and a remaining
  duration; `--json` adds `lease: { platform, id, deviceName, holder,
expiresAt }`. The remedy lists, in order: wait longer with `--wait
<seconds>`, pick another device by id, or `--no-wait` with its consequence
  spelled out. It also covers two refusals with no wait: a lease file that
  does not parse (`lease` fields null, the file named) and this root's lease
  with no known token (remedy `stim device unlock`).
- `STIM_DEVICE_LOST`: the run's lease was taken by another workspace before
  the install. The message names the new holder and its expiry.
- `STIM_BAD_ARG`: an unparseable or out-of-range `--for`, an unusable
  `--wait`, `--wait` with `--no-wait`, or either flag without `--device`.
- `STIM_NO_DEVICE` and `STIM_NO_PROJECT`: unchanged.

## Output streams

`lock`'s grant line and every `--json` payload go to stdout; waiting lines,
the `--no-wait` warning, the `STIM_DEVICE_LOST` warning, and `unlock`'s
released-nothing note go to stderr.

## Guidance deltas

`guide`: the topic that carries physical-device use gains a paragraph with
the sequence `lock`, `ios --device`, device-tool work, `unlock`; the
run-scoped lease and the per-step raise; the pool rule; `--wait` and
`--no-wait` with the bypass consequence; and that nothing but `lock` and a
run moves the expiry. `guide errors` gains `STIM_DEVICE_BUSY` and
`STIM_DEVICE_LOST`. The option surface lines gain the two flags and the two
commands. Contract tests pin all of it.

Skill: one sentence under the physical-device paragraph, routing to the
guide, and one permanent rule: never delete another workspace's lease file;
`gc --delete` removes expired ones.

AGENTS.md: the command surface sentence gains `device lock|unlock`. The
"Locked state" rule gains: "Device leases use a declared expiry because the
holder can be an agent with no process." Invariant 2's physical-device
paragraph is replaced by:

> A physical device reached through `android --device` or `ios --device` is
> used but not owned. Hardware cannot be created or booted, so those paths
> install, launch, and read what logs they can, and nothing more. The only
> state a physical device leaves is its lease: the file under
> `$STIM_HOME/device-locks/` and the holder's token in that workspace's
> `state.json`. A serial or UDID never enters the project registry, and
> `teardown.ts` never sees a physical device. `stop` and `worktree remove`
> release the workspace's leases; `gc --delete` deletes only expired lease
> files.

Invariant 3's option list gains `--wait <seconds> --no-wait` on `ios` and
`android`.

## Testing

- `engine/device-lease.ts` is pure over an injected clock and file layer:
  take free, take held, take expired, renew and release by token, release by
  holder root without a token, the stale-release case (new grant, old token),
  duration parsing and the range, pool ordering, the held-device preference
  and the disconnected-held-device refusal, one lease per platform.
- The real file protocol runs once with two processes racing for one lease
  under the directory lock, and once with a holder renewing while a claimant
  takes an expired lease: exactly one holder survives, and the loser sees
  `STIM_DEVICE_LOST`.
- Command tests with a fake clock: the wait loop freeing mid-wait, the
  waiting line cadence, `--wait 0`, `--no-wait` on a held device (warning,
  no file) and on a free one (lease taken), the per-step raise, the run
  lease released on success, failure, and exception; `status`, `stop`,
  `worktree remove`, `gc`.
- The verification raise covers the stability window: a proof arriving at
  the bundle deadline leaves the lease unexpired until the window ends.
- Guide contract tests for the paragraph, the codes, and the option lines.

Hardware, one phone: lock from workspace A; `ios --device` from B waits and
refuses with the holder and expiry; B with `--no-wait` installs and A's app
closes (same app id, the consequence the warning states); A's lease expires
and B's plain run proceeds; a run-scoped lease appears in `status` during an
install and is gone after. The pool with two devices is verified on hardware
only when two are connected; until then its selection is unit-tested.

## Decisions

| Question                                               | Decision                                                                                          | Why                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding `device lock` and `device unlock` and two flags | Approved by the maintainer, 2026-09-02                                                            | A shared phone has no other arbiter                                                                                                           |
| What keeps a lease alive                               | A declared duration, raised only by a run's own device steps                                      | Activity-based refresh keeps a dead agent's phone busy for as long as its app runs, which is forever; a declared lease is bounded and visible |
| How a run keeps the device during an install           | Raise the expiry before each step to now plus the larger of 60 seconds and the step's upper bound | Child processes are synchronous, so no timer can tick during an install                                                                       |
| Mutations                                              | Under the directory lock, re-read, one rule, temp file and rename                                 | A plain rename on renew overwrites a claimant that just took an expired lease                                                                 |
| Opt-out of waiting                                     | `--no-wait` proceeds without a lease when the device is held; a free device is leased as usual    | Maintainer's call; the warning names the holder and the cost                                                                                  |
| Holder identity                                        | The workspace root, at most one lease per platform                                                | Agents have no stable process; every other Stim state is per workspace                                                                        |
| Default lease                                          | 5 minutes, range 10 seconds to 30 minutes                                                         | Long enough for a device-tool session, short enough that a forgotten lease clears within a run                                                |
| Pool order                                             | Id, case-folded                                                                                   | Deterministic and free; adb has no names without a probe                                                                                      |

## Phases

1. `engine/device-lease.ts`, the file protocol, `status`, `stop`, `worktree
remove`, `gc`, and the AGENTS.md deltas except the command-surface
   sentence (a lease file exists from here on).
2. `ios`/`android`: the run-scoped lease, the per-step raise, the adb install
   timeout, `--wait`, `--no-wait`, `STIM_DEVICE_BUSY`, `STIM_DEVICE_LOST`.
3. `device lock` and `device unlock`, guide and skill text, and the AGENTS.md
   command-surface sentence.
4. The pool.
5. Hardware verification.
