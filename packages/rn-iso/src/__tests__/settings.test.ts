import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeSettingsLayers, readCommittedSettings, resolveSettings, unknownSettingKeys } from '../settings.ts';
import { setProjectSetting, setRepoSetting, upsertProject } from '../config.ts';

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('earlier layers win over later ones', () => {
  const merged = mergeSettingsLayers([
    { packageManager: 'bun' },
    { packageManager: 'pnpm', worktreeDir: '/b' },
  ]);
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
  ]);
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
    JSON.stringify({ packageManager: 'yarn', worktree: { baseRef: 'fresh' } })
  );
  setRepoSetting('/repo/.git', 'packageManager', 'pnpm');
  upsertProject('/proj', {});
  setProjectSetting('/proj', 'packageManager', 'bun');

  const merged = resolveSettings({
    projectPath: '/proj',
    gitCommonDir: '/repo/.git',
    repoRoot: tmpHome,
  });
  expect(merged.packageManager).toBe('bun');
  expect(merged.worktree.baseRef).toBe('fresh');
});

// Reported from the field: a committed `worktree.install` silently stopped
// working when 0.9.0 removed the install pipeline. The only symptom was a
// worktree with no dependencies. Removing a setting must break loudly.
test('unknownSettingKeys reports keys rn-iso no longer reads', () => {
  expect(unknownSettingKeys({ packageManager: 'pnpm' })).toEqual(['packageManager']);
  expect(unknownSettingKeys({ worktree: { install: ['pnpm i'] } })).toEqual(['worktree.install']);
});

test('unknownSettingKeys accepts every key that is still honoured', () => {
  expect(unknownSettingKeys({
    ios: { deviceType: 'iPhone 17 Pro', runtime: '26.2' },
    android: { systemImage: 'pkg' },
    worktree: { baseRef: 'fresh', include: ['.env'] },
    worktreeDir: '/tmp/wt',
  })).toEqual([]);
});

test('unknownSettingKeys reports a nested unknown without flagging its parent', () => {
  expect(unknownSettingKeys({ ios: { deviceType: 'x', bogus: 1 } })).toEqual(['ios.bogus']);
});

test('unknownSettingKeys tolerates empty and malformed input', () => {
  expect(unknownSettingKeys({})).toEqual([]);
  expect(unknownSettingKeys(null)).toEqual([]);
  expect(unknownSettingKeys('nope')).toEqual([]);
});

// v3 deleted the `config` CLI, so a committed `.rn-iso.json` is the way an
// array-valued setting is written by hand. These pin that the file's own JSON
// types survive resolution -- there is no parse step left to convert them, so
// a regression here would hand consumers a string where they expect an array.
test('committed caches and device settings resolve with their JSON types intact', () => {
  const repo = mkdtempSync(join(tmpdir(), 'rn-iso-repo-'));
  try {
    writeFileSync(join(repo, '.rn-iso.json'), JSON.stringify({
      caches: ['~/.myapp-metro-cache', '/tmp/build-cache'],
      ios: { deviceType: 'iPhone 17 Pro', runtime: '26.2' },
    }));
    const resolved = resolveSettings({ repoRoot: repo });
    expect(resolved.caches).toEqual(['~/.myapp-metro-cache', '/tmp/build-cache']);
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
