import { execSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Command } from 'commander';
import {
  carriedChangesLine,
  carryConflictWarning,
  dependencyInstallCommand,
  registerCreate,
  warmCarryCategories,
  warmCarrySummary,
} from '../commands/worktree.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { defaultWorktreeDir } from '../worktree.ts';
import { findEnclosingWorktreeRoot, getProject, upsertProject } from '../config.ts';

type ActionFn = (name: string | undefined, opts: Record<string, unknown>) => void | Promise<void>;

interface CommandStub {
  command(nameAndArgs?: string): CommandStub;
  description(str?: string): CommandStub;
  option(flags?: string, description?: string): CommandStub;
  action(fn: ActionFn): CommandStub;
}

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

function canon(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function captureAction(register: (cmd: Command) => void) {
  let captured: ActionFn | undefined;
  const stub: CommandStub = {
    command() {
      return stub;
    },
    description() {
      return stub;
    },
    option() {
      return stub;
    },
    action(fn: ActionFn) {
      captured = fn;
      return stub;
    },
  };
  register(stub as Command);
  return (name: string | undefined, opts: Record<string, unknown> = {}) => {
    if (!captured) throw new Error('register did not register an action');
    return captured(name, opts);
  };
}

function initScratchRepo(root: string) {
  mkdirSync(root, { recursive: true });
  const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
  git('git init -q');
  git('git config user.email test@example.com');
  git('git config user.name test');
  writeFileSync(join(root, 'README.md'), 'hello');
  git('git add README.md');
  git('git commit -q -m init');
  return git;
}

async function runCreateInRepo(repo: string, name: string, opts: Record<string, unknown>) {
  const logs: string[] = [];
  const errs: string[] = [];
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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-ok-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);

    const { logs } = await runCreateInRepo(repo, 'feat-x', { install: false });

    const expected = join(defaultWorktreeDir(repo), 'feat-x');
    expect(logs).toEqual([expected]);
    expect(getProject(expected)).toMatchObject({
      worktreeBranch: 'worktree-feat-x',
      worktreeBranchOwned: true,
      worktreeMainRoot: repo,
    });
    expect(process.exitCode).not.toBe(1);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a nested create records the repository main checkout', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-nested-')));
  const repo = join(base, 'repo');
  const parent = join(base, 'parent');
  try {
    const git = initScratchRepo(repo);
    git(`git worktree add -q -b parent ${JSON.stringify(parent)}`);

    await runCreateInRepo(parent, 'child', { base: 'head' });

    const child = join(defaultWorktreeDir(parent), 'child');
    expect(getProject(child)).toMatchObject({ worktreeMainRoot: repo });
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: defaults to the source checkout HEAD when origin/HEAD differs', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-default-head-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    const freshSha = git('git rev-parse HEAD').trim();
    git(`git update-ref refs/remotes/origin/main ${freshSha}`);
    git('git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
    writeFileSync(join(repo, 'CURRENT'), 'current checkout');
    git('git add CURRENT');
    git('git commit -q -m current');
    const headSha = git('git rev-parse HEAD').trim();

    await runCreateInRepo(repo, 'feat-default-head', {});
    const target = join(defaultWorktreeDir(repo), 'feat-default-head');

    expect(execSync('git rev-parse HEAD', { cwd: target, encoding: 'utf-8' }).trim()).toBe(headSha);
    expect(headSha).not.toBe(freshSha);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: --base fresh selects origin/HEAD when it differs from the source checkout', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-explicit-fresh-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    const freshSha = git('git rev-parse HEAD').trim();
    git(`git update-ref refs/remotes/origin/main ${freshSha}`);
    git('git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
    writeFileSync(join(repo, 'CURRENT'), 'current checkout');
    git('git add CURRENT');
    git('git commit -q -m current');

    await runCreateInRepo(repo, 'feat-explicit-fresh', { base: 'fresh' });
    const target = join(defaultWorktreeDir(repo), 'feat-explicit-fresh');

    expect(execSync('git rev-parse HEAD', { cwd: target, encoding: 'utf-8' }).trim()).toBe(freshSha);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: configured worktree.baseRef overrides the default', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-configured-fresh-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    const freshSha = git('git rev-parse HEAD').trim();
    git(`git update-ref refs/remotes/origin/main ${freshSha}`);
    git('git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
    writeFileSync(join(repo, 'CURRENT'), 'current checkout');
    git('git add CURRENT');
    git('git commit -q -m current');
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktree: { baseRef: 'fresh' } }));

    await runCreateInRepo(repo, 'feat-configured-fresh', {});
    const target = join(defaultWorktreeDir(repo), 'feat-configured-fresh');

    expect(execSync('git rev-parse HEAD', { cwd: target, encoding: 'utf-8' }).trim()).toBe(freshSha);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: rejects a --base this repo cannot resolve, before creating anything, on stderr, exit 1', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-badbase-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);

    const { logs, errs } = await runCreateInRepo(repo, 'feat-z', { base: 'origin/HEAD' });

    expect(logs).toEqual([]);
    expect(errs.some((e) => /Invalid --base/.test(e))).toBeTruthy();
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(defaultWorktreeDir(repo), 'feat-z'))).toBe(false);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: --base takes any ref this repo resolves, and branches from it', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-ref-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    git('git checkout -q -b release');
    writeFileSync(join(repo, 'RELEASE'), 'v1');
    git('git add RELEASE');
    git('git commit -q -m release');
    const releaseSha = git('git rev-parse release').trim();
    git('git checkout -q -');
    git('git tag v1 release');

    for (const [name, ref] of [
      ['feat-branch', 'release'],
      ['feat-tag', 'v1'],
      ['feat-sha', releaseSha],
    ] as [string, string][]) {
      const { logs, errs } = await runCreateInRepo(repo, name, { base: ref, install: false });
      const target = join(defaultWorktreeDir(repo), name);
      expect(logs).toEqual([target]);
      expect(process.exitCode).not.toBe(1);
      expect(execSync('git rev-parse HEAD', { cwd: target, encoding: 'utf-8' }).trim()).toBe(releaseSha);
      const branchedFrom = errs.filter((e) => /^  branch {6}worktree-/.test(String(e)));
      expect(branchedFrom.length).toBe(1);
      expect(String(branchedFrom[0])).toMatch(new RegExp(`from ${ref.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')} \\(`));
      expect(String(branchedFrom[0])).toMatch(new RegExp(releaseSha.slice(0, 7)));
    }
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: --dir places the worktree under that directory, resolved against the cwd', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-dir-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    // Run from a subdirectory: a relative --dir must resolve against the cwd,
    // not the repository root, or this lands at repo/.worktrees instead.
    mkdirSync(join(repo, 'sub'));
    const { logs } = await runCreateInRepo(join(repo, 'sub'), 'feat-x', { dir: '.worktrees', install: false });
    const target = join(repo, 'sub', '.worktrees', 'feat-x');
    expect(logs).toEqual([target]);
    expect(existsSync(join(target, '.git'))).toBeTruthy();
    expect(existsSync(join(repo, '.worktrees', 'feat-x'))).toBeFalsy();
    expect(existsSync(join(defaultWorktreeDir(repo), 'feat-x'))).toBeFalsy();
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create: rejects a blank --dir instead of falling through to the default directory', async () => {
  for (const value of ['', '   ']) {
    const program = new Command();
    program.exitOverride();
    registerCreate(program);
    await expect(() => program.parseAsync(['node', 'stim', 'create', 'x', '--dir', value])).rejects.toThrow(
      /must name a directory/,
    );
  }
});

