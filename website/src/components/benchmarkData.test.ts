import { describe, expect, it } from 'vitest';
import {
  assignCommandLanes,
  comparableRuns,
  commandAtCursor,
  formatSeconds,
  initialAuditSelection,
  timeBreakdown,
  type BenchmarkCommand,
  type BenchmarkRun,
} from './benchmarkData';

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

  it('keeps the latest completed command visible between events', () => {
    expect(commandAtCursor(commands, 11)).toEqual({ command: commands[1], state: 'complete' });
    expect(commandAtCursor(commands, 0)).toBeNull();
  });
});
