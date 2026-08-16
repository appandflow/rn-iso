# rn-iso — worktree creation and cache reclamation

Date: 2026-08-15
Status: draft

## Purpose

Two additions to rn-iso:

1. **`rn-iso worktree create|remove|list`** — create a git worktree with its
   environment set up (carry-over files, dependency install, workspace package
   build) and tear it down completely.
2. **`rn-iso gc`** — reclaim build artifacts that live *outside* a worktree and
   are therefore orphaned when the worktree is deleted.

The motivating workflow is Claude Code's `remote-control --spawn=worktree`,
which creates a worktree per session started from the phone. Today those
worktrees arrive with no dependencies, and deleting them leaks several GB of
DerivedData per worktree with nothing to reclaim it.

This widens rn-iso's remit from "device and port broker" to "dev environment
manager". That is a deliberate widening, recorded here because `CLAUDE.md` asks
that scope changes be raised rather than assumed.

## Measured baseline

All figures from tlon-apps at `origin/develop` (35a08a89d, RN 0.86.0) on an
M4 Mac mini, 16 GB, repos on an APFS USB SSD. These are the numbers the design
is calibrated against.

| Phase | Time |
|---|---|
| `git worktree add` | 0.45 s |
| `.env` carry-over (1 file) | instant |
| `pnpm install` (1544 pkgs) | 43 s |
| `npx install-skia` (skipped postinstall) | 2.5 s |
| `pnpm build:packages` | 10 s |
| **worktree ready** | **~56 s** |
| Cold native build (pod install + compile) | 423 s |
| Teardown (release + remove + DerivedData) | 55 s |

Disk, for one worktree with one complete build:

| Artifact | Size | Location | Dies with `git worktree remove`? |
|---|---|---|---|
| `node_modules` | 3.1 GB | inside worktree | yes |
| Pods, `.expo`, `android/build` | ~2 GB | inside worktree | yes |
| **DerivedData** | **4.3 GB** | **outside worktree** | **no — orphaned** |

The 4.3 GB is the entire justification for `gc`. Everything inside the worktree
already dies correctly; only the path-hashed DerivedData directory survives.

Teardown is dominated by deleting `node_modules` (44 s of 55 s). `gc` reclaims
the bytes that leak, but will never be the slow part.

## Non-goals

- **No relocation of build outputs.** We do not pass `-derivedDataPath` or
  otherwise inject build flags. Xcode's shared `ModuleCache.noindex` (3.4 GB,
  shared across projects) stays shared, and we avoid colliding with the
  "prefer the project's `ios` script" design in `runner.js`.
- **No per-worktree simulator device sets.** Device sets would force creating a
  simulator per worktree, violating the "don't auto-create simulators"
  invariant in `CLAUDE.md`. Claiming from a shared pool stays the model.
- **No sharing or deduplication of `node_modules`.** tlon-apps sets
  `node-linker=hoisted`, so pnpm does not content-address there and each
  worktree holds a real copy. Changing that is the project's call, not ours.
- **No fixing of EAS auth.** See Prerequisites.

## Architecture

### New modules

```
src/
  settings.js     # layered settings resolution
  worktree.js     # git worktree operations via exec.js
  artifacts.js    # DerivedData discovery and reclamation
  commands/
    worktree.js   # worktree create|remove|list
    gc.js         # machine-wide orphan sweep
```

Existing modules that change:

```
src/config.js       # v2 migration, `repos` section, shared reclaimProject()
src/sim/ios.js      # occupancy detection in selectIosDevice
src/commands/prune.js    # delegate to reclaimProject()
src/commands/release.js  # withhold shutdown for occupied simulators
src/commands/ios.js      # warn when setup status is incomplete
src/commands/android.js  # same
```

Existing conventions apply: ESM only, all `child_process` through
`src/exec.js`, pure parsing separated from I/O, ASCII in `src/`, `bin/`,
`test/`.

### Settings layering

Path-keyed settings do not inherit into a new worktree, because a new worktree
has a new absolute path and therefore no config entry. Two new layers fix that:

```
CLI flag
  > per-project entry   ~/.rn-iso/config.json  projects[<abs path>].settings   (exists)
  > per-repo local  (B) ~/.rn-iso/config.json  repos[<git-common-dir>].settings (new)
  > committed       (A) <repo>/.rn-iso.json                                     (new)
  > auto-detected       detectPackageManager / detectIsExpo / ios script
```

`git rev-parse --git-common-dir` returns the same path for every worktree of a
repository, so layer B is inherited by new worktrees for free.

