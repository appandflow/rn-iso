import { describe, expect, it } from 'vitest';
import {
  assignCommandLanes,
  benchmarkSelectionFromSearch,
  benchmarkSelectionSearch,
  comparableRuns,
  comparisonOutcome,
  commandAtCursor,
  formatSeconds,
  initialAuditSelection,
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
