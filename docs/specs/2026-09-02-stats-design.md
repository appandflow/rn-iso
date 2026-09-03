# Aggregate build and cache statistics

Date: 2026-09-02. Status: proposed. Issue: #256.

## Summary

Stim keeps one aggregate per project and platform, plus one machine-wide
aggregate, of how its native runs went: how many, how many hit the cache,
how long cold runs and hit runs take on average, and an estimate of the time
the cache saved. `stim stats` prints them. Nothing per run is stored.

## Motivation

The only persisted run data is the last run per workspace. A team that wants
to say what Stim saves them, or an agent deciding whether a cache miss is
normal for a project, has no number to point at without running a benchmark.

## Scope

In: `ios` and `android` runs, simulator, emulator, and physical device, on
this machine under one `STIM_HOME`. Out: Metro transform-cache statistics,
remote cache tiers, per-run history, and any upload.

## The project key

The key is the app's path in the repository's main working tree:
`join(dirname(gitCommonDir), relative(repoRoot, root))` when the common dir
is a `.git` directory, otherwise the canonical project root (invariant 6).
All worktrees of one repository share a bucket, because the normal flow is a
fresh worktree hitting the cache another checkout filled; two apps in one
monorepo do not share one. The key is passed through `realpath` before use and is the path `stats`
prints.

## The record

One file, `$STIM_HOME/stats.json`, version 1:

    {
      "version": 1,
      "machine": { "ios": <bucket>, "android": <bucket> },
      "projects": {
        "<key>": { "ios": <bucket>, "android": <bucket> }
      }
    }

A bucket's fields (a bucket is created on its first run, so `firstRunAt`
is never a placeholder):

    {
      "runs": 0,
      "failed": 0,
      "hits": 0,
      "misses": 0,
      "coldRuns": 0,
      "coldRunMs": 0,
      "hitRuns": 0,
      "hitRunMs": 0,
      "timeSavedMs": 0,
      "firstRunAt": "...",
      "lastRunAt": "..."
    }

### Amendment, 2026-09-02 (issue #265)

Two optional fields join a bucket:

    "lastColdBuildMs": 190000,
    "lastPodsMs": 100000

`lastColdBuildMs` is the duration of the BUILD PHASE of the last cache miss
that compiled, and `lastPodsMs` the duration of the last `pod install`. Each
is absent until the project has done that thing once. This is still
aggregate-only: two numbers per bucket, the last value each, not a log. They
size the heartbeat of the next run (`build       still compiling (1m00s of
~3m10s)`), which is why the last value beats the mean -- a project's build
time drifts with its size, so the most recent one is the best single guess.

Milliseconds are integers. Durations come from the run's injected clock
(`d.now` on iOS, the `now` option on Android) and timestamps from
`new Date(now()).toISOString()`, so the pure update function and its tests
use one clock.

## Update rule

The run's `durationMs` is the number `ios --json`, `android --json`, and
`lastBuild` already report: wall time for the whole run. Hits and misses are
compared run to run, so install, launch, and verification time sits on both
sides and cancels in the mean; no second definition of duration exists.

1. A run is an invocation that computed a cache key. An invocation refused before that point (outside a project, an
   unpreparable workspace, a bad flag, no Metro, no device to prepare, at
   capacity) is not recorded; `fail()` records only when a cache key exists.
   A busy lease or a boot that fails after the build is a run that ends
   through `fail()`. An invocation ended by a signal is not recorded.
2. Every run increments `runs` and sets `lastRunAt`; the first sets
   `firstRunAt`.
3. A run that ends through `fail()` or an uncaught exception increments
   `failed` and nothing else. `launched: 'unverified'` or `'bundling'` is a
   success.
4. Otherwise the run's final `cacheHit` decides. `'local'` or `'remote'` is a
   hit; `false` is a miss (including a swap that fell back to a full build,
   and a Release run on a physical device, which always compiles). A miss
   increments `misses` and `coldRuns` and adds `durationMs` to `coldRunMs`. A
   hit increments `hits`; unless it waited for another workspace's build
   (`waitedForBuild` set), it also increments `hitRuns`, adds `durationMs`
   to `hitRunMs`, and credits `timeSavedMs` with
   `max(0, round(coldRunMs / coldRuns) - durationMs)` computed from the
   PROJECT bucket before this run's update. A hit that waited counts in
   `hits` and nothing else: the compile it skipped was paid for in the wait.
   With no cold run recorded for the project and platform, a hit credits
   nothing, even when the machine bucket has cold runs: compile times differ
   per project.

### Amendment, 2026-09-02 (issue #265)

5. A run that supplies a build-phase duration (a miss that compiled) sets
   `lastColdBuildMs`, and one that supplies a `pod install` duration sets
   `lastPodsMs`; a run that did neither leaves both exactly as they were. The
   machine bucket takes them in lockstep, like every other field. Both are
   written by the same recorder, in the same call, under the same lock.

