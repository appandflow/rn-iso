import type { BenchmarkData, BenchmarkRun } from './benchmarkData';
export { defaultRun } from './benchmarkSelection';
import benchmarkJson from '@site/src/data/benchmarks/luna-rc12.json';
import lunaAndroidBenchmarkJson from '@site/src/data/benchmarks/luna-android.json';
import opusBenchmarkJson from '@site/src/data/benchmarks/opus-rc12.json';
import opusAndroidBenchmarkJson from '@site/src/data/benchmarks/opus-android.json';
import sonnetBenchmarkJson from '@site/src/data/benchmarks/sonnet-rc12.json';
import sonnetAndroidBenchmarkJson from '@site/src/data/benchmarks/sonnet-android.json';
import solBenchmarkJson from '@site/src/data/benchmarks/sol-rc12.json';
import solAndroidBenchmarkJson from '@site/src/data/benchmarks/sol-android.json';
import solLaunchCrashJson from '@site/src/data/benchmarks/sol-launch-crash.json';

export const benchmarks = (
  [
    benchmarkJson,
    lunaAndroidBenchmarkJson,
    solBenchmarkJson,
    solAndroidBenchmarkJson,
    sonnetBenchmarkJson,
    sonnetAndroidBenchmarkJson,
    opusBenchmarkJson,
    opusAndroidBenchmarkJson,
    solLaunchCrashJson,
  ] as BenchmarkData[]
).filter((benchmark) => benchmark.runs.some((run) => run.valid));

export function displayVariant(variant: BenchmarkRun['variant']): string {
  if (variant === 'javascript') return 'JavaScript change';
  if (variant === 'native') return 'Native change';
  return 'JavaScript launch failure';
}
