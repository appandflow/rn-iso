# rn-iso Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI (`rn-iso`) that lets multiple React Native / Expo projects (or worktrees) run concurrently, each with its own Metro server and dedicated simulator/emulator, so AI agents can target the right device without manual port/sim juggling.

**Architecture:** Node.js ESM CLI built on `commander`. Global config at `~/.rn-iso/config.json` keyed by absolute project path. Per-platform device assignment is sticky and stored in config. Process invocation goes through a single `exec` wrapper so logic is testable. Pure parsing/algorithm code is unit-tested with `node --test`; integration with real sims is verified manually.

**Tech Stack:** Node 20+, ESM modules, `commander` (CLI), `chalk` (colors), `prompts` (interactive picker). Test runner: `node --test`. No transpiler.

**Reference spec:** `docs/specs/2026-04-25-rn-iso-design.md` — defer there for any design intent ambiguity.

---

## File Structure

```
bin/cli.js                          # entry, dispatches to commands
src/
  exec.js                           # single point for child_process; mockable
  config.js                         # global config CRUD, schema migration
  project.js                        # project root walk, bundle ID detection, Expo detection
  ports.js                          # port allocation + Metro probing
  sim/
    ios.js                          # simctl wrappers, iOS device pool/allocation
    android.js                      # adb/emulator wrappers, Android device pool
  metro.js                          # detached Metro spawn, PID lifecycle, log files
  runner.js                         # bare vs Expo dispatch (run-ios/run-android)
  commands/
    ios.js                          # `rn-iso ios`
    android.js                      # `rn-iso android`
    start.js                        # `rn-iso start`
    device.js                       # `rn-iso device`
    status.js                       # `rn-iso status`
    release.js                      # `rn-iso release`
    shutdown.js                     # `rn-iso shutdown`
    prune.js                        # `rn-iso prune`
    logs.js                         # `rn-iso logs`
    stop.js                         # `rn-iso stop`
test/
  config.test.js
  project.test.js
  ports.test.js
  sim-ios.test.js
  sim-android.test.js
  runner.test.js
skill/
  SKILL.md
package.json
.gitignore
README.md
```

Each `src/commands/*.js` is a thin commander wrapper that calls service functions in the relevant module. The bulk of testable logic lives in `src/sim/`, `src/ports.js`, `src/config.js`, `src/project.js`.

---

## Task 1: Project bootstrap

**Files:**

- Create: `package.json`
- Create: `.gitignore`
- Create: `bin/cli.js`
- Create: `src/index.js` (placeholder, just exports version)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "rn-iso",
  "version": "0.1.0",
  "description": "Isolated React Native dev environments per project/worktree",
  "type": "module",
  "bin": {
    "rn-iso": "bin/cli.js"
  },
  "scripts": {
    "test": "node --test test/*.test.js"
  },
  "dependencies": {
    "chalk": "^5.4.1",
    "commander": "^13.1.0",
    "prompts": "^2.4.2"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 3: Install dependencies**

Run: `cd /Users/janicduplessis/Developer/rn-iso && npm install`
Expected: creates `node_modules/` and `package-lock.json` without errors.

- [ ] **Step 4: Create bin/cli.js with version-only stub**

```javascript
#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program.name('rn-iso').description('Isolated React Native dev environments per project/worktree').version('0.1.0');

program.parse();
```

- [ ] **Step 5: Make executable and smoke-test**

Run: `chmod +x bin/cli.js && node bin/cli.js --version`
Expected output: `0.1.0`

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore bin/cli.js
git commit -m "chore: project bootstrap with commander stub"
```

---

## Task 2: Exec wrapper

The single point all `child_process` calls go through. Tests inject a mock to avoid real shell-outs.

**Files:**

- Create: `src/exec.js`
- Create: `test/exec.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/exec.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, getExecutor, resetExecutor } from '../src/exec.js';

test('default executor runs commands and returns stdout trimmed', () => {
  resetExecutor();
  const out = getExecutor().run('echo hello');
  assert.equal(out, 'hello');
});

test('runQuiet returns null on failure', () => {
  resetExecutor();
  const out = getExecutor().runQuiet('false');
  assert.equal(out, null);
});

