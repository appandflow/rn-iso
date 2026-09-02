import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import {
  defaultWorktreeDir,
  worktreePath,
  matchesInclude,
  isCarrySkipped,
  unpushedCommits,
  hasUncommittedWork,
  listWorktrees,
  carryOverFiles,
  carryUncommittedChanges,
  cloneIgnoredEntries,
  dirtyFingerprintFiles,
  podsOutOfSync,
  depsOutOfSync,
  isPodInstallChurn,
  listGitignoredEntries,
  listGitignoredFiles,
  listCarryableIgnoredEntries,
  listTrackedPaths,
  addWorktree,
  removeWorktree,
  resolveBaseRef,
  resolveRef,
} from '../worktree.ts';

afterEach(() => resetExecutor());

test('default worktree dir is a sibling of the repo', () => {
  expect(defaultWorktreeDir('/Volumes/ExternalSSD/Developer/tlon-apps')).toBe(
    '/Volumes/ExternalSSD/Developer/tlon-apps-worktrees',
  );
});

test('worktreePath joins the dir and the name', () => {
  expect(worktreePath({ worktreeDir: '/wt', name: 'feat-x' })).toBe('/wt/feat-x');
});

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
  setExecutor({ run: () => ' M file.js', runQuiet: () => ' M file.js', spawn: () => {} });
  expect(hasUncommittedWork('/wt')).toBe(true);
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  expect(hasUncommittedWork('/wt')).toBe(false);
});

test('unpushedCommits lists commits missing from every remote and every other local branch', () => {
  setExecutor({
    runQuiet: (cmd: string) => (/symbolic-ref/.test(cmd) ? 'worktree-ws' : 'abc123 first\ndef456 second'),
    spawn: () => {},
  });
  expect(unpushedCommits('/wt')).toEqual(['abc123 first', 'def456 second']);
});

test('unpushedCommits returns empty when git reports nothing', () => {
  setExecutor({ runQuiet: (cmd: string) => (/symbolic-ref/.test(cmd) ? 'worktree-ws' : ''), spawn: () => {} });
  expect(unpushedCommits('/wt')).toEqual([]);
});

test('unpushedCommits excludes only the worktree own branch from the local-branch protection', () => {
  const calls: string[] = [];
  setExecutor({
    runQuiet: (cmd: string) => {
      calls.push(cmd);
      if (/symbolic-ref/.test(cmd)) return 'worktree-ws';
      if (/ log /.test(cmd)) return 'abc123 own-work';
      return null;
    },
    spawn: () => {},
  });
  expect(unpushedCommits('/wt')).toEqual(['abc123 own-work']);
  const log = calls.find((c) => / log /.test(c));
  expect(log).toContain('log --oneline HEAD --not --remotes --exclude="worktree-ws" --branches');
});

test('unpushedCommits falls back to the remotes-only count on a detached HEAD or an unsafe branch name', () => {
  for (const branch of [null, 'evil"; touch PWNED; "']) {
    const calls: string[] = [];
    setExecutor({
      runQuiet: (cmd: string) => {
        calls.push(cmd);
        if (/symbolic-ref/.test(cmd)) return branch;
        if (/ log /.test(cmd)) return '';
        return null;
      },
      spawn: () => {},
    });
    expect(unpushedCommits('/wt')).toEqual([]);
    const log = calls.find((c) => / log /.test(c));
    expect(log).toMatch(/--not --remotes$/);
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

test('resolveBaseRef("head") returns HEAD and never touches origin/HEAD', () => {
  const calls: string[] = [];
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => {
      calls.push(cmd);
      return '';
    },
    spawn: () => {},
  });
  expect(resolveBaseRef('/repo', 'head')).toBe('HEAD');
  expect(calls).toEqual([]);
});

test('resolveBaseRef("fresh") returns origin/HEAD\'s branch when it resolves, no warning', () => {
  setExecutor({ run: () => '', runQuiet: () => 'origin/main', spawn: () => {} });
  const errs: string[] = [];
  const originalError = console.error;
  console.error = (msg) => errs.push(msg);
  try {
    expect(resolveBaseRef('/repo', 'fresh')).toBe('origin/main');
  } finally {
    console.error = originalError;
  }
  expect(errs).toEqual([]);
});

test('resolveBaseRef("fresh") falls back to HEAD and warns on stderr when origin/HEAD is missing', () => {
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  const errs: string[] = [];
  const originalError = console.error;
  console.error = (msg) => errs.push(msg);
  try {
    expect(resolveBaseRef('/repo', 'fresh')).toBe('HEAD');
  } finally {
    console.error = originalError;
  }
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/origin\/HEAD/);
  expect(errs[0]).toMatch(/HEAD/);
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
  setExecutor({ run: () => porcelain, runQuiet: () => porcelain, spawn: () => {} });
  expect(listWorktrees('/repo')).toEqual([
    { path: '/repo', branch: 'main' },
    { path: '/repo-worktrees/detached' },
    { path: '/repo-worktrees/feat-x', branch: 'feat-x' },
  ]);
});

