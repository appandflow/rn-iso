import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopAction, resolveStopTarget, stopTargets } from '../src/commands/stop.js';

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

// Reported from the field: `worktree create X --label X` labels the worktree
// ROOT, which owns no port, while `up` registers the app dir (shortcut
// "X/tlon-mobile"). `stop X` therefore printed "No Metro port assigned" and
// exited 0 while Metro kept running -- an agent reads exit 0 as done.
test('stopTargets falls through to nested projects when the target owns no port', () => {
  const projects = {
    '/wt/x': { label: 'X', worktreeRoot: true },
    '/wt/x/apps/mobile': { metroPort: 8083 },
  };
  assert.deepEqual(stopTargets('/wt/x', projects), [
    { path: '/wt/x/apps/mobile', port: 8083 },
  ]);
});

test('stopTargets returns the target itself when it owns a port', () => {
  const projects = { '/proj/a': { metroPort: 8082 } };
  assert.deepEqual(stopTargets('/proj/a', projects), [{ path: '/proj/a', port: 8082 }]);
});

test('stopTargets collects every nested project with a port', () => {
  const projects = {
    '/wt/x': { label: 'X', worktreeRoot: true },
    '/wt/x/apps/a': { metroPort: 8083 },
    '/wt/x/apps/b': { metroPort: 8084 },
    '/other': { metroPort: 8099 },
  };
  const got = stopTargets('/wt/x', projects).map(t => t.port).sort();
  assert.deepEqual(got, [8083, 8084], 'must not reach outside the target');
});

test('stopTargets returns empty when nothing under the target owns a port', () => {
  assert.deepEqual(stopTargets('/wt/x', { '/wt/x': { worktreeRoot: true } }), []);
});
