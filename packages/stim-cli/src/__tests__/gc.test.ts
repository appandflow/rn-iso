import assert from 'node:assert';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { METRO_NAMED_CACHE_LAYOUT } from '@stim-cli/core';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../exec.ts';
import { saveConfig, loadConfig } from '../config.ts';
import { register } from '../cache-manifest.ts';
import { ensureRemoteBootOwned, withRemoteSessionLock } from '../engine/device-remote.ts';
import { deviceLeasePath, deviceLocksDir } from '../engine/device-lease.ts';
import { withEasProjectLock } from '../engine/eas-project-lock.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceStateFile } from '../paths.ts';
import gcCommand, {
  collectGcReport,
  describeParkedSims,
  describeUnverifiableDevices,
  findOrphanedDevices,
  findStaleDeviceRecords,
  findStaleProjectDevices,
  formatGcReport,
  runGc,
  selectCaches,
} from '../commands/gc.ts';
import { makeConfig, makeIosSim, makeCacheDescriptor, makeBuildLock, makeBuildSlot } from './_factories.ts';

describe('selectCaches', () => {
  const caches = [
    makeCacheDescriptor({ name: 'Xcode compilation cache', dir: '/home/.stim/compilation-cache' }),
    makeCacheDescriptor({ name: 'Build cache', dir: '/home/.stim/build-cache' }),
    makeCacheDescriptor({ name: 'Metro file maps', dir: '/tmp/metro-file-map-1' }),
  ];

  test('no name keeps every cache', () => {
    expect(selectCaches(caches, null)).toHaveLength(3);
    expect(selectCaches(caches, '')).toHaveLength(3);
  });

  test('a name selects the caches it appears in, whatever its case', () => {
    expect(selectCaches(caches, 'compilation cache').map((c) => c.name)).toEqual(['Xcode compilation cache']);
    expect(selectCaches(caches, 'COMPILATION').map((c) => c.name)).toEqual(['Xcode compilation cache']);
  });

  test('a directory fragment selects a cache the name does not match', () => {
    expect(selectCaches(caches, 'metro-file-map').map((c) => c.name)).toEqual(['Metro file maps']);
  });

  test('all is a reserved name that selects every cache', () => {
    expect(selectCaches(caches, 'all')).toHaveLength(3);
    expect(selectCaches(caches, 'ALL')).toHaveLength(3);
  });

  test('the reserved name wins over a directory that happens to carry it', () => {
    const withInstall = [...caches, makeCacheDescriptor({ name: 'Vendor cache', dir: '/opt/install/cache' })];
    expect(selectCaches(withInstall, 'all')).toHaveLength(4);
    expect(selectCaches(withInstall, 'install').map((c) => c.name)).toEqual(['Vendor cache']);
  });

  test('a name nothing carries selects no cache', () => {
    expect(selectCaches(caches, 'gradle')).toEqual([]);
  });
});

describe('a cache-scoped report', () => {
  test('carries the scope and inspects nothing else', async () => {
    const report = await collectGcReport({ cache: 'compilation cache' });
    expect(report.cacheScope).toBe('compilation cache');
    expect(report.deadProjects).toEqual([]);
    expect(report.orphanedDevices).toEqual([]);
    expect(report.staleDevices).toEqual([]);
    expect(report.staleDeviceRecords).toEqual([]);
    expect(report.buildLocks).toEqual({ stale: [], live: [] });
    expect(report.buildSlots).toEqual({ stale: [], live: [] });
    expect(report.skipped).toEqual([]);
    for (const c of report.caches) {
      expect(`${c.name} ${c.dir}`.toLowerCase()).toContain('compilation cache');
    }
  });

  test('the report says what was not inspected instead of claiming a clean machine', () => {
    const lines = formatGcReport({ cacheScope: 'compilation cache' });
    expect(lines.some((l) => l.includes('Cache scope: "compilation cache"'))).toBeTruthy();
    expect(lines.some((l) => l.includes('Nothing to reclaim'))).toBeFalsy();
  });

  test('an unscoped report still reports a clean machine', () => {
    const lines = formatGcReport({});
    expect(lines.some((l) => l.includes('Nothing to reclaim'))).toBeTruthy();
  });

  test('a name no cache carries says so instead of reporting a clean machine', async () => {
    const output = await captureLog(() => runGc({ cache: 'nothing-carries-this-name' }));
    expect(output).toContain('No shared cache carries "nothing-carries-this-name"');
    expect(output).not.toContain('Nothing to reclaim');
  });
});

test('a wrong-typed setting refuses gc with nothing on stdout', async () => {
  const errs: string[] = [];
  const originalError = console.error;
  console.error = (...args) => errs.push(args.join(' '));
  try {
    const output = await captureLog(() =>
      runGc({}, { settingShapeErrors: () => ['Invalid caches setting {}. Expected an array of strings.'] }),
    );
    expect(output).toBe('');
    expect(errs.join('\n')).toContain('Invalid caches setting {}. Expected an array of strings.');
    expect(process.exitCode).toBe(1);
  } finally {
    console.error = originalError;
    process.exitCode = 0;
  }
});

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

