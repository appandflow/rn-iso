# rn-iso — agent guide

Quick orientation for AI assistants working in this repo.

## What this is

A Node.js CLI that gives a React Native / Expo project (or git worktree) an
isolated dev environment, and runs the whole dev loop inside it. Three things,
in the order an agent uses them:

- **`rn-iso start`** hosts the dev server under a detached per-workspace
  supervisor (bare RN in-process with an NDJSON reporter; Expo as a child
  `expo start --port N`) on a reserved, collision-free Metro port, and blocks
  until it verifies as this project's.
- **`rn-iso ios` / `rn-iso android`** ensure an **owned** simulator/emulator,
  gate on that dev server, fingerprint the native inputs, install from the
  shared build cache or build (prebuild / pod-or-gradle sync / xcodebuild or
  gradle), install, launch wired to the reserved port, and attach a device-log
  collector.
- **`rn-iso logs`** queries the merged NDJSON timeline under
  `<root>/.rn-iso/logs`; **`rn-iso stop`** is the inverse of `start` (halt the
  supervisor, reap the collectors, shut the owned device DOWN, free the port —
  it never deletes).

The v3 lifecycle is `worktree create` -> `start` -> `ios|android` ->
`logs --errors` -> edit -> `logs` -> `stop` / `worktree remove` (which reaps the
owned device(s) along with the worktree).

**The surface is closed, at ten commands.** `doctor`, `worktree
create|remove`, `start`, `stop`, `ios`, `android`, `logs`, `status`, `gc`, plus
`guide`. That is all of it, deliberately (spec: "Command surface").
v2's `up`, `device`, `release`, `shutdown`, `config`, `build-cache` and
`worktree list` are deleted, along with `--serial` and all physical-device
support. A project needing more wraps rn-iso in an npm script rather than
rn-iso growing a flag.

**`init` went too, and it is the most recent deletion — do not bring it back.**
Repo setup is not a generator's job: every edit it would make lands in a file
the project already owns (a `metro.config.js` with its own transformer, a
`Podfile` with existing `post_install` logic, an app config that may be
TypeScript), which is judgement, not templating. `doctor` reports the findings
read-only and `skill/rn-iso-init/SKILL.md` is the playbook an agent follows to
apply each one by hand. The generated `scripts/dev` went with it: v3 IS the
build command, so there was no bundler or build command left to wrap. The one
edit that never needed judgement — `.rn-iso/` in `.gitignore` — is now
SELF-ENSURED by the commands that create the directory
(`ensureWorkspaceIgnored` in `src/engine/workspace.js`, called by `start`,
`ios` and `android`), which is what removed the setup step rather than moving
it.

State lives in `~/.rn-iso/config.json`, keyed by absolute project path, plus
per-workspace `<root>/.rn-iso/state.json` (the supervisor record, the collector
records, and `lastBuild`). The `RN_ISO_HOME` env var redirects the global half
for tests.

Both of those JSON files are multi-writer, and **both read-modify-writes are
locked** with the same primitive: `src/dir-lock.js` (`withDirLock`), an atomic
`mkdir` + mtime-stale-takeover advisory lock, reentrant per lock path. The
global config uses it as `withConfigLock` (lock at `~/.rn-iso/config.lock`);
state.json uses it as `withWorkspaceStateLock` in `src/supervisor/run.js` (lock
at `<root>/.rn-iso/state.lock`), which every state writer -- the supervisor, the
two collectors, and `ios`/`android`'s `lastBuild` -- inherits by going through
`writeWorkspaceState`. mtime staleness is correct for these because the writes
are milliseconds long; a lock a process holds for _minutes_ (a build) must use
pid-liveness instead (`src/engine/build-lock.js`), never this.

## Architecture conventions

