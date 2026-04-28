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
  recordSimUsage,
  getSimUsage,
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
  upsertProject('/Users/janic/Developer/myapp', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: true });
  setDevice('/Users/janic/Developer/myapp', 'ios', { deviceUdid: 'UDID-PROJ' });
  const claimed = allClaimedDevices();
  assert.deepEqual(claimed.iosClaims['UDID-PROJ'], {
    label: 'myapp',
    path: '/Users/janic/Developer/myapp',
  });
});

test('allClaimedDevices.androidClaims maps console port to owning project', () => {
  upsertProject('/Users/janic/Developer/myapp', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice('/Users/janic/Developer/myapp', 'android', { avdName: 'Pixel_6', consolePort: 5554 });
  const claimed = allClaimedDevices();
  assert.deepEqual(claimed.androidClaims[5554], {
    label: 'myapp',
    path: '/Users/janic/Developer/myapp',
    avdName: 'Pixel_6',
  });
});
