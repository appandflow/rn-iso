import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { resetExecutor, setExecutor } from '../exec.ts';
import statsCommand from '../commands/stats.ts';
import {
  createRunRecorder,
  emptyStats,
  readRunEstimates,
  readStats,
  recordRunStats,
  statsFile,
  statsProjectKey,
  updateStats,
  type StatsBucket,
  type StatsRecord,
  type StatsRun,
} from '../engine/stats.ts';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const T1 = Date.parse('2026-09-02T10:00:00.000Z');

let tmpHome: string;
let root: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn() {
      throw new Error('stats spawns nothing');
    },
  });
});

afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function run(overrides: Partial<StatsRun> = {}): StatsRun {
  return {
    platform: 'ios',
    projectKey: '/repo/app',
    failed: false,
    cacheHit: false,
    waitedForBuild: false,
    durationMs: 60_000,
    ...overrides,
  };
}

function bucketOf(record: StatsRecord, key: string): StatsBucket {
  const bucket = record.projects[key]?.ios;
  assert(bucket);
  return bucket;
}

describe('the update rule', () => {
  test('a miss records a cold run and creates the bucket with both timestamps', () => {
    const record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket).toEqual({
      runs: 1,
      failed: 0,
      hits: 0,
      misses: 1,
      coldRuns: 1,
      coldRunMs: 240_000,
      hitRuns: 0,
      hitRunMs: 0,
      timeSavedMs: 0,
      firstRunAt: '2026-09-01T10:00:00.000Z',
      lastRunAt: '2026-09-01T10:00:00.000Z',
    });
    expect(record.machine.ios).toEqual(bucket);
    expect(record.version).toBe(1);
  });

  test('a hit after a cold run is credited the mean cold run minus its own duration', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    record = updateStats(record, run({ durationMs: 120_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 30_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.runs).toBe(3);
    expect(bucket.hits).toBe(1);
    expect(bucket.misses).toBe(2);
    expect(bucket.hitRuns).toBe(1);
    expect(bucket.hitRunMs).toBe(30_000);
    expect(bucket.timeSavedMs).toBe(150_000);
    expect(bucket.coldRunMs).toBe(360_000);
    expect(bucket.firstRunAt).toBe('2026-09-01T10:00:00.000Z');
    expect(bucket.lastRunAt).toBe('2026-09-02T10:00:00.000Z');
  });

  test('a remote hit counts like a local one', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 200_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'remote', durationMs: 20_000 }), T1);

    expect(bucketOf(record, '/repo/app').hits).toBe(1);
    expect(bucketOf(record, '/repo/app').timeSavedMs).toBe(180_000);
  });

  test('a hit slower than the mean cold run credits nothing rather than a negative', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 20_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 90_000 }), T1);

    expect(bucketOf(record, '/repo/app').timeSavedMs).toBe(0);
    expect(bucketOf(record, '/repo/app').hitRunMs).toBe(90_000);
  });

  test('a hit that waited for another workspace counts as a hit and nothing else', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', waitedForBuild: true, durationMs: 30_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.runs).toBe(2);
    expect(bucket.hits).toBe(1);
    expect(bucket.hitRuns).toBe(0);
    expect(bucket.hitRunMs).toBe(0);
    expect(bucket.timeSavedMs).toBe(0);
    expect(record.machine.ios?.timeSavedMs).toBe(0);
  });

  test('a hit with no cold run for this project and platform credits nothing', () => {
    let record = updateStats(emptyStats(), run({ platform: 'android', durationMs: 600_000 }), T0);
    record = updateStats(record, run({ projectKey: '/repo/other', durationMs: 600_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 30_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(record.machine.ios?.coldRuns).toBe(1);
    expect(bucket.hits).toBe(1);
    expect(bucket.timeSavedMs).toBe(0);
    expect(record.machine.ios?.timeSavedMs).toBe(0);
  });

  test('a failed run counts as a run and a failure and nothing else', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    record = updateStats(record, run({ failed: true, cacheHit: 'local', durationMs: 5_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.runs).toBe(2);
    expect(bucket.failed).toBe(1);
    expect(bucket.hits).toBe(0);
    expect(bucket.misses).toBe(1);
    expect(bucket.hitRuns).toBe(0);
    expect(bucket.coldRuns).toBe(1);
    expect(bucket.lastRunAt).toBe('2026-09-02T10:00:00.000Z');
  });

  test('the machine bucket moves in lockstep with the projects that feed it', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    record = updateStats(record, run({ projectKey: '/repo/other', durationMs: 400_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 40_000 }), T1);
    record = updateStats(record, run({ projectKey: '/repo/other', cacheHit: 'local', durationMs: 40_000 }), T1);

    const machine = record.machine.ios;
    assert(machine);
    expect(machine.runs).toBe(4);
    expect(machine.hits).toBe(2);
    expect(machine.coldRunMs).toBe(640_000);
    expect(machine.timeSavedMs).toBe(200_000 + 360_000);
    expect(machine.timeSavedMs).toBe(
      bucketOf(record, '/repo/app').timeSavedMs + bucketOf(record, '/repo/other').timeSavedMs,
    );
  });

  test('a platform keeps its own bucket', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 100_000 }), T0);
    record = updateStats(record, run({ platform: 'android', durationMs: 300_000 }), T0);

    expect(record.projects['/repo/app']?.ios?.coldRunMs).toBe(100_000);
    expect(record.projects['/repo/app']?.android?.coldRunMs).toBe(300_000);
    expect(record.machine.android?.runs).toBe(1);
  });

  test('milliseconds stay whole numbers', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000.6 }), T0);
    record = updateStats(record, run({ durationMs: 100_001 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 30_000.4 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.coldRunMs).toBe(340_002);
    expect(bucket.hitRunMs).toBe(30_000);
    expect(bucket.timeSavedMs).toBe(140_001);
    expect(Number.isInteger(bucket.timeSavedMs)).toBe(true);
  });

  test('a miss that compiled records the build phase, in both buckets', () => {
    const record = updateStats(emptyStats(), run({ durationMs: 240_000, coldBuildMs: 190_000 }), T0);

    expect(bucketOf(record, '/repo/app').lastColdBuildMs).toBe(190_000);
    expect(record.machine.ios?.lastColdBuildMs).toBe(190_000);
  });

  test('a pod install records its own duration, in both buckets', () => {
    const record = updateStats(emptyStats(), run({ durationMs: 240_000, podsMs: 100_000 }), T0);

    expect(bucketOf(record, '/repo/app').lastPodsMs).toBe(100_000);
    expect(record.machine.ios?.lastPodsMs).toBe(100_000);
  });

  test('the last value wins: a later cold build replaces the one before it', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000, coldBuildMs: 190_000, podsMs: 100_000 }), T0);
    record = updateStats(record, run({ durationMs: 300_000, coldBuildMs: 250_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.lastColdBuildMs).toBe(250_000);
    expect(bucket.lastPodsMs).toBe(100_000);
  });

  test('a run with no long phase leaves both fields exactly as they were', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000, coldBuildMs: 190_000, podsMs: 100_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 30_000 }), T1);
    record = updateStats(record, run({ failed: true, durationMs: 5_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.lastColdBuildMs).toBe(190_000);
    expect(bucket.lastPodsMs).toBe(100_000);
  });

  test('a bucket that never compiled carries neither field, so the payload is unchanged', () => {
    const record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    const bucket = bucketOf(record, '/repo/app');

    expect('lastColdBuildMs' in bucket).toBe(false);
    expect('lastPodsMs' in bucket).toBe(false);
  });

  test('the input record is not mutated', () => {
    const before = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    const snapshot = JSON.stringify(before);
    updateStats(before, run({ cacheHit: 'local', durationMs: 10_000 }), T1);

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('the stats file', () => {
  test('a run is written under the config lock and read back', () => {
    const outcome = recordRunStats(run({ projectKey: root, durationMs: 240_000 }), T0);

    expect(outcome).toEqual({ recorded: true, note: null });
    expect(existsSync(statsFile())).toBe(true);
    expect(readStats().record?.projects[root]?.ios?.coldRunMs).toBe(240_000);
    expect(readFileSync(statsFile(), 'utf-8').split('\n')).toHaveLength(2);
  });

  test('a file from a newer Stim is left untouched and the run records nothing', () => {
    const newer = JSON.stringify({ version: 2, machine: {}, projects: {} });
    writeFileSync(statsFile(), newer);

    const outcome = recordRunStats(run({ projectKey: root }), T0);

    expect(outcome.recorded).toBe(false);
    expect(outcome.note).toMatch(/version 2/);
    expect(readFileSync(statsFile(), 'utf-8')).toBe(newer);
    expect(readStats().record).toBe(null);
    expect(readStats().note).toMatch(/version 2/);
  });

  test('a corrupt file is renamed aside, a fresh one is started, and the run is recorded', () => {
    writeFileSync(statsFile(), '{ this is not json');

    const outcome = recordRunStats(run({ projectKey: root, durationMs: 5_000 }), T0);

    expect(outcome.recorded).toBe(true);
    expect(outcome.note).toMatch(/moved to /);
    expect(readFileSync(`${statsFile()}.corrupt-${T0}`, 'utf-8')).toBe('{ this is not json');
    expect(readStats().record?.projects[root]?.ios?.runs).toBe(1);
  });

  test('a file that parses to something other than a versioned object is corrupt too', () => {
    writeFileSync(statsFile(), JSON.stringify([1, 2, 3]));
    expect(recordRunStats(run({ projectKey: root }), T0).note).toMatch(/moved to /);

    writeFileSync(statsFile(), JSON.stringify({ machine: {}, projects: {} }));
    expect(recordRunStats(run({ projectKey: root }), T1).note).toMatch(/moved to /);
    expect(readdirSync(tmpHome).filter((name) => name.includes('corrupt-'))).toHaveLength(2);
  });

  test('the recorder writes nowhere but STIM_HOME and creates no config.json', () => {
    recordRunStats(run({ projectKey: root }), T0);

    expect(statsFile()).toBe(join(tmpHome, 'stats.json'));
    expect(existsSync(join(tmpHome, 'config.json'))).toBe(false);
  });

  test('the project key is the app path in the main working tree, canonical', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'stim-repo-')));
    const worktree = join(repo, 'worktrees', 'agent-1');

    expect(
      statsProjectKey({ root: join(worktree, 'apps', 'mobile'), commonDir: join(repo, '.git'), repoRoot: worktree }),
    ).toBe(join(repo, 'apps', 'mobile'));
    expect(statsProjectKey({ root, commonDir: null, repoRoot: null })).toBe(root);
    expect(statsProjectKey({ root, commonDir: join(repo, 'bare.git'), repoRoot: repo })).toBe(root);

    rmSync(repo, { recursive: true, force: true });
  });
});

