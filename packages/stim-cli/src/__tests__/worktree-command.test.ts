import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dependencyInstallCommand } from '../commands/worktree.ts';
import { findEnclosingWorktreeRoot, upsertProject } from '../config.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('findEnclosingWorktreeRoot uses a real path-segment prefix, not a bare startsWith', async () => {
  upsertProject('/a/foo-worktrees/x', { label: 'x', worktreeRoot: true });
  expect(findEnclosingWorktreeRoot('/a/foo-worktrees/xy')).toBe(null);
  expect(findEnclosingWorktreeRoot('/a/foo-worktrees/xy/pkg')).toBe(null);
  expect(findEnclosingWorktreeRoot('/a/foo-worktrees/x/pkg')).toBe('/a/foo-worktrees/x');
});

test('findEnclosingWorktreeRoot picks the longest matching worktree-root key', async () => {
  upsertProject('/repo-worktrees', { label: 'outer', worktreeRoot: true });
  upsertProject('/repo-worktrees/feat-x', { label: 'feat-x', worktreeRoot: true });
  expect(findEnclosingWorktreeRoot('/repo-worktrees/feat-x/apps/mobile')).toBe('/repo-worktrees/feat-x');
});

test('findEnclosingWorktreeRoot returns null when nothing is registered as a worktree root', async () => {
  upsertProject('/repo-worktrees/feat-x', { label: 'feat-x' });
  expect(findEnclosingWorktreeRoot('/repo-worktrees/feat-x/apps/mobile')).toBe(null);
});

test('dependencyInstallCommand shell-quotes repository paths', () => {
  expect(dependencyInstallCommand('/tmp/app/$(touch PWNED)')).toBe("cd '/tmp/app/$(touch PWNED)' && npm install");
  expect(dependencyInstallCommand("/tmp/app/it's-here")).toBe("cd '/tmp/app/it'\\''s-here' && npm install");
});
