---
title: 'Commands'
sidebar_position: 3
description: 'The closed, ten-command surface, and what each one does'
---

## Quick start

Run via `npx` from any RN/Expo project directory -- no install needed:

```bash
npx rn-iso start             # dev server on a reserved port, under a supervisor
npx rn-iso ios               # owned sim booted, app installed and launched on it
npx rn-iso logs --errors     # no output + exit 0 = nothing is broken
npx rn-iso stop              # supervisor down, sim shut down, port freed
```

```
$ npx rn-iso start
OK: dev server on port 8082, supervisor pid 41233 (expo-child) (6s)

$ npx rn-iso ios
device      rn-iso-myproject (BF2A..) booted (9s)
fingerprint a3f9b1.. hit (2s)
install     from cache (3s)
launch      com.example.app (1s)
OK: com.example.app launched on BF2A..
```

The order is not optional: `ios` / `android` never start the bundler, so with nothing holding the reserved port they refuse in about a second with `RN_ISO_NO_METRO` instead of spending four minutes building an app that cannot load a bundle.

Each command takes `--json` and then prints exactly one line of JSON on stdout, with every other line on stderr:

```json
{
  "platform": "ios",
  "udid": "BF2A-...",
  "deviceName": "rn-iso-myproject",
  "fingerprint": "a3f9b1...",
  "cacheKey": "...",
  "cacheHit": "local",
  "cacheSkipped": false,
  "appPath": "/...",
  "bundleId": "com.example.app",
  "launched": true,
  "metroPort": 8082,
  "logs": { "dir": "/path/.rn-iso/logs" },
  "durationMs": 9412
}
```

`cacheHit` is a LEVEL, not a boolean: `"local"` (this machine's shared cache), `"remote"` (the project's own Expo `buildCacheProvider`, whose artifact is copied into the local cache on the way past) or `false` (it was compiled). `cacheSkipped` is true only when `--no-build-cache` was passed, which is "nothing was looked up" rather than "nothing was found".

In a different worktree of the same app, the same two commands get a _different_ owned sim and Metro port, so both run side by side.

To set a repo up for that in the first place, run `rn-iso doctor` and work
through what it reports:

```bash
npx rn-iso doctor
```

There is no `rn-iso init`. Every edit that setup needs lands in a file the
project already owns -- a `metro.config.js` with its own transformer, a
`Podfile` with existing `post_install` logic, an app config that may be
TypeScript -- and a generator that rewrites those eventually corrupts one. So
`doctor` reports, read-only and always exit 0, and the bundled `rn-iso-init`
skill is the playbook for applying each finding by hand. The one edit that
needed no judgement, `.rn-iso/` in `.gitignore`, is self-ensured: `start`,
`ios` and `android` each add it if it is missing and say so once on stderr --
commit that line with the change you were already making, and it stops being
rewritten in every fresh worktree.

For AI coding agents, install the bundled skills so the agent knows how to drive the CLI (the lifecycle, the facts contract, and the destructive-command rules). They install with the skills CLI, straight from GitHub:

```bash
npx skills add appandflow/rn-iso
```

