import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacity, diskIsTight, diskLine, environmentState, formatSpace, parseDfFree, tightVolumes, unprovisionedWorktrees } from '../src/status.js';

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

// An empty map from a simctl that never answered is not evidence. Warning per
// project there reports a machine-wide tooling failure as a device problem.
test('an unreadable sim listing leaves the state unknown instead of warning per project', () => {
  const s = environmentState(project(), { simsByUdid: {}, metro: { missing: true }, simsAvailable: false });
  assert.equal(s.ios.state, 'unknown');
  assert.equal(s.warnings.join(' ').includes('no longer exists'), false);
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

// rn-iso reported RAM commitment and said nothing about disk. Disk is what
// actually ran out: a full volume stopped every command, including the `gc`
// that exists to reclaim space.
test('parseDfFree reads the available and total columns from df -k', () => {
  const out = [
    'Filesystem   1024-blocks       Used  Available Capacity iused ifree %iused  Mounted on',
    '/dev/disk3s5   970989436  776862512  164363576    83%    12M  1.6G    1%   /',
  ].join('\n');
  assert.deepEqual(parseDfFree(out), {
    availableMb: Math.round(164363576 / 1024),
    totalMb: Math.round(970989436 / 1024),
  });
});

// A volume name can contain spaces, so the columns are counted from the
// capacity percentage rightwards rather than by splitting on whitespace.
test('a filesystem name containing spaces still parses', () => {
  const out = [
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    'my volume name 2097152 1048576 1048576 50% /Volumes/x',
  ].join('\n');
  assert.deepEqual(parseDfFree(out), { availableMb: 1024, totalMb: 2048 });
});

test('unreadable df output is null, never a guess', () => {
  assert.equal(parseDfFree(''), null);
  assert.equal(parseDfFree(null), null);
  assert.equal(parseDfFree('Filesystem 1024-blocks Used Available Capacity'), null);
});

test('a nearly full disk is flagged before a build discovers it', () => {
  assert.equal(diskIsTight({ availableMb: 5 * 1024, totalMb: 900 * 1024 }), true);
  assert.equal(diskIsTight({ availableMb: 190 * 1024, totalMb: 900 * 1024 }), false);
  assert.equal(diskIsTight(null), false);
});

// --- v3: the supervisor and the log timeline --------------------------------
//
// Both arrive as facts the caller gathered, keeping this module pure: `healthy`
// is already the answer to "pid alive AND resolveProjectMetro says the thing on
// its port is ours", not something re-derived here.

test('a healthy supervisor is reported with its pid, mode and start time', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: BOOTED },
    metro: { metro: { pid: 42, leader: 42, cwd: '/proj/a' } },
    supervisor: { pid: 4242, mode: 'bare-inproc', startedAt: 1700000000000, alive: true, healthy: true },
  });
  assert.deepEqual(s.supervisor, { pid: 4242, mode: 'bare-inproc', startedAt: 1700000000000, healthy: true });
  assert.equal(s.warnings.join(' ').includes('stale supervisor'), false);
});

// A registration whose process is gone is what `start` would otherwise treat as
// "already running", and what `worktree remove` would go looking for. Nothing
// else on the machine reports it.
test('a supervisor record whose pid is dead is warned about as stale', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: SHUTDOWN },
    metro: { missing: true },
    supervisor: { pid: 4242, mode: 'expo-child', startedAt: 5, alive: false, healthy: false },
  });
  assert.equal(s.supervisor.healthy, false);
  assert.match(s.warnings.join(' '), /stale supervisor record for \/proj\/a/);
});

// Alive but not answering on its port is a supervisor that is starting up or
// wedged -- reported as unhealthy, but NOT as a stale record, because the pid
// is real and killing it is still `stop`'s job.
test('a live supervisor that is not answering is unhealthy but not stale', () => {
  const s = environmentState(project(), {
    metro: { missing: true },
    supervisor: { pid: 4242, mode: 'expo-child', startedAt: 5, alive: true, healthy: false },
  });
  assert.equal(s.supervisor.healthy, false);
  assert.equal(s.warnings.join(' ').includes('stale supervisor'), false);
});

