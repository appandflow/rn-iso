# Stim — spawn-and-reap ownership, broker-only commands

Date: 2026-08-16
Status: draft
Supersedes: the device-allocation model of `2026-04-25-stim-design.md` and
amends `2026-08-15-worktrees-and-cache-reclamation-design.md`. The worktree,
settings, and gc machinery from the latter is the foundation this builds on.

## Purpose

Two linked pivots, both consequences of the same shift in who Stim serves.

The original design assumed two long-lived peers — a human and an agent —
sharing one machine's fixed pool of simulators, with Stim brokering claims
so neither stepped on the other. The tool's center of gravity has moved:
agents get **disposable environments** (a worktree, created unattended, often
from a phone), work in them, and tear them down. For that consumer:

1. **Spawn-and-reap replaces claim-and-lock.** An environment _creates_ its
   simulator/emulator rather than claiming one from a shared pool. Locking
   machinery exists because resources are shared; owned resources need none.
2. **Stim becomes a pure environment broker.** The `ios`/`android` build
   wrappers encode judgment about how to build a project (which script, which
   CLI, which flags) — judgment a coding agent has natively from repo
   context. Stim stops wrapping builds and instead provisions resources and
   hands over facts. The build itself belongs to the agent.

Concrete motivators, all observed:

- Two projects sharing a claimed sim fought over the foreground during
  automated UI verification (RNTester vs. the app under test). Under
  ownership this is structurally impossible.
- The wrapper's dispatch perpetually chases project idiosyncrasies (a
  monorepo whose `android` script bakes in `--variant=productionDebug`;
  a repo with `expo` in deps that builds with the RN CLI). An agent reads
  `package.json` and just knows.
- The pool caps concurrency at the number of pre-existing sims and
  accumulates every project's app data on shared devices.

## The ownership rule

> Every simulator or emulator Stim uses is one Stim created, named
> `stim-<label>`, recorded with `owned: true` in config. Stim never
> allocates, boots, or destroys a device it did not create. Teardown of the
> owner destroys the resource.

This replaces CLAUDE.md invariant 2 ("never auto-create simulators"). That
invariant existed because early auto-creation accumulated junk sims — a
symptom of creation **without a reaper**. The reaper now exists (`worktree
remove`, `release`, `gc`); creation with guaranteed destruction is not the
same hazard. The rewritten invariant is stronger than the old one: ownership
is provable (name prefix + config record), where claims and occupancy probes
were heuristics about other people's processes.

The rule also simplifies the safety story: Stim cannot stomp a foreign
tool's simulator because it never touches devices it didn't create.
Occupancy detection (the `.xctrunner` probe) survives, demoted from primary
mechanism to a guard: even owned-sim shutdown/delete checks it first, since
an external tool may legitimately be driving an stim-owned sim.

**The one exception: physical devices.** Hardware cannot be spawned.
Serial-based assignment survives only for physical Android devices, and is
documented as the exception it is.

## Command surface

### `stim up <ios|android> [--json] [--device-type <name>] [--runtime <ver>]`

The single "make my environment ready" command, replacing the `ios` /
`android` build wrappers. It:

1. Resolves the project (walk up from cwd, as today) and the layered
   settings (`resolveSettings` — every command now consumes the full
   project > repo > committed chain, closing the gap where only
   `worktree create` used it).
2. Ensures an owned device: reuse the recorded one (boot if shut down), or
   **create** one — newest iPhone device type on the newest installed
   runtime by default; overridable via flags or the `ios.deviceType` /
   `ios.runtime` / `android.systemImage` settings keys. Android creates an
   AVD via `avdmanager create avd` against the newest installed arm64
   system image, erroring with instructions if none is installed (Stim
   still never installs system images).
3. Allocates the Metro port (unchanged logic) and ensures **managed Metro**
   is running on it — detached, PID-tracked, logged. Managed is now the
   only mode; the `--managed-metro` flag is deleted along with the wrapper
   that made it optional.
4. On Android, applies `adb reverse` for the Metro port after boot.
5. Prints the facts. `--json`:

```json
{
  "platform": "ios",
  "udid": "…",
  "metroPort": 8082,
  "metroPid": 123,
  "metroHealthy": true,
  "metroLog": "~/.stim/logs/….log",
  "bundleId": "io.tlon.groups",
  "setup": { "complete": true, "commands": [] }
}
```

Android's payload carries `serial` (`emulator-<consolePort>`), `avdName`,
and `kind: "emulator" | "physical"` in place of `udid`, matching today's
`device --json` shape.

`up` never runs a build. The agent runs the project's own build command
against these facts (see SKILL.md section below). Both expo and the RN CLI
probe the port and skip spawning a second bundler when Metro already answers
`/status`, which is what makes managed-only safe.

`stim device` remains as the read-only facts query (no ensure side
effects); `up --json` is a superset.

### Changed semantics

- **`release`** — deletes the owned device (`simctl delete` /
  `avdmanager delete avd`). Releasing an owned resource means destroying
  it; app state is disposable by definition. Occupancy-guarded, `--force`
  to override.
- **`worktree remove`** — additionally deletes the env's owned devices
  (both platforms). The env dies whole. Same occupancy guard.
