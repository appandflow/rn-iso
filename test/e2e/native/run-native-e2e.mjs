#!/usr/bin/env node
// NATIVE E2E DRIVER (the LOOP suite) -- codifies docs/field-test-protocol.md as
// an executable.
//
// This is the SLOW e2e. It creates a real app, drives the real rn-iso loop
// against a real simulator/emulator with a real compiler, and asserts the cache
// actually engages on a second worktree. It is a 2x2 matrix:
//
//     framework in {bare, expo}   x   platform in {ios, android}
//
// The two frameworks are not cosmetic variants: they exercise genuinely
// different rn-iso code paths.
//   - BARE hosts Metro IN-PROCESS from the project's node_modules and attaches
//     @rn-iso/metro's ndjsonReporter. `start --json` reports mode "bare-inproc".
//     Fingerprinting is provided by rn-iso's direct @expo/fingerprint dependency;
//     the bare fixture does not need to install it into the project.
//   - EXPO spawns the project's own `expo start --port N` as a CHILD and parses
//     its stdout. `start --json` reports mode "expo-child". A managed template
//     has no ios/android dir, so rn-iso runs `expo prebuild` first.
// The start-mode assertion is deliberate: a field test caught detectIsExpo
// misfiring on a wrapper-less app.json, so each variant asserts its mode
// EXPLICITLY rather than trusting detection.
//
// ITS SIBLING is test/e2e/native/run-cache-e2e.mjs, the CACHE suite: this file
// proves the loop works, that one proves each individual cache is engaged,
// storing and reused. The fixture creation, process wrappers and cleanup checks
// they share live in ./harness.mjs.
//
// USAGE
//   node run-native-e2e.mjs --framework <bare|expo> --platform <ios|android> [opts]
//     --app-dir <path>    use an existing checkout instead of creating a fixture
//     --keep              skip teardown (leave the worktrees/sims for inspection)
//     --fixture-only      create the fixture app, then stop before any build
//                         (safe to run anywhere: writes files, boots no device)
//     --dry-run           print the plan and exit (no side effects) -- the CI
//                         smoke and the local arg-parse check use this
//
// The fixture-creation commands are version-sensitive (the RN community CLI and
// create-expo-app change flags between releases), so each is overridable with an
// env var -- see FIXTURE_COMMANDS in harness.mjs -- and a reviewer setting up
// the runner can adjust them without touching the assertion logic.
//
// This driver talks to rn-iso ONLY through its CLI and through the filesystem,
// exactly as a real user (or the field-test agent) would. It imports nothing
// from packages/rn-iso, so it also serves as a black-box check of the published
// surface.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_COMMANDS,
  assert,
  buildLog,
  cleanupTmp,
  createFixture,
  createHarness,
  dumpDiagnostics,
  lastLines,
  preflight,
  quote,
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
// The compiler signatures that must be ABSENT from the second worktree's build
// log -- their presence would mean it compiled instead of installing the cache.
const COMPILE_SIGNS =
  PLATFORM === 'ios' ? [/xcodebuild/i, /CompileC\b/i, /Ld /] : [/gradlew/i, /:app:compile/i, /Task :app:/i];

// Throwaway home so the run never touches the developer's real registry or the
// real ~/.rn-iso/build-cache. The CI cache job maps a persistent build-cache
// into this path deliberately (see e2e-native.yml); locally it is ephemeral.
// --dry-run makes NO side effects, so it does not even create temp dirs.
const HOME_DIR = args.dryRun ? '<dry-run>' : args.home || mkdtempSync(join(tmpdir(), `rn-iso-native-${VARIANT}-home-`));
const WORK_DIR = args.dryRun ? '<dry-run>' : mkdtempSync(join(tmpdir(), `rn-iso-native-${VARIANT}-`));
const ENV = { ...process.env, RN_ISO_HOME: HOME_DIR, CI: '1' };
process.env.RN_ISO_HOME = HOME_DIR;
// Set by the CI job when actions/cache RESTORED a persisted build cache: the
// first build may then be a cross-run hit rather than a cold miss. See step 2.
const WARM_CACHE = process.env.RN_ISO_E2E_WARM_CACHE === '1';

