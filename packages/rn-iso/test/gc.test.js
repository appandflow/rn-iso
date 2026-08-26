import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { saveConfig, loadConfig } from '../src/config.js';
import { register } from '../src/cache-manifest.js';
import gcCommand, {
  collectGcReport,
  describeUnverifiableDevices,
  findOrphanedDevices,
  findStaleDeviceRecords,
  findStaleProjectDevices,
  formatGcReport,
  runGc,
} from '../src/commands/gc.js';

const DAY_MS = 24 * 60 * 60 * 1000;

test('names skipped entries and why they were skipped', () => {
  const lines = formatGcReport({
    skipped: [{ dir: '/Volumes/ExternalSSD/proj', reason: 'volume /Volumes/ExternalSSD is not mounted' }],
    deadProjects: [],
  }).join('\n');
  assert.match(lines, /not mounted/);
  assert.match(lines, /skipped/i);
});

test('says nothing to reclaim when everything is clean', () => {
  const lines = formatGcReport({ skipped: [], deadProjects: [] }).join('\n');
  assert.match(lines, /nothing to reclaim/i);
});

test('lists dead project entries', () => {
  const lines = formatGcReport({
    skipped: [],
    deadProjects: ['/gone/proj'],
  }).join('\n');
  assert.match(lines, /\/gone\/proj/);
  assert.match(lines, /Dead project entries/);
});

test('headline does not claim "nothing to reclaim" without flagging unchecked entries', () => {
  const lines = formatGcReport({
    skipped: [{ dir: '/Volumes/ExternalSSD/proj', reason: 'volume /Volumes/ExternalSSD is not mounted' }],
    deadProjects: [],
  }).join('\n');
  const headline = lines.split('\n')[0];
  assert.doesNotMatch(headline, /^Nothing to reclaim\.$/);
  assert.match(headline, /could not be checked/i);
});

// `cache list` is gone as a verb, so its one piece of information -- which
// rows a project described itself and which ones rn-iso merely recognised --
// has to survive in gc's report or it is lost.
test('the cache report says which caches were registered and which were detected', () => {
  const lines = formatGcReport({
    skipped: [],
    deadProjects: [],
    caches: [
      { name: 'Metro transforms', dir: '/c/metro', note: 'from a metro.config.js', bytes: 2048, source: 'registered' },
      { name: 'Xcode compilation cache', dir: '/c/cas', note: 'index-backed', bytes: 4096, source: 'detected' },
    ],
  }).join('\n');
  assert.match(lines, /Metro transforms.*registered/);
  assert.match(lines, /Xcode compilation cache.*detected/);
});

// --- findOrphanedDevices (pure) ----------------------------------------

test('findOrphanedDevices proposes only rn-iso devices absent from config', () => {
  const result = findOrphanedDevices({
    sims: [
      { udid: 'U1', name: 'rn-iso-gone' },
      { udid: 'U2', name: 'rn-iso-live' },
      { udid: 'U3', name: 'iPhone 17 Pro' },
    ],
    avds: ['rn-iso-old', 'Pixel_7'],
    config: { projects: { '/p': { platforms: {
      ios: { deviceUdid: 'U2', owned: true },
      android: { avdName: 'rn-iso-kept', owned: true },
    } } } },
    isMounted: () => true,
  });
  assert.deepEqual(result.orphaned.map(o => o.id).sort(), ['U1', 'rn-iso-old']);
});

test('devices referenced by a project on an unmounted volume are kept', () => {
  const result = findOrphanedDevices({
    sims: [{ udid: 'U1', name: 'rn-iso-ext' }],
    avds: [],
    config: { projects: { '/Volumes/Ext/p': { platforms: { ios: { deviceUdid: 'U1', owned: true } } } } },
    isMounted: () => false,
  });
  assert.equal(result.orphaned.length, 0);
  assert.match(result.kept[0].reason, /not mounted/);
});

