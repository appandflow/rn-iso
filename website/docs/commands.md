---
title: 'Command reference'
sidebar_position: 1
description: 'Every Stim command and option'
---

import StimTabs from '@site/src/components/StimTabs';

Commands use `stim`. If Stim is not installed globally, replace `stim` with
`npx stim-cli`.

Run `stim <command> --help` for parser help. Run `stim guide` for the full
reference that ships with the installed version.

## Normal workflow

<StimTabs
code={`stim doctor
stim start
stim ios                 # or: stim android
stim logs --errors
stim stop`}
/>

`ios` and `android` require a running dev server for a Debug build. Release
builds embed the JavaScript bundle and skip that requirement.

## `doctor`

```text
stim doctor [--platform <ios|android>] [--json] [--fix]
```

Inspects the main checkout. It reports missing or stale dependencies, CocoaPods
state, cache conflicts, device capacity, and remote session problems. On a
checkout without installed dependencies, it also reports fingerprint
differences against a fresh worktree. The check is read-only unless `--fix` is
passed.

`--platform ios` or `--platform android` limits native findings to that
platform while keeping shared project checks.

`doctor` also flags when an agent harness sandboxes shell commands and Stim is
not allowed through it, which shows up as unrelated-looking failures against
the simulator service, the adb server, and Stim's own state directory.
`--fix` writes the missing allowance into `.claude/settings.local.json` at the
repository root, the per-user file, merging it with whatever is already there
and touching nothing else. It refuses to change anything under Codex, whose
sandbox has no per-path allowance to add, and it does nothing when no
sandboxing harness is present. See `stim guide errors` for the failure
signatures and the manual settings.

## `start`

```text
stim start [--wait <seconds>] [--remote] [--json]
```

Starts the project dev server on the workspace's reserved port. Stim supervises
the process and captures its output. A healthy existing server for the same
project is reused.

- `--wait <seconds>` changes the startup timeout. The default is 60 seconds.
- `--remote` prepares Metro for a remote device.
- `--json` prints one stable result object on stdout.

## `ios`

```text
stim ios [--configuration <name>] [--device-type <name>] [--runtime <version>]
         [--device [udid]] [--wait <seconds> | --no-wait] [--remote <proxy|eas>]
         [--no-metro-check] [--no-build-cache] [--json]
```

Builds or restores the iOS app. Stim then boots an owned simulator, installs the
app, opens it, and checks launch logs. The build always runs on the local
machine, including remote-device workflows.

- `--configuration <name>` selects an Xcode configuration. The default is Debug.
- `--device-type <name>` creates this workspace's owned simulator as that model,
  overriding `ios.deviceType` for one invocation. A model no installed runtime
  can create refuses with `STIM_BAD_ARG` and prints the ones they do offer.
- `--runtime <version>` creates it on that iOS runtime, overriding `ios.runtime`
  the same way. It takes a version (`26.5`) or a runtime's full name
  (`iOS 26.5`), exactly.
- `--device [udid]` builds, installs, and launches on a connected iPhone instead
  of the owned simulator. With no UDID it takes the first connected device it
  can lease. It cannot be combined with `--remote`. Stim never creates, boots,
  or deletes hardware.
- `--wait <seconds>` bounds the wait for a physical-device lease (default 60;
  `0` refuses immediately if busy). Only with `--device`.
- `--no-wait` bypasses leasing, including when another workspace holds the
  device. Installing the same app terminates that workspace's running app.
  Only with `--device`; cannot be combined with `--wait`.
- `--remote proxy` uses a configured Agent Device daemon.
- `--remote eas` uses an EAS remote simulator.
- `--no-metro-check` skips the Debug dev-server gate.
- `--no-build-cache` ignores cached artifacts and replaces the matching entry.
- `--json` prints one stable result object on stdout.

A non-Debug configuration embeds its JavaScript bundle.

A device build is local-tier only. Its cache key ends `-device`, so it cannot
collide with a simulator build, and no build-cache provider or Expo remote cache
is read or written on a `--device` run, because every entry they hold is keyed
for the simulator.

A `--device` run installs with `devicectl device install app` and launches with
`devicectl device process launch`. Every device install is signed, Debug
included, so the app's own `embedded.mobileprovision` must be unexpired and must
name the phone, and the identity it names must be in this machine's keychain
whenever Stim modifies the bundle.