const h = createHarness({ env: ENV, cliPath: CLI, label: `native-e2e ${VARIANT}` });
const { cli, cliJson, sh, log, banner, die } = h;

const created = []; // worktree paths we made, for cleanup + diagnostics.

// ---- the run ----------------------------------------------------------------

async function main() {
  preflight(h, PLATFORM);

  // 1. Fixture: a freshly created app, committed, with a bare remote so
  //    `worktree remove` sees the branch tip as pushed (no --force needed).
  const appDir = args.appDir ? resolve(args.appDir) : createFixture({ framework: FRAMEWORK, workDir: WORK_DIR, h });
  if (args.fixtureOnly) {
    log(`fixture-only: app created at ${appDir}. Stopping before any build.`);
    return;
  }

  // 2. First worktree -> cold build. On a fresh cache cacheHit MUST be false; a
  //    real artifact MUST exist; launched is true-or-unverified (unverified is
  //    handled, not a failure -- see the protocol).
  //
  //    RN_ISO_E2E_WARM_CACHE relaxes ONLY the cold-miss assertion: the CI job
  //    persists RN_ISO_BUILD_CACHE across runs (actions/cache), and on a run
  //    that restored a cache holding THIS fingerprint the first build is itself
  //    a legitimate cross-run HIT -- which is exactly the cross-run path the
  //    persisted cache exists to exercise. The registry (RN_ISO_HOME) is still
  //    throwaway, so device/project state stays deterministic. The wt2 proof
  //    below is unconditional either way.
  const wt1 = worktreeCreate('e2e-1', appDir);
  const start1 = startAndAssertMode(wt1);
  log(`wt1 start mode: ${start1.mode}`);
  const build1 = buildAndAssert(wt1, { expectCacheHit: false });
  if (WARM_CACHE) {
    log(
      build1.cacheHit
        ? `wt1 warm-started from the cross-run cache (${build1.cacheHit}) -- cross-run cache path exercised`
        : 'wt1 cold build: the restored cross-run cache held no matching fingerprint',
    );
  } else {
    assert(build1.cacheHit === false, `cold build must be a cache MISS, got ${JSON.stringify(build1.cacheHit)}`);
  }
  assertArtifact(build1.appPath);
  handleLaunch(build1, 'wt1');

  // 3. Second worktree, SAME commit -> the cache must engage: cacheHit "local"
  //    and NO compile in the build log (the whole reason this tool exists).
  const wt2 = worktreeCreate('e2e-2', appDir);
  const start2 = startAndAssertMode(wt2);
  log(`wt2 start mode: ${start2.mode}`);
  const build2 = buildAndAssert(wt2, { expectCacheHit: true });
  assert(
    build2.cacheHit === 'local' || build2.cacheHit === 'remote',
    `second worktree must HIT the cache, got ${JSON.stringify(build2.cacheHit)}`,
  );
  assertArtifact(build2.appPath);
  assertNoCompile(wt2);
  handleLaunch(build2, 'wt2');
  log('CACHE PROOF: second worktree installed from cache without compiling.');

  // 4. Teardown: stop each, remove each (NO --force), then the protocol's five
  //    cleanup checks.
  cli(['stop'], { cwd: wt2 });
  cli(['stop'], { cwd: wt1 });
  worktreeRemove(wt2);
  worktreeRemove(wt1);
  verifyCleanup({ h, platform: PLATFORM, appDir, created });
}

// ---- steps ------------------------------------------------------------------

