import type { BenchmarkData, BenchmarkRun } from './benchmarkData';

export type BenchmarkDimensions = {
  model: string;
  platform: 'ios' | 'android';
  suite: 'readiness' | 'launch-crash';
};

export function defaultRun(benchmark: BenchmarkData | undefined, preferredId?: string): BenchmarkRun | undefined {
  return benchmark?.runs.find((run) => run.valid && run.id === preferredId) ?? benchmark?.runs.find((run) => run.valid);
}

export function benchmarkDimensions(benchmark: BenchmarkData): BenchmarkDimensions {
  const firstValidRun = benchmark.runs.find((run) => run.valid);
  return {
    model: benchmark.pricing?.model ?? firstValidRun?.model ?? benchmark.title,
    platform:
      benchmark.platform ??
      firstValidRun?.platform ??
      (/android/i.test(benchmark.environment.simulator) ? 'android' : 'ios'),
    suite: benchmark.suite ?? 'readiness',
  };
}

export function benchmarkModelLabel(model: string): string {
  const knownName = model.match(/(?:^|[-_/])(luna|sol|sonnet|opus)$/i)?.[1];
  const name = knownName ?? model;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

export function benchmarkForDimensions(
  catalog: BenchmarkData[],
  requested: BenchmarkDimensions,
): BenchmarkData | undefined {
  const modelMatches = catalog.filter((candidate) => benchmarkDimensions(candidate).model === requested.model);
  const platformMatches = modelMatches.filter(
    (candidate) => benchmarkDimensions(candidate).platform === requested.platform,
  );
  return (
    platformMatches.find((candidate) => benchmarkDimensions(candidate).suite === requested.suite) ??
    platformMatches.find((candidate) => benchmarkDimensions(candidate).suite === 'readiness') ??
    platformMatches[0] ??
    modelMatches.find((candidate) => benchmarkDimensions(candidate).suite === requested.suite) ??
    modelMatches.find((candidate) => benchmarkDimensions(candidate).suite === 'readiness') ??
    modelMatches[0]
  );
}
