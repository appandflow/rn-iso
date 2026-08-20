import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerCreate } from '../src/commands/worktree.js';
import { resetExecutor } from '../src/exec.js';
import { defaultWorktreeDir } from '../src/worktree.js';
import {upsertProject, findEnclosingWorktreeRoot} from '../src/config.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('findEnclosingWorktreeRoot uses a real path-segment prefix, not a bare startsWith', async () => {
  upsertProject('/a/foo-worktrees/x', { label: 'x', worktreeRoot: true });
  assert.equal(findEnclosingWorktreeRoot('/a/foo-worktrees/xy'), null);
  assert.equal(findEnclosingWorktreeRoot('/a/foo-worktrees/xy/pkg'), null);
  assert.equal(findEnclosingWorktreeRoot('/a/foo-worktrees/x/pkg'), '/a/foo-worktrees/x');
});

test('findEnclosingWorktreeRoot picks the longest matching worktree-root key', async () => {
  upsertProject('/repo-worktrees', { label: 'outer', worktreeRoot: true });
  upsertProject('/repo-worktrees/feat-x', { label: 'feat-x', worktreeRoot: true });
  assert.equal(findEnclosingWorktreeRoot('/repo-worktrees/feat-x/apps/mobile'), '/repo-worktrees/feat-x');
});

test('findEnclosingWorktreeRoot returns null when nothing is registered as a worktree root', async () => {
  upsertProject('/repo-worktrees/feat-x', { label: 'feat-x' });
  assert.equal(findEnclosingWorktreeRoot('/repo-worktrees/feat-x/apps/mobile'), null);
});

// --- action-level tests: the stdout contract --------------------------
//
// CLAUDE.md item 8: the WorktreeCreate hook uses whatever `worktree create`
// writes to stdout, and ONLY that, as the directory for the new session.
// Every status/carry-over/failure line must go to stderr, and a setup
// pipeline failure must still exit 0 (a non-zero exit here makes the hook
// abort the session even though the worktree exists and is usable). Nothing
// short of driving the real action against a real repo protects this --
// the contract is about *what goes where*, not about any single function's
// return value. Harness mirrors test/worktree-remove.test.js's captureAction
// (registerCreate chains .command().description().option()...action(fn) off
// a stub commander object) plus the real-git tmpdir/cleanup pattern from
// test/worktree.test.js.

// macOS's tmpdir() is itself a symlink (/var -> /private/var); `git
// rev-parse --show-toplevel` (behind repoRoot) resolves through it, so an
// expected path built from the raw mkdtempSync() result would never match
// the actual argv0 -- same fix as `canon` in test/worktree-remove.test.js.
function canon(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function captureAction(register) {
  let captured;
  const stub = {
    command() { return stub; },
    description() { return stub; },
    option() { return stub; },
    action(fn) { captured = fn; return stub; },
  };
  register(stub);
  return (name, opts = {}) => captured(name, opts);
}

function initScratchRepo(root) {
  mkdirSync(root, { recursive: true });
  const git = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
  git('git init -q');
  git('git config user.email test@example.com');
  git('git config user.name test');
  writeFileSync(join(root, 'README.md'), 'hello');
  git('git add README.md');
  git('git commit -q -m init');
  return git;
}

async function runCreateInRepo(repo, name, opts) {
  const logs = [];
  const errs = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalCwd = process.cwd();
  console.log = (msg) => logs.push(msg);
  console.error = (msg) => errs.push(msg);
  process.chdir(repo);
  try {
    const run = captureAction(registerCreate);
    await run(name, opts);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(originalCwd);
  }
  return { logs, errs };
}

test('create action: success path writes exactly one stdout line, the worktree path', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-create-ok-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);

    const { logs } = await runCreateInRepo(repo, 'feat-x', { install: false });

    const expected = join(defaultWorktreeDir(repo), 'feat-x');
    assert.deepEqual(logs, [expected]);
    assert.notEqual(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});


// --- action-level tests: --base validation -----------------------------

test('create action: rejects an unrecognized --base before creating anything, on stderr, exit 1', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-create-badbase-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);

    const { logs, errs } = await runCreateInRepo(repo, 'feat-z', { base: 'origin/HEAD' });

    assert.deepEqual(logs, []);
    assert.ok(errs.some(e => /Invalid --base/.test(e)));
    assert.equal(process.exitCode, 1);
    assert.equal(existsSync(join(defaultWorktreeDir(repo), 'feat-z')), false);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: accepts --base head and --base fresh', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-create-goodbase-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);

    const head = await runCreateInRepo(repo, 'feat-head', { base: 'head', install: false });
    assert.deepEqual(head.logs, [join(defaultWorktreeDir(repo), 'feat-head')]);
    assert.notEqual(process.exitCode, 1);

    const fresh = await runCreateInRepo(repo, 'feat-fresh', { base: 'fresh', install: false });
    assert.deepEqual(fresh.logs, [join(defaultWorktreeDir(repo), 'feat-fresh')]);
    assert.notEqual(process.exitCode, 1);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});
