# stim-cli

[![CI](https://github.com/appandflow/stim/actions/workflows/ci.yml/badge.svg)](https://github.com/appandflow/stim/actions/workflows/ci.yml)

The React Native / Expo CLI for AI agents. One isolated dev environment per project or worktree: `stim start` runs the dev server on a reserved, collision-free Metro port under a detached supervisor; `stim ios` / `stim android` boot a dedicated, **owned** simulator/emulator, install a build from a shared fingerprint cache when nothing native changed, and launch the app wired to that port; `stim logs --errors` answers "did that work" from a captured timeline instead of a scraped terminal. Multiple worktrees or coding agents can each get their own environment and build the same app in parallel without port or device collisions.

It never prompts, prints on the order of ten lines, takes `--json` everywhere, and reports a failing build as the _extracted_ compiler diagnostic plus a log path rather than four thousand lines of transcript.

> **Experimental.** APIs, flags, and on-disk state may change. File issues if anything breaks.

## Why this exists

Coding agents are moving to the cloud, and React Native is one of the places
that goes badly. A cloud agent needs macOS, a matching Xcode, a booted
simulator, a signing identity, and every MCP server re-authenticated -- on
runners that cost several times a Linux box and lag Xcode releases by months.
Physical devices are simply out of reach.

Locally, none of that is a problem. The environment is already set up, the
Mac is already paid for, simulators work, you are already logged into
everything, and the agent harness already provides the isolation that a cloud
sandbox is there to provide.

What breaks locally is that agents share one machine. Two of them reach for
port 8081, or the same booted simulator, and both end up talking to the wrong
bundler -- silently, because nothing tells you a build attached to somebody
else's Metro. When an agent is killed mid-run it leaves a simulator booted, a
Metro squatting on a port, and an `xcodebuild` test runner pinning a device
nothing can now delete.

That is the first job of this tool: arbitrate the contended resources, and
reclaim them when the agent that owned them dies badly. The second is the dev
server, which every agent otherwise backgrounds by hand and then scrapes a log
file for: `start` runs it on the reserved port and captures its output as
structured records, so `logs --errors` replaces the scraping. What stays out is
the build -- which command, which flags, when to install -- because that is
judgment a coding agent already has from reading the repo, and stim-cli
deliberately does not take it back.

### Where local honestly loses

- **CPU and memory are finite.** Two or three live environments on a 16 GB
  machine, not ten. Cloud wins this outright.
- **Paths are not stable.** CI checks out to the same path every run, so
  path-keyed caches (ccache, Xcode's compilation cache, a CocoaPods sandbox)
  just work. Locally every worktree sits somewhere different, and those caches
  quietly miss everything -- measured on one project as 0 ccache hits out of
  1094 across two workspaces. It is fixable, but it is a tax cloud does not pay.
- **Disk grows without bound.** Simulators and the shared caches that make any
  of this fast all accumulate. `gc` exists for that reason.

The registry lives in `~/.stim-cli/config.json`, keyed by absolute project path, and each project's runtime state lives under `$STIM_CLI_HOME/workspaces/<readable-name>--<16hex-path-digest>/`. Worktrees count as separate projects. There is no shared mutex -- each project gets its own port and its own device.

## Quick start

The package exports only `stim`. Run it without installing, or install it once:

```bash
npx stim-cli <command>
npm install --global stim-cli
```

Later examples use `stim`. If it is not installed globally, replace `stim`
with the `npx` form above.

```bash
stim start             # dev server on a reserved port, under a supervisor
stim ios               # owned sim booted, app installed and launched on it
stim logs --errors     # no output + exit 0 = nothing is broken
stim stop              # supervisor down, sim shut down, port freed
```

```
$ stim start
OK: dev server on port 8082, supervisor pid 41233 (expo-child) (6s)

$ stim ios
device      stim-cli-myproject (BF2A..) booted (9s)
fingerprint a3f9b1.. hit (2s)
install     from cache (3s)
launch      com.example.app (1s)
OK: com.example.app launched on BF2A..
```

The order is not optional: `ios` / `android` never start the bundler, so with nothing holding the reserved port they refuse in about a second with `STIM_CLI_NO_METRO` instead of spending four minutes building an app that cannot load a bundle.

Each command takes `--json` and then prints exactly one line of JSON on stdout, with every other line on stderr:

```json
{
  "platform": "ios",
  "udid": "BF2A-...",
  "deviceName": "stim-cli-myproject",
  "fingerprint": "a3f9b1...",
  "cacheKey": "...",
  "cacheHit": "local",
  "cacheSkipped": false,
  "compilationCache": { "status": "not-run", "hits": null, "cacheableTasks": null, "hitRatePercent": null },
  "appPath": "/...",
  "bundleId": "com.example.app",
  "launched": true,
  "metroPort": 8082,
  "logs": { "dir": "~/.stim-cli/workspaces/my-app--<16hex-path-digest>/logs" },
  "durationMs": 9412
}
```

`cacheHit` is a LEVEL, not a boolean: `"local"` (this machine's shared cache), `"remote"` (the project's own Expo `buildCacheProvider`, whose artifact is copied into the local cache on the way past) or `false` (it was compiled). `cacheSkipped` is true only when `--no-build-cache` was passed, which is "nothing was looked up" rather than "nothing was found".

`compilationCache` reports Xcode's compilation-cache summary when Xcode builds the app. Its status is `"not-run"` when the artifact cache supplies the app. Its status is `"unavailable"` when Xcode does not report reliable statistics.

In a different worktree of the same app, the same two commands get a _different_ owned sim and Metro port, so both run side by side.

## No project changes required

**stim-cli runs on a clean checkout of somebody else's repo.** That is a design
constraint, not a coincidence: evaluating it must not cost a PR. The
performance caches that used to be setup steps ride on the command lines
stim-cli composes itself.

| Cache                   | How stim-cli supplies it                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Xcode compilation cache | `COMPILATION_CACHE_ENABLE_CACHING`, a shared `COMPILATION_CACHE_CAS_PATH`, `SWIFT_ENABLE_COMPILE_CACHE=NO` and a `CLANG_OTHER_PREFIX_MAPPINGS` entry mapping this workspace's root, all as build-setting overrides on stim-cli's own `xcodebuild` argv -- so no Podfile `post_install` block. Xcode 26+ only (older Xcode ignores them, so they are not added), and skipped when the project configured ccache, which defeats it. |
| Gradle build cache      | `--build-cache` on stim-cli's own `gradlew` argv -- so no `org.gradle.caching=true` in a committed `gradle.properties`. The cache directory is under the Gradle user home, already shared by every worktree.                                                                                                                                                                                                                      |
| Metro transform cache   | A `FileStore` **appended** to the dev server `start` hosts -- in-process on bare React Native, and through Expo's config override on SDK 54+. The adapter composes the project's existing Metro config and stores, then reports from inside the child when the store is loaded. Expo SDK 53 and older run normally without stim-cli's shared transform store; that is only a cold-bundle performance regression.                  |

Each prints one dim line when it applies, so none of it is invisible. The
Metro injection has a machine-level kill switch --
`{ "caches": { "injectMetroStore": false } }` in `~/.stim-cli/config.json`,
which is a machine setting rather than a repo change on purpose.

Runtime state is kept outside the project tree, under
`$STIM_CLI_HOME/workspaces/<readable-project-slug>--<16hex-path-digest>/` (by
default `~/.stim-cli/workspaces/...`). Its `workspace.json` records the
canonical absolute project root. No project-side directory or `.gitignore`
change is needed.

### What `doctor` is for, then

```bash
stim doctor
```

**It reports what stim-cli cannot fix for itself.** The mere absence of a
project-side cache setting is not a finding at all -- stim-cli supplies the Metro
store, the compilation cache and the Gradle build cache on its own command
lines, so a repo that configures none of them is clean here. What it does
report is active misconfiguration: a missing `expo-dev-client` (a reserved port
cannot reach the app without it), ccache (the one thing that stops stim-cli
adding its compilation cache), a checkout that does not fingerprint like a
fresh worktree (every worktree then misses the build cache), a
`buildCacheProvider` on a key this SDK ignores, an EAS session that cannot
answer -- plus the settings that are wired in a way that defeats the builds
you make OUTSIDE stim-cli (a `cacheStores` behind an env-var flag, a compilation
CAS left at the per-workspace default). A clean run means there is nothing
stim-cli needs from this repo.

There is no `stim init`, and no setup skill either. There is no longer a
setup playbook to follow: what little a repo can get wrong is reported by
`doctor` at the moment it matters, and the edit it names lands in a file the
project already owns -- a `metro.config.js` with its own transformer, a
`Podfile` with existing `post_install` logic, an app config that may be
TypeScript -- which is judgement, not templating.

For AI coding agents, install the bundled skill so the agent knows how to drive the CLI (the lifecycle, the facts contract, and the destructive-command rules). It installs with the skills CLI, straight from GitHub:

```bash
npx skills add appandflow/stim
```

[Getting started](https://appandflow.github.io/stim/docs/getting-started) is the whole human-side setup: install the skill, then describe what you want built.

## Owned devices

Every simulator or emulator stim-cli uses is one **stim-cli created**, named `stim-cli-<label>`, and recorded with `owned: true`. stim-cli never boots, allocates, or destroys a device it did not create -- it cannot stomp a foreign tool's simulator, because it never touches devices it didn't make. Teardown of the owning project (`worktree remove`, or `gc` on an orphan) destroys the device, not just a claim on it.

That rule has **no exception**. stim-cli has no physical-device support: there is no code path that boots, installs onto, or even probes hardware.

This is a change from earlier versions, where stim-cli picked an existing, unclaimed simulator from the pool instead of creating one. That model existed to avoid accumulating junk simulators -- but the accumulation was really a symptom of creation _without_ a reaper. The reaper now exists, so creating a device and guaranteeing its eventual destruction is no longer the same hazard.

## Destruction lives in exactly two commands

`worktree remove` destroys the workspace you name; `gc --delete` sweeps the machine. **Nothing else deletes anything.**

The one workspace `worktree remove` never destroys is the main checkout: git cannot remove the main working tree, and deleting the source tree is not what anyone meant. There -- and only there -- it reclaims the environment instead: the owned devices are deleted, the Metro port freed, the registry entries (including nested monorepo app dirs) dropped, and the global workspace directories removed, while the tree itself stays exactly as it was. Because no source files are deleted, the dirty-tree and unpushed-work guards do not apply on that path. A registered project directory that is not a git repo at all gets the same environment reclaim.

In particular `stop` does not, by design: it shuts the owned device down and leaves it assigned, so returning to a branch costs a boot rather than a create, a provision and a reinstall. There is no `--delete` on it, because an agent reaching for `stop` to reclaim memory must not have one within reach of a typo. Destruction lives in `worktree remove` and `gc`, never here.

Device teardown is not occupancy-guarded. An explicit `stop`, `worktree remove`, or `gc --delete` shuts down the Stim-owned device even if another tool still uses it. These commands never shut down an unowned device.

If a delete fails, the failure is reported, the config record is **kept** so the device stays tracked, and the command exits 1. Dropping the record on a failed teardown is exactly what turns it into a simulator nothing references.

## Commands

| Command                                                                                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start [--json] [--wait <seconds>]`                                                                            | Start this workspace's dev server on the reserved port under a detached supervisor, and block until it answers _and_ verifies as this project's (default 60s). Idempotent: a healthy dev server on the port is a no-op. Bare RN is hosted in-process with stim-cli's NDJSON reporter; Expo runs the project's own `expo start --port <n>` as a child. Structured logs land in `$STIM_CLI_HOME/workspaces/<project>--<digest>/logs`. A failure under `--json` still puts one line on stdout: the `{code, message, remedy}` contract (`STIM_CLI_METRO_TIMEOUT`, `STIM_CLI_SUPERVISOR_EXITED`, ...).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `logs [--source <s...>] [--level <l>] [--since <d>] [--grep <re>] [--tail <n>] [--errors] [--follow] [--json]` | Query the merged NDJSON timeline in `$STIM_CLI_HOME/workspaces/<project>--<digest>/logs`. Prints and exits; nothing matching is a successful, empty result (exit 0). `--errors` is the agent-loop query: errors and fatals since the last marker. `--follow` streams.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ios [--json] [--no-metro-check] [--no-build-cache] [--configuration <name>]`                                  | Boot this workspace's owned simulator, verify the reserved port holds _this project's_ dev server, fingerprint the native inputs, install the cached `.app` if that fingerprint has one (otherwise prebuild / `pod install` / `xcodebuild` and store the result), install, launch wired to the reserved port, and attach a device-log collector. After installing an Expo dev client, it preapproves exactly that app's bundle id and discovered scheme for CoreSimulatorBridge, suppressing iOS's first-launch confirmation without approving unrelated apps or schemes. Refuses with `STIM_CLI_NO_METRO` in about a second when nothing holds the port; `--no-metro-check` overrides. On an Expo project a local miss also asks the provider the project already configured (`expo.buildCacheProvider`), time-bounded, and a hit is stored locally on the way past. `--no-build-cache` looks nothing up and builds fresh -- it still stores (replacing the entry) and still uploads. `--configuration Release` (or the `ios.configuration` setting) builds a simulator Release app with the JS embedded: Metro is skipped entirely (`metroPort: null`, plain launch, process-alive verification), the cache keys `-release-sim`, and a cache hit regenerates this workspace's JS with the project's own bundler + hermesc into a copy of the cached .app, re-signs and installs that -- a failed swap falls back to a full build. Simulator only. |
| `android [--json] [--no-metro-check] [--no-build-cache] [--variant <name>]`                                    | The same over `gradlew assembleDebug` and `adb`, on this workspace's owned emulator, with `adb reverse tcp:8081 tcp:<port>` doing the port wiring. On a project with product flavors, `--variant productionDebug` (or the `android.variant` setting, which the flag overrides) runs `assembleProductionDebug`, finds the APK in `apk/production/debug/` and keys the build cache on the variant; the launched applicationId is always read from the built APK's manifest. A variant whose name **ends in `Release`** is a release build -- no second flag: the JS is embedded, so Metro is skipped entirely (`metroPort: null`, no `adb reverse`, no dev-client deep link, a plain `am start`, and `launched` proven by the app process being alive on the device). A release cache hit re-packs the cached APK -- copy aside, regenerate the bundle with the project's own tools + hermesc, `zip -0` it back in (stored, because the runtime mmaps it), zipalign, then `apksigner` with `android/app/debug.keystore` (override via `android.keystore` / `android.keystorePassword`). An **asset gate** compares the freshly emitted assets against the ones the APK carries and falls back to a full build on any difference, and a signer conflict from a CI-signed copy uninstalls the package once and retries. Local emulator installs only.                                                                                                   |
| `stop [--force] [--json]`                                                                                      | The inverse of `start`: halt this workspace's supervisor, reap its device-log collectors, shut the owned device **down** (never deleted, so it stays assigned), and free the reserved port. Non-destructive and takes no target -- it acts on the current workspace. With no supervisor recorded it falls back to killing an identity-verified Metro on the reserved port; `--force` is only for an unproven listener there. Already-stopped is a success at every step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `status [--json]`                                                                                              | Show every registered project (machine-wide by default; there is no `--all`): device assignments, Metro state, supervisor pid / mode / health, last build (fingerprint, cache hit, duration), log directory and error count since the last marker, plus machine capacity and free disk on the boot, STIM_CLI_HOME and current-project volumes when distinct.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `gc [--delete] [--older-than <days>] [--all]`                                                                  | Report what stim-cli has left behind: entries for projects whose directory no longer exists, orphaned `stim-cli-*` devices, records naming a device that is no longer on the machine, and every shared build cache with its size. Orphaned and stale owned Android AVD rows include their on-disk size when the AVD content directory can be read. Reports and writes nothing by default; `--delete` reclaims the dead entries (freeing their Metro ports), reaps the orphaned devices, and clears the stale device records (the record only -- there is no device left to touch, so it issues no simctl/avdmanager command). `--older-than <days>` additionally reaps owned devices whose _project_ has gone untouched that long, and trims cache entries nothing has used in that time. `--all` (with `--delete`) empties the caches whole -- see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `doctor [--json]`                                                                                              | Report what stim-cli cannot handle on its own. The ABSENCE of a project-side cache setting is not a finding -- stim-cli supplies the Metro store (bare React Native and Expo SDK 54+), the Xcode compilation cache and the Gradle build cache on its own command lines. What it reports is active misconfiguration: a missing dev client, ccache (which is what stops stim-cli adding its own compilation cache), a `cacheStores` wired behind a conditional so it is off in the case that matters, a compilation CAS left at the per-workspace default, a configured build-cache provider on the key this SDK ignores, an EAS session that cannot answer, and -- last, because it computes a real fingerprint twice via a temporary worktree of HEAD (removed again) -- a checkout that does not fingerprint like a fresh worktree. A clean run means nothing stim-cli cannot handle itself. Read-only, and always exits 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `worktree create <name> [--base <ref>] [--label <name>] [--carry-ignored]`                                     | Create an isolated git worktree: carries over gitignored files, prints the worktree path (and, on stderr, what it branched from -- ref and short sha). `--base` takes `head` (the current checkout's HEAD and the default), `fresh` (origin/HEAD), or any ref `git rev-parse` resolves; an unresolvable one is refused before anything is created. Does not install dependencies unless `--carry-ignored` clones the source's working state: its gitignored paths (node_modules, Pods, build output) plus its uncommitted tracked changes, applied when they fit the base and reported when they do not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `worktree remove [<path>] [--force]`                                                                           | Remove a worktree, reclaiming its global build artifacts, Metro port, and owned devices (deleted, not just freed). It also removes the branch that Stim created when the branch has no unique commits; attached branches and branches with unique commits remain. Defaults to the current workspace. Refuses if it has uncommitted or unpushed work unless `--force`, naming the right restore command per class (`git checkout --` for modified tracked files, `git clean -fd` for untracked ones). Current stim-cli state never dirties the project. On the main checkout it reclaims the environment only and never touches source files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `guide [topic]`                                                                                                | Print reference docs for the installed version (topics: facts, metro, logs, errors, lifecycle, cleanup, settings). Generated by the binary, so it cannot drift.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## How it works

- **Config** at `~/.stim-cli/config.json`, keyed by absolute project path. Symlinked worktrees collapse via `realpath`. Every write goes through a lockfile and lands by atomic rename, so several agents provisioning at once cannot lose each other's device records. A config that will not parse is reported by name and never reset automatically -- it holds the records of every device stim-cli owns, and resetting it would orphan all of them.
- **Port allocation:** `start` scans upward from 8082 for a port that is both unclaimed in the registry and actually free on the machine, reclaiming ports from dead projects on the way. Claiming is race-safe: the write only lands if the config still shows the port unclaimed, so two parallel runs that probe the same free port cannot both take it. A project whose directory only _looks_ gone because its volume is unmounted keeps its port.
- **Owned device creation:** on iOS, `ios` creates the newest iPhone device type -- highest generation number, base model rather than Pro/Pro Max -- on the newest installed runtime by default (or reuses the project's already-recorded owned sim, booting it if shut down). An optional `ios.simslimProfile` applies a committed [SimSlim](https://github.com/MobAI-App/simslim) profile to each Stim-owned local simulator. On Android, it creates an AVD via `avdmanager create avd` against the newest installed arm64 system image (stim-cli never installs system images itself -- it errors with install instructions if none is found). New owned AVDs get an 8 GiB data partition, retaining headroom for repeated installs while capping userdata growth below the 10 GiB setting measured on the selected API 36 profile. Owned AVDs always cold-boot: the emulator neither loads nor saves a Quick Boot snapshot, avoiding a large snapshot for a disposable device at the cost of a slower restart after `stop`. Override the device defaults with `ios.deviceType` / `ios.runtime` / `android.systemImage` / `android.dataPartitionSizeGb`; use `android.avdConfigFile` or `android.avdConfig` for supported native AVD hardware settings -- see "Settings" below.
- **Runtime output is externalized.** Logs, state, pidfiles and Xcode DerivedData live under the global workspace directory, so `worktree remove` can reclaim them without project-tree state. Gradle still uses its normal project build directories; `--build-cache` points task caching at the shared Gradle user home.
- **The port is never baked into a build.** The fingerprint cache shares binaries across workspaces, so a port compiled in would let a binary built for 8082 be served to a workspace holding 8083. iOS gets `RCT_jsLocation` written into the app's simulator defaults (or an `expo-development-client` deep link). For a dev-client link, stim-cli also writes CoreSimulatorBridge approval entries for exactly that installed bundle id and scheme through the booted owned simulator's `defaults`; an unrelated scheme remains unapproved. Android gets `adb reverse tcp:8081 tcp:<port>`. `RCT_METRO_PORT` is deliberately not passed to builds.
- **Starting the bundler yourself still works.** Both Expo and the RN CLI probe the port and skip spawning a second bundler when one already answers `/status`, and `ios`'s Metro gate accepts a server you started as long as it runs from inside the project -- but nothing is captured that way, so `stim logs` stays empty. Teardown (`stop`, `worktree remove`, `gc`) finds Metro by port via `lsof` and only kills it after confirming it answers `/status` **and** runs from inside the project: a port is not identity, so an unidentified listener is reported instead of killed.

If you need a single shared sim with a mutex instead of one owned device per project, see [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree).

## The dev server and logs

`stim start` runs the dev server for you, on the port it reserves for this workspace, under a **detached per-workspace supervisor**. It blocks until the server both answers and verifies as this project's (the same identity check teardown uses, never a bare port probe), then exits leaving it running:

```bash
stim start --json
# {"port":8082,"supervisorPid":41233,"mode":"bare-inproc","logsDir":"/Users/me/.stim-cli/workspaces/my-app--0123456789abcdef/logs","alreadyRunning":false}
```

It has two flags and will not grow more: `--json` and `--wait <seconds>` (default 60). Anything a project needs beyond that belongs in its own bundler command. Running `start` twice leaves one supervisor -- a healthy dev server on the port is a no-op, including one you started yourself, which is reported with `supervisorPid: null` and left alone rather than fought over.

There is no machine-wide daemon: one supervisor process per workspace, recorded in the global workspace `state.json` and in the registry before it starts serving, and gone (with its records) on any exit path. Two modes:

- **`bare-inproc`** -- bare React Native: Metro is hosted _inside_ the supervisor, loaded from the project's own `node_modules`, with `@stim-cli/metro`'s NDJSON reporter attached. Bundler events, in-app `console.log` and redboxes all arrive structured. Hosting is the only way to get them: both CLIs overwrite `config.reporter` after loading `metro.config.js`, so a reporter wired in there is discarded.
- **`expo-child`** -- Expo: the project's own `expo start --port <n>` runs as a child and its stdout is parsed into the same records. Expo's dev server is protocol-bearing (manifest, dev-client and expo-router middleware), so reimplementing it would be forking Expo; the cost is that levels are _inferred_ from each line, which those records mark with `raw: true`.

Everything lands as one JSON object per line under the global workspace `logs/` directory, and `stim logs` queries the files merged into one timeline:

```bash
stim logs --errors            # errors since the last marker; empty + exit 0 = healthy
stim logs --source client --since 5m --grep 'Profile'
stim logs --follow --level warn
stim logs --errors --json     # raw records, so stdout is valid NDJSON
```

**Nothing matching is exit 0.** `logs --errors` returning nothing is the pass condition of a build loop, so an empty result must never read as a failure; the only exit-1 paths are a malformed query and no project. `--errors` means level `error` or `fatal` strictly after the most recent record carrying `marker: true`, and the marker is searched across every source, so a marker in one file closes the window for all of them. Markers are written when a bundle build finishes -- which is what stops an error you already fixed from being reported forever. `stim status` reports the same count per workspace.

The record is `{ ts, src, level, msg }` plus optional `event`, `stack`, `marker` and `raw`. `src` is one of `metro`, `client`, `device`, `build`: the supervisor writes `metro` (both modes) and `client` (bare only -- in `expo-child` mode Expo's client output arrives on the bundler stream), and `ios` / `android` write `build` (the transcript at level debug, the extracted diagnostics at level error) and `device` (via the `simctl log stream` / `logcat` collector they attach after launch). `logs/supervisor.log` is deliberately _not_ part of the timeline: it is the supervisor's raw stdio, and it is what `start` quotes when a supervisor dies before it can write a structured record. `logs/emulator.log` is outside the timeline for the same reason: it is the Android emulator's raw stdio, truncated on each boot, and it is what `android` quotes when a boot fails.

`stim stop` is the inverse: it halts the supervisor (identity-verified: a pid is only signalled when it is alive, recorded for this workspace, and holding the port this project reserved), SIGTERMs the device-log collectors recorded in the same `state.json`, shuts the owned device down without deleting it, and frees the port. It never escalates to `SIGKILL` -- a supervisor mid-write on the log files is exactly what `SIGTERM` handling exists to finish -- so a supervisor that will not exit is reported with its pid instead.

## Device settings

The device model, runtime and system image can be pinned per project so stim-cli's defaults are not what you get. There is no `stim config` command -- stim-cli's commands take no device flags, so settings are **files**. See "Settings" below for the layers; the one that travels with the repo is `.stim-cli.json` at its root:

```json
{
  "ios": { "deviceType": "iPhone 17 Pro", "runtime": "26.2" },
  "android": { "systemImage": "system-images;android-36;google_apis;arm64-v8a" }
}
```

Resolution order: the project layer, then the repo layer, then that committed file, then stim-cli's own default (newest iPhone, base model, on the newest installed runtime; newest installed arm64 system image). A pinned model is honoured on **reuse** as well as on creation: an existing owned sim of a different model is refused rather than silently booted.

## Shared build caches

Everything `gc` reclaims is _dead_: a project entry whose directory no longer
exists belongs to nobody, and a `stim-cli-*` simulator nothing references is
never coming back. Shared build caches are the opposite -- alive by design and
shared by projects on the machine:

- **Metro's `FileStore`** has no eviction logic whatsoever.
- **Xcode's compilation cache** has no size cap.
- **Gradle's build cache** applies Gradle's own retention policy and is shared by
  every Gradle build under the Gradle user home, including builds that did not
  use stim-cli. stim-cli reports it but never deletes from it.
- **Metro file maps** accumulate one file per project root ever served.

So every `gc` run reports them -- in their own bucket, tagged _registered_ or
_detected_, and never counted in the reclaim total -- and a plain `gc --delete`
_never_ touches them:

```bash
stim gc                            # report everything, caches included
stim gc --delete --older-than 30   # trim entries unused for 30 days
stim gc --delete --all             # empty them completely
```

Prefer trimming. Most of these caches are a flat collection of independent
entries -- one file per key for Metro's `FileStore`, one directory per
fingerprint for a build cache -- so the ones nothing has touched in weeks
can go while the rest keep working. "Unused" means neither read nor written: a
cache hit reads an entry without rewriting it, so pruning on modification time
alone would evict exactly the entries that are earning their keep.

Xcode's compilation cache is the exception. It is an LLVM CAS whose `v4.actions`
index references its `v9.*.leaf` data files, so removing leaves individually
would leave the index pointing at data that is gone. `--older-than` reports it
as left alone; it can only be emptied whole, which is what `--all` does.

Gradle's build cache is report-only. stim-cli enables it with `--build-cache`,
so `gc` detects and sizes `caches/build-cache-1` under `GRADLE_USER_HOME`
(default `~/.gradle`). Because that directory is shared with every other Gradle
build on the machine, stim-cli never prunes or empties it, even with
`--delete --older-than` or `--delete --all`.

Emptying is a performance decision, not cleanup: the next build in every
project pays to refill what you removed. The summary says so.

### Registering a cache stim-cli cannot detect

A Metro `FileStore` root, a build-cache provider's artifact directory, a
relocated `COMPILATION_CACHE_CAS_PATH` -- all come from a project's own config,
so stim-cli cannot guess them. The cache names itself instead, once, from code:

```js
// A setup script, a build-cache provider -- anywhere that creates the cache.
import { register } from 'stim-cli/cache-manifest';

register({
  dir: '~/.myapp-metro-cache',
  name: 'Metro transforms',
  entriesDepth: 2,
});
register({ dir: '~/.myapp-cas', prune: 'atomic' }); // index-backed: emptied whole or not at all
```

`entriesDepth` says how far below the directory one entry sits, and it is
what keeps trimming safe. The default, 1, is a flat store: every child of the
root is an entry. A root with a layer of grouping _above_ the entries registers
2 -- Metro's `FileStore` shards its keys across 256 directories, and a build
cache is keyed `<platform>/<key>` -- so `gc --delete --older-than 30`
trims one transform or one build instead of a 256th of every transform on the
machine, or an entire platform's builds.

Registration is idempotent and keyed on the directory, so a cache can call it on
every build; `@stim-cli/metro` and `@stim-cli/expo-build-cache` both do (by writing
the manifest directly, so they need no stim-cli installed at all).

The `caches` setting is the no-code alternative and is still read: a list of
paths under `caches` in a committed `.stim-cli.json` is reported alongside the
registered ones. Every path in it is treated as a flat store, so register from
code for anything that needs a depth or `atomic`.

```json
{ "caches": ["~/.myapp-metro-cache", "~/.myapp-build-cache"] }
```

## The cache packages

Two optional packages ship alongside the CLI. Both register themselves with
stim-cli the first time they run, so `gc` reports and trims them, and
both work fine without stim-cli installed -- it is an optional peer.

- **[`@stim-cli/metro`](https://www.npmjs.com/package/@stim-cli/metro)**
  -- one Metro transform cache shared by every worktree, instead of Metro's
  per-project default that makes each new workspace re-transform the whole
  module graph. It also carries the NDJSON reporter stim-cli uses to capture a
  dev server's logs, which is not a cache and is not wired up by `init`.
- **[`@stim-cli/expo-build-cache`](https://www.npmjs.com/package/@stim-cli/expo-build-cache)**
  -- a local Expo build cache provider. When no native input changed, the Expo
  CLI installs a cached `.app` / `.apk` instead of compiling. Wire it to
  `expo.buildCacheProvider` on SDK 54+, or `expo.experiments.buildCacheProvider`
  on SDK 53, which reads only that key and ignores the top-level one in silence.

Each package's README has the wiring. Neither is needed for `stim ios` /
`stim android`, which address the build cache directly: the Expo provider is
for builds run _outside_ stim-cli (`expo run:ios` by hand, or EAS), so that the two
share artifacts instead of filling two caches with the same builds. Bare React
Native has no provider hook at all and needs none.

What every entry point does need is `@expo/fingerprint` to compute the key. It
works on a project with no Expo in it at all. stim-cli uses its declared
`@expo/fingerprint` dependency directly, independently of the target project's
package graph, so a bare `@react-native-community/cli init` app needs no
`package.json` change to use the build cache. When it cannot produce a hash,
`stim ios` refuses with `STIM_CLI_NO_FINGERPRINT` rather than compiling from
scratch forever.

Entries are keyed `<fingerprintHash>-<variant>-<target>`, identically by every
entry point. The fingerprint covers what the project _is_, never how it was
built, so the variant (the Xcode configuration on iOS, the gradle variant on
Android; `debug` when unset) and the target class (`sim` unless the device
selector says otherwise) are part of the key. Without them a Release build would
answer a Debug lookup and a device build would answer a simulator one -- both
silently, both producing a binary that cannot run. stim-cli builds Debug for a
simulator and nothing else, so those fields are constant here; they exist
because the Expo provider and any future release path share the same keyspace.

## Project labels (--label)

Every project has a "shortcut": its `label` if one was set (e.g. via `worktree create --label`), else inherited from the enclosing worktree's label, else the directory basename. It is what names the owned device -- `stim-cli-<label>` -- and what `status` reports a workspace as.

```bash
stim worktree create feature-x --label agent-1   # its sim will be stim-cli-agent-1
```

Two projects sharing the same basename with no distinguishing label collide, which is why `worktree create` registers a label for the worktree root: every worktree of a monorepo otherwise shares the same app-dir basename.

## Worktrees

```bash
stim worktree create feature-x        # creates ../<repo>-worktrees/feature-x
stim worktree remove                  # removes it, deleting its owned device(s) and freeing its Metro port
```

`worktree create <name>` does three things in one step: creates the git worktree itself (branched `worktree-<name>` off the current `HEAD` by default -- pass `--base fresh` to use `origin/HEAD` instead), carries over gitignored files (see "Carry-over" below), and registers a label for the worktree root so `stim-cli` shortcuts don't collide across a monorepo's worktrees (every worktree of a monorepo shares the same app-dir basename). Prefer it over a raw `git worktree add` for that reason. It prints only the resulting worktree path to stdout; everything else goes to stderr (see "Wiring into Claude Code" below).

It deliberately does **not** install dependencies. Which commands a repo actually needs -- a plain install, a workspace filter, a codegen step after it -- is project-specific judgment. Install them yourself (or from your agent) before building, or use `--carry-ignored` to clone the source worktree's `node_modules`.

`worktree remove [<path>]` defaults to the current workspace. It reclaims the global workspace's build artifacts, Metro port, logs and every owned device registered under it (deleting them, not just clearing the claim -- the environment dies whole) before removing the git worktree itself. It also deletes the branch that `worktree create` created when no commit is unique to that branch. A branch that existed before Stim attached the worktree, or one with unique commits, remains. The command refuses if the worktree has uncommitted changes, untracked files, or commits that exist on no remote -- pass `--force` to override, but note `--force` only discards uncommitted/untracked state; committed work stays safe on the branch either way. On the main checkout it reclaims the environment only and leaves the tree itself untouched.

There is no `worktree list`: `stim status` shows the same worktrees _with_ their devices, ports and supervisors, including ones that have no environment yet.

### Carry-over

Gitignored files (like `.env`, local certs, or IDE state) don't exist in a fresh worktree by default. `worktree create` copies any gitignored file matching a pattern from either:

- `.worktreeinclude` at the repo root -- one gitignore-style pattern per line (`#` comments allowed), e.g.:
  ```
  .env
  .env.*
  **/*.local.json
  ```
- or the `worktree.include` setting (see "Settings" below), if no `.worktreeinclude` file exists.

Only files that are both gitignored and pattern-matched are copied -- tracked files are never duplicated into the worktree.

#### `--carry-ignored`

That carry-over is file-by-file, which suits a handful of small config files but not the multi-gigabyte trees a worktree needs in order to build without reinstalling. `worktree create --carry-ignored` instead clones **every safe** gitignored path -- `node_modules`, `ios/Pods`, `ios/build` (React Native codegen output, without which `xcodebuild` fails on a missing `States.cpp` until `pod install` regenerates it) -- minus:

- every registered Git worktree nested below the source checkout. If Git reports an ignored parent as one collapsed entry, Stim skips that parent instead of recursively copying the nested worktree;
- anything matching `.worktreeexclude` at the repo root, same gitignore-style syntax as `.worktreeinclude`, e.g.:
  ```
  bench/results/logs
  ```
- or the `worktree.exclude` setting, if no `.worktreeexclude` file exists.

The project exclusions add to Stim's safety exclusions. They cannot make Stim copy a registered nested worktree. This rule covers tool-managed locations and custom worktree locations without a hardcoded path list.

It is a skip list rather than a copy list on purpose: forgetting to name something you needed shows up months later as a confusing build error, while forgetting to skip something only costs a needless copy.

Each path is cloned with `cp -Rc`, so on APFS the copy is copy-on-write -- a 3.6 GB tree costs roughly 12s and tens of MB of real disk. Off by default because that only holds on APFS, within one volume: elsewhere the clone is refused and the fallback is a real copy of every byte, which `worktree create` reports separately. The command also reports whether it carried dependencies, CocoaPods, and native build output.

When a plain create detects those warm paths in the source, stderr gives the exact command for the next worktree:

```
Warm source not carried: dependencies, CocoaPods, native build output. For the next worktree, use: stim worktree create <name> --carry-ignored
```

Cloned dependencies match the source worktree, not necessarily the new branch's manifests -- the same contract as restoring a CI cache. Reinstall if the branch changes them.

`--carry-ignored` carries the source's **working state**, not just its gitignored trees: after the clone it also carries the source tree's uncommitted **tracked** changes (`git diff HEAD --binary`, checked with `git apply --check` and then applied), because the cloned artifacts were installed and fingerprinted against that working tree, not against a clean HEAD. When the patch applies, the worktree says so on stderr and leaves the changes uncommitted:

```
Carried 2 uncommitted change(s) from the source (app.json, ios/Podfile.lock) -- uncommitted here too; commit deliberately.
```

When the worktree's `--base` diverges from the source HEAD and the patch does not apply, **nothing is changed** and a warning names the files instead: the carried artifacts were installed for the source's uncommitted state, so fingerprints and cache keys in the worktree will differ from the source's until the two are reconciled. Untracked (non-ignored) files are not carried, same as always -- and a plain `worktree create` without the flag stays pure HEAD: no clone, no diff carry, no warning.

### Why worktrees live next to the repo, not inside it

`worktree create` places new worktrees in a sibling directory (`../<repo>-worktrees/<name>`), never under the repo root. A worktree nested inside the repo puts a second copy of every `package.json` inside Metro's watch root, which causes jest-haste-map naming collisions (two files claiming the same module name). Its multi-gigabyte `node_modules` also gets walked by Metro, TypeScript, and ESLint on every run. Gitignoring the nested worktree directory does not fix either problem: those tools walk the filesystem directly, not `git`, so a `.gitignore` entry is invisible to them.

### Wiring into Claude Code (`WorktreeCreate` hook)

Claude Code's `WorktreeCreate` hook fires when a session for a new worktree starts, and uses the hook command's stdout as the directory for that session. `stim worktree create` is built for exactly this contract -- it prints only the resulting path to stdout, and everything else goes to stderr. Wire it in `.claude/settings.json`:

```json
{
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [{ "type": "command", "command": "npx stim-cli worktree create \"$(jq -r .name)\"" }] }
    ]
  }
}
```

## Keeping the agent skill in sync

The skill other AI agents read ships inside the npm package. Because it is
installed by copy, upgrading stim-cli does **not** refresh it -- a 0.14.0 CLI
happily runs against a skill from 0.6.x, and the only symptom is an agent
following instructions that no longer match the binary.

After upgrading, refresh it the same way it was installed:

```bash
npx skills add appandflow/stim
```

That installs the one bundled skill, `stim-cli`: how to drive the CLI. There is
no separate setup skill -- stim-cli needs no project changes, and the handful of
things it cannot handle itself are what `stim doctor` reports, at the moment
they matter.

The skill is deliberately thin: it carries the rules that don't change
(the ownership model, the destructive-command rules, the parallel-agent rules)
and defers everything version-specific to `stim guide <topic>`, which is
generated by the installed binary and so cannot drift.

## Settings

`worktree create`, `start`, `ios` and `android` resolve settings from three layers, merged with the first match winning (nested objects merge key by key; arrays -- like `worktree.include` -- are replaced wholesale, never concatenated):

1. **Project settings** -- per absolute project path, stored in `~/.stim-cli/config.json`. Highest precedence.
2. **Repo settings** -- shared by every worktree of the same repository (keyed by the repo's git common dir), also stored in `~/.stim-cli/config.json`. Local to this machine.
3. **Committed settings** -- `.stim-cli.json` at the repo root, checked into git and shared with everyone who clones the repo. Lowest precedence, but the only layer that travels with the repo -- and, with the `config` command gone, normally the one you want.

The keys stim-cli reads are `ios.deviceType`, `ios.runtime`, `ios.configuration`, `ios.simslimProfile`, `android.systemImage`, `android.dataPartitionSizeGb`, `android.avdConfigFile`, `android.avdConfig`, `android.variant`, `android.keystore`, `android.keystorePassword`, `worktreeDir`, `caches`, and, under `worktree`: `baseRef` (`"fresh"` or `"head"`), `include` (carry-over patterns, same role as `.worktreeinclude`) and `exclude` (the `--carry-ignored` skip list, same role as `.worktreeexclude`). **Anything else is ignored, and stim-cli warns about it by name on every run that resolves settings** -- a `worktree.install` pipeline, for instance, is not a key stim-cli reads. Example `.stim-cli.json`:

```json
{
  "ios": {
    "deviceType": "iPhone 17 Pro",
    "simslimProfile": ".simslim/dev.json"
  },
  "android": {
    "dataPartitionSizeGb": 10,
    "avdConfigFile": ".stim-cli/android-avd.ini",
    "avdConfig": { "hw.keyboard": true }
  },
  "worktree": {
    "baseRef": "head",
    "include": [".env", ".env.*"]
  }
}
```

`ios.simslimProfile` names a SimSlim JSON profile relative to the repository root, or to the project root outside Git. Install SimSlim once on each Mac with `brew install mobai-app/tap/simslim`. On each local `stim ios`, Stim asks SimSlim to reconcile the profile on the owned simulator. The first change can update services and reboot the simulator. A matching profile is a fast no-op on later launches. The service settings persist across normal shutdowns and reboots. Removing `ios.simslimProfile` restores stock services when Stim applied the profile. Stim never changes an unowned or remote simulator. SimSlim requires an iOS 18 or newer simulator.

`android.dataPartitionSizeGb` is a whole number of GiB from 6 through 16384; it defaults to 8. It is applied only between creating a fresh owned AVD and its first boot because Android userdata images grow but do not shrink. Changing it leaves an existing AVD untouched; remove that worktree environment or reap the device with `gc --delete`, then let `android` create a replacement.

`android.avdConfigFile` names a flat native `key=value` INI fragment relative to the repository root, or to the project root outside Git, and at most 64 KiB. It is not a replacement `config.ini`: stim-cli parses the fragment, validates each setting, and atomically merges it into the `config.ini` that `avdmanager` generated. Absolute paths, root escapes, symlink escapes, sections, malformed lines, duplicate keys, and unsupported settings are refused before an AVD is created. `android.avdConfig` supplies the same settings inline as a flat JSON object; its resolved key/value pairs override the selected fragment. The inline object merges key by key across the normal settings layers, while `avdConfigFile` is a scalar path selected from the highest-precedence layer that defines it.

The supported native keys are `hw.accelerometer`, `hw.accelerometer_uncalibrated`, `hw.audioInput`, `hw.audioOutput`, `hw.battery`, `hw.cpu.ncore`, `hw.dPad`, `hw.gps`, `hw.gpu.enabled`, `hw.gpu.mode`, `hw.gyroscope`, `hw.initialOrientation`, `hw.keyboard`, `hw.lcd.density`, `hw.lcd.vsync`, `hw.mainKeys`, `hw.ramSize`, `hw.rotaryInput`, `hw.screen`, `hw.trackBall`, `runtime.network.latency`, `runtime.network.speed`, `showDeviceFrame`, and `vm.heapSize`. Boolean keys accept JSON booleans, string `true` / `false`, or native `yes` / `no`. Numeric ranges are: `hw.cpu.ncore` 1-64; `hw.lcd.density` 72-1000 dpi; `hw.lcd.vsync` 1-1000 Hz; `hw.ramSize` 1536-8192 MB; and `vm.heapSize` 16-4096 MB. Enums are: `hw.gpu.mode` = `auto` / `host` / `software` / `lavapipe` / `swiftshader` / `swangle`; `hw.initialOrientation` = `portrait` / `landscape`; `hw.screen` = `no-touch` / `touch` / `multi-touch`; `runtime.network.latency` = `none` / `gsm` / `hscsd` / `gprs` / `edge` / `umts` / `hsdpa` / `lte` / `evdo` / `5g`; and `runtime.network.speed` = `gsm` / `hscsd` / `gprs` / `edge` / `umts` / `hsdpa` / `lte` / `evdo` / `5g` / `full`. Identity, architecture, host path, storage, system-image, kernel, camera, snapshot, boot-lifecycle, and unknown future keys fail closed. The emulator can still normalize a valid value to a device-compatible effective value.

On displayless Linux (without `DISPLAY` or `WAYLAND_DISPLAY`), stim-cli launches with `-gpu swiftshader_indirect -noaudio` so the emulator can boot headlessly. Those launch arguments override `hw.gpu.enabled`, `hw.gpu.mode`, `hw.audioInput`, and `hw.audioOutput`; the stored AVD values still apply on launches with a display.

AVD overrides, like the data-partition size, apply only to a newly created owned AVD before its first boot. Recorded or recovered existing AVDs are never rewritten; recreate the environment to adopt a change.

`android.keystorePassword` accepts apksigner's schemed form (`env:MY_KS_PASS`, `file:/keys/pw.txt`, `stdin`) as well as a bare password, which is how a committed file can name a release keystore without carrying its secret.

**Never put secrets in `.stim-cli.json`.** It's committed to git and readable by anyone with repo access. Secrets belong in gitignored files (`.env` and friends) that `worktree create`'s carry-over feature copies into each new worktree -- that mechanism exists specifically so gitignored, secret-bearing files reach a fresh worktree without ever being committed to `.stim-cli.json` or anywhere else in git history.

## Requirements

- macOS (iOS); macOS or Linux (Android)
- Node 20.19.4 or later on Node 20, or Node 22.12.0 or later
- Xcode (iOS), Android SDK + at least one installed arm64 system image (Android)
- `expo` or `react-native` in the project's `package.json`

## License

MIT
