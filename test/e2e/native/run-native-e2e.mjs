#!/usr/bin/env node
// NATIVE E2E DRIVER -- codifies docs/field-test-protocol.md as an executable.
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
//     A bare project has no @expo/fingerprint of its own, so the fixture installs
//     it (rn-iso ios hard-fails RN_ISO_NO_FINGERPRINT otherwise -- this is the
//     documented rn-iso-init step).
//   - EXPO spawns the project's own `expo start --port N` as a CHILD and parses
//     its stdout. `start --json` reports mode "expo-child". A managed template
//     has no ios/android dir, so rn-iso runs `expo prebuild` first.
// The start-mode assertion is deliberate: a field test caught detectIsExpo
// misfiring on a wrapper-less app.json, so each variant asserts its mode
// EXPLICITLY rather than trusting detection.
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
// env var -- see FIXTURE_COMMANDS below -- and a reviewer setting up the runner
// can adjust them without touching the assertion logic.
//
// This driver talks to rn-iso ONLY through its CLI and through the filesystem,
// exactly as a real user (or the field-test agent) would. It imports nothing
// from packages/rn-iso, so it also serves as a black-box check of the published
// surface.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Set by the CI job when actions/cache RESTORED a persisted build cache: the
// first build may then be a cross-run hit rather than a cold miss. See step 2.
const WARM_CACHE = process.env.RN_ISO_E2E_WARM_CACHE === '1';

const created = []; // worktree paths we made, for cleanup + diagnostics.
let mainCheckout = null;

// ---- the run ----------------------------------------------------------------

async function main() {
  preflight();

  // 1. Fixture: a freshly created app, committed, with a bare remote so
  //    `worktree remove` sees the branch tip as pushed (no --force needed).
  const appDir = args.appDir ? resolve(args.appDir) : createFixture();
  mainCheckout = appDir;
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
  verifyCleanup(appDir);
}

// ---- steps ------------------------------------------------------------------

function preflight() {
  // The CLI must run at all.
  const v = cli(['--version'], { allowFail: true });
  assert(v.code === 0, `rn-iso CLI does not run: ${v.stderr}`);
  log(`rn-iso ${v.stdout.trim()}`);

  // Toolchain presence is a SKIP, not a failure -- the ios variant needs Xcode,
  // the android variant needs the SDK. On a runner that lacks them the job
  // should not have scheduled this variant, but say so clearly if it did.
  if (PLATFORM === 'ios') {
    if (process.platform !== 'darwin') die('ios variant requires macOS + Xcode; this is not a macOS host.', 2);
    requireTool('xcrun', ['--version']);
    requireTool('xcodebuild', ['-version']);
  } else {
    // android: adb + emulator must be on PATH (the CI job sets this up via the
    // android-emulator-runner action + ANDROID_HOME). rn-iso creates and boots
    // its OWN owned AVD; it does not reuse the action's emulator.
    requireTool('adb', ['version']);
  }
}

