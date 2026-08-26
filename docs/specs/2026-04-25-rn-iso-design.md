# rn-iso — design

Date: 2026-04-25
Status: draft

## Purpose

A CLI that lets you run multiple React Native / Expo projects (or worktrees of the same project) concurrently on one machine, each with its own Metro server and its own simulator/emulator, without manually juggling ports or device targets.

Primary motivator: AI coding agents working in parallel across multiple worktrees. Each agent — and any UI-driving skill it uses — should be able to "just work" against the right device without the user wiring it up by hand.

Secondary motivator: a human jumping between several projects locally, without colliding ports and without mental overhead about which sim is which.

## Non-goals (v1)

- **No shared-device mode and no mutex/lock.** With dedicated sims per project, contention disappears. If a user is on tight hardware and wants one shared sim, they can use `react-native-worktree` instead.
- **No build-cache shenanigans.** Trust `expo run:ios` / `react-native run-ios` and the underlying toolchain.
- **No automatic shutdown of simulators.** Manual via `prune --shutdown` or `shutdown`. Users frequently bounce between agents and don't want their sim killed out from under them.
- **No Expo Go support.** Custom dev clients only — Expo Go can't have its Metro target rewritten cleanly.
- **No concurrency limits / build-slot semaphore.** Add later if it proves to be a problem.

## User scenarios

### Scenario A — multi-agent, multiple worktrees

Janic spawns three Claude Code sessions in three worktrees of the same app. Each runs `rn-iso ios` once. Each gets:

- A unique Metro port (8082, 8083, 8084).
- A dedicated booted iOS simulator (different UDIDs).
- An installed copy of the app pointing to that worktree's port.

Each agent calls `rn-iso device` to learn its UDID and uses it for `agent-device` calls. No locking required; no agent disturbs another.

### Scenario B — solo multi-project switching

Janic works on app A in the morning and app B in the afternoon. Each project's first `rn-iso ios` invocation assigned it a sim. Going back to app A's directory and running `rn-iso ios` boots its sim if shut down and reuses everything else.

### Scenario C — agent working alongside human

Agent owns sim X on port 8083. Human runs the same app from a different worktree on sim Y, port 8084. They don't interact. No protocol required.

## Architecture

### Global config

Stored at `~/.rn-iso/config.json`. Keyed by absolute project path (resolved via `realpath` to handle symlinks consistently).

```json
{
  "version": 1,
  "projects": {
    "/Users/janic/Developer/myapp": {
      "bundleId": "com.myapp",
      "androidPackage": "com.myapp",
      "isExpo": true,
      "metroPort": 8082,
      "metroPid": 12345,
      "platforms": {
        "ios": {
          "deviceUdid": "A1B2C3D4-..."
        },
        "android": {
          "avdName": "Pixel_6_API_34",
          "consolePort": 5554
        }
      }
    },
    "/Users/janic/Developer/myapp-feat-auth": {
      "...": "..."
    }
  }
}
```

Notes:

- Single Metro per project, shared across iOS and Android (same as `react-native run-*` defaults).
- `metroPort` and `metroPid` live at the project level — one Metro serves both platforms.
- `metroPid` is recorded when Metro is started detached, used by `rn-iso stop` and `rn-iso logs`.
- The project path is the key — git worktrees produce different absolute paths, so they're naturally separate entries.
- Schema is versioned to allow forward migrations.

### Project detection

`rn-iso` resolves the "current project" by walking up from CWD until it finds a directory containing `package.json`. That directory is the canonical project root used as the config key.

Inside that root, detection determines:

- **Bare vs Expo:** presence of `expo` in `package.json` dependencies AND presence of `app.json` / `app.config.{js,ts}`. If both, treat as Expo.
- **Bundle ID / package name:** lifted from the existing `react-native-worktree` logic — checks `app.json` (`expo.ios.bundleIdentifier`, `expo.android.package`) and `app.config.{js,ts}` via regex.

### Port allocation

Same logic as `react-native-worktree`:

- On first assignment for a project, scan all ports in config across all projects, plus probe `localhost:<port>/status` to detect dead Metros.
- If a dead Metro port is found, reclaim it and remove the dead entry.
- Else assign `max(allPorts, 8081) + 1`.

Both platforms in the same project share one Metro port.

### Device assignment

Sticky and explicit. First `rn-iso ios` for a project picks a sim and writes it to config. Subsequent invocations reuse it.

**Selection algorithm (iOS):**

1. List booted sims via `xcrun simctl list devices booted -j`.
2. Compute "claimed" UDIDs from config (across all projects).
3. **Prefer reuse:** if config has a UDID for this project and it's bootable (exists in `simctl list devices`), use it. Boot it if not booted.
4. **Else allocate from booted-and-unclaimed:** pick the first booted sim that's not claimed by any project.
5. **Else prompt to boot a new one:**
   - Interactive: `xcrun simctl list devicetypes` → arrow-key picker; default to the most recently used iPhone runtime.
   - Non-interactive (`--auto` / `--device-type "iPhone 15 Pro"`): boot a fresh sim of that type, no prompt.
