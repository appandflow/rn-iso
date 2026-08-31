import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBuildCacheProvider,
  checkCompilationCache,
  checkCcacheConflict,
  checkDevClient,
  checkEasAuth,
  checkFingerprintParity,
  checkMetroCache,
  detectFingerprintParity,
  checkRemoteDevice,
  checkSimSlim,
  checkMainCheckout,
  runDoctor,
  detectXcodeMajor,
  parseXcodeMajor,
  checkConcurrency,
} from '../doctor.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import type { EasAuthResult } from '../engine/remote-cache.ts';
import assert from 'node:assert';

test('checkMainCheckout reports missing dependencies, Pods, and native output', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-source-cold-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    mkdirSync(join(project, 'ios'), { recursive: true });
    writeFileSync(join(project, 'ios', 'Podfile.lock'), 'pods\n');

    const findings = checkMainCheckout(project, { brokenPods: [], upstream: null });
    expect(findings.map((finding) => finding.title)).toEqual([
      'The main checkout has no installed dependencies',
      'The main checkout CocoaPods state is missing',
      'The main checkout has no iOS warm build output',
    ]);
    expect(findings[0]?.fix).toMatch(/npm ci/);
    expect(findings[1]?.fix).toMatch(/pod install/);
    expect(findings[2]?.fix).toMatch(/stim ios/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('checkMainCheckout recognizes non-npm dependency installs', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-main-pnpm-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const cold = checkMainCheckout(project, { brokenPods: [], upstream: null });
    expect(cold.find((finding) => /installed dependencies/.test(finding.title))?.fix).toMatch(/pnpm install/);

    mkdirSync(join(project, 'node_modules'));
    const warm = checkMainCheckout(project, { brokenPods: [], upstream: null });
    expect(warm.some((finding) => /installed dependencies/.test(finding.title))).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('checkMainCheckout reads warm state from the Git main checkout', () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-doctor-main-worktree-'));
  const repo = join(base, 'repo');
  const linked = join(base, 'linked');
  try {
    mkdirSync(join(repo, 'apps', 'mobile'), { recursive: true });
    writeFileSync(join(repo, 'apps', 'mobile', 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email test@example.com', { cwd: repo });
    execSync('git config user.name test', { cwd: repo });
    execSync('git add .', { cwd: repo });
    execSync('git -c commit.gpgsign=false commit -q -m init', { cwd: repo });
    execSync(`git worktree add -q -b linked ${JSON.stringify(linked)}`, { cwd: repo });
    mkdirSync(join(linked, 'apps', 'mobile', 'node_modules'));

    const findings = checkMainCheckout(join(linked, 'apps', 'mobile'), { brokenPods: [], upstream: null });
    expect(findings.some((finding) => /no installed dependencies/.test(finding.title))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('checkMainCheckout reports broken CocoaPods links even when lockfiles match', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-source-broken-pods-'));
  try {
    mkdirSync(join(project, 'ios', 'Pods'), { recursive: true });
    writeFileSync(join(project, 'ios', 'Podfile.lock'), 'pods\n');
    writeFileSync(join(project, 'ios', 'Pods', 'Manifest.lock'), 'pods\n');

    const findings = checkMainCheckout(project, {
      brokenPods: [join(project, 'ios', 'Pods', 'Headers', 'sqlite3.h')],
      upstream: null,
    });
    const broken = findings.find((finding) => /broken links/.test(finding.title));
    expect(broken?.level).toBe('cost');
    expect(broken?.fix).toMatch(/pod install --clean-install/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('checkMainCheckout reports stale dependencies and the locally known upstream gap', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-source-stale-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    mkdirSync(join(project, 'node_modules'), { recursive: true });

    const findings = checkMainCheckout(project, {
      npmTreeValid: false,
      upstream: { name: 'origin/main', ahead: 0, behind: 2 },
    });
    expect(findings.some((finding) => /dependency tree is stale/.test(finding.title))).toBe(true);
    expect(findings.some((finding) => /2 commits behind origin\/main/.test(finding.title))).toBe(true);
    expect(findings.find((finding) => /behind/.test(finding.title))?.detail).toMatch(/locally known/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

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

test('a non-Expo project is not told anything about a provider it cannot have', () => {
  expect(checkBuildCacheProvider(null, null, false)).toBe(null);
  expect(checkBuildCacheProvider({ expo: {} }, 57, false)).toBe(null);
  expect(checkBuildCacheProvider(null, 57, false, 'app.config.ts')).toBe(null);
});

test('compilation cache is not flagged at all on an Xcode that does not have it', () => {
  expect(checkCompilationCache("config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'", 15)).toBe(null);
});

test('a Podfile that enables no compilation caching is reported as nothing at all', () => {
  for (const xcode of [26, 27, null]) {
    expect(checkCompilationCache('post_install do |installer|\nend\n', xcode)).toBe(null);
  }
  expect(checkCompilationCache(null, 26)).toBe(null);
});

test('compilation cache enabled without a CAS path is a note about builds outside Stim', () => {
  const f = checkCompilationCache("config.build_settings['COMPILATION_CACHE_ENABLE_CACHING'] = 'YES'", 26);
  assert(f);
  expect(f.level).toBe('note');
  expect(f.detail).toMatch(/per-workspace/);
  expect(f.detail).toMatch(/outside Stim/);
  expect(f.fix).toMatch(/Nothing to do for Stim/);
  expect(f.fix).toMatch(/~\/\.stim\/compilation-cache/);
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

test('ccache alone is now flagged, because it is what stops Stim supplying the other', () => {
  const f = checkCcacheConflict('post_install', { 'apple.ccacheEnabled': 'true' });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.title).toMatch(/Stim leaves Xcode compilation caching off/);
});

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
  expect(checkCcacheConflict(null, { 'apple.ccacheEnabled': 'true' })).toBe(null);
});

test('a bare React Native project is not told to install expo-dev-client', () => {
  expect(checkDevClient({ dependencies: { 'react-native': '0.86.2' } })).toBe(null);
});

test('an Expo project without the dev client is flagged, because a reserved port cannot reach it', () => {
  const f = checkDevClient({ dependencies: { expo: '~57.0.0' } });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.detail).toMatch(/8081/);
});

test('a project that configures no cacheStores is reported as nothing at all', () => {
  expect(checkMetroCache('config.cacheStores = [new FileStore({})]')).toBe(null);
  expect(checkMetroCache('module.exports = config;')).toBe(null);
  expect(checkMetroCache(null)).toBe(null);
  expect(checkMetroCache("module.exports = require('@acme/app-scripts/metro-config')(__dirname);")).toBe(null);
});

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

test('parseXcodeMajor reads the major from real xcodebuild output', () => {
  expect(parseXcodeMajor('Xcode 26.1\nBuild version 17B55\n')).toBe(26);
  expect(parseXcodeMajor('Xcode 15\nBuild version 15A240d')).toBe(15);
});

test('parseXcodeMajor returns null for anything it does not recognise', () => {
  for (const output of [null, '', 'xcode-select: error: tool not installed', 'Xcode vNext']) {
    expect(parseXcodeMajor(output)).toBe(null);
  }
});

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

test('the dev client fix names the install, the rebuild, and why not to bake the port in', () => {
  const f = checkDevClient({ dependencies: { expo: '~57.0.0' } });
  assert(f);
  expect(f.fix).toMatch(/npx expo install expo-dev-client/);
  expect(f.fix).toMatch(/rebuild/i);
  expect(f.fix).toMatch(/NATIVE dependency/);
  expect(f.fix).toMatch(/RCT_METRO_PORT/);
});

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

test('an unconditional cacheStores stays silent', () => {
  expect(checkMetroCache("config.cacheStores = [new FileStore({ root: '/x' })];")).toBe(null);
  expect(
    checkMetroCache(
      "const { sharedCacheStores } = require('@stim-cli/metro');\nconfig.cacheStores = sharedCacheStores('app');",
    ),
  ).toBe(null);
});

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

test('an ordinary config built on expo/metro-config with no cacheStores is silent too', () => {
  expect(checkMetroCache("module.exports = require('expo/metro-config').getDefaultConfig(__dirname);")).toBe(null);
  expect(
    checkMetroCache(
      "const base = require('@acme/metro');\nbase.cacheStores = [new FileStore({ root: '/x' })];\nmodule.exports = base;",
    ),
  ).toBe(null);
});

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

  const easProject = mkdtempSync(join(tmpdir(), 'stim-doctor-'));
  writeFileSync(join(easProject, 'package.json'), JSON.stringify({ dependencies: { expo: '~57.0.0' } }));
  writeFileSync(
    join(easProject, 'app.json'),
    JSON.stringify({ expo: { owner: 'th3rd-wave', buildCacheProvider: 'eas' } }),
  );
  runDoctor(easProject, { easAuth: auth });
  expect(probes.length).toBe(1);
  expect(probes[0]?.projectRoot).toBe(easProject);
  expect(probes[0]?.owner).toBe('th3rd-wave');

  const otherProject = mkdtempSync(join(tmpdir(), 'stim-doctor-'));
  writeFileSync(join(otherProject, 'package.json'), JSON.stringify({ dependencies: { expo: '~57.0.0' } }));
  writeFileSync(
    join(otherProject, 'app.json'),
    JSON.stringify({ expo: { buildCacheProvider: { plugin: '@stim-cli/expo-build-cache' } } }),
  );
  runDoctor(otherProject, { easAuth: auth });
  expect(probes.length).toBe(1);

  rmSync(easProject, { recursive: true, force: true });
  rmSync(otherProject, { recursive: true, force: true });
});

test('the EAS finding reaches the report runDoctor returns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-doctor-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { expo: '~57.0.0' } }));
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: { buildCacheProvider: 'eas' } }));
  const findings = runDoctor(dir, {
    easAuth: () => ({ failed: true, code: 'logged-out', remedy: 'Run `eas login` (or set EXPO_TOKEN).' }),
  });
  expect(findings.some((f) => /EAS/.test(f.title) && f.level === 'cost')).toBeTruthy();
  rmSync(dir, { recursive: true, force: true });
});

test('checkConcurrency is silent when no limit is set', () => {
  expect(checkConcurrency({ maxBuilds: 0, maxDevices: 0 })).toBe(null);
});

test('checkConcurrency echoes the caps and the current live count when set', () => {
  const f = checkConcurrency({ maxBuilds: 2, maxDevices: 3, liveDevices: 1, activeBuilds: 0 });
  assert(f);
  expect(f.level).toBe('note');
  expect(f.detail).toMatch(/maxBuilds 2/);
  expect(f.detail).toMatch(/maxDevices 3/);
  expect(f.detail).toMatch(/1 /);
});

test('runDoctor stays silent about concurrency when nothing is set', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doc-conc-'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
  const findings = runDoctor(project, { concurrency: () => ({ maxBuilds: 0, maxDevices: 0 }) });
  expect(!findings.some((f) => /concurrency/i.test(f.title))).toBeTruthy();
  rmSync(project, { recursive: true, force: true });
});

test('runDoctor emits one concurrency note when a limit is set', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doc-conc2-'));
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

test('checkSimSlim reports only configured profiles that cannot run', () => {
  expect(checkSimSlim()).toBeNull();
  expect(checkSimSlim({ configured: true, onPath: true })).toBeNull();
  const missing = checkSimSlim({ configured: true, onPath: false });
  assert(missing);
  expect(missing.level).toBe('cost');
  expect(missing.fix).toMatch(/brew install/);

  const invalid = checkSimSlim({ profileError: 'missing profile.json' });
  assert(invalid);
  expect(invalid.title).toMatch(/invalid/i);
  expect(invalid.detail).toMatch(/missing profile/);
});

test('runDoctor reports a configured SimSlim profile when the binary is missing', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-simslim-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
    writeFileSync(join(project, 'simslim.json'), '{}\n');
    writeFileSync(join(project, '.stim.json'), JSON.stringify({ ios: { simslimProfile: 'simslim.json' } }));
    const findings = runDoctor(project, {
      concurrency: { maxBuilds: 0, maxDevices: 0 },
      lookupSimSlim: () => false,
    });
    expect(findings.some((finding) => /SimSlim/.test(finding.title) && finding.level === 'cost')).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a project with no provider configured at all is reported as nothing', () => {
  expect(checkBuildCacheProvider({ expo: {} }, 57)).toBe(null);
  expect(checkBuildCacheProvider({ expo: {} }, 53)).toBe(null);
  expect(checkBuildCacheProvider({ expo: { name: 'app' } }, null)).toBe(null);
});

test('a gradle.properties without org.gradle.caching is not a finding any more', () => {
  const withAndroid = mkdtempSync(join(tmpdir(), 'stim-doc-gradle-'));
  writeFileSync(join(withAndroid, 'package.json'), JSON.stringify({ name: 'x' }));
  mkdirSync(join(withAndroid, 'android'), { recursive: true });
  for (const source of ['org.gradle.jvmargs=-Xmx2g\n', '# org.gradle.caching=true\n', 'org.gradle.caching=false\n']) {
    writeFileSync(join(withAndroid, 'android', 'gradle.properties'), source);
    expect(runDoctor(withAndroid).some((f) => /Gradle/i.test(f.title))).toBe(false);
  }
  rmSync(withAndroid, { recursive: true, force: true });
});

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
  expect(f.detail).toMatch(/app\.json, ios\/Podfile\.lock, android\/build\.gradle/);
  expect(f.detail).toMatch(/and 1 more/);
  expect(f.detail).toMatch(/git reports app\.json/);
  expect(f.detail).toMatch(/MISS/);
  expect(f.detail).toMatch(/fingerprint twice/);
  expect(f.detail).toMatch(/\.git\/worktrees/);
  expect(f.detail).toMatch(/cleaned up/);
});

test('the parity fix carries the .fingerprintignore advice, including what not to ignore', () => {
  const f = checkFingerprintParity({ projectHash: 'aaa', worktreeHash: 'bbb' });
  assert(f);
  expect(f.fix).toMatch(/\.fingerprintignore/);
  expect(f.fix).toMatch(/gitignore/);
  expect(f.fix).toMatch(/absolute machine paths|generated|env file/);
  expect(f.fix).toMatch(/Never ignore a real native input/);
});

test('a parity mismatch with no dirty files still fires, hedged instead of accusing', () => {
  const f = checkFingerprintParity({ projectHash: 'aaa', worktreeHash: 'bbb', changed: ['ios/Podfile.lock'] });
  assert(f);
  expect(f.detail).toMatch(/likely cause/);
  expect(f.detail).not.toMatch(/git reports/);
});

test('detectFingerprintParity against a real repo: a dirty app.json fires the note and the temp worktree is cleaned up', async () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-parity-repo-'));
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

    const createFingerprint = async (dir: string) => {
      const hash = createHash('sha1')
        .update(readFileSync(join(dir, 'app.json'), 'utf-8'))
        .digest('hex');
      return { hash, sources: [{ type: 'file' as const, filePath: 'app.json', reasons: [], hash }] };
    };

    const finding = await detectFingerprintParity(repo, { createFingerprint });
    assert(finding, 'expected the parity note to fire');
    expect(finding.level).toBe('note');
    expect(finding.title).toMatch(/fresh worktree/);
    expect(finding.detail).toMatch(/app\.json/);
    expect(finding.detail).toMatch(/git reports app\.json/);

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
  const base = mkdtempSync(join(tmpdir(), 'stim-parity-clean-'));
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

    const createFingerprint = async (dir: string) => {
      const hash = createHash('sha1')
        .update(readFileSync(join(dir, 'app.json'), 'utf-8'))
        .digest('hex');
      return { hash, sources: [{ type: 'file' as const, filePath: 'app.json', reasons: [], hash }] };
    };

    expect(await detectFingerprintParity(repo, { createFingerprint })).toBe(null);
    expect(execSync('git worktree list', { cwd: repo, encoding: 'utf-8' }).trim().split('\n').length).toBe(1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('detectFingerprintParity skips silently outside a git repo without invoking the fingerprinter', async () => {
  resetExecutor();
  const dir = mkdtempSync(join(tmpdir(), 'stim-parity-nogit-'));
  try {
    let called = false;
    const createFingerprint = async () => {
      called = true;
      return { hash: 'x', sources: [] };
    };
    expect(await detectFingerprintParity(dir, { createFingerprint })).toBe(null);
    expect(called).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectFingerprintParity skips a cold comparison when dependencies are installed', async () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-parity-installed-'));
  try {
    execSync('git init -q', { cwd: base });
    mkdirSync(join(base, 'node_modules'));
    let called = false;
    const createFingerprint = async () => {
      called = true;
      return { hash: 'x', sources: [] };
    };
    expect(await detectFingerprintParity(base, { createFingerprint })).toBe(null);
    expect(called).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a project with no remote device gets no remote finding', () => {
  expect(checkRemoteDevice({})).toBeNull();
  expect(checkRemoteDevice({ agentDeviceOnPath: true, easCliResolvable: true })).toBeNull();
  expect(checkRemoteDevice({ daemonInEnv: true, agentDeviceOnPath: true })).toBeNull();
});

test('a configured remote with no agent-device is a cost, not a note', () => {
  const f = checkRemoteDevice({ configured: 'eas', agentDeviceOnPath: false });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.fix).toContain('agent-device');
  expect(f.detail).toContain('stim ios --remote eas');
  expect(f.detail).toContain('stim android --remote eas');
  expect(f.detail).not.toContain('`stim ios --remote`');
});

test('the proxy backend reports that the operator owns the daemon', () => {
  const f = checkRemoteDevice({ configured: 'proxy', daemonInEnv: true, agentDeviceOnPath: true });
  assert(f);
  expect(f.level).toBe('note');
  expect(f.detail).toContain('does not create or stop the remote device');
});

test('the proxy backend requires both daemon variables', () => {
  const f = checkRemoteDevice({ configured: 'proxy', daemonInEnv: false, agentDeviceOnPath: true });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.fix).toContain('AGENT_DEVICE_DAEMON_BASE_URL');
});

test('the eas backend requires eas-cli even when daemon variables exist', () => {
  const f = checkRemoteDevice({
    configured: 'eas',
    daemonInEnv: true,
    agentDeviceOnPath: true,
    easCliResolvable: false,
  });
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.fix).toContain('eas-cli');
});

test('a fully configured remote says what it will do, including the log gap', () => {
  const f = checkRemoteDevice({ configured: 'eas', agentDeviceOnPath: true, easCliResolvable: true });
  assert(f);
  expect(f.level).toBe('note');
  expect(f.detail).toContain('Native device logs are not captured');
});

test.each([
  ['proxy', 'eas'],
  ['eas', 'proxy'],
] as const)('runDoctor checks mixed %s and %s platform backends', (iosBackend, androidBackend) => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doc-remote-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
    writeFileSync(
      join(project, '.stim.json'),
      JSON.stringify({ ios: { remote: iosBackend }, android: { remote: androidBackend } }),
    );
    const findings = runDoctor(project, {
      concurrency: () => ({ maxBuilds: 0, maxDevices: 0 }),
      remoteEnv: {
        AGENT_DEVICE_DAEMON_BASE_URL: 'https://proxy.example/agent-device',
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'tok_proxy',
      },
      lookupAgentDevice: () => true,
      lookupEasCli: () => false,
    });

    expect(findings.filter((finding) => finding.title === 'This project uses a remote proxy')).toHaveLength(1);
    expect(findings.filter((finding) => finding.title.includes('no eas-cli'))).toHaveLength(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('runDoctor checks one shared backend once', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doc-remote-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
    writeFileSync(
      join(project, '.stim.json'),
      JSON.stringify({ ios: { remote: 'proxy' }, android: { remote: 'proxy' } }),
    );
    const findings = runDoctor(project, {
      concurrency: () => ({ maxBuilds: 0, maxDevices: 0 }),
      remoteEnv: {
        AGENT_DEVICE_DAEMON_BASE_URL: 'https://proxy.example/agent-device',
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'tok_proxy',
      },
      lookupAgentDevice: () => true,
      lookupEasCli: () => false,
    });

    expect(findings.filter((finding) => finding.title === 'This project uses a remote proxy')).toHaveLength(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('runDoctor resolves a SimSlim profile from the repository root in a monorepo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'stim-doc-monorepo-'));
  const project = join(repo, 'apps', 'mobile');
  try {
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'mobile' }));
    writeFileSync(join(repo, 'simslim.json'), '{}\n');
    writeFileSync(join(repo, '.stim.json'), JSON.stringify({ ios: { simslimProfile: 'simslim.json' } }));
    execSync('git init -q', { cwd: repo });

    const findings = runDoctor(project, {
      concurrency: () => ({ maxBuilds: 0, maxDevices: 0 }),
      lookupSimSlim: () => false,
    });

    expect(findings.some((finding) => finding.title.includes('SimSlim is not installed'))).toBe(true);
    expect(findings.some((finding) => finding.title === 'The SimSlim profile is invalid')).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test.each([
  ['AGENT_DEVICE_DAEMON_BASE_URL', '   ', 'proxy-token-fixture'],
  ['AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'https://proxy.example/agent-device', '\t\n'],
] as const)('runDoctor rejects a whitespace-only %s', (_missingVariable, baseUrl, token) => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doc-remote-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
    writeFileSync(join(project, '.stim.json'), JSON.stringify({ ios: { remote: 'proxy' } }));
    const findings = runDoctor(project, {
      concurrency: () => ({ maxBuilds: 0, maxDevices: 0 }),
      remoteEnv: {
        AGENT_DEVICE_DAEMON_BASE_URL: baseUrl,
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: token,
      },
      lookupAgentDevice: () => true,
    });

    expect(findings.some((finding) => finding.title === 'The remote proxy credentials are missing')).toBe(true);
    expect(findings.some((finding) => finding.title === 'This project uses a remote proxy')).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
