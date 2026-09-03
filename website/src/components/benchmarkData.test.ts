import { describe, expect, it } from 'vitest';
import { assignCommandLanes, formatSeconds, type BenchmarkCommand } from './benchmarkData';

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
});
