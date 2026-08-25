# rn-iso v3 Step 1: Artifact Layout and Teardown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move build output into `<worktree>/.rn-iso/` and content-addressed caches into `~/.rn-iso/`, so a workspace's artifacts die with the workspace instead of being reverse-mapped out of a global directory.

**Architecture:** A new `src/paths.js` becomes the single source of truth for every path rn-iso writes. `src/artifacts.js` splits: its volume and size utilities move to `src/fs-util.js`, its DerivedData classification is deleted. `init` writes the redirection into the repo, `doctor` reports it, and `gc` narrows to what still orphans.

**Tech Stack:** Node 20+, ESM, `node --test`, commander, chalk. No new dependencies.

## Global Constraints

- **ESM only** in `packages/rn-iso`. No `require()`, no CommonJS. (`CLAUDE.md` conventions)
- **ASCII only** in `src/`, `bin/`, `test/`. No em dashes, smart quotes or check marks. Markdown may use them.
- **All `child_process` goes through `src/exec.js`.** Importing `child_process` anywhere else is a bug.
- **Config writes happen inside `withConfigLock()`** and land via `saveConfig`'s write-temp-then-rename.
- **`RN_ISO_HOME` redirects all config and shared-cache paths.** Every state-touching test sets it in `beforeEach` and deletes it in `afterEach`.
- **Fail closed on ambiguity.** Any classifier that cannot get a definite answer skips rather than deletes.
- **No new dependencies.** `prompts` is removed, not added to.
- Run the suite from the repo root: `npm test`. Single file: `cd packages/rn-iso && node --test test/<name>.test.js`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/rn-iso/src/paths.js` | **New.** Every path rn-iso writes: workspace-local under `<root>/.rn-iso/`, shared under `getConfigDir()`. Pure functions, no I/O. |
| `packages/rn-iso/src/fs-util.js` | **New.** The half of `artifacts.js` that survives: volume detection (`volumeRootFor`, `isRealMount`, `listMountedVolumes`, `isOnMountedVolume`) and sizing (`directorySize`, `formatBytes`). |
| `packages/rn-iso/src/artifacts.js` | **Deleted.** Its DerivedData classification has no consumer once build output is workspace-local. |
| `packages/rn-iso/src/init.js` | Templates gain `.rn-iso/` in `.gitignore` and `.worktreeexclude`, plus the xcconfig and Podfile redirection. |
| `packages/rn-iso/src/doctor.js` | Gains `checkArtifactLayout`. |
| `packages/rn-iso/src/commands/gc.js` | Narrowed: dead entries, orphaned devices, shared caches. DerivedData sweep removed. |
| `packages/rn-iso/src/commands/prune.js` | **Deleted.** Its behavior is `gc --delete` restricted to one project. |
| `packages/rn-iso/src/commands/cache.js` | **Deleted.** `register`/`forget`/`list` fold into `gc`'s report. |

**Do not touch in this step:** `up.js`, `device.js`, `release.js`, `stop.js`, `shutdown.js`. They keep working against the v2 surface until step 3 replaces them. This step must leave `npm test` green and the CLI usable.

---

### Task 1: The layout module

**Files:**
- Create: `packages/rn-iso/src/paths.js`
- Test: `packages/rn-iso/test/paths.test.js`

**Interfaces:**
- Consumes: `getConfigDir()` from `src/config.js` (already respects `RN_ISO_HOME`).
- Produces: `workspaceDir(root)`, `workspaceLogsDir(root)`, `workspaceDerivedData(root)`, `workspaceGradleBuild(root)`, `supervisorPidFile(root)`, `workspaceStateFile(root)`, `sharedMetroCache()`, `sharedBuildCache()`, `sharedCompilationCache()`, `sharedGradle()`, `sharedPods()`. All return absolute path strings and perform no I/O.

- [ ] **Step 1: Write the failing test**

```js
// packages/rn-iso/test/paths.test.js
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  workspaceDir, workspaceLogsDir, workspaceDerivedData, supervisorPidFile,
  sharedMetroCache, sharedBuildCache, sharedCompilationCache,
} from '../src/paths.js';

