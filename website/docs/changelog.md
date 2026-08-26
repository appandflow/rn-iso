---
title: 'Changelog'
sidebar_position: 99
description: 'Release notes'
---

Full release history is on [GitHub Releases](https://github.com/appandflow/rn-iso/releases).

# 1.3.1

A patch release: everything the 1.3.0 field test and the native e2e matrix
shook out. Two groups of fixes -- the ones CI forced (rn-iso now has a
2x2 native e2e, real apps built on real simulators and emulators on GitHub
runners, and getting it green found real product bugs) -- and the diagnostics
issues the field test filed (#24, #25, #26).

## Fixes

Found by the native e2e (they bit CI first, but any Linux or Intel host hits
them):

- **Metro identity on hosts where `lsof -d cwd` answers nothing.** GitHub's
  ubuntu runners do exactly this, so a healthy dev server could never verify
  as the project's own and every `start` timed out. Linux now reads
  `/proc/<pid>/cwd` directly; lsof stays the macOS path and the fallback.
- **Android system images are picked for the host's architecture.** The
  arm64-only filter returned nothing on an x86_64 host; the pick now matches
  the machine (arm64 -> arm64-v8a, otherwise x86_64).
- **The emulator boots headless on a displayless Linux host.** Without
  `-no-window` it died in display init and never registered with adb; rn-iso
  detects the absence of DISPLAY/WAYLAND_DISPLAY rather than asking for
  configuration. A desktop session keeps its window.
- **A cold first AVD boot gets 240s** (was 120), which software rendering on a
  loaded machine genuinely needs.
- **`android` launches cache-hit builds in projects with no `android/`
  directory** by reading the package name from the APK's own manifest --
  mirroring what iOS already did with the cached app's Info.plist.

From the field-test issues:

- **#24** -- a failed `start` now quotes this attempt's error records from the
  log timeline, not just supervisor.log. In expo-child mode a dev server that
  dies on a config error (the field case: a `PluginError` from a stale
  worktree) leaves supervisor.log empty and its death cry in metro.ndjson;
  the failure used to point at the empty file.
- **#25** -- the `logs --json` zero-match contract is pinned in `guide logs`
  and the flag help: zero matches is zero bytes on stdout with exit 0 (an
  empty NDJSON stream -- parse line by line, never as one JSON document).
- **#26** -- the occupied-sim skip names only the foreign `.xctrunner`
  bundles the occupancy decider actually counted, instead of a `ps` scan that
  dragged in the sim's own runtime and the app rn-iso itself launched; the
  "current as of the last `git fetch`" note no longer prints for
  `--base head` (it only applies to `fresh`); and the 30s heartbeat now also
  covers the pod-install phase (a 2m33s `pod install` used to be silent).

## Docs

- **[Getting started](/docs/getting-started)** -- the quickest integration in
  four steps: zero-install first run, agent skills via `npx skills add
appandflow/rn-iso`, the ten-minute cache wiring, parallel worktrees. Linked
  from both READMEs.
- The lingering `npx rn-iso skill install` instructions are gone from the
  README (the command was removed in 1.3.0).
- Skill caveat: `--carry-ignored` against a base whose `.gitignore` differs
  can leave carried paths as untracked churn that `worktree remove` later,
  correctly, refuses over -- with the per-class restore commands.

# 1.3.0

Everything since v1.1.0 — the TypeScript migration (the unpublished 1.2.0 bump)
plus a hardening pass, a four-round code review, and the full field-test issue
backlog. All three packages move together, as always.

## New

- **TypeScript, end to end.** The codebase is strict TS 7 (native), bundled
  with tsdown — `rn-iso` ships ESM, the two cache packages stay deliberate
  CJS. Tests run on vitest and typecheck in the same strict pass as
  production; oxlint (`no-explicit-any` as an error) and oxfmt gate style, and
  knip gates dead code in CI.
- **Build heartbeat.** `ios` / `android` print a stderr line about every 30s
  while the compiler runs — elapsed time plus the current transcript line — so
  a five-minute build is never indistinguishable from a wedged one. stdout
  still carries exactly one `--json` payload.
- **Per-run build transcript.** `build-<platform>.ndjson` now truncates on
  each run's first write; "see the log for the transcript" always opens on
  this run. Device/metro logs still append.
- **`status --json`: `labelOnly`.** A monorepo worktree-root entry that only
  holds the label reservation is now flagged, so JSON consumers can count
  workspaces without double-counting.
- **`worktree create` staleness note.** `fresh` / `head` branch from a
  remote-tracking ref that is only as current as the last `git fetch`; the
  command now says so instead of silently building on stale code.

## Removed (breaking)

- **The `skill` command.** Bundled skills are installed with `npx skills`;
  a built-in copy-into-`~/.claude` command (and its staleness warning on
  `start`) was redundant. The surface is now ten commands.
- **Node 20.** The floor is Node >= 22 (Node 20 reaches end of life
  2026-04-30, and the toolchain runs TypeScript natively).

## Fixes

Found by a four-round adversarial code review:

- **spawn-entry** resolved its dev/dist layout by matching `/src/` anywhere in
  the module URL, so a package installed under a path containing `/src/`
  spawned a supervisor from files that do not exist. It now checks only the
  module's own parent directory.
- **Single-flight builds** could double-acquire: the stale-lock takeover did an
  unconditional `rmSync` on a stale read, so a late waiter could delete the new
  holder's fresh lock (build-lock) or over-subscribe `maxBuilds` (build-slots).
  Takeover is atomic now (`renameSync`), and `gc --delete` re-checks liveness
  right before removing a stale lock or slot.
- **`killMetroTree`** signalled the process-group leader — the shell, not
  Metro — when a backgrounded Metro shared rn-iso's own group. It now signals
  the listener pid in that case.
- **`reclaimProject`** (`worktree remove` / `gc`) never reaped device-log
  collectors the way `stop` does; a collector outliving a failed device
  teardown could resurrect a zombie `.rn-iso/` after the tree was deleted.
- **`removeWorktree`** ran a destructive `git worktree remove` through the
  shell with the path interpolated; it uses `runFile` with `--` now.
- The Expo build-cache provider guards its readdir/touch/rename against a
  concurrent prune, matching the CLI-side twin; `doctor` also reads
  `metro.config.cjs`.
- **Metro identity on Linux** reads `/proc/<pid>/cwd` directly (lsof stays the
  macOS path and the fallback): on hosts where `lsof -d cwd` returns nothing --
  GitHub's ubuntu runners do exactly this -- a healthy dev server could never
  verify as the project's own, and every `start` timed out.

From the field-test issue backlog:

- **#8** — `worktree remove` no longer counts commits inherited from a
  local-only base ref as unpushed; only commits reachable from nowhere else
  refuse removal, and the remedy is followable.
- **#9** — pod-install failures print the CocoaPods `[!]` blocks / Ruby
  exception head instead of the log tail (which held deferred warnings).
- **#13** — `logs --errors` no longer accumulates across consecutive failed
  bundles: every bundle attempt writes a marker when it finishes, success or
  failure, so only the newest failure is reported; a client redbox is never
  retired by a failed rebuild.
- **#14** — `gc`'s device sweep waits 30s (was 10s) before giving up, so
  orphaned emulators surface on a loaded machine.
- **#18** — Android tooling (`emulator`, `adb`, `avdmanager`) is resolved via
  `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `~/Library/Android/sdk` before falling
  back to `PATH`, so teardown from a shell without the SDK exported succeeds
  instead of permanently orphaning the registry entry.
- **#16** — the skill documents the private-registry `.npmrc` failure mode of
  `npx rn-iso` (E401) and the `--registry` workaround.

## Docs

- Clean-slate pass: comments and docs describe the tool as it is, without
  version archaeology; executed implementation plans removed.
