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
  sharedCcache,
  sharedCompilationCache,
  sharedGradle,
  sharedPods,
} from '../paths.ts';

describe('workspace paths', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
    process.env.STIM_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test('workspace state lives under STIM_HOME with a readable collision-safe name', () => {
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
    expect(emulatorLogFile(root)).toBe(join(dir, 'logs', 'emulator.log'));
  });

  test('path calculation is pure: no directory is created as a side effect', () => {
    const root = join(tmpdir(), 'stim-nonexistent-xyz');
    workspaceDir(root);
    workspaceLogsDir(root);
    workspaceDerivedData(root);
    workspaceGradleBuild(root);
    supervisorPidFile(root);
    workspaceStateFile(root);
    emulatorLogFile(root);
    expect(existsSync(workspaceDir(root))).toBe(false);
    expect(existsSync(join(root, '.stim'))).toBe(false);
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
    tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
    process.env.STIM_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test('shared caches honour STIM_HOME', () => {
    expect(sharedMetroCache()).toBe(join(tmpHome, 'metro-cache'));
    expect(sharedBuildCache()).toBe(join(tmpHome, 'build-cache'));
    expect(sharedCompilationCache()).toBe(join(tmpHome, 'compilation-cache'));
    expect(sharedCcache()).toBe(join(tmpHome, 'ccache'));
    expect(sharedGradle()).toBe(join(tmpHome, 'gradle'));
    expect(sharedPods()).toBe(join(tmpHome, 'pods'));
  });

  test('shared paths are pure: reading one creates nothing', () => {
    sharedMetroCache();
    sharedBuildCache();
    sharedCompilationCache();
    sharedCcache();
    sharedGradle();
    sharedPods();
    expect(existsSync(join(tmpHome, 'metro-cache'))).toBe(false);
    expect(existsSync(join(tmpHome, 'build-cache'))).toBe(false);
    expect(existsSync(join(tmpHome, 'ccache'))).toBe(false);
  });
});

describe('shared cache roots', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
    process.env.STIM_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
    delete process.env.STIM_METRO_CACHE;
  });

  test('explicit cache env overrides win and remain parent roots', () => {
    process.env.STIM_BUILD_CACHE = '/tmp/custom-build';
    expect(sharedBuildCache()).toBe('/tmp/custom-build');

    process.env.STIM_METRO_CACHE = '/tmp/custom-metro';
    expect(sharedMetroCache()).toBe('/tmp/custom-metro');
    expect(sharedMetroCache('demo')).toBe('/tmp/custom-metro/demo');
    expect(sharedMetroCache('@scope/app')).toBe('/tmp/custom-metro/-scope-app');
  });

  test('a named Metro cache is a subdirectory, and cannot escape the root', () => {
    expect(sharedMetroCache('demo')).toBe(join(tmpHome, 'metro-cache', 'demo'));
    expect(sharedMetroCache('@scope/app')).toBe(join(tmpHome, 'metro-cache', '-scope-app'));
    expect(sharedMetroCache('..')).toBe(join(tmpHome, 'metro-cache', 'app'));
  });
});
