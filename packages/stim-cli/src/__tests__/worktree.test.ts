import assert from 'node:assert';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import {
  matchesInclude,
  isCarrySkipped,
  unpushedCommits,
  hasUncommittedWork,
  listWorktrees,
  cloneIgnoredEntries,
  dirtyFingerprintFiles,
  podsOutOfSync,
  depsOutOfSync,
  isPodInstallChurn,
  listGitignoredEntries,
  listCarryableIgnoredEntries,
  listTrackedPaths,
  removeWorktree,
  repoRoot,
  gitCommonDir,
  isMainWorkingTree,
  branchExists,
  hasRemote,
  dirtyPaths,
  restoreFile,
} from '../worktree.ts';

afterEach(() => resetExecutor());

test('matchesInclude supports gitignore-style patterns', () => {
  expect(matchesInclude('apps/tlon-mobile/.env', ['.env'])).toBe(true);
  expect(matchesInclude('apps/tlon-mobile/.env', ['*.env'])).toBe(false);
  expect(matchesInclude('config/secrets.json', ['config/secrets.json'])).toBe(true);
  expect(matchesInclude('a/b/c.node', ['**/*.node'])).toBe(true);
  expect(matchesInclude('apps/x/.env.local', ['.env'])).toBe(false);
});

test('matchesInclude treats a leading slash as a root anchor', () => {
  expect(matchesInclude('config/secrets.json', ['/config/secrets.json'])).toBe(true);
  expect(matchesInclude('a/config/secrets.json', ['/config/secrets.json'])).toBe(false);
  expect(matchesInclude('a/config/secrets.json', ['config/secrets.json'])).toBe(true);
});

test('matchesInclude treats ? as a single-character wildcard, not a quantifier', () => {
  expect(matchesInclude('apps/mobile/b1.env', ['b?.env'])).toBe(true);
  expect(matchesInclude('apps/mobile/b12.env', ['b?.env'])).toBe(false);
  expect(matchesInclude('apps/mobile/b.env', ['b?.env'])).toBe(false);
});

test('hasUncommittedWork reflects git status output', () => {
  setExecutor({ run: () => '', runFileQuiet: () => ' M file.js', spawn: () => {} });
  expect(hasUncommittedWork('/wt')).toBe(true);
  setExecutor({ run: () => '', runFileQuiet: () => '', spawn: () => {} });
  expect(hasUncommittedWork('/wt')).toBe(false);
});

test('unpushedCommits lists commits missing from every remote and every other local branch', () => {
  setExecutor({
    runFileQuiet: (_file: string, args: string[]) =>
      args.includes('symbolic-ref') ? 'worktree-ws' : 'abc123 first\ndef456 second',
    spawn: () => {},
  });
  expect(unpushedCommits('/wt')).toEqual(['abc123 first', 'def456 second']);
});

test('unpushedCommits returns empty when git reports nothing', () => {
  setExecutor({
    runFileQuiet: (_file: string, args: string[]) => (args.includes('symbolic-ref') ? 'worktree-ws' : ''),
    spawn: () => {},
  });
  expect(unpushedCommits('/wt')).toEqual([]);
});

test('unpushedCommits excludes only the worktree own branch from the local-branch protection', () => {
  const calls: string[][] = [];
  setExecutor({
    runFileQuiet: (_file: string, args: string[]) => {
      calls.push(args);
      if (args.includes('symbolic-ref')) return 'worktree-ws';
      if (args.includes('log')) return 'abc123 own-work';
      return null;
    },
    spawn: () => {},
  });
  expect(unpushedCommits('/wt')).toEqual(['abc123 own-work']);
  const log = calls.find((args) => args.includes('log'));
  expect(log).toEqual([
    '-C',
    '/wt',
    'log',
    '--oneline',
    'HEAD',
    '--not',
    '--remotes',
    '--exclude=worktree-ws',
    '--branches',
  ]);
});

