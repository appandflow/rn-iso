import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacity, environmentState, unprovisionedWorktrees } from '../src/status.js';

const BOOTED = { udid: 'U1', name: 'rn-iso-app', state: 'Booted' };
const SHUTDOWN = { udid: 'U1', name: 'rn-iso-app', state: 'Shutdown' };

function project(over = {}) {
  return {
    __path: '/proj/a',
    metroPort: 8082,
    platforms: { ios: { deviceUdid: 'U1', owned: true } },
    ...over,
  };
}

// "Live" has to mean consuming the machine right now. A registered project with
// nothing booted costs nothing, and counting it would make the capacity warning
// fire on a machine that is doing nothing.
test('a registered project with nothing booted is not live and costs no memory', () => {
  const s = environmentState(project(), { simsByUdid: { U1: SHUTDOWN }, metro: { missing: true } });
  assert.equal(s.live, false);
  assert.equal(s.memoryMb, 0);
});

test('a booted sim with Metro running is live, and counts both', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: BOOTED },
    metro: { metro: { pid: 42, leader: 42, cwd: '/proj/a' } },
  });
  assert.equal(s.live, true);
  assert.ok(s.memoryMb >= 2000, 'a sim plus a bundler is the bulk of an environment');
  assert.equal(s.metro.pid, 42);
});

// The failure that silently builds against the wrong bundler. It outranks every
// other warning because nothing else in the system reports it.
test('a port answered by something that is not our Metro is warned about', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: BOOTED },
    metro: { notOurs: 'pid 99 runs from /somewhere/else' },
  });
  assert.equal(s.metro.running, false);
  assert.match(s.warnings.join(' '), /somewhere\/else/);
});

// The shape of an environment somebody walked away from: 1.5 GB held, nothing
// served.
test('a booted sim with no Metro is called out as abandoned', () => {
  const s = environmentState(project(), { simsByUdid: { U1: BOOTED }, metro: { missing: true } });
  assert.match(s.warnings.join(' '), /booted with no Metro/);
});

test('a recorded device that no longer exists is reported rather than shown as fine', () => {
  const s = environmentState(project(), { simsByUdid: {}, metro: { missing: true } });
  assert.equal(s.ios.state, 'missing');
  assert.match(s.warnings.join(' '), /no longer exists/);
});

// Past the point where committed memory outweighs the machine, more parallelism
// makes everything slower -- and that is the one failure a parallel agent cannot
// observe for itself.
test('capacity warns once committed memory passes a comfortable share of the machine', () => {
  const live = { live: true, memoryMb: 2200 };
  assert.equal(capacity([live, live], 16384).overCapacity, false, 'two environments on 16 GB is fine');
  assert.equal(capacity([live, live, live, live, live], 16384).overCapacity, true, 'five is not');
});

test('capacity says nothing when the machine size is unknown', () => {
  assert.equal(capacity([{ live: true, memoryMb: 9999 }], null).overCapacity, false);
});

test('unprovisioned worktrees are the ones with no registered environment', () => {
  const worktrees = [{ path: '/wt/a' }, { path: '/wt/b' }];
  assert.deepEqual(unprovisionedWorktrees(worktrees, ['/wt/a']).map(w => w.path), ['/wt/b']);
});
