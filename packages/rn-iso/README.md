# rn-iso

Isolated React Native / Expo dev environments, one per project or worktree. `rn-iso up <platform>` creates (or reuses) a dedicated, **owned** simulator/emulator and reserves a Metro port, then hands you the facts -- UDID/serial, port, bundle id -- to run the project's own build against. `rn-iso start` runs the dev server on that port under a detached supervisor and captures everything it prints, so `rn-iso logs --errors` can answer "did that build work" without scraping a terminal. Multiple worktrees or coding agents can each get their own environment and build the same app in parallel without port or device collisions.

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
judgment a coding agent already has from reading the repo, and rn-iso
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

State lives in `~/.rn-iso/config.json`, keyed by absolute project path. Worktrees count as separate projects. There is no shared mutex -- each project gets its own port and its own device.

## Quick start

Run via `npx` from any RN/Expo project directory -- no install needed:

```bash
npx rn-iso up ios --json     # ensure an owned sim + Metro port; print the facts
```

```json
{"platform":"ios","owned":true,"metroPort":8082,"metroHealthy":false,"metroConflict":null,"bundleId":"io.tlon.groups","udid":"ABC-...","deviceName":"rn-iso-myproject"}
```

`up` never builds or installs anything -- start the dev server, run the project's own build against the printed facts, then ask what went wrong:

```bash
npx rn-iso start                                  # dev server on 8082, supervised; blocks until healthy
npx expo run:ios --device ABC-... --port 8082     # or: npx react-native run-ios --udid ABC-... --port 8082
npx rn-iso logs --errors                          # no output + exit 0 = nothing is broken
npx rn-iso stop                                   # supervisor down, sim shut down, port freed
```

In a different worktree of the same app, `up` creates a *different* owned sim and Metro port, so both run side by side:

```bash
npx rn-iso up ios --json     # a second, independent sim + port
```

To set a repo up for that in the first place, `rn-iso init` writes the loop
documentation and a `scripts/dev` runner, then reports what is still slow, and
`rn-iso doctor` reports the same findings on their own:

```bash
npx rn-iso init
npx rn-iso doctor
```

For AI coding agents, install the bundled skills so the agent knows how to drive the CLI (the lifecycle, the facts contract, and the destructive-command rules):

```bash
npx rn-iso skill install
```

The same skills also install via the skills CLI, straight from GitHub:

```bash
npx skills add janicduplessis/rn-iso
```

## Owned devices

Every simulator or emulator rn-iso uses is one **rn-iso created**, named `rn-iso-<label>`, and recorded with `owned: true`. rn-iso never boots, allocates, or destroys a device it did not create -- it cannot stomp a foreign tool's simulator, because it never touches devices it didn't make. Teardown of the owning project (`release`, `worktree remove`, or `gc` on an orphan) destroys the device, not just a claim on it.

This is a change from earlier versions, where rn-iso picked an existing, unclaimed simulator from the pool instead of creating one (see "Breaking change" below). That model existed to avoid accumulating junk simulators -- but the accumulation was really a symptom of creation *without* a reaper. The reaper now exists (`release`, `worktree remove`, `gc`), so creating a device and guaranteeing its eventual destruction is no longer the same hazard.

**The one exception: physical devices.** Hardware cannot be spawned. A physical Android device assigned with `up android --serial <serial>` is never booted, shut down, or deleted by rn-iso -- only assigned or cleared. There is no physical-iOS support; iOS is simulators only.

A pre-pivot assignment without `owned: true` ("legacy") is reused only while it is actually running -- rn-iso will not boot, shut down, or delete it. It converges to an owned device naturally (once shut down and re-created) or immediately via `release`.

## Breaking change: `release` now deletes the device

`release` used to just clear a claim, leaving the simulator running for reuse. Now, releasing an **owned** device shuts it down AND deletes it (`simctl delete` / `avdmanager delete avd`) -- releasing an owned resource means destroying it, since app state on a disposable, single-purpose sim has no reason to persist. A legacy or physical-device assignment is still only ever cleared, never deleted -- the old behavior, preserved exactly where the device isn't rn-iso's to destroy. `worktree remove` follows the same rule for every owned device registered under the worktree, since the environment is meant to die whole.

