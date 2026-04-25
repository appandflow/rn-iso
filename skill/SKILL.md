---
name: rn-iso
description: Manage isolated React Native / Expo dev environments. Each project (or worktree) gets its own Metro server and dedicated simulator/emulator. Use to ensure the right simulator is booted with the right port, and to discover which device to target for UI interactions.
user_invocable: true
---

# rn-iso — Isolated RN Dev Environments

You are an AI agent working on a React Native / Expo project, possibly alongside other agents working on different projects or worktrees. Each project owns its own dedicated simulator and Metro server. There is no locking — your sim is yours.

## Core workflow

From the project root (or any subdirectory):

1. **Ensure the platform is ready** — `rn-iso ios` or `rn-iso android`. This:
   - Allocates a Metro port for the project (or reuses the assigned one)
   - Picks a dedicated simulator (or boots a new one)
   - Starts Metro detached
   - Builds and installs the app on the simulator

2. **Get the device target** — `rn-iso device --platform ios --json` returns:
   ```json
   {"platform":"ios","udid":"ABC-...","metroPort":8083}
   ```
   Use the UDID for any `agent-device` / `xcrun simctl` / `idb` calls. For Android, the `serial` field gives you `emulator-<port>` to use with `adb -s`.

3. **Interact with the device** — pass the UDID/serial to your UI tools. Never call `simctl boot` or `simctl <verb>` without `<UDID>` — `booted` could be the wrong sim.

## CRITICAL rules

- **Always use `rn-iso device` to discover your target.** Never assume `booted` is your sim — another project's simulator might be booted too.
- **Always pass the UDID/serial explicitly** to `xcrun simctl` and `adb -s`. Examples:
  - `xcrun simctl io <UDID> screenshot out.png`
  - `adb -s emulator-5556 shell input tap 100 200`
- **Don't call `release` or `shutdown`** unless the user explicitly asks. Other agents may be using neighboring sims; keep yours up so the user can come back to it.
- **Don't manually start Metro on a different port.** `rn-iso start` (or `rn-iso ios/android`) already handles port assignment.
- **For non-interactive / first-run scenarios**, pass `--auto` and optionally `--device-type "iPhone 15 Pro"`. Without these, `rn-iso ios` will prompt for a device type if no sims are booted.

## Typical agent workflow

```bash
# Once per session — ensure the project's sim and Metro are up.
rn-iso ios --auto

# Get the target.
UDID=$(rn-iso device --platform ios)

# Use the target for UI interactions (delegate to agent-device or your tool of choice).
xcrun simctl io "$UDID" screenshot /tmp/screen.png

# When you change app code, Metro hot-reloads automatically. No restart needed.
# Only re-run `rn-iso ios` when you've changed native code or installed new native modules.
```

## When things go wrong

- **"No rn-iso assignment for project"** — run `rn-iso ios` (or android) first.
- **"Could not detect bundle identifier"** — your project's `app.json` is missing `expo.ios.bundleIdentifier`. Fix the app config.
- **Metro port collision** — `rn-iso ios` should reclaim dead ports automatically. If you see "port busy by non-Metro process," another tool is using that port; close it.
- **Sim was deleted** — `rn-iso ios` will detect the stale assignment and re-allocate. If not, run `rn-iso prune` then `rn-iso ios`.

## Other useful commands

- `rn-iso status` — show all projects and their state.
- `rn-iso logs` — tail the Metro log for the current project.
- `rn-iso stop` — kill the project's Metro (rare — usually leave it running).
- `rn-iso prune` — GC dead entries machine-wide; safe to run periodically.

## Differences from `react-native-worktree`

`react-native-worktree` shares one simulator across worktrees with a mutex. `rn-iso` gives each project its own dedicated simulator — no locking, no contention. If both are installed, prefer `rn-iso` unless the user explicitly asks for the shared-sim model.
