---
name: rn-iso
description: Manage isolated React Native / Expo dev environments. Each project (or worktree) gets its own Metro server and dedicated simulator/emulator. Use to ensure the right simulator is booted with the right port, and to discover which device to target for UI interactions.
user_invocable: true
---

# rn-iso — Isolated RN Dev Environments

You are an AI agent working on a React Native / Expo project, possibly alongside other agents working on different projects or worktrees. Each project owns its own dedicated simulator and Metro server. There is no locking — your sim is yours.

Invoke the CLI via `npx`: `npx rn-iso <command>`. Don't `npm install -g`; `npx` resolves the latest published version.

## Core workflow

From the project root (or any subdirectory):

1. **Ensure the platform is ready** — `npx rn-iso ios --auto` (or `npx rn-iso android`). This:
   - Allocates a Metro port for the project (or reuses the assigned one)
   - Picks a dedicated unclaimed sim (booting it if shutdown). With `--auto`, picks the first candidate without prompting.
   - Builds and installs the app via the project's `ios` / `android` script if present, else `expo run:ios` / `react-native run-ios`. The build CLI starts Metro itself on the assigned port; rn-iso doesn't spawn a separate Metro. Detects the package manager from the lockfile (walks up for monorepos).

2. **Get the device target** — `npx rn-iso device --platform ios --json`:
   ```json
   {"platform":"ios","udid":"ABC-...","metroPort":8083}
   ```
   Use the UDID for `agent-device` / `xcrun simctl` / `idb`. For Android, the `serial` field gives you `emulator-<port>` to use with `adb -s`.

3. **Interact with the device** — pass the UDID/serial to your UI tools. Never call `simctl <verb>` without `<UDID>` — `booted` could be the wrong sim.

## CRITICAL rules

- **Pass `--auto` for non-interactive use** of `ios` or `android`. Without it, the command will prompt with an arrow-key picker if multiple unclaimed sims/AVDs exist. `--auto` is also implied automatically when stdin isn't a TTY (e.g., when an agent pipes the command), so under most agent harnesses you don't have to remember the flag — but passing it explicitly is harmless and clearer.
- **`--auto` will NOT take over a claimed sim/AVD.** If every device is claimed by other rn-iso projects, `--auto` errors. To take one over, run the command interactively (no `--auto`, with a real TTY) and confirm at the prompt — only do this if the user explicitly asks.
- **Always use `npx rn-iso device` to discover your target.** Never assume `booted` is your sim — another project's simulator might be booted too.
- **Always pass the UDID/serial explicitly** to `xcrun simctl` and `adb -s`. Examples:
  - `xcrun simctl io <UDID> screenshot out.png`
  - `adb -s emulator-5556 shell input tap 100 200`
- **Don't call `release` or `release --shutdown`** unless the user explicitly asks. Other agents may be using neighboring sims; keep yours up so the user can come back to it.
- **Don't manually start Metro on a different port.** `npx rn-iso start` (or `npx rn-iso ios/android`) already handles port assignment.
- **rn-iso never auto-creates simulators.** It reuses existing unclaimed sims (booted or shutdown). If none are available, it errors. To create a new one explicitly, pass `--device-type "iPhone 17 Pro" [--runtime 26.2]`.

## Typical agent workflow

```bash
# Once per session -- ensure the project's sim and Metro are up.
npx rn-iso ios --auto

# Get the target.
UDID=$(npx rn-iso device --platform ios)

# Use the target for UI interactions (delegate to agent-device or your tool).
xcrun simctl io "$UDID" screenshot /tmp/screen.png

# When you change app code, Metro hot-reloads automatically. No restart needed.
# Only re-run `npx rn-iso ios` after native code changes or new native modules.
```

## Locking a manually-started sim

If the user has already booted a sim and started the app themselves (Xcode, Simulator.app, `xcrun simctl boot`, manual `expo run:ios`), and asks you to "lock" or "claim" that sim for the current project, use `reserve`:

```bash
npx rn-iso reserve            # picks from booted iOS sims (current project)
npx rn-iso reserve android    # picks from running emulators
npx rn-iso unreserve          # drop the project's lock (without shutting down)
```

Reserve binds the sim to the current project the same way `ios` does, but skips the build/install step. After reserving, `npx rn-iso device` will return that sim's UDID. Other rn-iso projects will see it as claimed.

## When things go wrong

- **"No rn-iso assignment for project"** — run `npx rn-iso ios` (or android) first.
- **"All iOS simulators are claimed by other rn-iso projects"** (under `--auto`) — every existing sim is held by another project. Options: free another project (`npx rn-iso release` from there), pass `--device-type "iPhone 17 Pro"` to create a new sim, or re-run without `--auto` (in a real TTY) and ask the user before confirming the take-over prompt.
- **"All Android AVDs are claimed by other rn-iso projects"** — same situation on Android. Free another project or re-run interactively to take one over.
- **Wrong sim got the app** — older `@expo/cli` (< 54.0.24) had a bug where the launch ignored `--device`. Bump expo to 54.0.34+ if on SDK 54.
- **Metro port collision** — `npx rn-iso ios` reclaims dead ports automatically. If you see "port busy by non-Metro process," another tool is using that port; close it.
- **Sim was deleted** — `npx rn-iso ios` detects the stale assignment and re-allocates.
- **Detection picked the wrong CLI** (e.g. project has `expo` in deps but uses `react-native run-ios`) — rn-iso prefers your `ios` / `android` script and detects the CLI from its body. Override with `--script <name>` or skip with `--no-script` to force the direct CLI fallback. Override package manager with `--pm <npm|yarn|pnpm|bun>`.

## Other useful commands

- `npx rn-iso status` — show all projects, their assignments, and Metro state.
- `npx rn-iso start` — start Metro detached on the project's assigned port WITHOUT building/installing. Useful to keep Metro alive across builds.
- `npx rn-iso stop [<port>|<shortcut>|<path>]` — kill Metro. No arg = current project. Passing a port (e.g. `8083`) kills whatever is on it; a project shortcut (label or unique basename) or absolute path targets that project. Finds the process by port, so it works whether Metro was started by `npx rn-iso start` or by the build CLI.
- `npx rn-iso release [<shortcut>|<path>] [--platform <p>] [--shutdown]` — free a project's sim assignment. Defaults to the current project. `--shutdown` also stops the sim/emulator.

### Project shortcuts (--label)

Every project has a "shortcut" you can pass to `stop` / `release` instead of the full path. The first interactive run of `ios` / `android` / `reserve` prompts for one (default: directory basename); under `--auto` / non-TTY the prompt is skipped and the basename is used implicitly. To set or override explicitly, pass `--label <name>`:

```bash
npx rn-iso ios --auto --label agent-1
npx rn-iso stop agent-1
```

## Sort order in the picker

When the iOS picker fires, sims are sorted by:
1. Family (iPhone before iPad before others)
2. State (booted before shutdown within family)
3. Usage count (most-used floats up; tracked per UDID across all projects)
4. Name (alphabetical, stable tiebreak)

When the Android picker fires, AVDs are sorted by running state (running emulators first), then alphabetically.

Sims/AVDs claimed by other rn-iso projects show in yellow with a `[claimed by ...]` tag. They're selectable but require a confirm prompt before being taken over.

## Differences from `react-native-worktree`

`react-native-worktree` shares one simulator across worktrees with a mutex. `rn-iso` gives each project its own dedicated simulator — no locking, no contention. If both are installed, prefer `rn-iso` unless the user explicitly asks for the shared-sim model.
