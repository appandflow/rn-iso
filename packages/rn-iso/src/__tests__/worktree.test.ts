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
  isWorkspaceArtifact,
  isCarrySkipped,
  unpushedCommits,
  hasUncommittedWork,
  listWorktrees,
  carryOverFiles,
  cloneIgnoredEntries,
  podsOutOfSync,
  isPodInstallChurn,
  listGitignoredEntries,
  listGitignoredFiles,
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

test('unpushedCommits lists commits missing from every remote', () => {
  setExecutor({
    run: () => 'abc123 first\ndef456 second',
    runQuiet: () => 'abc123 first\ndef456 second',
    spawn: () => {},
  });
  expect(unpushedCommits('/wt')).toEqual(['abc123 first', 'def456 second']);
});

test('unpushedCommits returns empty when git reports nothing', () => {
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  expect(unpushedCommits('/wt')).toEqual([]);
});

// A mocked test cannot protect this: the naive command form (`git log
// --oneline --not --remotes`, no explicit HEAD) silently returns empty
// output even when unpushed commits exist, once any revision argument is
// present git stops defaulting to HEAD on its own. Only a real git process
// against a real repo + real remote catches that. Drives the real executor
// (resetExecutor) over a scratch repo with a bare "remote" on disk.
test('unpushedCommits against a real repo: empty right after push, reports a commit made only locally', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-unpushed-'));
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

// Silent before this task: a repo with no `origin` remote (or one where
// `origin/HEAD` was never set) made every "fresh" worktree branch from
// local HEAD with no indication anything had fallen back.
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
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'rn-iso-test-target-'));
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
        // The carry asks the DESTINATION what it tracks before it copies
        // anything; this fixture target is an empty directory, so: nothing.
        if (cmd.includes('ls-files -z')) return '';
        capturedCmd = cmd;
        // Simulates the real `git ls-files --others --ignored` output: only
        // untracked, gitignored files ever appear here. A tracked file
        // cannot be in this list no matter what patterns say.
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
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'rn-iso-test-target-'));
  try {
    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/.env'), 'SECRET=1');
    // Listed as gitignored+matched by the mocked `git ls-files` output, but
    // never actually created on disk -- copyFileSync must fail on this one.
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
    expect(failed[0].file).toBe('apps/missing/.env');
    expect(failed[0].error).toMatch(/ENOENT|no such file/i);
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
    // The trailing slashes are what `--directory` emits for a wholly-ignored
    // directory; listGitignoredFiles drops these entries, this one must not.
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

test('cloneIgnoredEntries skips excluded paths and reports a clone that fell back to a real copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'rn-iso-test-target-'));
  try {
    const fileCalls: [string, string[]][] = [];
    setExecutor({
      run: (cmd) => {
        throw new Error(`unexpected shell run: ${cmd}`);
      },
      runFile: (file, args) => {
        fileCalls.push([file, args]);
        // `cp -Rc` is the APFS-clone probe; throwing is how the real executor
        // surfaces a refused clonefile (different volume / not APFS), which the
        // fallback `cp -R` then handles.
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
    // No shell string; `from`/`to` reach cp as literal argv elements.
    expect(fileCalls.some(([f, a]) => f === 'cp' && a[0] === '-Rc')).toBeTruthy();
    expect(fileCalls.some(([f, a]) => f === 'cp' && a[0] === '-R')).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('carryOverFiles against a real git repo copies only the gitignored+matched file', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-realgit-'));
  const root = join(base, 'repo');
  const target = join(base, 'target');
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(target, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');

    // Tracked file that happens to match a carry-over pattern: must never
    // be copied, because it is already tracked (not gitignored).
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config/secrets.json'), '{"tracked": true}');
    writeFileSync(join(root, 'README.md'), 'hello');
    writeFileSync(join(root, '.gitignore'), '.env\ndist/\n');
    git('git add README.md config/secrets.json .gitignore');
    git('git commit -q -m init');

    // Untracked, gitignored, and pattern-matched: must be copied.
    mkdirSync(join(root, 'apps/mobile'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/.env'), 'SECRET=1');

    // Untracked and gitignored, but not pattern-matched: must not be copied.
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

// Regression for the bug where `git ls-files --others --ignored
// --exclude-standard` output past execSync's default 1MB maxBuffer made
// listGitignoredFiles (and therefore carryOverFiles) silently return
// nothing -- `copied` and `failed` both empty, so `worktree create` never
// even warned. A mocked executor cannot catch this class of bug (the whole
// failure is inside execSync's real buffering), so this drives real git
// over a real, oversized ignored-file set. The bloat files sit at the repo
// root next to a tracked README so the directory can never collapse to a
// single `--directory` entry -- this is what keeps raw ls-files output
// large even after the node_modules-scoping fix, so the test still
// exercises the maxBuffer path it exists to guard.
test('listGitignoredFiles and carryOverFiles still find the target file when raw ls-files output exceeds 1MB', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-bigignore-'));
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

    // ~1.3MB of untracked, ignored, irrelevant filenames -- stands in for
    // the real-world case (a multi-GB node_modules), just scattered instead
    // of collapsible into one directory entry.
    const padding = 'x'.repeat(200);
    for (let i = 0; i < 6000; i++) {
      writeFileSync(join(root, `bloat-${i}-${padding}.ignoreme`), '');
    }

    // The actual file carry-over exists to find, buried in the same
    // oversized, ignored listing.
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
  const tmp = mkdtempSync(join(tmpdir(), 'rn-iso-test-add-'));
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

    const result = addWorktree({ path, branch: 'feat-x', baseRef: 'origin/main', cwd: tmp });

    expect(result).toBe(path);
    // No shell string anywhere; the space-bearing path is a single literal argv
    // element, and `--` terminates options so neither path nor baseRef can be
    // read as a flag.
    expect(calls).toEqual([['git', ['worktree', 'add', '-b', 'feat-x', '--', path, 'origin/main']]]);
    expect(existsSync(dirname(path))).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Regression for `create -> remove -> create` with the same name: `git
// worktree remove` deletes the worktree directory but never the branch, so
// a second create with the same name used to hit git's "branch already
// exists" error on `-b`. addWorktree must detect that and attach instead.
test('addWorktree attaches to an existing branch instead of erroring on -b', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rn-iso-test-add-reuse-'));
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
      // Simulate the branch already existing (left behind by an earlier
      // `worktree remove`): rev-parse --verify succeeds and prints a sha.
      runQuiet: (cmd) => (/rev-parse --verify --quiet/.test(cmd) ? 'deadbeef' : ''),
      spawn: () => {},
    });

    const result = addWorktree({ path, branch: 'worktree-fix-login', baseRef: 'origin/main', cwd: tmp });

    expect(result).toBe(path);
    // Attach path: no `-b`, and `--` still terminates options before the path.
    expect(calls).toEqual([['git', ['worktree', 'add', '--', path, 'worktree-fix-login']]]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('addWorktree uses -b for a genuinely new branch name', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rn-iso-test-add-fresh-'));
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
      runQuiet: () => null, // branch does not exist
      spawn: () => {},
    });

    addWorktree({ path, branch: 'worktree-new-thing', baseRef: 'origin/main', cwd: tmp });

    expect(calls).toEqual([['git', ['worktree', 'add', '-b', 'worktree-new-thing', '--', path, 'origin/main']]]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeWorktree includes --force only when asked, for a path containing a space', () => {
  const path = '/tmp/my worktree/repo';
  const calls: string[] = [];
  setExecutor({
    run: (cmd) => {
      calls.push(cmd);
      return '';
    },
    runQuiet: () => '',
    spawn: () => {},
  });

  removeWorktree(path);
  removeWorktree(path, { force: true });

  expect(calls).toEqual([
    `git -C "${path}" worktree remove "${path}"`,
    `git -C "${path}" worktree remove --force "${path}"`,
  ]);
});

// `ios/Pods/` is gitignored and gets cloned; `ios/Podfile.lock` is tracked and
// comes from the branch. When the source worktree's two disagree, the clone
// imports the contradiction and xcodebuild reports it only after every pod has
// compiled ("sandbox is not in sync"). Catching it at create time is a file
// comparison; catching it at build time cost 25 minutes on a real project.
function podsFixture({
  manifest,
  podfileLock,
  dir = 'ios',
}: {
  manifest?: string | null;
  podfileLock?: string | null;
  dir?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-pods-'));
  mkdirSync(join(root, dir, 'Pods'), { recursive: true });
  if (manifest != null) writeFileSync(join(root, dir, 'Pods', 'Manifest.lock'), manifest);
  if (podfileLock != null) writeFileSync(join(root, dir, 'Podfile.lock'), podfileLock);
  return root;
}

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

// A monorepo keeps the app -- and its Pods -- under e.g. apps/mobile, so the
// check cannot be hardcoded to a top-level `ios/`.
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

// No Manifest.lock means nothing was ever installed into that directory, so
// there is no claim to contradict. Warning there would be noise.
test('a Pods directory with no Manifest.lock is not reported', () => {
  const root = podsFixture({ manifest: null, podfileLock: 'a\n' });
  expect(podsOutOfSync(root, ['ios/Pods'])).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

// The removal refusal used to print the CocoaPods restore command
// unconditionally. On member-app the dirty files are brand assets a shell
// script rewrites, so following that command cleared nothing.
test('pod-install churn is recognised so the restore advice only fires when it works', () => {
  expect(isPodInstallChurn([' M ios/Podfile.lock', ' M ios/PatientApp.xcodeproj/project.pbxproj'])).toBe(true);
  expect(isPodInstallChurn([' M ios/Podfile.lock', ' M config.json'])).toBe(false);
  expect(isPodInstallChurn([' M App/Images/ic_app_ios.png'])).toBe(false);
  expect(isPodInstallChurn([])).toBe(false);
});

// --- .rn-iso/ is never carried, and that is not configurable -----------------
//
// It holds this workspace's derived data, its logs and the supervisor pidfile:
// build output keyed to a path the new worktree does not have, and a pidfile
// for a process that is not running. There is no repo for which carrying that
// is right, so it is code rather than a line in a file someone has to remember
// to write. A monorepo has one per app directory, hence the depth cases.
test('isWorkspaceArtifact matches the workspace dir at any depth, and nothing else', () => {
  for (const rel of [
    '.rn-iso',
    '.rn-iso/logs/metro.ndjson',
    'apps/mobile/.rn-iso',
    'apps/mobile/.rn-iso/derived-data',
  ]) {
    expect(isWorkspaceArtifact(rel)).toBe(true);
  }
  for (const rel of ['node_modules', 'apps/mobile/.rn-isotope', 'docs/rn-iso.md', 'apps/.rn-iso-old']) {
    expect(isWorkspaceArtifact(rel)).toBe(false);
  }
});

test('cloneIgnoredEntries skips every .rn-iso with no pattern file anywhere', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'rn-iso-test-target-'));
  try {
    setExecutor({
      run: () => '',
      runFile: () => '', // cp -Rc / cp -R now go through runFile; '' = clone ok
      runQuiet: (cmd) => {
        if (cmd.includes('ls-files -z')) return '';
        if (cmd.startsWith('git ')) return 'node_modules/\n.rn-iso/\napps/mobile/.rn-iso/\napps/mobile/ios/Pods/';
        return '';
      },
      spawn: () => {},
    });

    const { copied } = cloneIgnoredEntries({ root, target, patterns: [] });

    expect(copied).toEqual(['node_modules', 'apps/mobile/ios/Pods']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// The pattern file extends the built-in list. It cannot shorten it: a pattern
// that names .rn-iso -- or a negation someone hopes will re-include it -- has
// no effect, because the exclusion is not implemented with patterns at all.
test('.worktreeexclude patterns add to the built-in exclusion and cannot undo it', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'rn-iso-test-target-'));
  try {
    setExecutor({
      run: () => '',
      runFile: () => '', // cp -Rc / cp -R now go through runFile; '' = clone ok
      runQuiet: (cmd) => {
        if (cmd.includes('ls-files -z')) return '';
        if (cmd.startsWith('git ')) return 'node_modules/\ncoverage/\napps/mobile/.rn-iso/';
        return '';
      },
      spawn: () => {},
    });

    const extended = cloneIgnoredEntries({ root, target, patterns: ['coverage'] });
    expect(extended.copied).toEqual(['node_modules']);

    const attemptedReinclude = cloneIgnoredEntries({ root, target, patterns: ['!.rn-iso', '!**/.rn-iso'] });
    expect(attemptedReinclude.copied).toEqual(['node_modules', 'coverage']);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// The file-by-file half of carry-over (.worktreeinclude) reaches individual
// gitignored files, which is how a `**/*.json`-shaped pattern could otherwise
// pick up a workspace's own state.json.
test('carryOverFiles never carries a file from inside a workspace directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'rn-iso-test-target-'));
  try {
    mkdirSync(join(root, 'apps/mobile/.rn-iso'), { recursive: true });
    writeFileSync(join(root, 'apps/mobile/.rn-iso/state.json'), '{"supervisorPid":123}');
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config/local.json'), '{}');
    setExecutor({
      run: () => '',
      runQuiet: (cmd) => (cmd.includes('ls-files -z') ? '' : 'apps/mobile/.rn-iso/state.json\nconfig/local.json'),
      spawn: () => {},
    });

    const { copied } = carryOverFiles({ root, target, patterns: ['**/*.json'] });

    expect(copied).toEqual(['config/local.json']);
    expect(existsSync(join(target, 'apps/mobile/.rn-iso/state.json'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

// Ignore state is a PER-WORKTREE fact: git computes it from the `.gitignore`
// files that worktree has checked out, and those are themselves tracked,
// branch-varying files. So "ignored and untracked over in the source" says
// nothing about the destination -- `worktree create --base` exists precisely
// to let the two sit on different branches.
//
// Observed on tlon-apps, whose apps/tlon-mobile/.gitignore ignores
// `*.keystore` and then re-includes `!android/app/debug.keystore` so the team
// shares one debug signing identity. A source worktree whose branch predates
// that re-include has the keystore ignored+untracked, so the carry-over
// enumerated it and copied that machine's own copy over the tracked one the
// new worktree had just checked out. Silent tracked-file corruption, and by
// tlon's own comment the exact file whose drift poisons their EAS build cache
// and breaks APK installs across machines with a signature mismatch.
test('cloneIgnoredEntries against a real git repo never overwrites a path the destination tracks', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-tracked-clone-'));
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

    // The branch the new worktree is cut from re-includes the keystore and
    // tracks it, exactly as tlon-apps does.
    git('git checkout -q -b feature');
    writeFileSync(join(root, '.gitignore'), '*.keystore\n!android/app/debug.keystore\nbuild/\n');
    writeFileSync(join(root, 'android/app/debug.keystore'), 'BRANCH-VERSION');
    git('git add -A');
    git('git commit -q -m "feature: track debug.keystore through a negation"');
    git('git checkout -q main');

    // The source worktree, sitting on the older branch: its keystore is
    // ignored, untracked, and drifted from what the branch carries.
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
    // The genuinely ignored build output still comes across -- the guard is a
    // scalpel, not a switch that turns carry-over off.
    expect(copied).toEqual(['build']);
    expect(readFileSync(join(target, 'build/artifact.txt'), 'utf-8')).toBe('output');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('carryOverFiles against a real git repo never overwrites a path the destination tracks', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-tracked-carry-'));
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

    // A `.worktreeinclude` wide enough to name both files: the include list is
    // a filter over what git says is ignored, and it must not be able to reach
    // a file the destination tracks.
    const { copied, skipped } = carryOverFiles({ root, target, patterns: ['*.keystore', '.env'] });

    expect(copied).toEqual(['apps/mobile/.env']);
    expect(skipped).toEqual([{ file: 'apps/mobile/debug.keystore', reason: 'tracked' }]);
    expect(readFileSync(join(target, 'apps/mobile/debug.keystore'), 'utf-8')).toBe('BRANCH-VERSION');
    expect(readFileSync(join(target, 'apps/mobile/.env'), 'utf-8')).toBe('SECRET=1');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The negation case that motivated all of this, kept as its own test because
// it is the one a hand-rolled matcher gets wrong: a matcher that honours
// `dir/` but ignores the `!dir/keep.txt` line under it would enumerate the
// tracked file and carry it. git's own enumeration gets it right (a tracked
// path is never an "other"), and the destination-side guard backs it up.
//
// `git add -f` is not incidental: gitignore cannot re-include a file whose
// PARENT directory is excluded, so `dir/` + `!dir/keep.txt` leaves keep.txt
// ignored, and force-adding is how a repo ends up with a tracked file under
// an ignored directory in the first place.
test('carry against a real git repo leaves a tracked file under an ignored directory alone', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-negation-'));
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

    // Source-side drift: the tracked file differs from what the branch holds.
    writeFileSync(join(root, 'dir/keep.txt'), 'SOURCE-MACHINE-LOCAL');

    const { copied, skipped, failed } = cloneIgnoredEntries({ root, target, patterns: [] });

    expect(failed).toEqual([]);
    expect(skipped).toEqual([]);
    expect(readFileSync(join(target, 'dir/keep.txt'), 'utf-8')).toBe('BRANCH-VERSION');
    // Everything else under the ignored directory still carries.
    expect(copied.sort()).toEqual(['dir/junk.txt', 'dir/sub']);
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
  // Without -z, `ls-files` C-quotes any path that is non-ASCII or holds a
  // newline, and a quoted path can never match the entry the carry is about
  // to copy -- the guard would silently pass it through.
  expect(capturedCmd).toMatch(/-z/);

  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  expect(listTrackedPaths('/wt')).toBe(null);
});

// The destination of a real `worktree create` is always a git worktree, so an
// unanswerable `ls-files` means something is wrong enough that guessing is not
// allowed. Falling back to "assume nothing is tracked" would reopen the exact
// hole this guard closes, so the carry refuses to write over anything that is
// already there.
test('carry fails closed when the destination cannot be asked what it tracks', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'rn-iso-test-target-'));
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

// -----------------------------------------------------------------------------
// Shell-injection regressions (C1 + H1). These MUST drive the real executor
// against a real git repo: a mocked exec proves the argv shape but cannot prove
// no shell evaluates a `$(...)` payload. The whole point is that repo-controlled
// input -- a committed worktree.baseRef, a `--base`, or an ignored filename that
// `git ls-files` does not quote -- reaches git/cp as one literal argument.

test('C1: resolveRef never lets a $(...) baseRef reach a shell, and still resolves a real ref', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-sec-resolveref-'));
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

    // A relative-path payload lands in the process cwd if a shell ever runs it.
    process.chdir(base);
    expect(resolveRef(root, '$(touch PWNED)')).toBe(null);
    expect(existsSync(join(base, 'PWNED'))).toBe(false);

    // Real refs still resolve to the sha, unchanged.
    expect(resolveRef(root, 'HEAD')).toBe(realHead);
    expect(resolveRef(root, 'main')).toBe(realHead);
    // A leading-dash ref is a safe lookup miss (--end-of-options), not a flag.
    expect(resolveRef(root, '-oops')).toBe(null);
  } finally {
    process.chdir(cwdBefore);
    rmSync(base, { recursive: true, force: true });
  }
});

test('C1: addWorktree never lets a $(...) baseRef reach a shell, and still creates a worktree', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-sec-addwt-'));
  const root = join(base, 'repo');
  const cwdBefore = process.cwd();
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git('git commit -q --allow-empty -m init');

    // `git worktree add` carries no `-C`, so it runs in process.cwd(); the real
    // create flow invokes it from inside the repo. A relative-path payload would
    // land here if a shell ever ran it.
    process.chdir(root);
    // A `$(...)` baseRef must not execute. git will simply fail to resolve the
    // literal commit-ish, so addWorktree throws -- but no shell runs.
    expect(() =>
      addWorktree({
        path: join(base, 'wt-evil'),
        branch: 'worktree-evil',
        baseRef: '$(touch PWNED2)',
        cwd: root,
      }),
    ).toThrow();
    expect(existsSync(join(root, 'PWNED2'))).toBe(false);

    // A real base ref still produces a working worktree on a fresh branch.
    const wt = join(base, 'wt-good');
    addWorktree({ path: wt, branch: 'worktree-good', baseRef: 'HEAD', cwd: root });
    expect(existsSync(join(wt, '.git'))).toBe(true);
    expect(git('git worktree list --porcelain')).toMatch(/worktree-good/);
  } finally {
    process.chdir(cwdBefore);
    rmSync(base, { recursive: true, force: true });
  }
});

test('C1: addWorktree rejects a leading-dash baseRef with a clear error (defense in depth)', () => {
  const path = join(tmpdir(), 'rn-iso-test-sec-dash', 'repo');
  setExecutor({
    run: (cmd) => {
      throw new Error(`unexpected shell run: ${cmd}`);
    },
    runFile: (file, args) => {
      throw new Error(`git must not be invoked: ${file} ${args.join(' ')}`);
    },
    runQuiet: () => null, // branch does not exist -> fresh path, where baseRef is used
    spawn: () => {},
  });
  expect(() =>
    addWorktree({ path, branch: 'worktree-x', baseRef: '--upload-pack=touch EVIL', cwd: dirname(path) }),
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
  expect(() => addWorktree({ path: '-evil/repo', branch: 'worktree-x', baseRef: 'HEAD', cwd: '/tmp' })).toThrow(
    /a path beginning with "-"/,
  );
  expect(() =>
    addWorktree({ path: '/tmp/a$(touch X)/repo', branch: 'worktree-x', baseRef: 'HEAD', cwd: '/tmp' }),
  ).toThrow(/shell metacharacters/);
});

test('H1: cloneIgnoredEntries carries a top-level ignored $(...) filename as a literal file, never executing it', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-sec-clone-'));
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

    // A genuinely ignored, top-level file whose NAME is a command-substitution
    // payload. `git ls-files --others --ignored --directory` returns this
    // unquoted; under the old `cp -Rc "${from}"` it executed.
    const evil = 'a$(touch INJECTED).log';
    writeFileSync(join(root, evil), 'payload');

    process.chdir(base);
    const { copied, failed } = cloneIgnoredEntries({ root, target, patterns: [] });

    expect(existsSync(join(base, 'INJECTED'))).toBe(false);
    expect(failed).toEqual([]);
    expect(copied.includes(evil)).toBeTruthy();
    // Carried as a real file with its content intact, not evaluated.
    expect(existsSync(join(target, evil))).toBe(true);
    expect(readFileSync(join(target, evil), 'utf-8')).toBe('payload');
  } finally {
    process.chdir(cwdBefore);
    rmSync(base, { recursive: true, force: true });
  }
});

test('isCarrySkipped skips .rn-iso and .DerivedData at any depth, and nothing that merely resembles them', () => {
  for (const rel of [
    '.rn-iso',
    'apps/mobile/.rn-iso',
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
    'apps/mobile/.rn-isotope',
    'MyDerivedData',
    'apple/MyDerivedData/x',
    '.DerivedDataThing',
    'apple/DerivedDataFoo',
    'apple/.DerivedDataX',
  ]) {
    expect(isCarrySkipped(rel)).toBe(false);
  }
});

// The live bug: `worktree create --carry-ignored` cloned
// node_modules/expo-modules-jsi/apple/.DerivedData -- a Clang module cache that
// bakes the SOURCE worktree's absolute paths -- so the new worktree's build
// died with `missing required module 'SwiftShims'`. node_modules is one
// collapsed ls-files entry, so the skip has to reach INSIDE the clone: prune
// the .DerivedData subtree from the destination while leaving its siblings.
test('cloneIgnoredEntries against a real git repo drops a nested .DerivedData but keeps its sibling', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-derived-'));
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

    // Gitignored via node_modules: the Clang module cache (baked absolute
    // paths -> must NOT be carried) and a real source file beside it (must be
    // carried, proving we prune the child, not the parent apple/ directory).
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

// carryOverFiles is file-by-file (and excludes node_modules), so the same skip
// applies at the entry level: a .DerivedData segment in an enumerated path is
// dropped while its sibling is copied. The empty `.keep` keeps git from
// collapsing .DerivedData into one directory entry, so both files enumerate
// individually the way they would inside a partially-ignored tree.
test('carryOverFiles against a real git repo skips a .DerivedData file but copies its sibling', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-test-derived-files-'));
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
    writeFileSync(join(root, 'apple/.DerivedData/.keep'), ''); // untracked, not ignored
    writeFileSync(join(root, 'apple/Real.derived'), 'source');
    writeFileSync(join(root, 'apple/.keep'), ''); // untracked, not ignored

    const { copied, failed } = carryOverFiles({ root, target, patterns: ['*.derived'] });

    expect(copied).toEqual(['apple/Real.derived']);
    expect(failed).toEqual([]);
    expect(existsSync(join(target, 'apple/Real.derived'))).toBe(true);
    expect(existsSync(join(target, 'apple/.DerivedData/cache.derived'))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
