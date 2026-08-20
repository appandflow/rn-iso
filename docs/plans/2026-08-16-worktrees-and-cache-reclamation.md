# Worktree Creation and Cache Reclamation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `rn-iso worktree create|remove|list` and `rn-iso gc` so a git worktree can be created with its environment set up and torn down without leaking build artifacts.

**Architecture:** Three new modules (`settings.js`, `worktree.js`, `artifacts.js`) plus two new command modules. Settings gain two inheritance layers keyed by git-common-dir and a committed `.rn-iso.json`, so a fresh worktree inherits configuration its absolute path cannot provide. Reclamation maps DerivedData directories back to projects via each directory's `info.plist` `WorkspacePath`.

**Tech Stack:** Node 20+, ESM only, `commander`, `chalk`, `prompts`. Tests are `node --test` with no framework.

## Global Constraints

- **ESM only.** `"type": "module"`, no transpiler, no `require()`.
- **All `child_process` goes through `src/exec.js`** (`getExecutor()`). Importing `child_process` anywhere outside `exec.js` is a bug.
- **ASCII only in `src/`, `bin/`, `test/`.** No em dashes, smart quotes, or check marks. Markdown files may use them.
- **Pure parsing separated from invocation.** Pure functions are unit-tested; I/O wrappers around them stay thin.
- **`RN_ISO_HOME` redirects all config and log paths** via `getConfigDir()`. Every config-touching test sets it in `beforeEach` and deletes it in `afterEach`.
- **Update `skill/SKILL.md` whenever user-facing behavior changes** (Task 11).
- **Commits:** conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`), titles under ~70 chars. Do not pass `--no-gpg-sign`; do not force signing either (no signing key is configured on this machine).
- **Never auto-create simulators.** Preserve the existing invariant.
- **Ambiguity always resolves toward not deleting.** Any unreadable metadata, unparseable probe output, or absent volume means "skip", never "orphan".

Run the full suite with `npm test` at the end of every task.

---

### Task 1: Config schema v2 with a `repos` section

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `getRepoSettings(gitCommonDir)`, `setRepoSetting(gitCommonDir, dottedKey, value)`, `unsetRepoSetting(gitCommonDir, dottedKey)`. `ensureConfig()` now returns `{version: 2, projects: {}, repos: {}}`.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.js` (import `getRepoSettings`, `setRepoSetting`, `unsetRepoSetting` in the existing import block):

```js
test('ensureConfig creates a v2 config with a repos section', () => {
  const cfg = ensureConfig();
  assert.equal(cfg.version, 2);
  assert.deepEqual(cfg.repos, {});
});

test('migrates a v1 config without touching projects', () => {
  saveConfig({
    version: 1,
    projects: { '/a': { metroPort: 8082, platforms: { ios: { deviceUdid: 'U1' } } } },
  });
  const cfg = ensureConfig();
  assert.equal(cfg.version, 2);
  assert.deepEqual(cfg.repos, {});
  assert.deepEqual(cfg.projects['/a'], {
    metroPort: 8082,
    platforms: { ios: { deviceUdid: 'U1' } },
  });
});

test('repo settings round-trip by git common dir', () => {
  setRepoSetting('/repo/.git', 'worktreeDir', '/wt');
  setRepoSetting('/repo/.git', 'worktree.baseRef', 'head');
  assert.deepEqual(getRepoSettings('/repo/.git'), {
    worktreeDir: '/wt',
    worktree: { baseRef: 'head' },
  });
  assert.equal(unsetRepoSetting('/repo/.git', 'worktree.baseRef'), true);
  assert.deepEqual(getRepoSettings('/repo/.git'), { worktreeDir: '/wt' });
});

test('getRepoSettings returns an empty object for an unknown repo', () => {
  assert.deepEqual(getRepoSettings('/nope/.git'), {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.js`
Expected: FAIL — `getRepoSettings is not a function`, and the v2 assertions fail with `version` 1.

- [ ] **Step 3: Implement the migration and repo accessors**

In `src/config.js`, replace `ensureConfig` and add the accessors. `writeNested`, `readNested`, and `deleteNested` already exist in this file and are reused as-is.

```js
const CONFIG_VERSION = 2;

export function ensureConfig() {
  const existing = loadConfig();
  if (existing) {
    // Migration is additive: add `repos` and bump the version, never rewrite
    // `projects`. A v1 config carries live device claims we must not lose.
    let changed = false;
    if (!existing.repos) {
      existing.repos = {};
      changed = true;
    }
    if (existing.version !== CONFIG_VERSION) {
      existing.version = CONFIG_VERSION;
      changed = true;
    }
    if (changed) saveConfig(existing);
    return existing;
  }
  const fresh = { version: CONFIG_VERSION, projects: {}, repos: {} };
  saveConfig(fresh);
  return fresh;
}

export function getRepoSettings(gitCommonDir) {
  const cfg = loadConfig();
  return cfg?.repos?.[gitCommonDir]?.settings || {};
}

export function setRepoSetting(gitCommonDir, dottedKey, value) {
  const cfg = ensureConfig();
  cfg.repos[gitCommonDir] = cfg.repos[gitCommonDir] || {};
  cfg.repos[gitCommonDir].settings = cfg.repos[gitCommonDir].settings || {};
  writeNested(cfg.repos[gitCommonDir].settings, dottedKey, value);
  saveConfig(cfg);
}

export function unsetRepoSetting(gitCommonDir, dottedKey) {
  const cfg = loadConfig();
  const settings = cfg?.repos?.[gitCommonDir]?.settings;
  if (!settings) return false;
  const removed = deleteNested(settings, dottedKey);
  if (removed) saveConfig(cfg);
  return removed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, including every pre-existing config test.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): add v2 schema with per-repo settings section"
```

---

### Task 2: Layered settings resolution

**Files:**
- Create: `src/settings.js`
- Test: `test/settings.test.js`

**Interfaces:**
- Consumes: `getProjectSettings`, `getRepoSettings` from Task 1.
- Produces: `mergeSettingsLayers(layers)` (pure, first-wins over an ordered array), `resolveSettings({projectPath, gitCommonDir, repoRoot})` returning the merged object, `readCommittedSettings(repoRoot)` reading `<repoRoot>/.rn-iso.json`.

- [ ] **Step 1: Write the failing tests**

