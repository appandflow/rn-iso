import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { deviceLeasePath, takeLease, type LeaseIo, type WorkspaceLeases } from '../engine/device-lease.ts';
import { DEVICE_WAIT_POLL_MS } from '../engine/device-lease-run.ts';
import { heldPoolId, selectFromPool } from '../engine/device-pool.ts';
import { iosPoolCandidates } from '../engine/ios-device.ts';
import { androidPoolCandidates } from '../sim/android.ts';

const ROOT = '/worktree/mine';
const OTHER = '/worktree/theirs';
const FIRST = '00008030-AAA';
const SECOND = '00008120-BBB';

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
  };
}

type Harness = ReturnType<typeof harness>;

const NONE = () => ({ message: 'No physical iOS device is connected.', remedy: 'Plug one in.' });

function pool(h: Harness, ids: string[], over: Record<string, unknown> = {}) {
  return selectFromPool({
    root: ROOT,
    platform: 'ios',
    idLabel: 'udid',
    list: () => ids.map((id) => ({ id, name: `name-${id}` })),
    noCandidates: NONE,
    waitSeconds: 60,
    now: h.now,
    sleep: h.sleep,
    warn: h.warn,
    io: h.io,
    ...over,
  });
}

function leasedBy(h: Harness, root: string, id: string, durationMs = 600_000) {
  const taken = takeLease({ root, platform: 'ios', id, deviceName: `name-${id}`, kind: 'declared', durationMs }, h.io);
  assert(taken.status === 'taken');
  if (root !== ROOT) h.holders.delete(root);
  return taken.lease;
}

describe('which connected devices are candidates', () => {
  const device = (over: Record<string, unknown> = {}) => ({
    udid: FIRST,
    name: 'Old iPhone',
    bootState: 'booted',
    developerModeStatus: 'enabled',
    pairingState: 'paired',
    transportType: 'wired',
    ...over,
  });

  test('an iOS device must be wired, paired, and have Developer Mode on', () => {
    const accepted = iosPoolCandidates([
      device(),
      device({ udid: 'B', transportType: 'localNetwork' }),
      device({ udid: 'C', pairingState: 'unpaired' }),
      device({ udid: 'D', developerModeStatus: 'disabled' }),
    ]);
    expect(accepted.map((entry) => entry.udid)).toEqual([FIRST]);
    expect(iosPoolCandidates([])).toEqual([]);
  });

  test('an Android candidate is any non-emulator adb reports in the device state, TCP included', () => {
    const adb = {
      emulators: [{ serial: 'emulator-5554', consolePort: 5554 }],
      physical: [{ serial: 'RFCR7081Q9L' }, { serial: '192.168.1.5:5555' }, { serial: 'FAKE' }],
      unhealthy: [{ serial: 'OFFLINE', kind: 'physical' as const, status: 'offline' }],
    };
    const accepted = androidPoolCandidates(adb, (serial) => serial === 'FAKE');
    expect(accepted.map((entry) => entry.serial)).toEqual(['RFCR7081Q9L', '192.168.1.5:5555']);
  });
});

describe('choosing from the pool', () => {
  test('the first free candidate in case-folded id order wins', async () => {
    const h = harness();
    const result = await pool(h, ['Zzz', 'aaa']);
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe('aaa');
    expect(h.slept).toEqual([]);
  });

  test('a candidate another workspace holds is skipped', async () => {
    const h = harness();
    leasedBy(h, OTHER, FIRST);
    const result = await pool(h, [FIRST, SECOND]);
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe(SECOND);
  });

  test('an expired lease makes its device free again', async () => {
    const h = harness();
    leasedBy(h, OTHER, FIRST, 60_000);
    h.advance(61_000);
    const result = await pool(h, [FIRST, SECOND]);
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe(FIRST);
  });

  test("this workspace's own device wins even when it sorts last", async () => {
    const h = harness();
    leasedBy(h, ROOT, SECOND);
    const result = await pool(h, [FIRST, SECOND]);
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe(SECOND);
  });

  test('a stale record does not pin this workspace to a device it no longer holds', async () => {
    const h = harness();
    leasedBy(h, ROOT, SECOND, 60_000);
    h.advance(61_000);
    expect(heldPoolId(ROOT, 'ios', h.now(), h.io)).toBe(null);
    const result = await pool(h, [FIRST, SECOND]);
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe(FIRST);
  });

  test('a candidate whose lease file does not parse is never treated as free', async () => {
    const h = harness();
    h.files.set(deviceLeasePath('ios', 'A-CORRUPT'), '{ not a lease');
    const result = await pool(h, ['A-CORRUPT', 'B-FREE']);
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe('B-FREE');
  });

  test('every candidate unreadable refuses, naming the files rather than the phones', async () => {
    const h = harness();
    h.files.set(deviceLeasePath('ios', 'A-CORRUPT'), '{ not a lease');
    const result = await pool(h, ['A-CORRUPT']);
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_DEVICE_BUSY');
    expect(result.refusal.message).toMatch(/Every connected device has an unreadable lease file/);
    expect(result.refusal.message).toContain(deviceLeasePath('ios', 'A-CORRUPT'));
    expect(result.refusal.remedy).toMatch(/`stim gc` reports them on every run/);
    expect(result.refusal.lease).toEqual({
      platform: null,
      id: null,
      deviceName: null,
      holder: null,
      expiresAt: null,
    });
    expect(h.slept).toEqual([]);
  });

  test('an unreadable file is named beside the holders when the rest are leased', async () => {
    const h = harness();
    leasedBy(h, OTHER, FIRST);
    h.files.set(deviceLeasePath('ios', 'A-CORRUPT'), '{ not a lease');
    const result = await pool(h, ['A-CORRUPT', FIRST], { waitSeconds: 0 });
    assert(result.status === 'refused');
    expect(result.refusal.message).toMatch(/Every connected device is leased by another workspace/);
    expect(result.refusal.message).toMatch(/Unreadable lease file/);
    expect(result.refusal.message).toContain(deviceLeasePath('ios', 'A-CORRUPT'));
  });

  test('a leased device that is not connected refuses rather than picking another', async () => {
    const h = harness();
    leasedBy(h, ROOT, 'GONE');
    const result = await pool(h, [FIRST, SECOND]);
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_NO_DEVICE');
    expect(result.refusal.message).toMatch(/This workspace leases GONE, and it is not connected/);
    expect(result.refusal.remedy).toMatch(/stim device unlock/);
    expect(result.refusal.remedy).toMatch(/Naming another `--device <udid>` refuses the same way/);
  });

  test('no candidate at all refuses with the resolver own words', async () => {
    const h = harness();
    const result = await pool(h, []);
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_NO_DEVICE');
    expect(result.refusal.message).toBe('No physical iOS device is connected.');
    expect(result.refusal.remedy).toBe('Plug one in.');
  });
});

