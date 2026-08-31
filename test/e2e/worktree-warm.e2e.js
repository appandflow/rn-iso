import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.match(plainWarm.stderr, /Warm source not carried: dependencies, CocoaPods, native build output/);
  assert.match(plainWarm.stderr, /stim worktree create <name> --carry-ignored/);

  const carried = create('carried', ['--carry-ignored']);
  assert.equal(carried.status, 0, carried.stderr);
  assert.match(carried.stderr, /Carried warm state: dependencies=yes, CocoaPods=yes, native build output=yes/);
  assert.match(carried.stderr, /Copy mode: (APFS copy-on-write clone|full byte copy)/);
  const carriedPath = carried.stdout.trim();
  assert.ok(existsSync(join(carriedPath, 'node_modules', 'pkg', 'index.js')));
  assert.ok(existsSync(join(carriedPath, 'ios', 'Pods', 'Manifest.lock')));
  assert.ok(existsSync(join(carriedPath, 'ios', 'build', 'generated.cpp')));
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
