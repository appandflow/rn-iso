import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { upsertProject, setDevice, getProject } from '../src/config.js';
import { describeDereferenced } from '../src/reclaim.js';

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

test('describeDereferenced lists ios and android device records', () => {
  const devices = describeDereferenced({
    platforms: { ios: { deviceUdid: 'U1' }, android: { avdName: 'Pixel_6' } },
  });
  assert.deepEqual(devices, ['ios sim U1', 'android avd Pixel_6']);
});

test('describeDereferenced reports a physical android device when there is no avd', () => {
  assert.deepEqual(describeDereferenced({ platforms: { android: { serial: 'R5CT' } } }), [
    'android device R5CT',
  ]);
});

test('describeDereferenced returns an empty list when nothing is claimed', () => {
  assert.deepEqual(describeDereferenced({ platforms: {} }), []);
  assert.deepEqual(describeDereferenced({}), []);
});

test('reclaimProject removes the config entry', async () => {
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  const { reclaimProject } = await import('../src/reclaim.js');
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1' });

  const result = await reclaimProject('/proj', { deleteArtifacts: false });
  assert.equal(result.path, '/proj');
  assert.deepEqual(result.dereferenced, ['ios sim U1']);
  assert.equal(getProject('/proj'), null);
});

// The DerivedData scan shells one `plutil` per directory and one `du` walk per
// match. A caller that never reads the sizes must not pay for them.
test('reclaimProject does not scan or size artifacts unless the caller asks', async () => {
  const calls = [];
  setExecutor({
    run: (cmd) => { calls.push(cmd); return ''; },
    runQuiet: (cmd) => { calls.push(cmd); return null; },
    spawn: () => {},
  });
  const { reclaimProject } = await import('../src/reclaim.js');
  upsertProject('/proj', { metroPort: 8082 });

  const result = await reclaimProject('/proj', { deleteArtifacts: false });
  assert.deepEqual(result.artifacts, []);
  assert.equal(calls.some(c => c.startsWith('du -sk')), false, 'no du walk when nothing reads the sizes');
  assert.equal(calls.some(c => c.startsWith('plutil')), false, 'no plutil scan when nothing reads the list');
});

test("reclaimProject lists artifact dirs without measuring them in 'list' mode", async () => {
  const calls = [];
  setExecutor({
    run: (cmd) => { calls.push(cmd); return ''; },
    runQuiet: (cmd) => { calls.push(cmd); return null; },
    spawn: () => {},
  });
  const { reclaimProject } = await import('../src/reclaim.js');
  upsertProject('/proj', { metroPort: 8082 });

  await reclaimProject('/proj', { deleteArtifacts: false, artifacts: 'list' });
  assert.equal(calls.some(c => c.startsWith('du -sk')), false, "'list' must not shell a du walk");
});

// A device whose delete FAILED is still on the machine. Dropping the entry
// that names it is what turns a failed teardown into a leaked simulator.
test('reclaimProject keeps the config entry when an owned device delete fails', async () => {
  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
        { udid: 'U1', name: 'rn-iso-proj', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  setExecutor({
    run: (cmd) => {
      if (cmd.includes('simctl list devices --json')) return listJson;
      if (cmd.includes('simctl delete')) throw new Error('Unable to delete device');
      return '';
    },
    runQuiet: (cmd) => (cmd.includes('simctl list devices --json') ? listJson : null),
    spawn: () => {},
  });
  const { reclaimProject } = await import('../src/reclaim.js');
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1', owned: true });

  const result = await reclaimProject('/proj', { deleteOwnedDevices: true });
  assert.equal(result.keptEntry, true);
  assert.equal(result.deletedDevices.length, 0);
  assert.match(result.failedDevices[0].reason, /Unable to delete device/);
  assert.ok(getProject('/proj'), 'the entry naming the undeleted sim must survive');
});

test('reclaimProject removes the entry when the owned device really is deleted', async () => {
  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
        { udid: 'U1', name: 'rn-iso-proj', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  setExecutor({
    run: (cmd) => (cmd.includes('simctl list devices --json') ? listJson : ''),
    runQuiet: (cmd) => (cmd.includes('simctl list devices --json') ? listJson : null),
    spawn: () => {},
  });
  const { reclaimProject } = await import('../src/reclaim.js');
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1', owned: true });

  const result = await reclaimProject('/proj', { deleteOwnedDevices: true });
  assert.equal(result.keptEntry, false);
  assert.deepEqual(result.deletedDevices, ['U1']);
  assert.equal(getProject('/proj'), null);
});

test('reclaimProject refuses to kill an unidentified process on the port', async () => {
  // A stale record plus a foreign listener must NOT be killed: this is the
  // Metro analogue of the Android console-port Critical from the 0.7.0 review.
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => (cmd.includes('-sTCP:LISTEN') ? '4242' : ''),
    spawn: () => {},
  });
  const { reclaimProject } = await import('../src/reclaim.js');
  upsertProject('/nonexistent/project', { metroPort: 8082 });

  const result = await reclaimProject('/nonexistent/project', { deleteArtifacts: false });
  assert.equal(result.killedPid, null);
  assert.ok(result.skippedMetro, 'must report why it declined');
  resetExecutor();
});
