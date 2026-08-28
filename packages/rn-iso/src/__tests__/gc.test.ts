import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../exec.ts';
import { saveConfig, loadConfig } from '../config.ts';
import { register } from '../cache-manifest.ts';
import gcCommand, {
  collectGcReport,
  describeUnverifiableDevices,
  findOrphanedDevices,
  findStaleDeviceRecords,
  findStaleProjectDevices,
  formatGcReport,
  runGc,
} from '../commands/gc.ts';
import { makeConfig, makeIosSim, makeCacheDescriptor, makeBuildLock, makeBuildSlot } from './_factories.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

test('names skipped entries and why they were skipped', () => {
  const lines = formatGcReport({
    skipped: [{ dir: '/Volumes/ExternalSSD/proj', reason: 'volume /Volumes/ExternalSSD is not mounted' }],
    deadProjects: [],
  }).join('\n');
  expect(lines).toMatch(/not mounted/);
  expect(lines).toMatch(/skipped/i);
});

test('says nothing to reclaim when everything is clean', () => {
  const lines = formatGcReport({ skipped: [], deadProjects: [] }).join('\n');
  expect(lines).toMatch(/nothing to reclaim/i);
});

test('lists dead project entries', () => {
  const lines = formatGcReport({
    skipped: [],
    deadProjects: ['/gone/proj'],
  }).join('\n');
  expect(lines).toMatch(/\/gone\/proj/);
  expect(lines).toMatch(/Dead project entries/);
});

test('headline does not claim "nothing to reclaim" without flagging unchecked entries', () => {
  const lines = formatGcReport({
    skipped: [{ dir: '/Volumes/ExternalSSD/proj', reason: 'volume /Volumes/ExternalSSD is not mounted' }],
    deadProjects: [],
  }).join('\n');
  const headline = lines.split('\n')[0];
  expect(headline).not.toMatch(/^Nothing to reclaim\.$/);
  expect(headline).toMatch(/could not be checked/i);
});

test('the cache report says which caches were registered and which were detected', () => {
  const lines = formatGcReport({
    skipped: [],
    deadProjects: [],
    caches: [
      makeCacheDescriptor({
        name: 'Metro transforms',
        dir: '/c/metro',
        note: 'from a metro.config.js',
        bytes: 2048,
        source: 'registered',
      }),
      makeCacheDescriptor({
        name: 'Xcode compilation cache',
        dir: '/c/cas',
        note: 'index-backed',
        bytes: 4096,
        source: 'detected',
      }),
    ],
  }).join('\n');
  expect(lines).toMatch(/Metro transforms.*registered/);
  expect(lines).toMatch(/Xcode compilation cache.*detected/);
});

test('findOrphanedDevices proposes only rn-iso devices absent from config', () => {
  const result = findOrphanedDevices({
    sims: [
      makeIosSim({ udid: 'U1', name: 'rn-iso-gone' }),
      makeIosSim({ udid: 'U2', name: 'rn-iso-live' }),
      makeIosSim({ udid: 'U3', name: 'iPhone 17 Pro' }),
    ],
    avds: ['rn-iso-old', 'Pixel_7'],
    config: makeConfig({
      projects: {
        '/p': {
          platforms: {
            ios: { deviceUdid: 'U2', owned: true },
            android: { avdName: 'rn-iso-kept', owned: true },
          },
        },
      },
    }),
    isMounted: () => true,
  });
  expect(result.orphaned.map((o) => o.id).toSorted()).toEqual(['U1', 'rn-iso-old']);
});

test('devices referenced by a project on an unmounted volume are kept', () => {
  const result = findOrphanedDevices({
    sims: [makeIosSim({ udid: 'U1', name: 'rn-iso-ext' })],
    avds: [],
    config: makeConfig({ projects: { '/Volumes/Ext/p': { platforms: { ios: { deviceUdid: 'U1', owned: true } } } } }),
    isMounted: () => false,
  });
  expect(result.orphaned.length).toBe(0);
  expect(result.kept[0]?.reason).toMatch(/not mounted/);
});

test('a device named by a non-owned (legacy/stale) record is still counted as referenced, not orphaned', () => {
  const result = findOrphanedDevices({
    sims: [makeIosSim({ udid: 'U1', name: 'rn-iso-stale-record' })],
    avds: ['rn-iso-stale-avd'],
    config: makeConfig({
      projects: {
        '/p': {
          platforms: {
            ios: { deviceUdid: 'U1' },
            android: { avdName: 'rn-iso-stale-avd' },
          },
        },
      },
    }),
    isMounted: () => true,
  });
  expect(result.orphaned.length).toBe(0);
});

