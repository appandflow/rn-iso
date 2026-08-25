import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  installCommand,
  projectFacts,
  renderDevScript,
  renderGitignoreAdditions,
  renderPodfileCasPin,
} from '../src/init.js';
import { appendGitignoreAdditions } from '../src/commands/init.js';

const expoApp = { pkg: { name: 'demo', dependencies: { expo: '~57.0.0', 'react-native': '0.86.2' } } };
const bareApp = { pkg: { name: 'bare', dependencies: { 'react-native': '0.86.2' } } };

// v3 runs the build itself, so the facts carry no invented run command and no
// copy of the project's script table: nothing here reconstructs a command line.
// (`packageManager` is not one of those -- it names a repo's own installer in
// one line of advice, and never composes a build or a bundler command.)
test('the facts describe the ecosystem and nothing about how to invoke it', () => {
  const facts = projectFacts(expoApp);
  assert.equal(facts.isExpo, true);
  assert.equal(facts.runCommand, undefined);
  assert.equal(facts.scripts, undefined);
});

test('the SDK major is read from the expo range, and absent for a bare project', () => {
  assert.equal(projectFacts(expoApp).sdkMajor, 57);
  assert.equal(projectFacts(bareApp).sdkMajor, null);
  assert.equal(projectFacts(bareApp).isExpo, false);
});

test('@expo/fingerprint is detected in either dependency block', () => {
  assert.equal(projectFacts(expoApp).hasFingerprint, false);
  assert.equal(
    projectFacts({ pkg: { dependencies: { expo: '~57.0.0' }, devDependencies: { '@expo/fingerprint': '^1.0.0' } } }).hasFingerprint,
    true
  );
});

// --- the dev script ---------------------------------------------------------
//
// v2's script hand-started a bundler into /tmp, polled `/status`, and then ran
// the project's build command. All three of those are now inside `rn-iso start`
// and `rn-iso ios`, so the script is the sequence and nothing else.

test('the dev script is start, then the platform command, in that order', () => {
  const script = renderDevScript();
  const startAt = script.indexOf('npx rn-iso start');
  const runAt = script.indexOf('npx rn-iso "$PLATFORM"');
  assert.ok(startAt !== -1 && runAt !== -1);
  assert.ok(startAt < runAt, 'the dev server has to be up before the build runs');
});

test('the dev script defaults to ios and forwards the rest of its arguments', () => {
  const script = renderDevScript();
  assert.match(script, /PLATFORM="\$\{1:-ios\}"/);
  assert.match(script, /npx rn-iso "\$PLATFORM" "\$@"/);
});

// Everything the script used to do by hand is now a command's own contract, so
// none of the hand-rolled machinery may come back.
test('the dev script hand-rolls no bundler, no poll loop and no log file', () => {
  const script = renderDevScript();
  for (const gone of ['packager-status:running', 'seq 1 60', '/tmp/rn-iso-metro', 'rn-iso up', '--wait-metro', '--no-bundler', 'RCT_jsLocation', '&']) {
    assert.ok(!script.includes(gone), `the dev script must not contain ${gone}`);
  }
});

// It is one script for both platforms because `rn-iso ios` and `rn-iso android`
// take the same (empty) option surface -- there is nothing left to specialise.
test('the dev script is the same whatever the project is', () => {
  assert.equal(renderDevScript(), renderDevScript());
});

// `.rn-iso/` needs exactly one entry now. It used to need a second one in a
// generated `.worktreeexclude`, and missing that was silent; `worktree create
// --carry-ignored` skips the directory in code instead (isWorkspaceArtifact,
// covered in test/worktree.test.js), so there is no second file to generate.
test('gitignore additions cover the workspace dir', () => {
  assert.match(renderGitignoreAdditions(), /^\.rn-iso\/$/m);
});

test('podfile pin puts the CAS outside DerivedData', () => {
  const out = renderPodfileCasPin();
  assert.match(out, /COMPILATION_CACHE_ENABLE_CACHING/);
  assert.match(out, /COMPILATION_CACHE_CAS_PATH/);
  // The whole point: it must not land anywhere under a workspace-local
  // derived-data tree, or it is shared with nothing.
  assert.doesNotMatch(out, /\.rn-iso\/derived-data/);
});

