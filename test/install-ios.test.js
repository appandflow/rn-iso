import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import { findRecentAppByBundleId, installOnSim, launchOnSim } from '../src/install/ios.js';

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rn-iso-dd-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  resetExecutor();
});

function mkApp(rel, bundleId, mtimeMs) {
  const appDir = join(tmpRoot, rel);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'Info.plist'), `BINARY_PLIST_PLACEHOLDER:${bundleId}`);
  if (mtimeMs) {
    const t = mtimeMs / 1000;
    utimesSync(appDir, t, t);
  }
  return appDir;
}

test('findRecentAppByBundleId returns the most recent matching app', () => {
  const olderApp = mkApp('Build/Products/Debug-iphonesimulator/MyApp.app', 'com.foo.app', Date.now() - 60 * 1000);
  const newerApp = mkApp('NewerProj-abc/Build/Products/Debug-iphonesimulator/MyApp.app', 'com.foo.app', Date.now() - 1000);
  // Mock plutil so it returns the bundleId we baked into Info.plist
  setExecutor({
    run: (cmd) => { throw new Error('not used'); },
    runQuiet: (cmd) => {
      const m = cmd.match(/"([^"]+)"$/);
      if (!m) return null;
      const path = m[1];
      const text = readFileSync(path, 'utf-8');
      const bid = text.split(':')[1];
      return bid || null;
    },
    spawn: () => null,
  });
  const found = findRecentAppByBundleId('com.foo.app', { root: tmpRoot });
  assert.equal(found, newerApp);
});

test('findRecentAppByBundleId ignores apps with mismatched bundle id', () => {
  mkApp('Build/Products/Debug-iphonesimulator/Other.app', 'com.other.app', Date.now() - 1000);
  setExecutor({
    run: () => { throw new Error('not used'); },
    runQuiet: (cmd) => {
      const m = cmd.match(/"([^"]+)"$/);
      if (!m) return null;
      const text = readFileSync(m[1], 'utf-8');
      return text.split(':')[1];
    },
    spawn: () => null,
  });
  const found = findRecentAppByBundleId('com.foo.app', { root: tmpRoot });
  assert.equal(found, null);
});

test('findRecentAppByBundleId ignores apps older than maxAgeMs', () => {
  mkApp('Build/Products/Debug-iphonesimulator/MyApp.app', 'com.foo.app', Date.now() - 10 * 60 * 1000);
  setExecutor({
    run: () => { throw new Error('not used'); },
    runQuiet: (cmd) => {
      const m = cmd.match(/"([^"]+)"$/);
      if (!m) return null;
      const text = readFileSync(m[1], 'utf-8');
      return text.split(':')[1];
    },
    spawn: () => null,
  });
  const found = findRecentAppByBundleId('com.foo.app', { root: tmpRoot, maxAgeMs: 60 * 1000 });
  assert.equal(found, null);
});

test('findRecentAppByBundleId returns null when DerivedData root does not exist', () => {
  const found = findRecentAppByBundleId('com.foo.app', { root: '/no/such/path' });
  assert.equal(found, null);
});

test('installOnSim shells out to xcrun simctl install with the udid and path', () => {
  let captured;
  setExecutor({
    run: (cmd) => { captured = cmd; return ''; },
    runQuiet: () => null,
    spawn: () => null,
  });
  installOnSim('UDID-1', '/tmp/MyApp.app');
  assert.equal(captured, 'xcrun simctl install UDID-1 "/tmp/MyApp.app"');
});

test('launchOnSim terminates first then launches', () => {
  const calls = [];
  setExecutor({
    run: (cmd) => { calls.push({ kind: 'run', cmd }); return ''; },
    runQuiet: (cmd) => { calls.push({ kind: 'runQuiet', cmd }); return null; },
    spawn: () => null,
  });
  launchOnSim('UDID-1', 'com.foo.app');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'runQuiet');
  assert.match(calls[0].cmd, /simctl terminate UDID-1 com\.foo\.app/);
  assert.equal(calls[1].kind, 'run');
  assert.match(calls[1].cmd, /simctl launch UDID-1 com\.foo\.app/);
});
