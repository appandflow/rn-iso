import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkArtifactLayout,
  checkBuildCacheProvider,
  checkCompilationCache,
  checkCcacheConflict,
  checkDevClient,
  checkLegacyCaches,
  checkMetroCache,
  detectXcodeMajor,
  parseXcodeMajor,
  pendingCacheMigrations,
} from '../src/doctor.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from '../src/cache-manifest.js';
import { resetExecutor, setExecutor } from '../src/exec.js';

// Where the key lives moved when the setting was promoted out of experiments,
// and the combination that silently does nothing is the NEW key on an OLD SDK.
// Verified against both CLIs: SDK 53 resolves exp.experiments.buildCacheProvider
// and nothing else; SDK 57 resolves exp.buildCacheProvider ?? the experiments one.
test('buildCacheProvider at the top level on SDK 53 is reported as a silent no-op', () => {
  const f = checkBuildCacheProvider({ expo: { buildCacheProvider: './p.js' } }, 53);
  assert.equal(f.level, 'cost');
  assert.match(f.detail, /ignored in silence/);
});

test('buildCacheProvider under experiments on SDK 53 is correct, and reported as nothing', () => {
  assert.equal(checkBuildCacheProvider({ expo: { experiments: { buildCacheProvider: './p.js' } } }, 53), null);
});

test('buildCacheProvider under experiments on a newer SDK still works, so it is a note not a cost', () => {
  const f = checkBuildCacheProvider({ expo: { experiments: { buildCacheProvider: './p.js' } } }, 57);
  assert.equal(f.level, 'note', 'the CLI falls back to it -- flagging this as a cost would be wrong');
  assert.match(f.detail, /falls back/);
});

test('buildCacheProvider at the top level on a newer SDK is what it should be', () => {
  assert.equal(checkBuildCacheProvider({ expo: { buildCacheProvider: './p.js' } }, 57), null);
});

// A bare React Native project has no provider hook at all, so advice about
// where to put the key would be nonsense.
test('a non-Expo project is told there is no hook, not told to configure one', () => {
  const f = checkBuildCacheProvider(null, null, false);
  assert.equal(f.level, 'note');
  assert.match(f.title, /outside Expo/);
  assert.match(f.detail, /fingerprint/);
});

// The compilation cache is an Xcode 26 feature. On older Xcode there is nothing
// useful to say, and "enable it" would be wrong.
test('compilation cache is not flagged at all on an Xcode that does not have it', () => {
  assert.equal(checkCompilationCache('post_install do |installer|\nend\n', 15), null);
});

test('compilation cache enabled without a CAS path is a cost, because the default is per-workspace', () => {
  const f = checkCompilationCache("config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'", 26);
  assert.equal(f.level, 'cost');
  assert.match(f.detail, /per-workspace/);
});

test('compilation cache with an explicit CAS path is reported as nothing', () => {
  const src = "COMPILATION_CACHE_ENABLE_CACHING = 'YES'\nCOMPILATION_CACHE_CAS_PATH = '/x'";
  assert.equal(checkCompilationCache(src, 26), null);
});

test('ccache alongside compilation caching is flagged as mutually defeating', () => {
  const f = checkCcacheConflict("COMPILATION_CACHE_ENABLE_CACHING = 'YES'", { 'apple.ccacheEnabled': 'true' });
  assert.equal(f.level, 'cost');
  assert.match(f.detail, /explicitly built modules/);
});

test('ccache alone is not flagged -- it is a legitimate choice without the other', () => {
  assert.equal(checkCcacheConflict('post_install', { 'apple.ccacheEnabled': 'true' }), null);
});

// The dev client advice is Expo-specific: a bare RN app has no dev client to
// install and reaches a non-default port another way.
test('a bare React Native project is not told to install expo-dev-client', () => {
  assert.equal(checkDevClient({ dependencies: { 'react-native': '0.86.2' } }), null);
});

test('an Expo project without the dev client is flagged, because a reserved port cannot reach it', () => {
  const f = checkDevClient({ dependencies: { expo: '~57.0.0' } });
  assert.equal(f.level, 'cost');
  assert.match(f.detail, /8081/);
});

test('metro config with a cacheStore is reported as nothing; without one it is a cost', () => {
  assert.equal(checkMetroCache('config.cacheStores = [new FileStore({})]'), null);
  assert.equal(checkMetroCache('module.exports = config;').level, 'cost');
  assert.equal(checkMetroCache(null).level, 'note', 'a missing config is worth a note, not an accusation');
});

// A config that is code cannot be read without executing it, and executing
// project code inside a diagnostic is not acceptable. Saying nothing would be
// worse than saying so: silence reads as a pass, and this is the check whose
// failure mode is silence in the first place.
test('a project whose config is app.config.ts is told the check could not run', () => {
  const f = checkBuildCacheProvider(null, 53, true, 'app.config.ts');
  assert.equal(f.level, 'note');
  assert.match(f.title, /Cannot check/);
  assert.match(f.fix, /experiments/, 'SDK 53 needs the experiments key, so name it');
});

