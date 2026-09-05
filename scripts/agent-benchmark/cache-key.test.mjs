import { describe, expect, it } from 'vitest';
import { selectBenchmarkCacheKey } from './cache-key.mjs';

describe('benchmark cache key selection', () => {
  it('selects the exact iOS simulator key', () => {
    expect(selectBenchmarkCacheKey('ios', 'abc', ['abc-debug-sim', 'abc-debug-sim-arm64-v8a'])).toBe('abc-debug-sim');
  });

  it('selects the ABI-scoped Android simulator key', () => {
    expect(selectBenchmarkCacheKey('android', 'abc', ['abc-debug-sim-arm64-v8a'])).toBe('abc-debug-sim-arm64-v8a');
  });

  it('rejects missing or ambiguous Android keys', () => {
    expect(() => selectBenchmarkCacheKey('android', 'abc', [])).toThrow(/got \[\]/);
    expect(() =>
      selectBenchmarkCacheKey('android', 'abc', ['abc-debug-sim-arm64-v8a', 'abc-debug-sim-x86_64']),
    ).toThrow(/arm64-v8a.*x86_64/);
  });
});
