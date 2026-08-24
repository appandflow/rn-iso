import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
  clearDevice,
  allMetroPorts,
  allConsolePortsAndSerials,
  getProjectSettings,
  getProjectSetting,
  setProjectSetting,
  unsetProjectSetting,
  pruneDeadProjects,
  getRepoSettings,
  setRepoSetting,
  unsetRepoSetting,
} from '../src/config.js';

let tmpHome;

// Claims from nonexistent paths are filtered, so tests that want a claim to
// be visible must register a directory that actually exists.
function liveProjectDir(name) {
  const dir = join(tmpHome, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'rn-iso-test-'));
  process.env.RN_ISO_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.RN_ISO_HOME;
});

test('getConfigDir respects RN_ISO_HOME', () => {
  assert.equal(getConfigDir(), tmpHome);
});

test('loadConfig returns null when no file exists', () => {
  assert.equal(loadConfig(), null);
});

test('ensureConfig creates and returns empty config', () => {
  const cfg = ensureConfig();
  assert.deepEqual(cfg, { version: 2, projects: {}, repos: {} });
  assert.ok(existsSync(join(tmpHome, 'config.json')));
});

test('saveConfig + loadConfig roundtrip', () => {
  saveConfig({ version: 1, projects: { '/foo': { metroPort: 8082, platforms: {} } } });
  const cfg = loadConfig();
  assert.equal(cfg.projects['/foo'].metroPort, 8082);
});

// --- crash tolerance ---

// The config records which devices rn-iso owns. Resetting a damaged one to {}
// would orphan every owned sim, so a parse failure must be reported, not
// swallowed.
test('loadConfig reports a corrupt config by path instead of throwing a raw SyntaxError', () => {
  writeFileSync(join(tmpHome, 'config.json'), '{"projects": {"/a": ');
  assert.throws(() => loadConfig(), (err) => {
    assert.match(err.message, /not valid JSON/);
    assert.match(err.message, /config\.json/);
    assert.doesNotMatch(err.constructor.name, /SyntaxError/);
    return true;
  });
});

test('loadConfig keeps a corrupt config on disk rather than resetting it', () => {
  const p = join(tmpHome, 'config.json');
  writeFileSync(p, 'not json at all');
  assert.throws(() => loadConfig());
  assert.equal(readFileSync(p, 'utf-8'), 'not json at all');
});

// An interrupted write must never leave a half-written config.json: the new
// content lands in a temp file and is renamed over the target in one step.
test('saveConfig writes through a temp file and leaves none behind', () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  const strays = readdirSync(tmpHome).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(strays, [], 'no temp file may survive a completed save');
  assert.deepEqual(loadConfig(), { version: 2, projects: {}, repos: {} });
});

// --- write lock ---

test('withConfigLock is reentrant, so nested mutators cannot deadlock', () => {
  const result = withConfigLock(() => {
    upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
    claimMetroPort('/p', 8082);
    return getProject('/p').metroPort;
  });
  assert.equal(result, 8082);
  assert.equal(existsSync(join(tmpHome, 'config.lock')), false, 'the lock must be released');
});

test('withConfigLock releases the lock when the body throws', () => {
  assert.throws(() => withConfigLock(() => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(join(tmpHome, 'config.lock')), false);
  // Still usable afterwards.
  assert.equal(withConfigLock(() => 'ok'), 'ok');
});

// A process killed mid-mutation leaves its lock directory behind. Waiting on
// it forever would wedge every later command, so a lock older than the stale
// timeout is taken over.
test('withConfigLock takes over a stale lock left by a dead process', () => {
  const lock = join(tmpHome, 'config.lock');
  mkdirSync(lock);
  const longAgo = new Date(Date.now() - 60000);
  utimesSync(lock, longAgo, longAgo);
  assert.equal(withConfigLock(() => 'taken over'), 'taken over');
  assert.equal(existsSync(lock), false);
});

// Cross-PROCESS on purpose, like the isPortFree test in test/ports.test.js.
// Several rn-iso commands run at once on this machine, and each mutator is a
// read-modify-write of one file: without the lock the last writer wins and the
// other processes' records are simply gone.
test('concurrent processes each keep their record', async () => {
  const script = join(tmpHome, 'writer.mjs');
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  writeFileSync(script, [
    `const { upsertProject } = await import(${JSON.stringify(configUrl)});`,
    'const key = process.argv[2];',
    'upsertProject(key, { bundleId: key, androidPackage: key, isExpo: false });',
  ].join('\n'));

  const keys = ['/p1', '/p2', '/p3', '/p4', '/p5', '/p6'];
  await Promise.all(keys.map(key => new Promise((resolve, reject) => {
    execFile(process.execPath, [script, key], { env: { ...process.env, RN_ISO_HOME: tmpHome } },
      (err) => (err ? reject(err) : resolve()));
  })));

  const cfg = loadConfig();
  for (const key of keys) {
    assert.ok(cfg.projects[key], `${key} must survive concurrent writers`);
  }
});

// --- port claims ---

test('claimMetroPort records the port when nothing else holds it', () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  assert.equal(claimMetroPort('/a', 8082), 8082);
  assert.equal(getProject('/a').metroPort, 8082);
});

