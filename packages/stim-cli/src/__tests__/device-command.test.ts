import assert from 'node:assert';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { grantLine, registerDevice, releasedLine, runLock, runUnlock, type DeviceDeps } from '../commands/device.ts';
import { fileLeaseIo, listLeaseFiles, takeLease, type DeviceLease, type LeaseIo } from '../engine/device-lease.ts';
import { readWorkspaceState } from '../supervisor/state.ts';

const PHONE = '00008101-000A10913C89001E';
const SERIAL = 'RFCR7081Q9L';
const OTHER_ROOT = '/worktree/theirs';

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-home-'));
  process.env.STIM_HOME = home;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function harness(over: Partial<DeviceDeps> = {}) {
  const out: string[] = [];
  const note: string[] = [];
  let clock = Date.parse('2026-09-02T12:00:00.000Z');
  const io: LeaseIo = { ...fileLeaseIo, now: () => clock };
  const deps: Partial<DeviceDeps> = {
    io,
    findProjectRoot: () => root,
    listIosDevices: () => [
      {
        udid: PHONE,
        name: 'Old iPhone',
        bootState: 'booted',
        developerModeStatus: 'enabled',
        pairingState: 'paired',
        transportType: 'wired',
      },
    ],
    listAdbDevices: () => ({ emulators: [], physical: [{ serial: SERIAL }], unhealthy: [] }),
    physicalDeviceModel: () => 'SM-G996W',
    probeEmulatorSerial: () => false,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: (line: string) => out.push(line),
    note: (line: string) => note.push(line),
    ...over,
  };
  return {
    deps,
    io,
    out,
    note,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    lease: (platform = 'ios', id = PHONE): DeviceLease | null => {
      const file = listLeaseFiles().find((entry) => entry.platform === platform && entry.id === id);
      return file?.lease ?? null;
    },
  };
}

function heldByAnother(io: LeaseIo, durationMs = 10 * 60_000) {
  const taken = takeLease(
    { root: OTHER_ROOT, platform: 'ios', id: PHONE, deviceName: 'Old iPhone', kind: 'declared', durationMs },
    io,
  );
  assert(taken.status === 'taken');
  return taken.lease;
}