test('a device owned only by a dead project is orphaned when that project is passed as deadProjects', () => {
  const result = findOrphanedDevices({
    sims: [makeIosSim({ udid: 'U1', name: 'rn-iso-dead' })],
    avds: [],
    config: makeConfig({ projects: { '/gone/p': { platforms: { ios: { deviceUdid: 'U1', owned: true } } } } }),
    isMounted: () => true,
    deadProjects: ['/gone/p'],
  });
  expect(result.orphaned.map((o) => o.id)).toEqual(['U1']);
});

const staleSims = [makeIosSim({ udid: 'U-STALE', name: 'rn-iso-stale' })];

function staleConfig(extra = {}) {
  return makeConfig({
    projects: {
      '/live/p': { platforms: { ios: { deviceUdid: 'U-STALE', owned: true } } },
      ...extra,
    },
  });
}

test('findStaleDeviceRecords reports a live project pointing at a device that is gone', () => {
  const stale = findStaleDeviceRecords({
    config: makeConfig({
      projects: {
        '/a': { platforms: { ios: { deviceUdid: 'GONE', owned: true } } },
        '/b': { platforms: { ios: { deviceUdid: 'HERE', owned: true } } },
        '/c': { platforms: { android: { avdName: 'rn-iso-gone', owned: true } } },
        '/d': { platforms: { android: { avdName: 'rn-iso-here', owned: true } } },
      },
    }),
    sims: [makeIosSim({ udid: 'HERE', name: 'rn-iso-b' })],
    avds: ['rn-iso-here'],
  });
  expect(stale.map((r) => [r.kind, r.id, r.project])).toEqual([
    ['ios', 'GONE', '/a'],
    ['android', 'rn-iso-gone', '/c'],
  ]);
});

test('findStaleDeviceRecords proposes nothing for a platform whose listing failed', () => {
  const config = makeConfig({
    projects: {
      '/a': { platforms: { ios: { deviceUdid: 'GONE' }, android: { avdName: 'rn-iso-gone' } } },
    },
  });
  expect(findStaleDeviceRecords({ config, sims: [], avds: [], simsChecked: false }).map((r) => r.kind)).toEqual([
    'android',
  ]);
  expect(findStaleDeviceRecords({ config, sims: [], avds: [], avdsChecked: false }).map((r) => r.kind)).toEqual([
    'ios',
  ]);
  expect(findStaleDeviceRecords({ config, simsChecked: false, avdsChecked: false })).toEqual([]);
});

test('findStaleDeviceRecords skips a project the dead-entry sweep already claimed', () => {
  const stale = findStaleDeviceRecords({
    config: makeConfig({ projects: { '/dead': { platforms: { ios: { deviceUdid: 'GONE' } } } } }),
    sims: [],
    deadProjects: ['/dead'],
  });
  expect(stale).toEqual([]);
});

test('findStaleDeviceRecords covers a non-owned record too, and reports its ownership', () => {
  const stale = findStaleDeviceRecords({
    config: makeConfig({ projects: { '/a': { platforms: { ios: { deviceUdid: 'GONE' } } } } }),
    sims: [],
  });
  expect(stale.map((r) => r.owned)).toEqual([false]);
});

test('findStaleDeviceRecords never calls a physical serial record stale', () => {
  expect(
    findStaleDeviceRecords({
      config: makeConfig({ projects: { '/a': { platforms: { android: { serial: 'R58M1234' } } } } }),
      avds: [],
    }),
  ).toEqual([]);
});

test('the report names stale device records and says the delete touches no device', () => {
  const lines = formatGcReport({
    staleDeviceRecords: [{ kind: 'ios', id: 'GONE', project: '/a', owned: false }],
  }).join('\n');
  expect(lines).toMatch(/Stale device records \(1\)/);
  expect(lines).toMatch(/ios GONE is not on this machine/);
  expect(lines).toMatch(/recorded by \/a/);
  expect(lines).toMatch(/RECORD only/);
  expect(lines).not.toMatch(/Nothing to reclaim/);
});