// .gitignore belongs to the repo, so init appends to it rather than generating
// it -- and init is re-run after an upgrade, so a second copy of the block
// would be noise that survives forever.
test('the gitignore additions are appended at most once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-init-'));
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    assert.equal(appendGitignoreAdditions(dir).changed, true);
    assert.equal(appendGitignoreAdditions(dir).changed, false);
    const source = readFileSync(join(dir, '.gitignore'), 'utf-8');
    assert.equal(source.split('\n').filter(l => l.trim() === '.rn-iso/').length, 1);
    assert.match(source, /^node_modules$/m, 'what the repo already ignored has to survive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// gitignore is a path list, so `/.rn-iso`, `.rn-iso` and `.rn-iso/` are one
// entry. Matching on the literal template would append beside an entry that
// already covers it.
test('an entry the repo already had is recognised whatever form it takes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-init-'));
  try {
    writeFileSync(join(dir, '.gitignore'), '# build output\n/.rn-iso\n');
    assert.equal(appendGitignoreAdditions(dir).changed, false);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf-8'), '# build output\n/.rn-iso\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A .gitignore that is not there yet is the ordinary case in a fresh bare repo.
test('a missing gitignore is created rather than skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-init-'));
  try {
    assert.equal(appendGitignoreAdditions(dir).changed, true);
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf-8'), /^\.rn-iso\/$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the fingerprint remedy -------------------------------------------------
//
// In a pnpm monorepo @expo/fingerprint is hoisted and transitive: absent from
// the app's dependency table, resolvable from it. The dep table alone had init
// announce "builds cannot be cached until it is installed" about a repo where
// they already could -- and prescribe `npm i -D` to a pnpm workspace.
test('@expo/fingerprint is detected by resolution when the dep table does not list it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-fp-'));
  try {
    const pkgDir = join(dir, 'node_modules', '@expo', 'fingerprint');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@expo/fingerprint', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '~57.0.0' } }));

    const facts = projectFacts({ pkg: { dependencies: { expo: '~57.0.0' } }, projectRoot: dir });
    assert.equal(facts.hasFingerprint, true, 'a hoisted copy resolves, so the build cache works today');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a root, the dependency table is still the answer', () => {
  assert.equal(projectFacts(expoApp).hasFingerprint, false);
  assert.equal(projectFacts({ ...expoApp, packageManager: 'pnpm' }).packageManager, 'pnpm');
});

// `npm i -D` in a pnpm workspace writes a second lockfile and installs into a
// directory nothing resolves from.
test('the install command is the one this repo is actually managed with', () => {
  assert.equal(installCommand('pnpm', '@expo/fingerprint'), 'pnpm add -D @expo/fingerprint');
  assert.equal(installCommand('yarn', '@expo/fingerprint'), 'yarn add -D @expo/fingerprint');
  assert.equal(installCommand('npm', '@expo/fingerprint'), 'npm i -D @expo/fingerprint');
});

test('an undetectable package manager produces no command at all, rather than npm', () => {
  assert.equal(installCommand(null, '@expo/fingerprint'), null);
  assert.equal(installCommand('bun', '@expo/fingerprint'), null, 'a manager whose flags are not known is not guessed at');
});

// A snippet that has to find a loop that is already there is what went wrong on
// a real Podfile: its post_install had no target loop at all (only one over
// resource bundles), so the two settings compiled into nothing and cached
// nothing, silently.
test('the podfile pin brings its own target and configuration loop', () => {
  const out = renderPodfileCasPin();
  assert.match(out, /installer\.pods_project\.targets\.each/);
  assert.match(out, /build_configurations\.each/);
  const enable = out.indexOf('COMPILATION_CACHE_ENABLE_CACHING');
  assert.ok(out.indexOf('targets.each') < enable, 'the settings go inside the loop');
  assert.match(out, /^end$/m);
});
