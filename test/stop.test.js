import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopAction } from '../src/commands/stop.js';

test('stopAction kills an identified Metro', () => {
  const r = stopAction({ resolution: { metro: { pid: 1, leader: 2 } }, force: false });
  assert.equal(r.action, 'killed');
  assert.equal(r.leader, 2);
});

test('stopAction treats nothing-listening as a no-op, not an error', () => {
  const r = stopAction({ resolution: { missing: true }, force: false });
  assert.equal(r.action, 'missing');
});

test('stopAction refuses an unidentified listener and surfaces the reason', () => {
  const r = stopAction({ resolution: { notOurs: 'pid 9 runs from /elsewhere' }, force: false });
  assert.equal(r.action, 'refused');
  assert.match(r.reason, /elsewhere/);
});

test('stopAction with --force kills an unidentified listener', () => {
  const r = stopAction({ resolution: { notOurs: 'unknown', pid: 9 }, force: true });
  assert.equal(r.action, 'forced');
  assert.equal(r.pid, 9);
});

// --force must never turn "nothing is there" into a kill attempt: the missing
// branch is checked before force is consulted.
test('stopAction with --force still reports missing when nothing listens', () => {
  const r = stopAction({ resolution: { missing: true }, force: true });
  assert.equal(r.action, 'missing');
});

test('stopAction prefers the identified path even when force is set', () => {
  const r = stopAction({ resolution: { metro: { pid: 1, leader: 2 } }, force: true });
  assert.equal(r.action, 'killed');
});