// Two `up` runs probe the same free port at the same time; only one may keep
// it. The loser is told so, instead of both recording 8082.
test('claimMetroPort refuses a port another project claimed first', () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  assert.equal(claimMetroPort('/a', 8082), 8082);
  assert.equal(claimMetroPort('/b', 8082), null);
  assert.equal(getProject('/b').metroPort, null);
});

test('claimMetroPort re-claiming a project\'s own port is not a conflict', () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  assert.equal(claimMetroPort('/a', 8082), 8082);
});

test('upsertProject creates a new project entry with defaults', () => {
  const proj = upsertProject('/abs/path', {
    bundleId: 'com.foo',
    androidPackage: 'com.foo',
    isExpo: true,
  });
  assert.equal(proj.bundleId, 'com.foo');
  assert.equal(proj.metroPort, null);
  assert.deepEqual(proj.platforms, {});
});

test('upsertProject preserves existing fields when called again', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  claimMetroPort('/p', 8082);
  upsertProject('/p', { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  const proj = getProject('/p');
  assert.equal(proj.bundleId, 'com.b');
  assert.equal(proj.metroPort, 8082);
});

test('setDevice and clearDevice mutate platforms', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice('/p', 'ios', { deviceUdid: 'ABC' });
  assert.equal(getProject('/p').platforms.ios.deviceUdid, 'ABC');
  clearDevice('/p', 'ios');
  assert.equal(getProject('/p').platforms.ios, undefined);
});

