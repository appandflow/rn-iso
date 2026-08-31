#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_COMMANDS,
  assert,
  buildLog,
  cleanupTmp,
  createFixture,
  createHarness,
  describeGrowth,
  dirStats,
  dumpDiagnostics,
  formatBytes,
  growth,
  lastLines,
  preflight,
  quote,
  readNdjson,
  topFileNames,
  verifyCleanup,
  workspaceLogsDir,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CLI = join(REPO, 'packages', 'stim-cli', 'dist', 'cli.mjs');

const args = parseArgs(process.argv.slice(2));
const FRAMEWORK = args.framework;
const PLATFORM = args.platform;
const VARIANT = `${FRAMEWORK}-${PLATFORM}`;
const EXPECTED_MODE = FRAMEWORK === 'expo' ? 'expo-child' : 'bare-inproc';
const ARTIFACT_EXT = PLATFORM === 'ios' ? '.app' : '.apk';

const HOME_DIR = args.dryRun ? '<dry-run>' : args.home || mkdtempSync(join(tmpdir(), `stim-cache-${VARIANT}-home-`));
const WORK_DIR = args.dryRun ? '<dry-run>' : mkdtempSync(join(tmpdir(), `stim-cache-${VARIANT}-`));

const BUILD_CACHE_ROOT = args.dryRun ? '<dry-run>' : join(HOME_DIR, 'build-cache');
const METRO_CACHE_ROOT = args.dryRun ? '<dry-run>' : join(HOME_DIR, 'metro-cache');
const CACHE_TMP_DIR = args.dryRun ? '<dry-run>' : join(HOME_DIR, 'tmp');
const CAS_DIR = join(HOME_DIR, 'compilation-cache');
if (!args.dryRun) mkdirSync(CACHE_TMP_DIR, { recursive: true });
const ENV = {
  ...process.env,
  STIM_HOME: HOME_DIR,
  STIM_BUILD_CACHE: BUILD_CACHE_ROOT,
  STIM_METRO_CACHE: METRO_CACHE_ROOT,
  TMPDIR: CACHE_TMP_DIR,
  CI: '1',
};
process.env.STIM_HOME = HOME_DIR;
const GRADLE_CACHE_DIR = join(process.env.GRADLE_USER_HOME || join(homedir(), '.gradle'), 'caches', 'build-cache-1');
const RACE_CACHE_ROOT = args.dryRun ? '<dry-run>' : join(WORK_DIR, 'race-build-cache');

const h = createHarness({ env: ENV, cliPath: CLI, label: `cache-e2e ${VARIANT}` });
const { cli, cliJson, sh, log, banner, die } = h;

const created = [];

const CHECK_TITLES = {
  'zero-config': 'the repo is untouched by stim-cli runtime state',
  'metro-store': 'the shared Metro transform store is engaged, stores, and is reused',
  'xcode-cas': 'Xcode compilation caching is on the real xcodebuild argv, stores, and is reused',
  'gradle-cache': 'the Gradle build cache is on the real gradlew argv, stores, and is reused',
  'fingerprint-cache': 'the fingerprint build cache stores a complete entry under the post-mutation key',
  'pods-reuse': 'a worktree with carried, matching Pods skips pod install entirely',
  'single-flight': 'two workspaces racing one uncached fingerprint compile exactly once',
  'gc-view': 'gc reports every cache above, with a size, and calls none of them garbage',
};

const ledger = new Map();

function openCheck(id) {
  const title = CHECK_TITLES[id];
  assert(title, `unknown check id ${id}`);
  const entry = { id, title, status: null, reason: null, evidence: [] };
  ledger.set(id, entry);
  banner(`CHECK ${id}: ${title}`);
  return {
    id,
    ev(line) {
      entry.evidence.push(String(line));
      log(`  | ${line}`);
      return this;
    },
    pass(reason = null) {
      return finish(entry, 'pass', reason);
    },
    skip(reason) {
      return finish(entry, 'skip', reason);
    },
    fail(reason) {
      return finish(entry, 'fail', reason);
    },
  };
}

function finish(entry, status, reason) {
  if (entry.status) throw new Error(`check ${entry.id} reported ${entry.status} and then ${status}`);
  entry.status = status;
  entry.reason = reason;
  log(`  ${status.toUpperCase()} ${entry.id}${reason ? `: ${reason}` : ''}`);
  return entry;
}

async function runCheck(id, fn) {
  const c = openCheck(id);
  try {
    await fn(c);
  } catch (e) {
    if (!ledger.get(id).status) c.fail(`threw: ${e?.message || e}`);
    else log(`  (after reporting: ${e?.message || e})`);
  }
  const entry = ledger.get(id);
  if (!entry.status) finish(entry, 'fail', 'the check finished without reporting a verdict');
  return entry;
}

function skipCheck(id, reason) {
  openCheck(id).skip(reason);
}