test('a device named by a non-owned (legacy/stale) record is still counted as referenced, not orphaned', () => {
  const result = findOrphanedDevices({
    sims: [{ udid: 'U1', name: 'rn-iso-stale-record' }],
    avds: ['rn-iso-stale-avd'],
    config: {
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
    },
    isMounted: () => true,
  });
  assert.equal(result.orphaned.length, 0);
});

// I3: a dead project's config entry hasn't been removed yet by the time the
// device sweep runs in the SAME gc invocation -- it must not count as a
// live reference, or the device only gets reaped on a second run.
test('a device owned only by a dead project is orphaned when that project is passed as deadProjects', () => {
  const result = findOrphanedDevices({
    sims: [{ udid: 'U1', name: 'rn-iso-dead' }],
    avds: [],
    config: { projects: { '/gone/p': { platforms: { ios: { deviceUdid: 'U1', owned: true } } } } },
    isMounted: () => true,
    deadProjects: ['/gone/p'],
  });
  assert.deepEqual(result.orphaned.map(o => o.id), ['U1']);
});

// --- findStaleProjectDevices (pure) ------------------------------------
//
// The gap this closes: `stop` has no --delete and a plain checkout cannot be
// `worktree remove`d, so the main checkout's owned sim is shut down but never
// reaped. Nothing else on the machine would ever destroy it.

const staleSims = [{ udid: 'U-STALE', name: 'rn-iso-stale' }];

function staleConfig(extra = {}) {
  return {
    projects: {
      '/live/p': { platforms: { ios: { deviceUdid: 'U-STALE', owned: true } } },
      ...extra,
    },
  };
}

// --- stale device RECORDS ---------------------------------------------
//
// The gap two field-test runs fell into: `status` warns "recorded sim <udid> no
// longer exists" forever, and `gc` said nothing -- the path is alive so the
// dead-entry sweep skips it, and the device is gone so the orphan sweep, which
// starts from the live listing, cannot see it at all.

test('findStaleDeviceRecords reports a live project pointing at a device that is gone', () => {
  const stale = findStaleDeviceRecords({
    config: {
      projects: {
        '/a': { platforms: { ios: { deviceUdid: 'GONE', owned: true } } },
        '/b': { platforms: { ios: { deviceUdid: 'HERE', owned: true } } },
        '/c': { platforms: { android: { avdName: 'rn-iso-gone', owned: true } } },
        '/d': { platforms: { android: { avdName: 'rn-iso-here', owned: true } } },
      },
    },
    sims: [{ udid: 'HERE', name: 'rn-iso-b' }],
    avds: ['rn-iso-here'],
  });
  assert.deepEqual(stale.map(r => [r.kind, r.id, r.project]), [
    ['ios', 'GONE', '/a'],
    ['android', 'rn-iso-gone', '/c'],
  ]);
});

// A listing that could not be READ is not evidence that anything is gone.
// Reading it as such would propose clearing every device record on the machine
// the first time simctl is missing or wedged.
test('findStaleDeviceRecords proposes nothing for a platform whose listing failed', () => {
  const config = {
    projects: {
      '/a': { platforms: { ios: { deviceUdid: 'GONE' }, android: { avdName: 'rn-iso-gone' } } },
    },
  };
  assert.deepEqual(findStaleDeviceRecords({ config, sims: [], avds: [], simsChecked: false }).map(r => r.kind), ['android']);
  assert.deepEqual(findStaleDeviceRecords({ config, sims: [], avds: [], avdsChecked: false }).map(r => r.kind), ['ios']);
  assert.deepEqual(findStaleDeviceRecords({ config, simsChecked: false, avdsChecked: false }), []);
});

test('findStaleDeviceRecords skips a project the dead-entry sweep already claimed', () => {
  const stale = findStaleDeviceRecords({
    config: { projects: { '/dead': { platforms: { ios: { deviceUdid: 'GONE' } } } } },
    sims: [],
    deadProjects: ['/dead'],
  });
  assert.deepEqual(stale, []);
});