test('setExecutor replaces the active executor', () => {
  setExecutor({
    run: () => 'mocked',
    runQuiet: () => 'mocked-quiet',
    spawn: () => ({ pid: 999 }),
  });
  assert.equal(getExecutor().run('anything'), 'mocked');
  assert.equal(getExecutor().runQuiet('anything'), 'mocked-quiet');
  resetExecutor();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/exec.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/exec.js**

```javascript
// src/exec.js
import { execSync, spawn } from 'child_process';

const defaultExecutor = {
  run(cmd) {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  },
  runQuiet(cmd) {
    try {
      return this.run(cmd);
    } catch {
      return null;
    }
  },
  spawn(cmd, args, opts) {
    return spawn(cmd, args, opts);
  },
};

let active = defaultExecutor;

export function setExecutor(e) {
  active = e;
}

export function resetExecutor() {
  active = defaultExecutor;
}

export function getExecutor() {
  return active;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/exec.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exec.js test/exec.test.js
git commit -m "feat: mockable exec wrapper for child_process calls"
```

---

## Task 3: Project root + bundle ID detection

**Files:**

- Create: `src/project.js`
- Create: `test/project.test.js`
- Create: `test/fixtures/sample-expo-project/package.json` (test fixture)
- Create: `test/fixtures/sample-expo-project/app.json` (test fixture)

- [ ] **Step 1: Create test fixtures**

`test/fixtures/sample-expo-project/package.json`:

```json
{
  "name": "sample-app",
  "dependencies": { "expo": "~50.0.0" }
}
```

`test/fixtures/sample-expo-project/app.json`:

```json
{
  "expo": {
    "ios": { "bundleIdentifier": "com.example.sample" },
    "android": { "package": "com.example.sample" }
  }
}
```

Also create `test/fixtures/sample-bare-project/package.json`:

```json
{
  "name": "bare-app",
  "dependencies": { "react-native": "0.74.0" }
}
```

And create `test/fixtures/sample-expo-project/src/.keep` (empty file) to allow walking up from a nested dir during testing:

```

```

- [ ] **Step 2: Write failing tests**

```javascript
// test/project.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'path';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../src/project.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const EXPO_PROJ = join(FIXTURES, 'sample-expo-project');
const BARE_PROJ = join(FIXTURES, 'sample-bare-project');

test('findProjectRoot walks up from cwd to find package.json', () => {
  const nested = join(EXPO_PROJ, 'src');
  assert.equal(findProjectRoot(nested), EXPO_PROJ);
});

test('findProjectRoot returns null when no package.json found', () => {
  assert.equal(findProjectRoot('/'), null);
});

test('detectIsExpo true when expo is in dependencies', () => {
  assert.equal(detectIsExpo(EXPO_PROJ), true);
});

test('detectIsExpo false when expo is not in dependencies', () => {
  assert.equal(detectIsExpo(BARE_PROJ), false);
});

test('detectBundleId reads ios.bundleIdentifier from app.json', () => {
  assert.equal(detectBundleId(EXPO_PROJ), 'com.example.sample');
});

test('detectBundleId returns null when app.json absent', () => {
  assert.equal(detectBundleId(BARE_PROJ), null);
});

test('detectAndroidPackage reads android.package from app.json', () => {
  assert.equal(detectAndroidPackage(EXPO_PROJ), 'com.example.sample');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- test/project.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement src/project.js**

```javascript
// src/project.js
import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';

export function findProjectRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readPackageJson(projectRoot) {
  const p = join(projectRoot, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function detectIsExpo(projectRoot) {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return false;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return 'expo' in deps;
}

function readAppJson(projectRoot) {
  const p = join(projectRoot, 'app.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function readAppConfigText(projectRoot) {
  for (const name of ['app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs']) {
    const p = join(projectRoot, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function detectBundleId(projectRoot) {
  const appJson = readAppJson(projectRoot);
  const fromJson = appJson?.expo?.ios?.bundleIdentifier;
  if (fromJson) return fromJson;

  const text = readAppConfigText(projectRoot);
  if (text) {
    const m = text.match(/bundleIdentifier\s*:\s*["']([^"']+)["']/);
    if (m) return m[1];
  }
  return null;
}

export function detectAndroidPackage(projectRoot) {
  const appJson = readAppJson(projectRoot);
  const fromJson = appJson?.expo?.android?.package;
  if (fromJson) return fromJson;

  const text = readAppConfigText(projectRoot);
  if (text) {
    const m = text.match(/package\s*:\s*["']([^"']+)["']/);
    if (m) return m[1];
  }
  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/project.test.js`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/project.js test/project.test.js test/fixtures/
git commit -m "feat: project root + bundle ID + Expo detection"
```

---

## Task 4: Config module

**Files:**

- Create: `src/config.js`
- Create: `test/config.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// test/config.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getConfigDir,
  loadConfig,
  saveConfig,
  ensureConfig,
  getProject,
  upsertProject,
  removeProject,
  setMetro,
  setDevice,
  clearDevice,
  allMetroPorts,
  allClaimedDevices,
} from '../src/config.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('getConfigDir respects RN_ISO_HOME', () => {
  assert.equal(getConfigDir(), tmpHome);
});

test('loadConfig returns null when no file exists', () => {
  assert.equal(loadConfig(), null);
});

test('ensureConfig creates and returns empty config', () => {
  const cfg = ensureConfig();
  assert.deepEqual(cfg, { version: 1, projects: {} });
  assert.ok(existsSync(join(tmpHome, 'config.json')));
});

test('saveConfig + loadConfig roundtrip', () => {
  saveConfig({ version: 1, projects: { '/foo': { metroPort: 8082, platforms: {} } } });
  const cfg = loadConfig();
  assert.equal(cfg.projects['/foo'].metroPort, 8082);
});

test('upsertProject creates a new project entry with defaults', () => {
  const proj = upsertProject('/abs/path', {
    bundleId: 'com.foo',
    androidPackage: 'com.foo',
    isExpo: true,
  });
  assert.equal(proj.bundleId, 'com.foo');
  assert.equal(proj.metroPort, null);
  assert.deepEqual(proj.platforms, {});
});

test('upsertProject preserves existing fields when called again', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setMetro('/p', 8082, 12345);
  upsertProject('/p', { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  const proj = getProject('/p');
  assert.equal(proj.bundleId, 'com.b');
  assert.equal(proj.metroPort, 8082);
  assert.equal(proj.metroPid, 12345);
});

test('setDevice and clearDevice mutate platforms', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice('/p', 'ios', { deviceUdid: 'ABC' });
  assert.equal(getProject('/p').platforms.ios.deviceUdid, 'ABC');
  clearDevice('/p', 'ios');
  assert.equal(getProject('/p').platforms.ios, undefined);
});

test('allMetroPorts collects ports from all projects', () => {
  upsertProject('/a', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  upsertProject('/b', { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  setMetro('/a', 8082, null);
  setMetro('/b', 8083, null);
  assert.deepEqual(allMetroPorts().sort(), [8082, 8083]);
});

test('allClaimedDevices returns udids and avd names across projects', () => {
  upsertProject('/a', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  upsertProject('/b', { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  setDevice('/a', 'ios', { deviceUdid: 'UDID-1' });
  setDevice('/b', 'android', { avdName: 'Pixel_6', consolePort: 5554 });
  const claimed = allClaimedDevices();
  assert.deepEqual(claimed.iosUdids, ['UDID-1']);
  assert.deepEqual(claimed.androidAvds, ['Pixel_6']);
  assert.deepEqual(claimed.androidConsolePorts, [5554]);
});

test('removeProject deletes entry', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  removeProject('/p');
  assert.equal(getProject('/p'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/config.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/config.js**

```javascript
// src/config.js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function getConfigDir() {
  return process.env.RN_ISO_HOME || join(homedir(), '.rn-iso');
}

function getConfigPath() {
  return join(getConfigDir(), 'config.json');
}

function ensureDir() {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadConfig() {
  const p = getConfigPath();
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function saveConfig(config) {
  ensureDir();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n');
}

export function ensureConfig() {
  const existing = loadConfig();
  if (existing) return existing;
  const fresh = { version: 1, projects: {} };
  saveConfig(fresh);
  return fresh;
}

export function getProject(projectPath) {
  const cfg = loadConfig();
  return cfg?.projects?.[projectPath] || null;
}

export function upsertProject(projectPath, fields) {
  const cfg = ensureConfig();
  const existing = cfg.projects[projectPath] || {
    metroPort: null,
    metroPid: null,
    platforms: {},
  };
  cfg.projects[projectPath] = {
    ...existing,
    ...fields,
  };
  saveConfig(cfg);
  return cfg.projects[projectPath];
}

export function removeProject(projectPath) {
  const cfg = loadConfig();
  if (!cfg?.projects?.[projectPath]) return;
  delete cfg.projects[projectPath];
  saveConfig(cfg);
}

export function setMetro(projectPath, metroPort, metroPid) {
  const cfg = ensureConfig();
  if (!cfg.projects[projectPath]) {
    throw new Error(`Project not registered: ${projectPath}`);
  }
  cfg.projects[projectPath].metroPort = metroPort;
  cfg.projects[projectPath].metroPid = metroPid;
  saveConfig(cfg);
}

export function setDevice(projectPath, platform, deviceFields) {
  const cfg = ensureConfig();
  if (!cfg.projects[projectPath]) {
    throw new Error(`Project not registered: ${projectPath}`);
  }
  cfg.projects[projectPath].platforms = cfg.projects[projectPath].platforms || {};
  cfg.projects[projectPath].platforms[platform] = deviceFields;
  saveConfig(cfg);
}

export function clearDevice(projectPath, platform) {
  const cfg = loadConfig();
  if (!cfg?.projects?.[projectPath]?.platforms) return;
  delete cfg.projects[projectPath].platforms[platform];
  saveConfig(cfg);
}

export function allMetroPorts() {
  const cfg = loadConfig();
  if (!cfg?.projects) return [];
  return Object.values(cfg.projects)
    .map((p) => p.metroPort)
    .filter((p) => typeof p === 'number');
}

export function allClaimedDevices() {
  const cfg = loadConfig();
  const result = { iosUdids: [], androidAvds: [], androidConsolePorts: [] };
  if (!cfg?.projects) return result;
  for (const proj of Object.values(cfg.projects)) {
    const ios = proj.platforms?.ios;
    if (ios?.deviceUdid) result.iosUdids.push(ios.deviceUdid);
    const android = proj.platforms?.android;
    if (android?.avdName) result.androidAvds.push(android.avdName);
    if (typeof android?.consolePort === 'number') result.androidConsolePorts.push(android.consolePort);
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/config.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: global config module with per-project state"
```

---

## Task 5: Port allocation

**Files:**

- Create: `src/ports.js`
- Create: `test/ports.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// test/ports.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetExecutor } from '../src/exec.js';
import { upsertProject, setMetro } from '../src/config.js';
import { computeNextPort, findReclaimablePort, allocatePort } from '../src/ports.js';

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

test('computeNextPort returns 8082 with no existing ports', () => {
  assert.equal(computeNextPort(), 8082);
});

test('computeNextPort returns max + 1', () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  setMetro('/a', 8082, null);
  setMetro('/b', 8090, null);
  assert.equal(computeNextPort(), 8091);
});

test('findReclaimablePort returns null when no projects', async () => {
  const r = await findReclaimablePort('/excluded');
  assert.equal(r, null);
});

test('findReclaimablePort skips the excluded project path', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setMetro('/a', 8082, null);
  // Mock isMetroRunning to always return false (port is dead)
  const r = await findReclaimablePort('/a', async () => false);
  assert.equal(r, null);
});

test('findReclaimablePort returns first dead port and its owner', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  setMetro('/a', 8082, null);
  setMetro('/b', 8083, null);
  // 8082 alive, 8083 dead
  const probe = async (port) => port === 8082;
  const r = await findReclaimablePort('/c', probe);
  assert.deepEqual(r, { port: 8083, ownerPath: '/b' });
});

test('allocatePort reclaims dead ports and removes the dead project', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setMetro('/a', 8082, null);
  const probe = async () => false;
  const port = await allocatePort('/new', probe);
  assert.equal(port, 8082);
  // Caller should have removed /a — verify via behavior
  const { getProject } = await import('../src/config.js');
  assert.equal(getProject('/a'), null);
});

test('allocatePort assigns a fresh port when nothing is reclaimable', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setMetro('/a', 8082, null);
  const probe = async () => true; // everything alive
  const port = await allocatePort('/new', probe);
  assert.equal(port, 8083);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/ports.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/ports.js**

```javascript
// src/ports.js
import { request } from 'http';
import { loadConfig, allMetroPorts, removeProject } from './config.js';

export function isMetroRunning(port) {
  return new Promise((resolve) => {
    const req = request({ hostname: 'localhost', port, path: '/status', timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(data.includes('packager-status:running')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export function computeNextPort() {
  const ports = allMetroPorts();
  if (ports.length === 0) return 8082;
  return Math.max(...ports, 8081) + 1;
}

export async function findReclaimablePort(excludeProjectPath, probe = isMetroRunning) {
  const cfg = loadConfig();
  if (!cfg?.projects) return null;
  const candidates = [];
  for (const [path, proj] of Object.entries(cfg.projects)) {
    if (path === excludeProjectPath) continue;
    if (typeof proj.metroPort === 'number') {
      candidates.push({ port: proj.metroPort, ownerPath: path });
    }
  }
  for (const c of candidates) {
    const alive = await probe(c.port);
    if (!alive) return c;
  }
  return null;
}

export async function allocatePort(projectPath, probe = isMetroRunning) {
  const reclaim = await findReclaimablePort(projectPath, probe);
  if (reclaim) {
    removeProject(reclaim.ownerPath);
    return reclaim.port;
  }
  return computeNextPort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/ports.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ports.js test/ports.test.js
git commit -m "feat: port allocation with reclamation of dead Metro ports"
```

---

## Task 6: iOS sim listing + selection logic

The selection algorithm is pure given simctl output and the claimed-set. Implement and test it without invoking real simctl.

**Files:**

- Create: `src/sim/ios.js`
- Create: `test/sim-ios.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// test/sim-ios.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { parseSimctlList, selectIosDevice, listAllIosSims, listBootedIosSims } from '../src/sim/ios.js';

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

const SIMCTL_OUTPUT = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-17-2': [
      { udid: 'UDID-A', name: 'iPhone 15', state: 'Booted', isAvailable: true },
      { udid: 'UDID-B', name: 'iPhone 15 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'UDID-C', name: 'iPhone 14', state: 'Booted', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-16-0': [
      { udid: 'UDID-OLD', name: 'iPhone 13', state: 'Shutdown', isAvailable: false },
    ],
  },
});

test('parseSimctlList flattens devices and filters unavailable', () => {
  const sims = parseSimctlList(SIMCTL_OUTPUT);
  assert.equal(sims.length, 3);
  assert.deepEqual(sims.map((s) => s.udid).sort(), ['UDID-A', 'UDID-B', 'UDID-C']);
});

test('parseSimctlList includes runtime in each entry', () => {
  const sims = parseSimctlList(SIMCTL_OUTPUT);
  const a = sims.find((s) => s.udid === 'UDID-A');
  assert.equal(a.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-17-2');
});

test('listAllIosSims uses simctl via executor', () => {
  setExecutor({
    run: (cmd) => {
      assert.match(cmd, /xcrun simctl list devices --json/);
      return SIMCTL_OUTPUT;
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const sims = listAllIosSims();
  assert.equal(sims.length, 3);
});

test('listBootedIosSims filters by state', () => {
  setExecutor({
    run: () => SIMCTL_OUTPUT,
    runQuiet: () => null,
    spawn: () => null,
  });
  const booted = listBootedIosSims();
  assert.deepEqual(booted.map((s) => s.udid).sort(), ['UDID-A', 'UDID-C']);
});

test('selectIosDevice prefers existing assignment when sim still exists', () => {
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: 'UDID-B',
    claimedUdids: [],
  });
  assert.deepEqual(result, { kind: 'reuse', udid: 'UDID-B', state: 'Shutdown' });
});

test('selectIosDevice ignores existing assignment when sim no longer exists', () => {
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: 'GHOST-UDID',
    claimedUdids: [],
  });
  assert.equal(result.kind, 'allocate');
});

test('selectIosDevice allocates first booted-and-unclaimed sim', () => {
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: null,
    claimedUdids: ['UDID-A'],
  });
  assert.deepEqual(result, { kind: 'allocate', udid: 'UDID-C', state: 'Booted' });
});

test('selectIosDevice returns needsBoot when nothing booted+unclaimed', () => {
  setExecutor({ run: () => SIMCTL_OUTPUT, runQuiet: () => null, spawn: () => null });
  const result = selectIosDevice({
    existingUdid: null,
    claimedUdids: ['UDID-A', 'UDID-C'],
  });
  assert.equal(result.kind, 'needsBoot');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/sim-ios.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/sim/ios.js**

```javascript
// src/sim/ios.js
import { getExecutor } from '../exec.js';

export function parseSimctlList(jsonOutput) {
  const data = JSON.parse(jsonOutput);
  const sims = [];
  for (const [runtime, devices] of Object.entries(data.devices || {})) {
    for (const dev of devices) {
      if (!dev.isAvailable) continue;
      sims.push({
        udid: dev.udid,
        name: dev.name,
        state: dev.state,
        runtime,
      });
    }
  }
  return sims;
}

export function listAllIosSims() {
  const out = getExecutor().run('xcrun simctl list devices --json');
  return parseSimctlList(out);
}

export function listBootedIosSims() {
  return listAllIosSims().filter((s) => s.state === 'Booted');
}

export function selectIosDevice({ existingUdid, claimedUdids }) {
  const sims = listAllIosSims();
  const claimed = new Set(claimedUdids);

  if (existingUdid) {
    const found = sims.find((s) => s.udid === existingUdid);
    if (found) {
      return { kind: 'reuse', udid: found.udid, state: found.state };
    }
  }

  const candidate = sims.find((s) => s.state === 'Booted' && !claimed.has(s.udid));
  if (candidate) {
    return { kind: 'allocate', udid: candidate.udid, state: candidate.state };
  }

  return { kind: 'needsBoot' };
}

export function bootIosSim(udid) {
  const exec = getExecutor();
  // simctl errors if already booted; use runQuiet to swallow.
  exec.runQuiet(`xcrun simctl boot ${udid}`);
  exec.runQuiet('open -a Simulator');
}

export function shutdownIosSim(udid) {
  getExecutor().runQuiet(`xcrun simctl shutdown ${udid}`);
}

export function listIosDeviceTypes() {
  const exec = getExecutor();
  const out = exec.run('xcrun simctl list devicetypes --json');
  const data = JSON.parse(out);
  return (data.devicetypes || []).map((dt) => ({
    identifier: dt.identifier,
    name: dt.name,
  }));
}

export function createIosSim(deviceTypeId, runtimeId) {
  const out = getExecutor().run(`xcrun simctl create "rn-iso" "${deviceTypeId}" "${runtimeId}"`);
  return out.trim();
}

export function listIosRuntimes() {
  const out = getExecutor().run('xcrun simctl list runtimes --json');
  const data = JSON.parse(out);
  return (data.runtimes || [])
    .filter((r) => r.isAvailable && r.platform === 'iOS')
    .map((r) => ({ identifier: r.identifier, name: r.name, version: r.version }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/sim-ios.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sim/ios.js test/sim-ios.test.js
git commit -m "feat: iOS simctl wrappers and device selection algorithm"
```

---

## Task 7: Android emulator listing + selection logic

**Files:**

- Create: `src/sim/android.js`
- Create: `test/sim-android.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// test/sim-android.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { parseAvdList, parseAdbDevices, selectAndroidDevice, nextConsolePort } from '../src/sim/android.js';

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

test('parseAvdList strips header and blanks', () => {
  const out = `INFO    | Storing AVDs in...\nPixel_6_API_34\nPixel_7_API_33\n`;
  const avds = parseAvdList(out);
  assert.deepEqual(avds, ['Pixel_6_API_34', 'Pixel_7_API_33']);
});

test('parseAdbDevices extracts running emulator console ports', () => {
  const out = `List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n0123456789ABCDEF\tdevice\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(
    result.emulators.sort((a, b) => a.consolePort - b.consolePort),
    [
      { serial: 'emulator-5554', consolePort: 5554 },
      { serial: 'emulator-5556', consolePort: 5556 },
    ],
  );
});

test('parseAdbDevices ignores offline emulators', () => {
  const out = `List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n`;
  const result = parseAdbDevices(out);
  assert.deepEqual(result.emulators, [{ serial: 'emulator-5556', consolePort: 5556 }]);
});

test('nextConsolePort returns 5554 when none claimed', () => {
  assert.equal(nextConsolePort([]), 5554);
});

test('nextConsolePort returns next even port above max claimed', () => {
  assert.equal(nextConsolePort([5554, 5556]), 5558);
});

test('selectAndroidDevice prefers existing assignment when AVD still exists', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return 'Pixel_6_API_34\n';
      if (cmd.includes('adb devices')) return 'List of devices attached\n';
      throw new Error('unexpected: ' + cmd);
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const result = selectAndroidDevice({
    existingAvd: 'Pixel_6_API_34',
    existingConsolePort: 5554,
    claimedAvds: [],
    claimedConsolePorts: [],
  });
  assert.deepEqual(result, {
    kind: 'reuse',
    avdName: 'Pixel_6_API_34',
    consolePort: 5554,
    isRunning: false,
  });
});

test('selectAndroidDevice marks running when serial present in adb devices', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return 'Pixel_6_API_34\n';
      if (cmd.includes('adb devices')) return 'List of devices attached\nemulator-5554\tdevice\n';
      throw new Error('unexpected');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const result = selectAndroidDevice({
    existingAvd: 'Pixel_6_API_34',
    existingConsolePort: 5554,
    claimedAvds: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.isRunning, true);
});

test('selectAndroidDevice allocates first unclaimed AVD with next console port', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return 'Pixel_6_API_34\nPixel_7_API_33\n';
      if (cmd.includes('adb devices')) return 'List of devices attached\n';
      throw new Error('unexpected');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingConsolePort: null,
    claimedAvds: ['Pixel_6_API_34'],
    claimedConsolePorts: [5554],
  });
  assert.deepEqual(result, {
    kind: 'allocate',
    avdName: 'Pixel_7_API_33',
    consolePort: 5556,
    isRunning: false,
  });
});

test('selectAndroidDevice returns noAvd when no AVDs exist', () => {
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('list-avds')) return '';
      if (cmd.includes('adb devices')) return 'List of devices attached\n';
      throw new Error('unexpected');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  const result = selectAndroidDevice({
    existingAvd: null,
    existingConsolePort: null,
    claimedAvds: [],
    claimedConsolePorts: [],
  });
  assert.equal(result.kind, 'noAvd');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/sim-android.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/sim/android.js**

```javascript
// src/sim/android.js
import { getExecutor } from '../exec.js';

export function parseAvdList(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('INFO') && !l.startsWith('WARNING'));
}

export function parseAdbDevices(text) {
  const lines = text.split('\n').slice(1); // skip "List of devices attached"
  const emulators = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, status] = trimmed.split(/\s+/);
    if (status !== 'device') continue;
    const m = serial.match(/^emulator-(\d+)$/);
    if (m) emulators.push({ serial, consolePort: parseInt(m[1], 10) });
  }
  return { emulators };
}

export function listAvds() {
  return parseAvdList(getExecutor().run('emulator -list-avds'));
}

export function listAdbDevices() {
  return parseAdbDevices(getExecutor().run('adb devices'));
}

export function nextConsolePort(claimedPorts) {
  if (claimedPorts.length === 0) return 5554;
  const max = Math.max(...claimedPorts);
  return max + 2; // emulator console ports are even
}

export function selectAndroidDevice({ existingAvd, existingConsolePort, claimedAvds, claimedConsolePorts }) {
  const avds = listAvds();
  const adbDevices = listAdbDevices();
  const runningPorts = new Set(adbDevices.emulators.map((e) => e.consolePort));

  if (existingAvd && avds.includes(existingAvd)) {
    const port = existingConsolePort ?? nextConsolePort(claimedConsolePorts);
    return {
      kind: 'reuse',
      avdName: existingAvd,
      consolePort: port,
      isRunning: runningPorts.has(port),
    };
  }

  if (avds.length === 0) {
    return { kind: 'noAvd' };
  }

  const claimedAvdSet = new Set(claimedAvds);
  const candidate = avds.find((a) => !claimedAvdSet.has(a));
  if (!candidate) {
    return { kind: 'noAvd' };
  }
  const consolePort = nextConsolePort(claimedConsolePorts);
  return {
    kind: 'allocate',
    avdName: candidate,
    consolePort,
    isRunning: runningPorts.has(consolePort),
  };
}

export function bootAndroidEmulator(avdName, consolePort) {
  const exec = getExecutor();
  exec
    .spawn('emulator', ['-avd', avdName, '-port', String(consolePort)], {
      detached: true,
      stdio: 'ignore',
    })
    .unref();
}

export async function waitForBoot(serial, timeoutMs = 60000) {
  const exec = getExecutor();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const out = exec.runQuiet(`adb -s ${serial} shell getprop sys.boot_completed`);
    if (out && out.trim() === '1') return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function shutdownAndroidEmulator(serial) {
  getExecutor().runQuiet(`adb -s ${serial} emu kill`);
}

export function adbReverse(serial, port) {
  getExecutor().run(`adb -s ${serial} reverse tcp:${port} tcp:${port}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/sim-android.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sim/android.js test/sim-android.test.js
git commit -m "feat: Android emulator listing and device selection"
```

---

## Task 8: Runner module (Expo vs bare dispatch)

**Files:**

- Create: `src/runner.js`
- Create: `test/runner.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// test/runner.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { buildIosCommand, buildAndroidCommand, buildMetroCommand, resolveSimNameByUdid } from '../src/runner.js';

afterEach(() => resetExecutor());

test('buildIosCommand uses expo run:ios when isExpo', () => {
  const cmd = buildIosCommand({ isExpo: true, udid: 'UDID-1', port: 8083, simName: 'iPhone 15' });
  assert.equal(cmd, 'npx expo run:ios --device UDID-1 --port 8083');
});

test('buildIosCommand uses react-native run-ios when bare and resolves sim name', () => {
  const cmd = buildIosCommand({ isExpo: false, udid: 'UDID-1', port: 8083, simName: 'iPhone 15' });
  assert.equal(cmd, 'npx react-native run-ios --simulator "iPhone 15" --port 8083');
});

test('buildAndroidCommand for expo uses --device serial', () => {
  const cmd = buildAndroidCommand({ isExpo: true, serial: 'emulator-5554', port: 8083 });
  assert.equal(cmd, 'npx expo run:android --device emulator-5554 --port 8083');
});

test('buildAndroidCommand for bare uses --deviceId and RCT_METRO_PORT env prefix', () => {
  const cmd = buildAndroidCommand({ isExpo: false, serial: 'emulator-5554', port: 8083 });
  assert.equal(cmd, 'RCT_METRO_PORT=8083 npx react-native run-android --deviceId emulator-5554');
});

test('buildMetroCommand picks expo or react-native', () => {
  assert.equal(buildMetroCommand({ isExpo: true, port: 8083 }), 'npx expo start --port 8083');
  assert.equal(buildMetroCommand({ isExpo: false, port: 8083 }), 'npx react-native start --port 8083');
});

test('resolveSimNameByUdid returns name from simctl JSON', () => {
  setExecutor({
    run: () =>
      JSON.stringify({
        devices: {
          'iOS-17': [{ udid: 'UDID-1', name: 'iPhone 15', state: 'Booted', isAvailable: true }],
        },
      }),
    runQuiet: () => null,
    spawn: () => null,
  });
  assert.equal(resolveSimNameByUdid('UDID-1'), 'iPhone 15');
});

test('resolveSimNameByUdid throws when ambiguous', () => {
  setExecutor({
    run: () =>
      JSON.stringify({
        devices: {
          'iOS-17': [
            { udid: 'UDID-1', name: 'iPhone 15', state: 'Booted', isAvailable: true },
            { udid: 'UDID-2', name: 'iPhone 15', state: 'Shutdown', isAvailable: true },
          ],
        },
      }),
    runQuiet: () => null,
    spawn: () => null,
  });
  assert.throws(() => resolveSimNameByUdid('UDID-1'), /ambiguous/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/runner.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/runner.js**

```javascript
// src/runner.js
import { listAllIosSims } from './sim/ios.js';

export function buildIosCommand({ isExpo, udid, port, simName }) {
  if (isExpo) {
    return `npx expo run:ios --device ${udid} --port ${port}`;
  }
  return `npx react-native run-ios --simulator "${simName}" --port ${port}`;
}

export function buildAndroidCommand({ isExpo, serial, port }) {
  if (isExpo) {
    return `npx expo run:android --device ${serial} --port ${port}`;
  }
  return `RCT_METRO_PORT=${port} npx react-native run-android --deviceId ${serial}`;
}

export function buildMetroCommand({ isExpo, port }) {
  return isExpo ? `npx expo start --port ${port}` : `npx react-native start --port ${port}`;
}

export function resolveSimNameByUdid(udid) {
  const sims = listAllIosSims();
  const target = sims.find((s) => s.udid === udid);
  if (!target) throw new Error(`Simulator UDID not found: ${udid}`);
  const sameName = sims.filter((s) => s.name === target.name);
  if (sameName.length > 1) {
    throw new Error(
      `Multiple simulators named "${target.name}" — bare RN takes a name, not UDID. ` +
        `Rename one in the Simulator app.`,
    );
  }
  return target.name;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/runner.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runner.js test/runner.test.js
git commit -m "feat: Expo vs bare dispatch for run/start commands"
```

---

## Task 9: Metro process management

**Files:**

- Create: `src/metro.js`
- Create: `test/metro.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// test/metro.test.js
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { logFileFor, projectHash, buildMetroSpawnArgs } from '../src/metro.js';

afterEach(() => resetExecutor());

test('projectHash is deterministic and short', () => {
  const a = projectHash('/foo/bar');
  const b = projectHash('/foo/bar');
  const c = projectHash('/foo/baz');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 12);
});

test('logFileFor uses RN_ISO_HOME and project hash', () => {
  process.env.RN_ISO_HOME = '/tmp/test-rn-iso';
  const path = logFileFor('/some/project');
  assert.match(path, /^\/tmp\/test-rn-iso\/logs\/[0-9a-f]{12}\.log$/);
  delete process.env.RN_ISO_HOME;
});

test('buildMetroSpawnArgs returns correct argv for expo', () => {
  const { cmd, args } = buildMetroSpawnArgs({ isExpo: true, port: 8083 });
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['expo', 'start', '--port', '8083']);
});

test('buildMetroSpawnArgs returns correct argv for bare', () => {
  const { cmd, args } = buildMetroSpawnArgs({ isExpo: false, port: 8083 });
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['react-native', 'start', '--port', '8083']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/metro.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/metro.js**

```javascript
// src/metro.js
import { createHash } from 'crypto';
import { mkdirSync, existsSync, openSync, statSync } from 'fs';
import { join } from 'path';
import { getExecutor } from './exec.js';
import { getConfigDir } from './config.js';
import { isMetroRunning } from './ports.js';

export function projectHash(projectPath) {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
}

export function logFileFor(projectPath) {
  const dir = join(getConfigDir(), 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${projectHash(projectPath)}.log`);
}

export function buildMetroSpawnArgs({ isExpo, port }) {
  return {
    cmd: 'npx',
    args: isExpo ? ['expo', 'start', '--port', String(port)] : ['react-native', 'start', '--port', String(port)],
  };
}

export async function ensureMetro({ projectPath, isExpo, port, detach = true }) {
  if (await isMetroRunning(port)) return { alreadyRunning: true, pid: null };

  const log = logFileFor(projectPath);
  const fd = openSync(log, 'a');

  const { cmd, args } = buildMetroSpawnArgs({ isExpo, port });
  const exec = getExecutor();
  const child = exec.spawn(cmd, args, {
    cwd: projectPath,
    detached: detach,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, RCT_METRO_PORT: String(port) },
  });
  if (detach) child.unref();
  return { alreadyRunning: false, pid: child.pid };
}

export function killMetroByPid(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function logFileExists(projectPath) {
  const path = logFileFor(projectPath);
  try {
    statSync(path);
    return path;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/metro.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/metro.js test/metro.test.js
git commit -m "feat: Metro process management with detached spawn and log files"
```

---

## Task 10: `rn-iso device` command

The simplest user-facing command — surface assignment lookup.

**Files:**

- Create: `src/commands/device.js`
- Modify: `bin/cli.js`

- [ ] **Step 1: Implement src/commands/device.js**

```javascript
// src/commands/device.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject } from '../config.js';

export default function deviceCommand(program) {
  program
    .command('device')
    .description('Print the assigned device UDID/serial for the current project')
    .option('--platform <platform>', 'ios or android', 'ios')
    .option('--json', 'Emit JSON with full assignment info')
    .action((opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj) {
        console.error(chalk.red(`No rn-iso assignment for project ${root}. Run \`rn-iso ${opts.platform}\` first.`));
        process.exit(1);
      }
      const platformEntry = proj.platforms?.[opts.platform];
      if (!platformEntry) {
        console.error(chalk.red(`No ${opts.platform} device assigned. Run \`rn-iso ${opts.platform}\` first.`));
        process.exit(1);
      }

      if (opts.json) {
        const payload =
          opts.platform === 'ios'
            ? { platform: 'ios', udid: platformEntry.deviceUdid, metroPort: proj.metroPort }
            : {
                platform: 'android',
                serial: `emulator-${platformEntry.consolePort}`,
                avdName: platformEntry.avdName,
                consolePort: platformEntry.consolePort,
                metroPort: proj.metroPort,
              };
        console.log(JSON.stringify(payload));
        return;
      }

      if (opts.platform === 'ios') {
        console.log(platformEntry.deviceUdid);
      } else {
        console.log(`emulator-${platformEntry.consolePort}`);
      }
    });
}
```

- [ ] **Step 2: Wire into bin/cli.js**

Replace `bin/cli.js` with:

```javascript
#!/usr/bin/env node
import { Command } from 'commander';
import deviceCommand from '../src/commands/device.js';

const program = new Command();
program.name('rn-iso').description('Isolated React Native dev environments per project/worktree').version('0.1.0');

deviceCommand(program);

program.parse();
```

- [ ] **Step 3: Smoke test (no project assigned, expect error)**

Run: `cd /tmp && node /Users/janicduplessis/Developer/rn-iso/bin/cli.js device`
Expected: stderr contains "Not in a React Native project"; exit code 1.

- [ ] **Step 4: Commit**

```bash
git add src/commands/device.js bin/cli.js
git commit -m "feat: rn-iso device command"
```

---

## Task 11: `rn-iso ios` command — ensure sim assigned, booted, app installed, Metro running

This is the central user flow. It composes everything built so far.

**Files:**

- Create: `src/commands/ios.js`
- Modify: `bin/cli.js`

- [ ] **Step 1: Implement src/commands/ios.js**

```javascript
// src/commands/ios.js
import chalk from 'chalk';
import prompts from 'prompts';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, allClaimedDevices } from '../config.js';
import { allocatePort } from '../ports.js';
import { selectIosDevice, bootIosSim, listIosDeviceTypes, listIosRuntimes, createIosSim } from '../sim/ios.js';
import { ensureMetro } from '../metro.js';
import { buildIosCommand, resolveSimNameByUdid } from '../runner.js';
import { getExecutor } from '../exec.js';

export default function iosCommand(program) {
  program
    .command('ios')
    .description('Ensure a dedicated iOS simulator + Metro server for the current project; build/install if needed')
    .option('--device-type <name>', 'Device type identifier for new sim (e.g. "iPhone 15 Pro")')
    .option('--auto', 'Non-interactive: boot a fresh sim if none available, no prompts')
    .option('--no-install', 'Skip the build/install step (assume app is already installed)')
    .action(async (opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }

      const bundleId = detectBundleId(root);
      const androidPackage = detectAndroidPackage(root);
      const isExpo = detectIsExpo(root);
      if (!bundleId) {
        console.error(
          chalk.red('Could not detect iOS bundle identifier. v1 requires app.json with expo.ios.bundleIdentifier set.'),
        );
        process.exit(1);
      }

      // Register or update the project entry.
      let proj = getProject(root);
      if (!proj) {
        upsertProject(root, { bundleId, androidPackage, isExpo });
      } else {
        upsertProject(root, { bundleId, androidPackage, isExpo });
      }
      proj = getProject(root);

      // Allocate Metro port if not yet assigned.
      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
        console.log(chalk.dim(`Allocated Metro port: ${port}`));
      }

      // Pick (or reuse) a simulator.
      const claimed = allClaimedDevices().iosUdids.filter((u) => u !== proj.platforms?.ios?.deviceUdid);
      const selection = selectIosDevice({
        existingUdid: proj.platforms?.ios?.deviceUdid || null,
        claimedUdids: claimed,
      });

      let udid;
      if (selection.kind === 'reuse') {
        udid = selection.udid;
        if (selection.state !== 'Booted') {
          console.log(chalk.dim(`Booting assigned sim ${udid}...`));
          bootIosSim(udid);
        } else {
          console.log(chalk.dim(`Reusing assigned sim ${udid} (already booted)`));
        }
      } else if (selection.kind === 'allocate') {
        udid = selection.udid;
        console.log(chalk.green(`Assigned booted sim ${udid}`));
      } else {
        // needsBoot: nothing booted+unclaimed.
        udid = await bootNewSim({ auto: opts.auto, deviceType: opts.deviceType });
        console.log(chalk.green(`Booted new sim ${udid}`));
      }

      setDevice(root, 'ios', { deviceUdid: udid });

      // Ensure Metro is running.
      const metro = await ensureMetro({ projectPath: root, isExpo, port: proj.metroPort });
      if (metro.alreadyRunning) {
        console.log(chalk.dim(`Metro already running on port ${proj.metroPort}`));
      } else {
        setMetro(root, proj.metroPort, metro.pid);
        console.log(chalk.green(`Metro started (pid ${metro.pid}, port ${proj.metroPort}) — logs at ~/.rn-iso/logs/`));
      }

      // Build/install/launch unless --no-install.
      if (opts.install !== false) {
        const simName = isExpo ? null : resolveSimNameByUdid(udid);
        const cmd = buildIosCommand({ isExpo, udid, port: proj.metroPort, simName });
        console.log(chalk.dim(`> ${cmd}`));
        // Stream the build output via spawn-with-inherit-stdio.
        const exec = getExecutor();
        const child = exec.spawn('sh', ['-c', cmd], { cwd: root, stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code})`))));
        });
      }

      console.log(chalk.green(`\n✓ iOS ready on sim ${udid}, Metro port ${proj.metroPort}`));
    });
}

async function bootNewSim({ auto, deviceType }) {
  const types = listIosDeviceTypes().filter((t) => t.identifier.includes('iPhone'));
  const runtimes = listIosRuntimes();
  if (runtimes.length === 0) throw new Error('No iOS runtimes installed; install one via Xcode.');
  const latestRuntime = runtimes.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];

  let chosenType;
  if (deviceType) {
    chosenType = types.find((t) => t.name === deviceType || t.identifier === deviceType);
    if (!chosenType) throw new Error(`Device type not found: ${deviceType}`);
  } else if (auto) {
    chosenType = types.find((t) => t.name === 'iPhone 15 Pro') || types[0];
  } else {
    const choices = types.map((t) => ({ title: t.name, value: t.identifier }));
    const answer = await prompts({
      type: 'select',
      name: 'id',
      message: 'No booted simulator available. Pick a device type to boot:',
      choices,
    });
    if (!answer.id) throw new Error('Cancelled.');
    chosenType = types.find((t) => t.identifier === answer.id);
  }

  const udid = createIosSim(chosenType.identifier, latestRuntime.identifier);
  bootIosSim(udid);
  return udid;
}
```

- [ ] **Step 2: Wire into bin/cli.js**

```javascript
#!/usr/bin/env node
import { Command } from 'commander';
import deviceCommand from '../src/commands/device.js';
import iosCommand from '../src/commands/ios.js';

const program = new Command();
program.name('rn-iso').description('Isolated React Native dev environments per project/worktree').version('0.1.0');

deviceCommand(program);
iosCommand(program);

program.parse();
```

- [ ] **Step 3: Manual verification**

In a real Expo project (or test fixture):

```bash
cd /path/to/some-expo-app
node /Users/janicduplessis/Developer/rn-iso/bin/cli.js ios --no-install
```

Expected: Metro starts, a sim is assigned (or booted), config is updated. Verify by inspecting `~/.rn-iso/config.json` and the log file at `~/.rn-iso/logs/`.

If no booted sim and no `--auto`, you should get a picker prompt.

- [ ] **Step 4: Commit**

```bash
git add src/commands/ios.js bin/cli.js
git commit -m "feat: rn-iso ios command — sim allocation, Metro, build dispatch"
```

---

## Task 12: `rn-iso android` command

Mirror of `ios.js` but with Android specifics.

**Files:**

- Create: `src/commands/android.js`
- Modify: `bin/cli.js`

- [ ] **Step 1: Implement src/commands/android.js**

```javascript
// src/commands/android.js
import chalk from 'chalk';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, allClaimedDevices } from '../config.js';
import { allocatePort } from '../ports.js';
import { selectAndroidDevice, bootAndroidEmulator, waitForBoot, adbReverse, listAdbDevices } from '../sim/android.js';
import { ensureMetro } from '../metro.js';
import { buildAndroidCommand } from '../runner.js';
import { getExecutor } from '../exec.js';

export default function androidCommand(program) {
  program
    .command('android')
    .description('Ensure a dedicated Android emulator + Metro for the current project; build/install if needed')
    .option('--no-install', 'Skip the build/install step')
    .action(async (opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }

      const bundleId = detectBundleId(root);
      const androidPackage = detectAndroidPackage(root);
      const isExpo = detectIsExpo(root);
      if (!androidPackage) {
        console.error(
          chalk.red('Could not detect Android package. v1 requires app.json with expo.android.package set.'),
        );
        process.exit(1);
      }

      let proj = getProject(root);
      if (!proj) {
        upsertProject(root, { bundleId, androidPackage, isExpo });
      } else {
        upsertProject(root, { bundleId, androidPackage, isExpo });
      }
      proj = getProject(root);

      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
        console.log(chalk.dim(`Allocated Metro port: ${port}`));
      }

      const claimed = allClaimedDevices();
      const myAvd = proj.platforms?.android?.avdName || null;
      const myPort = proj.platforms?.android?.consolePort || null;
      const claimedAvds = claimed.androidAvds.filter((a) => a !== myAvd);
      const claimedPorts = claimed.androidConsolePorts.filter((p) => p !== myPort);

      const selection = selectAndroidDevice({
        existingAvd: myAvd,
        existingConsolePort: myPort,
        claimedAvds,
        claimedConsolePorts: claimedPorts,
      });

      if (selection.kind === 'noAvd') {
        console.error(
          chalk.red(
            'No AVDs available (or all are claimed by other projects). ' +
              'Create one via Android Studio (Tools → Device Manager).',
          ),
        );
        process.exit(1);
      }

      const { avdName, consolePort, isRunning } = selection;
      const serial = `emulator-${consolePort}`;

      if (!isRunning) {
        console.log(chalk.dim(`Booting emulator ${avdName} on port ${consolePort}...`));
        bootAndroidEmulator(avdName, consolePort);
        console.log(chalk.dim('Waiting for boot to complete (this can take 10-30s)...'));
        const ok = await waitForBoot(serial, 120000);
        if (!ok) {
          console.error(chalk.red(`Emulator ${serial} did not finish booting within 2 minutes.`));
          process.exit(1);
        }
      } else {
        console.log(chalk.dim(`Reusing running emulator ${serial}`));
      }

      setDevice(root, 'android', { avdName, consolePort });

      const metro = await ensureMetro({ projectPath: root, isExpo, port: proj.metroPort });
      if (metro.alreadyRunning) {
        console.log(chalk.dim(`Metro already running on port ${proj.metroPort}`));
      } else {
        setMetro(root, proj.metroPort, metro.pid);
        console.log(chalk.green(`Metro started (pid ${metro.pid}, port ${proj.metroPort})`));
      }

      adbReverse(serial, proj.metroPort);
      console.log(chalk.dim(`adb reverse tcp:${proj.metroPort} configured for ${serial}`));

      if (opts.install !== false) {
        const cmd = buildAndroidCommand({ isExpo, serial, port: proj.metroPort });
        console.log(chalk.dim(`> ${cmd}`));
        const exec = getExecutor();
        const child = exec.spawn('sh', ['-c', cmd], { cwd: root, stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code})`))));
        });
      }

      console.log(chalk.green(`\n✓ Android ready on ${serial}, Metro port ${proj.metroPort}`));
    });
}
```

- [ ] **Step 2: Wire into bin/cli.js**

```javascript
#!/usr/bin/env node
import { Command } from 'commander';
import deviceCommand from '../src/commands/device.js';
import iosCommand from '../src/commands/ios.js';
import androidCommand from '../src/commands/android.js';

const program = new Command();
program.name('rn-iso').description('Isolated React Native dev environments per project/worktree').version('0.1.0');

deviceCommand(program);
iosCommand(program);
androidCommand(program);

program.parse();
```

- [ ] **Step 3: Manual verification**

```bash
cd /path/to/some-expo-app
node /Users/janicduplessis/Developer/rn-iso/bin/cli.js android --no-install
```

Expected: emulator boots if needed, Metro starts, adb reverse runs, config is updated.

- [ ] **Step 4: Commit**

```bash
git add src/commands/android.js bin/cli.js
git commit -m "feat: rn-iso android command — emulator allocation, Metro, build dispatch"
```

---

## Task 13: `rn-iso start` / `stop` / `logs` commands

Metro lifecycle commands without platform action.

**Files:**

- Create: `src/commands/start.js`
- Create: `src/commands/stop.js`
- Create: `src/commands/logs.js`
- Modify: `bin/cli.js`

- [ ] **Step 1: Implement src/commands/start.js**

```javascript
// src/commands/start.js
import chalk from 'chalk';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro } from '../config.js';
import { allocatePort } from '../ports.js';
import { ensureMetro } from '../metro.js';

export default function startCommand(program) {
  program
    .command('start')
    .description('Ensure Metro is running for the current project (no platform action)')
    .action(async () => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }
      const isExpo = detectIsExpo(root);

      let proj = getProject(root);
      if (!proj) {
        upsertProject(root, {
          bundleId: detectBundleId(root),
          androidPackage: detectAndroidPackage(root),
          isExpo,
        });
        proj = getProject(root);
      }
      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
      }

      const metro = await ensureMetro({ projectPath: root, isExpo, port: proj.metroPort });
      if (metro.alreadyRunning) {
        console.log(chalk.dim(`Metro already running on port ${proj.metroPort}`));
      } else {
        setMetro(root, proj.metroPort, metro.pid);
        console.log(chalk.green(`Metro started (pid ${metro.pid}, port ${proj.metroPort})`));
      }
    });
}
```

- [ ] **Step 2: Implement src/commands/stop.js**

```javascript
// src/commands/stop.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject, setMetro } from '../config.js';
import { killMetroByPid } from '../metro.js';

export default function stopCommand(program) {
  program
    .command('stop')
    .description('Kill the Metro process for the current project')
    .action(() => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project.'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj?.metroPid) {
        console.log(chalk.dim('No Metro PID recorded for this project.'));
        return;
      }
      const ok = killMetroByPid(proj.metroPid);
      setMetro(root, proj.metroPort, null);
      console.log(
        ok ? chalk.green(`Killed Metro pid ${proj.metroPid}`) : chalk.dim(`Metro pid ${proj.metroPid} was not alive`),
      );
    });
}
```

- [ ] **Step 3: Implement src/commands/logs.js**

```javascript
// src/commands/logs.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { logFileExists } from '../metro.js';
import { getExecutor } from '../exec.js';

