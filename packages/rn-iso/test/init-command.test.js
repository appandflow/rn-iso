// `rn-iso init` writes scripts/dev and means it to be runnable. writeFileSync's
// `mode` option only applies when it creates the file, so --force over an
// existing script rewrote its contents and left whatever permission bits were
// already there -- including none.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import initCommand from '../src/commands/init.js';

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
