import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  workspaceDir, workspaceLogsDir, workspaceDerivedData, workspaceGradleBuild,
  supervisorPidFile, workspaceStateFile,
  sharedMetroCache, sharedBuildCache, sharedCompilationCache,
  sharedGradle, sharedPods,
} from '../src/paths.js';

describe('workspace paths', () => {
  test('everything workspace-local lives under <root>/.rn-iso', () => {
    assert.strictEqual(workspaceDir('/repo/wt'), '/repo/wt/.rn-iso');
    assert.strictEqual(workspaceLogsDir('/repo/wt'), '/repo/wt/.rn-iso/logs');
    assert.strictEqual(workspaceDerivedData('/repo/wt'), '/repo/wt/.rn-iso/derived-data');
    assert.strictEqual(workspaceGradleBuild('/repo/wt'), '/repo/wt/.rn-iso/gradle-build');
    assert.strictEqual(supervisorPidFile('/repo/wt'), '/repo/wt/.rn-iso/supervisor.pid');
    assert.strictEqual(workspaceStateFile('/repo/wt'), '/repo/wt/.rn-iso/state.json');
  });

  test('paths are pure: no directory is created as a side effect', () => {
    const root = join(tmpdir(), 'rn-iso-nonexistent-xyz');
    workspaceDir(root);
    workspaceLogsDir(root);
    workspaceDerivedData(root);
    workspaceGradleBuild(root);
    supervisorPidFile(root);
    workspaceStateFile(root);
    assert.ok(!existsSync(join(root, '.rn-iso')));
  });
});

describe('shared paths', () => {
  let tmpHome;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
    process.env.RN_ISO_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
  });

  test('shared caches honour RN_ISO_HOME', () => {
    assert.strictEqual(sharedMetroCache(), join(tmpHome, 'metro-cache'));
    assert.strictEqual(sharedBuildCache(), join(tmpHome, 'build-cache'));
    assert.strictEqual(sharedCompilationCache(), join(tmpHome, 'compilation-cache'));
    assert.strictEqual(sharedGradle(), join(tmpHome, 'gradle'));
    assert.strictEqual(sharedPods(), join(tmpHome, 'pods'));
  });

  test('shared paths are pure: reading one creates nothing', () => {
    sharedMetroCache();
    sharedBuildCache();
    sharedCompilationCache();
    sharedGradle();
    sharedPods();
    assert.ok(!existsSync(join(tmpHome, 'metro-cache')));
    assert.ok(!existsSync(join(tmpHome, 'build-cache')));
  });
});

// The two cache packages honoured RN_ISO_BUILD_CACHE and RN_ISO_METRO_CACHE
// before paths.js existed. Taking over the resolution without them would
// silently stop reading an override someone had already set, which reads as an
// empty cache rather than as an error.
describe('shared cache roots', () => {
  let tmpHome;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
    process.env.RN_ISO_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
    delete process.env.RN_ISO_BUILD_CACHE;
    delete process.env.RN_ISO_METRO_CACHE;
  });

  test('the legacy env overrides win over the layout', () => {
    process.env.RN_ISO_BUILD_CACHE = '/tmp/custom-build';
    assert.strictEqual(sharedBuildCache(), '/tmp/custom-build');

    process.env.RN_ISO_METRO_CACHE = '/tmp/custom-metro';
    assert.strictEqual(sharedMetroCache(), '/tmp/custom-metro');
    // The override names one directory, so it wins for a named cache too --
    // otherwise half the stores would move and half would not.
    assert.strictEqual(sharedMetroCache('demo'), '/tmp/custom-metro');
  });

  test('a named Metro cache is a subdirectory, and cannot escape the root', () => {
    assert.strictEqual(sharedMetroCache('demo'), join(tmpHome, 'metro-cache', 'demo'));
    assert.strictEqual(sharedMetroCache('@scope/app'), join(tmpHome, 'metro-cache', '-scope-app'));
    assert.strictEqual(sharedMetroCache('..'), join(tmpHome, 'metro-cache', 'app'));
  });
});
