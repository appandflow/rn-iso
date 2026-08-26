# Spawn-and-Reap Ownership and Broker-Only Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Devices are created and owned by their environment (reaped on release/remove/gc) instead of claimed from a pool, and `rn-iso up <platform>` replaces the `ios`/`android` build wrappers — it provisions resources and prints facts; the agent runs the project's own build.

**Architecture:** New creation/deletion primitives in `src/sim/*.js`, a new `src/commands/up.js` consuming the full settings chain, then a deletion wave removing the claims/picker/dispatch machinery, then semantic updates to `release`/`shutdown`/`worktree remove`/`gc`/`status`, test hardening carried from the prior branch, and a docs rewrite.

**Tech Stack:** Node 20+, ESM only, `commander`, `chalk`. Tests are `node --test`, mockable executor via `src/exec.js`.

**Spec:** `docs/specs/2026-08-16-spawn-and-reap-broker-design.md` — read it first; it records the ownership rule, the graded semantics, and what is deliberately out of scope.

## Global Constraints

- ESM only. No `require()`. All `child_process` through `src/exec.js` (`getExecutor()`).
- **ASCII only in `src/`, `bin/`, `test/`.** Markdown may use non-ASCII.
- Pure logic separated from I/O; pure functions unit-tested.
- `RN_ISO_HOME` redirects config paths; config-touching tests set it in `beforeEach`, delete in `afterEach`.
- **The ownership rule:** rn-iso never boots, shuts down, or destroys a device it did not create. Owned devices are named `rn-iso-<label>` and recorded with `owned: true`. Legacy (unowned) assignments are reused but NEVER deleted or shut down. Physical devices are assignment-only.
- **Live verification is mandatory for every new shell command** (`simctl create/delete`, `avdmanager create/delete avd`). Three bugs shipped on the prior branch because mocked-executor tests cannot catch a wrong shell command. Run the real command once against the real tool and report the output. Never run the CLI against the rn-iso repo itself; set `RN_ISO_HOME` to a temp dir for any real-CLI check.
- Occupancy guard: any shutdown/delete of an owned device checks `isSimOccupied` first (iOS); `--force` overrides.
- Commits: conventional prefixes, titles under ~70 chars. Do not pass `--no-gpg-sign`; do not force signing (no key on this machine — unsigned is correct).
- `avdmanager` is NOT on PATH on this machine; resolve it as `$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager` (with `ANDROID_HOME` defaulting to `~/Library/Android/sdk`).
- Run `npm test` at the end of every task. Baseline at plan start: 232 passing.

---

### Task 1: iOS owned-device primitives

**Files:**

- Modify: `src/sim/ios.js`
- Test: `test/sim-ios.test.js`

**Interfaces:**

- Consumes: existing `listIosDeviceTypes()`, `listIosRuntimes()`, `bootIosSim`, `getExecutor`.
- Produces: `pickDefaultIosCreation(deviceTypes, runtimes, {deviceType, runtime})` (pure) returning `{deviceTypeId, runtimeId} | null`; `sanitizeDeviceLabel(label)` (pure); `createOwnedIosSim(label, {deviceType, runtime})` returning `{udid, name}`; `deleteIosSim(udid)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/sim-ios.test.js`:

```js
test('pickDefaultIosCreation picks the newest iPhone on the newest runtime', () => {
  const deviceTypes = [
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro', name: 'iPad Pro' },
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', name: 'iPhone 16' },
    { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' },
  ];
  const runtimes = [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
      name: 'iOS 26.2',
      version: '26.2',
      supportedDeviceTypes: deviceTypes,
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      name: 'iOS 26.5',
      version: '26.5',
      supportedDeviceTypes: deviceTypes,
    },
  ];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, {});
  assert.equal(pick.runtimeId, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5');
  assert.equal(pick.deviceTypeId, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro');
});

test('pickDefaultIosCreation honors explicit deviceType and runtime by name', () => {
  const deviceTypes = [{ identifier: 'dt.iphone16', name: 'iPhone 16' }];
  const runtimes = [
    { identifier: 'rt.26-2', name: 'iOS 26.2', version: '26.2', supportedDeviceTypes: deviceTypes },
    { identifier: 'rt.26-5', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes },
  ];
  const pick = pickDefaultIosCreation(deviceTypes, runtimes, { deviceType: 'iPhone 16', runtime: '26.2' });
  assert.equal(pick.deviceTypeId, 'dt.iphone16');
  assert.equal(pick.runtimeId, 'rt.26-2');
});

test('pickDefaultIosCreation returns null when nothing matches', () => {
  assert.equal(pickDefaultIosCreation([], [], {}), null);
  const deviceTypes = [{ identifier: 'dt', name: 'iPhone 17' }];
  const runtimes = [{ identifier: 'rt', name: 'iOS 26.5', version: '26.5', supportedDeviceTypes: deviceTypes }];
  assert.equal(pickDefaultIosCreation(deviceTypes, runtimes, { deviceType: 'iPhone 99' }), null);
});

test('sanitizeDeviceLabel strips characters simctl names should not carry', () => {
  assert.equal(sanitizeDeviceLabel('feat-a/tlon-mobile'), 'feat-a-tlon-mobile');
  assert.equal(sanitizeDeviceLabel('x  y"z`$'), 'x-y-z');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/sim-ios.test.js`
