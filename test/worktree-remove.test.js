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
function makeExecutor({ dirty = '', unpushed = '', remote = 'origin', worktrees = '' } = {}) {
  const runCalls = [];
  const runQuietCalls = [];
  const exec = {
    calls: { run: runCalls, runQuiet: runQuietCalls },
    run(cmd) {
      runCalls.push(cmd);
      if (/worktree remove/.test(cmd)) return '';
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet(cmd) {
      runQuietCalls.push(cmd);
      if (/status --porcelain/.test(cmd)) return dirty;
      if (/log --oneline HEAD --not --remotes/.test(cmd)) return unpushed;
      if (/worktree list --porcelain/.test(cmd)) return worktrees;
      if (/remote$/.test(cmd)) return remote;
      return null;
    },
    spawn() {},
  };
  return exec;
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
