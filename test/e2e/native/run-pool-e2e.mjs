#!/usr/bin/env node
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_COMMANDS,
  assert,
  cleanupTmp,
  createCleanupTracker,
  createFixture,
  createHarness,
  dumpDiagnostics,
  preflight,
  quote,
  verifyCleanup,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CLI = join(REPO, 'packages', 'stim-cli', 'dist', 'cli.mjs');
const PLATFORM = 'ios';
const PARKED_MAX = '1';

const args = parseArgs(process.argv.slice(2));
const FRAMEWORK = args.framework;
const HOME_DIR = args.dryRun ? '<dry-run>' : args.home || mkdtempSync(join(tmpdir(), `stim-pool-${FRAMEWORK}-home-`));
const WORK_DIR = args.dryRun ? '<dry-run>' : mkdtempSync(join(tmpdir(), `stim-pool-${FRAMEWORK}-`));
const ENV = { ...process.env, STIM_HOME: HOME_DIR, CI: '1', STIM_POOL_IOS_PARKED_MAX: PARKED_MAX };
process.env.STIM_HOME = HOME_DIR;

const h = createHarness({ env: ENV, cliPath: CLI, label: `pool-e2e ${FRAMEWORK}` });
const cleanup = createCleanupTracker({ h, platform: PLATFORM });
const { cli, sh, log, banner, die } = h;

const created = [];