Create `test/settings.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeSettingsLayers, readCommittedSettings, resolveSettings } from '../src/settings.js';
import { setProjectSetting, setRepoSetting, upsertProject } from '../src/config.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('earlier layers win over later ones', () => {
  const merged = mergeSettingsLayers([
    { packageManager: 'bun' },
    { packageManager: 'pnpm', worktreeDir: '/b' },
  ]);
  assert.deepEqual(merged, { packageManager: 'bun', worktreeDir: '/b' });
});

test('merges nested objects key by key rather than replacing them', () => {
  const merged = mergeSettingsLayers([
    { worktree: { baseRef: 'head' } },
    { worktree: { baseRef: 'fresh', install: ['pnpm install'] } },
  ]);
  assert.deepEqual(merged, { worktree: { baseRef: 'head', install: ['pnpm install'] } });
});

test('ignores null and undefined layers', () => {
  assert.deepEqual(mergeSettingsLayers([null, { a: 1 }, undefined]), { a: 1 });
});

test('an array value is replaced wholesale, not concatenated', () => {
  const merged = mergeSettingsLayers([
    { worktree: { install: ['a'] } },
    { worktree: { install: ['b', 'c'] } },
  ]);
  assert.deepEqual(merged.worktree.install, ['a']);
});

test('readCommittedSettings reads .rn-iso.json', () => {
  writeFileSync(join(tmpHome, '.rn-iso.json'), JSON.stringify({ packageManager: 'yarn' }));
  assert.deepEqual(readCommittedSettings(tmpHome), { packageManager: 'yarn' });
});

test('readCommittedSettings returns empty for missing or malformed files', () => {
  assert.deepEqual(readCommittedSettings(tmpHome), {});
  writeFileSync(join(tmpHome, '.rn-iso.json'), '{ not json');
  assert.deepEqual(readCommittedSettings(tmpHome), {});
});

test('resolveSettings orders project over repo over committed', () => {
  writeFileSync(
    join(tmpHome, '.rn-iso.json'),
    JSON.stringify({ packageManager: 'yarn', worktree: { baseRef: 'fresh' } })
  );
  setRepoSetting('/repo/.git', 'packageManager', 'pnpm');
  upsertProject('/proj', {});
  setProjectSetting('/proj', 'packageManager', 'bun');

  const merged = resolveSettings({
    projectPath: '/proj',
    gitCommonDir: '/repo/.git',
    repoRoot: tmpHome,
  });
  assert.equal(merged.packageManager, 'bun');
  assert.equal(merged.worktree.baseRef, 'fresh');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/settings.test.js`
Expected: FAIL — cannot find module `../src/settings.js`.

- [ ] **Step 3: Implement `src/settings.js`**

```js
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProjectSettings, getRepoSettings } from './config.js';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// First layer wins. Nested plain objects merge key by key so a repo can set
// worktree.baseRef without erasing a committed worktree.install. Arrays are
// replaced wholesale: a partial override of a command pipeline would be
// meaningless.
export function mergeSettingsLayers(layers) {
  const out = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = mergeSettingsLayers([out[key], value]);
      } else if (!(key in out)) {
        out[key] = value;
      }
    }
  }
  return out;
}

export function readCommittedSettings(repoRoot) {
  if (!repoRoot) return {};
  const p = join(repoRoot, '.rn-iso.json');
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // A malformed committed file must not break every command. Callers that
    // care can surface it; resolution treats it as absent.
    return {};
  }
}

export function resolveSettings({ projectPath, gitCommonDir, repoRoot }) {
  return mergeSettingsLayers([
    projectPath ? getProjectSettings(projectPath) : null,
    gitCommonDir ? getRepoSettings(gitCommonDir) : null,
    readCommittedSettings(repoRoot),
  ]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.js test/settings.test.js
git commit -m "feat(settings): add layered settings resolution"
```

---

### Task 3: DerivedData discovery and orphan classification

**Files:**
- Create: `src/artifacts.js`
- Test: `test/artifacts.test.js`

**Interfaces:**
- Consumes: `getExecutor` from `src/exec.js`.
- Produces: `parseDerivedDataInfo(plistJson)` returning `{workspacePath, lastAccessed}`; `volumeRootFor(path)`; `classifyDerivedData(entries, {mountedVolumes, now, olderThanDays})` returning `{orphaned, live, skipped}`; `derivedDataRoot()`; `listDerivedDataEntries()`.

- [ ] **Step 1: Write the failing tests**

Create `test/artifacts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDerivedDataInfo,
  volumeRootFor,
  classifyDerivedData,
} from '../src/artifacts.js';

test('parses WorkspacePath and LastAccessedDate from plutil json', () => {
  const json = JSON.stringify({
    WorkspacePath: '/Volumes/ExternalSSD/Developer/app/ios/App.xcworkspace',
    LastAccessedDate: '2026-08-03T21:38:12Z',
  });
  const info = parseDerivedDataInfo(json);
  assert.equal(info.workspacePath, '/Volumes/ExternalSSD/Developer/app/ios/App.xcworkspace');
  assert.equal(info.lastAccessed instanceof Date, true);
});

test('returns null for unparseable or incomplete plist json', () => {
  assert.equal(parseDerivedDataInfo('not json'), null);
  assert.equal(parseDerivedDataInfo(JSON.stringify({ LastAccessedDate: '2026-01-01' })), null);
});

test('volumeRootFor identifies external and boot volumes', () => {
  assert.equal(volumeRootFor('/Volumes/ExternalSSD/Developer/app'), '/Volumes/ExternalSSD');
  assert.equal(volumeRootFor('/Users/j/Developer/app'), '/');
});

test('classifies a missing workspace on a mounted volume as orphaned', () => {
  const result = classifyDerivedData(
    [{ dir: '/dd/App-abc', workspacePath: '/Volumes/ExternalSSD/gone/App.xcworkspace', exists: false }],
    { mountedVolumes: ['/', '/Volumes/ExternalSSD'] }
  );
  assert.deepEqual(result.orphaned.map(e => e.dir), ['/dd/App-abc']);
  assert.equal(result.skipped.length, 0);
});

test('skips rather than orphans when the volume is not mounted', () => {
  const result = classifyDerivedData(
    [{ dir: '/dd/App-abc', workspacePath: '/Volumes/ExternalSSD/x/App.xcworkspace', exists: false }],
    { mountedVolumes: ['/'] }
  );
  assert.equal(result.orphaned.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /not mounted/);
});

test('skips entries whose metadata could not be read', () => {
  const result = classifyDerivedData(
    [{ dir: '/dd/App-abc', workspacePath: null, exists: false }],
    { mountedVolumes: ['/'] }
  );
  assert.equal(result.orphaned.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /unreadable/);
});

test('an existing workspace is live, never orphaned', () => {
  const result = classifyDerivedData(
    [{ dir: '/dd/App-abc', workspacePath: '/live/App.xcworkspace', exists: true }],
    { mountedVolumes: ['/'] }
  );
  assert.deepEqual(result.live.map(e => e.dir), ['/dd/App-abc']);
  assert.equal(result.orphaned.length, 0);
});

test('olderThanDays keeps recently accessed orphans out of the result', () => {
  const now = new Date('2026-08-16T00:00:00Z');
  const entries = [
    { dir: '/dd/old', workspacePath: '/gone/A.xcworkspace', exists: false, lastAccessed: new Date('2026-07-01T00:00:00Z') },
    { dir: '/dd/new', workspacePath: '/gone/B.xcworkspace', exists: false, lastAccessed: new Date('2026-08-15T00:00:00Z') },
  ];
  const result = classifyDerivedData(entries, { mountedVolumes: ['/'], now, olderThanDays: 7 });
  assert.deepEqual(result.orphaned.map(e => e.dir), ['/dd/old']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/artifacts.test.js`
Expected: FAIL — cannot find module `../src/artifacts.js`.

- [ ] **Step 3: Implement `src/artifacts.js`**

