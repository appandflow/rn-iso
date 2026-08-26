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

// `cache list` is gone as a verb, so its one piece of information -- which
// rows a project described itself and which ones rn-iso merely recognised --
// has to survive in gc's report or it is lost.
test('the cache report says which caches were registered and which were detected', () => {
  const lines = formatGcReport({
    skipped: [],
    deadProjects: [],
    caches: [
      makeCacheDescriptor({ name: 'Metro transforms', dir: '/c/metro', note: 'from a metro.config.js', bytes: 2048, source: 'registered' }),
      makeCacheDescriptor({ name: 'Xcode compilation cache', dir: '/c/cas', note: 'index-backed', bytes: 4096, source: 'detected' }),
    ],
  }).join('\n');
  expect(lines).toMatch(/Metro transforms.*registered/);
  expect(lines).toMatch(/Xcode compilation cache.*detected/);
});

// --- findOrphanedDevices (pure) ----------------------------------------

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
  expect(result.orphaned.map((o) => o.id).sort()).toEqual(['U1', 'rn-iso-old']);
});

test('devices referenced by a project on an unmounted volume are kept', () => {
  const result = findOrphanedDevices({
    sims: [makeIosSim({ udid: 'U1', name: 'rn-iso-ext' })],
    avds: [],
    config: makeConfig({ projects: { '/Volumes/Ext/p': { platforms: { ios: { deviceUdid: 'U1', owned: true } } } } }),
    isMounted: () => false,
  });
  expect(result.orphaned.length).toBe(0);
  expect(result.kept[0].reason).toMatch(/not mounted/);
});

