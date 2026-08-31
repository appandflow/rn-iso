import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetExecutor } from '../exec.ts';
import { upsertProject, setDevice, saveConfig, getProject, claimMetroPort } from '../config.ts';
import { computeNextPort, findReclaimablePort, allocatePort, reserveMetroPort } from '../ports.ts';

const allFree = async () => true;

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
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
  const r = await findReclaimablePort('/a', async () => false);
  expect(r).toBe(null);
});

test('findReclaimablePort returns first dead port and its owner', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  claimMetroPort('/a', 8082);
  claimMetroPort('/b', 8083);
  const probe = async (port: number) => port === 8082;
  const r = await findReclaimablePort('/c', probe);
  expect(r).toEqual({ port: 8083, ownerPath: '/b' });
});

test('allocatePort reclaims dead ports and removes the dead project', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  const probe = async () => false;
  const port = await allocatePort('/new', probe, allFree);
  expect(port).toBe(8082);
  expect(getProject('/a')).toBe(null);
});

test('findReclaimablePort does not reclaim live-path projects even with dead Metro', async () => {
  const liveDir = join(tmpHome, 'live-project');
  mkdirSync(liveDir, { recursive: true });
  upsertProject(liveDir, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort(liveDir, 8082);
  const r = await findReclaimablePort('/new', async () => false);
  expect(r).toBe(null);
});

test('allocatePort assigns a fresh port when nothing is reclaimable', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  const probe = async () => true;
  const port = await allocatePort('/new', probe, allFree);
  expect(port).toBe(8083);
});

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

test('allocatePort does not delete the entry of a project on an unmounted volume', async () => {
  const unmounted = '/Volumes/NotPluggedIn/worktree';
  upsertProject(unmounted, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setDevice(unmounted, 'ios', { deviceUdid: 'U1', owned: true });
  claimMetroPort(unmounted, 8082);
  const port = await allocatePort('/new', async () => false, allFree);
  expect(port).not.toBe(8082);
  expect(getProject(unmounted)).toBeTruthy();
});

test('reserveMetroPort moves on when another project claims the port first', async () => {
  const dirA = join(tmpHome, 'a');
  const dirB = join(tmpHome, 'b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  upsertProject(dirA, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject(dirB, { bundleId: 'b', androidPackage: 'b', isExpo: false });
  let probes = 0;
  const isFree = async () => {
    if (probes++ === 0) claimMetroPort(dirA, 8082);
    return true;
  };
  const port = await reserveMetroPort(dirB, async () => false, isFree);
  expect(port).toBe(8083);
  const recB = getProject(dirB);
  const recA = getProject(dirA);
  assert(recB);
  assert(recA);
  expect(recB.metroPort).toBe(8083);
  expect(recA.metroPort).toBe(8082);
});

test('reserveMetroPort records the port it hands back', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const port = await reserveMetroPort('/a', async () => false, allFree);
  expect(port).toBe(8082);
  const rec = getProject('/a');
  assert(rec);
  expect(rec.metroPort).toBe(8082);
});

test('allocatePort does not reuse a reclaimable port that is now occupied', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  const deadMetro = async () => false;
  const isFree = async (p: number) => p !== 8082;
  const port = await allocatePort('/new', deadMetro, isFree);
  expect(port).not.toBe(8082);
  expect(port).toBe(8083);
});
