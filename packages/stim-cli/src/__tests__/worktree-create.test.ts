import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Command } from 'commander';
import { carriedChangesLine, carryConflictWarning, registerCreate } from '../commands/worktree.ts';
import { resetExecutor } from '../exec.ts';
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
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-cli-test-'));
  process.env.STIM_CLI_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_CLI_HOME;
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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-ok-')));
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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-nested-')));
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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-default-head-')));
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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-explicit-fresh-')));
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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-configured-fresh-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    const freshSha = git('git rev-parse HEAD').trim();
    git(`git update-ref refs/remotes/origin/main ${freshSha}`);
    git('git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main');
    writeFileSync(join(repo, 'CURRENT'), 'current checkout');
    git('git add CURRENT');
    git('git commit -q -m current');
    writeFileSync(join(repo, '.stim-cli.json'), JSON.stringify({ worktree: { baseRef: 'fresh' } }));

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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-badbase-')));
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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-ref-')));
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
      const branchedFrom = errs.filter((e) => String(e).startsWith('Branched '));
      expect(branchedFrom.length).toBe(1);
      expect(String(branchedFrom[0])).toMatch(new RegExp(`from ${ref.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')} \\(`));
      expect(String(branchedFrom[0])).toMatch(new RegExp(releaseSha.slice(0, 7)));
    }
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: an existing branch is reported as attached, not as branched from --base', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-reuse-')));
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
    expect(errs.some((e) => /Attached to the existing branch worktree-feat-again/.test(String(e)))).toBeTruthy();
    expect(!errs.some((e) => String(e).startsWith('Branched '))).toBeTruthy();
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: accepts --base head and --base fresh', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-goodbase-')));
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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-stale-')));
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

test('create action: a leftover branch already AT the base is attached to, not refused', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-samesha-')));
  const repo = join(base, 'repo');
  try {
    const git = initScratchRepo(repo);
    git('git branch worktree-feat-same');
    const headSha = git('git rev-parse HEAD').trim();

    const { logs, errs } = await runCreateInRepo(repo, 'feat-same', { base: headSha });

    expect(logs).toEqual([join(defaultWorktreeDir(repo), 'feat-same')]);
    expect(process.exitCode).not.toBe(1);
    expect(errs.some((e) => /Attached to the existing branch worktree-feat-same/.test(String(e)))).toBeTruthy();
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: with no --base a leftover branch is still attached to', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-nobase-')));
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

test('carriedChangesLine and carryConflictWarning cap at three files and count the rest', () => {
  expect(carriedChangesLine(['app.json'])).toBe(
    'Carried 1 uncommitted change(s) from the source (app.json) -- uncommitted here too; commit deliberately.',
  );
  expect(carriedChangesLine(['a', 'b', 'c', 'd', 'e'])).toContain('(a, b, c, +2)');
  const warning = carryConflictWarning(['a', 'b', 'c', 'd']);
  expect(warning).toContain('(a, b, c, +1)');
  expect(warning).toMatch(/base diverges from the source HEAD/);
  expect(warning).toMatch(/nothing was changed here/);
  expect(warning).toMatch(/fingerprints and cache keys/);
});

test('create action: --carry-ignored applies the source uncommitted changes when they fit the base', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-carrydiff-')));
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
    expect(errs.some((e) => /Carried 1 uncommitted change\(s\) from the source \(app\.json\)/.test(e))).toBeTruthy();
    expect(errs.some((e) => /uncommitted here too; commit deliberately/.test(e))).toBeTruthy();
    expect(process.exitCode).not.toBe(1);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});

test('create action: --carry-ignored warns and applies NOTHING when the base diverges from the source HEAD', async () => {
  resetExecutor();
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-carryconflict-')));
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
    expect(errs.some((e) => /Could not carry the source's uncommitted changes \(app\.json\)/.test(e))).toBeTruthy();
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
  const base = canon(mkdtempSync(join(tmpdir(), 'stim-cli-test-create-nocarry-')));
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
    expect(errs.some((e) => /Carried .* uncommitted|Could not carry/.test(e))).toBe(false);
  } finally {
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
  }
});
