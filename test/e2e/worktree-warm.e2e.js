import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CLI = join(REPO, 'packages', 'stim-cli', 'bin', 'cli.ts');
const ctx = {};

before(() => {
  ctx.home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-warm-e2e-home-')));
  ctx.tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-warm-e2e-')));
  ctx.repo = join(ctx.tmp, 'app');
  mkdirSync(ctx.repo, { recursive: true });
  writeFileSync(join(ctx.repo, 'package.json'), '{"name":"warm-fixture","private":true}\n');
  writeFileSync(join(ctx.repo, '.gitignore'), 'node_modules/\nios/Pods/\nios/build/\n');
  mkdirSync(join(ctx.repo, 'ios'), { recursive: true });
  writeFileSync(join(ctx.repo, 'ios', 'Podfile'), "platform :ios, '15.1'\n");
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@example.com']);
  git(['config', 'user.name', 'stim-cli e2e']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-m', 'fixture']);
});

after(() => {
  for (const dir of [ctx.home, ctx.tmp]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('cold and warm worktree creation report different guidance', () => {
  const cold = create('cold');
  assert.equal(cold.status, 0, cold.stderr);
  assert.doesNotMatch(cold.stderr, /Warm source not carried|--carry-ignored/);

  write('node_modules/pkg/index.js', 'dependency');
  write('ios/Pods/Manifest.lock', 'pods');
  write('ios/build/generated.cpp', 'native');

  const plainWarm = create('plain-warm');
  assert.equal(plainWarm.status, 0, plainWarm.stderr);
  assert.match(
    plainWarm.stderr,
    /^ {2}carry {7}warm source not carried: dependencies, CocoaPods, native build output/m,
  );
  assert.match(plainWarm.stderr, /stim worktree create <name> --carry-ignored/);

  const carried = create('carried', ['--carry-ignored']);
  assert.equal(carried.status, 0, carried.stderr);
  assert.match(carried.stderr, /^ {2}carry {7}node_modules, Pods, native build output \((APFS clone|byte copy)\)$/m);
  assert.match(carried.stderr, /^ {2}ready {7}\//m);
  const carriedPath = carried.stdout.trim();
  assert.ok(existsSync(join(carriedPath, 'node_modules', 'pkg', 'index.js')));
  assert.ok(existsSync(join(carriedPath, 'ios', 'Pods', 'Manifest.lock')));
  assert.ok(existsSync(join(carriedPath, 'ios', 'build', 'generated.cpp')));
});

test('carried pods are judged against the Podfile.lock the new worktree ends up with', () => {
  const repo = join(ctx.tmp, 'pods-app');
  const branchLock = 'PODS:\n  - fmt (11.0.2)\n';
  const workingLock = 'PODS:\n  - fmt (11.0.2)\n  - RNScreens (4.0.0)\n';
  mkdirSync(join(repo, 'ios'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'ios/Pods/\n');
  writeFileSync(join(repo, 'ios', 'Podfile'), "platform :ios, '15.1'\n");
  writeFileSync(join(repo, 'ios', 'Podfile.lock'), branchLock);
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'e2e@example.com'],
    ['config', 'user.name', 'stim-cli e2e'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '-A'],
    ['commit', '-m', 'pods fixture'],
  ]) {
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
  }
  writeFileSync(join(repo, 'ios', 'Podfile.lock'), workingLock);
  mkdirSync(join(repo, 'ios', 'Pods'), { recursive: true });
  writeFileSync(join(repo, 'ios', 'Pods', 'Manifest.lock'), workingLock);

  const carried = spawnSync(
    process.execPath,
    [CLI, 'worktree', 'create', 'pods-carried', '--base', 'head', '--carry-ignored'],
    { cwd: repo, env: { ...process.env, STIM_HOME: ctx.home }, encoding: 'utf-8' },
  );
  assert.equal(carried.status, 0, carried.stderr);
  const created = carried.stdout.trim();
  assert.equal(readFileSync(join(created, 'ios', 'Podfile.lock'), 'utf-8'), workingLock);
  assert.equal(readFileSync(join(created, 'ios', 'Pods', 'Manifest.lock'), 'utf-8'), workingLock);
  assert.doesNotMatch(carried.stderr, /carried ios\/Pods does not match/);
});

function create(name, extra = []) {
  return spawnSync(process.execPath, [CLI, 'worktree', 'create', name, '--base', 'head', ...extra], {
    cwd: ctx.repo,
    env: { ...process.env, STIM_HOME: ctx.home },
    encoding: 'utf-8',
  });
}

function git(args) {
  return execFileSync('git', ['-C', ctx.repo, ...args], { encoding: 'utf-8' });
}

function write(rel, contents) {
  const path = join(ctx.repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
