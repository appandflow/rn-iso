# rn-iso — agent guide

Quick orientation for AI assistants working in this repo.

## What this is

A Node.js CLI that gives each React Native / Expo project (or git worktree)
its own Metro server and dedicated simulator/emulator, so multiple agents can
work on different projects in parallel without device or port collisions.

State lives in `~/.rn-iso/config.json`, keyed by absolute project path. The
`RN_ISO_HOME` env var redirects this for tests.

## Architecture conventions

- **ESM only.** `"type": "module"`, no transpiler, Node 20+ directly. No
  CommonJS, no `require()`.
- **Single exec wrapper.** All `child_process` calls go through
  `src/exec.js` (`getExecutor()`). Tests inject a mock via `setExecutor()`.
  Anywhere outside `exec.js` that imports `child_process` directly is a bug.
- **Pure parsing separate from invocation.** Functions like `parseSimctlList`,
  `parseAdbDevices`, `selectIosDevice`, `sortSims` are pure and unit-tested;
  the I/O wrappers around them are thin.
- **ASCII in source files.** No em dashes, smart quotes, or check marks in
  `src/`, `bin/`, `test/`. Markdown files (README, SKILL, this file) may use
  them. The hooks have flagged this before.

## File layout

```
bin/cli.js              # commander entry, registers each command module
src/
  exec.js               # mockable child_process wrapper
  config.js             # config CRUD, reservations, sim-usage tracking
  project.js            # project root walk, bundle-id detection (incl. native fallbacks)
  ports.js              # Metro port allocation + reclamation
  runner.js             # script-vs-CLI dispatch, package-manager detection (walks up for monorepos)
  metro.js              # detached Metro spawn, PID + log lifecycle
  sim/
    ios.js              # simctl wrappers, sim selection, sortSims, parseRuntimeVersion
    android.js          # adb/emulator wrappers, AVD selection
  commands/
    ios.js android.js   # the main user-facing commands
    start.js stop.js logs.js
    status.js
    device.js           # `rn-iso device --json` -> agent-device target
    release.js shutdown.js prune.js
    reserve.js unreserve.js
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
  meaty (like `reserve`).
- New / changed flag on `ios` or `android`? Update "Core workflow" and
  "Critical rules" if the flag matters for non-interactive agent use.
- Behavior change (e.g., picker now does X)? Update both the
  description and the "When things go wrong" section.

The skill is shipped to users via the curl line in the README; staleness
breaks agent guidance.

### 2. Don't auto-create simulators

`selectIosDevice` returns `needsBoot` only when no unclaimed sim exists at
all. `commands/ios.js` then errors unless `--device-type` is passed. We do
NOT prompt and create on the user's behalf — that was the original UX and
was removed because it accumulated junk sims. The picker only chooses among
EXISTING sims (booted or shutdown). When you change device-selection logic,
preserve this invariant.

### 3. The post-install verification step is intentionally absent

Earlier versions ran `xcrun simctl install/launch` after the build CLI to
work around a wrong-sim bug in `@expo/cli` (since fixed in 54.0.24). That
step caused double-launches and was removed. If you find yourself wanting
to add it back, the upstream bug is the right place to fix things —
`patch-package` for stuck users, not workaround code in `commands/ios.js`.

### 3b. `rn-iso ios` / `android` do NOT spawn Metro

The build CLI (`expo run:ios` / `react-native run-ios`) starts Metro
itself on the `--port` we pass. We used to also pre-spawn a detached
Metro before the build, which led to two Metros on the same port.
Removed.

`rn-iso start` is still around for the explicit "I just want Metro" case
— it spawns Metro detached and tracks the PID + log file. The build
commands rely on the build CLI's Metro; `rn-iso stop` looks up the PID
by port (via `lsof`) so it works regardless of who started Metro.

### 4. Reservations are first-class claims

`allClaimedDevices()` returns BOTH project-claimed AND reservation-claimed
devices. If you add a new claim source (e.g., a new section in config.json),
extend `allClaimedDevices` AND `iosClaims` so the picker greys it out with a
useful label. Don't filter at any one call site — keep the policy in
`config.js`.

### 5. Package-manager / script detection

`runner.js` prefers the project's `ios` / `android` script over a direct
`expo run:ios` / `react-native run-ios` invocation. Reasons: respects user
flags, picks the right CLI, works with non-standard setups (rainbow has
`expo` in deps but uses `react-native run-ios`).

`detectScriptCli` regex-matches the script body to decide flag names
(`--device <UDID>` for Expo, `--udid <UDID>` for RN). If you ever need a
new flag, update both the script-path branch and the direct fallback.

`detectPackageManager` walks up from the project root looking for a
lockfile (monorepo support). Don't single-directory-check.

### 6. `RN_ISO_HOME` is the test redirect

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

### 7. `findProjectRoot` uses `realpath`

So symlinked worktrees collapse to the same canonical key as the
non-symlinked path. Don't add code that compares paths without
canonicalizing first.

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

- GPG signing is enabled globally — commits sign automatically. Don't pass
  `--no-gpg-sign`. If you need to re-sign an existing commit (e.g.,
  someone forgot signing), `git commit --amend --no-edit -S` works.
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
