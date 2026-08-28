import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeSettingsLayers, readCommittedSettings, resolveSettings, unknownSettingKeys } from '../settings.ts';
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
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
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

test('readCommittedSettings reads .rn-iso.json', () => {
  writeFileSync(join(tmpHome, '.rn-iso.json'), JSON.stringify({ packageManager: 'yarn' }));
  expect(readCommittedSettings(tmpHome)).toEqual({ packageManager: 'yarn' });
});

test('readCommittedSettings returns empty for missing or malformed files', () => {
  expect(readCommittedSettings(tmpHome)).toEqual({});
  writeFileSync(join(tmpHome, '.rn-iso.json'), '{ not json');
  expect(readCommittedSettings(tmpHome)).toEqual({});
});

test('resolveSettings orders project over repo over committed', () => {
  writeFileSync(
    join(tmpHome, '.rn-iso.json'),
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

test('unknownSettingKeys reports keys rn-iso no longer reads', () => {
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

test('unknownSettingKeys reports a nested unknown without flagging its parent', () => {
  expect(unknownSettingKeys({ ios: { deviceType: 'x', bogus: 1 } })).toEqual(['ios.bogus']);
});

test('unknownSettingKeys tolerates empty and malformed input', () => {
  expect(unknownSettingKeys({})).toEqual([]);
  expect(unknownSettingKeys(null)).toEqual([]);
  expect(unknownSettingKeys('nope')).toEqual([]);
});

test('committed caches and device settings resolve with their JSON types intact', () => {
  const repo = mkdtempSync(join(tmpdir(), 'rn-iso-repo-'));
  try {
    writeFileSync(
      join(repo, '.rn-iso.json'),
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
