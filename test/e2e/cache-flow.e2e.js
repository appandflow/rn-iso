// FAST CROSS-PLATFORM E2E -- the cache machinery, end to end, with no compiler.
//
// This is the one e2e that runs on Ubuntu with no Xcode and no Android SDK. It
// drives the REAL library and the REAL CLI everywhere they are OS-portable and
// asserts the whole cross-worktree cache story the native jobs prove again with
// an actual build:
//
//   1. `rn-iso worktree create` makes two real git worktrees at one commit, and
//      honours the stdout-is-only-the-path contract.
//   2. Two worktrees of one commit FINGERPRINT IDENTICALLY when scoped to a
//      platform (the cross-worktree cache premise) -- and differ under ios/ when
//      a worktree-local path leaks in, which is exactly why the hash is scoped.
//   3. A build stored under wt1's key RESOLVES from wt2's key: a cross-worktree
//      cache HIT with no compiler in sight. Change a native input in wt2 and the
//      key changes and the hit becomes a MISS.
//   4. Two real processes racing the single-flight lock: exactly one builds; the
//      other waits and resolves the artifact the first one stored.
//   5. `rn-iso worktree remove` leaves nothing behind -- no dirs, no config
//      entries, a clean `git worktree list`.
//
// Everything runs under a throwaway RN_ISO_HOME and a throwaway TMPDIR-rooted
// repo, so it never touches the real machine's caches, registry or checkouts.
//
// The only non-real piece is the leaf hash function: @expo/fingerprint is not
// installed in this repo, so a vendored, API-compatible, platform-scoping stub
// is injected through the `load` seam fingerprintProject already exposes for
// this purpose. See fixtures/fingerprint-stub.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  fingerprintProject,
  buildCacheKey,
  storeBuild,
  resolveBuild,
  entryDir,
} from '../../packages/rn-iso/src/build-cache.ts';
import { buildLockPath } from '../../packages/rn-iso/src/engine/build-lock.ts';
import { loadConfig } from '../../packages/rn-iso/src/config.ts';
import { makeFingerprinter } from './fixtures/fingerprint-stub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CLI = join(REPO, 'packages', 'rn-iso', 'bin', 'cli.ts');
const LOCK_URL = pathToFileURL(join(REPO, 'packages', 'rn-iso', 'src', 'engine', 'build-lock.ts')).href;
const CACHE_URL = pathToFileURL(join(REPO, 'packages', 'rn-iso', 'src', 'build-cache.ts')).href;

// The stub, injected everywhere fingerprintProject is called below.
const load = () => makeFingerprinter();

const ctx = {};

before(() => {
  // One throwaway home for the registry + the shared build cache, one throwaway
  // tmp root for the repo and its worktrees. realpath so macOS's /var -> /private
  // symlink cannot make a config key written at create time miss at remove time.
  ctx.home = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-e2e-home-')));
  ctx.tmp = realpathSync(mkdtempSync(join(tmpdir(), 'rn-iso-e2e-')));
  process.env.RN_ISO_HOME = ctx.home;

  ctx.repo = join(ctx.tmp, 'app');
  ctx.remote = join(ctx.tmp, 'remote.git');
  makeMinimalRnProject(ctx.repo);
  initGitRepoWithRemote(ctx.repo, ctx.remote);
});