- **ESM only, in `packages/rn-iso`.** `"type": "module"`, no transpiler, Node
  20+ directly. No CommonJS, no `require()`. **The documented exception is the
  two cache packages** (`packages/expo-build-cache`, `packages/metro`):
  they are CJS on purpose, because a `metro.config.js` and an Expo build-cache
  provider are both loaded by `require()`. **They do not import rn-iso at
  all** — they self-register by writing `<config dir>/caches.json` directly.
  The history is why: they used to reach rn-iso through a dynamic
  `import('rn-iso/cache-manifest')`, because a plain `require()` of an ESM
  module throws `ERR_REQUIRE_ESM` on Node before 20.19, which silently turned
  registration into a no-op on every one of those versions. Writing the
  manifest file directly removes the dependency instead of guarding it. Keep it
  that way: rn-iso is an optional peer, and a missing or old one must never
  break a bundler config or a build. `rn-iso/cache-manifest` still exists as a
  public export for consumers that DO have rn-iso -- and, since the `cache
register` / `forget` / `list` verbs were removed, the ONLY way to register a
  cache by hand; it is simply not how these two packages do it.
  `@rn-iso/metro` carries a second export for the same reason it is CJS:
  `ndjsonReporter` is `require()`d by whoever hosts Metro programmatically, and
  it imports nothing from rn-iso either.
- **Single exec wrapper.** All `child_process` calls go through
  `src/exec.js` (`getExecutor()`). Tests inject a mock via `setExecutor()`.
  Anywhere outside `exec.js` that imports `child_process` directly is a bug.
  It offers `run(cmd)` (shell), `runQuiet(cmd)` (shell, null on failure),
  `runFile(file, args)` (argv array, no shell) and `spawn`. Use `runFile`
  whenever an argument is a path the user chose rather than a string this
  codebase composed — `storeBuild` copies a caller-supplied `.app` path that
  way, so a space or a quote in it reaches `cp` as one literal argument.
- **Pure parsing/decision logic separate from invocation.** Functions like
  `parseSimctlList`, `parseAdbDevices`, `pickDefaultIosCreation`,
  `pickDefaultSystemImage`, `parseXcodeMajor`, `buildCacheKey`,
  `findOrphanedDevices`, and `buildFacts` are pure and unit-tested; the I/O
  wrappers around them (the actual `simctl`/`avdmanager`/`adb`/`xcodebuild`
  calls) are thin.
- **Config writes are locked and atomic.** Every mutator in `src/config.js`
  runs its read-modify-write inside `withConfigLock()` and lands via
  `saveConfig`'s write-temp-then-rename. Several rn-iso commands genuinely do
  run at once (a `worktree create` per agent, each followed by its own
  `start` and `ios`), and two interleaving unlocked writes lose one side's
  device record. Add new
  state-touching code inside the lock, not beside it. Port reservation follows
  the same rule from the other end: `claimMetroPort` writes only if the config
  still shows the port unclaimed, and `reserveMetroPort` re-allocates when it
  does not, so two parallel `start` runs cannot both take a port they both
  probed as free. And `loadConfig` THROWS on unparseable JSON rather than resetting —
  the file holds the record of every device rn-iso owns, so a silent reset
  would orphan all of them and hand `gc --delete` a machine full of live
  environments to destroy.
- **ASCII in source files.** No em dashes, smart quotes, or check marks in any
  package's `src/`, `bin/`, `test/`, or `index.js`. Markdown files (the
  READMEs, the SKILLs, this file) may use them. The hooks have flagged this
  before.

## File layout

The repo is an npm workspace. Everything published lives under `packages/`,
and the root holds only the workspace manifest and these docs.

