import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkArtifactLayout,
  checkBuildCacheProvider,
  checkCompilationCache,
  checkCcacheConflict,
  checkDevClient,
  checkEasAuth,
  checkMetroCache,
  runDoctor,
  metroConfigDelegate,
  detectXcodeMajor,
  parseXcodeMajor,
  checkConcurrency,
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

// `.rn-iso/` holds this workspace's build output, logs and supervisor pidfile,
// and the only thing that can still be wrong about it is the .gitignore entry:
// carrying it into a fresh worktree is prevented in code now, not by a second
// file that has to say so (isWorkspaceArtifact in src/worktree.js).
test('silent when .rn-iso is gitignored', () => {
  assert.equal(checkArtifactLayout({ gitignoreSource: '.rn-iso/\n' }), null);
});

test('a project that does not ignore .rn-iso is told what ends up in git status', () => {
  const f = checkArtifactLayout({ gitignoreSource: 'node_modules\n' });
  assert.ok(f, 'expected a finding');
  assert.match(f.title, /not gitignored/);
  assert.match(f.detail, /commit/i);
  assert.match(f.fix, /add it themselves/i);
});

test('a missing .gitignore is the same diagnosis as one that does not mention it', () => {
  assert.match(checkArtifactLayout({ gitignoreSource: null }).title, /not gitignored/);
  assert.equal(checkArtifactLayout().title, checkArtifactLayout({ gitignoreSource: '' }).title);
});

// The entry is a path, not a substring: leading and trailing slashes and
// comments are all the forms a real .gitignore is written in.
test('the entry is recognised however it is written, and comments do not count', () => {
  assert.equal(checkArtifactLayout({ gitignoreSource: '/.rn-iso\n' }), null);
  assert.equal(checkArtifactLayout({ gitignoreSource: '.rn-iso\n' }), null);
  assert.match(
    checkArtifactLayout({ gitignoreSource: '# ignore .rn-iso/ one day\nnode_modules\n' }).title,
    /not gitignored/,
    'a commented-out entry ignores nothing'
  );
});

// --- cacheStores that is only wired some of the time ------------------------
//
// The real shape from a field run: the store is built behind an env var that is
// off by default, and spread into the config. A substring match on
// `cacheStores` read that as a pass, so doctor confirmed a cache that was never
// installed. doctor still does not evaluate the file -- it says it cannot tell.
test('a cacheStores behind an env-var conditional is downgraded to a note, not a pass', () => {
  const source = [
    'const sharedCacheStores =',
    "  process.env.TLON_METRO_SHARED_CACHE_ENABLED === '1'",
    '    ? [new FileStore({ root: sharedCacheRoot })]',
    '    : undefined;',
    'const config = {',
    '  ...(sharedCacheStores ? { cacheStores: sharedCacheStores } : {}),',
    '};',
  ].join('\n');
  const f = checkMetroCache(source);
  assert.ok(f, 'expected a finding');
  assert.equal(f.level, 'note', 'doctor cannot evaluate the file, so it cannot call this a cost either');
  assert.match(f.title, /cacheStores/);
  assert.match(f.fix, /env var/i);
});

test('a cacheStores set inside an if is a note for the same reason', () => {
  const source = 'if (process.env.SHARED) {\n  config.cacheStores = [new FileStore({})];\n}\n';
  assert.equal(checkMetroCache(source).level, 'note');
});

// The plain shape is the one this check exists to reward: unconditional wiring
// stays silent, exactly as before.
test('an unconditional cacheStores stays silent', () => {
  assert.equal(checkMetroCache("config.cacheStores = [new FileStore({ root: '/x' })];"), null);
  assert.equal(checkMetroCache("const { sharedCacheStores } = require('@rn-iso/metro');\nconfig.cacheStores = sharedCacheStores('app');"), null);
});

// A metro.config.js that is one line of delegation decides NOTHING here, and
// the per-project cost finding it used to produce was a confident measurement
// of a file that does not hold the answer. Taken verbatim from a real
// yarn-workspaces repo, commented-out require and all.
test('a metro config that delegates to a workspace package is reported as uninspectable', () => {
  const source = [
    '// RN CLI checks for this to make sure the config is valid :/',
    "// const { getDefaultConfig } = require('@react-native/metro-config');",
    '',
    "module.exports = require('@th3rdwave/react-native-app-scripts/metro-config')(",
    '  __dirname,',
    ');',
  ].join('\n');
  assert.equal(metroConfigDelegate(source), '@th3rdwave/react-native-app-scripts/metro-config');
  const f = checkMetroCache(source);
  assert.equal(f.level, 'note', 'a cost nobody can act on is worse than a note');
  assert.match(f.title, /delegates to @th3rdwave\/react-native-app-scripts\/metro-config; rn-iso cannot inspect it/);
  assert.doesNotMatch(f.title, /per-project/);
});

