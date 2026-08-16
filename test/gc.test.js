import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { saveConfig, loadConfig } from '../src/config.js';
import gcCommand, { formatGcReport } from '../src/commands/gc.js';

test('reports orphans with sizes and a total', () => {
  const lines = formatGcReport({
    orphaned: [{ dir: '/dd/App-abc', workspacePath: '/gone/App.xcworkspace', bytes: 4617089843 }],
    skipped: [],
    deadProjects: [],
    totalBytes: 4617089843,
  }).join('\n');
  assert.match(lines, /App-abc/);
  assert.match(lines, /4\.3G/);
});

test('names skipped entries and why they were skipped', () => {
  const lines = formatGcReport({
    orphaned: [],
    skipped: [{ dir: '/dd/X', reason: 'volume /Volumes/ExternalSSD is not mounted' }],
    deadProjects: [],
    totalBytes: 0,
  }).join('\n');
  assert.match(lines, /not mounted/);
  assert.match(lines, /skipped/i);
});

test('says nothing to reclaim when everything is clean', () => {
  const lines = formatGcReport({ orphaned: [], skipped: [], deadProjects: [], totalBytes: 0 }).join('\n');
  assert.match(lines, /nothing to reclaim/i);
});

test('marks an unmeasured entry instead of printing a misleading 0K', () => {
  const lines = formatGcReport({
    orphaned: [
      { dir: '/dd/App-def', workspacePath: '/gone/App2.xcworkspace', bytes: 0, measured: false },
    ],
    skipped: [],
    deadProjects: [],
    totalBytes: 0,
  }).join('\n');
  assert.match(lines, /App-def/);
  assert.match(lines, /unmeasured/i);
  assert.match(lines, /lower bound/i);
});

test('lists dead project entries', () => {
  const lines = formatGcReport({
    orphaned: [],
    skipped: [],
    deadProjects: ['/gone/proj'],
    totalBytes: 0,
  }).join('\n');
  assert.match(lines, /\/gone\/proj/);
  assert.match(lines, /Dead project entries/);
});

test('headline does not claim "nothing to reclaim" without flagging unchecked entries', () => {
  const lines = formatGcReport({
    orphaned: [],
    skipped: [{ dir: '/dd/X', reason: 'volume /Volumes/ExternalSSD is not mounted' }],
    deadProjects: [],
    totalBytes: 0,
  }).join('\n');
  const headline = lines.split('\n')[0];
  assert.doesNotMatch(headline, /^Nothing to reclaim\.$/);
  assert.match(headline, /could not be checked/i);
});

// --- Action-level tests -----------------------------------------------
//
// The tests above only exercise the pure formatter. Nothing above pins the
// most important property of this command: a bare `gc` (no --delete) must
// never reach an rmSync. These drive the real Commander action against a
// tmpdir HOME (derivedDataRoot() honors $HOME via os.homedir()) and a
// tmpdir RN_ISO_HOME (config.js), with the du/plutil shellouts mocked via
// setExecutor.

let tmpHome;
let fakeHome;
let ddRoot;
let originalHome;

function makeDdEntry(name, { workspacePath, kb } = {}) {
  const dir = join(ddRoot, name);
  mkdirSync(dir, { recursive: true });
  const plistPath = join(dir, 'info.plist');
  writeFileSync(plistPath, 'placeholder, only existence is checked directly');
  return { dir, plistPath, workspacePath, kb };
}

function installExecutor(entries) {
  const plists = {};
  const sizes = {};
  for (const e of entries) {
    if (e.workspacePath !== undefined) {
      plists[e.plistPath] = JSON.stringify({
        WorkspacePath: e.workspacePath,
        LastAccessedDate: '2026-01-01T00:00:00Z',
      });
    }
    if (e.kb !== undefined) sizes[e.dir] = e.kb;
  }
  setExecutor({
    run(cmd) {
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet(cmd) {
      const plutilMatch = cmd.match(/^plutil -convert json -o - "(.+)"$/);
      if (plutilMatch) {
        const v = plists[plutilMatch[1]];
        return v !== undefined ? v : null;
      }
      const duMatch = cmd.match(/^du -sk "(.+)"$/);
      if (duMatch) {
        const kb = sizes[duMatch[1]];
        return kb !== undefined ? `${kb}\t${duMatch[1]}` : null;
      }
      // e.g. lsof port lookups from reclaimProject: no live pid.
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
  ddRoot = join(fakeHome, 'Library', 'Developer', 'Xcode', 'DerivedData');
  mkdirSync(ddRoot, { recursive: true });
});

afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

test('a bare gc deletes nothing, even with orphans present', async () => {
  const liveWorkspace = join(fakeHome, 'live-project');
  mkdirSync(liveWorkspace, { recursive: true });

  const orphan = makeDdEntry('App-orphan', {
    workspacePath: join(fakeHome, 'gone', 'App.xcworkspace'),
    kb: 1024,
  });
  const live = makeDdEntry('App-live', { workspacePath: liveWorkspace, kb: 512 });
  installExecutor([orphan, live]);

  await runGc();

  assert.equal(existsSync(orphan.dir), true);
  assert.equal(existsSync(live.dir), true);
});

test('--delete removes orphaned entries but leaves skipped and live directories on disk', async () => {
  const liveWorkspace = join(fakeHome, 'live-project');
  mkdirSync(liveWorkspace, { recursive: true });

  const orphan = makeDdEntry('App-orphan', {
    workspacePath: join(fakeHome, 'gone', 'App.xcworkspace'),
    kb: 2048,
  });
  const live = makeDdEntry('App-live', { workspacePath: liveWorkspace, kb: 512 });
  // A workspace path on a volume that is (almost certainly) not attached to
  // this machine: classified as skipped, not orphaned, and must survive.
  const skipped = makeDdEntry('App-skipped', {
    workspacePath: '/Volumes/RnIsoTestVolumeThatDoesNotExist/gone/App.xcworkspace',
    kb: 4096,
  });
  installExecutor([orphan, live, skipped]);

  await runGc(['--delete']);

  assert.equal(existsSync(orphan.dir), false);
  assert.equal(existsSync(live.dir), true);
  assert.equal(existsSync(skipped.dir), true);
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
  installExecutor([]);

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

test('rejects a non-numeric --older-than instead of silently skipping every entry', async () => {
  const program = new Command();
  program.exitOverride();
  gcCommand(program);
  await assert.rejects(() =>
    program.parseAsync(['node', 'rn-iso', 'gc', '--older-than', 'lastweek'])
  );
});