async function main() {
  preflight(h, PLATFORM);

  const appDir = args.appDir
    ? resolve(args.appDir)
    : createFixture({ framework: FRAMEWORK, platform: PLATFORM, workDir: WORK_DIR, h });

  banner('two workspaces on an empty pool: both create');
  const wt1 = worktreeCreate('pool-1', appDir);
  const first = runIos(wt1);
  assert(first.adopted === false, `wt1 ran on an empty pool and must have created, not adopted:\n${first.deviceLine}`);
  const wt2 = worktreeCreate('pool-2', appDir);
  const second = runIos(wt2);
  assert(second.adopted === false, `wt2 must have created its own sim, not adopted:\n${second.deviceLine}`);
  assert(second.udid !== first.udid, 'two workspaces shared one simulator');

  banner('remove: the first parks');
  cleanup.recordWorkspace(wt1);
  cli(['stop'], { cwd: wt1 });
  const removed1 = worktreeRemove(wt1);
  assert(/ {2}device {6}parked stim-parked /.test(removed1), `worktree remove did not park:\n${removed1}`);
  assertPoolSize(1);

  banner('remove: the second parks and evicts the first');
  cleanup.recordWorkspace(wt2);
  cli(['stop'], { cwd: wt2 });
  const removed2 = worktreeRemove(wt2);
  assert(/ {2}device {6}parked stim-parked /.test(removed2), `the second remove did not park:\n${removed2}`);
  assert(
    new RegExp(` {2}device {6}deleted stim-parked .* \\(pool over ${PARKED_MAX}\\)`).test(removed2),
    `the second remove did not evict the oldest parked sim:\n${removed2}`,
  );
  assertPoolSize(1);
  assertSimCount(1);

  banner('a third workspace adopts');
  const wt3 = worktreeCreate('pool-3', appDir);
  const third = runIos(wt3);
  assert(third.adopted === true, `wt3 must have adopted the parked simulator:\n${third.deviceLine}`);
  assert(third.udid === second.udid, `wt3 adopted ${third.udid}, not the parked ${second.udid}`);
  assertPoolSize(0);

  banner('remove: the third parks');
  cleanup.recordWorkspace(wt3);
  cli(['stop'], { cwd: wt3 });
  const removed3 = worktreeRemove(wt3);
  assert(/ {2}device {6}parked stim-parked /.test(removed3), `the third remove did not park:\n${removed3}`);
  assertPoolSize(1);

  banner('gc --delete empties the pool');
  const gc = cli(['gc'], { allowFail: true });
  assert(/^Parked simulators \(1/m.test(gc.stdout), `gc did not report the pool:\n${gc.stdout}`);
  const deleted = cli(['gc', '--delete']);
  assert(
    /Deleted parked ios sim /.test(deleted.stdout),
    `gc --delete did not delete the parked sim:\n${deleted.stdout}`,
  );
  assertPoolSize(0);

  await verifyCleanup({ h, cleanup, appDir, created });
}

function worktreeCreate(name, appDir) {
  const r = cli(['worktree', 'create', name, '--base', 'head', '--carry-ignored'], { cwd: appDir });
  const path = r.stdout.trim().split('\n').findLast(Boolean);
  assert(path && existsSync(path), `worktree create did not yield a real path: ${JSON.stringify(r.stdout)}`);
  created.push(path);
  log(`worktree ${name} -> ${path}`);
  return path;
}

function runIos(cwd) {
  cli(['start', '--json', '--wait', '240'], { cwd });
  cleanup.recordWorkspace(cwd);
  const r = cli([PLATFORM, '--json'], { cwd, timeout: 40 * 60 * 1000 });
  const facts = JSON.parse(r.stdout.trim().split('\n').findLast(Boolean));
  cleanup.recordBuild(facts);
  cleanup.recordWorkspace(cwd);
  const deviceLine = r.stderr.split('\n').find((line) => / {2}device {6}.*(booted|adopted) /.test(line)) ?? '';
  log(`device line: ${deviceLine.trim()}`);
  return { udid: facts.udid, adopted: / adopted /.test(deviceLine), deviceLine };
}

function worktreeRemove(path) {
  sh('git', ['-C', path, 'checkout', '--', '.'], { allowFail: true });
  sh('git', ['-C', path, 'clean', '-fdq', 'ios', 'android'], { allowFail: true });
  const r = cli(['worktree', 'remove', path], { allowFail: true });
  assert(r.code === 0, `worktree remove refused a clean worktree:\n${r.stderr}`);
  log(`removed worktree ${path}`);
  return r.stderr;
}

function assertPoolSize(expected) {
  const status = cli(['status'], { allowFail: true }).stdout;
  const line = /^pool: (\d+) parked iOS simulators?/m.exec(status);
  const actual = line ? Number(line[1]) : 0;
  assert(actual === expected, `pool holds ${actual} parked simulators, expected ${expected}:\n${status}`);
  log(`pool: ${actual} parked`);
}

function assertSimCount(expected) {
  const remaining = cleanup.remainingDevices();
  const actual = remaining.length;
  assert(
    actual === expected,
    `${actual} simulators from this run exist, expected ${expected}:\n${remaining.join('\n')}`,
  );
}

function cleanupAfterFailure() {
  for (const path of created.toReversed()) {
    if (!existsSync(path)) continue;
    cli(['stop'], { cwd: path, allowFail: true });
    sh('git', ['-C', path, 'checkout', '--', '.'], { allowFail: true });
    sh('git', ['-C', path, 'clean', '-fdq', 'ios', 'android'], { allowFail: true });
    cli(['worktree', 'remove', path, '--force'], { allowFail: true });
  }
  cli(['gc', '--delete'], { allowFail: true });
}

function parseArgs(argv) {
  const out = { framework: 'expo', appDir: null, keep: false, dryRun: false, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--framework') out.framework = argv[++i];
    else if (a === '--app-dir') out.appDir = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--keep') out.keep = true;
    else if (a === '--dry-run') out.dryRun = true;
    else {
      process.stderr.write(`[pool-e2e] ERROR: unknown arg: ${a}\n`);
      process.exit(1);
    }
  }
  return out;
}

if (!['bare', 'expo'].includes(FRAMEWORK)) {
  die('usage: run-pool-e2e.mjs [--framework <bare|expo>] [--app-dir P] [--keep] [--dry-run]');
}

banner(`pool e2e: ${FRAMEWORK}-ios (STIM_POOL_IOS_PARKED_MAX=${PARKED_MAX})`);
log(`STIM_HOME=${HOME_DIR}`);
log(`work dir=${WORK_DIR}`);
log(
  args.appDir
    ? `using existing app: ${resolve(args.appDir)}`
    : `fixture: ${FIXTURE_COMMANDS[FRAMEWORK]('<appDir>').map(quote).join(' ')}`,
);
if (args.dryRun) {
  log('dry run: no side effects. Exiting.');
  process.exit(0);
}

main().then(
  () => {
    log(`PASS pool ${FRAMEWORK}-ios`);
    if (!args.keep) cleanupTmp([WORK_DIR, args.home ? null : HOME_DIR]);
    process.exit(0);
  },
  (err) => {
    log(`FAIL pool ${FRAMEWORK}-ios: ${err?.message || err}`);
    dumpDiagnostics(h, created);
    cleanupAfterFailure();
    if (!args.keep) cleanupTmp([WORK_DIR, args.home ? null : HOME_DIR]);
    process.exit(1);
  },
);