[Getting started](https://github.com/appandflow/rn-iso/blob/main/docs/getting-started.md) walks the whole integration -- first run, agent setup, cache wiring, worktrees -- in four short steps.

## The ten commands

All commands below take the same `npx rn-iso` prefix.

| Command                                                                                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start [--json] [--wait <seconds>]`                                                                            | Start this workspace's dev server on the reserved port under a detached supervisor, and block until it answers _and_ verifies as this project's (default 60s). Idempotent: a healthy dev server on the port is a no-op. Bare RN is hosted in-process with rn-iso's NDJSON reporter; Expo runs the project's own `expo start --port <n>` as a child. Structured logs land in `<root>/.rn-iso/logs`, and `.rn-iso/` is added to the project's `.gitignore` if it is not already there. A failure under `--json` still puts one line on stdout: the `{code, message, remedy}` contract (`RN_ISO_METRO_TIMEOUT`, `RN_ISO_SUPERVISOR_EXITED`, ...).                                                                                                                                      |
| `logs [--source <s...>] [--level <l>] [--since <d>] [--grep <re>] [--tail <n>] [--errors] [--follow] [--json]` | Query the merged NDJSON timeline in `<root>/.rn-iso/logs`. Prints and exits; nothing matching is a successful, empty result (exit 0). `--errors` is the agent-loop query: errors and fatals since the last marker. `--follow` streams.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ios [--json] [--no-metro-check] [--no-build-cache]`                                                           | Boot this workspace's owned simulator, verify the reserved port holds _this project's_ dev server, fingerprint the native inputs, install the cached `.app` if that fingerprint has one (otherwise prebuild / `pod install` / `xcodebuild` and store the result), install, launch wired to the reserved port, and attach a device-log collector. Refuses with `RN_ISO_NO_METRO` in about a second when nothing holds the port; `--no-metro-check` overrides. On an Expo project a local miss also asks the provider the project already configured (`expo.buildCacheProvider`), time-bounded, and a hit is stored locally on the way past. `--no-build-cache` looks nothing up and builds fresh -- it still stores (replacing the entry) and still uploads. Debug / simulator only. |
| `android [--json] [--no-metro-check] [--no-build-cache]`                                                       | The same over `gradlew assembleDebug` and `adb`, on this workspace's owned emulator, with `adb reverse tcp:8081 tcp:<port>` doing the port wiring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `stop [--force] [--json]`                                                                                      | The inverse of `start`: halt this workspace's supervisor, reap its device-log collectors, shut the owned device **down** (never deleted, so it stays assigned), and free the reserved port. Non-destructive and takes no target -- it acts on the current workspace. With no supervisor recorded it falls back to killing an identity-verified Metro on the reserved port; `--force` is only for an unproven listener there. Already-stopped is a success at every step.                                                                                                                                                                                                                                                                                                            |
| `status [--json]`                                                                                              | Show every registered project (machine-wide by default; there is no `--all`): device assignments (owned/legacy), Metro state, supervisor pid / mode / health, last build (fingerprint, cache hit, duration), log directory and error count since the last marker, plus machine capacity and free disk -- on the boot volume, and on the current project's volume too when that is a different one.                                                                                                                                                                                                                                                                                                                                                                                  |
| `gc [--delete] [--older-than <days>] [--all]`                                                                  | Report what rn-iso has left behind: entries for projects whose directory no longer exists, orphaned `rn-iso-*` devices, records naming a device that is no longer on the machine, and every shared build cache with its size. Reports and writes nothing by default; `--delete` reclaims the dead entries (freeing their Metro ports), reaps the orphaned devices, and clears the stale device records (the record only -- there is no device left to touch, so it issues no simctl/avdmanager command). `--older-than <days>` additionally reaps owned devices whose _project_ has gone untouched that long, and trims cache entries nothing has used in that time. `--all` (with `--delete`) empties the caches whole -- see below.                                               |
| `doctor [--json]`                                                                                              | Report the configuration that makes a second workspace slower than it needs to be: a missing dev client, a per-project Metro cache, a compilation cache left at its default path, a ccache conflict, a build-cache provider on the key this SDK ignores. Read-only, and always exits 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `worktree create <name> [--base <ref>] [--label <name>] [--carry-ignored]`                                     | Create an isolated git worktree: carries over gitignored files, prints the worktree path (and, on stderr, what it branched from -- ref and short sha). `--base` takes `fresh` (origin/HEAD, the default), `head`, or any ref `git rev-parse` resolves; an unresolvable one is refused before anything is created. Does not install dependencies unless `--carry-ignored` clones them.                                                                                                                                                                                                                                                                                                                                                                                               |
| `worktree remove [<path>] [--force]`                                                                           | Remove a worktree, reclaiming its build artifacts, Metro port, and owned devices (deleted, not just freed). Defaults to the current workspace. Refuses if it has uncommitted or unpushed work unless `--force`, naming the right restore command per class (`git checkout --` for modified tracked files, `git clean -fd` for untracked ones). The workspace's own `.rn-iso/` never counts as dirt -- it dies with the worktree by design.                                                                                                                                                                                                                                                                                                                                          |
| `guide [topic]`                                                                                                | Print reference docs for the installed version (topics: facts, metro, logs, errors, lifecycle, cleanup, settings). Generated by the binary, so it cannot drift.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Project labels (`--label`)

Every project has a "shortcut": its `label` if one was set (e.g. via `worktree create --label`), else inherited from the enclosing worktree's label, else the directory basename. It is what names the owned device -- `rn-iso-<label>` -- and what `status` reports a workspace as.

```bash
npx rn-iso worktree create feature-x --label agent-1   # its sim will be rn-iso-agent-1
```

Two projects sharing the same basename with no distinguishing label collide, which is why `worktree create` registers a label for the worktree root: every worktree of a monorepo otherwise shares the same app-dir basename.