```js
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getExecutor } from './exec.js';

export function derivedDataRoot() {
  return join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
}

export function parseDerivedDataInfo(plistJson) {
  let data;
  try {
    data = JSON.parse(plistJson);
  } catch {
    return null;
  }
  const workspacePath = data?.WorkspacePath;
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) return null;
  const raw = data.LastAccessedDate;
  const lastAccessed = raw ? new Date(raw) : null;
  return {
    workspacePath,
    lastAccessed: lastAccessed && !isNaN(lastAccessed.getTime()) ? lastAccessed : null,
  };
}

// "/Volumes/Foo/bar" -> "/Volumes/Foo"; anything else is on the boot volume.
export function volumeRootFor(path) {
  const m = String(path).match(/^(\/Volumes\/[^/]+)/);
  return m ? m[1] : '/';
}

export function listMountedVolumes() {
  const roots = ['/'];
  try {
    for (const name of readdirSync('/Volumes')) {
      roots.push(join('/Volumes', name));
    }
  } catch {
    // No /Volumes (or unreadable). The boot volume is still mounted.
  }
  return roots;
}

export function listDerivedDataEntries(root = derivedDataRoot()) {
  const exec = getExecutor();
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const plist = join(dir, 'info.plist');
    if (!existsSync(plist)) {
      // Shared caches like ModuleCache.noindex have no info.plist. They belong
      // to no project and must never be classified.
      continue;
    }
    const out = exec.runQuiet(`plutil -convert json -o - "${plist}"`);
    const info = out ? parseDerivedDataInfo(out) : null;
    entries.push({
      dir,
      workspacePath: info?.workspacePath || null,
      lastAccessed: info?.lastAccessed || null,
      exists: info?.workspacePath ? existsSync(info.workspacePath) : false,
    });
  }
  return entries;
}

// Pure. Every branch that cannot prove a directory is orphaned puts it in
// `skipped`, never in `orphaned`.
export function classifyDerivedData(entries, { mountedVolumes, now, olderThanDays } = {}) {
  const mounted = new Set(mountedVolumes || []);
  const orphaned = [];
  const live = [];
  const skipped = [];

  for (const entry of entries) {
    if (!entry.workspacePath) {
      skipped.push({ ...entry, reason: 'unreadable info.plist' });
      continue;
    }
    if (entry.exists) {
      live.push(entry);
      continue;
    }
    const volume = volumeRootFor(entry.workspacePath);
    if (!mounted.has(volume)) {
      // The workspace looks gone only because its disk is not attached.
      // Deleting here would destroy live build output.
      skipped.push({ ...entry, reason: `volume ${volume} is not mounted` });
      continue;
    }
    if (olderThanDays != null) {
      if (!entry.lastAccessed) {
        skipped.push({ ...entry, reason: 'no LastAccessedDate to age-filter on' });
        continue;
      }
      const ageDays = ((now || new Date()) - entry.lastAccessed) / 86400000;
      if (ageDays < olderThanDays) {
        live.push(entry);
        continue;
      }
    }
    orphaned.push(entry);
  }

  return { orphaned, live, skipped };
}

export function findDerivedDataFor(projectPath, root = derivedDataRoot()) {
  const prefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return listDerivedDataEntries(root).filter(
    e => e.workspacePath && (e.workspacePath === projectPath || e.workspacePath.startsWith(prefix))
  );
}

export function findOrphanedDerivedData({ olderThanDays } = {}) {
  return classifyDerivedData(listDerivedDataEntries(), {
    mountedVolumes: listMountedVolumes(),
    now: new Date(),
    olderThanDays,
  });
}

export function directorySize(dir) {
  const out = getExecutor().runQuiet(`du -sk "${dir}"`);
  if (!out) return 0;
  const kb = parseInt(out.split(/\s+/)[0], 10);
  return isNaN(kb) ? 0 : kb * 1024;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  return `${Math.round(bytes / 1024)}K`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/artifacts.js test/artifacts.test.js
git commit -m "feat(artifacts): map DerivedData to projects and classify orphans"
```

---

### Task 4: Shared `reclaimProject`, with `prune` delegating to it

**Files:**
- Create: `src/reclaim.js`
- Modify: `src/commands/prune.js`
- Test: `test/reclaim.test.js`

**Interfaces:**
- Consumes: `pruneDeadProjects`, `removeProject` (config.js); `findPidListeningOnPort` (metro.js); `findDerivedDataFor`, `directorySize` (Task 3).
- Produces: `reclaimProject(path, {deleteArtifacts})` returning `{path, freed: string[], artifacts: [{dir, bytes}], killedPid}`.

- [ ] **Step 1: Write the failing test**

Create `test/reclaim.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { upsertProject, setDevice, getProject } from '../src/config.js';
import { describeFreed } from '../src/reclaim.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
  resetExecutor();
});

test('describeFreed lists ios and android claims', () => {
  const freed = describeFreed({
    platforms: { ios: { deviceUdid: 'U1' }, android: { avdName: 'Pixel_6' } },
  });
  assert.deepEqual(freed, ['ios sim U1', 'android avd Pixel_6']);
});

test('describeFreed reports a physical android device when there is no avd', () => {
  assert.deepEqual(describeFreed({ platforms: { android: { serial: 'R5CT' } } }), [
    'android device R5CT',
  ]);
});

test('describeFreed returns an empty list when nothing is claimed', () => {
  assert.deepEqual(describeFreed({ platforms: {} }), []);
  assert.deepEqual(describeFreed({}), []);
});

test('reclaimProject removes the config entry', async () => {
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  const { reclaimProject } = await import('../src/reclaim.js');
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1' });

  const result = reclaimProject('/proj', { deleteArtifacts: false });
  assert.equal(result.path, '/proj');
  assert.deepEqual(result.freed, ['ios sim U1']);
  assert.equal(getProject('/proj'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/reclaim.test.js`
Expected: FAIL — cannot find module `../src/reclaim.js`.

- [ ] **Step 3: Implement `src/reclaim.js`**

```js
import { rmSync } from 'fs';
import { getProject, removeProject } from './config.js';
import { findPidListeningOnPort } from './metro.js';
import { directorySize, findDerivedDataFor } from './artifacts.js';

export function describeFreed(project) {
  const freed = [];
  const ios = project?.platforms?.ios;
  if (ios?.deviceUdid) freed.push(`ios sim ${ios.deviceUdid}`);
  const android = project?.platforms?.android;
  if (android?.avdName) freed.push(`android avd ${android.avdName}`);
  else if (android?.serial) freed.push(`android device ${android.serial}`);
  return freed;
}

// Drop a project's rn-iso state and, optionally, its external build output.
// Shared by `prune`, `gc`, and `worktree remove` so the three cannot drift.
export function reclaimProject(path, { deleteArtifacts = false } = {}) {
  const project = getProject(path);
  const freed = describeFreed(project);

  const artifacts = findDerivedDataFor(path).map(entry => ({
    dir: entry.dir,
    bytes: directorySize(entry.dir),
  }));

  if (deleteArtifacts) {
    for (const artifact of artifacts) {
      rmSync(artifact.dir, { recursive: true, force: true });
    }
  }

  // A Metro started from a deleted directory can outlive it and squat on the
  // port, so the port is not genuinely free until the process is gone.
  let killedPid = null;
  if (typeof project?.metroPort === 'number') {
    const pid = findPidListeningOnPort(project.metroPort);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        killedPid = pid;
      } catch {
        killedPid = null;
      }
    }
  }

  if (project) removeProject(path);

  return { path, freed, artifacts, killedPid, metroPort: project?.metroPort ?? null };
}
```

- [ ] **Step 4: Rewrite `src/commands/prune.js` to delegate**

Replace the file's `.action(...)` body. `prune` keeps its existing contract: config only, never disk.