6. Boot it via `xcrun simctl boot <UDID>` and `open -a Simulator`.

**Selection algorithm (Android):**

1. List existing AVDs via `emulator -list-avds`.
2. List currently-running emulator console ports via `adb devices` (entries like `emulator-5554`).
3. Compute claimed AVDs and console ports from config.
4. Prefer reuse: if config has an AVD for this project, start it on its assigned console port if not running.
5. Else pick an unclaimed AVD; assign next free even console port starting at 5554.
6. Else prompt to create a new AVD (or fail with a helpful message — AVD creation is gnarly enough that v1 may just instruct the user to create one in Android Studio).

When booting Android: `emulator -avd <name> -port <consolePort>` (detached).

### App install

iOS:

- `expo run:ios --device <UDID> --port <PORT>` (Expo) or `react-native run-ios --simulator <name> --port <PORT>` (bare; note: bare RN takes a name, not UDID — translate via `simctl list`).
- These build, install, and launch.
- On reruns of `rn-iso ios` against the same project + sim, this is fast because the build is incremental.

Android:

- `expo run:android --device <serial> --port <PORT>` (Expo) or `react-native run-android --deviceId <serial>` (bare).
- After install, set up `adb -s <serial> reverse tcp:<PORT> tcp:<PORT>` so the emulator can reach Metro on the host.

### Metro management

`rn-iso ios` / `rn-iso android` ensure Metro is running on the project's assigned port:

- If a process is already responding to `/status` on that port, leave it alone.
- Else spawn detached: `npx expo start --port <PORT>` or `npx react-native start --port <PORT>`. Record PID in config. Pipe stdout/stderr to `~/.rn-iso/logs/<project-hash>-metro.log`.

`rn-iso start` is the standalone form: ensure Metro, do nothing else.
`rn-iso logs` tails the log file.
`rn-iso stop` kills Metro by PID.
`rn-iso status` shows per-project state.

### Cleanup

- `rn-iso release [--platform <p>]` — clear device assignment for the current project. Does not shut down the sim.
- `rn-iso shutdown [--platform <p>]` — `simctl shutdown <UDID>` / kill emulator process for the current project. Releases assignment.
- `rn-iso prune [--shutdown]` — scan config:
  - Drop projects whose path no longer exists.
  - Drop platform assignments whose UDID/AVD no longer exists.
  - With `--shutdown`: also shut down any sims/emulators referenced only by dropped entries.

## Command surface

```
rn-iso ios       [--device-type <name>] [--detach] [--auto]
rn-iso android   [--device-type <name>] [--detach] [--auto]
rn-iso start     [--detach]                                # metro only
rn-iso device    [--platform ios|android]                  # print UDID/serial; exit 0 if assigned, 1 if not
rn-iso status                                              # all projects, current project highlighted
rn-iso release   [--platform ios|android]                  # unbind device(s) for current project
rn-iso shutdown  [--platform ios|android]                  # release + shut down sim(s)
rn-iso prune     [--shutdown]                              # GC dead entries machine-wide
rn-iso logs      [--platform ios|android]                  # tail metro logs
rn-iso stop                                                # kill metro for current project
```

The "current project" is always the package.json root walking up from CWD. No flags to override.

## Platform specifics

### iOS

- Boot: `xcrun simctl boot <UDID>` (idempotent — errors if already booted; ignore "Booted" error).
- Install: `expo run:ios --device <UDID>` or equivalent.
- Launch: handled by run-ios. To relaunch later: `xcrun simctl terminate <UDID> <bundleId>` + `xcrun simctl launch <UDID> <bundleId>`.
- Port-on-existing-app trick (carried over from `react-native-worktree`):
  ```
  xcrun simctl spawn <UDID> defaults write <bundleId> RCT_jsLocation "localhost:<port>"
  ```
  Used when the user wants to repoint without rebuilding (rare in dedicated-sim mode but useful for "I changed Metro port" or "I moved this worktree's port to reclaim").

### Android (more involved than iOS)

- Each emulator instance occupies a console port (`-port <consolePort>`); ADB serial is `emulator-<consolePort>`.
- Reverse port mapping is per-device: `adb -s emulator-5554 reverse tcp:<MetroPort> tcp:<MetroPort>`.
- Boot is slow (10-30s); we should poll `adb -s <serial> shell getprop sys.boot_completed` until "1" before trying to install.
- Multiple instances of the same AVD are technically supported (`-port` differs), but each instance keeps a private system image overlay; clean disk usage matters. For v1, prefer one AVD per running instance.
- `debug_http_host` SharedPref trick (from `react-native-worktree`) is the equivalent of iOS `RCT_jsLocation` for repointing without rebuilding.

### Bare vs Expo dispatch

| Action      | Expo                                                | Bare                                                                                             |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Run iOS     | `npx expo run:ios --device <UDID> --port <P>`       | `npx react-native run-ios --simulator "<name>" --port <P>`                                       |
| Run Android | `npx expo run:android --device <serial> --port <P>` | `npx react-native run-android --deviceId <serial>` (bare RN takes port via `RCT_METRO_PORT` env) |
| Start Metro | `npx expo start --port <P>`                         | `npx react-native start --port <P>`                                                              |