Expected: FAIL — `pickDefaultIosCreation is not defined`.

- [ ] **Step 3: Implement in `src/sim/ios.js`**

```js
// Newest iPhone device type on the newest installed runtime, unless the
// caller pinned either by name. Pure: takes the listings as data.
export function pickDefaultIosCreation(deviceTypes, runtimes, { deviceType, runtime } = {}) {
  const rts = [...runtimes].sort((a, b) =>
    String(b.version).localeCompare(String(a.version), undefined, { numeric: true }),
  );
  const wantedRts = runtime ? rts.filter((r) => r.version === runtime || r.name.endsWith(runtime)) : rts;
  for (const rt of wantedRts) {
    const supported = (rt.supportedDeviceTypes || []).filter((d) =>
      deviceType ? d.name === deviceType : /^iPhone/i.test(d.name),
    );
    if (supported.length === 0) continue;
    const best = [...supported].sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))[0];
    return { deviceTypeId: best.identifier, runtimeId: rt.identifier };
  }
  return null;
}

export function sanitizeDeviceLabel(label) {
  return String(label)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createOwnedIosSim(label, { deviceType, runtime } = {}) {
  const pick = pickDefaultIosCreation(listIosDeviceTypes(), listIosRuntimes(), { deviceType, runtime });
  if (!pick) {
    throw new Error(
      'No matching simulator device type / runtime is installed. Install one via Xcode, or pass --device-type / --runtime.',
    );
  }
  const name = `rn-iso-${sanitizeDeviceLabel(label)}`;
  const udid = getExecutor().run(`xcrun simctl create "${name}" "${pick.deviceTypeId}" "${pick.runtimeId}"`).trim();
  return { udid, name };
}

export function deleteIosSim(udid) {
  getExecutor().runQuiet(`xcrun simctl delete ${udid}`);
}
```

The existing random-suffix `createIosSim` is superseded; remove it and its callers in this task if the only caller is the old `--device-type` path inside `src/commands/ios.js` (that file is deleted in Task 4 — if removing `createIosSim` now would break it, leave the removal to Task 4 and note it).

- [ ] **Step 4: Run tests, then live-verify**

Run: `npm test` → PASS.

Live (report the output):

```bash
node --input-type=module -e "
import { createOwnedIosSim, deleteIosSim, listAllIosSims } from './src/sim/ios.js';
const { udid, name } = createOwnedIosSim('plan-verify');
console.log('created', name, udid);
console.log('visible:', listAllIosSims().some(s => s.udid === udid));
deleteIosSim(udid);
console.log('deleted:', !listAllIosSims().some(s => s.udid === udid));
"
```

Expected: created `rn-iso-plan-verify`, visible true, deleted true.

- [ ] **Step 5: Commit**

```bash
git add src/sim/ios.js test/sim-ios.test.js
git commit -m "feat(ios): owned-sim creation and deletion primitives"
```

---

### Task 2: Android owned-AVD primitives

**Files:**

- Modify: `src/sim/android.js`
- Test: `test/sim-android.test.js`

**Interfaces:**

- Consumes: `getExecutor`; filesystem under `$ANDROID_HOME/system-images`.
- Produces: `androidHome()`; `listInstalledSystemImages()` returning `[{api, tag, arch, pkg}]` where `pkg` is `system-images;android-36;google_apis;arm64-v8a`; `pickDefaultSystemImage(images, {systemImage})` (pure); `createOwnedAvd(label, {systemImage})` returning `{avdName}`; `deleteAvd(avdName)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/sim-android.test.js`:

```js
test('pickDefaultSystemImage prefers highest api, then google_apis, arm64 only', () => {
  const images = [
    { api: 35, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-35;default;arm64-v8a' },
    { api: 36, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-36;default;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'arm64-v8a', pkg: 'system-images;android-36;google_apis;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'x86_64', pkg: 'system-images;android-36;google_apis;x86_64' },
  ];
  assert.equal(pickDefaultSystemImage(images, {}).pkg, 'system-images;android-36;google_apis;arm64-v8a');
});

test('pickDefaultSystemImage honors an explicit package and returns null on no match', () => {
  const images = [{ api: 36, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-36;default;arm64-v8a' }];
  assert.equal(pickDefaultSystemImage(images, { systemImage: images[0].pkg }).pkg, images[0].pkg);
  assert.equal(pickDefaultSystemImage([], {}), null);
  assert.equal(pickDefaultSystemImage(images, { systemImage: 'system-images;android-99;x;y' }), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/sim-android.test.js`
Expected: FAIL — `pickDefaultSystemImage is not defined`.

- [ ] **Step 3: Implement in `src/sim/android.js`**

```js
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function androidHome() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library', 'Android', 'sdk');
}

function avdmanagerPath() {
  return join(androidHome(), 'cmdline-tools', 'latest', 'bin', 'avdmanager');
}

// system-images/<android-XX>/<tag>/<arch>/ on disk.
export function listInstalledSystemImages() {
  const root = join(androidHome(), 'system-images');
  const images = [];
  if (!existsSync(root)) return images;
  for (const apiDir of readdirSync(root)) {
    const m = apiDir.match(/^android-(\d+)$/);
    if (!m) continue;
    const apiPath = join(root, apiDir);
    for (const tag of safeList(apiPath)) {
      for (const arch of safeList(join(apiPath, tag))) {
        images.push({ api: Number(m[1]), tag, arch, pkg: `system-images;${apiDir};${tag};${arch}` });
      }
    }
  }
  return images;
}

function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Highest API first; google_apis over other tags; Apple Silicon needs arm64.
export function pickDefaultSystemImage(images, { systemImage } = {}) {
  if (systemImage) return images.find((i) => i.pkg === systemImage) || null;
  const arm = images.filter((i) => i.arch === 'arm64-v8a');
  if (arm.length === 0) return null;
  return [...arm].sort(
    (a, b) => b.api - a.api || (b.tag === 'google_apis' ? 1 : 0) - (a.tag === 'google_apis' ? 1 : 0),
  )[0];
}

export function createOwnedAvd(label, { systemImage } = {}) {
  const pick = pickDefaultSystemImage(listInstalledSystemImages(), { systemImage });
  if (!pick) {
    throw new Error(
      'No arm64 Android system image is installed. Install one, e.g.: sdkmanager "system-images;android-36;google_apis;arm64-v8a"',
    );
  }
  const avdName = `rn-iso-${sanitizeAvdLabel(label)}`;
  // avdmanager prompts "Do you wish to create a custom hardware profile?";
  // piping "no" answers it non-interactively.
  getExecutor().run(`echo no | "${avdmanagerPath()}" create avd -n "${avdName}" -k "${pick.pkg}"`);
  return { avdName };
}

export function sanitizeAvdLabel(label) {
  return String(label)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deleteAvd(avdName) {
  getExecutor().runQuiet(`"${avdmanagerPath()}" delete avd -n "${avdName}"`);
}
```

- [ ] **Step 4: Run tests, then live-verify**

Run: `npm test` → PASS.

Live (report the output; this machine has `android-36 / arm64-v8a` installed):

```bash
node --input-type=module -e "
import { listInstalledSystemImages, pickDefaultSystemImage, createOwnedAvd, deleteAvd, listAvds } from './src/sim/android.js';
console.log('images:', listInstalledSystemImages());
console.log('pick:', pickDefaultSystemImage(listInstalledSystemImages(), {}));
const { avdName } = createOwnedAvd('plan-verify');
console.log('created', avdName, 'listed:', listAvds().includes(avdName));
deleteAvd(avdName);
console.log('deleted:', !listAvds().includes(avdName));
"
```

Expected: at least one image, a non-null pick, created+listed true, deleted true. If `avdmanager` needs a JDK env var on this machine, report what was required rather than working around it silently.

- [ ] **Step 5: Commit**

```bash
git add src/sim/android.js test/sim-android.test.js
git commit -m "feat(android): owned-AVD creation and deletion primitives"
```

---

### Task 3: `rn-iso up <platform>`

**Files:**

- Create: `src/commands/up.js`
- Modify: `bin/cli.js`, `src/config.js`
- Test: `test/up.test.js`

**Interfaces:**

