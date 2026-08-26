# End-to-end tests and CI

rn-iso has three test layers. The unit suite (`npm test`, ~1350 `node:test`
cases across the three packages) is the bulk of the coverage. On top of it sit
two end-to-end layers that exercise the *published loop* rather than individual
functions.

## The fast cross-platform e2e

`test/e2e/cache-flow.e2e.js`, run with:

```bash
npm run test:e2e
```

Runs anywhere Node 20+ and git are available -- **no Xcode, no Android SDK**.
It drives the real CLI and the real cache library end to end under a throwaway
`RN_ISO_HOME` and a throwaway temp repo, so it never touches the machine's real
caches, registry, or checkouts. What it proves:

1. `rn-iso worktree create` makes two real git worktrees at one commit and keeps
   its stdout-is-only-the-path contract.
2. Two worktrees of one commit **fingerprint identically when scoped to a
   platform** (the cross-worktree cache premise) -- and diverge under `ios/`
   when a worktree-local path leaks in, which is exactly why the hash is scoped.
3. A build stored under wt1's key **resolves from wt2's key**: a cross-worktree
   cache hit with no compiler. Change a native input in wt2 and the key changes
   and the hit becomes a miss.
4. Two real node processes racing the single-flight build lock: **exactly one
   builds**, the other waits and resolves the artifact the first one stored.
5. `rn-iso worktree remove` refuses a dirty tree, then removes a clean one
   leaving no dirs, no config entries, and a clean `git worktree list`.

The one non-real piece is the leaf hash function: `@expo/fingerprint` is not a
dependency of this repo, so a vendored, API-compatible, platform-scoping stub
(`test/e2e/fixtures/fingerprint-stub.mjs`) is injected through the `load` seam
`fingerprintProject` already exposes for exactly this reason. Everything else --
`buildCacheKey`, `storeBuild`, `resolveBuild`, `acquireBuildLock`, the worktree
CLI -- is the real library.

## The native e2e

`test/e2e/native/run-native-e2e.mjs` codifies `docs/field-test-protocol.md` as
an executable. It creates a real app, runs the real `start` -> `ios|android`
loop against a real simulator/emulator with a real compiler, and proves the
cache actually engages on a second worktree. It is a 2x2 matrix:

```
framework in {bare, expo}   x   platform in {ios, android}
```

bare and expo are not cosmetic variants: bare hosts Metro **in-process**
(`start` mode `bare-inproc`) and needs `@expo/fingerprint` installed into the
fixture; expo spawns `expo start` as a **child** (mode `expo-child`) and
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
env var (`RN_ISO_E2E_BARE_INIT`, `RN_ISO_E2E_EXPO_INIT`) so a runner can adjust
them without touching assertion logic.

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
  not block every PR. iOS runs on `macos-latest` (Xcode via
  `maxim-lobanov/setup-xcode`); Android runs on a Linux+KVM host via
  `reactivecircus/android-emulator-runner`. Each platform's `{bare, expo}` are a
  matrix, so they run as parallel, isolated jobs. `~/.rn-iso`'s shared build
  cache (`RN_ISO_BUILD_CACHE`) is persisted across runs with `actions/cache`, so
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
