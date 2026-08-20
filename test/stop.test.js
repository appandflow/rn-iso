import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopAction, resolveStopTarget } from '../src/commands/stop.js';

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

// Port targeting belongs to `stop`: the port is the resource stop owns.
// `release <port>` used to double as an arbitrary process killer, which put
// the only "kill an unregistered port-holder" path on the device-teardown
// command.
test('resolveStopTarget resolves a numeric port to its owning project', () => {
  const r = resolveStopTarget('8083', {
    byPort: (p) => (p === 8083 ? '/proj/a' : null),
    byShortcut: () => ({ found: null, error: 'nope' }),
  });
  assert.deepEqual(r, { project: '/proj/a', port: 8083 });
});

test('resolveStopTarget reports an unowned port so the caller can offer --force', () => {
  const r = resolveStopTarget('8099', {
    byPort: () => null,
    byShortcut: () => ({ found: null, error: 'nope' }),
  });
  assert.deepEqual(r, { unownedPort: 8099 });
});

test('resolveStopTarget falls through to shortcut resolution for non-numeric targets', () => {
  const r = resolveStopTarget('agent-1', {
    byPort: () => null,
    byShortcut: (t) => ({ found: t === 'agent-1' ? '/proj/a' : null, error: 'nope' }),
  });
  assert.deepEqual(r, { project: '/proj/a', port: null });
});

test('resolveStopTarget surfaces a shortcut resolution error', () => {
  const r = resolveStopTarget('bogus', {
    byPort: () => null,
    byShortcut: () => ({ found: null, error: 'no such project' }),
  });
  assert.deepEqual(r, { error: 'no such project' });
});