function worktreeCreate(name, appDir) {
  // --carry-ignored clones node_modules (and Pods, on iOS) so the worktree can
  // build without a reinstall -- fast (APFS clone) on macOS, a full copy on the
  // Linux android runner but still correct. stdout is ONLY the path.
  const r = cli(['worktree', 'create', name, '--base', 'head', '--carry-ignored'], { cwd: appDir });
  const path = r.stdout.trim().split('\n').findLast(Boolean);
  assert(path && existsSync(path), `worktree create did not yield a real path: ${JSON.stringify(r.stdout)}`);
  created.push(path);
  log(`worktree ${name} -> ${path}`);
  return path;
}

function startAndAssertMode(cwd) {
  // --wait 240 (vs the 60s default): a bare RN app hosts Metro in-process, and
  // its first metro-file-map crawl + transform on a cold, loaded CI runner can
  // take well over a minute -- the android-bare job hit RN_ISO_METRO_TIMEOUT at
  // 60s. This is CI headroom, not a product change.
  const r = cli(['start', '--json', '--wait', '240'], { cwd, allowFail: true });
  if (r.code !== 0) {
    // The one diagnosis start's stderr cannot carry: WHY the supervisor / dev
    // server never verified. Surface its log right in the job output -- the
    // artifact upload misses dot-dirs unless include-hidden-files, and an
    // inline tail beats downloading an artifact anyway.
    const supLog = join(workspaceLogsDir(cwd), 'supervisor.log');
    if (existsSync(supLog)) {
      log(`--- supervisor.log (tail) ---\n${lastLines(readFileSync(supLog, 'utf-8'), 80)}`);
    }
    die(`rn-iso start failed (exit ${r.code}):\n${lastLines(r.stderr, 40)}`);
  }
  const line = r.stdout.trim().split('\n').findLast(Boolean);
  const facts = JSON.parse(line);
  assert(
    facts.mode === EXPECTED_MODE,
    `start mode for a ${FRAMEWORK} app must be ${EXPECTED_MODE}, got ${JSON.stringify(facts.mode)} ` +
      '(this is exactly the detectIsExpo path a field test caught misfiring)',
  );
  return facts;
}

function buildAndAssert(cwd, { expectCacheHit }) {
  log(`building ${PLATFORM} in ${cwd} (expect cache ${expectCacheHit ? 'HIT' : 'MISS'})...`);
  const facts = cliJson([PLATFORM, '--json'], { cwd, timeout: 40 * 60 * 1000 });
  log(
    `build facts: cacheHit=${JSON.stringify(facts.cacheHit)} launched=${JSON.stringify(facts.launched)} ` +
      `waitedForBuild=${JSON.stringify(facts.waitedForBuild)} durationMs=${facts.durationMs}`,
  );
  return facts;
}

function assertArtifact(appPath) {
  assert(
    typeof appPath === 'string' && appPath.endsWith(ARTIFACT_EXT),
    `appPath should be a ${ARTIFACT_EXT}, got ${JSON.stringify(appPath)}`,
  );
  assert(existsSync(appPath), `the built artifact does not exist on disk: ${appPath}`);
  log(`artifact ok: ${appPath}`);
}

// launched is three-valued (true | false | 'unverified'). 'unverified' is NOT a
// failure -- the app installed and launched, but no bundle request was observed
// (a picker awaiting a tap, a confirmation alert). The protocol says follow
// rn-iso's own guidance and judge; here we record it and continue.
function handleLaunch(facts, label) {
  if (facts.launched === true) {
    log(`${label} launched and verified.`);
    return;
  }
  if (facts.launched === 'unverified') {
    log(`${label} launched but UNVERIFIED (no bundle request seen) -- tolerated per protocol.`);
    return;
  }
  throw new Error(`${label} did not launch (launched=${JSON.stringify(facts.launched)})`);
}