describe('workspace paths', () => {
  test('everything workspace-local lives under <root>/.rn-iso', () => {
    assert.strictEqual(workspaceDir('/repo/wt'), '/repo/wt/.rn-iso');
    assert.strictEqual(workspaceLogsDir('/repo/wt'), '/repo/wt/.rn-iso/logs');
    assert.strictEqual(workspaceDerivedData('/repo/wt'), '/repo/wt/.rn-iso/derived-data');
    assert.strictEqual(supervisorPidFile('/repo/wt'), '/repo/wt/.rn-iso/supervisor.pid');
  });

  test('paths are pure: no directory is created as a side effect', () => {
    const root = join(tmpdir(), 'rn-iso-nonexistent-xyz');
    workspaceLogsDir(root);
    assert.ok(!require('fs').existsSync(join(root, '.rn-iso')));
  });
});

describe('shared paths', () => {
  let tmpHome;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
    process.env.RN_ISO_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
  });

  test('shared caches honour RN_ISO_HOME', () => {
    assert.strictEqual(sharedMetroCache(), join(tmpHome, 'metro-cache'));
    assert.strictEqual(sharedBuildCache(), join(tmpHome, 'build-cache'));
    assert.strictEqual(sharedCompilationCache(), join(tmpHome, 'compilation-cache'));
  });
});
```

Note: replace the `require('fs')` in the purity test with a top-level
`import { existsSync } from 'fs'` — the file is ESM and `require` is not
defined. It is written here only to make the assertion's intent obvious.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rn-iso && node --test test/paths.test.js`
Expected: FAIL, `Cannot find module '../src/paths.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// packages/rn-iso/src/paths.js
//
// The single source of truth for every path rn-iso writes.
//
// The rule that decides which half a path belongs in: CONTENT-ADDRESSED
// artifacts are shared, LOCATION-ADDRESSED artifacts are workspace-local. A
// build cache entry keyed on a fingerprint is meaningful to any workspace on
// the same commit, so it is shared. A DerivedData tree is meaningful only to
// the checkout that produced it, so it lives inside that checkout and dies
// with it -- which is what removes the need to ever reverse-map a global
// build directory back to a workspace.
//
// Pure: nothing here creates a directory. Callers mkdir when they write.
import { join } from 'path';
import { getConfigDir } from './config.js';

export const WORKSPACE_DIR_NAME = '.rn-iso';

export function workspaceDir(projectRoot) {
  return join(projectRoot, WORKSPACE_DIR_NAME);
}

export function workspaceLogsDir(projectRoot) {
  return join(workspaceDir(projectRoot), 'logs');
}

export function workspaceDerivedData(projectRoot) {
  return join(workspaceDir(projectRoot), 'derived-data');
}

export function workspaceGradleBuild(projectRoot) {
  return join(workspaceDir(projectRoot), 'gradle-build');
}

export function supervisorPidFile(projectRoot) {
  return join(workspaceDir(projectRoot), 'supervisor.pid');
}

export function workspaceStateFile(projectRoot) {
  return join(workspaceDir(projectRoot), 'state.json');
}

// Shared caches derive from getConfigDir() rather than homedir() so that
// RN_ISO_HOME redirects them along with the registry, which is what lets a
// test run against a temp directory without touching the real machine.
export function sharedMetroCache() {
  return join(getConfigDir(), 'metro-cache');
}

export function sharedBuildCache() {
  return join(getConfigDir(), 'build-cache');
}

export function sharedCompilationCache() {
  return join(getConfigDir(), 'compilation-cache');
}

export function sharedGradle() {
  return join(getConfigDir(), 'gradle');
}

export function sharedPods() {
  return join(getConfigDir(), 'pods');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rn-iso && node --test test/paths.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add packages/rn-iso/src/paths.js packages/rn-iso/test/paths.test.js
git commit -m "feat: add paths module as the single source of truth for layout"
```

---

### Task 2: Split artifacts.js into fs-util.js

