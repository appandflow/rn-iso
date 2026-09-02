import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  awaitIosDeviceLaunch,
  collectorRecordsFor,
  deviceProcessPid,
  installIosDeviceApp,
  iosDeviceProcess,
  iosInstallFailureKind,
  iosInstallRemedy,
  iosLaunchRefusalKind,
  iosLaunchRemedy,
  listIosDevices,
  localNetworkPending,
  parseDevicectlDevices,
  parseDeviceProcesses,
  iosPoolNoCandidatesRefusal,
  resolveIosPhysicalDevice,
  verifyIosDeviceReleaseLaunch,
  type IosDeviceEntry,
} from '../engine/ios-device.ts';
import { deviceConsoleLevel, parseDeviceConsoleLine } from '../collector/ios-device.ts';
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
  expect(empty.error).toMatch(/no cabled device at all/);
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

test('iosPoolNoCandidatesRefusal names each unhealthy cabled device with its own reason, not the count message', () => {
  const refusal = iosPoolNoCandidatesRefusal([
    entry({ developerModeStatus: 'disabled' }),
    entry({ udid: OTHER, name: 'Second', pairingState: 'unpaired' }),
  ]);
  expect(refusal.udid).toBeUndefined();
  expect(refusal.error).toContain(resolveIosPhysicalDevice(null, [entry({ developerModeStatus: 'disabled' })]).error);
  expect(refusal.error).toContain(
    resolveIosPhysicalDevice(null, [entry({ udid: OTHER, name: 'Second', pairingState: 'unpaired' })]).error,
  );
  expect(refusal.error).not.toMatch(/Several devices are connected/);
  expect(refusal.remedy).toMatch(/Developer Mode/);
  expect(refusal.remedy).toMatch(/Trust/);
});

test('iosPoolNoCandidatesRefusal falls back to the resolver when nothing is cabled', () => {
  expect(iosPoolNoCandidatesRefusal([])).toEqual(resolveIosPhysicalDevice(null, []));
  const wireless = entry({ transportType: 'localNetwork' });
  expect(iosPoolNoCandidatesRefusal([wireless])).toEqual(resolveIosPhysicalDevice(null, [wireless]));
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

test('a phone reachable only over the network is refused: v1 installs over the cable', () => {
  const wireless = entry({ transportType: 'localNetwork' });
  const refused = resolveIosPhysicalDevice(null, [wireless]);
  expect(refused.udid).toBeUndefined();
  expect(refused.error).toContain('localNetwork');
  expect(refused.remedy).toMatch(/cable/);

  const named = resolveIosPhysicalDevice(PHONE, [wireless]);
  expect(named.udid).toBeUndefined();
  expect(named.error).toContain('not a cable');
});

test('a wireless phone is not a candidate, so a single cabled one is still unambiguous', () => {
  expect(
    resolveIosPhysicalDevice(null, [entry({ udid: OTHER, name: 'Wireless', transportType: 'localNetwork' }), entry()]),
  ).toEqual({ udid: PHONE, name: 'Test Phone' });
});

test('an absent transportType is not treated as wireless', () => {
  expect(resolveIosPhysicalDevice(null, [entry({ transportType: null })])).toEqual({ udid: PHONE, name: 'Test Phone' });
  expect(resolveIosPhysicalDevice(null, [entry({ transportType: 'USB' })])).toEqual({
    udid: PHONE,
    name: 'Test Phone',
  });
});

test('listIosDevices runs devicectl into a temp file, parses it, and removes the directory', () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  let outPath = '';
  setExecutor({
    runFile(file: string, args: string[]) {
      calls.push({ file, args });
      outPath = args[args.length - 1] as string;
      writeFileSync(outPath, payload([device(PHONE)]));
      return '';
    },
  });
  try {
    expect(listIosDevices()).toEqual([
      {
        udid: PHONE,
        name: 'Phone 802E',
        bootState: 'booted',
        developerModeStatus: 'enabled',
        pairingState: 'paired',
        transportType: 'wired',
      },
    ]);
  } finally {
    resetExecutor();
  }
  expect(calls).toHaveLength(1);
  expect(calls[0]?.file).toBe('xcrun');
  expect(calls[0]?.args.slice(0, 4)).toEqual(['devicectl', 'list', 'devices', '-j']);
  expect(outPath.startsWith(tmpdir()) || outPath.startsWith('/private')).toBe(true);
  expect(existsSync(outPath)).toBe(false);
  expect(readdirSync(tmpdir()).some((e) => e.startsWith('stim-devicectl-') && existsSync(join(tmpdir(), e)))).toBe(
    false,
  );
});

test('listIosDevices reports no devices when devicectl fails, and still cleans up', () => {
  let outPath = '';
  setExecutor({
    runFile(_file: string, args: string[]) {
      outPath = args[args.length - 1] as string;
      throw new Error('xcrun: devicectl is not available');
    },
  });
  try {
    expect(listIosDevices()).toEqual([]);
  } finally {
    resetExecutor();
  }
  expect(existsSync(outPath)).toBe(false);
});

function devicectlAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  return getExecutor().runQuiet('command -v xcrun') !== null;
}

