import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import chalk from 'chalk';
import { phaseLine } from '../command-output.ts';
import { register } from '../cache-manifest.ts';
import { getExecutor } from '../exec.ts';
import { sharedCcache, workspaceLogsDir } from '../paths.ts';
import type { CcacheActivity } from '../types.ts';

export const CCACHE_MAX_SIZE = '5G';

// ccache manual, "SLOPPINESS": pch_defines is required for a precompiled
// header to be reusable at all, and time_macros lets a translation unit that
// expands __DATE__ or __TIME__ be cached.
export const CCACHE_SLOPPINESS = 'pch_defines,time_macros';

const STATS_LOG_FILE = 'ccache-stats.log';

export const CCACHE_UNAVAILABLE: CcacheActivity = {
  status: 'unavailable',
  hits: null,
  misses: null,
  hitRatePercent: null,
};

export const CCACHE_NOT_RUN: CcacheActivity = {
  status: 'not-run',
  hits: null,
  misses: null,
  hitRatePercent: null,
};

export interface CcacheSetup {
  dir: string;
  statsLog: string;
  env: Record<string, string>;
}

export function ccacheStatsLog(root: string): string {
  return join(workspaceLogsDir(root), STATS_LOG_FILE);
}

export function ccacheEnvironment({
  binary,
  dir,
  workspaceRoot,
  statsLog,
}: {
  binary: string;
  dir: string;
  workspaceRoot: string;
  statsLog: string;
}): Record<string, string> {
  return {
    CMAKE_C_COMPILER_LAUNCHER: binary,
    CMAKE_CXX_COMPILER_LAUNCHER: binary,
    CCACHE_DIR: dir,
    CCACHE_BASEDIR: workspaceRoot,
    // ccache manual, "CCACHE_NOHASHDIR": the boolean is read from this
    // spelling only; CCACHE_HASHDIR=false is not honored.
    CCACHE_NOHASHDIR: 'true',
    CCACHE_SLOPPINESS,
    CCACHE_MAXSIZE: CCACHE_MAX_SIZE,
    CCACHE_STATSLOG: statsLog,
  };
}

export function parseCcacheBinary(output: unknown): string | null {
  const first = String(output ?? '')
    .split('\n')[0]
    ?.trim();
  if (!first || !isAbsolute(first)) return null;
  return first;
}

const CMAKE_LAUNCHER = /CMAKE_(C|CXX)_COMPILER_LAUNCHER\b/;

export function projectCmakeLauncher(source: unknown): string | null {
  if (typeof source !== 'string') return null;
  const match = CMAKE_LAUNCHER.exec(source);
  return match ? `CMAKE_${match[1]}_COMPILER_LAUNCHER` : null;
}

const HIT_COUNTERS = new Set(['direct_cache_hit', 'preprocessed_cache_hit']);

export function parseCcacheStatsLog(text: unknown): CcacheActivity | null {
  if (typeof text !== 'string') return null;
  let hits = 0;
  let misses = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (HIT_COUNTERS.has(line)) hits += 1;
    else if (line === 'cache_miss') misses += 1;
  }
  const total = hits + misses;
  if (total === 0) return null;
  return {
    status: 'reported',
    hits,
    misses,
    hitRatePercent: Math.round((hits / total) * 1000) / 10,
  };
}

export function readCcacheActivity(statsLog: string): CcacheActivity {
  let text: string;
  try {
    text = readFileSync(statsLog, 'utf-8');
  } catch {
    return CCACHE_UNAVAILABLE;
  }
  return parseCcacheStatsLog(text) ?? CCACHE_UNAVAILABLE;
}

export function ccacheActivityLine(activity: CcacheActivity): string {
  if (activity.status === 'reported') {
    return `${activity.hits} hits / ${activity.misses} misses (${activity.hitRatePercent}%)`;
  }
  if (activity.status === 'not-run') return 'not run; artifact cache supplied the app';
  return 'unavailable; no C++ compile went through ccache';
}

function lookupCcache(): string | null {
  try {
    return parseCcacheBinary(getExecutor().runQuiet('command -v ccache', { timeoutMs: 5000 }));
  } catch {
    return null;
  }
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function canonical(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export function resolveCcache({
  root,
  dir = sharedCcache(),
  lookup = lookupCcache,
  onNote = (line: string) => console.error(line),
}: {
  root: string;
  dir?: string;
  lookup?: () => string | null;
  onNote?: (line: string) => void;
}): CcacheSetup | null {
  const binary = lookup();
  if (!binary) {
    onNote(chalk.dim(phaseLine('cache', 'ccache off (not installed; brew install ccache)')));
    return null;
  }

  const declared = projectCmakeLauncher(readOrNull(join(root, 'android', 'app', 'build.gradle')));
  if (declared) {
    onNote(chalk.dim(phaseLine('cache', `ccache off (android/app/build.gradle sets ${declared} itself)`)));
    return null;
  }

  const statsLog = ccacheStatsLog(root);
  register({
    dir,
    name: 'ccache',
    prune: 'atomic',
    note: 'ccache keeps itself under CCACHE_MAXSIZE, so it is emptied whole or not at all',
  });
  onNote(chalk.dim(phaseLine('cache', `ccache on (${dir})`)));
  return {
    dir,
    statsLog,
    env: ccacheEnvironment({ binary, dir, workspaceRoot: canonical(root), statsLog }),
  };
}