// Ownership gates DESTRUCTION, and this destroys nothing. A legacy record
// pointing at a simulator that no longer exists is exactly as useless as an
// owned one, and leaving it keeps `status` warning about it forever.
test('findStaleDeviceRecords covers a non-owned record too, and reports its ownership', () => {
  const stale = findStaleDeviceRecords({
    config: { projects: { '/a': { platforms: { ios: { deviceUdid: 'GONE' } } } } },
    sims: [],
  });
  assert.deepEqual(stale.map(r => r.owned), [false]);
});

// A legacy physical record names hardware rn-iso never created; there is no AVD
// listing it could be checked against, and nothing may consume it.
test('findStaleDeviceRecords never calls a physical serial record stale', () => {
  assert.deepEqual(findStaleDeviceRecords({
    config: { projects: { '/a': { platforms: { android: { serial: 'R58M1234' } } } } },
    avds: [],
  }), []);
});

test('the report names stale device records and says the delete touches no device', () => {
  const lines = formatGcReport({
    staleDeviceRecords: [{ kind: 'ios', id: 'GONE', project: '/a' }],
  }).join('\n');
  assert.match(lines, /Stale device records \(1\)/);
  assert.match(lines, /ios GONE is not on this machine/);
  assert.match(lines, /recorded by \/a/);
  assert.match(lines, /RECORD only/);
  assert.doesNotMatch(lines, /Nothing to reclaim/, 'a stale record is something to reclaim');
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
  assert.deepEqual(stale.map(d => d.id), ['U-STALE']);
  assert.equal(stale[0].project, '/live/p');
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
  assert.equal(stale.length, 0);
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
  assert.equal(stale.length, 0);
});

test('findStaleProjectDevices ignores devices rn-iso does not own', () => {
  const now = Date.now();
  const stale = findStaleProjectDevices({
    config: { projects: { '/live/p': { platforms: { ios: { deviceUdid: 'U-STALE' } } } } },
    sims: staleSims,
    avds: [],
    olderThanDays: 30,
    now,
    lastTouched: () => now - 90 * DAY_MS,
  });
  assert.equal(stale.length, 0);
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
  assert.equal(stale.length, 0);
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
  assert.equal(stale.length, 0);
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
    .finally(() => { console.log = originalLog; })
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

  assert.ok(loadConfig().projects[localDeadPath], 'a bare gc must not prune anything');
  assert.deepEqual(loadConfig(), before, 'bare gc must not mutate config');
});

test('gc reports the three things that still orphan, and no DerivedData', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();

  const report = await collectGcReport();

  assert.ok(!('derivedData' in report), 'DerivedData sweep should be gone');
  assert.ok('deadProjects' in report);
  assert.ok('orphanedDevices' in report);
  assert.ok('caches' in report);
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
  assert.ok(cfg.projects[unmountedPath], 'entry on unmounted volume must not be pruned');
  assert.equal(cfg.projects[unmountedPath].metroPort, 8100);
  // The genuinely local dead entry (boot volume, directory just missing) is
  // still pruned as before.
  assert.equal(cfg.projects[localDeadPath], undefined);
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
      'com.apple.CoreSimulator.SimRuntime.iOS-17-4': devices.map(d => ({
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

  const firstListIndex = execCalls.findIndex(c => c.includes('simctl list devices --json'));
  const shutdown1Index = execCalls.findIndex(c => c.startsWith('xcrun simctl shutdown UDID-1'));
  const shutdown2Index = execCalls.findIndex(c => c.startsWith('xcrun simctl shutdown UDID-2'));
  const delete2Index = execCalls.findIndex(c => c.startsWith('xcrun simctl delete UDID-2'));

  assert.ok(firstListIndex !== -1, 'ownership must be re-checked via a live listing');
  assert.ok(firstListIndex < shutdown1Index, 'the live listing (resolveOwnedIosSim) must run before shutdown');
  assert.ok(shutdown2Index !== -1 && delete2Index !== -1, 'the second device must still be processed');
  assert.ok(shutdown2Index < delete2Index, 'shutdown must precede delete');
  // The first device's shutdown threw, so its delete must never have been issued
  // -- containment: one bad device must not abort the rest of the sweep, and a
  // failed teardown must not still proceed to delete.
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl delete UDID-1')), false);
});

test('report-mode gc lists a seeded orphaned ios sim but issues no shutdown or delete command', async () => {
  const execCalls = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-9', name: 'rn-iso-report-orphan' }],
    execCalls,
  });
  saveConfig({ version: 2, projects: {}, repos: {} });

  const output = await captureLog(() => sweepingGc({ delete: false }));

  assert.match(output, /rn-iso-report-orphan/);
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl shutdown')), false);
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl delete')), false);
});