test('a device named by a non-owned (legacy/stale) record is still counted as referenced, not orphaned', () => {
  const result = findOrphanedDevices({
    sims: [makeIosSim({ udid: 'U1', name: 'rn-iso-stale-record' })],
    avds: ['rn-iso-stale-avd'],
    config: makeConfig({
      projects: {
        '/p': {
          platforms: {
            // No `owned: true` on either record -- a stale/mid-transition
            // record must still count as a reference, or this sweep would
            // propose deleting a device an unowned record still points at.
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

// I3: a dead project's config entry hasn't been removed yet by the time the
// device sweep runs in the SAME gc invocation -- it must not count as a
// live reference, or the device only gets reaped on a second run.
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

// --- findStaleProjectDevices (pure) ------------------------------------
//
// The gap this closes: `stop` has no --delete and a plain checkout cannot be
// `worktree remove`d, so the main checkout's owned sim is shut down but never
// reaped. Nothing else on the machine would ever destroy it.

const staleSims = [makeIosSim({ udid: 'U-STALE', name: 'rn-iso-stale' })];

function staleConfig(extra = {}) {
  return makeConfig({
    projects: {
      '/live/p': { platforms: { ios: { deviceUdid: 'U-STALE', owned: true } } },
      ...extra,
    },
  });
}

// --- stale device RECORDS ---------------------------------------------
//
// The gap two field-test runs fell into: `status` warns "recorded sim <udid> no
// longer exists" forever, and `gc` said nothing -- the path is alive so the
// dead-entry sweep skips it, and the device is gone so the orphan sweep, which
// starts from the live listing, cannot see it at all.

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

// A listing that could not be READ is not evidence that anything is gone.
// Reading it as such would propose clearing every device record on the machine
// the first time simctl is missing or wedged.
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

// Ownership gates DESTRUCTION, and this destroys nothing. A legacy record
// pointing at a simulator that no longer exists is exactly as useless as an
// owned one, and leaving it keeps `status` warning about it forever.
test('findStaleDeviceRecords covers a non-owned record too, and reports its ownership', () => {
  const stale = findStaleDeviceRecords({
    config: makeConfig({ projects: { '/a': { platforms: { ios: { deviceUdid: 'GONE' } } } } }),
    sims: [],
  });
  expect(stale.map((r) => r.owned)).toEqual([false]);
});

// A legacy physical record names hardware rn-iso never created; there is no AVD
// listing it could be checked against, and nothing may consume it.
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
  expect(stale[0].project).toBe('/live/p');
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

// CLAUDE.md item 8: on doubt, skip. An unreadable timestamp is not evidence
// that a project is abandoned.
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

// A record naming a device that is not on the machine any more is not
// something to issue a delete at: the live listing is the only proof.
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

// A dead project's device is already the orphan sweep's job. Proposing it
// twice would issue two deletes at the same udid in one run.
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

// --- Action-level tests -----------------------------------------------
//
// The tests above only exercise the pure formatter. These drive the real
// Commander action against a tmpdir RN_ISO_HOME (config.js) plus a tmpdir
// HOME, so a "dead" project path resolves to a real, mounted boot-volume
// ancestor rather than to the developer's own repos.

let tmpHome;
let fakeHome;
let originalHome;
let originalTmpdir;

// No device tooling and no shellouts of any kind: any `run` is a bug, and
// runQuiet answers the lsof port lookup reclaimProject makes with "no live
// pid". Tests that need a live simctl listing use installDeviceExecutor.
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

// Through commander, exactly as the binary does: the RN_ISO_HOME guard is
// live on this path, so the device sweep is a no-op here by design.
async function cli(args = []) {
  const program = new Command();
  gcCommand(program);
  await program.parseAsync(['node', 'rn-iso', 'gc', ...args]);
}

// The sweep machinery itself (teardown ordering, containment, stale reaping)
// can only be exercised with the scoped-home guard lifted, and the guard is
// deliberately unreachable from the CLI. `runGc` takes the decision as a
// parameter commander never supplies, so these tests opt in explicitly and
// every device they touch is a mocked one.
async function sweepingGc(opts = {}) {
  await runGc({ unsafeAllowScopedDeviceSweep: true, ...opts });
}

function captureLog(fn) {
  const logs = [];
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

  // gc reports the shared caches on every run now, and one of them (Metro's
  // file maps) lives loose in the system temp directory. Without redirecting
  // TMPDIR, a `--delete --older-than` test would trim the developer's own
  // Metro file maps off the real machine.
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

// A bare `gc` must never write. The unmounted-volume entry is the one that
// matters: an unplugged external SSD makes a live project look dead, and
// unregistering it would drop its device claim (CLAUDE.md item 8).
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

  expect(loadConfig().projects[localDeadPath]).toBeTruthy();
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
  // localDeadPath deliberately not created on disk: existsSync(localDeadPath) is false.

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

  const cfg = loadConfig();
  // The unmounted-volume entry survives: its volume could not be confirmed
  // mounted, so it must not be treated as dead.
  expect(cfg.projects[unmountedPath]).toBeTruthy();
  expect(cfg.projects[unmountedPath].metroPort).toBe(8100);
  // The genuinely local dead entry (boot volume, directory just missing) is
  // still pruned as before.
  expect(cfg.projects[localDeadPath]).toBe(undefined);
});

// --- Device-delete integration -----------------------------------------
//
// The action tests above never exercise the device-delete path:
// installExecutor() throws on any `run`, so listAllIosSims() always throws
// and orphanedDevices is always []. These seed a live simctl listing so a
// real rn-iso-* sim goes through resolveOwnedIosSim -> shutdown -> delete.

function iosListJson(devices) {
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

function installDeviceExecutor({ devices, execCalls, throwOnShutdownFor = new Set() }) {
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

function touchedDaysAgo(dir, days) {
  mkdirSync(dir, { recursive: true });
  const when = new Date(Date.now() - days * DAY_MS);
  utimesSync(dir, when, when);
}

test('--delete re-verifies ownership before shutdown, shuts down before delete, and contains a per-device teardown throw', async () => {
  const execCalls = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-1', name: 'rn-iso-orphan-1' },
      { udid: 'UDID-2', name: 'rn-iso-orphan-2' },
    ],
    execCalls,
    throwOnShutdownFor: new Set(['UDID-1']),
  });
  // Config references neither device: both are orphaned.
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
  // The first device's shutdown threw, so its delete must never have been issued
  // -- containment: one bad device must not abort the rest of the sweep, and a
  // failed teardown must not still proceed to delete.
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-1'))).toBe(false);
});

test('report-mode gc lists a seeded orphaned ios sim but issues no shutdown or delete command', async () => {
  const execCalls = [];
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

// I3: before the fix, findOrphanedDevices was computed from the
// pre-prune config, so a dead project's owned device still counted as
// "referenced" on the run that prunes it -- it only got swept on a SECOND
// `gc --delete`. One run must now both prune the dead entry and reap its
// device.
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
  const execCalls = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-DEAD', name: 'rn-iso-dead-owner' }],
    execCalls,
  });

  await sweepingGc({ delete: true });

  const cfg = loadConfig();
  expect(cfg.projects[localDeadPath]).toBe(undefined);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown UDID-DEAD'))).toBeTruthy();
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-DEAD'))).toBeTruthy();
});

// --- The two blast-radius holes ----------------------------------------
//
// These are two DIFFERENT holes with the same consequence: an under-informed
// reference map makes every rn-iso-* device on the machine look orphaned, and
// --delete then destroys live environments belonging to someone else. Two
// real simulators were destroyed this way. Each guard is tested with the
// other one lifted, so neither can quietly stop carrying its own weight.

// Hole (a): no config file at all. Tested with the scoped-home guard lifted,
// so the cfg === null guard is the only thing standing between --delete and
// every rn-iso-* device on the machine.
test('gc with no config names rn-iso devices it cannot verify, but never touches them', async () => {
  const execCalls = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-LIVE', name: 'rn-iso-someones-live-env', state: 'Booted' }],
    execCalls,
  });
  // No saveConfig() call at all, so loadConfig() returns null, not {projects:{}}.

  const output = await captureLog(() => sweepingGc({ delete: true }));

  // It IS named -- silently skipping meant a wiped config orphaned simulators
  // that nothing would ever surface again.
  expect(output).toMatch(/rn-iso-someones-live-env/);
  expect(output).toMatch(/no rn-iso config found/i);
  expect(output).toMatch(/cannot be verified as orphaned/i);
  // ...but it is never classified as orphaned, and never acted on.
  expect(output).not.toMatch(/Orphaned devices/i);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
});

// Hole (b): a POPULATED config under a non-default RN_ISO_HOME. This is the
// one that actually destroyed simulators: a throwaway home stops being null
// the moment any command writes to it, and from that point the sweep looked
// perfectly well-informed while knowing nothing about the machine's real
// devices. RN_ISO_HOME scopes the config; sims and AVDs are machine-global.
test('a config scoped by RN_ISO_HOME never sweeps machine-global devices', async () => {
  const execCalls = [];
  installDeviceExecutor({
    devices: [
      { udid: 'UDID-REAL-1', name: 'rn-iso-real-env-1', state: 'Booted' },
      { udid: 'UDID-REAL-2', name: 'rn-iso-real-env-2' },
    ],
    execCalls,
  });
  // Populated, and referencing none of the machine's devices -- exactly what a
  // throwaway home looks like after one `up`.
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

// The guard spares DEVICES and machine-global CACHES. Dead-entry pruning is
// genuinely config-scoped -- the entries live in the config being read -- so it
// stays fully functional under RN_ISO_HOME.
test('the RN_ISO_HOME guard does not disable dead-entry pruning', async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({ version: 2, projects: { [localDeadPath]: { metroPort: 8100 } }, repos: {} });
  installExecutor();

  await cli(['--delete']);

  expect(loadConfig().projects[localDeadPath]).toBe(undefined);
});

// --- Stale owned devices (--older-than) --------------------------------

test('--delete --older-than reaps an owned device whose project went untouched, and clears its record', async () => {
  const stalePath = join(fakeHome, 'abandoned-project');
  touchedDaysAgo(stalePath, 90);
  saveConfig({
    version: 2,
    projects: { [stalePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-STALE', owned: true } } } },
    repos: {},
  });
  const execCalls = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-STALE', name: 'rn-iso-abandoned' }],
    execCalls,
  });

  await sweepingGc({ delete: true, olderThan: 30 });

  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown UDID-STALE'))).toBeTruthy();
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete UDID-STALE'))).toBeTruthy();
  const cfg = loadConfig();
  expect(cfg.projects[stalePath]).toBeTruthy();
  expect(cfg.projects[stalePath].platforms?.ios).toBe(undefined);
});

// The whole field-test complaint, end to end: a live project whose recorded sim
// is gone warned in `status` on every run and `gc` proposed nothing about it.
test('gc reports a live project whose recorded sim is gone, and --delete clears the record only', async () => {
  const livePath = join(fakeHome, 'live-project');
  touchedDaysAgo(livePath, 1);
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-VANISHED', owned: true } } } },
    repos: {},
  });
  const execCalls = [];
  installDeviceExecutor({ devices: [], execCalls });

  const report = await captureLog(() => sweepingGc({ delete: false }));
  expect(report).toMatch(/Stale device records \(1\)/);
  expect(report).toMatch(/UDID-VANISHED/);
  expect(loadConfig().projects[livePath].platforms.ios).toBeTruthy();

  const output = await captureLog(() => sweepingGc({ delete: true }));
  expect(output).toMatch(/Cleared the ios record/);
  const cfg = loadConfig();
  expect(cfg.projects[livePath]).toBeTruthy();
  expect(cfg.projects[livePath].platforms?.ios).toBe(undefined);
  // Never touches devices: the premise is that there is none left to touch.
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
  expect(loadConfig().projects[livePath].platforms.ios).toBeTruthy();
});

test('--older-than without --delete only reports the stale device', async () => {
  const stalePath = join(fakeHome, 'abandoned-project');
  touchedDaysAgo(stalePath, 90);
  saveConfig({
    version: 2,
    projects: { [stalePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-STALE', owned: true } } } },
    repos: {},
  });
  const execCalls = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-STALE', name: 'rn-iso-abandoned' }],
    execCalls,
  });

  const output = await captureLog(() => sweepingGc({ delete: false, olderThan: 30 }));

  expect(output).toMatch(/rn-iso-abandoned/);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
  expect(loadConfig().projects[stalePath].platforms.ios).toBeTruthy();
});

test('a device whose project is still being worked in is never reaped by --older-than', async () => {
  const livePath = join(fakeHome, 'live-project');
  touchedDaysAgo(livePath, 1);
  saveConfig({
    version: 2,
    projects: { [livePath]: { metroPort: 8100, platforms: { ios: { deviceUdid: 'UDID-LIVE', owned: true } } } },
    repos: {},
  });
  const execCalls = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-LIVE', name: 'rn-iso-live' }],
    execCalls,
  });

  await sweepingGc({ delete: true, olderThan: 30 });

  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
  expect(loadConfig().projects[livePath].platforms.ios).toBeTruthy();
});

