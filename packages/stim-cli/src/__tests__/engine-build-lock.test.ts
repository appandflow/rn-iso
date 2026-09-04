import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  acquireBuildLock,
  buildLockPath,
  buildLocksDir,
  listBuildLocks,
  readBuildLock,
  releaseBuildLock,
  takeoverLine,
  waitForBuild,
  waitingLine,
} from '../engine/build-lock.ts';

const PLATFORM = 'ios';
const KEY = 'a3f9b1c2d3e4f5-debug-sim';

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-home-'));
  process.env.STIM_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'stim-ws-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

const spec = (over = {}) => ({ platform: PLATFORM, key: KEY, root, logFile: join(root, 'build.ndjson'), ...over });

describe('where the lock lives', () => {
  test('is a directory under the config dir, named by platform and cache key', () => {
    expect(buildLocksDir()).toBe(join(home, 'build-locks'));
    expect(buildLockPath(PLATFORM, KEY)).toBe(join(home, 'build-locks', `ios-${KEY}.lock`));
  });

  test('follows STIM_HOME', () => {
    process.env.STIM_HOME = join(home, 'elsewhere');
    expect(buildLocksDir()).toBe(join(home, 'elsewhere', 'build-locks'));
  });

  test('a separator in the key cannot escape the lock directory', () => {
    const path = buildLockPath('ios', '../../etc/passwd');
    expect(dirname(path)).toBe(join(home, 'build-locks'));
    expect(!basename(path).includes('/')).toBeTruthy();
    expect(acquireBuildLock(spec({ key: '../../etc/passwd' })).acquired).toBe(true);
    expect(existsSync(join(home, 'build-locks'))).toBe(true);
  });
});

