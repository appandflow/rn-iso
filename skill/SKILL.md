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
- **Don't call `release`** unless the user explicitly asks. If the assigned device is one rn-iso created, `release` deletes it (not just a claim release); other agents may be using neighboring sims, so keep yours up so the user can come back to it.
- **Don't manually start Metro on a different port.** `npx rn-iso start` (or `npx rn-iso ios/android`) already handles port assignment.
- **rn-iso never auto-creates simulators.** It reuses existing unclaimed sims (booted or shutdown) and, on Android, also surfaces any physical device adb can see. If nothing is available, it errors. To create a new iOS sim explicitly, pass `--device-type "iPhone 17 Pro" [--runtime 26.2]`.
- **Never run `rn-iso gc --delete` without asking the user.** It is the only destructive command in the tool and can erase tens of gigabytes of build output. A bare `rn-iso gc` (no flag) is always safe — it only reports what it would delete.
- **Never pass `--force` to `rn-iso worktree remove` without asking the user.** A refusal to remove means the worktree holds uncommitted changes, untracked files, or commits that exist on no remote. `--force` discards the uncommitted/untracked state permanently. Push the branch instead, or confirm with the user first.
- **If `rn-iso worktree list` shows "setup incomplete"**, or `rn-iso ios` / `rn-iso android` warns `worktree setup is incomplete`, the worktree's setup pipeline (e.g. `npm install`) failed when the worktree was created. Read the recorded failing command from that warning and re-run it directly rather than guessing why the build breaks.

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

## Worktrees

**Prefer `npx rn-iso worktree create` over a raw `git worktree add`.** `create` is what performs carry-over of gitignored files (like `.env`), runs the project's setup pipeline (install, etc.), and sets the label that stops monorepo shortcut collisions (every worktree of a monorepo shares the same app-dir basename, e.g. `tlon-mobile`, so without the label their `rn-iso` shortcuts collide). A raw `git worktree add` skips all three, leaving a worktree that looks fine but has no `node_modules`, no `.env`, and a shortcut that fights its siblings.

```bash
npx rn-iso worktree create <name> [--base fresh|head] [--no-install] [--label <label>]
npx rn-iso worktree remove <path> [--force]
npx rn-iso worktree list
```

- **`create <name>`** — makes a sibling worktree (next to the repo, not inside it — see the README for why), branches it as `worktree-<name>` from `origin/HEAD` (`--base fresh`, the default) or the current `HEAD` (`--base head`), carries over any gitignored files matched by `.worktreeinclude` (or the `worktree.include` setting), then runs the install pipeline (`--no-install` skips it). **Prints only the worktree's absolute path to stdout** — everything else (progress, warnings, failures) goes to stderr, and the command exits 0 even if setup failed, so it's safe to wire into automation (see the README's `WorktreeCreate` hook example). If setup fails or is skipped, the worktree is still created and usable; `rn-iso ios` / `rn-iso android` will warn about it later.
- **`remove <path>`** — reclaims the worktree's build artifacts, Metro port, and (nested app-dir projects included) every owned sim/AVD registered under it: an owned device is shut down and deleted, not just unassigned, since the environment dies whole. A legacy or physical device assignment is only ever cleared, never deleted. An owned iOS sim actively driven by a foreign UI-test runner is left running (its claim is dropped and it's reported as skipped) so `gc` can catch it later. Refuses (exit 1) if the worktree has uncommitted changes, untracked files, or commits not on any remote — see "Refusing to remove" below. Also refuses if `<path>` is the main checkout or not a worktree of the current repo at all.
- **`list`** — lists this repo's worktrees with a per-worktree setup status: `setup ok`, `setup incomplete`, or `unmanaged` (created outside `rn-iso worktree create`, e.g. by raw `git worktree add`).

## gc — reclaiming disk space

