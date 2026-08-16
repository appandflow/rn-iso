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
  unpushedCommits,
  hasUncommittedWork,
  listWorktrees,
  carryOverFiles,
  addWorktree,
  removeWorktree,
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

    const copied = carryOverFiles({ root, target, patterns: ['.env'] });

    assert.deepEqual(copied, ['apps/mobile/.env']);
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

    const copied = carryOverFiles({ root, target, patterns: ['.env', 'secrets.json'] });

    assert.deepEqual(copied, ['apps/mobile/.env']);
    assert.equal(existsSync(join(target, 'apps/mobile/.env')), true);
    assert.equal(readFileSync(join(target, 'apps/mobile/.env'), 'utf-8'), 'SECRET=1');
    assert.equal(existsSync(join(target, 'dist/build.log')), false);
    assert.equal(existsSync(join(target, 'config/secrets.json')), false);
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
    `git worktree remove "${path}"`,
    `git worktree remove --force "${path}"`,
  ]);
});
