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
  writeFileSync(join(ctx.repo, '.gitignore'), 'node_modules/\nios/Pods/\nios/build/\n.env\n');
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

test('create is rejected without creating a checkout', () => {
  const removed = spawnSync(process.execPath, [CLI, 'worktree', 'create', 'removed'], {
    cwd: ctx.repo,
    env: { ...process.env, STIM_HOME: ctx.home },
    encoding: 'utf-8',
  });
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /unknown command 'create'/);
  assert.equal(git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('Git creates a clean checkout and warm copies ignored dependencies and native output', () => {
  write('node_modules/pkg/index.js', 'dependency');
  write('ios/Pods/Manifest.lock', 'pods');
  write('ios/build/generated.cpp', 'native');
  const linked = create('warmed');
  assert.equal(existsSync(join(linked, 'node_modules')), false);
  const warmed = warm(linked);
  assert.equal(warmed.status, 0, warmed.stderr);
  assert.equal(warmed.stdout, '');
  assert.match(warmed.stderr, /complete: 3 ignored entries copied/);
  assert.equal(readFileSync(join(linked, 'node_modules/pkg/index.js'), 'utf-8'), 'dependency');
  assert.equal(readFileSync(join(linked, 'ios/Pods/Manifest.lock'), 'utf-8'), 'pods');
  assert.equal(readFileSync(join(linked, 'ios/build/generated.cpp'), 'utf-8'), 'native');
});

test('warm leaves the selected tracked base unchanged and reports mismatched copied Pods', () => {
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

  const linked = create('pods-warmed', repo);
  const warmed = warm(linked);
  assert.equal(warmed.status, 0, warmed.stderr);
  assert.equal(readFileSync(join(linked, 'ios/Podfile.lock'), 'utf-8'), branchLock);
  assert.equal(readFileSync(join(linked, 'ios/Pods/Manifest.lock'), 'utf-8'), workingLock);
  assert.equal(readFileSync(join(repo, 'ios/Podfile.lock'), 'utf-8'), workingLock);
  assert.match(warmed.stderr, /carried ios\/Pods does not match/);
});

function create(name, repo = ctx.repo, detached = false) {
  const linked = join(ctx.tmp, name);
  execFileSync('git', ['-C', repo, 'worktree', 'add', ...(detached ? ['--detach'] : ['-b', name]), linked, 'HEAD']);
  return linked;
}

function warm(cwd) {
  return spawnSync(process.execPath, [CLI, 'worktree', 'warm'], {
    cwd,
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

test('an externally created worktree can warm from main without changing its branch or existing entries', () => {
  const linked = join(ctx.tmp, 'external-linked');
  git(['worktree', 'add', '-b', 'external-linked', linked]);
  write('.gitignore', readFileSync(join(ctx.repo, '.gitignore'), 'utf-8') + '.env\n');
  write('.env', 'main local config');
  write('.worktreeexclude', 'ios/build\n');
  write('package.json', '{"name":"dirty-main"}\n');
  mkdirSync(join(linked, 'node_modules', 'own'), { recursive: true });
  writeFileSync(join(linked, 'node_modules', 'own', 'index.js'), 'own dependency');
  const head = execFileSync('git', ['-C', linked, 'rev-parse', 'HEAD'], { encoding: 'utf-8' });
  const run = () =>
    spawnSync(process.execPath, [CLI, 'worktree', 'warm'], {
      cwd: join(linked, 'ios'),
      env: { ...process.env, STIM_HOME: ctx.home },
      encoding: 'utf-8',
    });
  const warmed = run();
  assert.equal(warmed.status, 0, warmed.stderr);
  assert.equal(warmed.stdout, '');
  assert.match(warmed.stderr, /kept node_modules \(exists\)/);
  assert.match(warmed.stderr, /complete: .*0 failed/);
  assert.equal(readFileSync(join(linked, '.env'), 'utf-8'), 'main local config');
  assert.equal(readFileSync(join(linked, 'node_modules', 'own', 'index.js'), 'utf-8'), 'own dependency');
  assert.equal(existsSync(join(linked, 'node_modules', 'pkg')), false);
  assert.equal(existsSync(join(linked, 'ios', 'build')), false);
  assert.equal(readFileSync(join(linked, 'package.json'), 'utf-8'), '{"name":"warm-fixture","private":true}\n');
  assert.equal(execFileSync('git', ['-C', linked, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }), head);
  assert.equal(
    execFileSync('git', ['-C', linked, 'branch', '--show-current'], { encoding: 'utf-8' }).trim(),
    'external-linked',
  );
  const repeated = run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stderr, /complete: 0 ignored entries copied/);
});

for (const warmed of [false, true]) {
  for (const detached of [false, true]) {
    test(`remove accepts an unregistered ${warmed ? 'warmed' : 'unwarmed'} ${detached ? 'detached' : 'branch'} worktree`, () => {
      const name = `remove-${warmed}-${detached}`;
      const linked = create(name, ctx.repo, detached);
      if (warmed) {
        const result = warm(linked);
        assert.equal(result.status, 0, result.stderr);
      }
      const removed = spawnSync(process.execPath, [CLI, 'worktree', 'remove', linked], {
        cwd: ctx.repo,
        env: { ...process.env, STIM_HOME: ctx.home },
        encoding: 'utf-8',
      });
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(existsSync(linked), false);
      assert.ok(!git(['worktree', 'list', '--porcelain']).includes(linked));
      if (!detached) assert.equal(git(['show-ref', '--verify', `refs/heads/${name}`]).trim().length > 0, true);
    });
  }
}
