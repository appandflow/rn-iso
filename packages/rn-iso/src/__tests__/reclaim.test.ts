import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { upsertProject, setDevice, getProject } from '../config.ts';
import { describeDereferenced, reclaimProject } from '../reclaim.ts';

let tmpHome: string;

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

  const result = await reclaimProject('/proj', { deleteOwnedDevices: false });
  expect(result.path).toBe('/proj');
  expect(result.dereferenced).toEqual(['ios sim U1']);
  expect(getProject('/proj')).toBe(null);
});

// Build output is workspace-local now, so reclaiming an entry has no external
// artifacts to find or measure: it must not walk a global DerivedData tree
// (one `plutil` per directory) or size anything (one `du` walk per match).
test('reclaimProject scans and sizes no build output at all', async () => {
  const calls: string[] = [];
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
  expect(result.failedDevices[0]?.reason).toMatch(/Unable to delete device/);
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

  const result = await reclaimProject('/nonexistent/project', { deleteOwnedDevices: false });
  expect(result.killedPid).toBe(null);
  expect(result.skippedMetro).toBeTruthy();
  resetExecutor();
});

// --- the remote session ----------------------------------------------------
//
// A remote session bills until its max duration, so `worktree remove` and
// `gc` ending it is not housekeeping -- it is the difference between a clean
// teardown and money spent on nothing.
//
// TIMING is what these pin. The session id lives in the workspace's
// state.json and `eas simulator:stop` needs a project directory, so both are
// gone the moment the caller removes the tree. Ending it has to happen inside
// reclaim, before that.

function workspaceWithSession(sessionId: string): string {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-ws-'));
  mkdirSync(join(root, '.rn-iso'), { recursive: true });
  writeFileSync(join(root, '.rn-iso', 'state.json'), JSON.stringify({ remoteDevice: { platform: 'ios', sessionId } }));
  upsertProject(root, { label: 'agent-1' });
  return root;
}

test('reclaim ends the remote session recorded for the workspace', async () => {
  const root = workspaceWithSession('drs_42');
  const stopped: string[] = [];
  const r = await reclaimProject(root, {
    stopSession: (_root, id) => {
      stopped.push(id);
      return { status: 'torn-down' };
    },
  });
  expect(stopped).toEqual(['drs_42']);
  expect(r.stoppedSession).toBe('drs_42');
  rmSync(root, { recursive: true, force: true });
});

test('the session is ended even without deleteOwnedDevices', async () => {
  // deleteOwnedDevices guards DESTROYING a local sim, which is a real choice
  // because a shut-down sim can be booted again. A session cannot be handed
  // back: the workspace holding its id is going away either way.
  const root = workspaceWithSession('drs_7');
  let called = false;
  await reclaimProject(root, {
    deleteOwnedDevices: false,
    stopSession: () => {
      called = true;
      return { status: 'torn-down' };
    },
  });
  expect(called).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test('a session that could not be stopped keeps the entry and names the manual fix', async () => {
  const root = workspaceWithSession('drs_99');
  const r = await reclaimProject(root, {
    stopSession: () => ({ status: 'failed', reason: 'offline' }),
  });
  expect(r.stoppedSession).toBeNull();
  // keptEntry is what stops `worktree remove` reporting a clean teardown, and
  // what leaves a record naming the session that is still running.
  expect(r.keptEntry).toBe(true);
  expect(getProject(root)).toBeTruthy();
  const reported = r.failedDevices[0]?.reason ?? '';
  expect(reported).toContain('eas simulator:stop --id drs_99');
  expect(reported).toContain('billing');
  rmSync(root, { recursive: true, force: true });
});

test('a throwing stop is contained, so the caller still removes the tree', async () => {
  // A propagated throw would abort reclaim before `git worktree remove` runs,
  // and re-running would hit it forever.
  const root = workspaceWithSession('drs_5');
  const r = await reclaimProject(root, {
    stopSession: () => {
      throw new Error('eas exploded');
    },
  });
  expect(r.stoppedSession).toBeNull();
  expect(r.failedDevices[0]?.reason).toContain('eas exploded');
  rmSync(root, { recursive: true, force: true });
});

test('a workspace with no session never reaches for eas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-ws-'));
  upsertProject(root, { label: 'agent-1' });
  let called = false;
  const r = await reclaimProject(root, {
    stopSession: () => {
      called = true;
      return { status: 'torn-down' };
    },
  });
  expect(called).toBe(false);
  expect(r.stoppedSession).toBeNull();
  rmSync(root, { recursive: true, force: true });
});