test('the ESM and plain forms of the same delegation are recognized too', () => {
  assert.equal(metroConfigDelegate("module.exports = require('@acme/metro');"), '@acme/metro');
  assert.equal(metroConfigDelegate("export { default } from '@acme/metro';"), '@acme/metro');
  assert.equal(metroConfigDelegate("export default require('./tools/metro-config');"), './tools/metro-config');
});

test('an ordinary config that BUILDS on a metro package is not a delegation', () => {
  // The distinction that matters: requiring expo/metro-config and then
  // configuring it is a config doctor can read, and it must still get the
  // real finding.
  assert.equal(metroConfigDelegate("module.exports = require('expo/metro-config').getDefaultConfig(__dirname);"), null);
  assert.equal(metroConfigDelegate("const { getDefaultConfig } = require('@react-native/metro-config');\nconst config = getDefaultConfig(__dirname);\nmodule.exports = config;"), null);
  assert.equal(checkMetroCache("module.exports = require('expo/metro-config').getDefaultConfig(__dirname);").level, 'cost');
});

test('a delegating config that DOES mention cacheStores is read normally', () => {
  // Delegation is only interesting because the file says nothing about the
  // cache. One that does is inspectable after all.
  const source = "const base = require('@acme/metro');\nbase.cacheStores = [new FileStore({ root: '/x' })];\nmodule.exports = base;";
  assert.equal(metroConfigDelegate(source), null);
  assert.equal(checkMetroCache(source), null);
});

// The two settings only do anything inside a loop that defines `config`. A real
// Podfile's post_install had no such loop (only one over resource bundles), so
// the advice as written produced a Podfile that compiled and cached nothing.
test('the compilation cache advice names the loop the settings have to live in', () => {
  const f = checkCompilationCache('post_install do |installer|\nend\n', 26);
  assert.match(f.fix, /post_install/);
  assert.match(f.fix, /targets\.each/);
  assert.match(f.fix, /build_configurations/);
  assert.match(f.fix, /adding one if/i);
});

// A dynamic config is the one case where doctor cannot answer its own question,
// so it has to hand over the command that can -- and say that an existing
// provider, "eas" included, already satisfies the check.
test('the dynamic-config note carries the command that answers it', () => {
  const f = checkBuildCacheProvider(null, 57, true, 'app.config.ts');
  assert.match(f.fix, /npx expo config --json/);
  assert.match(f.fix, /buildCacheProvider/);
});

test('the dynamic-config note says an existing provider is kept, as the static one does', () => {
  for (const sdk of [53, 57]) {
    const f = checkBuildCacheProvider(null, sdk, true, 'app.config.ts');
    assert.match(f.fix, /"eas"/, `SDK ${sdk}`);
    assert.match(f.fix, /never replaces it/, `SDK ${sdk}`);
  }
});

// --- the EAS session ---------------------------------------------------------
//
// The check exists because eas-build-cache-provider returns null on EVERY
// failure (its own source: try/catch around `npx eas-cli`, catch -> return
// null), so a team whose shared cache is off because nobody is logged in sees
// exactly what a cold cache looks like. doctor is the place that can say so.
test('a project with no EAS provider is not asked about EAS at all', () => {
  let asked = false;
  const f = checkEasAuth({ provider: { plugin: './local.js' }, auth: () => { asked = true; } });
  assert.equal(f, null);
  assert.equal(asked, false, 'whoami is a network call; it is not run for projects that do not use EAS');
});

test('the EAS provider with no eas-cli anywhere is a cost, with an install remedy', () => {
  const f = checkEasAuth({ provider: 'eas', auth: { failed: true, code: 'no-cli', reason: 'no `eas` executable', remedy: 'Install eas-cli.' } });
  assert.equal(f.level, 'cost');
  assert.match(f.title, /eas-cli/);
  assert.match(f.fix, /Install eas-cli/);
});

test('the EAS provider with no session is a cost naming both ways back in', () => {
  const f = checkEasAuth({ provider: 'eas', auth: { failed: true, code: 'logged-out', reason: 'Not logged in', remedy: 'Run `eas login` (or set EXPO_TOKEN).' } });
  assert.equal(f.level, 'cost');
  assert.match(f.detail, /miss/i, 'the point is that it looks exactly like an empty cache');
  assert.match(f.fix, /eas login/);
  assert.match(f.fix, /EXPO_TOKEN/);
});

// A note rather than a cost, and the detail has to say why: whoami does not
// always enumerate accounts (a robot actor prints a display name that is not an
// account name), and access is the server's decision, not this list's.
test('a session on an account that does not cover the owner is a NOTE naming both', () => {
  const f = checkEasAuth({
    provider: 'eas',
    owner: 'th3rd-wave',
    auth: { failed: true, code: 'wrong-account', account: 'janic', accounts: ['janic'], owner: 'th3rd-wave', remedy: 'Run `eas login` as a member of th3rd-wave.' },
  });
  assert.equal(f.level, 'note');
  assert.match(f.title, /janic/);
  assert.match(f.title, /th3rd-wave/);
  assert.match(f.detail, /not a hard failure|may be incomplete|cannot be read/i);
});