test('create action: --dir through a symlink yields the real path git will report', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-dir-link-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    const { logs } = await runCreateInRepo(repo, 'feat-z', { dir: join(base, 'link', 'wts'), install: false });
    const target = join(base, 'real', 'wts', 'feat-z');
    expect(logs).toEqual([target]);
    expect(realpathSync(target)).toBe(target);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: --carry-ignored into a nested --dir does not copy the worktree into itself', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-dir-carry-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
    execSync('git add .gitignore && git commit -q -m ignore', { cwd: repo });
    const { logs } = await runCreateInRepo(repo, 'feat-nest', {
      dir: '.worktrees',
      carryIgnored: true,
      install: false,
    });
    const target = join(repo, '.worktrees', 'feat-nest');
    expect(logs).toEqual([target]);
    expect(existsSync(join(target, '.worktrees'))).toBeFalsy();
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a non-string worktreeDir setting refuses cleanly instead of throwing', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-dir-invalid-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: 5 }));

    const { logs, errs } = await runCreateInRepo(repo, 'feat-invalid', { install: false });

    expect(logs).toEqual([]);
    expect(errs.some((e) => /Invalid worktreeDir setting/.test(e))).toBeTruthy();
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: an object worktreeDir is one refusal, never an unknown-key warning', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-dir-object-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: {} }));

    const { logs, errs } = await runCreateInRepo(repo, 'feat-object-dir', { install: false });

    expect(logs).toEqual([]);
    expect(errs.filter((e) => /Invalid worktreeDir setting/.test(e))).toHaveLength(1);
    expect(errs.some((e) => /Invalid worktreeDir setting \{\}\. Expected a string path\./.test(e))).toBeTruthy();
    expect(errs.some((e) => /not read by Stim/.test(e))).toBe(false);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: --dir takes precedence over the worktreeDir setting', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-dir-setting-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: join(base, 'from-setting') }));
    const { logs } = await runCreateInRepo(repo, 'feat-y', { dir: join(base, 'from-flag'), install: false });
    expect(logs).toEqual([join(base, 'from-flag', 'feat-y')]);
    expect(existsSync(join(base, 'from-setting', 'feat-y'))).toBeFalsy();
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a relative worktreeDir resolves against the repository root, not the cwd', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-dir-relative-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: '.stim-worktrees' }));
    const cwd = join(repo, 'apps', 'mobile');
    mkdirSync(cwd, { recursive: true });

    const { logs } = await runCreateInRepo(cwd, 'feat-relative', { install: false });

    expect(logs).toEqual([join(repo, '.stim-worktrees', 'feat-relative')]);
    expect(existsSync(join(cwd, '.stim-worktrees'))).toBeFalsy();
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: an absolute worktreeDir is used as written', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-dir-absolute-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    const configured = join(base, 'elsewhere');
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: configured }));
    const cwd = join(repo, 'apps', 'mobile');
    mkdirSync(cwd, { recursive: true });

    const { logs } = await runCreateInRepo(cwd, 'feat-absolute', { install: false });

    expect(logs).toEqual([join(configured, 'feat-absolute')]);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: no worktreeDir setting uses the sibling default from any cwd', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-dir-default-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);
    const cwd = join(repo, 'apps', 'mobile');
    mkdirSync(cwd, { recursive: true });

    const { logs } = await runCreateInRepo(cwd, 'feat-fallback', { install: false });

    expect(logs).toEqual([join(defaultWorktreeDir(repo), 'feat-fallback')]);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: an existing branch is reported as attached, not as branched from --base', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-reuse-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    git('git branch worktree-feat-again');

    const { logs, errs } = await runCreateInRepo(repo, 'feat-again', { install: false });

    expect(logs).toEqual([join(defaultWorktreeDir(repo), 'feat-again')]);
    expect(getProject(join(defaultWorktreeDir(repo), 'feat-again'))).toMatchObject({
      worktreeBranch: 'worktree-feat-again',
      worktreeBranchOwned: false,
      worktreeMainRoot: repo,
    });
    expect(errs.some((e) => /^  branch {6}attached to the existing worktree-feat-again/.test(String(e)))).toBeTruthy();
    expect(!errs.some((e) => /^  branch {6}worktree-feat-again from /.test(String(e)))).toBeTruthy();
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: accepts --base head and --base fresh', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-goodbase-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);

    const head = await runCreateInRepo(repo, 'feat-head', { base: 'head', install: false });
    expect(head.logs).toEqual([join(defaultWorktreeDir(repo), 'feat-head')]);
    expect(process.exitCode).not.toBe(1);
    expect(head.errs.some((e) => /current as of the last/.test(String(e)))).toBe(false);

    const fresh = await runCreateInRepo(repo, 'feat-fresh', { base: 'fresh', install: false });
    expect(fresh.logs).toEqual([join(defaultWorktreeDir(repo), 'feat-fresh')]);
    expect(process.exitCode).not.toBe(1);
    expect(fresh.errs.some((e) => /current as of the last/.test(String(e)))).toBe(true);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: refuses when a leftover branch would void an explicit --base', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-stale-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    git('git branch worktree-feat-stale');
    writeFileSync(join(repo, 'NEW'), 'new');
    git('git add NEW');
    git('git commit -q -m second');
    const newSha = git('git rev-parse HEAD').trim();

    const { logs, errs } = await runCreateInRepo(repo, 'feat-stale', { base: newSha });

    expect(logs).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(defaultWorktreeDir(repo), 'feat-stale'))).toBe(false);
    const text = errs.join('\n');
    expect(text).toMatch(/worktree-feat-stale/);
    expect(text).toMatch(/branch -D worktree-feat-stale/);
    expect(text).toMatch(/create <other-name>|different name/i);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a leftover branch already AT the base is refused too, since --base would guarantee nothing', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-samesha-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    git('git branch worktree-feat-same');
    const headSha = git('git rev-parse HEAD').trim();

    const { logs, errs } = await runCreateInRepo(repo, 'feat-same', { base: headSha });

    expect(logs).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(defaultWorktreeDir(repo), 'feat-same'))).toBe(false);
    const text = errs.join('\n');
    expect(text).toContain('STIM_WORKTREE_BRANCH_EXISTS');
    expect(text).toMatch(/coincidence, not the guarantee/);
    expect(text).toMatch(/branch -D worktree-feat-same/);
    expect(text).not.toMatch(/attached to the existing/);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: with no --base a leftover branch is still attached to', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-nobase-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    git('git branch worktree-feat-quiet');
    writeFileSync(join(repo, 'NEW'), 'new');
    git('git add NEW');
    git('git commit -q -m second');

    const { logs } = await runCreateInRepo(repo, 'feat-quiet', {});

    expect(logs).toEqual([join(defaultWorktreeDir(repo), 'feat-quiet')]);
    expect(process.exitCode).not.toBe(1);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

