#!/usr/bin/env node
// CACHE E2E DRIVER (the CACHE suite) -- the executable replacement for the
// hand-written cache field passes.
//
// WHY IT EXISTS. rn-iso's whole value is the caches it supplies without asking
// a repo to change: the Metro transform store, Xcode's compilation cache, the
// Gradle build cache, the fingerprint build cache, carried Pods, and the
// single-flight lock that keeps two workspaces from compiling the same thing
// twice. Every one of them is INVISIBLE when it breaks: the flag is still on
// the command line, the build still succeeds, and the only symptom is time.
// Manual passes kept drifting -- one Android pass never checked Gradle caching
// at all, a zero-config pass ran iOS-only and left `--build-cache` unproven,
// and a broken Expo Metro store shipped through green CI (#73) because nothing
// measured the directory it was supposed to be filling.
//
// THE THREE-PART RULE. For every cache, this suite proves three separate
// things, and refuses to accept one as evidence of another:
//
//   ENGAGED   the flag / setting / record is really there, read back from the
//             REAL command line or the REAL log -- never re-derived from this
//             file's idea of what rn-iso should have done.
//   STORES    the cache directory actually GREW: a file count before and a
//             file count after. This is the one that matters. An engaged cache
//             that stores nothing is exactly the shape of the old hook bug, and it
//             is indistinguishable from a working one by every other means.
//   REUSED    a SECOND workspace got the stored work back.
//
// HONESTY RULES, which are the point of the whole file:
//   - every assertion prints the evidence it checked: numbers, and quoted lines;
//   - a check that cannot run SKIPS with the reason spelled out ("no Android
//     SDK on this runner"), and a skip is never a pass;
//   - nothing passes silently. A check that reports nothing is a failure.
//
// USAGE
//   node run-cache-e2e.mjs --framework <bare|expo> --platform <ios|android> [opts]
//     --app-dir <path>    use an existing checkout instead of creating a fixture
//     --home <path>       reuse an RN_ISO_HOME instead of a throwaway one
//     --keep              skip teardown (leave worktrees/sims for inspection)
//     --skip-race         skip the single-flight phase (it costs one full
//                         compile); the check reports SKIP with that reason
//     --summary <file>    also write the machine-readable summary here
//     --dry-run           print the plan and exit (no side effects)
//
// OUTPUT. Every human line goes to STDERR. STDOUT carries exactly one line: the
// machine-readable summary, the same shape `rn-iso <platform> --json` uses --
// one parseable object, nothing else.
//
// It talks to rn-iso ONLY through its CLI and the filesystem, like the loop
// suite beside it, so it is also a black-box check of the published surface.
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
  verifyCleanup,
  workspaceLogsDir,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CLI = join(REPO, 'packages', 'rn-iso', 'dist', 'cli.js');

// ---- args -------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const FRAMEWORK = args.framework;
const PLATFORM = args.platform;
const VARIANT = `${FRAMEWORK}-${PLATFORM}`;
const EXPECTED_MODE = FRAMEWORK === 'expo' ? 'expo-child' : 'bare-inproc';
const ARTIFACT_EXT = PLATFORM === 'ios' ? '.app' : '.apk';

const HOME_DIR = args.dryRun ? '<dry-run>' : args.home || mkdtempSync(join(tmpdir(), `rn-iso-cache-${VARIANT}-home-`));
const WORK_DIR = args.dryRun ? '<dry-run>' : mkdtempSync(join(tmpdir(), `rn-iso-cache-${VARIANT}-`));