// --- Shared caches (the folded-in `cache list`) -------------------------

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

// Emptying a shared cache is a performance decision, not cleanup. A plain
// --delete is aimed at dead entries and orphaned devices, and must not take
// gigabytes of live cache with it.
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

  const { existsSync } = await import('node:fs');
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

  const { existsSync } = await import('node:fs');
  expect(existsSync(oldEntry)).toBe(false);
  expect(existsSync(freshEntry)).toBeTruthy();
});

// --- gc --delete --all: the whole-or-nothing caches ---------------------
//
// --older-than TRIMS entries by age, and an index-backed cache cannot be
// trimmed at all: Xcode's LLVM CAS addresses its `v9.*.leaf` data files from a
// `v4.actions` index, so removing leaves individually corrupts it. pruneCache
// declines it by design, which left nothing on the machine able to clear it.
// --all is that path, and it is emptying rather than trimming.

test('--delete --all empties an index-backed cache that --older-than cannot trim', async () => {
  // Registered INSIDE getConfigDir(): RN_ISO_HOME scopes what --all is allowed
  // to destroy, and a cache under the config dir is genuinely in scope.
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

  // The gap --all exists to close: age-based trimming skips this cache whole.
  await captureLog(() => cli(['--delete', '--older-than', '30']));
  expect(existsSync(leaf)).toBeTruthy();

  await captureLog(() => cli(['--delete', '--all']));
  expect(existsSync(leaf)).toBe(false);
  expect(existsSync(index)).toBe(false);
});