Layer A is committed and shared with the team: script names, the carry-over
list, the setup pipeline. Layer B is machine-local: paths on this machine's
disks, anything installation-specific.

**Secrets never go in layer A.** The carry-over list names gitignored files
(`.env`, tokens); the list itself is safe to commit, the files are not, and
`.rn-iso.json` must not hold their contents.

### Config schema v2

```jsonc
{
  "version": 2,
  "projects": { "/abs/path": { /* unchanged */ } },
  "repos": {
    "/Volumes/ExternalSSD/Developer/tlon-apps/.git": {
      "settings": { "worktreeDir": "..." }
    }
  }
}
```

`ensureConfig` migrates v1 by adding an empty `repos`. `projects` is not
rewritten. A migration test asserts existing project entries survive untouched.

### Worktree location

Default: a sibling of the repository, on the same volume.

```
/Volumes/ExternalSSD/Developer/tlon-apps/                    # repo
/Volumes/ExternalSSD/Developer/tlon-apps-worktrees/feat-x/   # worktrees
```

**Not** `<repo>/.claude/worktrees/`, which is Claude Code's default. A worktree
inside the repository root puts a second copy of every `package.json` inside
Metro's watch root, causing `jest-haste-map` naming collisions, and its
`node_modules` gets walked by Metro, TypeScript and ESLint. Gitignoring does
not help — those tools walk the filesystem, not git.

**Not** `~/.rn-iso/worktrees/` either: on the reference machine `$HOME` is on a
different, nearly-full volume, and a worktree must be on the same volume as its
repository.

Overridable via the `worktreeDir` setting (layer B — it is machine-specific).

Because Claude Code's built-in `--spawn=worktree` hardcodes
`.claude/worktrees/`, placing worktrees elsewhere requires wiring
`rn-iso worktree create` as a `WorktreeCreate` hook. The hook is therefore
load-bearing for the phone-spawned workflow, not optional.

Two behavioural consequences, from the Claude Code docs:

- Claude Code re-enters `.claude/worktrees/` worktrees on resume even when
  launched from inside them; for worktrees elsewhere it re-enters only if it
  can vouch for them from the launch directory. Resume from the main checkout.
- A worktree created by a `WorktreeCreate` hook keeps its transcript at the
  launch directory rather than moving it.

## Command surface

```
rn-iso worktree create <name> [--base <ref>] [--no-install] [--label <name>]
rn-iso worktree remove <name|path> [--force] [-y]
rn-iso worktree list
rn-iso gc [--delete] [--older-than <days>]
```

### `worktree create <name>`

1. Resolve the repository root and the layered settings.
2. Compute the path: `<worktreeDir>/<name>`, default
   `<parent>/<repo>-worktrees/<name>`.
3. `git worktree add` on a new branch from `worktree.baseRef`
   (`fresh` = `origin/HEAD`, matching Claude Code's default; `head` for
   current work).
4. Copy carry-over files.
5. Run the setup pipeline (unless `--no-install`).
6. **Print the worktree path on stdout. Everything else goes to stderr.**

Step 6 is the `WorktreeCreate` hook contract — Claude Code reads stdout as the
directory to use. Getting the stream split right is what lets one
implementation serve both the CLI and the hook.

`worktree create` does **not** register the project in `~/.rn-iso/config.json`.
Registration stays where it is today: on first `rn-iso ios` / `android`.
Removal locates artifacts by path prefix and does not need an entry to exist.

### Carry-over

Reads `.worktreeinclude` if present, else the `worktree.include` setting.
Gitignore syntax. Only files that are **both matched and gitignored** are
copied, so tracked files are never duplicated.

This rule earns its keep: of tlon-apps' four `.env*` files, three are tracked
and arrive with the checkout; only `apps/tlon-mobile/.env` needs copying. A
naive `.env*` glob would have duplicated the other three.

Reusing Claude Code's `.worktreeinclude` rather than defining a competing
format is deliberate.

Build artifacts are a legitimate carry-over target too — prebuilt native
modules (`better_sqlite3.node`) are gitignored and expensive to rebuild.

### Setup pipeline

`worktree.install` is **a list of commands, not a boolean**. A single
`install` is not sufficient for real monorepos.

Evidence: in tlon-apps, `pnpm install` aborted on a `better-sqlite3` native
build (Node 26 vs the pinned 20.11.0/22.22.0). That abort meant later
postinstall scripts never ran, so `react-native-skia` never fetched its
prebuilt binaries and `pod install` failed. After fixing that by hand, the app
red-boxed on `@tloncorp/editor/dist/editorHtml`, because the workspace package
build (`pnpm build:packages`) had never run either. **One failed install
cascaded into two more failures.**