```
packages/rn-iso/          # the CLI. ESM, Node 20+.
  bin/cli.js              # commander entry, registers each command module
  src/
    exec.js               # mockable child_process wrapper (run / runQuiet / runFile / spawn)
    config.js             # config CRUD under a lockfile, device records, atomic writes,
                          # claimMetroPort, layered settings storage
    settings.js           # layered settings resolution (project > repo > committed .rn-iso.json)
                          # plus KNOWN_SETTINGS / unknownSettingKeys, which is what warns about a
                          # key rn-iso stopped reading
    project.js            # project root walk, bundle-id detection (incl. native fallbacks), shortcut resolution
    ports.js              # Metro port allocation, reclamation, and race-safe reservation
    metro.js              # port-to-process identity (resolveProjectMetro) and group killing
    ndjson.js             # Contract 1: the log record. LEVELS/SOURCES, the parser, and
                          # createNdjsonWriter (writing never throws; drops are counted)
    logs-query.js         # reading the timeline back: k-way merge over <logs>/*.ndjson,
                          # recordMatches / queryLogs / followLogs, and the --errors
                          # marker window
    worktree.js           # git worktree add/remove/list, base-ref resolution, carry-over.
                          # `.rn-iso/` is excluded from carry-over unconditionally, at any depth
                          # (isWorkspaceArtifact); `.worktreeexclude` only ADDS to that list
    fs-util.js            # volume utilities (volumeRootFor, isRealMount, listMountedVolumes,
                          # isOnMountedVolume) and sizing (directorySize, formatBytes)
    paths.js              # every path rn-iso writes: workspace-local under <root>/.rn-iso,
                          # shared caches under getConfigDir(). Pure, no I/O.
    status.js             # pure shaping of the cross-project state `status` prints
    teardown.js           # THE owned-device teardown: resolve -> occupancy -> shutdown -> delete,
                          # with containment. Used by reclaim, stop, gc.
    reclaim.js            # shared reclaim-a-project logic (used by gc and worktree remove):
                          # frees Metro/port, and -- with deleteOwnedDevices -- tears down
                          # owned devices via teardown.js
    caches.js             # shared-cache discovery (Xcode CAS, Metro file maps, declared paths),
                          # sizing, and entry-level pruning at a cache's entriesDepth
    cache-manifest.js     # the registry caches write to describe themselves. Exported to other
                          # packages as `rn-iso/cache-manifest`; changing its shape is a public
                          # API change.
    build-cache.js        # the CLI-side build cache: key derivation, resolve/store, self-registration
    doctor.js             # the checks behind `doctor` -- each a pure function of the text it is given
    sim/
      ios.js              # simctl wrappers, owned-sim creation/selection, ownership verification
      android.js          # adb/emulator/avdmanager wrappers, owned-AVD creation/selection
    engine/               # the reimplemented build operations. Pure decision logic separated
                          # from invocation throughout; every module is injectable, so the
                          # commands' own tests are about ORDER and OUTPUT, not about xcodebuild.
      device.js           # ensureOwnedDevice (the ownership rule, item 2) + ensureBooted (the
                          # wait `simctl install` needs). No path here touches hardware.
      workspace.js        # ensureWorkspaceIgnored: the `.rn-iso/` gitignore entry, self-ensured
                          # by start / ios / android. Idempotent and content-based (`/.rn-iso`,
                          # `.rn-iso` and `.rn-iso/` are ONE entry to git), creates the file when
                          # there is none, and reports an unwritable .gitignore rather than
                          # throwing -- no dev server dies over a read-only checkout
      prebuild.js         # `expo prebuild -p <p> --no-install`, only when the native dir is absent
      deps.js             # podsAreStale (pure: Podfile.lock vs Pods/Manifest.lock) + runPodInstall
      xcode.js            # discoverXcodeProject / listSchemes / buildIos: xcodebuild into
                          # <ws>/.rn-iso/derived-data, transcript streamed to the build log
      gradle.js           # buildAndroid: ./gradlew assembleDebug, apk located by output listing
      errors-xcode.js     # PURE: transcript -> {file, line, message} diagnostics, deduped, capped
      errors-gradle.js    # the same for gradle/kotlin/aapt failures
      build-lock.js       # SINGLE-FLIGHT builds: when both cache levels miss, one workspace
                          # takes an atomic mkdir lock on <platform, cacheKey> and compiles
                          # while the others waitForBuild and install its artifact. Staleness
                          # is PID-LIVENESS, never mtime -- a 20-minute hold is normal here
      app-install.js      # artifact -> device: simctl install/launch, adb install -r + am start,
                          # and Contract 6's port wiring (RCT_jsLocation / dev-client deep link /
                          # `adb reverse tcp:8081 tcp:<port>`). The port is NEVER baked into a build.
    collector/            # the detached device-log collectors (Contract 5)
      run.js              # the entry point: registers under state.json.collectors, unregisters
                          # on SIGTERM, writes Contract-1 records to device.ndjson
      ios.js  android.js  # PURE line parsers for `simctl log stream --style ndjson` / `adb logcat`
    supervisor/
      run.js              # the detached per-workspace supervisor: writes its records BEFORE
                          # serving, no silent exit path, plus the state.json/pid helpers
      server-bare.js      # bare RN: hosts Metro in-process from the PROJECT's node_modules
                          # and attaches @rn-iso/metro's ndjsonReporter
      server-expo.js      # expo: spawns the project's own `expo start --port N` and parses
                          # its stdout into records (levels inferred, raw: true)
      errors.js           # {code, message, remedy}; separate so server-*.js never imports
                          # run.js back (that cycle deadlocked the first live run)
    commands/           # one file per registered command; bin/cli.js registers them in
                        # lifecycle order, which is the order `--help` lists them
      doctor.js           # print the findings from src/doctor.js
      worktree.js         # worktree create/remove (there is no `list`; `status` covers it)
      start.js            # spawn the detached supervisor, wait for identity-verified health
      stop.js             # the inverse of start: supervisor halted, collectors reaped, owned
                          # device shut down (never deleted), port freed. Identity-verified,
                          # non-destructive
      ios.js  android.js  # ORCHESTRATION ONLY over engine/: device -> metro gate -> fingerprint
                          # -> cache/build -> install -> launch -> collector. THE ORDER IS THE
                          # PRODUCT: the metro gate runs before the boot and before any build
                          # work, so a dead port costs a second rather than four minutes
      logs.js             # query/follow the merged NDJSON timeline; empty result is exit 0
      status.js
      gc.js               # report/reclaim dead project entries, orphaned devices and STALE DEVICE
                          # RECORDS (a live project pointing at a sim/AVD that is gone -- the
                          # mirror image of an orphan, and the one `status` warned about forever
                          # with nothing able to clear it; --delete clears the RECORD only), and
                          # report the shared caches (every run; there is no --caches flag)
      guide.js            # version-matched reference topics, printed by the binary
  test/
    *.test.js             # `node --test` (no framework)
  skill/
    SKILL.md              # the always-on agent skill: how to drive the CLI
    rn-iso-init/SKILL.md  # the task-shaped skill: making a repo fast for parallel agents

packages/expo-build-cache/  # @rn-iso/expo-build-cache. CJS (see conventions above).
  index.js                  # the Expo build-cache provider: resolveBuildCache / uploadBuildCache
packages/metro/             # @rn-iso/metro. CJS (see conventions above).
  index.js                  # sharedCacheStores(): a FileStore outside any project, self-registered.
                            # ndjsonReporter(): Metro's events as NDJSON records, for whoever hosts
                            # Metro programmatically -- both CLIs discard a config-set reporter
  test/reporter.test.js     # `node --test`, CommonJS like the package it tests
```

