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
  // Caller should have removed /a -- verify via behavior
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