describe('stim device lock', () => {
  test('a free phone is leased to this workspace, and said so on stdout', async () => {
    const h = harness();
    const facts = await runLock('ios', undefined, {}, h.deps);
    assert(!('code' in facts));

    expect(facts).toEqual({
      platform: 'ios',
      id: PHONE,
      deviceName: 'Old iPhone',
      holder: root,
      kind: 'declared',
      grantedAt: new Date(h.now()).toISOString(),
      expiresAt: new Date(h.now() + 5 * 60_000).toISOString(),
      leaseSeconds: 300,
    });
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toMatch(
      new RegExp(
        `locked Old iPhone \\(${PHONE}\\) for ${root} until \\d\\d:\\d\\d:\\d\\d \\(5m\\)\\. ` +
          'Renew: stim device lock ios --for 5m\\. Release: stim device unlock\\.',
      ),
    );
    expect(h.lease()?.holder).toBe(root);
    expect(readWorkspaceState(root)?.deviceLeases).toEqual({
      ios: { id: PHONE, token: expect.any(String), kind: 'declared' },
    });
  });

  test('a padded --for still prints a Renew hint that can be run as printed', async () => {
    const h = harness();
    const facts = await runLock('ios', PHONE, { for: ' 90s ' }, h.deps);
    assert(!('code' in facts));
    expect(facts.leaseSeconds).toBe(90);
    expect(h.out[0]).toMatch(/\(90s\)\. Renew: stim device lock ios --for 90s\. Release: stim device unlock\./);
  });

  test('--json prints the payload the spec lists, and nothing else', async () => {
    const h = harness();
    await runLock('ios', PHONE, { json: true, for: '90s' }, h.deps);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] as string)).toEqual({
      platform: 'ios',
      id: PHONE,
      deviceName: 'Old iPhone',
      holder: root,
      kind: 'declared',
      grantedAt: new Date(h.now()).toISOString(),
      expiresAt: new Date(h.now() + 90_000).toISOString(),
      leaseSeconds: 90,
    });
  });

  test('an android serial is leased with the model adb reports as its name', async () => {
    const h = harness();
    const facts = await runLock('android', undefined, {}, h.deps);
    assert(!('code' in facts));
    expect(facts.id).toBe(SERIAL);
    expect(facts.deviceName).toBe('SM-G996W');
    expect(h.lease('android', SERIAL)?.holder).toBe(root);
  });

  test('locking the device this workspace already holds sets the expiry, and can shorten it', async () => {
    const h = harness();
    const first = await runLock('ios', PHONE, { for: '10m' }, h.deps);
    assert(!('code' in first));

    const shorter = await runLock('ios', PHONE, { for: '30s' }, h.deps);
    assert(!('code' in shorter));
    expect(Date.parse(shorter.expiresAt)).toBeLessThan(Date.parse(first.expiresAt));
    expect(Date.parse(shorter.expiresAt) - h.now()).toBe(30_000);
    expect(listLeaseFiles()).toHaveLength(1);
  });

  test('locking another device of the same platform releases the first one', async () => {
    const h = harness({
      listIosDevices: () =>
        [PHONE, 'SECOND-PHONE'].map((udid) => ({
          udid,
          name: udid === PHONE ? 'Old iPhone' : 'New iPhone',
          bootState: 'booted',
          developerModeStatus: 'enabled',
          pairingState: 'paired',
          transportType: 'wired',
        })),
    });
    await runLock('ios', PHONE, {}, h.deps);
    await runLock('ios', 'SECOND-PHONE', {}, h.deps);

    expect(listLeaseFiles().map((entry) => entry.id)).toEqual(['SECOND-PHONE']);
    expect(readWorkspaceState(root)?.deviceLeases).toEqual({
      ios: { id: 'SECOND-PHONE', token: expect.any(String), kind: 'declared' },
    });
  });

  test('a device that fails the resolver is refused with the resolver own message, and nothing is written', async () => {
    const h = harness({ listIosDevices: () => [] });
    const failure = await runLock('ios', undefined, {}, h.deps);
    assert('code' in failure);
    expect(failure.code).toBe('STIM_NO_DEVICE');
    expect(failure.message).toMatch(/No physical iOS device is connected/);
    expect(failure.remedy).toMatch(/Developer Mode/);
    expect(listLeaseFiles()).toEqual([]);
  });

  test('an unpaired phone is refused with the pairing remedy', async () => {
    const h = harness({
      listIosDevices: () => [
        {
          udid: PHONE,
          name: 'Old iPhone',
          bootState: 'booted',
          developerModeStatus: 'enabled',
          pairingState: 'unpaired',
          transportType: 'wired',
        },
      ],
    });
    const failure = await runLock('ios', undefined, {}, h.deps);
    assert('code' in failure);
    expect(failure.remedy).toMatch(/tap Trust/);
    expect(listLeaseFiles()).toEqual([]);
  });

  test('a device another workspace holds refuses under --wait 0, with the lease in the JSON', async () => {
    const h = harness();
    const lease = heldByAnother(h.io);
    const failure = await runLock('ios', PHONE, { wait: '0', json: true }, h.deps);
    assert('code' in failure);

    expect(failure.code).toBe('STIM_DEVICE_BUSY');
    expect(failure.message).toMatch(new RegExp(`^${OTHER_ROOT} holds Old iPhone \\(${PHONE}\\) until`));
    expect(JSON.parse(h.out[0] as string).lease).toEqual({
      platform: 'ios',
      id: PHONE,
      deviceName: 'Old iPhone',
      holder: OTHER_ROOT,
      expiresAt: lease.expiresAt,
    });
    expect(h.lease()?.holder).toBe(OTHER_ROOT);
  });

  test('a lease that frees mid-wait is taken by the waiting lock', async () => {
    const h = harness();
    heldByAnother(h.io, 6_000);
    const facts = await runLock('ios', PHONE, {}, h.deps);
    assert(!('code' in facts));
    expect(facts.holder).toBe(root);
    expect(h.note.filter((line) => line.includes('waiting for'))).toHaveLength(1);
  });

  test('a long wait prints the holder at once and then every 30 seconds, to stderr', async () => {
    const h = harness();
    heldByAnother(h.io);
    const failure = await runLock('ios', PHONE, { wait: '61' }, h.deps);
    assert('code' in failure);
    const waiting = h.note.filter((line) => line.includes('waiting for'));
    expect(waiting).toHaveLength(3);
    expect(waiting[0]).toMatch(new RegExp(`waiting for ${OTHER_ROOT} to release Old iPhone`));
    expect(h.out).toEqual([]);
  });

  test('a bad platform, --for and --wait are all STIM_BAD_ARG, before any device is listed', async () => {
    const listed: number[] = [];
    const h = harness({
      listIosDevices: () => {
        listed.push(1);
        return [];
      },
    });

    const platform = await runLock('web', undefined, {}, h.deps);
    assert('code' in platform);
    expect(platform.code).toBe('STIM_BAD_ARG');
    expect(platform.message).toMatch(/takes ios or android/);

    for (const value of ['5', '0s', '9s', '31m', '5h', '1.5m']) {
      const bad = await runLock('ios', undefined, { for: value }, h.deps);
      assert('code' in bad);
      expect(bad.code).toBe('STIM_BAD_ARG');
    }

    const wait = await runLock('ios', undefined, { wait: 'soon' }, h.deps);
    assert('code' in wait);
    expect(wait.code).toBe('STIM_BAD_ARG');
    expect(wait.message).toMatch(/Invalid --wait value/);
    expect(listed).toEqual([]);
  });

  test('outside a project it refuses with STIM_NO_PROJECT', async () => {
    const h = harness({ findProjectRoot: () => null });
    const failure = await runLock('ios', undefined, { json: true }, h.deps);
    assert('code' in failure);
    expect(failure.code).toBe('STIM_NO_PROJECT');
    expect(JSON.parse(h.out[0] as string)).toEqual({
      code: 'STIM_NO_PROJECT',
      message: 'Not in a React Native project (no package.json found).',
      remedy: 'Run this from the app directory -- the one holding package.json.',
    });
  });
});

