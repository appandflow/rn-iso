# Aggregate build and cache statistics

Date: 2026-09-02. Status: proposed. Issue: #256.

## Summary

Stim keeps one aggregate per project and platform, plus one machine-wide
aggregate, of how its native runs went: how many, how many hit the cache,
how long cold builds and hit runs take on average, and an estimate of the
time the cache saved. `stim stats` prints them. Nothing per run is stored.

## Motivation

The only persisted run data is the last run per workspace. A team that wants
to say what Stim saves them, or an agent deciding whether a cache miss is
normal for a project, has no number to point at without running a benchmark.

## Scope

In: `ios` and `android` runs, simulator, emulator, and physical device, on
this machine under one `STIM_HOME`. Out: Metro transform-cache statistics,
remote cache tiers, per-run history, and any upload.

## The record

One file, `$STIM_HOME/stats.json`, version 1:

    {
      "version": 1,
      "machine": { <bucket> },
      "projects": {
        "/canonical/root": {
          "ios": { <bucket> },
          "android": { <bucket> }
        }
      }
    }

A bucket:

    {
      "runs": 0,
      "hits": 0,
      "misses": 0,
      "failed": 0,
      "coldBuilds": 0,
      "coldBuildMs": 0,
      "hitRuns": 0,
      "hitRunMs": 0,
      "timeSavedMs": 0,
      "firstRunAt": "...",
      "lastRunAt": "..."
    }

The machine bucket is updated in lockstep with the project bucket on every
run, so removing a project from the registry or from disk never changes the
machine totals.

## Update rule

At the end of every `ios` or `android` run, on every exit path, under the
global config lock, Stim reads the file, applies one rule, and writes it back
with a temp file and rename:

1. `runs` increments. A run that exits with a failure code increments
   `failed` and nothing else.
2. A cache miss that compiled increments `misses` and `coldBuilds`, and adds
   the build phase's duration to `coldBuildMs`. A miss whose build was
   skipped (`--no-build-cache` still compiles, so it counts; a refusal before
   the build does not reach this rule) counts as a miss without a cold build.
3. A cache hit increments `hits` and `hitRuns`, adds the run's total
   duration to `hitRunMs`, and credits `timeSavedMs` with
   `max(0, coldBuildMs / coldBuilds - runDurationMs)` computed from the
   PROJECT bucket before this run's update; with no cold build recorded for
   the project and platform yet, it credits nothing. The machine bucket
   receives the same credit.
4. `firstRunAt` is set once; `lastRunAt` every run.

The estimate is a mean, and it is labelled as an estimate wherever it is
printed. A hit on a physical device saves the same compile as a hit on a
simulator; the two share a platform bucket.

A file that does not parse is renamed aside with a `.corrupt-<time>` suffix
and a fresh one started; the run itself never fails because of statistics,
and the renaming is the one message it prints.

## The command

    stim stats [--json]

Prints, for this project (when run inside one) and for the machine:

    project /path/to/app
      ios      42 runs   36 hits (86%)   cold build 4m12s avg   hit run 31s avg   saved ~2h 13m (estimated)   since 2026-09-01
      android  10 runs    7 hits (70%)   cold build 6m40s avg   hit run 48s avg   saved ~41m (estimated)     since 2026-09-01
    machine
      ios     118 runs   97 hits (82%)   ...
      android  31 runs   20 hits (65%)   ...

Outside a project it prints the machine section only. Buckets with zero runs
are omitted. `--json` prints the file's content for this project and the
machine bucket as one line (invariant 7). There is no reset flag; deleting
the file resets everything, and `gc` leaves it alone.

## Guidance deltas

`guide`: a `stats` entry in the command list and option surface, the
update rule in one paragraph (what counts as a hit, how the estimate is
made), and the file's location under the state layout. Skill: nothing, the
normal workflow does not change. AGENTS.md: the command surface sentence
gains `stats`.

## Testing

- Pure `updateStats(record, run)` over an injected clock: each rule above,
  the no-cold-build case, the failed-run case, lockstep machine totals, the
  corrupt-file rename.
- Command tests: the table for a project and the machine, the outside-project
  case, `--json` one line, zero-run buckets omitted.
- The write happens on every exit path of `ios` and `android` (success,
  `fail()`, exception) and never turns a successful run into a failure.
- Guide contract tests for the new entry.

## Decisions

| Question             | Decision                                           | Why                                                       |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Per run or aggregate | Aggregate only                                     | Maintainer's call, 2026-09-02: no run log                 |
| Scope                | Per project and machine-wide, both shown           | Both are useful: a team number and a personal one         |
| Estimate             | Mean cold build minus the hit run, floored at zero | The only estimate an aggregate allows; labelled estimated |
| Reset                | None                                               | Delete the file                                           |
