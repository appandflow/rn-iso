---
name: rn-iso
description: Environment broker for isolated React Native / Expo dev environments. Each project (or worktree) gets its own owned simulator/emulator and Metro server, created on demand and reaped on release. Use to spin up a worktree, get a ready device + Metro, and discover which device to target for UI interactions -- rn-iso never runs your build.
user_invocable: true
---

# rn-iso -- Isolated RN Dev Environments

You are an AI agent working on a React Native / Expo project, possibly alongside other agents working on different projects or worktrees. rn-iso is a pure **environment broker**: it creates and owns a dedicated simulator/emulator and Metro server per project, and hands you the facts to build against. It never runs your build -- that's your job, using the project's own tooling.

Invoke the CLI via `npx`: `npx rn-iso <command>`. Don't `npm install -g`; `npx` resolves the latest published version.

## The env lifecycle

The primary agent flow, start to finish:

```bash
# 1. Create an isolated worktree (skip if you're already in one).
npx rn-iso worktree create feature-x

# 2. Ensure a ready device + Metro for the platform you're targeting.
npx rn-iso up ios --json
# => {"platform":"ios","owned":true,"udid":"ABC-...","deviceName":"rn-iso-feature-x",
#     "metroPort":8082,"metroPid":12345,"metroHealthy":true,
#     "metroLog":"~/.rn-iso/logs/<hash>.log","bundleId":"io.tlon.groups",
#     "setup":{"complete":true,"commands":[]}}

# 3. YOU run the project's own build, targeting the facts from step 2
#    (see "Common setups" below).
npx expo run:ios --device ABC-... --port 8082

# 4. Work: interact with the device, iterate, hot-reload.

# 5. When done, remove the worktree -- this also deletes the owned device(s).
npx rn-iso worktree remove <path>
```

`up` **creates the device if none exists yet** (an owned `rn-iso-<label>` sim/AVD), reuses it if one is already recorded, and always ensures Metro is running (managed -- detached, PID-tracked, logged; this is the only mode, there is no flag to opt out). It never installs an app and never invokes a build CLI. Reading `package.json` / the native project to decide how to build is your job, not rn-iso's -- you have that judgment natively from repo context; rn-iso only provisions the resources.

## The facts contract

- Always get your target device and port from `up --json` or `device --json` -- never hardcode or guess a UDID/serial/port.
- Always pass them **explicitly** to your build command and to any device-interaction tool (`agent-device`, `xcrun simctl`, `adb -s`, `idb`).
- Never assume `booted` is your sim, and never call a device verb without an explicit UDID/serial -- another project's simulator may also be booted.
- `metroHealthy` in the JSON is a live ping of Metro's `/status` endpoint. If it's `false` right after `up`, something is wrong -- check `metroLog` / run `rn-iso logs`.
- Android's JSON payload uses `serial` / `avdName` / `consolePort` / `kind` (`"emulator"` or `"physical"`) instead of `udid`. Android's `bundleId` field in the facts is the **Android package name**, not the iOS bundle id.
- `rn-iso device --platform <ios|android> --json` is a read-only, no-ensure/no-create re-check of the current assignment plus Metro state -- use it when you just need to confirm what's already assigned without touching devices or Metro. Its payload is a subset of `up --json`'s: it omits `owned`, `bundleId`, and `setup`, so use `up --json` (or `status`) when you need those fields.

## Common setups reference

`up` gives you a device and a port; you decide how to invoke the project's build. Use this table as a starting point and adapt to what's actually in the repo:

| Project shape | Build invocation |
|---|---|
| Expo (`expo run:ios` in scripts) | `<pm> ios -- --device <udid> --port <port>` or `npx expo run:ios --device <udid> --port <port>` |
| Bare RN | `npx react-native run-ios --udid <udid> --port <port>` (older CLIs: `--simulator "<name>"`) |
| Expo Android | `npx expo run:android --device <serial> --port <port>` (adb reverse already applied by `up`) |
| Bare RN Android | `npx react-native run-android --device <serial>` with `RCT_METRO_PORT=<port>` |
| Monorepo | run from the app directory (`apps/<app>`), not the repo root |
| Custom variants/flavors | prefer the project's own script (it bakes in the right flags); append device/port |