// THE CACHE ROOTS. Laid out under the throwaway home, and the two env overrides
// are FORCED rather than honoured -- the one place this suite deliberately
// differs from the loop suite beside it.
//
// The loop suite lets CI persist RN_ISO_BUILD_CACHE across runs on purpose, so
// the cross-run cache path is exercised; it has RN_ISO_E2E_WARM_CACHE to relax
// its cold-miss assertion when that happens. This suite cannot: EVERY number it
// reports is a before/after around a cold compile, and a warm inherited cache
// turns "the CAS gained 4,000 files" into "the CAS gained 0 files and the build
// was a hit", which is a measurement of nothing. Inheriting a developer's real
// RN_ISO_BUILD_CACHE / RN_ISO_METRO_CACHE would also write this fixture's
// entries into their machine's shared caches, which the throwaway home exists
// to prevent. So both are overridden, and the plan prints where they landed.
const BUILD_CACHE_ROOT = args.dryRun ? '<dry-run>' : join(HOME_DIR, 'build-cache');
const METRO_CACHE_ROOT = args.dryRun ? '<dry-run>' : join(HOME_DIR, 'metro-cache');
const CAS_DIR = join(HOME_DIR, 'compilation-cache');
const ENV = {
  ...process.env,
  RN_ISO_HOME: HOME_DIR,
  RN_ISO_BUILD_CACHE: BUILD_CACHE_ROOT,
  RN_ISO_METRO_CACHE: METRO_CACHE_ROOT,
  CI: '1',
};
process.env.RN_ISO_HOME = HOME_DIR;
// Gradle's LOCAL build cache. It lives under the Gradle user home, which is
// what makes `--build-cache` cross-worktree with nothing else configured.
const GRADLE_CACHE_DIR = join(process.env.GRADLE_USER_HOME || join(homedir(), '.gradle'), 'caches', 'build-cache-1');
// A build-cache root the racers alone address, so "the same fingerprint, not in
// the cache" needs no source mutation: the fingerprint is IDENTICAL to the one
// wt1 stored, and the only reason it misses is that this root is empty. That
// keeps the single-flight check about the LOCK and nothing else.
const RACE_CACHE_ROOT = args.dryRun ? '<dry-run>' : join(WORK_DIR, 'race-build-cache');

const h = createHarness({ env: ENV, cliPath: CLI, label: `cache-e2e ${VARIANT}` });
const { cli, cliJson, sh, log, banner, die } = h;

const created = []; // worktree paths we made, for cleanup + diagnostics

// ---- the check ledger -------------------------------------------------------
//
// Each of the eight checks records its own evidence and exactly one verdict.
// Nothing else may write a verdict, and a check that finishes without one is a
// failure -- "nothing said no" is not a pass.

