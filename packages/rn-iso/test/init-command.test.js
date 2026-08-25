// `rn-iso init` writes scripts/dev and means it to be runnable. writeFileSync's
// `mode` option only applies when it creates the file, so --force over an
// existing script rewrote its contents and left whatever permission bits were
// already there -- including none.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import initCommand, { migrateLegacyCaches } from '../src/commands/init.js';

// Stub of the commander `Command` API, the same shape test/worktree-remove.js
// uses: capturing the action is the only way to run it without commander's own
// argument parsing.
function captureAction(register) {
  let captured;
  const stub = {
    command() { return stub; },
    description() { return stub; },
    option() { return stub; },
    action(fn) { captured = fn; return stub; },
  };
  register(stub);
  return (opts = {}) => captured(opts);
}

let tmpHome;
let project;
let cwd;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-initcmd-home-'));
  process.env.RN_ISO_HOME = tmpHome;
  project = mkdtempSync(join(tmpdir(), 'rn-iso-initcmd-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '~57.0.0' } }));
  cwd = process.cwd();
  process.chdir(project);
  // init ends by running doctor, which asks the toolchain for its Xcode
  // version. Nothing here is about that.
  setExecutor({ run: () => '', runQuiet: () => null, spawn: () => {} });
});
afterEach(() => {
  process.chdir(cwd);
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

function mode(path) {
  return statSync(path).mode & 0o777;
}

test('init writes an executable scripts/dev', () => {
  captureAction(initCommand)({});
  assert.equal(mode(join(project, 'scripts', 'dev')), 0o755);
});

test('init --force restores the executable bit on a scripts/dev that lost it', () => {
  const script = join(project, 'scripts', 'dev');
  captureAction(initCommand)({});
  chmodSync(script, 0o644);

  captureAction(initCommand)({ force: true });

  assert.equal(mode(script), 0o755, 'a script you have to chmod before it runs is not a written script');
});

test('init without --force keeps a file someone has edited', () => {
  const workflow = join(project, 'WORKFLOW.md');
  captureAction(initCommand)({});
  writeFileSync(workflow, 'mine');

  captureAction(initCommand)({});

  assert.equal(readFileSync(workflow, 'utf-8'), 'mine');
});

// A cache left behind in its old location costs the disk twice and a cold
// rebuild in every project on the machine, and they run to many GB -- so `init`
// moves them. A rename on the same volume is instantaneous whatever the size,
// which is the only reason this is safe to do inside a command people run
// casually.
//
// RN_ISO_HOME is nested inside a throwaway directory here on purpose: the
// legacy build cache resolves as the sibling of the config dir, so this can
// never reach the real ~/.rn-iso-build-cache.
function withFakeHome(fn) {
  const outer = mkdtempSync(join(tmpdir(), 'rn-iso-migrate-'));
  const home = join(outer, '.rn-iso');
  mkdirSync(home, { recursive: true });
  const previous = process.env.RN_ISO_HOME;
  process.env.RN_ISO_HOME = home;
  try {
    return fn(outer, home);
  } finally {
    if (previous === undefined) delete process.env.RN_ISO_HOME;
    else process.env.RN_ISO_HOME = previous;
    rmSync(outer, { recursive: true, force: true });
  }
}

test('init renames a legacy cache into its new home', () => {
  withFakeHome((outer, home) => {
    const legacy = join(outer, '.rn-iso-build-cache');
    mkdirSync(join(legacy, 'ios', 'abc'), { recursive: true });
    writeFileSync(join(legacy, 'ios', 'abc', 'App.apk'), 'binary');

    captureAction(initCommand)({});

    assert.equal(existsSync(legacy), false, 'the old directory is gone, not copied');
    assert.equal(readFileSync(join(home, 'build-cache', 'ios', 'abc', 'App.apk'), 'utf-8'), 'binary');
  });
});

test('a legacy cache whose destination exists is left alone, not merged', () => {
  withFakeHome((outer, home) => {
    const legacy = join(outer, '.rn-iso-build-cache');
    mkdirSync(join(legacy, 'ios'), { recursive: true });
    mkdirSync(join(home, 'build-cache', 'ios'), { recursive: true });
    writeFileSync(join(home, 'build-cache', 'ios', 'keep'), 'newer');

    const results = migrateLegacyCaches();

    assert.deepEqual(results.map(r => r.status), ['skipped']);
    assert.ok(existsSync(legacy), 'nothing is deleted on the refused path');
    assert.equal(readFileSync(join(home, 'build-cache', 'ios', 'keep'), 'utf-8'), 'newer');
  });
});

// Fail closed: a rename that cannot happen (a different volume, a permission)
// must not turn into a copy-and-delete. The directory stays where it is, the
// failure is reported, and doctor keeps naming it.
test('a rename that cannot happen leaves the legacy directory untouched', () => {
  withFakeHome((outer, home) => {
    const legacy = join(outer, '.rn-iso-build-cache');
    mkdirSync(legacy);
    const results = migrateLegacyCaches([
      { legacy, dest: join('/dev/null/nope', 'build-cache'), label: 'build cache', destExists: false },
    ]);
    assert.deepEqual(results.map(r => r.status), ['failed']);
    assert.ok(results[0].error, 'the reason has to survive to the report');
    assert.ok(existsSync(legacy), 'a failed move never deletes');
  });
});