- Consumes: Task 1/2 primitives; `allocatePort` (`src/ports.js`); `ensureMetro`, `waitForMetroReady` (`src/metro.js`); `resolveSettings` (`src/settings.js`); `gitCommonDir`, `repoRoot` (`src/worktree.js`); `findProjectRoot`, `detectIsExpo`, `detectBundleId`, `detectAndroidPackage` (`src/project.js`); `bootIosSim`, `isSimOccupied` (`src/sim/ios.js`); `bootAndroidEmulator`, `waitForBoot`, `adbReverse`, `nextConsolePort`, `listAdbDevices` (`src/sim/android.js`); `getSetupStatus`, `getProject`, `upsertProject`, `setDevice` (`src/config.js`).
- Produces: `buildFacts({platform, project, port, metro, setup})` (pure) returning the JSON payload object; `ensureOwnedDevice({platform, project, projectPath, label, settings, flags})` returning the device record; the registered `up` command.

- [ ] **Step 1: Write the failing tests**

Create `test/up.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildFacts } from '../src/commands/up.js';

let tmpHome;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('buildFacts shapes the ios payload', () => {
  const facts = buildFacts({
    platform: 'ios',
    device: { deviceUdid: 'U1', owned: true, deviceName: 'rn-iso-app' },
    port: 8082,
    metro: { pid: 12, healthy: true, log: '/l.log' },
    bundleId: 'com.app',
    setup: { complete: true, commands: [] },
  });
  assert.deepEqual(facts, {
    platform: 'ios',
    udid: 'U1',
    owned: true,
    deviceName: 'rn-iso-app',
    metroPort: 8082,
    metroPid: 12,
    metroHealthy: true,
    metroLog: '/l.log',
    bundleId: 'com.app',
    setup: { complete: true, commands: [] },
  });
});

test('buildFacts shapes the android payload with serial and kind', () => {
  const facts = buildFacts({
    platform: 'android',
    device: { avdName: 'rn-iso-app', consolePort: 5554, owned: true },
    port: 8083,
    metro: { pid: 13, healthy: true, log: '/l.log' },
    bundleId: 'com.app',
    setup: null,
  });
  assert.equal(facts.serial, 'emulator-5554');
  assert.equal(facts.kind, 'emulator');
  assert.equal(facts.avdName, 'rn-iso-app');
  assert.equal(facts.udid, undefined);
});

test('buildFacts marks a physical android assignment', () => {
  const facts = buildFacts({
    platform: 'android',
    device: { serial: 'R5CT1234', owned: false },
    port: 8084,
    metro: { pid: null, healthy: false, log: null },
    bundleId: null,
    setup: null,
  });
  assert.equal(facts.kind, 'physical');
  assert.equal(facts.serial, 'R5CT1234');
  assert.equal(facts.owned, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/up.test.js`
Expected: FAIL — cannot find module `../src/commands/up.js`.

- [ ] **Step 3: Implement `src/commands/up.js`**

The command action, step by step (all human-readable output to stderr when `--json`; the JSON payload is the only stdout content in that mode):

1. `const root = findProjectRoot(process.cwd())` — error + exit 1 if null.
2. `const settings = resolveSettings({ projectPath: root, gitCommonDir: gitCommonDir(root), repoRoot: repoRoot(root) })`.
3. `ensureOwnedDevice(...)`:
   - Existing record for the platform? If it has `owned: true` or is legacy with a live device, reuse: iOS boot if shut down (`bootIosSim`), Android boot if not running (`bootAndroidEmulator` on its recorded `consolePort`, then `waitForBoot`). A recorded device that no longer exists (deleted sim / removed AVD) is dropped and falls through to creation.
   - No record: create owned. Label = the project's shortcut (`projectShortcut` semantics — reuse the enclosing-worktree-aware helper from `src/project.js`). iOS: `createOwnedIosSim(label, { deviceType: flags.deviceType || settings.ios?.deviceType, runtime: flags.runtime || settings.ios?.runtime })`, then boot. Android: `createOwnedAvd(label, { systemImage: flags.systemImage || settings.android?.systemImage })`, allocate `nextConsolePort` from the console ports in config, boot, `waitForBoot`.
   - Record via `setDevice(root, platform, { ...record, owned: true, deviceName })` (legacy reuse keeps its record untouched).
   - **Legacy reuse never boots:** if the record lacks `owned: true` and the device is shut down, do NOT boot it (ownership rule: we do not boot devices we did not create). Print a stderr note telling the user to boot it themselves or `rn-iso release` to switch the project to an owned device, and continue (Metro and port are still ensured).
4. `const port = await allocatePort(root)`.
5. `await ensureMetro({ projectPath: root, isExpo: detectIsExpo(root), port })` — managed is the only mode.
6. Android emulator: `adbReverse(serial, port)` after boot completes.
7. `const setup = getSetupStatus(root)`.
8. Print: `--json` → `console.log(JSON.stringify(buildFacts(...)))` as the sole stdout write; human mode → a short multi-line summary (stdout is fine in human mode).

`buildFacts` is pure:

```js
export function buildFacts({ platform, device, port, metro, bundleId, setup }) {
  const base = {
    platform,
    owned: Boolean(device.owned),
    metroPort: port,
    metroPid: metro.pid ?? null,
    metroHealthy: Boolean(metro.healthy),
    metroLog: metro.log ?? null,
    bundleId: bundleId ?? null,
    setup: setup ?? null,
  };
  if (platform === 'ios') {
    return { ...base, udid: device.deviceUdid, deviceName: device.deviceName ?? null };
  }
  if (device.avdName) {
    return { ...base, kind: 'emulator', avdName: device.avdName, serial: `emulator-${device.consolePort}` };
  }
  return { ...base, kind: 'physical', serial: device.serial };
}
```

(Adjust key order in the first test to match implementation — `deepEqual` ignores order, keep it simple.)

Register in `bin/cli.js`. Flags: `--json`, `--device-type <name>`, `--runtime <ver>`, `--system-image <pkg>`.

In `src/config.js`, extend the `config` command's `ALLOWED_KEYS` (in `src/commands/config.js`) from `packageManager, ios.script, android.script` to `packageManager, ios.deviceType, ios.runtime, android.systemImage` (the `.script` keys die with the wrappers — Task 4 removes their remaining references). Add a `--repo` flag to `rn-iso config` that reads/writes the repo layer via `setRepoSetting`/`unsetRepoSetting`/`getRepoSettings` keyed by `gitCommonDir(process.cwd())`, accepting the same keys plus `worktreeDir` and `worktree.*`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → PASS.

- [ ] **Step 5: Live smoke — the full broker flow on a scratch Expo-shaped project**

With `RN_ISO_HOME` pointed at a temp dir, in a scratch directory containing a minimal `package.json` (`{"name":"scratch-app","dependencies":{"expo":"*"}}`) and `app.json` (`{"expo":{"ios":{"bundleIdentifier":"com.scratch"}}}`):

```bash
RN_ISO_HOME=$(mktemp -d) node /path/to/rn-iso/bin/cli.js up ios --json
```

Expected: exactly one stdout line of parseable JSON with a real created sim's `udid`, `owned: true`, `deviceName` starting `rn-iso-`, a `metroPort`, and `metroHealthy: true` (Metro will really start — kill it and delete the sim afterwards; report the payload). This is the mandatory live check for the whole pipeline.

- [ ] **Step 6: Commit**

```bash
git add src/commands/up.js src/commands/config.js bin/cli.js test/up.test.js
git commit -m "feat(up): broker command - ensure owned device, port, metro, facts"
```

---

### Task 4: The deletion wave

**Files:**

- Delete: `src/commands/ios.js`, `src/commands/android.js`, `src/commands/reserve.js`, `src/commands/unreserve.js`
- Modify: `bin/cli.js`, `src/sim/ios.js`, `src/sim/android.js`, `src/config.js`, `src/runner.js`, `src/commands/device.js`, `src/commands/status.js` (import fixes only), `src/labels.js` (if it imported removed code)
- Test: delete/trim the tests of removed code across `test/*.test.js`

**Interfaces:**

- Consumes: nothing new. Produces: a smaller surface; everything remaining must still pass.

- [ ] **Step 1: Remove the commands**

Delete the four command files; remove their imports and registrations from `bin/cli.js`. `rn-iso --help` must now show: `device, up, start, stop, logs, prune, status, release, shutdown, config, worktree, gc`.

- [ ] **Step 2: Remove the claims/picker/usage machinery**

- `src/sim/ios.js`: delete `selectIosDevice`, `sortSims`, `deviceFamilyRank` (verify no remaining importer first — `pickDefaultIosCreation` does not use them), `findOccupiedSims` if its only caller was `commands/ios.js`. KEEP `parseOccupyingApps`, `isSimOccupied` (the guard), `parseSimctlList`, listing/boot/shutdown/create/delete, `parseRuntimeVersion`, `formatIosLabel`. Delete the old random-suffix `createIosSim` if Task 1 left it.
- `src/sim/android.js`: delete `selectAndroidDevice`, `sortAndroidCandidates`, `enumerateAndroidCandidates` (verify `up` did not reuse them; `up` reads config records directly). KEEP parse/list/boot/waitForBoot/adbReverse/shutdown/`nextConsolePort`/`getAvdNameForSerial` and the Task 2 additions.
- `src/config.js`: delete `recordSimUsage`, `getSimUsage`. Shrink `allClaimedDevices` to what still has consumers — console ports (for `nextConsolePort`) and physical serials. Rename to `allConsolePortsAndSerials` or keep the name with a comment; pick one and update callers.
- `src/runner.js`: delete `detectScriptCli`, `buildIosCommand`, `buildAndroidCommand`, `getProjectScript`, `buildScriptCommand`, `shQuote`, `buildMetroCommand`, `resolveSimNameByUdid`. KEEP `findLockfile`, `detectPackageManager`.
- `src/commands/config.js`: remove any residual handling of `ios.script` / `android.script`.
- `src/labels.js`: if the interactive label prompt was only reachable from the deleted wrappers, delete the prompt path too (labels are now set by `worktree create` and by basename default at registration).