test('reports parked simulators with model, runtime, age, size, and delete effect', () => {
  const parked = describeParkedSims(
    [
      {
        udid: 'A1F3-0000',
        name: 'stim-parked (iPhone 17 26.5) a1f3',
        deviceTypeIdentifier: 'iphone-17',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        parkedAt: '2026-09-01T00:00:00.000Z',
        simslimManaged: false,
      },
    ],
    [
      makeIosSim({
        udid: 'A1F3-0000',
        name: 'stim-parked (iPhone 17 26.5) a1f3',
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        deviceTypeIdentifier: 'iphone-17',
        dataPathSize: 2 * 1024 * 1024,
      }),
    ],
    [{ identifier: 'iphone-17', name: 'iPhone 17' }],
  );
  const lines = formatGcReport({ parkedSims: parked }, { now: Date.parse('2026-09-03T00:00:00.000Z') }).join('\n');
  expect(lines).toMatch(/Parked simulators \(1, 2M\)/);
  expect(lines).toMatch(/A1F3\.\.\).*iPhone 17 26\.5.*parked 48h ago.*2M/);
  expect(lines).toMatch(/--delete deletes every parked simulator and empties the pool/);
  expect(lines).not.toMatch(/Nothing to reclaim/);
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

test('findOrphanedDevices proposes only Stim devices absent from config', () => {
  const result = findOrphanedDevices({
    sims: [
      makeIosSim({ udid: 'U1', name: 'stim-gone' }),
      makeIosSim({ udid: 'U2', name: 'stim-live' }),
      makeIosSim({ udid: 'U3', name: 'iPhone 17 Pro' }),
    ],
    avds: ['stim-old', 'Pixel_7'],
    config: makeConfig({
      projects: {
        '/p': {
          platforms: {
            ios: { deviceUdid: 'U2', owned: true },
            android: { avdName: 'stim-kept', owned: true },
          },
        },
      },
    }),
    isMounted: () => true,
  });
  expect(result.orphaned.map((o) => o.id).toSorted()).toEqual(['U1', 'stim-old']);
});

test('a simulator in the parked pool is referenced rather than orphaned', () => {
  const result = findOrphanedDevices({
    sims: [makeIosSim({ udid: 'P1', name: 'stim-parked (iPhone 17 26.5) p1' })],
    config: makeConfig({
      parked: {
        ios: [
          {
            udid: 'P1',
            name: 'stim-parked (iPhone 17 26.5) p1',
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
            parkedAt: '2026-09-03T00:00:00.000Z',
            simslimManaged: false,
          },
        ],
        android: [],
      },
    }),
  });

  expect(result.orphaned).toEqual([]);
  expect(result.kept[0]?.reason).toBe('referenced by the simulator pool');
});

test('gc sizes only listed owned Android AVDs after ownership classification', async () => {
  const now = Date.now();
  const project = join(tmpHome, 'stale-project');
  mkdirSync(project, { recursive: true });
  saveConfig({
    version: 2,
    projects: {
      [project]: { platforms: { android: { avdName: 'stim-stale', owned: true } } },
    },
    repos: {},
  });
  const sized: string[] = [];
  const sizeTimeouts: Array<number | undefined> = [];
  setExecutor({
    run(cmd) {
      if (cmd.includes('simctl list devices --json')) return JSON.stringify({ devices: {} });
      if (cmd.endsWith(' -list-avds')) {
        return 'stim-orphan\nstim-stale\nstim-unreadable\nPixel_7\n';
      }
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet: () => null,
    spawn: () => null,
  });

  const report = await collectGcReport(
    {
      olderThan: 30,
      now,
      lastTouched: () => now - 90 * DAY_MS,
      unsafeAllowScopedDeviceSweep: true,
    },
    {
      avdDirectory: (name) => `/avds/${name}.avd`,
      directorySize: (dir, options) => {
        sized.push(dir);
        sizeTimeouts.push(options?.timeoutMs);
        if (dir.includes('unreadable')) throw new Error('timed out');
        return dir.includes('orphan') ? 5 * 1024 ** 3 : 2 * 1024 ** 3;
      },
      precollectedEasSessionSweep: {
        projectScope: null,
        orphaned: [],
        notices: [],
        deletionSafe: true,
      },
    },
  );

  expect(report.orphanedDevices).toContainEqual({
    kind: 'android',
    id: 'stim-orphan',
    name: 'stim-orphan',
    bytes: 5 * 1024 ** 3,
  });
  expect(report.staleDevices).toContainEqual({
    kind: 'android',
    id: 'stim-stale',
    name: 'stim-stale',
    project,
    idleDays: 90,
    bytes: 2 * 1024 ** 3,
  });
  expect(report.orphanedDevices).toContainEqual({
    kind: 'android',
    id: 'stim-unreadable',
    name: 'stim-unreadable',
  });
  expect(sized).toEqual(['/avds/stim-orphan.avd', '/avds/stim-unreadable.avd', '/avds/stim-stale.avd']);
  expect(sizeTimeouts).toEqual([5000, 5000, 5000]);

  const output = formatGcReport(report).join('\n');
  expect(output).toMatch(/stim-orphan.*5\.0G on disk/);
  expect(output).toMatch(/stim-stale.*2\.0G on disk/);
  expect(output).not.toMatch(/stim-unreadable.*on disk/);
  expect(output).not.toMatch(/Pixel_7/);
});

test('devices referenced by a project on an unmounted volume are kept', () => {
  const result = findOrphanedDevices({
    sims: [makeIosSim({ udid: 'U1', name: 'stim-ext' })],
    avds: [],
    config: makeConfig({ projects: { '/Volumes/Ext/p': { platforms: { ios: { deviceUdid: 'U1', owned: true } } } } }),
    isMounted: () => false,
  });
  expect(result.orphaned.length).toBe(0);
  expect(result.kept[0]?.reason).toMatch(/not mounted/);
});

test('a device named by a non-owned (legacy/stale) record is still counted as referenced, not orphaned', () => {
  const result = findOrphanedDevices({
    sims: [makeIosSim({ udid: 'U1', name: 'stim-stale-record' })],
    avds: ['stim-stale-avd'],
    config: makeConfig({
      projects: {
        '/p': {
          platforms: {
            ios: { deviceUdid: 'U1' },
            android: { avdName: 'stim-stale-avd' },
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
    sims: [makeIosSim({ udid: 'U1', name: 'stim-dead' })],
    avds: [],
    config: makeConfig({ projects: { '/gone/p': { platforms: { ios: { deviceUdid: 'U1', owned: true } } } } }),
    isMounted: () => true,
    deadProjects: ['/gone/p'],
  });
  expect(result.orphaned.map((o) => o.id)).toEqual(['U1']);
});

const staleSims = [makeIosSim({ udid: 'U-STALE', name: 'stim-stale' })];

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
        '/c': { platforms: { android: { avdName: 'stim-gone', owned: true } } },
        '/d': { platforms: { android: { avdName: 'stim-here', owned: true } } },
      },
    }),
    sims: [makeIosSim({ udid: 'HERE', name: 'stim-b' })],
    avds: ['stim-here'],
  });
  expect(stale.map((r) => [r.kind, r.id, r.project])).toEqual([
    ['ios', 'GONE', '/a'],
    ['android', 'stim-gone', '/c'],
  ]);
});

