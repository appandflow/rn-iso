import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveInstallPipeline } from '../src/commands/worktree.js';
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

test('uses the configured pipeline verbatim', () => {
  const pipeline = resolveInstallPipeline(
    { worktree: { install: ['pnpm install', 'pnpm build:packages'] } },
    'npm'
  );
  assert.deepEqual(pipeline, ['pnpm install', 'pnpm build:packages']);
});

test('accepts a single string as a one-command pipeline', () => {
  assert.deepEqual(resolveInstallPipeline({ worktree: { install: 'yarn' } }, 'npm'), ['yarn']);
});

test('install false disables the pipeline', () => {
  assert.deepEqual(resolveInstallPipeline({ worktree: { install: false } }, 'npm'), []);
});

test('falls back to a configured settings.packageManager over the passed-in one', () => {
  const pipeline = resolveInstallPipeline({ packageManager: 'pnpm' }, 'npm');
  assert.deepEqual(pipeline, ['pnpm install']);
});

// This is the fallback branch that used to be untestable: resolveInstallPipeline
// no longer calls detectPackageManager itself (that walks the filesystem for
// lockfiles), so the caller-supplied package manager can be exercised directly
// with no settings.packageManager override and no disk I/O.
test('falls back to the caller-supplied package manager when settings has none', () => {
  assert.deepEqual(resolveInstallPipeline({}, 'pnpm'), ['pnpm install']);
  assert.deepEqual(resolveInstallPipeline(undefined, 'bun'), ['bun install']);
});

test('setup status round-trips and reports incompleteness', () => {
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

test('getSetupStatus returns null for an unknown project', () => {
  assert.equal(getSetupStatus('/nope'), null);
});

// This is the scenario Fix 1 targets: `worktree create` registers the
// worktree root with a label and a setup status, but the agent later runs
// `rn-iso ios` from a nested app dir (e.g. apps/tlon-mobile in a monorepo),
// which registers a *different* key with no setup status of its own. Without
// the fallback, a later `getSetupStatus(<app dir>)` would return null and the
// "setup incomplete" warning would never fire.
test('getSetupStatus falls back to the enclosing worktree root status', () => {
  const root = '/repo-worktrees/feat-x';
  upsertProject(root, { label: 'feat-x', worktreeRoot: true });
  setSetupStatus(root, { complete: false, commands: [{ command: 'pnpm install', ok: false }] });

  const appDir = `${root}/apps/tlon-mobile`;
  upsertProject(appDir, {});

  const status = getSetupStatus(appDir);
  assert.equal(status.complete, false);
  assert.equal(status.commands[0].command, 'pnpm install');
});

test('getSetupStatus prefers a project own status over the enclosing worktree root', () => {
  const root = '/repo-worktrees/feat-x';
  upsertProject(root, { label: 'feat-x', worktreeRoot: true });
  setSetupStatus(root, { complete: false, commands: [] });

  const appDir = `${root}/apps/tlon-mobile`;
  upsertProject(appDir, {});
  setSetupStatus(appDir, { complete: true, commands: [] });

  assert.equal(getSetupStatus(appDir).complete, true);
});

test('findEnclosingWorktreeRoot uses a real path-segment prefix, not a bare startsWith', () => {
  upsertProject('/a/foo-worktrees/x', { label: 'x', worktreeRoot: true });
  assert.equal(findEnclosingWorktreeRoot('/a/foo-worktrees/xy'), null);
  assert.equal(findEnclosingWorktreeRoot('/a/foo-worktrees/xy/pkg'), null);
  assert.equal(findEnclosingWorktreeRoot('/a/foo-worktrees/x/pkg'), '/a/foo-worktrees/x');
});

test('findEnclosingWorktreeRoot picks the longest matching worktree-root key', () => {
  upsertProject('/repo-worktrees', { label: 'outer', worktreeRoot: true });
  upsertProject('/repo-worktrees/feat-x', { label: 'feat-x', worktreeRoot: true });
  assert.equal(findEnclosingWorktreeRoot('/repo-worktrees/feat-x/apps/mobile'), '/repo-worktrees/feat-x');
});

test('findEnclosingWorktreeRoot returns null when nothing is registered as a worktree root', () => {
  upsertProject('/repo-worktrees/feat-x', { label: 'feat-x' });
  assert.equal(findEnclosingWorktreeRoot('/repo-worktrees/feat-x/apps/mobile'), null);
});
