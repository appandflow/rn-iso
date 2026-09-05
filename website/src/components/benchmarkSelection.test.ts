import { describe, expect, it } from 'vitest';
import { benchmarkDimensions, benchmarkForDimensions, benchmarkModelLabel, defaultRun } from './benchmarkSelection';
import type { BenchmarkData } from './benchmarkData';

function benchmark(
  stage: string,
  model: string,
  platform: 'ios' | 'android' | undefined,
  suite: 'readiness' | 'launch-crash' | undefined,
): BenchmarkData {
  return {
    stage,
    title: stage,
    platform,
    suite,
    pricing: model.startsWith('gpt-') ? { model } : null,
    environment: { simulator: platform === 'android' ? 'Android emulator' : 'iPhone Simulator' },
    runs: [
      { id: 'javascript-stim', model, platform, valid: true },
      { id: 'native-stim', model, platform, valid: true },
    ],
  } as BenchmarkData;
}

describe('benchmark catalog selection', () => {
  const readinessIos = benchmark('sol-ios', 'gpt-5.6-sol', 'ios', 'readiness');
  const readinessAndroid = benchmark('sol-android', 'gpt-5.6-sol', 'android', 'readiness');
  const crashIos = benchmark('sol-crash', 'gpt-5.6-sol', 'ios', 'launch-crash');
  const lunaIos = benchmark('luna-ios', 'gpt-5.6-luna', undefined, undefined);
  const catalog = [lunaIos, readinessIos, readinessAndroid, crashIos];

  it('derives missing legacy dimensions from the run and environment', () => {
    expect(benchmarkDimensions(lunaIos)).toEqual({
      model: 'gpt-5.6-luna',
      platform: 'ios',
      suite: 'readiness',
    });
  });

  it('selects model, platform, and suite independently', () => {
    expect(
      benchmarkForDimensions(catalog, { model: 'gpt-5.6-sol', platform: 'ios', suite: 'launch-crash' })?.stage,
    ).toBe('sol-crash');
    expect(
      benchmarkForDimensions(catalog, { model: 'gpt-5.6-sol', platform: 'android', suite: 'launch-crash' })?.stage,
    ).toBe('sol-android');
  });

  it('preserves a run when the destination provides it', () => {
    expect(defaultRun(readinessAndroid, 'native-stim')?.id).toBe('native-stim');
    expect(defaultRun(readinessAndroid, 'missing')?.id).toBe('javascript-stim');
  });

  it('formats the catalog model identifiers for picker labels', () => {
    expect(benchmarkModelLabel('gpt-5.6-luna')).toBe('Luna');
    expect(benchmarkModelLabel('sonnet')).toBe('Sonnet');
  });
});
