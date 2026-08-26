import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeSettingsLayers, readCommittedSettings, resolveSettings, unknownSettingKeys } from '../src/settings.ts';
import { setProjectSetting, setRepoSetting, upsertProject } from '../src/config.ts';

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
  assert.deepEqual(merged, { packageManager: 'bun', worktreeDir: '/b' });
});

test('merges nested objects key by key rather than replacing them', () => {
  const merged = mergeSettingsLayers([
    { worktree: { baseRef: 'head' } },
    { worktree: { baseRef: 'fresh', install: ['pnpm install'] } },
  ]);
  assert.deepEqual(merged, { worktree: { baseRef: 'head', install: ['pnpm install'] } });
});

test('ignores null and undefined layers', () => {
  assert.deepEqual(mergeSettingsLayers([null, { a: 1 }, undefined]), { a: 1 });
});

test('an array value is replaced wholesale, not concatenated', () => {
  const merged = mergeSettingsLayers([
    { worktree: { install: ['a'] } },
    { worktree: { install: ['b', 'c'] } },
  ]);
  assert.deepEqual(merged.worktree.install, ['a']);
});

test('readCommittedSettings reads .rn-iso.json', () => {
  writeFileSync(join(tmpHome, '.rn-iso.json'), JSON.stringify({ packageManager: 'yarn' }));
  assert.deepEqual(readCommittedSettings(tmpHome), { packageManager: 'yarn' });
});

test('readCommittedSettings returns empty for missing or malformed files', () => {
  assert.deepEqual(readCommittedSettings(tmpHome), {});
  writeFileSync(join(tmpHome, '.rn-iso.json'), '{ not json');
  assert.deepEqual(readCommittedSettings(tmpHome), {});
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
  assert.equal(merged.packageManager, 'bun');
  assert.equal(merged.worktree.baseRef, 'fresh');
});

// Reported from the field: a committed `worktree.install` silently stopped
// working when 0.9.0 removed the install pipeline. The only symptom was a
// worktree with no dependencies. Removing a setting must break loudly.
test('unknownSettingKeys reports keys rn-iso no longer reads', () => {
  assert.deepEqual(unknownSettingKeys({ packageManager: 'pnpm' }), ['packageManager']);
  assert.deepEqual(unknownSettingKeys({ worktree: { install: ['pnpm i'] } }), ['worktree.install']);
});

test('unknownSettingKeys accepts every key that is still honoured', () => {
  assert.deepEqual(unknownSettingKeys({
    ios: { deviceType: 'iPhone 17 Pro', runtime: '26.2' },
    android: { systemImage: 'pkg' },
    worktree: { baseRef: 'fresh', include: ['.env'] },
    worktreeDir: '/tmp/wt',
  }), []);
});

test('unknownSettingKeys reports a nested unknown without flagging its parent', () => {
  assert.deepEqual(unknownSettingKeys({ ios: { deviceType: 'x', bogus: 1 } }), ['ios.bogus']);
});

test('unknownSettingKeys tolerates empty and malformed input', () => {
  assert.deepEqual(unknownSettingKeys({}), []);
  assert.deepEqual(unknownSettingKeys(null), []);
  assert.deepEqual(unknownSettingKeys('nope'), []);
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
    assert.deepEqual(resolved.caches, ['~/.myapp-metro-cache', '/tmp/build-cache']);
    assert.equal(resolved.ios.deviceType, 'iPhone 17 Pro');
    assert.equal(resolved.ios.runtime, '26.2');
    assert.deepEqual(unknownSettingKeys(resolved), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a repo-layer array setting survives resolution as an array', () => {
  setRepoSetting('/repo/.git', 'caches', ['~/.myapp-metro-cache', '/tmp/build-cache']);
  const resolved = resolveSettings({ gitCommonDir: '/repo/.git' });
  assert.deepEqual(resolved.caches, ['~/.myapp-metro-cache', '/tmp/build-cache']);
});
