// src/engine/build-lock.js -- single-flight builds.
//
// Three agents on one commit currently pay for the same 19-minute build three
// times. The lock is what makes exactly one of them compile it while the other
// two wait for the artifact and install it.
//
// What is pinned here:
//   1. THE PRIMITIVE. mkdirSync is atomic on every filesystem rn-iso runs on
//      (the same rationale src/config.js's withConfigLock is built on), so the
//      winner of a race is decided by the kernel and not by a check-then-act.
//   2. STALENESS IS PID-LIVENESS, never mtime. A build legitimately runs for
//      20+ minutes, so an age-based takeover would hand a second workspace the
//      lock while the first is still compiling. A lock whose pid is dead is
//      stale, and nothing else is.
//   3. THE WAIT'S OUTCOMES. The artifact appearing IS the completion signal --
//      a released lock with no artifact means the builder failed, and the
//      waiter takes over rather than waiting forever for a build that is not
//      coming.
//   4. A REAL RACE, in real processes, against a real filesystem (CLAUDE.md
//      item 9): a mocked mkdir cannot prove two processes cannot both win.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  acquireBuildLock,
  buildLockPath,
  buildLocksDir,
  listBuildLocks,
  readBuildLock,
  releaseBuildLock,
  waitForBuild,
  waitingLine,
} from '../src/engine/build-lock.js';

const PLATFORM = 'ios';
const KEY = 'a3f9b1c2d3e4f5-debug-sim';

let home;
let root;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rn-iso-home-'));
  process.env.RN_ISO_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'rn-iso-ws-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

const spec = (over = {}) => ({ platform: PLATFORM, key: KEY, root, logFile: join(root, 'build.ndjson'), ...over });

// --- the path ---------------------------------------------------------------

describe('where the lock lives', () => {
  test('is a directory under the config dir, named by platform and cache key', () => {
    assert.equal(buildLocksDir(), join(home, 'build-locks'));
    assert.equal(buildLockPath(PLATFORM, KEY), join(home, 'build-locks', `ios-${KEY}.lock`));
  });

  // RN_ISO_HOME redirects it along with everything else, which is what lets
  // these tests -- and a rehearsal run -- race against a throwaway home.
  test('follows RN_ISO_HOME', () => {
    process.env.RN_ISO_HOME = join(home, 'elsewhere');
    assert.equal(buildLocksDir(), join(home, 'elsewhere', 'build-locks'));
  });

  // The key is composed by this codebase, but a lock path is a filesystem
  // write: a separator in either half must never climb out of the lock dir.
  test('a separator in the key cannot escape the lock directory', () => {
    const path = buildLockPath('ios', '../../etc/passwd');
    // One segment, directly inside the lock directory: the separators are gone,
    // so what is left cannot traverse anywhere even though it still reads as
    // the key someone passed.
    assert.equal(dirname(path), join(home, 'build-locks'));
    assert.ok(!basename(path).includes('/'), path);
    assert.equal(acquireBuildLock(spec({ key: '../../etc/passwd' })).acquired, true);
    assert.equal(existsSync(join(home, 'build-locks')), true);
  });
});

// --- acquire / held / release ----------------------------------------------