`npx rn-iso gc [--delete] [--older-than <days>]` finds Xcode DerivedData directories left behind by deleted worktrees (matched by the workspace path recorded in each DerivedData entry, not by rn-iso's own config) plus dead `rn-iso` project entries, and reports how much disk space reclaiming them would free.

**`gc` with no flag only reports — it never deletes anything.** Pass `--delete` to actually remove the reported directories and entries; this is the only destructive command in the tool (see the CRITICAL rule above — always ask before running it with `--delete`). `--older-than <days>` narrows the report to artifacts not accessed recently.

The report has three buckets:
- **Orphaned build artifacts** — DerivedData whose workspace path no longer exists. Deleted (with sizes) under `--delete`.
- **Dead project entries** — `rn-iso` config entries whose project directory no longer exists. Pruned under `--delete` (same as `rn-iso prune`).
- **Skipped** — entries `gc` could NOT prove are dead (see "gc reporting entries as skipped" below). Never deleted, even under `--delete`.

## When things go wrong

- **"No rn-iso assignment for project"** — run `npx rn-iso ios` (or android) first.
- **"All iOS simulators are claimed by other rn-iso projects"** (under `--auto`) — every existing sim is held by another project. Claims from deleted worktrees don't count (they're auto-reclaimed), so these are all live projects. Options: `npx rn-iso prune` if you suspect stale state, free another project (`npx rn-iso release` from there), pass `--device-type "iPhone 17 Pro"` to create a new sim, or re-run without `--auto` (in a real TTY) and ask the user before confirming the take-over prompt.
- **"All Android AVDs are claimed by other rn-iso projects"** — same situation on Android. Free another project or re-run interactively to take one over.
- **Wrong sim got the app** — older `@expo/cli` (< 54.0.24) had a bug where the launch ignored `--device`. Bump expo to 54.0.34+ if on SDK 54.
- **Blank screen / app installed but nothing renders** — check `npx rn-iso status`. Metro `stopped` almost always means the build ran WITHOUT `--managed-metro`, so Metro died with the shell that ran it: recover with `npx rn-iso start`, then relaunch the app (`xcrun simctl launch <UDID> <bundleId>`), and pass the flag next time. If Metro IS running, read `npx rn-iso logs -n 50` for bundle/resolution errors (a stale `node_modules` after a branch switch is a classic — reinstall deps, then `npx rn-iso stop` + `start`).
- **Metro port collision** — `npx rn-iso ios` reclaims dead ports automatically. If you see "port busy by non-Metro process," another tool is using that port; close it.
- **Sim was deleted** — `npx rn-iso ios` detects the stale assignment and re-allocates.
- **Detection picked the wrong CLI** (e.g. project has `expo` in deps but uses `react-native run-ios`) — rn-iso prefers your `ios` / `android` script and detects the CLI from its body. Override with `--script <name>` or skip with `--no-script` to force the direct CLI fallback. Override package manager with `--pm <npm|yarn|pnpm|bun>`.
- **"Refusing to remove `<path>`"** — `rn-iso worktree remove` found uncommitted changes, untracked files, or commits not on any remote in that worktree, and refused rather than risk losing work. Push the branch to fix the "unpushed commits" case. Do not re-run with `--force` without asking the user first — `--force` permanently discards uncommitted changes and untracked files (committed work on the branch is safe either way, since the branch ref survives).
- **A sim shows `[in use]`** in the iOS picker — a foreign tool (usually a UI-test runner, e.g. XCTest) is actively driving that sim; this is different from `[claimed by ...]`, which means another rn-iso project owns it. `--auto` automatically skips `[in use]` sims. Do not take one over interactively without asking the user first.
- **`gc` reports entries as "skipped"** — these are directories `gc` could NOT prove are dead: the workspace path lives on an unmounted volume, or its DerivedData metadata (`info.plist`) could not be read. Skipped is a safety outcome, not an error — `gc` fails closed rather than guessing. In particular, since this machine's repos live on an external volume, unplugging that volume makes everything on it show as skipped (never deleted) instead of orphaned.

## Other useful commands

- `npx rn-iso status` — show all projects, their assignments, and Metro state.
- `npx rn-iso logs [<port>|<shortcut>|<path>] [-n <lines>] [--follow]` — print the managed Metro log (default: last 50 lines of the current project's). This is where bundle progress, module-resolution errors, and client console logs land. **Check this first on a blank screen or red box** — it's faster than screenshots.
- `npx rn-iso prune` — remove entries for projects whose directory no longer exists (deleted worktrees), freeing their sims/emulators and ports, and killing any orphaned Metro. Live projects are never touched. Claims from deleted worktrees are also ignored automatically during device selection, so prune is housekeeping, not a prerequisite.
- `npx rn-iso worktree create|remove|list` — create/remove isolated git worktrees with carry-over and setup, or list them. See "Worktrees" above.
- `npx rn-iso gc [--delete] [--older-than <days>]` — report or reclaim disk space from orphaned build artifacts and dead project entries. See "gc" above.
- `npx rn-iso start [--reset-cache] [-- <extras...>]` — start Metro detached on the project's assigned port WITHOUT building/installing. `--reset-cache` clears Metro's transform cache. Other extras after `--` are forwarded to `expo start` / `react-native start`.
- `npx rn-iso stop [<port>|<shortcut>|<path>]` — kill Metro. No arg = current project. Passing a port (e.g. `8083`) kills whatever is on it; a project shortcut (label or unique basename) or absolute path targets that project. Finds the process by port, so it works whether Metro was started by `npx rn-iso start` or by the build CLI.
- `npx rn-iso release [<port>|<shortcut>|<path>] [--platform <p>] [--force]` — free a project's sim assignment. Defaults to the current project. Target can also be a Metro port (`8083`) or a shortcut (label / unique basename). If the assigned device is one rn-iso created, it is shut down and deleted (not just unassigned); a legacy or physical device assignment is only ever cleared, never deleted. For iOS sims, deletion is withheld (claim still cleared) if a UI-test runner is actively driving the sim, unless `--force` is passed; Android emulators have no occupancy probe, so an owned emulator is always deleted.
- `npx rn-iso shutdown [<shortcut>|<path>] [-y] [--keep-sims]` — kill Metro, shut down owned sims/emulators, and clear device assignments. Only shuts down devices rn-iso created (`owned: true`); a legacy or physical device assignment is left running and its skip is reported separately. An owned iOS sim currently driven by a foreign UI-test runner is likewise left running and reported as skipped (Android has no occupancy probe, so an owned emulator is always shut down). With no arg, scopes to **every** registered project (end-of-day reset); pass a project shortcut (label or unique basename) or absolute path to scope to one. Note this does NOT default to the current project (deliberate — `shutdown` is the explicit "tear it all down" command). Prompts unless `-y` / non-TTY; `--keep-sims` only kills Metro and clears assignments without touching the sims. Project entries themselves stay registered, so `metroPort` allocations and labels survive.
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