Default, when unset: a single detected install command via
`detectPackageManager`. tlon-apps would configure (layer A):

```json
{ "worktree": { "install": ["pnpm install", "pnpm build:packages"] } }
```

**Setup status is recorded in config.** Each command's exit status is stored on
the project/worktree entry. If any failed, `rn-iso ios` / `android` prints a
warning naming the failed command before building, and `rn-iso status` shows
the worktree as `setup incomplete`. Silence is not acceptable: the failure mode
we observed is an agent burning a full build cycle to rediscover it as a red
box.

### Labels

`worktree create` sets `--label` to the worktree name by default.

Without this, projects register under their directory basename. In a monorepo
every worktree's app directory is `apps/tlon-mobile`, so every worktree
registers as `tlon-mobile` and collides. Confirmed in testing:
`rn-iso release wt-test` failed with "No registered project matches".

### `worktree remove <name|path>`

Refuses, before touching anything, when the worktree holds work that removal
would destroy:

- uncommitted changes or untracked files
- **commits on its branch that are not on any remote**

`--force` overrides. The refusal names what was found and how to keep it
(push the branch, or re-run with `--force`). This mirrors Claude Code, which
prompts rather than discarding, and it matters more here than for a plain
`git worktree remove` because the whole point of the command is that agents
and phone-spawned sessions call it unattended.

Then `git worktree remove`, then reclaim:

- DerivedData directories whose `WorkspacePath` is under the worktree
- the rn-iso project entry and its device claims
- its Metro port, and any Metro process still listening on it

The last group is exactly what `prune` does today. Both call a shared
`reclaimProject(path)` rather than duplicating the logic.

### `worktree list`

Lists the current repository's rn-iso-created worktrees with, for each: path,
branch, label, setup status, and the size of its reclaimable external
artifacts. Worktrees created by other means (Claude Code, raw `git worktree
add`) are listed too, marked as unmanaged, since `remove` and `gc` handle them
identically.

### `gc`

Machine-wide sweep for everything left behind by worktrees that no longer
exist, in one command:

- DerivedData directories whose `WorkspacePath` no longer exists
- dead rn-iso config entries, their device claims and Metro ports (the same
  work `prune` does)

**Reports by default. Acts only with `--delete`.** `--older-than <days>`
filters on `LastAccessedDate`.

`prune` remains as the narrow, always-safe command: config entries only, never
disk, no flag required. `gc` is the "I am out of disk" button and is the only
destructive command in the tool. Both call the same `reclaimProject(path)`, so
`gc` is a superset rather than a reimplementation.

Because `gc` works from `WorkspacePath` alone, it also cleans up after
worktrees created by Claude Code's built-in `--spawn=worktree` without rn-iso
ever being involved.

## Device occupancy beyond rn-iso claims

`allClaimedDevices()` only knows about rn-iso's own claims, so a simulator
another tool is actively driving looks free. During testing rn-iso selected a
booted simulator that an `agent-device` XCUITest runner was driving, installed
onto it, and later `release --shutdown` killed it out from under that session.

`selectIosDevice` gains a third state alongside free and claimed:
**occupied** — booted, unclaimed by rn-iso, but with a foreign runner process
attached. Detection is a booted simulator with a running
`*.xctrunner` (or otherwise non-project) app in `launchctl list`.

Behavior:

- `--auto` skips occupied simulators, as it does claimed ones.
- The interactive picker shows them greyed with an `[in use]` tag and requires
  the same confirm prompt as a take-over.
- `release --shutdown` refuses to shut down a simulator that is occupied by a
  foreign runner, and says so, unless `--force` is passed. Releasing the
  rn-iso claim still happens; only the shutdown is withheld.

Detection is a heuristic and must fail open: if the probe errors or returns
nothing parseable, treat the device as free rather than blocking selection.
The pure classifier over `launchctl list` output is unit-tested; the probe
around it is thin.

## Reclamation mechanism

Every DerivedData directory contains an `info.plist`:

```
WorkspacePath   => /abs/path/to/App.xcworkspace
LastAccessedDate => 2026-08-03 21:38:12 +0000
```

This maps an artifact directory back to its project without reverse-engineering
Xcode's path hash. `artifacts.js` exports a pure `parseDerivedDataInfo(plist)`
plus thin `findDerivedDataFor(projectPath)` and `findOrphanedDerivedData()`
wrappers.

Orphan test: `!existsSync(workspacePath)` — the same rule
`allClaimedDevices()` already uses for dead worktrees.

### Safety: the unmounted-volume guard