async function main() {
  preflight(h, PLATFORM);

  const appDir = args.appDir
    ? resolve(args.appDir)
    : createFixture({ framework: FRAMEWORK, platform: PLATFORM, workDir: WORK_DIR, h });
  const expoSdk = FRAMEWORK === 'expo' ? readExpoSdkMajor(appDir) : null;
  log(`app: ${appDir}`);
  if (FRAMEWORK === 'expo') log(`Expo SDK: ${expoSdk ?? 'unknown'}`);
  const baseline = snapshotRepo(appDir);
  log(`baseline: porcelain ${baseline.porcelain === '' ? 'CLEAN' : JSON.stringify(baseline.porcelain)}`);
  log(`baseline: .gitignore ${baseline.gitignoreExists ? `${baseline.gitignore.length} bytes` : 'ABSENT'}`);
  mkdirSync(RACE_CACHE_ROOT, { recursive: true });

  const dirtyByWorktree = [];

  const wt1 = worktreeCreate('e2e-cache-1', appDir);
  const start1 = startAndAssertMode(wt1);
  log(`wt1 start mode=${start1.mode} port=${start1.port}`);

  const storeRoot1 = metroStoreRootFrom(wt1);
  const metroBefore1 = dirStats(storeRoot1 || METRO_CACHE_ROOT);
  const casBefore1 = dirStats(CAS_DIR);
  const gradleBefore1 = dirStats(GRADLE_CACHE_DIR);
  // Gradle cache entries are 32-hex content hashes; the same directory also
  // holds build-cache-1.lock and gc.properties, which must not count as stores.
  const GRADLE_ENTRY = /^[0-9a-f]{32}$/;
  const gradleNamesBefore1 = new Set(topFileNames(GRADLE_CACHE_DIR, { matching: GRADLE_ENTRY }));

  const build1 = build(wt1, 'wt1 (cold)');
  assert(
    build1.cacheHit === false,
    `wt1 must be a cache MISS on a throwaway home, got ${JSON.stringify(build1.cacheHit)}`,
  );
  assertArtifact(build1.appPath);

  const metroAfter1 = await settle(storeRoot1 || METRO_CACHE_ROOT, 'wt1 Metro store');
  const casAfter1 = dirStats(CAS_DIR);
  const gradleAfter1 = dirStats(GRADLE_CACHE_DIR);
  const gradleNamesAfter1 = new Set(topFileNames(GRADLE_CACHE_DIR, { matching: GRADLE_ENTRY }));
  const gradleNewNames1 = [...gradleNamesAfter1].filter((n) => !gradleNamesBefore1.has(n));

  const wt2 = worktreeCreate('e2e-cache-2', appDir);
  const start2 = startAndAssertMode(wt2);
  log(`wt2 start mode=${start2.mode} port=${start2.port}`);
  const storeRoot2 = metroStoreRootFrom(wt2);
  const metroBefore2 = dirStats(storeRoot2 || METRO_CACHE_ROOT);
  const build2 = build(wt2, 'wt2 (expect HIT)');
  assert(
    build2.cacheHit === 'local' || build2.cacheHit === 'remote',
    `wt2 must HIT the build cache, got ${JSON.stringify(build2.cacheHit)}`,
  );
  assertArtifact(build2.appPath);
  const metroAfter2 = await settle(storeRoot2 || METRO_CACHE_ROOT, 'wt2 Metro store');

  await runCheck('metro-store', (c) => {
    if (FRAMEWORK === 'expo' && (expoSdk === null || expoSdk < 54)) {
      return c.skip(
        expoSdk === null
          ? 'the Expo SDK could not be determined; stim-cli intentionally leaves its Metro cache unchanged'
          : `Expo SDK ${expoSdk} predates the config override added in SDK 54; stim-cli intentionally leaves its Metro cache unchanged`,
      );
    }
    const rec1 = metroStoreRecords(wt1);
    const rec2 = metroStoreRecords(wt2);

    const problems = [];

    const expectPhrase =
      FRAMEWORK === 'expo'
        ? 'the dev server process confirmed the store is in the config Metro loaded'
        : 'appended the shared Metro transform store at';
    for (const [label, rec] of [
      ['wt1', rec1],
      ['wt2', rec2],
    ]) {
      for (const kind of ['requested', 'added', 'present', 'skipped', 'couldNotShare']) {
        if (rec[kind]) c.ev(`${label} ${kind}: ${JSON.stringify(rec[kind].msg)}`);
      }
      if (!rec.added) {
        c.ev(`${label}: NO cache_store_added record in ${rec.file}`);
        problems.push(
          rec.requested
            ? `${label} recorded cache_store_requested but the dev server never confirmed it and never warned: the config adapter was loaded by a process that did not honour it`
            : `${label} wrote no cache_store_added record at all (${rec.file})`,
        );
      } else if (!rec.added.msg.includes(expectPhrase)) {
        problems.push(
          `${label}'s record is not the ${EXPECTED_MODE} confirmation (wanted ${JSON.stringify(expectPhrase)}): ${JSON.stringify(rec.added.msg)}`,
        );
      }
      if (rec.couldNotShare) {
        problems.push(`${label} logged the adapter's fail-soft warning, so the store never reached Metro`);
      }
    }
    if (!rec1.couldNotShare && !rec2.couldNotShare) {
      c.ev('neither workspace logged "could not share this project\'s Metro transform cache"');
    }

    if (storeRoot1 && storeRoot2) {
      c.ev(`store roots: wt1 ${storeRoot1} | wt2 ${storeRoot2}`);
      if (storeRoot1 !== storeRoot2) problems.push('the two workspaces point at DIFFERENT stores');
    } else {
      c.ev(`no store root in a record; the configured root ${METRO_CACHE_ROOT} was measured instead`);
    }

    const g1 = growth('wt1 Metro store', metroBefore1, metroAfter1);
    const g2 = growth('wt2 Metro store', metroBefore2, metroAfter2);
    c.ev(describeGrowth(g1));
    c.ev(describeGrowth(g2));
    if (g1.added <= 0) {
      problems.push(
        `the shared Metro store did not gain a single file across wt1's build+launch (${g1.dir}). Engaged but not storing is exactly the #73 failure mode.`,
      );
    } else {
      const reusePct = Math.round(((g1.added - g2.added) / g1.added) * 100);
      c.ev(`wt2 added ${g2.added} entries where wt1 added ${g1.added} -- ${reusePct}% of wt1's transforms reused`);
      if (g2.added >= g1.added) {
        problems.push(`wt2 added ${g2.added} store entries, no fewer than wt1's ${g1.added}: it reused nothing`);
      }
    }

    if (problems.length) return c.fail(problems.join(' | '));
    const reusePct = Math.round(((g1.added - g2.added) / g1.added) * 100);
    return c.pass(`store shared at ${storeRoot1}; wt1 +${g1.added} files, wt2 +${g2.added} (${reusePct}% reused)`);
  });

  if (PLATFORM === 'ios') {
    await runCheck('xcode-cas', (c) => {
      const argv = buildStartArgv(wt1);
      assert(argv, `no build_start record in ${buildLog(wt1)}`);
      c.ev(`xcodebuild argv: ${argv}`);
      const required = [
        'COMPILATION_CACHE_ENABLE_CACHING=YES',
        `COMPILATION_CACHE_CAS_PATH=${CAS_DIR}`,
        'SWIFT_ENABLE_COMPILE_CACHE=NO',
        'CLANG_ENABLE_PREFIX_MAPPING=YES',
        `CLANG_OTHER_PREFIX_MAPPINGS=${wt1.replace(/\/+$/, '')}=/^src`,
      ];
      const missing = required.filter((s) => !argv.includes(s));
      if (missing.length) {
        const xc = sh('xcodebuild', ['-version'], { allowFail: true }).stdout.trim().split('\n')[0] || 'unknown';
        const major = /^Xcode\s+(\d+)/.exec(xc);
        if (!major || Number(major[1]) < 26) {
          return c.skip(
            `compilation caching needs Xcode 26+; this runner reports ${JSON.stringify(xc)}, and stim-cli adds no settings below that floor`,
          );
        }
        return c.fail(`the xcodebuild argv is missing ${missing.length} setting(s): ${missing.join(' ')}`);
      }
      c.ev(`all 5 compilation-cache settings present verbatim on the argv (CAS at ${CAS_DIR})`);

      const g = growth('Xcode CAS', casBefore1, casAfter1);
      c.ev(describeGrowth(g));
      assert(
        g.added > 0,
        'the CAS directory gained no files across a full cold compile: caching is on but storing nothing',
      );
      return c.pass(
        `5/5 settings on the argv; CAS +${g.added} files (${formatBytes(g.bytesAdded)}) across the cold build`,
      );
    });
  } else {
    skipCheck('xcode-cas', `platform is ${PLATFORM}: Xcode compilation caching is an iOS-only cache`);
  }

  if (PLATFORM === 'android') {
    await runCheck('gradle-cache', (c) => {
      const argv = buildStartArgv(wt1);
      assert(argv, `no build_start record in ${buildLog(wt1)}`);
      c.ev(`gradlew argv: ${argv}`);
      assert(/gradlew/.test(argv), `the build_start record does not name gradlew: ${argv}`);
      assert(
        /\s--build-cache(\s|$)/.test(argv),
        `--build-cache is NOT on the gradlew argv, so gradle ran with its task-output cache off: ${argv}`,
      );
      c.ev('--build-cache present on the argv stim-cli composed');

      const g = growth('Gradle build cache', gradleBefore1, gradleAfter1);
      c.ev(describeGrowth(g));
      const removed = [...gradleNamesBefore1].filter((n) => !gradleNamesAfter1.has(n)).length;
      c.ev(
        `${gradleNewNames1.length} new entry file(s) written by the cold assemble` +
          (removed > 0 ? ` (Gradle's own cleanup removed ${removed} old file(s) in the same window)` : ''),
      );
      // A machine cache already holding this fixture's task outputs (a previous
      // suite run) stores nothing on a cold workspace: the build LOADS instead.
      // Either direction proves the cache is engaged.
      const wt1FromCache = readNdjson(buildLog(wt1))
        .map((r) => String(r.msg || ''))
        .filter((m) => /FROM-CACHE/.test(m));
      if (gradleNewNames1.length === 0) {
        for (const line of wt1FromCache.slice(0, 3)) c.ev(`wt1 gradle: ${line}`);
      }
      assert(
        gradleNewNames1.length > 0 || wt1FromCache.length > 0,
        `${GRADLE_CACHE_DIR} gained no NEW entries across a cold assemble, and no wt1 task came back FROM-CACHE either. Gradle only creates, fills, or reads it when --build-cache is on, so this is engaged-but-inert. (Judged by entry-name set difference plus the build log; a net count drop from Gradle's periodic cleanup of old entries does not fail this check.)`,
      );

      log('forcing gradle to execute in wt2 with --no-build-cache so its task cache can be observed...');
      const forced = cliJson([PLATFORM, '--json', '--no-build-cache'], { cwd: wt2, timeout: 40 * 60 * 1000 });
      c.ev(`wt2 forced run: cacheSkipped=${JSON.stringify(forced.cacheSkipped)} durationMs=${forced.durationMs}`);
      const lines = readNdjson(buildLog(wt2))
        .map((r) => String(r.msg || ''))
        .filter((m) => /FROM-CACHE/.test(m));
      for (const line of lines.slice(0, 5)) c.ev(`gradle: ${line}`);
      assert(
        lines.length > 0,
        `no task in wt2 came back FROM-CACHE, so the second worktree reused none of wt1's task outputs (log: ${buildLog(wt2)})`,
      );
      return c.pass(
        `--build-cache on the argv; ` +
          (gradleNewNames1.length > 0
            ? `${gradleNewNames1.length} new cache entries; `
            : `warm machine cache reused by wt1 (${wt1FromCache.length} FROM-CACHE); `) +
          `${lines.length} FROM-CACHE task(s) in the second worktree`,
      );
    });
  } else {
    skipCheck('gradle-cache', `platform is ${PLATFORM}: the Gradle build cache is an Android-only cache`);
  }

  await runCheck('fingerprint-cache', (c) => {
    const platformDir = join(BUILD_CACHE_ROOT, PLATFORM);
    const keys = existsSync(platformDir) ? readdirSync(platformDir) : [];
    c.ev(`entries under ${platformDir}: ${keys.length} (${keys.join(', ') || 'none'})`);
    assert(keys.length > 0, 'the cold build stored no cache entry at all');

    log('re-running the build in the SAME tree: it must hit what the cold run stored');
    const again = build(wt1, 'wt1 (second run, same tree)');
    c.ev(`wt1 looked up ${build1.cacheKey} when cold; the same tree now looks up ${again.cacheKey}`);
    assert(
      again.cacheHit === 'local',
      `the second run in the same tree did not hit the local cache (cacheHit=${JSON.stringify(again.cacheHit)}) -- the entry was stored under a key this tree does not compute`,
    );
    c.ev(`second run cacheHit=${JSON.stringify(again.cacheHit)} durationMs=${again.durationMs}`);
    c.ev(
      build1.cacheKey === again.cacheKey
        ? 'lookup and store key coincide: no mutating step (prebuild / pod install) ran in this tree'
        : 'the key SHIFTED between lookup and store (prebuild / pod install rewrote fingerprint sources), and the entry is under the POST-mutation key',
    );

    const entry = join(platformDir, again.cacheKey);
    assert(existsSync(entry), `no entry directory at ${entry}`);
    const files = readdirSync(entry);
    c.ev(`entry ${again.cacheKey} holds: ${files.join(', ')}`);
    assert(
      files.some((f) => f.endsWith(ARTIFACT_EXT)),
      `the entry holds no ${ARTIFACT_EXT}: ${files.join(', ')}`,
    );
    assert(
      files.includes('fingerprint-sources.json'),
      'the entry has no fingerprint-sources.json sidecar, so a later miss cannot say what moved',
    );
    const sources = JSON.parse(readFileSync(join(entry, 'fingerprint-sources.json'), 'utf-8'));
    c.ev(`fingerprint-sources.json parses and lists ${Array.isArray(sources) ? sources.length : '?'} source(s)`);
    assert(Array.isArray(sources) && sources.length > 0, 'fingerprint-sources.json is empty');

    const configuration = String(again.configuration || 'debug').toLowerCase();
    if (PLATFORM === 'android' && configuration === 'release') {
      assert(
        files.includes('assets-manifest.json'),
        'an Android RELEASE entry has no assets-manifest.json, so the APK swap has nothing to gate on',
      );
      c.ev('assets-manifest.json present on the release entry');
    } else {
      c.ev(
        `assets-manifest.json is not expected here: it is written for Android RELEASE entries, and this is ${PLATFORM}/${configuration}`,
      );
    }
    return c.pass(`entry complete under the post-mutation key ${again.cacheKey}; the same-tree re-run hit it`);
  });

  await runCheck('gc-view', (c) => {
    const gc = cli(['gc'], { cwd: appDir, allowFail: true });
    assert(gc.code === 0, `gc exited ${gc.code}`);
    const outLines = gc.stdout.split('\n');
    const headerIndex = outLines.findIndex((l) => /Shared build caches \(\d+\)/.test(l));
    assert(headerIndex >= 0, `gc printed no "Shared build caches (N)" section:\n${lastLines(gc.stdout, 30)}`);
    const header = outLines[headerIndex];
    c.ev(`gc header: ${header.trim()}`);
    assert(/alive, not garbage/.test(header), `gc's cache header does not call them alive: ${header}`);

    for (const line of outLines.slice(headerIndex + 1)) {
      if (line.trim()) c.ev(`gc: ${line.trim()}`);
      if (/^\s*total:/.test(line)) break;
    }

    const expected = [
      { name: 'the fingerprint build cache', dir: BUILD_CACHE_ROOT },
      { name: 'the shared Metro transform store', dir: storeRoot1 || METRO_CACHE_ROOT },
    ];
    if (PLATFORM === 'ios') expected.push({ name: "Xcode's compilation cache (CAS)", dir: CAS_DIR });
    if (PLATFORM === 'android') expected.push({ name: 'the Gradle build cache', dir: GRADLE_CACHE_DIR });

    const missing = [];
    for (const e of expected) {
      const stats = dirStats(e.dir);
      if (!stats.exists || stats.files === 0) {
        c.ev(`${e.name}: nothing on disk at ${e.dir}, so gc has nothing to report -- not counted against it`);
        continue;
      }
      if (gc.stdout.includes(e.dir)) {
        c.ev(`gc reports ${e.name} at ${e.dir} (${stats.files} files, ${formatBytes(stats.bytes)})`);
      } else {
        c.ev(
          `gc DOES NOT report ${e.name}, which holds ${stats.files} files (${formatBytes(stats.bytes)}) at ${e.dir}`,
        );
        missing.push(e);
      }
    }
    if (missing.length) {
      return c.fail(
        `${missing.length} live cache(s) are invisible to gc, so nothing will ever trim them: ${missing.map((m) => m.dir).join(', ')}`,
      );
    }
    return c.pass(`gc reports ${expected.length} live cache(s) with sizes and calls none of them garbage`);
  });

  stopWorkspace(wt2);

  let raceOutcome = null;
  if (args.skipRace) {
    log('--skip-race: the single-flight phase (one full compile) is being skipped');
  } else {
    const wt3 = worktreeCreate('e2e-cache-3', wt1);
    const wt4 = worktreeCreate('e2e-cache-4', wt1);
    startAndAssertMode(wt3);
    startAndAssertMode(wt4);
    const casBeforeRace = dirStats(CAS_DIR);
    banner('racing two workspaces at ONE uncached fingerprint');
    log(`both address an empty build cache at ${RACE_CACHE_ROOT}; the build LOCK is shared through STIM_HOME`);
    const raceEnv = { ...ENV, STIM_BUILD_CACHE: RACE_CACHE_ROOT };
    const [r3, r4] = await Promise.all([
      cliAsync([PLATFORM, '--json'], { cwd: wt3, env: raceEnv }),
      cliAsync([PLATFORM, '--json'], { cwd: wt4, env: raceEnv }),
    ]);
    const casAfterRace = dirStats(CAS_DIR);
    raceOutcome = { r3, r4, casBeforeRace, casAfterRace };
  }

  await runCheck('single-flight', (c) => {
    if (!raceOutcome) return c.skip('--skip-race was passed, so no race was run');
    const { r3, r4 } = raceOutcome;
    for (const [label, r] of [
      ['wt3', r3],
      ['wt4', r4],
    ]) {
      assert(r.code === 0, `${label} exited ${r.code}:\n${lastLines(r.stderr, 25)}`);
      c.ev(
        `${label}: cacheHit=${JSON.stringify(r.facts.cacheHit)} waitedForBuild=${JSON.stringify(r.facts.waitedForBuild)} durationMs=${r.facts.durationMs}`,
      );
    }
    assert(
      r3.facts.cacheKey === r4.facts.cacheKey,
      `the racers did not fingerprint alike (${r3.facts.cacheKey} vs ${r4.facts.cacheKey}), so they were never racing the same entry`,
    );
    c.ev(`both racers computed the same key: ${r3.facts.cacheKey}`);

    const waiters = [r3, r4].filter((r) => r.facts.waitedForBuild);
    const builder = [r3, r4].find((r) => !r.facts.waitedForBuild);
    assert(
      waiters.length === 1,
      `exactly one racer must have waited; ${waiters.length} did. Both compiling is the duplicate-work the lock exists to prevent.`,
    );
    const [waiter] = waiters;
    c.ev(`the builder returned in ${builder.facts.durationMs}ms; the waiter returned in ${waiter.facts.durationMs}ms`);
    assert(
      waiter.facts.cacheHit === 'local',
      `the waiter did not install from the cache (cacheHit=${JSON.stringify(waiter.facts.cacheHit)})`,
    );
    c.ev(`waiter payload: waitedForBuild=${JSON.stringify(waiter.facts.waitedForBuild)}`);
    assert(
      Number(waiter.facts.waitedForBuild?.ms) > 0 && waiter.facts.waitedForBuild?.pid,
      `waitedForBuild must carry the builder's pid and a non-zero wait: ${JSON.stringify(waiter.facts.waitedForBuild)}`,
    );
    const line = waiter.stderr.split('\n').find((l) => /waited .* -> installed from cache/.test(l));
    assert(
      line,
      `the waiter never printed the "waited ... -> installed from cache" line:\n${lastLines(waiter.stderr, 25)}`,
    );
    c.ev(`waiter phase line: ${JSON.stringify(stripAnsi(line).trim())}`);
    assert(
      builder.facts.cacheHit === false,
      `the builder should have MISSED, got ${JSON.stringify(builder.facts.cacheHit)}`,
    );
    return c.pass('one compiled, one waited on the lock and installed the artifact it stored');
  });

  await runCheck('pods-reuse', (c) => {
    if (PLATFORM !== 'ios') return c.skip(`platform is ${PLATFORM}: CocoaPods is an iOS-only step`);
    if (!raceOutcome) return c.skip('--skip-race was passed, and the carried-Pods worktrees are created by that phase');
    const { r3, r4 } = raceOutcome;
    const builder = [r3, r4].find((r) => !r.facts.waitedForBuild);
    assert(builder, 'no racer took the build path, so nothing decided about pods');
    const phases = builder.stderr
      .split('\n')
      .map((l) => stripAnsi(l).trimEnd())
      .filter((l) => /^(prebuild|pods|fingerprint|build|cache|install|launch)\s+\S/.test(l));
    for (const p of phases) c.ev(`builder phase: ${p}`);
    const podsLines = phases.filter((l) => /^pods\s/.test(l));
    assert(
      podsLines.length === 0,
      `a pods phase line appeared even though Pods were carried in and match Podfile.lock: ${podsLines.join(' | ')}`,
    );
    c.ev('NO `pods` phase line at all: pod install was skipped, not merely fast');
    const podsDir = join(builder.cwd, 'ios', 'Pods');
    const podStats = dirStats(podsDir);
    assert(podStats.exists && podStats.files > 0, `the worktree carried no Pods to reuse (${podsDir})`);
    c.ev(`carried Pods present: ${podStats.files} files (${formatBytes(podStats.bytes)}) at ${podsDir}`);
    const manifest = join(podsDir, 'Manifest.lock');
    const lock = join(builder.cwd, 'ios', 'Podfile.lock');
    if (existsSync(manifest) && existsSync(lock)) {
      const same = readFileSync(manifest, 'utf-8') === readFileSync(lock, 'utf-8');
      c.ev(`Pods/Manifest.lock ${same ? 'MATCHES' : 'differs from'} ios/Podfile.lock`);
      assert(same, 'the carried Pods do not match Podfile.lock, so skipping the install would have been wrong');
    }
    return c.pass('a --carry-ignored worktree with matching Pods ran no pod install');
  });

  if (PLATFORM === 'ios') annotateCasReuse(raceOutcome, casBefore1, casAfter1);

  banner('teardown');
  for (const wt of created.toReversed()) {
    if (!existsSync(wt)) continue;
    stopWorkspace(wt);
    const entries = porcelain(wt).split('\n').filter(Boolean);
    const diffs = {};
    for (const line of entries) diffs[porcelainPath(line)] = fileDiff(wt, porcelainPath(line));
    dirtyByWorktree.push({ wt, porcelain: entries.join('\n'), diffs });
    worktreeRemove(wt);
  }
  verifyCleanup({ h, platform: PLATFORM, appDir, created });

  await runCheck('zero-config', (c) => {
    let critical = 0;
    let unexplained = 0;
    for (const snap of dirtyByWorktree) {
      const entries = snap.porcelain.split('\n').filter(Boolean);
      c.ev(`${snap.wt}: ${entries.length === 0 ? 'CLEAN' : `${entries.length} dirty path(s)`}`);
      for (const line of entries) {
        const path = porcelainPath(line);
        const diff = snap.diffs[path] || '';
        const showDiff = () => {
          for (const dl of diff.split('\n').filter((l) => /^[+-][^+-]/.test(l))) c.ev(`    ${dl}`);
        };
        if (CRITICAL_PATHS.some((re) => re.test(path))) {
          c.ev(`  CRITICAL: stim-cli modified ${path}`);
          showDiff();
          critical += 1;
        } else if (POD_CHURN_PATHS.some((re) => re.test(path))) {
          c.ev(`  ${path} -- CocoaPods' own install output, not a stim-cli edit`);
        } else if (FRAMEWORK === 'expo' && PREBUILD_CHURN_PATHS.some((re) => re.test(path))) {
          c.ev(`  ${path} -- \`expo prebuild\` output, not a stim-cli edit; the lines it wrote:`);
          showDiff();
        } else {
          c.ev(`  UNEXPLAINED: ${path}`);
          showDiff();
          unexplained += 1;
        }
      }
    }
    if (critical > 0) {
      return c.fail(
        `${critical} CRITICAL edit(s): stim-cli supplies every cache on its own command line and must touch none of metro.config.js / Podfile / gradle.properties`,
      );
    }
    if (unexplained > 0) return c.fail(`${unexplained} change(s) stim-cli cannot account for`);

    const after = snapshotRepo(appDir);
    c.ev(
      `main checkout after the run: porcelain ${after.porcelain === '' ? 'CLEAN' : JSON.stringify(after.porcelain)}`,
    );
    assert(after.porcelain === baseline.porcelain, `the main checkout is not as we found it:\n${after.porcelain}`);
    c.ev(
      `.gitignore ${after.gitignore === baseline.gitignore ? 'byte-identical to the baseline' : 'CHANGED'} (${after.gitignore.length} bytes)`,
    );
    assert(after.gitignore === baseline.gitignore, "the main checkout's .gitignore was left modified");
    for (const wt of created) assert(!existsSync(wt), `worktree directory survived removal: ${wt}`);
    c.ev(`all ${created.length} worktree directories are gone, each removed without --force`);
    return c.pass('runtime state stayed outside the repository and removal restored fixture changes');
  });
}