export default function logsCommand(program) {
  program
    .command('logs')
    .description('Tail the Metro log file for the current project')
    .action(() => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project.'));
        process.exit(1);
      }
      const path = logFileExists(root);
      if (!path) {
        console.error(chalk.red('No Metro log file found. Have you run `rn-iso start` or `rn-iso ios/android`?'));
        process.exit(1);
      }
      console.log(chalk.dim(`Tailing ${path}\n`));
      const exec = getExecutor();
      const child = exec.spawn('tail', ['-f', path], { stdio: 'inherit' });
      // Forward SIGINT cleanly
      process.on('SIGINT', () => child.kill('SIGINT'));
    });
}
```

- [ ] **Step 4: Wire into bin/cli.js**

```javascript
#!/usr/bin/env node
import { Command } from 'commander';
import deviceCommand from '../src/commands/device.js';
import iosCommand from '../src/commands/ios.js';
import androidCommand from '../src/commands/android.js';
import startCommand from '../src/commands/start.js';
import stopCommand from '../src/commands/stop.js';
import logsCommand from '../src/commands/logs.js';

const program = new Command();
program.name('rn-iso').description('Isolated React Native dev environments per project/worktree').version('0.1.0');

deviceCommand(program);
iosCommand(program);
androidCommand(program);
startCommand(program);
stopCommand(program);
logsCommand(program);