test('findStaleDeviceRecords proposes nothing for a platform whose listing failed', () => {
  const config = makeConfig({
    projects: {
      '/a': { platforms: { ios: { deviceUdid: 'GONE' }, android: { avdName: 'stim-gone' } } },
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

test('findStaleProjectDevices ignores devices Stim does not own', () => {
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
  await program.parseAsync(['node', 'stim', 'gc', ...args]);
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

interface EasCall {
  args: string[];
  options: { cwd?: string; timeoutMs?: number; omitEnv?: readonly string[] };
}

type EasResponse = string | Error | ((options: EasCall['options']) => string | Error);

function easGcHarness({
  project,
  list,
  get = {},
  stop = {},
}: {
  project: string;
  list:
    | string
    | Error
    | Record<string, string | Error>
    | ((after: string, page: number, options: EasCall['options']) => string | Error);
  get?: Record<string, EasResponse>;
  stop?: Record<string, EasResponse>;
}) {
  const calls: EasCall[] = [];
  let page = 0;
  return {
    calls,
    deps: {
      easLedgerRoot: join(fakeHome, 'machine-eas'),
      findProjectRoot: () => project,
      detectIsExpo: () => true,
      resolveEasCliBin: () => ({ file: '/bin/eas', source: 'path' as const }),
      runEasFile(_file: string, args: string[], options: EasCall['options']) {
        calls.push({ args, options });
        const id = args[args.indexOf('--id') + 1] ?? '';
        const after = args.includes('--after') ? (args[args.indexOf('--after') + 1] ?? '') : 'first';
        const listValue =
          typeof list === 'function'
            ? list(after, page++, options)
            : typeof list === 'object' && !(list instanceof Error)
              ? list[after]
              : list;
        const selected = args[0] === 'simulator:list' ? listValue : args[0] === 'simulator:get' ? get[id] : stop[id];
        const value = typeof selected === 'function' ? selected(options) : selected;
        if (value instanceof Error) throw value;
        return value ?? '';
      },
    },
  };
}

function easList(
  sessions: Array<{ id?: string; name?: string; status?: string; platform?: string | null }> = [],
  pageInfo: { hasNextPage?: unknown; endCursor?: unknown } = { hasNextPage: false, endCursor: null },
): string {
  return JSON.stringify({ sessions, pageInfo });
}

function registerExpoProject(project: string): void {
  mkdirSync(project, { recursive: true });
  saveConfig({ version: 2, projects: { [project]: { isExpo: true } }, repos: {} });
}

function writeRemoteState(project: string, value: unknown): void {
  ensureWorkspaceStorage(project);
  writeFileSync(workspaceStateFile(project), typeof value === 'string' ? value : JSON.stringify(value));
}

function writeEasLedger(
  ledgerRoot: string,
  claims: Array<{
    sessionId: string;
    name: string;
    platform: 'ios' | 'android';
    workspaceRoot: string;
    stateFile: string;
  }>,
): void {
  mkdirSync(ledgerRoot, { recursive: true });
  const file = join(ledgerRoot, 'sessions.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { claims?: Record<string, unknown> };
    existing = parsed.claims ?? {};
  }
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      claims: {
        ...existing,
        ...Object.fromEntries(
          claims.map((claim) => [
            claim.sessionId,
            { ...claim, workspaceHome: dirname(dirname(dirname(claim.stateFile))) },
          ]),
        ),
      },
    }),
  );
}

function claimEasSessions(
  project: string,
  sessions: Array<{ id: string; name: string; platform: 'ios' | 'android' }>,
): void {
  ensureWorkspaceStorage(project);
  writeEasLedger(
    join(fakeHome, 'machine-eas'),
    sessions.map((session) => ({
      sessionId: session.id,
      name: session.name,
      platform: session.platform,
      workspaceRoot: project,
      stateFile: workspaceStateFile(project),
    })),
  );
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;

  originalHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'stim-fakehome-'));
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
  delete process.env.STIM_HOME;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('EAS orphan session sweep', () => {
  test('a session claimed from another STIM_HOME is never stopped', async () => {
    const project = join(fakeHome, 'expo-app');
    const clone = join(fakeHome, 'expo-app-clone');
    const homeA = join(fakeHome, 'home-a');
    const homeB = join(fakeHome, 'home-b');
    const ledgerRoot = join(fakeHome, 'machine-eas');
    mkdirSync(project, { recursive: true });
    mkdirSync(clone, { recursive: true });

    process.env.STIM_HOME = homeB;
    writeRemoteState(clone, { remoteDevice: { platform: 'ios', sessionId: 'drs_home_b' } });
    const stateFile = workspaceStateFile(clone);
    writeEasLedger(ledgerRoot, [
      { sessionId: 'drs_home_b', name: 'stim-home-b', platform: 'ios', workspaceRoot: clone, stateFile },
    ]);

    process.env.STIM_HOME = homeA;
    saveConfig({ version: 2, projects: { [project]: { isExpo: true } }, repos: {} });
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_home_b', name: 'stim-home-b', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_home_b: JSON.stringify({ id: 'drs_home_b', name: 'stim-home-b', status: 'IN_PROGRESS' }) },
      stop: { drs_home_b: JSON.stringify({ id: 'drs_home_b', status: 'STOPPED' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, { ...harness.deps, easLedgerRoot: ledgerRoot }));

    expect(output).not.toMatch(/Stopped EAS session drs_home_b/);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('a missing config never authorizes an unclaimed session stop', async () => {
    const project = join(fakeHome, 'expo-app');
    mkdirSync(project, { recursive: true });
    installExecutor();
    const ledgerRoot = join(fakeHome, 'machine-eas');
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_unclaimed', name: 'stim-unclaimed', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_unclaimed: JSON.stringify({ id: 'drs_unclaimed', name: 'stim-unclaimed', status: 'IN_PROGRESS' }),
      },
      stop: { drs_unclaimed: JSON.stringify({ id: 'drs_unclaimed', status: 'STOPPED' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, { ...harness.deps, easLedgerRoot: ledgerRoot }));

    expect(output).toMatch(/unclaimed|ownership.*not verified/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('a fixed ledger claim authorizes cleanup after its workspace state is verified absent', async () => {
    const project = join(fakeHome, 'expo-app');
    const ledgerRoot = join(fakeHome, 'machine-eas');
    mkdirSync(project, { recursive: true });
    ensureWorkspaceStorage(project);
    const stateFile = workspaceStateFile(project);
    writeEasLedger(ledgerRoot, [
      { sessionId: 'drs_claimed', name: 'stim-claimed', platform: 'ios', workspaceRoot: project, stateFile },
    ]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_claimed', name: 'stim-claimed', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_claimed: JSON.stringify({ id: 'drs_claimed', name: 'stim-claimed', status: 'IN_PROGRESS' }) },
      stop: { drs_claimed: JSON.stringify({ id: 'drs_claimed', status: 'STOPPED' }) },
    });

    await captureLog(() => runGc({ delete: true }, { ...harness.deps, easLedgerRoot: ledgerRoot }));

    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list', 'simulator:get', 'simulator:stop']);
  });

  test.each(['missing', 'corrupt', 'mismatched', 'mismatched-state-path'])(
    '%s fixed ledger data never authorizes stop',
    async (kind) => {
      const project = join(fakeHome, 'expo-app');
      const ledgerRoot = join(fakeHome, 'machine-eas');
      mkdirSync(project, { recursive: true });
      ensureWorkspaceStorage(project);
      if (kind === 'corrupt') {
        mkdirSync(ledgerRoot, { recursive: true });
        writeFileSync(join(ledgerRoot, 'sessions.json'), '{broken');
      } else if (kind === 'mismatched') {
        writeEasLedger(ledgerRoot, [
          {
            sessionId: 'drs_target',
            name: 'stim-different',
            platform: 'ios',
            workspaceRoot: project,
            stateFile: workspaceStateFile(project),
          },
        ]);
      } else if (kind === 'mismatched-state-path') {
        const stateFile = join(tmpHome, 'workspaces', 'wrong-workspace', 'state.json');
        mkdirSync(dirname(stateFile), { recursive: true });
        writeEasLedger(ledgerRoot, [
          {
            sessionId: 'drs_target',
            name: 'stim-target',
            platform: 'ios',
            workspaceRoot: project,
            stateFile,
          },
        ]);
      }
      installExecutor();
      const harness = easGcHarness({
        project,
        list: easList([{ id: 'drs_target', name: 'stim-target', status: 'IN_PROGRESS', platform: 'IOS' }]),
        get: { drs_target: JSON.stringify({ id: 'drs_target', name: 'stim-target', status: 'IN_PROGRESS' }) },
        stop: { drs_target: JSON.stringify({ id: 'drs_target', status: 'STOPPED' }) },
      });

      await captureLog(() => runGc({ delete: true }, { ...harness.deps, easLedgerRoot: ledgerRoot }));

      expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
    },
  );

  test('local delete work runs after the fixed EAS lock is released', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    writeLock({ pid: 999999 });
    const harness = easGcHarness({ project, list: easList() });
    let held = false;
    let localDeleteHeld: boolean | null = null;
    const originalLog = console.log;
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('Cleared the ios build lock')) localDeleteHeld = held;
    });

    try {
      await runGc(
        { delete: true },
        {
          ...harness.deps,
          easLedgerRoot: join(fakeHome, 'machine-eas'),
          withEasProjectLock: async (_root, fn) => {
            held = true;
            try {
              return await fn();
            } finally {
              held = false;
            }
          },
        },
      );
    } finally {
      log.mockRestore();
      console.log = originalLog;
    }

    expect(localDeleteHeld).toBe(false);
  });

  test('dry run reports a project-scoped orphan and performs no lookup or stop', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_orphan', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
    });

    const output = await captureLog(() => runGc({}, harness.deps));

    expect(output).toMatch(/Orphaned EAS sessions \(1\)/);
    expect(output).toContain('drs_orphan');
    expect(output).toContain('stim-old');
    expect(output).toContain(project);
    expect(output).toMatch(/eas simulator:stop --id drs_orphan/);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
    expect(harness.calls[0]?.options).toMatchObject({ cwd: project, timeoutMs: expect.any(Number) });
    expect(harness.calls[0]?.options.omitEnv).toEqual(
      expect.arrayContaining(['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN']),
    );
  });

  test('a session recorded by another registered workspace is not orphaned', async () => {
    const project = join(fakeHome, 'expo-app');
    const otherWorkspace = join(fakeHome, 'expo-worktree');
    mkdirSync(project, { recursive: true });
    mkdirSync(otherWorkspace, { recursive: true });
    saveConfig({
      version: 2,
      projects: { [project]: { isExpo: true }, [otherWorkspace]: { isExpo: true } },
      repos: {},
    });
    claimEasSessions(project, [{ id: 'drs_orphan', name: 'stim-old', platform: 'ios' }]);
    writeRemoteState(otherWorkspace, { remoteDevice: { platform: 'ios', sessionId: 'drs_recorded' } });
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([
        { id: 'drs_recorded', name: 'stim-live', status: 'IN_PROGRESS', platform: 'IOS' },
        { id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' },
      ]),
    });

    const output = await captureLog(() => runGc({}, harness.deps));

    expect(output).not.toContain('drs_recorded');
    expect(output).toContain('drs_orphan');
    expect(JSON.parse(readFileSync(workspaceStateFile(otherWorkspace), 'utf-8'))).toMatchObject({
      remoteDevice: { sessionId: 'drs_recorded' },
    });
  });

  test.each([
    ['missing', (root: string) => root],
    [
      'inaccessible',
      (root: string) => {
        mkdirSync(root);
        chmodSync(root, 0o000);
        return root;
      },
    ],
  ])('a registered workspace root that is %s fails closed', async (_label, prepareRoot) => {
    const project = join(fakeHome, 'expo-app');
    const unavailable = prepareRoot(join(fakeHome, 'unavailable-workspace'));
    mkdirSync(project, { recursive: true });
    saveConfig({
      version: 2,
      projects: { [project]: { isExpo: true }, [unavailable]: { isExpo: true } },
      repos: {},
    });
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_orphan: JSON.stringify({ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_orphan: JSON.stringify({ id: 'drs_orphan', status: 'STOPPED' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps)).finally(() => {
      if (existsSync(unavailable)) chmodSync(unavailable, 0o700);
    });

    expect(output).toMatch(/unavailable-workspace.*not available|unavailable-workspace.*not readable/i);
    expect(harness.calls).toEqual([]);
  });

  test('an existing registered workspace with no state file does not block deletion', async () => {
    const project = join(fakeHome, 'expo-app');
    const emptyWorkspace = join(fakeHome, 'empty-workspace');
    mkdirSync(project, { recursive: true });
    mkdirSync(emptyWorkspace, { recursive: true });
    saveConfig({
      version: 2,
      projects: { [project]: { isExpo: true }, [emptyWorkspace]: { isExpo: true } },
      repos: {},
    });
    ensureWorkspaceStorage(emptyWorkspace);
    claimEasSessions(emptyWorkspace, [{ id: 'drs_orphan', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_orphan: JSON.stringify({ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_orphan: JSON.stringify({ id: 'drs_orphan', status: 'STOPPED' }) },
    });

    await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list', 'simulator:get', 'simulator:stop']);
  });

  test('an active remote session creation lock disables deletion while local cleanup continues', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_creating', name: 'stim-creating', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_creating: JSON.stringify({ id: 'drs_creating', name: 'stim-creating', status: 'IN_PROGRESS' }),
      },
      stop: { drs_creating: JSON.stringify({ id: 'drs_creating', status: 'STOPPED' }) },
    });

    const output = await withRemoteSessionLock(project, () => captureLog(() => runGc({ delete: true }, harness.deps)));

    expect(output).toMatch(/remote-session|remote session.*lock/i);
    expect(harness.calls).toEqual([]);
    expect(existsSync(staleLock)).toBe(false);
  });

  test('an active EAS start lock disables only the remote sweep while local cleanup continues', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    writeFileSync(
      join(project, 'app.json'),
      JSON.stringify({ expo: { extra: { eas: { projectId: 'active-eas-project' } } } }),
    );
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_hidden', name: 'stim-hidden', status: 'IN_PROGRESS', platform: 'IOS' }]),
    });

    const output = await withEasProjectLock(project, () => captureLog(() => runGc({ delete: true }, harness.deps)), {
      machineRoot: join(fakeHome, 'machine-eas'),
    });

    expect(output).toMatch(/EAS project lock/i);
    expect(harness.calls).toEqual([]);
    expect(existsSync(staleLock)).toBe(false);
  });

  test('a false then true Expo classification cannot enable an unlocked EAS sweep', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_race', name: 'stim-race', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_race: JSON.stringify({ id: 'drs_race', name: 'stim-race', status: 'IN_PROGRESS' }),
      },
      stop: { drs_race: JSON.stringify({ id: 'drs_race', status: 'STOPPED' }) },
    });
    let classifications = 0;

    await captureLog(() =>
      runGc(
        { delete: true },
        {
          ...harness.deps,
          detectIsExpo: () => classifications++ > 0,
        },
      ),
    );

    expect(classifications).toBe(1);
    expect(harness.calls).toEqual([]);
    expect(existsSync(staleLock)).toBe(false);
  });

  test('dry run does not wait behind an active remote session creation lock', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_creating', name: 'stim-creating', status: 'IN_PROGRESS', platform: 'IOS' }]),
    });
    const startedAt = Date.now();

    const output = await withRemoteSessionLock(project, () => captureLog(() => runGc({}, harness.deps)));

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(output).toMatch(/remote-session|remote session.*lock/i);
    expect(harness.calls).toEqual([]);
  });

  test('a malformed remote session lock disables the EAS sweep', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const lockDir = join(workspaceDir(realpathSync(project)), 'remote-session.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), '{not valid json');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_hidden', name: 'stim-hidden', status: 'IN_PROGRESS', platform: 'IOS' }]),
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(output).toMatch(/remote-session|remote session.*lock/i);
    expect(harness.calls).toEqual([]);
    expect(existsSync(lockDir)).toBe(true);
  });

  test('registry expansion releases and retries the sorted remote session lock set', async () => {
    const project = join(fakeHome, 'z-expo-app');
    const added = join(fakeHome, 'a-expo-workspace');
    registerExpoProject(project);
    mkdirSync(added, { recursive: true });
    installExecutor();
    const harness = easGcHarness({ project, list: easList() });
    const acquisitions: string[] = [];
    let depth = 0;
    let expanded = false;
    const deps = {
      ...harness.deps,
      withRemoteSessionLock: async <T>(root: string, fn: () => Promise<T>): Promise<T> => {
        acquisitions.push(root);
        depth++;
        try {
          if (!expanded) {
            expanded = true;
            saveConfig({
              version: 2,
              projects: { [project]: { isExpo: true }, [added]: { isExpo: true } },
              repos: {},
            });
          }
          return await fn();
        } finally {
          depth--;
        }
      },
    } as unknown as Parameters<typeof runGc>[1];

    await captureLog(() => runGc({}, deps));

    expect(acquisitions).toEqual([realpathSync(project), realpathSync(added), realpathSync(project)]);
    expect(depth).toBe(0);
  });

  test('an error from the GC core is not retried as a lock acquisition failure', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({ project, list: easList() });
    const failure = new Error('report output failed');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      throw failure;
    });

    await expect(runGc({}, harness.deps)).rejects.toBe(failure);

    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  test('an unexpected EAS collection failure becomes a notice while local cleanup continues', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({ project, list: easList() });
    const deps = {
      ...harness.deps,
      withRemoteSessionLock: async <T>(_root: string, fn: () => Promise<T>): Promise<T> => {
        await fn();
        throw new Error('remote session lock release failed');
      },
    } as unknown as Parameters<typeof runGc>[1];

    const output = await captureLog(() => runGc({ delete: true }, deps));

    expect(output).toMatch(/EAS collection failed.*remote session lock release failed/i);
    expect(harness.calls.filter((call) => call.args[0] === 'simulator:stop')).toEqual([]);
    expect(existsSync(staleLock)).toBe(false);
  });

  test('a workspace registered during the EAS list cannot hide a pending state write', async () => {
    const project = join(fakeHome, 'expo-app');
    const added = join(fakeHome, 'new-expo-workspace');
    registerExpoProject(project);
    mkdirSync(added, { recursive: true });
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({
      project,
      list: () => {
        saveConfig({
          version: 2,
          projects: { [project]: { isExpo: true }, [added]: { isExpo: true } },
          repos: {},
        });
        return easList([{ id: 'drs_registering', name: 'stim-registering', status: 'IN_PROGRESS', platform: 'IOS' }]);
      },
      get: {
        drs_registering: JSON.stringify({
          id: 'drs_registering',
          name: 'stim-registering',
          status: 'IN_PROGRESS',
        }),
      },
      stop: { drs_registering: JSON.stringify({ id: 'drs_registering', status: 'STOPPED' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(output).toMatch(/registered workspace roots.*changed|new.*remote-session lock/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
    expect(existsSync(staleLock)).toBe(false);
  });

  test('the final state rescan rejects a workspace registered after classification', async () => {
    const project = join(fakeHome, 'expo-app');
    const added = join(fakeHome, 'late-expo-workspace');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_registering', name: 'stim-registering', platform: 'ios' }]);
    mkdirSync(added, { recursive: true });
    installExecutor();
    const harness = easGcHarness({
      project,
      list: () => {
        queueMicrotask(() => {
          saveConfig({
            version: 2,
            projects: { [project]: { isExpo: true }, [added]: { isExpo: true } },
            repos: {},
          });
          writeRemoteState(added, { remoteDevice: { platform: 'ios', sessionId: 'drs_registering' } });
        });
        return easList([{ id: 'drs_registering', name: 'stim-registering', status: 'IN_PROGRESS', platform: 'IOS' }]);
      },
      get: {
        drs_registering: JSON.stringify({
          id: 'drs_registering',
          name: 'stim-registering',
          status: 'IN_PROGRESS',
        }),
      },
      stop: { drs_registering: JSON.stringify({ id: 'drs_registering', status: 'STOPPED' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(output).toMatch(/workspace record.*left running/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('the EAS sweep lock covers separate clones with asymmetric static and dynamic config through the final stop', async () => {
    const project = join(fakeHome, 'expo-app');
    const otherWorkspace = join(fakeHome, 'expo-app-clone');
    const projectGitCommon = join(fakeHome, 'project.git');
    const otherGitCommon = join(fakeHome, 'other.git');
    registerExpoProject(project);
    mkdirSync(otherWorkspace, { recursive: true });
    mkdirSync(projectGitCommon, { recursive: true });
    mkdirSync(otherGitCommon, { recursive: true });
    const appConfig = JSON.stringify({ expo: { extra: { eas: { projectId: 'shared-eas-project' } } } });
    writeFileSync(join(project, 'app.json'), appConfig);
    writeFileSync(
      join(otherWorkspace, 'app.config.js'),
      "module.exports = { extra: { eas: { projectId: 'shared-eas-project' } } };\n",
    );
    claimEasSessions(project, [{ id: 'drs_old', name: 'stim-old', platform: 'ios' }]);
    setExecutor({
      run(cmd) {
        throw new Error(`unexpected run: ${cmd}`);
      },
      runQuiet(cmd) {
        if (!cmd.includes('--git-common-dir')) return null;
        return cmd.includes(otherWorkspace) ? otherGitCommon : projectGitCommon;
      },
      spawn(cmd) {
        throw new Error(`unexpected spawn: ${cmd}`);
      },
    });
    const order: string[] = [];
    let startPromise: Promise<unknown> | null = null;
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_old', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_old: () => {
          order.push('get');
          startPromise = ensureRemoteBootOwned({
            root: otherWorkspace,
            platform: 'ios',
            sessionName: 'stim-new',
            startedAt: '2026-08-28T00:00:00.000Z',
            register: () => {
              order.push('register');
              const config = loadConfig();
              saveConfig({
                version: 2,
                projects: { ...config?.projects, [otherWorkspace]: { isExpo: true } },
                repos: config?.repos ?? {},
              });
            },
            boot: async () => {
              order.push('create');
              return { ok: true, udid: 'drs_new' };
            },
            createdSessionId: () => 'drs_new',
            abandonCreatedSession: () => ({ ok: true, sessionId: 'drs_new' }),
            writeState: () => {
              order.push('publish');
            },
            ledgerRoot: join(fakeHome, 'machine-eas'),
          });
          return JSON.stringify({ id: 'drs_old', name: 'stim-old', status: 'IN_PROGRESS' });
        },
      },
      stop: {
        drs_old: () => {
          order.push('stop');
          return JSON.stringify({ id: 'drs_old', status: 'STOPPED' });
        },
      },
    });

    await captureLog(() => runGc({ delete: true }, harness.deps));
    await startPromise;

    expect(order).toEqual(['get', 'stop', 'register', 'create', 'publish']);
  });

  test('collects every page before comparing current-project sessions', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [
      { id: 'drs_page_1', name: 'stim-one', platform: 'ios' },
      { id: 'drs_page_2', name: 'stim-two', platform: 'android' },
    ]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: {
        first: easList([{ id: 'drs_page_1', name: 'stim-one', status: 'IN_PROGRESS', platform: 'IOS' }], {
          hasNextPage: true,
          endCursor: 'cursor-2',
        }),
        'cursor-2': easList([{ id: 'drs_page_2', name: 'stim-two', status: 'NEW', platform: 'ANDROID' }], {
          hasNextPage: false,
          endCursor: 'cursor-2-end',
        }),
      },
    });

    const output = await captureLog(() => runGc({}, harness.deps));

    expect(output).toMatch(/Orphaned EAS sessions \(2\)/);
    expect(output).toContain('drs_page_1');
    expect(output).toContain('drs_page_2');
    const pages = harness.calls.filter((call) => call.args[0] === 'simulator:list');
    expect(pages).toHaveLength(2);
    expect(pages[0]?.args).toEqual(expect.arrayContaining(['--limit', '100']));
    expect(pages[0]?.args).not.toContain('--after');
    expect(pages[1]?.args).toEqual(expect.arrayContaining(['--limit', '100', '--after', 'cursor-2']));
    for (const page of pages) {
      expect(page.options).toMatchObject({ cwd: project, timeoutMs: 30_000 });
      expect(page.options.omitEnv).toEqual(
        expect.arrayContaining(['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN']),
      );
    }
  });

  test('a unique-cursor sequence stops at the configured page limit', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({
      project,
      list: (_after, page) => {
        if (page > 10) throw new Error('test safety bound reached');
        return easList([], { hasNextPage: true, endCursor: `cursor-${page + 1}` });
      },
    });
    const deps = { ...harness.deps, easMaxPages: 3 } as unknown as Parameters<typeof runGc>[1];

    const output = await captureLog(() => runGc({ delete: true }, deps));

    expect(output).toMatch(/EAS session sweep notice/i);
    expect(output).toMatch(/page limit|maximum.*pages/i);
    expect(harness.calls.filter((call) => call.args[0] === 'simulator:list')).toHaveLength(3);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:get')).toBe(false);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
    expect(existsSync(staleLock)).toBe(false);
  });

  test('a slow page sequence stops at the total deadline and shortens the final page timeout', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    let clock = 0;
    const harness = easGcHarness({
      project,
      list: (_after, page) => {
        clock += 40_000;
        return easList(
          page === 2 ? [{ id: 'drs_too_late', name: 'stim-too-late', status: 'IN_PROGRESS', platform: 'IOS' }] : [],
          { hasNextPage: page < 2, endCursor: `cursor-${page + 1}` },
        );
      },
      get: {
        drs_too_late: JSON.stringify({ id: 'drs_too_late', name: 'stim-too-late', status: 'IN_PROGRESS' }),
      },
      stop: { drs_too_late: JSON.stringify({ id: 'drs_too_late', status: 'STOPPED' }) },
    });
    const deps = {
      ...harness.deps,
      easNow: () => clock,
      easCollectionTimeoutMs: 60_000,
    } as unknown as Parameters<typeof runGc>[1];

    const output = await captureLog(() => runGc({ delete: true }, deps));

    expect(output).toMatch(/EAS session sweep notice/i);
    expect(output).toMatch(/deadline|time limit/i);
    const listCalls = harness.calls.filter((call) => call.args[0] === 'simulator:list');
    expect(listCalls.map((call) => call.options.timeoutMs)).toEqual([30_000, 20_000]);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:get')).toBe(false);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
    expect(existsSync(staleLock)).toBe(false);
  });

  test.each([
    [
      'malformed page info',
      { first: JSON.stringify({ sessions: [], pageInfo: { hasNextPage: 'yes', endCursor: null } }) },
    ],
    ['missing next cursor', { first: easList([], { hasNextPage: true, endCursor: null }) }],
    [
      'repeated cursor',
      {
        first: easList([], { hasNextPage: true, endCursor: 'same' }),
        same: easList([], { hasNextPage: true, endCursor: 'same' }),
      },
    ],
    [
      'later page failure',
      {
        first: easList([], { hasNextPage: true, endCursor: 'next' }),
        next: new Error('page request failed'),
      },
    ],
  ])('a %s fails closed while local deletion continues', async (_label, list) => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({ project, list });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(output).toMatch(/EAS session sweep notice/i);
    expect(output).toMatch(/page|cursor/i);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:get')).toBe(false);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
    expect(existsSync(staleLock)).toBe(false);
  });

  test.each([
    ['missing', undefined],
    ['null', null],
    ['unknown', 'WINDOWS'],
  ])('an owned session with %s platform is never reported or stopped', async (_label, platform) => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_bad', name: 'stim-bad', status: 'IN_PROGRESS', platform }]),
      get: { drs_bad: JSON.stringify({ id: 'drs_bad', name: 'stim-bad', status: 'IN_PROGRESS' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(output).toMatch(/platform/i);
    expect(output).not.toMatch(/Orphaned EAS sessions/);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('delete stops an orphan only after a matching active owned lookup', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_orphan', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_orphan: JSON.stringify({ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_orphan: JSON.stringify({ id: 'drs_orphan', status: 'STOPPED' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list', 'simulator:get', 'simulator:stop']);
    expect(output).toMatch(/Stopped EAS session drs_orphan/);
  });

  test.each([
    {
      label: 'terminal',
      get: JSON.stringify({ id: 'drs_old', name: 'stim-old', status: 'STOPPED' }),
      expected: /already stopped/i,
    },
    {
      label: 'missing',
      get: Object.assign(new Error('lookup failed'), { stderr: 'Device run session drs_old was not found.' }),
      expected: /already gone/i,
    },
  ])('treats a $label candidate as resolved without a stop', async ({ get, expected }) => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_old', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_old', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_old: get },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
    expect(output).toMatch(expected);
  });

  test.each([
    ['network failure', new Error('getaddrinfo ENOTFOUND api.expo.dev')],
    ['authentication failure', new Error('Authentication failed. Log in to EAS.')],
    ['malformed output', 'not json'],
  ])('reports a %s as a notice while local deletion continues', async (_label, list) => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({ project, list });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(output).toMatch(/EAS session sweep notice/i);
    expect(existsSync(staleLock)).toBe(false);
  });

  test('a malformed workspace state fails closed for remote deletion', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    writeRemoteState(project, '{not json');
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_orphan: JSON.stringify({ id: 'drs_orphan', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_orphan: JSON.stringify({ id: 'drs_orphan', status: 'STOPPED' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(output).toMatch(/state\.json.*could not be read|state\.json.*valid JSON/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('a listed state entry that cannot be read fails closed for remote deletion', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_unreadable', name: 'stim-old', platform: 'ios' }]);
    symlinkSync(join(fakeHome, 'missing-state-target'), workspaceStateFile(project));
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_unreadable', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_unreadable: JSON.stringify({ id: 'drs_unreadable', name: 'stim-old', status: 'IN_PROGRESS' }) },
      stop: { drs_unreadable: JSON.stringify({ id: 'drs_unreadable', status: 'STOPPED' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(output).toMatch(/state\.json.*could not be read/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual(['simulator:list']);
  });

  test('a candidate changed to an unowned name is never stopped', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_reused', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_reused', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: { drs_reused: JSON.stringify({ id: 'drs_reused', name: 'manual-session', status: 'IN_PROGRESS' }) },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(output).toMatch(/not owned by Stim/i);
    expect(harness.calls.some((call) => call.args[0] === 'simulator:stop')).toBe(false);
    expect(output).toMatch(/could not be deleted/i);
  });

  test('candidate failures are independent and do not block local cleanup', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [
      { id: 'drs_lookup_fail', name: 'stim-one', platform: 'ios' },
      { id: 'drs_stop_fail', name: 'stim-two', platform: 'android' },
      { id: 'drs_ok', name: 'stim-three', platform: 'ios' },
    ]);
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({
      project,
      list: easList([
        { id: 'drs_lookup_fail', name: 'stim-one', status: 'IN_PROGRESS', platform: 'IOS' },
        { id: 'drs_stop_fail', name: 'stim-two', status: 'IN_PROGRESS', platform: 'ANDROID' },
        { id: 'drs_ok', name: 'stim-three', status: 'IN_PROGRESS', platform: 'IOS' },
      ]),
      get: {
        drs_lookup_fail: new Error('lookup timed out'),
        drs_stop_fail: JSON.stringify({ id: 'drs_stop_fail', name: 'stim-two', status: 'IN_PROGRESS' }),
        drs_ok: JSON.stringify({ id: 'drs_ok', name: 'stim-three', status: 'IN_PROGRESS' }),
      },
      stop: {
        drs_stop_fail: new Error('stop failed'),
        drs_ok: JSON.stringify({ id: 'drs_ok', status: 'STOPPED' }),
      },
    });

    const output = await captureLog(() => runGc({ delete: true }, harness.deps));

    expect(harness.calls.filter((call) => call.args[0] === 'simulator:get')).toHaveLength(3);
    expect(harness.calls.filter((call) => call.args[0] === 'simulator:stop')).toHaveLength(2);
    expect(output).toContain('Stopped EAS session drs_ok');
    expect(output).toMatch(/could not be deleted/i);
    expect(existsSync(staleLock)).toBe(false);
  });

  test('a throwing claim removal reports resolved sessions and continues other candidates and local cleanup', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [
      { id: 'drs_first', name: 'stim-first', platform: 'ios' },
      { id: 'drs_second', name: 'stim-second', platform: 'android' },
    ]);
    installExecutor();
    const staleLock = writeLock({ pid: 999999 });
    const harness = easGcHarness({
      project,
      list: easList([
        { id: 'drs_first', name: 'stim-first', status: 'IN_PROGRESS', platform: 'IOS' },
        { id: 'drs_second', name: 'stim-second', status: 'IN_PROGRESS', platform: 'ANDROID' },
      ]),
      get: {
        drs_first: JSON.stringify({ id: 'drs_first', name: 'stim-first', status: 'IN_PROGRESS' }),
        drs_second: JSON.stringify({ id: 'drs_second', name: 'stim-second', status: 'IN_PROGRESS' }),
      },
      stop: {
        drs_first: JSON.stringify({ id: 'drs_first', status: 'STOPPED' }),
        drs_second: JSON.stringify({ id: 'drs_second', status: 'STOPPED' }),
      },
    });

    const output = await captureLog(() =>
      runGc({ delete: true }, {
        ...harness.deps,
        removeEasSessionClaim: () => {
          throw new Error('claim store unavailable');
        },
      } as unknown as Parameters<typeof runGc>[1]),
    );

    expect(output).toMatch(/Stopped EAS session drs_first/);
    expect(output).toMatch(/Stopped EAS session drs_second/);
    expect(output).toMatch(/ownership claim.*could not be removed/i);
    expect(harness.calls.map((call) => call.args[0])).toEqual([
      'simulator:list',
      'simulator:get',
      'simulator:stop',
      'simulator:get',
      'simulator:stop',
    ]);
    expect(existsSync(staleLock)).toBe(false);
  });

  test('a false claim removal reports the stopped session and retained claim', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_resolved', name: 'stim-resolved', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_resolved', name: 'stim-resolved', status: 'IN_PROGRESS', platform: 'IOS' }]),
      get: {
        drs_resolved: JSON.stringify({ id: 'drs_resolved', name: 'stim-resolved', status: 'IN_PROGRESS' }),
      },
      stop: { drs_resolved: JSON.stringify({ id: 'drs_resolved', status: 'STOPPED' }) },
    });

    const output = await captureLog(() =>
      runGc({ delete: true }, { ...harness.deps, removeEasSessionClaim: () => false } as unknown as Parameters<
        typeof runGc
      >[1]),
    );

    expect(output).toMatch(/Stopped EAS session drs_resolved/);
    expect(output).toMatch(/ownership claim.*could not be removed/i);
    expect(output).toMatch(/could not be deleted/i);
  });

  test('the report states that the EAS sweep covers only the current project', async () => {
    const project = join(fakeHome, 'expo-app');
    registerExpoProject(project);
    claimEasSessions(project, [{ id: 'drs_old', name: 'stim-old', platform: 'ios' }]);
    installExecutor();
    const harness = easGcHarness({
      project,
      list: easList([{ id: 'drs_old', name: 'stim-old', status: 'IN_PROGRESS', platform: 'IOS' }]),
    });

    const output = await captureLog(() => runGc({}, harness.deps));

    expect(output).toMatch(/current EAS project only/i);
    expect(output).not.toMatch(/all EAS projects/i);
  });
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
  const unmountedPath = '/Volumes/StimTestVolumeThatDoesNotExist/proj/gone';
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
      { udid: 'UDID-1', name: 'stim-orphan-1' },
      { udid: 'UDID-2', name: 'stim-orphan-2' },
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
    devices: [{ udid: 'UDID-9', name: 'stim-report-orphan' }],
    execCalls,
  });
  saveConfig({ version: 2, projects: {}, repos: {} });

  const output = await captureLog(() => sweepingGc({ delete: false }));

  expect(output).toMatch(/stim-report-orphan/);
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
    devices: [{ udid: 'UDID-DEAD', name: 'stim-dead-owner' }],
    execCalls,
  });

  await sweepingGc({ delete: true });

  const cfg = currentConfig();
  expect(cfg.projects[localDeadPath]).toBe(undefined);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown UDID-DEAD'))).toBeTruthy();
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-DEAD'))).toBeTruthy();
});