const LIVE = devicectlAvailable() ? false : 'xcrun is not available on this machine';

const APP = '/private/var/containers/Bundle/Application/9C1/Fixture.app/Fixture';

function processPayload(processes: unknown[]): string {
  return JSON.stringify({
    info: { outcome: 'success' },
    result: { deviceIdentifier: 'X', runningProcesses: processes },
  });
}

test('parseDeviceProcesses reads the pid and executable devicectl nests, and drops the rest', () => {
  const parsed = parseDeviceProcesses(
    processPayload([
      { executable: 'file:///sbin/launchd', processIdentifier: 1 },
      { executable: `file://${APP}`, processIdentifier: 767 },
      { processIdentifier: 88 },
      { executable: 'file:///usr/libexec/logd' },
      { executable: 'file:///bin/x', processIdentifier: 0 },
    ]),
  );
  expect(parsed).toEqual([
    { pid: 1, executable: 'file:///sbin/launchd' },
    { pid: 767, executable: `file://${APP}` },
  ]);
});

test('parseDeviceProcesses tolerates junk instead of throwing', () => {
  expect(parseDeviceProcesses('not json')).toEqual([]);
  expect(parseDeviceProcesses({ result: {} })).toEqual([]);
  expect(parseDeviceProcesses(null)).toEqual([]);
});

test('deviceProcessPid matches the app bundle, not a process that merely mentions it', () => {
  const processes = [
    { pid: 12, executable: 'file:///usr/libexec/Fixture-helper' },
    { pid: 767, executable: `file://${APP}` },
  ];
  expect(deviceProcessPid(processes, 'Fixture')).toBe(767);
  expect(deviceProcessPid(processes, 'Other')).toBe(null);
  expect(deviceProcessPid([], 'Fixture')).toBe(null);
});

test('iosDeviceProcess passes the udid and cleans its temp directory up', () => {
  const calls: string[][] = [];
  let outPath = '';
  setExecutor({
    runFile(_file: string, args: string[]) {
      calls.push(args);
      outPath = args[args.length - 1] as string;
      writeFileSync(outPath, processPayload([{ executable: `file://${APP}`, processIdentifier: 767 }]));
      return '';
    },
  });
  try {
    expect(iosDeviceProcess({ udid: PHONE, appName: 'Fixture' })).toBe(767);
  } finally {
    resetExecutor();
  }
  expect(calls[0]?.slice(0, 6)).toEqual(['devicectl', 'device', 'info', 'processes', '--device', PHONE]);
  expect(existsSync(outPath)).toBe(false);
});

test('iosDeviceProcess reports undefined -- not "gone" -- when the probe itself fails', () => {
  setExecutor({
    runFile() {
      throw new Error('devicectl: device not found');
    },
  });
  try {
    expect(iosDeviceProcess({ udid: PHONE, appName: 'Fixture' })).toBe(undefined);
  } finally {
    resetExecutor();
  }
});

test('iosInstallFailureKind names the causes devicectl reports, and nothing it does not', () => {
  expect(
    iosInstallFailureKind(
      "Upgrade's application-identifier entitlement string (TEAM.com.x) does not match installed application's",
    ),
  ).toBe('signer');
  expect(iosInstallFailureKind('MismatchedApplicationIdentifierEntitlement')).toBe('signer');
  expect(iosInstallFailureKind('The device is locked.')).toBe('locked');
  expect(iosInstallFailureKind('The device is not paired with this host.')).toBe('untrusted-host');
  expect(iosInstallFailureKind('Developer Mode is disabled on this device.')).toBe('developer-mode');
  expect(iosInstallFailureKind('There is not enough disk space on the device.')).toBe('storage');
  expect(iosInstallFailureKind('some other failure')).toBe(null);
  expect(iosInstallFailureKind(undefined)).toBe(null);
});

