---
title: 'Commands'
sidebar_position: 3
description: 'The closed, ten-command surface, and what each one does'
---

import StimTabs from '@site/src/components/StimTabs';

## Quick start

<StimTabs
code={`stim start             # dev server on a reserved port, under a supervisor
stim ios               # owned sim booted, app installed and launched on it
stim logs --errors     # no output + exit 0 = nothing is broken
stim stop              # supervisor down, sim shut down, port freed`}
/>

<StimTabs
code={`$ stim start
OK: dev server on port 8082, supervisor pid 41233 (expo-child) (6s)

$ stim ios
device stim-cli-myproject (BF2A..) booted (9s)
fingerprint a3f9b1.. hit (2s)
install from cache (3s)
launch com.example.app (1s)
OK: com.example.app launched on BF2A..`}
/>

The order is not optional: `ios` / `android` never start the bundler, so with nothing holding the reserved port they refuse in about a second with `STIM_CLI_NO_METRO` instead of spending four minutes building an app that cannot load a bundle.

Each command takes `--json` and then prints exactly one line of JSON on stdout, with every other line on stderr:

```json
{
  "platform": "ios",
  "udid": "BF2A-...",
  "deviceName": "stim-cli-myproject",
  "fingerprint": "a3f9b1...",
  "cacheKey": "...",
  "cacheHit": "local",
  "cacheSkipped": false,
  "appPath": "/...",
  "bundleId": "com.example.app",
  "launched": true,
  "metroPort": 8082,
  "logs": { "dir": "/path/.stim-cli/logs" },
  "durationMs": 9412
}
```

`cacheHit` is a LEVEL, not a boolean: `"local"` (this machine's shared cache), `"remote"` (the project's own Expo `buildCacheProvider`, whose artifact is copied into the local cache on the way past) or `false` (it was compiled). `cacheSkipped` is true only when `--no-build-cache` was passed, which is "nothing was looked up" rather than "nothing was found".

In a different worktree of the same app, the same two commands get a _different_ owned sim and Metro port, so both run side by side.

**Setting a repo up is not a step.** stim-cli runs on a clean checkout: the Xcode
compilation cache, Gradle's build cache and a shared Metro transform store all
ride on the command lines stim-cli composes itself. When something IS blocked or
slow, `stim doctor` is the read-only second opinion:

<StimTabs code={`stim doctor`} />

It reports only what stim-cli cannot handle on its own -- a missing dev client,
ccache, a checkout that does not fingerprint like a fresh worktree, a
`buildCacheProvider` on a key this SDK ignores, a broken EAS session -- plus
the settings that matter solely for builds you make outside stim-cli. There is no
`stim init` and no setup skill: the edits doctor names land in files the
project already owns (a `metro.config.js` with its own transformer, a `Podfile`
with existing `post_install` logic, an app config that may be TypeScript),
which is judgement, not templating. The one edit that needed no judgement,
`.stim-cli/` in `.gitignore`, is self-ensured: `start`, `ios` and `android` each
add it if it is missing and say so once on stderr -- commit that line with the
change you were already making, and it stops being rewritten in every fresh
worktree.

For AI coding agents, install the bundled skill so the agent knows how to drive the CLI (the lifecycle, the facts contract, and the destructive-command rules). It installs with the skills CLI, straight from GitHub:

```bash
npx skills add appandflow/stim
```

[Getting started](/docs/getting-started) is the whole human-side setup: install the skill, then describe what you want built.

## The ten commands