`CLAUDE.md` already notes that a project on an unmounted volume looks "dead" to
`existsSync`. For `prune` that is benign — a config entry is dropped. For
`gc --delete` it is destructive: the reference machine keeps every repository
on a USB-attached SSD, so unmounting it would make every `WorkspacePath` look
orphaned and `gc --delete` would erase all live DerivedData.

**Hard requirement:** before classifying anything as an orphan, resolve its
volume root and confirm that volume is mounted. If the volume is absent, skip
every path on it rather than counting them as orphans. An unreadable or missing
`info.plist` also skips rather than deletes.

The rule is that ambiguity always resolves toward not deleting.

## Error handling

A non-zero exit from a `WorktreeCreate` hook kills the session spawn, so
failures are graded:

| Failure | Behavior |
|---|---|
| Worktree path exists and is valid | Print path, exit 0 (idempotent — hook retries must not fail) |
| Not a git repo, or `git worktree add` fails | Surface git's stderr verbatim, exit 1 (nothing was created) |
| Carry-over copy fails | Warn on stderr, continue |
| Setup pipeline command fails | Print path on stdout, warn loudly on stderr, **record status**, exit 0 |

The last row is deliberate: a worktree with a broken install is recoverable
in-session, but a failed spawn loses the session entirely. The recorded status
is what stops that leniency from becoming silence.

## Testing

`node --test`, mock executor via `setExecutor`, `RN_ISO_HOME` redirect.

Pure and unit-tested:

- `parseDerivedDataInfo`
- settings merge across all five layers, including precedence and partial
  overrides
- carry-over matching (gitignore syntax, and the "matched AND gitignored" rule)
- worktree path computation
- orphan classification, **including the unmounted-volume case**
- occupancy classification over `launchctl list` output, including the
  fail-open path when the probe returns nothing parseable

Exec-mocked:

- `git worktree add` / `remove`, `git rev-parse --git-common-dir`
- setup pipeline invocation and per-command status recording
- unpushed-commit detection, and that `worktree remove` refuses without
  `--force` and proceeds with it
- that `release --shutdown` withholds shutdown for an occupied simulator but
  still clears the rn-iso claim

Config:

- v1 to v2 migration, asserting `projects` survives unchanged

New files: `test/settings.test.js`, `test/worktree.test.js`,
`test/artifacts.test.js`.

## Documentation

Per `CLAUDE.md` rule 1, `skill/SKILL.md` is updated in the same change:

- a `worktree` section (create/remove/list, and that agents should prefer
  `create` over raw `git worktree add` so setup and labelling happen)
- a `gc` section stating that agents must **never** run `gc --delete` without
  asking — it is the only destructive command in the tool
- a note that "setup incomplete" in `rn-iso status` means the setup pipeline
  failed, and to read the recorded command rather than guessing

`README.md` gets the command table entries and a `WorktreeCreate` hook example.

## Prerequisites (documented, not implemented)

**EAS build cache.** tlon-apps sets `buildCacheProvider: 'eas'`, which should
let `expo run:ios` download a prebuilt dev client instead of compiling. On the
reference machine it silently falls back to a local build: the logged-in EAS
user is not a member of the project's owning account, the cache lookup returns
`Entity not authorized`, and the provider fails soft. The 423 s cold build in
the baseline above is that fallback.

With EAS cache working, a fresh worktree could skip the native build entirely
and be ready in about a minute instead of eight. That is a large enough
difference to the phone-spawned workflow that the setup docs must call it out,
even though rn-iso cannot fix it: `rn-iso` does not manage EAS auth.

Note that EAS CLI holds one session at a time (`~/.expo/state.json`), but a
single user can belong to many accounts, so the usual fix is account
membership rather than a second login. Where two identities are genuinely
needed, `EXPO_TOKEN` scoped per repository overrides the stored session — and
being a secret, it belongs in a carried-over `.env`, never in `.rn-iso.json`.

## Review decisions

Three questions were left open in the first draft and resolved on review
(2026-08-16). All three are folded into the sections above:

1. **Detect non-rn-iso device occupancy — yes.** See "Device occupancy beyond
   rn-iso claims". Scoped into this work rather than deferred, because
   `worktree remove` and `release --shutdown` are exactly the unattended paths
   that caused the problem.

2. **`worktree remove` refuses on unpushed commits — yes.** See
   "`worktree remove`". `--force` overrides.

3. **`gc` also handles dead config entries — yes.** See "`gc`". It is a
   superset of `prune` sharing `reclaimProject`; `prune` stays as the narrow
   always-safe command.

## Open questions

None outstanding.
