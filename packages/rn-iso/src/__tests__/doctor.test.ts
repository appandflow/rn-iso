import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkArtifactLayout,
  checkBuildCacheProvider,
  checkCompilationCache,
  checkCcacheConflict,
  checkDevClient,
  checkEasAuth,
  checkFingerprintParity,
  checkMetroCache,
  detectFingerprintParity,
  runDoctor,
  detectXcodeMajor,
  parseXcodeMajor,
  checkConcurrency,
} from '../doctor.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import type { EasAuthResult } from '../engine/remote-cache.ts';
import assert from 'node:assert';

// Where the key lives moved when the setting was promoted out of experiments,
// and the combination that silently does nothing is the NEW key on an OLD SDK.
// Verified against both CLIs: SDK 53 resolves exp.experiments.buildCacheProvider
// and nothing else; SDK 57 resolves exp.buildCacheProvider ?? the experiments one.
test('buildCacheProvider at the top level on SDK 53 is reported as a silent no-op', () => {
  const f = checkBuildCacheProvider({ expo: { buildCacheProvider: './p.js' } }, 53);
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.detail).toMatch(/ignored in silence/);
});

test('buildCacheProvider under experiments on SDK 53 is correct, and reported as nothing', () => {
  expect(checkBuildCacheProvider({ expo: { experiments: { buildCacheProvider: './p.js' } } }, 53)).toBe(null);
});

test('buildCacheProvider under experiments on a newer SDK still works, so it is a note not a cost', () => {
  const f = checkBuildCacheProvider({ expo: { experiments: { buildCacheProvider: './p.js' } } }, 57);
  assert(f);
  expect(f.level).toBe('note');
  expect(f.detail).toMatch(/falls back/);
});

test('buildCacheProvider at the top level on a newer SDK is what it should be', () => {
  expect(checkBuildCacheProvider({ expo: { buildCacheProvider: './p.js' } }, 57)).toBe(null);
});

// A bare React Native project has no provider hook at all, so there is nothing
// to misconfigure and nothing to act on -- and a note with no fix meant a bare
// project could never get a clean doctor run over something rn-iso handles
// entirely by itself. Same rule as a MISSING provider on Expo: silence.
test('a non-Expo project is not told anything about a provider it cannot have', () => {
  expect(checkBuildCacheProvider(null, null, false)).toBe(null);
  expect(checkBuildCacheProvider({ expo: {} }, 57, false)).toBe(null);
  expect(checkBuildCacheProvider(null, 57, false, 'app.config.ts')).toBe(null);
});

// The compilation cache is an Xcode 26 feature. On older Xcode the project's own
// setting does nothing either way, so there is nothing to report.
test('compilation cache is not flagged at all on an Xcode that does not have it', () => {
  expect(checkCompilationCache("config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'", 15)).toBe(null);
});

// THE RULE (issue #67 follow-up): rn-iso passes the compilation-cache settings
// on its own xcodebuild argv, so a Podfile that enables NOTHING is not a
// finding -- the absence of a project-side cache setting is nothing doctor has
// to report any more.
test('a Podfile that enables no compilation caching is reported as nothing at all', () => {
  for (const xcode of [26, 27, null]) {
    expect(checkCompilationCache('post_install do |installer|\nend\n', xcode)).toBe(null);
  }
  expect(checkCompilationCache(null, 26)).toBe(null);
});

// It is a NOTE and not a cost now: rn-iso overrides COMPILATION_CACHE_CAS_PATH
// on its own xcodebuild command line, so a Podfile left at the default costs
// only the builds that are not rn-iso's.
test('compilation cache enabled without a CAS path is a note about builds outside rn-iso', () => {
  const f = checkCompilationCache("config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'", 26);
  assert(f);
  expect(f.level).toBe('note');
  expect(f.detail).toMatch(/per-workspace/);
  expect(f.detail).toMatch(/outside rn-iso/);
  expect(f.fix).toMatch(/Nothing to do for rn-iso/);
  // Point the project's own builds at the SAME cache rn-iso fills, or the
  // machine ends up with two.
  expect(f.fix).toMatch(/~\/\.rn-iso\/compilation-cache/);
});

