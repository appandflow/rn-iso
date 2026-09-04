import { describe, expect, it } from 'vitest';
import {
  assignCommandLanes,
  benchmarkDisplayTitle,
  benchmarkSelectionFromSearch,
  benchmarkSelectionSearch,
  benchmarkOverview,
  comparableRuns,
  comparisonOutcome,
  commandAtCursor,
  formatSeconds,
  initialAuditSelection,
  timelineZoomFromPinch,
  timeBreakdown,
  type BenchmarkData,
  type BenchmarkCommand,
  type BenchmarkRun,
} from './benchmarkData';

const navigationBenchmarks = [
  {
    stage: 'luna-rc12',
    runs: [
      { id: 'javascript-stim', valid: true },
      { id: 'native-stim', valid: true },
      { id: 'luna-invalid', valid: false },
    ],
  },
  {
    stage: 'sol-rc12',
    runs: [
      { id: 'javascript-stim', valid: true },
      { id: 'native-stim', valid: true },
    ],
  },
] as BenchmarkData[];

function command(id: string, startSeconds: number, endSeconds: number): BenchmarkCommand {
  return { id, startSeconds, endSeconds, command: id, output: '', exitCode: 0 };
}

describe('assignCommandLanes', () => {
  it('puts concurrent commands on separate rows and reuses rows after completion', () => {
    const result = assignCommandLanes([command('long', 1, 10), command('concurrent', 2, 4), command('later', 4, 7)]);

    expect(result.laneCount).toBe(2);
    expect(result.commands.map(({ id, lane }) => [id, lane])).toEqual([
      ['long', 0],
      ['concurrent', 1],
      ['later', 1],
    ]);
  });
});

describe('formatSeconds', () => {
  it('formats longer durations as minutes and seconds', () => {
    expect(formatSeconds(133.857)).toBe('2m 14s');
    expect(formatSeconds(479.412)).toBe('7m 59s');
  });

  it('keeps short command durations in seconds', () => {
    expect(formatSeconds(2.55)).toBe('2.5s');
    expect(formatSeconds(30)).toBe('30s');
  });

  it('chooses minutes after rounding and handles a missing endpoint', () => {
    expect(formatSeconds(59.6)).toBe('1m 0s');
    expect(formatSeconds(59.4)).toBe('59s');
    expect(formatSeconds(null)).toBe('unavailable');
  });
});

describe('benchmarkDisplayTitle', () => {
  it('removes release and benchmark versions from display titles', () => {
    expect(benchmarkDisplayTitle('Luna rc.12')).toBe('Luna');
    expect(benchmarkDisplayTitle('Sonnet RC12')).toBe('Sonnet');
    expect(benchmarkDisplayTitle('Benchmark v4')).toBe('Benchmark');
  });

  it('keeps model version numbers that are part of the name', () => {
    expect(benchmarkDisplayTitle('GPT-5.6 Luna')).toBe('GPT-5.6 Luna');
  });
});

describe('comparableRuns', () => {
  it('excludes invalid and missing Settings endpoints', () => {
    const valid = { id: 'valid', valid: true, settingsReadySeconds: 42 } as BenchmarkRun;
    const invalid = { id: 'invalid', valid: false, settingsReadySeconds: 31 } as BenchmarkRun;
    const missing = { id: 'missing', valid: true, settingsReadySeconds: null } as BenchmarkRun;

    expect(comparableRuns([valid, invalid, missing]).map((run) => run.id)).toEqual(['valid']);
  });
});

describe('benchmark URL selection', () => {
  it('selects an explicitly linked benchmark and valid run', () => {
    expect(benchmarkSelectionFromSearch('?benchmark=sol-rc12&run=native-stim', navigationBenchmarks)).toEqual({
      stage: 'sol-rc12',
      runId: 'native-stim',
    });
  });

  it('requires the benchmark for a run link and rejects invalid runs', () => {
    expect(benchmarkSelectionFromSearch('?run=native-stim', navigationBenchmarks)).toEqual({
      stage: 'luna-rc12',
      runId: 'javascript-stim',
    });
    expect(benchmarkSelectionFromSearch('?benchmark=luna-rc12&run=luna-invalid', navigationBenchmarks)).toEqual({
      stage: 'luna-rc12',
      runId: 'javascript-stim',
    });
  });

  it('uses a clean URL for the default and stable query parameters otherwise', () => {
    expect(benchmarkSelectionSearch({ stage: 'luna-rc12', runId: 'javascript-stim' }, navigationBenchmarks)).toBe('');
    expect(benchmarkSelectionSearch({ stage: 'sol-rc12', runId: 'native-stim' }, navigationBenchmarks)).toBe(
      '?benchmark=sol-rc12&run=native-stim',
    );
  });
});

