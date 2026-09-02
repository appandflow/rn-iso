import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { getConfigDir, withConfigLock } from '../config.ts';
import type { CacheHitLevel } from '../types.ts';

export const STATS_VERSION = 1;

export type StatsPlatform = 'ios' | 'android';

export interface StatsBucket {
  runs: number;
  failed: number;
  hits: number;
  misses: number;
  coldRuns: number;
  coldRunMs: number;
  hitRuns: number;
  hitRunMs: number;
  timeSavedMs: number;
  firstRunAt: string;
  lastRunAt: string;
}

export type StatsScope = Partial<Record<StatsPlatform, StatsBucket>>;

export interface StatsRecord {
  version: number;
  machine: StatsScope;
  projects: Record<string, StatsScope>;
}

export interface StatsRun {
  platform: StatsPlatform;
  projectKey: string;
  failed: boolean;
  cacheHit: CacheHitLevel;
  waitedForBuild: boolean;
  durationMs: number;
}

export interface RecordStatsResult {
  recorded: boolean;
  note: string | null;
}

export interface ReadStatsResult {
  record: StatsRecord | null;
  note: string | null;
}

interface RunOutcome {
  failed: boolean;
  cacheHit?: CacheHitLevel;
  waited?: unknown;
  durationMs: number;
}

export interface RunRecorder {
  setProject(key: string): void;
  setCacheKey(key: string): void;
  record(outcome: RunOutcome): void;
}

const PLATFORMS: StatsPlatform[] = ['ios', 'android'];

export function statsFile(): string {
  return join(getConfigDir(), 'stats.json');
}

export function emptyStats(): StatsRecord {
  return { version: STATS_VERSION, machine: {}, projects: {} };
}

export function statsProjectKey({
  root,
  commonDir,
  repoRoot,
}: {
  root: string;
  commonDir: string | null;
  repoRoot: string | null;
}): string {
  if (commonDir && repoRoot && basename(commonDir) === '.git') {
    return canonical(join(dirname(commonDir), relative(repoRoot, root)));
  }
  return canonical(root);
}

export function updateStats(record: StatsRecord, run: StatsRun, now: number): StatsRecord {
  const at = new Date(now).toISOString();
  const durationMs = wholeMs(run.durationMs);
  const projects: Record<string, StatsScope> = { ...record.projects };
  const scope: StatsScope = { ...projects[run.projectKey] };
  const machine: StatsScope = { ...record.machine };
  const before = scope[run.platform] ?? null;
  const credit = creditMs(before, run, durationMs);

  scope[run.platform] = applyRun(before, run, { at, durationMs, credit });
  projects[run.projectKey] = scope;
  machine[run.platform] = applyRun(machine[run.platform] ?? null, run, { at, durationMs, credit });

  return { version: STATS_VERSION, machine, projects };
}

export function readStats(): ReadStatsResult {
  const path = statsFile();
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return { record: null, note: null };
  }
  const parsed = parseRecord(text);
  if (!parsed) {
    return {
      record: null,
      note: `Run statistics at ${path} could not be read; the next ios or android run moves them aside and starts a new file.`,
    };
  }
  if (parsed.version > STATS_VERSION) {
    return {
      record: null,
      note: `Run statistics at ${path} are version ${parsed.version}, which this Stim does not understand, so none are shown.`,
    };
  }
  return { record: normalize(parsed), note: null };
}

export function recordRunStats(run: StatsRun, now: number): RecordStatsResult {
  return withConfigLock(() => {
    const path = statsFile();
    const loaded = loadForUpdate(path, now);
    if (loaded.newerVersion !== null) {
      return {
        recorded: false,
        note:
          `Run statistics at ${path} are version ${loaded.newerVersion}, which this Stim does not understand, ` +
          'so this run was not recorded.',
      };
    }
    writeStats(path, updateStats(loaded.record, run, now));
    return { recorded: true, note: loaded.note };
  });
}