test('compilation cache with an explicit CAS path is reported as nothing', () => {
  const src = "COMPILATION_CACHE_ENABLE_CACHING = 'YES'\nCOMPILATION_CACHE_CAS_PATH = '/x'";
  expect(checkCompilationCache(src, 26)).toBe(null);
});

test('ccache alongside compilation caching is flagged as mutually defeating', () => {
  const f = checkCcacheConflict("COMPILATION_CACHE_ENABLE_CACHING = 'YES'", { 'apple.ccacheEnabled': 'true' });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.detail).toMatch(/explicitly built modules/);
});

// It USED to take both halves, because the project was the only thing that
// could turn compilation caching on. rn-iso turns it on itself now, on every
// `rn-iso ios` -- except when ccache is configured, which is the one condition
// that makes it skip. So ccache alone is exactly the silent "neither cache" the
// finding exists to name.
test('ccache alone is now flagged, because it is what stops rn-iso supplying the other', () => {
  const f = checkCcacheConflict('post_install', { 'apple.ccacheEnabled': 'true' });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.title).toMatch(/rn-iso leaves Xcode compilation caching off/);
});

// doctor is the only place this is said, so the fix has to name where the value
// is WRITTEN: on Expo it comes from the expo-build-properties plugin and
// prebuild rewrites Podfile.properties.json from it, so editing the generated
// file alone is undone by the next prebuild.
test('the ccache fix names where the value comes from, on Expo and on a bare project', () => {
  const f = checkCcacheConflict('post_install', { 'apple.ccacheEnabled': 'true' });
  assert(f);
  expect(f.fix).toMatch(/expo-build-properties/);
  expect(f.fix).toMatch(/Podfile\.properties\.json/);
  expect(f.fix).toMatch(/pod install/);
});

test('a project with no ccache is reported as nothing, with or without caching in the Podfile', () => {
  expect(checkCcacheConflict("COMPILATION_CACHE_ENABLE_CACHING = 'YES'", { 'apple.ccacheEnabled': 'false' })).toBe(
    null,
  );
  expect(checkCcacheConflict('post_install', null)).toBe(null);
  // No Podfile at all means no iOS project to say anything about.
  expect(checkCcacheConflict(null, { 'apple.ccacheEnabled': 'true' })).toBe(null);
});

// The dev client advice is Expo-specific: a bare RN app has no dev client to
// install and reaches a non-default port another way.
test('a bare React Native project is not told to install expo-dev-client', () => {
  expect(checkDevClient({ dependencies: { 'react-native': '0.86.2' } })).toBe(null);
});

test('an Expo project without the dev client is flagged, because a reserved port cannot reach it', () => {
  const f = checkDevClient({ dependencies: { expo: '~57.0.0' } });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.detail).toMatch(/8081/);
});

// THE RULE (issue #67 follow-up): `rn-iso start` appends its own FileStore to
// the config it hosts (bare) or injects one into the Expo child, so a project
// with no cacheStores is not paying anything under rn-iso. Its ABSENCE is
// therefore not a finding -- no metro.config.js, a config that never names
// cacheStores, and a config that delegates to another package are all silent.
test('a project that configures no cacheStores is reported as nothing at all', () => {
  expect(checkMetroCache('config.cacheStores = [new FileStore({})]')).toBe(null);
  expect(checkMetroCache('module.exports = config;')).toBe(null);
  expect(checkMetroCache(null)).toBe(null);
  expect(checkMetroCache("module.exports = require('@acme/app-scripts/metro-config')(__dirname);")).toBe(null);
});

// A config that is code cannot be read without executing it, and executing
// project code inside a diagnostic is not acceptable. Saying nothing would be
// worse than saying so: silence reads as a pass, and this is the check whose
// failure mode is silence in the first place.
test('a project whose config is app.config.ts is told the check could not run', () => {
  const f = checkBuildCacheProvider(null, 53, true, 'app.config.ts');
  assert(f);
  expect(f.level).toBe('note');
  expect(f.title).toMatch(/Cannot check/);
  expect(f.fix).toMatch(/experiments/);
});

test('a newer SDK with a dynamic config is pointed at the top-level key', () => {
  const f = checkBuildCacheProvider(null, 57, true, 'app.config.js');
  assert(f);
  expect(f.fix).toMatch(/top-level/);
});