describe('stim device unlock', () => {
  test('it releases every lease this workspace holds, and names each on stdout', async () => {
    const h = harness();
    await runLock('ios', PHONE, {}, h.deps);
    await runLock('android', SERIAL, {}, h.deps);
    h.out.length = 0;

    const released = await runUnlock(undefined, {}, h.deps);
    assert(Array.isArray(released));
    expect(released.map((lease) => lease.platform).toSorted()).toEqual(['android', 'ios']);
    expect(h.out).toHaveLength(2);
    expect(h.out.join('\n')).toMatch(new RegExp(`unlocked Old iPhone \\(${PHONE}\\) -- the ios lease ran until`));
    expect(listLeaseFiles()).toEqual([]);
    expect(readWorkspaceState(root)?.deviceLeases).toBeUndefined();
  });

  test('a named platform releases only that lease', async () => {
    const h = harness();
    await runLock('ios', PHONE, {}, h.deps);
    await runLock('android', SERIAL, {}, h.deps);

    const released = await runUnlock('android', {}, h.deps);
    assert(Array.isArray(released));
    expect(released.map((lease) => lease.id)).toEqual([SERIAL]);
    expect(listLeaseFiles().map((entry) => entry.id)).toEqual([PHONE]);
  });

  test('a lease whose token this workspace lost is still released, by holder', async () => {
    const h = harness();
    await runLock('ios', PHONE, {}, h.deps);
    rmSync(join(home, 'workspaces'), { recursive: true, force: true });

    const released = await runUnlock(undefined, {}, h.deps);
    assert(Array.isArray(released));
    expect(released.map((lease) => lease.id)).toEqual([PHONE]);
    expect(listLeaseFiles()).toEqual([]);
  });

  test('releasing nothing is a stderr note and an empty JSON list, not an error', async () => {
    const h = harness();
    const released = await runUnlock(undefined, { json: true }, h.deps);
    assert(Array.isArray(released));
    expect(released).toEqual([]);
    expect(h.note.join('\n')).toMatch(new RegExp(`No device lease to release for ${root}`));
    expect(h.out).toEqual(['[]']);
  });

  test('--json carries the holder beside each released lease', async () => {
    const h = harness();
    const locked = await runLock('ios', PHONE, {}, h.deps);
    assert(!('code' in locked));
    h.out.length = 0;

    await runUnlock('ios', { json: true }, h.deps);
    expect(JSON.parse(h.out[0] as string)).toEqual([
      { platform: 'ios', id: PHONE, deviceName: 'Old iPhone', expiresAt: locked.expiresAt, holder: root },
    ]);
  });

  test('another workspace lease is never released', async () => {
    const h = harness();
    heldByAnother(h.io);
    const released = await runUnlock(undefined, {}, h.deps);
    assert(Array.isArray(released));
    expect(released).toEqual([]);
    expect(h.lease()?.holder).toBe(OTHER_ROOT);
  });

  test('a bad platform and no project are refused before anything is released', async () => {
    const h = harness();
    await runLock('ios', PHONE, {}, h.deps);

    const bad = await runUnlock('web', {}, h.deps);
    assert(!Array.isArray(bad));
    expect(bad.code).toBe('STIM_BAD_ARG');

    const outside = await runUnlock(undefined, {}, { ...h.deps, findProjectRoot: () => null });
    assert(!Array.isArray(outside));
    expect(outside.code).toBe('STIM_NO_PROJECT');
    expect(listLeaseFiles()).toHaveLength(1);
  });
});

describe('the command surface', () => {
  test('lock and unlock are registered under device, with the flags the guide lists', () => {
    const program = new Command();
    registerDevice(program);
    const device = program.commands.find((command) => command.name() === 'device');
    assert(device);
    expect(device.commands.map((command) => command.name()).toSorted()).toEqual(['lock', 'unlock']);

    const lock = device.commands.find((command) => command.name() === 'lock');
    assert(lock);
    expect(lock.options.map((option) => option.long).toSorted()).toEqual(['--for', '--json', '--wait']);
    expect(lock.usage()).toMatch(/<platform> \[id\]/);

    const unlock = device.commands.find((command) => command.name() === 'unlock');
    assert(unlock);
    expect(unlock.options.map((option) => option.long)).toEqual(['--json']);
    expect(unlock.usage()).toMatch(/\[platform\]/);
  });

  test('the grant and release lines read the same way the guide says they do', () => {
    const facts = {
      platform: 'ios' as const,
      id: PHONE,
      deviceName: null,
      holder: '/w/a',
      kind: 'declared',
      grantedAt: null,
      expiresAt: '2026-09-02T12:09:31.000Z',
      leaseSeconds: 300,
    };
    expect(grantLine(facts, '5m')).toMatch(new RegExp(`^locked ${PHONE} for /w/a until`));
    expect(releasedLine({ platform: 'android', id: SERIAL, deviceName: null, expiresAt: facts.expiresAt })).toMatch(
      new RegExp(`^unlocked ${SERIAL} -- the android lease ran until`),
    );
  });
});
