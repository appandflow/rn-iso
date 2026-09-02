import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, utimesSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getConfigDir,
  loadConfig,
  saveConfig,
  ensureConfig,
  withConfigLock,
  claimMetroPort,
  getProject,
  upsertProject,
  removeProject,
  setDevice,
  releaseAndroidConsolePort,
  clearDevice,
  allMetroPorts,
  allConsolePortsAndSerials,
  getProjectSettings,
  getProjectSetting,
  setProjectSetting,
  unsetProjectSetting,
  getRepoSettings,
  setRepoSetting,
  unsetRepoSetting,
  getConcurrencyLimits,
  metroStoreInjectionEnabled,
} from '../config.ts';
import { makeConfig } from './_factories.ts';
import assert from 'node:assert';

let tmpHome: string;

function liveProjectDir(name: string) {
  const dir = join(tmpHome, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('getConfigDir respects STIM_HOME', () => {
  expect(getConfigDir()).toBe(tmpHome);
});

test('loadConfig returns null when no file exists', () => {
  expect(loadConfig()).toBe(null);
});

test('ensureConfig creates and returns empty config', () => {
  const cfg = ensureConfig();
  expect(cfg).toEqual({ version: 2, projects: {}, repos: {} });
  expect(existsSync(join(tmpHome, 'config.json'))).toBeTruthy();
});

test('saveConfig + loadConfig roundtrip', () => {
  saveConfig(makeConfig({ version: 1, projects: { '/foo': { metroPort: 8082, platforms: {} } } }));
  const cfg = loadConfig();
  assert(cfg);
  assert(cfg.projects['/foo']);
  expect(cfg.projects['/foo'].metroPort).toBe(8082);
});

test('loadConfig reports a corrupt config by path instead of throwing a raw SyntaxError', () => {
  writeFileSync(join(tmpHome, 'config.json'), '{"projects": {"/a": ');
  let err: unknown;
  try {
    loadConfig();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/not valid JSON/);
  expect((err as Error).message).toMatch(/config\.json/);
  expect((err as Error).constructor.name).not.toMatch(/SyntaxError/);
});

test('loadConfig keeps a corrupt config on disk rather than resetting it', () => {
  const p = join(tmpHome, 'config.json');
  writeFileSync(p, 'not json at all');
  expect(() => loadConfig()).toThrow(/not valid JSON/);
  expect(readFileSync(p, 'utf-8')).toBe('not json at all');
});

test('saveConfig writes through a temp file and leaves none behind', () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  const strays = readdirSync(tmpHome).filter((name) => name.endsWith('.tmp'));
  expect(strays).toEqual([]);
  expect(loadConfig()).toEqual({ version: 2, projects: {}, repos: {} });
});

test('withConfigLock is reentrant, so nested mutators cannot deadlock', () => {
  const result = withConfigLock(() => {
    upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
    claimMetroPort('/p', 8082);
    const proj = getProject('/p');
    assert(proj);
    return proj.metroPort;
  });
  expect(result).toBe(8082);
  expect(existsSync(join(tmpHome, 'config.lock'))).toBe(false);
});

test('withConfigLock releases the lock when the body throws', () => {
  expect(() =>
    withConfigLock(() => {
      throw new Error('boom');
    }),
  ).toThrow(/boom/);
  expect(existsSync(join(tmpHome, 'config.lock'))).toBe(false);
  expect(withConfigLock(() => 'ok')).toBe('ok');
});

test('withConfigLock takes over a stale lock left by a dead process', () => {
  const lock = join(tmpHome, 'config.lock');
  mkdirSync(lock);
  const longAgo = new Date(Date.now() - 60000);
  utimesSync(lock, longAgo, longAgo);
  expect(withConfigLock(() => 'taken over')).toBe('taken over');
  expect(existsSync(lock)).toBe(false);
});

test('concurrent processes each keep their record', async () => {
  const script = join(tmpHome, 'writer.mjs');
  const configUrl = new URL('../config.ts', import.meta.url).href;
  writeFileSync(
    script,
    [
      `const { upsertProject } = await import(${JSON.stringify(configUrl)});`,
      'const key = process.argv[2];',
      'upsertProject(key, { bundleId: key, androidPackage: key, isExpo: false });',
    ].join('\n'),
  );

  const keys = ['/p1', '/p2', '/p3', '/p4', '/p5', '/p6'];
  await Promise.all(
    keys.map(
      (key) =>
        new Promise<void>((resolve, reject) => {
          execFile(process.execPath, [script, key], { env: { ...process.env, STIM_HOME: tmpHome } }, (err) =>
            err ? reject(err) : resolve(),
          );
        }),
    ),
  );

  const cfg = loadConfig();
  assert(cfg);
  for (const key of keys) {
    expect(cfg.projects[key]).toBeTruthy();
  }
});

test('claimMetroPort records the port when nothing else holds it', () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  expect(claimMetroPort('/a', 8082)).toBe(8082);
  const a = getProject('/a');
  assert(a);
  expect(a.metroPort).toBe(8082);
});