test('no config at all and no dynamic config stays silent', () => {
  expect(checkBuildCacheProvider(null, 57, true, null)).toBe(null);
});

// The version comes from `xcodebuild -version`, whose first line is "Xcode 26.1".
test('parseXcodeMajor reads the major from real xcodebuild output', () => {
  expect(parseXcodeMajor('Xcode 26.1\nBuild version 17B55\n')).toBe(26);
  expect(parseXcodeMajor('Xcode 15\nBuild version 15A240d')).toBe(15);
});

// No Xcode, command line tools only, or a format this does not know: all of them
// mean "unknown", never a number.
test('parseXcodeMajor returns null for anything it does not recognise', () => {
  for (const output of [null, '', 'xcode-select: error: tool not installed', 'Xcode vNext']) {
    expect(parseXcodeMajor(output)).toBe(null);
  }
});

// A mocked executor proves the parsing; running the real command proves the
// output has the shape the parser expects on this machine.
test('detectXcodeMajor agrees with the real xcodebuild, when there is one', () => {
  resetExecutor();
  const major = detectXcodeMajor();
  expect(major === null || (Number.isInteger(major) && major > 0)).toBeTruthy();
});

test('detectXcodeMajor reports unknown rather than throwing when xcodebuild is missing', () => {
  setExecutor({
    run: () => {
      throw new Error('not found');
    },
    runQuiet: () => null,
    spawn: () => {},
  });
  try {
    expect(detectXcodeMajor()).toBe(null);
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
  expect(checkDevClient(pkg, false)).toBe(null);
});

test('the dev client finding still fires for a project that builds with expo run:ios', () => {
  const pkg = { dependencies: { expo: '~57.0.0' } };
  const f = checkDevClient(pkg, true);
  assert(f);
  expect(f.level).toBe('cost');
});

// This is the one finding whose remedy is a NATIVE dependency, so the fix has
// to say both halves: install it AND rebuild, because an app already on the
// device will not pick it up. It also has to refuse the wrong shortcut --
// compiling the port in breaks the build cache, which does not key on the port.
test('the dev client fix names the install, the rebuild, and why not to bake the port in', () => {
  const f = checkDevClient({ dependencies: { expo: '~57.0.0' } });
  assert(f);
  expect(f.fix).toMatch(/npx expo install expo-dev-client/);
  expect(f.fix).toMatch(/rebuild/i);
  expect(f.fix).toMatch(/NATIVE dependency/);
  expect(f.fix).toMatch(/RCT_METRO_PORT/);
});

// `.rn-iso/` holds this workspace's build output, logs and supervisor pidfile,
// and the only thing that can still be wrong about it is the .gitignore entry:
// carrying it into a fresh worktree is prevented in code now, not by a second
// file that has to say so (isWorkspaceArtifact in src/worktree.js).
test('silent when .rn-iso is gitignored', () => {
  expect(checkArtifactLayout({ gitignoreSource: '.rn-iso/\n' })).toBe(null);
  // git's monorepo-aware verdict wins over the app dir's own file (#31)
  expect(checkArtifactLayout({ gitignoreSource: 'node_modules\n', gitIgnored: true })).toBe(null);
  expect(checkArtifactLayout({ gitignoreSource: '.rn-iso/\n', gitIgnored: null })).toBe(null);
});

test('a project that does not ignore .rn-iso is told what ends up in git status', () => {
  const f = checkArtifactLayout({ gitignoreSource: 'node_modules\n' });
  assert(f);
  expect(f.title).toMatch(/not gitignored/);
  expect(f.detail).toMatch(/commit/i);
  expect(f.fix).toMatch(/add it themselves/i);
});

test('a missing .gitignore is the same diagnosis as one that does not mention it', () => {
  const missing = checkArtifactLayout({ gitignoreSource: null });
  assert(missing);
  expect(missing.title).toMatch(/not gitignored/);
  const noArg = checkArtifactLayout();
  const empty = checkArtifactLayout({ gitignoreSource: '' });
  assert(noArg);
  assert(empty);
  expect(noArg.title).toBe(empty.title);
});

// The entry is a path, not a substring: leading and trailing slashes and
// comments are all the forms a real .gitignore is written in.
test('the entry is recognised however it is written, and comments do not count', () => {
  expect(checkArtifactLayout({ gitignoreSource: '/.rn-iso\n' })).toBe(null);
  expect(checkArtifactLayout({ gitignoreSource: '.rn-iso\n' })).toBe(null);
  const commented = checkArtifactLayout({ gitignoreSource: '# ignore .rn-iso/ one day\nnode_modules\n' });
  assert(commented);
  expect(commented.title).toMatch(/not gitignored/);
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
  assert(f);
  expect(f.level).toBe('note');
  expect(f.title).toMatch(/cacheStores/);
  expect(f.fix).toMatch(/env var/i);
});

test('a cacheStores set inside an if is a note for the same reason', () => {
  const source = 'if (process.env.SHARED) {\n  config.cacheStores = [new FileStore({})];\n}\n';
  const f = checkMetroCache(source);
  assert(f);
  expect(f.level).toBe('note');
});

// The plain shape is the one this check exists to reward: unconditional wiring
// stays silent, exactly as before.
test('an unconditional cacheStores stays silent', () => {
  expect(checkMetroCache("config.cacheStores = [new FileStore({ root: '/x' })];")).toBe(null);
  expect(
    checkMetroCache(
      "const { sharedCacheStores } = require('@rn-iso/metro');\nconfig.cacheStores = sharedCacheStores('app');",
    ),
  ).toBe(null);
});

// A metro.config.js that is one line of delegation used to get its own "cannot
// inspect it" note. It does not any more: what such a file hides is a store
// rn-iso supplies either way, so there is nothing doctor can say that is
// actionable. Taken verbatim from a real yarn-workspaces repo, commented-out
// require and all.
test('a metro config that delegates to a workspace package is silent, not a note', () => {
  const source = [
    '// RN CLI checks for this to make sure the config is valid :/',
    "// const { getDefaultConfig } = require('@react-native/metro-config');",
    '',
    "module.exports = require('@th3rdwave/react-native-app-scripts/metro-config')(",
    '  __dirname,',
    ');',
  ].join('\n');
  expect(checkMetroCache(source)).toBe(null);
});

// A config that BUILDS on a metro package is an ordinary config, and one that
// simply sets no cacheStores is silent for the same reason as everything above.
test('an ordinary config built on expo/metro-config with no cacheStores is silent too', () => {
  expect(checkMetroCache("module.exports = require('expo/metro-config').getDefaultConfig(__dirname);")).toBe(null);
  expect(
    checkMetroCache(
      "const base = require('@acme/metro');\nbase.cacheStores = [new FileStore({ root: '/x' })];\nmodule.exports = base;",
    ),
  ).toBe(null);
});

// A dynamic config is the one case where doctor cannot answer its own question,
// so it has to hand over the command that can -- and say that an existing
// provider, "eas" included, already satisfies the check.
test('the dynamic-config note carries the command that answers it', () => {
  const f = checkBuildCacheProvider(null, 57, true, 'app.config.ts');
  assert(f);
  expect(f.fix).toMatch(/npx expo config --json/);
  expect(f.fix).toMatch(/buildCacheProvider/);
});

test('the dynamic-config note says an existing provider is kept, as the static one does', () => {
  for (const sdk of [53, 57]) {
    const f = checkBuildCacheProvider(null, sdk, true, 'app.config.ts');
    assert(f);
    expect(f.fix).toMatch(/"eas"/);
    expect(f.fix).toMatch(/never replaces it/);
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
  const f = checkEasAuth({
    provider: { plugin: './local.js' },
    auth: () => {
      asked = true;
    },
  } as unknown as Parameters<typeof checkEasAuth>[0]);
  expect(f).toBe(null);
  expect(asked).toBe(false);
});

test('the EAS provider with no eas-cli anywhere is a cost, with an install remedy', () => {
  const f = checkEasAuth({
    provider: 'eas',
    auth: { failed: true, code: 'no-cli', reason: 'no `eas` executable', remedy: 'Install eas-cli.' },
  });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.title).toMatch(/eas-cli/);
  expect(f.fix).toMatch(/Install eas-cli/);
});

test('the EAS provider with no session is a cost naming both ways back in', () => {
  const f = checkEasAuth({
    provider: 'eas',
    auth: { failed: true, code: 'logged-out', reason: 'Not logged in', remedy: 'Run `eas login` (or set EXPO_TOKEN).' },
  });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.detail).toMatch(/miss/i);
  expect(f.fix).toMatch(/eas login/);
  expect(f.fix).toMatch(/EXPO_TOKEN/);
});

