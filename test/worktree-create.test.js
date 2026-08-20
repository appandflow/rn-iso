import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveInstallPipeline, registerCreate } from '../src/commands/worktree.js';
import { resetExecutor } from '../src/exec.js';
import { defaultWorktreeDir } from '../src/worktree.js';
import { upsertProject, setSetupStatus, getSetupStatus, findEnclosingWorktreeRoot } from '../src/config.js';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('uses the configured pipeline verbatim', async () => {
  const pipeline = resolveInstallPipeline(
    { worktree: { install: ['pnpm install', 'pnpm build:packages'] } },
    'npm'
  );
  assert.deepEqual(pipeline, ['pnpm install', 'pnpm build:packages']);
});

test('accepts a single string as a one-command pipeline', async () => {
  assert.deepEqual(resolveInstallPipeline({ worktree: { install: 'yarn' } }, 'npm'), ['yarn']);
});

test('install false disables the pipeline', async () => {
  assert.deepEqual(resolveInstallPipeline({ worktree: { install: false } }, 'npm'), []);
});

test('falls back to a configured settings.packageManager over the passed-in one', async () => {
  const pipeline = resolveInstallPipeline({ packageManager: 'pnpm' }, 'npm');
  assert.deepEqual(pipeline, ['pnpm install']);
});

// This is the fallback branch that used to be untestable: resolveInstallPipeline
// no longer calls detectPackageManager itself (that walks the filesystem for
// lockfiles), so the caller-supplied package manager can be exercised directly
// with no settings.packageManager override and no disk I/O.
test('falls back to the caller-supplied package manager when settings has none', async () => {
  assert.deepEqual(resolveInstallPipeline({}, 'pnpm'), ['pnpm install']);
  assert.deepEqual(resolveInstallPipeline(undefined, 'bun'), ['bun install']);
});

test('setup status round-trips and reports incompleteness', async () => {
  upsertProject('/proj', {});
  setSetupStatus('/proj', {
    complete: false,
    commands: [
      { command: 'pnpm install', ok: false },
      { command: 'pnpm build:packages', ok: true },
    ],
  });
  const status = getSetupStatus('/proj');
  assert.equal(status.complete, false);
  assert.equal(status.commands[0].ok, false);
});

test('getSetupStatus returns null for an unknown project', async () => {
  assert.equal(getSetupStatus('/nope'), null);
});

// This is the scenario Fix 1 targets: `worktree create` registers the
// worktree root with a label and a setup status, but the agent later runs
// `rn-iso ios` from a nested app dir (e.g. apps/tlon-mobile in a monorepo),
// which registers a *different* key with no setup status of its own. Without
// the fallback, a later `getSetupStatus(<app dir>)` would return null and the
// "setup incomplete" warning would never fire.
test('getSetupStatus falls back to the enclosing worktree root status', async () => {
  const root = '/repo-worktrees/feat-x';
  upsertProject(root, { label: 'feat-x', worktreeRoot: true });
  setSetupStatus(root, { complete: false, commands: [{ command: 'pnpm install', ok: false }] });

  const appDir = `${root}/apps/tlon-mobile`;
  upsertProject(appDir, {});

  const status = getSetupStatus(appDir);
  assert.equal(status.complete, false);
  assert.equal(status.commands[0].command, 'pnpm install');
});

test('getSetupStatus prefers a project own status over the enclosing worktree root', async () => {
  const root = '/repo-worktrees/feat-x';
  upsertProject(root, { label: 'feat-x', worktreeRoot: true });
  setSetupStatus(root, { complete: false, commands: [] });

  const appDir = `${root}/apps/tlon-mobile`;
  upsertProject(appDir, {});
  setSetupStatus(appDir, { complete: true, commands: [] });

  assert.equal(getSetupStatus(appDir).complete, true);
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

test('create action: setup-pipeline failure still writes exactly one stdout line and does not set exitCode 1', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'rn-iso-test-create-fail-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    // A committed setup pipeline that always fails -- readCommittedSettings
    // reads this straight off disk, no tracking required.
    writeFileSync(join(repo, '.rn-iso.json'), JSON.stringify({ worktree: { install: 'exit 1' } }));

    const { logs, errs } = await runCreateInRepo(repo, 'feat-y', {});

    const expected = join(defaultWorktreeDir(repo), 'feat-y');
    assert.deepEqual(logs, [expected]);
    assert.notEqual(process.exitCode, 1);
    // Sanity: the pipeline really did fail (and reported that on stderr,
    // never stdout) -- otherwise this test would pass for the wrong reason.
    assert.ok(errs.some(e => /Setup incomplete/.test(e)));
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
