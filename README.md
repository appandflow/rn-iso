# rn-iso

An environment broker for React Native / Expo: `rn-iso up <platform>` creates (or reuses) a dedicated, **owned** simulator/emulator and reserves a Metro port for the current project, then hands you the facts -- UDID/serial, port, bundle id -- so you (or your coding agent) can start Metro and run the project's own build. Multiple worktrees or coding agents can each get their own environment and build the same app in parallel without port or device collisions.

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

That is the whole job of this tool: arbitrate the contended resources, and
reclaim them when the agent that owned them dies badly. Everything else --
which build command, which bundler flags, when to install -- is judgment a
coding agent already has from reading the repo, and rn-iso deliberately does
not take it back.

### Where local honestly loses

- **CPU and memory are finite.** Two or three live environments on a 16 GB
  machine, not ten. Cloud wins this outright.
- **Paths are not stable.** CI checks out to the same path every run, so
  path-keyed caches (ccache, Xcode's compilation cache, a CocoaPods sandbox)
  just work. Locally every worktree sits somewhere different, and those caches
  quietly miss everything -- measured on one project as 0 ccache hits out of
  1094 across two workspaces. It is fixable, but it is a tax cloud does not pay.
- **Disk grows without bound.** Simulators, DerivedData and the shared caches
  that make any of this fast all accumulate. `gc` and `gc --caches` exist for
  that reason.

State lives in `~/.rn-iso/config.json`, keyed by absolute project path. Worktrees count as separate projects. There is no shared mutex -- each project gets its own port and its own device.

## Quick start

Run via `npx` from any RN/Expo project directory -- no install needed:

```bash
npx rn-iso up ios --json     # ensure an owned sim + Metro; print the facts
```

```json
{"platform":"ios","owned":true,"udid":"ABC-...","deviceName":"rn-iso-myproject","metroPort":8082,"metroHealthy":false,"bundleId":"io.tlon.groups","metroConflict":null}
```

`up` never builds or installs anything -- run the project's own build against the printed facts:

```bash
npx expo run:ios --device ABC-... --port 8082
# or: npx react-native run-ios --udid ABC-... --port 8082
```

In a different worktree of the same app, `up` creates a *different* owned sim and Metro port, so both run side by side:

```bash
npx rn-iso up ios --json     # a second, independent sim + port
```

For AI coding agents, install the skill so the agent knows how to drive the CLI (the lifecycle, the facts contract, and a table of build invocations per project shape):

```bash
npx skills add janicduplessis/rn-iso
```

## Owned devices

Every simulator or emulator rn-iso uses is one **rn-iso created**, named `rn-iso-<label>`, and recorded with `owned: true`. rn-iso never boots, allocates, or destroys a device it did not create -- it cannot stomp a foreign tool's simulator, because it never touches devices it didn't make. Teardown of the owning project (`release`, `worktree remove`, or `gc` on an orphan) destroys the device, not just a claim on it.

This is a change from earlier versions, where rn-iso picked an existing, unclaimed simulator from the pool instead of creating one (see "Breaking change" below). That model existed to avoid accumulating junk simulators -- but the accumulation was really a symptom of creation *without* a reaper. The reaper now exists (`release`, `worktree remove`, `gc`), so creating a device and guaranteeing its eventual destruction is no longer the same hazard.

**The one exception: physical devices.** Hardware cannot be spawned. A physical Android device connected via `adb` is still assigned by serial and is never booted, shut down, or deleted by rn-iso -- only assigned or cleared.

A pre-pivot assignment without `owned: true` ("legacy") is reused only while it is actually running -- rn-iso will not boot, shut down, or delete it. It converges to an owned device naturally (once shut down and re-created) or immediately via `release`.

## Breaking change: `release` now deletes the device

`release` used to just clear a claim, leaving the simulator running for reuse. Now, releasing an **owned** device shuts it down AND deletes it (`simctl delete` / `avdmanager delete avd`) -- releasing an owned resource means destroying it, since app state on a disposable, single-purpose sim has no reason to persist. A legacy or physical-device assignment is still only ever cleared, never deleted -- the old behavior, preserved exactly where the device isn't rn-iso's to destroy. `worktree remove` follows the same rule for every owned device registered under the worktree, since the environment is meant to die whole. Both are occupancy-guarded (an iOS sim actively driven by a foreign UI-test runner is left running and reported instead of deleted); `release --force` overrides the guard.

## Commands

All commands below take the same `npx rn-iso` prefix.

| Command | Purpose |
|---|---|
| `up <ios\|android> [--json] [--device-type <name>] [--runtime <ver>] [--system-image <pkg>]` | Ensure an owned device and reserve a Metro port for the current project; print the facts. Never builds, never starts Metro. |
| `device [--platform ios\|android] [--json]` | Print the current device assignment (no ensure/create side effects). |
| `stop [<port>\|<shortcut>\|<path>] [--force]` | Kill this project's Metro, after proving the process on the reserved port is ours. `--force` kills an unidentified listener. Pass a port to target it directly; a port no project owns prompts first. No arg = current project. |
| `status` | Show all projects' device assignments (owned/legacy) and Metro state. |
| `release [<port>\|<shortcut>\|<path>] [--platform <p>] [--force]` | Free a project's device assignment. Deletes it if owned (see above); clears it if legacy/physical. `--force` deletes even if in use by another tool (iOS only). |
| `shutdown [<shortcut>\|<path>] [-y] [--keep-sims]` | Kill Metro, shut down (never delete) owned sims/emulators. Owned device records stay recorded so `up` can reuse them; legacy/physical assignments are cleared. No arg = every registered project. |
| `prune` | Remove entries for deleted project directories, freeing their ports (not devices -- see `gc`). |
| `gc [--delete] [--older-than <days>] [--caches]` | Report (or, with `--delete`, reclaim) orphaned Xcode DerivedData, dead project entries, and orphaned `rn-iso-*` devices. Reports only by default. `--caches` additionally reports the shared build caches -- see below. |
| `config [<key> [<value>]] [--unset] [--project <target>] [--repo]` | Get / set a per-project (or, with `--repo`, repo-shared) setting. |
| `worktree create <name> [--base fresh\|head] [--label <name>] [--carry-ignored]` | Create an isolated git worktree: carries over gitignored files, prints the worktree path. Does not install dependencies unless `--carry-ignored` clones them. |
| `worktree remove <path> [--force]` | Remove a worktree, reclaiming its build artifacts, Metro port, and owned devices (deleted, not just freed). Refuses if it has uncommitted or unpushed work unless `--force`. |
| `worktree list` | List this repo's worktrees and their branches. |
| `guide [topic]` | Print reference docs for the installed version (topics: facts, metro, errors, lifecycle, settings). Generated by the binary, so it cannot drift. |
| `skill install [--print]` | Copy this version's agent skill into `~/.claude/skills` and `~/.agents/skills`. Run after upgrading. |

## How it works

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Symlinked worktrees collapse via `realpath`.
- **Port allocation:** `up` assigns 8082, 8083, 8084 etc., reclaiming dead ports on the way.
- **Owned device creation:** on iOS, `up` creates the newest iPhone device type -- highest generation number, base model rather than Pro/Pro Max -- on the newest installed runtime by default (or reuses the project's already-recorded owned sim, booting it if shut down). On Android, it creates an AVD via `avdmanager create avd` against the newest installed arm64 system image (rn-iso never installs system images itself -- it errors with install instructions if none is found). Override the defaults with `--device-type`/`--runtime`/`--system-image`, or persist them via `rn-iso config ios.deviceType|ios.runtime|android.systemImage`.
- **rn-iso never runs a build.** `up` only provisions the device, Metro, and (on Android) `adb reverse`; you run the project's own `expo run:*` / `react-native run-*` (or its wrapping script) against the printed facts. The skill's "Common setups reference" table has invocations for the common project shapes.
- **rn-iso reserves the Metro port; you start Metro.** Which bundler command a project needs is project-specific judgment -- the same reason rn-iso stopped wrapping builds -- so `up` allocates and records a collision-free port and leaves the invocation to you. Both Expo and the RN CLI probe the target port and skip spawning a second bundler when Metro already answers `/status`, which is what makes it safe to start Metro yourself and then build against it. Teardown (`stop`, `release`, `worktree remove`, `gc`) finds Metro by port via `lsof`, but only kills it after confirming it answers `/status` **and** runs from inside the project -- a port is not identity, so an unidentified listener is reported instead of killed.

If you need a single shared sim with a mutex instead of one owned device per project, see [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree).

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

## Shared build caches (`gc --caches`)

Everything `gc` reclaims by default is *dead*: a DerivedData directory whose
workspace no longer exists belongs to nobody. Shared build caches are the
opposite -- alive by design, shared by every project on the machine, and
pruned by nothing:

- **Metro's `FileStore`** has no eviction logic whatsoever.
- **Xcode's compilation cache** has no size cap.
- **Metro file maps** accumulate one file per project root ever served.

So they are reported in their own bucket and are *never* touched by a plain
`gc --delete`:

```bash
npx rn-iso gc --caches                            # report sizes only
npx rn-iso gc --caches --delete --older-than 30   # trim entries unused for 30 days
npx rn-iso gc --caches --delete                   # empty them completely
```

Prefer trimming. Most of these caches are a flat collection of independent
entries -- one file per key for Metro's `FileStore`, one directory per
fingerprint for an Expo build cache -- so the ones nothing has touched in weeks
can go while the rest keep working. "Unused" means neither read nor written: a
cache hit reads an entry without rewriting it, so pruning on modification time
alone would evict exactly the entries that are earning their keep.

Xcode's compilation cache is the exception. It is an LLVM CAS whose `v4.actions`
index references its `v9.*.leaf` data files, so removing leaves individually
would leave the index pointing at data that is gone. `--older-than` reports it
as left alone; it can only be emptied whole.

Emptying is a performance decision, not cleanup: the next build in every
project pays to refill what you removed. The summary says so.

Caches rn-iso cannot detect -- a Metro `FileStore` root, an Expo build-cache
provider's artifact directory, a relocated `COMPILATION_CACHE_CAS_PATH` -- come
from a project's own config, so name them with the `caches` setting:

```bash
npx rn-iso config caches '["~/.myapp-metro-cache", "~/.myapp-build-cache"]' --repo
```

## Project shortcuts (--label)

Every project has a "shortcut" you can pass to `stop` / `release` / `config --project` instead of the full path: its `label` if one was set (e.g. via `worktree create --label`), else inherited from the enclosing worktree's label, else the directory basename.

```bash
npx rn-iso worktree create feature-x --label agent-1
npx rn-iso stop agent-1
npx rn-iso release agent-1
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

## Keeping the agent skill in sync

The skill other AI agents read ships inside the npm package. Because it is
installed by copy, upgrading rn-iso does **not** refresh it -- a 0.10.0 CLI
happily runs against a skill from 0.6.x, and the only symptom is an agent
following instructions that no longer match the binary.

After upgrading:

```bash
npx rn-iso skill install
```

The skill itself is deliberately thin: it carries the rules that don't change
(the ownership model, the destructive-command rules, the parallel-agent rules)
and defers everything version-specific to `npx rn-iso guide <topic>`, which is
generated by the installed binary and so cannot drift.

## Settings

`worktree create` and `up` resolve settings from three layers, merged with the first match winning (nested objects merge key by key; arrays -- like `worktree.include` -- are replaced wholesale, never concatenated):

1. **Project settings** -- per absolute project path, stored in `~/.rn-iso/config.json`. Set with `npx rn-iso config <key> <value>` (see above). Highest precedence.
2. **Repo settings** -- shared by every worktree of the same repository (keyed by the repo's git common dir), also stored in `~/.rn-iso/config.json`, set with `npx rn-iso config <key> <value> --repo`. Local to this machine.
3. **Committed settings** -- `.rn-iso.json` at the repo root, checked into git and shared with everyone who clones the repo. Lowest precedence, but the only layer that travels with the repo.

Recognized keys include `ios.deviceType`, `ios.runtime`, `android.systemImage`, and, under `worktree`: `baseRef` (`"fresh"` or `"head"`) and `include` (carry-over patterns, same role as `.worktreeinclude`). Example `.rn-iso.json`:

```json
{
  "ios": { "deviceType": "iPhone 17 Pro" },
  "worktree": {
    "baseRef": "fresh",
    "install": ["pnpm install", "pnpm run codegen"],
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