// A note rather than a cost, and the detail has to say why: whoami does not
// always enumerate accounts (a robot actor prints a display name that is not an
// account name), and access is the server's decision, not this list's.
test('a session on an account that does not cover the owner is a NOTE naming both', () => {
  const f = checkEasAuth({
    provider: 'eas',
    owner: 'th3rd-wave',
    auth: {
      failed: true,
      code: 'wrong-account',
      account: 'janic',
      accounts: ['janic'],
      owner: 'th3rd-wave',
      remedy: 'Run `eas login` as a member of th3rd-wave.',
    },
  });
  assert(f);
  expect(f.level).toBe('note');
  expect(f.title).toMatch(/janic/);
  expect(f.title).toMatch(/th3rd-wave/);
  expect(f.detail).toMatch(/not a hard failure|may be incomplete|cannot be read/i);
});

// Offline is the case that must not produce a false alarm: whoami hits the
// network whenever a session exists, and a plane is not a logged-out user.
test('an unestablished session is a note about the check, not an accusation', () => {
  const f = checkEasAuth({ provider: 'eas', auth: { unknown: 'eas whoami timed out after 15000ms' } });
  assert(f);
  expect(f.level).toBe('note');
  expect(f.detail).toMatch(/timed out/);
  expect(!/not logged in/i.test(f.title)).toBeTruthy();
});

