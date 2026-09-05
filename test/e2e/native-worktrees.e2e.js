import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertMatchingPods,
  createFixture,
  createHarness,
  createWarmWorktree,
  workspaceLogsDir,
} from './native/harness.mjs';

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-worktrees-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

function repoFixture(t) {
  const base = scratch(t);
  const sourceDir = join(base, 'fixture app');
  const workDir = join(base, 'run worktrees');
  mkdirSync(sourceDir);
  mkdirSync(workDir);
  writeFileSync(join(sourceDir, 'package.json'), '{"name":"fixture"}\n');
  git(sourceDir, 'init', '-q', '-b', 'main');
  git(sourceDir, 'config', 'user.email', 'test@example.com');
  git(sourceDir, 'config', 'user.name', 'test');
  git(sourceDir, 'config', 'commit.gpgsign', 'false');
  git(sourceDir, 'add', '.');
  git(sourceDir, 'commit', '-qm', 'fixture');
  const h = createHarness({ env: { ...process.env, STIM_HOME: join(base, 'home') }, cliPath: '', label: 'fixture' });
  return { sourceDir, workDir, h, created: [] };
}

test('native worktree creation uses real detached Git paths and records them before warming', (t) => {
  const f = repoFixture(t);
  const before = git(f.sourceDir, 'show-ref', '--heads');
  const head = git(f.sourceDir, 'rev-parse', 'HEAD');
  let warmCalls = 0;
  f.h.cli = (argv, opts) => {
    warmCalls++;
    assert.deepEqual(argv, ['worktree', 'warm']);
    assert.deepEqual(f.created, [opts.cwd]);
    assert.equal(existsSync(opts.cwd), true);
    assert.equal(git(opts.cwd, 'branch', '--show-current'), '');
    assert.equal(git(opts.cwd, 'rev-parse', 'HEAD'), head);
    return { code: 0, stdout: '', stderr: '' };
  };
  const path = createWarmWorktree({ ...f, name: 'native [one]' });
  assert.equal(path, join(f.workDir, 'native [one]'));
  assert.equal(warmCalls, 1);
  assert.equal(git(f.sourceDir, 'show-ref', '--heads'), before);
  assert.equal(git(f.sourceDir, 'status', '--porcelain'), '');
  git(f.sourceDir, 'worktree', 'remove', path);
  assert.doesNotMatch(git(f.sourceDir, 'worktree', 'list', '--porcelain'), /native \[one\]/);
});

test('a failed native warm keeps its created worktree recorded for diagnostics and cleanup', (t) => {
  const f = repoFixture(t);
  f.h.cli = () => ({ code: 1, stdout: '', stderr: 'copy failed' });
  assert.throws(() => createWarmWorktree({ ...f, name: 'failed-warm' }), /warming .* failed: copy failed/);
  assert.deepEqual(f.created, [join(f.workDir, 'failed-warm')]);
  assert.equal(existsSync(f.created[0]), true);
  assert.equal(git(f.sourceDir, 'branch', '--list'), '* main');
  git(f.sourceDir, 'worktree', 'remove', f.created[0]);
});

test('native worktrees from a symlinked parent use the same paths as logs and Git cleanup', (t) => {
  const f = repoFixture(t);
  const alias = `${f.workDir}-alias`;
  symlinkSync(f.workDir, alias);
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = f.h.env.STIM_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
  });
  f.h.cli = (_, { cwd }) => {
    const logs = workspaceLogsDir(realpathSync(cwd));
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'build.log'), 'build evidence');
    return { code: 0, stdout: '', stderr: '' };
  };
  const path = createWarmWorktree({ ...f, workDir: alias, name: 'aliased' });
  assert.equal(readFileSync(join(workspaceLogsDir(path), 'build.log'), 'utf-8'), 'build evidence');
  assert.deepEqual(f.created, [realpathSync(path)]);
  assert.ok(git(f.sourceDir, 'worktree', 'list', '--porcelain').includes(`worktree ${f.created[0]}\n`));
  git(f.sourceDir, 'worktree', 'remove', path);
});

test('failed Git creation does not warm or claim an existing path', (t) => {
  const f = repoFixture(t);
  const path = join(f.workDir, 'occupied');
  writeFileSync(path, 'keep');
  f.h.cli = () => assert.fail('warm must not run after a failed git add');
  assert.throws(() => createWarmWorktree({ ...f, name: 'occupied' }), /git worktree add failed/);
  assert.deepEqual(f.created, []);
  assert.equal(readFileSync(path, 'utf-8'), 'keep');
});

test('Pods reuse requires both lockfiles and an exact match', (t) => {
  const app = scratch(t);
  mkdirSync(join(app, 'ios', 'Pods'), { recursive: true });
  assert.throws(() => assertMatchingPods(app), /requires Podfile.lock and Pods\/Manifest.lock/);
  writeFileSync(join(app, 'ios', 'Podfile.lock'), 'lock');
  assert.throws(() => assertMatchingPods(app), /requires Podfile.lock and Pods\/Manifest.lock/);
  writeFileSync(join(app, 'ios', 'Pods', 'Manifest.lock'), 'other');
  assert.throws(() => assertMatchingPods(app), /differs/);
  writeFileSync(join(app, 'ios', 'Pods', 'Manifest.lock'), 'lock');
  assert.doesNotThrow(() => assertMatchingPods(app));
});

test('the disposable Expo iOS fixture prepares matching Pods before committing its baseline', (t) => {
  const workDir = scratch(t);
  const tools = join(workDir, 'tools');
  mkdirSync(tools);
  const npm = join(tools, 'npm');
  writeFileSync(npm, '#!/bin/sh\nexit 0\n');
  chmodSync(npm, 0o755);
  const init = join(workDir, 'init.mjs');
  writeFileSync(
    init,
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const app = process.argv[2];
mkdirSync(app);
writeFileSync(join(app, 'package.json'), '{"name":"fixture"}\\n');
`,
  );
  const previousInit = process.env.STIM_E2E_EXPO_INIT;
  process.env.STIM_E2E_EXPO_INIT = `${process.execPath} ${init} {dir}`;
  t.after(() => {
    if (previousInit === undefined) delete process.env.STIM_E2E_EXPO_INIT;
    else process.env.STIM_E2E_EXPO_INIT = previousInit;
  });
  const h = createHarness({
    env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, STIM_HOME: join(workDir, 'home') },
    cliPath: '',
    label: 'fixture',
  });
  const sh = h.sh;
  let prepared = false;
  h.sh = (file, argv, opts) => {
    if (file === 'npx') {
      assert.deepEqual(argv, ['--no-install', 'expo', 'prebuild', '--platform', 'ios']);
      assert.equal(existsSync(join(opts.cwd, '.git')), false);
      mkdirSync(join(opts.cwd, 'ios', 'Pods'), { recursive: true });
      writeFileSync(join(opts.cwd, 'ios', 'Pods', 'Manifest.lock'), 'prepared');
      writeFileSync(join(opts.cwd, 'ios', 'Podfile.lock'), 'prepared');
      writeFileSync(join(opts.cwd, 'package.json'), '{"name":"prepared-fixture"}\n');
      prepared = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (file === 'git' && argv[0] === 'init') assert.equal(prepared, true);
    return sh(file, argv, opts);
  };
  const app = createFixture({ framework: 'expo', platform: 'ios', workDir, h });
  assertMatchingPods(app);
  assert.equal(git(app, 'status', '--porcelain'), '');
  assert.equal(git(app, 'show', 'HEAD:package.json'), '{"name":"prepared-fixture"}');
  assert.equal(git(app, 'ls-files', 'ios'), '');
});