program.parse();
```

- [ ] **Step 5: Manual verification**

In a project: `node bin/cli.js start`, then `node bin/cli.js stop`, then `node bin/cli.js logs` (will fail if no log yet, succeed after a start).

- [ ] **Step 6: Commit**

```bash
git add src/commands/start.js src/commands/stop.js src/commands/logs.js bin/cli.js
git commit -m "feat: rn-iso start / stop / logs commands"
```

---

## Task 14: `rn-iso status` command

Show all projects' state.

**Files:**

- Create: `src/commands/status.js`
- Modify: `bin/cli.js`

- [ ] **Step 1: Implement src/commands/status.js**

```javascript
// src/commands/status.js
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { isMetroRunning } from '../ports.js';
import { isPidAlive } from '../metro.js';
import { findProjectRoot } from '../project.js';

export default function statusCommand(program) {
  program
    .command('status')
    .description('Show all rn-iso project assignments and Metro state')
    .action(async () => {
      const cfg = loadConfig();
      if (!cfg || Object.keys(cfg.projects).length === 0) {
        console.log(chalk.dim('No projects registered.'));
        return;
      }

      const cwdRoot = findProjectRoot(process.cwd());

      for (const [path, proj] of Object.entries(cfg.projects)) {
        const isCurrent = path === cwdRoot;
        const header = isCurrent ? chalk.bold.cyan(`* ${path}`) : path;
        console.log('\n' + header);
        console.log(chalk.dim(`  app: ${proj.bundleId} (${proj.isExpo ? 'expo' : 'bare'})`));

        if (proj.metroPort) {
          const running = await isMetroRunning(proj.metroPort);
          const pidLive = isPidAlive(proj.metroPid);
          const label = running
            ? chalk.green('running')
            : pidLive
              ? chalk.yellow('pid alive but not responding')
              : chalk.dim('stopped');
          console.log(`  metro: port ${proj.metroPort} pid ${proj.metroPid ?? '?'} (${label})`);
        } else {
          console.log(chalk.dim('  metro: unassigned'));
        }

        const ios = proj.platforms?.ios;
        if (ios) console.log(`  ios: ${chalk.cyan(ios.deviceUdid)}`);
        const android = proj.platforms?.android;
        if (android) console.log(`  android: ${chalk.cyan(android.avdName)} on emulator-${android.consolePort}`);
      }
      console.log('');
    });
}
```

- [ ] **Step 2: Wire into bin/cli.js**

Add `import statusCommand from '../src/commands/status.js';` and `statusCommand(program);`.

- [ ] **Step 3: Manual verification**

After running `rn-iso ios` in one or two projects: `node bin/cli.js status`. Should list each with their port + sim.

- [ ] **Step 4: Commit**

```bash
git add src/commands/status.js bin/cli.js
git commit -m "feat: rn-iso status command"
```

---

## Task 15: `rn-iso release` and `rn-iso shutdown` commands

**Files:**

- Create: `src/commands/release.js`
- Create: `src/commands/shutdown.js`
- Modify: `bin/cli.js`

- [ ] **Step 1: Implement src/commands/release.js**

```javascript
// src/commands/release.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject, clearDevice } from '../config.js';

