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

1. **Ensure the platform is ready** — `npx rn-iso ios --auto --managed-metro` (or `npx rn-iso android --auto --managed-metro`). This:
   - Allocates a Metro port for the project (or reuses the assigned one)
   - With `--managed-metro`: **starts Metro detached, logging to a per-project file.** Metro survives the shell that ran the command — you do NOT need to keep the command running or restart Metro after a build. The build CLI is passed `--no-packager` / `--no-bundler` so it never spawns a competing Metro.
   - Picks a dedicated unclaimed sim (booting it if shutdown). With `--auto`, picks the first candidate without prompting.
   - Builds and installs the app via the project's `ios` / `android` script if present, else `expo run:ios` / `react-native run-ios`. Detects the package manager from the lockfile (walks up for monorepos).

2. **Get the device target** — `npx rn-iso device --platform ios --json`:
   ```json
   {"platform":"ios","udid":"ABC-...","metroPort":8083,"metroPid":12345,"metroHealthy":true,"metroLog":"~/.rn-iso/logs/<hash>.log"}
   ```
   `metroHealthy` is a live ping of Metro's /status endpoint — if it's `false` after a build, something is wrong (see "When things go wrong"). `metroLog` is the managed Metro log file (also via `rn-iso logs`). Use the UDID for `agent-device` / `xcrun simctl` / `idb`. For Android, the `serial` field gives you `emulator-<port>` (or the hardware serial for a physical device) to use with `adb -s`. The Android JSON payload also includes `kind: "emulator" | "physical"`.

3. **Interact with the device** — pass the UDID/serial to your UI tools. Never call `simctl <verb>` without `<UDID>` — `booted` could be the wrong sim.

## CRITICAL rules

- **ALWAYS pass `--managed-metro`** to `ios` / `android`. Without it, the build CLI starts Metro as a child of YOUR shell — when your shell command exits, Metro dies with it and the app is left showing a blank screen. The flag is off by default because humans want the interactive bundler; agents never do.
- **Pass `--auto` for non-interactive use** of `ios` or `android`. Without it, the command will prompt with an arrow-key picker if multiple unclaimed sims/AVDs exist. `--auto` is also implied automatically when stdin isn't a TTY (e.g., when an agent pipes the command), so under most agent harnesses you don't have to remember the flag — but passing it explicitly is harmless and clearer.
- **Forward extra flags to the build CLI with `--`.** `npx rn-iso ios -- --variant=release` (or `android -- --mode=diaRelease`) appends those flags to the underlying `react-native run-*` / `expo run:*` invocation. Useful for release-mode builds, custom terminals, etc. Last-wins semantics, so extras can override defaults rn-iso set earlier in the command. `start` accepts the same `--` extras and forwards them to `expo start` / `react-native start`. For a cache-cleared restart use the first-class flag `npx rn-iso start --reset-cache` (the bare `--` form does not survive `npx`, which swallows the separator). If Metro is already running, extras are not applied (run `rn-iso stop` first and re-run).
- **`--auto` will NOT take over a claimed sim/AVD.** If every device is claimed by other rn-iso projects, `--auto` errors. To take one over, run the command interactively (no `--auto`, with a real TTY) and confirm at the prompt — only do this if the user explicitly asks.
- **Always use `npx rn-iso device` to discover your target.** Never assume `booted` is your sim — another project's simulator might be booted too.
- **Always pass the UDID/serial explicitly** to `xcrun simctl` and `adb -s`. Examples:
  - `xcrun simctl io <UDID> screenshot out.png`
  - `adb -s emulator-5556 shell input tap 100 200`
- **Don't call `release` or `release --shutdown`** unless the user explicitly asks. Other agents may be using neighboring sims; keep yours up so the user can come back to it.
- **Don't manually start Metro on a different port.** `npx rn-iso start` (or `npx rn-iso ios/android`) already handles port assignment.
- **rn-iso never auto-creates simulators.** It reuses existing unclaimed sims (booted or shutdown) and, on Android, also surfaces any physical device adb can see. If nothing is available, it errors. To create a new iOS sim explicitly, pass `--device-type "iPhone 17 Pro" [--runtime 26.2]`.

## Typical agent workflow