const CHECK_TITLES = {
  'zero-config': 'the repo is untouched by rn-iso runtime state',
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
    // One line of evidence. Printed as it is recorded so a CI log reads in
    // order, and kept so the summary can carry it.
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

// Runs one check's body. A throw inside is that check's FAILURE, not the run's:
// the remaining caches are still worth measuring, and a suite that stops at the
// first red tells you about one cache instead of eight. Only the setup phases
// outside this (fixture, wt1's build) are fatal, because nothing downstream of
// them means anything.
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

// A check whose preconditions never happened. Used when an earlier phase means
// there is nothing to measure -- and it says which phase.
function skipCheck(id, reason) {
  openCheck(id).skip(reason);
}

// ---- the run ----------------------------------------------------------------

async function main() {
  preflight(h, PLATFORM);

  // ---- phase 0: the fixture and the untouched-repo baseline ----------------
  //
  // The fixture and every worktree must remain project-tree clean: runtime state
  // is written to the isolated global RN_ISO_HOME.
  const appDir = args.appDir ? resolve(args.appDir) : createFixture({ framework: FRAMEWORK, workDir: WORK_DIR, h });
  const expoSdk = FRAMEWORK === 'expo' ? readExpoSdkMajor(appDir) : null;
  log(`app: ${appDir}`);
  if (FRAMEWORK === 'expo') log(`Expo SDK: ${expoSdk ?? 'unknown'}`);
  const baseline = snapshotRepo(appDir);
  log(`baseline: porcelain ${baseline.porcelain === '' ? 'CLEAN' : JSON.stringify(baseline.porcelain)}`);
  log(`baseline: .gitignore ${baseline.gitignoreExists ? `${baseline.gitignore.length} bytes` : 'ABSENT'}`);
  mkdirSync(RACE_CACHE_ROOT, { recursive: true });

  // Snapshots of every worktree's dirty state, taken immediately before that
  // worktree is removed. The zero-config check reads them at the end.
  const dirtyByWorktree = [];

  // ---- phase 1: wt1, the cold build that fills every cache -----------------
  const wt1 = worktreeCreate('e2e-cache-1', appDir);
  const start1 = startAndAssertMode(wt1);
  log(`wt1 start mode=${start1.mode} port=${start1.port}`);

  const storeRoot1 = metroStoreRootFrom(wt1);
  const metroBefore1 = dirStats(storeRoot1 || METRO_CACHE_ROOT);
  const casBefore1 = dirStats(CAS_DIR);
  const gradleBefore1 = dirStats(GRADLE_CACHE_DIR);

  const build1 = build(wt1, 'wt1 (cold)');
  assert(
    build1.cacheHit === false,
    `wt1 must be a cache MISS on a throwaway home, got ${JSON.stringify(build1.cacheHit)}`,
  );
  assertArtifact(build1.appPath);

  // The store fills WHILE the app launches and asks this workspace's Metro for
  // a bundle, which outlives the command that started it. Wait for the count to
  // stop moving rather than sampling once and hoping.
  const metroAfter1 = await settle(storeRoot1 || METRO_CACHE_ROOT, 'wt1 Metro store');
  const casAfter1 = dirStats(CAS_DIR);
  const gradleAfter1 = dirStats(GRADLE_CACHE_DIR);

  // ---- phase 2: wt2, the second workspace ----------------------------------
  const wt2 = worktreeCreate('e2e-cache-2', appDir);
  const start2 = startAndAssertMode(wt2);
  log(`wt2 start mode=${start2.mode} port=${start2.port}`);
  const storeRoot2 = metroStoreRootFrom(wt2);
  const metroBefore2 = dirStats(storeRoot2 || METRO_CACHE_ROOT);
  const build2 = build(wt2, 'wt2 (expect HIT)');
  // Not a check of its own -- the loop suite already owns this one -- but every
  // measurement below assumes wt2 got its artifact from the cache rather than
  // compiling a second copy, so it is asserted before anything reads it.
  assert(
    build2.cacheHit === 'local' || build2.cacheHit === 'remote',
    `wt2 must HIT the build cache, got ${JSON.stringify(build2.cacheHit)}`,
  );
  assertArtifact(build2.appPath);
  const metroAfter2 = await settle(storeRoot2 || METRO_CACHE_ROOT, 'wt2 Metro store');

  // ---- check 2: the Metro transform store ----------------------------------
  await runCheck('metro-store', (c) => {
    if (FRAMEWORK === 'expo' && (expoSdk === null || expoSdk < 54)) {
      return c.skip(
        expoSdk === null
          ? 'the Expo SDK could not be determined; rn-iso intentionally leaves its Metro cache unchanged'
          : `Expo SDK ${expoSdk} predates the config override added in SDK 54; rn-iso intentionally leaves its Metro cache unchanged`,
      );
    }
    const rec1 = metroStoreRecords(wt1);
    const rec2 = metroStoreRecords(wt2);

    // EVERY MEASUREMENT FIRST, THEN THE VERDICT. An earlier version asserted as
    // it went and returned on the first failure, which meant a run that failed
    // on the record never printed the file counts -- and the counts are the
    // half that says whether the store is merely unreported or genuinely empty.
    // So the problems are collected and reported together.
    const problems = [];

    // (1) ENGAGED, per dev-server mode. For expo the confirming
    // `cache_store_added` can only be written when the config adapter reports back from
    // inside the child; for bare it is the in-process append. rn-iso's own
    // `cache_store_requested` is explicitly NOT evidence: it records what
    // rn-iso ASKED for, before the process that has to honour it even exists.
    // That distinction IS #73's fix, and this is the check that makes having it
    // worth something.
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
      // The adapter fails SOFT by design, so its warning means a working dev
      // server with no shared cache -- green CI, no cache.
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

    // (2) STORES and (3) REUSED, printed whatever the records said above.
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

  // ---- check 3 / 4: the compiler-level caches ------------------------------
  if (PLATFORM === 'ios') {
    await runCheck('xcode-cas', (c) => {
      // ENGAGED, read VERBATIM off the argv rn-iso actually ran. engine/xcode.ts
      // writes it as the build log's first record precisely so this is readable
      // rather than reconstructable.
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
        // Below the floor the settings do nothing at all, and rn-iso adds none
        // on purpose. That is a SKIP with the version in it, not a pass.
        const xc = sh('xcodebuild', ['-version'], { allowFail: true }).stdout.trim().split('\n')[0] || 'unknown';
        const major = /^Xcode\s+(\d+)/.exec(xc);
        if (!major || Number(major[1]) < 26) {
          return c.skip(
            `compilation caching needs Xcode 26+; this runner reports ${JSON.stringify(xc)}, and rn-iso adds no settings below that floor`,
          );
        }
        return c.fail(`the xcodebuild argv is missing ${missing.length} setting(s): ${missing.join(' ')}`);
      }
      c.ev(`all 5 compilation-cache settings present verbatim on the argv (CAS at ${CAS_DIR})`);

      // STORES.
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
      // ENGAGED, off the real argv -- engine/gradle.ts writes the same
      // build_start record engine/xcode.ts does (issue #78), so this reads what
      // ran instead of racing `ps` against a live build.
      const argv = buildStartArgv(wt1);
      assert(argv, `no build_start record in ${buildLog(wt1)}`);
      c.ev(`gradlew argv: ${argv}`);
      assert(/gradlew/.test(argv), `the build_start record does not name gradlew: ${argv}`);
      assert(
        /\s--build-cache(\s|$)/.test(argv),
        `--build-cache is NOT on the gradlew argv, so gradle ran with its task-output cache off: ${argv}`,
      );
      c.ev('--build-cache present on the argv rn-iso composed');

      // STORES.
      const g = growth('Gradle build cache', gradleBefore1, gradleAfter1);
      c.ev(describeGrowth(g));
      assert(
        g.added > 0,
        `${GRADLE_CACHE_DIR} gained no entries across a cold assemble. Gradle only creates and fills it when --build-cache is on, so this is engaged-but-not-storing.`,
      );

      // REUSED. rn-iso's own fingerprint cache would short-circuit gradle
      // entirely in wt2, so --no-build-cache turns THAT lookup off (and only
      // that one) to force gradle to run and show its FROM-CACHE outcomes.
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
        `--build-cache on the argv; cache +${g.added} files; ${lines.length} FROM-CACHE task(s) in the second worktree`,
      );
    });
  } else {
    skipCheck('gradle-cache', `platform is ${PLATFORM}: the Gradle build cache is an Android-only cache`);
  }

  // ---- check 5: the fingerprint build cache --------------------------------
  await runCheck('fingerprint-cache', (c) => {
    const platformDir = join(BUILD_CACHE_ROOT, PLATFORM);
    const keys = existsSync(platformDir) ? readdirSync(platformDir) : [];
    c.ev(`entries under ${platformDir}: ${keys.length} (${keys.join(', ') || 'none'})`);
    assert(keys.length > 0, 'the cold build stored no cache entry at all');

    // THE POST-MUTATION KEY. prebuild and pod install REWRITE fingerprinted
    // inputs, so the key the cold run looked up is not the key it stored under.
    // The only honest way to prove the entry landed under the right one is to
    // ask the same tree again: a second run in wt1 must HIT what the first
    // stored.
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

    // The entry itself, complete. The artifact alone is not a complete entry:
    // fingerprint-sources.json is what lets a later MISS say what moved, and on
    // an Android RELEASE entry assets-manifest.json is what lets the APK swap
    // refuse an asset it cannot package.
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

  // ---- check 8: gc's view, taken while every cache is warm -----------------
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

    // The rows must actually cover the caches this run filled. A cache absent
    // from gc is an unbounded directory nothing will ever trim -- the exact
    // hazard registerMetroStore's own comment names.
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

  // wt2 has said everything it can; free its simulator before the race adds two
  // more workspaces to this machine.
  stopWorkspace(wt2);

  // ---- phase 3: the race, which also proves pods reuse and CAS reuse -------
  let raceOutcome = null;
  if (args.skipRace) {
    log('--skip-race: the single-flight phase (one full compile) is being skipped');
  } else {
    // From wt1, NOT from the main checkout: --carry-ignored then clones wt1's
    // ios/ and its installed Pods, which is what the pods-reuse check needs.
    const wt3 = worktreeCreate('e2e-cache-3', wt1);
    const wt4 = worktreeCreate('e2e-cache-4', wt1);
    startAndAssertMode(wt3);
    startAndAssertMode(wt4);
    const casBeforeRace = dirStats(CAS_DIR);
    banner('racing two workspaces at ONE uncached fingerprint');
    log(`both address an empty build cache at ${RACE_CACHE_ROOT}; the build LOCK is shared through RN_ISO_HOME`);
    const raceEnv = { ...ENV, RN_ISO_BUILD_CACHE: RACE_CACHE_ROOT };
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
    const builders = [r3, r4].filter((r) => !r.facts.waitedForBuild);
    assert(
      waiters.length === 1,
      `exactly one racer must have waited; ${waiters.length} did. Both compiling is the duplicate-work the lock exists to prevent.`,
    );
    const waiter = waiters[0];
    const builder = builders[0];
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
    // The WAITER never reaches the pods step at all (it is on the cache path),
    // so only the BUILDER can prove this: it missed the cache, ran the build
    // path, and had to decide about pods with Pods/ already carried in.
    const { r3, r4 } = raceOutcome;
    const builder = [r3, r4].find((r) => !r.facts.waitedForBuild);
    assert(builder, 'no racer took the build path, so nothing decided about pods');
    const phases = builder.stderr
      .split('\n')
      .map((l) => stripAnsi(l).trimEnd())
      // phaseLine pads the name to 11 characters and adds one space, so an
      // 11-character name like `fingerprint` is followed by a SINGLE space.
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

  // The REUSED half of check 3, measured on the race's compile: a compile in a
  // workspace that has never compiled anything, against a CAS wt1 filled. It is
  // appended to the xcode-cas entry rather than being its own check, because
  // "reused" is one third of one cache's verdict, not a ninth cache.
  if (PLATFORM === 'ios') annotateCasReuse(raceOutcome, casBefore1, casAfter1);

  // ---- phase 4: teardown, and the zero-config verdict ----------------------
  banner('teardown');
  for (const wt of created.toReversed()) {
    if (!existsSync(wt)) continue;
    stopWorkspace(wt);
    // The diff PER DIRTY PATH, captured before the worktree goes away: a
    // verdict of "rn-iso changed a file it had no business changing" is worth
    // nothing without the lines it changed, and this directory is about to be
    // deleted.
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
          c.ev(`  CRITICAL: rn-iso modified ${path}`);
          showDiff();
          critical += 1;
        } else if (POD_CHURN_PATHS.some((re) => re.test(path))) {
          c.ev(`  ${path} -- CocoaPods' own install output, not an rn-iso edit`);
        } else if (FRAMEWORK === 'expo' && PREBUILD_CHURN_PATHS.some((re) => re.test(path))) {
          c.ev(`  ${path} -- \`expo prebuild\` output, not an rn-iso edit; the lines it wrote:`);
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
        `${critical} CRITICAL edit(s): rn-iso supplies every cache on its own command line and must touch none of metro.config.js / Podfile / gradle.properties`,
      );
    }
    if (unexplained > 0) return c.fail(`${unexplained} change(s) rn-iso cannot account for`);

    // Worktree removal ran without --force and the main checkout remains exact.
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

// The three files a repo owns that rn-iso is never allowed to write, because
// supplying the cache on its own command line instead of editing them is the
// entire zero-config claim.
const CRITICAL_PATHS = [/(^|\/)metro\.config\.[cm]?[jt]s$/, /(^|\/)Podfile$/, /(^|\/)gradle\.properties$/];

// CocoaPods rewrites these itself when it installs; they are the project's own
// build tool doing its job, not rn-iso authoring a file. Named explicitly so
// anything ELSE that shows up is a failure rather than a shrug.
const POD_CHURN_PATHS = [
  /\.xcodeproj\/project\.pbxproj$/,
  /Info\.plist$/,
  /PrivacyInfo\.xcprivacy$/,
  /(^|\/)Podfile\.lock$/,
  /\.xcworkspace/,
];

// `expo prebuild` writes these itself on a MANAGED app: it stamps the resolved
// bundleIdentifier / package into the app config and repoints package.json's
// ios/android scripts at `expo run:*`. rn-iso only INVOKES prebuild, and only
// when the native directory is absent -- the generator's own output is not an
// rn-iso edit. Allowed for the expo framework only (a bare app runs no
// prebuild, so the same change there IS unexplained), and the diff is printed
// either way so a reviewer sees exactly what landed.
const PREBUILD_CHURN_PATHS = [/(^|\/)package\.json$/, /(^|\/)app\.(json|config\.[cm]?[jt]s)$/];

// ---- steps ------------------------------------------------------------------

function worktreeCreate(name, sourceDir) {
  const r = cli(['worktree', 'create', name, '--base', 'head', '--carry-ignored'], { cwd: sourceDir });
  const path = r.stdout.trim().split('\n').filter(Boolean).pop();
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
    die(`rn-iso start failed (exit ${r.code}):\n${lastLines(r.stderr, 40)}`);
  }
  const facts = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
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

// Removal WITHOUT --force. Restore fixture-induced tracked churn first, then
// let rn-iso remove a genuinely clean worktree; no project file is exempt.
function worktreeRemove(path) {
  sh('git', ['-C', path, 'checkout', '--', '.'], { allowFail: true });
  sh('git', ['-C', path, 'clean', '-fdq', 'ios', 'android'], { allowFail: true });
  const r = cli(['worktree', 'remove', path], { allowFail: true });
  assert(r.code === 0, `worktree remove refused a worktree after fixture-induced changes were restored:\n${r.stderr}`);
  log(`removed worktree ${path}`);
}

// Appends the CAS "REUSED" third to the xcode-cas verdict, or says in the
// evidence why it could not be measured. Never upgrades a verdict: it can only
// confirm a pass or turn it into a failure.
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

// ---- evidence readers -------------------------------------------------------

// The metro.ndjson records that say what happened to the shared transform
// store: the confirmation, and the adapter's fail-soft warning.
function metroStoreRecords(cwd) {
  const file = join(workspaceLogsDir(cwd), 'metro.ndjson');
  const records = readNdjson(file);
  return {
    file,
    // WHAT RN-ISO ASKED FOR, kept separate from what happened. `requested` is
    // written by rn-iso itself before the dev-server child exists; only `added`
    // can report that the store reached the config Metro loaded. Reading them
    // as one thing is the bug #73 was, so this suite names them apart.
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

// The store root a workspace's own record names. Read from the record rather
// than recomputed, so a product that changes where the store lives is caught
// here instead of being silently followed.
function metroStoreRootFrom(cwd) {
  const rec = metroStoreRecords(cwd).added;
  if (!rec) return null;
  const m = /(?:through|store at)\s+(\S+)/.exec(String(rec.msg));
  return m ? m[1] : null;
}

// The build log's build_start record: the literal argv rn-iso ran. iOS has
// written it since engine/xcode.ts existed; Android got the matching record in
// issue #78, which is what lets the Gradle check read a flag instead of racing
// `ps` against a live build.
function buildStartArgv(cwd) {
  const rec = readNdjson(buildLog(cwd)).find((r) => r.event === 'build_start');
  return rec ? String(rec.msg) : null;
}

// ---- git --------------------------------------------------------------------

// TRAILING newlines only. `.trim()` here ate the LEADING SPACE of the first
// line -- porcelain's status field is two columns wide, so ` M .gitignore`
// became `M .gitignore` and every path was then read one character short
// (`gitignore`). Found by the first real run of this suite.
function porcelain(dir) {
  return sh('git', ['-C', dir, 'status', '--porcelain'], { allowFail: true }).stdout.replace(/\n+$/, '');
}

function fileDiff(dir, path) {
  return sh('git', ['-C', dir, 'diff', '--', path], { allowFail: true }).stdout;
}

// PURE. The path out of one `git status --porcelain` line: two status columns,
// a space, then the path -- quoted when it needs escaping, and `old -> new` for
// a rename, of which the destination is the one that exists.
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

// ---- async process ----------------------------------------------------------

// The race needs two rn-iso runs in flight at once, which spawnSync cannot do.
// Same capture-and-echo contract as harness.sh, plus the parsed --json line.
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
        facts = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
      } catch {
        // A run that failed before its JSON line still has a stderr worth
        // reporting; the caller asserts on the exit code first.
      }
      resolveP({ code: code ?? 1, stdout, stderr, facts, cwd });
    });
  });
}