```js
// src/commands/prune.js
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { existsSync } from 'fs';
import { reclaimProject } from '../reclaim.js';

export default function pruneCommand(program) {
  program
    .command('prune')
    .description('Remove entries for projects whose directory no longer exists (deleted worktrees), freeing their sims/emulators and Metro ports. Live projects are never touched. Does not delete build artifacts; see `gc`.')
    .action(() => {
      const cfg = loadConfig();
      const deadPaths = Object.keys(cfg?.projects || {}).filter(p => !existsSync(p));

      if (deadPaths.length === 0) {
        console.log(chalk.dim('Nothing to prune: every registered project path still exists.'));
        return;
      }

      let reclaimableBytes = 0;
      for (const path of deadPaths) {
        const result = reclaimProject(path, { deleteArtifacts: false });
        console.log(chalk.green(`Pruned ${path}`));
        if (result.freed.length) console.log(chalk.dim(`  freed: ${result.freed.join(', ')}`));
        if (result.killedPid) {
          console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid} on port ${result.metroPort}`));
        }
        for (const artifact of result.artifacts) reclaimableBytes += artifact.bytes;
      }

      console.log(chalk.dim(`\n${deadPaths.length} project entr${deadPaths.length === 1 ? 'y' : 'ies'} removed.`));
      if (reclaimableBytes > 0) {
        console.log(chalk.yellow('Build artifacts from these projects are still on disk. Run `rn-iso gc` to review them.'));
      }
    });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reclaim.js src/commands/prune.js test/reclaim.test.js
git commit -m "feat(reclaim): extract shared reclaimProject and use it in prune"
```

---

### Task 5: The `gc` command

**Files:**
- Create: `src/commands/gc.js`
- Modify: `bin/cli.js`
- Test: `test/gc.test.js`

**Interfaces:**
- Consumes: `findOrphanedDerivedData`, `directorySize`, `formatBytes` (Task 3); `reclaimProject` (Task 4).
- Produces: `formatGcReport({orphaned, skipped, deadProjects, totalBytes})` (pure, returns a string array).

- [ ] **Step 1: Write the failing test**

Create `test/gc.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGcReport } from '../src/commands/gc.js';

test('reports orphans with sizes and a total', () => {
  const lines = formatGcReport({
    orphaned: [{ dir: '/dd/App-abc', workspacePath: '/gone/App.xcworkspace', bytes: 4617089843 }],
    skipped: [],
    deadProjects: [],
    totalBytes: 4617089843,
  }).join('\n');
  assert.match(lines, /App-abc/);
  assert.match(lines, /4\.3G/);
});

test('names skipped entries and why they were skipped', () => {
  const lines = formatGcReport({
    orphaned: [],
    skipped: [{ dir: '/dd/X', reason: 'volume /Volumes/ExternalSSD is not mounted' }],
    deadProjects: [],
    totalBytes: 0,
  }).join('\n');
  assert.match(lines, /not mounted/);
  assert.match(lines, /skipped/i);
});