test('a good session is reported as nothing at all', () => {
  expect(
    checkEasAuth({ provider: 'eas', owner: 'janic', auth: { ok: true, account: 'janic', accounts: ['janic'] } }),
  ).toBe(null);
});

// The experiments key is where SDK 53 keeps it, and "eas" there is still EAS.
test('the provider is recognised on either key', () => {
  const auth: EasAuthResult = { failed: true, code: 'logged-out', remedy: 'Run `eas login`.' };
  expect(checkEasAuth({ provider: 'eas', auth })).toBeTruthy();
});

test('runDoctor probes the session only for an EAS project, and passes it the owner', () => {
  const probes: { projectRoot: string; owner?: string | null }[] = [];
  const auth = (args: { projectRoot: string; owner?: string | null }): EasAuthResult => {
    probes.push(args);
    return { ok: true, account: 'janic', accounts: ['janic'] };
  };

  const easProject = mkdtempSync(join(tmpdir(), 'rn-iso-doctor-'));
  writeFileSync(join(easProject, 'package.json'), JSON.stringify({ dependencies: { expo: '~57.0.0' } }));
  writeFileSync(
    join(easProject, 'app.json'),
    JSON.stringify({ expo: { owner: 'th3rd-wave', buildCacheProvider: 'eas' } }),
  );
  runDoctor(easProject, { easAuth: auth });
  expect(probes.length).toBe(1);
  expect(probes[0]?.projectRoot).toBe(easProject);
  expect(probes[0]?.owner).toBe('th3rd-wave');

  const otherProject = mkdtempSync(join(tmpdir(), 'rn-iso-doctor-'));
  writeFileSync(join(otherProject, 'package.json'), JSON.stringify({ dependencies: { expo: '~57.0.0' } }));
  writeFileSync(
    join(otherProject, 'app.json'),
    JSON.stringify({ expo: { buildCacheProvider: { plugin: '@rn-iso/expo-build-cache' } } }),
  );
  runDoctor(otherProject, { easAuth: auth });
  expect(probes.length).toBe(1);

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
  expect(findings.some((f) => /EAS/.test(f.title) && f.level === 'cost')).toBeTruthy();
  rmSync(dir, { recursive: true, force: true });
});

// --- concurrency note (only when limits are set) ---
test('checkConcurrency is silent when no limit is set', () => {
  expect(checkConcurrency({ maxBuilds: 0, maxDevices: 0 })).toBe(null);
});

test('checkConcurrency echoes the caps and the current live count when set', () => {
  const f = checkConcurrency({ maxBuilds: 2, maxDevices: 3, liveDevices: 1, activeBuilds: 0 });
  assert(f);
  expect(f.level).toBe('note');
  expect(f.detail).toMatch(/maxBuilds 2/);
  expect(f.detail).toMatch(/maxDevices 3/);
  expect(f.detail).toMatch(/1 /); // live device count echoed
});