function createFixture() {
  const appDir = join(WORK_DIR, 'app');
  const cmd = FIXTURE_COMMANDS[FRAMEWORK](appDir);
  log(`creating ${FRAMEWORK} fixture: ${cmd.map(quote).join(' ')}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: WORK_DIR, env: ENV, stdio: 'inherit', timeout: 20 * 60 * 1000 });
  if (r.status !== 0) die(`fixture creation failed (exit ${r.status ?? r.signal})`);
  assert(existsSync(join(appDir, 'package.json')), `fixture has no package.json at ${appDir}`);

  // A bare project has no @expo/fingerprint; rn-iso ios/android hard-fails
  // without it (RN_ISO_NO_FINGERPRINT). This is the documented rn-iso-init step,
  // done here so the cache path is reachable. (Expo templates already resolve
  // it through the `expo` dependency.)
  if (FRAMEWORK === 'bare') {
    const r2 = spawnSync('npm', ['install', '--no-audit', '--no-fund', '-D', '@expo/fingerprint'], {
      cwd: appDir,
      env: ENV,
      stdio: 'inherit',
      timeout: 10 * 60 * 1000,
    });
    if (r2.status !== 0) die('installing @expo/fingerprint into the bare fixture failed');
  } else {
    // create-expo-app ran with --no-install (its own install is flaky in CI),
    // so the fixture has no node_modules yet. Install now: `start`'s expo-child
    // needs `expo` resolvable (RN_ISO_EXPO_BIN otherwise), and worktree create
    // --carry-ignored only clones a node_modules that exists.
    const r2 = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: appDir,
      env: ENV,
      stdio: 'inherit',
      timeout: 15 * 60 * 1000,
    });
    if (r2.status !== 0) die('installing the expo fixture dependencies failed');
  }

  gitInitWithRemote(appDir);
  return appDir;
}

function worktreeCreate(name, appDir) {
  // --carry-ignored clones node_modules (and Pods, on iOS) so the worktree can
  // build without a reinstall -- fast (APFS clone) on macOS, a full copy on the
  // Linux android runner but still correct. stdout is ONLY the path.
  const r = cli(['worktree', 'create', name, '--base', 'head', '--carry-ignored'], { cwd: appDir });
  const path = r.stdout.trim().split('\n').filter(Boolean).pop();
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
    const supLog = join(cwd, '.rn-iso', 'logs', 'supervisor.log');
    if (existsSync(supLog)) {
      log(`--- supervisor.log (tail) ---\n${lastLines(readFileSync(supLog, 'utf-8'), 80)}`);
    }
    die(`rn-iso start failed (exit ${r.code}):\n${lastLines(r.stderr, 40)}`);
  }
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
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
  const log_ = buildLog(cwd);
  if (!log_) {
    log('warn: no build-*.ndjson to inspect for compile signatures');
    return;
  }
  const text = readFileSync(log_, 'utf-8');
  for (const sign of COMPILE_SIGNS) {
    assert(
      !sign.test(text),
      `the cached build's log contains a compile signature ${sign} -- it should have installed, not compiled:\n${log_}`,
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
  // does it too. `clean -fd` (no -x) skips gitignored paths, so node_modules,
  // Pods and .rn-iso/ are untouched. Both are no-ops on a cache-installed
  // worktree that never compiled.
  sh('git', ['-C', path, 'checkout', '--', '.'], { allowFail: true });
  sh('git', ['-C', path, 'clean', '-fdq', 'ios', 'android'], { allowFail: true });
  // No --force: after the churn restore, a routine worktree must remove clean.
  const r = cli(['worktree', 'remove', path], { allowFail: true });
  assert(r.code === 0, `worktree remove refused a clean worktree:\n${r.stderr}`);
  log(`removed worktree ${path}`);
}

// The protocol's five cleanup checks.
function verifyCleanup(appDir) {
  banner('cleanup checks');

  // (1) no rn-iso-* devices remain.
  if (PLATFORM === 'ios') {
    const out = sh('xcrun', ['simctl', 'list', 'devices']).stdout;
    assert(!/rn-iso-/.test(out), 'an rn-iso-* simulator was left behind');
  } else {
    const out = sh('emulator', ['-list-avds'], { allowFail: true }).stdout;
    assert(!/rn-iso-/.test(out), 'an rn-iso-* AVD was left behind');
  }
  log('(1) no rn-iso-* devices remain');

  // (2) no supervisor/collector processes.
  const ps = sh('ps', ['ax'], { allowFail: true }).stdout;
  assert(!/rn-iso.*supervisor|supervisor\/run\.js/.test(ps), 'a supervisor process is still running');
  log('(2) no supervisor/collector processes');

  // (3) status no longer lists our workspaces.
  const status = cli(['status'], { allowFail: true }).stdout;
  assert(!created.some((p) => status.includes(p)), 'status still lists a removed workspace');
  log('(3) status is clean of our workspaces');

  // (4) main checkout unchanged.
  const porcelain = sh('git', ['-C', appDir, 'status', '--porcelain']).stdout.trim();
  assert(porcelain === '', `main checkout is dirty after the run:\n${porcelain}`);
  const wl = sh('git', ['-C', appDir, 'worktree', 'list']).stdout;
  assert(!/e2e-1|e2e-2/.test(wl), `a worktree registration survived:\n${wl}`);
  log('(4) main checkout byte-clean, no worktrees linger');

  // (5) gc (report-only) finds nothing of ours orphaned.
  const gc = cli(['gc'], { allowFail: true });
  assert(!created.some((p) => gc.stdout.includes(p)), 'gc reports one of our workspaces as orphaned');
  log('(5) gc reports nothing of ours orphaned');
}

// ---- fixture commands (version-sensitive, overridable) ----------------------

const FIXTURE_COMMANDS = {
  // Bare RN via the community CLI. `--skip-git-init` because we init git
  // ourselves (with a remote); `--install-pods false` because rn-iso runs pod
  // install as part of `ios`. Override with RN_ISO_E2E_BARE_INIT if a newer CLI
  // changes the flags.
  bare(appDir) {
    if (process.env.RN_ISO_E2E_BARE_INIT) return withDir(process.env.RN_ISO_E2E_BARE_INIT, appDir);
    return [
      'npx',
      '--yes',
      '@react-native-community/cli@latest',
      'init',
      'RnIsoE2E',
      '--directory',
      appDir,
      '--skip-git-init',
      '--install-pods',
      'false',
      '--pm',
      'npm',
    ];
  },
  // Managed Expo via a MINIMAL template (blank), so rn-iso's `expo prebuild`
  // path is exercised on first build. Override with RN_ISO_E2E_EXPO_INIT.
  expo(appDir) {
    if (process.env.RN_ISO_E2E_EXPO_INIT) return withDir(process.env.RN_ISO_E2E_EXPO_INIT, appDir);
    return ['npx', '--yes', 'create-expo-app@latest', appDir, '--template', 'blank', '--no-install'];
  },
};

function withDir(tmplStr, appDir) {
  // Split a shell-ish override on whitespace and substitute {dir}. Kept simple:
  // the override is a trusted CI/reviewer value, not user input.
  return tmplStr
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t === '{dir}' ? appDir : t));
}