test('says nothing to reclaim when everything is clean', () => {
  const lines = formatGcReport({ orphaned: [], skipped: [], deadProjects: [], totalBytes: 0 }).join('\n');
  assert.match(lines, /nothing to reclaim/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/gc.test.js`
Expected: FAIL — cannot find module `../src/commands/gc.js`.

- [ ] **Step 3: Implement `src/commands/gc.js`**

```js
import { existsSync, rmSync } from 'fs';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { directorySize, findOrphanedDerivedData, formatBytes } from '../artifacts.js';
import { reclaimProject } from '../reclaim.js';

export function formatGcReport({ orphaned, skipped, deadProjects, totalBytes }) {
  const lines = [];

  if (orphaned.length === 0 && deadProjects.length === 0) {
    lines.push('Nothing to reclaim.');
  }

  if (orphaned.length) {
    lines.push(`Orphaned build artifacts (${orphaned.length}):`);
    for (const entry of orphaned) {
      lines.push(`  ${formatBytes(entry.bytes).padStart(6)}  ${entry.dir}`);
      lines.push(`          was: ${entry.workspacePath}`);
    }
    lines.push(`  total: ${formatBytes(totalBytes)}`);
  }

  if (deadProjects.length) {
    lines.push(`Dead project entries (${deadProjects.length}):`);
    for (const path of deadProjects) lines.push(`  ${path}`);
  }

  if (skipped.length) {
    lines.push(`Skipped (${skipped.length}) - not classified as orphaned:`);
    for (const entry of skipped) lines.push(`  ${entry.dir}: ${entry.reason}`);
  }

  return lines;
}

export default function gcCommand(program) {
  program
    .command('gc')
    .description('Reclaim build artifacts and config entries left behind by worktrees that no longer exist. Reports by default; pass --delete to act.')
    .option('--delete', 'actually delete the reported artifacts and entries')
    .option('--older-than <days>', 'only consider artifacts not accessed in this many days', v => parseInt(v, 10))
    .action(opts => {
      const { orphaned, skipped } = findOrphanedDerivedData({ olderThanDays: opts.olderThan });

      const sized = orphaned.map(entry => ({ ...entry, bytes: directorySize(entry.dir) }));
      const totalBytes = sized.reduce((sum, e) => sum + e.bytes, 0);

      const cfg = loadConfig();
      const deadProjects = Object.keys(cfg?.projects || {}).filter(p => !existsSync(p));

      for (const line of formatGcReport({ orphaned: sized, skipped, deadProjects, totalBytes })) {
        console.log(line);
      }

      if (sized.length === 0 && deadProjects.length === 0) return;

      if (!opts.delete) {
        console.log(chalk.dim('\nDry run. Re-run with --delete to reclaim.'));
        return;
      }

      for (const entry of sized) {
        rmSync(entry.dir, { recursive: true, force: true });
        console.log(chalk.green(`Deleted ${entry.dir}`));
      }
      for (const path of deadProjects) {
        // Artifacts for these were already covered by the orphan sweep above.
        const result = reclaimProject(path, { deleteArtifacts: false });
        console.log(chalk.green(`Pruned ${path}`));
        if (result.killedPid) {
          console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid}`));
        }
      }
      console.log(chalk.dim(`\nReclaimed ${formatBytes(totalBytes)}.`));
    });
}
```

- [ ] **Step 4: Register the command in `bin/cli.js`**

Add the import alongside the others and the call alongside the others:

```js
import gcCommand from '../src/commands/gc.js';
```

```js
gcCommand(program);
```

- [ ] **Step 5: Run tests and a smoke check**

Run: `npm test`
Expected: PASS.

Run: `node bin/cli.js gc`
Expected: exits 0, prints either "Nothing to reclaim." or a report; never deletes.

- [ ] **Step 6: Commit**

```bash
git add src/commands/gc.js bin/cli.js test/gc.test.js
git commit -m "feat(gc): add machine-wide artifact and config reclamation"
```

---

### Task 6: Foreign-runner occupancy detection

**Files:**
- Modify: `src/sim/ios.js`
- Test: `test/sim-ios.test.js`

**Interfaces:**
- Consumes: `getExecutor`.
- Produces: `parseOccupyingApps(launchctlOutput)` returning bundle-id strings; `isSimOccupied(udid)`; `selectIosDevice` now accepts `occupiedUdids` and returns candidates carrying `occupied: boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `test/sim-ios.test.js` (extend the existing import from `../src/sim/ios.js`):

```js
test('parseOccupyingApps finds xctrunner bundles', () => {
  const out = [
    '507e\t0\tUIKitApplication:com.apple.Spotlight[507e][rb-legacy]',
    '082a\t0\tUIKitApplication:com.callstack.agentdevice.runner.uitests.xctrunner[082a][rb-legacy]',
  ].join('\n');
  assert.deepEqual(parseOccupyingApps(out), ['com.callstack.agentdevice.runner.uitests.xctrunner']);
});

test('parseOccupyingApps ignores apple system apps', () => {
  const out = '507e\t0\tUIKitApplication:com.apple.Spotlight[507e][rb-legacy]';
  assert.deepEqual(parseOccupyingApps(out), []);
});

test('parseOccupyingApps fails open on unparseable output', () => {
  assert.deepEqual(parseOccupyingApps(''), []);
  assert.deepEqual(parseOccupyingApps(null), []);
});

test('selectIosDevice excludes occupied sims from allocation', () => {
  setExecutor({
    run: () => JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { udid: 'FREE', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
          { udid: 'BUSY', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
        ],
      },
    }),
    runQuiet: () => null,
    spawn: () => {},
  });
  const result = selectIosDevice({ claimedUdids: [], occupiedUdids: ['BUSY'] });
  assert.equal(result.kind, 'allocate');
  assert.deepEqual(result.candidates.map(c => c.udid), ['FREE']);
});

test('selectIosDevice reports allClaimed when every sim is claimed or occupied', () => {
  setExecutor({
    run: () => JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
          { udid: 'BUSY', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
        ],
      },
    }),
    runQuiet: () => null,
    spawn: () => {},
  });
  const result = selectIosDevice({ claimedUdids: [], occupiedUdids: ['BUSY'] });
  assert.equal(result.kind, 'allClaimed');
  assert.equal(result.candidates[0].occupied, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/sim-ios.test.js`
Expected: FAIL — `parseOccupyingApps is not defined`.

- [ ] **Step 3: Implement occupancy in `src/sim/ios.js`**

Add these functions and replace `selectIosDevice`:

```js
// launchctl lines look like:
//   082a\t0\tUIKitApplication:com.example.app[082a][rb-legacy]
// A foreign UI-test runner holding the sim is the case we care about. Apple's
// own system apps are always present and mean nothing.
export function parseOccupyingApps(launchctlOutput) {
  if (typeof launchctlOutput !== 'string' || launchctlOutput.length === 0) return [];
  const ids = [];
  for (const line of launchctlOutput.split('\n')) {
    const m = line.match(/UIKitApplication:([^[\s]+)/);
    if (!m) continue;
    const bundleId = m[1];
    if (bundleId.startsWith('com.apple.')) continue;
    if (!/\.xctrunner$/.test(bundleId)) continue;
    ids.push(bundleId);
  }
  return ids;
}

// Heuristic, and deliberately fails open: if the probe errors we report "not
// occupied" so a bad probe can never block device selection entirely.
export function isSimOccupied(udid) {
  const out = getExecutor().runQuiet(`xcrun simctl spawn ${udid} launchctl list`);
  return parseOccupyingApps(out).length > 0;
}

export function findOccupiedSims(udids) {
  return udids.filter(udid => {
    try {
      return isSimOccupied(udid);
    } catch {
      return false;
    }
  });
}

export function selectIosDevice({ existingUdid, claimedUdids, occupiedUdids = [], usage = {} }) {
  const sims = listAllIosSims();
  const claimed = new Set(claimedUdids);
  const occupied = new Set(occupiedUdids);

  if (existingUdid) {
    const found = sims.find(s => s.udid === existingUdid);
    if (found) {
      return { kind: 'reuse', udid: found.udid, name: found.name, state: found.state };
    }
  }

  if (sims.length === 0) return { kind: 'noSims' };

  const annotate = list => list.map(s => ({ ...s, occupied: occupied.has(s.udid) }));

  const available = sims.filter(s => !claimed.has(s.udid) && !occupied.has(s.udid));
  if (available.length === 0) {
    // Every sim is claimed by another project, held by a reservation, or busy
    // with a foreign runner. The picker can offer to take one over.
    return { kind: 'allClaimed', candidates: annotate(sortSims(sims, usage)) };
  }

  return { kind: 'allocate', candidates: annotate(sortSims(available, usage)) };
}
```

- [ ] **Step 4: Wire the probe into `src/commands/ios.js`**

Find the `selectIosDevice({ ... })` call and add the occupancy lookup immediately before it. Only booted sims can be occupied, so probe just those.

```js
import { findOccupiedSims, listBootedIosSims } from '../sim/ios.js';

const bootedUdids = listBootedIosSims().map(s => s.udid);
const occupiedUdids = findOccupiedSims(bootedUdids.filter(u => !claimedUdids.includes(u)));

const selection = selectIosDevice({ existingUdid, claimedUdids, occupiedUdids, usage });
```

In the interactive picker, render an occupied candidate the same way a claimed one is rendered, with the tag `[in use]` in `chalk.yellow`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sim/ios.js src/commands/ios.js test/sim-ios.test.js
git commit -m "feat(ios): treat sims held by a foreign xctrunner as occupied"
```

---

### Task 7: `release --shutdown` withholds shutdown for occupied sims

**Files:**
- Modify: `src/commands/release.js`
- Test: `test/release.test.js`

**Interfaces:**
- Consumes: `isSimOccupied` (Task 6).
- Produces: `shouldShutdown({occupied, force})` (pure).

- [ ] **Step 1: Write the failing test**

Create `test/release.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShutdown } from '../src/commands/release.js';

test('shuts down an unoccupied sim', () => {
  assert.deepEqual(shouldShutdown({ occupied: false, force: false }), { shutdown: true, reason: null });
});

test('withholds shutdown for an occupied sim', () => {
  const result = shouldShutdown({ occupied: true, force: false });
  assert.equal(result.shutdown, false);
  assert.match(result.reason, /in use/i);
});

test('--force overrides occupancy', () => {
  assert.deepEqual(shouldShutdown({ occupied: true, force: true }), { shutdown: true, reason: null });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/release.test.js`
Expected: FAIL — `shouldShutdown` is not exported.

- [ ] **Step 3: Implement in `src/commands/release.js`**

Add the pure helper and export it:

```js
export function shouldShutdown({ occupied, force }) {
  if (occupied && !force) {
    return {
      shutdown: false,
      reason: 'simulator is in use by another tool (a UI-test runner is attached)',
    };
  }
  return { shutdown: true, reason: null };
}
```

Add `.option('--force', 'shut down even if the simulator is in use by another tool')` to the command, and gate the existing shutdown call. The rn-iso claim is always released; only the shutdown is withheld.

```js
import { isSimOccupied, shutdownIosSim } from '../sim/ios.js';
import { shouldShutdown } from './release.js';

if (opts.shutdown && udid) {
  const decision = shouldShutdown({ occupied: isSimOccupied(udid), force: opts.force });
  if (decision.shutdown) {
    shutdownIosSim(udid);
    console.log(chalk.green(`Shut down iOS sim ${formatIosLabel(udid)}`));
  } else {
    console.log(chalk.yellow(`Did not shut down ${formatIosLabel(udid)}: ${decision.reason}.`));
    console.log(chalk.dim('The rn-iso claim was released. Pass --force to shut it down anyway.'));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/release.js test/release.test.js
git commit -m "feat(release): withhold shutdown for sims in use by another tool"
```

---

### Task 8: Git worktree operations and carry-over

**Files:**
- Create: `src/worktree.js`
- Test: `test/worktree.test.js`

**Interfaces:**
- Consumes: `getExecutor`.
- Produces: `gitCommonDir(cwd)`, `repoRoot(cwd)`, `defaultWorktreeDir(repoRoot)`, `worktreePath({worktreeDir, name})`, `hasUncommittedWork(dir)`, `unpushedCommits(dir)`, `matchesInclude(path, patterns)` (pure), `carryOverFiles({repoRoot, worktreePath, patterns})`, `addWorktree({path, branch, baseRef})`, `removeWorktree(path, {force})`, `listWorktrees(cwd)`.

- [ ] **Step 1: Write the failing tests**

Create `test/worktree.test.js`:

```js
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, resetExecutor } from '../src/exec.js';
import {
  defaultWorktreeDir,
  worktreePath,
  matchesInclude,
  unpushedCommits,
  hasUncommittedWork,
} from '../src/worktree.js';

afterEach(() => resetExecutor());

test('default worktree dir is a sibling of the repo', () => {
  assert.equal(
    defaultWorktreeDir('/Volumes/ExternalSSD/Developer/tlon-apps'),
    '/Volumes/ExternalSSD/Developer/tlon-apps-worktrees'
  );
});

test('worktreePath joins the dir and the name', () => {
  assert.equal(worktreePath({ worktreeDir: '/wt', name: 'feat-x' }), '/wt/feat-x');
});

test('matchesInclude supports gitignore-style patterns', () => {
  assert.equal(matchesInclude('apps/tlon-mobile/.env', ['.env']), true);
  assert.equal(matchesInclude('apps/tlon-mobile/.env', ['*.env']), false);
  assert.equal(matchesInclude('config/secrets.json', ['config/secrets.json']), true);
  assert.equal(matchesInclude('a/b/c.node', ['**/*.node']), true);
  assert.equal(matchesInclude('apps/x/.env.local', ['.env']), false);
});

test('hasUncommittedWork reflects git status output', () => {
  setExecutor({ run: () => ' M file.js', runQuiet: () => ' M file.js', spawn: () => {} });
  assert.equal(hasUncommittedWork('/wt'), true);
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  assert.equal(hasUncommittedWork('/wt'), false);
});

test('unpushedCommits lists commits missing from every remote', () => {
  setExecutor({
    run: () => 'abc123 first\ndef456 second',
    runQuiet: () => 'abc123 first\ndef456 second',
    spawn: () => {},
  });
  assert.deepEqual(unpushedCommits('/wt'), ['abc123 first', 'def456 second']);
});

test('unpushedCommits returns empty when git reports nothing', () => {
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  assert.deepEqual(unpushedCommits('/wt'), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/worktree.test.js`
Expected: FAIL — cannot find module `../src/worktree.js`.

- [ ] **Step 3: Implement `src/worktree.js`**

```js
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { getExecutor } from './exec.js';

export function gitCommonDir(cwd) {
  const out = getExecutor().runQuiet(`git -C "${cwd}" rev-parse --path-format=absolute --git-common-dir`);
  return out ? out.trim() : null;
}

export function repoRoot(cwd) {
  const out = getExecutor().runQuiet(`git -C "${cwd}" rev-parse --show-toplevel`);
  return out ? out.trim() : null;
}

// Sibling of the repo, on the same volume. Not inside the repo: a worktree
// under the repo root puts a second copy of every package.json inside Metro's
// watch root, which causes jest-haste-map naming collisions.
export function defaultWorktreeDir(root) {
  return join(dirname(root), `${basename(root)}-worktrees`);
}

export function worktreePath({ worktreeDir, name }) {
  return join(worktreeDir, name);
}

// gitignore-style matching, limited to the subset a carry-over list needs:
// a bare name matches that exact path segment chain, `**/` matches any depth.
export function matchesInclude(path, patterns) {
  for (const pattern of patterns || []) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '::GLOBSTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::GLOBSTAR::/g, '(?:.*/)?');
    const re = new RegExp(`(^|/)${escaped}$`);
    if (re.test(path)) return true;
  }
  return false;
}

export function readWorktreeInclude(root) {
  const p = join(root, '.worktreeinclude');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

export function listGitignoredFiles(root) {
  const out = getExecutor().runQuiet(
    `git -C "${root}" ls-files --others --ignored --exclude-standard`
  );
  return out ? out.split('\n').filter(Boolean) : [];
}

// Only files that are BOTH matched by a pattern AND gitignored are copied, so
// tracked files are never duplicated into the worktree.
export function carryOverFiles({ root, target, patterns }) {
  if (!patterns || patterns.length === 0) return [];
  const copied = [];
  for (const rel of listGitignoredFiles(root)) {
    if (!matchesInclude(rel, patterns)) continue;
    const from = join(root, rel);
    const to = join(target, rel);
    try {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(rel);
    } catch {
      // A single unreadable file must not abort worktree creation.
    }
  }
  return copied;
}

export function hasUncommittedWork(dir) {
  const out = getExecutor().runQuiet(`git -C "${dir}" status --porcelain`);
  return Boolean(out && out.trim().length > 0);
}

// Commits reachable from HEAD but from no remote ref. Removing the worktree
// would destroy these.
export function unpushedCommits(dir) {
  const out = getExecutor().runQuiet(
    `git -C "${dir}" log --oneline --not --remotes`
  );
  return out ? out.split('\n').map(l => l.trim()).filter(Boolean) : [];
}

export function addWorktree({ path, branch, baseRef }) {
  mkdirSync(dirname(path), { recursive: true });
  getExecutor().run(`git worktree add "${path}" -b "${branch}" "${baseRef}"`);
  return path;
}

export function removeWorktree(path, { force = false } = {}) {
  const flag = force ? ' --force' : '';
  getExecutor().run(`git worktree remove${flag} "${path}"`);
}

export function listWorktrees(cwd) {
  const out = getExecutor().runQuiet(`git -C "${cwd}" worktree list --porcelain`);
  if (!out) return [];
  const entries = [];
  let current = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    }
  }
  if (current.path) entries.push(current);
  return entries;
}

export function resolveBaseRef(cwd, baseRef) {
  if (baseRef === 'head') return 'HEAD';
  const head = getExecutor().runQuiet(`git -C "${cwd}" rev-parse --abbrev-ref origin/HEAD`);
  return head ? head.trim() : 'HEAD';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worktree.js test/worktree.test.js
git commit -m "feat(worktree): add git worktree operations and carry-over"
```

---

### Task 9: `rn-iso worktree create`

**Files:**
- Create: `src/commands/worktree.js`
- Modify: `bin/cli.js`, `src/config.js`
- Test: `test/worktree-create.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 8; `detectPackageManager` from `src/runner.js`.
- Produces: `resolveInstallPipeline(settings, projectRoot)` (pure) returning `string[]`; `setSetupStatus(path, status)` / `getSetupStatus(path)` in config.js, where status is `{commands: [{command, ok}], complete: boolean}`.

- [ ] **Step 1: Write the failing tests**

Create `test/worktree-create.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveInstallPipeline } from '../src/commands/worktree.js';
import { upsertProject, setSetupStatus, getSetupStatus } from '../src/config.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('uses the configured pipeline verbatim', () => {
  const pipeline = resolveInstallPipeline(
    { worktree: { install: ['pnpm install', 'pnpm build:packages'] } },
    '/proj'
  );
  assert.deepEqual(pipeline, ['pnpm install', 'pnpm build:packages']);
});

test('accepts a single string as a one-command pipeline', () => {
  assert.deepEqual(resolveInstallPipeline({ worktree: { install: 'yarn' } }, '/proj'), ['yarn']);
});

test('install false disables the pipeline', () => {
  assert.deepEqual(resolveInstallPipeline({ worktree: { install: false } }, '/proj'), []);
});

test('falls back to the detected package manager', () => {
  const pipeline = resolveInstallPipeline({ packageManager: 'pnpm' }, '/proj');
  assert.deepEqual(pipeline, ['pnpm install']);
});

test('setup status round-trips and reports incompleteness', () => {
  upsertProject('/proj', {});
  setSetupStatus('/proj', {
    complete: false,
    commands: [
      { command: 'pnpm install', ok: false },
      { command: 'pnpm build:packages', ok: true },
    ],
  });
  const status = getSetupStatus('/proj');
  assert.equal(status.complete, false);
  assert.equal(status.commands[0].ok, false);
});

test('getSetupStatus returns null for an unknown project', () => {
  assert.equal(getSetupStatus('/nope'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/worktree-create.test.js`
Expected: FAIL — cannot find module `../src/commands/worktree.js`.

- [ ] **Step 3: Add setup-status accessors to `src/config.js`**

```js
export function setSetupStatus(projectPath, status) {
  const cfg = ensureConfig();
  if (!cfg.projects[projectPath]) {
    cfg.projects[projectPath] = { metroPort: null, metroPid: null, platforms: {} };
  }
  cfg.projects[projectPath].setup = status;
  saveConfig(cfg);
}

export function getSetupStatus(projectPath) {
  return getProject(projectPath)?.setup || null;
}
```

- [ ] **Step 4: Implement `src/commands/worktree.js` (create only for now)**

```js
import { existsSync } from 'fs';
import chalk from 'chalk';
import { detectPackageManager } from '../runner.js';
import { resolveSettings } from '../settings.js';
import { setSetupStatus, upsertProject } from '../config.js';
import { getExecutor } from '../exec.js';
import {
  addWorktree,
  carryOverFiles,
  defaultWorktreeDir,
  gitCommonDir,
  readWorktreeInclude,
  repoRoot,
  resolveBaseRef,
  worktreePath,
} from '../worktree.js';

// A pipeline, not a boolean: one `install` is not enough for a monorepo, where
// a failed postinstall silently leaves later setup steps unrun.
export function resolveInstallPipeline(settings, projectRoot) {
  const configured = settings?.worktree?.install;
  if (configured === false) return [];
  if (typeof configured === 'string') return [configured];
  if (Array.isArray(configured)) return configured;
  const pm = settings?.packageManager || detectPackageManager(projectRoot) || 'npm';
  return [`${pm} install`];
}

function runPipeline(commands, cwd) {
  const exec = getExecutor();
  const results = [];
  for (const command of commands) {
    // stderr, so stdout stays reserved for the worktree path (hook contract).
    console.error(chalk.dim(`> ${command}`));
    try {
      exec.run(`cd "${cwd}" && ${command}`);
      results.push({ command, ok: true });
    } catch (e) {
      results.push({ command, ok: false, error: String(e?.message || e).slice(0, 500) });
      console.error(chalk.yellow(`  failed: ${command}`));
      // Keep going: later commands may still be useful, and the recorded
      // status tells the next `rn-iso ios` exactly what to re-run.
    }
  }
  return results;
}

export function registerCreate(worktree) {
  worktree
    .command('create <name>')
    .description('Create a git worktree with its environment set up. Prints the worktree path on stdout.')
    .option('--base <ref>', 'base ref: "fresh" (origin/HEAD, default) or "head"')
    .option('--no-install', 'skip the setup pipeline')
    .option('--label <label>', 'rn-iso shortcut for the worktree (defaults to the worktree name)')
    .action((name, opts) => {
      const root = repoRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not a git repository.'));
        process.exit(1);
      }
      const common = gitCommonDir(process.cwd());
      const settings = resolveSettings({ gitCommonDir: common, repoRoot: root });

      const dir = settings.worktreeDir || defaultWorktreeDir(root);
      const target = worktreePath({ worktreeDir: dir, name });

      // Idempotent: a hook retry must not fail.
      if (existsSync(target)) {
        console.error(chalk.dim(`Worktree already exists at ${target}`));
        console.log(target);
        return;
      }

      const baseRef = resolveBaseRef(root, opts.base || settings?.worktree?.baseRef || 'fresh');
      try {
        addWorktree({ path: target, branch: `worktree-${name}`, baseRef });
      } catch (e) {
        console.error(String(e?.message || e));
        process.exit(1);
      }

      const patterns = readWorktreeInclude(root) || settings?.worktree?.include || [];
      const copied = carryOverFiles({ root, target, patterns });
      if (copied.length) console.error(chalk.dim(`Carried over ${copied.length} file(s).`));

      let results = [];
      if (opts.install !== false) {
        results = runPipeline(resolveInstallPipeline(settings, target), target);
      }
      const complete = results.every(r => r.ok);

      // Register the label now, before `rn-iso ios` ever runs. Without this,
      // the project would later register under its directory basename, and in
      // a monorepo every worktree's app dir shares that basename (every
      // worktree of tlon-apps is "tlon-mobile"), so the shortcuts collide.
      upsertProject(target, { label: opts.label || name });
      setSetupStatus(target, { complete, commands: results });

      if (!complete) {
        const failed = results.filter(r => !r.ok).map(r => r.command);
        console.error(chalk.yellow(`Setup incomplete. Failed: ${failed.join(', ')}`));
        console.error(chalk.dim('The worktree is usable but may not build until these succeed.'));
      }

      // The WorktreeCreate hook reads stdout as the directory to use. Nothing
      // else may be written here, and a setup failure must still exit 0 or the
      // session spawn dies.
      console.log(target);
    });
}

export default function worktreeCommand(program) {
  const worktree = program.command('worktree').description('Create and remove isolated worktrees');
  registerCreate(worktree);
}
```

- [ ] **Step 5: Register in `bin/cli.js`**

```js
import worktreeCommand from '../src/commands/worktree.js';
```

```js
worktreeCommand(program);
```

- [ ] **Step 6: Run tests and a real smoke check**

Run: `npm test`
Expected: PASS.

Run, in a scratch git repo with one commit:

```bash
node /path/to/rn-iso/bin/cli.js worktree create smoke --no-install
```

Expected: prints exactly one line on stdout (the worktree path); the directory exists; running the same command again prints the same path and exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/commands/worktree.js src/config.js bin/cli.js test/worktree-create.test.js
git commit -m "feat(worktree): add create with carry-over and setup pipeline"
```

---

### Task 10: `worktree remove` and `worktree list`

**Files:**
- Modify: `src/commands/worktree.js`
- Test: `test/worktree-remove.test.js`

**Interfaces:**
- Consumes: `reclaimProject` (Task 4); `hasUncommittedWork`, `unpushedCommits`, `removeWorktree`, `listWorktrees` (Task 8).
- Produces: `removalBlockers({dirty, unpushed})` (pure) returning `string[]`.

- [ ] **Step 1: Write the failing tests**

Create `test/worktree-remove.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removalBlockers } from '../src/commands/worktree.js';

test('no blockers for a clean worktree', () => {
  assert.deepEqual(removalBlockers({ dirty: false, unpushed: [] }), []);
});

test('reports uncommitted changes', () => {
  const blockers = removalBlockers({ dirty: true, unpushed: [] });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /uncommitted/i);
});

test('reports unpushed commits with a count', () => {
  const blockers = removalBlockers({ dirty: false, unpushed: ['abc one', 'def two'] });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /2 commit/);
});

test('reports both when both apply', () => {
  assert.equal(removalBlockers({ dirty: true, unpushed: ['abc one'] }).length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/worktree-remove.test.js`
Expected: FAIL — `removalBlockers` is not exported.

- [ ] **Step 3: Add remove and list to `src/commands/worktree.js`**

```js
import { rmSync } from 'fs';
import { formatBytes } from '../artifacts.js';
import { reclaimProject } from '../reclaim.js';
import { getSetupStatus } from '../config.js';
import {
  hasUncommittedWork,
  listWorktrees,
  removeWorktree,
  unpushedCommits,
} from '../worktree.js';

export function removalBlockers({ dirty, unpushed }) {
  const blockers = [];
  if (dirty) blockers.push('uncommitted changes or untracked files');
  if (unpushed && unpushed.length) {
    blockers.push(`${unpushed.length} commit(s) not on any remote`);
  }
  return blockers;
}

export function registerRemove(worktree) {
  worktree
    .command('remove <target>')
    .description('Remove a worktree and reclaim its build artifacts, sim claim, and Metro port.')
    .option('--force', 'remove even when the worktree holds uncommitted or unpushed work')
    .action((target, opts) => {
      const path = resolve(target);
      if (!existsSync(path)) {
        console.error(chalk.red(`No such worktree: ${path}`));
        process.exit(1);
      }

      const blockers = removalBlockers({
        dirty: hasUncommittedWork(path),
        unpushed: unpushedCommits(path),
      });
      if (blockers.length && !opts.force) {
        console.error(chalk.red(`Refusing to remove ${path}:`));
        for (const b of blockers) console.error(chalk.red(`  - ${b}`));
        console.error(chalk.dim('Push the branch, or re-run with --force to discard this work.'));
        process.exit(1);
      }

      // Find artifacts before the directory disappears; reclaimProject matches
      // on WorkspacePath prefixes that only resolve while the path exists.
      const result = reclaimProject(path, { deleteArtifacts: false });

      removeWorktree(path, { force: opts.force });
      console.log(chalk.green(`Removed worktree ${path}`));
      if (result.freed.length) console.log(chalk.dim(`  freed: ${result.freed.join(', ')}`));
      if (result.killedPid) console.log(chalk.dim(`  killed Metro pid ${result.killedPid}`));

      let bytes = 0;
      for (const artifact of result.artifacts) {
        rmSync(artifact.dir, { recursive: true, force: true });
        bytes += artifact.bytes;
      }
      if (bytes > 0) console.log(chalk.dim(`  reclaimed ${formatBytes(bytes)} of build artifacts`));
    });
}

export function registerList(worktree) {
  worktree
    .command('list')
    .description("List this repository's worktrees with their setup status.")
    .action(() => {
      const entries = listWorktrees(process.cwd());
      if (entries.length <= 1) {
        console.log(chalk.dim('No worktrees besides the main checkout.'));
        return;
      }
      for (const entry of entries.slice(1)) {
        const status = getSetupStatus(entry.path);
        const label = status
          ? status.complete
            ? chalk.green('setup ok')
            : chalk.yellow('setup incomplete')
          : chalk.dim('unmanaged');
        console.log(`${entry.path}  [${entry.branch || 'detached'}]  ${label}`);
      }
    });
}
```

Update the default export and add the missing imports (`resolve` from `path`, `existsSync` from `fs`):

```js
export default function worktreeCommand(program) {
  const worktree = program.command('worktree').description('Create and remove isolated worktrees');
  registerCreate(worktree);
  registerRemove(worktree);
  registerList(worktree);
}
```

- [ ] **Step 4: Warn about incomplete setup in `src/commands/ios.js` and `src/commands/android.js`**

Immediately after the project root is resolved in each, before the build runs:

```js
import { getSetupStatus } from '../config.js';

const setup = getSetupStatus(projectRoot);
if (setup && !setup.complete) {
  const failed = setup.commands.filter(c => !c.ok).map(c => c.command);
  console.log(chalk.yellow(`Warning: worktree setup is incomplete. Failed: ${failed.join(', ')}`));
  console.log(chalk.dim('The build may fail until these succeed.'));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Smoke-test the refusal**

In the scratch repo from Task 9, inside the worktree: `touch junk.txt`, then run `worktree remove <path>`.
Expected: exits 1, names "uncommitted changes or untracked files", does not remove. Re-run with `--force`: removes.

- [ ] **Step 7: Commit**

```bash
git add src/commands/worktree.js src/commands/ios.js src/commands/android.js test/worktree-remove.test.js
git commit -m "feat(worktree): add remove with work protection, and list"
```

---

### Task 11: Documentation

**Files:**
- Modify: `skill/SKILL.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Update `skill/SKILL.md`**

Add a `worktree` section covering `create`/`remove`/`list`, stating that agents should prefer `rn-iso worktree create` over raw `git worktree add` so carry-over, setup, and labelling happen. Add a `gc` section. Add to CRITICAL rules:

```markdown
- **NEVER run `rn-iso gc --delete` without asking the user.** It is the only
  destructive command in the tool and can erase tens of gigabytes. Running
  `rn-iso gc` with no flag is always safe and only reports.
- **If `rn-iso status` shows "setup incomplete"**, the worktree's setup
  pipeline failed. Read the recorded failing command and re-run it rather than
  guessing why the build breaks.
```

Add to "When things go wrong":

```markdown
- **"Refusing to remove <path>"** - the worktree has uncommitted changes or
  commits not on any remote. Do not pass `--force` without asking the user;
  push the branch instead.
- **Sim shows `[in use]`** - another tool (usually a UI-test runner) is
  driving it. `--auto` skips these. Do not take one over without asking.
```

- [ ] **Step 2: Update `README.md`**

Add `worktree create|remove|list` and `gc` to the command table. Add a section documenting the `WorktreeCreate` hook wiring:

```json
{
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [{ "type": "command", "command": "rn-iso worktree create \"$(jq -r .name)\"" }] }
    ]
  }
}
```

Document the settings layers, `.rn-iso.json`, and that secrets belong in carried-over `.env` files rather than the committed layer.

- [ ] **Step 3: Update `CLAUDE.md`**

Add the new modules to the file-layout block. Add a "Particularities" entry for the stdout/stderr contract in `worktree create` and one for the unmounted-volume guard in `gc`. Fix the stale claim that GPG signing is enabled globally.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skill/SKILL.md README.md CLAUDE.md
git commit -m "docs: document worktree and gc commands"
```

---

## Self-review notes

Spec coverage checked section by section: settings layering (Tasks 1-2), worktree location (Task 8 `defaultWorktreeDir`), command surface (Tasks 5, 9, 10), carry-over (Task 8), setup pipeline and status (Task 9), labels (Task 9 `--label`), `worktree remove` protections (Task 10), `worktree list` (Task 10), `gc` (Task 5), device occupancy (Tasks 6-7), reclamation mechanism and the unmounted-volume guard (Task 3), error handling grades (Task 9), testing (every task), documentation (Task 11).

Two spec items are deliberately not implemented, matching the spec's own framing: the EAS cache prerequisite is documentation only, and `--older-than` is wired but its packaging into a scheduled sweep is out of scope.

Verified against the current source before writing: `detectPackageManager` (`src/runner.js:33`) and `findPidListeningOnPort` (`src/metro.js:71`) exist with the signatures used here, and `git rev-parse --path-format=absolute --git-common-dir` is supported by the installed git.

Type-consistency check: `reclaimProject` returns `{path, freed, artifacts, killedPid, metroPort}` in Task 4 and is destructured on exactly those names in Tasks 5 and 10. `classifyDerivedData` returns `{orphaned, live, skipped}` in Task 3 and is consumed on those names in Task 5. `setSetupStatus`/`getSetupStatus` take and return `{complete, commands}` in Tasks 9 and 10.