The two cache packages duplicate a little of `src/build-cache.js` and
`src/paths.js` on purpose: they must work with no rn-iso installed, so neither
may import either module. Two pieces matter, and both fail the same silent way.

- **`buildCacheKey`** — both entry points build the key the same way, so they
  address the same entries.
- **The cache ROOT resolution** — `sharedBuildCache()` / `sharedMetroCache()` in
  `src/paths.js`, repeated in each package's own `configDir()` / `cacheRoot()`.
  The precedence is `RN_ISO_BUILD_CACHE` / `RN_ISO_METRO_CACHE` first, then
  `RN_ISO_HOME` (or `~/.rn-iso`) plus `build-cache` / `metro-cache`.

Change one copy and you must change all of them, or the CLI and the provider
quietly stop sharing a cache: one stores a build in a directory the other never
looks in, and neither says so. `test/cache-packages.test.js` is the only thing
holding the three implementations together — it asserts the packages resolve
exactly what `src/paths.js` does, with and without the env overrides.

## Particularities to remember

### 1. Update `skill/SKILL.md` whenever user-facing behavior changes

The skill is what installed AI agents read to learn how to use the CLI. When
you add a command, change a flag, change picker UX, or alter defaults — open
`skill/SKILL.md` and update the relevant section in the same change. Quick
checklist:

- New command? It goes in the "Command surface" list, which is pinned by
  `test/guide.test.js` against `bin/cli.js` -- a command registered and not
  listed fails the suite, and a DELETED command must be recorded as gone in the
  same list (that test asserts the surface says "no `init`" the same way it says
  "no `up`").
- New / changed flag? Update "The flow" if it changes the order, and
  `guide lifecycle`'s option-surface block, which is pinned against the
  command sources the same way. Growing the surface at all is a decision the
  spec argues against; make it deliberately.
