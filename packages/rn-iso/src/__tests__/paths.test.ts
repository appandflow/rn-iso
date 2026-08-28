import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  emulatorLogFile,
  ensureWorkspaceStorage,
  workspaceDir,
  workspaceId,
  workspaceLogsDir,
  workspaceMetadataFile,
  workspaceName,
  workspaceSlug,
  workspaceDerivedData,
  workspaceGradleBuild,
  supervisorPidFile,
  workspaceStateFile,
  sharedMetroCache,
  sharedBuildCache,
  sharedCompilationCache,
  sharedGradle,
  sharedPods,
} from '../paths.ts';

describe('workspace paths', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
    process.env.RN_ISO_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
  });

  test('workspace state lives under RN_ISO_HOME with a readable collision-safe name', () => {
    const root = '/repo/My App';
    const dir = join(tmpHome, 'workspaces', workspaceName(root));
    expect(workspaceSlug(root)).toBe('my-app');
    expect(workspaceId(root)).toMatch(/^[a-f0-9]{16}$/);
    expect(workspaceName(root)).toBe(`my-app--${workspaceId(root)}`);
    expect(workspaceDir(root)).toBe(dir);
    expect(workspaceLogsDir(root)).toBe(join(dir, 'logs'));
    expect(workspaceDerivedData(root)).toBe(join(dir, 'derived-data'));
    expect(workspaceGradleBuild(root)).toBe(join(dir, 'gradle-build'));
    expect(supervisorPidFile(root)).toBe(join(dir, 'supervisor.pid'));
    expect(workspaceStateFile(root)).toBe(join(dir, 'state.json'));
    // NOT .ndjson: the k-way merge in logs-query must never try to parse the
    // emulator's raw stdio.
    expect(emulatorLogFile(root)).toBe(join(dir, 'logs', 'emulator.log'));
  });

  test('path calculation is pure: no directory is created as a side effect', () => {
    const root = join(tmpdir(), 'rn-iso-nonexistent-xyz');
    workspaceDir(root);
    workspaceLogsDir(root);
    workspaceDerivedData(root);
    workspaceGradleBuild(root);
    supervisorPidFile(root);
    workspaceStateFile(root);
    emulatorLogFile(root);
    expect(existsSync(workspaceDir(root))).toBe(false);
    expect(existsSync(join(root, '.rn-iso'))).toBe(false);
  });

  test('same basename at different paths is readable and collision-safe', () => {
    expect(workspaceSlug('/one/mobile')).toBe('mobile');
    expect(workspaceSlug('/two/mobile')).toBe('mobile');
    expect(workspaceName('/one/mobile')).not.toBe(workspaceName('/two/mobile'));
  });

  test('ensureWorkspaceStorage records ownership and refuses a mismatched record', () => {
    const root = join(tmpdir(), 'Readable App');
    expect(ensureWorkspaceStorage(root)).toBe(workspaceDir(root));
    expect(JSON.parse(readFileSync(workspaceMetadataFile(root), 'utf-8'))).toEqual({
      projectRoot: root,
      workspace: workspaceName(root),
      version: 1,
    });

    writeFileSync(workspaceMetadataFile(root), '{"projectRoot":"/somewhere/else"}\n');
    expect(() => ensureWorkspaceStorage(root)).toThrow(/workspace collision/);
  });
});

describe('shared paths', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
    process.env.RN_ISO_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.RN_ISO_HOME;
  });

  test('shared caches honour RN_ISO_HOME', () => {
    expect(sharedMetroCache()).toBe(join(tmpHome, 'metro-cache'));
    expect(sharedBuildCache()).toBe(join(tmpHome, 'build-cache'));
    expect(sharedCompilationCache()).toBe(join(tmpHome, 'compilation-cache'));
    expect(sharedGradle()).toBe(join(tmpHome, 'gradle'));
    expect(sharedPods()).toBe(join(tmpHome, 'pods'));
  });

  test('shared paths are pure: reading one creates nothing', () => {
    sharedMetroCache();
    sharedBuildCache();
    sharedCompilationCache();
    sharedGradle();
    sharedPods();
    expect(existsSync(join(tmpHome, 'metro-cache'))).toBe(false);
    expect(existsSync(join(tmpHome, 'build-cache'))).toBe(false);
  });
});

// The two cache packages honoured RN_ISO_BUILD_CACHE and RN_ISO_METRO_CACHE
// before paths.ts existed. Taking over the resolution without them would
// silently stop reading an override someone had already set, which reads as an
// empty cache rather than as an error.
describe('shared cache roots', () => {
  let tmpHome: string;
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

  test('explicit cache env overrides win over the layout', () => {
    process.env.RN_ISO_BUILD_CACHE = '/tmp/custom-build';
    expect(sharedBuildCache()).toBe('/tmp/custom-build');

    process.env.RN_ISO_METRO_CACHE = '/tmp/custom-metro';
    expect(sharedMetroCache()).toBe('/tmp/custom-metro');
    // The override names one directory, so it wins for a named cache too --
    // otherwise half the stores would move and half would not.
    expect(sharedMetroCache('demo')).toBe('/tmp/custom-metro');
  });

  test('a named Metro cache is a subdirectory, and cannot escape the root', () => {
    expect(sharedMetroCache('demo')).toBe(join(tmpHome, 'metro-cache', 'demo'));
    expect(sharedMetroCache('@scope/app')).toBe(join(tmpHome, 'metro-cache', '-scope-app'));
    expect(sharedMetroCache('..')).toBe(join(tmpHome, 'metro-cache', 'app'));
  });
});