```bash
# Once per session -- ensure the project's sim and Metro are up.
# --managed-metro keeps Metro alive after this command exits (see CRITICAL rules).
npx rn-iso ios --auto --managed-metro

# Get the target.
UDID=$(npx rn-iso device --platform ios)

# Use the target for UI interactions (delegate to agent-device or your tool).
xcrun simctl io "$UDID" screenshot /tmp/screen.png

# When you change app code, Metro hot-reloads automatically. No restart needed.
# Only re-run `npx rn-iso ios` after native code changes or new native modules.

# Something looks wrong (blank screen, red box)? Read the Metro log first.
npx rn-iso logs -n 50
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
- **"All iOS simulators are claimed by other rn-iso projects"** (under `--auto`) — every existing sim is held by another project. Claims from deleted worktrees don't count (they're auto-reclaimed), so these are all live projects. Options: `npx rn-iso prune` if you suspect stale state, free another project (`npx rn-iso release` from there), pass `--device-type "iPhone 17 Pro"` to create a new sim, or re-run without `--auto` (in a real TTY) and ask the user before confirming the take-over prompt.
- **"All Android AVDs are claimed by other rn-iso projects"** — same situation on Android. Free another project or re-run interactively to take one over.
- **Wrong sim got the app** — older `@expo/cli` (< 54.0.24) had a bug where the launch ignored `--device`. Bump expo to 54.0.34+ if on SDK 54.
- **Blank screen / app installed but nothing renders** — check `npx rn-iso status`. Metro `stopped` almost always means the build ran WITHOUT `--managed-metro`, so Metro died with the shell that ran it: recover with `npx rn-iso start`, then relaunch the app (`xcrun simctl launch <UDID> <bundleId>`), and pass the flag next time. If Metro IS running, read `npx rn-iso logs -n 50` for bundle/resolution errors (a stale `node_modules` after a branch switch is a classic — reinstall deps, then `npx rn-iso stop` + `start`).
- **Metro port collision** — `npx rn-iso ios` reclaims dead ports automatically. If you see "port busy by non-Metro process," another tool is using that port; close it.
- **Sim was deleted** — `npx rn-iso ios` detects the stale assignment and re-allocates.
- **Detection picked the wrong CLI** (e.g. project has `expo` in deps but uses `react-native run-ios`) — rn-iso prefers your `ios` / `android` script and detects the CLI from its body. Override with `--script <name>` or skip with `--no-script` to force the direct CLI fallback. Override package manager with `--pm <npm|yarn|pnpm|bun>`.

## Other useful commands

- `npx rn-iso status` — show all projects, their assignments, and Metro state.
- `npx rn-iso logs [<port>|<shortcut>|<path>] [-n <lines>] [--follow]` — print the managed Metro log (default: last 50 lines of the current project's). This is where bundle progress, module-resolution errors, and client console logs land. **Check this first on a blank screen or red box** — it's faster than screenshots.
- `npx rn-iso prune` — remove entries for projects whose directory no longer exists (deleted worktrees), freeing their sims/emulators and ports, and killing any orphaned Metro. Live projects are never touched. Claims from deleted worktrees are also ignored automatically during device selection, so prune is housekeeping, not a prerequisite.
- `npx rn-iso start [--reset-cache] [-- <extras...>]` — start Metro detached on the project's assigned port WITHOUT building/installing. `--reset-cache` clears Metro's transform cache. Other extras after `--` are forwarded to `expo start` / `react-native start`.
- `npx rn-iso stop [<port>|<shortcut>|<path>]` — kill Metro. No arg = current project. Passing a port (e.g. `8083`) kills whatever is on it; a project shortcut (label or unique basename) or absolute path targets that project. Finds the process by port, so it works whether Metro was started by `npx rn-iso start` or by the build CLI.
- `npx rn-iso release [<port>|<shortcut>|<path>] [--platform <p>] [--shutdown]` — free a project's sim assignment. Defaults to the current project. Target can also be a Metro port (`8083`) or a shortcut (label / unique basename). `--shutdown` also stops the sim/emulator.
- `npx rn-iso shutdown [<shortcut>|<path>] [-y] [--keep-sims]` — kill Metro, shut down sims/emulators, and clear device assignments. With no arg, scopes to **every** registered project (end-of-day reset); pass a project shortcut (label or unique basename) or absolute path to scope to one. Note this does NOT default to the current project (deliberate — `shutdown` is the explicit "tear it all down" command). Prompts unless `-y` / non-TTY; `--keep-sims` only kills Metro and clears assignments without touching the sims. Project entries themselves stay registered, so `metroPort` allocations and labels survive.
- `npx rn-iso config [<key> [<value>]] [--unset] [--project <target>]` — persist per-project settings. Allowed keys: `packageManager` (npm|yarn|pnpm|bun), `ios.script`, `android.script`. Resolution order on `ios`/`android`: CLI flag > stored setting > inferred default. Useful when a project's build script is named differently (`dev:ios` instead of `ios`) or when a different package manager is used than the lockfile suggests.

### Project shortcuts (--label)

Every project has a "shortcut" you can pass to `stop` / `release` instead of the full path. The first interactive run of `ios` / `android` / `reserve` prompts for one (default: directory basename); under `--auto` / non-TTY the prompt is skipped and the basename is used implicitly. To set or override explicitly, pass `--label <name>`:

```bash
npx rn-iso ios --auto --label agent-1
npx rn-iso stop agent-1
```

## Sort order in the picker

When the iOS picker fires, sims are sorted by:
1. Family (iPhone before iPad before others)
2. State (booted before shutdown within family, so an already-running sim is reused rather than booting another)
3. Runtime version (newest installed iOS runtime first, so `--auto`/agent runs prefer the latest runtime over older ones within the same state)
4. Usage count (most-used floats up; tracked per UDID across all projects)
5. Name (alphabetical, stable tiebreak)

When the Android picker fires, candidates include both AVDs on disk and physical devices currently visible to `adb`. They are sorted by running state (running emulators and connected physical devices first), then physical above AVDs within the same running group, then alphabetically. Physical devices show with a `[physical]` tag. Once selected, a physical device is claimed by serial just like an AVD; `release` clears the claim but never shuts the device down.

Sims/AVDs claimed by other rn-iso projects show in yellow with a `[claimed by ...]` tag. They're selectable but require a confirm prompt before being taken over.

## Differences from `react-native-worktree`

`react-native-worktree` shares one simulator across worktrees with a mutex. `rn-iso` gives each project its own dedicated simulator — no locking, no contention. If both are installed, prefer `rn-iso` unless the user explicitly asks for the shared-sim model.