test('findStaleProjectDevices reaps an owned device whose project has not been touched', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: staleConfig(),
    sims: staleSims,
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => now - 90 * DAY_MS,
  });
  expect(stale.map((d) => d.id)).toEqual(['U-STALE']);
  expect(stale[0]?.project).toBe('/live/p');
});

test('findStaleProjectDevices leaves a recently touched project alone', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: staleConfig(),
    sims: staleSims,
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => now - 2 * DAY_MS,
  });
  expect(stale.length).toBe(0);
});

test('findStaleProjectDevices fails closed when a project timestamp cannot be read', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: staleConfig(),
    sims: staleSims,
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => NaN,
  });
  expect(stale.length).toBe(0);
});

test('findStaleProjectDevices ignores devices rn-iso does not own', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: makeConfig({ projects: { '/live/p': { platforms: { ios: { deviceUdid: 'U-STALE' } } } } }),
    sims: staleSims,
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => now - 90 * DAY_MS,
  });
  expect(stale.length).toBe(0);
});

test('findStaleProjectDevices only proposes devices present in the live listing', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: staleConfig(),
    sims: [],
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => now - 90 * DAY_MS,
  });
  expect(stale.length).toBe(0);
});

test('findStaleProjectDevices skips projects the dead-entry sweep already claimed', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: staleConfig(),
    sims: staleSims,
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => now - 90 * DAY_MS,
    deadProjects: ['/live/p'],
  });
  expect(stale.length).toBe(0);
});

let tmpHome: string;
let fakeHome: string;
let originalHome: string | undefined;
let originalTmpdir: string | undefined;

function currentConfig() {
  const cfg = loadConfig();
  assert(cfg, 'expected a config on disk');
  return cfg;
}

function installExecutor() {
  setExecutor({
    run(cmd) {
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet() {
      return null;
    },
    spawn(cmd) {
      throw new Error(`unexpected spawn: ${cmd}`);
    },
  });
}

async function cli(args: string[] = []) {
  const program = new Command();
  gcCommand(program);
  await program.parseAsync(['node', 'rn-iso', 'gc', ...args]);
}

async function sweepingGc(opts = {}) {
  await runGc({ unsafeAllowScopedDeviceSweep: true, ...opts });
}

function captureLog(fn: () => unknown) {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = originalLog;
    })
    .then(() => logs.join('\n'));
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;

  originalHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'rn-iso-fakehome-'));
  process.env.HOME = fakeHome;

  originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = fakeHome;
});

afterEach(() => {
  resetExecutor();
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

test('a bare gc leaves every registered entry in place', async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({
    version: 2,
    projects: { [localDeadPath]: { metroPort: 8101 } },
    repos: {},
  });
  installExecutor();

  const before = loadConfig();
  await cli();

  expect(currentConfig().projects[localDeadPath]).toBeTruthy();
  expect(loadConfig()).toEqual(before);
});

test('gc reports the three things that still orphan, and no DerivedData', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const report = await collectGcReport();

  expect(!('derivedData' in report)).toBeTruthy();
  expect('deadProjects' in report).toBeTruthy();
  expect('orphanedDevices' in report).toBeTruthy();
  expect('caches' in report).toBeTruthy();
});

test('a dead project on an unmounted volume is not unregistered', async () => {
  const unmountedPath = '/Volumes/RnIsoTestVolumeThatDoesNotExist/proj/gone';
  const localDeadPath = join(fakeHome, 'no-longer-here');

  saveConfig({
    version: 2,
    projects: {
      [unmountedPath]: { metroPort: 8100 },
      [localDeadPath]: { metroPort: 8101 },
    },
    repos: {},
  });
  installExecutor();

  await cli(['--delete']);

  const cfg = currentConfig();
  expect(cfg.projects[unmountedPath]).toBeTruthy();
  expect(cfg.projects[unmountedPath]?.metroPort).toBe(8100);
  expect(cfg.projects[localDeadPath]).toBe(undefined);
});

interface DeviceSpec {
  udid: string;
  name: string;
  state?: string;
}

function iosListJson(devices: DeviceSpec[]) {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-4': devices.map((d) => ({
        udid: d.udid,
        name: d.name,
        state: d.state || 'Shutdown',
        isAvailable: true,
      })),
    },
  });
}