export default function releaseCommand(program) {
  program
    .command('release')
    .description('Unbind device assignment(s) for the current project')
    .option('--platform <platform>', 'ios or android (default: both)')
    .action((opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project.'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj) {
        console.log(chalk.dim('No project entry to release.'));
        return;
      }
      const platforms = opts.platform ? [opts.platform] : ['ios', 'android'];
      for (const p of platforms) {
        if (proj.platforms?.[p]) {
          clearDevice(root, p);
          console.log(chalk.green(`Released ${p} assignment.`));
        } else {
          console.log(chalk.dim(`No ${p} assignment to release.`));
        }
      }
    });
}
```

- [ ] **Step 2: Implement src/commands/shutdown.js**

```javascript
// src/commands/shutdown.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject, clearDevice } from '../config.js';
import { shutdownIosSim } from '../sim/ios.js';
import { shutdownAndroidEmulator } from '../sim/android.js';

export default function shutdownCommand(program) {
  program
    .command('shutdown')
    .description('Release and shut down the simulator/emulator(s) for the current project')
    .option('--platform <platform>', 'ios or android (default: both)')
    .action((opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project.'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj) {
        console.log(chalk.dim('No project entry.'));
        return;
      }
      const platforms = opts.platform ? [opts.platform] : ['ios', 'android'];
      for (const p of platforms) {
        const entry = proj.platforms?.[p];
        if (!entry) {
          console.log(chalk.dim(`No ${p} assignment.`));
          continue;
        }
        if (p === 'ios') {
          shutdownIosSim(entry.deviceUdid);
          console.log(chalk.green(`Shut down iOS sim ${entry.deviceUdid}`));
        } else {
          shutdownAndroidEmulator(`emulator-${entry.consolePort}`);
          console.log(chalk.green(`Shut down emulator-${entry.consolePort}`));
        }
        clearDevice(root, p);
      }
    });
}
```

- [ ] **Step 3: Wire into bin/cli.js**

Add imports and registrations for both.

- [ ] **Step 4: Commit**

```bash
git add src/commands/release.js src/commands/shutdown.js bin/cli.js
git commit -m "feat: rn-iso release and shutdown commands"
```

---

## Task 16: `rn-iso prune` command

GC dead entries machine-wide.

**Files:**

- Create: `src/commands/prune.js`
- Modify: `bin/cli.js`

- [ ] **Step 1: Implement src/commands/prune.js**

```javascript
// src/commands/prune.js
import { existsSync } from 'fs';
import chalk from 'chalk';
import { loadConfig, removeProject, clearDevice } from '../config.js';
import { listAllIosSims, shutdownIosSim } from '../sim/ios.js';
import { listAvds, shutdownAndroidEmulator } from '../sim/android.js';