test('a newer SDK with a dynamic config is pointed at the top-level key', () => {
  const f = checkBuildCacheProvider(null, 57, true, 'app.config.js');
  assert.match(f.fix, /top-level/);
});

test('no config at all and no dynamic config stays silent', () => {
  assert.equal(checkBuildCacheProvider(null, 57, true, null), null);
});

// Nothing ever passed an Xcode version, so every user was told what "Xcode 26+"
// offers, including the ones on Xcode 15 for whom that check should not fire and
// the ones whose actual version this line was quietly guessing at.
test('the compilation cache advice names the Xcode it was told about', () => {
  const podfile = 'post_install do |installer|\nend\n';
  assert.match(checkCompilationCache(podfile, 27).detail, /On Xcode 27 /);
});

test('an unreadable Xcode version is hedged rather than guessed at', () => {
  const podfile = 'post_install do |installer|\nend\n';
  const f = checkCompilationCache(podfile, null);
  assert.equal(f.level, 'note', 'the advice still goes out: unknown is not the same as too old');
  assert.match(f.detail, /could not be read/);
  assert.doesNotMatch(f.detail, /^On Xcode 26 a /, 'a version rn-iso never read must not read as a measurement');
});

// The version comes from `xcodebuild -version`, whose first line is "Xcode 26.1".
test('parseXcodeMajor reads the major from real xcodebuild output', () => {
  assert.equal(parseXcodeMajor('Xcode 26.1\nBuild version 17B55\n'), 26);
  assert.equal(parseXcodeMajor('Xcode 15\nBuild version 15A240d'), 15);
});

// No Xcode, command line tools only, or a format this does not know: all of them
// mean "unknown", never a number.
test('parseXcodeMajor returns null for anything it does not recognise', () => {
  for (const output of [null, '', 'xcode-select: error: tool not installed', 'Xcode vNext']) {
    assert.equal(parseXcodeMajor(output), null, JSON.stringify(output));
  }
});

// A mocked executor proves the parsing; running the real command proves the
// output has the shape the parser expects on this machine.
test('detectXcodeMajor agrees with the real xcodebuild, when there is one', () => {
  resetExecutor();
  const major = detectXcodeMajor();
  assert.ok(major === null || (Number.isInteger(major) && major > 0), `got ${major}`);
});

test('detectXcodeMajor reports unknown rather than throwing when xcodebuild is missing', () => {
  setExecutor({ run: () => { throw new Error('not found'); }, runQuiet: () => null, spawn: () => {} });
  try {
    assert.equal(detectXcodeMajor(), null);
  } finally {
    resetExecutor();
  }
});

// An app can depend on a dozen expo-* modules and still build with
// `react-native run-ios`. member-app is the real case: `expo` 53 in
// dependencies, `ios` script running `react-native run-ios`, and `status`
// already printing "(bare)". doctor used to key on the dependency alone and
// contradicted status with two Expo-only findings.
test('an expo-dependency project that builds with react-native run-ios is not flagged', () => {
  const pkg = { dependencies: { expo: '53.0.23', 'react-native': '0.79.6' } };
  assert.equal(checkDevClient(pkg, false), null);
});

test('the dev client finding still fires for a project that builds with expo run:ios', () => {
  const pkg = { dependencies: { expo: '~57.0.0' } };
  assert.equal(checkDevClient(pkg, true).level, 'cost');
});

// .rn-iso/ holds this workspace's build output, logs and supervisor pidfile.
// Gitignored but not worktree-excluded is the asymmetry that matters: it is
// exactly the state in which `worktree create --carry-ignored` copies another
// workspace's DerivedData, stale logs and a dead pidfile into a fresh worktree,
// which is strictly worse than starting with an empty cache.
test('reports when .rn-iso is gitignored but not worktree-excluded', () => {
  const f = checkArtifactLayout({
    gitignoreSource: '.rn-iso/\n',
    worktreeExcludeSource: '**/*.log\n',
  });
  assert.ok(f, 'expected a finding');
  assert.match(f.detail, /carry/i);
});

test('silent when both are wired', () => {
  assert.equal(checkArtifactLayout({
    gitignoreSource: '.rn-iso/\n',
    worktreeExcludeSource: '.rn-iso/\n',
  }), null);
});

// Worktree-excluded but not gitignored is the other half: nothing is carried,
// but every build commits its own DerivedData.
test('reports when .rn-iso is worktree-excluded but not gitignored', () => {
  const f = checkArtifactLayout({
    gitignoreSource: 'node_modules\n',
    worktreeExcludeSource: '.rn-iso/\n',
  });
  assert.ok(f, 'expected a finding');
  assert.match(f.title, /not gitignored/);
  assert.match(f.detail, /commit/i);
});