describe('acquireBuildLock', () => {
  test('creates the lock and records who holds it', () => {
    const got = acquireBuildLock(spec());
    assert.equal(got.acquired, true);
    assert.equal(got.path, buildLockPath(PLATFORM, KEY));

    const info = readBuildLock(got.path);
    assert.equal(info.pid, process.pid);
    assert.equal(info.projectRoot, root);
    assert.equal(info.logFile, join(root, 'build.ndjson'));
    assert.ok(Date.parse(info.startedAt) > 0, 'startedAt is an ISO timestamp');
  });

  // The whole point: the second caller is TOLD who is building, so it can say
  // so and tail the right log rather than compiling the same thing again.
  test('a second acquire reports the holder rather than acquiring', () => {
    acquireBuildLock(spec());
    const second = acquireBuildLock(spec({ root: '/other/worktree' }));
    assert.equal(second.acquired, undefined);
    assert.deepEqual(second.held, {
      pid: process.pid,
      projectRoot: root,
      startedAt: second.held.startedAt,
      logFile: join(root, 'build.ndjson'),
    });
  });

  test('a different platform or key is a different lock', () => {
    acquireBuildLock(spec());
    assert.equal(acquireBuildLock(spec({ platform: 'android' })).acquired, true);
    assert.equal(acquireBuildLock(spec({ key: 'other-debug-sim' })).acquired, true);
  });

  // A 20-minute xcodebuild is NORMAL. If staleness were mtime-based the way
  // the config lock's is, the second workspace would take the lock at minute
  // ten and both would compile -- which is the bug this whole file exists to
  // prevent.
  test('an OLD lock held by a LIVE pid is not stale', () => {
    const got = acquireBuildLock(spec());
    const longAgo = new Date(Date.now() - 45 * 60 * 1000);
    utimesSync(got.path, longAgo, longAgo);
    const second = acquireBuildLock(spec());
    assert.equal(second.acquired, undefined, '45 minutes into a build is not a stale lock');
    assert.equal(second.held.pid, process.pid);
  });

  test('a lock held by a DEAD pid is taken over', () => {
    const path = buildLockPath(PLATFORM, KEY);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'lock.json'), JSON.stringify({
      pid: 999999, projectRoot: '/gone/worktree', startedAt: new Date().toISOString(), logFile: '/gone/build.ndjson',
    }));

    const got = acquireBuildLock(spec({ isAlive: () => false }));
    assert.equal(got.acquired, true);
    assert.equal(readBuildLock(path).pid, process.pid, 'the record is ours now');
  });

  // A process killed between the mkdir and the write leaves a lock nothing can
  // identify. Waiting on it forever would wedge every later build on this
  // fingerprint, so it ages out -- this is the ONE place an age is consulted,
  // and only because there is no pid to ask about.
  test('a lock with no lock.json at all is taken over once it has aged', () => {
    const path = buildLockPath(PLATFORM, KEY);
    mkdirSync(path, { recursive: true });
    const longAgo = new Date(Date.now() - 60 * 1000);
    utimesSync(path, longAgo, longAgo);

    const got = acquireBuildLock(spec());
    assert.equal(got.acquired, true);
    assert.equal(readBuildLock(path).pid, process.pid);
  });

  test('releaseBuildLock removes the lock and is safe to repeat', () => {
    const got = acquireBuildLock(spec());
    assert.equal(releaseBuildLock(got), true);
    assert.equal(existsSync(got.path), false);
    assert.equal(releaseBuildLock(got), true, 'releasing twice is not an error');
    assert.equal(acquireBuildLock(spec()).acquired, true, 'the next builder gets it');
  });

  // The counterpart of the takeover rule: once another process has decided our
  // lock was stale and re-created it, the rmSync we run on the way out would
  // delete a lock that is now someone else's, and TWO builders would compile.
  test('releaseBuildLock refuses to remove a lock another pid took over', () => {
    const got = acquireBuildLock(spec());
    writeFileSync(join(got.path, 'lock.json'), JSON.stringify({
      pid: 424242, projectRoot: '/another/worktree', startedAt: new Date().toISOString(), logFile: null,
    }));
    assert.equal(releaseBuildLock(got), false);
    assert.equal(existsSync(got.path), true, 'the new holder keeps its lock');
  });

  // A failed build must free its waiters. `finally` is how the commands do it;
  // this is the same guarantee at the unit level.
  test('a throw inside a finally-wrapped build still releases', () => {
    const got = acquireBuildLock(spec());
    assert.throws(() => {
      try {
        throw new Error('xcodebuild exploded');
      } finally {
        releaseBuildLock(got);
      }
    }, /exploded/);
    assert.equal(existsSync(got.path), false);
  });
});

// --- listing (what gc reports) ---------------------------------------------

describe('listBuildLocks', () => {
  test('is empty when nothing has ever built', () => {
    assert.deepEqual(listBuildLocks(), []);
  });

  test('classifies each lock by whether its builder is still alive', () => {
    acquireBuildLock(spec());
    const dead = buildLockPath('android', 'deadkey-debug-sim');
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, 'lock.json'), JSON.stringify({
      pid: 999999, projectRoot: '/gone/worktree', startedAt: '2026-08-25T10:00:00.000Z', logFile: '/gone/b.ndjson',
    }));

    const locks = listBuildLocks({ isAlive: (pid) => pid === process.pid });
    assert.equal(locks.length, 2);
    const live = locks.find((l) => l.alive);
    const stale = locks.find((l) => !l.alive);
    assert.equal(live.platform, 'ios');
    assert.equal(live.key, KEY);
    assert.equal(live.projectRoot, root);
    assert.equal(stale.platform, 'android');
    assert.equal(stale.pid, 999999);
    assert.equal(stale.path, dead);
  });

  // A directory somebody dropped in by hand is not a lock. Reporting it as a
  // stale one would have `gc --delete` removing files it never wrote.
  test('a lock directory with unreadable json is listed with a null pid, not skipped', () => {
    const path = buildLockPath(PLATFORM, KEY);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'lock.json'), 'not json');
    const [lock] = listBuildLocks();
    assert.equal(lock.pid, null);
    assert.equal(lock.alive, false, 'nothing can be proven to hold it, so it is stale');
  });
});