Bare RN's `run-ios` takes a device _name_, not a UDID — we'll resolve UDID → name via `simctl list devices -j`. If multiple sims share a name (common), error out with "ambiguous; please rename one in the Simulator app."

## Agent integration

A skill (provisional name `rn-iso`) shipped with the CLI that teaches agents how to use it. Skill content covers:

- Run `rn-iso ios` (or android) from the project root before any device interaction.
- Use `rn-iso device --platform ios` to get the UDID, pass to `agent-device`'s `--device <UDID>` form (or whatever the platform-specific flag is).
- Pass `--auto --device-type "iPhone 15 Pro"` (or similar) for non-interactive runs.
- Always reuse — never call `release` or `shutdown` unless the user asks.

The skill installs the same way as `react-native-worktree`'s skill (`curl ... -o ~/.claude/skills/rn-iso/SKILL.md`).

`rn-iso device` is the single point of integration. Output format:

- Success: `<UDID>` (or `<emulator-serial>`) on stdout, exit 0.
- Not assigned: empty stdout, error message on stderr, exit 1.
- `--platform <p>` filters; default = ios.
- `--json` form returns `{ "platform": "ios", "udid": "...", "metroPort": 8083 }` for tooling.

## Failure modes & error handling

| Situation                                                           | Behavior                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| No `package.json` found walking up from CWD                         | Error: "Not in a React Native project (no package.json)"                                                           |
| Bundle ID undetectable                                              | Error: "Could not detect bundle ID; provide via `--bundle-id <id>`" (later — v1 requires app.json)                 |
| Assigned sim no longer exists                                       | Warn, drop assignment, run normal allocation                                                                       |
| Assigned sim exists but won't boot                                  | Error with the simctl message; don't auto-fall-through                                                             |
| Metro port collides with non-rn-iso process                         | Detect via probe; if `/status` doesn't return `packager-status:running`, error: "port X busy by non-Metro process" |
| Two instances of `rn-iso ios` for the same project run concurrently | File-based lock on the project's config entry during mutation. Race-window only during allocation.                 |
| Expo run hangs / fails                                              | Surface stderr; don't silently retry                                                                               |

## Testing strategy

- **Unit tests** for: config schema parsing/migration, port allocation, project root detection, bundle ID detection, device-pool selection algorithm (mocked simctl/adb output).
- **Integration tests** are hard for sim/emulator interactions and out of scope for v1; rely on manual verification on the developer's machine.
- Use `node --test` (same as `react-native-worktree` — no test framework deps).

## Implementation notes

- Language: JavaScript (ESM), no TS toolchain. Match `react-native-worktree`'s style for legibility / cross-pollination.
- Dependencies: `commander` (CLI), `chalk` (color), `prompts` or built-in readline (interactive picker). Prefer minimal deps.
- File layout:
  ```
  bin/cli.js
  src/
    commands/
      ios.js
      android.js
      start.js
      device.js
      status.js
      release.js
      shutdown.js
      prune.js
      logs.js
      stop.js
    config.js          # global config CRUD, project root detection, bundle ID detection
    ports.js           # port allocation + Metro probing
    sim/
      ios.js           # simctl wrappers + iOS device pool
      android.js       # adb/emulator wrappers + Android device pool
    metro.js           # detached spawn, log piping, PID lifecycle
    runner.js          # bare vs Expo dispatch
  test/
    *.test.js
  skill/
    SKILL.md
  ```

## Open questions

1. **Skill name.** `rn-iso` is fine for the CLI. The skill name visible to agents could be the same, or something more discoverable like `react-native-isolated-dev`. I'll default to `rn-iso` and we can rename later.
2. **Coexistence with `react-native-worktree`.** A user might have both installed. They don't conflict (different config dirs), but the skill descriptions might both trigger and confuse agents. The skill description should be specific enough that agents only invoke `rn-iso` when the user has set it up.
3. **Multi-app projects (one repo, multiple Expo apps via `expo prebuild --variant`).** Out of scope for v1. Treat each project path as a single app.
4. **Windows / Linux support.** macOS-first. Android-on-Linux is plausible later. iOS is mac-only by definition.
5. **Should `device --json` include the Metro port?** Yes for v1 — agents may want to verify Metro is up before kicking off a UI test.
6. **AVD creation in `rn-iso android` first-run.** Defer to user; instruct them to use Android Studio. Revisit if it's a common pain point.

## Future / later

- Build-slot semaphore (limit concurrent native builds).
- Auto-shutdown sim after N hours of inactivity (opt-in).
- Hot-rebind without rebuild via `RCT_jsLocation` / `debug_http_host` (the `react-native-worktree` trick) — exposed as `rn-iso rebind` for power users.
- TUI dashboard.
- Replace `commander` with a smaller arg parser if package size becomes a concern.