interface InstallDeviceExecutorOptions {
  devices: DeviceSpec[];
  execCalls: string[];
  throwOnShutdownFor?: Set<string>;
}

function installDeviceExecutor({
  devices,
  execCalls,
  throwOnShutdownFor = new Set<string>(),
}: InstallDeviceExecutorOptions) {
  setExecutor({
    run(cmd) {
      execCalls.push(cmd);
      if (cmd.includes('simctl list devices --json')) return iosListJson(devices);
      if (cmd.startsWith('xcrun simctl delete ')) return '';
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet(cmd) {
      execCalls.push(cmd);
      if (cmd.includes('simctl list devices --json')) return iosListJson(devices);
      const shutdownMatch = cmd.match(/^xcrun simctl shutdown (.+)$/);
      if (shutdownMatch && throwOnShutdownFor.has(shutdownMatch[1])) {
        throw new Error(`simulated shutdown failure for ${shutdownMatch[1]}`);
      }
      return '';
    },
    spawn(cmd) {
      throw new Error(`unexpected spawn: ${cmd}`);
    },
  });
}

function touchedDaysAgo(dir: string, days: number) {
  mkdirSync(dir, { recursive: true });
  const when = new Date(Date.now() - days * DAY_MS);
  utimesSync(dir, when, when);
}

test('--delete re-verifies ownership before shutdown, shuts down before delete, and contains a per-device teardown throw', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-1', name: 'rn-iso-orphan-1' },
      { udid: 'UDID-2', name: 'rn-iso-orphan-2' },
    ],
    execCalls,
    throwOnShutdownFor: new Set(['UDID-1']),
  });
  saveConfig({ version: 2, projects: {}, repos: {} });

  await sweepingGc({ delete: true });

  const firstListIndex = execCalls.findIndex((c) => c.includes('simctl list devices --json'));
  const shutdown1Index = execCalls.findIndex((c) => c.startsWith('xcrun simctl shutdown UDID-1'));
  const shutdown2Index = execCalls.findIndex((c) => c.startsWith('xcrun simctl shutdown UDID-2'));
  const delete2Index = execCalls.findIndex((c) => c.startsWith('xcrun simctl delete UDID-2'));

  expect(firstListIndex !== -1).toBeTruthy();
  expect(firstListIndex < shutdown1Index).toBeTruthy();
  expect(shutdown2Index !== -1 && delete2Index !== -1).toBeTruthy();
  expect(shutdown2Index < delete2Index).toBeTruthy();
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-1'))).toBe(false);
});

test('report-mode gc lists a seeded orphaned ios sim but issues no shutdown or delete command', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-9', name: 'rn-iso-report-orphan' }],
    execCalls,
  });
  saveConfig({ version: 2, projects: {}, repos: {} });

  const output = await captureLog(() => sweepingGc({ delete: false }));

  expect(output).toMatch(/rn-iso-report-orphan/);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
});

test("--delete reaps a dead project's owned orphan device in the same run it prunes the entry", async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({
    version: 2,
    projects: {
      [localDeadPath]: {
        metroPort: 8100,
        platforms: { ios: { deviceUdid: 'UDID-DEAD', owned: true } },
      },
    },
    repos: {},
  });
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-DEAD', name: 'rn-iso-dead-owner' }],
    execCalls,
  });

  await sweepingGc({ delete: true });

  const cfg = currentConfig();
  expect(cfg.projects[localDeadPath]).toBe(undefined);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown UDID-DEAD'))).toBeTruthy();
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-DEAD'))).toBeTruthy();
});

test('gc with no config names rn-iso devices it cannot verify, but never touches them', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-LIVE', name: 'rn-iso-someones-live-env', state: 'Booted' }],
    execCalls,
  });

  const output = await captureLog(() => sweepingGc({ delete: true }));

  expect(output).toMatch(/rn-iso-someones-live-env/);
  expect(output).toMatch(/no rn-iso config found/i);
  expect(output).toMatch(/cannot be verified as orphaned/i);
  expect(output).not.toMatch(/Orphaned devices/i);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
});