const UNWRITABLE_SKIP =
  'runs as root, where a 0o500 directory does not block writes, so the git failure cannot be staged';

function skipAsRoot(ctx: { skip: (note?: string) => void }): void {
  if (process.getuid?.() === 0) ctx.skip(UNWRITABLE_SKIP);
}

test('create action: a failed git worktree add rolls back the branch it just created', async (ctx) => {
  skipAsRoot(ctx);
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-rollback-')));
  const repo = join(base, 'repo');
  const unwritable = join(base, 'unwritable');
  try {
    const git = initScratchRepo(repo);
    mkdirSync(unwritable);
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: unwritable }));
    chmodSync(unwritable, 0o500);

    const { logs, errs } = await runCreateInRepo(repo, 'feat-roll', { install: false });

    expect(logs).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(git('git branch --list worktree-feat-roll').trim()).toBe('');
    expect(errs.join('\n')).toMatch(/Deleted worktree-feat-roll/);
  } finally {
    process.exitCode = 0;
    chmodSync(unwritable, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a failed git worktree add keeps a branch it did not create', async (ctx) => {
  skipAsRoot(ctx);
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-rollback-keep-')));
  const repo = join(base, 'repo');
  const unwritable = join(base, 'unwritable');
  try {
    const git = initScratchRepo(repo);
    git('git branch worktree-feat-keep');
    mkdirSync(unwritable);
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: unwritable }));
    chmodSync(unwritable, 0o500);

    const { logs, errs } = await runCreateInRepo(repo, 'feat-keep', { install: false });

    expect(logs).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(git('git branch --list worktree-feat-keep')).toMatch(/worktree-feat-keep/);
    expect(errs.join('\n')).not.toMatch(/Deleted worktree-feat-keep/);
  } finally {
    process.exitCode = 0;
    chmodSync(unwritable, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a branch that appears between the pre-check and the add is never rolled back', async (ctx) => {
  skipAsRoot(ctx);
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-rollback-race-')));
  const repo = join(base, 'repo');
  const unwritable = join(base, 'unwritable');
  try {
    const git = initScratchRepo(repo);
    mkdirSync(unwritable);
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: unwritable }));
    chmodSync(unwritable, 0o500);

    const real = getExecutor();
    let verified = 0;
    setExecutor({
      run: (cmd: string, opts: unknown) => real.run(cmd, opts as never),
      runFile: (file: string, args: string[], opts: unknown) => real.runFile(file, args, opts as never),
      spawn: (cmd: string, args: string[], opts: unknown) => real.spawn(cmd, args, opts as never),
      runQuiet: (cmd: string, opts: unknown) => {
        const out = real.runQuiet(cmd, opts as never);
        if (cmd.includes('refs/heads/worktree-feat-race') && ++verified === 1) {
          git('git branch worktree-feat-race');
        }
        return out;
      },
    });

    const { logs, errs } = await runCreateInRepo(repo, 'feat-race', { install: false });

    expect(logs).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(git('git branch --list worktree-feat-race')).toMatch(/worktree-feat-race/);
    const text = errs.join('\n');
    expect(text).not.toMatch(/Deleted worktree-feat-race/);
    expect(text).toMatch(/Kept the branch worktree-feat-race[\s\S]*already existed/);
  } finally {
    process.exitCode = 0;
    resetExecutor();
    chmodSync(unwritable, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: the rollback reads refs/heads, so a same-named tag does not shield the branch', async (ctx) => {
  skipAsRoot(ctx);
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-rollback-tag-')));
  const repo = join(base, 'repo');
  const unwritable = join(base, 'unwritable');
  try {
    const git = initScratchRepo(repo);
    const firstSha = git('git rev-parse HEAD').trim();
    writeFileSync(join(repo, 'NEW'), 'new');
    git('git add NEW');
    git('git commit -q -m second');
    git(`git tag worktree-feat-tag ${firstSha}`);
    mkdirSync(unwritable);
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: unwritable }));
    chmodSync(unwritable, 0o500);

    const { errs } = await runCreateInRepo(repo, 'feat-tag', { install: false });

    expect(process.exitCode).toBe(1);
    expect(git('git branch --list worktree-feat-tag').trim()).toBe('');
    expect(git('git tag --list worktree-feat-tag').trim()).toBe('worktree-feat-tag');
    expect(errs.join('\n')).toMatch(/Deleted worktree-feat-tag/);
  } finally {
    process.exitCode = 0;
    chmodSync(unwritable, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: the rollback compares against the base captured before the add, not a moved one', async (ctx) => {
  skipAsRoot(ctx);
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-rollback-moved-')));
  const repo = join(base, 'repo');
  const unwritable = join(base, 'unwritable');
  try {
    const git = initScratchRepo(repo);
    mkdirSync(unwritable);
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ worktreeDir: unwritable }));
    chmodSync(unwritable, 0o500);

    const real = getExecutor();
    setExecutor({
      run: (cmd: string, opts: unknown) => real.run(cmd, opts as never),
      runQuiet: (cmd: string, opts: unknown) => real.runQuiet(cmd, opts as never),
      spawn: (cmd: string, args: string[], opts: unknown) => real.spawn(cmd, args, opts as never),
      runFile: (file: string, args: string[], opts: unknown) => {
        if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') {
          try {
            return real.runFile(file, args, opts as never);
          } catch (error) {
            writeFileSync(join(repo, 'MOVED'), 'moved');
            git('git add MOVED');
            git('git commit -q -m moved');
            throw error;
          }
        }
        return real.runFile(file, args, opts as never);
      },
    });

    const { errs } = await runCreateInRepo(repo, 'feat-moved', { install: false });

    expect(process.exitCode).toBe(1);
    expect(git('git branch --list worktree-feat-moved').trim()).toBe('');
    expect(errs.join('\n')).toMatch(/Deleted worktree-feat-moved/);
  } finally {
    process.exitCode = 0;
    resetExecutor();
    chmodSync(unwritable, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a same-named tag does not stand in for the branch in the --base refusal', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-tag-refusal-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    const firstSha = git('git rev-parse --short HEAD').trim();
    writeFileSync(join(repo, 'NEW'), 'new');
    git('git add NEW');
    git('git commit -q -m second');
    const headSha = git('git rev-parse --short HEAD').trim();
    git(`git tag worktree-feat-tagbase ${firstSha}`);
    git('git branch worktree-feat-tagbase');

    const { errs } = await runCreateInRepo(repo, 'feat-tagbase', { base: 'head' });

    expect(process.exitCode).toBe(1);
    const text = errs.join('\n');
    expect(text).toContain('STIM_WORKTREE_BRANCH_EXISTS');
    expect(text).toContain(`already exists at ${headSha}`);
    expect(text).not.toContain(firstSha);
    expect(text).toMatch(/which is where --base head resolves right now/);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('carriedChangesLine and carryConflictWarning cap at three files and count the rest', () => {
  expect(carriedChangesLine(['app.json'])).toBe(
    'carried 1 uncommitted change from the source (app.json) -- uncommitted here too; commit deliberately',
  );
  expect(carriedChangesLine(['a', 'b'])).toContain('carried 2 uncommitted changes from the source');
  expect(carriedChangesLine(['a', 'b', 'c', 'd', 'e'])).toContain('(a, b, c, +2)');
  const warning = carryConflictWarning(['a', 'b', 'c', 'd']);
  expect(warning).toContain('(a, b, c, +1)');
  expect(warning).toMatch(/base diverges from the source HEAD/);
  expect(warning).toMatch(/nothing was changed here/);
  expect(warning).toMatch(/fingerprints and cache keys/);
});

test('create action: --carry-ignored applies the source uncommitted changes when they fit the base', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-carrydiff-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    writeFileSync(join(repo, 'app.json'), '{"expo":{"name":"app"}}\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git('git add app.json .gitignore');
    git('git commit -q -m app');
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = () => {};\n');
    writeFileSync(join(repo, 'app.json'), '{"expo":{"name":"app","scheme":"dirty-scheme"}}\n');

    const { logs, errs } = await runCreateInRepo(repo, 'feat-carry', { carryIgnored: true, base: 'head' });

    const wt = join(defaultWorktreeDir(repo), 'feat-carry');
    expect(logs).toEqual([wt]);
    expect(readFileSync(join(wt, 'app.json'), 'utf-8')).toContain('dirty-scheme');
    const status = execSync('git status --porcelain -- app.json', { cwd: wt, encoding: 'utf-8' }).trim();
    expect(status).toBe('M app.json');
    expect(
      errs.some((e) => /^  carry {7}carried 1 uncommitted change from the source \(app\.json\)/.test(e)),
    ).toBeTruthy();
    expect(errs.some((e) => /uncommitted here too; commit deliberately/.test(e))).toBeTruthy();
    expect(process.exitCode).not.toBe(1);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: --carry-ignored warns and applies NOTHING when the base diverges from the source HEAD', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-carryconflict-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    writeFileSync(join(repo, 'app.json'), 'first version\n');
    git('git add app.json');
    git('git commit -q -m one');
    const oldSha = git('git rev-parse HEAD').trim();
    writeFileSync(join(repo, 'app.json'), 'completely rewritten\n');
    git('git add app.json');
    git('git commit -q -m two');
    writeFileSync(join(repo, 'app.json'), 'completely rewritten, plus dirty\n');

    const { logs, errs } = await runCreateInRepo(repo, 'feat-conflict', { carryIgnored: true, base: oldSha });

    const wt = join(defaultWorktreeDir(repo), 'feat-conflict');
    expect(logs).toEqual([wt]);
    expect(readFileSync(join(wt, 'app.json'), 'utf-8')).toBe('first version\n');
    expect(execSync('git status --porcelain', { cwd: wt, encoding: 'utf-8' }).trim()).toBe('');
    expect(
      errs.some((e) => /^  carry {7}could not carry the source's uncommitted changes \(app\.json\)/.test(e)),
    ).toBeTruthy();
    expect(errs.some((e) => /base diverges from the source HEAD/.test(e))).toBeTruthy();
    expect(errs.some((e) => /fingerprints and cache keys/.test(e))).toBeTruthy();
    expect(process.exitCode).not.toBe(1);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a plain create (no --carry-ignored) is pure HEAD -- no diff carry, no warning', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-nocarry-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    writeFileSync(join(repo, 'app.json'), '{"expo":{}}\n');
    git('git add app.json');
    git('git commit -q -m app');
    writeFileSync(join(repo, 'app.json'), '{"expo":{"scheme":"dirty"}}\n');

    const { errs } = await runCreateInRepo(repo, 'feat-plain', { base: 'head' });

    const wt = join(defaultWorktreeDir(repo), 'feat-plain');
    expect(readFileSync(join(wt, 'app.json'), 'utf-8')).toBe('{"expo":{}}\n');
    expect(execSync('git status --porcelain', { cwd: wt, encoding: 'utf-8' }).trim()).toBe('');
    expect(errs.some((e) => /carried .* uncommitted|could not carry/.test(e))).toBe(false);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('warmCarryCategories recognizes dependency, CocoaPods, and native output paths', () => {
  expect(
    warmCarryCategories([
      'apps/mobile/node_modules',
      'apps/mobile/ios/Pods',
      'apps/mobile/ios/build',
      'apps/mobile/android/app/build',
    ]),
  ).toEqual({ dependencies: true, pods: true, nativeOutput: true });
  expect(warmCarrySummary(['node_modules'], undefined, true)).toBe(
    'node_modules (APFS clone); no Pods; no native build output',
  );
  expect(warmCarrySummary(['node_modules', 'ios/Pods', 'ios/build'], undefined, false)).toBe(
    'node_modules, Pods, native build output (byte copy)',
  );
});

test('dependencyInstallCommand shell-quotes repository paths', () => {
  expect(dependencyInstallCommand('/tmp/app/$(touch PWNED)')).toBe("cd '/tmp/app/$(touch PWNED)' && npm install");
  expect(dependencyInstallCommand("/tmp/app/it's-here")).toBe("cd '/tmp/app/it'\\''s-here' && npm install");
});

test('warmCarryCategories inspects a collapsed ignored directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-warm-categories-'));
  try {
    for (const rel of ['ios/Pods', 'ios/build']) mkdirSync(join(root, rel), { recursive: true });
    expect(warmCarryCategories(['ios'], root)).toEqual({ dependencies: false, pods: true, nativeOutput: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('warmCarryCategories ignores native build paths that contain a node_modules directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-warm-native-node-modules-'));
  try {
    const nativeOutput = 'android/app/.cxx/debug/Users/example/app/node_modules/react-native-screens';
    mkdirSync(join(root, nativeOutput), { recursive: true });
    mkdirSync(join(root, 'android/app/build'), { recursive: true });
    expect(warmCarryCategories(['android/app/.cxx', 'android/app/build'], root)).toEqual({
      dependencies: false,
      pods: false,
      nativeOutput: true,
    });

    writeFileSync(join(root, 'package.json'), '{"name":"app"}\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    expect(warmCarryCategories(['android/app/.cxx', 'node_modules'], root).dependencies).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('warmCarryCategories keeps a confirmed node_modules sticky against a later unconfirmed one', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-warm-sticky-deps-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"app"}\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, 'vendor/node_modules'), { recursive: true });

    expect(warmCarryCategories(['node_modules', 'vendor/node_modules'], root).dependencies).toBe(true);
    expect(warmCarryCategories(['vendor/node_modules', 'node_modules'], root).dependencies).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('create action: a plain create reports the exact warm-worktree command when warm state exists', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-warm-hint-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\nios/Pods/\nios/build/\n');
    writeFileSync(join(repo, 'package.json'), '{"name":"app"}\n');
    mkdirSync(join(repo, 'ios'), { recursive: true });
    writeFileSync(join(repo, 'ios', 'Podfile'), "platform :ios, '15.1'\n");
    git('git add .gitignore package.json ios/Podfile');
    git('git commit -q -m ignored');
    for (const rel of ['node_modules/pkg/index.js', 'ios/Pods/Manifest.lock', 'ios/build/generated.cpp']) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), 'warm');
    }

    const { errs } = await runCreateInRepo(repo, 'feat-warm-hint', { base: 'head' });

    expect(
      errs.some((e) => /^  carry {7}warm source not carried: dependencies, CocoaPods, native build output/.test(e)),
    ).toBe(true);
    expect(errs.some((e) => /stim worktree create <name> --carry-ignored/.test(e))).toBe(true);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

function podsRepo(repo: string, { branchLock, workingLock }: { branchLock: string; workingLock: string }) {
  const git = initScratchRepo(repo);
  writeFileSync(join(repo, '.gitignore'), 'ios/Pods/\n');
  mkdirSync(join(repo, 'ios'), { recursive: true });
  writeFileSync(join(repo, 'ios', 'Podfile'), "platform :ios, '15.1'\n");
  writeFileSync(join(repo, 'ios', 'Podfile.lock'), branchLock);
  git('git add .gitignore ios/Podfile ios/Podfile.lock');
  git('git commit -q -m pods');
  writeFileSync(join(repo, 'ios', 'Podfile.lock'), workingLock);
  mkdirSync(join(repo, 'ios', 'Pods'), { recursive: true });
  writeFileSync(join(repo, 'ios', 'Pods', 'Manifest.lock'), workingLock);
}

test('create action: pods installed against an uncommitted Podfile.lock carried along are not called stale', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-pods-carried-')));
  const repo = join(base, 'repo');
  const branchLock = 'PODS:\n  - fmt (11.0.2)\n';
  const workingLock = 'PODS:\n  - fmt (11.0.2)\n  - RNScreens (4.0.0)\n';
  try {
    podsRepo(repo, { branchLock, workingLock });

    const { errs } = await runCreateInRepo(repo, 'feat-pods-carried', { base: 'head', carryIgnored: true });

    const wt = join(defaultWorktreeDir(repo), 'feat-pods-carried');
    expect(readFileSync(join(wt, 'ios', 'Podfile.lock'), 'utf-8')).toBe(
      readFileSync(join(wt, 'ios', 'Pods', 'Manifest.lock'), 'utf-8'),
    );
    expect(errs.some((e) => /carried ios\/Pods does not match/.test(e))).toBe(false);
    expect(errs.some((e) => /^  carry {7}carried 1 uncommitted change /.test(e))).toBe(true);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: pods that disagree with the Podfile.lock on disk still get the pod install warning', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-pods-stale-')));
  const repo = join(base, 'repo');
  try {
    podsRepo(repo, { branchLock: 'PODS:\n  - fmt (11.0.2)\n', workingLock: 'PODS:\n  - fmt (11.0.2)\n' });
    writeFileSync(join(repo, 'ios', 'Pods', 'Manifest.lock'), 'PODS:\n  - fmt (10.0.0)\n');

    const { errs } = await runCreateInRepo(repo, 'feat-pods-stale', { base: 'head', carryIgnored: true });

    const warning = errs.find((e) => /^  carry {7}carried ios\/Pods does not match/.test(e));
    expect(warning).toContain('the ios/Podfile.lock on disk here');
    expect(warning).toContain('pod install');
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: --carry-ignored reports warm categories and the copy mode', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-warm-summary-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\nios/Pods/\nios/build/\n');
    writeFileSync(join(repo, 'package.json'), '{"name":"app"}\n');
    mkdirSync(join(repo, 'ios'), { recursive: true });
    writeFileSync(join(repo, 'ios', 'Podfile'), "platform :ios, '15.1'\n");
    git('git add .gitignore package.json ios/Podfile');
    git('git commit -q -m ignored');
    for (const rel of ['node_modules/pkg/index.js', 'ios/Pods/Manifest.lock', 'ios/build/generated.cpp']) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), 'warm');
    }

    const { errs } = await runCreateInRepo(repo, 'feat-warm-summary', { base: 'head', carryIgnored: true });

    expect(
      errs.some((e) => /^  carry {7}node_modules, Pods, native build output \((APFS clone|byte copy)\)$/.test(e)),
    ).toBe(true);
    expect(errs.some((e) => /Cloned dependencies may be stale/.test(e))).toBe(false);
    expect(errs.some((e) => /^  ready {7}\//.test(e))).toBe(true);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: the stale-carry line prints only when the branch lockfile differs', async () => {
  for (const [label, useOldBase] of [
    ['a branch whose lockfile matches the source', false],
    ['a branch pinned before the lockfile changed', true],
  ] as const) {
    resetExecutor();
    const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-stale-')));
    const repo = join(base, 'repo');
    try {
      const git = initScratchRepo(repo);
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(repo, 'package.json'), '{"name":"app"}\n');
      writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
      git('git add .gitignore package.json package-lock.json');
      git('git commit -q -m lockfile');
      const first = git('git rev-parse HEAD').trim();
      writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/pkg":{}}}\n');
      git('git add package-lock.json');
      git('git commit -q -m bump');
      mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'dep');

      const { errs } = await runCreateInRepo(repo, `feat-stale-${useOldBase ? 'yes' : 'no'}`, {
        base: useOldBase ? first : 'head',
        carryIgnored: true,
      });

      expect({
        label,
        stale: errs.some((e) => /^  carry {7}carried dependencies may be stale/.test(e)),
      }).toEqual({ label, stale: useOldBase });
    } finally {
      process.exitCode = 0;
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test('create action: a cold plain create does not recommend --carry-ignored', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-cold-hint-')));
  const repo = join(base, 'repo');
  try {
    initScratchRepo(repo);

    const { errs } = await runCreateInRepo(repo, 'feat-cold-hint', { base: 'head' });

    expect(errs.some((e) => /Warm source not carried|--carry-ignored/.test(e))).toBe(false);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a cold --carry-ignored create prints one exact dependency remedy', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-cold-carry-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    git('git add package-lock.json');
    git('git commit -q -m lockfile');

    const { errs } = await runCreateInRepo(repo, 'feat-cold-carry', { base: 'head', carryIgnored: true });

    const remedies = errs.filter((e) => /^  carry {7}no dependencies carried/.test(e));
    expect(remedies).toHaveLength(1);
    expect(remedies[0]).toContain('npm ci');
    expect(errs.some((e) => /^  ready {7}\//.test(e))).toBe(true);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: a cold nested package prints its package manager and directory', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-cold-nested-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    mkdirSync(join(repo, 'apps/mobile'), { recursive: true });
    writeFileSync(join(repo, 'apps/mobile/yarn.lock'), 'lock\n');
    git('git add apps/mobile/yarn.lock');
    git('git commit -q -m nested-lockfile');

    const { errs } = await runCreateInRepo(repo, 'feat-cold-nested', { base: 'head', carryIgnored: true });
    const target = join(defaultWorktreeDir(repo), 'feat-cold-nested', 'apps/mobile');

    expect(errs.some((line) => line.includes(`cd '${target}' && yarn install`))).toBe(true);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: stale nested dependencies use the nested package manager', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-test-create-nested-stale-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    writeFileSync(join(repo, '.gitignore'), 'apps/mobile/node_modules/\n');
    mkdirSync(join(repo, 'apps/mobile'), { recursive: true });
    writeFileSync(join(repo, 'apps/mobile/yarn.lock'), 'version one\n');
    git('git add .gitignore apps/mobile/yarn.lock');
    git('git commit -q -m first-lock');
    const oldHead = git('git rev-parse HEAD').trim();
    writeFileSync(join(repo, 'apps/mobile/yarn.lock'), 'version two\n');
    git('git add apps/mobile/yarn.lock');
    git('git commit -q -m second-lock');
    mkdirSync(join(repo, 'apps/mobile/node_modules/pkg'), { recursive: true });
    writeFileSync(join(repo, 'apps/mobile/node_modules/pkg/index.js'), 'warm');

    const { errs } = await runCreateInRepo(repo, 'feat-nested-stale', { base: oldHead, carryIgnored: true });
    const target = join(defaultWorktreeDir(repo), 'feat-nested-stale', 'apps/mobile');

    expect(errs.some((line) => line.includes(`cd '${target}' && yarn install`))).toBe(true);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});