- Behavior change (e.g., a new `--json` field, a new destructive side effect)?
  Update both the relevant section and "When things go wrong".

Two skills ship in the package, installed with `npx skills`:
`skill/SKILL.md` (how to drive the CLI) and `skill/rn-iso-init/SKILL.md`
(how to make a repo fast for parallel agents). The second one is the whole
of repo setup -- it is a PLAYBOOK an agent applies by hand, not a description of
a command -- so a change to caching or to `doctor` belongs there, not in the
first.
Staleness breaks agent guidance, and the copy on a user's machine is a
plain file copy that upgrading rn-iso does not refresh.

### 2. The ownership rule

Every simulator or emulator rn-iso uses is one **rn-iso created**, named
`rn-iso-<label>`, recorded with `owned: true` in config. rn-iso never
allocates, boots, or destroys a device it did not create. Teardown of the
owning project (`worktree remove`, or `gc` sweeping an orphan) destroys the
device it owns, not just a claim on it.

**The rule now has no carve-out.** It used to read "the one exception is
physical devices: hardware cannot be spawned" — v3 deleted `--serial` and all
physical support (spec: "Out of scope"), so every device rn-iso touches is one
rn-iso created, and `teardown.js` lost its unowned branch. A legacy record
naming a serial is reported once in `engine/device.js` and falls through to
creating an owned emulator; nothing is ever issued at that serial. When
resolving ambiguity here, fail toward creating an owned emulator, never toward
touching hardware. (`parseAdbDevices` still buckets physical serials — it is a
faithful parse of `adb devices`, and a connected phone has to land somewhere
that is not `emulators`. Nothing consumes that bucket, and nothing may.)

The record is the only thing that makes a device findable again, so it
outlives a failed teardown: when a delete fails, the command reports it, keeps
the assignment, and exits 1. Clearing the record there is what turns a failed
teardown into a simulator nothing references and nothing will ever reap.

