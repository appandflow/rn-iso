import assert from 'node:assert';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  androidAvdConfigSetting,
  cacheProviderSettingError,
  androidAvdConfigSettingError,
  androidDataPartitionSizeBytes,
  androidDataPartitionSizeGbSetting,
  androidDataPartitionSizeGbSettingError,
  iosLanHostSetting,
  iosLanHostSettingError,
  iosSigningIdentitySetting,
  iosSigningIdentitySettingError,
  iosSigningIdentitySha1Setting,
  iosSigningIdentitySha1SettingError,
  iosSimSlimProfileSetting,
  iosSimSlimProfileSettingError,
  mergeSettingsLayers,
  ngrokUrlSetting,
  parseAndroidAvdConfigIni,
  publicUrlSetting,
  readCommittedSettings,
  remoteAndroidSetting,
  remoteDeviceSettingError,
  remoteIosSetting,
  resolveCacheProviderConfig,
  resolveSettings,
  tunnelModeSetting,
  unknownSettingKeys,
  worktreeDirSettingError,
} from '../settings.ts';
import { setProjectSetting, setRepoSetting, upsertProject } from '../config.ts';

type SettingsView = {
  packageManager?: string;
  caches?: string[];
  worktree?: { install?: string[]; baseRef?: string };
  ios?: { deviceType?: string; runtime?: string };
  [k: string]: unknown;
};

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('earlier layers win over later ones', () => {
  const merged = mergeSettingsLayers([{ packageManager: 'bun' }, { packageManager: 'pnpm', worktreeDir: '/b' }]);
  expect(merged).toEqual({ packageManager: 'bun', worktreeDir: '/b' });
});

test('merges nested objects key by key rather than replacing them', () => {
  const merged = mergeSettingsLayers([
    { worktree: { baseRef: 'head' } },
    { worktree: { baseRef: 'fresh', install: ['pnpm install'] } },
  ]);
  expect(merged).toEqual({ worktree: { baseRef: 'head', install: ['pnpm install'] } });
});

test('merges android.avdConfig keys across settings layers with earlier values winning', () => {
  const merged = mergeSettingsLayers([
    { android: { avdConfig: { 'hw.ramSize': 4096 } } },
    { android: { avdConfig: { 'hw.ramSize': 2048, 'hw.keyboard': true } } },
  ]);
  expect(merged).toEqual({
    android: { avdConfig: { 'hw.ramSize': 4096, 'hw.keyboard': true } },
  });
});

test('ignores null and undefined layers', () => {
  expect(mergeSettingsLayers([null, { a: 1 }, undefined])).toEqual({ a: 1 });
});

test('an array value is replaced wholesale, not concatenated', () => {
  const merged = mergeSettingsLayers([
    { worktree: { install: ['a'] } },
    { worktree: { install: ['b', 'c'] } },
  ]) as SettingsView;
  assert(merged.worktree);
  expect(merged.worktree.install).toEqual(['a']);
});

test('readCommittedSettings reads .stim.json', () => {
  writeFileSync(join(tmpHome, '.stim.json'), JSON.stringify({ packageManager: 'yarn' }));
  expect(readCommittedSettings(tmpHome)).toEqual({ packageManager: 'yarn' });
});

test('readCommittedSettings returns empty for missing or malformed files', () => {
  expect(readCommittedSettings(tmpHome)).toEqual({});
  writeFileSync(join(tmpHome, '.stim.json'), '{ not json');
  expect(readCommittedSettings(tmpHome)).toEqual({});
});

test('resolveSettings orders project over repo over committed', () => {
  writeFileSync(
    join(tmpHome, '.stim.json'),
    JSON.stringify({ packageManager: 'yarn', worktree: { baseRef: 'fresh' } }),
  );
  setRepoSetting('/repo/.git', 'packageManager', 'pnpm');
  upsertProject('/proj', {});
  setProjectSetting('/proj', 'packageManager', 'bun');

  const merged = resolveSettings({
    projectPath: '/proj',
    gitCommonDir: '/repo/.git',
    repoRoot: tmpHome,
  }) as SettingsView;
  expect(merged.packageManager).toBe('bun');
  assert(merged.worktree);
  expect(merged.worktree.baseRef).toBe('fresh');
});