// --- the wait ---------------------------------------------------------------

describe('waitForBuild', () => {
  const held = { pid: process.pid, projectRoot: '/other/worktree', startedAt: new Date().toISOString(), logFile: '/other/build.ndjson' };

  function lockOn(info = held) {
    const path = buildLockPath(PLATFORM, KEY);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'lock.json'), JSON.stringify(info));
    return path;
  }

  const opts = (over = {}) => ({
    platform: PLATFORM,
    key: KEY,
    intervalMs: 1,
    sleep: async () => {},
    ...over,
  });

  // The artifact is the completion signal, not the lock's disappearance: the
  // builder stores THEN releases, so an artifact can be there while the lock
  // still is, and a waiter that keyed on the lock would sit through the gap.
  test('an artifact appearing is the hit, and it says how long the wait cost', async () => {
    lockOn();
    let polls = 0;
    let clock = 1000;
    const result = await waitForBuild(opts({
      resolve: () => (++polls < 3 ? null : '/cache/ios/key/Fixture.app'),
      isAlive: () => true,
      now: () => (clock += 5000),
    }));
    assert.equal(result.hit, '/cache/ios/key/Fixture.app');
    assert.ok(result.waitedMs > 0, 'the wait is measured');
    assert.equal(polls, 3);
  });

  test('the lock disappearing with no artifact means the builder failed', async () => {
    lockOn();
    const path = buildLockPath(PLATFORM, KEY);
    let polls = 0;
    const result = await waitForBuild(opts({
      resolve: () => null,
      isAlive: () => true,
      sleep: async () => { if (++polls === 1) rmSync(path, { recursive: true, force: true }); },
    }));
    assert.equal(result.hit, undefined);
    assert.ok(result.builderFailed, 'the caller is told to take over');
    assert.match(result.builderFailed, /lock/i);
  });

  test('a dead builder means the same, without waiting for the lock to go', async () => {
    lockOn();
    const result = await waitForBuild(opts({ resolve: () => null, isAlive: () => false }));
    assert.ok(result.builderFailed);
    assert.match(result.builderFailed, /pid/i);
  });

  // The race the artifact-first ordering exists to close: the builder stored
  // its artifact and released between our two checks. That is a HIT, not a
  // failed build -- reporting it as a failure would have the waiter recompile
  // something that is sitting in the cache.
  test('an artifact that lands as the lock is released is still a hit', async () => {
    const path = lockOn();
    let stored = null;
    const result = await waitForBuild(opts({
      resolve: () => stored,
      isAlive: () => true,
      sleep: async () => {
        stored = '/cache/ios/key/Fixture.app';
        rmSync(path, { recursive: true, force: true });
      },
    }));
    assert.equal(result.hit, '/cache/ios/key/Fixture.app');
  });

  test('there is no wait at all when the artifact is already there', async () => {
    lockOn();
    let slept = 0;
    const result = await waitForBuild(opts({
      resolve: () => '/cache/ios/key/Fixture.app',
      isAlive: () => true,
      sleep: async () => { slept++; },
    }));
    assert.equal(result.hit, '/cache/ios/key/Fixture.app');
    assert.equal(slept, 0);
  });

  // Silence for nineteen minutes is indistinguishable from a hang. The line
  // names the pid to check and the log to tail, so the wait is auditable from
  // another terminal.
  test('emits a progress line about every 30s, naming the holder and its log', async () => {
    lockOn();
    let clock = 0;
    const lines = [];
    let polls = 0;
    await waitForBuild(opts({
      resolve: () => (++polls < 200 ? null : '/cache/ios/key/Fixture.app'),
      isAlive: () => true,
      now: () => (clock += 1000),
      out: (l) => lines.push(l),
    }));
    assert.ok(lines.length >= 5, `expected periodic progress, got ${lines.length}`);
    assert.ok(lines.length < 20, `progress must not be per-poll, got ${lines.length}`);
    assert.match(lines[0], /^build\s+waiting on \/other\/worktree \(pid \d+, .+ elapsed\) -- tail \/other\/build\.ndjson$/);
  });

  // pid-liveness is the real guard; the ceiling is only there so a builder
  // that is alive but wedged cannot hold an agent forever. It names the lock
  // path because removing that directory is the whole remedy.
  test('a generous ceiling ends the wait with a structured error naming the lock', async () => {
    const path = lockOn();
    let clock = 0;
    await assert.rejects(
      () => waitForBuild(opts({
        resolve: () => null,
        isAlive: () => true,
        now: () => (clock += 60 * 1000),
        ceilingMs: 90 * 60 * 1000,
      })),
      (err) => {
        assert.equal(err.code, 'RN_ISO_BUILD_WAIT_TIMEOUT');
        assert.equal(err.lockPath, path);
        assert.match(err.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      }
    );
  });
});