// I3: before the fix, findOrphanedDevices was computed from the
// pre-prune config, so a dead project's owned device still counted as
// "referenced" on the run that prunes it -- it only got swept on a SECOND
// `gc --delete`. One run must now both prune the dead entry and reap its
// device.
test('--delete reaps a dead project\'s owned orphan device in the same run it prunes the entry', async () => {
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
  assert.equal(cfg.projects[localDeadPath], undefined, 'the dead project entry must be pruned');
  assert.ok(execCalls.some(c => c.startsWith('xcrun simctl shutdown UDID-DEAD')), 'expected the owned device to be shut down in this same run');
  assert.ok(execCalls.some(c => c.startsWith('xcrun simctl delete UDID-DEAD')), 'expected the owned device to be deleted in this same run');
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
  assert.match(output, /rn-iso-someones-live-env/, 'an unverifiable device should still be surfaced by name');
  assert.match(output, /no rn-iso config found/i);
  assert.match(output, /cannot be verified as orphaned/i);
  // ...but it is never classified as orphaned, and never acted on.
  assert.doesNotMatch(output, /Orphaned devices/i, 'must not classify it as orphaned');
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl shutdown')), false);
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl delete')), false);
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

  assert.doesNotMatch(output, /Orphaned devices/i, 'a scoped config must not classify global devices as orphaned');
  assert.match(output, /RN_ISO_HOME/, 'the skip must be reported, not silent');
  assert.match(output, /rn-iso-real-env-1/, 'the devices it declined to judge are still named');
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl shutdown')), false, 'no device may be shut down');
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl delete')), false, 'no device may be deleted');
});