test('a config scoped by RN_ISO_HOME never sweeps machine-global devices', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-REAL-1', name: 'rn-iso-real-env-1', state: 'Booted' },
      { udid: 'UDID-REAL-2', name: 'rn-iso-real-env-2' },
    ],
    execCalls,
  });
  const livePath = join(fakeHome, 'some-project');
  mkdirSync(livePath, { recursive: true });
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-ELSEWHERE', owned: true } } } },
    repos: {},
  });

  const output = await captureLog(() => cli(['--delete']));

  expect(output).not.toMatch(/Orphaned devices/i);
  expect(output).toMatch(/RN_ISO_HOME/);
  expect(output).toMatch(/rn-iso-real-env-1/);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
});

test('the RN_ISO_HOME guard does not disable dead-entry pruning', async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({ version: 2, projects: { [localDeadPath]: { metroPort: 8100 } }, repos: {} });
  installExecutor();

  await cli(['--delete']);

  expect(currentConfig().projects[localDeadPath]).toBe(undefined);
});

test('--delete --older-than reaps an owned device whose project went untouched, and clears its record', async () => {
  const stalePath = join(fakeHome, 'abandoned-project');
  touchedDaysAgo(stalePath, 90);
  saveConfig({
    version: 2,
    projects: { [stalePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-STALE', owned: true } } } },
    repos: {},
  });
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-STALE', name: 'rn-iso-abandoned' }],
    execCalls,
  });

  await sweepingGc({ delete: true, olderThan: 30 });

  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown UDID-STALE'))).toBeTruthy();
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-STALE'))).toBeTruthy();
  const cfg = currentConfig();
  expect(cfg.projects[stalePath]).toBeTruthy();
  expect(cfg.projects[stalePath]?.platforms?.ios).toBe(undefined);
});

test('gc reports a live project whose recorded sim is gone, and --delete clears the record only', async () => {
  const livePath = join(fakeHome, 'live-project');
  touchedDaysAgo(livePath, 1);
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-VANISHED', owned: true } } } },
    repos: {},
  });
  const execCalls: string[] = [];
  installDeviceExecutor({ devices: [], execCalls });

  const report = await captureLog(() => sweepingGc({ delete: false }));
  expect(report).toMatch(/Stale device records \(1\)/);
  expect(report).toMatch(/UDID-VANISHED/);
  expect(currentConfig().projects[livePath]?.platforms?.ios).toBeTruthy();

  const output = await captureLog(() => sweepingGc({ delete: true }));
  expect(output).toMatch(/Cleared the ios record/);
  const cfg = currentConfig();
  expect(cfg.projects[livePath]).toBeTruthy();
  expect(cfg.projects[livePath]?.platforms?.ios).toBe(undefined);
  expect(execCalls.some((c) => /simctl (shutdown|delete)/.test(c))).toBe(false);
  expect(execCalls.some((c) => /avdmanager delete/.test(c))).toBe(false);
});

test('a recorded sim that IS on the machine is not a stale record', async () => {
  const livePath = join(fakeHome, 'live-project');
  touchedDaysAgo(livePath, 1);
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-HERE', owned: true } } } },
    repos: {},
  });
  installDeviceExecutor({ devices: [{ udid: 'UDID-HERE', name: 'rn-iso-live' }], execCalls: [] });

  const output = await captureLog(() => sweepingGc({ delete: true }));
  expect(output).not.toMatch(/Stale device records/);
  expect(currentConfig().projects[livePath]?.platforms?.ios).toBeTruthy();
});

test('--older-than without --delete only reports the stale device', async () => {
  const stalePath = join(fakeHome, 'abandoned-project');
  touchedDaysAgo(stalePath, 90);
  saveConfig({
    version: 2,
    projects: { [stalePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-STALE', owned: true } } } },
    repos: {},
  });
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-STALE', name: 'rn-iso-abandoned' }],
    execCalls,
  });

  const output = await captureLog(() => sweepingGc({ delete: false, olderThan: 30 }));

  expect(output).toMatch(/rn-iso-abandoned/);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
  expect(currentConfig().projects[stalePath]?.platforms?.ios).toBeTruthy();
});

test('a device whose project is still being worked in is never reaped by --older-than', async () => {
  const livePath = join(fakeHome, 'live-project');
  touchedDaysAgo(livePath, 1);
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-LIVE', owned: true } } } },
    repos: {},
  });
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-LIVE', name: 'rn-iso-live' }],
    execCalls,
  });

  await sweepingGc({ delete: true, olderThan: 30 });

  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
  expect(currentConfig().projects[livePath]?.platforms?.ios).toBeTruthy();
});

