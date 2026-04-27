import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../src/exec.js';
import {
  buildIosCommand,
  buildAndroidCommand,
  buildMetroCommand,
  buildScriptCommand,
  detectPackageManager,
  detectScriptCli,
  findLockfile,
  getProjectScript,
  resolveSimNameByUdid,
} from '../src/runner.js';

let tmpProj;

function makeProj(files) {
  tmpProj = mkdtempSync(join(tmpdir(), 'rn-iso-runner-'));
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(tmpProj, rel);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, content);
  }
  return tmpProj;
}

afterEach(() => {
  if (tmpProj) rmSync(tmpProj, { recursive: true, force: true });
  tmpProj = null;
  resetExecutor();
});

// ---- Direct CLI fallback (no script) ----

test('buildIosCommand expo fallback uses --device with UDID', () => {
  const root = makeProj({ 'package.json': '{}' });
  const cmd = buildIosCommand({ projectRoot: root, packageManager: 'npm', scriptName: 'ios', isExpo: true, udid: 'UDID-1', port: 8083, useScript: false });
  assert.equal(cmd, 'npx expo run:ios --device UDID-1 --port 8083');
});

test('buildIosCommand bare fallback uses --udid (not --simulator)', () => {
  const root = makeProj({ 'package.json': '{}' });
  const cmd = buildIosCommand({ projectRoot: root, packageManager: 'npm', scriptName: 'ios', isExpo: false, udid: 'UDID-1', port: 8083, useScript: false });
  assert.equal(cmd, 'npx react-native run-ios --udid UDID-1 --port 8083');
});

test('buildAndroidCommand expo fallback uses --device serial', () => {
  const root = makeProj({ 'package.json': '{}' });
  const cmd = buildAndroidCommand({ projectRoot: root, packageManager: 'npm', scriptName: 'android', isExpo: true, serial: 'emulator-5554', port: 8083, useScript: false });
  assert.equal(cmd, 'npx expo run:android --device emulator-5554 --port 8083');
});

test('buildAndroidCommand bare fallback uses --deviceId and RCT_METRO_PORT', () => {
  const root = makeProj({ 'package.json': '{}' });
  const cmd = buildAndroidCommand({ projectRoot: root, packageManager: 'npm', scriptName: 'android', isExpo: false, serial: 'emulator-5554', port: 8083, useScript: false });
  assert.equal(cmd, 'RCT_METRO_PORT=8083 npx react-native run-android --deviceId emulator-5554');
});

// ---- Script-based path ----

test('buildIosCommand uses npm script with -- separator and --udid for RN script', () => {
  const root = makeProj({
    'package.json': JSON.stringify({ scripts: { ios: 'react-native run-ios --simulator="iPhone 16 Pro"' } }),
  });
  const cmd = buildIosCommand({ projectRoot: root, packageManager: 'npm', scriptName: 'ios', isExpo: false, udid: 'UDID-1', port: 8083 });
  assert.equal(cmd, 'npm run ios -- --udid UDID-1 --port 8083');
});

test('buildIosCommand uses yarn script (no -- separator) and --udid for RN script', () => {
  const root = makeProj({
    'package.json': JSON.stringify({ scripts: { ios: 'react-native run-ios' } }),
  });
  const cmd = buildIosCommand({ projectRoot: root, packageManager: 'yarn', scriptName: 'ios', isExpo: false, udid: 'UDID-1', port: 8083 });
  assert.equal(cmd, 'yarn ios --udid UDID-1 --port 8083');
});

test('buildIosCommand uses --device flag for expo script', () => {
  const root = makeProj({
    'package.json': JSON.stringify({ scripts: { ios: 'expo run:ios' } }),
  });
  const cmd = buildIosCommand({ projectRoot: root, packageManager: 'pnpm', scriptName: 'ios', isExpo: true, udid: 'UDID-1', port: 8083 });
  assert.equal(cmd, 'pnpm ios --device UDID-1 --port 8083');
});

test('buildIosCommand falls back to direct CLI when script does not exist', () => {
  const root = makeProj({
    'package.json': JSON.stringify({ scripts: { build: 'echo' } }),
  });
  const cmd = buildIosCommand({ projectRoot: root, packageManager: 'npm', scriptName: 'ios', isExpo: false, udid: 'UDID-1', port: 8083 });
  assert.equal(cmd, 'npx react-native run-ios --udid UDID-1 --port 8083');
});

test('buildAndroidCommand uses script via bun and --deviceId for RN script', () => {
  const root = makeProj({
    'package.json': JSON.stringify({ scripts: { android: 'react-native run-android' } }),
  });
  const cmd = buildAndroidCommand({ projectRoot: root, packageManager: 'bun', scriptName: 'android', isExpo: false, serial: 'emulator-5554', port: 8083 });
  assert.equal(cmd, 'bun run android --deviceId emulator-5554 --port 8083');
});

