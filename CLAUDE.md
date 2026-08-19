# rn-iso — agent guide

Quick orientation for AI assistants working in this repo.

## What this is

A Node.js CLI that acts as an environment broker for React Native / Expo:
`rn-iso up <platform>` creates (or reuses) an **owned** simulator/emulator and
a managed Metro server for the current project (or git worktree), then prints
the facts — UDID/serial, port, bundle id — so an agent can run the project's
own build against them. rn-iso itself never builds or installs anything. The
lifecycle is `worktree create` -> `up <platform> --json` -> agent runs the
project's build -> work -> `worktree remove` (which reaps the owned
device(s) along with the worktree).

State lives in `~/.rn-iso/config.json`, keyed by absolute project path. The
`RN_ISO_HOME` env var redirects this for tests.

## Architecture conventions

- **ESM only.** `"type": "module"`, no transpiler, Node 20+ directly. No
  CommonJS, no `require()`.
- **Single exec wrapper.** All `child_process` calls go through
  `src/exec.js` (`getExecutor()`). Tests inject a mock via `setExecutor()`.
  Anywhere outside `exec.js` that imports `child_process` directly is a bug.
- **Pure parsing/decision logic separate from invocation.** Functions like
  `parseSimctlList`, `parseAdbDevices`, `pickDefaultIosCreation`,
  `pickDefaultSystemImage`, `releaseAction`, `findOrphanedDevices`, and
  `buildFacts` are pure and unit-tested; the I/O wrappers around them (the
  actual `simctl`/`avdmanager`/`adb` calls) are thin.
- **ASCII in source files.** No em dashes, smart quotes, or check marks in
  `src/`, `bin/`, `test/`. Markdown files (README, SKILL, this file) may use
  them. The hooks have flagged this before.

## File layout

```
bin/cli.js              # commander entry, registers each command module
src/
  exec.js               # mockable child_process wrapper
  config.js             # config CRUD, device records, setup status
  settings.js           # layered settings resolution (project > repo > committed .rn-iso.json)
  project.js            # project root walk, bundle-id detection (incl. native fallbacks), shortcut resolution
  ports.js              # Metro port allocation + reclamation
  runner.js             # package-manager detection (walks up for monorepos); survives solely
                         # as the worktree install-pipeline default now that build dispatch is gone
  metro.js              # detached Metro spawn, PID + log lifecycle
  worktree.js           # git worktree add/remove/list, base-ref resolution, carry-over
  artifacts.js          # Xcode DerivedData discovery/classification, mounted-volume detection
  reclaim.js            # shared reclaim-a-project logic (used by prune, gc, worktree remove,
                         # release, shutdown): frees Metro/port, and -- with
                         # deleteOwnedDevices -- shuts down + deletes owned devices
  sim/
    ios.js              # simctl wrappers, owned-sim creation/selection, ownership verification
    android.js          # adb/emulator/avdmanager wrappers, owned-AVD creation/selection
  commands/
    up.js                 # the broker command: ensure owned device + Metro + port, print facts
    device.js              # read-only facts query, no ensure side effects
    start.js stop.js logs.js
    status.js
    release.js shutdown.js prune.js
    worktree.js          # worktree create/remove/list
    gc.js                 # report/reclaim orphaned build artifacts, dead project entries, orphaned devices
    config.js              # per-project / repo settings CRUD
test/
  *.test.js             # `node --test` (no framework)
skill/SKILL.md          # the agent-facing skill
```

## Particularities to remember

### 1. Update `skill/SKILL.md` whenever user-facing behavior changes

The skill is what installed AI agents read to learn how to use the CLI. When
you add a command, change a flag, change picker UX, or alter defaults — open
`skill/SKILL.md` and update the relevant section in the same change. Quick
checklist:

- New command? Add it under "Other useful commands" or its own section if
  meaty (like `worktree` or `gc`).
- New / changed flag on `up`? Update "The env lifecycle" and the facts
  contract / common-setups table if the flag matters for non-interactive
  agent use.
- Behavior change (e.g., a new `up --json` field, a new destructive
  side effect)? Update both the relevant section and "When things go wrong".

The skill is shipped to users via the `npx skills add janicduplessis/rn-iso`
line in the README; staleness breaks agent guidance.

### 2. The ownership rule

Every simulator or emulator rn-iso uses is one **rn-iso created**, named
`rn-iso-<label>`, recorded with `owned: true` in config. rn-iso never
allocates, boots, or destroys a device it did not create. Teardown of the
owning project (`release`, `worktree remove`, or `gc` sweeping an orphan)
destroys the device it owns, not just a claim on it. The one exception is
physical devices: hardware cannot be spawned, so a physical Android device
is still assigned by serial and never booted/shut down/deleted by rn-iso.

