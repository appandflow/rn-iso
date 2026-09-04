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
  kind: 'appAlive' | 'diagnosis' | 'settingsReady';
  label: string;
  atSeconds: number;
};

export type BenchmarkBackgroundProcess = {
  id: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
  launcherCommandId: string;
  monitorCount: number;
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
  platform?: 'ios' | 'android';
  variant: 'javascript' | 'native' | 'launch-crash';
  arm: 'stim' | 'control';
  valid: boolean;
  invalidReasons: string[];
  settingsReadySeconds: number | null;
  appAliveSeconds: number | null;
  diagnosisSeconds?: number | null;
  diagnosisCommandCount?: number | null;
  launchCrashAudit?: {
    initialLaunchCommandId: string;
    errorCaptureCommandId: string;
    diagnosisCommandId: string;
    repairedLaunchCommandId: string;
    screenshotCommandId: string;
  } | null;
  diagnosisUsage?: BenchmarkUsage | null;
  estimatedDiagnosisCostUsd?: number | null;
  totalSeconds: number;
  commandCount: number;
  usage: BenchmarkUsage;
  estimatedTokenCostUsd: number | null;
  summary: string;
  messages: BenchmarkMessage[];
  commands: BenchmarkCommand[];
  backgroundProcesses: BenchmarkBackgroundProcess[];
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
  suite?: 'readiness' | 'launch-crash';
  platform?: 'ios' | 'android';
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
  environment: BenchmarkEnvironment;
  runs: BenchmarkRun[];
};

export type BenchmarkEnvironment = {
  machine: {
    model: string;
    chip: string;
    memory: string;
  };
  macos: string;
  xcode: string;
  node: string;
  simulator: string;
};

export type BenchmarkAuditSelection =
  | { kind: 'command'; event: BenchmarkCommand }
  | { kind: 'message'; event: BenchmarkMessage }
  | { kind: 'marker'; event: BenchmarkMarker }
  | { kind: 'background'; event: BenchmarkBackgroundProcess };

export type BenchmarkTimeBreakdown = {
  shellActiveSeconds: number;
  agentOtherSeconds: number;
  summedCommandSeconds: number;
  peakConcurrency: number;
};

export type PlaybackCommand = {
  command: BenchmarkCommand;
  state: 'running' | 'complete';
};

export type CommandWithLane = BenchmarkCommand & { lane: number };

export type BenchmarkComparison = {
  label: string;
  tone: 'gain' | 'loss' | 'neutral';
};

export type BenchmarkRouteSelection = {
  stage: string;
  runId: string;
};

export type BenchmarkOverviewArm = {
  arm: BenchmarkRun['arm'];
  label: 'Stim' | 'Control';
  run: (BenchmarkRun & { settingsReadySeconds: number }) | null;
  widthPercent: number;
  href: string | null;
};

export type BenchmarkOverviewRow = {
  stage: string;
  title: string;
  arms: BenchmarkOverviewArm[];
};

export type BenchmarkOverview = {
  maxSeconds: number;
  rows: BenchmarkOverviewRow[];
};

function orderedCopy<T>(values: T[], compare: (a: T, b: T) => number): T[] {
  const result: T[] = [];
  for (const value of values) {
    const index = result.findIndex((candidate) => compare(candidate, value) > 0);
    if (index === -1) result.push(value);
    else result.splice(index, 0, value);
  }
  return result;
}

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

export function benchmarkDisplayTitle(title: string): string {
  return title.replace(/\s+(?:rc\.?\d+(?:\.\d+)*|v\d+(?:\.\d+)*)$/i, '');
}

export function comparableRuns(runs: BenchmarkRun[]): Array<BenchmarkRun & { settingsReadySeconds: number }> {
  return runs.filter(
    (run): run is BenchmarkRun & { settingsReadySeconds: number } => run.valid && run.settingsReadySeconds !== null,
  );
}

export function benchmarkSelectionFromSearch(search: string, benchmarks: BenchmarkData[]): BenchmarkRouteSelection {
  const params = new URLSearchParams(search);
  const requestedStage = params.get('benchmark');
  const requestedRun = requestedStage ? params.get('run') : null;
  const benchmark = benchmarks.find((candidate) => candidate.stage === requestedStage) ?? benchmarks[0];
  const validRuns = benchmark?.runs.filter((run) => run.valid) ?? [];
  const run = validRuns.find((candidate) => candidate.id === requestedRun) ?? validRuns[0];
  return { stage: benchmark?.stage ?? '', runId: run?.id ?? '' };
}

