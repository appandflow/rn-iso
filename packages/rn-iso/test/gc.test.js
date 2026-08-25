import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { saveConfig, loadConfig } from '../src/config.js';
import gcCommand, { findOrphanedDevices, formatGcReport, describeUnverifiableDevices } from '../src/commands/gc.js';

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

// --- Action-level tests -----------------------------------------------
//
// The tests above only exercise the pure formatter. These drive the real
// Commander action against a tmpdir RN_ISO_HOME (config.js) plus a tmpdir
// HOME, so a "dead" project path resolves to a real, mounted boot-volume
// ancestor rather than to the developer's own repos.

let tmpHome;
let fakeHome;
let originalHome;

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

async function runGc(args = []) {
  const program = new Command();
  gcCommand(program);
  await program.parseAsync(['node', 'rn-iso', 'gc', ...args]);
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;

  originalHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'rn-iso-fakehome-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  resetExecutor();
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

  await runGc();

  assert.ok(loadConfig().projects[localDeadPath], 'a bare gc must not prune anything');
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

  await runGc(['--delete']);

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

  await runGc(['--delete']);

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

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await runGc();
  } finally {
    console.log = originalLog;
  }

  assert.match(logs.join('\n'), /rn-iso-report-orphan/);
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

  await runGc(['--delete']);

  const cfg = loadConfig();
  assert.equal(cfg.projects[localDeadPath], undefined, 'the dead project entry must be pruned');
  assert.ok(execCalls.some(c => c.startsWith('xcrun simctl shutdown UDID-DEAD')), 'expected the owned device to be shut down in this same run');
  assert.ok(execCalls.some(c => c.startsWith('xcrun simctl delete UDID-DEAD')), 'expected the owned device to be deleted in this same run');
});

// I7: no config file at all (a fresh RN_ISO_HOME, or one that has simply
// never registered a project) must not be read as "every project's
// reference is absent" -- that classified EVERY rn-iso-* device on the
// machine as orphaned, and --delete would have destroyed every live
// environment. No saveConfig() call here at all, so loadConfig() returns
// null, not {projects: {}}.
test('gc with no config names rn-iso devices it cannot verify, but never touches them', async () => {
  const execCalls = [];
  installDeviceExecutor({
    devices: [{ udid: 'UDID-LIVE', name: 'rn-iso-someones-live-env', state: 'Booted' }],
    execCalls,
  });

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await runGc(['--delete']);
  } finally {
    console.log = originalLog;
  }

  const output = logs.join('\n');
  // It IS named -- silently skipping meant a wiped config orphaned simulators
  // that nothing would ever surface again.
  assert.match(output, /rn-iso-someones-live-env/, 'an unverifiable device should still be surfaced by name');
  assert.match(output, /no rn-iso config found/i);
  assert.match(output, /cannot be verified as orphaned/i);
  // ...but it is never classified as orphaned, and never acted on: an empty
  // reference map would make every rn-iso-* device on the machine look
  // orphaned, including another RN_ISO_HOME's live environments.
  assert.doesNotMatch(output, /Orphaned devices/i, 'must not classify it as orphaned');
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl shutdown')), false);
  assert.equal(execCalls.some(c => c.startsWith('xcrun simctl delete')), false);
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