export default function pruneCommand(program) {
  program
    .command('prune')
    .description('Garbage-collect dead project entries and missing device assignments')
    .option('--shutdown', 'Also shut down sims/emulators referenced only by dropped entries')
    .action((opts) => {
      const cfg = loadConfig();
      if (!cfg?.projects) {
        console.log(chalk.dim('Nothing to prune.'));
        return;
      }

      const allIosUdids = new Set(listAllIosSims().map((s) => s.udid));
      const allAvds = new Set(listAvds());

      const droppedSims = [];
      const droppedEmulators = [];

      for (const [path, proj] of Object.entries(cfg.projects)) {
        // Drop entire project if its dir is gone.
        if (!existsSync(path)) {
          if (opts.shutdown) {
            if (proj.platforms?.ios?.deviceUdid) droppedSims.push(proj.platforms.ios.deviceUdid);
            if (proj.platforms?.android?.consolePort) droppedEmulators.push(proj.platforms.android.consolePort);
          }
          removeProject(path);
          console.log(chalk.yellow(`Dropped missing project: ${path}`));
          continue;
        }

        // Drop iOS assignment if UDID no longer exists.
        if (proj.platforms?.ios && !allIosUdids.has(proj.platforms.ios.deviceUdid)) {
          clearDevice(path, 'ios');
          console.log(chalk.dim(`${path}: cleared stale iOS assignment ${proj.platforms.ios.deviceUdid}`));
        }
        // Drop Android assignment if AVD no longer exists.
        if (proj.platforms?.android && !allAvds.has(proj.platforms.android.avdName)) {
          clearDevice(path, 'android');
          console.log(chalk.dim(`${path}: cleared stale Android assignment ${proj.platforms.android.avdName}`));
        }
      }

      if (opts.shutdown) {
        for (const udid of droppedSims) shutdownIosSim(udid);
        for (const port of droppedEmulators) shutdownAndroidEmulator(`emulator-${port}`);
      }

      console.log(chalk.green('Prune complete.'));
    });
}
```

- [ ] **Step 2: Wire into bin/cli.js**

Add import and registration for `pruneCommand`.

- [ ] **Step 3: Commit**

```bash
git add src/commands/prune.js bin/cli.js
git commit -m "feat: rn-iso prune command for GC"
```

---

## Task 17: Skill file for AI agents

**Files:**

- Create: `skill/SKILL.md`

- [ ] **Step 1: Write skill/SKILL.md**

````markdown
---
name: rn-iso
description: Manage isolated React Native / Expo dev environments. Each project (or worktree) gets its own Metro server and dedicated simulator/emulator. Use to ensure the right simulator is booted with the right port, and to discover which device to target for UI interactions.
user_invocable: true
---

# rn-iso — Isolated RN Dev Environments

You are an AI agent working on a React Native / Expo project, possibly alongside other agents working on different projects or worktrees. Each project owns its own dedicated simulator and Metro server. There is no locking — your sim is yours.

## Core workflow

From the project root (or any subdirectory):

1. **Ensure the platform is ready** — `rn-iso ios` or `rn-iso android`. This:
   - Allocates a Metro port for the project (or reuses the assigned one)
   - Picks a dedicated simulator (or boots a new one)
   - Starts Metro detached
   - Builds and installs the app on the simulator

2. **Get the device target** — `rn-iso device --platform ios --json` returns:
   ```json
   { "platform": "ios", "udid": "ABC-...", "metroPort": 8083 }
   ```
````

Use the UDID for any `agent-device` / `xcrun simctl` / `idb` calls. For Android, the `serial` field gives you `emulator-<port>` to use with `adb -s`.

3. **Interact with the device** — pass the UDID/serial to your UI tools. Never call `simctl boot` or `simctl <verb>` without `<UDID>` — `booted` could be the wrong sim.

## CRITICAL rules

- **Always use `rn-iso device` to discover your target.** Never assume `booted` is your sim — another project's simulator might be booted too.
- **Always pass the UDID/serial explicitly** to `xcrun simctl` and `adb -s`. Examples:
  - `xcrun simctl io <UDID> screenshot out.png`
  - `adb -s emulator-5556 shell input tap 100 200`
- **Don't call `release` or `shutdown`** unless the user explicitly asks. Other agents may be using neighboring sims; keep yours up so the user can come back to it.
- **Don't manually start Metro on a different port.** `rn-iso start` (or `rn-iso ios/android`) already handles port assignment.
- **For non-interactive / first-run scenarios**, pass `--auto` and optionally `--device-type "iPhone 15 Pro"`. Without these, `rn-iso ios` will prompt for a device type if no sims are booted.

## Typical agent workflow

```bash
# Once per session — ensure the project's sim and Metro are up.
rn-iso ios --auto