// A missing file is not a different diagnosis from a file that does not mention
// the directory: both mean the layout was never wired up, and both are fixed by
// the same command.
test('reports when neither file mentions the workspace directory', () => {
  const f = checkArtifactLayout({ gitignoreSource: null, worktreeExcludeSource: null });
  assert.ok(f, 'expected a finding');
  assert.match(f.fix, /rn-iso init/);
});

// The entry is a path, not a substring: leading and trailing slashes and
// comments are all the forms a real .gitignore is written in.
test('the entry is recognised however it is written, and comments do not count', () => {
  assert.match(
    checkArtifactLayout({
      gitignoreSource: '# ignore .rn-iso/ one day\nnode_modules\n',
      worktreeExcludeSource: '.rn-iso/\n',
    }).title,
    /not gitignored/,
    'a commented-out entry ignores nothing'
  );
  assert.equal(checkArtifactLayout({
    gitignoreSource: '/.rn-iso\n',
    worktreeExcludeSource: '.rn-iso\n',
  }), null);
});

// A cache left in its old location costs the disk twice AND a cold rebuild in
// every project on the machine, and nothing else on the box will ever mention
// it: the CLI and both packages have stopped looking there.
test('a legacy cache directory is reported with its size and a remedy', () => {
  const f = checkLegacyCaches([
    { legacy: '/home/u/.rn-iso-build-cache', dest: '/home/u/.rn-iso/build-cache', label: 'build cache', destExists: false, bytes: 3 * 1024 ** 3 },
  ]);
  assert.equal(f.level, 'cost');
  assert.match(f.detail, /\.rn-iso-build-cache/);
  assert.match(f.detail, /3\.0G/, 'the size is the whole reason to care');
  assert.match(f.fix, /rn-iso init/);
});

test('nothing left in a legacy location is no finding at all', () => {
  assert.equal(checkLegacyCaches([]), null);
  assert.equal(checkLegacyCaches(), null);
});

// A destination that already exists is not something `init` will resolve: the
// rename is refused rather than merged, so the advice has to say so.
test('a legacy cache whose destination is taken says so', () => {
  const f = checkLegacyCaches([
    { legacy: '/home/u/.demo-metro-cache', dest: '/home/u/.rn-iso/metro-cache/demo', label: 'Metro cache', destExists: true, bytes: 1024 ** 2 },
  ]);
  assert.match(f.fix, /by hand/);
});

// The legacy build cache is the sibling of the config dir rather than a literal
// ~/.rn-iso-build-cache, so RN_ISO_HOME sandboxes the whole migration: a test
// (or a live dry run) can never reach the real one.
//
// The Metro half cannot be derived that way -- the legacy directory was named
// after the app, `~/.<name>-metro-cache` -- so the manifest is the only record
// of where it actually is. Only the ones @rn-iso/metro-cache registered may
// move: a FileStore someone wired up by hand still points at its own directory,
// and moving that would take away a cache nothing else knows how to find.
function withFakeHome(fn) {
  const outer = mkdtempSync(join(tmpdir(), 'rn-iso-legacy-'));
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

test('the legacy build cache is found next to the config dir', () => {
  withFakeHome((outer, home) => {
    const legacy = join(outer, '.rn-iso-build-cache');
    assert.deepEqual(pendingCacheMigrations(), [], 'nothing to move when it is not there');
    mkdirSync(legacy);
    const pending = pendingCacheMigrations();
    assert.deepEqual(pending.map(p => p.legacy), [legacy]);
    assert.equal(pending[0].dest, join(home, 'build-cache'));
    assert.equal(pending[0].destExists, false);
  });
});

test('only the Metro caches @rn-iso/metro-cache registered are candidates', () => {
  withFakeHome((outer, home) => {
    const ours = join(outer, '.demo-metro-cache');
    const handRolled = join(outer, '.other-metro-cache');
    mkdirSync(ours);
    mkdirSync(handRolled);
    register({ dir: ours, name: 'Metro transform cache', prune: 'entries', entriesDepth: 2 });
    register({ dir: handRolled, name: 'Metro transforms', prune: 'entries', entriesDepth: 2 });

    const pending = pendingCacheMigrations();
    assert.deepEqual(pending.map(p => p.legacy), [ours], 'a hand-wired FileStore keeps its directory');
    assert.equal(pending[0].dest, join(home, 'metro-cache', 'demo'));
  });
});

test('a destination that already exists is reported, not silently merged', () => {
  withFakeHome((outer, home) => {
    mkdirSync(join(outer, '.rn-iso-build-cache'));
    mkdirSync(join(home, 'build-cache'));
    assert.equal(pendingCacheMigrations()[0].destExists, true);
  });
});
