import { describe, expect, it } from 'vitest';
import { terminalRows, type BenchmarkCommand } from '../../video/terminalRows';

function command(overrides: Partial<BenchmarkCommand> = {}): BenchmarkCommand {
  return {
    command: 'example',
    startSeconds: 0,
    endSeconds: 1,
    output: '',
    ...overrides,
  };
}

describe('terminalRows', () => {
  it('preserves multiline command output', () => {
    expect(terminalRows([command({ output: 'first\n  second\n\nfourth\n' })], 2)).toEqual([
      { kind: 'command', text: '$ example' },
      { kind: 'output', text: 'first\n  second\n\nfourth' },
    ]);
  });

  it('keeps the full transcript so the viewport can scroll it', () => {
    const commands = Array.from({ length: 14 }, (_, index) =>
      command({ command: `command-${index}`, startSeconds: index, endSeconds: index + 0.5 }),
    );

    const rows = terminalRows(commands, 20);

    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual({ kind: 'command', text: '$ command-0' });
    expect(rows.at(-1)).toEqual({ kind: 'command', text: '$ command-13' });
  });

  it('shows only elapsed time while a command is active', () => {
    expect(terminalRows([command({ endSeconds: 10, output: 'future output' })], 2)).toEqual([
      { kind: 'command', text: '$ example' },
      { kind: 'active', text: 'running 2.0s' },
    ]);
  });
});