Both Expo and the RN CLI probe the target port and skip spawning a second bundler when Metro already answers `/status` -- this is what makes rn-iso's managed-only Metro safe to build against.

## Metro rules

- Metro is **always managed by rn-iso** (started by `up`, detached, PID-tracked, logged to a per-project file). Never start your own Metro server, and never pass a flag that makes the build CLI spawn its own bundler.
- Something looks wrong (blank screen, red box)? Read `npx rn-iso logs -n 50` **first** -- it's faster than screenshots and usually shows the actual bundling/resolution error.
- `npx rn-iso start` exists as the standalone "just Metro" command if you ever need it without a device action.

## Destructive-command rules

- **Never run `rn-iso gc --delete` without asking the user.** It can erase tens of gigabytes of build output. A bare `rn-iso gc` (no flag) only reports and is always safe.
- **Never pass `--force` to `rn-iso worktree remove` without asking the user.** A refusal means the worktree holds uncommitted changes, untracked files, or commits that exist on no remote; `--force` discards the uncommitted/untracked state permanently.
- **`release` now deletes the device.** If the assigned device is one rn-iso created (`owned: true`), `release` shuts it down AND deletes it -- not just a claim release. Don't release an environment you intend to keep using. Don't call `release` unless the user explicitly asks.
- **`worktree remove` deletes owned devices too.** The environment dies whole: removing a worktree also shuts down and deletes every owned sim/AVD registered under it (including nested monorepo app-dir projects). This is on top of the uncommitted/unpushed-work guard above -- expect it, and don't remove a worktree you (or the user) still need the device from.

## Capacity note

Owned devices are real resources: a booted iOS sim is roughly 1-2 GB of RAM, an Android emulator 2-3 GB. On a 16 GB machine, plan for **2-3 live environments** at a time, not more. There is no built-in concurrency limit -- `up` will happily create a fourth or fifth device and let the machine struggle. If you're spinning up several worktrees, `worktree remove` (or `release`) the ones you're done with before creating more.

## The physical-device exception

Hardware cannot be spawned. A physical Android device connected via `adb` is assigned by serial, the same way it always was -- it is the one exception to "every device rn-iso uses is one rn-iso created." `up`/`release`/`shutdown` never boot, shut down, or delete a physical device; they only assign/clear the serial. iOS has no equivalent (no physical-iOS support).

## When things go wrong

- **"No rn-iso entry for `<project>`"** -- run `npx rn-iso up ios` (or `up android`) first.
- **Failed to ensure device (Android)** -- usually a missing/misconfigured `JAVA_HOME` or `ANDROID_HOME`, or no arm64 system image installed (rn-iso never installs one for you; install with `sdkmanager "system-images;android-36;google_apis;arm64-v8a"` or similar, or pass `--system-image`).
- **No matching iOS device type / runtime installed** -- install one via Xcode, or pass `--device-type` / `--runtime` explicitly to `up`.
- **Blank screen / app installed but nothing renders** -- check `npx rn-iso status` for Metro state, then `npx rn-iso logs -n 50` for bundle/resolution errors (a stale `node_modules` after a branch switch is a classic -- reinstall deps, then `npx rn-iso stop` + `start`).
- **Metro port collision** -- `up`/`start` reclaim dead ports automatically. "port busy by non-Metro process" means another tool is using that port; close it.
- **A recorded device was deleted out from under rn-iso** (sim/AVD gone) -- `up` detects the stale record and creates a fresh owned device automatically.
- **"Refusing to remove `<path>`"** -- `rn-iso worktree remove` found uncommitted changes, untracked files, or commits not on any remote, and refused rather than risk losing work. Push the branch, or confirm `--force` with the user first (see "Destructive-command rules").
- **`gc` reports entries as "skipped"** -- directories/devices `gc` could NOT prove are dead: the workspace lives on an unmounted volume, or a device is currently occupied by a foreign tool (e.g. a UI-test runner). Skipped is a safety outcome, not an error -- `gc` fails closed rather than guessing.
- **If `rn-iso worktree list` shows "setup incomplete"**, or `rn-iso status` warns about it, the worktree's setup pipeline (e.g. `npm install`) failed when the worktree was created. Read the recorded failing command and re-run it directly rather than guessing why the build breaks.