History: this replaces an earlier invariant, "never auto-create
simulators," which existed because early auto-creation accumulated junk
sims. That was really a symptom of creation *without* a reaper — there was
no command that ever destroyed a device rn-iso had booted for you. The
reaper now exists (`release`, `worktree remove`, `gc`'s orphan sweep), so
creating a device and guaranteeing its eventual destruction is no longer
the same hazard. Ownership is also stronger than the old claim model: it's
provable (name prefix + config record), where claims and occupancy probes
were heuristics about other people's processes. When you touch
device-selection or device-teardown logic, preserve this rule: create only
`rn-iso-<label>`-named devices, verify that prefix before any destructive
command, and never touch a device rn-iso didn't create.

### 3. `up` is a broker, never a build wrapper

`commands/up.js` ensures an owned device, a Metro port, and managed Metro,
then prints the facts (`buildFacts`) and stops. It never runs `expo
run:ios` / `react-native run-android` or any equivalent, never installs an
app, and never launches one. That judgment — which script, which CLI,
which flags a given project needs — used to live in rn-iso (`runner.js`'s
build dispatch, deleted) and was a maintenance burden that kept getting
project idiosyncrasies wrong; a coding agent has that judgment natively
from reading the repo, so the build step was handed to the caller
entirely. If you're tempted to add install/launch/verification logic to
`up` (e.g. a post-install `xcrun simctl launch` to work around some build
CLI's rough edge), don't — that belongs in the agent's own build
invocation or upstream in the build CLI, not in the broker. `up`'s only
job is: device ready, Metro ready, facts printed.

### 4. Owned-device teardown is centralized and ownership-verified

`reclaim.js`'s `reclaimOwnedDevices` (invoked via `reclaimProject(path, {
deleteOwnedDevices: true })`) is the one place that shuts down and deletes
owned devices; `release.js`, `shutdown.js`, and `gc.js` each re-implement
the same three-step pattern inline for their own call sites, and all three
must stay consistent with it. The pattern, in order: (1) re-resolve the
device against the *live* sim/AVD list immediately before issuing any
command at it (`resolveOwnedIosSim`) — a udid whose sim was renamed away
from the `rn-iso-` prefix, or already deleted, must never be shut down,
only reported as a skip; issuing shutdown first and only catching the
mismatch at delete time would already have hit whatever real simulator
that udid resolves to. (2) Check occupancy (`isSimOccupied`, iOS only —
Android has no probe) — a foreign UI-test runner may still be attached to
an owned sim, so an occupied one is left running and reported as skipped;
`release --force` is the only override across these call sites (`gc` and
`shutdown` have none, and simply leave it for a later `gc` run). (3) Only then shut down and
delete. Each device's teardown is wrapped in its own try/catch so one bad
record or exec throw can't abort a batch operation (`worktree remove`
reaping several nested projects, `gc` sweeping many orphans). If you add a
new device-deleting call site, follow this same order — don't skip the
live re-resolve step because "the record should still be accurate."

Project paths that no longer exist on disk are handled by `prune`/`gc`,
not by device selection: a deleted worktree's Metro port is reclaimable
(`findReclaimablePort` in `ports.js` only ever reclaims dead-path
projects — removing a live project's entry would drop its device claim)
and its owned devices are swept by `gc`'s orphan-device check
(`findOrphanedDevices`) once nothing references them. Caveat carried over
from the old claim model: a project on an unmounted volume looks "dead" by
a plain existence check; local worktrees are the supported case, and both
`gc` and `prune` fail closed on an unmounted volume (see item 8).

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
notice, and setup-pipeline failure goes to `console.error` (stderr)
instead. It also exits 0 even when the setup pipeline fails — a non-zero
exit here would make the hook treat worktree creation itself as failed and
abort the session, when really the worktree exists and is usable, just
maybe not buildable yet (the failure is recorded via `setSetupStatus` and
surfaced later by `worktree list` and in `up --json`'s `setup` field). If you touch this
command, keep every new `console.log` off the success path and never turn
a setup failure into a non-zero exit.

### 8. The unmounted-volume guard always fails closed

`classifyDerivedData` (`src/artifacts.js`) and the dead-project sweep in
`src/commands/gc.js` both resolve ambiguity toward NOT deleting. A
DerivedData entry whose `WorkspacePath` no longer exists on disk looks
orphaned — but if it lives on a volume that simply is not mounted right
now (this machine's repos live on an external SSD that gets unplugged), it
is not actually gone, and deleting it would destroy live build output. Any
point where the classifier cannot get a definite answer — an unmounted
volume, an unreadable `info.plist`, an unresolvable symlinked ancestor —
routes the entry into `skipped`, never `orphaned`. Preserve that direction
if you touch this code: on doubt, skip, don't delete.

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

```bash
npm install         # one-time
npm test            # node --test test/*.test.js
npm link            # symlink rn-iso onto your PATH for live testing
```

After `npm link`, edits to `src/` are picked up immediately by the linked
`rn-iso` command.

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

## Things explicitly out of scope (for now)

- Locking / mutex around device usage. The whole premise is dedicated sims.
- Auto-shutdown of sims after N hours of inactivity.
- Cross-platform support beyond macOS (iOS) + macOS/Linux (Android).
- Multi-app projects (one repo, multiple Expo apps via `--variant`).
- A daemon or TUI dashboard.

If a request edges into these, raise it instead of building it.
