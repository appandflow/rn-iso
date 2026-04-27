---
name: rn-iso
description: Manage isolated React Native / Expo dev environments. Each project (or worktree) gets its own Metro server and dedicated simulator/emulator. Use to ensure the right simulator is booted with the right port, and to discover which device to target for UI interactions.
user_invocable: true
---

# rn-iso — Isolated RN Dev Environments

You are an AI agent working on a React Native / Expo project, possibly alongside other agents working on different projects or worktrees. Each project owns its own dedicated simulator and Metro server. There is no locking — your sim is yours.

## Core workflow

From the project root (or any subdirectory):

1. **Ensure the platform is ready** — `rn-iso ios --auto` (or `rn-iso android`). This:
   - Allocates a Metro port for the project (or reuses the assigned one)
   - Picks a dedicated unclaimed sim (booting it if shutdown). With `--auto`, picks the first candidate without prompting.
   - Builds and installs the app via the project's `ios` / `android` script if present, else `expo run:ios` / `react-native run-ios`. The build CLI starts Metro itself on the assigned port; rn-iso doesn't spawn a separate Metro. Detects the package manager from the lockfile (walks up for monorepos).

2. **Get the device target** — `rn-iso device --platform ios --json`:
   ```json
   {"platform":"ios","udid":"ABC-...","metroPort":8083}
   ```
   Use the UDID for `agent-device` / `xcrun simctl` / `idb`. For Android, the `serial` field gives you `emulator-<port>` to use with `adb -s`.

3. **Interact with the device** — pass the UDID/serial to your UI tools. Never call `simctl <verb>` without `<UDID>` — `booted` could be the wrong sim.

## CRITICAL rules

- **Always pass `--auto` for non-interactive use.** Without it, `rn-iso ios` will prompt with an arrow-key picker if multiple unclaimed sims exist. Agents must use `--auto` to skip.
- **Always use `rn-iso device` to discover your target.** Never assume `booted` is your sim — another project's simulator might be booted too.
- **Always pass the UDID/serial explicitly** to `xcrun simctl` and `adb -s`. Examples:
  - `xcrun simctl io <UDID> screenshot out.png`
  - `adb -s emulator-5556 shell input tap 100 200`
- **Don't call `release` or `shutdown`** unless the user explicitly asks. Other agents may be using neighboring sims; keep yours up so the user can come back to it.
- **Don't manually start Metro on a different port.** `rn-iso start` (or `rn-iso ios/android`) already handles port assignment.
- **rn-iso never auto-creates simulators.** It reuses existing unclaimed sims (booted or shutdown). If none are available, it errors. To create a new one explicitly, pass `--device-type "iPhone 17 Pro" [--runtime 26.2]`.

## Typical agent workflow

```bash
# Once per session -- ensure the project's sim and Metro are up.
rn-iso ios --auto

# Get the target.
UDID=$(rn-iso device --platform ios)

# Use the target for UI interactions (delegate to agent-device or your tool).
xcrun simctl io "$UDID" screenshot /tmp/screen.png

# When you change app code, Metro hot-reloads automatically. No restart needed.
# Only re-run `rn-iso ios` after native code changes or new native modules.
```

## Reserving sims used by external processes

If you boot a sim outside of rn-iso (Xcode, manual `simctl boot`, another agent that doesn't use rn-iso), tell rn-iso to skip it during allocation:

```bash
# Direct form -- if you know the UDID:
rn-iso reserve ios <UDID> --label "agent-1"
rn-iso reserve android emulator-5554 --label "agent-2"

# Interactive form -- pick from currently booted sims / running emulators:
rn-iso reserve            # both platforms, multi-select picker
rn-iso reserve ios        # iOS only
rn-iso reserve --list     # show current reservations

# Release when done:
rn-iso unreserve ios <UDID>
rn-iso unreserve --all
```

Reserved sims show grayed out as `[reserved]` in `rn-iso ios` pickers and won't be picked by allocation.

## When things go wrong

- **"No rn-iso assignment for project"** — run `rn-iso ios` (or android) first.
- **"No unclaimed iOS simulator available"** — every existing sim is claimed by another project or reserved. Options: open a sim in Simulator.app, run `rn-iso unreserve --all` if you have stale reservations, free another project (`rn-iso release`), or pass `--device-type "iPhone 17 Pro"` to create a new one.
- **Wrong sim got the app** — older `@expo/cli` (< 54.0.24) had a bug where the launch ignored `--device`. Bump expo to 54.0.34+ if on SDK 54.
- **Metro port collision** — `rn-iso ios` reclaims dead ports automatically. If you see "port busy by non-Metro process," another tool is using that port; close it.
- **Sim was deleted** — `rn-iso ios` detects the stale assignment and re-allocates. If not, run `rn-iso prune` then `rn-iso ios`.
- **Detection picked the wrong CLI** (e.g. project has `expo` in deps but uses `react-native run-ios`) — rn-iso prefers your `ios` / `android` script and detects the CLI from its body. Override with `--script <name>` or skip with `--no-script` to force the direct CLI fallback. Override package manager with `--pm <npm|yarn|pnpm|bun>`.

## Other useful commands

- `rn-iso status` — show all projects, their assignments, and Metro state. Reservations appear in their own section.
- `rn-iso start` — start Metro detached on the project's assigned port WITHOUT building/installing. Useful if you want logs (`rn-iso logs`) or to keep Metro alive across builds.
- `rn-iso logs` — tail the Metro log file (only available if Metro was started via `rn-iso start`; the build CLI's Metro doesn't write to our log).
- `rn-iso stop` — kill the project's Metro. Finds the process by port, so it works whether Metro was started by `rn-iso start` or by the build CLI.
- `rn-iso prune` — GC dead entries machine-wide; safe to run periodically.
- `rn-iso release [project]` — unbind device assignment(s). `[project]` is the directory basename or absolute path; defaults to the current project. Lets you free up another project's sim from anywhere (e.g. `rn-iso release agent-1`).

## Sort order in the picker

When the `ios` picker fires, sims are sorted by:
1. Family (iPhone before iPad before others — set by user preference if you usually use iPhones)
2. State (booted before shutdown within family)
3. Usage count (most-used floats up; tracked per UDID across all projects)
4. Name (alphabetical, stable tiebreak)

Claimed and reserved sims are listed but greyed out and skipped by the cursor.

## Differences from `react-native-worktree`

`react-native-worktree` shares one simulator across worktrees with a mutex. `rn-iso` gives each project its own dedicated simulator — no locking, no contention. If both are installed, prefer `rn-iso` unless the user explicitly asks for the shared-sim model.