describe('waitingLine', () => {
  test('is one phase line, in the same column as every other', () => {
    const line = waitingLine({ projectRoot: '/w/app-412', pid: 41233, elapsedMs: 8 * 60 * 1000, logFile: '/w/app-412/.rn-iso/logs/build-ios.ndjson' });
    assert.equal(line, 'build       waiting on /w/app-412 (pid 41233, 8m elapsed) -- tail /w/app-412/.rn-iso/logs/build-ios.ndjson');
  });

  test('reads in seconds before the first minute is up', () => {
    assert.match(waitingLine({ projectRoot: '/w', pid: 1, elapsedMs: 30000, logFile: '/l' }), /30s elapsed/);
  });

  test('says so when the holder recorded no log file', () => {
    const line = waitingLine({ projectRoot: '/w', pid: 1, elapsedMs: 1000, logFile: null });
    assert.ok(!line.includes('tail'), line);
  });
});

// --- the real race ----------------------------------------------------------
//
// CLAUDE.md item 9: a mocked filesystem proves the branches, not the
// exclusion. Everything below runs in real child processes against a real
// directory, because "exactly one wins" is a claim about the kernel.

describe('a real race between real processes', () => {
  const LOCK_URL = new URL('../src/engine/build-lock.js', import.meta.url).href;
  const CACHE_URL = new URL('../src/build-cache.js', import.meta.url).href;

  function script(name, body) {
    const path = join(root, name);
    writeFileSync(path, body);
    return path;
  }

  function runNode(path, args = [], env = {}) {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [path, ...args], {
        env: { ...process.env, RN_ISO_HOME: home, ...env },
        timeout: 60000,
      }, (err, stdout, stderr) => {
        if (err && err.code === undefined) return reject(err);
        resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  test('exactly one of six processes acquires the same lock', async () => {
    const racer = script('racer.mjs', [
      `const { acquireBuildLock } = await import(${JSON.stringify(LOCK_URL)});`,
      'const got = acquireBuildLock({',
      '  platform: "ios", key: process.argv[2], root: `/worktree/${process.argv[3]}`,',
      '  logFile: `/worktree/${process.argv[3]}/build.ndjson`,',
      '});',
      // Held long enough that every sibling has certainly reached the mkdir.
      'await new Promise(r => setTimeout(r, 1500));',
      'console.log(JSON.stringify({ pid: process.pid, ...got }));',
    ].join('\n'));

    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map(name => runNode(racer, ['race-debug-sim', name]))
    );
    const answers = results.map(r => JSON.parse(r.stdout.trim()));
    const winners = answers.filter(a => a.acquired);
    const losers = answers.filter(a => a.held);

    assert.equal(winners.length, 1, `exactly one builder: ${JSON.stringify(answers.map(a => a.acquired ?? a.held?.pid))}`);
    assert.equal(losers.length, 5);
    for (const loser of losers) {
      assert.equal(loser.held.pid, winners[0].pid, 'every loser names the one real builder');
      assert.match(loser.held.projectRoot, /^\/worktree\//);
    }
    // The winner's record is still on disk: nothing released it.
    assert.equal(readBuildLock(buildLockPath('ios', 'race-debug-sim')).pid, winners[0].pid);
  });

  // The whole chain, end to end, in two processes: one holds the lock,
  // compiles (a sleep and a real directory), stores into the real cache and
  // releases; the other waits and installs what appeared.
  test('a waiter resolves the artifact the builder stores', async () => {
    const key = 'shared-debug-sim';
    const builder = script('builder.mjs', [
      `const { acquireBuildLock, releaseBuildLock } = await import(${JSON.stringify(LOCK_URL)});`,
      `const { storeBuild } = await import(${JSON.stringify(CACHE_URL)});`,
      'const { mkdirSync, writeFileSync } = await import("node:fs");',
      'const { join } = await import("node:path");',
      `const got = acquireBuildLock({ platform: "ios", key: ${JSON.stringify(key)}, root: process.argv[2], logFile: join(process.argv[2], "build.ndjson") });`,
      'if (!got.acquired) { console.log(JSON.stringify({ raced: true })); process.exit(0); }',
      'try {',
      '  await new Promise(r => setTimeout(r, 900));',   // the "build"
      '  const app = join(process.argv[2], "Fixture.app");',
      '  mkdirSync(app, { recursive: true });',
      '  writeFileSync(join(app, "Fixture"), "binary");',
      `  const stored = storeBuild("ios", ${JSON.stringify(key)}, app);`,
      '  console.log(JSON.stringify({ built: true, stored }));',
      '} finally {',
      '  releaseBuildLock(got);',
      '}',
    ].join('\n'));

    const waiter = script('waiter.mjs', [
      `const { acquireBuildLock, waitForBuild } = await import(${JSON.stringify(LOCK_URL)});`,
      `const got = acquireBuildLock({ platform: "ios", key: ${JSON.stringify(key)}, root: process.argv[2], logFile: null });`,
      'if (got.acquired) { console.log(JSON.stringify({ wonInstead: true })); process.exit(0); }',
      `const result = await waitForBuild({ platform: "ios", key: ${JSON.stringify(key)}, intervalMs: 50, out: (l) => console.error(l) });`,
      'console.log(JSON.stringify({ ...result, held: got.held }));',
    ].join('\n'));

    const buildRoot = join(root, 'builder');
    mkdirSync(buildRoot, { recursive: true });
    const started = runNode(builder, [buildRoot]);
    // Give the builder the lock first: this test is about the WAITER's path,
    // and the race itself is the test above.
    await new Promise(r => setTimeout(r, 300));
    const [built, waited] = await Promise.all([started, runNode(waiter, [join(root, 'waiter')])]);

    const builderOut = JSON.parse(built.stdout.trim());
    assert.equal(builderOut.built, true, built.stderr);
    const waiterOut = JSON.parse(waited.stdout.trim());
    assert.equal(waiterOut.wonInstead, undefined, 'the waiter must not have taken the lock');
    assert.equal(waiterOut.hit, builderOut.stored, 'both processes resolve the same cache entry');
    assert.ok(waiterOut.waitedMs >= 0);
    assert.ok(existsSync(join(waiterOut.hit, 'Fixture')), 'the artifact is real');
    // The builder released in its finally, so the next build on this
    // fingerprint is not blocked behind a lock nobody holds.
    assert.equal(existsSync(buildLockPath('ios', key)), false);
  });

  // A builder that is SIGKILLed releases nothing. pid-liveness is what keeps
  // that from wedging every other workspace on the fingerprint.
  test('a builder killed mid-build leaves a lock the waiter takes over', async () => {
    const key = 'crash-debug-sim';
    const suicide = script('suicide.mjs', [
      `const { acquireBuildLock } = await import(${JSON.stringify(LOCK_URL)});`,
      `const got = acquireBuildLock({ platform: "ios", key: ${JSON.stringify(key)}, root: "/worktree/doomed", logFile: "/worktree/doomed/build.ndjson" });`,
      'console.log(JSON.stringify(got));',
      'process.kill(process.pid, "SIGKILL");',
    ].join('\n'));

    const dead = await runNode(suicide);
    assert.equal(JSON.parse(dead.stdout.trim()).acquired, true);
    assert.equal(existsSync(buildLockPath('ios', key)), true, 'the lock outlives the process');

    const result = await waitForBuild({ platform: 'ios', key, intervalMs: 10 });
    assert.ok(result.builderFailed, 'a dead builder is not something to wait for');

    const takeover = acquireBuildLock({ platform: 'ios', key, root, logFile: null });
    assert.equal(takeover.acquired, true);
    assert.equal(readBuildLock(takeover.path).pid, process.pid);
  });
});

// gc --delete acts on what listBuildLocks reports, so the list must never
// contain something rn-iso did not write.
test('a stray file with a .lock name is not reported as a lock', () => {
  mkdirSync(buildLocksDir(), { recursive: true });
  writeFileSync(join(buildLocksDir(), 'ios-not-a-lock.lock'), 'a file, not a directory');
  assert.deepEqual(listBuildLocks(), []);
});
