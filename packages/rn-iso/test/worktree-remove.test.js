import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  addsOnlyWorkspaceIgnoreBlock,
  excludeSelfHealedIgnores,
  excludeWorkspaceArtifacts,
  matchWorktreeEntry,
  porcelainPath,
  removalBlockers,
  registerRemove,
  removalRemedy,
  workspaceArtifactPaths,
} from '../src/commands/worktree.js';
import { renderWorkspaceIgnoreBlock } from '../src/engine/workspace.js';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { upsertProject, getProject } from '../src/config.js';

test('no blockers for a clean worktree', async () => {
  assert.deepEqual(removalBlockers({ dirty: false, unpushed: [] }), []);
});

test('reports uncommitted changes', async () => {
  const blockers = removalBlockers({ dirty: true, unpushed: [] });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /uncommitted/i);
});

test('reports unpushed commits with a count', async () => {
  const blockers = removalBlockers({ dirty: false, unpushed: ['abc one', 'def two'] });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /2 commit/);
});

test('reports both when both apply', async () => {
  assert.equal(removalBlockers({ dirty: true, unpushed: ['abc one'] }).length, 2);
});

// dirty/unpushed are null (not false/[]) when the underlying git call itself
// failed -- see hasUncommittedWork/unpushedCommits in src/worktree.js. A
// destructive command must fail CLOSED on that: treat "could not determine"
// as its own blocker rather than let it fall through to "clean".
test('reports an indeterminate-status blocker instead of treating it as clean', async () => {
  assert.equal(removalBlockers({ dirty: null, unpushed: [] }).length, 1);
  assert.equal(removalBlockers({ dirty: false, unpushed: null }).length, 1);
  assert.match(removalBlockers({ dirty: null, unpushed: null })[0], /could not determine/i);
});

// --- the dirty listing: what counts, and what to do about it ----------

test('porcelainPath reads the path out of each status form', () => {
  assert.equal(porcelainPath('?? .rn-iso/'), '.rn-iso/');
  assert.equal(porcelainPath(' M ios/Podfile.lock'), 'ios/Podfile.lock');
  assert.equal(porcelainPath('R  old/name.js -> new/name.js'), 'new/name.js', 'a rename is about where the file is NOW');
  assert.equal(porcelainPath('?? "we\u00e4rd path"'), 'we\u00e4rd path', 'git quotes non-ASCII paths');
  assert.equal(porcelainPath('   '), null);
});

// Two real e2e runs dead-ended on `?? .rn-iso/`, with `--force` -- which also
// discards real work -- as the only documented escape. The directory dies with
// the worktree by design, so it never counts.
test('the workspace directory never counts as dirty work, at any depth', () => {
  assert.deepEqual(excludeWorkspaceArtifacts(['?? .rn-iso/']), []);
  assert.deepEqual(excludeWorkspaceArtifacts(['?? apps/mobile/.rn-iso/']), []);
  assert.deepEqual(excludeWorkspaceArtifacts([' M .rn-iso/state.json']), []);
  assert.deepEqual(
    excludeWorkspaceArtifacts(['?? .rn-iso/', ' M src/app.js']),
    [' M src/app.js'],
    'real work beside it still counts'
  );
  assert.deepEqual(
    excludeWorkspaceArtifacts(['?? .rn-isolation/']),
    ['?? .rn-isolation/'],
    'a prefix match is not a segment match'
  );
});

// `git worktree remove` runs its OWN cleanliness check, so filtering .rn-iso/
// out of rn-iso's verdict only moved the dead end one step: git then refused
// over the same untracked directory, with --force as its only answer.
test('workspaceArtifactPaths is the complement of the filter, so the two cover every line', () => {
  const lines = ['?? .rn-iso/', ' M src/app.js', '?? apps/mobile/.rn-iso/'];
  assert.deepEqual(workspaceArtifactPaths(lines), ['.rn-iso/', 'apps/mobile/.rn-iso/']);
  assert.deepEqual(excludeWorkspaceArtifacts(lines), [' M src/app.js']);
  assert.equal(workspaceArtifactPaths(lines).length + excludeWorkspaceArtifacts(lines).length, lines.length);
});