// The guard spares DEVICES and machine-global CACHES. Dead-entry pruning is
// genuinely config-scoped -- the entries live in the config being read -- so it
// stays fully functional under RN_ISO_HOME.
test('the RN_ISO_HOME guard does not disable dead-entry pruning', async () => {
  const localDeadPath = join(fakeHome, 'no-longer-here');
  saveConfig({ version: 2, projects: { [localDeadPath]: { metroPort: 8100 } }, repos: {} });
  installExecutor();

  await cli(['--delete']);

  assert.equal(loadConfig().projects[localDeadPath], undefined, 'dead entries must still be pruned');
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

  assert.ok(execCalls.some(c => c.startsWith('xcrun simctl shutdown UDID-STALE')), 'the stale device must be shut down');
  assert.ok(execCalls.some(c => c.startsWith('xcrun simctl delete UDID-STALE')), 'the stale device must be deleted');
  const cfg = loadConfig();
  assert.ok(cfg.projects[stalePath], 'the project itself is alive and must keep its entry');
  assert.equal(cfg.projects[stalePath].platforms?.ios, undefined, 'the record of a deleted device must be cleared');
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
  assert.match(report, /Stale device records \(1\)/);
  assert.match(report, /UDID-VANISHED/);
  assert.ok(loadConfig().projects[livePath].platforms.ios, 'a report must not clear the record');

  const output = await captureLog(() => sweepingGc({ delete: true }));
  assert.match(output, /Cleared the ios record/);
  const cfg = loadConfig();
  assert.ok(cfg.projects[livePath], 'the project is alive and keeps its entry');
  assert.equal(cfg.projects[livePath].platforms?.ios, undefined, 'only the record goes');
  // Never touches devices: the premise is that there is none left to touch.
  assert.equal(execCalls.some(c => /simctl (shutdown|delete)/.test(c)), false);
  assert.equal(execCalls.some(c => /avdmanager delete/.test(c)), false);
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
  assert.doesNotMatch(output, /Stale device records/);
  assert.ok(loadConfig().projects[livePath].platforms.ios, 'the record stays');
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

  assert.match(output, /rn-iso-abandoned/);
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl shutdown')), false);
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl delete')), false);
  assert.ok(loadConfig().projects[stalePath].platforms.ios, 'a report must not clear the record');
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

  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl delete')), false);
  assert.ok(loadConfig().projects[livePath].platforms.ios, 'a live project keeps its device');
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

  assert.match(output, /My cache/);
  assert.match(output, /registered/);
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
  assert.ok(existsSync(entry), 'a plain --delete must leave shared caches alone');
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
  assert.equal(existsSync(oldEntry), false, 'the untouched entry should be trimmed');
  assert.ok(existsSync(freshEntry), 'a recently used entry must survive');
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
  assert.ok(
    report.caches.some(c => c.prune === 'atomic' && c.willEmpty),
    'an in-scope index-backed cache must be marked for emptying'
  );

  // The gap --all exists to close: age-based trimming skips this cache whole.
  await captureLog(() => cli(['--delete', '--older-than', '30']));
  assert.ok(existsSync(leaf), '--older-than must leave an index-backed cache alone');

  await captureLog(() => cli(['--delete', '--all']));
  assert.equal(existsSync(leaf), false, '--delete --all must empty the data');
  assert.equal(existsSync(index), false, 'the index goes with the data it addresses');
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

  assert.equal(existsSync(freshEntry), false, '--all empties; it does not filter by age');
  assert.ok(existsSync(cacheDir), 'the cache directory itself stays; only its entries go');
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

  assert.match(output, /Xcode compilation cache/);
  assert.match(output, /empt/i, 'the report must say the cache would be emptied');
  assert.ok(existsSync(leaf), '--all without --delete must write nothing');
  assert.deepEqual(loadConfig(), before, '--all without --delete must not mutate config');
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

  assert.ok(existsSync(leaf), 'a machine-global cache must survive a scoped --all');
  assert.match(output, /RN_ISO_HOME/, 'the refusal must be reported with its reason, not silent');
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

  assert.ok(existsSync(map), 'a machine-global cache must survive a scoped --older-than trim');
  assert.match(output, /machine-global/, 'the refusal must be reported with its reason, not silent');
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

  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl shutdown')), false, '--all must not shut down a device');
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl delete')), false, '--all must not delete a device');
  const cfg = loadConfig();
  assert.ok(cfg.projects[livePath], '--all must not drop a project entry');
  assert.ok(cfg.projects[livePath].platforms?.ios, '--all must not clear a device record');
  assert.equal(existsSync(entry), false, 'the cache it WAS aimed at is emptied');
});

test('rejects a non-numeric --older-than instead of silently skipping every entry', async () => {
  const program = new Command();
  program.exitOverride();
  gcCommand(program);
  await assert.rejects(() =>
    program.parseAsync(['node', 'rn-iso', 'gc', '--older-than', 'lastweek'])
  );
});

// With no config, gc must never DELETE (a missing config makes every rn-iso-*
// device look orphaned, including another RN_ISO_HOME's live ones) -- but it
// should still SAY they exist. Silently skipping meant a wiped config orphaned
// simulators that nothing would ever surface again.
test('describeUnverifiableDevices names rn-iso devices it cannot verify', () => {
  const notices = describeUnverifiableDevices(
    ['rn-iso-alpha', 'iPhone 17 Pro'],
    ['rn-iso-beta', 'Pixel_6_API_34'],
  );
  const joined = notices.join('\n');
  assert.match(joined, /rn-iso-alpha/);
  assert.match(joined, /rn-iso-beta/);
  assert.doesNotMatch(joined, /iPhone 17 Pro/, 'must not mention devices that are not ours');
  assert.doesNotMatch(joined, /Pixel_6/, 'must not mention devices that are not ours');
});