describe('the run recorder', () => {
  function recorderFor(writes: { run: StatsRun; now: number }[]) {
    const recorder = createRunRecorder({
      platform: 'ios',
      write: (statsRun, at) => {
        writes.push({ run: statsRun, now: at });
        return { recorded: true, note: null };
      },
      now: () => T0,
      note: () => {},
    });
    recorder.setProject('/repo/app');
    recorder.setCacheKey('ios-abc');
    return recorder;
  }

  test('the build and pod install durations reach the record', () => {
    const writes: { run: StatsRun; now: number }[] = [];
    const recorder = recorderFor(writes);
    recorder.setPodsMs(100_000);
    recorder.setBuildMs(190_000);
    recorder.record({ failed: false, cacheHit: false, durationMs: 300_000 });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.run.coldBuildMs).toBe(190_000);
    expect(writes[0]?.run.podsMs).toBe(100_000);
  });

  test('a run with neither phase sends neither field', () => {
    const writes: { run: StatsRun; now: number }[] = [];
    recorderFor(writes).record({ failed: false, cacheHit: 'local', durationMs: 30_000 });

    expect(writes[0]?.run).not.toHaveProperty('coldBuildMs');
    expect(writes[0]?.run).not.toHaveProperty('podsMs');
  });
});

describe('the estimates a run reads back', () => {
  test('the project bucket supplies the last cold build and the last pod install', () => {
    const record = updateStats(emptyStats(), run({ projectKey: root, coldBuildMs: 190_000, podsMs: 100_000 }), T0);
    writeFileSync(statsFile(), JSON.stringify(record));

    expect(readRunEstimates({ projectKey: root, platform: 'ios' })).toEqual({
      coldBuildMs: 190_000,
      podsMs: 100_000,
    });
  });

  test('another project, another platform, and no file at all all read as no record', () => {
    const record = updateStats(emptyStats(), run({ projectKey: root, coldBuildMs: 190_000 }), T0);
    writeFileSync(statsFile(), JSON.stringify(record));

    expect(readRunEstimates({ projectKey: '/elsewhere', platform: 'ios' })).toEqual({
      coldBuildMs: null,
      podsMs: null,
    });
    expect(readRunEstimates({ projectKey: root, platform: 'android' })).toEqual({
      coldBuildMs: null,
      podsMs: null,
    });
    rmSync(statsFile(), { force: true });
    expect(readRunEstimates({ projectKey: root, platform: 'ios' })).toEqual({ coldBuildMs: null, podsMs: null });
    expect(readRunEstimates({ projectKey: null, platform: 'ios' })).toEqual({ coldBuildMs: null, podsMs: null });
  });

  test('a corrupt file and a throwing read are silent: the run gets no estimate and no note', () => {
    writeFileSync(statsFile(), 'not json at all');

    expect(readRunEstimates({ projectKey: root, platform: 'ios' })).toEqual({ coldBuildMs: null, podsMs: null });
    expect(
      readRunEstimates({
        projectKey: root,
        platform: 'ios',
        read: () => {
          throw new Error('nope');
        },
      }),
    ).toEqual({ coldBuildMs: null, podsMs: null });
    expect(readFileSync(statsFile(), 'utf-8')).toBe('not json at all');
  });
});