export function createRunRecorder({
  platform,
  write,
  now,
  note,
}: {
  platform: StatsPlatform;
  write: (run: StatsRun, now: number) => RecordStatsResult;
  now: () => number;
  note: (line: string) => void;
}): RunRecorder {
  let projectKey: string | null = null;
  let cacheKey: string | null = null;
  let recorded = false;
  return {
    setProject(key: string): void {
      projectKey = key;
    },
    setCacheKey(key: string): void {
      cacheKey = key;
    },
    record({ failed, cacheHit = false, waited = null, durationMs }: RunOutcome): void {
      if (!projectKey || !cacheKey || recorded) return;
      recorded = true;
      try {
        const outcome = write(
          { platform, projectKey, failed, cacheHit, waitedForBuild: Boolean(waited), durationMs },
          now(),
        );
        if (outcome?.note) note(outcome.note);
      } catch (error) {
        note(`Run statistics could not be recorded: ${(error as Error)?.message || error}`);
      }
    },
  };
}

function loadForUpdate(
  path: string,
  now: number,
): { record: StatsRecord; note: string | null; newerVersion: number | null } {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return { record: emptyStats(), note: null, newerVersion: null };
  }
  const parsed = parseRecord(text);
  if (!parsed) {
    const aside = `${path}.corrupt-${now}`;
    renameSync(path, aside);
    return {
      record: emptyStats(),
      note: `Run statistics at ${path} could not be read, so they were moved to ${aside} and a new file was started.`,
      newerVersion: null,
    };
  }
  if (parsed.version > STATS_VERSION) {
    return { record: emptyStats(), note: null, newerVersion: parsed.version };
  }
  return { record: normalize(parsed), note: null, newerVersion: null };
}

function writeStats(path: string, record: StatsRecord): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function parseRecord(text: string): StatsRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'number' || !Number.isInteger(version)) return null;
  return parsed as StatsRecord;
}

function normalize(record: StatsRecord): StatsRecord {
  const projects: Record<string, StatsScope> = {};
  const source = record.projects;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, scope] of Object.entries(source)) projects[key] = normalizeScope(scope);
  }
  return { version: STATS_VERSION, machine: normalizeScope(record.machine), projects };
}

function normalizeScope(scope: unknown): StatsScope {
  const normalized: StatsScope = {};
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return normalized;
  for (const platform of PLATFORMS) {
    const bucket = (scope as Record<string, unknown>)[platform];
    if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
      normalized[platform] = normalizeBucket(bucket as Record<string, unknown>);
    }
  }
  return normalized;
}

function normalizeBucket(bucket: Record<string, unknown>): StatsBucket {
  return {
    runs: count(bucket.runs),
    failed: count(bucket.failed),
    hits: count(bucket.hits),
    misses: count(bucket.misses),
    coldRuns: count(bucket.coldRuns),
    coldRunMs: count(bucket.coldRunMs),
    hitRuns: count(bucket.hitRuns),
    hitRunMs: count(bucket.hitRunMs),
    timeSavedMs: count(bucket.timeSavedMs),
    firstRunAt: timestamp(bucket.firstRunAt),
    lastRunAt: timestamp(bucket.lastRunAt),
  };
}

function applyRun(
  bucket: StatsBucket | null,
  run: StatsRun,
  { at, durationMs, credit }: { at: string; durationMs: number; credit: number },
): StatsBucket {
  const next: StatsBucket = bucket
    ? { ...bucket }
    : {
        runs: 0,
        failed: 0,
        hits: 0,
        misses: 0,
        coldRuns: 0,
        coldRunMs: 0,
        hitRuns: 0,
        hitRunMs: 0,
        timeSavedMs: 0,
        firstRunAt: at,
        lastRunAt: at,
      };
  next.runs += 1;
  next.lastRunAt = at;
  if (run.failed) {
    next.failed += 1;
    return next;
  }
  if (isHit(run.cacheHit)) {
    next.hits += 1;
    if (!run.waitedForBuild) {
      next.hitRuns += 1;
      next.hitRunMs += durationMs;
      next.timeSavedMs += credit;
    }
    return next;
  }
  next.misses += 1;
  next.coldRuns += 1;
  next.coldRunMs += durationMs;
  return next;
}

function creditMs(bucket: StatsBucket | null, run: StatsRun, durationMs: number): number {
  if (run.failed || !isHit(run.cacheHit) || run.waitedForBuild) return 0;
  if (!bucket || bucket.coldRuns <= 0) return 0;
  return Math.max(0, Math.round(bucket.coldRunMs / bucket.coldRuns) - durationMs);
}

function isHit(cacheHit: CacheHitLevel): boolean {
  return cacheHit === 'local' || cacheHit === 'remote';
}

function wholeMs(value: unknown): number {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

function count(value: unknown): number {
  return wholeMs(value);
}

function timestamp(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : new Date(0).toISOString();
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
