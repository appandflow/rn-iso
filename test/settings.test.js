import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeSettingsLayers, readCommittedSettings, resolveSettings, unknownSettingKeys } from '../src/settings.js';
import { setProjectSetting, setRepoSetting, upsertProject } from '../src/config.js';

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
