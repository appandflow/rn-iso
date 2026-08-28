import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mergeSettingsLayers,
  ngrokUrlSetting,
  publicUrlSetting,
  readCommittedSettings,
  remoteAndroidSetting,
  remoteDeviceSettingError,
  remoteIosSetting,
  resolveSettings,
  tunnelModeSetting,
  unknownSettingKeys,
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
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-cli-test-'));
  process.env.STIM_CLI_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_CLI_HOME;
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

test('readCommittedSettings reads .stim-cli.json', () => {
  writeFileSync(join(tmpHome, '.stim-cli.json'), JSON.stringify({ packageManager: 'yarn' }));
  expect(readCommittedSettings(tmpHome)).toEqual({ packageManager: 'yarn' });
});

test('readCommittedSettings returns empty for missing or malformed files', () => {
  expect(readCommittedSettings(tmpHome)).toEqual({});
  writeFileSync(join(tmpHome, '.stim-cli.json'), '{ not json');
  expect(readCommittedSettings(tmpHome)).toEqual({});
});

test('resolveSettings orders project over repo over committed', () => {
  writeFileSync(
    join(tmpHome, '.stim-cli.json'),
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

test('unknownSettingKeys reports keys stim-cli no longer reads', () => {
  expect(unknownSettingKeys({ packageManager: 'pnpm' })).toEqual(['packageManager']);
  expect(unknownSettingKeys({ worktree: { install: ['pnpm i'] } })).toEqual(['worktree.install']);
});

test('unknownSettingKeys accepts every key that is still honoured', () => {
  expect(
    unknownSettingKeys({
      ios: { deviceType: 'iPhone 17 Pro', runtime: '26.2', configuration: 'Release' },
      android: { systemImage: 'pkg', variant: 'productionDebug' },
      worktree: { baseRef: 'fresh', include: ['.env'] },
      worktreeDir: '/tmp/wt',
    }),
  ).toEqual([]);
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

test('unknownSettingKeys tolerates empty and malformed input', () => {
  expect(unknownSettingKeys({})).toEqual([]);
  expect(unknownSettingKeys(null)).toEqual([]);
  expect(unknownSettingKeys('nope')).toEqual([]);
});

test('committed caches and device settings resolve with their JSON types intact', () => {
  const repo = mkdtempSync(join(tmpdir(), 'stim-cli-repo-'));
  try {
    writeFileSync(
      join(repo, '.stim-cli.json'),
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
