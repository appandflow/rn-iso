import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  DEFAULT_LEASE_MS,
  deviceLeaseLockPath,
  deviceLeasePath,
  deviceLocksDir,
  listLeaseFiles,
  parseLease,
  parseLeaseDuration,
  raiseLease,
  releaseRunLease,
  releaseWorkspaceLeases,
  removeExpiredLease,
  selectPoolDevice,
  takeLease,
  type DeviceLease,
  type LeaseIo,
  type WorkspaceLeases,
} from '../engine/device-lease.ts';
import { writeWorkspaceState } from '../supervisor/state.ts';

const ROOT_A = '/worktree/a';
const ROOT_B = '/worktree/b';
const UDID = '00008101-000A10913C89001E';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-home-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

interface Harness {
  io: LeaseIo;
  files: Map<string, string>;
  holders: Map<string, WorkspaceLeases>;
  locks: string[];
  advance: (ms: number) => void;
  read: (platform: string, id: string) => DeviceLease | null;
}

function harness(start = Date.parse('2026-09-02T12:00:00.000Z')): Harness {
  const files = new Map<string, string>();
  const holders = new Map<string, WorkspaceLeases>();
  const locks: string[] = [];
  let clock = start;
  const io: LeaseIo = {
    now: () => clock,
    readLease: (path) => files.get(path) ?? null,
    writeLease: (path, body) => {
      files.set(path, body);
    },
    removeLease: (path) => {
      files.delete(path);
    },
    listLeaseNames: () => [...files.keys()].map((path) => basename(path)),
    withLeaseLock: (lockPath, fn) => {
      locks.push(lockPath);
      return fn();
    },
    readHolder: (root) => structuredClone(holders.get(root) ?? {}),
    writeHolder: (root, leases) => {
      holders.set(root, structuredClone(leases));
    },
  };
  return {
    io,
    files,
    holders,
    locks,
    advance: (ms) => {
      clock += ms;
    },
    read: (platform, id) => parseLease(files.get(deviceLeasePath(platform, id)) ?? null),
  };
}

describe('where a lease lives', () => {
  test('is a file under the config dir, named by platform and sanitized id', () => {
    expect(deviceLocksDir()).toBe(join(home, 'device-locks'));
    expect(deviceLeasePath('ios', UDID)).toBe(join(home, 'device-locks', `ios-${UDID}.json`));
  });

  test("an adb TCP serial's colon cannot escape the lease directory", () => {
    const path = deviceLeasePath('android', '192.168.1.5:5555');
    expect(path).toBe(join(home, 'device-locks', 'android-192.168.1.5-5555.json'));
    const escaped = deviceLeasePath('android', '../../etc/passwd');
    expect(dirname(escaped)).toBe(join(home, 'device-locks'));
    expect(basename(escaped).includes('/')).toBe(false);
  });

  test('the lock shares the stem with the lease it guards', () => {
    expect(deviceLeaseLockPath('ios', UDID)).toBe(join(home, 'device-locks', `ios-${UDID}.lock`));
  });
});

