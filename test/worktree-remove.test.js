import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removalBlockers } from '../src/commands/worktree.js';

test('no blockers for a clean worktree', () => {
  assert.deepEqual(removalBlockers({ dirty: false, unpushed: [] }), []);
});

test('reports uncommitted changes', () => {
  const blockers = removalBlockers({ dirty: true, unpushed: [] });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /uncommitted/i);
});

test('reports unpushed commits with a count', () => {
  const blockers = removalBlockers({ dirty: false, unpushed: ['abc one', 'def two'] });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /2 commit/);
});

test('reports both when both apply', () => {
  assert.equal(removalBlockers({ dirty: true, unpushed: ['abc one'] }).length, 2);
});