test('a bare gc reports a registered cache with its size, without being asked for it', async () => {
  const cacheDir = join(fakeHome, 'my-cache');
  mkdirSync(join(cacheDir, 'entry-a'), { recursive: true });
  writeFileSync(join(cacheDir, 'entry-a', 'blob'), 'x'.repeat(1000));
  register({ dir: cacheDir, name: 'My cache', note: 'a test cache' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const output = await captureLog(() => cli());

  expect(output).toMatch(/My cache/);
  expect(output).toMatch(/registered/);
});

test('--delete on its own never touches a shared cache', async () => {
  const cacheDir = join(fakeHome, 'my-cache');
  const entry = join(cacheDir, 'entry-a');
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, 'blob'), 'x'.repeat(1000));
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(entry, old, old);
  register({ dir: cacheDir, name: 'My cache' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await cli(['--delete']);

  expect(existsSync(entry)).toBeTruthy();
});

test('--delete --older-than trims the cache entries nothing has touched', async () => {
  const cacheDir = join(fakeHome, 'my-cache');
  const oldEntry = join(cacheDir, 'entry-old');
  const freshEntry = join(cacheDir, 'entry-fresh');
  mkdirSync(oldEntry, { recursive: true });
  mkdirSync(freshEntry, { recursive: true });
  writeFileSync(join(oldEntry, 'blob'), 'x'.repeat(1000));
  writeFileSync(join(freshEntry, 'blob'), 'x'.repeat(1000));
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(oldEntry, old, old);
  register({ dir: cacheDir, name: 'My cache' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await cli(['--delete', '--older-than', '30']);

  expect(existsSync(oldEntry)).toBe(false);
  expect(existsSync(freshEntry)).toBeTruthy();
});

test('--delete --all empties an index-backed cache that --older-than cannot trim', async () => {
  const casDir = join(tmpHome, 'compilation-cache');
  const leaf = join(casDir, 'v9.data.leaf');
  const index = join(casDir, 'v4.actions');
  mkdirSync(casDir, { recursive: true });
  writeFileSync(leaf, 'x'.repeat(1000));
  writeFileSync(index, 'index');
  register({ dir: casDir, name: 'Xcode compilation cache', prune: 'atomic' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const report = await collectGcReport({ all: true });
  expect(report.caches.some((c) => c.prune === 'atomic' && c.willEmpty)).toBeTruthy();

  await captureLog(() => cli(['--delete', '--older-than', '30']));
  expect(existsSync(leaf)).toBeTruthy();

  await captureLog(() => cli(['--delete', '--all']));
  expect(existsSync(leaf)).toBe(false);
  expect(existsSync(index)).toBe(false);
});

test('--delete --all empties an entries-style cache including entries used today', async () => {
  const cacheDir = join(tmpHome, 'my-cache');
  const freshEntry = join(cacheDir, 'entry-fresh');
  mkdirSync(freshEntry, { recursive: true });
  writeFileSync(join(freshEntry, 'blob'), 'x'.repeat(1000));
  register({ dir: cacheDir, name: 'My cache' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await captureLog(() => cli(['--delete', '--all']));

  expect(existsSync(freshEntry)).toBe(false);
  expect(existsSync(cacheDir)).toBeTruthy();
});

test('--all without --delete reports what would be emptied and writes nothing', async () => {
  const casDir = join(tmpHome, 'compilation-cache');
  const leaf = join(casDir, 'v9.data.leaf');
  mkdirSync(casDir, { recursive: true });
  writeFileSync(leaf, 'x'.repeat(1000));
  register({ dir: casDir, name: 'Xcode compilation cache', prune: 'atomic' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const before = loadConfig();

  const output = await captureLog(() => cli(['--all']));

  expect(output).toMatch(/Xcode compilation cache/);
  expect(output).toMatch(/empt/i);
  expect(existsSync(leaf)).toBeTruthy();
  expect(loadConfig()).toEqual(before);
});

test('--delete --all under a scoped home refuses machine-global caches', async () => {
  const globalCas = join(fakeHome, 'Library', 'Developer', 'Xcode', 'DerivedData', 'CompilationCache.noindex');
  const leaf = join(globalCas, 'v9.data.leaf');
  mkdirSync(globalCas, { recursive: true });
  writeFileSync(leaf, 'x'.repeat(1000));
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const output = await captureLog(() => cli(['--delete', '--all']));

  expect(existsSync(leaf)).toBeTruthy();
  expect(output).toMatch(/RN_ISO_HOME/);
});

test('--delete --older-than under a scoped home refuses machine-global caches', async () => {
  const map = join(fakeHome, 'metro-file-map-abc123');
  writeFileSync(map, 'x'.repeat(1000));
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(map, old, old);
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const output = await captureLog(() => cli(['--delete', '--older-than', '30']));

  expect(existsSync(map)).toBeTruthy();
  expect(output).toMatch(/machine-global/);
});

test('--all reaches caches only: never a device, never a project entry', async () => {
  const livePath = join(fakeHome, 'live-project');
  mkdirSync(livePath, { recursive: true });
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-LIVE', owned: true } } } },
    repos: {},
  });
  const cacheDir = join(tmpHome, 'my-cache');
  const entry = join(cacheDir, 'entry-a');
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, 'blob'), 'x'.repeat(1000));
  register({ dir: cacheDir, name: 'My cache' });
  const execCalls: string[] = [];
  installDeviceExecutor({ devices: [{ udid: 'UDID-LIVE', name: 'rn-iso-live' }], execCalls });

  await captureLog(() => sweepingGc({ delete: true, all: true }));

  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
  const cfg = currentConfig();
  expect(cfg.projects[livePath]).toBeTruthy();
  expect(cfg.projects[livePath]?.platforms?.ios).toBeTruthy();
  expect(existsSync(entry)).toBe(false);
});

test('rejects a non-numeric --older-than instead of silently skipping every entry', async () => {
  const program = new Command();
  program.exitOverride();
  gcCommand(program);
  await expect(() => program.parseAsync(['node', 'rn-iso', 'gc', '--older-than', 'lastweek'])).rejects.toThrow(
    /must be a whole number of days/,
  );
});

test('describeUnverifiableDevices names rn-iso devices it cannot verify', () => {
  const notices = describeUnverifiableDevices(['rn-iso-alpha', 'iPhone 17 Pro'], ['rn-iso-beta', 'Pixel_6_API_34']);
  const joined = notices.join('\n');
  expect(joined).toMatch(/rn-iso-alpha/);
  expect(joined).toMatch(/rn-iso-beta/);
  expect(joined).not.toMatch(/iPhone 17 Pro/);
  expect(joined).not.toMatch(/Pixel_6/);
});

test('describeUnverifiableDevices says only that the sweep was skipped when nothing is ours', () => {
  const notices = describeUnverifiableDevices(['iPhone 17 Pro'], []);
  expect(notices.length).toBe(1);
  expect(notices[0]).toMatch(/device sweep skipped/);
});

test('describeUnverifiableDevices tolerates empty listings', () => {
  expect(describeUnverifiableDevices([], []).length).toBe(1);
});

test('describeUnverifiableDevices carries the reason it was given', () => {
  const notices = describeUnverifiableDevices(['rn-iso-alpha'], [], {
    reason: 'RN_ISO_HOME scopes this config while simulators are machine-global',
  });
  expect(notices.join('\n')).toMatch(/RN_ISO_HOME/);
});

function writeLock({
  platform = 'ios',
  key = 'abc-debug-sim',
  pid,
  projectRoot = '/w/app-412',
}: {
  platform?: string;
  key?: string;
  pid: number;
  projectRoot?: string;
}) {
  const path = join(tmpHome, 'build-locks', `${platform}-${key}.lock`);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'lock.json'),
    JSON.stringify({
      pid,
      projectRoot,
      startedAt: new Date().toISOString(),
      logFile: `${projectRoot}/.rn-iso/logs/build-${platform}.ndjson`,
    }),
  );
  return path;
}

test('the report separates locks whose builder is gone from builds in progress', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  writeLock({ pid: process.pid, projectRoot: '/w/alive' });
  writeLock({ platform: 'android', key: 'def-debug-sim', pid: 999999, projectRoot: '/w/dead' });

  const report = await collectGcReport();
  expect(report.buildLocks.stale.length).toBe(1);
  expect(report.buildLocks.stale[0]?.pid).toBe(999999);
  expect(report.buildLocks.live.length).toBe(1);
  expect(report.buildLocks.live[0]?.projectRoot).toBe('/w/alive');
});

test('formatGcReport names both, and says a live one is a build it will not touch', () => {
  const lines = formatGcReport({
    buildLocks: {
      stale: [
        makeBuildLock({
          platform: 'ios',
          key: 'abc-debug-sim',
          pid: 999999,
          projectRoot: '/w/dead',
          path: '/h/build-locks/ios-abc.lock',
        }),
      ],
      live: [
        makeBuildLock({
          platform: 'android',
          key: 'def-debug-sim',
          pid: 41233,
          projectRoot: '/w/alive',
          path: '/h/build-locks/android-def.lock',
        }),
      ],
    },
  }).join('\n');
  expect(lines).toMatch(/Stale build locks \(1\)/);
  expect(lines).toMatch(/999999/);
  expect(lines).toMatch(/\/w\/dead/);
  expect(lines).toMatch(/Builds in progress \(1\)/);
  expect(lines).toMatch(/41233/);
  expect(lines).toMatch(/\/w\/alive/);
  expect(lines).toMatch(/not touched|left alone/i);
});

test('a stale lock counts as something to reclaim', () => {
  const lines = formatGcReport({
    buildLocks: {
      stale: [makeBuildLock({ platform: 'ios', key: 'k', pid: 9, projectRoot: '/w', path: '/h/l.lock' })],
      live: [],
    },
  }).join('\n');
  expect(lines.split('\n')[0]).not.toMatch(/^Nothing to reclaim\.$/);
});

test('a live lock alone is not something to reclaim', () => {
  const lines = formatGcReport({
    buildLocks: {
      stale: [],
      live: [makeBuildLock({ platform: 'ios', key: 'k', pid: process.pid, projectRoot: '/w', path: '/h/l.lock' })],
    },
  }).join('\n');
  expect(lines).toMatch(/Nothing to reclaim/);
  expect(lines).toMatch(/Builds in progress/);
});

test('--delete removes the stale lock and leaves the live one alone', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const live = writeLock({ pid: process.pid, projectRoot: '/w/alive' });
  const stale = writeLock({ platform: 'android', key: 'def-debug-sim', pid: 999999, projectRoot: '/w/dead' });

  const output = await captureLog(() => sweepingGc({ delete: true }));
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(output).toMatch(/build lock/i);
});

test('a bare gc removes no lock at all', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const stale = writeLock({ pid: 999999 });
  await captureLog(() => sweepingGc({}));
  expect(existsSync(stale)).toBe(true);
});

function writeSlot({
  index = 0,
  pid,
  projectRoot = '/w/app-412',
}: {
  index?: number;
  pid: number;
  projectRoot?: string;
}) {
  const path = join(tmpHome, 'build-slots', `slot-${index}`);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'slot.json'),
    JSON.stringify({ pid, index, projectRoot, startedAt: new Date().toISOString() }),
  );
  return path;
}

