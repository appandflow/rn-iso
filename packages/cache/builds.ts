import { existsSync } from 'node:fs';
import {
  callWithTimeout,
  type BuildCacheCapability,
  type BuildCacheTarget,
  type ProviderCallResult,
  type WarnOnce,
} from './provider.ts';

export const BUILD_RESOLVE_TIMEOUT_MS = 30_000;
export const BUILD_UPLOAD_TIMEOUT_MS = 60_000;

export interface TieredBuildResolution {
  path: string;
  tier: 'local' | 'provider';
  providerName?: string;
  storedLocally?: boolean;
}

export interface ResolveTieredBuildOptions {
  local: BuildCacheCapability;
  provider?: BuildCacheCapability | null;
  providerName?: string | null;
  target: BuildCacheTarget;
  destinationDir: string;
  skipRead?: boolean;
  warn?: WarnOnce;
  timeoutMs?: number;
}

export interface StoreTieredBuildOptions {
  local: BuildCacheCapability;
  provider?: BuildCacheCapability | null;
  target: BuildCacheTarget;
  sourcePath: string;
  overwrite: boolean;
  timeoutMs?: number;
}

export interface TieredBuildStoreResult {
  localPath: string | null;
  providerUpload: Promise<ProviderCallResult<void>> | null;
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

function ignore(): void {}

export async function resolveTieredBuild({
  local,
  provider = null,
  providerName = null,
  target,
  destinationDir,
  skipRead = false,
  warn = ignore,
  timeoutMs = BUILD_RESOLVE_TIMEOUT_MS,
}: ResolveTieredBuildOptions): Promise<TieredBuildResolution | null> {
  if (skipRead) return null;

  const hit = await local.resolve({ ...target, destinationDir, signal: neverAborted() });
  if (hit) return { path: hit, tier: 'local' };
  if (!provider) return null;

  const label = providerName || 'the cache provider';
  const outcome = await callWithTimeout((signal) => provider.resolve({ ...target, destinationDir, signal }), timeoutMs);
  if (outcome.timedOut) {
    warn('provider-resolve', `${label} did not answer within ${timeoutMs}ms; building instead`);
    return null;
  }
  if (outcome.failed) {
    warn('provider-resolve', `${label} could not be used: ${outcome.failed}; building instead`);
    return null;
  }
  const path = typeof outcome.value === 'string' ? outcome.value.trim() : '';
  if (path === '') return null;
  if (!existsSync(path)) {
    warn('provider-resolve', `${label} returned ${path}, which does not exist; building instead`);
    return null;
  }

  let stored: string | null = null;
  try {
    stored = (await local.store({ ...target, sourcePath: path, overwrite: false, signal: neverAborted() })) || null;
  } catch (error) {
    warn(
      'provider-backfill',
      `a ${label} hit could not be stored locally: ${String((error as Error)?.message || error)}`,
    );
  }
  return {
    path: stored || path,
    tier: 'provider',
    ...(providerName ? { providerName } : {}),
    storedLocally: Boolean(stored),
  };
}

export async function storeTieredBuild({
  local,
  provider = null,
  target,
  sourcePath,
  overwrite,
  timeoutMs = BUILD_UPLOAD_TIMEOUT_MS,
}: StoreTieredBuildOptions): Promise<TieredBuildStoreResult> {
  const localPath = (await local.store({ ...target, sourcePath, overwrite, signal: neverAborted() })) || null;
  if (!provider) return { localPath, providerUpload: null };

  const providerUpload = callWithTimeout<void>(async (signal) => {
    await provider.store({ ...target, sourcePath, overwrite, signal });
  }, timeoutMs);
  return { localPath, providerUpload };
}