test('gc with no config names Stim devices it cannot verify, but never touches them', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-LIVE', name: 'stim-someones-live-env', state: 'Booted' }],
    execCalls,
  });

  const output = await captureLog(() => sweepingGc({ delete: true }));

  expect(output).toMatch(/stim-someones-live-env/);
  expect(output).toMatch(/no Stim config found/i);
  expect(output).toMatch(/cannot be verified as orphaned/i);
  expect(output).not.toMatch(/Orphaned devices/i);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
});

test('a config scoped by STIM_HOME never sweeps machine-global devices', async () => {
  const execCalls: string[] = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-REAL-1', name: 'stim-real-env-1', state: 'Booted' },
      { udid: 'UDID-REAL-2', name: 'stim-real-env-2' },
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
  expect(output).toMatch(/STIM_HOME/);
  expect(output).toMatch(/stim-real-env-1/);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
});

test('the STIM_HOME guard does not disable dead-entry pruning', async () => {
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
    devices: [{ udid: 'UDID-STALE', name: 'stim-abandoned' }],
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
  installDeviceExecutor({ devices: [{ udid: 'UDID-HERE', name: 'stim-live' }], execCalls: [] });

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
    devices: [{ udid: 'UDID-STALE', name: 'stim-abandoned' }],
    execCalls,
  });

  const output = await captureLog(() => sweepingGc({ delete: false, olderThan: 30 }));

  expect(output).toMatch(/stim-abandoned/);
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
    devices: [{ udid: 'UDID-LIVE', name: 'stim-live' }],
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