**Files:**
- Create: `packages/rn-iso/src/fs-util.js`
- Create: `packages/rn-iso/test/fs-util.test.js`
- Delete: `packages/rn-iso/src/artifacts.js`, `packages/rn-iso/test/artifacts.test.js`
- Modify (import updates): `src/ports.js`, `src/reclaim.js`, `src/config.js`, `src/caches.js`, `src/commands/gc.js`, `src/commands/build-cache.js`, `src/commands/cache.js`, `src/commands/prune.js`, `src/commands/worktree.js`

**Interfaces:**
- Produces: `volumeRootFor(path)`, `isRealMount(entryDev, rootDev)`, `listMountedVolumes({statFn})`, `isOnMountedVolume(path, mountedVolumes)`, `directorySize(dir)`, `formatBytes(bytes)` — all moved verbatim from `artifacts.js`, signatures unchanged.
- Removed with no replacement: `derivedDataRoot`, `parseDerivedDataInfo`, `listDerivedDataEntries`, `classifyDerivedData`, `findDerivedDataFor`, `findOrphanedDerivedData`.

**Why this is a split and not a deletion:** the mounted-volume guard protects
two different things, and only one of them goes away. Guarding *DerivedData
classification* stops being necessary once build output is workspace-local.
Guarding the *project registry* does not: `findReclaimablePort` in `ports.js`
must still refuse to reclaim the port of a project whose volume is merely
unplugged, because reclaiming removes the whole entry and drops its device
claim. Deleting `isOnMountedVolume` would silently reintroduce that bug.

- [ ] **Step 1: Copy the surviving tests into the new test file**

Copy from `test/artifacts.test.js` every test for `volumeRootFor`,
`isRealMount`, `listMountedVolumes`, `isOnMountedVolume`, `directorySize` and
`formatBytes` into `test/fs-util.test.js`, changing only the import path to
`../src/fs-util.js`. Do not copy the `parseDerivedDataInfo`,
`listDerivedDataEntries`, `classifyDerivedData` or `findOrphanedDerivedData`
tests — those cover code being deleted.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rn-iso && node --test test/fs-util.test.js`
Expected: FAIL, `Cannot find module '../src/fs-util.js'`

- [ ] **Step 3: Create fs-util.js**

Move the six surviving functions from `src/artifacts.js` verbatim, along with
their explanatory comments — particularly the one on `volumeRootFor` about
case-insensitive normalization, and the one on `isOnMountedVolume` about
failing closed. Keep the `fs` and `path` imports the moved code needs and drop
the rest.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rn-iso && node --test test/fs-util.test.js`
Expected: PASS

- [ ] **Step 5: Update all nine importers**

Change `from './artifacts.js'` to `from './fs-util.js'` (and
`'../artifacts.js'` to `'../fs-util.js'`). Then delete every call to a
DerivedData function. `src/commands/gc.js` and `src/commands/prune.js` lose
whole code paths here; leave the surrounding command working and report
nothing where the artifact section used to be. Task 5 rewrites `gc` properly.

- [ ] **Step 6: Delete the old files**

```bash
git rm packages/rn-iso/src/artifacts.js packages/rn-iso/test/artifacts.test.js
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test` from the repo root.
Expected: PASS. A failure naming `artifacts.js` means an importer was missed.

- [ ] **Step 8: Commit**

```bash
git add -A packages/rn-iso
git commit -m "refactor: split artifacts.js, keep volume and size utils in fs-util"
```

---

### Task 3: init writes the layout into the repo

**Files:**
- Modify: `packages/rn-iso/src/init.js` (`renderWorktreeExclude` at line 216)
- Modify: `packages/rn-iso/src/commands/init.js`
- Test: `packages/rn-iso/test/init.test.js`

**Interfaces:**
- Consumes: `workspaceDerivedData`, `sharedCompilationCache` from `src/paths.js` (Task 1).
- Produces: `renderGitignoreAdditions()` returning the lines `init` appends to `.gitignore`; `renderPodfileCasPin()` returning the `post_install` lines that pin the compilation cache.

