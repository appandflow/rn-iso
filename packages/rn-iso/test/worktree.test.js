import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import {
  defaultWorktreeDir,
  worktreePath,
  matchesInclude,
  isWorkspaceArtifact,
  unpushedCommits,
  hasUncommittedWork,
  listWorktrees,
  carryOverFiles,
  cloneIgnoredEntries,
  podsOutOfSync,
  isPodInstallChurn,
  listGitignoredEntries,
  listGitignoredFiles,
  addWorktree,
  removeWorktree,
  resolveBaseRef,
} from '../src/worktree.js';

afterEach(() => resetExecutor());

test('default worktree dir is a sibling of the repo', () => {
  assert.equal(
    defaultWorktreeDir('/Volumes/ExternalSSD/Developer/tlon-apps'),
    '/Volumes/ExternalSSD/Developer/tlon-apps-worktrees'
  );
});

test('worktreePath joins the dir and the name', () => {
  assert.equal(worktreePath({ worktreeDir: '/wt', name: 'feat-x' }), '/wt/feat-x');
});

test('matchesInclude supports gitignore-style patterns', () => {
  assert.equal(matchesInclude('apps/tlon-mobile/.env', ['.env']), true);
  assert.equal(matchesInclude('apps/tlon-mobile/.env', ['*.env']), false);
  assert.equal(matchesInclude('config/secrets.json', ['config/secrets.json']), true);
  assert.equal(matchesInclude('a/b/c.node', ['**/*.node']), true);
  assert.equal(matchesInclude('apps/x/.env.local', ['.env']), false);
});

test('matchesInclude treats a leading slash as a root anchor', () => {
  assert.equal(matchesInclude('config/secrets.json', ['/config/secrets.json']), true);
  assert.equal(matchesInclude('a/config/secrets.json', ['/config/secrets.json']), false);
  assert.equal(matchesInclude('a/config/secrets.json', ['config/secrets.json']), true);
});

test('matchesInclude treats ? as a single-character wildcard, not a quantifier', () => {
  assert.equal(matchesInclude('apps/mobile/b1.env', ['b?.env']), true);
  assert.equal(matchesInclude('apps/mobile/b12.env', ['b?.env']), false);
  assert.equal(matchesInclude('apps/mobile/b.env', ['b?.env']), false);
});

test('hasUncommittedWork reflects git status output', () => {
  setExecutor({ run: () => ' M file.js', runQuiet: () => ' M file.js', spawn: () => {} });
  assert.equal(hasUncommittedWork('/wt'), true);
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  assert.equal(hasUncommittedWork('/wt'), false);
});

test('unpushedCommits lists commits missing from every remote', () => {
  setExecutor({
    run: () => 'abc123 first\ndef456 second',
    runQuiet: () => 'abc123 first\ndef456 second',
    spawn: () => {},
  });
  assert.deepEqual(unpushedCommits('/wt'), ['abc123 first', 'def456 second']);
});