after(() => {
  for (const dir of [ctx.home, ctx.tmp]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.RN_ISO_HOME;
});

// --- 1. worktree create: two worktrees at one commit, stdout is the path -----

test('worktree create prints only the worktree path, and makes a real worktree', () => {
  ctx.wt1 = createWorktree('e2e-wt1');
  ctx.wt2 = createWorktree('e2e-wt2');

  for (const wt of [ctx.wt1, ctx.wt2]) {
    assert.ok(existsSync(wt), `worktree dir exists: ${wt}`);
    assert.ok(existsSync(join(wt, 'package.json')), 'the checkout is populated');
    assert.ok(existsSync(join(wt, 'ios')) && existsSync(join(wt, 'android')), 'native dirs are present');
  }
  assert.notEqual(ctx.wt1, ctx.wt2);

  // Registered in the config as worktree roots (this is what remove must undo).
  const projects = loadConfig()?.projects || {};
  assert.ok(projects[ctx.wt1]?.worktreeRoot, 'wt1 registered as a worktree root');
  assert.ok(projects[ctx.wt2]?.worktreeRoot, 'wt2 registered as a worktree root');
});

// --- 2. the cross-worktree fingerprint premise -------------------------------

test('two worktrees of one commit fingerprint identically when scoped', async () => {
  const a = await fingerprintProject(ctx.wt1, { platform: 'android', load });
  const b = await fingerprintProject(ctx.wt2, { platform: 'android', load });
  assert.ok(a && typeof a === 'string', 'a real hash came back');
  assert.equal(a, b, 'identical native trees at one commit hash identically -- the whole premise');
  ctx.androidHash1 = a;
});

test('a worktree-local path under ios/ changes the ios hash but NOT the android one', async () => {
  // Simulate the documented hermes-podspec problem: something under ios/ bakes
  // the absolute worktree path in, so two worktrees of one commit differ under
  // ios/ by construction. This is exactly why fingerprintProject scopes.
  writeFileSync(join(ctx.wt1, 'ios', 'Podfile.lock'), `PODS:\n  - hermes-engine (from \`${ctx.wt1}/ios\`)\n`);
  writeFileSync(join(ctx.wt2, 'ios', 'Podfile.lock'), `PODS:\n  - hermes-engine (from \`${ctx.wt2}/ios\`)\n`);

  const iosA = await fingerprintProject(ctx.wt1, { platform: 'ios', load });
  const iosB = await fingerprintProject(ctx.wt2, { platform: 'ios', load });
  assert.notEqual(iosA, iosB, 'the ios hash differs across worktrees -- an UNSCOPED hash would poison android too');

  // ... and the android hash is untouched by the ios/ divergence: still equal,
  // still what it was before. This is the property that makes the cross-worktree
  // android cache hit at all.
  const androidA = await fingerprintProject(ctx.wt1, { platform: 'android', load });
  const androidB = await fingerprintProject(ctx.wt2, { platform: 'android', load });
  assert.equal(androidA, androidB, 'scoping keeps the ios/ churn out of the android key');
  assert.equal(androidA, ctx.androidHash1, 'and the android hash did not move');
});

// --- 3. cross-worktree cache hit, then a miss on a native change -------------

test('a build stored under wt1 key resolves from wt2 key: a cross-worktree HIT', async () => {
  const hash1 = await fingerprintProject(ctx.wt1, { platform: 'android', load });
  const hash2 = await fingerprintProject(ctx.wt2, { platform: 'android', load });
  const key1 = buildCacheKey('android', hash1, {});
  const key2 = buildCacheKey('android', hash2, {});
  assert.equal(key1, key2, 'same fingerprint, same options -> same cache key across worktrees');

  // A synthetic artifact -- storeBuild copies it into the shared cache with the
  // same atomic staging path a real .apk/.app takes. No compiler runs.
  const synthetic = join(ctx.tmp, 'synthetic', 'Foo.app');
  mkdirSync(synthetic, { recursive: true });
  writeFileSync(join(synthetic, 'Foo'), 'not a real binary, but a real file');
  const stored = storeBuild('android', key1, synthetic);
  assert.ok(stored && existsSync(stored), 'stored into the shared cache');
  assert.equal(stored, join(entryDir('android', key1), 'Foo.app'), 'landed at the fingerprint-keyed path');

  // The wt2 process, on the same commit, resolves the SAME entry -- without
  // ever building. This is the cache doing its whole job.
  const hit = resolveBuild('android', key2);
  assert.equal(hit, stored, 'wt2 resolves exactly what wt1 stored');
  assert.ok(existsSync(join(hit, 'Foo')), 'and the artifact is real');
  ctx.androidKey = key1;
});

test('changing a native input in wt2 changes the key and turns the hit into a MISS', async () => {
  // A genuine native input: append to android/app/build.gradle. The fingerprint
  // must move, the key with it, and resolveBuild must now find nothing.
  const gradle = join(ctx.wt2, 'android', 'app', 'build.gradle');
  writeFileSync(gradle, readFileSync(gradle, 'utf-8') + '\n// native input changed by the e2e\n');

  const changed = await fingerprintProject(ctx.wt2, { platform: 'android', load });
  assert.notEqual(changed, ctx.androidHash1, 'the fingerprint moved with the native input');

  const changedKey = buildCacheKey('android', changed, {});
  assert.notEqual(changedKey, ctx.androidKey, 'so the cache key moved too');
  assert.equal(resolveBuild('android', changedKey), null, 'and it is a MISS -- exactly the rebuild trigger');
});

// --- 4. single-flight: exactly one builds; the other waits and resolves ------

test('exactly one of four racing processes acquires the lock', async () => {
  const key = 'race-debug-sim';
  const racer = writeScript('racer.mjs', [
    `const { acquireBuildLock } = await import(${JSON.stringify(LOCK_URL)});`,
    'const got = acquireBuildLock({',
    '  platform: "ios", key: process.argv[2], root: `/worktree/${process.argv[3]}`,',
    '  logFile: `/worktree/${process.argv[3]}/build.ndjson`,',
    '});',
    // Hold long enough that every sibling has certainly reached its own mkdir.
    'await new Promise(r => setTimeout(r, 1200));',
    'process.stdout.write(JSON.stringify({ pid: process.pid, ...got }));',
  ]);

  const results = await Promise.all(['a', 'b', 'c', 'd'].map((name) => runNode(racer, [key, name])));
  const answers = results.map((r) => JSON.parse(r.stdout.trim()));
  const winners = answers.filter((a) => a.acquired);
  const losers = answers.filter((a) => a.held);

  assert.equal(
    winners.length,
    1,
    `exactly one builder: ${JSON.stringify(answers.map((a) => a.acquired ?? a.held?.pid))}`,
  );
  assert.equal(losers.length, 3, 'everyone else is told to wait');
  for (const loser of losers) {
    assert.equal(loser.held.pid, winners[0].pid, 'every loser names the one real builder');
  }
});

test('the loser of a race waits and resolves the artifact the winner stores', async () => {
  const key = 'shared-debug-sim';
  const builder = writeScript('builder.mjs', [
    `const { acquireBuildLock, releaseBuildLock } = await import(${JSON.stringify(LOCK_URL)});`,
    `const { storeBuild } = await import(${JSON.stringify(CACHE_URL)});`,
    'const { mkdirSync, writeFileSync } = await import("node:fs");',
    'const { join } = await import("node:path");',
    `const got = acquireBuildLock({ platform: "ios", key: ${JSON.stringify(key)}, root: process.argv[2], logFile: join(process.argv[2], "build.ndjson") });`,
    'if (!got.acquired) { process.stdout.write(JSON.stringify({ raced: true })); process.exit(0); }',
    'try {',
    '  await new Promise(r => setTimeout(r, 900));', // the "build"
    '  const app = join(process.argv[2], "Fixture.app");',
    '  mkdirSync(app, { recursive: true });',
    '  writeFileSync(join(app, "Fixture"), "binary");',
    `  const stored = storeBuild("ios", ${JSON.stringify(key)}, app);`,
    '  process.stdout.write(JSON.stringify({ built: true, stored }));',
    '} finally {',
    '  releaseBuildLock(got);',
    '}',
  ]);
  const waiter = writeScript('waiter.mjs', [
    `const { acquireBuildLock, waitForBuild } = await import(${JSON.stringify(LOCK_URL)});`,
    `const got = acquireBuildLock({ platform: "ios", key: ${JSON.stringify(key)}, root: process.argv[2], logFile: null });`,
    'if (got.acquired) { process.stdout.write(JSON.stringify({ wonInstead: true })); process.exit(0); }',
    `const result = await waitForBuild({ platform: "ios", key: ${JSON.stringify(key)}, intervalMs: 50, out: (l) => console.error(l) });`,
    'process.stdout.write(JSON.stringify({ ...result, heldPid: got.held.pid }));',
  ]);

  const buildRoot = join(ctx.tmp, 'race-builder');
  const waitRoot = join(ctx.tmp, 'race-waiter');
  mkdirSync(buildRoot, { recursive: true });
  mkdirSync(waitRoot, { recursive: true });

  const started = runNode(builder, [buildRoot]);
  // Give the builder the lock first: this assertion is about the WAITER's path.
  await delay(300);
  const [built, waited] = await Promise.all([started, runNode(waiter, [waitRoot])]);

  const builderOut = JSON.parse(built.stdout.trim());
  assert.equal(builderOut.built, true, `builder should have built: ${built.stderr}`);
  const waiterOut = JSON.parse(waited.stdout.trim());
  assert.equal(waiterOut.wonInstead, undefined, 'the waiter must not have taken the lock');
  assert.equal(waiterOut.hit, builderOut.stored, 'the waiter resolves exactly the entry the builder stored');
  assert.ok(existsSync(join(waiterOut.hit, 'Fixture')), 'the resolved artifact is real');
  // Released in the builder's finally: the next build on this fingerprint is
  // not stuck behind a lock nobody holds.
  assert.equal(existsSync(buildLockPath('ios', key)), false, 'the lock was released');
});

// --- 5. teardown leaves nothing behind ---------------------------------------

test('worktree remove refuses a dirty tree, then removes a clean one leaving nothing behind', () => {
  // Steps 2 and 4 dirtied both worktrees on purpose (an untracked ios/Podfile.lock,
  // a modified android/app/build.gradle). remove must REFUSE that without --force
  // -- protecting work the tester did not mean to throw away.
  assert.throws(
    () => removeWorktree(ctx.wt1),
    /Refusing to remove|uncommitted/i,
    'a dirty worktree is not silently deleted',
  );

  // Follow the tool's own remedy: drop the untracked file, restore the tracked
  // change. Now the tree is clean and removal is the routine no-force path.
  for (const wt of [ctx.wt1, ctx.wt2]) {
    rmSync(join(wt, 'ios', 'Podfile.lock'), { force: true });
    execFileSync('git', ['-C', wt, 'checkout', '--', '.'], { encoding: 'utf-8' });
  }

  removeWorktree(ctx.wt1);
  removeWorktree(ctx.wt2);

  assert.ok(!existsSync(ctx.wt1), 'wt1 directory is gone');
  assert.ok(!existsSync(ctx.wt2), 'wt2 directory is gone');

  const projects = loadConfig()?.projects || {};
  assert.equal(projects[ctx.wt1], undefined, 'wt1 config entry is gone');
  assert.equal(projects[ctx.wt2], undefined, 'wt2 config entry is gone');
  assert.ok(!Object.keys(projects).some((p) => p.includes('-worktrees')), 'no stray worktree entries remain');

  const list = execFileSync('git', ['-C', ctx.repo, 'worktree', 'list'], { encoding: 'utf-8' });
  assert.ok(!list.includes('-worktrees'), `only the main checkout remains:\n${list}`);
});

// --- helpers -----------------------------------------------------------------

function createWorktree(name) {
  // stdout is ONLY the path, per the documented contract; everything else
  // ("Branched ...", "Worktree ready.") goes to stderr. --base head keeps this
  // deterministic in a repo whose origin/HEAD we control.
  const out = execFileSync(process.execPath, [CLI, 'worktree', 'create', name, '--base', 'head'], {
    cwd: ctx.repo,
    env: { ...process.env, RN_ISO_HOME: ctx.home },
    encoding: 'utf-8',
  });
  const lines = out.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `stdout carries exactly one line (the path), got:\n${out}`);
  const path = lines[0];
  assert.ok(path.startsWith('/') || /^[A-Za-z]:\\/.test(path), `stdout is an absolute path: ${path}`);
  return realpathSync(path);
}