test('carryOverFiles copies only files that are both gitignored and pattern-matched (mocked)', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'stim-test-target-'));
  try {
    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/.env'), 'SECRET=1');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/build.log'), 'log output');

    let capturedCmd;
    setExecutor({
      run: (cmd) => {
        throw new Error(`unexpected run: ${cmd}`);
      },
      runQuiet: (cmd) => {
        if (cmd.includes('ls-files -z')) return '';
        capturedCmd = cmd;
        return 'apps/mobile/.env\ndist/build.log';
      },
      spawn: () => {},
    });

    const { copied, failed } = carryOverFiles({ root, target, patterns: ['.env'] });

    expect(copied).toEqual(['apps/mobile/.env']);
    expect(failed).toEqual([]);
    expect(existsSync(join(target, 'apps/mobile/.env'))).toBe(true);
    expect(readFileSync(join(target, 'apps/mobile/.env'), 'utf-8')).toBe('SECRET=1');
    expect(existsSync(join(target, 'dist/build.log'))).toBe(false);
    expect(capturedCmd).toMatch(/--others/);
    expect(capturedCmd).toMatch(/--ignored/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('carryOverFiles reports per-file failures instead of swallowing them', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'stim-test-target-'));
  try {
    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/.env'), 'SECRET=1');
    setExecutor({
      run: (cmd) => {
        throw new Error(`unexpected run: ${cmd}`);
      },
      runQuiet: (cmd) => (cmd.includes('ls-files -z') ? '' : 'apps/mobile/.env\napps/missing/.env'),
      spawn: () => {},
    });

    const { copied, failed } = carryOverFiles({ root, target, patterns: ['.env'] });

    expect(copied).toEqual(['apps/mobile/.env']);
    expect(failed.length).toBe(1);
    expect(failed[0]?.file).toBe('apps/missing/.env');
    expect(failed[0]?.error).toMatch(/ENOENT|no such file/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('listGitignoredEntries keeps collapsed directories and does not exclude node_modules', () => {
  let capturedCmd;
  setExecutor({
    run: (cmd) => {
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet: (cmd) => {
      capturedCmd = cmd;
      return 'node_modules/\nios/Pods/\nios/.xcode.env.local';
    },
    spawn: () => {},
  });

  expect(listGitignoredEntries('/repo')).toEqual(['node_modules', 'ios/Pods', 'ios/.xcode.env.local']);
  expect(capturedCmd).toMatch(/--directory/);
  expect(capturedCmd).not.toMatch(/exclude,glob/);
});

test('listCarryableIgnoredEntries skips a collapsed ignored parent that contains a registered worktree', () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => {
      if (cmd.includes('worktree list --porcelain')) {
        return 'worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/task\nbranch refs/heads/task\n';
      }
      if (cmd.includes('ls-files --others --ignored')) return '.claude/\nnode_modules/\nios/Pods/';
      return '';
    },
    spawn: () => {},
  });

  expect(listCarryableIgnoredEntries('/repo', [])).toEqual(['node_modules', 'ios/Pods']);
});