describe('acquireBuildLock', () => {
  test('creates the lock and records who holds it', () => {
    const got = acquireBuildLock(spec());
    expect(got.acquired).toBe(true);
    expect(got.path).toBe(buildLockPath(PLATFORM, KEY));
    assert(got.path);

    const info = readBuildLock(got.path);
    assert(info);
    expect(info.pid).toBe(process.pid);
    expect(info.projectRoot).toBe(root);
    expect(info.logFile).toBe(join(root, 'build.ndjson'));
    assert(info.startedAt);
    expect(Date.parse(info.startedAt) > 0).toBeTruthy();
  });

  test('a second acquire reports the holder rather than acquiring', () => {
    acquireBuildLock(spec());
    const second = acquireBuildLock(spec({ root: '/other/worktree' }));
    expect(second.acquired).toBe(undefined);
    assert(second.held);
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

  test('an OLD lock held by a LIVE pid is not stale', () => {
    const got = acquireBuildLock(spec());
    assert(got.path);
    const longAgo = new Date(Date.now() - 45 * 60 * 1000);
    utimesSync(got.path, longAgo, longAgo);
    const second = acquireBuildLock(spec());
    expect(second.acquired).toBe(undefined);
    assert(second.held);
    expect(second.held.pid).toBe(process.pid);
  });

  test('a lock held by a DEAD pid is taken over', () => {
    const path = buildLockPath(PLATFORM, KEY);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, 'lock.json'),
      JSON.stringify({
        pid: 999999,
        projectRoot: '/gone/worktree',
        startedAt: new Date().toISOString(),
        logFile: '/gone/build.ndjson',
      }),
    );

    const got = acquireBuildLock(spec({ isAlive: () => false }));
    expect(got.acquired).toBe(true);
    const taken = readBuildLock(path);
    assert(taken);
    expect(taken.pid).toBe(process.pid);
    assert(got.tookOver);
    expect(got.tookOver.pid).toBe(999999);
    expect(got.tookOver.projectRoot).toBe('/gone/worktree');
    expect(got.tookOver.logFile).toBe('/gone/build.ndjson');
  });

  test('an ordinary acquisition took nothing over, so nothing is reported', () => {
    expect(acquireBuildLock(spec()).tookOver).toBe(undefined);
  });

  test('a lock with no lock.json at all is taken over once it has aged', () => {
    const path = buildLockPath(PLATFORM, KEY);
    mkdirSync(path, { recursive: true });
    const longAgo = new Date(Date.now() - 60 * 1000);
    utimesSync(path, longAgo, longAgo);

    const got = acquireBuildLock(spec());
    expect(got.acquired).toBe(true);
    const taken = readBuildLock(path);
    assert(taken);
    expect(taken.pid).toBe(process.pid);
  });

  test('releaseBuildLock removes the lock and is safe to repeat', () => {
    const got = acquireBuildLock(spec());
    assert(got.path);
    expect(releaseBuildLock(got)).toBe(true);
    expect(existsSync(got.path)).toBe(false);
    expect(releaseBuildLock(got)).toBe(true);
    expect(acquireBuildLock(spec()).acquired).toBe(true);
  });

  test('releaseBuildLock refuses to remove a lock another pid took over', () => {
    const got = acquireBuildLock(spec());
    assert(got.path);
    writeFileSync(
      join(got.path, 'lock.json'),
      JSON.stringify({
        pid: 424242,
        projectRoot: '/another/worktree',
        startedAt: new Date().toISOString(),
        logFile: null,
      }),
    );
    expect(releaseBuildLock(got)).toBe(false);
    expect(existsSync(got.path)).toBe(true);
  });

  test('a throw inside a finally-wrapped build still releases', () => {
    const got = acquireBuildLock(spec());
    assert(got.path);
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

describe('listBuildLocks', () => {
  test('is empty when nothing has ever built', () => {
    expect(listBuildLocks()).toEqual([]);
  });

  test('classifies each lock by whether its builder is still alive', () => {
    acquireBuildLock(spec());
    const dead = buildLockPath('android', 'deadkey-debug-sim');
    mkdirSync(dead, { recursive: true });
    writeFileSync(
      join(dead, 'lock.json'),
      JSON.stringify({
        pid: 999999,
        projectRoot: '/gone/worktree',
        startedAt: '2026-08-25T10:00:00.000Z',
        logFile: '/gone/b.ndjson',
      }),
    );

    const locks = listBuildLocks({ isAlive: (pid) => pid === process.pid });
    expect(locks.length).toBe(2);
    const live = locks.find((l) => l.alive);
    const stale = locks.find((l) => !l.alive);
    assert(live);
    assert(stale);
    expect(live.platform).toBe('ios');
    expect(live.key).toBe(KEY);
    expect(live.projectRoot).toBe(root);
    expect(stale.platform).toBe('android');
    expect(stale.pid).toBe(999999);
    expect(stale.path).toBe(dead);
  });

  test('a lock directory with unreadable json is listed with a null pid, not skipped', () => {
    const path = buildLockPath(PLATFORM, KEY);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'lock.json'), 'not json');
    const [lock] = listBuildLocks();
    assert(lock);
    expect(lock.pid).toBe(null);
    expect(lock.alive).toBe(false);
  });
});

describe('waitForBuild', () => {
  const held = {
    pid: process.pid,
    projectRoot: '/other/worktree',
    startedAt: new Date().toISOString(),
    logFile: '/other/build.ndjson',
  };

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

  test('an artifact appearing is the hit, and it says how long the wait cost', async () => {
    lockOn();
    let polls = 0;
    let clock = 1000;
    const result = await waitForBuild(
      opts({
        resolve: () => (++polls < 3 ? null : '/cache/ios/key/Fixture.app'),
        isAlive: () => true,
        now: () => (clock += 5000),
      }),
    );
    expect(result.hit).toBe('/cache/ios/key/Fixture.app');
    assert(result.waitedMs != null);
    expect(result.waitedMs > 0).toBeTruthy();
    expect(polls).toBe(3);
  });

  test('the lock disappearing with no artifact means the builder failed', async () => {
    lockOn();
    const path = buildLockPath(PLATFORM, KEY);
    let polls = 0;
    const result = await waitForBuild(
      opts({
        resolve: () => null,
        isAlive: () => true,
        sleep: async () => {
          if (++polls === 1) rmSync(path, { recursive: true, force: true });
        },
      }),
    );
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

  test('an artifact that lands as the lock is released is still a hit', async () => {
    const path = lockOn();
    let stored: string | null = null;
    const result = await waitForBuild(
      opts({
        resolve: () => stored,
        isAlive: () => true,
        sleep: async () => {
          stored = '/cache/ios/key/Fixture.app';
          rmSync(path, { recursive: true, force: true });
        },
      }),
    );
    expect(result.hit).toBe('/cache/ios/key/Fixture.app');
  });

  test('there is no wait at all when the artifact is already there', async () => {
    lockOn();
    let slept = 0;
    const result = await waitForBuild(
      opts({
        resolve: () => '/cache/ios/key/Fixture.app',
        isAlive: () => true,
        sleep: async () => {
          slept++;
        },
      }),
    );
    expect(result.hit).toBe('/cache/ios/key/Fixture.app');
    expect(slept).toBe(0);
  });

  test('emits a progress line about every 30s, naming the holder and its log', async () => {
    lockOn();
    let clock = 0;
    const lines: string[] = [];
    let polls = 0;
    await waitForBuild(
      opts({
        resolve: () => (++polls < 200 ? null : '/cache/ios/key/Fixture.app'),
        isAlive: () => true,
        now: () => (clock += 1000),
        out: (l: string) => lines.push(l),
      }),
    );
    expect(lines.length >= 5).toBeTruthy();
    expect(lines.length < 20).toBeTruthy();
    expect(lines[0]).toMatch(
      /^build\s+waiting on \/other\/worktree \(pid \d+, .+ elapsed\) -- tail \/other\/build\.ndjson$/,
    );
  });

  test('a generous ceiling ends the wait with a structured error naming the lock', async () => {
    const path = lockOn();
    let clock = 0;
    let err: (Error & { code?: string; lockPath?: string }) | undefined;
    try {
      await waitForBuild(
        opts({
          resolve: () => null,
          isAlive: () => true,
          now: () => (clock += 60 * 1000),
          ceilingMs: 90 * 60 * 1000,
        }),
      );
    } catch (e) {
      err = e as Error & { code?: string; lockPath?: string };
    }
    expect(err).toBeInstanceOf(Error);
    expect(err?.code).toBe('STIM_BUILD_WAIT_TIMEOUT');
    expect(err?.lockPath).toBe(path);
    expect(err?.message).toMatch(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('waitingLine', () => {
  test('is one phase line, in the same column as every other', () => {
    const line = waitingLine({
      projectRoot: '/w/app-412',
      pid: 41233,
      elapsedMs: 8 * 60 * 1000,
      logFile: '/w/app-412/.stim/logs/build-ios.ndjson',
    });
    expect(line).toBe(
      'build       waiting on /w/app-412 (pid 41233, 8m00s elapsed) -- tail /w/app-412/.stim/logs/build-ios.ndjson',
    );
  });

  test('reads in seconds before the first minute is up', () => {
    expect(waitingLine({ projectRoot: '/w', pid: 1, elapsedMs: 30000, logFile: '/l' })).toMatch(/30s elapsed/);
  });

  test('keeps seconds past the first minute, so two lines 30s apart never read the same', () => {
    const args = { projectRoot: '/w', pid: 1, logFile: null };
    expect(waitingLine({ ...args, elapsedMs: 60_000 })).toMatch(/1m00s elapsed/);
    expect(waitingLine({ ...args, elapsedMs: 90_000 })).toMatch(/1m30s elapsed/);
  });

  test('says so when the holder recorded no log file', () => {
    const line = waitingLine({ projectRoot: '/w', pid: 1, elapsedMs: 1000, logFile: null });
    expect(!line.includes('tail')).toBeTruthy();
  });
});

describe('a real race between real processes', { timeout: 30_000 }, () => {
  const LOCK_URL = new URL('../engine/build-lock.ts', import.meta.url).href;
  const CACHE_URL = new URL('../build-cache.ts', import.meta.url).href;
  const CHILD_TIMEOUT_MS = 20_000;
  const HANDSHAKE_MS = 10_000;

  function script(name: string, body: string) {
    const path = join(root, name);
    writeFileSync(path, body);
    return path;
  }

  function runNode(path: string, args: string[] = [], env: Record<string, string> = {}) {
    return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        [path, ...args],
        {
          env: { ...process.env, STIM_HOME: home, ...env },
          timeout: CHILD_TIMEOUT_MS,
        },
        (err, stdout, stderr) => {
          if (err?.killed) return reject(new Error(`${path} was killed after ${CHILD_TIMEOUT_MS}ms (${err.signal})`));
          if (err && err.code === undefined) return reject(err);
          resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  test('exactly one of six processes acquires the same lock', async () => {
    const racer = script(
      'racer.mjs',
      [
        `const { acquireBuildLock } = await import(${JSON.stringify(LOCK_URL)});`,
        'const got = acquireBuildLock({',
        '  platform: "ios", key: process.argv[2], root: `/worktree/${process.argv[3]}`,',
        '  logFile: `/worktree/${process.argv[3]}/build.ndjson`,',
        '});',
        'await new Promise(r => setTimeout(r, 1500));',
        'console.log(JSON.stringify({ pid: process.pid, ...got }));',
      ].join('\n'),
    );

    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => runNode(racer, ['race-debug-sim', name])),
    );
    const answers = results.map((r) => JSON.parse(r.stdout.trim()));
    const winners = answers.filter((a) => a.acquired);
    const losers = answers.filter((a) => a.held);

    expect(winners.length).toBe(1);
    expect(losers.length).toBe(5);
    for (const loser of losers) {
      expect(loser.held.pid).toBe(winners[0].pid);
      expect(loser.held.projectRoot).toMatch(/^\/worktree\//);
    }
    const winnerRecord = readBuildLock(buildLockPath('ios', 'race-debug-sim'));
    assert(winnerRecord);
    expect(winnerRecord.pid).toBe(winners[0].pid);
  });

  test('a waiter resolves the artifact the builder stores', async () => {
    const key = 'shared-debug-sim';
    const builder = script(
      'builder.mjs',
      [
        `const { acquireBuildLock, releaseBuildLock } = await import(${JSON.stringify(LOCK_URL)});`,
        `const { storeBuild } = await import(${JSON.stringify(CACHE_URL)});`,
        'const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");',
        'const { join } = await import("node:path");',
        `const got = acquireBuildLock({ platform: "ios", key: ${JSON.stringify(key)}, root: process.argv[2], logFile: join(process.argv[2], "build.ndjson") });`,
        'if (!got.acquired) { console.log(JSON.stringify({ raced: true })); process.exit(0); }',
        'writeFileSync(join(process.argv[2], "lock-ready"), "");',
        'const lost = process.argv[3];',
        'try {',
        `  const deadline = Date.now() + ${HANDSHAKE_MS};`,
        '  let seen = false;',
        '  for (;;) {',
        '    if (existsSync(lost)) { seen = true; break; }',
        '    if (Date.now() >= deadline) break;',
        '    await new Promise(r => setTimeout(r, 20));',
        '  }',
        '  if (!seen) {',
        '    console.log(JSON.stringify({ built: false, missing: lost }));',
        '  } else {',
        '    const app = join(process.argv[2], "Fixture.app");',
        '    mkdirSync(app, { recursive: true });',
        '    writeFileSync(join(app, "Fixture"), "binary");',
        `    const stored = storeBuild("ios", ${JSON.stringify(key)}, app);`,
        '    console.log(JSON.stringify({ built: true, stored }));',
        '  }',
        '} finally {',
        '  releaseBuildLock(got);',
        '}',
      ].join('\n'),
    );

    const waiter = script(
      'waiter.mjs',
      [
        `const { acquireBuildLock, waitForBuild } = await import(${JSON.stringify(LOCK_URL)});`,
        'const { writeFileSync } = await import("node:fs");',
        `const got = acquireBuildLock({ platform: "ios", key: ${JSON.stringify(key)}, root: process.argv[2], logFile: null });`,
        'if (got.acquired) { console.log(JSON.stringify({ wonInstead: true })); process.exit(0); }',
        'writeFileSync(process.argv[3], "");',
        `const result = await waitForBuild({ platform: "ios", key: ${JSON.stringify(key)}, intervalMs: 50, out: (l) => console.error(l) });`,
        'console.log(JSON.stringify({ ...result, held: got.held }));',
      ].join('\n'),
    );

    const buildRoot = join(root, 'builder');
    mkdirSync(buildRoot, { recursive: true });
    const lost = join(buildRoot, 'waiter-lost');
    const started = runNode(builder, [buildRoot, lost]);
    const ready = join(buildRoot, 'lock-ready');
    for (let attempts = 0; attempts < 400 && !existsSync(ready); attempts += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(ready), `the builder never wrote ${ready}`).toBe(true);
    const [built, waited] = await Promise.all([started, runNode(waiter, [join(root, 'waiter'), lost])]);

    const builderOut = JSON.parse(built.stdout.trim());
    expect(builderOut.built, `the builder gave up waiting for ${lost}`).toBe(true);
    const waiterOut = JSON.parse(waited.stdout.trim());
    expect(waiterOut.wonInstead).toBe(undefined);
    expect(waiterOut.hit).toBe(builderOut.stored);
    expect(waiterOut.waitedMs >= 0).toBeTruthy();
    expect(existsSync(join(waiterOut.hit, 'Fixture'))).toBeTruthy();
    expect(existsSync(buildLockPath('ios', key))).toBe(false);
  });

  test('a builder killed mid-build leaves a lock the waiter takes over', async () => {
    const key = 'crash-debug-sim';
    const suicide = script(
      'suicide.mjs',
      [
        `const { acquireBuildLock } = await import(${JSON.stringify(LOCK_URL)});`,
        `const got = acquireBuildLock({ platform: "ios", key: ${JSON.stringify(key)}, root: "/worktree/doomed", logFile: "/worktree/doomed/build.ndjson" });`,
        'console.log(JSON.stringify(got));',
        'process.kill(process.pid, "SIGKILL");',
      ].join('\n'),
    );

    const dead = await runNode(suicide);
    expect(JSON.parse(dead.stdout.trim()).acquired).toBe(true);
    expect(existsSync(buildLockPath('ios', key))).toBe(true);

    const result = await waitForBuild({ platform: 'ios', key, intervalMs: 10 });
    expect(result.builderFailed).toBeTruthy();

    const takeover = acquireBuildLock({ platform: 'ios', key, root, logFile: null });
    expect(takeover.acquired).toBe(true);
    assert(takeover.path);
    const takeoverRecord = readBuildLock(takeover.path);
    assert(takeoverRecord);
    expect(takeoverRecord.pid).toBe(process.pid);
  });
});

test('a stray file with a .lock name is not reported as a lock', () => {
  mkdirSync(buildLocksDir(), { recursive: true });
  writeFileSync(join(buildLocksDir(), 'ios-not-a-lock.lock'), 'a file, not a directory');
  expect(listBuildLocks()).toEqual([]);
});

describe('takeoverLine', () => {
  test('names the builder, its log, and that the inputs are unchanged', () => {
    const line = takeoverLine({
      projectRoot: '/w/other',
      pid: 4242,
      logFile: '/w/other/.stim/logs/build-android.ndjson',
      startedAt: new Date(1_000_000).toISOString(),
      now: () => 1_000_000 + 120_000,
    });
    expect(line).toMatch(/RETRY: \/w\/other's build of this fingerprint \(pid 4242\) FAILED without an artifact/);
    expect(line).toMatch(/it started 2m00s ago/);
    expect(line).toMatch(/SAME inputs/);
    expect(line).toMatch(/read \/w\/other\/\.stim\/logs\/build-android\.ndjson/);
  });

  test('an unidentifiable holder still produces one usable line', () => {
    const line = takeoverLine({ projectRoot: null, pid: null, logFile: null });
    expect(line).toMatch(/another workspace's build of this fingerprint \(pid \?\)/);
    expect(line).not.toMatch(/it started/);
    expect(line).not.toMatch(/read /);
  });

  test('carries no phase prefix of its own', () => {
    expect(takeoverLine({ projectRoot: null, pid: 1, logFile: null }).startsWith('RETRY:')).toBe(true);
  });
});
