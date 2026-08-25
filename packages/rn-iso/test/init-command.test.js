// `rn-iso init` writes scripts/dev and means it to be runnable. writeFileSync's
// `mode` option only applies when it creates the file, so --force over an
// existing script rewrote its contents and left whatever permission bits were
// already there -- including none.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// init reports on stderr (stdout is reserved across this CLI for parseable
// payloads), so what it TELLS you is only readable by capturing it.
function captureStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
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
  const script = join(project, 'scripts', 'dev');
  captureAction(initCommand)({});
  writeFileSync(script, 'mine');

  captureAction(initCommand)({});

  assert.equal(readFileSync(script, 'utf-8'), 'mine');
});

// v3 generates no WORKFLOW.md. v2 needed one because rn-iso refused to know a
// project's build commands; v3 IS the build command, so the document had become
// an unmanaged copy of `rn-iso guide lifecycle` -- stale in exactly the places
// the repo had moved on, which is how it came to tell a repo already pointing
// buildCacheProvider at "eas" to install another provider over it.
test('init writes no WORKFLOW.md', () => {
  captureAction(initCommand)({});
  assert.equal(existsSync(join(project, 'WORKFLOW.md')), false);
});

// One a previous version wrote is the repo's now: init neither refreshes it nor
// deletes it, and doctor says nothing about it.
test('a WORKFLOW.md an older version generated is left exactly as it is', () => {
  const stale = join(project, 'WORKFLOW.md');
  writeFileSync(stale, '# ours now\n');
  captureAction(initCommand)({ force: true });
  assert.equal(readFileSync(stale, 'utf-8'), '# ours now\n');
});

// --- where the generated files land in a monorepo ----------------------------
//
// `worktree create` reads `.worktreeexclude` at the GIT REPO ROOT, so a file
// written next to the app's package.json excludes nothing -- and on the run
// that found this, doctor then confirmed the no-op file. .gitignore is the
// opposite case and stays where it is: git reads the one in the directory it
// applies to.
//
// Real git, because the location under test is the one `git rev-parse
// --show-toplevel` reports rather than one this code composes.
function monorepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-initcmd-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const app = join(repo, 'packages', 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '~57.0.0' } }));
  return { repo, app };
}

test('init writes into the app package, and no .worktreeexclude anywhere', () => {
  const { repo, app } = monorepo();
  try {
    resetExecutor();
    process.chdir(app);
    captureAction(initCommand)({});

    assert.equal(existsSync(join(app, 'scripts', 'dev')), true, 'the script belongs to the app that runs it');
    assert.equal(existsSync(join(app, '.gitignore')), true, 'gitignore stays project-local');
    // Carrying `.rn-iso/` into a fresh worktree is prevented in code, so there
    // is no generated pattern file at either root -- and no way for one written
    // in the wrong place to look like it is doing something.
    assert.equal(existsSync(join(app, '.worktreeexclude')), false);
    assert.equal(existsSync(join(repo, '.worktreeexclude')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A `.worktreeexclude` the repo wrote for itself is the repo's: init neither
// generates one nor touches one.
test('a .worktreeexclude the repo already has is left alone', () => {
  const { repo, app } = monorepo();
  try {
    resetExecutor();
    writeFileSync(join(repo, '.worktreeexclude'), 'coverage\n');
    process.chdir(app);
    captureAction(initCommand)({ force: true });

    assert.equal(readFileSync(join(repo, '.worktreeexclude'), 'utf-8'), 'coverage\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A pnpm monorepo told to run `npm i -D` gets a second lockfile and a
// dependency in the wrong place. The lockfile is at the repo root, not next to
// the app -- and in a monorepo @expo/fingerprint is usually hoisted, so the
// app's own dependency table is not where an installed one shows up either.
test('the fingerprint remedy names the package manager the repo actually uses', () => {
  const { repo, app } = monorepo();
  try {
    resetExecutor();
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    process.chdir(app);

    const out = captureStderr(() => captureAction(initCommand)({}));

    assert.match(out, /pnpm add -D @expo\/fingerprint/);
    assert.doesNotMatch(out, /npm i -D @expo\/fingerprint/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a hoisted @expo/fingerprint is not reported as missing', () => {
  const { repo, app } = monorepo();
  try {
    resetExecutor();
    const fp = join(repo, 'node_modules', '@expo', 'fingerprint');
    mkdirSync(fp, { recursive: true });
    writeFileSync(join(fp, 'package.json'), JSON.stringify({ name: '@expo/fingerprint', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(fp, 'index.js'), 'module.exports = {};\n');
    process.chdir(app);

    const out = captureStderr(() => captureAction(initCommand)({}));

    assert.doesNotMatch(out, /WITHOUT @expo\/fingerprint/, 'it resolves from here, so builds can be cached today');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