// Emptying an entries-style cache goes through pruneCache, the same code
// --older-than uses -- there is no second removal path for the ordinary case.
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

// The guard --all makes mandatory, and the reason this flag is dangerous:
// discoverCaches returns DETECTED caches as well as registered ones, and the
// detected ones are MACHINE-GLOBAL. Xcode's CAS sits under
// ~/Library/Developer/Xcode/DerivedData and Metro's file maps sit in
// os.tmpdir(); neither moves with RN_ISO_HOME. So --all under a throwaway home
// would empty the real machine's caches -- structurally the same bug as the
// scoped device sweep that destroyed two real simulators on this branch, aimed
// at disk instead of at live environments.
//
// RN_ISO_HOME scopes the config. Anything outside the config dir is
// machine-global. A scoped config must never destroy machine-global state.
test('--delete --all under a scoped home refuses machine-global caches', async () => {
  // Detected exactly the way it is on a real machine: HOME is redirected here,
  // so this is where caches.js looks for Xcode's CAS. It is outside
  // getConfigDir(), which is what makes it off limits.
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

// The SAME hole, one flag over. --older-than trims rather than empties, but
// trimming is destructive too and reaches the identical machine-global
// directories. Metro's file maps are the case that proves it: prune 'entries'
// (so pruneCache WILL trim them by age, unlike the index-backed CAS) living
// loose in os.tmpdir(), which does not move with RN_ISO_HOME.
//
// This test must use a trimmable cache. Pointing it at the Xcode CAS passes
// vacuously -- the CAS survives because pruneCache refuses atomic caches by
// design, not because any guard stopped it.
test('--delete --older-than under a scoped home refuses machine-global caches', async () => {
  // TMPDIR is redirected to fakeHome, which is OUTSIDE getConfigDir() (tmpHome)
  // -- the same relationship the real os.tmpdir() has to the real ~/.rn-iso.
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

// --all's blast radius is disk, never live environments. The device sweep is
// deliberately LIFTED here: --all must not widen its reach even on a run where
// the sweep is genuinely working.
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
  const execCalls = [];
  installDeviceExecutor({ devices: [{ udid: 'UDID-LIVE', name: 'rn-iso-live' }], execCalls });

  await captureLog(() => sweepingGc({ delete: true, all: true }));

  expect(execCalls.some((c) => c.startsWith('xcrun simctl shutdown'))).toBe(false);
  expect(execCalls.some((c) => c.startsWith('xcrun simctl delete'))).toBe(false);
  const cfg = loadConfig();
  expect(cfg.projects[livePath]).toBeTruthy();
  expect(cfg.projects[livePath].platforms?.ios).toBeTruthy();
  expect(existsSync(entry)).toBe(false);
});

test('rejects a non-numeric --older-than instead of silently skipping every entry', async () => {
  const program = new Command();
  program.exitOverride();
  gcCommand(program);
  await expect(() => program.parseAsync(['node', 'rn-iso', 'gc', '--older-than', 'lastweek'])).rejects.toThrow();
});

// With no config, gc must never DELETE (a missing config makes every rn-iso-*
// device look orphaned, including another RN_ISO_HOME's live ones) -- but it
// should still SAY they exist. Silently skipping meant a wiped config orphaned
// simulators that nothing would ever surface again.
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

// --- build locks -----------------------------------------------------------
//
// A build lock (engine/build-lock.js) is a directory saying "this pid is
// compiling this fingerprint". A machine that was rebooted, or a process that
// was SIGKILLed, leaves one behind. It is harmless -- the next builder takes
// it over on the pid-liveness check -- but it is debris, and `gc` is where
// debris is reported.
//
// The direction of doubt is the one every other sweep here takes: a lock whose
// holder is ALIVE is a build in progress, and nothing may touch it. Deleting
// one would put two workspaces on the same 19-minute compile, which is the
// exact failure single-flight exists to prevent.

function writeLock({ platform = 'ios', key = 'abc-debug-sim', pid, projectRoot = '/w/app-412' }) {
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
  expect(report.buildLocks.stale[0].pid).toBe(999999);
  expect(report.buildLocks.live.length).toBe(1);
  expect(report.buildLocks.live[0].projectRoot).toBe('/w/alive');
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
    buildLocks: { stale: [makeBuildLock({ platform: 'ios', key: 'k', pid: 9, projectRoot: '/w', path: '/h/l.lock' })], live: [] },
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

// --- build slots (engine/build-slots.js) -----------------------------------
//
// A build SLOT is the opt-in concurrency limit's semaphore. Like a build lock,
// a reboot or a SIGKILL leaves a stale one behind; gc reports and (with
// --delete) clears the stale ones, and never touches a slot a live builder holds.

function writeSlot({ index = 0, pid, projectRoot = '/w/app-412' }) {
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
  expect(report.buildSlots.stale[0].pid).toBe(999999);
  expect(report.buildSlots.live.length).toBe(1);
});

test('formatGcReport names a stale build slot', () => {
  const lines = formatGcReport({
    buildSlots: { stale: [makeBuildSlot({ index: 1, pid: 999999, projectRoot: '/w/dead', path: '/h/build-slots/slot-1' })], live: [] },
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