test('unpushedCommits returns empty when git reports nothing', () => {
  setExecutor({ run: () => '', runQuiet: () => '', spawn: () => {} });
  assert.deepEqual(unpushedCommits('/wt'), []);
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
    const git = (cmd) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git(`git remote add origin "${bareRemote}"`);
    writeFileSync(join(repo, 'README.md'), 'hello');
    git('git add README.md');
    git('git commit -q -m init');
    git('git push -q -u origin HEAD');

    assert.deepEqual(unpushedCommits(repo), []);

    writeFileSync(join(repo, 'local.txt'), 'local only');
    git('git add local.txt');
    git('git commit -q -m "local-only commit"');

    const unpushed = unpushedCommits(repo);
    assert.equal(unpushed.length, 1);
    assert.match(unpushed[0], /local-only commit/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('resolveBaseRef("head") returns HEAD and never touches origin/HEAD', () => {
  const calls = [];
  setExecutor({ run: () => '', runQuiet: (cmd) => { calls.push(cmd); return ''; }, spawn: () => {} });
  assert.equal(resolveBaseRef('/repo', 'head'), 'HEAD');
  assert.deepEqual(calls, []);
});

test('resolveBaseRef("fresh") returns origin/HEAD\'s branch when it resolves, no warning', () => {
  setExecutor({ run: () => '', runQuiet: () => 'origin/main', spawn: () => {} });
  const errs = [];
  const originalError = console.error;
  console.error = (msg) => errs.push(msg);
  try {
    assert.equal(resolveBaseRef('/repo', 'fresh'), 'origin/main');
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errs, []);
});

// Silent before this task: a repo with no `origin` remote (or one where
// `origin/HEAD` was never set) made every "fresh" worktree branch from
// local HEAD with no indication anything had fallen back.
test('resolveBaseRef("fresh") falls back to HEAD and warns on stderr when origin/HEAD is missing', () => {
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
  const errs = [];
  const originalError = console.error;
  console.error = (msg) => errs.push(msg);
  try {
    assert.equal(resolveBaseRef('/repo', 'fresh'), 'HEAD');
  } finally {
    console.error = originalError;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /origin\/HEAD/);
  assert.match(errs[0], /HEAD/);
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
  assert.deepEqual(listWorktrees('/repo'), [
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
        capturedCmd = cmd;
        // Simulates the real `git ls-files --others --ignored` output: only
        // untracked, gitignored files ever appear here. A tracked file
        // cannot be in this list no matter what patterns say.
        return 'apps/mobile/.env\ndist/build.log';
      },
      spawn: () => {},
    });

    const { copied, failed } = carryOverFiles({ root, target, patterns: ['.env'] });

    assert.deepEqual(copied, ['apps/mobile/.env']);
    assert.deepEqual(failed, []);
    assert.equal(existsSync(join(target, 'apps/mobile/.env')), true);
    assert.equal(readFileSync(join(target, 'apps/mobile/.env'), 'utf-8'), 'SECRET=1');
    assert.equal(existsSync(join(target, 'dist/build.log')), false);
    assert.match(capturedCmd, /--others/);
    assert.match(capturedCmd, /--ignored/);
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
      runQuiet: () => 'apps/mobile/.env\napps/missing/.env',
      spawn: () => {},
    });

    const { copied, failed } = carryOverFiles({ root, target, patterns: ['.env'] });

    assert.deepEqual(copied, ['apps/mobile/.env']);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].file, 'apps/missing/.env');
    assert.match(failed[0].error, /ENOENT|no such file/i);
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

  assert.deepEqual(listGitignoredEntries('/repo'), ['node_modules', 'ios/Pods', 'ios/.xcode.env.local']);
  assert.match(capturedCmd, /--directory/);
  assert.doesNotMatch(capturedCmd, /exclude,glob/);
});

