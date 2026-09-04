import type { BenchmarkData, BenchmarkRun } from './benchmarkData';
import benchmarkJson from '@site/src/data/benchmarks/luna-rc12.json';
import opusBenchmarkJson from '@site/src/data/benchmarks/opus-rc12.json';
import sonnetBenchmarkJson from '@site/src/data/benchmarks/sonnet-rc12.json';
import solBenchmarkJson from '@site/src/data/benchmarks/sol-rc12.json';

export const benchmarks = (
  [benchmarkJson, solBenchmarkJson, sonnetBenchmarkJson, opusBenchmarkJson] as BenchmarkData[]
).filter((benchmark) => benchmark.runs.some((run) => run.valid));

export function defaultRun(benchmark: BenchmarkData | undefined): BenchmarkRun | undefined {
  return benchmark?.runs.find((run) => run.valid);
}

export function displayVariant(variant: BenchmarkRun['variant']): string {
  return variant === 'javascript' ? 'JavaScript change' : 'Native change';
}