## Worktrees

**Prefer `npx rn-iso worktree create` over a raw `git worktree add`.** `create` performs carry-over of gitignored files (like `.env`), runs the project's setup pipeline (install, etc.), and sets the label that stops monorepo shortcut collisions (every worktree of a monorepo shares the same app-dir basename, e.g. `tlon-mobile`, so without the label their `rn-iso` shortcuts collide). A raw `git worktree add` skips all three, leaving a worktree that looks fine but has no `node_modules`, no `.env`, and a shortcut that fights its siblings.

```bash
npx rn-iso worktree create <name> [--base fresh|head] [--no-install] [--label <label>]
npx rn-iso worktree remove <path> [--force]
npx rn-iso worktree list
```

- **`create <name>`** -- makes a sibling worktree (next to the repo, not inside it -- see the README for why), branches it as `worktree-<name>` from `origin/HEAD` (`--base fresh`, the default) or the current `HEAD` (`--base head`), carries over any gitignored files matched by `.worktreeinclude` (or the `worktree.include` setting), then runs the install pipeline (`--no-install` skips it). **Prints only the worktree's absolute path to stdout** -- everything else goes to stderr, and the command exits 0 even if setup failed, so it's safe to wire into automation (see the README's `WorktreeCreate` hook example). If setup fails or is skipped, the worktree is still created and usable; `rn-iso up` will warn about it later via the facts payload's `setup` field.
- **`remove <path>`** -- reclaims the worktree's build artifacts, Metro port, and (nested app-dir projects included) every owned sim/AVD registered under it: an owned device is shut down and deleted, not just unassigned, since the environment dies whole. A legacy or physical device assignment is only ever cleared, never deleted. An owned iOS sim actively driven by a foreign UI-test runner is left running (its claim is dropped and it's reported as skipped, "left for gc") so `gc` can catch it later. Refuses (exit 1) if the worktree has uncommitted changes, untracked files, or commits not on any remote -- see "Destructive-command rules" above. Also refuses if `<path>` is the main checkout or not a worktree of the current repo at all.
- **`list`** -- lists this repo's worktrees with a per-worktree setup status: `setup ok`, `setup incomplete`, or `unmanaged` (created outside `rn-iso worktree create`, e.g. by raw `git worktree add`).

## gc -- reclaiming disk space and orphaned devices

`npx rn-iso gc [--delete] [--older-than <days>]` finds Xcode DerivedData directories left behind by deleted worktrees, dead `rn-iso` project entries, AND orphaned `rn-iso-*` devices (sims/AVDs not referenced by any live config entry), and reports what reclaiming them would free.

**`gc` with no flag only reports -- it never deletes anything.** Pass `--delete` to actually remove the reported directories, entries, and devices (see the destructive-command rule above -- always ask before running it with `--delete`). It isn't the only destructive command in the tool -- `release` (deletes owned devices) and `worktree remove --force` (discards uncommitted/untracked work) are destructive too; see the destructive-command rules above for all three. `--older-than <days>` narrows the artifact report to directories not accessed recently.