test('allMetroPorts collects ports from all projects', () => {
  upsertProject('/a', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  upsertProject('/b', { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  claimMetroPort('/a', 8082);
  claimMetroPort('/b', 8083);
  assert.deepEqual(allMetroPorts().sort(), [8082, 8083]);
});

test('allConsolePortsAndSerials collects android console ports across projects', () => {
  const a = liveProjectDir('a');
  const b = liveProjectDir('b');
  upsertProject(a, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  upsertProject(b, { bundleId: 'com.b', androidPackage: 'com.b', isExpo: false });
  setDevice(a, 'android', { avdName: 'Pixel_5', consolePort: 5556 });
  setDevice(b, 'android', { avdName: 'Pixel_6', consolePort: 5554 });
  const result = allConsolePortsAndSerials();
  assert.deepEqual(result.androidConsolePorts.sort(), [5554, 5556]);
});

test('allConsolePortsAndSerials collects physical serials (no avdName)', () => {
  const a = liveProjectDir('a');
  upsertProject(a, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice(a, 'android', { serial: 'R5CR70XXXXX' });
  const result = allConsolePortsAndSerials();
  assert.deepEqual(result.androidPhysicalSerials, ['R5CR70XXXXX']);
});

test('removeProject deletes entry', () => {
  upsertProject('/p', { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  removeProject('/p');
  assert.equal(getProject('/p'), null);
});

test('allConsolePortsAndSerials ignores entries from project paths that no longer exist', () => {
  const live = liveProjectDir('live');
  upsertProject(live, { bundleId: 'com.live', androidPackage: 'com.live', isExpo: false });
  setDevice(live, 'android', { avdName: 'Pixel_6', consolePort: 5554 });
  upsertProject('/definitely/gone/worktree', { bundleId: 'com.dead', androidPackage: 'com.dead', isExpo: false });
  setDevice('/definitely/gone/worktree', 'android', { avdName: 'Pixel_7', consolePort: 5556 });
  const result = allConsolePortsAndSerials();
  assert.deepEqual(result.androidConsolePorts, [5554]);
});

// A path on an unplugged external volume only LOOKS gone. Its emulator may
// still be running, so handing its console port to a second emulator would
// collide. Same direction gc and prune fail in.
test('allConsolePortsAndSerials keeps the claim of a project on an unmounted volume', () => {
  const unmounted = '/Volumes/NotPluggedIn/worktree';
  upsertProject(unmounted, { bundleId: 'com.x', androidPackage: 'com.x', isExpo: false });
  setDevice(unmounted, 'android', { avdName: 'rn-iso-x', consolePort: 5554 });
  const result = allConsolePortsAndSerials({ isMounted: () => false });
  assert.deepEqual(result.androidConsolePorts, [5554]);
});

test('allConsolePortsAndSerials frees the claim of a dead project on a mounted volume', () => {
  upsertProject('/definitely/gone', { bundleId: 'com.x', androidPackage: 'com.x', isExpo: false });
  setDevice('/definitely/gone', 'android', { avdName: 'rn-iso-x', consolePort: 5554 });
  const result = allConsolePortsAndSerials({ isMounted: () => true });
  assert.deepEqual(result.androidConsolePorts, []);
});

test('pruneDeadProjects removes dead-path entries and keeps live ones', () => {
  const live = liveProjectDir('live');
  upsertProject(live, { bundleId: 'com.live', androidPackage: 'com.live', isExpo: false });
  upsertProject('/definitely/gone/worktree', { bundleId: 'com.dead', androidPackage: 'com.dead', isExpo: false });
  claimMetroPort('/definitely/gone/worktree', 8099);
  const removed = pruneDeadProjects();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].path, '/definitely/gone/worktree');
  assert.equal(removed[0].project.metroPort, 8099);
  assert.equal(getProject('/definitely/gone/worktree'), null);
  assert.notEqual(getProject(live), null);
});

test('pruneDeadProjects returns empty list when nothing is dead', () => {
  const live = liveProjectDir('live');
  upsertProject(live, { bundleId: 'com.live', androidPackage: 'com.live', isExpo: false });
  assert.deepEqual(pruneDeadProjects(), []);
  assert.notEqual(getProject(live), null);
});

// --- Per-project settings ---

test('setProjectSetting writes a top-level key', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.deviceType', 'iPhone 16');
  assert.equal(getProjectSetting('/p', 'ios.deviceType'), 'iPhone 16');
  assert.deepEqual(getProjectSettings('/p'), { ios: { deviceType: 'iPhone 16' } });
});

test('setProjectSetting writes a dotted key, creating intermediate objects', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.script', 'dev:ios');
  setProjectSetting('/p', 'android.script', 'dev:android');
  assert.deepEqual(getProjectSettings('/p'), {
    ios: { script: 'dev:ios' },
    android: { script: 'dev:android' },
  });
  assert.equal(getProjectSetting('/p', 'ios.script'), 'dev:ios');
});

test('setProjectSetting overwrites an existing key', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.deviceType', 'iPhone 16');
  setProjectSetting('/p', 'ios.deviceType', 'iPhone 17');
  assert.equal(getProjectSetting('/p', 'ios.deviceType'), 'iPhone 17');
});

test('unsetProjectSetting removes a key and reports whether it existed', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setProjectSetting('/p', 'ios.script', 'dev:ios');
  assert.equal(unsetProjectSetting('/p', 'ios.script'), true);
  assert.equal(getProjectSetting('/p', 'ios.script'), undefined);
  assert.equal(unsetProjectSetting('/p', 'ios.script'), false);
});

test('getProjectSetting returns undefined for unknown projects / keys', () => {
  assert.equal(getProjectSetting('/missing', 'packageManager'), undefined);
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  assert.equal(getProjectSetting('/p', 'packageManager'), undefined);
});

test('setProjectSetting throws when the project is not registered', () => {
  assert.throws(() => setProjectSetting('/missing', 'packageManager', 'bun'), /not registered/);
});

// --- Config schema v2 / repo settings ---

test('ensureConfig creates a v2 config with a repos section', () => {
  const cfg = ensureConfig();
  assert.equal(cfg.version, 2);
  assert.deepEqual(cfg.repos, {});
});

test('migrates a v1 config without touching projects', () => {
  saveConfig({
    version: 1,
    projects: { '/a': { metroPort: 8082, platforms: { ios: { deviceUdid: 'U1' } } } },
  });
  const cfg = ensureConfig();
  assert.equal(cfg.version, 2);
  assert.deepEqual(cfg.repos, {});
  assert.deepEqual(cfg.projects['/a'], {
    metroPort: 8082,
    platforms: { ios: { deviceUdid: 'U1' } },
  });
});

test('repo settings round-trip by git common dir', () => {
  setRepoSetting('/repo/.git', 'worktreeDir', '/wt');
  setRepoSetting('/repo/.git', 'worktree.baseRef', 'head');
  assert.deepEqual(getRepoSettings('/repo/.git'), {
    worktreeDir: '/wt',
    worktree: { baseRef: 'head' },
  });
  assert.equal(unsetRepoSetting('/repo/.git', 'worktree.baseRef'), true);
  assert.deepEqual(getRepoSettings('/repo/.git'), { worktreeDir: '/wt' });
});

test('getRepoSettings returns an empty object for an unknown repo', () => {
  assert.deepEqual(getRepoSettings('/nope/.git'), {});
});