# Get the target.
UDID=$(rn-iso device --platform ios)

# Use the target for UI interactions (delegate to agent-device or your tool of choice).
xcrun simctl io "$UDID" screenshot /tmp/screen.png

# When you change app code, Metro hot-reloads automatically. No restart needed.
# Only re-run `rn-iso ios` when you've changed native code or installed new native modules.
```

## When things go wrong

- **"No rn-iso assignment for project"** — run `rn-iso ios` (or android) first.
- **"Could not detect bundle identifier"** — your project's `app.json` is missing `expo.ios.bundleIdentifier`. Fix the app config.
- **Metro port collision** — `rn-iso ios` should reclaim dead ports automatically. If you see "port busy by non-Metro process," another tool is using that port; close it.
- **Sim was deleted** — `rn-iso ios` will detect the stale assignment and re-allocate. If not, run `rn-iso prune` then `rn-iso ios`.

## Other useful commands

- `rn-iso status` — show all projects and their state.
- `rn-iso logs` — tail the Metro log for the current project.
- `rn-iso stop` — kill the project's Metro (rare — usually leave it running).
- `rn-iso prune` — GC dead entries machine-wide; safe to run periodically.

## Differences from `react-native-worktree`

`react-native-worktree` shares one simulator across worktrees with a mutex. `rn-iso` gives each project its own dedicated simulator — no locking, no contention. If both are installed, prefer `rn-iso` unless the user explicitly asks for the shared-sim model.

````

- [ ] **Step 2: Commit**

```bash
git add skill/SKILL.md
git commit -m "docs: skill file for AI agent integration"
````

