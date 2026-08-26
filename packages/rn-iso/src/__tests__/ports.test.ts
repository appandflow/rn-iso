import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetExecutor } from '../exec.ts';
import { upsertProject, setDevice, saveConfig, getProject, claimMetroPort } from '../config.ts';
import { computeNextPort, findReclaimablePort, allocatePort, reserveMetroPort, isPortFree } from '../ports.ts';

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
  expect(await computeNextPort(allFree)).toBe(8082);
});

test('computeNextPort skips registry-claimed ports', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  claimMetroPort('/a', 8082);
  claimMetroPort('/b', 8083);
  expect(await computeNextPort(allFree)).toBe(8084);
});

test('findReclaimablePort returns null when no projects', async () => {
  const r = await findReclaimablePort('/excluded');
  expect(r).toBe(null);
});

test('findReclaimablePort skips the excluded project path', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  // Mock isMetroRunning to always return false (port is dead)
  const r = await findReclaimablePort('/a', async () => false);
  expect(r).toBe(null);
});

test('findReclaimablePort returns first dead port and its owner', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  claimMetroPort('/a', 8082);
  claimMetroPort('/b', 8083);
  // 8082 alive, 8083 dead
  const probe = async (port) => port === 8082;
  const r = await findReclaimablePort('/c', probe);
  expect(r).toEqual({ port: 8083, ownerPath: '/b' });
});

test('allocatePort reclaims dead ports and removes the dead project', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  const probe = async () => false;
  const port = await allocatePort('/new', probe, allFree);
  expect(port).toBe(8082);
  // Caller should have removed /a -- verify via behavior
  const { getProject } = await import('../config.ts');
  expect(getProject('/a')).toBe(null);
});

test('findReclaimablePort does not reclaim live-path projects even with dead Metro', async () => {
  const liveDir = join(tmpHome, 'live-project');
  mkdirSync(liveDir, { recursive: true });
  upsertProject(liveDir, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort(liveDir, 8082);
  // Metro is dead, but the project directory exists: its entry (and device
  // claim) must survive.
  const r = await findReclaimablePort('/new', async () => false);
  expect(r).toBe(null);
});

test('allocatePort assigns a fresh port when nothing is reclaimable', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  const probe = async () => true; // everything alive
  const port = await allocatePort('/new', probe, allFree);
  expect(port).toBe(8083);
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
  expect(port).toBe(8084);
});

test('computeNextPort skips ports already in the registry AND occupied ports', async () => {
  saveConfig({
    version: 2,
    projects: { '/a': { metroPort: 8082 }, '/b': { metroPort: 8084 } },
    repos: {},
  });
  const occupied = new Set([8083]);
  const port = await computeNextPort(async (p) => !occupied.has(p));
  expect(port).toBe(8085);
});

test('computeNextPort reuses a gap left by a released project when it is genuinely free', async () => {
  saveConfig({ version: 2, projects: { '/a': { metroPort: 8083 } }, repos: {} });
  const port = await computeNextPort(async () => true);
  expect(port).toBe(8082);
});

test('computeNextPort throws rather than returning an occupied port when the range is exhausted', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  await expect(() => computeNextPort(async () => false)).rejects.toThrow(/no free Metro port/i);
});

// Cross-PROCESS on purpose. An in-process bind test passes even when the
// implementation is wrong: Node sets SO_REUSEADDR, so binding 0.0.0.0 while a
// separate process holds 127.0.0.1 succeeds and the port reads free. That
// exact bug shipped and was caught only by a live squatter, not by the
// same-process test that preceded this one.
test('isPortFree detects a listener held by ANOTHER process', async () => {
  const { spawn } = await import('node:child_process');
  const { isPortFree } = await import('../ports.ts');
  const port = 8131;
  const child = spawn(
    process.execPath,
    ['-e', `require('http').createServer((q,r)=>r.end('x')).listen(${port},'127.0.0.1')`],
    { stdio: 'ignore' },
  );
  try {
    for (let i = 0; i < 40; i++) {
      if (!(await isPortFree(port))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await isPortFree(port)).toBe(false);
    expect(await isPortFree(8132)).toBe(true);
  } finally {
    child.kill('SIGKILL');
  }
});

// An unplugged external volume makes a live project's path look gone.
// Reclaiming its port removes the whole entry -- label, port, owned-device
// record -- after which gc's orphan sweep would delete the sims it owned. The
// mounted-volume guard is what stops that, the same way gc's dead-entry
// sweep uses it.
test('findReclaimablePort skips a project whose volume is not mounted', async () => {
  const unmounted = '/Volumes/NotPluggedIn/worktree';
  upsertProject(unmounted, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort(unmounted, 8082);
  const r = await findReclaimablePort('/new', async () => false, { isMounted: () => false });
  expect(r).toBe(null);
});

test('findReclaimablePort still reclaims a dead project on a mounted volume', async () => {
  upsertProject('/definitely/gone', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/definitely/gone', 8082);
  const r = await findReclaimablePort('/new', async () => false, { isMounted: () => true });
  expect(r).toEqual({ port: 8082, ownerPath: '/definitely/gone' });
});

// allocatePort removes the reclaimed project's entry, so a fail-open guard
// here deletes a live project's device record on an unplugged volume.
test('allocatePort does not delete the entry of a project on an unmounted volume', async () => {
  const unmounted = '/Volumes/NotPluggedIn/worktree';
  upsertProject(unmounted, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setDevice(unmounted, 'ios', { deviceUdid: 'U1', owned: true });
  claimMetroPort(unmounted, 8082);
  const port = await allocatePort('/new', async () => false, allFree);
  expect(port).not.toBe(8082);
  expect(getProject(unmounted)).toBeTruthy();
});

// Two `up` runs can probe the same free port before either records it. The
// loser must allocate again rather than record a port that is already taken.
test('reserveMetroPort moves on when another project claims the port first', async () => {
  // Real directories: an entry whose path is gone is reclaimable, which would
  // hand the same port back instead of exercising the claim conflict.
  const dirA = join(tmpHome, 'a');
  const dirB = join(tmpHome, 'b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  upsertProject(dirA, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject(dirB, { bundleId: 'b', androidPackage: 'b', isExpo: false });
  let probes = 0;
  const isFree = async () => {
    // The first allocation for B sees 8082 as free; by the time it tries to
    // record it, A has claimed it.
    if (probes++ === 0) claimMetroPort(dirA, 8082);
    return true;
  };
  const port = await reserveMetroPort(dirB, async () => false, isFree);
  expect(port).toBe(8083);
  expect(getProject(dirB).metroPort).toBe(8083);
  expect(getProject(dirA).metroPort).toBe(8082);
});

test('reserveMetroPort records the port it hands back', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const port = await reserveMetroPort('/a', async () => false, allFree);
  expect(port).toBe(8082);
  expect(getProject('/a').metroPort).toBe(8082);
});

// A reclaimable port belongs to a dead project, but something unrelated may
// have taken it since the project died -- it must pass the same bind check.
test('allocatePort does not reuse a reclaimable port that is now occupied', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  const deadMetro = async () => false; // /a's Metro is gone
  const isFree = async (p) => p !== 8082; // ...but 8082 is held by something else
  const port = await allocatePort('/new', deadMetro, isFree);
  expect(port).not.toBe(8082);
  expect(port).toBe(8083);
});
