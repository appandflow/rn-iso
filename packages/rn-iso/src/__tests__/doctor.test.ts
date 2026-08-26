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

// A bare React Native project has no provider hook at all, so advice about
// where to put the key would be nonsense.
test('a non-Expo project is told there is no hook, not told to configure one', () => {
  const f = checkBuildCacheProvider(null, null, false);
  assert(f);
  expect(f.level).toBe('note');
  expect(f.title).toMatch(/outside Expo/);
  expect(f.detail).toMatch(/fingerprint/);
});

// The compilation cache is an Xcode 26 feature. On older Xcode there is nothing
// useful to say, and "enable it" would be wrong.
test('compilation cache is not flagged at all on an Xcode that does not have it', () => {
  expect(checkCompilationCache('post_install do |installer|\nend\n', 15)).toBe(null);
});

test('compilation cache enabled without a CAS path is a cost, because the default is per-workspace', () => {
  const f = checkCompilationCache("config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'", 26);
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.detail).toMatch(/per-workspace/);
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

test('ccache alone is not flagged -- it is a legitimate choice without the other', () => {
  expect(checkCcacheConflict('post_install', { 'apple.ccacheEnabled': 'true' })).toBe(null);
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

test('metro config with a cacheStore is reported as nothing; without one it is a cost', () => {
  expect(checkMetroCache('config.cacheStores = [new FileStore({})]')).toBe(null);
  const cost = checkMetroCache('module.exports = config;');
  assert(cost);
  expect(cost.level).toBe('cost');
  const note = checkMetroCache(null);
  assert(note);
  expect(note.level).toBe('note');
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

// Nothing ever passed an Xcode version, so every user was told what "Xcode 26+"
// offers, including the ones on Xcode 15 for whom that check should not fire and
// the ones whose actual version this line was quietly guessing at.
test('the compilation cache advice names the Xcode it was told about', () => {
  const podfile = 'post_install do |installer|\nend\n';
  const f = checkCompilationCache(podfile, 27);
  assert(f);
  expect(f.detail).toMatch(/On Xcode 27 /);
});

test('an unreadable Xcode version is hedged rather than guessed at', () => {
  const podfile = 'post_install do |installer|\nend\n';
  const f = checkCompilationCache(podfile, null);
  assert(f);
  expect(f.level).toBe('note');
  expect(f.detail).toMatch(/could not be read/);
  expect(f.detail).not.toMatch(/^On Xcode 26 a /);
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
  expect(metroConfigDelegate(source)).toBe('@th3rdwave/react-native-app-scripts/metro-config');
  const f = checkMetroCache(source);
  assert(f);
  expect(f.level).toBe('note');
  expect(f.title).toMatch(/delegates to @th3rdwave\/react-native-app-scripts\/metro-config; rn-iso cannot inspect it/);
  expect(f.title).not.toMatch(/per-project/);
});

test('the ESM and plain forms of the same delegation are recognized too', () => {
  expect(metroConfigDelegate("module.exports = require('@acme/metro');")).toBe('@acme/metro');
  expect(metroConfigDelegate("export { default } from '@acme/metro';")).toBe('@acme/metro');
  expect(metroConfigDelegate("export default require('./tools/metro-config');")).toBe('./tools/metro-config');
});

test('an ordinary config that BUILDS on a metro package is not a delegation', () => {
  // The distinction that matters: requiring expo/metro-config and then
  // configuring it is a config doctor can read, and it must still get the
  // real finding.
  expect(metroConfigDelegate("module.exports = require('expo/metro-config').getDefaultConfig(__dirname);")).toBe(null);
  expect(
    metroConfigDelegate(
      "const { getDefaultConfig } = require('@react-native/metro-config');\nconst config = getDefaultConfig(__dirname);\nmodule.exports = config;",
    ),
  ).toBe(null);
  const f = checkMetroCache("module.exports = require('expo/metro-config').getDefaultConfig(__dirname);");
  assert(f);
  expect(f.level).toBe('cost');
});

test('a delegating config that DOES mention cacheStores is read normally', () => {
  // Delegation is only interesting because the file says nothing about the
  // cache. One that does is inspectable after all.
  const source =
    "const base = require('@acme/metro');\nbase.cacheStores = [new FileStore({ root: '/x' })];\nmodule.exports = base;";
  expect(metroConfigDelegate(source)).toBe(null);
  expect(checkMetroCache(source)).toBe(null);
});

// The two settings only do anything inside a loop that defines `config`. A real
// Podfile's post_install had no such loop (only one over resource bundles), so
// the advice as written produced a Podfile that compiled and cached nothing.
test('the compilation cache advice names the loop the settings have to live in', () => {
  const f = checkCompilationCache('post_install do |installer|\nend\n', 26);
  assert(f);
  expect(f.fix).toMatch(/post_install/);
  expect(f.fix).toMatch(/targets\.each/);
  expect(f.fix).toMatch(/build_configurations/);
  expect(f.fix).toMatch(/adding one if/i);
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