- [ ] **Step 3: Trim the tests of everything removed**

Delete test cases exercising removed exports (search each removed name across `test/`). Do not delete tests for kept functions.

- [ ] **Step 4: Grep for stragglers**

```bash
grep -rn "selectIosDevice\|selectAndroidDevice\|recordSimUsage\|getSimUsage\|detectScriptCli\|buildIosCommand\|buildAndroidCommand\|managed-metro\|managedMetro\|reserve" src/ bin/ | grep -v "Binary"
```

Expected: no hits (reserve may legitimately appear in comments explaining history — judge each).

- [ ] **Step 5: Run tests, verify help**

Run: `npm test` → PASS (count will DROP — record old and new counts in the commit body).
Run: `node bin/cli.js --help` → the new command list; `node bin/cli.js up --help` works.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete build wrappers, claims machinery, and reserve"
```

---

### Task 5: `release` deletes owned devices

**Files:**

- Modify: `src/commands/release.js`
- Test: `test/release.test.js`

**Interfaces:**

- Consumes: `deleteIosSim`, `isSimOccupied`, `shutdownIosSim` (ios); `deleteAvd`, `shutdownAndroidEmulator` (android); existing `shouldShutdown`.
- Produces: `releaseAction({record, occupied, force})` (pure) returning `{action: 'delete' | 'clear', reason: string | null}`.

- [ ] **Step 1: Write the failing tests**

Add to `test/release.test.js`:

```js
test('owned device is deleted', () => {
  assert.deepEqual(releaseAction({ record: { owned: true }, occupied: false, force: false }), {
    action: 'delete',
    reason: null,
  });
});

test('occupied owned device is cleared, not deleted, without --force', () => {
  const r = releaseAction({ record: { owned: true }, occupied: true, force: false });
  assert.equal(r.action, 'clear');
  assert.match(r.reason, /in use/i);
});

test('--force deletes an occupied owned device', () => {
  assert.equal(releaseAction({ record: { owned: true }, occupied: true, force: true }).action, 'delete');
});

