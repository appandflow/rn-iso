---
name: stim
description: The React Native / Expo CLI for AI agents. Use when an agent needs an isolated Metro server and simulator or emulator, must build and launch an app, inspect build or runtime errors, create a parallel worktree, or identify the correct device for UI interaction.
---

# Stim

Use Stim to run React Native and Expo apps without sharing a Metro port or
device with another workspace. Run it without installing:

```bash
npx stim-cli <command>
```

The user can instead install it once, which provides the same `stim` command:

```bash
npm install --global stim-cli
```

Do not change the installation mode unless the user asks. Later examples use
`stim`. If it is not installed globally, replace `stim` with the `npx` form above.

Stim requires Node 20.19.4 or later on Node 20, or Node 22.12.0 or
later. If `npx` returns E401 or E404 in a repo with a private registry, use:

```bash
npx --registry=https://registry.npmjs.org stim-cli <command>
```

Prefer plain output for agent workflows. It streams each phase and ends with the
full device ID, app ID, Metro state, cache result, and log path. Use `--json`
only when a script must parse a stable payload.

## Normal workflow

Work in the current checkout by default. When the agent creates an app worktree
for isolation or parallel work, carry its installed dependencies and native
outputs.

Before a native worktree task, run `stim doctor`. Doctor checks the main
checkout even when it runs from a linked worktree. Fix its main-checkout
dependency and CocoaPods findings. Inspect any locally known upstream gap.

```bash
stim doctor

# When more native worktrees are expected, build the main checkout once to
# seed the shared build caches. Run these commands in the main checkout. Skip
# this for one-off or JavaScript-only work.
stim start
stim ios                    # or: stim android
stim stop

# By default, this branches from the current HEAD. The warm flag carries installed
# dependencies and native output. Use it on the first creation. Do not create a
# cold worktree first and retry. The command prints the new absolute path.
stim worktree create <name> --carry-ignored
cd <printed-path>

stim start
stim ios                    # or: stim android
stim logs --errors

# Edit JavaScript or TypeScript. Fast Refresh applies the change.
stim logs --since 30s --level error

stim stop

# If this workflow created a worktree, ask the user before deleting it.
stim worktree remove
```

Follow these rules during the loop:

- Run `start` before a debug `ios` or `android` build. If the build returns
  `STIM_NO_METRO`, run `stim start` and retry.
- Run `ios` or `android` again after a native input changes. A JavaScript-only
  change does not need another native build.
- A cold native build can outlive a shell timeout. Run the same build command
  again. The second call joins the active build or returns its result.
- `ios` and `android` install the app, launch it, and check its readiness. No
  separate device tool is required. Trust the exact device, app, Metro, and
  launch facts in Stim's final summary. Use the full reported device ID. Never
  assume that a simulator named `booted` belongs to this workspace.
- An `OK` summary with no launch qualifier proves the launch. When the summary
  says `bundle requested, still building`, Metro has not completed the bundle;
  wait and query the logs. For `launch UNVERIFIED`, follow the printed remedy
  before you claim success. JSON reports these states as `true`, `"bundling"`,
  and `"unverified"` in `launched`.
- Exit code 0 from `logs --errors` is the pass condition. Human output can show
  `No matching log records` on stderr. JSON mode prints zero bytes when no
  records match. Do not read the NDJSON files directly.
- Use `stim status` when resuming a workspace or recovering missing device,
  port, server, or build facts. A normal `start` and platform run already print
  the facts needed for the next step. Use `stim doctor` when a build is
  unexpectedly slow or the environment looks incomplete.

## Ownership and deletion

Stim operates only on devices it created. Owned devices use the
`stim-<label>` name. Never use Stim on physical or user-created devices.

Treat a refusal as an ownership or state mismatch. Read its code and remedy.
Do not add `--force` as a first response.

Ask the user before these actions:

- `worktree remove`, because it deletes the worktree, its Stim-created branch
  when it has no unique commits, and its owned device.
- `worktree remove --force`, because it also discards uncommitted and untracked
  files.
- `gc --delete`, because it deletes orphaned resources. `gc --delete --all`
  also empties shared build caches.
- `stop` when the workspace owns an EAS session, because it irreversibly ends
  that remote session. For a local device, `stop` shuts it down but does not
  delete it. An explicit `stop` shuts down a Stim-owned simulator even when
  another process uses it. It never shuts down an unowned simulator.

## Load advanced guidance only when needed

The installed CLI is the source of truth for flags, payloads, settings, error
codes, remote devices, release builds, caches, and cleanup. Read the relevant
topic before an advanced operation:

```bash
stim guide             # list topics
stim guide lifecycle   # full flow, flags, worktrees, builds, and capacity
stim guide facts       # JSON payload fields
stim guide metro       # supervisor, custom Metro, tunnels, and remote devices
stim guide logs        # filters, record shape, and capture limits
stim guide errors      # error codes and remedies
stim guide cleanup     # destructive behavior and disk cleanup
stim guide settings    # configuration files and supported keys
```

Run the guide before tasks that involve any of these cases:

- release configurations or Android variants;
- remote proxy or EAS devices;
- custom Metro processes or public tunnels;
- cache bypasses, cache misses, or concurrent builds;
- machine capacity limits;
- worktree carry-over warnings;
- fingerprint exclusions;
- `gc`, `--force`, cleanup failures, or unfamiliar cleanup states and error
  codes.

Ordinary `stim stop` and an authorized clean `stim worktree remove` do not need
the cleanup guide.

If this skill and `stim guide` disagree, follow the guide. The guide comes
from the binary that is running.
