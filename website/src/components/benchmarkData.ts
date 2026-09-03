export type BenchmarkCommand = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  command: string;
  output: string;
  exitCode: number | null;
};

export type BenchmarkMessage = {
  id: string;
  atSeconds: number;
  text: string;
};

export type BenchmarkMarker = {
  id: string;
  kind: 'appAlive' | 'settingsReady';
  label: string;
  atSeconds: number;
};

export type BenchmarkUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type BenchmarkRun = {
  id: string;
  model: string;
  variant: 'javascript' | 'native';
  arm: 'stim' | 'control';
  valid: boolean;
  invalidReasons: string[];
  settingsReadySeconds: number | null;
  appAliveSeconds: number | null;
  totalSeconds: number;
  commandCount: number;
  usage: BenchmarkUsage;
  estimatedTokenCostUsd: number | null;
  messages: BenchmarkMessage[];
  commands: BenchmarkCommand[];
  markers: BenchmarkMarker[];
  proof: {
    src: string;
    expected: string;
    width: number;
    height: number;
  } | null;
};

export type BenchmarkData = {
  schemaVersion: number;
  stage: string;
  title: string;
  protocolVersion: number;
  recordedOn: string;
  primaryMetric: string;
  pricing: {
    model: string;
    inputPerMillion: number;
    cachedInputPerMillion: number;
    outputPerMillion: number;
    source: string;
    estimateNote: string;
  } | null;
  runs: BenchmarkRun[];
};

export type BenchmarkAuditSelection =
  | { kind: 'command'; event: BenchmarkCommand }
  | { kind: 'message'; event: BenchmarkMessage }
  | { kind: 'marker'; event: BenchmarkMarker };

export type CommandWithLane = BenchmarkCommand & { lane: number };

export function assignCommandLanes(commands: BenchmarkCommand[]): {
  commands: CommandWithLane[];
  laneCount: number;
} {
  const laneEnds: number[] = [];
  const ordered: BenchmarkCommand[] = [];
  for (const command of commands) {
    const insertionIndex = ordered.findIndex(
      (candidate) =>
        candidate.startSeconds > command.startSeconds ||
        (candidate.startSeconds === command.startSeconds && candidate.endSeconds > command.endSeconds),
    );
    if (insertionIndex === -1) ordered.push(command);
    else ordered.splice(insertionIndex, 0, command);
  }
  const assigned = ordered.map((command) => {
    let lane = laneEnds.findIndex((end) => end <= command.startSeconds);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(command.endSeconds);
    } else {
      laneEnds[lane] = command.endSeconds;
    }
    return Object.assign({}, command, { lane });
  });
  return { commands: assigned, laneCount: Math.max(1, laneEnds.length) };
}

export function totalTokens(usage: BenchmarkUsage): number {
  return usage.input_tokens + usage.output_tokens;
}

export function comparableRuns(runs: BenchmarkRun[]): Array<BenchmarkRun & { settingsReadySeconds: number }> {
  return runs.filter(
    (run): run is BenchmarkRun & { settingsReadySeconds: number } => run.valid && run.settingsReadySeconds !== null,
  );
}

export function initialAuditSelection(run: BenchmarkRun): BenchmarkAuditSelection | null {
  const longestCommand = run.commands.reduce<BenchmarkCommand | undefined>(
    (longest, command) =>
      !longest || command.endSeconds - command.startSeconds > longest.endSeconds - longest.startSeconds
        ? command
        : longest,
    undefined,
  );
  if (longestCommand) return { kind: 'command', event: longestCommand };
  if (run.markers[0]) return { kind: 'marker', event: run.markers[0] };
  if (run.messages[0]) return { kind: 'message', event: run.messages[0] };
  return null;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export function formatSeconds(value: number | null): string {
  if (value === null) return 'unavailable';
  const rounded = Math.round(value);
  if (rounded >= 60) {
    return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)}s`;
}

export function formatCost(value: number | null): string {
  return value == null ? 'unavailable' : `$${value.toFixed(3)}`;
}