test('legacy and physical assignments are cleared, never deleted', () => {
  assert.equal(releaseAction({ record: { deviceUdid: 'U' }, occupied: false, force: false }).action, 'clear');
  assert.equal(releaseAction({ record: { serial: 'R5', owned: false }, occupied: false, force: true }).action, 'clear');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/release.test.js` → FAIL, `releaseAction` not exported.

- [ ] **Step 3: Implement**

```js
// Owned devices are rn-iso's to destroy; releasing one deletes it. Anything
// rn-iso did not create is only ever unassigned.
export function releaseAction({ record, occupied, force }) {
  if (!record?.owned) return { action: 'clear', reason: null };
  if (occupied && !force) {
    return {
      action: 'clear',
      reason: 'device is in use by another tool; claim cleared, device kept. Pass --force to delete it anyway',
    };
  }
  return { action: 'delete', reason: null };
}
```

Wire into the action: for iOS `action === 'delete'` → `shutdownIosSim(udid)` then `deleteIosSim(udid)`; Android emulator → `shutdownAndroidEmulator(serial)` then `deleteAvd(avdName)`. `clearDevice` runs in every case (as today). Print what happened, including `reason` when set. The old `--shutdown` flag becomes a no-op subset — remove it and its help text; deletion implies shutdown.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/release.js test/release.test.js
git commit -m "feat(release): delete owned devices, clear legacy and physical"
```

---

### Task 6: `worktree remove` reaps devices; `shutdown` honors ownership and occupancy

**Files:**

- Modify: `src/commands/worktree.js`, `src/commands/shutdown.js`, `src/reclaim.js`
- Test: `test/worktree-remove.test.js`, `test/shutdown.test.js`

**Interfaces:**

- Consumes: Task 5's `releaseAction`; `deleteIosSim`/`deleteAvd`; `isSimOccupied`; `shouldShutdown`.
- Produces: `reclaimProject` gains `{deleteOwnedDevices}` and returns `deletedDevices: string[]`.

- [ ] **Step 1: Write the failing tests**

In `test/worktree-remove.test.js`, extend the action-level harness (already present) with: a project entry under the worktree carrying `platforms.ios = { deviceUdid: 'U1', owned: true, deviceName: 'rn-iso-x' }`; assert the mocked executor received `xcrun simctl delete U1` during a successful remove, and did NOT receive it when the entry is legacy (`owned` absent).

In `test/shutdown.test.js`: assert `shutdown` issues `simctl shutdown` only for owned records, and skips an owned record when the occupancy probe reports a foreign `.xctrunner` (mock the `launchctl list` output), reporting the skip.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/worktree-remove.test.js test/shutdown.test.js` → FAIL.

- [ ] **Step 3: Implement**

- `src/reclaim.js`: `reclaimProject(path, { deleteArtifacts, deleteOwnedDevices })`. When `deleteOwnedDevices`, for each platform record with `owned: true`: occupancy-check (iOS), then shutdown+delete via the sim modules; collect names into `deletedDevices`. Legacy/physical records are untouched (claims cleared as today via `removeProject`).
- `src/commands/worktree.js` `registerRemove`: pass `deleteOwnedDevices: true`; print `deletedDevices`. (The nested-key sweep from the prior branch already reclaims monorepo app-dir entries — devices recorded there are covered by the same loop.)
- `src/commands/shutdown.js`: only shut down records with `owned: true`, through `shouldShutdown({occupied, force})`; report skipped-occupied and skipped-legacy distinctly. Remove the dead `deleteArtifacts` default-false plumbing if it obstructs — otherwise leave.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reclaim.js src/commands/worktree.js src/commands/shutdown.js test/worktree-remove.test.js test/shutdown.test.js
git commit -m "feat(reclaim): worktree remove reaps owned devices, shutdown guarded"
```

---

### Task 7: `gc` device sweep and `status` visibility

**Files:**

- Modify: `src/commands/gc.js`, `src/commands/status.js`, `src/artifacts.js` (only if a shared helper fits there)
- Test: `test/gc.test.js`, `test/status.test.js` (create if absent)

**Interfaces:**

- Consumes: `listAllIosSims`, `listAvds`, `loadConfig`, `isOnMountedVolume` (already in `src/artifacts.js` from the prior branch), `deleteIosSim`, `deleteAvd`.
- Produces: `findOrphanedDevices({sims, avds, config, isMounted})` (pure) returning `{orphaned: [{kind, id, name}], kept: [{kind, id, name, reason}]}`.

- [ ] **Step 1: Write the failing tests**

Add to `test/gc.test.js`:

```js
test('findOrphanedDevices proposes only rn-iso devices absent from config', () => {
  const result = findOrphanedDevices({
    sims: [
      { udid: 'U1', name: 'rn-iso-gone' },
      { udid: 'U2', name: 'rn-iso-live' },
      { udid: 'U3', name: 'iPhone 17 Pro' },
    ],
    avds: ['rn-iso-old', 'Pixel_7'],
    config: {
      projects: {
        '/p': {
          platforms: {
            ios: { deviceUdid: 'U2', owned: true },
            android: { avdName: 'rn-iso-kept', owned: true },
          },
        },
      },
    },
    isMounted: () => true,
  });
  assert.deepEqual(result.orphaned.map((o) => o.id).sort(), ['U1', 'rn-iso-old']);
});

test('devices referenced by a project on an unmounted volume are kept', () => {
  const result = findOrphanedDevices({
    sims: [{ udid: 'U1', name: 'rn-iso-ext' }],
    avds: [],
    config: { projects: { '/Volumes/Ext/p': { platforms: { ios: { deviceUdid: 'U1', owned: true } } } } },
    isMounted: () => false,
  });
  assert.equal(result.orphaned.length, 0);
  assert.match(result.kept[0].reason, /not mounted/);
});
```

Note the second test's semantics: when a referencing project's volume is unmounted, the reference COUNTS (device kept) even though the project path does not exist — the same fail-closed rule as the artifact sweep. A device is orphaned only when its name has the `rn-iso-` prefix AND no config entry on any mounted-or-existing project references it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/gc.test.js` → FAIL.

- [ ] **Step 3: Implement**

Pure `findOrphanedDevices` in `src/commands/gc.js` (export it), wired into the `gc` action: report orphaned devices alongside orphaned DerivedData; `--delete` shuts down and deletes them (occupancy-guarded for sims). `status`: for each project, show the platform records with an `(owned)` tag and the setup status line (`setup incomplete: <failed commands>`) via `getSetupStatus`.

- [ ] **Step 4: Run tests, live-check `gc` report mode**

Run: `npm test` → PASS.
Run: `node bin/cli.js gc` (bare) → exits 0, reports, deletes nothing.

- [ ] **Step 5: Commit**

```bash
git add src/commands/gc.js src/commands/status.js test/gc.test.js test/status.test.js
git commit -m "feat(gc,status): orphaned-device sweep and owned/setup visibility"
```

---

### Task 8: Carried test hardening and `--base` validation

**Files:**

- Modify: `src/commands/worktree.js`, `src/worktree.js`
- Test: `test/worktree-create.test.js`, `test/worktree.test.js`

- [ ] **Step 1: stdout-contract action test for `worktree create`**

Using the same stub-command harness as `test/worktree-remove.test.js`: capture `console.log`/`console.error` (swap them for recorders around the action call), run create against a real scratch repo with `--no-install`, assert exactly ONE stdout write equal to the worktree path, on both the success path and a setup-pipeline-failure path (configure `worktree.install` to a failing command), and assert `process.exitCode` is not set to 1 on the pipeline failure.

- [ ] **Step 2: Real-git `unpushedCommits` test**

In `test/worktree.test.js`, with the real executor (`resetExecutor()`): scratch repo + bare remote, one pushed commit, assert `unpushedCommits` is `[]`; add a local-only commit, assert it is reported. This is the guard that a mocked test cannot protect — the naive command form returned empty with unpushed commits present.

- [ ] **Step 3: Validate `--base`**

In `registerCreate`: accept only `fresh` or `head`; anything else errors on stderr, exit 1 (nothing created yet). In `resolveBaseRef`, when `fresh` falls back because `origin/HEAD` is missing, print a stderr warning naming the fallback. Add tests for both.

- [ ] **Step 4: Run tests, commit**

Run: `npm test` → PASS.

```bash
git add src/commands/worktree.js src/worktree.js test/worktree-create.test.js test/worktree.test.js
git commit -m "test(worktree): stdout contract, real-git unpushed guard, base validation"
```

---

### Task 9: Documentation rewrite

**Files:**

- Modify: `skill/SKILL.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: SKILL.md** — full rewrite per the spec's "SKILL.md restructure" section: lifecycle-led (`worktree create` → `up <platform> --json` → run the project's own build → `worktree remove`), the facts contract, the common-setups table (copy it from the spec verbatim as the starting point), Metro rules (managed-only; never start your own; `rn-iso logs` first on a red box), destructive rules (`gc --delete` and `worktree remove --force` require asking; `release` now DELETES the device), the capacity note, and the physical-device exception. Delete every rule that taught wrapper quirks (`--managed-metro`, `--auto` picker behavior, take-over flows, reserve).
- [ ] **Step 2: README.md** — reframe the opening around the environment broker; update the command table (`up`, no `ios`/`android`/`reserve`); document owned devices and the `release` semantics change prominently (breaking); keep the settings-layers and hook sections, correcting the layering claim (now true: every command consumes the chain).
- [ ] **Step 3: CLAUDE.md** — rewrite invariant 2 to the ownership rule with the history note (junk sims were creation without a reaper); delete sections 3b (managed-metro ownership) and 5 (script/CLI detection) as no-longer-applicable, replacing with a short "up is a broker, never a build wrapper" particularity; update the file layout; add the live-verification rule as a standing convention ("any command whose input is a real Xcode/git/Android artifact must be exercised once against the real tool").
- [ ] **Step 4: Version** — bump `package.json` to `0.7.0` (release itself follows RELEASE.md later, out of scope here).
- [ ] **Step 5: Run `npm test`, commit**

```bash
git add skill/SKILL.md README.md CLAUDE.md package.json
git commit -m "docs: rewrite for spawn-and-reap broker model, bump to 0.7.0"
```

---

## Self-review notes

Spec coverage: ownership rule + creation (Tasks 1-3), `up` and settings-everywhere (Task 3), deletions incl. `--managed-metro` and `.script` keys (Task 4), release/remove/shutdown semantics (Tasks 5-6), gc sweep + status (Task 7), carried hardening (Task 8), docs + 0.7.0 (Task 9). Physical-device exception is encoded in `releaseAction` and `buildFacts`. The spec's "What this does NOT change" list maps to zero tasks, as intended.

Type consistency: `releaseAction` returns `{action, reason}` consumed in Tasks 5-6; `buildFacts` payload keys match the spec's JSON example plus `owned`/`deviceName`/`kind`; `reclaimProject`'s new option is named `deleteOwnedDevices` in both Task 6 sites; device records use `deviceUdid`/`avdName`/`consolePort`/`serial` exactly as the existing config schema does.

Known judgment points left to implementers (deliberate): exact human-mode output formatting of `up`; whether `findOccupiedSims` survives Task 4 (depends on remaining callers); AVD `-d` device profile flag omitted (default profile is fine for v1 — record in the Task 2 report if the created AVD boots the emulator successfully).