// ---- git --------------------------------------------------------------------

function gitInitWithRemote(appDir) {
  const remote = join(WORK_DIR, 'remote.git');
  sh('git', ['init', '-b', 'main', appDir]);
  const g = (a) => sh('git', ['-C', appDir, ...a]);
  g(['config', 'user.email', 'e2e@example.com']);
  g(['config', 'user.name', 'rn-iso native e2e']);
  g(['config', 'commit.gpgsign', 'false']);
  // Expo's blank template may have no .gitignore that ignores node_modules; make
  // sure the heavy dirs are ignored so the commit stays small and worktree
  // create can carry them as gitignored entries.
  ensureGitignore(appDir);
  g(['add', '-A']);
  g(['commit', '-m', `${FRAMEWORK} native e2e fixture`]);
  sh('git', ['init', '--bare', '-b', 'main', remote]);
  g(['remote', 'add', 'origin', remote]);
  g(['push', '-u', 'origin', 'main']);
  g(['remote', 'set-head', 'origin', 'main']);
}

function ensureGitignore(appDir) {
  const gi = join(appDir, '.gitignore');
  const needed = ['node_modules/', 'ios/Pods/', 'ios/build/', 'android/.gradle/', 'android/app/build/', '.rn-iso/'];
  // A MANAGED app's native dirs are `expo prebuild` output -- disposable and
  // conventionally gitignored. Left tracked, the prebuild inside the worktree
  // makes the tree dirty and `worktree remove` (correctly) refuses. Bare apps
  // keep ios/ and android/ tracked: they ARE the source.
  if (FRAMEWORK === 'expo') needed.push('ios/', 'android/');
  let text = existsSync(gi) ? readFileSync(gi, 'utf-8') : '';
  const missing = needed.filter(
    (n) =>
      !text
        .split('\n')
        .map((l) => l.trim())
        .includes(n.replace(/\/$/, '')) && !text.includes(n),
  );
  if (missing.length) {
    const add = `\n# rn-iso native e2e\n${missing.join('\n')}\n`;
    spawnSync('sh', ['-c', `printf '%s' ${quote(add)} >> ${quote(gi)}`], { stdio: 'inherit' });
  }
}

