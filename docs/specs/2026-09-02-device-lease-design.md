# Physical device leases

Date: 2026-09-02. Status: proposed. Issue: #221.

## Summary

A workspace can hold a timed lease on a physical device. `stim device lock`
grants one for a declared duration, `stim device unlock` releases it, and
`ios --device` / `android --device` take a run-scoped lease of their own,
wait for a device held by another workspace, or skip the lease on request.
With several devices connected, `--device` with no id takes the first free
one. Nothing is inferred from activity: a lease lasts exactly as long as it
was declared, so an interrupted or forgetful agent costs the device at most
that long, and the expiry is printed wherever the lease is mentioned.

## Motivation

Two workspaces sharing one phone install over each other. On iOS the second
install closes the first workspace's app, because the app's lifetime is bound
to the device collector; on Android the second launch replaces the foreground
app. An agent that expects contention has no way to say "this phone is mine
for the next ten minutes", and an agent that finds the phone busy has no way
to wait or to know how long.

## Scope

In: physical iOS devices reached through `ios --device` and physical Android
devices reached through `android --device`, on one machine, under one
`STIM_HOME`.

Out: owned simulators and emulators (one per workspace already), remote and
EAS devices, locks shared across machines, and any per-agent identity. A lease
belongs to a workspace, identified by its canonical project root, because a
workspace is the unit every other piece of Stim state uses and an agent has
no stable process of its own.

## Commands

    stim device lock <ios|android> [id] [--for <duration>] [--wait <seconds>] [--json]
    stim device unlock [ios|android] [--json]

`lock` grants the lease to the current workspace. `id` is a UDID or a serial;
without it the pool rule below picks a device. `--for` is a duration such as
`90s`, `5m`, or `10m`; the default is `5m` and the maximum is `30m`. A larger
value is refused with `STIM_BAD_ARG`. `--wait` bounds how long `lock` waits
for a device held by another workspace, default 60, `0` refuses at once.
Running `lock` while this workspace already holds the device renews the lease
to now plus `--for`.

`unlock` releases every lease the workspace holds, or only the platform named.
Releasing nothing is not an error: it prints a note and exits 0.

`lock` prints one line, and `--json` prints one payload:

    locked Old iPhone (00008101-000A10913C89001E) for /path/to/ws until
    12:09:31 (5m). Renew: stim device lock ios --for 5m. Release: stim device
    unlock.

    { "platform": "ios", "id": "00008101-...", "deviceName": "Old iPhone",
      "holder": "/path/to/ws", "grantedAt": "...", "expiresAt": "...",
      "leaseSeconds": 300 }

## Lease semantics

A lease is a file under `$STIM_HOME/device-locks/<platform>-<id>.json`:

    { "platform": "ios", "id": "...", "deviceName": "...",
      "holder": "/canonical/root", "token": "<random>",
      "grantedAt": "...", "expiresAt": "..." }

Rules, in order of precedence:

1. A lease whose `expiresAt` is in the past is free. Any claimant may reap
   it: rename the file aside with the observed token in the aside name, then
   delete the aside. A rename that fails means another claimant reaped it
   first; re-read and retry.
2. A free device is taken by creating the file exclusively (`wx`) and writing
   it atomically. Two claimants racing get one winner from the exclusive
   create; the loser re-reads and sees the winner's lease.
3. Only the holder renews or releases, proven by the token it wrote. The
   token lives in the workspace state, not in the project tree.
4. Clocks are this machine's; there is no cross-machine case.
5. A lease is never extended by activity. The only writers of `expiresAt` are
   `lock` (now plus `--for`) and a running `ios`/`android` command (below).

The one-minute floor asked for at the start of the design survives as the
run-scoped lease: a device run holds the device for 60 seconds at a time,
renewed every 20 seconds while the run lasts.

## ios and android

A device run needs the device from install to launch verification; the build
before it does not touch the device and stays under the build lock. So the
lease step sits after the build and before install:

- If the workspace holds a lease on the chosen device, the run renews it every
  20 seconds to at least now plus 60 seconds while the run lasts, and leaves
  it where that lands when the run ends. A declared lease that would have
  expired during a long install therefore ends 60 seconds after the install
  instead; a declared lease longer than the run is untouched.
- If nobody holds the device, the run takes a run-scoped lease (60 seconds,
  renewed every 20 seconds) and releases it when the run ends, whatever the
  exit path.
- If another workspace holds the device, the run waits up to `--wait
<seconds>` (default 60), polling every 2 seconds and printing a waiting line
  every 30 seconds with the holder, the device, and the holder's expiry. When
  the wait runs out it refuses with `STIM_DEVICE_BUSY`. `--wait 0` refuses at
  once.
- `--no-wait` skips the lease entirely: the run proceeds now, takes no lease,
  and prints one warning line naming the holder and its expiry. On iOS the
  line also says that installing over the holder's app closes it. This is a
  bypass by design; the lease is advisory to a run that opts out.