test('installIosDeviceApp installs once and reports the path it installed', () => {
  const calls: string[][] = [];
  setExecutor({
    runFile(_file: string, args: string[]) {
      calls.push(args);
      return '';
    },
  });
  try {
    expect(installIosDeviceApp({ udid: PHONE, appPath: '/tmp/Fixture.app', bundleId: 'com.example.app' })).toEqual({
      ok: true,
      appPath: '/tmp/Fixture.app',
    });
  } finally {
    resetExecutor();
  }
  expect(calls).toEqual([['devicectl', 'device', 'install', 'app', '--device', PHONE, '/tmp/Fixture.app']]);
});

test('a signer conflict uninstalls once, retries once, and says the data went with it', () => {
  const calls: string[][] = [];
  setExecutor({
    runFile(_file: string, args: string[]) {
      calls.push(args);
      if (args[2] === 'install' && calls.filter((c) => c[2] === 'install').length === 1) {
        throw new Error('MismatchedApplicationIdentifierEntitlement');
      }
      return '';
    },
  });
  let result;
  try {
    result = installIosDeviceApp({ udid: PHONE, appPath: '/tmp/Fixture.app', bundleId: 'com.example.app' });
  } finally {
    resetExecutor();
  }
  expect(result.ok).toBe(true);
  expect(result.uninstalled).toBe(true);
  expect(result.note).toMatch(/its data went with it/);
  expect(calls.map((c) => c[2])).toEqual(['install', 'uninstall', 'install']);
  expect(calls[1]).toEqual(['devicectl', 'device', 'uninstall', 'app', '--device', PHONE, 'com.example.app']);
});

test("a failure that is not a signer conflict never uninstalls the user's app", () => {
  const calls: string[][] = [];
  setExecutor({
    runFile(_file: string, args: string[]) {
      calls.push(args);
      throw new Error('The device is locked.');
    },
  });
  let result;
  try {
    result = installIosDeviceApp({ udid: PHONE, appPath: '/tmp/Fixture.app', bundleId: 'com.example.app' });
  } finally {
    resetExecutor();
  }
  expect(result.failed).toBe(true);
  expect(result.code).toBe('STIM_INSTALL_FAILED');
  expect(result.remedy).toBe(iosInstallRemedy('locked', { udid: PHONE, bundleId: 'com.example.app' }));
  expect(calls.map((c) => c[2])).toEqual(['install']);
});

test('iosLaunchRefusalKind reads the untrusted-developer refusal a real phone produced', () => {
  const refusal = readFileSync(
    new URL('./fixtures/ios-device/launch-untrusted-developer.txt', import.meta.url),
    'utf-8',
  );
  expect(iosLaunchRefusalKind(refusal)).toBe('untrusted-developer');
  const carriers = refusal
    .split('\n')
    .filter((line) =>
      /profile has not been explicitly trusted|FBSOpenApplicationErrorDomain error 3|for reason: Security/.test(line),
    );
  expect(carriers.length).toBeGreaterThan(0);
  for (const line of carriers) expect(iosLaunchRefusalKind(line)).toBe('untrusted-developer');
  expect(iosLaunchRefusalKind('the device is locked')).toBe('locked');
  expect(iosLaunchRefusalKind('nothing recognisable')).toBe(null);
});

// The domain, the code and the reason are printed on separate lines of one
// error block, so a classifier that tested the joined text could pair a code
// from one line with a reason from another.
test('iosLaunchRefusalKind never pairs a code on one line with a reason on another', () => {
  expect(iosLaunchRefusalKind('FBSOpenApplicationErrorDomain error 7\nBSErrorCodeDescription = Security')).toBe(null);
  expect(iosLaunchRefusalKind('the app logged 3 things\nSecurity checks passed')).toBe(null);
  expect(iosLaunchRefusalKind('BSErrorCodeDescription = Security')).toBe(null);
});

test('the untrusted-developer remedy names the Settings screen that fixes it', () => {
  expect(iosLaunchRemedy('untrusted-developer', { udid: PHONE, bundleId: 'com.example.app' })).toMatch(
    /Settings > General > VPN & Device Management/,
  );
});