export function benchmarkSelectionSearch(selection: BenchmarkRouteSelection, benchmarks: BenchmarkData[]): string {
  const defaults = benchmarkSelectionFromSearch('', benchmarks);
  if (selection.stage === defaults.stage && selection.runId === defaults.runId) return '';
  const params = new URLSearchParams();
  params.set('benchmark', selection.stage);
  params.set('run', selection.runId);
  return `?${params.toString()}`;
}

export function timelineZoomFromPinch(initialZoom: number, initialDistance: number, distance: number): number {
  if (initialDistance <= 0 || distance <= 0) return Math.min(4, Math.max(1, initialZoom));
  return Number(Math.min(4, Math.max(1, initialZoom * (distance / initialDistance))).toFixed(2));
}

export function benchmarkOverview(benchmarks: BenchmarkData[], variant: BenchmarkRun['variant']): BenchmarkOverview {
  const candidates = benchmarks.map((benchmark) => ({
    benchmark,
    runs: comparableRuns(benchmark.runs).filter((run) => run.variant === variant),
  }));
  const maxSeconds = Math.max(1, ...candidates.flatMap(({ runs }) => runs.map((run) => run.settingsReadySeconds)));
  const rows = candidates.map(({ benchmark, runs }) => ({
    stage: benchmark.stage,
    title: benchmark.title,
    arms: (['stim', 'control'] as const).map((arm) => {
      const run = runs.find((candidate) => candidate.arm === arm) ?? null;
      return {
        arm,
        label: (arm === 'stim' ? 'Stim' : 'Control') as BenchmarkOverviewArm['label'],
        run,
        widthPercent: run ? (run.settingsReadySeconds / maxSeconds) * 100 : 0,
        href: run
          ? `/benchmarks${benchmarkSelectionSearch({ stage: benchmark.stage, runId: run.id }, benchmarks)}#audit-title`
          : null,
      };
    }),
  }));
  return { maxSeconds, rows };
}

export function comparisonOutcome(
  stimSeconds: number | null | undefined,
  controlSeconds: number | null | undefined,
): BenchmarkComparison {
  if (stimSeconds == null || controlSeconds == null || controlSeconds <= 0) {
    return { label: 'Matched run unavailable', tone: 'neutral' };
  }
  const signedPercent = Math.round((1 - stimSeconds / controlSeconds) * 100);
  if (signedPercent > 0) {
    return { label: `Stim reached Settings ${signedPercent}% sooner`, tone: 'gain' };
  }
  if (signedPercent < 0) {
    return { label: `Stim reached Settings ${Math.abs(signedPercent)}% slower`, tone: 'loss' };
  }
  return { label: 'Stim and control reached Settings in the same time', tone: 'neutral' };
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

export function timeBreakdown(run: BenchmarkRun): BenchmarkTimeBreakdown {
  const total = Math.max(0, run.totalSeconds);
  const intervals = orderedCopy(
    run.commands
      .map((command) => ({
        start: Math.min(total, Math.max(0, command.startSeconds)),
        end: Math.min(total, Math.max(0, command.endSeconds)),
      }))
      .filter((interval) => interval.end > interval.start),
    (a, b) => a.start - b.start || a.end - b.end,
  );

  let shellActiveSeconds = 0;
  let currentStart: number | null = null;
  let currentEnd = 0;
  for (const interval of intervals) {
    if (currentStart === null) {
      currentStart = interval.start;
      currentEnd = interval.end;
    } else if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      shellActiveSeconds += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }
  if (currentStart !== null) shellActiveSeconds += currentEnd - currentStart;

  const concurrencyEvents = orderedCopy(
    intervals.flatMap((interval) => [
      { at: interval.start, delta: 1 },
      { at: interval.end, delta: -1 },
    ]),
    (a, b) => a.at - b.at || a.delta - b.delta,
  );
  let concurrency = 0;
  let peakConcurrency = 0;
  for (const event of concurrencyEvents) {
    concurrency += event.delta;
    peakConcurrency = Math.max(peakConcurrency, concurrency);
  }

  return {
    shellActiveSeconds,
    agentOtherSeconds: Math.max(0, total - shellActiveSeconds),
    summedCommandSeconds: intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0),
    peakConcurrency,
  };
}

export function commandAtCursor(commands: BenchmarkCommand[], cursorSeconds: number): PlaybackCommand | null {
  const active = orderedCopy(
    commands.filter((command) => command.startSeconds <= cursorSeconds && command.endSeconds > cursorSeconds),
    (a, b) => b.startSeconds - a.startSeconds || b.endSeconds - a.endSeconds,
  )[0];
  if (active) return { command: active, state: 'running' };
  const completed = orderedCopy(
    commands.filter((command) => command.endSeconds <= cursorSeconds),
    (a, b) => b.endSeconds - a.endSeconds || b.startSeconds - a.startSeconds,
  )[0];
  if (completed) return { command: completed, state: 'complete' };
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