// Offline is the case that must not produce a false alarm: whoami hits the
// network whenever a session exists, and a plane is not a logged-out user.
test('an unestablished session is a note about the check, not an accusation', () => {
  const f = checkEasAuth({ provider: 'eas', auth: { unknown: 'eas whoami timed out after 15000ms' } });
  assert.equal(f.level, 'note');
  assert.match(f.detail, /timed out/);
  assert.ok(!/not logged in/i.test(f.title), 'an unreachable API is not a logged-out session');
});

test('a good session is reported as nothing at all', () => {
  assert.equal(checkEasAuth({ provider: 'eas', owner: 'janic', auth: { ok: true, account: 'janic', accounts: ['janic'] } }), null);
});

// The experiments key is where SDK 53 keeps it, and "eas" there is still EAS.
test('the provider is recognised on either key', () => {
  const auth = { failed: true, code: 'logged-out', remedy: 'Run `eas login`.' };
  assert.ok(checkEasAuth({ provider: 'eas', auth }));
});

test('runDoctor probes the session only for an EAS project, and passes it the owner', () => {
  const probes = [];
  const auth = (args) => { probes.push(args); return { ok: true, account: 'janic', accounts: ['janic'] }; };

  const easProject = mkdtempSync(join(tmpdir(), 'rn-iso-doctor-'));
  writeFileSync(join(easProject, 'package.json'), JSON.stringify({ dependencies: { expo: '~57.0.0' } }));
  writeFileSync(join(easProject, 'app.json'), JSON.stringify({ expo: { owner: 'th3rd-wave', buildCacheProvider: 'eas' } }));
  runDoctor(easProject, { easAuth: auth });
  assert.equal(probes.length, 1);
  assert.equal(probes[0].projectRoot, easProject);
  assert.equal(probes[0].owner, 'th3rd-wave');

  const otherProject = mkdtempSync(join(tmpdir(), 'rn-iso-doctor-'));
  writeFileSync(join(otherProject, 'package.json'), JSON.stringify({ dependencies: { expo: '~57.0.0' } }));
  writeFileSync(join(otherProject, 'app.json'), JSON.stringify({ expo: { buildCacheProvider: { plugin: '@rn-iso/expo-build-cache' } } }));
  runDoctor(otherProject, { easAuth: auth });
  assert.equal(probes.length, 1, 'a non-EAS project never pays for a whoami');

  rmSync(easProject, { recursive: true, force: true });
  rmSync(otherProject, { recursive: true, force: true });
});

test('the EAS finding reaches the report runDoctor returns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-doctor-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { expo: '~57.0.0' } }));
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: { buildCacheProvider: 'eas' } }));
  const findings = runDoctor(dir, {
    easAuth: () => ({ failed: true, code: 'logged-out', remedy: 'Run `eas login` (or set EXPO_TOKEN).' }),
  });
  assert.ok(findings.some(f => /EAS/.test(f.title) && f.level === 'cost'));
  rmSync(dir, { recursive: true, force: true });
});

// --- concurrency note (only when limits are set) ---
test('checkConcurrency is silent when no limit is set', () => {
  assert.equal(checkConcurrency({ maxBuilds: 0, maxDevices: 0 }), null);
});

test('checkConcurrency echoes the caps and the current live count when set', () => {
  const f = checkConcurrency({ maxBuilds: 2, maxDevices: 3, liveDevices: 1, activeBuilds: 0 });
  assert.equal(f.level, 'note');
  assert.match(f.detail, /maxBuilds 2/);
  assert.match(f.detail, /maxDevices 3/);
  assert.match(f.detail, /1 /); // live device count echoed
});

test('runDoctor stays silent about concurrency when nothing is set', () => {
  const project = mkdtempSync(join(tmpdir(), 'rn-iso-doc-conc-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
  const findings = runDoctor(project, { concurrency: () => ({ maxBuilds: 0, maxDevices: 0 }) });
  assert.ok(!findings.some(f => /concurrency/i.test(f.title)), 'no concurrency finding when unset');
  rmSync(project, { recursive: true, force: true });
});

test('runDoctor emits one concurrency note when a limit is set', () => {
  const project = mkdtempSync(join(tmpdir(), 'rn-iso-doc-conc2-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
  const findings = runDoctor(project, {
    concurrency: () => ({ maxBuilds: 1, maxDevices: 2 }),
    liveDevices: () => 0,
    activeBuilds: () => 0,
  });
  const notes = findings.filter(f => /concurrency/i.test(f.title));
  assert.equal(notes.length, 1);
  rmSync(project, { recursive: true, force: true });
});
