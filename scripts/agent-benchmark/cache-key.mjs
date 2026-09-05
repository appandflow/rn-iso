export function selectBenchmarkCacheKey(platform, fingerprint, entries) {
  const base = `${fingerprint}-debug-sim`;
  const matches =
    platform === 'android'
      ? entries.filter((entry) => entry.startsWith(`${base}-`))
      : entries.filter((entry) => entry === base);
  if (matches.length !== 1) {
    throw new Error(`expected one ${platform} benchmark cache key for ${base}, got ${JSON.stringify(matches)}`);
  }
  return matches[0];
}
