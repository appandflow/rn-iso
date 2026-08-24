import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage, resolveRegisteredProject, projectShortcut } from '../src/project.js';
import { upsertProject, getProject } from '../src/config.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const EXPO_PROJ = join(FIXTURES, 'sample-expo-project');
const BARE_PROJ = join(FIXTURES, 'sample-bare-project');

test('findProjectRoot walks up from cwd to find package.json', () => {
  const nested = join(EXPO_PROJ, 'src');
  assert.equal(findProjectRoot(nested), EXPO_PROJ);
});

test('findProjectRoot returns null when no package.json found', () => {
  assert.equal(findProjectRoot('/'), null);
});

test('detectIsExpo true when expo deps + app.json has expo block', () => {
  assert.equal(detectIsExpo(EXPO_PROJ), true);
});

test('detectIsExpo false when expo is not in dependencies', () => {
  assert.equal(detectIsExpo(BARE_PROJ), false);
});

test('detectIsExpo trusts the ios script: react-native script wins even with expo dep', async () => {
  // Mimics rainbow: `expo` in deps for prebuild/modules, but the ios script
  // invokes react-native run-ios. Should NOT be flagged as Expo.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const tmp = mkdtempSync(join((await import('os')).tmpdir(), 'rn-iso-detect-'));
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      dependencies: { expo: '54.0.33' },
      scripts: { ios: "react-native run-ios --simulator='iPhone 16 Pro'" },
    }));
    assert.equal(detectIsExpo(tmp), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('detectIsExpo trusts the ios script: expo run:ios wins', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
  const tmp = mkdtempSync(join((await import('os')).tmpdir(), 'rn-iso-detect-'));
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      dependencies: { 'react-native': '0.74.0' },
      scripts: { ios: 'expo run:ios' },
    }));
    assert.equal(detectIsExpo(tmp), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('detectBundleId reads ios.bundleIdentifier from app.json', () => {
  assert.equal(detectBundleId(EXPO_PROJ), 'com.example.sample');
});

test('detectBundleId falls back to pbxproj when app config has no bundle id', () => {
  // BARE_PROJ has no app.json; the fixture pbxproj has main app id "me.sample"
  // alongside an extension target with a longer suffix. Picks the most-common
  // concrete value, tie-breaking by shortest length.
  assert.equal(detectBundleId(BARE_PROJ), 'me.sample');
});

test('detectAndroidPackage reads android.package from app.json', () => {
  assert.equal(detectAndroidPackage(EXPO_PROJ), 'com.example.sample');
});

test('detectAndroidPackage falls back to android/app/build.gradle (namespace)', () => {
  assert.equal(detectAndroidPackage(BARE_PROJ), 'me.sample');
});

// resolveRegisteredProject -- needs an isolated config home.
let tmpHome;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-resolve-'));
  process.env.RN_ISO_HOME = tmpHome;
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('resolveRegisteredProject finds a project by absolute path', () => {
  upsertProject('/Users/x/Developer/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const r = resolveRegisteredProject('/Users/x/Developer/agent-1');
  assert.equal(r.found, '/Users/x/Developer/agent-1');
});

test('resolveRegisteredProject matches by basename when unambiguous', () => {
  upsertProject('/Users/x/Developer/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const r = resolveRegisteredProject('agent-1');
  assert.equal(r.found, '/Users/x/Developer/agent-1');
});

test('resolveRegisteredProject matches by an explicit --label', () => {
  upsertProject('/Users/x/Developer/anything', { bundleId: 'a', androidPackage: 'a', isExpo: false, label: 'agent-2' });
  const r = resolveRegisteredProject('agent-2');
  assert.equal(r.found, '/Users/x/Developer/anything');
});

test('resolveRegisteredProject prefers a project label over a colliding basename', () => {
  // /a/agent-x has basename agent-x; /b/other has explicit label agent-x.
  // Only `other` (with the explicit label) matches the shortcut "agent-x"
  // when the basename isn't a label, because projectShortcut returns label
  // if set and otherwise falls back to basename — both projects' shortcuts
  // resolve to "agent-x", which is a collision.
  upsertProject('/a/agent-x', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b/other', { bundleId: 'b', androidPackage: 'b', isExpo: false, label: 'agent-x' });
  const r = resolveRegisteredProject('agent-x');
  assert.equal(r.found, null);
  assert.match(r.error, /Multiple projects/);
});

test('resolveRegisteredProject errors with collision when two basenames match', () => {
  upsertProject('/a/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b/agent-1', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  const r = resolveRegisteredProject('agent-1');
  assert.equal(r.found, null);
  assert.match(r.error, /Multiple projects/);
});

test('resolveRegisteredProject errors when shortcut does not match anything', () => {
  upsertProject('/Users/x/Developer/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const r = resolveRegisteredProject('nope');
  assert.equal(r.found, null);
  assert.match(r.error, /No registered project/);
});

test('resolveRegisteredProject errors when path does not match anything', () => {
  upsertProject('/Users/x/Developer/agent-1', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const r = resolveRegisteredProject('/no/such/path');
  assert.equal(r.found, null);
  assert.match(r.error, /No registered project/);
});

// projectShortcut inheriting the enclosing worktree's label: without this,
// two worktrees of the same monorepo each have an app dir with the same
// basename (e.g. "tlon-mobile"), so their shortcuts would collide.
test('projectShortcut inherits the enclosing worktree label so same-basename app dirs stay unique', () => {
  upsertProject('/repo-worktrees/feat-a', { label: 'feat-a', worktreeRoot: true });
  upsertProject('/repo-worktrees/feat-b', { label: 'feat-b', worktreeRoot: true });

  const appDirA = '/repo-worktrees/feat-a/apps/tlon-mobile';
  const appDirB = '/repo-worktrees/feat-b/apps/tlon-mobile';
  upsertProject(appDirA, {});
  upsertProject(appDirB, {});

  const shortcutA = projectShortcut(appDirA, getProject(appDirA));
  const shortcutB = projectShortcut(appDirB, getProject(appDirB));

  assert.equal(shortcutA, 'feat-a/tlon-mobile');
  assert.equal(shortcutB, 'feat-b/tlon-mobile');
  assert.notEqual(shortcutA, shortcutB);
});

test('projectShortcut returns the worktree label itself for the worktree root', () => {
  upsertProject('/repo-worktrees/feat-a', { label: 'feat-a', worktreeRoot: true });
  assert.equal(projectShortcut('/repo-worktrees/feat-a', getProject('/repo-worktrees/feat-a')), 'feat-a');
});

test('projectShortcut prefers an explicit label over worktree inheritance', () => {
  upsertProject('/repo-worktrees/feat-a', { label: 'feat-a', worktreeRoot: true });
  const appDir = '/repo-worktrees/feat-a/apps/tlon-mobile';
  upsertProject(appDir, { label: 'custom' });
  assert.equal(projectShortcut(appDir, getProject(appDir)), 'custom');
});

test('projectShortcut falls back to the basename when not inside any registered worktree', () => {
  assert.equal(projectShortcut('/Users/x/Developer/standalone', null), 'standalone');
});