test('collectorRecordsFor ignores the predecessor a fresh run just signalled', () => {
  const records = [
    { ts: 1, event: 'collector_stopped', msg: 'device log collector received SIGTERM; detaching' },
    { ts: 2, event: 'collector_started', msg: 'device log collector pid 99 launching com.example.app on device X' },
    { ts: 3, msg: 'hello' },
  ];
  expect(collectorRecordsFor(records, 99).map((r) => r.ts)).toEqual([2, 3]);
  expect(collectorRecordsFor(records, 12)).toEqual([]);
  expect(collectorRecordsFor(records, null)).toEqual([]);
});

test('awaitIosDeviceLaunch returns the device pid as soon as the phone reports it', async () => {
  const pids = [null, null, 767];
  const result = await awaitIosDeviceLaunch({
    udid: PHONE,
    bundleId: 'com.example.app',
    appName: 'Fixture',
    collectorPid: 99,
    readRecords: () => [],
    probe: () => pids.shift() ?? null,
    sleep: async () => {},
    pollMs: 0,
  });
  expect(result).toEqual({ pid: 767 });
});

test('a console that ends before the app appears is a launch failure with its own evidence', async () => {
  const result = await awaitIosDeviceLaunch({
    udid: PHONE,
    bundleId: 'com.example.app',
    appName: 'Fixture',
    collectorPid: 99,
    readRecords: () => [
      { ts: 1, event: 'collector_started', msg: 'device log collector pid 99 launching com.example.app on device X' },
      {
        ts: 2,
        msg:
          'The operation could not be completed. Unable to launch com.example.app because it has an invalid code ' +
          'signature, inadequate entitlements or its profile has not been explicitly trusted by the user. ' +
          '(FBSOpenApplicationErrorDomain error 3 (0x03))',
      },
      { ts: 3, event: 'collector_failed', msg: 'the devicectl console ended with exit code 1' },
    ],
    probe: () => null,
    sleep: async () => {},
  });
  expect(result.failed).toBe(true);
  expect(result.remedy).toMatch(/VPN & Device Management/);
  expect(result.lines?.join('\n')).toMatch(/FBSOpenApplicationErrorDomain/);
});

test('a launch nothing reports at all times out with the generic devicectl remedy', async () => {
  let clock = 0;
  const result = await awaitIosDeviceLaunch({
    udid: PHONE,
    bundleId: 'com.example.app',
    appName: 'Fixture',
    collectorPid: 99,
    readRecords: () => [],
    probe: () => null,
    timeoutMs: 10,
    pollMs: 5,
    now: () => (clock += 5),
    sleep: async () => {},
  });
  expect(result.failed).toBe(true);
  expect(result.remedy).toMatch(/devicectl device process launch --console/);
});

test('verifyIosDeviceReleaseLaunch re-probes the phone rather than a host pid', async () => {
  const alive = await verifyIosDeviceReleaseLaunch({
    udid: PHONE,
    appName: 'Fixture',
    waitMs: 0,
    probe: () => 767,
    sleep: async () => {},
  });
  expect(alive.verified).toBe(true);
  expect(alive.pid).toBe(767);

  const gone = await verifyIosDeviceReleaseLaunch({
    udid: PHONE,
    appName: 'Fixture',
    waitMs: 0,
    probe: () => null,
    sleep: async () => {},
  });
  expect(gone).toMatchObject({ verified: false, reason: 'exited', pid: null });

  const blind = await verifyIosDeviceReleaseLaunch({
    udid: PHONE,
    appName: 'Fixture',
    waitMs: 0,
    probe: () => undefined,
    sleep: async () => {},
  });
  expect(blind).toMatchObject({ verified: false, reason: 'probe-failed' });
});

const LAN_ORIGIN = 'http://10.0.0.132:8082';
const APP_PID = 909;