**Do NOT try to redirect DerivedData from an xcconfig.** `-derivedDataPath` is
an `xcodebuild` command-line argument, not a build setting; `SYMROOT` and
`OBJROOT` control where build *products* land, which is a different and
narrower thing. The redirection is applied by the `ios` command passing
`-derivedDataPath $(workspaceDerivedData(root))` at build time, which lands in
step 3. `init` has nothing to write for it, because `src/paths.js` already
derives the path from the project root -- there is no configuration to store.

**The two interactions that must not be missed:**

1. `.rn-iso/` must land in **both** `.gitignore` and `.worktreeexclude`.
   Missing the second means `worktree create --carry-ignored` clones another
   workspace's DerivedData, logs and pidfile into a fresh worktree, which is
   strictly worse than starting cold.
2. `COMPILATION_CACHE_CAS_PATH` must be pinned to `sharedCompilationCache()`.
   Xcode's default CAS path is *inside* DerivedData, so redirecting DerivedData
   into the worktree would drag the CAS in with it and make it per-worktree,
   sharing nothing. `doctor.js`'s `checkCompilationCache` (line 96) already
   warns about exactly this and its message stays accurate.

- [ ] **Step 1: Write the failing test**

```js
test('worktreeExclude excludes the workspace dir', () => {
  assert.match(renderWorktreeExclude(), /^\.rn-iso\/$/m);
});

test('gitignore additions cover the workspace dir', () => {
  assert.match(renderGitignoreAdditions(), /^\.rn-iso\/$/m);
});

test('podfile pin puts the CAS outside DerivedData', () => {
  const out = renderPodfileCasPin();
  assert.match(out, /COMPILATION_CACHE_ENABLE_CACHING/);
  assert.match(out, /COMPILATION_CACHE_CAS_PATH/);
  // The whole point: it must not land anywhere under a workspace-local
  // derived-data tree, or it is shared with nothing.
  assert.doesNotMatch(out, /\.rn-iso\/derived-data/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rn-iso && node --test test/init.test.js`
Expected: FAIL, `renderGitignoreAdditions is not a function`

- [ ] **Step 3: Implement**

Add `.rn-iso/` to the template returned by `renderWorktreeExclude()`, with a
comment saying why (carrying another workspace's build output and pidfile is
worse than an empty cache). Add the two new render functions. Have
`src/commands/init.js` append the gitignore lines idempotently — appending
twice must not duplicate them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rn-iso && node --test test/init.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/rn-iso/src/init.js packages/rn-iso/src/commands/init.js packages/rn-iso/test/init.test.js
git commit -m "feat: init redirects DerivedData into the workspace, pins the CAS outside it"
```

---

### Task 4: doctor reports the layout

**Files:**
- Modify: `packages/rn-iso/src/doctor.js` (add beside `checkCompilationCache`, line 96; register in `runDoctor`, line 217)
- Test: `packages/rn-iso/test/doctor.test.js`

**Interfaces:**
- Consumes: `finding(level, title, detail, fix)` from `src/doctor.js` line 38.
- Produces: `checkArtifactLayout({ gitignoreSource, worktreeExcludeSource })` returning a finding or `null`. Pure — it is a function of the text it is given, matching every other check in the file.

- [ ] **Step 1: Write the failing test**

```js
test('reports when .rn-iso is gitignored but not worktree-excluded', () => {
  const f = checkArtifactLayout({
    gitignoreSource: '.rn-iso/\n',
    worktreeExcludeSource: '**/*.log\n',
  });
  assert.ok(f, 'expected a finding');
  assert.match(f.detail, /carry/i);
});