test('listCarryableIgnoredEntries skips entries inside a registered nested worktree', () => {
  setExecutor({
    run: () => '',
    runQuiet: (cmd) => {
      if (cmd.includes('worktree list --porcelain')) {
        return 'worktree /repo\nbranch refs/heads/main\n\nworktree /repo/tools/tasks/one\nbranch refs/heads/one\n';
      }
      if (cmd.includes('ls-files --others --ignored')) {
        return 'tools/tasks/one/node_modules/\ntools/shared-cache/\n';
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
    runQuiet: (cmd) => (cmd.includes('worktree list --porcelain') ? null : 'node_modules/'),
    spawn: () => {},
  });

  expect(() => listCarryableIgnoredEntries('/repo', [])).toThrow(
    'Could not list Git worktrees. Refusing to carry ignored files.',
  );
});

test('cloneIgnoredEntries does not copy a registered worktree nested under an ignored parent', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-nested-worktree-'));
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
    writeFileSync(join(root, '.gitignore'), '.claude/\nnode_modules/\n');
    git('git add README.md .gitignore');
    git('git commit -q -m init');
    git('git worktree add -q -b nested-task .claude/worktrees/task');
    mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules/pkg/index.js'), 'module.exports = true');

    const { copied, failed } = cloneIgnoredEntries({ root, target, patterns: [] });

    expect(copied).toEqual(['node_modules']);
    expect(failed).toEqual([]);
    expect(existsSync(join(target, 'node_modules/pkg/index.js'))).toBe(true);
    expect(existsSync(join(target, '.claude'))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('cloneIgnoredEntries skips excluded paths and reports a clone that fell back to a real copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'stim-test-target-'));
  try {
    const fileCalls: [string, string[]][] = [];
    setExecutor({
      run: (cmd) => {
        throw new Error(`unexpected shell run: ${cmd}`);
      },
      runFile: (file, args) => {
        fileCalls.push([file, args]);
        if (file === 'cp' && args[0] === '-Rc') throw new Error('clonefile refused');
        return '';
      },
      runQuiet: (cmd) => {
        if (cmd.includes('ls-files -z')) return '';
        if (cmd.startsWith('git ')) return 'node_modules/\nbench/results/logs/';
        return '';
      },
      spawn: () => {},
    });

    const { copied, failed, cloned } = cloneIgnoredEntries({
      root,
      target,
      patterns: ['bench/results/logs'],
    });

    expect(copied).toEqual(['node_modules']);
    expect(failed).toEqual([]);
    expect(cloned).toBe(false);
    expect(fileCalls.some(([f, a]) => f === 'cp' && a[0] === '-Rc')).toBeTruthy();
    expect(fileCalls.some(([f, a]) => f === 'cp' && a[0] === '-R')).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('carryOverFiles against a real git repo copies only the gitignored+matched file', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-realgit-'));
  const root = join(base, 'repo');
  const target = join(base, 'target');
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(target, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');

    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config/secrets.json'), '{"tracked": true}');
    writeFileSync(join(root, 'README.md'), 'hello');
    writeFileSync(join(root, '.gitignore'), '.env\ndist/\n');
    git('git add README.md config/secrets.json .gitignore');
    git('git commit -q -m init');

    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/.env'), 'SECRET=1');

    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/build.log'), 'log output');

    const { copied, failed } = carryOverFiles({ root, target, patterns: ['.env', 'secrets.json'] });

    expect(copied).toEqual(['apps/mobile/.env']);
    expect(failed).toEqual([]);
    expect(existsSync(join(target, 'apps/mobile/.env'))).toBe(true);
    expect(readFileSync(join(target, 'apps/mobile/.env'), 'utf-8')).toBe('SECRET=1');
    expect(existsSync(join(target, 'dist/build.log'))).toBe(false);
    expect(existsSync(join(target, 'config/secrets.json'))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('listGitignoredFiles and carryOverFiles still find the target file when raw ls-files output exceeds 1MB', () => {
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

    const ignored = listGitignoredFiles(root);
    expect(ignored.includes('apps/mobile/.env')).toBeTruthy();

    const { copied, failed } = carryOverFiles({ root, target, patterns: ['.env'] });
    expect(copied).toEqual(['apps/mobile/.env']);
    expect(failed).toEqual([]);
    expect(existsSync(join(target, 'apps/mobile/.env'))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('addWorktree runs git via runFile (no shell) with a `--` terminator, path as one argv element', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stim-test-add-'));
  try {
    const path = join(tmp, 'my worktree', 'repo');
    const calls: [string, string[]][] = [];
    setExecutor({
      run: (cmd) => {
        throw new Error(`unexpected shell run: ${cmd}`);
      },
      runFile: (file, args) => {
        calls.push([file, args]);
        return '';
      },
      runQuiet: () => '',
      spawn: () => {},
    });

    const result = addWorktree({ path, branch: 'feat-x', baseRef: 'origin/main', createBranch: true });

    expect(result).toBe(path);
    expect(calls).toEqual([['git', ['worktree', 'add', '-b', 'feat-x', '--', path, 'origin/main']]]);
    expect(existsSync(dirname(path))).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('addWorktree runs the form the caller chose and never re-decides for itself', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stim-test-add-reuse-'));
  try {
    const path = join(tmp, 'repo2');
    const calls: [string, string[]][] = [];
    setExecutor({
      run: (cmd) => {
        throw new Error(`unexpected shell run: ${cmd}`);
      },
      runFile: (file, args) => {
        calls.push([file, args]);
        return '';
      },
      runQuiet: (cmd) => {
        throw new Error(`addWorktree must not re-resolve anything: ${cmd}`);
      },
      spawn: () => {},
    });

    const result = addWorktree({ path, branch: 'worktree-fix-login', baseRef: 'origin/main', createBranch: false });

    expect(result).toBe(path);
    expect(calls).toEqual([['git', ['worktree', 'add', '--', path, 'worktree-fix-login']]]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('addWorktree uses -b when the caller says the branch is new, whatever the refs say now', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stim-test-add-fresh-'));
  try {
    const path = join(tmp, 'repo3');
    const calls: [string, string[]][] = [];
    setExecutor({
      run: (cmd) => {
        throw new Error(`unexpected shell run: ${cmd}`);
      },
      runFile: (file, args) => {
        calls.push([file, args]);
        return '';
      },
      runQuiet: () => 'deadbeef',
      spawn: () => {},
    });

    addWorktree({ path, branch: 'worktree-new-thing', baseRef: 'origin/main', createBranch: true });

    expect(calls).toEqual([['git', ['worktree', 'add', '-b', 'worktree-new-thing', '--', path, 'origin/main']]]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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

test('the Podfile.lock on disk decides, so a carried lockfile change clears the mismatch', () => {
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

test('cloneIgnoredEntries treats .stim like any other gitignored project directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'stim-test-target-'));
  try {
    setExecutor({
      run: () => '',
      runFile: () => '',
      runQuiet: (cmd) => {
        if (cmd.includes('ls-files -z')) return '';
        if (cmd.startsWith('git ')) return 'node_modules/\n.stim/\napps/mobile/.stim/\napps/mobile/ios/Pods/';
        return '';
      },
      spawn: () => {},
    });

    const { copied } = cloneIgnoredEntries({ root, target, patterns: [] });

    expect(copied).toEqual(['node_modules', '.stim', 'apps/mobile/.stim', 'apps/mobile/ios/Pods']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('.worktreeexclude can skip a project-owned .stim directory normally', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'stim-test-target-'));
  try {
    setExecutor({
      run: () => '',
      runFile: () => '',
      runQuiet: (cmd) => {
        if (cmd.includes('ls-files -z')) return '';
        if (cmd.startsWith('git ')) return 'node_modules/\ncoverage/\napps/mobile/.stim/';
        return '';
      },
      spawn: () => {},
    });

    const excluded = cloneIgnoredEntries({ root, target, patterns: ['coverage', '**/.stim'] });
    expect(excluded.copied).toEqual(['node_modules']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('carryOverFiles treats files inside .stim like ordinary project files', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'stim-test-target-'));
  try {
    mkdirSync(join(root, 'apps/mobile/.stim'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/.stim/state.json'), '{"supervisorPid":123}');
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config/local.json'), '{}');
    setExecutor({
      run: () => '',
      runQuiet: (cmd) => (cmd.includes('ls-files -z') ? '' : 'apps/mobile/.stim/state.json\nconfig/local.json'),
      spawn: () => {},
    });

    const { copied } = carryOverFiles({ root, target, patterns: ['**/*.json'] });

    expect(copied).toEqual(['apps/mobile/.stim/state.json', 'config/local.json']);
    expect(existsSync(join(target, 'apps/mobile/.stim/state.json'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
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

test('carryOverFiles against a real git repo never overwrites a path the destination tracks', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-tracked-carry-'));
  const root = join(base, 'repo');
  const target = join(base, 'wt');
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '*.keystore\n.env\n');
    writeFileSync(join(root, 'README.md'), 'hello');
    git('git add -A');
    git('git commit -q -m "main: every keystore ignored"');

    git('git checkout -q -b feature');
    writeFileSync(join(root, '.gitignore'), '*.keystore\n!apps/mobile/debug.keystore\n.env\n');
    writeFileSync(join(root, 'apps/mobile/debug.keystore'), 'BRANCH-VERSION');
    git('git add -A');
    git('git commit -q -m "feature: track debug.keystore"');
    git('git checkout -q main');

    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/debug.keystore'), 'SOURCE-MACHINE-LOCAL');
    writeFileSync(join(root, 'apps/mobile/.env'), 'SECRET=1');

    git(`git worktree add -q "${target}" feature`);

    const { copied, skipped } = carryOverFiles({ root, target, patterns: ['*.keystore', '.env'] });

    expect(copied).toEqual(['apps/mobile/.env']);
    expect(skipped).toEqual([{ file: 'apps/mobile/debug.keystore', reason: 'tracked' }]);
    expect(readFileSync(join(target, 'apps/mobile/debug.keystore'), 'utf-8')).toBe('BRANCH-VERSION');
    expect(readFileSync(join(target, 'apps/mobile/.env'), 'utf-8')).toBe('SECRET=1');
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

    const carried = carryOverFiles({ root, target, patterns: ['keep.txt', 'junk.txt'] });
    expect(carried.copied).toEqual(['dir/junk.txt']);
    expect(readFileSync(join(target, 'dir/keep.txt'), 'utf-8')).toBe('BRANCH-VERSION');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('listTrackedPaths asks git for a NUL-delimited list and reports an unanswerable query as null', () => {
  let capturedCmd;
  setExecutor({
    run: (cmd) => {
      throw new Error(`unexpected run: ${cmd}`);
    },
    runQuiet: (cmd) => {
      capturedCmd = cmd;
      return 'ios/Podfile.lock\0android/app/debug.keystore\0';
    },
    spawn: () => {},
  });
  expect(listTrackedPaths('/wt')).toEqual(['ios/Podfile.lock', 'android/app/debug.keystore']);
  expect(capturedCmd).toMatch(/ls-files/);
  expect(capturedCmd).toMatch(/-z/);

  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  expect(listTrackedPaths('/wt')).toBe(null);
});

test('carry fails closed when the destination cannot be asked what it tracks', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'stim-test-target-'));
  try {
    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/.env'), 'SOURCE');
    writeFileSync(join(root, 'apps/mobile/other.env'), 'SOURCE');
    mkdirSync(join(target, 'apps/mobile'), { recursive: true });
    writeFileSync(join(target, 'apps/mobile/.env'), 'ALREADY-THERE');

    setExecutor({
      run: () => '',
      runQuiet: (cmd) => {
        if (cmd.includes('ls-files -z')) return null;
        return 'apps/mobile/.env\napps/mobile/other.env';
      },
      spawn: () => {},
    });

    const { copied, skipped } = carryOverFiles({ root, target, patterns: ['*.env', '.env'] });

    expect(copied).toEqual(['apps/mobile/other.env']);
    expect(skipped).toEqual([{ file: 'apps/mobile/.env', reason: 'unverified' }]);
    expect(readFileSync(join(target, 'apps/mobile/.env'), 'utf-8')).toBe('ALREADY-THERE');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('C1: resolveRef never lets a $(...) baseRef reach a shell, and still resolves a real ref', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-test-sec-resolveref-'));
  const root = join(base, 'repo');
  const cwdBefore = process.cwd();
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git('git commit -q --allow-empty -m init');
    const realHead = git('git rev-parse --short HEAD').trim();

    process.chdir(base);
    expect(resolveRef(root, '$(touch PWNED)')).toBe(null);
    expect(existsSync(join(base, 'PWNED'))).toBe(false);

    expect(resolveRef(root, 'HEAD')).toBe(realHead);
    expect(resolveRef(root, 'main')).toBe(realHead);
    expect(resolveRef(root, '-oops')).toBe(null);
  } finally {
    process.chdir(cwdBefore);
    rmSync(base, { recursive: true, force: true });
  }
});

test('C1: addWorktree never lets a $(...) baseRef reach a shell, and still creates a worktree', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-test-sec-addwt-'));
  const root = join(base, 'repo');
  const cwdBefore = process.cwd();
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git('git commit -q --allow-empty -m init');

    process.chdir(root);
    expect(() =>
      addWorktree({
        path: join(base, 'wt-evil'),
        branch: 'worktree-evil',
        baseRef: '$(touch PWNED2)',
        createBranch: true,
      }),
    ).toThrow(/invalid reference/);
    expect(existsSync(join(root, 'PWNED2'))).toBe(false);

    const wt = join(base, 'wt-good');
    addWorktree({ path: wt, branch: 'worktree-good', baseRef: 'HEAD', createBranch: true });
    expect(existsSync(join(wt, '.git'))).toBe(true);
    expect(git('git worktree list --porcelain')).toMatch(/worktree-good/);
  } finally {
    process.chdir(cwdBefore);
    rmSync(base, { recursive: true, force: true });
  }
});

test('C1: addWorktree rejects a leading-dash baseRef with a clear error (defense in depth)', () => {
  const path = join(tmpdir(), 'stim-test-sec-dash', 'repo');
  setExecutor({
    run: (cmd) => {
      throw new Error(`unexpected shell run: ${cmd}`);
    },
    runFile: (file, args) => {
      throw new Error(`git must not be invoked: ${file} ${args.join(' ')}`);
    },
    runQuiet: () => null,
    spawn: () => {},
  });
  expect(() =>
    addWorktree({ path, branch: 'worktree-x', baseRef: '--upload-pack=touch EVIL', createBranch: true }),
  ).toThrow(/Refusing base ref/);
});

test('C1: addWorktree rejects a worktree path with a leading dash or shell metacharacters', () => {
  setExecutor({
    run: (cmd) => {
      throw new Error(`unexpected shell run: ${cmd}`);
    },
    runFile: (file, args) => {
      throw new Error(`git must not be invoked: ${file} ${args.join(' ')}`);
    },
    runQuiet: () => null,
    spawn: () => {},
  });
  expect(() => addWorktree({ path: '-evil/repo', branch: 'worktree-x', baseRef: 'HEAD', createBranch: true })).toThrow(
    /a path beginning with "-"/,
  );
  expect(() =>
    addWorktree({ path: '/tmp/a$(touch X)/repo', branch: 'worktree-x', baseRef: 'HEAD', createBranch: true }),
  ).toThrow(/shell metacharacters/);
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

test('carryOverFiles against a real git repo skips a .DerivedData file but copies its sibling', () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-derived-files-'));
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
    writeFileSync(join(root, '.gitignore'), '*.derived\n');
    git('git add README.md .gitignore');
    git('git commit -q -m init');

    mkdirSync(join(root, 'apple/.DerivedData'), { recursive: true });
    writeFileSync(join(root, 'apple/.DerivedData/cache.derived'), 'baked');
    writeFileSync(join(root, 'apple/.DerivedData/.keep'), '');
    writeFileSync(join(root, 'apple/Real.derived'), 'source');
    writeFileSync(join(root, 'apple/.keep'), '');

    const { copied, failed } = carryOverFiles({ root, target, patterns: ['*.derived'] });

    expect(copied).toEqual(['apple/Real.derived']);
    expect(failed).toEqual([]);
    expect(existsSync(join(target, 'apple/Real.derived'))).toBe(true);
    expect(existsSync(join(target, 'apple/.DerivedData/cache.derived'))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const TEXT_PATCH = [
  'diff --git a/app.json b/app.json',
  'index 000000..111111 100644',
  '--- a/app.json',
  '+++ b/app.json',
  '@@ -1 +1 @@',
  '-{}',
  '+{"dirty":true}',
].join('\n');

test('carryUncommittedChanges does nothing on a clean source tree, and when git cannot answer', () => {
  setExecutor({
    runQuiet: () => '',
    runFile: () => {
      throw new Error('nothing may be applied for an empty diff');
    },
    spawn: () => {},
  });
  expect(carryUncommittedChanges({ root: '/src', target: '/wt' })).toBe(null);

  setExecutor({ runQuiet: () => null, spawn: () => {} });
  expect(carryUncommittedChanges({ root: '/src', target: '/wt' })).toBe(null);
});

test('carryUncommittedChanges checks first, applies second, through one temp patch file it removes', () => {
  const runFileCalls: string[][] = [];
  setExecutor({
    runQuiet: (cmd: string) => (/--binary/.test(cmd) ? TEXT_PATCH : /--name-only/.test(cmd) ? 'app.json' : ''),
    runFile: (file: string, args: string[]) => {
      runFileCalls.push([file, ...args]);
      return '';
    },
    spawn: () => {},
  });

  const result = carryUncommittedChanges({ root: '/src', target: '/wt' });
  assert(result);
  expect(result.applied).toBe(true);
  expect(result.conflicted).toBe(false);
  expect(result.files).toEqual(['app.json']);

  expect(runFileCalls.length).toBe(2);
  expect(runFileCalls[0]?.slice(0, 5)).toEqual(['git', '-C', '/wt', 'apply', '--check']);
  expect(runFileCalls[1]?.slice(0, 4)).toEqual(['git', '-C', '/wt', 'apply']);
  const checkedFile = runFileCalls[0]?.[5];
  expect(runFileCalls[1]?.[4]).toBe(checkedFile);
  expect(existsSync(String(checkedFile))).toBe(false);
});

test('carryUncommittedChanges reports a conflict and applies NOTHING when --check refuses', () => {
  const runFileCalls: string[][] = [];
  setExecutor({
    runQuiet: (cmd: string) =>
      /--binary/.test(cmd) ? TEXT_PATCH : /--name-only/.test(cmd) ? 'app.json\nios/Podfile.lock' : '',
    runFile: (file: string, args: string[]) => {
      runFileCalls.push([file, ...args]);
      if (args.includes('--check')) throw new Error('error: patch does not apply');
      throw new Error('apply must not run after a failed check');
    },
    spawn: () => {},
  });

  const result = carryUncommittedChanges({ root: '/src', target: '/wt' });
  assert(result);
  expect(result.conflicted).toBe(true);
  expect(result.applied).toBe(false);
  expect(result.files).toEqual(['app.json', 'ios/Podfile.lock']);
  expect(runFileCalls.length).toBe(1);
});

test('a check that passes but an apply that fails is reported as the conflict case, not as carried', () => {
  setExecutor({
    runQuiet: (cmd: string) => (/--binary/.test(cmd) ? TEXT_PATCH : /--name-only/.test(cmd) ? 'app.json' : ''),
    runFile: (_file: string, args: string[]) => {
      if (args.includes('--check')) return '';
      throw new Error('error: app.json: No such file or directory');
    },
    spawn: () => {},
  });
  const result = carryUncommittedChanges({ root: '/src', target: '/wt' });
  assert(result);
  expect(result.applied).toBe(false);
  expect(result.conflicted).toBe(true);
});

test('dirtyFingerprintFiles asks git about exactly the fingerprint inputs and parses the paths', () => {
  const cmds: string[] = [];
  setExecutor({
    runQuiet: (cmd: string) => {
      cmds.push(cmd);
      return 'M app.json\nM  package.json';
    },
    spawn: () => {},
  });
  expect(dirtyFingerprintFiles('/p')).toEqual(['app.json', 'package.json']);
  expect(cmds[0]).toContain('status --porcelain -- app.json app.config.ts app.config.js app.config.mjs package.json');
});

test('dirtyFingerprintFiles is empty on a clean tree and when git cannot answer', () => {
  setExecutor({ runQuiet: () => '', spawn: () => {} });
  expect(dirtyFingerprintFiles('/p')).toEqual([]);
  setExecutor({ runQuiet: () => null, spawn: () => {} });
  expect(dirtyFingerprintFiles('/p')).toEqual([]);
});