// The build log for the second worktree must contain the launch record and NOT
// any compile step. This is the on-disk proof that the cache short-circuited the
// compiler, independent of the JSON's cacheHit field.
function assertNoCompile(cwd) {
  const logPath = buildLog(cwd);
  if (!logPath) {
    log('warn: no build-*.ndjson to inspect for compile signatures');
    return;
  }
  const text = readFileSync(logPath, 'utf-8');
  for (const sign of COMPILE_SIGNS) {
    assert(
      !sign.test(text),
      `the cached build's log contains a compile signature ${sign} -- it should have installed, not compiled:\n${logPath}`,
    );
  }
  log('no-compile proof: the second worktree build log holds no compiler invocation.');
}

function worktreeRemove(path) {
  // A worktree that COMPILED is not clean: pod install modifies tracked files
  // (project.pbxproj, Info.plist, PrivacyInfo.xcprivacy) and leaves untracked
  // output (Podfile.lock, *.xcworkspace). rn-iso's remove refuses that with a
  // documented remedy -- restore the churn, delete the untracked build output --
  // which is exactly what an agent following the refusal does, so the driver
  // does it too. `clean -fd` (no -x) skips gitignored paths such as
  // node_modules and Pods. rn-iso runtime state is global, outside this tree.
  // Both commands are no-ops on a cache-installed worktree that never compiled.
  sh('git', ['-C', path, 'checkout', '--', '.'], { allowFail: true });
  sh('git', ['-C', path, 'clean', '-fdq', 'ios', 'android'], { allowFail: true });
  // No --force: after the churn restore, a routine worktree must remove clean.
  const r = cli(['worktree', 'remove', path], { allowFail: true });
  assert(r.code === 0, `worktree remove refused a clean worktree:\n${r.stderr}`);
  log(`removed worktree ${path}`);
}

// ---- small utils ------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    framework: null,
    platform: null,
    appDir: null,
    keep: false,
    fixtureOnly: false,
    dryRun: false,
    home: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--framework') out.framework = argv[++i];
    else if (a === '--platform') out.platform = argv[++i];
    else if (a === '--app-dir') out.appDir = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--keep') out.keep = true;
    else if (a === '--fixture-only') out.fixtureOnly = true;
    else if (a === '--dry-run') out.dryRun = true;
    else {
      process.stderr.write(`[native-e2e] ERROR: unknown arg: ${a}\n`);
      process.exit(1);
    }
  }
  return out;
}

function plan() {
  log(`framework=${FRAMEWORK} platform=${PLATFORM} expectedMode=${EXPECTED_MODE} artifact=*${ARTIFACT_EXT}`);
  log(`RN_ISO_HOME=${HOME_DIR}`);
  log(`work dir=${WORK_DIR}`);
  log(
    args.appDir
      ? `using existing app: ${resolve(args.appDir)}`
      : `fixture: ${FIXTURE_COMMANDS[FRAMEWORK]('<appDir>').map(quote).join(' ')}`,
  );
}

// ---- entry (last, so every top-level const/function is initialized) --------

if (!['bare', 'expo'].includes(FRAMEWORK) || !['ios', 'android'].includes(PLATFORM)) {
  die(
    'usage: run-native-e2e.mjs --framework <bare|expo> --platform <ios|android> [--app-dir P] [--keep] [--fixture-only] [--dry-run]',
  );
}

banner(`native e2e: ${VARIANT} (expected start mode: ${EXPECTED_MODE})`);
plan();
if (args.dryRun) {
  log('dry run: no side effects. Exiting.');
  process.exit(0);
}

main().then(
  () => {
    log(`PASS ${VARIANT}`);
    if (!args.keep) cleanupTmp([WORK_DIR, args.home ? null : HOME_DIR]);
    process.exit(0);
  },
  (err) => {
    log(`FAIL ${VARIANT}: ${err?.message || err}`);
    dumpDiagnostics(h, created);
    if (!args.keep) cleanupTmp([WORK_DIR, args.home ? null : HOME_DIR]);
    process.exit(1);
  },
);