test('describeUnverifiableDevices says only that the sweep was skipped when nothing is ours', () => {
  const notices = describeUnverifiableDevices(['iPhone 17 Pro'], []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /device sweep skipped/);
});

test('describeUnverifiableDevices tolerates empty listings', () => {
  assert.equal(describeUnverifiableDevices([], []).length, 1);
});

test('describeUnverifiableDevices carries the reason it was given', () => {
  const notices = describeUnverifiableDevices(['rn-iso-alpha'], [], {
    reason: 'RN_ISO_HOME scopes this config while simulators are machine-global',
  });
  assert.match(notices.join('\n'), /RN_ISO_HOME/);
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
  writeFileSync(join(path, 'lock.json'), JSON.stringify({
    pid, projectRoot, startedAt: new Date().toISOString(), logFile: `${projectRoot}/.rn-iso/logs/build-${platform}.ndjson`,
  }));
  return path;
}

test('the report separates locks whose builder is gone from builds in progress', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  writeLock({ pid: process.pid, projectRoot: '/w/alive' });
  writeLock({ platform: 'android', key: 'def-debug-sim', pid: 999999, projectRoot: '/w/dead' });

  const report = await collectGcReport();
  assert.equal(report.buildLocks.stale.length, 1);
  assert.equal(report.buildLocks.stale[0].pid, 999999);
  assert.equal(report.buildLocks.live.length, 1);
  assert.equal(report.buildLocks.live[0].projectRoot, '/w/alive');
});

test('formatGcReport names both, and says a live one is a build it will not touch', () => {
  const lines = formatGcReport({
    buildLocks: {
      stale: [{ platform: 'ios', key: 'abc-debug-sim', pid: 999999, projectRoot: '/w/dead', path: '/h/build-locks/ios-abc.lock' }],
      live: [{ platform: 'android', key: 'def-debug-sim', pid: 41233, projectRoot: '/w/alive', path: '/h/build-locks/android-def.lock' }],
    },
  }).join('\n');
  assert.match(lines, /Stale build locks \(1\)/);
  assert.match(lines, /999999/);
  assert.match(lines, /\/w\/dead/);
  assert.match(lines, /Builds in progress \(1\)/);
  assert.match(lines, /41233/);
  assert.match(lines, /\/w\/alive/);
  assert.match(lines, /not touched|left alone/i);
});

test('a stale lock counts as something to reclaim', () => {
  const lines = formatGcReport({
    buildLocks: { stale: [{ platform: 'ios', key: 'k', pid: 9, projectRoot: '/w', path: '/h/l.lock' }], live: [] },
  }).join('\n');
  assert.doesNotMatch(lines.split('\n')[0], /^Nothing to reclaim\.$/);
});

test('a live lock alone is not something to reclaim', () => {
  const lines = formatGcReport({
    buildLocks: { stale: [], live: [{ platform: 'ios', key: 'k', pid: process.pid, projectRoot: '/w', path: '/h/l.lock' }] },
  }).join('\n');
  assert.match(lines, /Nothing to reclaim/);
  assert.match(lines, /Builds in progress/);
});

test('--delete removes the stale lock and leaves the live one alone', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const live = writeLock({ pid: process.pid, projectRoot: '/w/alive' });
  const stale = writeLock({ platform: 'android', key: 'def-debug-sim', pid: 999999, projectRoot: '/w/dead' });

  const output = await captureLog(() => sweepingGc({ delete: true }));
  assert.equal(existsSync(stale), false, 'the debris goes');
  assert.equal(existsSync(live), true, 'a build in progress is never interrupted');
  assert.match(output, /build lock/i);
});

test('a bare gc removes no lock at all', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  installExecutor();
  const stale = writeLock({ pid: 999999 });
  await captureLog(() => sweepingGc({}));
  assert.equal(existsSync(stale), true, 'a bare gc reports and writes nothing');
});