**A delete is not occupancy-guarded.** An owned sim goes away even if another tool is still attached to it. It is a device rn-iso created, for a project that is going away, and the process holding it is almost always the caller's own UI-test runner, which has nothing to return to. Skipping occupied sims there leaked booted sims and live `xcodebuild test-without-building` runners out of `worktree remove`, and "left for a later gc" only asked the same question again forever.

`shutdown` is the occupancy-guarded path (and `stop` uses the same one), because the device it spares survives the call and is still there to come back to: an iOS sim actively driven by a foreign UI-test runner is left running and reported instead of shut down. (Android has no occupancy probe, so an owned, identity-verified AVD is always eligible.)

If a delete fails, the failure is reported, the config record is **kept** so the device stays tracked, and `release` exits 1. Dropping the record on a failed teardown is exactly what turns it into a simulator nothing references.

## Commands

All commands below take the same `npx rn-iso` prefix.

| Command | Purpose |
|---|---|
| `start [--json] [--wait <seconds>]` | Start this workspace's dev server on the reserved port under a detached supervisor, and block until it answers *and* verifies as this project's (default 60s). Idempotent: a healthy dev server on the port is a no-op. Bare RN is hosted in-process with rn-iso's NDJSON reporter; Expo runs the project's own `expo start --port <n>` as a child. Structured logs land in `<root>/.rn-iso/logs`. |
| `logs [--source <s...>] [--level <l>] [--since <d>] [--grep <re>] [--tail <n>] [--errors] [--follow] [--json]` | Query the merged NDJSON timeline in `<root>/.rn-iso/logs`. Prints and exits; nothing matching is a successful, empty result (exit 0). `--errors` is the agent-loop query: errors and fatals since the last marker. `--follow` streams. |
| `up <ios\|android> [--json] [--wait-metro [seconds]] [--device-type <name>] [--runtime <ver>] [--system-image <pkg>] [--serial <serial>]` | Ensure an owned device and reserve a Metro port for the current project; print the facts. `--wait-metro` blocks until *this project's* Metro answers on the reserved port (default 60s). `--serial` assigns a connected physical Android device instead of creating an emulator. Never builds, and never starts the dev server -- that is `start`. |
| `device [--platform ios\|android] [--json]` | Print the current device assignment (no ensure/create side effects). |
| `stop [--force] [--json]` | The inverse of `start`: halt this workspace's supervisor, shut the owned device **down** (never deleted, so it stays assigned), and free the reserved port. Non-destructive and takes no target -- it acts on the current workspace. With no supervisor recorded it falls back to killing an identity-verified Metro on the reserved port; `--force` is only for an unproven listener there. Already-stopped is a success at every step. |
| `status [--json]` | Show every registered project: device assignments (owned/legacy), Metro state, supervisor pid / mode / health, log directory and error count since the last marker, plus machine capacity and disk. |
| `release [<port>\|<shortcut>\|<path>] [--platform <p>]` | Free a project's device assignment. Deletes the device if owned, without checking occupancy (see above); clears it if legacy/physical. On a failed delete it keeps the record and exits 1. |
| `shutdown [<shortcut>\|<path>] [-y] [--keep-sims]` | Kill Metro, shut down (never delete) owned sims/emulators, skipping any that are occupied. Owned device records stay recorded so `up` can reuse them; legacy/physical assignments are cleared. No arg = every registered project. |
| `gc [--delete] [--older-than <days>] [--all]` | Report what rn-iso has left behind: entries for projects whose directory no longer exists, orphaned `rn-iso-*` devices, and every shared build cache with its size. Reports and writes nothing by default; `--delete` reclaims the dead entries (freeing their Metro ports) and reaps the orphaned devices. `--older-than <days>` additionally reaps owned devices whose *project* has gone untouched that long, and trims cache entries nothing has used in that time. `--all` (with `--delete`) empties the caches whole -- see below. |
| `config [<key> [<value>]] [--unset] [--project <target>] [--repo]` | Get / set a per-project (or, with `--repo`, repo-shared) setting. |
| `doctor [--json]` | Report the configuration that makes a second workspace slower than it needs to be: a missing dev client, a per-project Metro cache, a compilation cache left at its default path, a ccache conflict, a build-cache provider on the key this SDK ignores. Read-only, and always exits 0. |
| `init [--force]` | Write `WORKFLOW.md`, an executable `scripts/dev`, and `.worktreeexclude` for this repo, then run `doctor`. Never overwrites an existing file without `--force`. |
| `build-cache resolve --platform <p> [--configuration <c>] [--variant <v>] [--device <id>]` | Print the path of a cached build matching the current native fingerprint. Prints nothing and exits 1 on a miss. |
| `build-cache store --platform <p> --path <app> [--configuration <c>] [--variant <v>] [--device <id>]` | Store a build you just made under the current native fingerprint. |
| `build-cache path` | Print the cache root, so a script can inspect or clear it directly. |
| `worktree create <name> [--base fresh\|head] [--label <name>] [--carry-ignored]` | Create an isolated git worktree: carries over gitignored files, prints the worktree path. Does not install dependencies unless `--carry-ignored` clones them. |
| `worktree remove <path> [--force]` | Remove a worktree, reclaiming its build artifacts, Metro port, and owned devices (deleted, not just freed). Refuses if it has uncommitted or unpushed work unless `--force`. |
| `worktree list` | List this repo's worktrees and their branches. |
| `guide [topic]` | Print reference docs for the installed version (topics: facts, metro, logs, errors, lifecycle, cleanup, settings). Generated by the binary, so it cannot drift. |
| `skill install [--print]` | Copy this version's agent skills into `~/.claude/skills` and `~/.agents/skills`. Run after upgrading. |