test('gc reports but never deletes the shared Gradle build cache under any deletion mode', async () => {
  const previous = process.env.GRADLE_USER_HOME;
  const gradleHome = join(fakeHome, 'gradle-home');
  const cachesRoot = join(gradleHome, 'caches');
  const cacheDir = join(cachesRoot, 'build-cache-1');
  const cacheAlias = join(gradleHome, 'caches-alias');
  const entry = join(cacheDir, 'entry-a');
  mkdirSync(cacheDir, { recursive: true });
  symlinkSync(cachesRoot, cacheAlias, 'dir');
  writeFileSync(entry, 'x'.repeat(1000));
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(entry, old, old);
  process.env.GRADLE_USER_HOME = gradleHome;
  saveConfig({ version: 2, projects: {}, repos: {} });
  register({ dir: cacheAlias, name: 'Gradle build cache', prune: 'entries' });
  installExecutor();

  try {
    for (const args of [['--delete'], ['--delete', '--older-than', '30'], ['--delete', '--cache', 'all']]) {
      const output = await captureLog(() => cli(args));
      expect(output).toMatch(/Gradle build cache/);
      expect(existsSync(entry)).toBeTruthy();
    }
  } finally {
    if (previous === undefined) delete process.env.GRADLE_USER_HOME;
    else process.env.GRADLE_USER_HOME = previous;
  }
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

test('--delete --older-than ignores a legacy Metro parent registered after its named child', async () => {
  const parent = join(tmpHome, 'metro-cache');
  const child = join(parent, 'demo');
  const shard = join(child, '0a');
  const currentTransform = join(shard, 'current');
  const legacyShard = join(parent, '1b');
  const legacyTransform = join(legacyShard, 'legacy');
  mkdirSync(shard, { recursive: true });
  mkdirSync(legacyShard, { recursive: true });
  writeFileSync(currentTransform, 'current');
  writeFileSync(legacyTransform, 'legacy');
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(shard, old, old);
  utimesSync(legacyTransform, old, old);
  register({
    dir: child,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
  });
  register({ dir: parent, name: 'Metro transform cache', prune: 'entries', entriesDepth: 2 });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await cli(['--delete', '--older-than', '30']);

  expect(existsSync(currentTransform)).toBe(true);
  expect(existsSync(legacyTransform)).toBe(true);
});

test('--delete --older-than ignores a legacy Metro parent whose named child is a symlink', async () => {
  const parent = join(tmpHome, 'metro-cache');
  const target = join(tmpHome, 'metro-target');
  const child = join(parent, 'demo');
  const shard = join(target, '0a');
  const currentTransform = join(shard, 'current');
  mkdirSync(parent, { recursive: true });
  mkdirSync(shard, { recursive: true });
  writeFileSync(currentTransform, 'current');
  symlinkSync(target, child, 'dir');
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(shard, old, old);
  register({
    dir: child,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
  });
  register({ dir: parent, name: 'Metro transform cache', prune: 'entries', entriesDepth: 2 });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await cli(['--delete', '--older-than', '30']);

  expect(existsSync(currentTransform)).toBe(true);
});

test('--delete --older-than keeps a current Metro store that is also a current override parent', async () => {
  const parent = join(tmpHome, 'metro-cache', 'first-app');
  const child = join(parent, 'second-app');
  const parentTransform = join(parent, '0a', 'old-parent-transform');
  const childTransform = join(child, '1b', 'current-child-transform');
  mkdirSync(dirname(parentTransform), { recursive: true });
  mkdirSync(dirname(childTransform), { recursive: true });
  writeFileSync(parentTransform, 'parent');
  writeFileSync(childTransform, 'child');
  const old = new Date(Date.now() - 400 * DAY_MS);
  utimesSync(parentTransform, old, old);
  utimesSync(dirname(childTransform), old, old);
  register({
    dir: parent,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
  });
  register({
    dir: child,
    name: 'Metro transform cache',
    prune: 'entries',
    entriesDepth: 2,
    layout: METRO_NAMED_CACHE_LAYOUT,
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const report = await collectGcReport({ olderThan: 30 });
  expect(report.caches.find((cache) => cache.dir === parent)?.prune).toBe('report-only');
  expect(report.caches.find((cache) => cache.dir === child)?.prune).toBe('entries');
  await cli(['--delete', '--older-than', '30']);

  expect(existsSync(parentTransform)).toBe(true);
  expect(existsSync(childTransform)).toBe(true);
});

test('--delete --cache all empties an index-backed cache that --older-than cannot trim', async () => {
  const casDir = join(tmpHome, 'compilation-cache');
  const leaf = join(casDir, 'v9.data.leaf');
  const index = join(casDir, 'v4.actions');
  mkdirSync(casDir, { recursive: true });
  writeFileSync(leaf, 'x'.repeat(1000));
  writeFileSync(index, 'index');
  register({ dir: casDir, name: 'Xcode compilation cache', prune: 'atomic' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const report = await collectGcReport({ cache: 'all' });
  expect(report.caches.some((c) => c.prune === 'atomic' && c.willEmpty)).toBeTruthy();

  await captureLog(() => cli(['--delete', '--older-than', '30']));
  expect(existsSync(leaf)).toBeTruthy();

  await captureLog(() => cli(['--delete', '--cache', 'all']));
  expect(existsSync(leaf)).toBe(false);
  expect(existsSync(index)).toBe(false);
});

test('--delete --cache all empties an entries-style cache including entries used today', async () => {
  const cacheDir = join(tmpHome, 'my-cache');
  const freshEntry = join(cacheDir, 'entry-fresh');
  mkdirSync(freshEntry, { recursive: true });
  writeFileSync(join(freshEntry, 'blob'), 'x'.repeat(1000));
  register({ dir: cacheDir, name: 'My cache' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  await captureLog(() => cli(['--delete', '--cache', 'all']));

  expect(existsSync(freshEntry)).toBe(false);
  expect(existsSync(cacheDir)).toBeTruthy();
});

test('--cache all without --delete reports what would be emptied and writes nothing', async () => {
  const casDir = join(tmpHome, 'compilation-cache');
  const leaf = join(casDir, 'v9.data.leaf');
  mkdirSync(casDir, { recursive: true });
  writeFileSync(leaf, 'x'.repeat(1000));
  register({ dir: casDir, name: 'Xcode compilation cache', prune: 'atomic' });
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const before = loadConfig();

  const output = await captureLog(() => cli(['--cache', 'all']));

  expect(output).toMatch(/Xcode compilation cache/);
  expect(output).toMatch(/empt/i);
  expect(existsSync(leaf)).toBeTruthy();
  expect(loadConfig()).toEqual(before);
});

test('--delete --cache all under a scoped home refuses machine-global caches', async () => {
  const globalCas = join(fakeHome, 'Library', 'Developer', 'Xcode', 'DerivedData', 'CompilationCache.noindex');
  const leaf = join(globalCas, 'v9.data.leaf');
  mkdirSync(globalCas, { recursive: true });
  writeFileSync(leaf, 'x'.repeat(1000));
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const output = await captureLog(() => cli(['--delete', '--cache', 'all']));

  expect(existsSync(leaf)).toBeTruthy();
  expect(output).toMatch(/STIM_HOME/);
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

test('--cache all reaches caches only: never a device, never a project entry', async () => {
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
  installDeviceExecutor({ devices: [{ udid: 'UDID-LIVE', name: 'stim-live' }], execCalls });

  await captureLog(() => sweepingGc({ delete: true, cache: 'all' }));

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
  await expect(() => program.parseAsync(['node', 'stim', 'gc', '--older-than', 'lastweek'])).rejects.toThrow(
    /must be a whole number of days/,
  );
});

test('rejects a blank --cache instead of widening the run', async () => {
  for (const value of ['', '   ']) {
    const program = new Command();
    program.exitOverride();
    gcCommand(program);
    await expect(() => program.parseAsync(['node', 'stim', 'gc', '--cache', value])).rejects.toThrow(
      /must name a cache/,
    );
  }
});

test('describeUnverifiableDevices names Stim devices it cannot verify', () => {
  const notices = describeUnverifiableDevices(['stim-alpha', 'iPhone 17 Pro'], ['stim-beta', 'Pixel_6_API_34']);
  const joined = notices.join('\n');
  expect(joined).toMatch(/stim-alpha/);
  expect(joined).toMatch(/stim-beta/);
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
  const notices = describeUnverifiableDevices(['stim-alpha'], [], {
    reason: 'STIM_HOME scopes this config while simulators are machine-global',
  });
  expect(notices.join('\n')).toMatch(/STIM_HOME/);
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
      logFile: `${projectRoot}/.stim/logs/build-${platform}.ndjson`,
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

function writeLeaseFile({
  platform = 'ios',
  id = 'UDID-LEASE',
  holder = '/w/holder',
  expiresInMs = 60_000,
  body = null,
}: {
  platform?: string;
  id?: string;
  holder?: string;
  expiresInMs?: number;
  body?: string | null;
}) {
  mkdirSync(deviceLocksDir(), { recursive: true });
  const path = deviceLeasePath(platform, id);
  const now = Date.now();
  writeFileSync(
    path,
    body ??
      JSON.stringify({
        version: 1,
        platform,
        id,
        deviceName: 'Old iPhone',
        holder,
        token: 'token-1',
        grantedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + expiresInMs).toISOString(),
      }),
  );
  return path;
}

describe('expired device leases', () => {
  test('a bare gc reports an expired lease and removes nothing', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const path = writeLeaseFile({ expiresInMs: -1000 });

    const output = await captureLog(() => sweepingGc({}));
    expect(output).toMatch(/Expired device leases \(1\)/);
    expect(output).toMatch(/UDID-LEASE/);
    expect(output).toMatch(/\/w\/holder/);
    expect(existsSync(path)).toBe(true);
  });

  test('--delete removes the expired lease and leaves a live one alone', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const expired = writeLeaseFile({ id: 'UDID-OLD', expiresInMs: -1000 });
    const live = writeLeaseFile({ id: 'UDID-LIVE', holder: tmpHome, expiresInMs: 600_000 });

    const output = await captureLog(() => sweepingGc({ delete: true }));
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(output).toMatch(/Cleared the expired ios device lease on UDID-OLD/);
  });

  test('a file that does not parse is reported and kept', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const path = writeLeaseFile({ id: 'UDID-BROKEN', body: '{ not a lease' });

    const output = await captureLog(() => sweepingGc({ delete: true }));
    expect(output).toMatch(/Device lease files kept \(1\)/);
    expect(output).toMatch(/does not parse as a lease/);
    expect(existsSync(path)).toBe(true);
  });

  test('an unexpired lease whose holder is gone is reported and kept', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    const path = writeLeaseFile({ id: 'UDID-ABSENT', holder: join(fakeHome, 'unmounted'), expiresInMs: 600_000 });

    const output = await captureLog(() => sweepingGc({ delete: true }));
    expect(output).toMatch(/Device lease files kept \(1\)/);
    expect(output).toMatch(/is not on this machine, but the lease runs until/);
    expect(existsSync(path)).toBe(true);
  });

  test('a lease of a live workspace is not reported at all', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    installExecutor();
    writeLeaseFile({ holder: tmpHome, expiresInMs: 600_000 });

    const output = await captureLog(() => sweepingGc({}));
    expect(output).not.toMatch(/device lease/i);
  });
});

test('an expired lease counts as something to reclaim', () => {
  const lines = formatGcReport({
    deviceLeases: {
      expired: [
        {
          path: '/h/device-locks/ios-U.json',
          name: 'ios-U.json',
          platform: 'ios',
          id: 'U',
          lease: {
            version: 1,
            platform: 'ios',
            id: 'U',
            deviceName: 'Old iPhone',
            holder: '/w/dead',
            token: 't',
            grantedAt: null,
            expiresAt: '2026-09-02T12:00:00.000Z',
          },
        },
      ],
      kept: [],
    },
  }).join('\n');
  expect(lines.split('\n')[0]).not.toMatch(/^Nothing to reclaim\.$/);
  expect(lines).toMatch(/Expired device leases \(1\)/);
  expect(lines).toMatch(/Old iPhone/);
  expect(lines).toMatch(/\/w\/dead/);
});

test('a kept lease file alone is not something to reclaim', () => {
  const lines = formatGcReport({
    deviceLeases: {
      expired: [],
      kept: [{ name: 'ios-U.json', path: '/h/device-locks/ios-U.json', reason: 'it does not parse as a lease' }],
    },
  }).join('\n');
  expect(lines).toMatch(/Nothing to reclaim/);
  expect(lines).toMatch(/Device lease files kept \(1\)/);
});