describe('benchmarkOverview', () => {
  it('builds paired rows with shared scaling and exact audit links', () => {
    const overview = benchmarkOverview(
      [
        {
          stage: 'first',
          title: 'First',
          runs: [
            { id: 'first-stim', arm: 'stim', variant: 'native', valid: true, settingsReadySeconds: 50 },
            { id: 'first-control', arm: 'control', variant: 'native', valid: true, settingsReadySeconds: 100 },
          ],
        },
        {
          stage: 'second',
          title: 'Second',
          runs: [
            { id: 'second-stim', arm: 'stim', variant: 'native', valid: true, settingsReadySeconds: 200 },
            { id: 'wrong-variant', arm: 'control', variant: 'javascript', valid: true, settingsReadySeconds: 400 },
          ],
        },
      ] as BenchmarkData[],
      'native',
    );

    expect(overview.maxSeconds).toBe(200);
    expect(overview.rows[0]?.arms.map(({ arm, widthPercent, href }) => ({ arm, widthPercent, href }))).toEqual([
      { arm: 'stim', widthPercent: 25, href: '/benchmarks#audit-title' },
      { arm: 'control', widthPercent: 50, href: '/benchmarks?benchmark=first&run=first-control#audit-title' },
    ]);
    expect(overview.rows[1]?.arms[0]).toMatchObject({
      arm: 'stim',
      label: 'Stim',
      widthPercent: 100,
      href: '/benchmarks?benchmark=second&run=second-stim#audit-title',
    });
    expect(overview.rows[1]?.arms[1]).toEqual({
      arm: 'control',
      label: 'Control',
      run: null,
      widthPercent: 0,
      href: null,
    });
  });

  it('treats invalid and valid runs without a Settings endpoint as missing', () => {
    const overview = benchmarkOverview(
      [
        {
          stage: 'missing',
          title: 'Missing',
          runs: [
            { id: 'invalid', arm: 'stim', variant: 'javascript', valid: false, settingsReadySeconds: 30 },
            { id: 'no-endpoint', arm: 'control', variant: 'javascript', valid: true, settingsReadySeconds: null },
          ],
        },
      ] as BenchmarkData[],
      'javascript',
    );

    expect(overview.maxSeconds).toBe(1);
    expect(overview.rows[0]?.arms.every((arm) => arm.run === null && arm.href === null && arm.widthPercent === 0)).toBe(
      true,
    );
  });
});

describe('comparisonOutcome', () => {
  it('describes both faster and slower Stim results without negative percentages', () => {
    expect(comparisonOutcome(80, 100)).toEqual({ label: 'Stim reached Settings 20% sooner', tone: 'gain' });
    expect(comparisonOutcome(108, 100)).toEqual({ label: 'Stim reached Settings 8% slower', tone: 'loss' });
  });

  it('handles equal and unavailable comparisons', () => {
    expect(comparisonOutcome(100, 100)).toEqual({
      label: 'Stim and control reached Settings in the same time',
      tone: 'neutral',
    });
    expect(comparisonOutcome(null, 100)).toEqual({ label: 'Matched run unavailable', tone: 'neutral' });
  });
});

describe('timelineZoomFromPinch', () => {
  it('scales from the gesture start and clamps to the supported range', () => {
    expect(timelineZoomFromPinch(2, 100, 150)).toBe(3);
    expect(timelineZoomFromPinch(3, 100, 200)).toBe(4);
    expect(timelineZoomFromPinch(2, 100, 20)).toBe(1);
  });
});

describe('initialAuditSelection', () => {
  it('returns an empty audit state when an invalid run has no events or proof', () => {
    const run = {
      valid: false,
      commands: [],
      markers: [],
      messages: [],
      proof: null,
    } as unknown as BenchmarkRun;

    expect(initialAuditSelection(run)).toBeNull();
    expect(run.proof).toBeNull();
  });
});

describe('timeBreakdown', () => {
  it('uses command interval union for wall time and reports concurrency separately', () => {
    const run = {
      totalSeconds: 20,
      commands: [command('first', 2, 10), command('overlap', 5, 8), command('later', 12, 15)],
    } as BenchmarkRun;

    expect(timeBreakdown(run)).toEqual({
      shellActiveSeconds: 11,
      agentOtherSeconds: 9,
      summedCommandSeconds: 14,
      peakConcurrency: 2,
    });
  });
});

describe('commandAtCursor', () => {
  const commands = [command('first', 2, 10), command('overlap', 5, 8), command('later', 12, 15)];

  it('shows the most recently started active command without revealing its final output', () => {
    expect(commandAtCursor(commands, 6)).toEqual({ command: commands[1], state: 'running' });
  });

  it('keeps the most recently completed command visible between events', () => {
    expect(commandAtCursor(commands, 11)).toEqual({ command: commands[0], state: 'complete' });
    expect(commandAtCursor(commands, 0)).toBeNull();
  });

  it('returns to an outer command while it remains active after a nested command completes', () => {
    expect(commandAtCursor(commands, 9)).toEqual({ command: commands[0], state: 'running' });
  });
});
