import { expect, test } from 'vitest';
import { parseDevicectlDevices, resolveIosPhysicalDevice, type IosDeviceEntry } from '../engine/ios-device.ts';
import { hostLanCandidates, lanCandidates } from '../engine/lan-address.ts';

const PHONE = '00008030-001A2B3C4D5E802E';
const OTHER = '00008120-000A11223C44201E';

function payload(devices: unknown[]): string {
  return JSON.stringify({
    info: { jsonVersion: 3, outcome: 'success' },
    result: { devices },
  });
}

function device(udid: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    hardwareProperties: { udid, platform: 'iOS' },
    deviceProperties: { name: `Phone ${udid.slice(-4)}`, bootState: 'booted', developerModeStatus: 'enabled' },
    connectionProperties: { pairingState: 'paired', transportType: 'wired' },
    ...overrides,
  };
}

function entry(overrides: Partial<IosDeviceEntry> = {}): IosDeviceEntry {
  return {
    udid: PHONE,
    name: 'Test Phone',
    bootState: 'booted',
    developerModeStatus: 'enabled',
    pairingState: 'paired',
    transportType: 'wired',
    ...overrides,
  };
}

test('parseDevicectlDevices reads the fields devicectl -j actually nests', () => {
  expect(parseDevicectlDevices(payload([device(PHONE)]))).toEqual([
    {
      udid: PHONE,
      name: 'Phone 802E',
      bootState: 'booted',
      developerModeStatus: 'enabled',
      pairingState: 'paired',
      transportType: 'wired',
    },
  ]);
});

test('parseDevicectlDevices tolerates the empty list a Mac with no phone produces', () => {
  expect(parseDevicectlDevices(payload([]))).toEqual([]);
  expect(parseDevicectlDevices('{"info":{}}')).toEqual([]);
  expect(parseDevicectlDevices('not json')).toEqual([]);
  expect(parseDevicectlDevices(null)).toEqual([]);
});

test('parseDevicectlDevices drops entries with no udid and defaults a missing name', () => {
  const parsed = parseDevicectlDevices(
    payload([{ deviceProperties: { name: 'nameless' } }, { hardwareProperties: { udid: OTHER } }]),
  );
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({ udid: OTHER, name: OTHER, developerModeStatus: null, pairingState: null });
});

test('parseDevicectlDevices accepts an already-parsed object', () => {
  expect(parseDevicectlDevices(JSON.parse(payload([device(PHONE)])))).toHaveLength(1);
});

test('resolveIosPhysicalDevice uses the one connected device when none is named', () => {
  expect(resolveIosPhysicalDevice(null, [entry()])).toEqual({ udid: PHONE, name: 'Test Phone' });
});

test('resolveIosPhysicalDevice refuses an ambiguous selection and lists the candidates', () => {
  const refusal = resolveIosPhysicalDevice(null, [entry(), entry({ udid: OTHER, name: 'Second' })]);
  expect(refusal.udid).toBeUndefined();
  expect(refusal.error).toContain(PHONE);
  expect(refusal.error).toContain(OTHER);
  expect(refusal.remedy).toContain('stim ios --device <udid>');
});

test('resolveIosPhysicalDevice refuses when nothing is connected', () => {
  const refusal = resolveIosPhysicalDevice(null, []);
  expect(refusal.udid).toBeUndefined();
  expect(refusal.error).toMatch(/No physical iOS device/);
  expect(refusal.remedy).toMatch(/Developer Mode/);
});

test('resolveIosPhysicalDevice matches a named udid case-insensitively', () => {
  expect(resolveIosPhysicalDevice(PHONE.toLowerCase(), [entry()])).toEqual({ udid: PHONE, name: 'Test Phone' });
});

test('resolveIosPhysicalDevice names what is connected when the requested udid is not', () => {
  const refusal = resolveIosPhysicalDevice(OTHER, [entry()]);
  expect(refusal.error).toContain(OTHER);
  expect(refusal.error).toContain(PHONE);
  const empty = resolveIosPhysicalDevice(OTHER, []);
  expect(empty.error).toMatch(/no device at all/);
});

test('resolveIosPhysicalDevice refuses an unpaired phone and a phone without Developer Mode', () => {
  const unpaired = resolveIosPhysicalDevice(null, [entry({ pairingState: 'unpaired' })]);
  expect(unpaired.udid).toBeUndefined();
  expect(unpaired.remedy).toMatch(/Trust/);

  const noDevMode = resolveIosPhysicalDevice(null, [entry({ developerModeStatus: 'disabled' })]);
  expect(noDevMode.udid).toBeUndefined();
  expect(noDevMode.remedy).toMatch(/Developer Mode/);
});

test('resolveIosPhysicalDevice does not invent a health problem from absent fields', () => {
  expect(resolveIosPhysicalDevice(null, [entry({ pairingState: null, developerModeStatus: null })])).toEqual({
    udid: PHONE,
    name: 'Test Phone',
  });
});

test('lanCandidates orders en0 first and the remaining en* by index', () => {
  expect(
    lanCandidates({
      en3: [{ family: 'IPv4', address: '10.0.3.5', internal: false }],
      en0: [{ family: 'IPv4', address: '10.0.0.5', internal: false }],
      en10: [{ family: 'IPv4', address: '10.0.10.5', internal: false }],
      en1: [{ family: 'IPv4', address: '10.0.1.5', internal: false }],
    }).map((c) => c.interfaceName),
  ).toEqual(['en0', 'en1', 'en3', 'en10']);
});

test('lanCandidates keeps a non-en interface but ranks it after every en*', () => {
  expect(
    lanCandidates({
      anpi0: [{ family: 'IPv4', address: '10.9.9.9', internal: false }],
      en1: [{ family: 'IPv4', address: '10.0.1.5', internal: false }],
    }).map((c) => c.interfaceName),
  ).toEqual(['en1', 'anpi0']);
});

test('lanCandidates drops loopback, IPv6, link-local, and the tunnel interfaces', () => {
  expect(
    lanCandidates({
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      en0: [
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv4', address: '169.254.10.1', internal: false },
      ],
      utun4: [{ family: 'IPv4', address: '100.72.66.29', internal: false }],
      bridge0: [{ family: 'IPv4', address: '192.168.64.1', internal: false }],
      awdl0: [{ family: 'IPv4', address: '169.254.9.9', internal: false }],
      en1: [{ family: 'IPv4', address: '10.0.0.132', internal: false }],
    }),
  ).toEqual([{ interfaceName: 'en1', address: '10.0.0.132' }]);
});

test('lanCandidates accepts the numeric family newer Node reports and dedupes addresses', () => {
  expect(
    lanCandidates({
      en0: [
        { family: 4, address: '10.0.0.7', internal: false },
        { family: 4, address: '10.0.0.7', internal: false },
      ],
      en2: [{ family: 4, address: '10.0.0.7', internal: false }],
    }),
  ).toEqual([{ interfaceName: 'en0', address: '10.0.0.7' }]);
});

test('lanCandidates returns nothing for an offline host', () => {
  expect(lanCandidates({ lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] })).toEqual([]);
  expect(lanCandidates(null)).toEqual([]);
});

test('hostLanCandidates is lanCandidates over the host os.networkInterfaces()', () => {
  const interfaces = {
    en0: [{ family: 'IPv4', address: '10.1.2.3', internal: false }],
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  };
  expect(hostLanCandidates(() => interfaces as never)).toEqual([{ interfaceName: 'en0', address: '10.1.2.3' }]);
  for (const candidate of hostLanCandidates()) {
    expect(candidate.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(candidate.interfaceName.length).toBeGreaterThan(0);
  }
});
