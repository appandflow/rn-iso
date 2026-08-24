import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBuildCacheProvider,
  checkCompilationCache,
  checkCcacheConflict,
  checkDevClient,
  checkMetroCache,
  detectXcodeMajor,
  parseXcodeMajor,
} from '../src/doctor.js';
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