test('the report separates stale build slots from ones a live builder holds', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  writeSlot({ index: 0, pid: process.pid, projectRoot: '/w/alive' });
  writeSlot({ index: 1, pid: 999999, projectRoot: '/w/dead' });

  const report = await collectGcReport();
  expect(report.buildSlots.stale.length).toBe(1);
  expect(report.buildSlots.stale[0]?.pid).toBe(999999);
  expect(report.buildSlots.live.length).toBe(1);
});

test('formatGcReport names a stale build slot', () => {
  const lines = formatGcReport({
    buildSlots: {
      stale: [makeBuildSlot({ index: 1, pid: 999999, projectRoot: '/w/dead', path: '/h/build-slots/slot-1' })],
      live: [],
    },
  }).join('\n');
  expect(lines).toMatch(/Stale build slots \(1\)/);
  expect(lines).toMatch(/999999/);
});

test('a stale build slot counts as something to reclaim', () => {
  const lines = formatGcReport({
    buildSlots: { stale: [makeBuildSlot({ index: 0, pid: 9, projectRoot: '/w', path: '/h/slot-0' })], live: [] },
  }).join('\n');
  expect(lines.split('\n')[0]).not.toMatch(/^Nothing to reclaim\.$/);
});

test('--delete removes the stale build slot and leaves a live one alone', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const live = writeSlot({ index: 0, pid: process.pid, projectRoot: '/w/alive' });
  const stale = writeSlot({ index: 1, pid: 999999, projectRoot: '/w/dead' });

  const output = await captureLog(() => sweepingGc({ delete: true }));
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(output).toMatch(/build slot/i);
});