test('claimMetroPort refuses a port another project claimed first', () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  expect(claimMetroPort('/a', 8082)).toBe(8082);
  expect(claimMetroPort('/b', 8082)).toBe(null);
  const b = getProject('/b');
  assert(b);
  expect(b.metroPort).toBe(null);
});

test("claimMetroPort re-claiming a project's own port is not a conflict", () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  expect(claimMetroPort('/a', 8082)).toBe(8082);
});

test('upsertProject creates a new project entry with defaults', () => {
  const proj = upsertProject('/abs/path', {
    bundleId: 'com.foo',
    androidPackage: 'com.foo',
    isExpo: true,
  });
  expect(proj.bundleId).toBe('com.foo');
  expect(proj.metroPort).toBe(null);
  expect(proj.platforms).toEqual({});
});

test('upsertProject preserves existing fields when called again', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  claimMetroPort('/p', 8082);
  upsertProject('/p', { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  const proj = getProject('/p');
  assert(proj);
  expect(proj.bundleId).toBe('com.b');
  expect(proj.metroPort).toBe(8082);
});

test('setDevice and clearDevice mutate platforms', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice('/p', 'ios', { deviceUdid: 'ABC' });
  const proj = getProject('/p');
  assert(proj?.platforms?.ios);
  expect(proj.platforms.ios.deviceUdid).toBe('ABC');
  clearDevice('/p', 'ios');
  const cleared = getProject('/p');
  assert(cleared);
  expect(cleared.platforms?.ios).toBe(undefined);
});

