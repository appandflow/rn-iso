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
} from '../engine/build-lock.ts';

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
    expect(buildLocksDir()).toBe(join(home, 'build-locks'));
    expect(buildLockPath(PLATFORM, KEY)).toBe(join(home, 'build-locks', `ios-${KEY}.lock`));
  });

  // RN_ISO_HOME redirects it along with everything else, which is what lets
  // these tests -- and a rehearsal run -- race against a throwaway home.
  test('follows RN_ISO_HOME', () => {
    process.env.RN_ISO_HOME = join(home, 'elsewhere');
    expect(buildLocksDir()).toBe(join(home, 'elsewhere', 'build-locks'));
  });

  // The key is composed by this codebase, but a lock path is a filesystem
  // write: a separator in either half must never climb out of the lock dir.
  test('a separator in the key cannot escape the lock directory', () => {
    const path = buildLockPath('ios', '../../etc/passwd');
    // One segment, directly inside the lock directory: the separators are gone,
    // so what is left cannot traverse anywhere even though it still reads as
    // the key someone passed.
    expect(dirname(path)).toBe(join(home, 'build-locks'));
    expect(!basename(path).includes('/')).toBeTruthy();
    expect(acquireBuildLock(spec({ key: '../../etc/passwd' })).acquired).toBe(true);
    expect(existsSync(join(home, 'build-locks'))).toBe(true);
  });
});

// --- acquire / held / release ----------------------------------------------

describe('acquireBuildLock', () => {
  test('creates the lock and records who holds it', () => {
    const got = acquireBuildLock(spec());
    expect(got.acquired).toBe(true);
    expect(got.path).toBe(buildLockPath(PLATFORM, KEY));

    const info = readBuildLock(got.path);
    expect(info.pid).toBe(process.pid);
    expect(info.projectRoot).toBe(root);
    expect(info.logFile).toBe(join(root, 'build.ndjson'));
    expect(Date.parse(info.startedAt) > 0).toBeTruthy();
  });

  // The whole point: the second caller is TOLD who is building, so it can say
  // so and tail the right log rather than compiling the same thing again.
  test('a second acquire reports the holder rather than acquiring', () => {
    acquireBuildLock(spec());
    const second = acquireBuildLock(spec({ root: '/other/worktree' }));
    expect(second.acquired).toBe(undefined);
    expect(second.held).toEqual({
      pid: process.pid,
      projectRoot: root,
      startedAt: second.held.startedAt,
      logFile: join(root, 'build.ndjson'),
    });
  });

  test('a different platform or key is a different lock', () => {
    acquireBuildLock(spec());
    expect(acquireBuildLock(spec({ platform: 'android' })).acquired).toBe(true);
    expect(acquireBuildLock(spec({ key: 'other-debug-sim' })).acquired).toBe(true);
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
    expect(second.acquired).toBe(undefined);
    expect(second.held.pid).toBe(process.pid);
  });

  test('a lock held by a DEAD pid is taken over', () => {
    const path = buildLockPath(PLATFORM, KEY);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'lock.json'), JSON.stringify({
      pid: 999999, projectRoot: '/gone/worktree', startedAt: new Date().toISOString(), logFile: '/gone/build.ndjson',
    }));

    const got = acquireBuildLock(spec({ isAlive: () => false }));
    expect(got.acquired).toBe(true);
    expect(readBuildLock(path).pid).toBe(process.pid);
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
    expect(got.acquired).toBe(true);
    expect(readBuildLock(path).pid).toBe(process.pid);
  });

  test('releaseBuildLock removes the lock and is safe to repeat', () => {
    const got = acquireBuildLock(spec());
    expect(releaseBuildLock(got)).toBe(true);
    expect(existsSync(got.path)).toBe(false);
    expect(releaseBuildLock(got)).toBe(true);
    expect(acquireBuildLock(spec()).acquired).toBe(true);
  });

  // The counterpart of the takeover rule: once another process has decided our
  // lock was stale and re-created it, the rmSync we run on the way out would
  // delete a lock that is now someone else's, and TWO builders would compile.
  test('releaseBuildLock refuses to remove a lock another pid took over', () => {
    const got = acquireBuildLock(spec());
    writeFileSync(join(got.path, 'lock.json'), JSON.stringify({
      pid: 424242, projectRoot: '/another/worktree', startedAt: new Date().toISOString(), logFile: null,
    }));
    expect(releaseBuildLock(got)).toBe(false);
    expect(existsSync(got.path)).toBe(true);
  });

  // A failed build must free its waiters. `finally` is how the commands do it;
  // this is the same guarantee at the unit level.
  test('a throw inside a finally-wrapped build still releases', () => {
    const got = acquireBuildLock(spec());
    expect(() => {
      try {
        throw new Error('xcodebuild exploded');
      } finally {
        releaseBuildLock(got);
      }
    }).toThrow(/exploded/);
    expect(existsSync(got.path)).toBe(false);
  });
});