Reading them is not part of the update rule: before its build, and before
`pod install`, a run reads the PROJECT bucket for its platform (the same key
rule) with a plain read and no lock. A file that is missing, unreadable, from
a newer version, or has no entry for this project yields no estimate and no
message; a statistics read never affects the run.

The machine bucket receives every increment and the same credit, so
`machine.timeSavedMs` is the sum of per-project credits and is not derivable
from the machine's own averages. Removing a project from the registry or
from disk never changes the machine bucket. Each credit uses the project's
mean cold run at that moment; the figure is an estimate and is labelled so
wherever it is printed. The hit rate is `hits / (runs - failed)`.

A physical device and a simulator share a platform bucket. A device hit
carries a re-seal and a devicectl install, so it raises the hit-run mean and
lowers only its own credit.

## Where the write happens

The recorder is injectable (`d.recordStats` in the iOS deps, an option in the
Android run options) and is called exactly once per run: inside `fail()`
before it exits, in the success reporter before any `exitAfterFlush`, and in a
`catch` around the run body for an uncaught exception, on both platforms. The
exits before workspace storage exists are not runs (rule 1). The write runs
under the global config lock: read, apply the rule, write with a temp file
and rename. Reads (`stats`) take no lock, because writes are atomic.

A statistics failure never changes the run's outcome or exit status. A file whose integer `version` is greater than 1 is left untouched and
the run records nothing. A file that does not parse, parses to something
other than an object, or has no integer `version`, is renamed aside under the same lock to `stats.json.corrupt-<unix ms>`
and a fresh one started. In every such case, and when the lock or the write
fails, the run prints one dim line to stderr, the way a failed `lastBuild`
write does, and continues.

## The command

    stim stats [--json]

Prints, for this project when run inside one and for the machine:

    project /path/to/app
      ios      42 runs (3 failed)   36 hits (92%)   cold run 4m12s avg   hit run 31s avg   saved ~2h13m (estimated)   since 2026-09-01
      android  10 runs    7 hits (70%)   cold run 6m40s avg   hit run 48s avg   saved ~41m (estimated)     since 2026-09-01
    machine
      ios     118 runs   97 hits (82%)   ...

"Inside a project" means `findProjectRoot(cwd)` found one; the project need
not be registered, and `stats` never creates `config.json`. A section with
no bucket prints `no runs recorded`; a column whose denominator is zero
prints `-`. Outside a project only the machine section prints. Durations use
a formatter with an hours unit, which `formatDuration` lacks today.

`--json` prints exactly one line:

    {"version":1,"project":{"key":"<path>","ios":<bucket|null>,"android":<bucket|null>}|null,"machine":{"ios":<bucket|null>,"android":<bucket|null>}}

`project` is `null` outside a project; a bucket that does not exist yet is
`null`. There is no reset flag; deleting the file resets everything. `gc`
leaves it alone, and `status` stays live state only.

## Guidance deltas

`guide`: `stats` in the command list and in the option surface under the
`settings` topic; the update rule in one paragraph under `facts` (what counts
as a hit, how the estimate is made, the project key); the file under the
state layout in `lifecycle`; and, beside `status`, one routing line: "what is
running" is `status`, "how much the cache saved" is `stats`. Skill: one
routing clause in the guide-routing list (the normal workflow is unchanged).
AGENTS.md: the command surface sentence gains `stats` after `status`.
Website: a `## stats` section in `commands.md` with the `--json` shape.

## Testing

- Pure `updateStats(record, run, now)`: every rule above, the waited hit,
  the no-cold-run case, the failed run, lockstep machine totals, the newer
  `version` skip, the corrupt-file rename under the lock, integer rounding.
- Command tests with `STIM_HOME` redirected: the table for a project and the
  machine, outside a project, no `config.json` present, `--json` one line
  with the exact shape, the empty section and the `-` column.
- `ios` and `android`: the injected recorder is called once on success, on
  `fail()`, and on an exception, and a throwing recorder never changes the
  exit status.
- Guide contract tests for the new entries and the routing line.

## Decisions

| Question                             | Decision                                                                      | Why                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Per run or aggregate                 | Aggregate only                                                                | Maintainer's call, 2026-09-02: no run log                           |
| Scope                                | Per project and machine-wide, both shown                                      | A team number and a personal one                                    |
| Project key                          | The app's path in the main working tree                                       | Worktrees are the normal flow and must pool; monorepo apps must not |
| What a credit compares               | Whole run to whole run                                                        | One definition of duration; install and launch cancel in the mean   |
| A hit that waited for a peer's build | Counted as a hit, no credit                                                   | The skipped compile was paid for in the wait                        |
| Estimate                             | The project's mean cold run at that moment minus the hit run, floored at zero | The only estimate an aggregate allows; labelled estimated           |
| Lock                                 | The global config lock                                                        | Short, once per run, and named by the maintainer                    |
| Corrupt file                         | Rename aside, start fresh, one dim line                                       | Data preserved; invariant 8 is about registry entries, not this     |
| Reset                                | None                                                                          | Delete the file                                                     |
