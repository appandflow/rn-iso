import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removalBlockers, registerRemove } from '../src/commands/worktree.js';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { upsertProject, getProject } from '../src/config.js';

test('no blockers for a clean worktree', () => {
  assert.deepEqual(removalBlockers({ dirty: false, unpushed: [] }), []);
});

test('reports uncommitted changes', () => {
  const blockers = removalBlockers({ dirty: true, unpushed: [] });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /uncommitted/i);
});

test('reports unpushed commits with a count', () => {
  const blockers = removalBlockers({ dirty: false, unpushed: ['abc one', 'def two'] });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /2 commit/);
});

test('reports both when both apply', () => {
  assert.equal(removalBlockers({ dirty: true, unpushed: ['abc one'] }).length, 2);
});

// dirty/unpushed are null (not false/[]) when the underlying git call itself
// failed -- see hasUncommittedWork/unpushedCommits in src/worktree.js. A
// destructive command must fail CLOSED on that: treat "could not determine"
// as its own blocker rather than let it fall through to "clean".
test('reports an indeterminate-status blocker instead of treating it as clean', () => {
  assert.equal(removalBlockers({ dirty: null, unpushed: [] }).length, 1);
  assert.equal(removalBlockers({ dirty: false, unpushed: null }).length, 1);
  assert.match(removalBlockers({ dirty: null, unpushed: null })[0], /could not determine/i);
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
function makeExecutor({ dirty = '', unpushed = '', remote = 'origin', worktrees = '', simctlList = '{"devices":{}}', occupied = {} } = {}) {
  const runCalls = [];
  const runQuietCalls = [];
  const exec = {
    calls: { run: runCalls, runQuiet: runQuietCalls },
    run(cmd) {
      runCalls.push(cmd);
      if (/worktree remove/.test(cmd)) return '';
      if (/simctl list devices --json/.test(cmd)) return simctlList;
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet(cmd) {
      runQuietCalls.push(cmd);
      if (/status --porcelain/.test(cmd)) return dirty;
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

test('action: refuses on the main checkout, leaving config untouched and never calling git worktree remove', () => {
  upsertProject(mainDir, { metroPort: 8081 });
  const before = getProject(mainDir);
  const exec = makeExecutor({ worktrees: porcelain([{ path: mainDir, branch: 'main' }]) });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  run(mainDir, {});

  assert.equal(process.exitCode, 1);
  assert.deepEqual(getProject(mainDir), before);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
});

test('action: --force does not bypass the main-checkout refusal', () => {
  upsertProject(mainDir, { metroPort: 8084 });
  const before = getProject(mainDir);
  const exec = makeExecutor({ worktrees: porcelain([{ path: mainDir, branch: 'main' }]) });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  run(mainDir, { force: true });

  assert.equal(process.exitCode, 1);
  assert.deepEqual(getProject(mainDir), before);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
});

test('action: refuses when git cannot answer the status check, leaving config untouched', () => {
  upsertProject(wtDir, { metroPort: 8082 });
  const before = getProject(wtDir);
  const exec = makeExecutor({
    dirty: null, // simulates hasUncommittedWork's runQuiet failing outright
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  run(wtDir, {});

  assert.equal(process.exitCode, 1);
  assert.deepEqual(getProject(wtDir), before);
  assert.ok(!exec.calls.run.some(c => /worktree remove/.test(c)));
});

test('action: on success, reclaimProject clears rn-iso tracking before removeWorktree runs', () => {
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
  run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.equal(getProject(wtDir), null);
  assert.ok(exec.calls.run.some(c => /worktree remove/.test(c)));
});

// Regression: in a monorepo, `rn-iso ios` registers a nested app dir (e.g.
// `<worktree>/apps/mobile`) as its own config key -- a different key from
// the worktree root that `worktree create` registers. That nested key is
// where metroPort and the device claim actually live. Reclaiming only the
// exact `path` argument (the old behaviour) leaves the nested entry, its
// Metro process, and its port claim to leak until `prune` runs.
test('action: reclaims a nested monorepo app-dir project registered under the worktree root, not just the root itself', () => {
  const nestedDir = join(wtDir, 'apps', 'mobile');
  upsertProject(wtDir, { metroPort: null, worktreeRoot: true });
  upsertProject(nestedDir, { metroPort: 8085, platforms: { ios: { deviceUdid: 'UDID-1' } } });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.equal(getProject(wtDir), null);
  assert.equal(getProject(nestedDir), null);
});

// The environment dies whole: `worktree remove` must reap the owned devices
// registered under it, not just clear rn-iso's tracking for them.
test('action: on success, deletes an owned iOS sim via simctl', () => {
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
  run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.ok(exec.calls.runQuiet.some(c => /xcrun simctl delete U1/.test(c)));
  assert.equal(getProject(wtDir), null);
});

// A legacy assignment (`owned` absent) is a device rn-iso did not create --
// its claim is cleared like any other, but the device itself must never be
// shut down or deleted.
test('action: does not delete a legacy (non-owned) iOS device', () => {
  upsertProject(wtDir, {
    metroPort: 8091,
    platforms: { ios: { deviceUdid: 'U2' } },
  });
  const exec = makeExecutor({
    worktrees: porcelain([{ path: mainDir, branch: 'main' }, { path: wtDir, branch: 'feat-x' }]),
  });
  setExecutor(exec);

  const run = captureAction(registerRemove);
  run(wtDir, {});

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
test('action: reaps owned sims under two nested monorepo app-dir keys, both of them', () => {
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
  run(wtDir, {});

  assert.notEqual(process.exitCode, 1);
  assert.ok(exec.calls.runQuiet.some(c => /xcrun simctl delete U3/.test(c)));
  assert.ok(exec.calls.runQuiet.some(c => /xcrun simctl delete U4/.test(c)));
  assert.equal(getProject(nestedDir1), null);
  assert.equal(getProject(nestedDir2), null);
});

// An occupied owned sim (a foreign UI-test runner still attached) must not
// block anything else: the worktree removal still proceeds, the OTHER
// nested project's owned sim is still reaped, and the occupied one comes
// back as a skip rather than aborting the whole command.
test('action: an occupied owned sim is skipped, without blocking worktree removal or the other device\'s reclamation', () => {
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
    run(wtDir, {});
  } finally {
    console.log = originalLog;
  }

  // The worktree itself was still removed.
  assert.notEqual(process.exitCode, 1);
  assert.ok(exec.calls.run.some(c => /worktree remove/.test(c)));

  // The occupied sim was never shut down or deleted, but the other one was.
  assert.ok(!exec.calls.runQuiet.some(c => /xcrun simctl shutdown U5/.test(c)));
  assert.ok(!exec.calls.runQuiet.some(c => /xcrun simctl delete U5/.test(c)));
  assert.ok(exec.calls.runQuiet.some(c => /xcrun simctl delete U6/.test(c)));

  // Both config entries are cleared either way -- reclaiming rn-iso's own
  // tracking does not depend on whether the device itself could be torn
  // down.
  assert.equal(getProject(nestedDir1), null);
  assert.equal(getProject(nestedDir2), null);

  // The skip is reported, naming the same device the (absent) freed line
  // would have -- rn-iso-c (U5), not a bare udid or bare name.
  assert.ok(logs.some(l => /kept rn-iso-c \(U5\)/.test(l) && /in use/i.test(l)));
});
