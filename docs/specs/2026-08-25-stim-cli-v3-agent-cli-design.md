# stim-cli v3 — the RN / Expo CLI for AI agents

Date: 2026-08-25
Status: draft
Supersedes: `2026-08-20-metro-handoff-design.md` (partially — see "Reversing the
metro handoff" below). Amends `2026-08-16-spawn-and-reap-broker-design.md`.

## Purpose

The React Native and Expo CLIs are built for a human at a terminal. That shows
up everywhere in their surface: interactive device pickers, TTY progress bars,
ephemeral colored output, and a long tail of flags whose only job is to manage
terminal noise. An AI agent driving a build loop has close to the opposite
needs — never prompt, print little, capture everything, expose state as data,
and let long-running things run in the background where they can be polled.

stim-cli v2 answered part of this by becoming a pure _broker_: it arbitrates the
two genuinely contended resources on a machine (an owned simulator/emulator and
a Metro port) and refuses to invoke project tooling. That was the right call
against the alternative available at the time, which was reconstructing other
people's command lines. It leaves the agent to run the bundler and the build by
hand, which is where most of the remaining friction and most of the token cost
now live.

v3 takes the other road: stim-cli reimplements the operations an agent needs —
`start`, `ios`, `android`, `logs` — with a deliberately small option surface,
optimized end to end for an agent loop rather than a terminal.

## Reversing the metro handoff

The 2026-08-20 spec deleted `start` and `logs`, on this reasoning: _how to
invoke a project's tooling is project-specific judgment, and encoding it
centrally means perpetually chasing idiosyncrasies._ The evidence was concrete
— on `member-app`, whose own start script is `react-native start
--client-logs`, stim-cli composed `react-native start --port 8082` and silently
dropped the project's flag.

That reasoning was correct about **reconstruction** and is not load-bearing
against **reimplementation**. v1 failed because it tried to infer and rebuild a
command line that already existed elsewhere; any inference it made could be
wrong, and silently. v3 infers nothing. It implements the operation directly
with a fixed, small set of options, and a project needing something outside
that set composes it in an npm script that wraps stim-cli, rather than stim-cli
guessing at the project.

The `--client-logs` example is the clearest illustration of why the option
surface shrinks rather than grows. That flag exists in the RN CLI because
forwarding client logs to a human's terminal is noisy; `metro-config` defaults
`server.forwardClientLogs` to `true` and the RN CLI turns it _off_ unless the
flag is passed. v3's destination is always a queryable file, so noise costs
nothing and the flag has no reason to exist: client logs are captured
unconditionally. A large fraction of both CLIs' options are in this category
and are deleted wholesale, not reimplemented.

What does **not** change is the broker principle for contended resources. Ports
and devices still need an arbiter, for exactly the reasons the spawn-and-reap
spec gave. v3 keeps that machinery essentially intact and builds on top of it.

## Design principles

These are the "for agents" claim, stated concretely enough to be violated.

1. **Never interactive.** No prompt, ever, under any condition. Ambiguity is a
   structured error with a remedy, not a picker. The `prompts` dependency is
   removed from the package.
2. **Small stdout, complete files.** Every command prints on the order of ten
   lines of outcome. Bundler, xcodebuild and gradle output goes to a log file
   referenced by path. A failing build prints the _extracted_ error, not four
   thousand lines of transcript.
3. **Capture is unconditional.** Nothing is ephemeral. Every flag that exists
   to control terminal verbosity is deleted rather than ported.
4. **`--json` everywhere**, with a stable documented schema.
5. **Idempotent and resumable.** Running a command twice does the right thing:
   `start` against a healthy supervisor is a no-op exit 0; `ios` against an
   unchanged fingerprint installs from cache.
6. **Semantic exit codes and structured errors.** Every failure carries
   `{code, message, remedy}`.
7. **Blocking is opt-in.** Long-running operations return immediately;
   `--follow` / `--wait` is always explicit.

## Artifact layout

The organizing rule:

> **Runtime state and content-addressed artifacts are global.**

```
~/.stim-cli/workspaces/<project>--<digest>/ # global workspace state
  derived-data/                      # -derivedDataPath for THIS checkout
  gradle-build/                      # android build dirs, .cxx
  logs/
    metro.ndjson  client.ndjson  device.ndjson  build-{ios,android}.ndjson
  supervisor.pid
  state.json                         # last build, fingerprint, cache result

~/.stim-cli/                           # machine-wide state and caches
  config.json                        # the broker registry (unchanged from v2)
  metro-cache/                       # transform cache (exists today)
  build-cache/<platform>/<key>/      # .app/.apk by fingerprint (exists today)
  compilation-cache/                 # COMPILATION_CACHE_CAS_PATH (LLVM CAS)
  gradle/                            # dependency cache
  pods/                              # CocoaPods cache + spec repo
```

### Why this deletes code

stim-cli today carries `src/artifacts.js` (~350 lines) plus the unmounted-volume
guard recorded as item 8 in `CLAUDE.md`, and effectively all of it exists to
answer one question: _which workspace owns this
`~/Library/Developer/Xcode/DerivedData/<hash>`, and is that workspace actually
gone or merely on an unplugged volume?_ Directing DerivedData into the worktree
via `-derivedDataPath` dissolves the question. Build output is inside the thing
being removed, so `worktree remove` reclaims it definitionally, and no
classifier has to guess. The orphaned-artifact sweep goes, and with it
`classifyDerivedData`, `listDerivedDataEntries`, `findOrphanedDerivedData` and
`findDerivedDataFor`.

**The mounted-volume guard does not go with it**, and the first draft of this
spec was wrong to say so. It protects two different things. Guarding
_DerivedData classification_ becomes unnecessary, because there is no longer a
global directory to reverse-map to a workspace. Guarding the _project registry_
does not: `findReclaimablePort` in `ports.js` still must not reclaim the port of
a project whose volume is merely unplugged, since that removes the whole entry
and drops its device claim. `isOnMountedVolume`, `listMountedVolumes`,
`volumeRootFor` and `isRealMount` therefore stay. So do `directorySize` and
`formatBytes`, which are generic and used by the cache reporting.

What `artifacts.js` gets is a split, not a deletion: the volume and size
utilities move to `src/fs-util.js`, and the DerivedData half is removed.

### Two interactions that must be got right

- **`init` must add generated entries to `.worktreeexclude`.**
  Missing the second means `worktree create --carry-ignored` clones another
  workspace's DerivedData, logs and pidfile into the new worktree — strictly
  worse than starting cold.
- **The supervisor pidfile is workspace-local, but a record of it stays
  global.** `~/.stim-cli/config.json` records that a workspace has a supervisor
  at pid N, or deleting a worktree out from under a running supervisor orphans
  a Metro process nothing can find. Same shape as the existing device records,
  and it keeps the existing reapers working.

### Compilation caching, not ccache

v3 supports Xcode compilation caching (`COMPILATION_CACHE_ENABLE_CACHING`,
LLVM CAS) and drops ccache support entirely. `doctor.js` already records the
decisive reason: ccache keys on absolute paths, so it misses across worktrees —
which makes it not merely redundant for this tool but wrong. Dropping it also
removes the mutual-exclusion check, since the ccache launcher script disables
the explicitly-built modules that compilation caching requires.

This interacts with the layout above and must be handled explicitly: **the
default CAS path is inside DerivedData.** Redirecting DerivedData into the
worktree would drag the CAS in with it, making it per-worktree and sharing
nothing — defeating the only reason to enable it. v3 therefore pins
`COMPILATION_CACHE_CAS_PATH` to `~/.stim-cli/compilation-cache/`. `doctor`
already flags this exact misconfiguration.

## Architecture

Three layers, with the existing code concentrated in the first.

### 1. Broker — kept from v2, largely unchanged

`config.js` (locked, atomic writes), `ports.js` (race-safe reservation),
`sim/ios.js` + `sim/android.js` (owned-device lifecycle), `worktree.js`,
`teardown.js`, `reclaim.js`, `caches.js`, `build-cache.js`, `cache-manifest.js`.
This code is battle-tested and its invariants carry forward verbatim — in
particular the ownership rule and centralized, ownership-verified teardown.

One simplification falls out of dropping physical-device support (below): the
ownership rule loses its only carve-out. Today `CLAUDE.md` item 2 reads _"the
one exception is physical devices: hardware cannot be spawned."_ With `--serial`
gone, **every device v3 touches is one v3 created**, and teardown loses its
unowned branch entirely.

### 2. Engine — new

The reimplemented operations, each a narrow module with pure decision logic
separated from invocation, following the existing convention:

```
src/engine/
  server/         bare.js  expo.js        # dev server hosting per ecosystem
  build/          ios.js  android.js      # xcodebuild / gradle orchestration
  deps.js                                 # pod install / gradle sync staleness
  prebuild.js                             # CNG native project generation
  install.js  launch.js                   # artifact -> device
  errors/         xcode.js  gradle.js     # transcript -> structured diagnostics
```

### 3. Supervisor — new

One detached process per workspace. It hosts the dev server, runs the
device-log collectors, writes the NDJSON streams, and exposes state through the
pidfile plus a control socket. It is not a machine-wide daemon: there is no
cross-project supervisor, no IPC beyond the workspace, and no service to
install or upgrade.

## Dependency strategy

v3 depends on **neither** ecosystem's packages. It resolves them from the
project's own `node_modules` at runtime, via
`createRequire(join(projectRoot, 'package.json'))` — the pattern
`loadFingerprinter()` in `src/build-cache.js` already uses for
`@expo/fingerprint`, generalized.

Every Expo project already has `@expo/cli` through `expo`; every bare RN
project already has `metro`, `@react-native/dev-middleware` and
`@react-native-community/cli-server-api`. So this costs nothing to install, and
more importantly it is **version-matched by construction**: v3 drives the exact
Metro the project builds with. A plugin package (`@stim-cli/plugin-expo`) could
only pin one version, and would drift from any project on a different SDK — the
decisive argument against that alternative, given that an SDK 53 and an SDK 55
project routinely share a machine.

The consequence is that v3's own dependency list gets _shorter_ than v2's:
`commander` and `chalk`, with `prompts` deleted under principle 1.

## Dev server hosting

The two ecosystems are not symmetric, and pretending otherwise is the main way
this design could fail.

**Bare RN** is thin. `runServer.js` in `@react-native/community-cli-plugin` is
roughly sixty lines over `Metro.runServer` plus `createDevMiddleware` and the
community middleware. v3's supervisor hosts it **in-process**, which buys
deterministic shutdown, no wrapper process in the tree, and direct port
binding.

**Expo is protocol-bearing and cannot be rehosted.** Its dev server also serves
`ManifestMiddleware`, `ExpoGoManifestHandlerMiddleware`,
`InterstitialPageMiddleware`, `DevToolsPluginMiddleware`, expo-router route
serving and DOM components. Those _are_ the protocol `expo-dev-client` speaks;
reimplementing them is forking Expo, not trimming fluff. Expo also exposes no
reporter-injection hook — there is no `customLogReporterPath` equivalent.

**v3 therefore spawns the project's own `expo start --port N` as a child**, and
passes nothing else. This is the pragmatic starting point: it works on every
SDK, adds no imports, and is measured in production before anything more
invasive is attempted. Hosting Expo in-process by deep-importing
`MetroBundlerDevServer` remains a possible later optimization; it is explicitly
deferred, because those are unversioned build artifacts of an internal TS
module and would break across SDK releases with no semver signal. If it is ever
adopted, the child-spawn path stays as the fallback.

Crucially, spawning costs nothing in log fidelity, because of the next section.

## The log pipeline

**Correction (2026-08-25, verified against both CLIs' source):** an earlier
draft made the reporter a project-side `metro.config.js` plugin, on the theory
that it would capture logs no matter who started the server. That is wrong.
Both CLIs **discard** a config-set reporter: Expo's `instantiateMetro.ts`
force-overrides `config.reporter` after loading the config, and RN's
`runServer.js` assigns `metroConfig.reporter` unconditionally. A reporter wired
into `metro.config.js` only survives when Metro is hosted programmatically.

So capture follows the hosting split rather than fighting it:

- **Bare RN:** the supervisor hosts Metro in-process and sets the NDJSON
  reporter itself. Full structure — reporter events, `client_log` records via
  `forwardClientLogs`, symbolication.
- **Expo:** the supervisor parses its `expo start` child's stdout into NDJSON
  records. Expo prints bundle progress and forwarded client logs to stdout, so
  the content is there; the structure is inferred (level from the line's
  prefix) rather than native. This is the accepted cost of shelling out, and
  in-process hosting remains the recorded upgrade path if it proves too lossy.

The `ndjsonReporter` implementation ships in `@stim-cli/metro` (the existing
`@stim-cli/metro-cache` renamed, still CJS, now with a second export) so the
supervisor and any project hosting Metro programmatically share one
implementation. `init` does not wire it into `metro.config.js` — that would
imply a capture path that does not exist.

Three sources normalize into one timeline of `{ts, src, level, ...}` records:

- **Bundler and client** — from the reporter. Because
  `server.forwardClientLogs` defaults to `true` and v3 never disables it,
  in-app `console.log` and redboxes arrive through the same channel as bundle
  progress and transform errors. Stacks are symbolicated through Metro's
  `/symbolicate` at capture time, so they point at source rather than bundle
  offsets.
- **Device native** — `xcrun simctl spawn <udid> log stream --style ndjson`
  predicated on the app's bundle id; `adb -s <serial> logcat` filtered to the
  app process. Filtered at the source, so the stream is the app's output rather
  than the whole system's.
- **Build** — xcodebuild and gradle transcripts, with diagnostics extracted
  into structured records by `engine/errors/`.

### Known risk

`runServer.js` carries a TODO for replacing Metro log forwarding.
Client-log forwarding through the reporter is slated for replacement by
CDP-based logging via the inspector proxy. This is a dated, concrete risk to
the client-log source specifically; the mitigation is that
`engine/server/bare.js` and the reporter package are the only places that would
change, and the inspector proxy exposes the same events through
`DeviceEventReporter`.

## Command surface

```
stim-cli init | doctor
stim-cli worktree create | remove
stim-cli start | stop
stim-cli ios | android
stim-cli logs [--source --level --since --grep --tail --follow --errors]
stim-cli status [--all]
stim-cli gc [--delete] [--older-than <days>]
```

Eleven entry points against v2's twenty-two. Two removals are consolidations
rather than lost capability, and both are recorded below: `worktree list`, and
the `cache` sub-verbs. `guide` and `skill install` carry over unchanged and are
not counted here; `config`, `build-cache` and `up` are gone, the first folded
into settings files and the latter two into `ios`/`android`.

### `start`

Reserves or reuses the workspace's Metro port, spawns the detached supervisor,
waits for the server to answer `/status` with `packager-status:running` _and_
to verify as this project's (v2's `resolveProjectMetro` identity check, not a
bare probe), then exits 0 printing the facts. A foreign holder of the reserved
port triggers re-reservation, as in v2. If a healthy supervisor already exists,
`start` is a no-op exit 0. On failure to come up it exits non-zero with the
extracted startup error and the log path — not the whole transcript.

There is no `start --stop`: `stop` is its own command, below.

### `ios` / `android`

```
ensure owned device booted
  -> verify Metro holds the reserved port      (fail fast — see below)
  -> fingerprint (@expo/fingerprint)
  -> cache hit? install cached artifact, skip the build entirely
  -> miss: prebuild if native dir absent
           sync pods / gradle if stale
           build
           store in build cache
  -> install -> launch
  -> attach the device-log collector
```

Per the metro handoff spec, these **never start the bundler**. But if no
healthy Metro holds the reserved port, `ios` fails immediately with
`STIM_CLI_NO_METRO` rather than spending four minutes producing an app that
cannot load a bundle; `--no-metro-check` overrides. Failing at second zero is
worth more to an agent loop than tolerance here.

Fingerprinting before prebuild is correct and deliberate: `@expo/fingerprint`
hashes config and dependencies on a CNG project, not the generated native
directory, so the cache is consulted before any generation cost is paid.

Note the `pod install` interaction already documented in `SKILL.md`: it rewrites
tracked files (`Podfile.lock`, `project.pbxproj`), which is what makes a later
`worktree remove` refuse. That refusal is correct and must not be softened.

### `logs`

Queries the merged NDJSON timeline. Non-blocking by default (principle 7);
`--follow` streams. `--errors` returns the structured error set since the most recent
app reload or build, whichever is later — redboxes with symbolicated stacks, Metro resolution failures, native
crashes — which is the query an agent loop actually issues.

### `status`

One payload: supervisor pid and health, reserved port, device udid/serial and
state, last build (fingerprint, cache hit or miss, duration), log paths, and
error counts since the last build. `--all` reports every workspace on the
machine.

### `stop`

The inverse of `start`, and named to say so. It halts the supervisor, shuts the
owned device down, and frees the port. **It is not destructive and takes no
flags**: the device survives shut down and stays assigned, so returning to the
branch costs a boot rather than a create, a provision and a reinstall.

This follows from a rule the whole surface obeys:

> **Destruction lives in exactly two commands — `worktree remove` and
> `gc --delete` — and `stop` is never one of them.**

`worktree remove` destroys the workspace you name; `gc --delete` sweeps the
machine. A verb that reads as the undo of `start` must not destroy a simulator
at all, even behind a flag: an agent reaching for `stop` to reclaim memory
should not have a `--delete` within reach of a typo. This also collapses v2's
`shutdown`-versus-`release` pair, with the destructive half moving to the two
commands that own destruction rather than becoming an option here.

`stop` takes no path and acts on the current workspace. Being non-destructive,
it is subject to no uncommitted-changes guard: `src/commands/worktree.js`
records that `pod install` rewrites `Podfile.lock` and `project.pbxproj` "so
this refusal fires after almost every iOS build", and a guard on `stop` would
therefore refuse in precisely the case it exists for — a dirty tree, mid-work,
on a machine short of memory.

### `worktree remove`

`stop`, then reap the owned device through `src/teardown.js`, then remove the
git worktree. Defaults to the current workspace. This is the destructive
teardown path: it is where deleting a device lives.

The uncommitted-changes guard and `--force` live here and only here, because
this is the only command that destroys source. On the main checkout it refuses
with a remedy naming `stop` (to release) and `gc --delete` (to reap); git's own model makes that coherent,
since `git worktree list` reports the main checkout as entry zero, which is why
`src/status.js` does `.slice(1)`.

### `status`, and why there is no `worktree list`

v2 shipped both, and `worktree list`'s own description reads "`stim-cli status`
shows the same worktrees WITH their environments -- prefer it." A command whose
purpose is to redirect to another command does not survive into v3. `status`
already reports unprovisioned worktrees (`unprovisionedWorktrees` in
`src/status.js`), so nothing is lost. Repo scoping, if wanted, is
`status --repo` — a flag, not a command.

### `gc`

An earlier draft replaced `gc` with `cache` / `cache trim`. That was wrong, and
planning caught it: **build artifacts are not the only thing that orphans.** A
project directory deleted by hand leaves a registry entry, a reserved port and
an owned simulator behind, and with `prune` and `up` gone there would be nothing
left on the machine that reaps them. Those are not caches and do not belong
under a `cache` verb.

So `gc` survives, narrowed to what is still real:

- **`gc`** reports, and is always safe: dead project entries, orphaned owned
  devices (`findOrphanedDevices`), and the shared caches under `~/.stim-cli/`
  with their sizes and age distribution.
- **`gc --delete [--older-than <days>]`** acts. `--older-than` trims cache
  entries by age; caches that index their own data — the LLVM CAS — are
  whole-or-nothing and say so rather than silently ignoring the flag. It also
  reaps owned devices belonging to projects untouched for `--older-than` days.

That last clause closes the gap left by `stop` having no `--delete`. A checkout
that is not a worktree cannot be `worktree remove`d, so without it the main
checkout's simulator would be shut down but never reaped, accumulating one per
project indefinitely. Sweeping stale devices is machine hygiene, which is
already what `gc` is for — and it keeps destruction in two commands rather than
three.

What `gc` _loses_ is the DerivedData sweep and its mounted-volume ambiguity,
which the artifact layout made unnecessary. v2's `cache register` / `forget` /
`list` verbs collapse into `gc`'s report, since v3 prescribes the cache paths.
`stim-cli/cache-manifest` survives as a **programmatic** export, because that is
how `@stim-cli/metro` and `build-cache.js` self-register. Only the CLI verbs go.

### `init` / `doctor`

`init` wires the repo: the reporter and shared cache stores into
`metro.config.js`, the build-cache provider, `COMPILATION_CACHE_ENABLE_CACHING`
with a CAS path outside DerivedData, DerivedData redirection into
the generated workspace exclusions into `.worktreeexclude`.
`doctor` reports the same findings read-only, plus the resolved server adapter
and its version, so an ecosystem mismatch is visible before a build hits it.

## Worked example: an agent fixing a bug ticket

_APP-412 — "Tapping Save on the profile screen crashes on iOS."_ This is the
path every command has to justify itself against.

### Once per repo, not per ticket

```
$ stim-cli doctor
  compilation caching   OFF          costs ~4m per cold native build
  metro cache           per-project  each worktree re-transforms the graph
  build cache provider  absent
  server adapter        expo 54.0.1 (child process)

$ stim-cli init
  wrote  metro.config.js       reporter + sharedCacheStores
  wrote  ios/Podfile           COMPILATION_CACHE_ENABLE_CACHING, CAS -> ~/.stim-cli
```

`doctor` is the read-only half and `init` the writing half of one question:
what is silently costing build time? Splitting them matters because an agent
must be able to _inspect_ a repo it does not own without modifying it.

### The ticket

```
$ cd "$(stim-cli worktree create app-412)"
```

Isolation, so this ticket cannot collide with whatever else is on the machine.
stdout is the path and nothing else — the `WorktreeCreate` hook contract from
`CLAUDE.md` item 7. On APFS, `--carry-ignored` clones `node_modules` and
`ios/Pods` instead of reinstalling them.

```
$ stim-cli start
  port       8082 (reserved)
  supervisor pid 41233
  logs       ~/.stim-cli/workspaces/app--<digest>/logs/
```

Reserves a collision-free port, spawns the detached supervisor, waits until the
server both answers `/status` **and** verifies as this project's, then exits.
The agent gets its shell back — no backgrounding idiom, no `sleep`, no poll
loop, and no chance of building against another worktree's bundler.

```
$ stim-cli ios
  device      stim-cli-app-412 (BF2A..) booted
  fingerprint a3f9b1.. hit
  install     from cache (3.1s)
  launch      com.example.app
```

The fingerprint is unchanged from a build another workspace already did, so
**nothing compiles**. This is the payoff of the shared build cache: the second
workspace on a commit costs a simulator boot, not four minutes of xcodebuild.

```
$ stim-cli logs --errors --json
{"ts":"..","src":"client","level":"fatal",
 "message":"TypeError: Cannot read property 'id' of undefined",
 "stack":[{"file":"src/screens/Profile.tsx","line":142,"fn":"onSave"}]}
```

The crash, symbolicated to a source file and line, from the merged timeline.
The agent did not have to attach a debugger, scrape a terminal, or know that
client logs and bundler logs come from different places. **This is the command
the whole design exists to make possible** — everything upstream is
infrastructure for it.

The agent edits `Profile.tsx`. Fast Refresh applies it; no stim-cli command is
involved, because editing JS is not an stim-cli concern.

```
$ stim-cli logs --since 30s --level error
  (no matching records)
```

Empty is the pass condition. Note it exits rather than streaming — principle 7.

### Teardown

```
$ stim-cli stop                           # supervisor down, sim shut down, port freed
$ stim-cli worktree remove                # done with the branch entirely
```

### The other commands, and what invokes them

Every remaining entry point earns its place on a path this happy sequence never
touches:

| Command                                | Invoked when                                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stim-cli status`                      | Session start, to orient: what is already running on this machine, which ports and devices are taken, is anything wedged. Also the answer to "the build is slow" — it reports RAM over-commitment and tight disk, the two causes nothing else surfaces. |
| `stim-cli status --all`                | Several agents share the Mac and one needs to know whether it is the fourth environment on a 16 GB box.                                                                                                                                                 |
| `stim-cli android`                     | The same ticket on the other platform, or a bug that only reproduces there.                                                                                                                                                                             |
| `stim-cli logs --source device`        | A native crash that never reached JS, so `--errors` on the client stream is empty but `logcat` / `simctl log stream` is not.                                                                                                                            |
| `stim-cli logs --follow`               | Watching a manual reproduction in real time rather than querying after.                                                                                                                                                                                 |
| `stim-cli gc`                          | Disk is filling, or a machine has accumulated environments from deleted checkouts. Reports dead entries, orphaned devices and cache sizes.                                                                                                              |
| `stim-cli gc --delete --older-than 14` | Reclaim without destroying the working set. Emptying costs every project on the machine its next build; trimming costs only what nothing has used.                                                                                                      |
| `stim-cli stop`                        | Reclaim ~1.5 GB from a branch you are not finished with, or release the main checkout, which `worktree remove` cannot act on.                                                                                                                           |
| `stim-cli doctor`                      | After an SDK upgrade, or when builds are unexpectedly slow — it names the cause instead of leaving the agent to guess.                                                                                                                                  |

### The failure paths, which are where the design earns its keep

```
$ stim-cli ios                                   # supervisor never came up
  error  STIM_CLI_NO_METRO: no Metro server holds reserved port 8082.
  remedy Run `stim-cli start` first, or pass --no-metro-check.
```

Two seconds, not four minutes followed by an app that cannot load a bundle.

```
$ stim-cli ios                                   # native change, cache miss
  fingerprint 7c02de.. miss
  pods        out of sync with Podfile.lock -> installed (18s)
  build       FAILED after 2m41s
  error       ios/App/AppDelegate.swift:42:8: cannot find 'Foo' in scope
  log         ~/.stim-cli/workspaces/app--<digest>/logs/build-ios.ndjson
```

Six lines and the actual compiler diagnostic. `expo run:ios` emits several
thousand lines here, and the agent pays for all of them on success as well as
failure. The full transcript is still on disk when it is wanted — which is
rarely, and never as tokens.

## Error contract

```json
{
  "code": "STIM_CLI_NO_METRO",
  "message": "No Metro server holds reserved port 8082.",
  "remedy": "Run `stim-cli start` first, or pass --no-metro-check."
}
```

Codes are stable identifiers an agent can branch on. Every refusal in the CLI
carries one, and `guide errors` enumerates them — extending the existing
convention of branching on data rather than matching prose.

## Out of scope

- **Release / configurable-variant builds.** Debug only. `buildCacheKey`
  retains its variant field for forward compatibility, but no release path
  ships. This removes Android signing configuration entirely.
- **Physical devices, both platforms.** `--serial` is deleted along with
  physical Android support; physical iOS was never supported and code signing
  has no agent-loop payoff. This is what removes the ownership carve-out.
- **ccache.**
- **A machine-wide daemon or TUI dashboard.** The supervisor is per-workspace.
- **Web / `expo start --web`.**
- **Locking or mutexes around device usage.** The premise remains dedicated
  devices per workspace.

## Implementation sequencing

This spec is deliberately larger than one implementation plan. It decomposes
into four, each independently shippable and each leaving the CLI in a working
state:

1. **Layout and teardown.** Global workspace state, DerivedData redirection, the
   CAS path pin, `init`/`doctor` updates, `.worktreeexclude` wiring. Deletes
   `artifacts.js`, the mounted-volume guard, and top-level `gc`. Ships against
   the v2 command surface with no new commands, and is worth having on its own.
2. **Supervisor and logs.** `@stim-cli/metro` reporter, the NDJSON streams,
   `start`, `stop`, `logs`, `status`. Bare RN in-process, Expo by child
   process. This is where the agent-facing value concentrates.
3. **`ios`.** Device provisioning folded in, fingerprint cache gate, prebuild,
   pod staleness, xcodebuild orchestration, diagnostic extraction, install and
   launch.
4. **`android`.** The same shape over gradle and adb.

Order matters: 2 depends on 1 for its log paths, and 3 and 4 depend on 2 for
the metro-port check and the build-log destination. Steps 3 and 4 are
independent of each other.

The v2 command removals (`up`, `device`, `release`, `stop`, `shutdown`,
`prune`, `worktree list`, the `cache` sub-verbs, `--serial`) land with
step 3, not before — the broker surface has to stay
usable until the build path that replaces it actually works.

## Risks

1. **Reimplementing xcodebuild and gradle orchestration is the bulk of the
   work** and where defects will concentrate. Mitigated by the existing
   convention (`CLAUDE.md` item 9) that anything touching a real toolchain
   artifact must be live-verified, not merely mock-tested — a mocked executor
   proves the right call was made, never that the toolchain accepts it.
2. **Version matrix across RN 0.7x–0.8x and Expo SDK 51+.** Mitigated by
   runtime resolution from the project (no pinning), a `compatibility.json`, and
   a fresh-init CI matrix, nightly or label-gated. Reanimated is the only real
   prior art for this shape and its approach is the model.
3. **Metro internals used by `engine/server/bare.js`** (`Metro.runServer`,
   `unstable_extraMiddleware`) are semi-private. Contained to one file, with the
   child-spawn path available as a fallback there too.
4. **Client-log forwarding deprecation** (T214991636), above.

## Testing strategy

- Pure decision logic (fingerprint keying, staleness detection, diagnostic
  extraction, log query filtering) unit-tested under `node --test`, following
  the existing split between pure functions and thin I/O wrappers.
- `STIM_CLI_HOME` continues to redirect all state for tests.
- A fixture matrix of real projects — bare RN, Expo CNG, Expo with committed
  native dirs, a monorepo — exercised end to end against real toolchains, since
  item 9 applies to every new engine module.
- Diagnostic extraction tested against recorded real xcodebuild and gradle
  failure transcripts.

## Open questions

None blocking. Two deferred decisions are recorded above rather than resolved:
whether to eventually host Expo in-process by deep import, and how to migrate
the client-log source when T214991636 lands.
