import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { STABILITY_WINDOW_MS, VERIFY_TIMEOUT_MS } from '../engine/app-install.ts';
import { deviceLeasePath, parseLease, takeLease, type LeaseIo, type WorkspaceLeases } from '../engine/device-lease.ts';
import {
  DEBUG_VERIFY_STEP_MS,
  DEFAULT_DEVICE_WAIT_SECONDS,
  DEVICE_WAIT_POLL_MS,
  LEASE_STEP_FLOOR_MS,
  acquireRunLease,
  leaseStepMs,
  parseDeviceWait,
  runLease,
  waitFlagConflict,
} from '../engine/device-lease-run.ts';

const ROOT = '/worktree/mine';
const OTHER = '/worktree/theirs';
const UDID = '00008030-001A2B3C4D5E802E';
const INSTALL_MS = 300_000;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-home-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function harness(start = Date.parse('2026-09-02T12:00:00.000Z')) {
  const files = new Map<string, string>();
  const holders = new Map<string, WorkspaceLeases>();
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
    withLeaseLock: (_lock, fn) => fn(),
    readHolder: (root) => structuredClone(holders.get(root) ?? {}),
    writeHolder: (root, leases) => {
      holders.set(root, structuredClone(leases));
    },
  };
  const warnings: string[] = [];
  const slept: number[] = [];
  return {
    io,
    files,
    holders,
    warnings,
    slept,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    warn: (line: string) => warnings.push(line),
    read: () => parseLease(files.get(deviceLeasePath('ios', UDID)) ?? null),
  };
}

type Harness = ReturnType<typeof harness>;

function acquire(h: Harness, over: Record<string, unknown> = {}) {
  return acquireRunLease({
    root: ROOT,
    platform: 'ios',
    id: UDID,
    deviceName: 'Test Phone',
    idLabel: 'udid',
    waitSeconds: DEFAULT_DEVICE_WAIT_SECONDS,
    noWait: false,
    installBoundMs: INSTALL_MS,
    now: h.now,
    sleep: h.sleep,
    warn: h.warn,
    io: h.io,
    ...over,
  });
}

describe('the flags that steer the wait', () => {
  test('--wait defaults to 60 seconds and accepts 0', () => {
    expect(parseDeviceWait(undefined)).toEqual({ seconds: DEFAULT_DEVICE_WAIT_SECONDS });
    expect(parseDeviceWait('0')).toEqual({ seconds: 0 });
    expect(parseDeviceWait('90')).toEqual({ seconds: 90 });
  });

  test('--wait refuses anything that is not a whole number of seconds', () => {
    for (const value of ['-1', '1.5', 'soon', '']) expect(parseDeviceWait(value)).toHaveProperty('error');
  });

  test('--wait and --no-wait together are visible in argv, in either order or form', () => {
    expect(waitFlagConflict(['stim', 'ios', '--device', '--wait', '30', '--no-wait'])).toBe(true);
    expect(waitFlagConflict(['stim', 'ios', '--no-wait', '--wait=30'])).toBe(true);
    expect(waitFlagConflict(['stim', 'ios', '--wait', '30'])).toBe(false);
    expect(waitFlagConflict(['stim', 'ios', '--no-wait'])).toBe(false);
  });

  test('a step never asks for less than 60 seconds', () => {
    expect(leaseStepMs(0)).toBe(LEASE_STEP_FLOOR_MS);
    expect(leaseStepMs(1000)).toBe(LEASE_STEP_FLOOR_MS);
    expect(leaseStepMs(INSTALL_MS)).toBe(INSTALL_MS);
    expect(DEBUG_VERIFY_STEP_MS).toBe(VERIFY_TIMEOUT_MS + STABILITY_WINDOW_MS);
  });
});