In Debug the phone reaches Metro over the LAN, because it shares no loopback
with the host and USB carries no reverse forward. Stim gates a non-internal IPv4
address as this workspace's Metro, then hands it to the app: an expo-dev-client
app through the deep link (`--payload-url`), a bare app by writing
`<addr>:<port>` into a copy of the bundle's `ip.txt` and re-sealing that copy.
The cache entry is never modified. Set `ios.lanHost` when this Mac has several
interfaces and the phone shares one that is not the first.

Two things a phone needs that a simulator does not, both one-time and both taps
on the phone: trusting the developer certificate under Settings > General > VPN &
Device Management, and allowing the Local Network prompt the first time the app
looks for Metro. Neither can be pre-granted from this Mac. The trust tap has no
API at all and is always the user's; the Local Network prompt can be accepted by
a device tool once it is showing, and Stim's `unverified` remedy prints those
commands when this launch's device log carries iOS's path reason for an
ungranted app. A prior Don't Allow logs the same reason, and the remedy covers
that too. Until it is granted, `launched` comes back `unverified`. Run
`stim guide errors` for the signature and the full recovery.

A `--device` run in a Release configuration builds fresh every time: a cached
Release app carries its builder's JavaScript, and Stim does not swap JavaScript
into cached iOS physical-device builds.

## `android`

```text
stim android [--variant <name>] [--system-image <id>] [--device [serial]]
             [--wait <seconds> | --no-wait] [--remote <proxy|eas>]
             [--no-metro-check] [--no-build-cache] [--json]
```

Builds or restores the Android app. Stim then boots an owned emulator, installs
the app, opens it, and checks launch logs.

- `--variant <name>` selects a Gradle variant. The default is `debug`.
- `--system-image <id>` creates this workspace's owned AVD from that sdkmanager
  package id, overriding `android.systemImage` for one invocation; an id this
  SDK has not installed refuses with `STIM_BAD_ARG` and prints the installed
  ids.
- `--device [serial]` installs and launches on a connected physical device.
  With no serial it selects a connected device this workspace can lease. It
  cannot be combined with `--remote`.
- `--wait <seconds>` bounds the physical-device lease wait (default 60;
  `0` refuses immediately if busy). Only with `--device`.
- `--no-wait` bypasses leasing, including another workspace's lease. Installing
  the same app terminates that workspace's running app. Only with `--device`;
  cannot be combined with `--wait`.
- `--remote proxy` uses a configured Agent Device daemon.
- `--remote eas` uses an EAS remote emulator.
- `--no-metro-check` skips the Debug dev-server gate.
- `--no-build-cache` ignores cached artifacts and replaces the matching entry.
- `--json` prints one stable result object on stdout.

A variant that ends in `Release` embeds its JavaScript bundle and skips Metro.

## `logs`

```text
stim logs [--source <metro|client|device|build|all...>]
          [--level <debug|info|warn|error|fatal>] [--since <duration>]
          [--grep <expression>] [--tail <count>] [--errors]
          [--follow] [--json]
```

Queries the workspace log timeline. No matching records is a successful empty
result.

- `--errors` selects errors and fatals from Metro, client, and build logs since
  the last launch marker. A completed bundle attempt resets only older Metro
  errors. Device logs require an explicit `--source device` or `--source all`.
- `--source device` includes operating-system device logs.
- `--follow` streams new matching records.
- `--json` writes NDJSON. Zero matches writes zero bytes.

## `stop`

```text
stim stop [--force] [--json]
```

Stops the supervisor and log collectors. It shuts down the owned local device,
ends an owned remote session, and frees the port. A local device stays assigned
for reuse. `--force` can stop an unverified listener on the reserved port.

On a physical iPhone the device log collector is the launch, so stopping it
closes the running app on the phone. Nothing is uninstalled and nothing about
the phone is recorded or deleted.

## `device lock` and `device unlock`

```text
stim device lock <ios|android> [id] [--for <duration>] [--wait <seconds>] [--json]
stim device unlock [ios|android] [--json]
```

Leases a connected physical device to this workspace, so another workspace's
`--device` run waits instead of installing over it. `--for` takes a whole
number of seconds or minutes from `10s` to `30m` and defaults to `5m`;
`--wait` bounds how long to wait for a device another workspace holds
(default 60 seconds, `0` refuses at once). Locking a device this workspace
already holds sets a new expiry, which can shorten it.

