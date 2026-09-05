import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CCACHE_MAX_SIZE,
  CCACHE_SLOPPINESS,
  CCACHE_UNAVAILABLE,
  ccacheActivityLine,
  ccacheEnvironment,
  ccacheStatsLog,
  parseCcacheBinary,
  parseCcacheStatsLog,
  projectCmakeLauncher,
  resolveCcache,
} from '../engine/ccache.ts';
import { readManifest } from '../cache-manifest.ts';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-ccache-home-'));
  savedHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = savedHome;
});

describe('ccacheEnvironment', () => {
  test('names every variable a relocatable Android CMake compile needs', () => {
    expect(
      ccacheEnvironment({
        binary: '/opt/homebrew/bin/ccache',
        dir: '/home/.stim/ccache',
        workspaceRoot: '/w/app',
        statsLog: '/home/.stim/workspaces/app/logs/ccache-stats.log',
      }),
    ).toEqual({
      CMAKE_C_COMPILER_LAUNCHER: '/opt/homebrew/bin/ccache',
      CMAKE_CXX_COMPILER_LAUNCHER: '/opt/homebrew/bin/ccache',
      CCACHE_DIR: '/home/.stim/ccache',
      CCACHE_BASEDIR: '/w/app',
      CCACHE_NOHASHDIR: 'true',
      CCACHE_SLOPPINESS: CCACHE_SLOPPINESS,
      CCACHE_MAXSIZE: CCACHE_MAX_SIZE,
      CCACHE_STATSLOG: '/home/.stim/workspaces/app/logs/ccache-stats.log',
    });
  });

  test('the launcher is always an absolute path, and the sloppiness covers precompiled headers', () => {
    const env = ccacheEnvironment({
      binary: '/usr/local/bin/ccache',
      dir: '/c',
      workspaceRoot: '/w',
      statsLog: '/l',
    });
    expect(String(env.CMAKE_CXX_COMPILER_LAUNCHER).startsWith('/')).toBe(true);
    expect(CCACHE_SLOPPINESS.split(',')).toEqual(['pch_defines', 'time_macros']);
    expect(CCACHE_MAX_SIZE).toBe('5G');
  });
});

describe('parseCcacheBinary', () => {
  test('takes the first line of `command -v ccache` and nothing else', () => {
    expect(parseCcacheBinary('/opt/homebrew/bin/ccache\n')).toBe('/opt/homebrew/bin/ccache');
    expect(parseCcacheBinary('/opt/homebrew/bin/ccache\n/usr/bin/ccache\n')).toBe('/opt/homebrew/bin/ccache');
  });

  test('a relative path or empty output is not a launcher', () => {
    expect(parseCcacheBinary('ccache')).toBe(null);
    expect(parseCcacheBinary('./ccache')).toBe(null);
    expect(parseCcacheBinary('')).toBe(null);
    expect(parseCcacheBinary(null)).toBe(null);
    expect(parseCcacheBinary(undefined)).toBe(null);
  });
});

describe('projectCmakeLauncher', () => {
  test('finds a launcher the project already passes to CMake', () => {
    const source = `
android {
  defaultConfig {
    externalNativeBuild {
      cmake {
        arguments "-DCMAKE_CXX_COMPILER_LAUNCHER=ccache", "-DANDROID_STL=c++_shared"
      }
    }
  }
}
`;
    expect(projectCmakeLauncher(source)).toBe('CMAKE_CXX_COMPILER_LAUNCHER');
    expect(projectCmakeLauncher('arguments "-DCMAKE_C_COMPILER_LAUNCHER=sccache"')).toBe('CMAKE_C_COMPILER_LAUNCHER');
  });

  test('an ordinary app build.gradle defines none', () => {
    expect(projectCmakeLauncher('apply plugin: "com.android.application"')).toBe(null);
    expect(projectCmakeLauncher(null)).toBe(null);
  });
});