- **`shutdown`** — shuts down (never deletes) owned devices; end-of-day
  semantics unchanged. Gains the occupancy guard `release --shutdown`
  already has, closing the known inconsistency.
- **`gc`** — new sweep: any `stim-*` sim or AVD not referenced by a live
  config entry is an orphan (report by default, `--delete` to act). The
  fail-closed rules apply unchanged: devices referenced by a project on an
  unmounted volume are kept.
- **`status`** — shows each project's owned devices and setup status
  (closing the open spec gap from the worktree branch).

### Deleted

- `ios` and `android` (the build wrappers)
- `reserve` / `unreserve` — their purpose was marking foreign sims as
  claimed so other projects would skip them; nothing claims anymore
- The allocation picker, `allClaimed` / take-over flow, `[claimed by …]` /
  `[in use]` UI, sim-usage tracking (`recordSimUsage` / `getSimUsage`)
- `runner.js`'s build dispatch: `detectScriptCli`, `buildIosCommand`,
  `buildAndroidCommand`, script-vs-CLI fallback. `detectPackageManager`
  survives solely as the worktree install-pipeline default
- The `ios.script` / `android.script` settings keys (nothing consumes them)
- `--managed-metro` (managed is the only mode)

## Config schema

`platforms.<p>` gains `owned: true` and `deviceName` (`stim-<label>`) on
devices Stim creates. New allocations always create owned devices. No
version bump is needed beyond v2.

## SKILL.md restructure

The skill flips from teaching the wrapper's quirks to teaching the broker
contract, and — since build judgment now lives with the agent — carries a
**common-setups reference** so that judgment has rails. The knowledge moves
from code that must be maintained (and was wrong more than once) to
reference text applied with agent judgment.

Structure:

1. **Lead with the env lifecycle** (the primary agent flow):
   `worktree create` → `up <platform> --json` → run the project's build →
   work → `worktree remove`.
2. **The facts contract:** always get UDID/serial/port from `up --json` or
   `device --json`; always pass them explicitly to build and device tools;
   never assume `booted`.
3. **Common setups reference** (a table, extended as new shapes appear):

   | Project shape                    | Build invocation                                                                                |
   | -------------------------------- | ----------------------------------------------------------------------------------------------- |
   | Expo (`expo run:ios` in scripts) | `<pm> ios -- --device <udid> --port <port>` or `npx expo run:ios --device <udid> --port <port>` |
   | Bare RN                          | `npx react-native run-ios --udid <udid> --port <port>` (older CLIs: `--simulator "<name>"`)     |
   | Expo Android                     | `npx expo run:android --device <serial> --port <port>` (adb reverse already applied by `up`)    |
   | Bare RN Android                  | `npx react-native run-android --device <serial>` with `RCT_METRO_PORT=<port>`                   |
   | Monorepo                         | run from the app directory (`apps/<app>`), not the repo root                                    |
   | Custom variants/flavors          | prefer the project's own script (it bakes in the right flags); append device/port               |

4. **Metro rules:** Metro is managed by Stim; never start your own; check
   `stim logs` first on a blank screen or red box (unchanged advice).
5. **Destructive-command rules:** unchanged (`gc --delete` and
   `worktree remove --force` require asking the user), plus: `release`
   now deletes the device — don't release an env you intend to keep using.
6. Capacity note: 2–3 live envs on a 16 GB machine; a booted sim is
   ~1–2 GB, an emulator 2–3 GB.

README leads with the broker/env framing instead of "per-project Metro
server and dedicated simulator".

## Testing

- Pure device-selection logic shrinks to "pick newest device type /
  runtime / system image" — unit-tested.
- Create/boot/delete wrappers: exec-mocked for logic, plus **live
  verification** for each real command (`simctl create/delete`,
  `avdmanager create/delete avd`, `adb reverse`) — institutionalizing the
  lesson from the worktree branch, where three separate bugs shipped
  because mocked-executor tests cannot catch a wrong shell command. Any
  command whose input is a real Xcode/git/Android artifact must be
  exercised once against the real tool in the suite or in recorded
  verification.
- `up --json`: action-level test asserting the JSON contract (single
  stdout payload, parseable, complete).
- Carried from the worktree branch's open items: an action-level test for
  `worktree create`'s stdout contract, and a real-git test for
  `unpushedCommits`.
- Sweep test: `gc` proposes only `stim-*` devices absent from config,
  and keeps devices referenced from unmounted-volume projects.

## What this does NOT change

- Port allocation, managed-Metro internals (`start`/`stop`/`logs`),
  worktree create/remove/list, settings layering, gc's artifact sweep,
  `prune`, config/labels — all as shipped on the worktree branch.
- No concurrency semaphore (documented capacity instead, unchanged
  decision).
- No system-image or runtime installation.
- The `WorktreeCreate` hook contract and machine-side wiring
  (launcher `--spawn=worktree`, hooks, `.worktreeinclude`, `.stim.json`,
  a Node version manager) — still required, still outside this spec.

## Release

Ships together with the unreleased worktree/gc branch as **0.7.0** — one
coherent "environment broker" release rather than two model changes in
sequence.

## Open questions

None. Decisions resolved during design review: full pivot (not hybrid),
both platforms now, `up <platform>` replaces the wrappers outright, skill
carries the common-setups reference.