| Command                                                                                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start [--json] [--wait <seconds>]`                                                                            | Start this workspace's dev server on the reserved port under a detached supervisor, and block until it answers _and_ verifies as this project's (default 60s). Idempotent: a healthy dev server on the port is a no-op. Bare RN is hosted in-process with stim-cli's NDJSON reporter; Expo runs the project's own `expo start --port <n>` as a child. Structured logs land in `<root>/.stim-cli/logs`, and `.stim-cli/` is added to the project's `.gitignore` if it is not already there. A failure under `--json` still puts one line on stdout: the `{code, message, remedy}` contract (`STIM_CLI_METRO_TIMEOUT`, `STIM_CLI_SUPERVISOR_EXITED`, ...).                                                                                                                                                                                                                                                                        |
| `logs [--source <s...>] [--level <l>] [--since <d>] [--grep <re>] [--tail <n>] [--errors] [--follow] [--json]` | Query the merged NDJSON timeline in `<root>/.stim-cli/logs`. Prints and exits; nothing matching is a successful, empty result (exit 0). `--errors` is the agent-loop query: errors and fatals since the last marker. `--follow` streams.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ios [--json] [--no-metro-check] [--no-build-cache]`                                                           | Boot this workspace's owned simulator, verify the reserved port holds _this project's_ dev server, fingerprint the native inputs, install the cached `.app` if that fingerprint has one (otherwise prebuild / `pod install` / `xcodebuild` and store the result), install, launch wired to the reserved port, and attach a device-log collector. Refuses with `STIM_CLI_NO_METRO` in about a second when nothing holds the port; `--no-metro-check` overrides. On an Expo project a local miss also asks the provider the project already configured (`expo.buildCacheProvider`), time-bounded, and a hit is stored locally on the way past. `--no-build-cache` looks nothing up and builds fresh -- it still stores (replacing the entry) and still uploads. Debug / simulator only.                                                                                                                                           |
| `android [--json] [--no-metro-check] [--no-build-cache]`                                                       | The same over `gradlew assembleDebug` and `adb`, on this workspace's owned emulator, with `adb reverse tcp:8081 tcp:<port>` doing the port wiring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stop [--force] [--json]`                                                                                      | The inverse of `start`: halt this workspace's supervisor, reap its device-log collectors, shut the owned device **down** (never deleted, so it stays assigned), and free the reserved port. Non-destructive and takes no target -- it acts on the current workspace. With no supervisor recorded it falls back to killing an identity-verified Metro on the reserved port; `--force` is only for an unproven listener there. Already-stopped is a success at every step.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `status [--json]`                                                                                              | Show every registered project (machine-wide by default; there is no `--all`): device assignments (owned/legacy), Metro state, supervisor pid / mode / health, last build (fingerprint, cache hit, duration), log directory and error count since the last marker, plus machine capacity and free disk -- on the boot volume, and on the current project's volume too when that is a different one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `gc [--delete] [--older-than <days>] [--all]`                                                                  | Report what stim-cli has left behind: entries for projects whose directory no longer exists, orphaned `stim-cli-*` devices, records naming a device that is no longer on the machine, and every shared build cache with its size. Reports and writes nothing by default; `--delete` reclaims the dead entries (freeing their Metro ports), reaps the orphaned devices, and clears the stale device records (the record only -- there is no device left to touch, so it issues no simctl/avdmanager command). `--older-than <days>` additionally reaps owned devices whose _project_ has gone untouched that long, and trims cache entries nothing has used in that time. `--all` (with `--delete`) empties the caches whole -- see below.                                                                                                                                                                                       |
| `doctor [--json]`                                                                                              | Report what stim-cli cannot handle on its own. The ABSENCE of a project-side cache setting is not a finding -- stim-cli supplies the Metro store, the Xcode compilation cache and the Gradle build cache on its own command lines. What it reports is active misconfiguration: a missing dev client, ccache (which is what stops stim-cli adding its own compilation cache), a `cacheStores` wired behind a conditional so it is off in the case that matters, a compilation CAS left at the per-workspace default, a configured build-cache provider on the key this SDK ignores, an EAS session that cannot answer, `.stim-cli/` missing from `.gitignore`, and -- last, because it computes a real fingerprint twice via a temporary worktree of HEAD (removed again) -- a checkout that does not fingerprint like a fresh worktree. A clean run means nothing stim-cli cannot handle itself. Read-only, and always exits 0. |
| `worktree create <name> [--base <ref>] [--label <name>] [--carry-ignored]`                                     | Create an isolated git worktree: carries over gitignored files, prints the worktree path (and, on stderr, what it branched from -- ref and short sha). `--base` takes `head` (the current checkout's HEAD and the default), `fresh` (origin/HEAD), or any ref `git rev-parse` resolves; an unresolvable one is refused before anything is created. Does not install dependencies unless `--carry-ignored` clones the source's working state: its gitignored paths (node_modules, Pods, build output) plus its uncommitted tracked changes, applied when they fit the base and reported when they do not.                                                                                                                                                                                                                                                                                                                        |
| `worktree remove [<path>] [--force]`                                                                           | Remove a worktree, reclaiming its build artifacts, Metro port, and owned devices (deleted, not just freed). It also removes the branch that Stim created when the branch has no unique commits; attached branches and branches with unique commits remain. Defaults to the current workspace. Refuses if it has uncommitted or unpushed work unless `--force`, naming the right restore command per class (`git checkout --` for modified tracked files, `git clean -fd` for untracked ones). The workspace's own `.stim-cli/` never counts as dirt -- it dies with the worktree by design.                                                                                                                                                                                                                                                                                                                                     |
| `guide [topic]`                                                                                                | Print reference docs for the installed version (topics: facts, metro, logs, errors, lifecycle, cleanup, settings). Generated by the binary, so it cannot drift.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Project labels (`--label`)

Every project has a "shortcut": its `label` if one was set (e.g. via `worktree create --label`), else inherited from the enclosing worktree's label, else the directory basename. It is what names the owned device -- `stim-cli-<label>` -- and what `status` reports a workspace as.

<StimTabs code={`stim worktree create feature-x --label agent-1   # its sim will be stim-cli-agent-1`} />

Two projects sharing the same basename with no distinguishing label collide, which is why `worktree create` registers a label for the worktree root: every worktree of a monorepo otherwise shares the same app-dir basename.