describe('waiting for a free device', () => {
  test('the poll re-lists devices, so one plugged in mid-wait is taken', async () => {
    const h = harness();
    leasedBy(h, OTHER, FIRST);
    let connected = [FIRST];
    const result = await pool(h, [], {
      list: () => connected.map((id) => ({ id, name: `name-${id}` })),
      sleep: async (ms: number) => {
        h.slept.push(ms);
        h.advance(ms);
        if (h.slept.length === 2) connected = [FIRST, SECOND];
      },
    });
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe(SECOND);
    expect(h.slept).toEqual([DEVICE_WAIT_POLL_MS, DEVICE_WAIT_POLL_MS]);
  });

  test('a lease that frees mid-wait is taken without re-plugging anything', async () => {
    const h = harness();
    leasedBy(h, OTHER, FIRST, 6_000);
    const result = await pool(h, [FIRST]);
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe(FIRST);
    expect(h.slept).toHaveLength(3);
  });

  test('the wait running out names every holder, once with each expiry', async () => {
    const h = harness();
    const first = leasedBy(h, OTHER, FIRST);
    leasedBy(h, '/worktree/third', SECOND);
    const result = await pool(h, [FIRST, SECOND], { waitSeconds: 4 });
    assert(result.status === 'refused');
    expect(result.refusal.code).toBe('STIM_DEVICE_BUSY');
    expect(result.refusal.message).toMatch(/Every connected device is leased by another workspace/);
    expect(result.refusal.message).toMatch(/this run waited 4s for one/);
    expect(result.refusal.message).toMatch(new RegExp(`${FIRST} \\(${OTHER}, until \\d\\d:`));
    expect(result.refusal.message).toMatch(new RegExp(`${SECOND} \\(/worktree/third, until`));
    expect(result.refusal.lease).toEqual({
      platform: 'ios',
      id: FIRST,
      deviceName: `name-${FIRST}`,
      holder: OTHER,
      expiresAt: first.expiresAt,
    });
  });

  test('--wait 0 refuses at once, without sleeping', async () => {
    const h = harness();
    leasedBy(h, OTHER, FIRST);
    const result = await pool(h, [FIRST], { waitSeconds: 0 });
    assert(result.status === 'refused');
    expect(h.slept).toEqual([]);
    expect(result.refusal.message).not.toMatch(/waited/);
  });

  test('the waiting line names every holder, at once and then every 30 seconds', async () => {
    const h = harness();
    leasedBy(h, OTHER, FIRST);
    await pool(h, [FIRST], { waitSeconds: 61 });
    expect(h.warnings).toHaveLength(3);
    expect(h.warnings[0]).toMatch(/waiting for a free device; every connected one is leased/);
    expect(h.warnings[0]).toMatch(new RegExp(`${FIRST} \\(${OTHER}, until`));
  });

  test('--no-wait takes the first candidate anyway, and leaves the lease to the run', async () => {
    const h = harness();
    leasedBy(h, OTHER, FIRST);
    const result = await pool(h, [FIRST, SECOND], { noWait: true, list: () => [{ id: FIRST }] });
    assert(result.status === 'selected');
    expect(result.candidate.id).toBe(FIRST);
    expect(h.slept).toEqual([]);
  });
});
