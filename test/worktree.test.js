import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setExecutor, resetExecutor } from '../src/exec.js';
import {
  defaultWorktreeDir,
  worktreePath,
  matchesInclude,
  unpushedCommits,
  hasUncommittedWork,
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
