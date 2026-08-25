import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  projectFacts,
  renderDevScript,
  renderGitignoreAdditions,
  renderPodfileCasPin,
  renderWorkflow,
  renderWorktreeExclude,
} from '../src/init.js';
import { appendGitignoreAdditions } from '../src/commands/init.js';

const expoApp = { pkg: { name: 'demo', dependencies: { expo: '~57.0.0', 'react-native': '0.86.2' } } };
const bareApp = { pkg: { name: 'bare', dependencies: { 'react-native': '0.86.2' } } };

// v3 runs the build itself, so the facts no longer carry an invented run
// command, the project's script table, or a package manager: nothing in the
// templates reconstructs a command line any more.
test('the facts describe the ecosystem and nothing about how to invoke it', () => {
  const facts = projectFacts(expoApp);
  assert.equal(facts.isExpo, true);
  assert.equal(facts.runCommand, undefined);
  assert.equal(facts.pm, undefined);
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

// --- the workflow -----------------------------------------------------------
//
// It documents the v3 loop, so it must name the v3 commands and none of the v2
// ones the CLI no longer has.

test('the workflow teaches start -> ios/android -> logs -> stop, in that order', () => {
  for (const facts of [projectFacts(expoApp), projectFacts(bareApp)]) {
    const doc = renderWorkflow(facts);
    const at = (needle) => {
      const i = doc.indexOf(needle);
      assert.notEqual(i, -1, `the workflow should mention ${needle}`);
      return i;
    };
    assert.ok(at('rn-iso worktree create') < at('rn-iso start'));
    assert.ok(at('rn-iso start') < at('rn-iso ios'));
    assert.ok(at('rn-iso ios') < at('rn-iso logs --errors'));
    assert.ok(at('rn-iso logs --errors') < at('rn-iso stop'));
    assert.ok(at('rn-iso stop') < at('rn-iso worktree remove'));
  }
});

// The commands that no longer exist. A generated document that teaches one of
// them is worse than no document: the agent runs it and gets "unknown command".
test('the workflow teaches no command the v3 binary does not have', () => {
  for (const facts of [projectFacts(expoApp), projectFacts(bareApp)]) {
    const doc = renderWorkflow(facts);
    for (const gone of ['rn-iso up', 'rn-iso release', 'rn-iso shutdown', 'rn-iso config', 'build-cache resolve', '--wait-metro', '--no-bundler']) {
      assert.ok(!doc.includes(gone), `the workflow must not teach ${gone}`);
    }
  }
});

// rn-iso never starts the bundler, and building before one answers is the
// mistake the whole ordering exists to prevent -- so the document has to say
// what happens instead of just naming the commands.
test('the workflow says why start comes first, in terms of the refusal', () => {
  const doc = renderWorkflow(projectFacts(expoApp));
  assert.match(doc, /RN_ISO_NO_METRO/);
  assert.match(doc, /never starts the bundler/);
});

// stop and worktree remove differ in exactly one way that matters, and reaching
// for the wrong one costs either a rebuild or a lost branch.
test('the workflow distinguishes the non-destructive stop from the destructive removal', () => {
  const doc = renderWorkflow(projectFacts(expoApp));
  assert.match(doc, /destroys nothing/);
  assert.match(doc, /uncommitted changes/);
  assert.match(doc, /Podfile\.lock/, 'the pod-install refusal fires after almost every iOS build');
});

// The build cache key moved when the setting left experiments, and naming the
// wrong one produces a silent no-op -- so the generated document has to name the
// one this SDK actually reads.
test('the workflow names the build cache key this SDK reads', () => {
  const sdk53 = renderWorkflow(projectFacts({ pkg: { dependencies: { expo: '~53.0.0' } } }));
  assert.match(sdk53, /expo\.experiments\.buildCacheProvider/);

  const sdk57 = renderWorkflow(projectFacts(expoApp));
  assert.match(sdk57, /expo\.buildCacheProvider/);
});

// A bare project has no Expo provider hook at all, so telling it where to put a
// key would be nonsense. It does not need one: `rn-iso ios` consults the shared
// cache itself, and only needs the fingerprinter.
test('a bare project is told about the fingerprinter, not about an Expo provider', () => {
  const doc = renderWorkflow(projectFacts(bareApp));
  assert.doesNotMatch(doc, /buildCacheProvider/);
  assert.match(doc, /@expo\/fingerprint/);
  assert.match(doc, /RN_ISO_NO_FINGERPRINT/, 'the refusal is what makes the missing dependency visible');
});

// The dev client is the difference between a reserved port working and a red
// screen, so an Expo project without it must be told first, not reassured.
test('an Expo project without the dev client is told to install it before anything else', () => {
  const doc = renderWorkflow(projectFacts(expoApp));
  assert.match(doc, /Install `expo-dev-client` before anything else/);
});

test('an Expo project that already has the dev client is told why it matters instead', () => {
  const doc = renderWorkflow(projectFacts({
    pkg: { dependencies: { expo: '~57.0.0', 'expo-dev-client': '~57.0.0' } },
  }));
  assert.doesNotMatch(doc, /Install `expo-dev-client` before/);
  assert.match(doc, /expo-development-client/);
});

// A bare project gets neither: rn-iso wires the port at runtime itself, and the
// reason it does NOT compile it in has to survive, or someone will.
test('a bare project is told how the port reaches the app without being compiled in', () => {
  const doc = renderWorkflow(projectFacts(bareApp));
  assert.match(doc, /RCT_jsLocation/);
  assert.match(doc, /adb reverse/);
  assert.match(doc, /does not bake the port|Neither bakes/);
});

test('the worktree exclude file is patterns and comments only', () => {
  const lines = renderWorktreeExclude().split('\n').filter(l => l.trim() && !l.startsWith('#'));
  assert.ok(lines.length > 0);
  assert.ok(lines.every(l => !l.includes(' ')), 'a pattern with a space in it would not match anything');
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

test('the workflow points at the script init writes alongside it', () => {
  for (const facts of [projectFacts(expoApp), projectFacts(bareApp)]) {
    const doc = renderWorkflow(facts);
    assert.match(doc, /\.\/scripts\/dev/);
    assert.match(doc, /Edit it freely/, 'the script is the repo\'s, not rn-iso\'s');
  }
});

// `.rn-iso/` has to land in BOTH files, and missing either one fails silently.
// Not worktree-excluded is the worse half: `worktree create --carry-ignored`
// then hands a fresh worktree the previous one's DerivedData, stale logs and a
// pidfile for a process that is not running.
test('worktreeExclude excludes the workspace dir', () => {
  assert.match(renderWorktreeExclude(), /^\.rn-iso\/$/m);
});

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
