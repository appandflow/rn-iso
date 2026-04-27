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

test('detectIsExpo true when expo is in dependencies', () => {
  assert.equal(detectIsExpo(EXPO_PROJ), true);
});

test('detectIsExpo false when expo is not in dependencies', () => {
  assert.equal(detectIsExpo(BARE_PROJ), false);
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
