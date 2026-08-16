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