test('silent when both are wired', () => {
  assert.strictEqual(checkArtifactLayout({
    gitignoreSource: '.rn-iso/\n',
    worktreeExcludeSource: '.rn-iso/\n',
  }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rn-iso && node --test test/doctor.test.js`
Expected: FAIL, `checkArtifactLayout is not a function`

- [ ] **Step 3: Implement**, and register the check in `runDoctor`'s findings array alongside `checkCompilationCache(podfile, xcodeMajor)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/rn-iso && node --test test/doctor.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/rn-iso/src/doctor.js packages/rn-iso/test/doctor.test.js
git commit -m "feat: doctor reports an unwired artifact layout"
```

---

### Task 5: Narrow gc, delete prune and cache

**Files:**
- Modify: `packages/rn-iso/src/commands/gc.js`
- Delete: `packages/rn-iso/src/commands/prune.js`, `packages/rn-iso/test/prune.test.js`, `packages/rn-iso/src/commands/cache.js`, `packages/rn-iso/test/cache-command.test.js`
- Modify: `packages/rn-iso/bin/cli.js` (drop the `pruneCommand` and `cacheCommand` registrations)
- Test: `packages/rn-iso/test/gc.test.js`

**Interfaces:**
- Consumes: `findOrphanedDevices` (already in `gc.js`), `discoverCaches`/`sizeCaches`/`pruneCache` from `src/caches.js`, `teardownOwnedIosSim`/`teardownOwnedAvd` from `src/teardown.js`.
- Produces: `gc [--delete] [--older-than <days>]`. Bare `gc` reports and never writes.
- `--delete --older-than <days>` must ALSO reap owned devices whose project has
  not been touched in that many days, not only fully orphaned ones. This is not
  optional polish: `stop` has no `--delete`, and a checkout that is not a
  worktree cannot be `worktree remove`d, so without this sweep the main
  checkout's simulator is shut down but never reaped and accumulates one per
  project forever. Reap through `src/teardown.js`; never delete a device
  directly.

**What changes and why:** `gc` loses the DerivedData sweep, because build output
now lives inside the workspace and `worktree remove` reclaims it by
construction. It **keeps** dead project entries and orphaned owned devices: a
project directory deleted by hand still leaves a registry entry, a reserved
port and a real simulator behind, and with `prune` and `up` both gone, nothing
else on the machine would ever reap them. Those are not caches and must not be
filed under a cache verb. `cache register`/`forget`/`list` fold into `gc`'s
report now that v3 prescribes the cache paths; the programmatic
`rn-iso/cache-manifest` export stays, because that is how `@rn-iso/metro` and
`build-cache.js` self-register.

- [ ] **Step 1: Write the failing test**

```js
test('bare gc reports and deletes nothing', async () => {
  const cfg = loadConfig();
  await runGc({ delete: false });
  assert.deepStrictEqual(loadConfig(), cfg, 'bare gc must not mutate config');
});

test('gc no longer reports DerivedData', async () => {
  const report = await collectGcReport({ delete: false });
  assert.ok(!('derivedData' in report), 'DerivedData sweep should be gone');
  assert.ok('deadProjects' in report);
  assert.ok('orphanedDevices' in report);
  assert.ok('caches' in report);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/rn-iso && node --test test/gc.test.js`
Expected: FAIL on the `derivedData` assertion

- [ ] **Step 3: Implement.** Remove the DerivedData section from `gc.js`. Keep dead entries, orphaned devices and caches. Fold the cache listing in. Delete `prune.js` and `cache.js` and their registrations in `bin/cli.js`.

- [ ] **Step 4: Run the whole suite**

Run: `npm test` from the repo root.
Expected: PASS.

- [ ] **Step 5: Live-verify** — `CLAUDE.md` item 9 applies, since `gc --delete` shells out to `simctl` and `avdmanager`. Create a throwaway owned sim, remove its project entry, run `rn-iso gc` (report only), confirm it names the sim, then `gc --delete` and confirm `xcrun simctl list devices` no longer shows it. Record the transcript in the task report.

- [ ] **Step 6: Commit**

```bash
git add -A packages/rn-iso
git commit -m "refactor: narrow gc to dead entries, orphaned devices and caches"
```

---

---

### Task 6: Reconcile the cache paths across all three implementations

**Files:**
- Modify: `packages/rn-iso/src/paths.js`, `packages/rn-iso/src/build-cache.js`
- Modify: `packages/metro-cache/index.js`, `packages/expo-build-cache/index.js`
- Modify: `packages/rn-iso/src/commands/init.js`, `packages/rn-iso/src/doctor.js`
- Modify: `CLAUDE.md`
- Test: `packages/rn-iso/test/paths.test.js`, `packages/rn-iso/test/cache-packages.test.js`

**The problem.** Task 1 declared shared paths that disagree with reality:

| | today | `paths.js` |
|---|---|---|
| build cache | `~/.rn-iso-build-cache` | `~/.rn-iso/build-cache` |
| metro cache | `~/.<name>-metro-cache` | `~/.rn-iso/metro-cache` |

Three separate things follow, and missing any one of them ships a bug.

1. **`paths.js` ignores the existing env overrides.** `RN_ISO_BUILD_CACHE` and
   `RN_ISO_METRO_CACHE` are honoured by the current implementations. `paths.js`
   must honour them too, or setting one silently stops working.
2. **The two CJS packages duplicate this logic ON PURPOSE.** `CLAUDE.md`
   records why: they must work with no rn-iso installed. Changing only
   `paths.js` splits the CLI and the providers onto different directories, so
   they stop sharing a cache -- the identical failure `CLAUDE.md` already warns
   about for `buildCacheKey`. All three move together or none do.
3. **Existing caches must not be silently orphaned.** They can be many GB, and
   leaving them stranded costs disk AND a cold rebuild in every project.

- [ ] **Step 1: Write the failing tests**

```js
test('shared paths honour the legacy env overrides', () => {
  process.env.RN_ISO_BUILD_CACHE = '/tmp/custom-build';
  assert.strictEqual(sharedBuildCache(), '/tmp/custom-build');
  delete process.env.RN_ISO_BUILD_CACHE;

  process.env.RN_ISO_METRO_CACHE = '/tmp/custom-metro';
  assert.strictEqual(sharedMetroCache(), '/tmp/custom-metro');
  delete process.env.RN_ISO_METRO_CACHE;
});

test('the CJS providers resolve the same root the CLI does', () => {
  // The whole point of this test: if these two ever disagree, the CLI stores
  // builds somewhere the Expo provider will never look for them.
  assert.strictEqual(require('../../expo-build-cache/index.js').cacheRoot(),
                     sharedBuildCache());
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/rn-iso && node --test test/paths.test.js test/cache-packages.test.js`
Expected: FAIL -- `sharedBuildCache()` returns the `getConfigDir()`-derived path, ignoring the env var.

- [ ] **Step 3: Make all three agree**

`paths.js` reads `RN_ISO_BUILD_CACHE` / `RN_ISO_METRO_CACHE` first and falls
back to the `getConfigDir()` layout. Update `packages/metro-cache/index.js` and
`packages/expo-build-cache/index.js` to compute the identical path with the
identical precedence. They cannot import `paths.js` (they must work with rn-iso
absent), so this is a deliberate duplication -- add a comment in each pointing
at the other two, exactly as the existing `buildCacheKey` comment does.

- [ ] **Step 4: Migrate on init, do not strand**

`init` renames a legacy cache directory into its new location when the legacy
one exists and the destination does not. A rename on the same volume is
instantaneous regardless of size. If the rename fails (cross-device, or
permissions), do NOT copy and do NOT delete -- report the legacy path and let
`gc` list it as reclaimable. Failing closed is the standing rule.

Add a `doctor` finding for a legacy directory that is still present, naming its
size and the remedy.

- [ ] **Step 5: Update CLAUDE.md**

The "two cache packages duplicate a little of `src/build-cache.js` on purpose"
paragraph currently names only `buildCacheKey`. It must now also name the cache
ROOT resolution, with the same warning: change one and you must change the
others, or the CLI and the providers quietly stop sharing a cache.

- [ ] **Step 6: Run the full suite**

Run: `npm test` from the repo root. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A packages/rn-iso packages/metro-cache packages/expo-build-cache CLAUDE.md
git commit -m "fix: one cache root across the CLI and both providers, with migration"
```

---

## Out of scope for this step

`start`, `stop`, `logs`, `ios`, `android`, the supervisor, the NDJSON reporter,
and the removal of `up`/`device`/`release`/`shutdown`/`--serial`. Those land in
steps 2 through 4. This step must leave `npm test` green and the v2 CLI usable
at every commit.
