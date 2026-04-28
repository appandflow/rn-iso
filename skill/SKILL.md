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

1. **Ensure the platform is ready** — `npx rn-iso ios --auto` (or `npx rn-iso android --auto`). This:
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

- **Always pass `--auto` for non-interactive use.** Without it, `npx rn-iso ios` will prompt with an arrow-key picker if multiple unclaimed sims exist. Agents must use `--auto` to skip.
- **`--auto` will NOT steal a claimed sim.** If every sim is claimed (other rn-iso projects or reservations), `--auto` errors out instead of taking one over. To take over a sim, run `npx rn-iso ios` (no `--auto`) and confirm at the prompt — only do this if the user explicitly asks.
- **Always use `npx rn-iso device` to discover your target.** Never assume `booted` is your sim — another project's simulator might be booted too.
- **Always pass the UDID/serial explicitly** to `xcrun simctl` and `adb -s`. Examples:
  - `xcrun simctl io <UDID> screenshot out.png`
  - `adb -s emulator-5556 shell input tap 100 200`
- **Don't call `release` or `shutdown`** unless the user explicitly asks. Other agents may be using neighboring sims; keep yours up so the user can come back to it.
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

## Reserving sims used by external processes

If you boot a sim outside of rn-iso (Xcode, manual `simctl boot`, another agent that doesn't use rn-iso), tell rn-iso to skip it during allocation:

```bash
# Direct form -- if you know the UDID:
npx rn-iso reserve ios <UDID> --label "agent-1"
npx rn-iso reserve android emulator-5554 --label "agent-2"

# Interactive form -- pick from currently booted sims / running emulators:
npx rn-iso reserve            # both platforms, multi-select picker
npx rn-iso reserve ios        # iOS only
npx rn-iso reserve --list     # show current reservations

# Release when done -- by UDID/serial OR by the label:
npx rn-iso unreserve <UDID>
npx rn-iso unreserve agent-1     # by label
npx rn-iso release agent-1       # `release` accepts the label too
npx rn-iso unreserve --all
```

Reserved sims appear in the `npx rn-iso ios` picker tagged `[reserved]`. They're selectable, but picking one prompts to confirm taking it over (which removes the reservation). Under `--auto`, they're skipped entirely.

## When things go wrong

- **"No rn-iso assignment for project"** — run `npx rn-iso ios` (or android) first.
- **"All iOS simulators are claimed by other projects or reservations"** (under `--auto`) — every existing sim is held by another rn-iso project or a reservation. Options: free another project (`npx rn-iso release` from there), `npx rn-iso unreserve --all` for stale reservations, pass `--device-type "iPhone 17 Pro"` to create a new sim, or re-run without `--auto` and ask the user before confirming the take-over prompt.
- **Wrong sim got the app** — older `@expo/cli` (< 54.0.24) had a bug where the launch ignored `--device`. Bump expo to 54.0.34+ if on SDK 54.
- **Metro port collision** — `npx rn-iso ios` reclaims dead ports automatically. If you see "port busy by non-Metro process," another tool is using that port; close it.
- **Sim was deleted** — `npx rn-iso ios` detects the stale assignment and re-allocates. If not, run `npx rn-iso prune` then `npx rn-iso ios`.
- **Detection picked the wrong CLI** (e.g. project has `expo` in deps but uses `react-native run-ios`) — rn-iso prefers your `ios` / `android` script and detects the CLI from its body. Override with `--script <name>` or skip with `--no-script` to force the direct CLI fallback. Override package manager with `--pm <npm|yarn|pnpm|bun>`.

## Other useful commands

- `npx rn-iso status` — show all projects, their assignments, and Metro state. Reservations appear in their own section.
- `npx rn-iso start` — start Metro detached on the project's assigned port WITHOUT building/installing. Useful if you want logs (`npx rn-iso logs`) or to keep Metro alive across builds.
- `npx rn-iso logs` — tail the Metro log file (only available if Metro was started via `npx rn-iso start`; the build CLI's Metro doesn't write to our log).
- `npx rn-iso stop` — kill the project's Metro. Finds the process by port, so it works whether Metro was started by `npx rn-iso start` or by the build CLI.
- `npx rn-iso prune` — GC dead entries machine-wide; safe to run periodically.
- `npx rn-iso release [target]` — free a project assignment OR a reservation. `[target]` is an absolute project path, the `--label` you set when reserving, or a UDID/serial. Defaults to the current project. Examples:
  - `npx rn-iso release` -- current project
  - `npx rn-iso release /Users/x/Developer/myapp` -- specific project by path
  - `npx rn-iso release agent-1` -- reservation by label (works across iOS/Android)
- `npx rn-iso unreserve <id|label>` — same as `npx rn-iso release` for reservations specifically. Accepts UDID, emulator serial, OR the `--label` from when you reserved. Pass `--platform ios|android` to restrict.

## Sort order in the picker

When the `ios` picker fires, sims are sorted by:
1. Family (iPhone before iPad before others)
2. State (booted before shutdown within family)
3. Usage count (most-used floats up; tracked per UDID across all projects)
4. Name (alphabetical, stable tiebreak)

Claimed and reserved sims show in yellow with a `[claimed by ...]` / `[reserved: ...]` tag. They're selectable but require a confirm prompt before being taken over.

## Differences from `react-native-worktree`

`react-native-worktree` shares one simulator across worktrees with a mutex. `rn-iso` gives each project its own dedicated simulator — no locking, no contention. If both are installed, prefer `rn-iso` unless the user explicitly asks for the shared-sim model.