const CRITICAL_PATHS = [/(^|\/)metro\.config\.[cm]?[jt]s$/, /(^|\/)Podfile$/, /(^|\/)gradle\.properties$/];

const POD_CHURN_PATHS = [
  /\.xcodeproj\/project\.pbxproj$/,
  /Info\.plist$/,
  /PrivacyInfo\.xcprivacy$/,
  /(^|\/)Podfile\.lock$/,
  /\.xcworkspace/,
];

const PREBUILD_CHURN_PATHS = [/(^|\/)package\.json$/, /(^|\/)app\.(json|config\.[cm]?[jt]s)$/];

function worktreeCreate(name, sourceDir) {
  const r = cli(['worktree', 'create', name, '--base', 'head', '--carry-ignored'], { cwd: sourceDir });
  const path = r.stdout.trim().split('\n').findLast(Boolean);
  assert(path && existsSync(path), `worktree create did not yield a real path: ${JSON.stringify(r.stdout)}`);
  created.push(path);
  log(`worktree ${name} (from ${sourceDir}) -> ${path}`);
  return path;
}

function startAndAssertMode(cwd) {
  const r = cli(['start', '--json', '--wait', '240'], { cwd, allowFail: true });
  if (r.code !== 0) {
    const supLog = join(workspaceLogsDir(cwd), 'supervisor.log');
    if (existsSync(supLog)) log(`--- supervisor.log (tail) ---\n${lastLines(readFileSync(supLog, 'utf-8'), 80)}`);
    die(`stim start failed (exit ${r.code}):\n${lastLines(r.stderr, 40)}`);
  }
  const facts = JSON.parse(r.stdout.trim().split('\n').findLast(Boolean));
  assert(
    facts.mode === EXPECTED_MODE,
    `start mode for a ${FRAMEWORK} app must be ${EXPECTED_MODE}, got ${JSON.stringify(facts.mode)}`,
  );
  return facts;
}

