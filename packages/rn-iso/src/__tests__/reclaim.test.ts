import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { upsertProject, setDevice, getProject } from '../config.ts';
import { describeDereferenced } from '../reclaim.ts';

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
  expect(devices).toEqual(['ios sim U1', 'android avd Pixel_6']);
});

test('describeDereferenced reports a physical android device when there is no avd', () => {
  expect(describeDereferenced({ platforms: { android: { serial: 'R5CT' } } })).toEqual(['android device R5CT']);
});

test('describeDereferenced returns an empty list when nothing is claimed', () => {
  expect(describeDereferenced({ platforms: {} })).toEqual([]);
  expect(describeDereferenced({})).toEqual([]);
});

test('reclaimProject removes the config entry', async () => {
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  const { reclaimProject } = await import('../reclaim.ts');
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1' });

  const result = await reclaimProject('/proj', { deleteArtifacts: false });
  expect(result.path).toBe('/proj');
  expect(result.dereferenced).toEqual(['ios sim U1']);
  expect(getProject('/proj')).toBe(null);
});

// Build output is workspace-local now, so reclaiming an entry has no external
// artifacts to find or measure: it must not walk a global DerivedData tree
// (one `plutil` per directory) or size anything (one `du` walk per match).
test('reclaimProject scans and sizes no build output at all', async () => {
  const calls = [];
  setExecutor({
    run: (cmd) => {
      calls.push(cmd);
      return '';
    },
    runQuiet: (cmd) => {
      calls.push(cmd);
      return null;
    },
    spawn: () => {},
  });
  const { reclaimProject } = await import('../reclaim.ts');
  upsertProject('/proj', { metroPort: 8082 });

  await reclaimProject('/proj');
  expect(calls.some((c) => c.startsWith('du -sk'))).toBe(false);
  expect(calls.some((c) => c.startsWith('plutil'))).toBe(false);
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
  const { reclaimProject } = await import('../reclaim.ts');
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1', owned: true });

  const result = await reclaimProject('/proj', { deleteOwnedDevices: true });
  expect(result.keptEntry).toBe(true);
  expect(result.deletedDevices.length).toBe(0);
  expect(result.failedDevices[0].reason).toMatch(/Unable to delete device/);
  expect(getProject('/proj')).toBeTruthy();
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
  const { reclaimProject } = await import('../reclaim.ts');
  upsertProject('/proj', { metroPort: 8082 });
  setDevice('/proj', 'ios', { deviceUdid: 'U1', owned: true });

  const result = await reclaimProject('/proj', { deleteOwnedDevices: true });
  expect(result.keptEntry).toBe(false);
  expect(result.deletedDevices).toEqual(['U1']);
  expect(getProject('/proj')).toBe(null);
});

test('reclaimProject refuses to kill an unidentified process on the port', async () => {
  // A stale record plus a foreign listener must NOT be killed: this is the
  // Metro analogue of the Android console-port Critical from the 0.7.0 review.
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => (cmd.includes('-sTCP:LISTEN') ? '4242' : ''),
    spawn: () => {},
  });
  const { reclaimProject } = await import('../reclaim.ts');
  upsertProject('/nonexistent/project', { metroPort: 8082 });

  const result = await reclaimProject('/nonexistent/project', { deleteArtifacts: false });
  expect(result.killedPid).toBe(null);
  expect(result.skippedMetro).toBeTruthy();
  resetExecutor();
});
