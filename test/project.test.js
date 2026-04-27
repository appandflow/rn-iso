import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'path';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../src/project.js';

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