function build(cwd, label) {
  log(`building ${PLATFORM} in ${cwd} (${label})...`);
  const facts = cliJson([PLATFORM, '--json'], { cwd, timeout: 40 * 60 * 1000 });
  log(
    `${label}: cacheHit=${JSON.stringify(facts.cacheHit)} key=${facts.cacheKey} launched=${JSON.stringify(facts.launched)} ` +
      `waitedForBuild=${JSON.stringify(facts.waitedForBuild)} durationMs=${facts.durationMs}`,
  );
  return facts;
}

function assertArtifact(appPath) {
  assert(
    typeof appPath === 'string' && appPath.endsWith(ARTIFACT_EXT) && existsSync(appPath),
    `the built artifact is missing or not a ${ARTIFACT_EXT}: ${JSON.stringify(appPath)}`,
  );
  log(`artifact ok: ${appPath}`);
}

function stopWorkspace(cwd) {
  if (!existsSync(cwd)) return;
  cli(['stop'], { cwd, allowFail: true });
}

function worktreeRemove(path) {
  sh('git', ['-C', path, 'checkout', '--', '.'], { allowFail: true });
  sh('git', ['-C', path, 'clean', '-fdq', 'ios', 'android'], { allowFail: true });
  const r = cli(['worktree', 'remove', path], { allowFail: true });
  assert(r.code === 0, `worktree remove refused a worktree after fixture-induced changes were restored:\n${r.stderr}`);
  log(`removed worktree ${path}`);
}

