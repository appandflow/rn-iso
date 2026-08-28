#!/usr/bin/env node
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

const args = parseArgs(process.argv.slice(2));
const FRAMEWORK = args.framework;
const PLATFORM = args.platform;
const VARIANT = `${FRAMEWORK}-${PLATFORM}`;
const EXPECTED_MODE = FRAMEWORK === 'expo' ? 'expo-child' : 'bare-inproc';
const ARTIFACT_EXT = PLATFORM === 'ios' ? '.app' : '.apk';
const COMPILE_SIGNS =
  PLATFORM === 'ios' ? [/xcodebuild/i, /CompileC\b/i, /Ld /] : [/gradlew/i, /:app:compile/i, /Task :app:/i];

const HOME_DIR = args.dryRun ? '<dry-run>' : args.home || mkdtempSync(join(tmpdir(), `rn-iso-native-${VARIANT}-home-`));
const WORK_DIR = args.dryRun ? '<dry-run>' : mkdtempSync(join(tmpdir(), `rn-iso-native-${VARIANT}-`));
const ENV = { ...process.env, RN_ISO_HOME: HOME_DIR, CI: '1' };
process.env.RN_ISO_HOME = HOME_DIR;
const WARM_CACHE = process.env.RN_ISO_E2E_WARM_CACHE === '1';

const h = createHarness({ env: ENV, cliPath: CLI, label: `native-e2e ${VARIANT}` });
const { cli, cliJson, sh, log, banner, die } = h;

const created = [];

async function main() {
  preflight(h, PLATFORM);

  const appDir = args.appDir ? resolve(args.appDir) : createFixture({ framework: FRAMEWORK, workDir: WORK_DIR, h });
  if (args.fixtureOnly) {
    log(`fixture-only: app created at ${appDir}. Stopping before any build.`);
    return;
  }

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

  cli(['stop'], { cwd: wt2 });
  cli(['stop'], { cwd: wt1 });
  worktreeRemove(wt2);
  worktreeRemove(wt1);
  verifyCleanup({ h, platform: PLATFORM, appDir, created });
}

function worktreeCreate(name, appDir) {
  const r = cli(['worktree', 'create', name, '--base', 'head', '--carry-ignored'], { cwd: appDir });
  const path = r.stdout.trim().split('\n').findLast(Boolean);
  assert(path && existsSync(path), `worktree create did not yield a real path: ${JSON.stringify(r.stdout)}`);
  created.push(path);
  log(`worktree ${name} -> ${path}`);
  return path;
}

function startAndAssertMode(cwd) {
  const r = cli(['start', '--json', '--wait', '240'], { cwd, allowFail: true });
  if (r.code !== 0) {
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
  sh('git', ['-C', path, 'checkout', '--', '.'], { allowFail: true });
  sh('git', ['-C', path, 'clean', '-fdq', 'ios', 'android'], { allowFail: true });
  const r = cli(['worktree', 'remove', path], { allowFail: true });
  assert(r.code === 0, `worktree remove refused a clean worktree:\n${r.stderr}`);
  log(`removed worktree ${path}`);
}

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