// ---- Helpers ----

test('detectPackageManager picks based on lockfile', () => {
  const yarnRoot = makeProj({ 'yarn.lock': '' });
  assert.equal(detectPackageManager(yarnRoot), 'yarn');
  rmSync(yarnRoot, { recursive: true });

  const pnpmRoot = makeProj({ 'pnpm-lock.yaml': '' });
  assert.equal(detectPackageManager(pnpmRoot), 'pnpm');
  rmSync(pnpmRoot, { recursive: true });

  const bunRoot = makeProj({ 'bun.lock': '' });
  assert.equal(detectPackageManager(bunRoot), 'bun');
  rmSync(bunRoot, { recursive: true });

  const npmRoot = makeProj({ 'package-lock.json': '' });
  assert.equal(detectPackageManager(npmRoot), 'npm');
  rmSync(npmRoot, { recursive: true });

  const noLock = makeProj({ 'package.json': '{}' });
  assert.equal(detectPackageManager(noLock), 'npm'); // default
});

test('detectPackageManager walks up to find lockfile in monorepo root', () => {
  // Layout:
  //   /tmp/.../    <-- yarn.lock here (workspace root)
  //   /tmp/.../apps/mobile/  <-- our "project" (no lockfile of its own)
  const root = makeProj({
    'yarn.lock': '',
    'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
    'apps/mobile/package.json': JSON.stringify({ name: 'mobile' }),
  });
  const projectRoot = join(root, 'apps/mobile');
  assert.equal(detectPackageManager(projectRoot), 'yarn');
});

test('findLockfile returns the lockfile dir and pm', () => {
  const root = makeProj({
    'pnpm-lock.yaml': '',
    'apps/mobile/package.json': '{}',
  });
  const found = findLockfile(join(root, 'apps/mobile'));
  assert.equal(found.pm, 'pnpm');
  assert.equal(found.dir, root);
});

test('findLockfile prefers nearest lockfile when nested ones exist', () => {
  // Some monorepos intentionally have nested lockfiles per package; pick the
  // closest one, not the workspace root's.
  const root = makeProj({
    'yarn.lock': '',
    'apps/mobile/pnpm-lock.yaml': '',
    'apps/mobile/package.json': '{}',
  });
  const found = findLockfile(join(root, 'apps/mobile'));
  assert.equal(found.pm, 'pnpm');
  assert.equal(found.dir, join(root, 'apps/mobile'));
});

test('detectScriptCli identifies expo, react-native, or unknown', () => {
  assert.equal(detectScriptCli('expo run:ios'), 'expo');
  assert.equal(detectScriptCli('npx expo run:ios'), 'expo');
  assert.equal(detectScriptCli('react-native run-ios --simulator x'), 'react-native');
  assert.equal(detectScriptCli('npx react-native start'), 'react-native');
  assert.equal(detectScriptCli('echo hello'), 'unknown');
  assert.equal(detectScriptCli(''), 'unknown');
});

test('getProjectScript reads scripts from package.json', () => {
  const root = makeProj({
    'package.json': JSON.stringify({ scripts: { ios: 'react-native run-ios' } }),
  });
  assert.equal(getProjectScript(root, 'ios'), 'react-native run-ios');
  assert.equal(getProjectScript(root, 'missing'), null);
});

test('buildScriptCommand uses the right convention per package manager', () => {
  assert.equal(buildScriptCommand('npm', 'ios', ['--udid X', '--port 8083']), 'npm run ios -- --udid X --port 8083');
  assert.equal(buildScriptCommand('yarn', 'ios', ['--udid X']), 'yarn ios --udid X');
  assert.equal(buildScriptCommand('pnpm', 'ios', ['--udid X']), 'pnpm ios --udid X');
  assert.equal(buildScriptCommand('bun', 'ios', ['--udid X']), 'bun run ios --udid X');
  assert.equal(buildScriptCommand('npm', 'ios', []), 'npm run ios');
});

// ---- Existing helpers retained ----

test('buildMetroCommand picks expo or react-native', () => {
  assert.equal(buildMetroCommand({ isExpo: true, port: 8083 }), 'npx expo start --port 8083');
  assert.equal(buildMetroCommand({ isExpo: false, port: 8083 }), 'npx react-native start --port 8083');
});

test('resolveSimNameByUdid returns name from simctl JSON', () => {
  setExecutor({
    run: () => JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
          { udid: 'UDID-1', name: 'iPhone 15', state: 'Booted', isAvailable: true },
        ],
      },
    }),
    runQuiet: () => null,
    spawn: () => null,
  });
  assert.equal(resolveSimNameByUdid('UDID-1'), 'iPhone 15');
});