function annotateCasReuse(raceOutcome, casBefore1, casAfter1) {
  const entry = ledger.get('xcode-cas');
  if (!entry) return;
  const ev = (line) => {
    entry.evidence.push(String(line));
    log(`  | [xcode-cas reuse] ${line}`);
  };
  if (!raceOutcome) return ev("REUSED not measured: --skip-race was passed, and the second compile is the race's");
  if (entry.status !== 'pass') return ev(`REUSED not measured: the engaged/stores half reported ${entry.status}`);
  const g = growth('Xcode CAS during the race compile', raceOutcome.casBeforeRace, raceOutcome.casAfterRace);
  ev(describeGrowth(g));
  const cold = casAfter1.files - casBefore1.files;
  const pct = cold === 0 ? 0 : Math.round(((cold - g.added) / cold) * 100);
  ev(
    `the cold compile added ${cold} CAS files; a compile in a never-compiled workspace added ${g.added} (${pct}% reused)`,
  );
  if (g.added >= cold) {
    entry.status = 'fail';
    entry.reason = `a compile in a second workspace added ${g.added} CAS files where the cold one added ${cold}: nothing was reused across workspaces (check CLANG_OTHER_PREFIX_MAPPINGS)`;
    log(`  FAIL xcode-cas: ${entry.reason}`);
    return;
  }
  entry.reason = `${entry.reason}; a second workspace's compile added only ${g.added} CAS files vs ${cold} cold (${pct}% reused)`;
  log(`  (xcode-cas REUSED confirmed: ${pct}%)`);
}