describe('taking the lease a run needs', () => {
  test('a free device is leased for the run, to the install bound', async () => {
    const h = harness();
    const result = await acquire(h);
    assert(result.status === 'leased');
    expect(result.kind).toBe('run');
    expect(Date.parse(result.expiresAt) - h.now()).toBe(INSTALL_MS);
    expect(h.read()?.holder).toBe(ROOT);
    expect(h.slept).toEqual([]);
  });

  test('a lease this workspace already holds is raised, not retaken', async () => {
    const h = harness();
    const declared = takeLease({ root: ROOT, platform: 'ios', id: UDID, kind: 'declared', durationMs: 600_000 }, h.io);
    assert(declared.status === 'taken');

    const result = await acquire(h);
    assert(result.status === 'leased');
    expect(result.kind).toBe('declared');
    expect(result.expiresAt).toBe(declared.lease.expiresAt);
    expect(h.read()?.token).toBe(declared.lease.token);
  });

  test('a device this workspace leases under another id refuses rather than taking a second', async () => {
    const h = harness();
    takeLease({ root: ROOT, platform: 'ios', id: 'ANOTHER-PHONE', kind: 'declared' }, h.io);
    const result = await acquire(h);
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_NO_DEVICE');
    expect(result.refusal.message).toMatch(/ANOTHER-PHONE/);
    expect(result.refusal.remedy).toMatch(/--device ANOTHER-PHONE/);
  });

  test("this root's own lease with no token left refuses at once, naming what to do", async () => {
    const h = harness();
    takeLease({ root: ROOT, platform: 'ios', id: UDID, kind: 'declared' }, h.io);
    h.holders.delete(ROOT);

    const result = await acquire(h);
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_DEVICE_BUSY');
    expect(result.refusal.message).toMatch(/its own record of that lease is gone/);
    expect(result.refusal.remedy).toMatch(/this workspace's own/);
    expect(result.refusal.lease?.holder).toBe(ROOT);
  });

  test('a lease file that does not parse refuses at once, with null lease fields', async () => {
    const h = harness();
    h.files.set(deviceLeasePath('ios', UDID), '{ not a lease');
    const result = await acquire(h);
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_DEVICE_BUSY');
    expect(result.refusal.message).toMatch(/does not parse/);
    expect(result.refusal.message).toMatch(
      new RegExp(deviceLeasePath('ios', UDID).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    expect(result.refusal.lease).toEqual({
      platform: null,
      id: null,
      deviceName: null,
      holder: null,
      expiresAt: null,
    });
    expect(h.slept).toEqual([]);
  });
});

describe('waiting for a device another workspace holds', () => {
  function held(h: Harness, durationMs = 10_000) {
    const taken = takeLease(
      { root: OTHER, platform: 'ios', id: UDID, deviceName: 'Test Phone', kind: 'run', durationMs },
      h.io,
    );
    assert(taken.status === 'taken');
    h.holders.delete(OTHER);
    return taken.lease;
  }

  test('a lease that frees mid-wait is taken by the waiter', async () => {
    const h = harness();
    held(h, 6_000);
    const result = await acquire(h);
    assert(result.status === 'leased');
    expect(result.kind).toBe('run');
    expect(h.slept).toEqual([DEVICE_WAIT_POLL_MS, DEVICE_WAIT_POLL_MS, DEVICE_WAIT_POLL_MS]);
    expect(h.read()?.holder).toBe(ROOT);
  });

  test('the waiting line is printed every 30 seconds, not on every poll', async () => {
    const h = harness();
    held(h, 10 * 60_000);
    const result = await acquire(h, { waitSeconds: 61 });
    assert(result.status === 'refused');
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[0]).toMatch(new RegExp(`waiting for ${OTHER} to release Test Phone \\(${UDID}\\)`));
    expect(h.warnings[0]).toMatch(/its lease runs until \d\d:\d\d:\d\d \(\d+m\d\ds from now\)/);
  });

  test('the wait running out refuses with the holder, the expiry and the three remedies', async () => {
    const h = harness();
    const lease = held(h, 10 * 60_000);
    const result = await acquire(h, { waitSeconds: 4 });
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_DEVICE_BUSY');
    expect(result.refusal.message).toMatch(new RegExp(`^${OTHER} holds Test Phone \\(${UDID}\\) until`));
    expect(result.refusal.message).toMatch(/waited 4s for it/);
    expect(result.refusal.remedy).toMatch(/Wait longer with `--wait <seconds>`/);
    expect(result.refusal.remedy).toMatch(/pick another device with `--device <udid>`/);
    expect(result.refusal.remedy).toMatch(/`--no-wait`[\s\S]*terminates the holder's running app/);
    expect(result.refusal.lease).toEqual({
      platform: 'ios',
      id: UDID,
      deviceName: 'Test Phone',
      holder: OTHER,
      expiresAt: lease.expiresAt,
    });
  });

  test('--wait 0 refuses at once, without sleeping', async () => {
    const h = harness();
    held(h, 10 * 60_000);
    const result = await acquire(h, { waitSeconds: 0 });
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_DEVICE_BUSY');
    expect(h.slept).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  test('--no-wait proceeds with no lease and warns about the holder and the cost', async () => {
    const h = harness();
    held(h, 10 * 60_000);
    const result = await acquire(h, { noWait: true, appId: 'com.example.app', holderAppId: () => 'com.example.app' });
    expect(result).toEqual({ status: 'unleased' });
    expect(h.warnings[0]).toMatch(new RegExp(`--no-wait: ${OTHER} holds Test Phone \\(${UDID}\\) until`));
    expect(h.warnings[0]).toMatch(/proceeding without a lease/);
    expect(h.warnings[1]).toMatch(/same app id, so this install terminates the app that workspace is running/);
    expect(h.read()?.holder).toBe(OTHER);
    expect(h.slept).toEqual([]);
  });

  test('--no-wait on a different app id says what actually happens instead', async () => {
    const h = harness();
    held(h, 10 * 60_000);
    await acquire(h, { noWait: true, appId: 'com.example.app', holderAppId: () => 'com.other.app' });
    expect(h.warnings[1]).toMatch(/backgrounds it/);
  });

  test('--no-wait still leases a free device', async () => {
    const h = harness();
    const result = await acquire(h, { noWait: true });
    assert(result.status === 'leased');
    expect(h.read()?.holder).toBe(ROOT);
    expect(h.warnings).toEqual([]);
  });
});

describe('the per-step raise', () => {
  async function leased(h: Harness) {
    const result = await acquire(h);
    assert(result.status === 'leased');
    return runLease({ root: ROOT, platform: 'ios', kind: result.kind, expiresAt: result.expiresAt, io: h.io });
  }

  test('each step raises to now plus the larger of 60 seconds and its own bound', async () => {
    const h = harness();
    const lease = await leased(h);
    h.advance(INSTALL_MS);

    const launch = lease.raise(47_000);
    expect(launch.ok).toBe(true);
    expect(Date.parse(lease.expiresAt as string) - h.now()).toBe(LEASE_STEP_FLOOR_MS);

    expect(lease.raise(INSTALL_MS).ok).toBe(true);
    expect(Date.parse(lease.expiresAt as string) - h.now()).toBe(INSTALL_MS);
  });

  test('a raise never lowers an expiry that already reaches further', async () => {
    const h = harness();
    const lease = await leased(h);
    const before = lease.expiresAt;
    expect(lease.raise(1000).ok).toBe(true);
    expect(lease.expiresAt).toBe(before);
  });

  test('the verification raise outlasts the bundle deadline plus the stability window', async () => {
    const h = harness();
    const lease = await leased(h);
    h.advance(INSTALL_MS);
    lease.raise(DEBUG_VERIFY_STEP_MS);

    h.advance(VERIFY_TIMEOUT_MS + STABILITY_WINDOW_MS);
    expect(Date.parse(lease.expiresAt as string)).toBeGreaterThan(h.now());
  });

  test('a lease another workspace took is lost once, and reported as no lease at all', async () => {
    const h = harness();
    const lease = await leased(h);
    h.advance(INSTALL_MS + 1);
    const stolen = takeLease({ root: OTHER, platform: 'ios', id: UDID, kind: 'run' }, h.io);
    assert(stolen.status === 'taken');

    const step = lease.raise(INSTALL_MS);
    expect(step.ok).toBe(false);
    expect(step.holder).toBe(OTHER);
    expect(lease.lost).toBe(true);
    expect(lease.facts()).toBe(null);
    expect(lease.raise(INSTALL_MS).ok).toBe(false);
  });

  test('a run that took no lease raises nothing and reports nothing', async () => {
    const h = harness();
    const lease = runLease({ root: ROOT, platform: 'ios', kind: null, expiresAt: null, io: h.io });
    expect(lease.raise(INSTALL_MS).ok).toBe(true);
    expect(lease.facts()).toBe(null);
    lease.release();
    expect(h.files.size).toBe(0);
  });
});

describe('releasing what the run took', () => {
  test('a run-scoped lease is released, and its facts describe what it was', async () => {
    const h = harness();
    const result = await acquire(h);
    assert(result.status === 'leased');
    const lease = runLease({ root: ROOT, platform: 'ios', kind: result.kind, expiresAt: result.expiresAt, io: h.io });

    expect(lease.facts()).toEqual({ kind: 'run', expiresAt: result.expiresAt });
    lease.release();
    expect(h.read()).toBe(null);
    expect(h.holders.get(ROOT)).toEqual({});
  });

  test('a declared lease outlives the run, raised to where its steps left it', async () => {
    const h = harness();
    takeLease({ root: ROOT, platform: 'ios', id: UDID, kind: 'declared', durationMs: 30_000 }, h.io);
    const result = await acquire(h);
    assert(result.status === 'leased');
    const lease = runLease({ root: ROOT, platform: 'ios', kind: result.kind, expiresAt: result.expiresAt, io: h.io });
    lease.raise(INSTALL_MS);

    lease.release();
    const survivor = h.read();
    assert(survivor);
    expect(survivor.holder).toBe(ROOT);
    expect(Date.parse(survivor.expiresAt) - h.now()).toBe(INSTALL_MS);
    expect(h.holders.get(ROOT)?.ios?.kind).toBe('declared');
  });
});