History: this replaces an earlier invariant, "never auto-create
simulators," which existed because early auto-creation accumulated junk
sims. That was really a symptom of creation _without_ a reaper — there was
no command that ever destroyed a device rn-iso had booted for you. The
reaper now exists (`worktree remove`, `gc`'s orphan sweep), so
creating a device and guaranteeing its eventual destruction is no longer
the same hazard. Ownership is also stronger than the old claim model: it's
provable (name prefix + config record), where claims and occupancy probes
were heuristics about other people's processes. When you touch
device-selection or device-teardown logic, preserve this rule: create only
`rn-iso-<label>`-named devices, verify that prefix before any destructive
command, and never touch a device rn-iso didn't create.

### 3. Reimplementation, not reconstruction — and the option surface does not grow

**The rule that is still load-bearing:** rn-iso must never RECONSTRUCT a command
line that already exists in the project. That is what v1 did — the deleted
`runner.js` inferred and rebuilt a build command, and every inference could be
wrong, silently. The concrete failure that settled it: on `member-app`, whose
own start script is `react-native start --client-logs`, rn-iso spawned
`react-native start --port 8082` and silently dropped the project's flag.

For two releases the conclusion drawn from that was "rn-iso is a broker and
invokes no project tooling at all" (0.7.0 deleted build dispatch, 0.8.0 deleted
bundler spawning, 0.9.0 deleted `worktree create`'s install pipeline).

**v3 amends that conclusion for BOTH halves — the dev server and the build.**
The reasoning was right about reconstruction and does not carry against
REIMPLEMENTATION. `start` hosts a bare RN project's Metro in-process from the
project's own `node_modules`, and for Expo runs `expo start --port <n>` and
NOTHING else, ever. `ios` / `android` drive `xcodebuild` / `gradlew` directly
with a fixed argument list this codebase composes, never one it inferred from a
package.json script. Nothing reads `scripts.start` or `scripts.ios`; when v3's
`init` templates stopped needing to, `bundlerCommand` / `runCommandFor` /
`detectPackageManager` were deleted outright — and `init` itself followed them
when the templates it was left holding turned out to be judgement calls rather
than files.

**What replaces the broker rule as the guard is the OPTION SURFACE.** It is
fixed and it does not grow:

    start           --json --wait
    ios / android   --json --no-metro-check
    logs            --source --level --since --grep --tail --follow --errors --json
    stop            --json --force

`--client-logs` is the archetype of what is deleted rather than ported: capture
is unconditional, and a queryable file has no terminal noise to manage. Release
builds, variants, device targets and `--serial` are all out of scope for the
same reason. A project needing something outside this set wraps rn-iso in a
script of its own — one the repo writes and owns, since rn-iso no longer
generates one.

`--base` is the counter-example worth remembering: it accepted only the two
sentinels `fresh` and `head`, and widening it to any ref `git rev-parse`
resolves is NOT the surface growing. The flag already existed, the plumbing
already passed the resolved ref to `git worktree add`, and the enum was refusing
inputs it could have accepted. Removing an arbitrary restriction on an existing
option is not the same move as adding an option.

`worktree create` still runs NO install pipeline. Deciding a repo's setup
commands -- a plain install, a workspace filter, a codegen step after it -- is
still reconstruction, and is still refused. `--carry-ignored` clones the
dependencies instead of guessing how to produce them.

### 4. Owned-device teardown is centralized and ownership-verified

`src/teardown.js` is the ONE implementation: `teardownOwnedIosSim(udid, {
del, label })` and `teardownOwnedAvd(avdName, { del })`. Every site
that touches an owned device — `reclaim.js` (and through it `gc` and
`worktree remove`), `commands/stop.js`, and `gc.js`'s orphan sweep — calls one
of them. Until 0.10.0 this file said reclaim.js was "the one place" while
admitting three others re-implemented the pattern inline; both could not be
true, and the copies had begun to drift. Do not add another copy.

The invariants it enforces, in order: (1) re-resolve the device against the
_live_ sim/AVD list immediately before issuing any command at it
(`resolveOwnedIosSim` / `resolveOwnedAvdSerial`) — a udid whose sim was
renamed away from the `rn-iso-` prefix, or already deleted, must never be
shut down, only reported as a skip; issuing shutdown first and only catching
the mismatch at delete time would already have hit whatever real simulator
that udid resolves to. (2) Check occupancy (`isSimOccupied`, iOS only —
Android has no probe) **only when the device will survive**, i.e. `del` is
false. Occupancy exists to spare a device you are coming back to, so
`stop` honours it. A device being deleted is going away regardless: it is
one rn-iso created, for a project that is going away, and the process holding
it is almost always the caller's own UI-test runner. Skipping there leaked
booted sims and live `xcodebuild test-without-building` runners out of
`worktree remove`, and "left for a later gc" only deferred the same decision
to a command that made it the same way. So there is no override flag on the
delete path at all: `worktree remove --force` overrides the DIRTY-TREE guard,
not the occupancy one, because there is nothing left for it to override.
(3) Only then shut down, and delete only when `del` is set (`stop` never
deletes). (4) Contain
failures: a throw becomes `{ status: 'failed' }`, never an exception that
aborts a batch (`worktree remove` reaping several nested projects, `gc`
sweeping many orphans).

Outcomes are `torn-down` / `missing` / `skipped` / `failed`; skips carry a
`kind` (`'not-owned'` or `'occupied'`) so callers branch on data rather than
matching on prose — `stop` reports those two cases differently.

Project paths that no longer exist on disk are handled by `gc`,
not by device selection: a deleted worktree's Metro port is reclaimable
(`findReclaimablePort` in `ports.js` only ever reclaims dead-path
projects — removing a live project's entry would drop its device claim)
and its owned devices are swept by `gc`'s orphan-device check
(`findOrphanedDevices`) once nothing references them. Caveat carried over
from the old claim model: a project on an unmounted volume looks "dead" by
a plain existence check; local worktrees are the supported case, and both
`gc` and `findReclaimablePort` fail closed on an unmounted volume (see item 8).

### 5. `RN_ISO_HOME` is the test redirect

All config + log paths derive from `getConfigDir()`, which respects
`RN_ISO_HOME`. Every config-touching test does:

```js
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});
```

If you add new state-touching code, follow this pattern.

### 6. `findProjectRoot` uses `realpath`

So symlinked worktrees collapse to the same canonical key as the
non-symlinked path. Don't add code that compares paths without
canonicalizing first.

### 7. `worktree create`'s stdout contract

Claude Code's `WorktreeCreate` hook uses whatever the hook command writes to
stdout as the directory for the new session — and only that. So
`registerCreate` in `src/commands/worktree.js` prints the worktree's
absolute path to stdout and NOTHING else: every status line, carry-over
notice and warning goes to `console.error` (stderr) instead. If you touch
this command, keep every new `console.log` off the success path.

The same reasoning applies to a non-zero exit: it would make the hook treat
worktree creation itself as failed and abort the session, when the worktree
exists and is usable. Only a failure to produce a worktree belongs on that
path.

The same one-thing-on-stdout discipline runs through every `--json` command
for a related reason: `start`, `ios`, `android`, `logs --json` and `stop --json`
each put exactly ONE parseable payload on stdout and send every progress line,
warning and phase line to stderr, so a caller can capture the payload with
`$(...)` while still watching a four-minute build. (The deleted
`build-cache resolve` had the same contract; it is gone, but the rule outlived
it.)

### 8. The unmounted-volume guard always fails closed

What the guard protects is the **project registry**: `findReclaimablePort` in
`src/ports.js` and the dead-project sweep in `src/commands/gc.js` both resolve
ambiguity toward NOT deleting. A project whose path no longer exists on disk
looks dead — but if it lives on a volume that simply is not mounted right now
(this machine's repos live on an external SSD that gets unplugged), it is not
actually gone, and dropping its entry takes its Metro port AND its device claim
with it, leaving an owned simulator nothing references and nothing will ever
reap. Any point where the check cannot get a definite answer — an unmounted
volume, an unresolvable symlinked ancestor — leaves the entry alone. Preserve
that direction if you touch this code: on doubt, skip, don't delete.

(This item used to open by naming `classifyDerivedData` in `src/artifacts.js`.
That function and that file are gone — build output is workspace-local now, so
there is no global DerivedData directory left to reverse-map to a workspace.
The registry half of the guard did not go with it.)

### 9. Live-verify anything that touches a real dev-tool artifact

A mocked `exec` proves your code called the right function with the right
arguments; it cannot prove those arguments form a command `simctl`,
`avdmanager`, or `git` actually accepts. Three separate bugs shipped on the
worktree/gc branch this way — wrong shell command, right-shaped mock — and
the fix each time was the same: run the real command once. Standing
convention: any command whose input is a real Xcode, git, or Android
artifact (a `simctl create`/`delete`, an `avdmanager create avd`, a `git
worktree add`, an `adb reverse`) must be exercised at least once against
the real tool, either as a `node --test` case that shells out for real
(see the `unpushedCommits`/`carryOverFiles`/`addWorktree` "against a real
repo" tests for the pattern) or as a manual verification recorded in the
change's report. Mocked-executor tests remain the bulk of the suite and
are still required for the logic around the real call — this item is
about not treating them as sufficient on their own for anything that
shells out to a real toolchain.

Resolved gotcha, worth not re-learning (2026-08-19): iOS live verification
was blocked for days by what was recorded as a "wedged simdiskimaged". That
diagnosis was wrong. `simctl` does not hang; it fails fast. The real cause
was that `~/Library/Developer/CoreSimulator/Devices` had been symlinked to
`/Volumes/ExternalSSD/CoreSimulator-Devices`, and `CoreSimulatorService` is
a launchd job, which TCC denies on `/Volumes/*`. Every `simctl create` died
with "Device was allocated but was stuck in creation state" and `simctl
list devices` reported zero devices, because `device_set.plist` could not
be written.

The discriminator is TCC attribution, not uid or file mode: a
Terminal-descended shell inherits a user-approved grant for the external
volume, a launchd job has none and can never prompt for one. Confirm that
class of failure in one command, no System Settings needed:

```sh
launchctl submit -l probe -- /bin/sh -c \
  'touch /Volumes/<vol>/<path>/.p || echo DENIED'
```

It is denied while the same write from your shell succeeds. Adding the
daemon binaries to Full Disk Access by hand does NOT fix it — that was
tried, with a service restart, and the EPERM was identical. The fix was
moving the device set back to the internal disk, where a launchd job writes
fine. General rule for this machine: source and build artifacts on the
external SSD are fine because you reach them through Terminal-descended
tools; anything a launchd-run daemon owns must live on the internal disk.

Always wrap `simctl` in `timeout` regardless, so a future regression cannot
wedge a session.

## Local development

The repo root is the npm workspace. Install and test from there:

```bash
npm install         # one-time, from the repo root; installs every package
npm test            # from the repo root: runs the rn-iso suite
```

Root `npm test` runs every workspace suite in turn — `rn-iso`, then
`@rn-iso/expo-build-cache`, then `@rn-iso/metro` — each of them
`node --test test/*.test.js`. The two ecosystem packages test only what is
theirs alone (self-registration, the NDJSON reporter); `buildCacheKey`'s rules
and the cache-root resolution are covered on the CLI side
(`src/build-cache.js`, `test/cache-packages.test.js`), so a change to either
copy of them still needs the CLI suite run and the other copy read.

Linking is per package, so it happens inside the package directory:

```bash
cd packages/rn-iso && npm link    # symlink rn-iso onto your PATH for live testing
```

After `npm link`, edits to `packages/rn-iso/src/` are picked up immediately by
the linked `rn-iso` command.

## Releases

See [`RELEASE.md`](./RELEASE.md) for the version-bump / tag / GitHub-release /
`npm publish` workflow. Follow it as written — the steps are ordered so a
failure mid-flow leaves the repo recoverable.

## Commit conventions

- GPG signing is NOT configured on this machine — there is no signing key
  set up, so a plain `git commit` produces an unsigned commit, and that is
  correct. Don't pass `--no-gpg-sign` (there is nothing to suppress) and
  don't try to force signing (`-S`) — it fails with no key configured.
- Conventional-style prefixes are used (`feat:`, `fix:`, `docs:`,
  `chore:`, `revert:`). Keep titles under ~70 chars; details in the body.
- One commit per logical change. The post-install removal and the
  script-based runner came in as separate commits even though they shipped
  in the same session.

## Opt-in concurrency limits (1.1.0)

rn-iso imposes no limits by default -- an unset cap is exactly the prior
behaviour. Two MACHINE-level caps (a top-level `concurrency: {maxBuilds,
maxDevices}` in `~/.rn-iso/config.json`, resolved by `getConcurrencyLimits` in
`src/config.js`, with `RN_ISO_MAX_BUILDS`/`RN_ISO_MAX_DEVICES` overriding; 0 or
absent = no enforcement) rein in a machine that cannot host as many parallel
builds or booted sims as there are agents.

- **`maxBuilds`** is an N-ary build-SLOT semaphore (`src/engine/build-slots.js`,
  `~/.rn-iso/build-slots/slot-{0..N-1}`, acquire-any by atomic mkdir,
  **pid-liveness** staleness like `build-lock.js` -- a slot is held for a whole
  build). Acquired AFTER the single-flight dedup (a waiter installing another
  workspace's artifact must not consume a slot) and released process.exit-safe,
  exactly as the build lock is, in `commands/ios.js` / `commands/android.js`. A
  full slate WAITS.
- **`maxDevices`** caps booted owned devices. `deviceCapacityRefusal` /
  `checkDeviceCapacity` in `src/engine/device.js` count live rn-iso-owned
  devices (booted `rn-iso-` sims + running owned AVDs via the registry) at
  device-ensure time and REFUSE a new one with `RN_ISO_AT_CAPACITY` -- it does
  NOT queue (interactive-shaped). A workspace whose own device is already booted
  is never refused (idempotent).

`doctor` prints one note (caps + live count) only when a cap is set; `gc`
reports and `--delete` clears stale build slots like stale build locks. There is
NO config CLI (removed in v3) -- these are set via `config.json` + env only, and
documented in `guide` (settings/errors/lifecycle) and the two skills.

## Things explicitly out of scope (for now)

- Per-device locking / mutex. The premise is still dedicated sims; the 1.1.0
  `maxDevices` cap is an opt-in COUNT limit that refuses a new boot over the
  cap, not a mutex serialising access to any one device.
- Auto-shutdown of sims after N hours of inactivity.
- Cross-platform support beyond macOS (iOS) + macOS/Linux (Android).
- Multi-app projects (one repo, multiple Expo apps via `--variant`).
- A daemon or TUI dashboard.

If a request edges into these, raise it instead of building it.
