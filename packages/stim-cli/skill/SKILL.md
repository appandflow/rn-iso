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

Or install it once, which provides the same `stim` command:

```bash
npm install --global stim-cli
```

Do not change the installation mode unless the user asks. Later examples use
`stim`. If it is not installed globally, replace `stim` with the `npx` form above.

Stim requires Node 20.19.4+, or 22.12.0+ on Node 22. If `npx` returns E401 or
E404 in a repo with a private registry, use:

```bash
npx --registry=https://registry.npmjs.org stim-cli <command>
```

Prefer plain output: it streams each phase and ends with the facts the next step
needs. Use `--json` only when a script must parse a stable payload.

## Normal workflow

Work in the current checkout by default. When the agent creates an app worktree
for isolation or parallel work, carry its dependencies and native outputs.

Before a native worktree task, run `stim doctor`: it checks the main checkout
even from a linked worktree. Fix its dependency and CocoaPods findings, and
inspect any locally known upstream gap.

```bash
stim doctor

# In the main checkout, seed the shared build caches when more native
# worktrees are coming; skip one-off or JavaScript-only work.
stim start
stim ios                    # or: stim android
stim stop

# Branches from HEAD. --carry-ignored carries installed dependencies and
# native output: pass it on the first creation, never on a retry. It prints
# the new absolute path.
stim worktree create <name> --carry-ignored
cd <printed-path>

stim start
stim ios                    # or: stim android
stim logs --errors

# Edit JavaScript or TypeScript. Fast Refresh applies the change.
stim logs --since 30s --level error

stim stop

stim worktree remove
```

Follow these rules during the loop:

- Run `start` before a debug `ios` or `android` build. If it returns
  `STIM_NO_METRO`, run `stim start` and retry.
- Run `ios` or `android` again after a native input changes. A JavaScript-only
  change does not need one.
- A cold native build can outlive a shell timeout. Run the same command again:
  the second call joins the active build or returns its result.
- `ios` and `android` install the app, launch it, and check its readiness. No
  separate device tool is required. Trust the exact device, app, Metro, and
  launch facts in Stim's final summary. Use the full reported device ID. Never
  assume that a simulator named `booted` belongs to this workspace.
- An `OK` summary with no launch qualifier proves the launch. `bundle requested,
still building` means Metro has not finished the bundle; wait and query the
  logs. For `launch UNVERIFIED`, follow the printed remedy before you claim
  success. JSON reports these as `true`, `"bundling"`, and `"unverified"` in
  `launched`.
- Exit code 0 from `logs --errors` is the pass condition. Human output can show
  `No matching log records` on stderr. JSON mode prints zero bytes when no
  records match. Do not read the NDJSON files directly.
- Use `stim status` when resuming a workspace or recovering missing device,
  port, server, or build facts; a normal `start` and platform run already print
  them. Use `stim doctor` when a build is unexpectedly slow or the environment
  looks incomplete.

## Ownership and deletion

Stim creates, boots, and deletes only devices it created. Owned simulators use
the `stim-<label> (<model> <runtime>)` name. Never point Stim at a user-created
emulator or simulator.

`worktree remove` parks the workspace's simulator for a later one to adopt. A
parked simulator is Stim-owned: never delete one by hand; `gc --delete` empties
the pool (`stim guide lifecycle`). A first launch on a physical iPhone can need
one-time taps the remedy names.

`stim android --device [serial]` and `stim ios --device [udid]` install on a
connected physical device. Stim never creates, boots, or deletes hardware, and
records nothing about it, so `stop` and `gc` leave it alone.

A `--device` run leases that device for the run. `stim device lock ios --for
10m` holds it across runs; `stim device unlock` gives it back
(`stim guide lifecycle`). Never delete another workspace's lease file under
`~/.stim/device-locks`; `gc --delete` removes the expired ones.

Treat a refusal as an ownership or state mismatch: read its code and remedy.
Never reach for `--force` first.

Ask the user before these actions:

- `worktree remove`, because it deletes the worktree, its Stim-created branch
  when it has no unique commits, and gives up its owned device.
- `worktree remove --force`, because it also discards uncommitted and untracked
  files.
- `gc --delete`, because it deletes orphaned resources. `gc --delete --cache all`
  empties the shared build caches instead; it inspects nothing else.
- `stop` when the workspace owns an EAS session, because it irreversibly ends
  that remote session. For a local device, `stop` shuts it down but does not
  delete it. An explicit `stop` shuts down a Stim-owned simulator even when
  another process uses it. It never shuts down an unowned simulator.

## Under a sandbox

An agent harness that sandboxes shell commands usually permits writes inside
the project and little else. Three things Stim needs sit outside that
boundary, and none of the failures names the sandbox: writes to `STIM_HOME`
(`~/.stim` unless set) fail with `EPERM` on a directory the user can write, the
iOS simulator service looks dead, and the adb server looks unreachable. They
are not a broken machine: compare that path against the harness's allowlist,
and the conflict is visible before anything runs.

Decide at the start of a session, not after the third failure: either run Stim
with the harness's sandbox disabled, or ask the user to allow those three.
`stim guide errors` lists what to allow.

## Load advanced guidance only when needed

The installed CLI is the source of truth for flags, payloads, settings, error
codes, remote devices, release builds, caches, and cleanup. Read the topic
first:

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

Run the guide before tasks involving any of these:

- release configurations or Android variants;
- remote proxy or EAS devices;
- custom Metro processes or public tunnels;
- cache bypasses, cache misses, or concurrent builds;
- machine capacity limits;
- cache hit rates or the time the cache saved, which `stim stats` reports;
- worktree carry-over warnings;
- fingerprint exclusions;
- `gc`, `--force`, cleanup failures, or unfamiliar cleanup states and error
  codes.

Ordinary `stim stop` and an authorized clean `stim worktree remove` do not need
the cleanup guide.

If this skill and `stim guide` disagree, follow the guide: it comes from the
binary that is running.