The report has four buckets:
- **Orphaned build artifacts** -- DerivedData whose workspace path no longer exists. Deleted (with sizes) under `--delete`.
- **Dead project entries** -- `rn-iso` config entries whose project directory no longer exists. Pruned under `--delete` (same as `rn-iso prune`).
- **Orphaned devices** -- `rn-iso-*` sims/AVDs no live config entry references. Shut down and deleted under `--delete`; an occupied iOS sim is left running and reported instead.
- **Skipped** -- entries `gc` could NOT prove are dead (unmounted volume, unreadable metadata, or a device sweep that timed out after 10s against a wedged simulator/emulator daemon). Never deleted, even under `--delete`.

## Other useful commands

- `npx rn-iso status` -- show all projects, their owned/legacy device assignments (tagged `(owned)`), setup status, and Metro state.
- `npx rn-iso logs [<port>|<shortcut>|<path>] [-n <lines>] [--follow]` -- print the managed Metro log (default: last 50 lines of the current project's). This is where bundle progress, module-resolution errors, and client console logs land. **Check this first on a blank screen or red box** -- it's faster than screenshots.
- `npx rn-iso prune` -- remove entries for projects whose directory no longer exists (deleted worktrees), freeing their ports and killing any orphaned Metro. Live projects are never touched. Does not delete devices or build artifacts; see `gc` for both.
- `npx rn-iso start [--reset-cache] [-- <extras...>]` -- start Metro detached on the project's assigned port WITHOUT ensuring a device. `--reset-cache` clears Metro's transform cache. Other extras after `--` are forwarded to `expo start` / `react-native start`.
- `npx rn-iso stop [<port>|<shortcut>|<path>]` -- kill Metro. No arg = current project. Passing a port (e.g. `8083`) kills whatever is on it; a project shortcut (label or unique basename) or absolute path targets that project.
- `npx rn-iso release [<port>|<shortcut>|<path>] [--platform <p>] [--force]` -- free a project's device assignment. Defaults to the current project. See "Destructive-command rules" above -- this deletes owned devices.
- `npx rn-iso shutdown [<shortcut>|<path>] [-y] [--keep-sims]` -- kill Metro and shut down (never delete) owned sims/emulators. Owned device records stay recorded (the device still exists and is still ours, so `up` can boot it back up); legacy or physical device assignments are cleared instead, since rn-iso doesn't control those devices' lifecycle. An owned device is left running and reported as skipped if it's currently occupied by a foreign UI-test runner. Only touches devices rn-iso created (`owned: true`). With no arg, scopes to **every** registered project (end-of-day reset); pass a project shortcut or absolute path to scope to one. Prompts unless `-y` / non-TTY; `--keep-sims` only kills Metro without touching devices or assignments.
- `npx rn-iso config [<key> [<value>]] [--unset] [--project <target>] [--repo]` -- persist settings. Project-layer allowed keys: `packageManager` (npm|yarn|pnpm|bun), `ios.deviceType`, `ios.runtime`, `android.systemImage`. With `--repo`, additionally accepts `worktreeDir` and any `worktree.*` key. Resolution order for `up`: CLI flag (`--device-type`/`--runtime`/`--system-image`) > stored setting > rn-iso's own default (newest iPhone, base model, on newest installed runtime; newest installed arm64 system image).

### Project shortcuts (--label)

Every project has a "shortcut" you can pass to `stop` / `release` / `logs` / `config --project` instead of the full path: the project's `label` if set, else inherited from the enclosing worktree's label, else the directory basename. Set one explicitly on worktree creation:

```bash
npx rn-iso worktree create feature-x --label agent-1
npx rn-iso stop agent-1
npx rn-iso release agent-1
```

Shortcut collisions (two projects sharing the same basename with no distinguishing label) error out and list the candidates so you can disambiguate with the absolute path.

## Differences from `react-native-worktree`

`react-native-worktree` shares one simulator across worktrees with a mutex. `rn-iso` gives each environment its own owned, disposable simulator/emulator -- no locking, no contention, and it's destroyed with the environment. If both are installed, prefer `rn-iso` unless the user explicitly asks for the shared-sim model.