function metroStoreRecords(cwd) {
  const file = join(workspaceLogsDir(cwd), 'metro.ndjson');
  const records = readNdjson(file);
  return {
    file,
    requested: records.find((r) => r.event === 'cache_store_requested') || null,
    added: records.find((r) => r.event === 'cache_store_added') || null,
    present: records.find((r) => r.event === 'cache_store_present') || null,
    skipped: records.find((r) => r.event === 'cache_store_skipped') || null,
    couldNotShare:
      records.find((r) => /could not share this project's Metro transform cache/.test(String(r.msg || ''))) || null,
  };
}

function readExpoSdkMajor(cwd) {
  let dir = resolve(cwd);
  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', 'expo', 'package.json'), 'utf8'));
      const match = /^(\d+)/.exec(String(pkg.version || ''));
      return match ? Number(match[1]) : null;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

function metroStoreRootFrom(cwd) {
  const rec = metroStoreRecords(cwd).added;
  if (!rec) return null;
  const m = /(?:through|store at)\s+(\S+)/.exec(String(rec.msg));
  return m ? m[1] : null;
}

function buildStartArgv(cwd) {
  const rec = readNdjson(buildLog(cwd)).find((r) => r.event === 'build_start');
  return rec ? String(rec.msg) : null;
}

function porcelain(dir) {
  return sh('git', ['-C', dir, 'status', '--porcelain'], { allowFail: true }).stdout.replace(/\n+$/, '');
}

function fileDiff(dir, path) {
  return sh('git', ['-C', dir, 'diff', '--', path], { allowFail: true }).stdout;
}

function porcelainPath(line) {
  const raw = String(line).slice(3).trim();
  const renamed = raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw;
  return renamed.replace(/^"(.*)"$/, '$1');
}

function snapshotRepo(dir) {
  const gi = join(dir, '.gitignore');
  return {
    porcelain: porcelain(dir),
    gitignoreExists: existsSync(gi),
    gitignore: existsSync(gi) ? readFileSync(gi, 'utf-8') : '',
  };
}

function cliAsync(argv, { cwd, env = ENV, timeout = 40 * 60 * 1000 } = {}) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [CLI, ...argv], { cwd, env });
    let stdout = '';
    let stderr = '';
    const tag = `[${argv[0]} in ${cwd.split('/').pop()}] `;
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      for (const l of String(d).split('\n')) if (l.trim()) process.stderr.write(tag + l + '\n');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      let facts = {};
      try {
        facts = JSON.parse(stdout.trim().split('\n').findLast(Boolean));
      } catch {}
      resolveP({ code: code ?? 1, stdout, stderr, facts, cwd });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(dir, label, { firstGrowthMs = 90000, quietMs = 6000, timeoutMs = 240000, stepMs = 1500 } = {}) {
  const startedAtMs = Date.now();
  const baseline = dirStats(dir);
  let last = baseline;
  let moved = false;
  let stableSince = Date.now();
  while (Date.now() - startedAtMs < timeoutMs) {
    await sleep(stepMs);
    const now = dirStats(dir);
    if (now.files !== last.files || now.bytes !== last.bytes) {
      last = now;
      moved = true;
      stableSince = Date.now();
      continue;
    }
    if (!moved) {
      if (Date.now() - startedAtMs >= firstGrowthMs) {
        log(
          `${label}: no growth at all in ${Math.round(firstGrowthMs / 1000)}s (${baseline.files} files, unchanged) -- reported as EMPTY, not as settled`,
        );
        return last;
      }
      continue;
    }
    if (Date.now() - stableSince >= quietMs) {
      log(`${label} settled at ${now.files} files after ${Math.round((Date.now() - startedAtMs) / 1000)}s`);
      return now;
    }
  }
  log(
    `${label} never settled within ${Math.round(timeoutMs / 1000)}s; reporting the last sample (${last.files} files)`,
  );
  return last;
}

const ANSI = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;]*m`, 'g');

function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

function emitSummary(durationMs, fatal) {
  const checks = [...ledger.values()].map((e) => ({
    id: e.id,
    title: e.title,
    status: e.status || 'fail',
    reason: e.reason,
    evidence: e.evidence,
  }));
  const counts = { pass: 0, skip: 0, fail: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const missing = Object.keys(CHECK_TITLES).filter((id) => !ledger.has(id));
  const summary = {
    suite: 'caches',
    variant: VARIANT,
    framework: FRAMEWORK,
    platform: PLATFORM,
    home: HOME_DIR,
    ok: counts.fail === 0 && missing.length === 0 && !fatal,
    fatal: fatal || null,
    counts: { ...counts, missing: missing.length },
    missing,
    durationMs,
    checks,
  };
  banner('summary');
  for (const c of checks) log(`${c.status.toUpperCase().padEnd(4)} ${c.id.padEnd(18)} ${c.reason || c.title}`);
  for (const id of missing) log(`MISS ${id.padEnd(18)} the run ended before this check could report`);
  log(`${summary.ok ? 'PASS' : 'FAIL'} ${VARIANT} in ${Math.round(durationMs / 1000)}s`);
  const line = JSON.stringify(summary);
  process.stdout.write(line + '\n');
  if (args.summary) {
    try {
      writeFileSync(args.summary, line + '\n');
      log(`summary written to ${args.summary}`);
    } catch (e) {
      log(`could not write ${args.summary}: ${e?.message || e}`);
    }
  }
  return summary;
}

function parseArgs(argv) {
  const out = {
    framework: null,
    platform: null,
    appDir: null,
    home: null,
    keep: false,
    skipRace: false,
    dryRun: false,
    summary: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--framework') out.framework = argv[++i];
    else if (a === '--platform') out.platform = argv[++i];
    else if (a === '--app-dir') out.appDir = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--summary') out.summary = argv[++i];
    else if (a === '--keep') out.keep = true;
    else if (a === '--skip-race') out.skipRace = true;
    else if (a === '--dry-run') out.dryRun = true;
    else {
      process.stderr.write(`[cache-e2e] ERROR: unknown arg: ${a}\n`);
      process.exit(1);
    }
  }
  return out;
}

function plan() {
  log(`framework=${FRAMEWORK} platform=${PLATFORM} expectedMode=${EXPECTED_MODE} artifact=*${ARTIFACT_EXT}`);
  log(`STIM_HOME=${HOME_DIR}`);
  log(`work dir=${WORK_DIR}`);
  log(`build cache=${BUILD_CACHE_ROOT} (forced; any inherited STIM_BUILD_CACHE is ignored)`);
  log(`metro cache=${METRO_CACHE_ROOT} (forced; any inherited STIM_METRO_CACHE is ignored)`);
  log(`temp dir=${CACHE_TMP_DIR} (forced so Metro's default store cannot hide shared-store writes)`);
  log(PLATFORM === 'ios' ? `xcode CAS=${CAS_DIR}` : `gradle build cache=${GRADLE_CACHE_DIR}`);
  log(`race build cache=${RACE_CACHE_ROOT}`);
  log(
    args.appDir
      ? `using existing app: ${resolve(args.appDir)}`
      : `fixture: ${FIXTURE_COMMANDS[FRAMEWORK]('<appDir>').map(quote).join(' ')} (runtime state stays under STIM_HOME)`,
  );
  log(`checks: ${Object.keys(CHECK_TITLES).join(', ')}`);
}

if (!['bare', 'expo'].includes(FRAMEWORK) || !['ios', 'android'].includes(PLATFORM)) {
  die(
    'usage: run-cache-e2e.mjs --framework <bare|expo> --platform <ios|android> [--app-dir P] [--home P] [--keep] [--skip-race] [--summary F] [--dry-run]',
  );
}

banner(`cache e2e: ${VARIANT}`);
plan();
if (args.dryRun) {
  log('dry run: no side effects. Exiting.');
  process.exit(0);
}

const startedAt = Date.now();
main().then(
  () => {
    const summary = emitSummary(Date.now() - startedAt, null);
    if (!args.keep) cleanupTmp([WORK_DIR, args.home ? null : HOME_DIR]);
    return process.exit(summary.ok ? 0 : 1);
  },
  (err) => {
    log(`FATAL: ${err?.message || err}`);
    dumpDiagnostics(h, created);
    emitSummary(Date.now() - startedAt, String(err?.message || err));
    if (!args.keep) cleanupTmp([WORK_DIR, args.home ? null : HOME_DIR]);
    return process.exit(1);
  },
);
