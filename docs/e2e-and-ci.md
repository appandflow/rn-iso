# End-to-end tests and CI

Per-workspace runtime state and logs live outside the project tree under
`$STIM_CLI_HOME/workspaces/<readable-project-slug>--<16hex-path-digest>/` (by
default `~/.stim-cli/workspaces/...`). stim-cli does not create a project
`.gitignore` entry for this state.

stim-cli has three test layers. The unit suite (`npm test`, ~1350 `node:test`
cases across the three packages) is the bulk of the coverage. On top of it sit
two end-to-end layers that exercise the _published loop_ rather than individual
functions.

## The fast cross-platform e2e

`test/e2e/cache-flow.e2e.js`, run with:

```bash
npm run test:e2e
```

Runs with Node 20.19.4 or later on Node 20, or Node 22.12.0 or later. Git is also required. The suite needs **no Xcode or Android SDK**.
It drives the real CLI and the real cache library end to end under a throwaway
`STIM_CLI_HOME` and a throwaway temp repo, so it never touches the machine's real
caches, registry, or checkouts. What it proves:

1. `stim-cli worktree create` makes two real git worktrees at one commit and keeps
   its stdout-is-only-the-path contract.
2. Two worktrees of one commit **fingerprint identically when scoped to a
   platform** (the cross-worktree cache premise) -- and diverge under `ios/`
   when a worktree-local path leaks in, which is exactly why the hash is scoped.
3. A build stored under wt1's key **resolves from wt2's key**: a cross-worktree
   cache hit with no compiler. Change a native input in wt2 and the key changes
   and the hit becomes a miss.
4. Two real node processes racing the single-flight build lock: **exactly one
   builds**, the other waits and resolves the artifact the first one stored.
5. `stim-cli worktree remove` refuses a dirty tree, then removes a clean one
   leaving no dirs, no config entries, and a clean `git worktree list`.

The one non-real piece is the leaf hash function: the real CLI has a direct `@expo/fingerprint` dependency, while this fast suite injects a deterministic platform-scoping stub (`test/e2e/fixtures/fingerprint-stub.mjs`) through the `load` seam. Everything else -- `buildCacheKey`, `storeBuild`, `resolveBuild`, `acquireBuildLock`, the worktree CLI -- is the real library.

## The native e2e

There are TWO native suites, on one 2x2 matrix and one shared harness
(`test/e2e/native/harness.mjs`, which owns the fixture creation, the process
wrappers, the cleanup checks and the diagnostics dump so both drivers build and
tear down the same app the same way):

| suite      | driver               | proves                                               | when                        |
| ---------- | -------------------- | ---------------------------------------------------- | --------------------------- |
| **loop**   | `run-native-e2e.mjs` | the dev loop works end to end                        | nightly, PR label, dispatch |
| **caches** | `run-cache-e2e.mjs`  | each individual cache is engaged, storing and reused | on demand                   |

### The loop suite

`test/e2e/native/run-native-e2e.mjs` codifies `docs/field-test-protocol.md` as
an executable. It creates a real app, runs the real `start` -> `ios|android`
loop against a real simulator/emulator with a real compiler, and proves the
cache actually engages on a second worktree. It is a 2x2 matrix:

```
framework in {bare, expo}   x   platform in {ios, android}
```

bare and expo are not cosmetic variants: bare hosts Metro **in-process**
(`start` mode `bare-inproc`); expo spawns `expo start` as a **child** (mode `expo-child`) and
prebuilds first. The driver asserts the start mode explicitly per variant --
this is the `detectIsExpo` path a field test caught misfiring on a wrapper-less
`app.json`. Per variant it asserts: correct start mode; a cold build produces a
real artifact; the second worktree hits the local cache with **no compile**
(proven from the build log, not just the JSON); and the protocol's five cleanup
checks pass.

It is **slow and occasionally flaky by nature**, so it is not run on every push.
Run one variant by hand:

```bash
node test/e2e/native/run-native-e2e.mjs --framework bare --platform ios
node test/e2e/native/run-native-e2e.mjs --framework expo --platform android
# safe, no device/build: create the fixture then stop
node test/e2e/native/run-native-e2e.mjs --framework expo --platform ios --fixture-only
# print the plan, no side effects
node test/e2e/native/run-native-e2e.mjs --framework bare --platform android --dry-run
```

The fixture-creation commands are version-sensitive; each is overridable with an
env var (`STIM_CLI_E2E_BARE_INIT`, `STIM_CLI_E2E_EXPO_INIT`) so a runner can adjust
them without touching assertion logic.

### The cache suite