// ---- process helpers --------------------------------------------------------

function cli(argv, opts = {}) {
  return sh(process.execPath, [CLI, ...argv], opts);
}

function cliJson(argv, opts = {}) {
  const r = cli(argv, opts);
  if (r.code !== 0) throw new Error(`rn-iso ${argv.join(' ')} failed (exit ${r.code}):\n${lastLines(r.stderr, 40)}`);
  // The --json contract: exactly one parseable line on stdout.
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`rn-iso ${argv.join(' ')} did not emit a JSON line on stdout:\n${r.stdout}`);
  }
}

// spawnSync with output both captured AND echoed to this process's stderr, so a
// CI log shows progress while assertions still get the text.
function sh(file, argv, opts = {}) {
  const r = spawnSync(file, argv, {
    cwd: opts.cwd,
    env: opts.env || ENV,
    encoding: 'utf-8',
    timeout: opts.timeout || 5 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  if (stderr) process.stderr.write(stderr);
  if (r.error && !opts.allowFail) die(`${file} ${argv.join(' ')} could not run: ${r.error.message}`);
  const code = r.status ?? (r.signal ? 1 : 0);
  if (code !== 0 && !opts.allowFail)
    die(`${file} ${argv.slice(0, 3).join(' ')} exited ${code}:\n${lastLines(stderr, 40)}`);
  return { code, stdout, stderr };
}

function requireTool(file, argv) {
  const r = sh(file, argv, { allowFail: true });
  if (r.code !== 0 && r.stderr && /not found|ENOENT/i.test(r.stderr)) {
    die(`required tool "${file}" is not available on this runner`, 2);
  }
}

// ---- diagnostics ------------------------------------------------------------

function buildLog(cwd) {
  const dir = join(cwd, '.rn-iso', 'logs');
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => /^build-.*\.ndjson$/.test(f))
    .map((f) => join(dir, f));
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || null;
}

// Dump the tail of every worktree's build log on failure: the extracted
// diagnostic plus the raw transcript are what a triager needs, and CI throws the
// worktree away. e2e-native.yml also uploads these as artifacts.
function dumpDiagnostics() {
  banner('DIAGNOSTICS (build log tails)');
  for (const wt of created) {
    const log_ = buildLog(wt);
    if (!log_) {
      log(`no build log under ${wt}`);
      continue;
    }
    log(`--- ${log_} (tail) ---`);
    process.stderr.write(lastLines(readFileSync(log_, 'utf-8'), 60) + '\n');
  }
}

function cleanupTmp() {
  for (const dir of [WORK_DIR, args.home ? null : HOME_DIR].filter(Boolean)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
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
    else die(`unknown arg: ${a}`);
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function log(msg) {
  process.stderr.write(`[native-e2e ${VARIANT}] ${msg}\n`);
}
function banner(msg) {
  log('='.repeat(4) + ` ${msg} ` + '='.repeat(4));
}
function die(msg, code = 1) {
  log(`ERROR: ${msg}`);
  process.exit(code);
}
function lastLines(s, n) {
  return String(s || '')
    .split('\n')
    .slice(-n)
    .join('\n');
}
function quote(s) {
  return /[^\w./@:{}-]/.test(s) ? `'${String(s).replace(/'/g, "'\\''")}'` : String(s);
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
    if (!args.keep) cleanupTmp();
    process.exit(0);
  },
  (err) => {
    log(`FAIL ${VARIANT}: ${err?.message || err}`);
    dumpDiagnostics();
    if (!args.keep) cleanupTmp();
    process.exit(1);
  },
);