test('runDoctor stays silent about concurrency when nothing is set', () => {
  const project = mkdtempSync(join(tmpdir(), 'rn-iso-doc-conc-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
  const findings = runDoctor(project, { concurrency: () => ({ maxBuilds: 0, maxDevices: 0 }) });
  expect(!findings.some((f) => /concurrency/i.test(f.title))).toBeTruthy();
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
  const notes = findings.filter((f) => /concurrency/i.test(f.title));
  expect(notes.length).toBe(1);
  rmSync(project, { recursive: true, force: true });
});

// --- a MISSING provider is deliberately silent -------------------------------
//
// rn-iso's own cache covers every build rn-iso drives, so a provider only adds
// value to builds run outside it -- optional, and not part of setup. What the
// check still reports is a provider CONFIGURED on a key this SDK never reads.
test('a project with no provider configured at all is reported as nothing', () => {
  expect(checkBuildCacheProvider({ expo: {} }, 57)).toBe(null);
  expect(checkBuildCacheProvider({ expo: {} }, 53)).toBe(null);
  expect(checkBuildCacheProvider({ expo: { name: 'app' } }, null)).toBe(null);
});

// --- Gradle's task-output cache ---------------------------------------------
//
// The check is GONE. `rn-iso android` passes --build-cache on its own gradlew
// argv, which wins over the properties file, so nothing android/gradle.properties
// can say about org.gradle.caching defeats rn-iso or is worth reporting: the
// only finding it ever produced was "the property is not set", which is exactly
// the absence this rule stopped reporting.
test('a gradle.properties without org.gradle.caching is not a finding any more', () => {
  const withAndroid = mkdtempSync(join(tmpdir(), 'rn-iso-doc-gradle-'));
  writeFileSync(join(withAndroid, 'package.json'), JSON.stringify({ name: 'x' }));
  mkdirSync(join(withAndroid, 'android'), { recursive: true });
  for (const source of ['org.gradle.jvmargs=-Xmx2g\n', '# org.gradle.caching=true\n', 'org.gradle.caching=false\n']) {
    writeFileSync(join(withAndroid, 'android', 'gradle.properties'), source);
    expect(runDoctor(withAndroid).some((f) => /Gradle/i.test(f.title))).toBe(false);
  }
  rmSync(withAndroid, { recursive: true, force: true });
});

// --- fingerprint parity ------------------------------------------------------
test('checkFingerprintParity is silent when the hashes agree or either side is unknown', () => {
  expect(checkFingerprintParity({ projectHash: 'a', worktreeHash: 'a' })).toBe(null);
  expect(checkFingerprintParity({ projectHash: null, worktreeHash: 'a' })).toBe(null);
  expect(checkFingerprintParity({ projectHash: 'a', worktreeHash: null })).toBe(null);
  expect(checkFingerprintParity()).toBe(null);
});

test('a parity mismatch names the differing sources, the dirty files, the consequence and the cost', () => {
  const f = checkFingerprintParity({
    projectHash: 'aaa',
    worktreeHash: 'bbb',
    changed: ['app.json', 'ios/Podfile.lock', 'android/build.gradle', 'package.json'],
    dirtyFiles: ['app.json'],
  });
  assert(f);
  expect(f.level).toBe('note');
  expect(f.title).toMatch(/fresh worktree/);
  // Up to three differing sources, then a count.
  expect(f.detail).toMatch(/app\.json, ios\/Podfile\.lock, android\/build\.gradle/);
  expect(f.detail).toMatch(/and 1 more/);
  // WHICH tracked inputs git reports dirty (the change-3 status helper).
  expect(f.detail).toMatch(/git reports app\.json/);
  // The consequence: worktrees miss what this checkout fills.
  expect(f.detail).toMatch(/MISS/);
  // The cost of the measurement is disclosed.
  expect(f.detail).toMatch(/fingerprint twice/);
  expect(f.detail).toMatch(/\.git\/worktrees/);
  expect(f.detail).toMatch(/cleaned up/);
});

// The .fingerprintignore advice lives HERE now -- there is no setup skill to
// carry it -- so the fix has to say what belongs in the file and what must
// never go in it.
test('the parity fix carries the .fingerprintignore advice, including what not to ignore', () => {
  const f = checkFingerprintParity({ projectHash: 'aaa', worktreeHash: 'bbb' });
  assert(f);
  expect(f.fix).toMatch(/\.fingerprintignore/);
  expect(f.fix).toMatch(/gitignore/);
  // What belongs in it: things that cannot change the native build.
  expect(f.fix).toMatch(/absolute machine paths|generated|env file/);
  // And the refusal: never ignore a real native input to force a hit.
  expect(f.fix).toMatch(/Never ignore a real native input/);
});

test('a parity mismatch with no dirty files still fires, hedged instead of accusing', () => {
  const f = checkFingerprintParity({ projectHash: 'aaa', worktreeHash: 'bbb', changed: ['ios/Podfile.lock'] });
  assert(f);
  expect(f.detail).toMatch(/likely cause/);
  expect(f.detail).not.toMatch(/git reports/);
});

// Real git throughout (CLAUDE.md item 9): worktree add/remove are exactly the
// commands a mocked executor cannot vouch for. The fingerprinter is injected --
// a scratch repo has no @expo/fingerprint -- as a content hash of app.json, so
// the dirty checkout and the clean HEAD worktree genuinely differ.
test('detectFingerprintParity against a real repo: a dirty app.json fires the note and the temp worktree is cleaned up', async () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-parity-repo-'));
  const repo = join(base, 'repo');
  try {
    mkdirSync(repo, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(join(repo, 'app.json'), JSON.stringify({ expo: { name: 'app' } }));
    git('git add package.json app.json');
    git('git commit -q -m init');
    writeFileSync(join(repo, 'app.json'), JSON.stringify({ expo: { name: 'app', scheme: 'dirty' } }));

    const load = () => ({
      createFingerprintAsync: async (dir: string) => {
        const hash = createHash('sha1')
          .update(readFileSync(join(dir, 'app.json'), 'utf-8'))
          .digest('hex');
        return { hash, sources: [{ type: 'file', filePath: 'app.json', hash }] };
      },
    });

    const finding = await detectFingerprintParity(repo, { load });
    assert(finding, 'expected the parity note to fire');
    expect(finding.level).toBe('note');
    expect(finding.title).toMatch(/fresh worktree/);
    expect(finding.detail).toMatch(/app\.json/);
    expect(finding.detail).toMatch(/git reports app\.json/);

    // The temp worktree is GONE on the success path: git lists only the main
    // working tree, and prune left no stale metadata behind.
    const worktrees = git('git worktree list').trim().split('\n');
    expect(worktrees.length).toBe(1);
    const stale = existsSync(join(repo, '.git', 'worktrees'))
      ? execSync(`ls ${JSON.stringify(join(repo, '.git', 'worktrees'))}`, { encoding: 'utf-8' }).trim()
      : '';
    expect(stale).toBe('');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('detectFingerprintParity against a real repo: a clean checkout is silent', async () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'rn-iso-parity-clean-'));
  const repo = join(base, 'repo');
  try {
    mkdirSync(repo, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    writeFileSync(join(repo, 'app.json'), JSON.stringify({ expo: { name: 'app' } }));
    git('git add app.json');
    git('git commit -q -m init');

    const load = () => ({
      createFingerprintAsync: async (dir: string) => {
        const hash = createHash('sha1')
          .update(readFileSync(join(dir, 'app.json'), 'utf-8'))
          .digest('hex');
        return { hash, sources: [{ type: 'file', filePath: 'app.json', hash }] };
      },
    });

    expect(await detectFingerprintParity(repo, { load })).toBe(null);
    expect(execSync('git worktree list', { cwd: repo, encoding: 'utf-8' }).trim().split('\n').length).toBe(1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('detectFingerprintParity skips silently outside a git repo and without a fingerprinter', async () => {
  resetExecutor();
  const dir = mkdtempSync(join(tmpdir(), 'rn-iso-parity-nogit-'));
  try {
    const load = () => ({
      createFingerprintAsync: async () => ({ hash: 'x', sources: [] }),
    });
    expect(await detectFingerprintParity(dir, { load })).toBe(null);
    expect(await detectFingerprintParity(dir, { load: () => null })).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