With no id, `lock` picks from the connected devices the resolver accepts: the
one this workspace already leases when it is connected, otherwise the first
free one in id order. The same rule serves `ios --device` and
`android --device` with no id, so two devices on one machine no longer refuse.

`unlock` releases every lease this workspace holds, or only the platform
named; releasing nothing is not an error. A `--device` run takes a lease of
its own for the length of the run, so `lock` is for holding a device across
runs, such as a device-tool session. `stim status` lists every lease on the
machine.

## `status`

```text
stim status [--json]
```

Shows every Stim environment on the machine. The output includes worktrees,
ports, devices, supervisors, builds, logs, capacity, and free disk space.

## `stats`

```text
stim stats [--json]
```

Shows how many `ios` and `android` runs this project and this machine have
recorded, how many hit the build cache, the mean cold run and hit run, and an
estimate of the time the cache saved. Only aggregates are kept, in
`$STIM_HOME/stats.json`; nothing per run is stored, and every worktree of a
repository counts into the same project bucket. Outside a project only the
machine section prints. There is no reset flag: delete that file to start over.

`--json` prints one line:

```json
{
  "version": 1,
  "project": { "key": "/path/to/app", "ios": {}, "android": null },
  "machine": { "ios": {}, "android": null }
}
```

`project` is `null` outside a project, and a platform with no run yet is
`null`. A bucket carries `runs`, `failed`, `hits`, `misses`, `coldRuns`,
`coldRunMs`, `hitRuns`, `hitRunMs`, `timeSavedMs`, `firstRunAt` and
`lastRunAt`, plus `lastColdBuildMs` and `lastPodsMs` once the project has
compiled or installed pods; those two size the progress line a long build
prints (`build       still compiling (1m00s of ~3m10s)`). The saved figure is
an estimate: each cache hit is credited this project's mean cold run at that
moment, minus its own duration, floored at zero.

## `worktree create`

```text
stim worktree create <name> [--base <head|fresh|ref>] [--dir <path>]
                            [--label <label>] [--carry-ignored]
```

Creates a git worktree and prints its absolute path.

- `--base head` uses the current checkout's `HEAD`, the default when
  `worktree.baseRef` is unset.
- `--base fresh` uses `origin/HEAD`.
- `--base <ref>` accepts any branch, tag, or commit that git resolves.
- `--dir <path>` creates the worktree under that directory instead of the
  `worktreeDir` setting or the default `<repo>-worktrees/` sibling. A relative
  path resolves against the current directory, while a relative `worktreeDir`
  setting resolves against the repository root. Slash-separated names keep
  their branch hierarchy but use a flat directory under that path:
  `feature/settings` becomes `feature+settings`.
- `--label` sets the short Stim name used by the environment and device.
- `--carry-ignored` copies safe ignored files and compatible uncommitted changes.

## `worktree remove`

```text
stim worktree remove [target] [--force]
```

Reclaims the target environment, build output, port, and owned device. It then
removes a linked worktree when safe. On the main checkout it only reclaims the
environment. `--force` permits removal with uncommitted or unpushed work.

## `gc`

```text
stim gc [--delete] [--older-than <days>] [--cache <name|all>]
```

Reports stale workspace entries, orphaned owned devices and remote sessions,
stale locks, and shared cache sizes. It does not change anything without
`--delete`.

- `--older-than <days>` also selects old devices and unused cache entries.
- `--cache <name|all>` with `--delete` empties the caches whose name or directory
  carries `<name>` whole, or every cache with `all`. Devices and project entries
  are not inspected, so a scoped run empties caches and reaps nothing.

## `guide`

```text
stim guide [topic]
```

Prints version-matched reference text. Topics are agent, facts, metro, logs,
errors, lifecycle, cleanup, and settings. Those topics also cover caches,
remote devices, and release builds.

## Structured output and exit codes

Use plain output for an agent workflow. It streams progress and includes all
facts needed for the next step. Use `--json` when a script must parse the result.

Commands exit with code 0 on success. Build, launch, ownership, or input errors
exit with a nonzero code and print an error code, message, and remedy. An empty
`logs` result exits with code 0.