test('no supervisor recorded reports null, not an absent field', () => {
  const s = environmentState(project(), { metro: { missing: true } });
  assert.equal(s.supervisor, null);
  assert.equal('supervisor' in s, true);
});

test('the log timeline is reported with the error count since the last marker', () => {
  const s = environmentState(project(), {
    metro: { missing: true },
    logs: { dir: '/proj/a/.rn-iso/logs', errorsSinceMarker: 3 },
  });
  assert.deepEqual(s.logs, { dir: '/proj/a/.rn-iso/logs', errorsSinceMarker: 3 });
});

test('a workspace with no log directory reports logs as null', () => {
  const s = environmentState(project(), { metro: { missing: true } });
  assert.equal(s.logs, null);
});

// The existing payload is a contract other tooling reads. Adding fields must
// not move or drop one.
test('every pre-v3 field survives the extension', () => {
  const s = environmentState(project(), {
    simsByUdid: { U1: BOOTED },
    metro: { metro: { pid: 42, leader: 42, cwd: '/proj/a' } },
    supervisor: { pid: 4242, mode: 'bare-inproc', startedAt: 5, alive: true, healthy: true },
    logs: { dir: '/proj/a/.rn-iso/logs', errorsSinceMarker: 0 },
  });
  for (const key of ['path', 'live', 'memoryMb', 'warnings', 'ios', 'android', 'metro', 'worktree']) {
    assert.equal(key in s, true, `${key} must still be reported`);
  }
  assert.equal(s.metro.port, 8082);
  assert.equal(s.ios.udid, 'U1');
});

// The disk line reported the boot volume and only the boot volume. On a machine
// whose repos live on an external SSD that is the wrong number twice: it
// describes a volume nothing is building on, and the volume that can actually
// fill up (build output is workspace-local) goes unmentioned.
test('one volume keeps the free-of-total form', () => {
  assert.equal(
    diskLine([{ volume: '/', disk: { availableMb: 38 * 1024, totalMb: 926 * 1024 } }]),
    '38 GB free of 926 GB on disk.'
  );
});

test('a project on another volume gets both volumes, named', () => {
  assert.equal(
    diskLine([
      { volume: '/', disk: { availableMb: 38 * 1024, totalMb: 926 * 1024 } },
      { volume: '/Volumes/ExternalSSD', disk: { availableMb: Math.round(1.5 * 1024 * 1024), totalMb: 2 * 1024 * 1024 } },
    ]),
    '38 GB free on /, 1.5 TB free on /Volumes/ExternalSSD.'
  );
});

test('an unreadable df prints no disk line at all rather than a broken one', () => {
  assert.equal(diskLine([]), null);
  assert.equal(diskLine(null), null);
  assert.equal(diskLine([{ volume: '/', disk: null }]), null);
});

test('formatSpace changes scale where the number stops being readable', () => {
  assert.equal(formatSpace(512), '512 MB');
  assert.equal(formatSpace(38 * 1024), '38 GB');
  assert.equal(formatSpace(1024 * 1024), '1.0 TB');
  assert.equal(formatSpace(NaN), '?');
});

// The warning has to name WHICH volume is tight, or a two-volume line leaves
// the reader guessing which of the two numbers it is about.
test('tightVolumes names only the volumes that are actually tight', () => {
  const volumes = [
    { volume: '/', disk: { availableMb: 5 * 1024, totalMb: 926 * 1024 } },
    { volume: '/Volumes/ExternalSSD', disk: { availableMb: 900 * 1024, totalMb: 2048 * 1024 } },
  ];
  assert.deepEqual(tightVolumes(volumes).map(v => v.volume), ['/']);
  assert.deepEqual(tightVolumes([]), []);
});