`test/e2e/native/run-cache-e2e.mjs` is the executable replacement for the
hand-written cache field passes. Those kept drifting in coverage: one Android
pass never checked Gradle caching at all, a zero-config pass ran iOS-only and
left `--build-cache` unproven, and a broken Expo Metro store shipped through green CI
(#73) because nothing measured the directory it was supposed to be filling.

**The three-part rule.** For every cache it proves three separate things, and
refuses to take one as evidence of another:

- **ENGAGED** -- the flag / setting / record is really there, read back off the
  REAL argv or the REAL log, never re-derived from the suite's idea of what
  stim-cli should have done.
- **STORES** -- the cache directory actually GREW. A file count before and a
  file count after. **This is the one that matters**: an engaged cache that
  stores nothing looks identical to a working one from every other angle, and
  that is exactly the shape of the old loader-hook bug.
- **REUSED** -- a SECOND workspace got the stored work back.

**The eight checks.**

| id                  | what it proves                                                                              | how                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zero-config`       | stim-cli writes no runtime state into the repo; global workspace state needs no ignore rule | `git status --porcelain` before and after; a change to `metro.config.js` / `Podfile` / `gradle.properties` is a CRITICAL failure; every worktree is removed WITHOUT `--force` and no project `.gitignore` mutation is expected                                                                                                                                                            |
| `metro-store`       | the shared transform store is engaged per dev-server mode, stores, and is reused            | the `cache_store_added` record in the global workspace `logs/metro.ndjson` (Expo SDK 54+: the config adapter's confirmation from inside the child; bare: the in-process append), the absence of a "could not share" warning, one store root for both workspaces, then a file count around each workspace's build+launch                                                                   |
| `xcode-cas`         | Xcode 26 compilation caching                                                                | the five build settings read verbatim off the `build_start` record in `build-ios.ndjson`, CAS directory growth across the cold compile, and near-zero growth when a never-compiled workspace compiles the same sources                                                                                                                                                                    |
| `gradle-cache`      | the Gradle build cache                                                                      | `--build-cache` read off the `build_start` record in `build-android.ndjson` (added in #78 so this need not race `ps`), growth of `<gradle user home>/caches/build-cache-1`, and `FROM-CACHE` tasks in a second worktree forced to run gradle with `stim-cli android --no-build-cache`                                                                                                     |
| `fingerprint-cache` | the entry is complete and under the right key                                               | the entry holds the artifact AND `fingerprint-sources.json` (and, for an Android release entry, `assets-manifest.json`); a second run in the SAME tree must HIT what the first stored, which is what proves the entry landed under the POST-mutation key that prebuild and `pod install` shift it to                                                                                      |
| `pods-reuse`        | carried Pods skip `pod install`                                                             | the racing worktrees are cloned from wt1 with `--carry-ignored`, so they carry its `ios/` and its installed Pods; the one that takes the BUILD path must print no `pods` phase line at all                                                                                                                                                                                                |
| `single-flight`     | two workspaces racing one uncached fingerprint compile once                                 | both racers point at an EMPTY build-cache root (so the fingerprint is identical to the one already stored and misses only because that root is empty, which keeps the check about the lock and nothing else) while the build lock stays shared through `STIM_CLI_HOME`; exactly one compiles, the other reports `waited ... -> installed from cache` with `waitedForBuild` in its payload |
| `gc-view`           | `gc` can see every cache                                                                    | a bare `gc` must list each live cache directory with a size under "Shared build caches (N) - alive, not garbage"                                                                                                                                                                                                                                                                          |

**Honesty rules.** Every assertion prints the evidence it checked -- numbers, and
quoted lines. A check that cannot run SKIPS with the reason spelled out ("no
Android SDK on this runner", "compilation caching needs Xcode 26+, this runner
reports ..."), and a skip is never a pass. A check that finishes without
reporting a verdict is a failure. Every human line goes to stderr; **stdout
carries exactly one line**, the machine-readable summary:

```json
{"suite":"caches","variant":"expo-ios","ok":true,"counts":{"pass":6,"skip":2,"fail":0},"checks":[...]}
```

Each `checks[]` entry carries its `id`, `status`, `reason` and the full
`evidence` array, so a CI job can fail on one cache without a human reading the
log.

**Cache roots are forced, not inherited.** Unlike the loop suite -- which lets
CI persist `STIM_CLI_BUILD_CACHE` across runs on purpose, and has
`STIM_CLI_E2E_WARM_CACHE` to relax its cold-miss assertion -- the cache suite
overrides `STIM_CLI_BUILD_CACHE` and `STIM_CLI_METRO_CACHE` into its own throwaway
home. Every number it reports is a before/after around a COLD compile, and an
inherited warm cache turns "the CAS gained 4,000 files" into a measurement of
nothing.

Run it by hand:

```bash
# the full suite (two cold compiles plus two cache-hit builds; 20-60 minutes)
node test/e2e/native/run-cache-e2e.mjs --framework expo --platform ios
node test/e2e/native/run-cache-e2e.mjs --framework bare --platform android

# skip the single-flight race (saves one cold compile; that check reports SKIP)
node test/e2e/native/run-cache-e2e.mjs --framework expo --platform ios --skip-race

# against a checkout you already have, and keep the summary
node test/e2e/native/run-cache-e2e.mjs --framework expo --platform ios \
  --app-dir ~/src/my-app --summary /tmp/cache-summary.json

# print the plan, no side effects
node test/e2e/native/run-cache-e2e.mjs --framework bare --platform ios --dry-run
```

On CI it is `workflow_dispatch` only: **Actions -> Native E2E -> Run workflow ->
suite: `caches`** (or `all` for both). The default stays `loop`, so the nightly
and the PR label behave exactly as they always have.

#### What its first run found

Recorded so that a red run is not mysterious. First full local run,
2026-08-27, `expo-ios`, Expo SDK 57 / RN 0.86 / Xcode 26.6, 769s:
`xcode-cas`, `fingerprint-cache`, `single-flight` and `pods-reuse` PASS,
`gradle-cache` SKIP (iOS), and **two checks fail on real product bugs, both
still open**:

- **`metro-store` (fixed)** -- the old Expo implementation intercepted Node's
  module loader and missed Expo's vendored Metro path. Expo SDK 54+'s
  `EXPO_OVERRIDE_METRO_CONFIG` now loads a small adapter instead, so the project
  config is composed through an explicit config seam and no module interception
  remains. SDK 53 and older intentionally use Expo's normal Metro cache.
- **`gc-view`** -- stim-cli points `COMPILATION_CACHE_CAS_PATH` at
  `<config dir>/compilation-cache`, but nothing registers that directory in the
  cache manifest, and `caches.ts` only DETECTS Xcode's default CAS under
  `~/Library/Developer/Xcode/DerivedData`. So `gc` reports a 28 KB cache nobody
  is filling and misses the 201 MB one a single build just wrote. Nothing will
  ever trim it -- the same hazard `registerMetroStore`'s own comment names for
  the Metro store.

## CI

Two workflows under `.github/workflows/`:

- **`ci.yml`** -- on every push and pull request. Ubuntu, Node matrix `[20, 22]`
  (20 is the `engines` floor, proven). Steps: `npm ci`, `npm test`,
  `npm run test:e2e`. Fast and **blocking**. (A lint/typecheck step is left as a
  commented placeholder for the planned TypeScript migration -- neither tool is
  set up yet.)

- **`e2e-native.yml`** -- the native matrix. **Gated**: it runs nightly
  (schedule), on demand (`workflow_dispatch`), and on a pull request **only when
  the PR carries the `e2e-native` label** -- a flaky 15-minute `xcodebuild` must
  not block every PR. A `suite` dispatch input picks which driver runs on the
  matrix (`loop` | `caches` | `all`, default `loop`); `inputs` is empty on
  schedule and on `pull_request`, so both fall through to `loop` and the
  nightly's behaviour is preserved by construction rather than by a second code
  path. The `caches` selection raises the job timeout to 120 minutes (per
  variant it pays one more cold compile than the loop suite -- the single-flight
  race -- plus two cache-hit builds, and on Android one forced `gradlew` run)
  and uploads its machine-readable summary
  as an artifact with `if: always()` -- a FAILING cache run is exactly when the
  per-check evidence is worth reading. iOS runs on `macos-latest` (Xcode via
  `maxim-lobanov/setup-xcode`); Android runs on a Linux+KVM host via
  `reactivecircus/android-emulator-runner`. Each platform's `{bare, expo}` are a
  matrix, so they run as parallel, isolated jobs. `~/.stim-cli`'s shared build
  cache (`STIM_CLI_BUILD_CACHE`) is persisted across runs with `actions/cache`, so
  the cross-run cache path is itself exercised; build logs
  (`build-*.ndjson`) are uploaded as artifacts on failure.

### Assumptions a reviewer must confirm

- The `macos-latest` runner image ships the Xcode that `latest-stable` selects,
  and it is new enough for the RN/Expo template the fixture creates.
- The `@react-native-community/cli` and `create-expo-app` flag surfaces in the
  driver's `FIXTURE_COMMANDS` match the versions the runners fetch (override via
  the env vars above if not).
- The Android job's `api-level` / `target` / `arch` have a matching system image
  available to `android-emulator-runner`.
- **Disk, for the `caches` suite only.** It stands up FOUR worktrees, each with
  its own global workspace DerivedData / Gradle build dir under `STIM_CLI_HOME`, and
  `--keep` leaves them for the artifact step. A hosted runner's free space is
  the thing most likely to end that run early; if it does, `--skip-race` drops
  it to two worktrees at the cost of the `single-flight` and `pods-reuse`
  checks (both of which then report SKIP with that reason).