function fixtureLines(name: string): string[] {
  return readFileSync(new URL(`./fixtures/ios-device/${name}`, import.meta.url), 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function deviceRecords(lines: readonly string[], { ts = 2000, pid = APP_PID }: { ts?: number; pid?: number } = {}) {
  return lines.map((msg) => ({ ts, src: 'device', level: 'info', msg, proc: `Trailhead(${pid})`, raw: true }));
}

describe('localNetworkPending', () => {
  const pending = deviceRecords(fixtureLines('local-network-pending.txt'));

  test('matches the capture a phone produced while the prompt was up', () => {
    expect(localNetworkPending(pending, { since: 1000, pid: APP_PID, lanOrigin: LAN_ORIGIN })).toBe(true);
  });

  test('only the NWPath reason carries the match, and it survives the pid filter', () => {
    const carriers = pending.filter((record) => record.msg.includes('Local network prohibited'));
    expect(carriers.length).toBeGreaterThan(0);
    for (const record of carriers) {
      expect(record.proc).toBe(`Trailhead(${APP_PID})`);
      expect(localNetworkPending([record], { since: 0, pid: APP_PID, lanOrigin: LAN_ORIGIN })).toBe(true);
    }
    for (const record of pending.filter((r) => !r.msg.includes('Local network prohibited'))) {
      expect(localNetworkPending([record], { since: 0, pid: APP_PID, lanOrigin: LAN_ORIGIN })).toBe(false);
    }
  });

  test('a refused connection, unrelated nw_ noise, and the sibling NWPath reasons are not it', () => {
    const negatives = deviceRecords(fixtureLines('local-network-negatives.txt'));
    expect(localNetworkPending(negatives, { since: 0, pid: APP_PID, lanOrigin: LAN_ORIGIN })).toBe(false);
    for (const record of negatives) {
      expect(localNetworkPending([record], { since: 0, pid: APP_PID, lanOrigin: LAN_ORIGIN })).toBe(false);
    }
  });

  test('the two errno-50 reasons that are NOT the permission are in that fixture', () => {
    const negatives = fixtureLines('local-network-negatives.txt');
    for (const reason of ['unsatisfied (No network route)', 'unsatisfied (Denied over cellular interface)']) {
      const line = negatives.find((candidate) => candidate.includes(reason));
      expect(line).toBeTruthy();
      expect(line).toContain('_kCFStreamErrorCodeKey=50');
      expect(line).toContain('Code=-1009');
      expect(localNetworkPending(deviceRecords([line!]), { since: 0, pid: APP_PID, lanOrigin: LAN_ORIGIN })).toBe(
        false,
      );
    }
  });

  test('records from before this launch and from another process do not count', () => {
    const scope = { pid: APP_PID, lanOrigin: LAN_ORIGIN };
    expect(
      localNetworkPending(deviceRecords(fixtureLines('local-network-pending.txt'), { ts: 999 }), {
        ...scope,
        since: 1000,
      }),
    ).toBe(false);
    expect(
      localNetworkPending(deviceRecords(fixtureLines('local-network-pending.txt'), { pid: 42 }), {
        ...scope,
        since: 1000,
      }),
    ).toBe(false);
    expect(
      localNetworkPending(deviceRecords(fixtureLines('local-network-pending.txt'), { pid: 42 }), {
        since: 1000,
        pid: null,
        lanOrigin: LAN_ORIGIN,
      }),
    ).toBe(true);
  });

  test('no LAN origin means no verdict', () => {
    expect(localNetworkPending(pending, { since: 0, pid: APP_PID, lanOrigin: null })).toBe(false);
  });

  test('the capture stays info, so nothing new reaches `logs --errors`', () => {
    for (const line of fixtureLines('local-network-pending.txt')) {
      expect(deviceConsoleLevel(line)).toBe('info');
      expect(parseDeviceConsoleLine(line)?.level).toBe('info');
    }
    const before = JSON.stringify(pending);
    localNetworkPending(pending, { since: 0, pid: APP_PID, lanOrigin: LAN_ORIGIN });
    expect(JSON.stringify(pending)).toBe(before);
  });
});

describe('listIosDevices against a real devicectl', { skip: LIVE as unknown as boolean }, () => {
  test('the argv is accepted and every entry it returns is well formed', () => {
    resetExecutor();
    const devices = listIosDevices();
    expect(Array.isArray(devices)).toBe(true);
    for (const found of devices) {
      expect(found.udid.length).toBeGreaterThan(0);
      expect(found.name.length).toBeGreaterThan(0);
    }
    expect(readdirSync(tmpdir()).filter((e) => e.startsWith('stim-devicectl-'))).toEqual([]);
  }, 60_000);

  test('the process-probe argv is accepted by the real devicectl when a phone is connected', () => {
    resetExecutor();
    const [connected] = listIosDevices();
    if (!connected) return;
    const pid = iosDeviceProcess({ udid: connected.udid, appName: 'NoSuchAppStimWouldEverBuild' });
    expect(pid).toBe(null);
  }, 120_000);
});