test('unknownSettingKeys reports keys Stim no longer reads', () => {
  expect(unknownSettingKeys({ packageManager: 'pnpm' })).toEqual(['packageManager']);
  expect(unknownSettingKeys({ worktree: { install: ['pnpm i'] } })).toEqual(['worktree.install']);
});

test('unknownSettingKeys accepts every key that is still honoured', () => {
  expect(
    unknownSettingKeys({
      ios: {
        deviceType: 'iPhone 17 Pro',
        runtime: '26.2',
        configuration: 'Release',
        simslimProfile: '.simslim/dev.json',
      },
      android: {
        systemImage: 'pkg',
        dataPartitionSizeGb: 8,
        avdConfigFile: '.stim/android-avd.ini',
        avdConfig: { 'hw.ramSize': 3072, 'hw.keyboard': true },
        variant: 'productionDebug',
      },
      worktree: { baseRef: 'fresh', include: ['.env'] },
      worktreeDir: '/tmp/wt',
    }),
  ).toEqual([]);
});

describe('iOS SimSlim profile settings', () => {
  test('resolves a repository-contained profile and treats an absent setting as disabled', () => {
    writeFileSync(join(tmpHome, 'simslim.json'), '{}\n');
    expect(iosSimSlimProfileSetting({ ios: { simslimProfile: 'simslim.json' } }, tmpHome)).toBe(
      realpathSync(join(tmpHome, 'simslim.json')),
    );
    expect(iosSimSlimProfileSetting({}, tmpHome)).toBeNull();
  });

  test('rejects invalid paths, missing profiles, and symlink escapes', () => {
    const outside = mkdtempSync(join(tmpdir(), 'stim-simslim-outside-'));
    try {
      writeFileSync(join(outside, 'profile.json'), '{}\n');
      symlinkSync(join(outside, 'profile.json'), join(tmpHome, 'linked.json'));
      for (const path of ['', '../profile.json', join(outside, 'profile.json'), 'missing.json', 'linked.json']) {
        expect(iosSimSlimProfileSettingError({ ios: { simslimProfile: path } }, tmpHome)).toBeTruthy();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('Android AVD config settings', () => {
  test('reads a repository-contained INI fragment and applies inline overrides on top', () => {
    writeFileSync(join(tmpHome, 'android-avd.ini'), 'hw.ramSize=3072\nhw.keyboard=no\n');
    expect(
      androidAvdConfigSetting(
        {
          android: {
            avdConfigFile: 'android-avd.ini',
            avdConfig: { 'hw.keyboard': true, 'vm.heapSize': 512 },
          },
        },
        tmpHome,
      ),
    ).toEqual({ 'hw.ramSize': '3072', 'hw.keyboard': 'yes', 'vm.heapSize': '512' });
  });

  test('parses comments and values containing equals, and rejects malformed or duplicate lines', () => {
    expect(parseAndroidAvdConfigIni('# device\n; local\nhw.keyboard=true\nruntime.network.speed=5g\n')).toEqual({
      'hw.keyboard': 'yes',
      'runtime.network.speed': '5g',
    });
    expect(() => parseAndroidAvdConfigIni('[hardware]\n')).toThrow(/line 1.*key=value/);
    expect(() => parseAndroidAvdConfigIni('hw.keyboard=yes\nhw.keyboard=no\n')).toThrow(/duplicate key/);
  });

  test.each([
    ['disk.dataPartition.path', '/tmp/elsewhere'],
    ['image.sysdir.1', '../image'],
    ['hw.cpu.arch', 'arm64'],
    ['hw.camera.back', 'webcam0'],
    ['hw.unknownFutureControl', 'yes'],
    ['toString', 'yes'],
  ])('rejects protected or unknown key %s', (key, value) => {
    expect(androidAvdConfigSettingError({ android: { avdConfig: { [key]: value } } }, tmpHome)).toMatch(
      /Unsupported android\.avdConfig key/,
    );
  });

  test.each([
    ['hw.ramSize', 1024],
    ['hw.cpu.ncore', 0],
    ['hw.keyboard', 'on'],
    ['hw.gpu.mode', 'swiftshader_indirect'],
    ['runtime.network.speed', 'unlimited'],
  ])('rejects invalid value %p for %s', (key, value) => {
    expect(androidAvdConfigSettingError({ android: { avdConfig: { [key]: value } } }, tmpHome)).toMatch(
      /Invalid android\.avdConfig value/,
    );
  });

  test('rejects non-scalar and line-injecting inline values', () => {
    expect(androidAvdConfigSettingError({ android: { avdConfig: { 'hw.keyboard': ['yes'] } } }, tmpHome)).toMatch(
      /Invalid android\.avdConfig value/,
    );
    expect(
      androidAvdConfigSettingError(
        { android: { avdConfig: { 'hw.keyboard': 'yes\ndisk.dataPartition.path=/tmp/outside' } } },
        tmpHome,
      ),
    ).toMatch(/expected one line/);
  });

  test('rejects absolute paths, traversal, symlink escapes, and oversized fragments', () => {
    const outside = mkdtempSync(join(tmpdir(), 'stim-outside-'));
    try {
      writeFileSync(join(outside, 'outside.ini'), 'hw.keyboard=yes\n');
      symlinkSync(join(outside, 'outside.ini'), join(tmpHome, 'linked.ini'));
      writeFileSync(join(tmpHome, 'large.ini'), `#${'x'.repeat(64 * 1024)}\n`);
      for (const path of [join(outside, 'outside.ini'), '../outside.ini', 'linked.ini', 'large.ini']) {
        expect(androidAvdConfigSettingError({ android: { avdConfigFile: path } }, tmpHome)).toBeTruthy();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('Android data partition size settings', () => {
  test('defaults above the emulator minimum and converts GiB to exact bytes', () => {
    expect(androidDataPartitionSizeGbSetting({})).toBe(8);
    expect(androidDataPartitionSizeBytes(6)).toBe(6 * 1024 ** 3);
  });

  test('accepts an integer override through the emulator ext4 maximum', () => {
    expect(androidDataPartitionSizeGbSetting({ android: { dataPartitionSizeGb: 12 } })).toBe(12);
    expect(androidDataPartitionSizeGbSettingError({ android: { dataPartitionSizeGb: 16 * 1024 } })).toBeNull();
  });

  test('uses the ordinary first-layer-wins precedence', () => {
    const merged = mergeSettingsLayers([
      { android: { dataPartitionSizeGb: 12 } },
      { android: { dataPartitionSizeGb: 10 } },
      { android: { dataPartitionSizeGb: 8 } },
    ]);
    expect(androidDataPartitionSizeGbSetting(merged)).toBe(12);
  });

  test.each([5, 6.5, '8', 16 * 1024 + 1])('rejects invalid value %p', (value) => {
    const settings = { android: { dataPartitionSizeGb: value } };
    expect(androidDataPartitionSizeGbSettingError(settings)).toMatch(/integer from 6 through 16384 GiB/);
    expect(() => androidDataPartitionSizeGbSetting(settings)).toThrow(/android\.dataPartitionSizeGb/);
  });
});

describe('remote device settings', () => {
  test('accepts only the explicit proxy and eas backends', () => {
    expect(remoteIosSetting({ ios: { remote: 'proxy' } })).toBe('proxy');
    expect(remoteIosSetting({ ios: { remote: 'eas' } })).toBe('eas');
    expect(remoteAndroidSetting({ android: { remote: 'proxy' } })).toBe('proxy');
    expect(remoteAndroidSetting({ android: { remote: 'eas' } })).toBe('eas');
  });

  test('reports invalid platform values instead of silently disabling remote mode', () => {
    expect(remoteDeviceSettingError({ ios: { remote: true } })).toBe(
      'Invalid ios.remote setting true. Expected one of: proxy, eas.',
    );
    expect(remoteDeviceSettingError({ android: { remote: 'cloud' } })).toBe(
      'Invalid android.remote setting "cloud". Expected one of: proxy, eas.',
    );
  });

  test('missing platform settings remain local and valid', () => {
    expect(remoteIosSetting({})).toBeNull();
    expect(remoteAndroidSetting({ android: {} })).toBeNull();
    expect(remoteDeviceSettingError({})).toBeNull();
  });
});

test('unknownSettingKeys reports a nested unknown without flagging its parent', () => {
  expect(unknownSettingKeys({ ios: { deviceType: 'x', bogus: 1 } })).toEqual(['ios.bogus']);
});

test('unknownSettingKeys treats a known scalar key with an object value as known, leaving refusal to its validator', () => {
  expect(unknownSettingKeys({ worktreeDir: {} })).toEqual([]);
  expect(worktreeDirSettingError({ worktreeDir: {} })).toMatch(/Invalid worktreeDir setting/);

  expect(unknownSettingKeys({ ios: { lanHost: {} } })).toEqual([]);
  expect(iosLanHostSettingError({ ios: { lanHost: {} } })).toMatch(/Invalid ios\.lanHost setting/);
});

test('unknownSettingKeys still reports a genuinely unknown nested key under ios', () => {
  expect(unknownSettingKeys({ ios: { bogus: {} } })).toEqual(['ios.bogus']);
});

test('unknownSettingKeys still reports an object value for a known scalar with no validator (transitional, see #210)', () => {
  expect(unknownSettingKeys({ ios: { configuration: {} } })).toEqual(['ios.configuration']);
});

test('every validated scalar key is a known setting, as a string and as an object', () => {
  const validated = [
    'worktreeDir',
    'ios.lanHost',
    'ios.signingIdentity',
    'ios.signingIdentitySha1',
    'ios.remote',
    'ios.simslimProfile',
    'android.remote',
    'android.dataPartitionSizeGb',
    'android.avdConfigFile',
    'cache.provider',
  ];
  const nested = (path: string, value: unknown): Record<string, unknown> =>
    path
      .split('.')
      .reverse()
      .reduce<Record<string, unknown>>((inner, key) => ({ [key]: inner }), value as Record<string, unknown>);
  for (const path of validated) {
    expect(unknownSettingKeys(nested(path, 'x'))).toEqual([]);
    expect(unknownSettingKeys(nested(path, {}))).toEqual([]);
  }
});

test('unknownSettingKeys tolerates empty and malformed input', () => {
  expect(unknownSettingKeys({})).toEqual([]);
  expect(unknownSettingKeys(null)).toEqual([]);
  expect(unknownSettingKeys('nope')).toEqual([]);
});

test('committed caches and device settings resolve with their JSON types intact', () => {
  const repo = mkdtempSync(join(tmpdir(), 'stim-repo-'));
  try {
    writeFileSync(
      join(repo, '.stim.json'),
      JSON.stringify({
        caches: ['~/.myapp-metro-cache', '/tmp/build-cache'],
        ios: { deviceType: 'iPhone 17 Pro', runtime: '26.2' },
      }),
    );
    const resolved = resolveSettings({ repoRoot: repo }) as SettingsView;
    expect(resolved.caches).toEqual(['~/.myapp-metro-cache', '/tmp/build-cache']);
    assert(resolved.ios);
    expect(resolved.ios.deviceType).toBe('iPhone 17 Pro');
    expect(resolved.ios.runtime).toBe('26.2');
    expect(unknownSettingKeys(resolved)).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a repo-layer array setting survives resolution as an array', () => {
  setRepoSetting('/repo/.git', 'caches', ['~/.myapp-metro-cache', '/tmp/build-cache']);
  const resolved = resolveSettings({ gitCommonDir: '/repo/.git' });
  expect(resolved.caches).toEqual(['~/.myapp-metro-cache', '/tmp/build-cache']);
});

test('unknownSettingKeys accepts metro.tunnel, metro.ngrokUrl, and metro.publicUrl', () => {
  expect(
    unknownSettingKeys({
      metro: {
        tunnel: 'ngrok',
        ngrokUrl: 'https://stable.ngrok.app',
        publicUrl: 'https://x.example.com',
      },
    }),
  ).toEqual([]);
});

describe('tunnelModeSetting', () => {
  test('reads one of the known modes', () => {
    expect(tunnelModeSetting({ metro: { tunnel: 'cloudflared' } })).toBe('cloudflared');
    expect(tunnelModeSetting({ metro: { tunnel: 'off' } })).toBe('off');
  });

  test('anything not a known mode -- a typo, an old value -- is unset, not trusted', () => {
    expect(tunnelModeSetting({ metro: { tunnel: 'ngrok-please' } })).toBeNull();
    expect(tunnelModeSetting({ metro: { tunnel: true } })).toBeNull();
  });

  test('a missing metro block, or no tunnel key, is unset', () => {
    expect(tunnelModeSetting({})).toBeNull();
    expect(tunnelModeSetting({ metro: {} })).toBeNull();
    expect(tunnelModeSetting({ metro: 'nope' })).toBeNull();
  });
});

describe('publicUrlSetting', () => {
  test('reads a committed tunnel URL', () => {
    expect(publicUrlSetting({ metro: { publicUrl: 'https://abc.trycloudflare.com' } })).toBe(
      'https://abc.trycloudflare.com',
    );
  });

  test('a non-string or blank value is unset', () => {
    expect(publicUrlSetting({ metro: { publicUrl: '' } })).toBeNull();
    expect(publicUrlSetting({ metro: { publicUrl: 42 } })).toBeNull();
    expect(publicUrlSetting({})).toBeNull();
  });
});

describe('ngrokUrlSetting', () => {
  test('reads a valid HTTPS URL with explicit ngrok mode', () => {
    expect(ngrokUrlSetting({ metro: { tunnel: 'ngrok', ngrokUrl: 'https://stable.ngrok.app' } })).toBe(
      'https://stable.ngrok.app',
    );
  });

  test('normalizes a trailing slash for stable record reuse', () => {
    expect(ngrokUrlSetting({ metro: { tunnel: 'ngrok', ngrokUrl: 'https://stable.ngrok.app/' } })).toBe(
      'https://stable.ngrok.app',
    );
  });

  test('is unset for auto and every other tunnel mode', () => {
    for (const tunnel of ['auto', 'expo', 'cloudflared', 'off']) {
      expect(ngrokUrlSetting({ metro: { tunnel, ngrokUrl: 'https://stable.ngrok.app' } })).toBeNull();
    }
  });

  test('rejects non-HTTPS and malformed URLs', () => {
    expect(ngrokUrlSetting({ metro: { tunnel: 'ngrok', ngrokUrl: 'http://stable.ngrok.app' } })).toBeNull();
    expect(ngrokUrlSetting({ metro: { tunnel: 'ngrok', ngrokUrl: 'not a url' } })).toBeNull();
    expect(ngrokUrlSetting({ metro: { tunnel: 'ngrok', ngrokUrl: 42 } })).toBeNull();
  });
});

test('resolveCacheProviderConfig reports no provider when nothing configures one', () => {
  writeFileSync(join(tmpHome, '.stim.json'), JSON.stringify({ worktree: { baseRef: 'fresh' } }));
  upsertProject('/proj', {});

  expect(
    resolveCacheProviderConfig({ projectPath: '/proj', gitCommonDir: '/repo/.git', repoRoot: tmpHome }),
  ).toBeNull();
});

test('a committed provider resolves from the directory holding .stim.json', () => {
  writeFileSync(
    join(tmpHome, '.stim.json'),
    JSON.stringify({ cache: { provider: './tools/cache-provider.cjs', options: { bucket: 'mobile' } } }),
  );
  upsertProject('/proj', {});

  expect(resolveCacheProviderConfig({ projectPath: '/proj', gitCommonDir: '/repo/.git', repoRoot: tmpHome })).toEqual({
    provider: './tools/cache-provider.cjs',
    options: { bucket: 'mobile' },
    baseDir: tmpHome,
  });
});

test('machine project settings override repository and committed providers', () => {
  writeFileSync(join(tmpHome, '.stim.json'), JSON.stringify({ cache: { provider: './committed.cjs' } }));
  setRepoSetting('/repo/.git', 'cache', { provider: './repo.cjs' });
  upsertProject('/proj', {});
  setProjectSetting('/proj', 'cache', { provider: './project.cjs' });

  expect(resolveCacheProviderConfig({ projectPath: '/proj', gitCommonDir: '/repo/.git', repoRoot: tmpHome })).toEqual({
    provider: './project.cjs',
    options: {},
    baseDir: '/proj',
  });
});

test('machine repository settings override committed providers and resolve from the repository root', () => {
  writeFileSync(join(tmpHome, '.stim.json'), JSON.stringify({ cache: { provider: './committed.cjs' } }));
  setRepoSetting('/repo/.git', 'cache', { provider: './repo.cjs' });
  upsertProject('/proj', {});

  expect(resolveCacheProviderConfig({ projectPath: '/proj', gitCommonDir: '/repo/.git', repoRoot: tmpHome })).toEqual({
    provider: './repo.cjs',
    options: {},
    baseDir: tmpHome,
  });
});

test('provider options merge across layers with earlier layers winning', () => {
  writeFileSync(
    join(tmpHome, '.stim.json'),
    JSON.stringify({ cache: { provider: './committed.cjs', options: { bucket: 'team', region: 'us' } } }),
  );
  setRepoSetting('/repo/.git', 'cache', { options: { region: 'eu' } });
  upsertProject('/proj', {});
  setProjectSetting('/proj', 'cache', { options: { token: 'from-machine' } });

  expect(resolveCacheProviderConfig({ projectPath: '/proj', gitCommonDir: '/repo/.git', repoRoot: tmpHome })).toEqual({
    provider: './committed.cjs',
    options: { token: 'from-machine', region: 'eu', bucket: 'team' },
    baseDir: tmpHome,
  });
});

test('an invalid provider reference reports no provider and names the error', () => {
  writeFileSync(join(tmpHome, '.stim.json'), JSON.stringify({ cache: { provider: 42, options: { a: 1 } } }));
  upsertProject('/proj', {});

  const context = { projectPath: '/proj', gitCommonDir: '/repo/.git', repoRoot: tmpHome };
  expect(resolveCacheProviderConfig(context)).toBeNull();
  expect(cacheProviderSettingError(resolveSettings(context))).toBe(
    'Invalid cache.provider setting 42. Expected a module path or package name.',
  );
});

test('cacheProviderSettingError accepts valid shapes and names invalid ones', () => {
  expect(cacheProviderSettingError({})).toBeNull();
  expect(cacheProviderSettingError({ cache: { provider: './cache.cjs', options: { bucket: 'a' } } })).toBeNull();
  expect(cacheProviderSettingError({ cache: { provider: '  ' } })).toMatch(/Invalid cache\.provider setting/);
  expect(cacheProviderSettingError({ cache: { provider: './cache.cjs', options: 'nope' } })).toMatch(
    /Invalid cache\.options setting/,
  );
  expect(cacheProviderSettingError({ cache: 'nope' })).toMatch(/Invalid cache setting/);
});

test('cache.provider and cache.options are known settings', () => {
  expect(
    unknownSettingKeys({ cache: { provider: './cache.cjs', options: { bucket: 'a', nested: { deep: true } } } }),
  ).toEqual([]);
  expect(unknownSettingKeys({ cache: { unknown: true } })).toEqual(['cache.unknown']);
});

test('ios.signingIdentity reads a trimmed identity name and refuses a shape codesign cannot take', () => {
  expect(iosSigningIdentitySetting({ ios: { signingIdentity: '  Apple Development: Jane (TEAMID5678)  ' } })).toBe(
    'Apple Development: Jane (TEAMID5678)',
  );
  expect(iosSigningIdentitySetting({})).toBe(null);
  expect(iosSigningIdentitySetting({ ios: [] })).toBe(null);

  expect(iosSigningIdentitySettingError({})).toBe(null);
  expect(iosSigningIdentitySettingError({ ios: { signingIdentity: 'Apple Development: Jane' } })).toBe(null);
  expect(iosSigningIdentitySettingError({ ios: { signingIdentity: '  ' } })).toMatch(/Invalid ios\.signingIdentity/);
  expect(iosSigningIdentitySettingError({ ios: { signingIdentity: 42 } })).toMatch(/Invalid ios\.signingIdentity/);
  expect(iosSigningIdentitySettingError({ ios: { signingIdentity: 'two\nlines' } })).toMatch(
    /Invalid ios\.signingIdentity/,
  );
});

test('ios.signingIdentitySha1 takes exactly the 40-hex hash find-identity prints, upper-cased', () => {
  const sha1 = '3fe19e227ec5bc2ede3ac52ab02ff46920445c6a';
  expect(iosSigningIdentitySha1Setting({ ios: { signingIdentitySha1: ` ${sha1} ` } })).toBe(sha1.toUpperCase());
  expect(iosSigningIdentitySha1Setting({})).toBe(null);

  expect(iosSigningIdentitySha1SettingError({})).toBe(null);
  expect(iosSigningIdentitySha1SettingError({ ios: { signingIdentitySha1: sha1 } })).toBe(null);
  expect(iosSigningIdentitySha1SettingError({ ios: { signingIdentitySha1: 'ABCDEF' } })).toMatch(
    /Invalid ios\.signingIdentitySha1/,
  );
  expect(iosSigningIdentitySha1SettingError({ ios: { signingIdentitySha1: `${sha1}00` } })).toMatch(
    /Invalid ios\.signingIdentitySha1/,
  );
});

test('ios.lanHost takes a bare address and refuses everything that would break serverRootWithHostPort', () => {
  expect(iosLanHostSetting({ ios: { lanHost: ' 192.168.1.42 ' } })).toBe('192.168.1.42');
  expect(iosLanHostSettingError({ ios: { lanHost: ' 192.168.1.42 ' } })).toBe(null);
  expect(iosLanHostSetting({ ios: { lanHost: 'mac-studio.local' } })).toBe('mac-studio.local');
  expect(iosLanHostSetting({})).toBe(null);

  expect(iosLanHostSettingError({})).toBe(null);
  expect(iosLanHostSettingError({ ios: { lanHost: '192.168.1.42' } })).toBe(null);
  for (const bad of [
    'http://192.168.1.42',
    'https://foo.ngrok.app',
    '192.168.1.42:8085',
    '192.168.1.42/',
    'a b',
    '',
    42,
  ]) {
    expect(iosLanHostSettingError({ ios: { lanHost: bad } })).toMatch(/Invalid ios\.lanHost/);
  }
});

test('worktreeDir refuses a non-string value and accepts a valid path', () => {
  expect(worktreeDirSettingError({ worktreeDir: 5 })).toMatch(/Invalid worktreeDir setting/);
  expect(worktreeDirSettingError({ worktreeDir: '.stim-worktrees' })).toBe(null);
});

test('the three iOS device settings are known keys', () => {
  expect(
    unknownSettingKeys({
      ios: { signingIdentity: 'a', signingIdentitySha1: 'b', lanHost: 'c' },
    }),
  ).toEqual([]);
  expect(unknownSettingKeys({ ios: { lanPort: 1 } })).toEqual(['ios.lanPort']);
});