describe('taking a lease', () => {
  test('a free device is taken, recorded in the file and in the workspace state', () => {
    const h = harness();
    const result = takeLease(
      { root: ROOT_A, platform: 'ios', id: UDID, deviceName: 'Old iPhone', kind: 'declared' },
      h.io,
    );
    assert(result.status === 'taken');
    expect(result.lease.holder).toBe(ROOT_A);
    expect(result.lease.deviceName).toBe('Old iPhone');
    expect(result.lease.expiresAt).toBe(
      new Date(Date.parse(result.lease.grantedAt as string) + DEFAULT_LEASE_MS).toISOString(),
    );
    expect(h.holders.get(ROOT_A)).toEqual({ ios: { id: UDID, token: result.lease.token, kind: 'declared' } });
  });

  test('a device another workspace holds is refused, and its lease is untouched', () => {
    const h = harness();
    const first = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    assert(first.status === 'taken');
    const second = takeLease({ root: ROOT_B, platform: 'ios', id: UDID, kind: 'run' }, h.io);
    assert(second.status === 'held');
    expect(second.lease.holder).toBe(ROOT_A);
    expect(h.read('ios', UDID)?.token).toBe(first.lease.token);
    expect(h.holders.get(ROOT_B)).toBeUndefined();
  });

  test('an expired lease is free, and the device is taken under a fresh token', () => {
    const h = harness();
    const first = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    assert(first.status === 'taken');
    h.advance(DEFAULT_LEASE_MS + 1);
    const second = takeLease({ root: ROOT_B, platform: 'ios', id: UDID, kind: 'run' }, h.io);
    assert(second.status === 'taken');
    expect(second.lease.holder).toBe(ROOT_B);
    expect(second.lease.token).not.toBe(first.lease.token);
  });

  test('this workspace taking the device again sets the expiry, and can shorten it', () => {
    const h = harness();
    const first = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    assert(first.status === 'taken');
    const shorter = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared', durationMs: 10_000 }, h.io);
    assert(shorter.status === 'set');
    expect(shorter.lease.token).toBe(first.lease.token);
    expect(Date.parse(shorter.lease.expiresAt)).toBeLessThan(Date.parse(first.lease.expiresAt));
  });

  test('a file that does not parse is never overwritten', () => {
    const h = harness();
    h.files.set(deviceLeasePath('ios', UDID), '{ this is not a lease');
    const result = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run' }, h.io);
    expect(result).toEqual({ status: 'unreadable', path: deviceLeasePath('ios', UDID) });
    expect(h.files.get(deviceLeasePath('ios', UDID))).toBe('{ this is not a lease');
  });

  test('a workspace holds at most one lease per platform', () => {
    const h = harness();
    takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    const second = takeLease({ root: ROOT_A, platform: 'ios', id: 'OTHER-UDID', kind: 'declared' }, h.io);
    assert(second.status === 'taken');
    expect(h.read('ios', UDID)).toBe(null);
    expect(h.holders.get(ROOT_A)).toEqual({ ios: { id: 'OTHER-UDID', token: second.lease.token, kind: 'declared' } });
  });

  test('a lease file this root left on another device goes even when the token is lost', () => {
    const h = harness();
    takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    h.holders.delete(ROOT_A);

    const second = takeLease({ root: ROOT_A, platform: 'ios', id: 'OTHER-UDID', kind: 'run' }, h.io);
    assert(second.status === 'taken');
    expect(h.read('ios', UDID)).toBe(null);
    expect(listLeaseFiles(h.io).map((entry) => entry.id)).toEqual(['OTHER-UDID']);
  });

  test('a run set on this workspace declared lease neither converts nor shortens it', () => {
    const h = harness();
    const declared = takeLease(
      { root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared', durationMs: 600_000 },
      h.io,
    );
    assert(declared.status === 'taken');

    const run = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run', durationMs: 60_000 }, h.io);
    assert(run.status === 'set');
    expect(run.lease.expiresAt).toBe(declared.lease.expiresAt);
    expect(h.holders.get(ROOT_A)?.ios?.kind).toBe('declared');
    expect(releaseRunLease({ root: ROOT_A, platform: 'ios' }, h.io)).toBe(null);
  });

  test('a lease on the other platform survives', () => {
    const h = harness();
    takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    takeLease({ root: ROOT_A, platform: 'android', id: 'R5CT', kind: 'run' }, h.io);
    expect(h.read('ios', UDID)?.holder).toBe(ROOT_A);
    expect(Object.keys(h.holders.get(ROOT_A) ?? {}).toSorted()).toEqual(['android', 'ios']);
  });

  test('every mutation runs under the lease lock', () => {
    const h = harness();
    takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run' }, h.io);
    raiseLease({ root: ROOT_A, platform: 'ios', minMs: 60_000 }, h.io);
    releaseRunLease({ root: ROOT_A, platform: 'ios' }, h.io);
    expect(h.locks).toEqual([
      deviceLeaseLockPath('ios', UDID),
      deviceLeaseLockPath('ios', UDID),
      deviceLeaseLockPath('ios', UDID),
    ]);
  });
});

describe('raising a lease', () => {
  test('raises to now plus the step bound and never lowers the expiry', () => {
    const h = harness();
    const taken = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run', durationMs: 60_000 }, h.io);
    assert(taken.status === 'taken');
    const short = raiseLease({ root: ROOT_A, platform: 'ios', minMs: 10_000 }, h.io);
    assert(short.status === 'raised');
    expect(short.lease.expiresAt).toBe(taken.lease.expiresAt);

    const long = raiseLease({ root: ROOT_A, platform: 'ios', minMs: 300_000 }, h.io);
    assert(long.status === 'raised');
    expect(Date.parse(long.lease.expiresAt)).toBeGreaterThan(Date.parse(taken.lease.expiresAt));
  });

  test('an expired file that still carries this run token is revived', () => {
    const h = harness();
    const taken = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run', durationMs: 60_000 }, h.io);
    assert(taken.status === 'taken');
    h.advance(120_000);
    const raised = raiseLease({ root: ROOT_A, platform: 'ios', minMs: 60_000 }, h.io);
    assert(raised.status === 'raised');
    expect(raised.lease.token).toBe(taken.lease.token);
    expect(Date.parse(raised.lease.expiresAt)).toBeGreaterThan(h.io.now());
  });

  test('a lease taken by another workspace is lost, and that lease is left alone', () => {
    const h = harness();
    takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run', durationMs: 60_000 }, h.io);
    h.advance(61_000);
    const stolen = takeLease({ root: ROOT_B, platform: 'ios', id: UDID, kind: 'run' }, h.io);
    assert(stolen.status === 'taken');
    const lost = raiseLease({ root: ROOT_A, platform: 'ios', minMs: 60_000 }, h.io);
    assert(lost.status === 'lost');
    expect(lost.lease?.holder).toBe(ROOT_B);
    expect(h.read('ios', UDID)?.token).toBe(stolen.lease.token);
  });

  test('a workspace with no lease for the platform raises nothing', () => {
    const h = harness();
    expect(raiseLease({ root: ROOT_A, platform: 'android', minMs: 60_000 }, h.io)).toEqual({ status: 'none' });
  });
});

describe('releasing a lease', () => {
  test('a run-scoped lease is released by token', () => {
    const h = harness();
    takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run' }, h.io);
    const released = releaseRunLease({ root: ROOT_A, platform: 'ios' }, h.io);
    expect(released?.id).toBe(UDID);
    expect(h.read('ios', UDID)).toBe(null);
    expect(h.holders.get(ROOT_A)).toEqual({});
  });

  test('a declared lease outlives the run that raised it', () => {
    const h = harness();
    takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    expect(releaseRunLease({ root: ROOT_A, platform: 'ios' }, h.io)).toBe(null);
    expect(h.read('ios', UDID)?.holder).toBe(ROOT_A);
  });

  test('a stale release with an old token leaves the newer grant alone', () => {
    const h = harness();
    const first = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run', durationMs: 60_000 }, h.io);
    assert(first.status === 'taken');
    const stale = h.holders.get(ROOT_A);
    h.advance(61_000);
    const second = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run' }, h.io);
    assert(second.status === 'taken');
    h.holders.set(ROOT_A, stale as WorkspaceLeases);

    expect(releaseRunLease({ root: ROOT_A, platform: 'ios' }, h.io)).toBe(null);
    expect(h.read('ios', UDID)?.token).toBe(second.lease.token);
  });

  test('a stale state token does not strand this root own unexpired lease', () => {
    const h = harness();
    const taken = takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'run' }, h.io);
    assert(taken.status === 'taken');
    h.holders.set(ROOT_A, { ios: { id: UDID, token: 'a-token-from-a-dead-run', kind: 'run' } });

    const released = releaseWorkspaceLeases(ROOT_A, {}, h.io);
    expect(released.map((r) => r.id)).toEqual([UDID]);
    expect(h.read('ios', UDID)).toBe(null);
  });

  test('a lease whose token this workspace lost is released by holder root', () => {
    const h = harness();
    takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    h.holders.delete(ROOT_A);
    const released = releaseWorkspaceLeases(ROOT_A, {}, h.io);
    expect(released.map((r) => r.id)).toEqual([UDID]);
    expect(h.read('ios', UDID)).toBe(null);
  });

  test('another workspace lease is never released', () => {
    const h = harness();
    takeLease({ root: ROOT_B, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    expect(releaseWorkspaceLeases(ROOT_A, {}, h.io)).toEqual([]);
    expect(h.read('ios', UDID)?.holder).toBe(ROOT_B);
  });

  test('every lease this workspace holds is released', () => {
    const h = harness();
    takeLease({ root: ROOT_A, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    takeLease({ root: ROOT_A, platform: 'android', id: 'R5CT', kind: 'run' }, h.io);
    const released = releaseWorkspaceLeases(ROOT_A, {}, h.io);
    expect(released.map((r) => r.platform).toSorted()).toEqual(['android', 'ios']);
    expect(h.files.size).toBe(0);
    expect(h.holders.get(ROOT_A)).toEqual({});
  });
});

describe('the lease duration', () => {
  test('accepts whole seconds and minutes inside the range', () => {
    expect(parseLeaseDuration('10s')).toEqual({ ms: 10_000 });
    expect(parseLeaseDuration('90s')).toEqual({ ms: 90_000 });
    expect(parseLeaseDuration('5m')).toEqual({ ms: DEFAULT_LEASE_MS });
    expect(parseLeaseDuration('30m')).toEqual({ ms: 1_800_000 });
  });

  test('refuses anything outside 10s to 30m', () => {
    expect(parseLeaseDuration('9s')).toHaveProperty('error');
    expect(parseLeaseDuration('31m')).toHaveProperty('error');
    expect(parseLeaseDuration('1801s')).toHaveProperty('error');
  });

  test('refuses a shape the pattern does not describe', () => {
    for (const value of ['5', '0s', '01m', '5h', '5M', '-1m', '1.5m', '']) {
      expect(parseLeaseDuration(value)).toHaveProperty('error');
    }
  });
});

describe('choosing a device from the pool', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z');
  const lease = (over: Partial<DeviceLease>): DeviceLease => ({
    version: 1,
    platform: 'ios',
    id: 'x',
    deviceName: null,
    holder: ROOT_B,
    token: 't',
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...over,
  });

  test('the first free candidate wins, in case-folded id order', () => {
    const selection = selectPoolDevice({
      candidates: [{ id: 'ZZZ' }, { id: 'aaa' }, { id: 'MMM' }],
      leases: [],
      now,
    });
    expect(selection).toEqual({ status: 'selected', candidate: { id: 'aaa' } });
  });

  test('a candidate whose lease expired is free', () => {
    const selection = selectPoolDevice({
      candidates: [{ id: 'aaa' }, { id: 'bbb' }],
      leases: [lease({ id: 'aaa', expiresAt: new Date(now - 1).toISOString() })],
      now,
    });
    expect(selection).toEqual({ status: 'selected', candidate: { id: 'aaa' } });
  });

  test('a candidate another workspace holds is skipped', () => {
    const selection = selectPoolDevice({
      candidates: [{ id: 'aaa' }, { id: 'bbb' }],
      leases: [lease({ id: 'aaa' })],
      now,
    });
    expect(selection).toEqual({ status: 'selected', candidate: { id: 'bbb' } });
  });

  test("this workspace's leased device wins even when it sorts last", () => {
    const selection = selectPoolDevice({
      candidates: [{ id: 'aaa' }, { id: 'zzz', name: 'Old iPhone' }],
      leases: [lease({ id: 'zzz', holder: ROOT_A })],
      held: 'zzz',
      now,
    });
    expect(selection).toEqual({ status: 'selected', candidate: { id: 'zzz', name: 'Old iPhone' } });
  });

  test('a leased device that is not connected refuses rather than picking another', () => {
    const selection = selectPoolDevice({ candidates: [{ id: 'aaa' }], leases: [], held: 'zzz', now });
    expect(selection).toEqual({ status: 'held-disconnected', id: 'zzz' });
  });

  test('candidates with none free name every holder', () => {
    const selection = selectPoolDevice({
      candidates: [{ id: 'bbb' }, { id: 'aaa' }],
      leases: [lease({ id: 'aaa' }), lease({ id: 'bbb', holder: '/worktree/c' })],
      now,
    });
    assert(selection.status === 'busy');
    expect(selection.holders.map((h) => h.holder)).toEqual([ROOT_B, '/worktree/c']);
  });

  test('no candidate at all is its own answer', () => {
    expect(selectPoolDevice({ candidates: [], leases: [], now })).toEqual({ status: 'none' });
  });
});

describe('the real file protocol', { timeout: 30_000 }, () => {
  const LEASE_URL = new URL('../engine/device-lease.ts', import.meta.url).href;
  const CHILD_TIMEOUT_MS = 20_000;
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'stim-lease-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function script(name: string, body: string) {
    const path = join(scratch, name);
    writeFileSync(path, body);
    return path;
  }

  function runNode(path: string, args: string[] = []) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        [path, ...args],
        { env: { ...process.env, STIM_HOME: home }, timeout: CHILD_TIMEOUT_MS },
        (err, stdout, stderr) => {
          if (err?.killed) return reject(new Error(`${path} was killed after ${CHILD_TIMEOUT_MS}ms (${err.signal})`));
          if (err && err.code === undefined) return reject(err);
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  const barrier = (name: string) => [
    'const { existsSync } = await import("node:fs");',
    `while (!existsSync(${JSON.stringify(join(scratch, name))})) await new Promise(r => setTimeout(r, 5));`,
  ];

  function release(name: string) {
    writeFileSync(join(scratch, name), '');
  }

  test('two processes racing for one free device leave exactly one holder', async () => {
    const racer = script(
      'racer.mjs',
      [
        `const { takeLease } = await import(${JSON.stringify(LEASE_URL)});`,
        ...barrier('go'),
        'const result = takeLease({ root: process.argv[2], platform: "ios", id: "RACE-UDID", kind: "run" });',
        'console.log(JSON.stringify(result));',
      ].join('\n'),
    );

    const runs = [runNode(racer, [join(scratch, 'a')]), runNode(racer, [join(scratch, 'b')])];
    release('go');
    const answers = (await Promise.all(runs)).map((r) => JSON.parse(r.stdout.trim()));

    const taken = answers.filter((a) => a.status === 'taken');
    const held = answers.filter((a) => a.status === 'held');
    expect(taken).toHaveLength(1);
    expect(held).toHaveLength(1);
    expect(held[0].lease.token).toBe(taken[0].lease.token);
    const survivor = parseLease(readFileSync(deviceLeasePath('ios', 'RACE-UDID'), 'utf-8'));
    expect(survivor?.token).toBe(taken[0].lease.token);
  });

  test('a holder renewing against a claimant taking its expired lease leaves one holder', async () => {
    const rootA = join(scratch, 'a');
    const rootB = join(scratch, 'b');
    const token = 'token-a';
    writeWorkspaceState(rootA, { deviceLeases: { ios: { id: UDID, token, kind: 'run' } } });
    const expired: DeviceLease = {
      version: 1,
      platform: 'ios',
      id: UDID,
      deviceName: 'Old iPhone',
      holder: rootA,
      token,
      grantedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const { mkdirSync } = await import('node:fs');
    mkdirSync(deviceLocksDir(), { recursive: true });
    writeFileSync(deviceLeasePath('ios', UDID), `${JSON.stringify(expired, null, 2)}\n`);

    const renewer = script(
      'renewer.mjs',
      [
        `const { raiseLease } = await import(${JSON.stringify(LEASE_URL)});`,
        ...barrier('go2'),
        `console.log(JSON.stringify(raiseLease({ root: ${JSON.stringify(rootA)}, platform: "ios", minMs: 60000 })));`,
      ].join('\n'),
    );
    const claimant = script(
      'claimant.mjs',
      [
        `const { takeLease } = await import(${JSON.stringify(LEASE_URL)});`,
        ...barrier('go2'),
        `console.log(JSON.stringify(takeLease({ root: ${JSON.stringify(rootB)}, platform: "ios", id: ${JSON.stringify(UDID)}, kind: "run" })));`,
      ].join('\n'),
    );

    const runs = [runNode(renewer), runNode(claimant)];
    release('go2');
    const [raise, take] = (await Promise.all(runs)).map((r) => JSON.parse(r.stdout.trim()));
    const survivor = parseLease(readFileSync(deviceLeasePath('ios', UDID), 'utf-8'));
    assert(survivor);

    const world = {
      raise: raise.status,
      take: take.status,
      holder: survivor.holder,
      keptTheOldToken: survivor.token === token,
    };
    expect([
      { raise: 'raised', take: 'held', holder: rootA, keptTheOldToken: true },
      { raise: 'lost', take: 'taken', holder: rootB, keptTheOldToken: false },
    ]).toContainEqual(world);
  });

  test('a lease that stopped being expired survives the delete that reported it', () => {
    const root = join(scratch, 'a');
    const path = deviceLeasePath('ios', UDID);
    const rewrite = (expiresAt: number) => {
      const lease = parseLease(readFileSync(path, 'utf-8')) as DeviceLease;
      writeFileSync(path, JSON.stringify({ ...lease, expiresAt: new Date(expiresAt).toISOString() }));
    };
    takeLease({ root, platform: 'ios', id: UDID, kind: 'run', durationMs: 10_000 });
    rewrite(Date.now() - 1000);
    const reported = listLeaseFiles()[0];
    assert(reported);

    rewrite(Date.now() + 600_000);
    expect(removeExpiredLease(reported)).toBe(false);
    expect(existsSync(path)).toBe(true);

    rewrite(Date.now() - 1000);
    expect(removeExpiredLease(reported)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test('a lease file is reported with what its own directory holds', () => {
    const taken = takeLease({ root: join(scratch, 'a'), platform: 'ios', id: UDID, kind: 'declared' });
    assert(taken.status === 'taken');
    const entries = listLeaseFiles();
    expect(entries.map((e) => e.name)).toEqual([`ios-${UDID}.json`]);
    expect(entries[0]?.lease?.holder).toBe(join(scratch, 'a'));
    expect(existsSync(deviceLeasePath('ios', UDID))).toBe(true);

    expect(releaseWorkspaceLeases(join(scratch, 'a')).map((r) => r.id)).toEqual([UDID]);
    expect(listLeaseFiles()).toEqual([]);
  });
});