function runStats(argv: string[] = []): { out: string[]; err: string[] } {
  const program = new Command();
  statsCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg) => out.push(String(msg));
  console.error = (msg) => err.push(String(msg));
  try {
    program.parse(['node', 'stim', 'stats', ...argv]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out, err };
}

function inDir<T>(dir: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

describe('stim stats', () => {
  test('prints the project section and the machine section', () => {
    let record = updateStats(emptyStats(), run({ projectKey: root, durationMs: 252_000 }), T0);
    record = updateStats(record, run({ projectKey: root, cacheHit: 'local', durationMs: 31_000 }), T1);
    record = updateStats(record, run({ projectKey: root, failed: true, durationMs: 4_000 }), T1);
    record = updateStats(record, run({ projectKey: '/elsewhere', platform: 'android', durationMs: 400_000 }), T1);
    writeFileSync(statsFile(), JSON.stringify(record));

    const { out: lines, err } = inDir(root, () => runStats());

    expect(lines[0]).toBe(`project ${root}`);
    expect(lines[1]).toMatch(
      /^ {2}ios {6}3 runs \(1 failed\) {3}1 hits \(50%\) {3}cold run 4m12s avg {3}hit run 31s avg {3}saved ~3m41s \(estimated\) {3}since 2026-09-01$/,
    );
    expect(err).toEqual([]);
    expect(lines).toContain('machine');
    const machine = lines.slice(lines.indexOf('machine') + 1);
    expect(machine.some((line) => line.includes('android') && line.includes('cold run 6m40s avg'))).toBe(true);
    expect(existsSync(join(tmpHome, 'config.json'))).toBe(false);
  });

  test('an hours estimate reads in hours', () => {
    let record = updateStats(emptyStats(), run({ projectKey: root, durationMs: 8_000_000 }), T0);
    record = updateStats(record, run({ projectKey: root, cacheHit: 'local', durationMs: 20_000 }), T1);
    writeFileSync(statsFile(), JSON.stringify(record));

    const { out: lines } = inDir(root, () => runStats());

    expect(lines[1]).toContain('saved ~2h13m (estimated)');
  });

  test('a section with no bucket says so, and a column with no denominator prints -', () => {
    const record = updateStats(emptyStats(), run({ projectKey: '/elsewhere', durationMs: 100_000 }), T0);
    record.projects[root] = {
      android: {
        runs: 1,
        failed: 1,
        hits: 0,
        misses: 0,
        coldRuns: 0,
        coldRunMs: 0,
        hitRuns: 0,
        hitRunMs: 0,
        timeSavedMs: 0,
        firstRunAt: '2026-09-01T10:00:00.000Z',
        lastRunAt: '2026-09-01T10:00:00.000Z',
      },
    };
    writeFileSync(statsFile(), JSON.stringify(record));

    const { out: lines } = inDir(root, () => runStats());

    expect(lines[1]).toContain('1 runs (1 failed)   0 hits (-)   cold run - avg   hit run - avg');
    expect(lines[1]).not.toContain('ios');
  });

  test('with no file at all both sections report no runs', () => {
    const { out: lines, err } = inDir(root, () => runStats());

    expect(err).toEqual([]);
    expect(lines).toEqual([`project ${root}`, '  no runs recorded', 'machine', '  no runs recorded']);
    expect(existsSync(statsFile())).toBe(false);
  });

  test('outside a project only the machine section prints', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stim-outside-')));
    writeFileSync(statsFile(), JSON.stringify(updateStats(emptyStats(), run({ projectKey: '/elsewhere' }), T0)));

    const { out: lines } = inDir(outside, () => runStats());

    expect(lines[0]).toBe('machine');
    expect(lines.some((line) => line.startsWith('project '))).toBe(false);

    rmSync(outside, { recursive: true, force: true });
  });

  test('--json prints exactly one parseable line in the documented shape', () => {
    const record = updateStats(emptyStats(), run({ projectKey: root, durationMs: 240_000 }), T0);
    writeFileSync(statsFile(), JSON.stringify(record));

    const { out: lines, err } = inDir(root, () => runStats(['--json']));

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] as string);
    expect(payload.version).toBe(1);
    expect(payload.project.key).toBe(root);
    expect(payload.project.ios.coldRunMs).toBe(240_000);
    expect(payload.project.android).toBe(null);
    expect(payload.machine.ios.runs).toBe(1);
    expect(payload.machine.android).toBe(null);
    expect(err).toEqual([]);
  });

  test('a file this Stim cannot use costs one stderr line and leaves stdout alone', () => {
    writeFileSync(statsFile(), JSON.stringify({ version: 2, machine: {}, projects: {} }));
    const newer = inDir(root, () => runStats());

    expect(newer.err).toHaveLength(1);
    expect(newer.err[0]).toMatch(/are version 2, which this Stim does not understand/);
    expect(newer.out).toEqual([`project ${root}`, '  no runs recorded', 'machine', '  no runs recorded']);

    writeFileSync(statsFile(), '{ this is not json');
    const corrupt = inDir(root, () => runStats(['--json']));

    expect(corrupt.err).toHaveLength(1);
    expect(corrupt.err[0]).toMatch(/could not be read; the next ios or android run moves them aside/);
    expect(corrupt.out).toHaveLength(1);
    expect(JSON.parse(corrupt.out[0] as string).project.ios).toBe(null);
    expect(readFileSync(statsFile(), 'utf-8')).toBe('{ this is not json');
  });

  test('--json outside a project reports a null project', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stim-outside-')));

    const { out: lines } = inDir(outside, () => runStats(['--json']));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      version: 1,
      project: null,
      machine: { ios: null, android: null },
    });

    rmSync(outside, { recursive: true, force: true });
  });
});