// --- listing (what gc reports) ---------------------------------------------

describe('listBuildLocks', () => {
  test('is empty when nothing has ever built', () => {
    expect(listBuildLocks()).toEqual([]);
  });

  test('classifies each lock by whether its builder is still alive', () => {
    acquireBuildLock(spec());
    const dead = buildLockPath('android', 'deadkey-debug-sim');
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, 'lock.json'), JSON.stringify({
      pid: 999999, projectRoot: '/gone/worktree', startedAt: '2026-08-25T10:00:00.000Z', logFile: '/gone/b.ndjson',
    }));

    const locks = listBuildLocks({ isAlive: (pid) => pid === process.pid });
    expect(locks.length).toBe(2);
    const live = locks.find((l) => l.alive);
    const stale = locks.find((l) => !l.alive);
    expect(live.platform).toBe('ios');
    expect(live.key).toBe(KEY);
    expect(live.projectRoot).toBe(root);
    expect(stale.platform).toBe('android');
    expect(stale.pid).toBe(999999);
    expect(stale.path).toBe(dead);
  });

  // A directory somebody dropped in by hand is not a lock. Reporting it as a
  // stale one would have `gc --delete` removing files it never wrote.
  test('a lock directory with unreadable json is listed with a null pid, not skipped', () => {
    const path = buildLockPath(PLATFORM, KEY);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'lock.json'), 'not json');
    const [lock] = listBuildLocks();
    expect(lock.pid).toBe(null);
    expect(lock.alive).toBe(false);
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
    expect(result.hit).toBe('/cache/ios/key/Fixture.app');
    expect(result.waitedMs > 0).toBeTruthy();
    expect(polls).toBe(3);
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
    expect(result.hit).toBe(undefined);
    expect(result.builderFailed).toBeTruthy();
    expect(result.builderFailed).toMatch(/lock/i);
  });

  test('a dead builder means the same, without waiting for the lock to go', async () => {
    lockOn();
    const result = await waitForBuild(opts({ resolve: () => null, isAlive: () => false }));
    expect(result.builderFailed).toBeTruthy();
    expect(result.builderFailed).toMatch(/pid/i);
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
    expect(result.hit).toBe('/cache/ios/key/Fixture.app');
  });

  test('there is no wait at all when the artifact is already there', async () => {
    lockOn();
    let slept = 0;
    const result = await waitForBuild(opts({
      resolve: () => '/cache/ios/key/Fixture.app',
      isAlive: () => true,
      sleep: async () => { slept++; },
    }));
    expect(result.hit).toBe('/cache/ios/key/Fixture.app');
    expect(slept).toBe(0);
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
    expect(lines.length >= 5).toBeTruthy();
    expect(lines.length < 20).toBeTruthy();
    expect(lines[0]).toMatch(/^build\s+waiting on \/other\/worktree \(pid \d+, .+ elapsed\) -- tail \/other\/build\.ndjson$/);
  });

  // pid-liveness is the real guard; the ceiling is only there so a builder
  // that is alive but wedged cannot hold an agent forever. It names the lock
  // path because removing that directory is the whole remedy.
  test('a generous ceiling ends the wait with a structured error naming the lock', async () => {
    const path = lockOn();
    let clock = 0;
    let err: any;
    try {
      await waitForBuild(opts({
        resolve: () => null,
        isAlive: () => true,
        now: () => (clock += 60 * 1000),
        ceilingMs: 90 * 60 * 1000,
      }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('RN_ISO_BUILD_WAIT_TIMEOUT');
    expect(err.lockPath).toBe(path);
    expect(err.message).toMatch(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('waitingLine', () => {
  test('is one phase line, in the same column as every other', () => {
    const line = waitingLine({ projectRoot: '/w/app-412', pid: 41233, elapsedMs: 8 * 60 * 1000, logFile: '/w/app-412/.rn-iso/logs/build-ios.ndjson' });
    expect(line).toBe('build       waiting on /w/app-412 (pid 41233, 8m elapsed) -- tail /w/app-412/.rn-iso/logs/build-ios.ndjson');
  });

  test('reads in seconds before the first minute is up', () => {
    expect(waitingLine({ projectRoot: '/w', pid: 1, elapsedMs: 30000, logFile: '/l' })).toMatch(/30s elapsed/);
  });

  test('says so when the holder recorded no log file', () => {
    const line = waitingLine({ projectRoot: '/w', pid: 1, elapsedMs: 1000, logFile: null });
    expect(!line.includes('tail')).toBeTruthy();
  });
});

// --- the real race ----------------------------------------------------------
//
// CLAUDE.md item 9: a mocked filesystem proves the branches, not the
// exclusion. Everything below runs in real child processes against a real
// directory, because "exactly one wins" is a claim about the kernel.

describe('a real race between real processes', () => {
  const LOCK_URL = new URL('../engine/build-lock.ts', import.meta.url).href;
  const CACHE_URL = new URL('../build-cache.ts', import.meta.url).href;

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

    expect(winners.length).toBe(1);
    expect(losers.length).toBe(5);
    for (const loser of losers) {
      expect(loser.held.pid).toBe(winners[0].pid);
      expect(loser.held.projectRoot).toMatch(/^\/worktree\//);
    }
    // The winner's record is still on disk: nothing released it.
    expect(readBuildLock(buildLockPath('ios', 'race-debug-sim')).pid).toBe(winners[0].pid);
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
    expect(builderOut.built).toBe(true);
    const waiterOut = JSON.parse(waited.stdout.trim());
    expect(waiterOut.wonInstead).toBe(undefined);
    expect(waiterOut.hit).toBe(builderOut.stored);
    expect(waiterOut.waitedMs >= 0).toBeTruthy();
    expect(existsSync(join(waiterOut.hit, 'Fixture'))).toBeTruthy();
    // The builder released in its finally, so the next build on this
    // fingerprint is not blocked behind a lock nobody holds.
    expect(existsSync(buildLockPath('ios', key))).toBe(false);
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
    expect(JSON.parse(dead.stdout.trim()).acquired).toBe(true);
    expect(existsSync(buildLockPath('ios', key))).toBe(true);

    const result = await waitForBuild({ platform: 'ios', key, intervalMs: 10 });
    expect(result.builderFailed).toBeTruthy();

    const takeover = acquireBuildLock({ platform: 'ios', key, root, logFile: null });
    expect(takeover.acquired).toBe(true);
    expect(readBuildLock(takeover.path).pid).toBe(process.pid);
  });
});

// gc --delete acts on what listBuildLocks reports, so the list must never
// contain something rn-iso did not write.
test('a stray file with a .lock name is not reported as a lock', () => {
  mkdirSync(buildLocksDir(), { recursive: true });
  writeFileSync(join(buildLocksDir(), 'ios-not-a-lock.lock'), 'a file, not a directory');
  expect(listBuildLocks()).toEqual([]);
});
