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
stim doctor [--json]
```

Inspects the main checkout. It reports missing or stale dependencies, CocoaPods
state, cache conflicts, device capacity, and remote session problems. On a
checkout without installed dependencies, it also reports fingerprint
differences against a fresh worktree. The check is read-only.

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
stim ios [--configuration <name>] [--remote <proxy|eas>]
         [--no-metro-check] [--no-build-cache] [--json]
```

Builds or restores the iOS app. Stim then boots an owned simulator, installs the
app, opens it, and checks launch logs. The build always runs on the local
machine, including remote-device workflows.

- `--configuration <name>` selects an Xcode configuration. The default is Debug.
- `--remote proxy` uses a configured Agent Device daemon.
- `--remote eas` uses an EAS remote simulator.
- `--no-metro-check` skips the Debug dev-server gate.
- `--no-build-cache` ignores cached artifacts and replaces the matching entry.
- `--json` prints one stable result object on stdout.

A non-Debug configuration embeds its JavaScript bundle and supports iOS
Simulator targets only.

## `android`

```text
stim android [--variant <name>] [--device [serial]] [--remote <proxy|eas>]
             [--no-metro-check] [--no-build-cache] [--json]
```

Builds or restores the Android app. Stim then boots an owned emulator, installs
the app, opens it, and checks launch logs.

- `--variant <name>` selects a Gradle variant. The default is `debug`.
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

- `--errors` selects app, bundle, and build errors after the last bundle marker.
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

## `status`

```text
stim status [--json]
```

Shows every Stim environment on the machine. The output includes worktrees,
ports, devices, supervisors, builds, logs, capacity, and free disk space.

## `worktree create`

```text
stim worktree create <name> [--base <head|fresh|ref>] [--label <label>]
                            [--carry-ignored]
```

Creates a git worktree and prints its absolute path.

- `--base head` uses the current checkout's `HEAD`. This is the default.
- `--base fresh` uses `origin/HEAD`.
- `--base <ref>` accepts any branch, tag, or commit that git resolves.
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

Prints version-matched reference text. Topics are facts, Metro, logs, errors,
lifecycle, cleanup, and settings. Cache mechanics, remote devices, and release
builds are covered inside those topics rather than as topics of their own.

## Structured output and exit codes

Use plain output for an agent workflow. It streams progress and includes all
facts needed for the next step. Use `--json` when a script must parse the result.

Commands exit with code 0 on success. Build, launch, ownership, or input errors
exit with a nonzero code and print an error code, message, and remedy. An empty
`logs` result exits with code 0.