## How it works

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Symlinked worktrees collapse via `realpath`. Every write goes through a lockfile and lands by atomic rename, so several agents running `up` at once cannot lose each other's device records. A config that will not parse is reported by name and never reset automatically -- it holds the records of every device rn-iso owns, and resetting it would orphan all of them.
- **Port allocation:** `up` scans upward from 8082 for a port that is both unclaimed in the registry and actually free on the machine, reclaiming ports from dead projects on the way. Claiming is race-safe: the write only lands if the config still shows the port unclaimed, so two parallel `up` runs that probe the same free port cannot both take it. A project whose directory only *looks* gone because its volume is unmounted keeps its port.
- **Owned device creation:** on iOS, `up` creates the newest iPhone device type -- highest generation number, base model rather than Pro/Pro Max -- on the newest installed runtime by default (or reuses the project's already-recorded owned sim, booting it if shut down). On Android, it creates an AVD via `avdmanager create avd` against the newest installed arm64 system image (rn-iso never installs system images itself -- it errors with install instructions if none is found). Override the defaults with `--device-type`/`--runtime`/`--system-image`, or persist them via `rn-iso config ios.deviceType|ios.runtime|android.systemImage`.
- **rn-iso never runs a build.** `up` only provisions the device, Metro port, and (on Android) `adb reverse`; you run the project's own `expo run:*` / `react-native run-*` (or its wrapping script) against the printed facts.
- **rn-iso reserves the Metro port, and `start` hosts the dev server on it.** See "The dev server and logs" below. Starting the bundler yourself against the reserved port still works -- both Expo and the RN CLI probe the port and skip spawning a second bundler when one already answers `/status` -- but nothing is captured that way. Teardown (`stop`, `release`, `worktree remove`, `gc`) finds Metro by port via `lsof` and only kills it after confirming it answers `/status` **and** runs from inside the project: a port is not identity, so an unidentified listener is reported instead of killed.

If you need a single shared sim with a mutex instead of one owned device per project, see [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree).

## The dev server and logs

`rn-iso start` runs the dev server for you, on the port `up` reserves, under a **detached per-workspace supervisor**. It blocks until the server both answers and verifies as this project's (the same identity check teardown uses, never a bare port probe), then exits leaving it running:

```bash
npx rn-iso start --json
# {"port":8082,"supervisorPid":41233,"mode":"bare-inproc","logsDir":"/path/.rn-iso/logs","alreadyRunning":false}
```

It has two flags and will not grow more: `--json` and `--wait <seconds>` (default 60). Anything a project needs beyond that belongs in its own bundler command. Running `start` twice leaves one supervisor -- a healthy dev server on the port is a no-op, including one you started yourself, which is reported with `supervisorPid: null` and left alone rather than fought over.

There is no machine-wide daemon: one supervisor process per workspace, recorded in `<root>/.rn-iso/state.json` and in the registry before it starts serving, and gone (with its records) on any exit path. Two modes:

- **`bare-inproc`** -- bare React Native: Metro is hosted *inside* the supervisor, loaded from the project's own `node_modules`, with `@rn-iso/metro`'s NDJSON reporter attached. Bundler events, in-app `console.log` and redboxes all arrive structured. Hosting is the only way to get them: both CLIs overwrite `config.reporter` after loading `metro.config.js`, so a reporter wired in there is discarded.
- **`expo-child`** -- Expo: the project's own `expo start --port <n>` runs as a child and its stdout is parsed into the same records. Expo's dev server is protocol-bearing (manifest, dev-client and expo-router middleware), so reimplementing it would be forking Expo; the cost is that levels are *inferred* from each line, which those records mark with `raw: true`.

Everything lands as one JSON object per line under `<root>/.rn-iso/logs`, and `rn-iso logs` queries the files merged into one timeline:

```bash
npx rn-iso logs --errors            # errors since the last marker; empty + exit 0 = healthy
npx rn-iso logs --source client --since 5m --grep 'Profile'
npx rn-iso logs --follow --level warn
npx rn-iso logs --errors --json     # raw records, so stdout is valid NDJSON
```

**Nothing matching is exit 0.** `logs --errors` returning nothing is the pass condition of a build loop, so an empty result must never read as a failure; the only exit-1 paths are a malformed query and no project. `--errors` means level `error` or `fatal` strictly after the most recent record carrying `marker: true`, and the marker is searched across every source, so a marker in one file closes the window for all of them. Markers are written when a bundle build finishes -- which is what stops an error you already fixed from being reported forever. `rn-iso status` reports the same count per workspace.

The record is `{ ts, src, level, msg }` plus optional `event`, `stack`, `marker` and `raw`. `src` is one of `metro`, `client`, `device`, `build`; today the supervisor writes `metro` (both modes) and `client` (bare only -- in `expo-child` mode Expo's client output arrives on the bundler stream). `.rn-iso/logs/supervisor.log` is deliberately *not* part of the timeline: it is the supervisor's raw stdio, and it is what `start` quotes when a supervisor dies before it can write a structured record.

`rn-iso stop` is the inverse: it halts the supervisor (identity-verified: a pid is only signalled when it is alive, recorded for this workspace, and holding the port this project reserved), shuts the owned device down without deleting it, and frees the port. It never escalates to `SIGKILL` -- a supervisor mid-write on the log files is exactly what `SIGTERM` handling exists to finish -- so a supervisor that will not exit is reported with its pid instead.

## Per-project settings (`rn-iso config`)

A few options can be persisted per project so you don't have to repeat the same flags every run. Resolution order for `up`:

1. CLI flag (`--device-type`, `--runtime`, `--system-image`)
2. Stored project setting (this section)
3. rn-iso's own default (newest iPhone, base model, on newest installed runtime; newest installed arm64 system image)

```bash
npx rn-iso config ios.deviceType "iPhone 17 Pro"
npx rn-iso config ios.runtime 26.2
npx rn-iso config android.systemImage "system-images;android-36;google_apis;arm64-v8a"
npx rn-iso config                    # list current project's settings
npx rn-iso config ios.deviceType     # print one
npx rn-iso config ios.deviceType --unset
```

Allowed project-layer keys today: `ios.deviceType`, `ios.runtime`, `android.systemImage`. Pass `--repo` to operate on the repo-shared layer instead (keyed by the repo's git common dir), which additionally accepts `worktreeDir` and any `worktree.*` key -- see "Settings" below. Settings live in `~/.rn-iso/config.json`.

## Shared build caches

Everything `gc` reclaims is *dead*: a project entry whose directory no longer
exists belongs to nobody, and a `rn-iso-*` simulator nothing references is
never coming back. Shared build caches are the opposite -- alive by design,
shared by every project on the machine, and pruned by nothing:

- **Metro's `FileStore`** has no eviction logic whatsoever.
- **Xcode's compilation cache** has no size cap.
- **Metro file maps** accumulate one file per project root ever served.

So every `gc` run reports them -- in their own bucket, tagged *registered* or
*detected*, and never counted in the reclaim total -- and a plain `gc --delete`
*never* touches them:

```bash
npx rn-iso gc                            # report everything, caches included
npx rn-iso gc --delete --older-than 30   # trim entries unused for 30 days
npx rn-iso gc --delete --all             # empty them completely
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

Emptying is a performance decision, not cleanup: the next build in every
project pays to refill what you removed. The summary says so.

### Registering a cache rn-iso cannot detect

A Metro `FileStore` root, a build-cache provider's artifact directory, a
relocated `COMPILATION_CACHE_CAS_PATH` -- all come from a project's own config,
so rn-iso cannot guess them. The cache names itself instead, once, from code:

```js
// A setup script, a build-cache provider -- anywhere that creates the cache.
// `rn-iso/cache-manifest` is ESM, so a CJS caller needs `await import(...)`.
import { register } from 'rn-iso/cache-manifest';

register({
  dir: '~/.myapp-metro-cache',
  name: 'Metro transforms',
  entriesDepth: 2,
});
register({ dir: '~/.myapp-cas', prune: 'atomic' }); // index-backed: emptied whole or not at all
```

`entriesDepth` says how far below the directory one entry sits, and it is
what keeps trimming safe. The default, 1, is a flat store: every child of the
root is an entry. A root with a layer of grouping *above* the entries registers
2 -- Metro's `FileStore` shards its keys across 256 directories, and a build
cache is keyed `<platform>/<key>` -- so `gc --delete --older-than 30`
trims one transform or one build instead of a 256th of every transform on the
machine, or an entire platform's builds.

Registration is idempotent and keyed on the directory, so a cache can call it on
every build; `@rn-iso/metro` and `@rn-iso/expo-build-cache` both do (by writing
the manifest directly, so they need no rn-iso installed at all).

The `caches` setting is the no-code alternative and is still read: a list of
paths under `caches` in a committed `.rn-iso.json` is reported alongside the
registered ones. It has no `rn-iso config` key of its own, and every path in it
is treated as a flat store, so register from code for anything that needs a
depth or `atomic`.

```json
{ "caches": ["~/.myapp-metro-cache", "~/.myapp-build-cache"] }
```

## The cache packages

Two optional packages ship alongside the CLI. Both register themselves with
rn-iso the first time they run, so `gc` reports and trims them, and
both work fine without rn-iso installed -- it is an optional peer.

- **[`@rn-iso/metro`](https://www.npmjs.com/package/@rn-iso/metro)**
  -- one Metro transform cache shared by every worktree, instead of Metro's
  per-project default that makes each new workspace re-transform the whole
  module graph. It also carries the NDJSON reporter rn-iso uses to capture a
  dev server's logs, which is not a cache and is not wired up by `init`.
- **[`@rn-iso/expo-build-cache`](https://www.npmjs.com/package/@rn-iso/expo-build-cache)**
  -- a local Expo build cache provider. When no native input changed, the Expo
  CLI installs a cached `.app` / `.apk` instead of compiling. Wire it to
  `expo.buildCacheProvider` on SDK 54+, or `expo.experiments.buildCacheProvider`
  on SDK 53, which reads only that key and ignores the top-level one in silence.

Each package's README has the wiring.

For a bare React Native project, which has no provider hook, `rn-iso build-cache
resolve|store` addresses the same cache from the CLI:

```bash
APP=$(npx rn-iso build-cache resolve --platform ios) || {
  npx react-native run-ios --udid "$UDID" --port "$PORT"
  npx rn-iso build-cache store --platform ios --path "$BUILT_APP"
}
```

It needs `@expo/fingerprint` to compute the key, which works on a project with
no Expo in it at all.

Entries are keyed `<fingerprintHash>-<variant>-<target>`, identically by both
entry points. The fingerprint covers what the project *is*, never how it was
built, so the variant (the Xcode configuration on iOS, the gradle variant on
Android; `debug` when unset) and the target class (`sim` unless the device
selector says otherwise) are part of the key. Without them a Release build would
answer a Debug lookup and a device build would answer a simulator one -- both
silently, both producing a binary that cannot run. Pass `--configuration` /
`--variant` / `--device` to `build-cache resolve` and `store` so a build you
store is the one a matching lookup finds.

## Project shortcuts (--label)

Every project has a "shortcut" you can pass to `release` / `shutdown` / `config --project` instead of the full path: its `label` if one was set (e.g. via `worktree create --label`), else inherited from the enclosing worktree's label, else the directory basename.

```bash
npx rn-iso worktree create feature-x --label agent-1
npx rn-iso release agent-1
npx rn-iso shutdown agent-1
```

Shortcut collisions (two projects sharing the same basename with no distinguishing label) error out and list the candidates so you can disambiguate with the absolute path.

## Worktrees

```bash
npx rn-iso worktree create feature-x        # creates ../<repo>-worktrees/feature-x
npx rn-iso worktree list                    # shows every worktree and its branch
npx rn-iso worktree remove <path>           # removes it, deleting its owned device(s) and freeing its Metro port
```

`worktree create <name>` does three things in one step: creates the git worktree itself (branched `worktree-<name>` off `origin/HEAD` by default -- pass `--base head` to branch off the current `HEAD` instead), carries over gitignored files (see "Carry-over" below), and registers a label for the worktree root so `rn-iso` shortcuts don't collide across a monorepo's worktrees (every worktree of a monorepo shares the same app-dir basename). Prefer it over a raw `git worktree add` for that reason. It prints only the resulting worktree path to stdout; everything else goes to stderr (see "Wiring into Claude Code" below).

It deliberately does **not** install dependencies. Which commands a repo actually needs -- a plain install, a workspace filter, a codegen step after it -- is project-specific judgment, the same reason rn-iso stopped wrapping builds in 0.7 and stopped starting Metro in 0.8. Install them yourself (or from your agent) before building.

`worktree remove <path>` reclaims the worktree's build artifacts, Metro port, and every owned device registered under it (deleting them, not just clearing the claim -- the environment dies whole) before removing the git worktree itself. It refuses if the worktree has uncommitted changes, untracked files, or commits that exist on no remote -- pass `--force` to override, but note `--force` only discards uncommitted/untracked state; committed work stays safe on the branch either way.

`worktree list` shows every worktree and its branch.

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

That carry-over is file-by-file, which suits a handful of small config files but not the multi-gigabyte trees a worktree needs in order to build without reinstalling. `worktree create --carry-ignored` instead clones **every** gitignored path -- `node_modules`, `ios/Pods`, `ios/build` (React Native codegen output, without which `xcodebuild` fails on a missing `States.cpp` until `pod install` regenerates it) -- minus anything matching:

- `.worktreeexclude` at the repo root, same gitignore-style syntax as `.worktreeinclude`, e.g.:
  ```
  bench/results/logs
  ```
- or the `worktree.exclude` setting, if no `.worktreeexclude` file exists.

It is a skip list rather than a copy list on purpose: forgetting to name something you needed shows up months later as a confusing build error, while forgetting to skip something only costs a needless copy.

Each path is cloned with `cp -Rc`, so on APFS the copy is copy-on-write -- a 3.6 GB tree costs roughly 12s and tens of MB of real disk. Off by default because that only holds on APFS, within one volume: elsewhere the clone is refused and the fallback is a real copy of every byte, which `worktree create` warns about.

Cloned dependencies match the source worktree, not necessarily the new branch's manifests -- the same contract as restoring a CI cache. Reinstall if the branch changes them.

### Why worktrees live next to the repo, not inside it

`worktree create` places new worktrees in a sibling directory (`../<repo>-worktrees/<name>`), never under the repo root. A worktree nested inside the repo puts a second copy of every `package.json` inside Metro's watch root, which causes jest-haste-map naming collisions (two files claiming the same module name). Its multi-gigabyte `node_modules` also gets walked by Metro, TypeScript, and ESLint on every run. Gitignoring the nested worktree directory does not fix either problem: those tools walk the filesystem directly, not `git`, so a `.gitignore` entry is invisible to them.

### Wiring into Claude Code (`WorktreeCreate` hook)

Claude Code's `WorktreeCreate` hook fires when a session for a new worktree starts, and uses the hook command's stdout as the directory for that session. `rn-iso worktree create` is built for exactly this contract -- it prints only the resulting path to stdout, and everything else goes to stderr. Wire it in `.claude/settings.json`:

```json
{
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [{ "type": "command", "command": "rn-iso worktree create \"$(jq -r .name)\"" }] }
    ]
  }
}
```

## Keeping the agent skills in sync

The skills other AI agents read ship inside the npm package. Because they are
installed by copy, upgrading rn-iso does **not** refresh them -- a 0.14.0 CLI
happily runs against a skill from 0.6.x, and the only symptom is an agent
following instructions that no longer match the binary.

After upgrading:

```bash
npx rn-iso skill install
```

That installs both bundled skills: `rn-iso` (how to drive the CLI) and
`rn-iso-init` (how to make a repo fast for parallel agents).

The `rn-iso` skill is deliberately thin: it carries the rules that don't change
(the ownership model, the destructive-command rules, the parallel-agent rules)
and defers everything version-specific to `npx rn-iso guide <topic>`, which is
generated by the installed binary and so cannot drift.

## Settings

`worktree create` and `up` resolve settings from three layers, merged with the first match winning (nested objects merge key by key; arrays -- like `worktree.include` -- are replaced wholesale, never concatenated):

1. **Project settings** -- per absolute project path, stored in `~/.rn-iso/config.json`. Set with `npx rn-iso config <key> <value>` (see above). Highest precedence.
2. **Repo settings** -- shared by every worktree of the same repository (keyed by the repo's git common dir), also stored in `~/.rn-iso/config.json`, set with `npx rn-iso config <key> <value> --repo`. Local to this machine.
3. **Committed settings** -- `.rn-iso.json` at the repo root, checked into git and shared with everyone who clones the repo. Lowest precedence, but the only layer that travels with the repo.

The keys rn-iso reads are `ios.deviceType`, `ios.runtime`, `android.systemImage`, `worktreeDir`, `caches`, and, under `worktree`: `baseRef` (`"fresh"` or `"head"`), `include` (carry-over patterns, same role as `.worktreeinclude`) and `exclude` (the `--carry-ignored` skip list, same role as `.worktreeexclude`). **Anything else is ignored, and `up` warns about it by name** -- a `worktree.install` pipeline, for instance, stopped being honoured in 0.9.0. Example `.rn-iso.json`:

```json
{
  "ios": { "deviceType": "iPhone 17 Pro" },
  "worktree": {
    "baseRef": "fresh",
    "include": [".env", ".env.*"]
  }
}
```

**Never put secrets in `.rn-iso.json`.** It's committed to git and readable by anyone with repo access. Secrets belong in gitignored files (`.env` and friends) that `worktree create`'s carry-over feature copies into each new worktree -- that mechanism exists specifically so gitignored, secret-bearing files reach a fresh worktree without ever being committed to `.rn-iso.json` or anywhere else in git history.

## Requirements

- macOS (iOS); macOS or Linux (Android)
- Node 20+
- Xcode (iOS), Android SDK + at least one installed arm64 system image (Android)
- `expo` or `react-native` in the project's `package.json`

## License

MIT