describe('parseCcacheStatsLog', () => {
  test('counts hits and misses from a real ccache 4 stats log', () => {
    const log = readFileSync(join(import.meta.dirname, 'fixtures', 'ccache-stats-log.txt'), 'utf-8');
    expect(parseCcacheStatsLog(log)).toEqual({
      status: 'reported',
      hits: 2,
      misses: 1,
      hitRatePercent: 66.7,
    });
  });

  test('a miss bumps three counters and still counts once', () => {
    const log = ['# a.cpp', 'cache_miss', 'direct_cache_miss', 'preprocessed_cache_miss', 'local_storage_write'].join(
      '\n',
    );
    expect(parseCcacheStatsLog(log)).toEqual({ status: 'reported', hits: 0, misses: 1, hitRatePercent: 0 });
  });

  test('no cacheable compile at all reports nothing rather than a zero rate', () => {
    expect(parseCcacheStatsLog('')).toBe(null);
    expect(parseCcacheStatsLog('# a.cpp\ncalled_for_link\n')).toBe(null);
    expect(parseCcacheStatsLog(null)).toBe(null);
  });
});

describe('ccacheActivityLine', () => {
  test('states the counts for a reported build and the reason otherwise', () => {
    expect(ccacheActivityLine({ status: 'reported', hits: 176, misses: 204, hitRatePercent: 46.3 })).toBe(
      '176 hits / 204 misses (46.3%)',
    );
    expect(ccacheActivityLine({ status: 'not-run', hits: null, misses: null, hitRatePercent: null })).toBe(
      'not run; artifact cache supplied the app',
    );
    expect(ccacheActivityLine(CCACHE_UNAVAILABLE)).toBe('unavailable; no C++ compile went through ccache');
  });
});

describe('resolveCcache', () => {
  function project(root: string, buildGradle = 'apply plugin: "com.android.application"\n'): void {
    mkdirSync(join(root, 'android', 'app'), { recursive: true });
    writeFileSync(join(root, 'android', 'app', 'build.gradle'), buildGradle);
  }

  test('sets the launcher, registers the cache for gc, and says so once', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-ccache-root-'));
    project(root);
    const notes: string[] = [];
    const resolved = resolveCcache({
      root,
      lookup: () => '/opt/homebrew/bin/ccache',
      onNote: (line) => notes.push(line),
    });
    assert(resolved);
    expect(resolved.env.CMAKE_CXX_COMPILER_LAUNCHER).toBe('/opt/homebrew/bin/ccache');
    expect(resolved.dir).toBe(join(home, 'ccache'));
    expect(resolved.env.CCACHE_BASEDIR).toBe(realpathSync(root));
    expect(resolved.statsLog).toBe(ccacheStatsLog(root));
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/^ {2}cache {7}ccache on \(/);
    const entry = readManifest().caches.find((c) => c.dir === join(home, 'ccache'));
    assert(entry);
    expect(entry.name).toBe('ccache');
    expect(entry.prune).toBe('atomic');
    rmSync(root, { recursive: true, force: true });
  });

  test('sets nothing when ccache is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-ccache-root-'));
    project(root);
    const notes: string[] = [];
    expect(resolveCcache({ root, lookup: () => null, onNote: (line) => notes.push(line) })).toBe(null);
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/ccache off \(not installed/);
    expect(readManifest().caches.length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test('leaves a project that passes its own CMake launcher alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-ccache-root-'));
    project(root, 'arguments "-DCMAKE_CXX_COMPILER_LAUNCHER=ccache"\n');
    const notes: string[] = [];
    expect(resolveCcache({ root, lookup: () => '/opt/homebrew/bin/ccache', onNote: (line) => notes.push(line) })).toBe(
      null,
    );
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(/ccache off \(android\/app\/build\.gradle sets CMAKE_CXX_COMPILER_LAUNCHER/);
    rmSync(root, { recursive: true, force: true });
  });

  test('the stats log lives beside this workspace logs, not in the shared cache', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-ccache-root-'));
    project(root);
    const resolved = resolveCcache({ root, lookup: () => '/opt/homebrew/bin/ccache', onNote: () => {} });
    assert(resolved);
    expect(resolved.statsLog.startsWith(join(home, 'workspaces'))).toBe(true);
    expect(resolved.statsLog.startsWith(resolved.dir)).toBe(false);
    expect(existsSync(resolved.dir)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
