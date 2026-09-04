export type BenchmarkCommand = {
  command: string;
  startSeconds: number;
  endSeconds: number;
  output: string;
};

export type BenchmarkTerminalRow = {
  kind: 'command' | 'active' | 'output';
  text: string;
};

function compactCommand(command: string) {
  if (command.includes('agent-device/SKILL.md')) return 'read skill: agent-device';
  if (command.includes('stim/SKILL.md')) return 'read skill: stim';
  return command
    .replaceAll('results/luna-rc12/javascript-stim/', '')
    .replaceAll('worktree/bench+javascript-stim', '<worktree>')
    .replaceAll('<simulator-udid>', '<owned-udid>');
}

function outputFor(entry: BenchmarkCommand) {
  if (entry.command.includes('/SKILL.md')) return 'loaded';
  return entry.output.trimEnd();
}

export function terminalRows(commands: BenchmarkCommand[], sourceSeconds: number) {
  return commands
    .filter((entry) => entry.startSeconds <= sourceSeconds)
    .flatMap((entry) => {
      const active = sourceSeconds < entry.endSeconds;
      const output = outputFor(entry);
      const rows: BenchmarkTerminalRow[] = [{ kind: 'command', text: `$ ${compactCommand(entry.command)}` }];
      if (active) {
        rows.push({
          kind: 'active',
          text: `running ${Math.max(0, sourceSeconds - entry.startSeconds).toFixed(1)}s`,
        });
      } else if (output) {
        rows.push({ kind: 'output', text: output });
      }
      return rows;
    });
}