---

## Task 18: README

**Files:**

- Create: `README.md`

- [ ] **Step 1: Write README.md**

````markdown
# rn-iso

Isolated React Native / Expo dev environments per project or worktree. Each project gets its own Metro server and dedicated simulator/emulator. Designed for running multiple AI coding agents in parallel without port or device collisions.

## Install

```bash
npm install -g rn-iso
```
````

For AI agents, install the skill:

```bash
# Claude Code
mkdir -p ~/.claude/skills/rn-iso && curl -fsSL https://raw.githubusercontent.com/.../rn-iso/main/skill/SKILL.md -o ~/.claude/skills/rn-iso/SKILL.md
```

## Quick start

In any RN/Expo project directory:

```bash
rn-iso ios       # ensure sim, Metro, build/install
rn-iso device    # print the assigned UDID
```

In a different worktree of the same app:

```bash
rn-iso ios       # gets a different sim and Metro port automatically
```

Both run side-by-side, no contention.

## Commands

| Command                                                     | Purpose                                         |
| ----------------------------------------------------------- | ----------------------------------------------- |
| `rn-iso ios [--auto] [--device-type <name>] [--no-install]` | Ensure iOS sim + Metro + build/install          |
| `rn-iso android [--no-install]`                             | Same for Android                                |
| `rn-iso start`                                              | Just start Metro, no platform action            |
| `rn-iso device [--platform ios                              | android] [--json]`                              | Print the assigned device target |
| `rn-iso status`                                             | Show all projects' state                        |
| `rn-iso release [--platform <p>]`                           | Unbind device assignment(s) for current project |
| `rn-iso shutdown [--platform <p>]`                          | Release and shut down sims for current project  |
| `rn-iso prune [--shutdown]`                                 | GC dead entries machine-wide                    |
| `rn-iso logs`                                               | Tail Metro log for current project              |
| `rn-iso stop`                                               | Kill Metro for current project                  |

## How it works

- **Config** at `~/.rn-iso/config.json`, keyed by absolute project path. Worktrees produce different paths → different entries.
- **Port allocation:** assigns 8082, 8083, 8084 etc. Reclaims dead ports on assignment.
- **Simulator pool:** prefers reusing your project's existing assignment; falls back to any booted-and-unclaimed sim; prompts to boot a new one if needed (`--auto` skips the prompt).
- **No locking:** your sim is yours; other projects' sims are theirs. If you're on tight hardware and want one shared sim with a mutex, use [`react-native-worktree`](https://github.com/aleqsio/react-native-worktree) instead.

## Requirements

- macOS (iOS support); Linux/macOS (Android support)
- Node 20+
- Xcode (iOS), Android SDK + at least one AVD (Android)
- Either `expo` in `package.json` (Expo workflow) or `react-native` (bare workflow)

## License

MIT

````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README"
````

---

## Self-review checklist

After implementing all tasks:

- [ ] Run full test suite: `npm test` — all tests pass.
- [ ] Manual verification on a real Expo project: `cd ~/some-expo-app && rn-iso ios --auto --no-install` succeeds.
- [ ] Manual verification on a worktree: create a worktree of the same app, run `rn-iso ios --auto` in it, confirm a different port and (if available) a different sim are used.
- [ ] `rn-iso status` shows both correctly.
- [ ] `rn-iso device --json` returns valid JSON with the right port.
- [ ] `rn-iso prune` doesn't touch live entries.
- [ ] Skill file installs cleanly via the README curl command (test path).
