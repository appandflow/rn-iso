---
name: stim-cli
description: The React Native / Expo CLI for AI agents. Use when an agent needs an isolated Metro server and simulator or emulator, must build and launch an app, inspect build or runtime errors, create a parallel worktree, or identify the correct device for UI interaction.
---

# stim-cli

Use stim-cli to run React Native and Expo apps without sharing a Metro port or
device with another workspace. Run it through `npx`; do not install it globally.

```bash
npx --package=stim-cli stim <command>
```

Prefer `--json` when another command or device tool needs a port, UDID, serial,
bundle ID, or path.

## Normal workflow

Work in the current checkout by default. Create a worktree only when the task
needs another branch or environment in parallel.

```bash
# Optional. The command prints the new absolute path.
npx --package=stim-cli stim worktree create app-412 --carry-ignored
cd <printed-path>

npx --package=stim-cli stim start
npx --package=stim-cli stim ios                    # or: npx --package=stim-cli stim android
npx --package=stim-cli stim logs --errors --json

# Edit JavaScript or TypeScript. Fast Refresh applies the change.
npx --package=stim-cli stim logs --since 30s --level error

npx --package=stim-cli stim stop
```

Follow these rules during the loop:

- Run `start` before a debug `ios` or `android` build. If the build returns
  `STIM_CLI_NO_METRO`, run `npx --package=stim-cli stim start` and retry.
- Run `ios` or `android` again after a native input changes. A JavaScript-only
  change does not need another native build.
- A cold native build can outlive a shell timeout. Run the same build command
  again. The second call joins the active build or returns its result.
- Target only the UDID, serial, and Metro port from this workspace's current
  JSON output. Never assume that the device named `booted` is yours. Never
  hardcode a Metro port.
- `launched: true` proves the launch. `launched: "bundling"` means Metro still
  builds the bundle. Wait and query the logs. For `launched: "unverified"`,
  follow the printed remedy before you claim success.
- Empty output from `logs --errors` with exit code 0 is the pass condition.
  Do not read the NDJSON files directly.
- Use `npx --package=stim-cli stim status` to find this workspace's device, port, server state,
  and last build. Use `npx --package=stim-cli stim doctor` when a build is unexpectedly slow
  or the environment looks incomplete.

## Ownership and deletion

stim-cli operates only on devices it created. Owned devices use the
`stim-cli-<label>` name. Never use stim-cli on physical or user-created devices.

Treat a refusal as an ownership or state mismatch. Read its code and remedy.
Do not add `--force` as a first response.

Ask the user before these actions:

- `worktree remove`, because it deletes the worktree and its owned device.
- `worktree remove --force`, because it also discards uncommitted and untracked
  files.
- `gc --delete`, because it deletes orphaned resources. `gc --delete --all`
  also empties shared build caches.
- `stop` when the workspace owns an EAS session, because it irreversibly ends
  that remote session. For a local device, `stop` shuts it down but does not
  delete it.

## Load advanced guidance only when needed

The installed CLI is the source of truth for flags, payloads, settings, error
codes, remote devices, release builds, caches, and cleanup. Read the relevant
topic before an advanced operation:

```bash
npx --package=stim-cli stim guide             # list topics
npx --package=stim-cli stim guide lifecycle   # full flow, flags, worktrees, builds, and capacity
npx --package=stim-cli stim guide facts       # JSON payload fields
npx --package=stim-cli stim guide metro       # supervisor, custom Metro, tunnels, and remote devices
npx --package=stim-cli stim guide logs        # filters, record shape, and capture limits
npx --package=stim-cli stim guide errors      # error codes and remedies
npx --package=stim-cli stim guide cleanup     # destructive behavior and disk cleanup
npx --package=stim-cli stim guide settings    # configuration files and supported keys
```

Run the guide before tasks that involve any of these cases:

- release configurations or Android variants;
- remote proxy or EAS devices;
- custom Metro processes or public tunnels;
- cache bypasses, cache misses, or concurrent builds;
- machine capacity limits;
- worktree carry-over warnings;
- fingerprint exclusions;
- destructive cleanup or an unfamiliar error code.

If this skill and `stim guide` disagree, follow the guide. The guide comes
from the binary that is running.