test('allMetroPorts collects ports from all projects', () => {
  upsertProject('/a', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  upsertProject('/b', { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  claimMetroPort('/a', 8082);
  claimMetroPort('/b', 8083);
  expect(allMetroPorts().toSorted()).toEqual([8082, 8083]);
});

test('allConsolePortsAndSerials collects android console ports across projects', () => {
  const a = liveProjectDir('a');
  const b = liveProjectDir('b');
  upsertProject(a, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  upsertProject(b, { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  setDevice(a, 'android', { avdName: 'Pixel_5', consolePort: 5556 });
  setDevice(b, 'android', { avdName: 'Pixel_6', consolePort: 5554 });
  const result = allConsolePortsAndSerials();
  expect(result.androidConsolePorts.toSorted()).toEqual([5554, 5556]);
});

test('allConsolePortsAndSerials collects physical serials (no avdName)', () => {
  const a = liveProjectDir('a');
  upsertProject(a, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice(a, 'android', { serial: 'R5CR70XXXXX' });
  const result = allConsolePortsAndSerials();
  expect(result.androidPhysicalSerials).toEqual(['R5CR70XXXXX']);
});

test('releaseAndroidConsolePort frees the claimed port and keeps the AVD recorded for gc', () => {
  const a = liveProjectDir('a');
  upsertProject(a, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice(a, 'android', { avdName: 'stim-a', consolePort: 5554, owned: true, deviceName: 'stim-a' });
  expect(releaseAndroidConsolePort(a, 5554)).toBe(true);
  expect(getProject(a)?.platforms?.android).toEqual({ avdName: 'stim-a', owned: true, deviceName: 'stim-a' });
  expect(allConsolePortsAndSerials().androidConsolePorts).toEqual([]);
});

test('releaseAndroidConsolePort leaves a port the record no longer holds', () => {
  const a = liveProjectDir('a');
  upsertProject(a, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice(a, 'android', { avdName: 'stim-a', consolePort: 5556, owned: true });
  expect(releaseAndroidConsolePort(a, 5554)).toBe(false);
  expect(getProject(a)?.platforms?.android?.consolePort).toBe(5556);
});

test('removeProject deletes entry', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  removeProject('/p');
  expect(getProject('/p')).toBe(null);
});

test('allConsolePortsAndSerials ignores entries from project paths that no longer exist', () => {
  const live = liveProjectDir('live');
  upsertProject(live, { bundleId: 'com.live', androidPackage: 'com.live', isExpo: false });
  setDevice(live, 'android', { avdName: 'Pixel_6', consolePort: 5554 });
  upsertProject('/definitely/gone/worktree', { bundleId: 'com.dead', androidPackage: 'com.dead', isExpo: false });
  setDevice('/definitely/gone/worktree', 'android', { avdName: 'Pixel_7', consolePort: 5556 });
  const result = allConsolePortsAndSerials();
  expect(result.androidConsolePorts).toEqual([5554]);
});

test('allConsolePortsAndSerials keeps the claim of a project on an unmounted volume', () => {
  const unmounted = '/Volumes/NotPluggedIn/worktree';
  upsertProject(unmounted, { bundleId: 'com.x', androidPackage: 'com.x', isExpo: false });
  setDevice(unmounted, 'android', { avdName: 'stim-x', consolePort: 5554 });
  const result = allConsolePortsAndSerials({ isMounted: () => false });
  expect(result.androidConsolePorts).toEqual([5554]);
});

test('allConsolePortsAndSerials frees the claim of a dead project on a mounted volume', () => {
  upsertProject('/definitely/gone', { bundleId: 'com.x', androidPackage: 'com.x', isExpo: false });
  setDevice('/definitely/gone', 'android', { avdName: 'stim-x', consolePort: 5554 });
  const result = allConsolePortsAndSerials({ isMounted: () => true });
  expect(result.androidConsolePorts).toEqual([]);
});

test('setProjectSetting writes a top-level key', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.deviceType', 'iPhone 16');
  expect(getProjectSetting('/p', 'ios.deviceType')).toBe('iPhone 16');
  expect(getProjectSettings('/p')).toEqual({ ios: { deviceType: 'iPhone 16' } });
});

test('setProjectSetting writes a dotted key, creating intermediate objects', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.script', 'dev:ios');
  setProjectSetting('/p', 'android.script', 'dev:android');
  expect(getProjectSettings('/p')).toEqual({
    ios: { script: 'dev:ios' },
    android: { script: 'dev:android' },
  });
  expect(getProjectSetting('/p', 'ios.script')).toBe('dev:ios');
});

test('setProjectSetting overwrites an existing key', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.deviceType', 'iPhone 16');
  setProjectSetting('/p', 'ios.deviceType', 'iPhone 17');
  expect(getProjectSetting('/p', 'ios.deviceType')).toBe('iPhone 17');
});

test('unsetProjectSetting removes a key and reports whether it existed', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.script', 'dev:ios');
  expect(unsetProjectSetting('/p', 'ios.script')).toBe(true);
  expect(getProjectSetting('/p', 'ios.script')).toBe(undefined);
  expect(unsetProjectSetting('/p', 'ios.script')).toBe(false);
});

test('getProjectSetting returns undefined for unknown projects / keys', () => {
  expect(getProjectSetting('/missing', 'packageManager')).toBe(undefined);
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  expect(getProjectSetting('/p', 'packageManager')).toBe(undefined);
});

test('setProjectSetting throws when the project is not registered', () => {
  expect(() => setProjectSetting('/missing', 'packageManager', 'bun')).toThrow(/not registered/);
});

test('ensureConfig creates a v2 config with a repos section', () => {
  const cfg = ensureConfig();
  expect(cfg.version).toBe(2);
  expect(cfg.repos).toEqual({});
});

test('migrates a v1 config without touching projects', () => {
  saveConfig(
    makeConfig({
      version: 1,
      projects: { '/a': { metroPort: 8082, platforms: { ios: { deviceUdid: 'U1' } } } },
    }),
  );
  const cfg = ensureConfig();
  expect(cfg.version).toBe(2);
  expect(cfg.repos).toEqual({});
  expect(cfg.projects['/a']).toEqual({
    metroPort: 8082,
    platforms: { ios: { deviceUdid: 'U1' } },
  });
});

test('repo settings round-trip by git common dir', () => {
  setRepoSetting('/repo/.git', 'worktreeDir', '/wt');
  setRepoSetting('/repo/.git', 'worktree.baseRef', 'head');
  expect(getRepoSettings('/repo/.git')).toEqual({
    worktreeDir: '/wt',
    worktree: { baseRef: 'head' },
  });
  expect(unsetRepoSetting('/repo/.git', 'worktree.baseRef')).toBe(true);
  expect(getRepoSettings('/repo/.git')).toEqual({ worktreeDir: '/wt' });
});

test('getRepoSettings returns an empty object for an unknown repo', () => {
  expect(getRepoSettings('/nope/.git')).toEqual({});
});

test('getConcurrencyLimits is unlimited (0) when nothing is set', () => {
  const env = {};
  expect(getConcurrencyLimits({ env })).toEqual({ maxBuilds: 0, maxDevices: 0 });
});

test('getConcurrencyLimits reads config.json concurrency', () => {
  saveConfig({ version: 2, projects: {}, repos: {}, concurrency: { maxBuilds: 2, maxDevices: 3 } });
  expect(getConcurrencyLimits({ env: {} })).toEqual({ maxBuilds: 2, maxDevices: 3 });
});

test('env overrides config, and 0/absent means no enforcement', () => {
  saveConfig({ version: 2, projects: {}, repos: {}, concurrency: { maxBuilds: 2, maxDevices: 3 } });
  expect(getConcurrencyLimits({ env: { STIM_MAX_BUILDS: '5', STIM_MAX_DEVICES: '0' } })).toEqual({
    maxBuilds: 5,
    maxDevices: 0,
  });
});

test('a negative or garbage value reads as unlimited', () => {
  expect(getConcurrencyLimits({ env: { STIM_MAX_BUILDS: '-1', STIM_MAX_DEVICES: 'lots' } })).toEqual({
    maxBuilds: 0,
    maxDevices: 0,
  });
});

test('the Metro store injection is ON by default, with no config at all', () => {
  expect(metroStoreInjectionEnabled()).toBe(true);
});

test('only the literal false turns it off', () => {
  saveConfig({ version: 2, projects: {}, repos: {}, caches: { injectMetroStore: false } });
  expect(metroStoreInjectionEnabled()).toBe(false);
});

test('a malformed or unrelated caches value leaves it on', () => {
  for (const caches of [{}, { metroCache: '/x' }, { injectMetroStore: 'false' }, { injectMetroStore: 0 }, ['/x']]) {
    saveConfig({ version: 2, projects: {}, repos: {}, caches } as never);
    expect(metroStoreInjectionEnabled()).toBe(true);
  }
});
