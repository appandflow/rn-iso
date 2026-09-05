import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Command } from 'commander';
import {
  checkBuildCacheProvider,
  checkCompilationCache,
  checkCcacheConflict,
  checkCcacheInstalled,
  checkCxxCompilerLauncher,
  parseCmakeCacheLauncher,
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
import doctorCommand, { doctorSuccessLines, parseDoctorPlatform, shadowedStimFinding } from '../commands/doctor.ts';
import type { Finding } from '../doctor.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import type { EasAuthResult } from '../engine/remote-cache.ts';
import assert from 'node:assert';
import {
  analyzeStimVersions,
  compareStimVersions,
  inspectStimVersions,
  parseStimVersionOutput,
} from '../stim-installations.ts';

const testStimVersions = analyzeStimVersions('1.2.3', '/tools/stim-cli', []);

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

test('checkMainCheckout filters native warm state and CocoaPods by platform', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-platform-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app' }));
    mkdirSync(join(project, 'node_modules'));
    mkdirSync(join(project, 'ios'), { recursive: true });
    mkdirSync(join(project, 'android'), { recursive: true });
    writeFileSync(join(project, 'ios', 'Podfile.lock'), 'pods\n');

    const ios = checkMainCheckout(project, { platform: 'ios', brokenPods: [], upstream: null });
    expect(ios.map((finding) => finding.title)).toEqual([
      'The main checkout CocoaPods state is missing',
      'The main checkout has no iOS warm build output',
    ]);

    const android = checkMainCheckout(project, { platform: 'android', brokenPods: [], upstream: null });
    expect(android.map((finding) => finding.title)).toEqual(['The main checkout has no Android warm build output']);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('parseDoctorPlatform accepts the two native platforms and rejects other values', () => {
  expect(parseDoctorPlatform('ios')).toBe('ios');
  expect(parseDoctorPlatform('android')).toBe('android');
  expect(() => parseDoctorPlatform('web')).toThrow(/ios, android/);
});

test('Stim version comparison follows semver prerelease precedence', () => {
  expect(compareStimVersions('1.0.0-rc.14', '1.0.0-rc.15')).toBeLessThan(0);
  expect(compareStimVersions('1.0.0-rc.15', '1.0.0')).toBeLessThan(0);
  expect(compareStimVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  expect(compareStimVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
  expect(compareStimVersions('1.0.0-A', '1.0.0-a')).toBeLessThan(0);
  expect(compareStimVersions('1.0.0-01', '1.0.0-1')).toBe(null);
  expect(parseStimVersionOutput('v1.2.3\n')).toBe('1.2.3');
  expect(parseStimVersionOutput('stim 1.2.3')).toBe(null);
});

test('Stim installation inspection finds a shadowed older executable and deduplicates real paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-doctor-versions-'));
  const oldBin = join(root, 'old');
  const newBin = join(root, 'new');
  const aliasBin = join(root, 'alias');
  mkdirSync(oldBin);
  mkdirSync(newBin);
  mkdirSync(aliasBin);
  writeFileSync(join(oldBin, 'stim'), '#!/bin/sh\nprintf "1.0.0-rc.14\\n"\n');
  writeFileSync(join(newBin, 'stim'), '#!/bin/sh\nprintf "1.0.0-rc.15\\n"\n');
  chmodSync(join(oldBin, 'stim'), 0o755);
  chmodSync(join(newBin, 'stim'), 0o755);
  symlinkSync(join(newBin, 'stim'), join(aliasBin, 'stim'));
  try {
    const report = await inspectStimVersions('1.0.0-rc.15', {
      pathValue: [oldBin, newBin, aliasBin].join(delimiter),
      runningPath: join(newBin, 'stim'),
    });
    expect(report.resolved).toMatchObject({ path: join(oldBin, 'stim'), version: '1.0.0-rc.14' });
    expect(report.installations).toHaveLength(2);
    expect(report.versions).toEqual(['1.0.0-rc.15', '1.0.0-rc.14']);
    expect(report.highestVersion).toBe('1.0.0-rc.15');
    expect(report.resolvedIsOlder).toBe(true);
    expect(shadowedStimFinding(report)).toMatchObject({
      level: 'cost',
      title: 'The Stim resolved from PATH is older than another installation',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Stim installation probes share one timeout window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-doctor-version-timeout-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  mkdirSync(first);
  mkdirSync(second);
  for (const directory of [first, second]) {
    writeFileSync(join(directory, 'stim'), "#!/bin/sh\ntrap '' TERM\nsleep 1\n");
    chmodSync(join(directory, 'stim'), 0o755);
  }
  try {
    const startedAt = Date.now();
    const report = await inspectStimVersions('1.0.0-rc.15', {
      pathValue: [first, second].join(delimiter),
      probeTimeoutMs: 50,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(report.installations.map((entry) => entry.version)).toEqual([null, null]);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test('checkMainCheckout runs its expensive probes only when their preconditions hold', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-probe-gate-'));
  const calls: string[][] = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    runFileQuiet: () => null,
    runFile: (file: string, args: string[] = []) => {
      calls.push([file, ...args]);
      return '';
    },
    spawn: () => {},
  });
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    mkdirSync(join(project, 'node_modules'));
    mkdirSync(join(project, 'ios'), { recursive: true });
    writeFileSync(join(project, 'ios', 'Podfile.lock'), 'pods\n');

    checkMainCheckout(project, { upstream: null });
    expect(calls.some(([file]) => file === 'npm')).toBe(false);
    expect(calls.some(([file]) => file === 'find')).toBe(false);

    rmSync(join(project, 'pnpm-lock.yaml'));
    writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    mkdirSync(join(project, 'ios', 'Pods'), { recursive: true });
    writeFileSync(join(project, 'ios', 'Pods', 'Manifest.lock'), 'pods\n');
    calls.length = 0;

    checkMainCheckout(project, { upstream: null });
    expect(calls.filter(([file]) => file === 'npm').map((call) => call.slice(1, 4))).toEqual([
      ['ls', '--all', '--json'],
    ]);
    expect(calls.some(([file, ...args]) => file === 'find' && args.includes(join(project, 'ios', 'Pods')))).toBe(true);
  } finally {
    resetExecutor();
    rmSync(project, { recursive: true, force: true });
  }
});

test('the CocoaPods remedy uses bundler only when the lockfile resolves cocoapods (#137)', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-source-gemfile-'));
  try {
    mkdirSync(join(project, 'ios'), { recursive: true });
    writeFileSync(join(project, 'ios', 'Podfile.lock'), 'pods\n');
    writeFileSync(join(project, 'Gemfile'), "gem 'fastlane'\n");
    writeFileSync(join(project, 'Gemfile.lock'), 'GEM\n  specs:\n    fastlane (2.219.0)\n');

    const fastlane = checkMainCheckout(project, { brokenPods: [], upstream: null }).find((f) =>
      /CocoaPods state/.test(f.title),
    );
    expect(fastlane?.fix).toMatch(/&& pod install/);
    expect(fastlane?.fix).not.toMatch(/bundle exec/);

    writeFileSync(join(project, 'Gemfile.lock'), 'GEM\n  specs:\n    cocoapods (1.15.2)\n');
    const pinned = checkMainCheckout(project, { brokenPods: [], upstream: null }).find((f) =>
      /CocoaPods state/.test(f.title),
    );
    expect(pinned?.fix).toMatch(/bundle exec pod install/);
  } finally {
    rmSync(project, { recursive: true, force: true });
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

test('the iOS ccache finding no longer claims ccache cannot cross worktrees at all', () => {
  const f = checkCcacheConflict('post_install', { 'apple.ccacheEnabled': 'true' });
  assert(f);
  expect(f.detail).not.toMatch(/misses across worktrees anyway/);
  expect(f.detail).toMatch(/default configuration/);
});

test('ccache on PATH is silent, and ccache absent costs time with a full remedy', () => {
  expect(checkCcacheInstalled(true)).toBe(null);
  const f = checkCcacheInstalled(false);
  assert(f);
  expect(f.level).toBe('cost');
  expect(f.title).toMatch(/ccache is not on PATH, so Android C\+\+ recompiles in every worktree/);
  expect(f.detail).toMatch(/command -v ccache/);
  expect(f.detail).toMatch(/CMAKE_CXX_COMPILER_LAUNCHER/);
  expect(f.detail).toMatch(/49\.6s.*34\.2s/);
  expect(f.fix).toMatch(/brew install ccache/);
  expect(f.fix).toMatch(/android\/app\/\.cxx/);
  expect(f.fix).toMatch(/node_modules\/\*\*\/android\/\.cxx/);
  expect(f.fix).toMatch(/\/opt\/homebrew\/bin/);
});

test('the ccache finding belongs to the Android group and is filtered out by --platform ios', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doc-ccache-platform-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
    mkdirSync(join(project, 'android'), { recursive: true });
    const options = { concurrency: { maxBuilds: 0, maxDevices: 0 }, lookupCcache: () => false };
    const android = runDoctor(project, { ...options, platform: 'android' as const });
    const ios = runDoctor(project, { ...options, platform: 'ios' as const });
    expect(android.some((f) => /ccache is not on PATH/.test(f.title))).toBe(true);
    expect(ios.some((f) => /ccache is not on PATH/.test(f.title))).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('parseCmakeCacheLauncher reads the launcher a configure wrote into CMakeCache.txt', () => {
  const cache = [
    '//Compiler launcher for CXX.',
    'CMAKE_CXX_COMPILER_LAUNCHER:STRING=/opt/homebrew/bin/ccache',
    'CMAKE_BUILD_TYPE:STRING=Debug',
  ].join('\n');
  expect(parseCmakeCacheLauncher(cache)).toBe('/opt/homebrew/bin/ccache');
  expect(parseCmakeCacheLauncher('CMAKE_CXX_COMPILER_LAUNCHER:STRING=')).toBe(null);
  expect(parseCmakeCacheLauncher('CMAKE_BUILD_TYPE:STRING=Debug')).toBe(null);
  expect(parseCmakeCacheLauncher(null)).toBe(null);
});

describe('checkCxxCompilerLauncher', () => {
  const onDisk = (path: string) => path === '/opt/homebrew/bin/ccache';

  test('a CMake cache naming a launcher that is gone is a cost, ccache installed or not', () => {
    for (const ccacheOnPath of [true, false]) {
      const f = checkCxxCompilerLauncher({
        states: [{ path: 'android/app/.cxx/Debug/a1/arm64-v8a', launcher: '/usr/local/bin/ccache' }],
        ccacheOnPath,
        launcherExists: onDisk,
      });
      assert(f);
      expect(f.level).toBe('cost');
      expect(f.title).toMatch(/names a compiler launcher that is not on this machine/);
      expect(f.detail).toMatch(/\/usr\/local\/bin\/ccache/);
      expect(f.fix).toMatch(/\.cxx/);
    }
  });

  test('a configured .cxx with no launcher costs the C++ cache until it is deleted once', () => {
    const f = checkCxxCompilerLauncher({
      states: [{ path: 'android/app/.cxx/Debug/a1/arm64-v8a', launcher: null }],
      ccacheOnPath: true,
      launcherExists: onDisk,
    });
    assert(f);
    expect(f.level).toBe('cost');
    expect(f.title).toMatch(/predates/);
    expect(f.fix).toMatch(/\.cxx/);
  });

  test('nothing is said about a .cxx with no launcher when ccache is not installed either', () => {
    expect(
      checkCxxCompilerLauncher({
        states: [{ path: 'android/app/.cxx/Debug/a1/arm64-v8a', launcher: null }],
        ccacheOnPath: false,
        launcherExists: onDisk,
      }),
    ).toBe(null);
  });

  test('a launcher CMake resolves through PATH is not read as a filesystem path', () => {
    for (const ccacheOnPath of [true, false]) {
      expect(
        checkCxxCompilerLauncher({
          states: [{ path: 'android/app/.cxx/Debug/a1/arm64-v8a', launcher: 'ccache' }],
          ccacheOnPath,
          launcherExists: onDisk,
        }),
      ).toBe(null);
      expect(
        checkCxxCompilerLauncher({
          states: [{ path: 'android/app/.cxx/Debug/a1/arm64-v8a', launcher: 'ccache;--some-flag' }],
          ccacheOnPath,
          launcherExists: onDisk,
        }),
      ).toBe(null);
    }
  });

  test('a launcher list whose absolute command is gone is still a cost', () => {
    const f = checkCxxCompilerLauncher({
      states: [{ path: 'android/app/.cxx/Debug/a1/arm64-v8a', launcher: '/usr/local/bin/ccache;--some-flag' }],
      ccacheOnPath: true,
      launcherExists: onDisk,
    });
    assert(f);
    expect(f.detail).toMatch(/\/usr\/local\/bin\/ccache/);
  });

  test('a .cxx already routed through an installed launcher, or none at all, is clean', () => {
    expect(
      checkCxxCompilerLauncher({
        states: [{ path: 'android/app/.cxx/Debug/a1/arm64-v8a', launcher: '/opt/homebrew/bin/ccache' }],
        ccacheOnPath: true,
        launcherExists: onDisk,
      }),
    ).toBe(null);
    expect(checkCxxCompilerLauncher({ states: [], ccacheOnPath: true, launcherExists: onDisk })).toBe(null);
  });
});

test('runDoctor reads the real .cxx of an Android project and reports it only for Android', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doc-cxx-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
    const abiDir = join(project, 'android', 'app', '.cxx', 'Debug', '3q1r2w4t', 'arm64-v8a');
    mkdirSync(abiDir, { recursive: true });
    writeFileSync(join(abiDir, 'CMakeCache.txt'), 'CMAKE_BUILD_TYPE:STRING=Debug\n');
    const options = { concurrency: { maxBuilds: 0, maxDevices: 0 }, lookupCcache: () => true };
    const android = runDoctor(project, { ...options, platform: 'android' as const });
    const ios = runDoctor(project, { ...options, platform: 'ios' as const });
    expect(android.some((f) => /predates/.test(f.title))).toBe(true);
    expect(ios.some((f) => /predates/.test(f.title))).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('an iOS-only checkout is not told about the Android C++ cache', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doc-noandroid-'));
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
    const findings = runDoctor(project, {
      concurrency: { maxBuilds: 0, maxDevices: 0 },
      lookupCcache: () => false,
    });
    expect(findings.some((f) => /ccache is not on PATH/.test(f.title))).toBe(false);
    expect(
      runDoctor(project, {
        concurrency: { maxBuilds: 0, maxDevices: 0 },
        lookupCcache: () => false,
        platform: 'android' as const,
      }).some((f) => /ccache is not on PATH/.test(f.title)),
    ).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
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
    runFileQuiet: () => null,
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

describe('a directory that is not an app', () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-doc-home-'));
    process.env.STIM_HOME = home;
    project = mkdtempSync(join(tmpdir(), 'stim-doc-app-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  const findings = () => runDoctor(project, { concurrency: () => ({ maxBuilds: 0, maxDevices: 0 }) });

  test('runDoctor reports a package.json that depends on neither react-native nor expo', () => {
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'monorepo', devDependencies: { vitest: '5' } }),
    );
    const reported = findings().find((f) => /not a React Native or Expo app/.test(f.title));
    assert(reported);
    expect(reported.level).toBe('cost');
    expect(reported.detail).toContain(join(project, 'package.json'));
    expect(reported.detail).toMatch(/STIM_NO_PROJECT/);
    expect(reported.fix).toMatch(/app directory/);
  });

  test('runDoctor reports a package.json that does not parse as its own finding', () => {
    writeFileSync(join(project, 'package.json'), '{ "name": "app", "dependencies": { "react-native": "0.81.0"');
    const reported = findings().find((f) => /does not parse/.test(f.title));
    assert(reported);
    expect(reported.level).toBe('cost');
    expect(reported.detail).toContain(join(project, 'package.json'));
    expect(reported.detail).not.toMatch(/neither react-native nor expo/);
    expect(reported.fix).toMatch(/Fix the JSON/);
    expect(findings().some((f) => /not a React Native or Expo app/.test(f.title))).toBe(false);
  });

  test('runDoctor stays silent when the package.json depends on react-native', () => {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
    expect(findings().some((f) => /not a React Native or Expo app/.test(f.title))).toBe(false);
  });
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

test('runDoctor reports a wrong-typed setting as a finding rather than refusing', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-setting-shape-'));
  const home = mkdtempSync(join(tmpdir(), 'stim-doctor-setting-home-'));
  process.env.STIM_HOME = home;
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
    writeFileSync(join(project, '.stim.json'), JSON.stringify({ ios: { configuration: {} }, caches: 42 }));
    const findings = runDoctor(project, { concurrency: { maxBuilds: 0, maxDevices: 0 } });
    const shapeFindings = findings.filter((finding) => /wrong type/i.test(finding.title));
    expect(shapeFindings.map((finding) => finding.detail)).toEqual([
      'Invalid ios.configuration setting {}. Expected a string.',
      'Invalid caches setting 42. Expected an array of strings.',
    ]);
    for (const finding of shapeFindings) {
      expect(finding.level).toBe('cost');
      expect(finding.fix).toMatch(/guide settings/);
    }
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
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

test('detectFingerprintParity fingerprints only the selected platform', async () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-parity-platform-'));
  try {
    execSync('git init -q', { cwd: base });
    execSync('git config user.email test@example.com', { cwd: base });
    execSync('git config user.name test', { cwd: base });
    writeFileSync(join(base, 'app.json'), JSON.stringify({ expo: { name: 'app' } }));
    mkdirSync(join(base, 'ios'));
    mkdirSync(join(base, 'android'));
    execSync('git add . && git commit -q -m init', { cwd: base });
    const platforms: string[][] = [];
    const createFingerprint = async (_root: string, options?: { platforms?: string[] }) => {
      platforms.push(options?.platforms ?? []);
      return { hash: 'same', sources: [] };
    };

    expect(await detectFingerprintParity(base, { createFingerprint, platform: 'android' })).toBe(null);
    expect(platforms).toEqual([['android'], ['android']]);
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

test('runDoctor keeps shared checks and filters native checks and remote backends', () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doc-platform-'));
  const home = mkdtempSync(join(tmpdir(), 'stim-doc-platform-home-'));
  process.env.STIM_HOME = home;
  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x' }));
    mkdirSync(join(project, 'ios'));
    mkdirSync(join(project, 'android'));
    writeFileSync(join(project, 'ios', 'Podfile'), 'COMPILATION_CACHE_ENABLE_CACHING = YES\n');
    writeFileSync(join(project, 'ios', 'Podfile.properties.json'), JSON.stringify({ 'apple.ccacheEnabled': 'true' }));
    writeFileSync(join(project, 'simslim.json'), '{}\n');
    writeFileSync(join(project, 'metro.config.js'), 'if (process.env.CACHE) config.cacheStores = [];\n');
    writeFileSync(
      join(project, '.stim.json'),
      JSON.stringify({
        ios: { remote: 'proxy', simslimProfile: 'simslim.json' },
        android: { remote: 'eas' },
      }),
    );
    writeFileSync(join(home, 'config.json'), JSON.stringify({ pool: { iosParkedMax: 'bad' } }));
    const options = {
      concurrency: { maxBuilds: 0, maxDevices: 0 },
      remoteEnv: {
        AGENT_DEVICE_DAEMON_BASE_URL: 'https://proxy.example/agent-device',
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'tok_proxy',
      },
      lookupAgentDevice: () => true,
      lookupEasCli: () => false,
      lookupSimSlim: () => false,
      lookupCcache: () => true,
    };

    const ios = runDoctor(project, { ...options, platform: 'ios', xcodeMajor: 26 });
    const android = runDoctor(project, { ...options, platform: 'android', xcodeMajor: null });

    for (const findings of [ios, android]) {
      expect(findings.some((finding) => finding.title.includes('metro.config.js'))).toBe(true);
    }
    expect(ios.some((finding) => finding.title.includes('Stim leaves Xcode compilation caching off'))).toBe(true);
    expect(ios.some((finding) => finding.title.includes('SimSlim'))).toBe(true);
    expect(ios.some((finding) => finding.title === 'This project uses a remote proxy')).toBe(true);
    expect(ios.some((finding) => finding.title.includes('simulator pool bound'))).toBe(true);
    expect(ios.some((finding) => finding.title.includes('no eas-cli'))).toBe(false);
    expect(android.some((finding) => finding.title.includes('Stim leaves Xcode compilation caching off'))).toBe(false);
    expect(android.some((finding) => finding.title.includes('SimSlim'))).toBe(false);
    expect(android.some((finding) => finding.title === 'This project uses a remote proxy')).toBe(false);
    expect(android.some((finding) => finding.title.includes('simulator pool bound'))).toBe(false);
    expect(android.some((finding) => finding.title.includes('no eas-cli'))).toBe(true);
  } finally {
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
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

test('doctor --json prints exactly one line of JSON on stdout', async () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-cli-'));
  const home = mkdtempSync(join(tmpdir(), 'stim-doctor-cli-home-'));
  process.env.STIM_HOME = home;
  const cwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app' }));
  const program = new Command();
  doctorCommand(program, '1.2.3', () => testStimVersions);
  console.log = (msg) => logs.push(String(msg));
  process.chdir(project);
  try {
    await program.parseAsync(['node', 'stim', 'doctor', '--json']);
  } finally {
    process.chdir(cwd);
    console.log = originalLog;
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
  expect(logs.length).toBe(1);
  const [line] = logs;
  assert(line);
  expect(line).not.toContain('\n');
  const payload = JSON.parse(line);
  expect(Array.isArray(payload.findings)).toBe(true);
  expect(typeof payload.project).toBe('string');
  expect(payload.platform).toBe(null);
  expect(payload.stim.runningVersion).toBe('1.2.3');
  expect(payload.stim.resolved).toBe(null);
});

test('doctor success output groups iOS checks and optional capabilities', () => {
  const output = doctorSuccessLines('ios', testStimVersions).join('\n');

  expect(output).toContain('Doctor (iOS)');
  expect(output).toContain('result      PASS');
  expect(output).toContain('findings    0');
  expect(output).toContain('version     1.2.3');
  expect(output).toContain('resolved    not found on PATH');
  expect(output).toContain('Project');
  expect(output).toContain('iOS');
  expect(output).toContain('setup       CocoaPods, warm state, dev client');
  expect(output).toContain('caches      Metro, Xcode compilation, ccache, build provider');
  expect(output).toContain('Handled automatically');
  expect(output).toContain('missing project cache settings are healthy');
  expect(output).not.toContain('Android');
  expect(output).not.toContain('Nothing to flag means');
});

test('doctor success output scopes native checks to Android', () => {
  const output = doctorSuccessLines('android', testStimVersions).join('\n');

  expect(output).toContain('Doctor (Android)');
  expect(output).toContain('Android');
  expect(output).toContain('setup       warm state, dev client');
  expect(output).toContain('caches      Metro, Gradle, ccache, build provider');
  expect(output).not.toContain('Xcode compilation');
  expect(output).not.toContain('SimSlim');
});

test('doctor --platform includes the selection in JSON and suppresses the other warm-state finding', async () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-cli-platform-'));
  const home = mkdtempSync(join(tmpdir(), 'stim-doctor-cli-platform-home-'));
  process.env.STIM_HOME = home;
  const cwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app' }));
  mkdirSync(join(project, 'node_modules'));
  mkdirSync(join(project, 'ios'));
  mkdirSync(join(project, 'android'));
  const program = new Command();
  doctorCommand(program, '1.2.3', () => testStimVersions);
  console.log = (msg) => logs.push(String(msg));
  process.chdir(project);
  try {
    await program.parseAsync(['node', 'stim', 'doctor', '--json', '--platform', 'ios']);
  } finally {
    process.chdir(cwd);
    console.log = originalLog;
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
  expect(logs).toHaveLength(1);
  const payload = JSON.parse(logs[0] as string);
  expect(payload.platform).toBe('ios');
  expect(payload.findings.some((finding: Finding) => finding.title.includes('Android warm'))).toBe(false);
  expect(payload.findings.some((finding: Finding) => finding.title.includes('iOS warm'))).toBe(true);
});

test('doctor --platform android does not invoke Xcode tooling', async () => {
  const project = mkdtempSync(join(tmpdir(), 'stim-doctor-cli-android-'));
  const home = mkdtempSync(join(tmpdir(), 'stim-doctor-cli-android-home-'));
  process.env.STIM_HOME = home;
  const cwd = process.cwd();
  const logs: string[] = [];
  const calls: string[] = [];
  const originalLog = console.log;
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app' }));
  mkdirSync(join(project, 'node_modules'));
  mkdirSync(join(project, 'android'));
  setExecutor({
    run: (command: string) => {
      calls.push(command);
      return '';
    },
    runQuiet: (command: string) => {
      calls.push(command);
      return null;
    },
    runFile: (file: string, args: string[]) => {
      calls.push([file, ...args].join(' '));
      return '';
    },
    runFileQuiet: (file: string, args: string[]) => {
      calls.push([file, ...args].join(' '));
      return null;
    },
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  const program = new Command();
  doctorCommand(program, '1.2.3', () => testStimVersions);
  console.log = (msg) => logs.push(String(msg));
  process.chdir(project);
  try {
    await program.parseAsync(['node', 'stim', 'doctor', '--json', '--platform', 'android']);
  } finally {
    process.chdir(cwd);
    console.log = originalLog;
    resetExecutor();
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
  expect(logs).toHaveLength(1);
  expect(calls.some((call) => call.includes('xcodebuild'))).toBe(false);
});