// The refusal used to offer `git checkout -- <path>` whatever the dirt was.
// That does nothing to an untracked file, so following it produced the identical
// refusal and taught the reader that --force was the only way out.
test('the remedy names the right command for each class of dirt', () => {
  const untracked = removalRemedy(['?? scratch.txt']).join('\n');
  assert.match(untracked, /clean -fd/);
  assert.doesNotMatch(untracked, /checkout --/);

  const modified = removalRemedy([' M src/app.js']).join('\n');
  assert.match(modified, /checkout --/);
  assert.doesNotMatch(modified, /clean -fd/);

  const both = removalRemedy(['?? scratch.txt', ' M src/app.js']).join('\n');
  assert.match(both, /checkout --/);
  assert.match(both, /clean -fd/);

  assert.deepEqual(removalRemedy([]), []);
});

// The one case where "restore and retry" is a complete instruction keeps its
// specific command.
test('pod-install churn keeps its exact restore command', () => {
  const lines = removalRemedy([' M ios/Podfile.lock', ' M ios/App.xcodeproj/project.pbxproj']).join('\n');
  assert.match(lines, /pod install` rewrites/);
  assert.match(lines, /ios\/Podfile\.lock/);
  assert.doesNotMatch(lines, /clean -fd/, 'nothing untracked, so nothing to clean');
});

test('the remedy names the worktree when it is given one', () => {
  assert.match(removalRemedy(['?? x'], { worktree: '/tmp/wt' }).join('\n'), /git -C \/tmp\/wt clean -fd/);
});

// A remedy is a command to run, so it carries the paths it is about rather than
// a `<path>...` the reader has to fill in from the listing above it.
test('the remedy carries the paths themselves, capped, quoting what needs it', () => {
  assert.match(removalRemedy([' M src/app.js', '?? scratch.txt'], { worktree: '/tmp/wt' }).join('\n'), /checkout -- src\/app\.js/);
  assert.match(removalRemedy(['?? "we ird.txt"'], { worktree: '/tmp/wt' }).join('\n'), /clean -fd "we ird\.txt"/);
  const many = removalRemedy([' M a', ' M b', ' M c', ' M d', ' M e', ' M f'], { worktree: '/tmp/wt' }).join('\n');
  assert.match(many, /checkout -- a b c d e \.\.\./);
  assert.ok(!many.includes('<path>'));
});

// --- action-level tests -----------------------------------------------
//
// The pure removalBlockers tests above cover the refusal *decision*, but not
// the wiring: that the action refuses BEFORE reclaimProject runs, and that
// reclaimProject runs BEFORE removeWorktree. Those two orderings are the
// entire point of this task, and nothing above would catch a future
// reordering that broke them -- both tests would still pass unchanged. The
// harness mirrors test/worktree.test.js:53-90 (setExecutor + RN_ISO_HOME);
// registerRemove is driven directly with a stub commander object rather
// than going through bin/cli.js.

function canon(p) {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

// Stub of the commander `Command` API: registerRemove chains
// .command().description().option().action(fn) off of whatever it is
// handed, exactly like the real `worktree` subcommand does in
// bin/cli.js. Capturing `fn` is the only way to invoke the action in
// isolation from commander's own arg-parsing.
function captureAction(register) {
  let captured;
  const stub = {
    command() { return stub; },
    description() { return stub; },
    option() { return stub; },
    action(fn) { captured = fn; return stub; },
  };
  register(stub);
  return (target, opts = {}) => captured(target, opts);
}

function porcelain(entries) {
  return entries
    .map(e => `worktree ${e.path}\nHEAD 0000000000000000000000000000000000000000\n${e.branch ? `branch refs/heads/${e.branch}` : 'detached'}\n`)
    .join('\n');
}

// `dirty`/`unpushed`/`worktrees` are the raw runQuiet return values (a
// string, or null to simulate the underlying git call failing outright).
// `simctlList` backs `xcrun simctl list devices --json` -- deleteIosSim
// looks a udid up there before it will delete it (the rn-iso- name-prefix
// guard), so any test that expects an owned iOS device to actually be
// deleted must list it here.
// `occupied` maps udid -> true to simulate a foreign .xctrunner UI-test
// runner still attached (isSimOccupied's `xcrun simctl spawn <udid>
// launchctl list` probe -- see parseOccupyingApps in src/sim/ios.js).
function makeExecutor({ dirty = '', unpushed = '', remote = 'origin', worktrees = '', simctlList = '{"devices":{}}', occupied = {}, diffs = {} } = {}) {
  const runCalls = [];
  const runQuietCalls = [];
  const exec = {
    calls: { run: runCalls, runQuiet: runQuietCalls },
    run(cmd) {
      runCalls.push(cmd);
      if (/worktree remove/.test(cmd)) return '';
      if (/simctl list devices --json/.test(cmd)) return simctlList;
      // deleteIosSim/deleteAvd go through the throwing run() so a failed
      // delete surfaces as { status: 'failed' } instead of a false success.
      if (/simctl delete|delete avd/.test(cmd)) return '';
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet(cmd) {
      runQuietCalls.push(cmd);
      if (/status --porcelain/.test(cmd)) return dirty;
      const diffMatch = cmd.match(/ diff -- "(.+)"$/);
      if (diffMatch) return diffs[diffMatch[1]] ?? '';
      if (/ checkout -- /.test(cmd)) return '';
      if (/log --oneline HEAD --not --remotes/.test(cmd)) return unpushed;
      if (/worktree list --porcelain/.test(cmd)) return worktrees;
      if (/remote$/.test(cmd)) return remote;
      const spawnMatch = cmd.match(/simctl spawn (\S+) launchctl list/);
      if (spawnMatch) {
        const udid = spawnMatch[1];
        return occupied[udid]
          ? '082a\t0\tUIKitApplication:com.example.MyAppUITests.xctrunner[082a][rb-legacy]'
          : '';
      }
      return null;
    },
    spawn() {},
  };
  return exec;
}

// One iOS runtime bucket with the given sims, matching parseSimctlList's
// expected shape (src/sim/ios.js).
function simctlJson(sims) {
  return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-17-0': sims } });
}

let tmpHome, mainDir, wtDir;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-home-'));
  process.env.RN_ISO_HOME = tmpHome;
  mainDir = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-main-')));
  wtDir = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-wt-')));
});

afterEach(() => {
  resetExecutor();
  process.exitCode = 0;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(mainDir, { recursive: true, force: true });
  rmSync(wtDir, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('action: refuses on the main checkout, leaving config untouched and never calling git worktree remove', async () => {
  upsertProject(mainDir, { metroPort: 8081 });
  const before = getProject(mainDir);
  const exec = makeExecutor({ worktrees: porcelain([{ path: mainDir, branch: 'main' }]) });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(mainDir, {});

  assert.equal(process.exitCode, 1);
  assert.deepEqual(getProject(mainDir), before);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
});

test('action: --force does not bypass the main-checkout refusal', async () => {
  upsertProject(mainDir, { metroPort: 8084 });
  const before = getProject(mainDir);
  const exec = makeExecutor({ worktrees: porcelain([{ path: mainDir, branch: 'main' }]) });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(mainDir, { force: true });

  assert.equal(process.exitCode, 1);
  assert.deepEqual(getProject(mainDir), before);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
});

test('action: refuses when git cannot answer the status check, leaving config untouched', async () => {
  upsertProject(wtDir, { metroPort: 8082 });
  const before = getProject(wtDir);
  const exec = makeExecutor({
    dirty: null, // simulates hasUncommittedWork's runQuiet failing outright
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.equal(process.exitCode, 1);
  assert.deepEqual(getProject(wtDir), before);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
});

test('action: on success, reclaimProject clears rn-iso tracking before removeWorktree runs', async () => {
  upsertProject(wtDir, { metroPort: 8083 });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  // The property this whole task exists to guarantee: by the time `git
  // worktree remove` runs, reclaimProject must already have dropped the
  // config entry. A future reorder (removeWorktree before reclaimProject)
  // would leave the entry present here and fail this assertion, even though
  // every pure removalBlockers test above would still pass unchanged.
  const originalRun = exec.run.bind(exec);
  exec.run = (cmd) => {
    if (/worktree remove/.test(cmd)) {
      assert.equal(getProject(wtDir), null, 'reclaimProject must run before removeWorktree');
    }
    return originalRun(cmd);
  };
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.equal(getProject(wtDir), null);
  assert.ok(exec.calls.run.some(c => /worktree remove/.test(c)));
});

// Regression: in a monorepo, `rn-iso ios` registers a nested app dir (e.g.
// `<worktree>/apps/mobile`) as its own config key -- a different key from
// the worktree root that `worktree create` registers. That nested key is
// where metroPort and the device claim actually live. Reclaiming only the
// exact `path` argument (the old behaviour) leaves the nested entry, its
// Metro process, and its port claim to leak until `gc --delete` runs.
test('action: reclaims a nested monorepo app-dir project registered under the worktree root, not just the root itself', async () => {
  const nestedDir = join(wtDir, 'apps', 'mobile');
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir, { metroPort: 8085, platforms: { ios: { deviceUdid: 'UDID-1' } } });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.equal(getProject(wtDir), null);
  assert.equal(getProject(nestedDir), null);
});

// The environment dies whole: `worktree remove` must reap the owned devices
// registered under it, not just clear rn-iso's tracking for them.
test('action: on success, deletes an owned iOS sim via simctl', async () => {
  upsertProject(wtDir, {
    metroPort: 8090,
    platforms: { ios: { deviceUdid: 'U1', owned: true, deviceName: 'rn-iso-x' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
    simctlList: simctlJson([{ udid: 'U1', name: 'rn-iso-x', state: 'Shutdown', isAvailable: true }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.ok(exec.calls.run.some(c => /xcrun simctl delete U1/.test(c)));
  assert.equal(getProject(wtDir), null);
});

// A legacy assignment (`owned` absent) is a device rn-iso did not create --
// its claim is cleared like any other, but the device itself must never be
// shut down or deleted.
test('action: does not delete a legacy (non-owned) iOS device', async () => {
  upsertProject(wtDir, {
    metroPort: 8091,
    platforms: { ios: { deviceUdid: 'U2' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  // Stronger than checking for the absence of a delete: U2 must never be
  // named in ANY issued command (no shutdown, no occupancy probe, no
  // delete) -- a legacy record is not rn-iso's to touch at all.
  assert.ok(![...exec.calls.run, ...exec.calls.runQuiet].some(c => c.includes('U2')));
  assert.equal(getProject(wtDir), null);
});

// The environment dies whole even in a monorepo: two nested app-dir keys
// under one worktree root, each with their own owned sim, must both be
// reaped by a single `worktree remove` -- not just the first one found.
test('action: reaps owned sims under two nested monorepo app-dir keys, both of them', async () => {
  const nestedDir1 = join(wtDir, 'apps', 'mobile1');
  const nestedDir2 = join(wtDir, 'apps', 'mobile2');
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir1, {
    metroPort: 8092,
    platforms: { ios: { deviceUdid: 'U3', owned: true, deviceName: 'rn-iso-a' } },
  });
  upsertProject(nestedDir2, {
    metroPort: 8093,
    platforms: { ios: { deviceUdid: 'U4', owned: true, deviceName: 'rn-iso-b' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
    simctlList: simctlJson([
      { udid: 'U3', name: 'rn-iso-a', state: 'Shutdown', isAvailable: true },
      { udid: 'U4', name: 'rn-iso-b', state: 'Shutdown', isAvailable: true },
    ]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.ok(exec.calls.run.some(c => /xcrun simctl delete U3/.test(c)));
  assert.ok(exec.calls.run.some(c => /xcrun simctl delete U4/.test(c)));
  assert.equal(getProject(nestedDir1), null);
  assert.equal(getProject(nestedDir2), null);
});

// An occupied owned sim (a foreign UI-test runner still attached) must not
// block anything else: the worktree removal still proceeds, the OTHER
// nested project's owned sim is still reaped, and the occupied one comes
// back as a skip rather than aborting the whole command.
test('action: an occupied owned sim is deleted with the rest -- the environment dies whole', async () => {
  const nestedDir1 = join(wtDir, 'apps', 'mobile1');
  const nestedDir2 = join(wtDir, 'apps', 'mobile2');
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir1, {
    metroPort: 8094,
    platforms: { ios: { deviceUdid: 'U5', owned: true, deviceName: 'rn-iso-c' } },
  });
  upsertProject(nestedDir2, {
    metroPort: 8095,
    platforms: { ios: { deviceUdid: 'U6', owned: true, deviceName: 'rn-iso-d' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
    simctlList: simctlJson([
      { udid: 'U5', name: 'rn-iso-c', state: 'Booted', isAvailable: true },
      { udid: 'U6', name: 'rn-iso-d', state: 'Shutdown', isAvailable: true },
    ]),
    occupied: { U5: true },
  });
  setExecutor(exec);

  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  const run = captureAction(registerRemove);
  try {
    await run(wtDir, {});
  } finally {
    console.log = originalLog;
  }

  // The worktree itself was still removed.
  assert.notEqual(process.exitCode, 1);
  assert.ok(exec.calls.run.some(c => /worktree remove/.test(c)));

  // Both sims go, occupied or not: they are rn-iso's own, created for a project
  // that is being removed, and the holder is almost always the caller's own
  // UI-test runner. Sparing U5 here is what used to leak a booted sim and a
  // live runner out of `worktree remove`.
  assert.ok(exec.calls.run.some(c => /xcrun simctl delete U5/.test(c)));
  assert.ok(exec.calls.run.some(c => /xcrun simctl delete U6/.test(c)));

  // Both config entries are cleared either way -- reclaiming rn-iso's own
  // tracking does not depend on whether the device itself could be torn
  // down.
  assert.equal(getProject(nestedDir1), null);
  assert.equal(getProject(nestedDir2), null);

  // Nothing is reported as kept: there is no occupied-skip path left for a
  // device being deleted, so no "kept ..." line should appear at all.
  assert.ok(!logs.some(l => /kept/i.test(l)), `unexpected kept line: ${logs.join(' | ')}`);
});

// The whole field-test failure, end to end: a workspace whose ONLY dirty path is
// its own `.rn-iso/` must remove without --force. Before this it refused, and
// the printed remedy (`git checkout -- <path>`) could not clear an untracked
// directory, so there was no non-destructive way forward at all.
test('action: a tree dirty only with .rn-iso/ removes without --force', async () => {
  upsertProject(wtDir, { metroPort: 8090 });
  const exec = makeExecutor({
    dirty: '?? .rn-iso/\n',
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.ok(exec.calls.run.some(c => /worktree remove/.test(c)), 'the worktree is actually removed');
  assert.ok(!exec.calls.run.some(c => /worktree remove --force/.test(c)), 'and not by forcing');
  assert.equal(getProject(wtDir), null, 'rn-iso tracking is released with it');
});

test('action: real work beside .rn-iso/ still refuses, and names both remedies', async () => {
  upsertProject(wtDir, { metroPort: 8091 });
  const exec = makeExecutor({
    dirty: '?? .rn-iso/\n M src/app.js\n?? scratch.txt\n',
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const errs = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  assert.equal(process.exitCode, 1);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
  const text = errs.join('\n');
  assert.match(text, /checkout --/);
  assert.match(text, /clean -fd/);
  assert.ok(!text.includes('.rn-iso/'), 'the listing does not show what it just decided to ignore');
});

// Filtering `.rn-iso/` out of rn-iso's own verdict was only half the fix: `git
// worktree remove` refuses on "modified or untracked files" too, so the
// directory has to be gone before git looks. Verified against real git in the
// live smoke run recorded with this change (CLAUDE.md item 9); this pins the
// wiring.
test('action: the workspace directory is deleted before git worktree remove is called', async () => {
  upsertProject(wtDir, { metroPort: 8092 });
  mkdirSync(join(wtDir, '.rn-iso', 'logs'), { recursive: true });
  writeFileSync(join(wtDir, '.rn-iso', 'state.json'), '{}');
  const exec = makeExecutor({
    dirty: '?? .rn-iso/\n',
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  // Fail the removal the way real git does when the directory is still there,
  // so the assertion is about ORDER rather than about our own rmSync.
  const originalRun = exec.run;
  exec.run = function (cmd) {
    if (/worktree remove/.test(cmd) && existsSync(join(wtDir, '.rn-iso'))) {
      throw new Error('fatal: contains modified or untracked files, use --force to delete it');
    }
    return originalRun.call(this, cmd);
  };
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.equal(existsSync(join(wtDir, '.rn-iso')), false, 'the workspace directory is gone');
  assert.notEqual(process.exitCode, 1, 'and git therefore did not refuse');
});

// Containment: a path out of `git status` is relative to the worktree, and
// anything that resolves outside it is left alone whatever it says.
test('action: a dirty path escaping the worktree is never removed', async () => {
  upsertProject(wtDir, { metroPort: 8093 });
  const outside = join(mainDir, '.rn-iso');
  mkdirSync(outside, { recursive: true });
  setExecutor(makeExecutor({
    dirty: '?? ../rn-iso-test-main-escape/.rn-iso/\n',
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  }));

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.equal(existsSync(outside), true, 'nothing outside the worktree is touched');
});

// --- item 1: rn-iso's own gitignore self-heal must not dead-end teardown ----
//
// `start` appends the `.rn-iso/` block to a TRACKED .gitignore (that is the
// self-heal that replaced `init`), which shows up as ` M apps/x/.gitignore` and
// refused the teardown -- the same class of dead end as `?? .rn-iso/`, one file
// over: the loop's own write blocking the loop's own exit. It is only ignorable
// when the diff is EXACTLY that block and nothing else, so the fixtures below
// are built from renderWorkspaceIgnoreBlock rather than retyped.

function ignoreDiff({ file = 'apps/x/.gitignore', added = [], removed = [], context = ['node_modules/'] } = {}) {
  return [
    `diff --git a/${file} b/${file}`,
    'index c2658d7..2986a0a 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1,6 @@',
    ...context.map(l => ` ${l}`),
    ...removed.map(l => `-${l}`),
    ...added.map(l => `+${l}`),
    '',
  ].join('\n');
}

// The exact lines ensureWorkspaceIgnored appends, blank separator included.
function ourBlockLines() {
  return ['', ...renderWorkspaceIgnoreBlock().split('\n').filter(l => l !== '')];
}

test('a .gitignore diff that adds only rn-iso own block is recognized as ours', () => {
  assert.equal(addsOnlyWorkspaceIgnoreBlock(ignoreDiff({ added: ourBlockLines() })), true);
});

test('one user line beside our block is not ours', () => {
  const added = [...ourBlockLines(), '.env.local'];
  assert.equal(addsOnlyWorkspaceIgnoreBlock(ignoreDiff({ added })), false);
});

test('a removed line is never ours, whatever was added', () => {
  const diff = ignoreDiff({ added: ourBlockLines(), removed: ['node_modules/'], context: [] });
  assert.equal(addsOnlyWorkspaceIgnoreBlock(diff), false);
});

test('an empty, missing or entry-less diff is not ours', () => {
  assert.equal(addsOnlyWorkspaceIgnoreBlock(''), false);
  assert.equal(addsOnlyWorkspaceIgnoreBlock(null), false);
  assert.equal(
    addsOnlyWorkspaceIgnoreBlock(ignoreDiff({ added: ['# rn-iso: this workspace\'s build output, logs and supervisor pidfile.'] })),
    false,
    'the comment alone, without the entry itself, is not the block'
  );
});

test('excludeSelfHealedIgnores drops only an unstaged .gitignore whose diff is ours', () => {
  const ours = ignoreDiff({ added: ourBlockLines() });
  const seen = [];
  const diff = (file) => { seen.push(file); return ours; };

  const clean = excludeSelfHealedIgnores([' M apps/x/.gitignore'], { diff });
  assert.deepEqual(clean.lines, []);
  assert.deepEqual(clean.healed, ['apps/x/.gitignore']);
  assert.deepEqual(seen, ['apps/x/.gitignore']);

  // A STAGED change to the same file is a different thing: `git checkout --`
  // would not clear it and git would refuse anyway. Fail closed.
  assert.deepEqual(
    excludeSelfHealedIgnores(['M  apps/x/.gitignore'], { diff }).lines,
    ['M  apps/x/.gitignore']
  );
  assert.deepEqual(
    excludeSelfHealedIgnores([' M src/app.js'], { diff }).lines,
    [' M src/app.js'],
    'a file that is not a .gitignore is never asked about'
  );
});

test('action: a worktree dirty only with rn-iso own gitignore append removes, restoring the file first', async () => {
  upsertProject(wtDir, { metroPort: 8096 });
  const exec = makeExecutor({
    dirty: ' M apps/x/.gitignore\n',
    diffs: { 'apps/x/.gitignore': ignoreDiff({ added: ourBlockLines() }) },
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const errs = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  assert.notEqual(process.exitCode, 1);
  assert.ok(exec.calls.run.some(c => /worktree remove/.test(c)), 'the worktree is actually removed');
  assert.ok(!exec.calls.run.some(c => /worktree remove --force/.test(c)), 'and not by forcing');
  // git runs its OWN cleanliness check, so the file has to be back before it
  // looks -- proven against real git in the integration test below.
  const restore = exec.calls.runQuiet.findIndex(c => /checkout -- "apps\/x\/\.gitignore"/.test(c));
  assert.ok(restore >= 0, 'the file is restored');
  assert.match(errs.join('\n'), /restoring apps\/x\/\.gitignore \(only rn-iso's own entry was added\)/);
});

test('action: our block plus a user line still refuses', async () => {
  upsertProject(wtDir, { metroPort: 8097 });
  const exec = makeExecutor({
    dirty: ' M apps/x/.gitignore\n',
    diffs: { 'apps/x/.gitignore': ignoreDiff({ added: [...ourBlockLines(), '.env.local'] }) },
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const errs = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  assert.equal(process.exitCode, 1);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
  assert.match(errs.join('\n'), /apps\/x\/\.gitignore/, 'and the file is named in the listing');
});

test('action: a removed line in the .gitignore still refuses', async () => {
  upsertProject(wtDir, { metroPort: 8098 });
  const exec = makeExecutor({
    dirty: ' M apps/x/.gitignore\n',
    diffs: {
      'apps/x/.gitignore': ignoreDiff({ added: ourBlockLines(), removed: ['node_modules/'], context: [] }),
    },
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(wtDir, {});

  assert.equal(process.exitCode, 1);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
});

// --- item 2: the default path, the remedy placeholders, the dead reference --

test('matchWorktreeEntry walks up to the enclosing worktree root', () => {
  const entries = [{ path: '/repo' }, { path: '/repo-worktrees/feat-x' }];
  assert.deepEqual(matchWorktreeEntry(entries, '/repo-worktrees/feat-x'), { index: 1, path: '/repo-worktrees/feat-x' });
  assert.deepEqual(matchWorktreeEntry(entries, '/repo-worktrees/feat-x/apps/mobile'), { index: 1, path: '/repo-worktrees/feat-x' });
  assert.deepEqual(matchWorktreeEntry(entries, '/repo/apps/mobile'), { index: 0, path: '/repo' }, 'the main checkout is still entry zero');
  assert.equal(matchWorktreeEntry(entries, '/repo-worktrees/feat-xy'), null, 'a prefix match is not a segment match');
  assert.equal(matchWorktreeEntry(entries, '/elsewhere'), null);
  assert.equal(matchWorktreeEntry([], '/repo'), null);
});

test('action: run from a monorepo app dir, it removes the enclosing worktree', async () => {
  const nestedDir = join(wtDir, 'apps', 'mobile');
  mkdirSync(nestedDir, { recursive: true });
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir, { metroPort: 8099 });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  await run(nestedDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.ok(exec.calls.run.some(c => c.includes(`worktree remove "${wtDir}"`)), 'git is asked for the ROOT, not the app dir');
  assert.equal(getProject(wtDir), null);
  assert.equal(getProject(nestedDir), null);
});

test('action: a path inside no worktree at all is still refused, pointing at git worktree list', async () => {
  const exec = makeExecutor({ worktrees: porcelain([{ path: mainDir, branch: 'main' }]) });
  setExecutor(exec);

  const errs = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  assert.equal(process.exitCode, 1);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
  const text = errs.join('\n');
  assert.match(text, /git worktree list/);
  assert.ok(!/rn-iso worktree list/.test(text), 'there is no `rn-iso worktree list` to point at');
});

test('action: the dirty-tree remedy names the real worktree, not a placeholder', async () => {
  upsertProject(wtDir, { metroPort: 8100 });
  setExecutor(makeExecutor({
    dirty: ' M src/app.js\n?? scratch.txt\n',
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  }));

  const errs = [];
  const original = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const run = captureAction(registerRemove);
    await run(wtDir, {});
  } finally {
    console.error = original;
  }

  assert.equal(process.exitCode, 1);
  const text = errs.join('\n');
  assert.ok(!text.includes('<worktree>'), `placeholder left in: ${text}`);
  assert.ok(!text.includes('git -C <path>'), `placeholder left in: ${text}`);
  assert.match(text, new RegExp(`git -C ${wtDir} checkout --`));
  assert.match(text, new RegExp(`git -C ${wtDir} clean -fd`));
});

// --- against real git (CLAUDE.md item 9) -------------------------------------
//
// Everything above runs on a mocked executor, which can prove we composed a
// git-shaped command but not that git accepts it -- and this change turns on
// two things only real git can settle: the exact shape of `git diff` for an
// appended block, and that `git worktree remove` still refuses over the
// modified .gitignore unless it is restored first (it does; that is why the
// verdict is paired with a restore rather than left to die with the directory).
test('against a real repo: removal from a monorepo app dir, dirty only with rn-iso own gitignore append', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-remove-live-')));
  const repo = join(base, 'repo');
  const originalCwd = process.cwd();
  const errs = [];
  const originalError = console.error;
  const originalLog = console.log;
  try {
    const bareRemote = join(base, 'remote.git');
    mkdirSync(bareRemote, { recursive: true });
    execSync(`git init -q --bare "${bareRemote}"`);
    mkdirSync(join(repo, 'apps', 'x'), { recursive: true });
    const git = (cmd) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git(`git remote add origin "${bareRemote}"`);
    writeFileSync(join(repo, 'apps', 'x', '.gitignore'), 'node_modules/\n');
    git('git add -A');
    git('git commit -q -m init');
    // Without a remote every commit counts as unpushed and the removal is
    // refused for a reason that has nothing to do with this test.
    git('git push -q -u origin HEAD');
    const wt = join(base, 'wt');
    git(`git worktree add -q "${wt}" -b feat-live`);

    // Exactly what `start` does, through the real writer: the workspace
    // directory, and the gitignore entry that hides it.
    const gitignore = join(wt, 'apps', 'x', '.gitignore');
    writeFileSync(gitignore, `${readFileSync(gitignore, 'utf-8')}\n${renderWorkspaceIgnoreBlock()}`);
    mkdirSync(join(wt, 'apps', 'x', '.rn-iso', 'logs'), { recursive: true });
    writeFileSync(join(wt, 'apps', 'x', '.rn-iso', 'state.json'), '{}');
    assert.equal(
      execSync('git status --porcelain', { cwd: wt, encoding: 'utf-8' }).trim(),
      'M apps/x/.gitignore',
      'sanity: real git reports only the self-heal -- .rn-iso/ is hidden by the entry it just added'
    );

    // ...and the removal is run from the app dir, the way an agent does.
    process.chdir(join(wt, 'apps', 'x'));
    console.error = (m) => errs.push(String(m));
    console.log = () => {};
    const run = captureAction(registerRemove);
    await run(undefined, {});
    console.error = originalError;
    console.log = originalLog;
    process.chdir(originalCwd);

    assert.notEqual(process.exitCode, 1, `refused: ${errs.join('\n')}`);
    assert.equal(existsSync(wt), false, 'real git actually removed the worktree');
    assert.match(errs.join('\n'), /restoring apps\/x\/\.gitignore/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.chdir(originalCwd);
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});
