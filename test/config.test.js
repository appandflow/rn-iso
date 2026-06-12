import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
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
  recordSimUsage,
  getSimUsage,
  getProjectSettings,
  getProjectSetting,
  setProjectSetting,
  unsetProjectSetting,
  pruneDeadProjects,
} from '../src/config.js';

let tmpHome;

// Claims from nonexistent paths are filtered, so tests that want a claim to
// be visible must register a directory that actually exists.
function liveProjectDir(name) {
  const dir = join(tmpHome, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
  const a = liveProjectDir('a');
  const b = liveProjectDir('b');
  upsertProject(a, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  upsertProject(b, { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  setDevice(a, 'ios', { deviceUdid: 'UDID-1' });
  setDevice(b, 'android', { avdName: 'Pixel_6', consolePort: 5554 });
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

test('recordSimUsage increments and getSimUsage reads counts', () => {
  recordSimUsage('ios', 'UDID-A');
  recordSimUsage('ios', 'UDID-A');
  recordSimUsage('ios', 'UDID-B');
  recordSimUsage('android', 'Pixel_6');
  const usage = getSimUsage();
  assert.equal(usage.ios['UDID-A'], 2);
  assert.equal(usage.ios['UDID-B'], 1);
  assert.equal(usage.android['Pixel_6'], 1);
});

test('allClaimedDevices.iosClaims maps udid to owning project label/path', () => {
  const myapp = liveProjectDir('myapp');
  upsertProject(myapp, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: true });
  setDevice(myapp, 'ios', { deviceUdid: 'UDID-PROJ' });
  const claimed = allClaimedDevices();
  assert.deepEqual(claimed.iosClaims['UDID-PROJ'], {
    label: 'myapp',
    path: myapp,
  });
});

test('allClaimedDevices ignores claims from project paths that no longer exist', () => {
  const live = liveProjectDir('live');
  upsertProject(live, { bundleId: 'com.live', androidPackage: 'com.live', isExpo: false });
  setDevice(live, 'ios', { deviceUdid: 'UDID-LIVE' });
  upsertProject('/definitely/gone/worktree', { bundleId: 'com.dead', androidPackage: 'com.dead', isExpo: false });
  setDevice('/definitely/gone/worktree', 'ios', { deviceUdid: 'UDID-DEAD' });
  const claimed = allClaimedDevices();
  assert.deepEqual(claimed.iosUdids, ['UDID-LIVE']);
  assert.equal(claimed.iosClaims['UDID-DEAD'], undefined);
});

test('pruneDeadProjects removes dead-path entries and keeps live ones', () => {
  const live = liveProjectDir('live');
  upsertProject(live, { bundleId: 'com.live', androidPackage: 'com.live', isExpo: false });
  upsertProject('/definitely/gone/worktree', { bundleId: 'com.dead', androidPackage: 'com.dead', isExpo: false });
  setMetro('/definitely/gone/worktree', 8099, null);
  const removed = pruneDeadProjects();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].path, '/definitely/gone/worktree');
  assert.equal(removed[0].project.metroPort, 8099);
  assert.equal(getProject('/definitely/gone/worktree'), null);
  assert.notEqual(getProject(live), null);
});

test('pruneDeadProjects returns empty list when nothing is dead', () => {
  const live = liveProjectDir('live');
  upsertProject(live, { bundleId: 'com.live', androidPackage: 'com.live', isExpo: false });
  assert.deepEqual(pruneDeadProjects(), []);
  assert.notEqual(getProject(live), null);
});

test('allClaimedDevices.androidClaims maps console port to owning project', () => {
  const myapp = liveProjectDir('myapp');
  upsertProject(myapp, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice(myapp, 'android', { avdName: 'Pixel_6', consolePort: 5554 });
  const claimed = allClaimedDevices();
  assert.deepEqual(claimed.androidClaims[5554], {
    label: 'myapp',
    path: myapp,
    avdName: 'Pixel_6',
  });
});

test('allClaimedDevices.androidClaimsByAvd maps avdName to owning project', () => {
  const myapp = liveProjectDir('myapp');
  upsertProject(myapp, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice(myapp, 'android', { avdName: 'Pixel_6', consolePort: 5554 });
  const claimed = allClaimedDevices();
  assert.deepEqual(claimed.androidClaimsByAvd['Pixel_6'], {
    label: 'myapp',
    path: myapp,
    consolePort: 5554,
  });
});

// --- Per-project settings ---

test('setProjectSetting writes a top-level key', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'packageManager', 'bun');
  assert.equal(getProjectSetting('/p', 'packageManager'), 'bun');
  assert.deepEqual(getProjectSettings('/p'), { packageManager: 'bun' });
});

test('setProjectSetting writes a dotted key, creating intermediate objects', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.script', 'dev:ios');
  setProjectSetting('/p', 'android.script', 'dev:android');
  assert.deepEqual(getProjectSettings('/p'), {
    ios: { script: 'dev:ios' },
    android: { script: 'dev:android' },
  });
  assert.equal(getProjectSetting('/p', 'ios.script'), 'dev:ios');
});

test('setProjectSetting overwrites an existing key', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'packageManager', 'bun');
  setProjectSetting('/p', 'packageManager', 'pnpm');
  assert.equal(getProjectSetting('/p', 'packageManager'), 'pnpm');
});

test('unsetProjectSetting removes a key and reports whether it existed', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.script', 'dev:ios');
  assert.equal(unsetProjectSetting('/p', 'ios.script'), true);
  assert.equal(getProjectSetting('/p', 'ios.script'), undefined);
  assert.equal(unsetProjectSetting('/p', 'ios.script'), false);
});

test('getProjectSetting returns undefined for unknown projects / keys', () => {
  assert.equal(getProjectSetting('/missing', 'packageManager'), undefined);
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  assert.equal(getProjectSetting('/p', 'packageManager'), undefined);
});

test('setProjectSetting throws when the project is not registered', () => {
  assert.throws(() => setProjectSetting('/missing', 'packageManager', 'bun'), /not registered/);
});
