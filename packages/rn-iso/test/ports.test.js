import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetExecutor } from '../src/exec.js';
import { upsertProject, setMetro, saveConfig } from '../src/config.js';
import { computeNextPort, findReclaimablePort, allocatePort, isPortFree } from '../src/ports.js';

// Every allocation test injects a deterministic freeness oracle: the real one
// binds sockets, so leaving it in would make results depend on whatever else
// this machine happens to be running.
const allFree = async () => true;

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

test('computeNextPort returns 8082 with no existing ports', async () => {
  assert.equal(await computeNextPort(allFree), 8082);
});

test('computeNextPort skips registry-claimed ports', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  setMetro('/a', 8082);
  setMetro('/b', 8083);
  assert.equal(await computeNextPort(allFree), 8084);
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
  const port = await allocatePort('/new', probe, allFree);
  assert.equal(port, 8082);
  // Caller should have removed /a -- verify via behavior
  const { getProject } = await import('../src/config.js');
  assert.equal(getProject('/a'), null);
});

test('findReclaimablePort does not reclaim live-path projects even with dead Metro', async () => {
  const liveDir = join(tmpHome, 'live-project');
  mkdirSync(liveDir, { recursive: true });
  upsertProject(liveDir, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setMetro(liveDir, 8082, null);
  // Metro is dead, but the project directory exists: its entry (and device
  // claim) must survive.
  const r = await findReclaimablePort('/new', async () => false);
  assert.equal(r, null);
});

test('allocatePort assigns a fresh port when nothing is reclaimable', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setMetro('/a', 8082, null);
  const probe = async () => true; // everything alive
  const port = await allocatePort('/new', probe, allFree);
  assert.equal(port, 8083);
});

// Reported from the field: three projects were each handed 8107. computeNextPort
// was max(registry)+1 with NO liveness check, so a port held by anything not in
// rn-iso's registry was invisible. The trap for the fix: isMetroRunning() only
// answers for Metro, so a web server on the port would still look free -- the
// check has to be a real bind.
test('computeNextPort skips a port that is occupied by a foreign process', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  const occupied = new Set([8082, 8083]);
  const port = await computeNextPort(async (p) => !occupied.has(p));
  assert.equal(port, 8084);
});

test('computeNextPort skips ports already in the registry AND occupied ports', async () => {
  saveConfig({
    version: 2,
    projects: { '/a': { metroPort: 8082 }, '/b': { metroPort: 8084 } },
    repos: {},
  });
  const occupied = new Set([8083]);
  const port = await computeNextPort(async (p) => !occupied.has(p));
  assert.equal(port, 8085, 'registry holds 8082/8084, a foreign process holds 8083');
});

test('computeNextPort reuses a gap left by a released project when it is genuinely free', async () => {
  saveConfig({ version: 2, projects: { '/a': { metroPort: 8083 } }, repos: {} });
  const port = await computeNextPort(async () => true);
  assert.equal(port, 8082, 'a free lower port is reused rather than always climbing');
});

test('computeNextPort throws rather than returning an occupied port when the range is exhausted', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  await assert.rejects(() => computeNextPort(async () => false), /no free Metro port/i);
});

// Cross-PROCESS on purpose. An in-process bind test passes even when the
// implementation is wrong: Node sets SO_REUSEADDR, so binding 0.0.0.0 while a
// separate process holds 127.0.0.1 succeeds and the port reads free. That
// exact bug shipped and was caught only by a live squatter, not by the
// same-process test that preceded this one.
test('isPortFree detects a listener held by ANOTHER process', async () => {
  const { spawn } = await import('node:child_process');
  const { isPortFree } = await import('../src/ports.js');
  const port = 8131;
  const child = spawn(process.execPath, ['-e',
    `require('http').createServer((q,r)=>r.end('x')).listen(${port},'127.0.0.1')`,
  ], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) {
      if (!(await isPortFree(port))) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(await isPortFree(port), false, 'a port held by another process must not read as free');
    assert.equal(await isPortFree(8132), true, 'an unused port must read as free');
  } finally {
    child.kill('SIGKILL');
  }
});

// A reclaimable port belongs to a dead project, but something unrelated may
// have taken it since the project died -- it must pass the same bind check.
test('allocatePort does not reuse a reclaimable port that is now occupied', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setMetro('/a', 8082);
  const deadMetro = async () => false;      // /a's Metro is gone
  const isFree = async (p) => p !== 8082;   // ...but 8082 is held by something else
  const port = await allocatePort('/new', deadMetro, isFree);
  assert.notEqual(port, 8082);
  assert.equal(port, 8083);
});