function removeWorktree(path) {
  execFileSync(process.execPath, [CLI, 'worktree', 'remove', path], {
    env: { ...process.env, RN_ISO_HOME: ctx.home },
    encoding: 'utf-8',
  });
}

function writeScript(name, lines) {
  const path = join(ctx.tmp, name);
  writeFileSync(path, Array.isArray(lines) ? lines.join('\n') : lines);
  return path;
}

function runNode(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        env: { ...process.env, RN_ISO_HOME: ctx.home },
        timeout: 60000,
      },
      (err, stdout, stderr) => {
        if (err && err.code === undefined) return reject(err);
        resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A minimal but RN-shaped project: a package.json plus ios/ and android/ trees
// with enough real files that a fingerprint has something to hash. Deliberately
// bare RN (a `react-native run-ios` ios script, no `expo` dep) so detectIsExpo
// is unambiguous -- the native jobs cover the Expo path with a real template.
function makeMinimalRnProject(root) {
  mkdirSync(join(root, 'ios', 'App.xcodeproj'), { recursive: true });
  mkdirSync(join(root, 'android', 'app'), { recursive: true });

  write(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'rn-iso-e2e-fixture',
        version: '1.0.0',
        private: true,
        scripts: { ios: 'react-native run-ios', android: 'react-native run-android' },
        dependencies: { react: '18.2.0', 'react-native': '0.74.0' },
      },
      null,
      2,
    ) + '\n',
  );

  write(join(root, 'app.json'), JSON.stringify({ name: 'App', displayName: 'App' }, null, 2) + '\n');
  write(join(root, 'index.js'), "import { AppRegistry } from 'react-native';\n");

  // ios/ native inputs.
  write(join(root, 'ios', 'Podfile'), "platform :ios, '15.1'\ntarget 'App' do\nend\n");
  write(join(root, 'ios', 'App.xcodeproj', 'project.pbxproj'), '// minimal pbxproj fixture\n');

  // android/ native inputs.
  write(join(root, 'android', 'build.gradle'), 'buildscript { ext { minSdkVersion = 24 } }\n');
  write(join(root, 'android', 'settings.gradle'), "rootProject.name = 'App'\n");
  write(join(root, 'android', 'app', 'build.gradle'), "apply plugin: 'com.android.application'\n");
  write(join(root, 'android', 'app', 'AndroidManifest.xml'), '<manifest package="com.app"/>\n');

  // .rn-iso must never influence a fingerprint, and must never be carried into a
  // worktree; a .gitignore entry keeps the tree clean for the remove step.
  write(join(root, '.gitignore'), 'node_modules/\n.rn-iso/\n');
}

function initGitRepoWithRemote(repo, remote) {
  const git = (args, cwd = repo) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf-8' });
  git(['config', 'user.email', 'e2e@example.com']);
  git(['config', 'user.name', 'rn-iso e2e']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-m', 'minimal RN fixture']);
  // A bare remote so `worktree remove` sees the branch tip as pushed and does
  // not refuse over "unpushed commits" -- this exercises the real no-force path.
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { encoding: 'utf-8' });
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'main']);
  git(['remote', 'set-head', 'origin', 'main']);
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}