// ---- measurement ------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A cache filled by a process we do not own (Metro serving a bundle to an app
// that just launched) is still filling when the command returns. Sample until
// the count stops moving, then report -- and say so if it never settled, rather
// than pretending the first sample was the answer.
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
    // A DIRECTORY THAT HAS NOT MOVED YET IS NOT A SETTLED ONE. The first
    // version of this returned after six quiet seconds, which on a cold graph
    // is just "Metro has not written anything yet" -- an unfilled cache and a
    // fast one then read identically, and telling those two apart is the whole
    // job. So a sample run that has seen NO change waits out firstGrowthMs
    // before reporting, and says which of the two it is.
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

// The phase lines rn-iso prints can be coloured, and the assertions match on
// their TEXT. The escape byte is built with fromCharCode rather than written
// into the regex literal so this file stays ASCII (CLAUDE.md).
const ANSI = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;]*m`, 'g');

function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

// ---- summary ----------------------------------------------------------------

// ONE parseable line on stdout, the same contract the CLI's own --json output
// keeps. Everything human went to stderr.
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
  // A check that never ran at all is not silently absent from the tally.
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

// ---- args / plan ------------------------------------------------------------

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
  log(`RN_ISO_HOME=${HOME_DIR}`);
  log(`work dir=${WORK_DIR}`);
  log(`build cache=${BUILD_CACHE_ROOT} (forced; any inherited RN_ISO_BUILD_CACHE is ignored)`);
  log(`metro cache=${METRO_CACHE_ROOT} (forced; any inherited RN_ISO_METRO_CACHE is ignored)`);
  log(PLATFORM === 'ios' ? `xcode CAS=${CAS_DIR}` : `gradle build cache=${GRADLE_CACHE_DIR}`);
  log(`race build cache=${RACE_CACHE_ROOT}`);
  log(
    args.appDir
      ? `using existing app: ${resolve(args.appDir)}`
      : `fixture: ${FIXTURE_COMMANDS[FRAMEWORK]('<appDir>').map(quote).join(' ')} (runtime state stays under RN_ISO_HOME)`,
  );
  log(`checks: ${Object.keys(CHECK_TITLES).join(', ')}`);
}

// ---- entry ------------------------------------------------------------------

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
    process.exit(summary.ok ? 0 : 1);
  },
  (err) => {
    // A fatal setup failure (no fixture, no cold build) is not a check verdict:
    // it means the checks never got a chance, and the summary says exactly that
    // rather than reporting seven silent passes.
    log(`FATAL: ${err?.message || err}`);
    dumpDiagnostics(h, created);
    emitSummary(Date.now() - startedAt, String(err?.message || err));
    if (!args.keep) cleanupTmp([WORK_DIR, args.home ? null : HOME_DIR]);
    process.exit(1);
  },
);