test('cloneIgnoredEntries skips excluded paths and reports a clone that fell back to a real copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'rn-iso-test-target-'));
  try {
    const cmds = [];
    setExecutor({
      run: (cmd) => {
        cmds.push(cmd);
        return '';
      },
      runQuiet: (cmd) => {
        if (cmd.startsWith('git ')) return 'node_modules/\nbench/results/logs/';
        // Anything else is the `cp -c` probe; null is how the real executor
        // reports a refused clonefile (different volume, or not APFS).
        cmds.push(cmd);
        return null;
      },
      spawn: () => {},
    });

    const { copied, failed, cloned } = cloneIgnoredEntries({
      root,
      target,
      patterns: ['bench/results/logs'],
    });

    assert.deepEqual(copied, ['node_modules']);
    assert.deepEqual(failed, []);
    assert.equal(cloned, false);
    assert.ok(cmds.some(c => c.startsWith('cp -Rc')));
    assert.ok(cmds.some(c => c.startsWith('cp -R ')));
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
    const git = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
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

    assert.deepEqual(copied, ['apps/mobile/.env']);
    assert.deepEqual(failed, []);
    assert.equal(existsSync(join(target, 'apps/mobile/.env')), true);
    assert.equal(readFileSync(join(target, 'apps/mobile/.env'), 'utf-8'), 'SECRET=1');
    assert.equal(existsSync(join(target, 'dist/build.log')), false);
    assert.equal(existsSync(join(target, 'config/secrets.json')), false);
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
    const git = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
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
      10
    );
    assert.ok(rawBytes > 1024 * 1024, `test setup must exceed 1MB of raw ls-files output (got ${rawBytes})`);

    const ignored = listGitignoredFiles(root);
    assert.ok(
      ignored.includes('apps/mobile/.env'),
      'the target file must still be found past the old 1MB maxBuffer ceiling'
    );

    const { copied, failed } = carryOverFiles({ root, target, patterns: ['.env'] });
    assert.deepEqual(copied, ['apps/mobile/.env']);
    assert.deepEqual(failed, []);
    assert.equal(existsSync(join(target, 'apps/mobile/.env')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('addWorktree builds the correct command for a path containing a space', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rn-iso-test-add-'));
  try {
    const path = join(tmp, 'my worktree', 'repo');
    const calls = [];
    setExecutor({
      run: (cmd) => {
        calls.push(cmd);
        return '';
      },
      runQuiet: () => '',
      spawn: () => {},
    });

    const result = addWorktree({ path, branch: 'feat-x', baseRef: 'origin/main' });

    assert.equal(result, path);
    assert.deepEqual(calls, [`git worktree add "${path}" -b "feat-x" "origin/main"`]);
    assert.equal(existsSync(dirname(path)), true);
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
    const calls = [];
    setExecutor({
      run: (cmd) => {
        calls.push(cmd);
        return '';
      },
      // Simulate the branch already existing (left behind by an earlier
      // `worktree remove`): rev-parse --verify succeeds and prints a sha.
      runQuiet: (cmd) => (/rev-parse --verify --quiet/.test(cmd) ? 'deadbeef' : ''),
      spawn: () => {},
    });

    const result = addWorktree({ path, branch: 'worktree-fix-login', baseRef: 'origin/main', cwd: tmp });

    assert.equal(result, path);
    assert.deepEqual(calls, [`git worktree add "${path}" "worktree-fix-login"`]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('addWorktree uses -b for a genuinely new branch name', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rn-iso-test-add-fresh-'));
  try {
    const path = join(tmp, 'repo3');
    const calls = [];
    setExecutor({
      run: (cmd) => {
        calls.push(cmd);
        return '';
      },
      runQuiet: () => null, // branch does not exist
      spawn: () => {},
    });

    addWorktree({ path, branch: 'worktree-new-thing', baseRef: 'origin/main', cwd: tmp });

    assert.deepEqual(calls, [`git worktree add "${path}" -b "worktree-new-thing" "origin/main"`]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeWorktree includes --force only when asked, for a path containing a space', () => {
  const path = '/tmp/my worktree/repo';
  const calls = [];
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

  assert.deepEqual(calls, [
    `git -C "${path}" worktree remove "${path}"`,
    `git -C "${path}" worktree remove --force "${path}"`,
  ]);
});

// `ios/Pods/` is gitignored and gets cloned; `ios/Podfile.lock` is tracked and
// comes from the branch. When the source worktree's two disagree, the clone
// imports the contradiction and xcodebuild reports it only after every pod has
// compiled ("sandbox is not in sync"). Catching it at create time is a file
// comparison; catching it at build time cost 25 minutes on a real project.
function podsFixture({ manifest, podfileLock, dir = 'ios' }) {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-pods-'));
  mkdirSync(join(root, dir, 'Pods'), { recursive: true });
  if (manifest != null) writeFileSync(join(root, dir, 'Pods', 'Manifest.lock'), manifest);
  if (podfileLock != null) writeFileSync(join(root, dir, 'Podfile.lock'), podfileLock);
  return root;
}

test('carried Pods matching their Podfile.lock produce no warning', () => {
  const root = podsFixture({ manifest: 'PODS:\n  - fmt (11.0.2)\n', podfileLock: 'PODS:\n  - fmt (11.0.2)\n' });
  assert.deepEqual(podsOutOfSync(root, ['ios/Pods', 'node_modules']), []);
  rmSync(root, { recursive: true, force: true });
});

test('carried Pods that disagree with Podfile.lock are reported', () => {
  const root = podsFixture({ manifest: 'React-Core (= 0.86.2)\n', podfileLock: 'React-Core (= 0.79.6)\n' });
  assert.deepEqual(podsOutOfSync(root, ['ios/Pods']), [{ dir: 'ios', reason: 'mismatch' }]);
  rmSync(root, { recursive: true, force: true });
});

test('carried Pods with no Podfile.lock beside them are reported as missing', () => {
  const root = podsFixture({ manifest: 'React-Core (= 0.86.2)\n', podfileLock: null });
  assert.deepEqual(podsOutOfSync(root, ['ios/Pods']), [{ dir: 'ios', reason: 'missing' }]);
  rmSync(root, { recursive: true, force: true });
});

// A monorepo keeps the app -- and its Pods -- under e.g. apps/mobile, so the
// check cannot be hardcoded to a top-level `ios/`.
test('a monorepo app directory is checked at its own path', () => {
  const root = podsFixture({ manifest: 'a\n', podfileLock: 'b\n', dir: 'apps/mobile/ios' });
  assert.deepEqual(podsOutOfSync(root, ['apps/mobile/ios/Pods']), [{ dir: 'apps/mobile/ios', reason: 'mismatch' }]);
  rmSync(root, { recursive: true, force: true });
});

test('entries that are not Pods directories are ignored, including lookalikes', () => {
  const root = podsFixture({ manifest: 'a\n', podfileLock: 'b\n' });
  assert.deepEqual(podsOutOfSync(root, ['node_modules', 'ios/build', 'vendor/PodsHelper']), []);
  rmSync(root, { recursive: true, force: true });
});

// No Manifest.lock means nothing was ever installed into that directory, so
// there is no claim to contradict. Warning there would be noise.
test('a Pods directory with no Manifest.lock is not reported', () => {
  const root = podsFixture({ manifest: null, podfileLock: 'a\n' });
  assert.deepEqual(podsOutOfSync(root, ['ios/Pods']), []);
  rmSync(root, { recursive: true, force: true });
});

// The removal refusal used to print the CocoaPods restore command
// unconditionally. On member-app the dirty files are brand assets a shell
// script rewrites, so following that command cleared nothing.
test('pod-install churn is recognised so the restore advice only fires when it works', () => {
  assert.equal(isPodInstallChurn([' M ios/Podfile.lock', ' M ios/PatientApp.xcodeproj/project.pbxproj']), true);
  assert.equal(isPodInstallChurn([' M ios/Podfile.lock', ' M config.json']), false, 'a brand asset is not pod churn');
  assert.equal(isPodInstallChurn([' M App/Images/ic_app_ios.png']), false);
  assert.equal(isPodInstallChurn([]), false, 'nothing dirty is not pod churn');
});

// --- .rn-iso/ is never carried, and that is not configurable -----------------
//
// It holds this workspace's derived data, its logs and the supervisor pidfile:
// build output keyed to a path the new worktree does not have, and a pidfile
// for a process that is not running. There is no repo for which carrying that
// is right, so it is code rather than a line in a file someone has to remember
// to write. A monorepo has one per app directory, hence the depth cases.
test('isWorkspaceArtifact matches the workspace dir at any depth, and nothing else', () => {
  for (const rel of ['.rn-iso', '.rn-iso/logs/metro.ndjson', 'apps/mobile/.rn-iso', 'apps/mobile/.rn-iso/derived-data']) {
    assert.equal(isWorkspaceArtifact(rel), true, rel);
  }
  for (const rel of ['node_modules', 'apps/mobile/.rn-isotope', 'docs/rn-iso.md', 'apps/.rn-iso-old']) {
    assert.equal(isWorkspaceArtifact(rel), false, rel);
  }
});

test('cloneIgnoredEntries skips every .rn-iso with no pattern file anywhere', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-iso-test-root-'));
  const target = mkdtempSync(join(tmpdir(), 'rn-iso-test-target-'));
  try {
    setExecutor({
      run: () => '',
      runQuiet: (cmd) => {
        if (cmd.startsWith('git ')) return 'node_modules/\n.rn-iso/\napps/mobile/.rn-iso/\napps/mobile/ios/Pods/';
        return '';
      },
      spawn: () => {},
    });

    const { copied } = cloneIgnoredEntries({ root, target, patterns: [] });

    assert.deepEqual(copied, ['node_modules', 'apps/mobile/ios/Pods']);
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
      runQuiet: (cmd) => {
        if (cmd.startsWith('git ')) return 'node_modules/\ncoverage/\napps/mobile/.rn-iso/';
        return '';
      },
      spawn: () => {},
    });

    const extended = cloneIgnoredEntries({ root, target, patterns: ['coverage'] });
    assert.deepEqual(extended.copied, ['node_modules'], 'the file adds coverage to the skip list');

    const attemptedReinclude = cloneIgnoredEntries({ root, target, patterns: ['!.rn-iso', '!**/.rn-iso'] });
    assert.deepEqual(
      attemptedReinclude.copied,
      ['node_modules', 'coverage'],
      'nothing in the file can bring the workspace directory back'
    );
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
      runQuiet: () => 'apps/mobile/.rn-iso/state.json\nconfig/local.json',
      spawn: () => {},
    });

    const { copied } = carryOverFiles({ root, target, patterns: ['**/*.json'] });

    assert.deepEqual(copied, ['config/local.json']);
    assert.equal(existsSync(join(target, 'apps/mobile/.rn-iso/state.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