test('unpushedCommits falls back to the remotes-only count on an unsafe branch name', () => {
  for (const branch of ['evil"; touch PWNED; "']) {
    const calls: string[][] = [];
    setExecutor({
      runFileQuiet: (_file: string, args: string[]) => {
        calls.push(args);
        if (args.includes('symbolic-ref')) return branch;
        if (args.includes('log')) return '';
        return null;
      },
      spawn: () => {},
    });
    expect(unpushedCommits('/wt')).toEqual([]);
    const log = calls.find((args) => args.includes('log'));
    expect(log?.slice(-2)).toEqual(['--not', '--remotes']);
  }
});

test('unpushedCommits against a real repo: empty right after push, reports a commit made only locally', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-test-unpushed-'));
  const bareRemote = join(base, 'remote.git');
  const repo = join(base, 'repo');
  try {
    mkdirSync(bareRemote, { recursive: true });
    execSync(`git init -q --bare "${bareRemote}"`);
    mkdirSync(repo, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git(`git remote add origin "${bareRemote}"`);
    writeFileSync(join(repo, 'README.md'), 'hello');
    git('git add README.md');
    git('git commit -q -m init');
    git('git push -q -u origin HEAD');

    expect(unpushedCommits(repo)).toEqual([]);

    writeFileSync(join(repo, 'local.txt'), 'local only');
    git('git add local.txt');
    git('git commit -q -m "local-only commit"');

    const unpushed = unpushedCommits(repo);
    assert(unpushed, 'unpushedCommits returned null');
    expect(unpushed.length).toBe(1);
    expect(unpushed[0]).toMatch(/local-only commit/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('unpushedCommits against a real repo: commits inherited from a local-only base ref do not count; a commit the worktree adds does', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-test-inherited-'));
  const repo = join(base, 'repo');
  try {
    const bareRemote = join(base, 'remote.git');
    mkdirSync(bareRemote, { recursive: true });
    execSync(`git init -q --bare "${bareRemote}"`);
    mkdirSync(repo, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git(`git remote add origin "${bareRemote}"`);
    writeFileSync(join(repo, 'README.md'), 'hello');
    git('git add README.md');
    git('git commit -q -m base-commit-X');
    const wt = join(base, 'wt');
    git(`git worktree add -q "${wt}" -b worktree-ws main`);

    expect(unpushedCommits(wt)).toEqual([]);

    writeFileSync(join(wt, 'work.txt'), 'work');
    execSync('git add work.txt', { cwd: wt });
    execSync('git commit -q -m "worktree-only commit"', { cwd: wt });
    const unpushed = unpushedCommits(wt);
    assert(unpushed, 'unpushedCommits returned null');
    expect(unpushed.length).toBe(1);
    expect(unpushed[0]).toMatch(/worktree-only commit/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('listWorktrees parses a detached-HEAD entry without dropping neighbours', () => {
  const porcelain = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo-worktrees/detached',
    'HEAD def456',
    'detached',
    '',
    'worktree /repo-worktrees/feat-x',
    'HEAD ghi789',
    'branch refs/heads/feat-x',
    '',
  ].join('\n');
  setExecutor({ run: () => porcelain, runFileQuiet: () => porcelain, spawn: () => {} });
  expect(listWorktrees('/repo')).toEqual([
    { path: '/repo', branch: 'main' },
    { path: '/repo-worktrees/detached' },
    { path: '/repo-worktrees/feat-x', branch: 'feat-x' },
  ]);
});

test('listGitignoredEntries keeps collapsed directories and does not exclude node_modules', () => {
  let capturedArgs: string[] | undefined;
  setExecutor({
    run: (cmd) => {
      throw new Error(`unexpected run: ${cmd}`);
    },
    runFile: (_file: string, args: string[]) => {
      capturedArgs = args;
      return 'node_modules/\0ios/Pods/\0ios/.xcode.env.local\0';
    },
    spawn: () => {},
  });

  expect(listGitignoredEntries('/repo')).toEqual(['node_modules', 'ios/Pods', 'ios/.xcode.env.local']);
  expect(capturedArgs).toContain('--directory');
  expect(capturedArgs).toContain('-z');
  expect(capturedArgs?.some((arg) => arg.includes('exclude,glob'))).toBe(false);
});

test('listCarryableIgnoredEntries skips a collapsed ignored parent that contains a registered worktree', () => {
  setExecutor({
    run: () => '',
    runFile: () => '.claude/\0node_modules/\0ios/Pods/\0',
    runFileQuiet: (_file: string, args: string[]) => {
      if (args.includes('worktree')) {
        return 'worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/task\nbranch refs/heads/task\n';
      }
      return '';
    },
    spawn: () => {},
  });

  expect(listCarryableIgnoredEntries('/repo', [])).toEqual(['node_modules', 'ios/Pods']);
});

test('listCarryableIgnoredEntries skips entries inside a registered nested worktree', () => {
  setExecutor({
    run: () => '',
    runFile: () => 'tools/tasks/one/node_modules/\0tools/shared-cache/\0',
    runFileQuiet: (_file: string, args: string[]) => {
      if (args.includes('worktree')) {
        return 'worktree /repo\nbranch refs/heads/main\n\nworktree /repo/tools/tasks/one\nbranch refs/heads/one\n';
      }
      return '';
    },
    spawn: () => {},
  });

  expect(listCarryableIgnoredEntries('/repo', [])).toEqual(['tools/shared-cache']);
});

test('listCarryableIgnoredEntries fails closed when Git cannot list worktrees', () => {
  setExecutor({
    run: () => '',
    runFileQuiet: (_file: string, args: string[]) => (args.includes('worktree') ? null : 'node_modules/'),
    spawn: () => {},
  });

  expect(() => listCarryableIgnoredEntries('/repo', [])).toThrow(
    'Could not list Git worktrees. Refusing to carry ignored files.',
  );
});

test('ignored inventory and warm copying still find the target file when raw ls-files output exceeds 1MB', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-bigignore-'));
  const root = join(base, 'repo');
  const target = join(base, 'target');
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(target, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');

    writeFileSync(join(root, 'README.md'), 'hello');
    writeFileSync(join(root, '.gitignore'), '*.ignoreme\n.env\n');
    git('git add README.md .gitignore');
    git('git commit -q -m init');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'copy-target', target]);

    const padding = 'x'.repeat(200);
    for (let i = 0; i < 6000; i++) {
      writeFileSync(join(root, `bloat-${i}-${padding}.ignoreme`), '');
    }

    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/.env'), 'SECRET=1');

    const rawBytes = parseInt(
      execSync(`git -C "${root}" ls-files --others --ignored --exclude-standard | wc -c`, { encoding: 'utf-8' }).trim(),
      10,
    );
    expect(rawBytes > 1024 * 1024).toBeTruthy();

    const ignored = listGitignoredEntries(root);
    expect(ignored.includes('apps')).toBeTruthy();

    const { copied, failed } = cloneIgnoredEntries({ root, target, patterns: ['bloat-*.ignoreme'] });
    expect(copied).toEqual(['apps']);
    expect(failed).toEqual([]);
    expect(existsSync(join(target, 'apps/mobile/.env'))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('removeWorktree runs git via runFile (no shell) and includes --force only when asked', () => {
  const path = '/tmp/my worktree/repo';
  const calls: string[][] = [];
  setExecutor({
    runFile: (file, args = []) => {
      calls.push([file, ...args]);
      return '';
    },
    runQuiet: () => '',
    spawn: () => {},
  });

  removeWorktree(path);
  removeWorktree(path, { force: true });

  expect(calls).toEqual([
    ['git', '-C', path, 'worktree', 'remove', '--', path],
    ['git', '-C', path, 'worktree', 'remove', '--force', '--', path],
  ]);
});

function podsFixture({
  manifest,
  podfileLock,
  dir = 'ios',
}: {
  manifest?: string | null;
  podfileLock?: string | null;
  dir?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), 'stim-pods-'));
  mkdirSync(join(root, dir, 'Pods'), { recursive: true });
  if (manifest != null) writeFileSync(join(root, dir, 'Pods', 'Manifest.lock'), manifest);
  if (podfileLock != null) writeFileSync(join(root, dir, 'Podfile.lock'), podfileLock);
  return root;
}

test('depsOutOfSync flags a carried node_modules whose source lockfile differs from the branch checkout', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-deps-'));
  const root = join(base, 'src');
  const target = join(base, 'wt');
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lock-v1');
    writeFileSync(join(target, 'pnpm-lock.yaml'), 'lock-v2');
    expect(depsOutOfSync(root, target, ['node_modules'])).toEqual([{ dir: '.', lockfile: 'pnpm-lock.yaml' }]);
    writeFileSync(join(target, 'pnpm-lock.yaml'), 'lock-v1');
    expect(depsOutOfSync(root, target, ['node_modules'])).toEqual([]);
    expect(depsOutOfSync(root, target, ['assets'])).toEqual([]);
    expect(depsOutOfSync(root, target, null)).toEqual([]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('carried Pods matching their Podfile.lock produce no warning', () => {
  const root = podsFixture({ manifest: 'PODS:\n  - fmt (11.0.2)\n', podfileLock: 'PODS:\n  - fmt (11.0.2)\n' });
  expect(podsOutOfSync(root, ['ios/Pods', 'node_modules'])).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test('carried Pods that disagree with Podfile.lock are reported', () => {
  const root = podsFixture({ manifest: 'React-Core (= 0.86.2)\n', podfileLock: 'React-Core (= 0.79.6)\n' });
  expect(podsOutOfSync(root, ['ios/Pods'])).toEqual([{ dir: 'ios', reason: 'mismatch' }]);
  rmSync(root, { recursive: true, force: true });
});

test('carried Pods with no Podfile.lock beside them are reported as missing', () => {
  const root = podsFixture({ manifest: 'React-Core (= 0.86.2)\n', podfileLock: null });
  expect(podsOutOfSync(root, ['ios/Pods'])).toEqual([{ dir: 'ios', reason: 'missing' }]);
  rmSync(root, { recursive: true, force: true });
});

test('a monorepo app directory is checked at its own path', () => {
  const root = podsFixture({ manifest: 'a\n', podfileLock: 'b\n', dir: 'apps/mobile/ios' });
  expect(podsOutOfSync(root, ['apps/mobile/ios/Pods'])).toEqual([{ dir: 'apps/mobile/ios', reason: 'mismatch' }]);
  rmSync(root, { recursive: true, force: true });
});

test('entries that are not Pods directories are ignored, including lookalikes', () => {
  const root = podsFixture({ manifest: 'a\n', podfileLock: 'b\n' });
  expect(podsOutOfSync(root, ['node_modules', 'ios/build', 'vendor/PodsHelper'])).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test('a Pods directory with no Manifest.lock is not reported', () => {
  const root = podsFixture({ manifest: null, podfileLock: 'a\n' });
  expect(podsOutOfSync(root, ['ios/Pods'])).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test('the Podfile.lock on disk decides, so reconciling it clears the mismatch', () => {
  const branchLock = 'PODS:\n  - fmt (11.0.2)\n';
  const workingLock = 'PODS:\n  - fmt (11.0.2)\n  - RNScreens (4.0.0)\n';
  const root = podsFixture({ manifest: workingLock, podfileLock: branchLock });
  try {
    expect(podsOutOfSync(root, ['ios/Pods'])).toEqual([{ dir: 'ios', reason: 'mismatch' }]);
    writeFileSync(join(root, 'ios', 'Podfile.lock'), workingLock);
    expect(podsOutOfSync(root, ['ios/Pods'])).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pod-install churn is recognised so the restore advice only fires when it works', () => {
  expect(isPodInstallChurn([' M ios/Podfile.lock', ' M ios/PatientApp.xcodeproj/project.pbxproj'])).toBe(true);
  expect(isPodInstallChurn([' M ios/Podfile.lock', ' M config.json'])).toBe(false);
  expect(isPodInstallChurn([' M App/Images/ic_app_ios.png'])).toBe(false);
  expect(isPodInstallChurn([])).toBe(false);
});

test('cloneIgnoredEntries against a real git repo never overwrites a path the destination tracks', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-tracked-clone-'));
  const root = join(base, 'repo');
  const target = join(base, 'wt');
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    mkdirSync(join(root, 'android/app'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '*.keystore\nbuild/\n');
    writeFileSync(join(root, 'android/app/App.java'), 'class App {}');
    git('git add -A');
    git('git commit -q -m "main: every keystore ignored"');

    git('git checkout -q -b feature');
    writeFileSync(join(root, '.gitignore'), '*.keystore\n!android/app/debug.keystore\nbuild/\n');
    writeFileSync(join(root, 'android/app/debug.keystore'), 'BRANCH-VERSION');
    git('git add -A');
    git('git commit -q -m "feature: track debug.keystore through a negation"');
    git('git checkout -q main');

    writeFileSync(join(root, 'android/app/debug.keystore'), 'SOURCE-MACHINE-LOCAL');
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, 'build/artifact.txt'), 'output');

    git(`git worktree add -q "${target}" feature`);
    expect(readFileSync(join(target, 'android/app/debug.keystore'), 'utf-8')).toBe('BRANCH-VERSION');

    const { copied, skipped, failed } = cloneIgnoredEntries({ root, target, patterns: [] });

    expect(failed).toEqual([]);
    expect(readFileSync(join(target, 'android/app/debug.keystore'), 'utf-8')).toBe('BRANCH-VERSION');
    expect(!copied.includes('android/app/debug.keystore')).toBeTruthy();
    expect(skipped).toEqual([{ file: 'android/app/debug.keystore', reason: 'tracked' }]);
    expect(copied).toEqual(['build']);
    expect(readFileSync(join(target, 'build/artifact.txt'), 'utf-8')).toBe('output');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('carry against a real git repo leaves a tracked file under an ignored directory alone', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-negation-'));
  const root = join(base, 'repo');
  const target = join(base, 'wt');
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    mkdirSync(join(root, 'dir/sub'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'dir/\n!dir/keep.txt\n');
    writeFileSync(join(root, 'dir/keep.txt'), 'BRANCH-VERSION');
    writeFileSync(join(root, 'dir/junk.txt'), 'junk');
    writeFileSync(join(root, 'dir/sub/deep.txt'), 'deep');
    git('git add .gitignore');
    git('git add -f dir/keep.txt');
    git('git commit -q -m init');

    git(`git worktree add -q "${target}" -b other main`);

    writeFileSync(join(root, 'dir/keep.txt'), 'SOURCE-MACHINE-LOCAL');

    const { copied, skipped, failed } = cloneIgnoredEntries({ root, target, patterns: [] });

    expect(failed).toEqual([]);
    expect(skipped).toEqual([]);
    expect(readFileSync(join(target, 'dir/keep.txt'), 'utf-8')).toBe('BRANCH-VERSION');
    expect(copied.toSorted()).toEqual(['dir/junk.txt', 'dir/sub']);
    expect(readFileSync(join(target, 'dir/junk.txt'), 'utf-8')).toBe('junk');
    expect(readFileSync(join(target, 'dir/sub/deep.txt'), 'utf-8')).toBe('deep');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('listTrackedPaths asks git for a NUL-delimited list and reports an unanswerable query as null', () => {
  let capturedArgs: string[] | undefined;
  setExecutor({
    run: (cmd) => {
      throw new Error(`unexpected run: ${cmd}`);
    },
    runFileQuiet: (_file: string, args: string[]) => {
      capturedArgs = args;
      return 'ios/Podfile.lock\0android/app/debug.keystore\0';
    },
    spawn: () => {},
  });
  expect(listTrackedPaths('/wt')).toEqual(['ios/Podfile.lock', 'android/app/debug.keystore']);
  expect(capturedArgs).toContain('ls-files');
  expect(capturedArgs).toContain('-z');

  setExecutor({ run: () => '', runFileQuiet: () => null, spawn: () => {} });
  expect(listTrackedPaths('/wt')).toBe(null);
});

test('H1: cloneIgnoredEntries carries a top-level ignored $(...) filename as a literal file, never executing it', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-test-sec-clone-'));
  const root = join(base, 'repo');
  const target = join(base, 'target');
  const cwdBefore = process.cwd();
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(target, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    writeFileSync(join(root, 'README.md'), 'hi');
    writeFileSync(join(root, '.gitignore'), '*.log\n');
    git('git add README.md .gitignore');
    git('git commit -q -m init');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'copy-target', target]);

    const evil = 'a$(touch INJECTED).log';
    writeFileSync(join(root, evil), 'payload');

    process.chdir(base);
    const { copied, failed } = cloneIgnoredEntries({ root, target, patterns: [] });

    expect(existsSync(join(base, 'INJECTED'))).toBe(false);
    expect(failed).toEqual([]);
    expect(copied.includes(evil)).toBeTruthy();
    expect(existsSync(join(target, evil))).toBe(true);
    expect(readFileSync(join(target, evil), 'utf-8')).toBe('payload');
  } finally {
    process.chdir(cwdBefore);
    rmSync(base, { recursive: true, force: true });
  }
});

test('isCarrySkipped skips .DerivedData at any depth and treats .stim normally', () => {
  for (const rel of [
    '.DerivedData',
    'ios/build/.DerivedData',
    'node_modules/expo-modules-jsi/apple/.DerivedData',
    'node_modules/pkg/apple/.DerivedData/ModuleCache.noindex/foo.pcm',
  ]) {
    expect(isCarrySkipped(rel)).toBe(true);
  }
  for (const rel of [
    'node_modules',
    'ios/Pods',
    '.stim',
    'apps/mobile/.stim',
    'apps/mobile/.stimtope',
    'MyDerivedData',
    'apple/MyDerivedData/x',
    '.DerivedDataThing',
    'apple/DerivedDataFoo',
    'apple/.DerivedDataX',
  ]) {
    expect(isCarrySkipped(rel)).toBe(false);
  }
});

test('cloneIgnoredEntries against a real git repo drops a nested .DerivedData but keeps its sibling', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-derived-'));
  const root = join(base, 'repo');
  const target = join(base, 'target');
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(target, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    writeFileSync(join(root, 'README.md'), 'hello');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    git('git add README.md .gitignore');
    git('git commit -q -m init');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'copy-target', target]);

    mkdirSync(join(root, 'node_modules/pkg/apple/.DerivedData'), { recursive: true });
    writeFileSync(join(root, 'node_modules/pkg/apple/.DerivedData/x'), 'baked');
    writeFileSync(join(root, 'node_modules/pkg/apple/Real.swift'), 'import Foundation');

    const { copied, failed } = cloneIgnoredEntries({ root, target, patterns: [] });

    expect(copied).toEqual(['node_modules']);
    expect(failed).toEqual([]);
    expect(existsSync(join(target, 'node_modules/pkg/apple/Real.swift'))).toBe(true);
    expect(existsSync(join(target, 'node_modules/pkg/apple/.DerivedData'))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('dirtyFingerprintFiles asks git about exactly the fingerprint inputs and parses the paths', () => {
  const calls: string[][] = [];
  setExecutor({
    runFileQuiet: (_file: string, args: string[]) => {
      calls.push(args);
      return 'M app.json\nM  package.json';
    },
    spawn: () => {},
  });
  expect(dirtyFingerprintFiles('/p')).toEqual(['app.json', 'package.json']);
  expect(calls[0]).toEqual([
    '-C',
    '/p',
    'status',
    '--porcelain',
    '--',
    'app.json',
    'app.config.ts',
    'app.config.js',
    'app.config.mjs',
    'package.json',
  ]);
});

test('dirtyFingerprintFiles is empty on a clean tree and when git cannot answer', () => {
  setExecutor({ runFileQuiet: () => '', spawn: () => {} });
  expect(dirtyFingerprintFiles('/p')).toEqual([]);
  setExecutor({ runFileQuiet: () => null, spawn: () => {} });
  expect(dirtyFingerprintFiles('/p')).toEqual([]);
});

test('git runs against a real repo whose path holds a space, a double quote, a dollar sign and a backtick', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-test-hostile-'));
  const root = join(base, 'we "ird $HOME `id` repo');
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    writeFileSync(join(root, '.gitignore'), 'secrets.env\n');
    writeFileSync(join(root, 'tracked.txt'), 'original\n');
    writeFileSync(join(root, 'secrets.env'), 'SECRET=1\n');
    git('git add .gitignore tracked.txt');
    git('git commit -q -m init');

    expect(repoRoot(root)).toBe(realpathSync(root));
    expect(gitCommonDir(root)).toBe(join(realpathSync(root), '.git'));
    expect(isMainWorkingTree(root)).toBe(true);
    expect(hasUncommittedWork(root)).toBe(false);
    expect(branchExists(root, 'main')).toBe(true);
    expect(branchExists(root, 'missing')).toBe(false);
    expect(hasRemote(root)).toBe(false);
    expect(listTrackedPaths(root)).toEqual(['.gitignore', 'tracked.txt']);
    expect(listGitignoredEntries(root)).toEqual(['secrets.env']);
    expect(listWorktrees(root)).toEqual([{ path: realpathSync(root), branch: 'main' }]);
    expect(unpushedCommits(root)?.length).toBe(1);

    writeFileSync(join(root, 'tracked.txt'), 'dirty\n');
    expect(hasUncommittedWork(root)).toBe(true);
    expect(dirtyPaths(root)).toEqual([' M tracked.txt']);
    expect(restoreFile(root, 'tracked.txt')).toBe(true);
    expect(readFileSync(join(root, 'tracked.txt'), 'utf-8')).toBe('original\n');
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('detached worktrees preserve unique commits but do not count commits already on a local branch', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-detached-'));
  const root = join(base, 'repo');
  const target = join(base, 'detached');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  try {
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'test');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'tracked.txt'), 'shared commit');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'shared main commit');
    git(root, 'worktree', 'add', '--detach', target);
    expect(unpushedCommits(target)).toEqual([]);
    writeFileSync(join(target, 'unique.txt'), 'detached work');
    git(target, 'add', '.');
    git(target, 'commit', '-qm', 'unique detached commit');
    const unique = unpushedCommits(target);
    expect(unique).toHaveLength(1);
    expect(unique?.[0]).toContain('unique detached commit');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unproven detached HEAD keeps the conservative remotes-only comparison', () => {
  const calls: string[][] = [];
  setExecutor({
    runFileQuiet: (_file: string, args: string[]) => {
      calls.push(args);
      if (args.includes('log')) return 'abc123 local work';
      return null;
    },
  });
  expect(unpushedCommits('/wt')).toEqual(['abc123 local work']);
  expect(calls.find((args) => args.includes('log'))?.slice(-2)).toEqual(['--not', '--remotes']);
});
