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
  addReservation,
  removeReservation,
  listReservations,
  clearAllReservations,
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
  assert.deepEqual(cfg, { version: 1, projects: {}, reservations: { ios: [], android: [] } });
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

test('addReservation appends an iOS reservation and idempotently updates by UDID', () => {
  addReservation('ios', { udid: 'UDID-X', label: 'agent-1' });
  addReservation('ios', { udid: 'UDID-Y' });
  let r = listReservations();
  assert.equal(r.ios.length, 2);
  // Re-add with same UDID -> updated, not duplicated
  addReservation('ios', { udid: 'UDID-X', label: 'agent-1-renamed' });
  r = listReservations();
  assert.equal(r.ios.length, 2);
  assert.equal(r.ios.find(e => e.udid === 'UDID-X').label, 'agent-1-renamed');
});

test('addReservation works for android keyed by serial', () => {
  addReservation('android', { serial: 'emulator-5554', consolePort: 5554, avdName: 'Pixel_6' });
  const r = listReservations();
  assert.equal(r.android.length, 1);
  assert.equal(r.android[0].avdName, 'Pixel_6');
});

test('removeReservation drops the matching entry', () => {
  addReservation('ios', { udid: 'UDID-1' });
  addReservation('ios', { udid: 'UDID-2' });
  const removed = removeReservation('ios', 'UDID-1');
  assert.equal(removed, true);
  assert.deepEqual(listReservations().ios.map(e => e.udid), ['UDID-2']);
});

test('allClaimedDevices includes reservations alongside project assignments', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice('/p', 'ios', { deviceUdid: 'UDID-PROJECT' });
  addReservation('ios', { udid: 'UDID-EXTERNAL', label: 'agent-1' });
  addReservation('android', { serial: 'emulator-5554', consolePort: 5554, avdName: 'Pixel_6' });
  const claimed = allClaimedDevices();
  assert.deepEqual(claimed.iosUdids.sort(), ['UDID-EXTERNAL', 'UDID-PROJECT']);
  assert.deepEqual(claimed.androidAvds, ['Pixel_6']);
  assert.deepEqual(claimed.androidConsolePorts, [5554]);
});

test('clearAllReservations empties both platforms', () => {
  addReservation('ios', { udid: 'UDID-1' });
  addReservation('android', { serial: 'emulator-5554', consolePort: 5554 });
  clearAllReservations();
  const r = listReservations();
  assert.deepEqual(r, { ios: [], android: [] });
});