`--wait` and `--no-wait` together are `STIM_BAD_ARG`. Both flags apply only
with `--device`; on a simulator or emulator run they are refused with
`STIM_BAD_ARG`, since owned devices have no contention.

## Pool

With `--device` and no id, on `lock` or on a run:

1. Candidates are the connected physical devices of that platform: iOS
   devices with a wired transport (the design rule from the iOS device
   spec), Android devices adb reports as `device`.
2. A candidate leased by this workspace wins. A workspace that holds a lease
   never lands on another device by accident.
3. Otherwise the first candidate not leased by another workspace wins, in a
   stable order: device name, then id.
4. With candidates but none free, the command waits under `--wait` as above,
   re-listing devices on each poll, then refuses with `STIM_DEVICE_BUSY`
   naming every holder.
5. With no candidates it refuses with the existing `STIM_NO_DEVICE`.

The chosen device is printed and returned in `--json` (`udid` or `serial`,
`deviceName`) so the agent can hand the same id to its device tool.

## Other commands

- `status` lists leases under the workspace: the device, the holder, the
  expiry, and whether it is this workspace's. JSON adds `deviceLeases`.
- `stop` releases the workspace's leases; a stopped workspace uses no device.
- `gc` deletes expired lease files and reports them; it touches no device.
- `doctor` says nothing new.

## Refusal codes

- `STIM_DEVICE_BUSY`: the device (or every pool candidate) is leased by
  another workspace and the wait ran out. The message names the holder root,
  the device name and id, and the expiry as a clock time and a remaining
  duration. The remedy lists, in order: wait longer with `--wait <seconds>`,
  pick another device by id, or `--no-wait` with its consequence spelled out.
- `STIM_BAD_ARG`: an unparseable or over-cap `--for`, an unusable `--wait`,
  `--wait` with `--no-wait`, or either flag without `--device`.
- `STIM_NO_DEVICE`: unchanged.

## Guidance deltas

`guide`: the topic that carries physical-device use gains a paragraph with
the sequence `lock`, `ios --device`, device-tool work, `unlock`; the run-scoped
lease; the pool rule; `--wait` and `--no-wait` with the bypass consequence;
and the fact that a lease is never extended by activity. `guide errors` gains
`STIM_DEVICE_BUSY`. The option surface lines gain the two flags and the two
commands. Contract tests pin all of it.

Skill: one sentence under the physical-device paragraph, routing to the
guide, and one permanent rule: never delete another workspace's lease file;
`gc` reaps expired ones.

AGENTS.md: the command surface sentence gains `device lock|unlock`; invariant
2 gains: "A physical device leaves one record, its lease file under
`$STIM_HOME/device-locks/`; it never enters the project registry. `stop`
releases the workspace's leases and `gc` deletes only expired ones." Invariant
3's option list gains `--wait <seconds> --no-wait` on `ios` and `android`.

## Testing

- `engine/device-lease.ts` is pure over an injected clock and file layer:
  acquire free, acquire held, acquire expired (reap then take), reap race
  (rename fails, retry sees the new holder), renew by holder only, release by
  token only, duration parsing and the cap, pool ordering and the held-device
  preference, the run-scoped renew cadence.
- The real file protocol runs once with two processes racing for one lease.
- Command tests with a fake clock: the wait loop freeing mid-wait, the
  waiting line cadence, `--wait 0`, `--no-wait` printing the warning and
  writing no file, the run lease taken, renewed, and released on success,
  failure, and exception; `status`, `stop`, `gc`.
- Guide contract tests for the paragraph, the code, and the option lines.

Hardware, one phone: lock from workspace A; `ios --device` from B waits and
refuses with the holder and expiry; B with `--no-wait` installs and A's app
closes (observed, since it is the consequence the warning states); A's lease
expires and B's plain run proceeds. The pool with two devices is verified on
hardware only when two are connected; until then its selection is unit-tested.

## Decisions

| Question                 | Decision                       | Why                                                                                                                                           |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| What keeps a lease alive | A declared duration only       | Activity-based refresh keeps a dead agent's phone busy for as long as its app runs, which is forever; a declared lease is bounded and visible |
| Opt-out of waiting       | `--no-wait` bypasses the lease | Maintainer's call; the warning names the holder and the cost                                                                                  |
| Holder identity          | The workspace root             | Agents have no stable process; every other Stim state is per workspace                                                                        |
| Default lease            | 5 minutes, cap 30              | Long enough for a device-tool session, short enough that a forgotten lease clears within a run                                                |
| Run-scoped lease         | 60 seconds renewed every 20    | The one-minute floor from the original idea, applied where a process exists to renew it                                                       |
| Pool order               | Name, then id                  | Stable and readable in output                                                                                                                 |

## Phases

1. `engine/device-lease.ts`, the file protocol, `status`, `gc`, `stop`.
2. `device lock` and `device unlock`, guide and skill text.
3. `ios`/`android`: the run-scoped lease, `--wait`, `--no-wait`.
4. The pool.
5. Hardware verification and the AGENTS.md deltas.
