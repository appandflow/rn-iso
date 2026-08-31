import { existsSync } from 'node:fs';
import {
  callWithTimeout,
  type BuildCacheCapability,
  type BuildCacheTarget,
  type LoadCacheProviderResult,
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

export type LoadBuildProvider = () => Promise<LoadCacheProviderResult> | LoadCacheProviderResult;

export interface ResolveTieredBuildOptions {
  local: BuildCacheCapability;
  loadProvider?: LoadBuildProvider | null;
  target: BuildCacheTarget;
  destinationDir: string;
  skipRead?: boolean;
  warn?: WarnOnce;
  timeoutMs?: number;
}

export interface StoreTieredBuildOptions {
  local: BuildCacheCapability;
  loadProvider?: LoadBuildProvider | null;
  target: BuildCacheTarget;
  sourcePath: string;
  overwrite: boolean;
  warn?: WarnOnce;
  timeoutMs?: number;
}

interface BuildProviderTier {
  capability: BuildCacheCapability;
  name: string;
}

async function providerTier(
  loadProvider: LoadBuildProvider | null | undefined,
  warn: WarnOnce,
): Promise<BuildProviderTier | null> {
  if (!loadProvider) return null;
  const loaded = await loadProvider();
  if (loaded?.unavailable) {
    warn(
      'provider-load',
      `provider not usable (${loaded.name ?? 'the cache provider'}): ${loaded.unavailable}; using local cache`,
    );
    return null;
  }
  const capability = loaded?.provider?.builds;
  if (!capability) return null;
  return { capability, name: loaded.name ?? 'the cache provider' };
}

export interface TieredBuildStoreResult {
  localPath: string | null;
  providerUpload: Promise<ProviderCallResult<void>> | null;
  providerName: string | null;
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

function ignore(): void {}

export async function resolveTieredBuild({
  local,
  loadProvider = null,
  target,
  destinationDir,
  skipRead = false,
  warn = ignore,
  timeoutMs = BUILD_RESOLVE_TIMEOUT_MS,
}: ResolveTieredBuildOptions): Promise<TieredBuildResolution | null> {
  if (skipRead) return null;

  const hit = await local.resolve({ ...target, destinationDir, signal: neverAborted() });
  if (hit) return { path: hit, tier: 'local' };

  const tier = await providerTier(loadProvider, warn);
  if (!tier) return null;

  const { capability: provider, name: label } = tier;
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
  return { path: stored || path, tier: 'provider', providerName: label, storedLocally: Boolean(stored) };
}

export async function storeTieredBuild({
  local,
  loadProvider = null,
  target,
  sourcePath,
  overwrite,
  warn = ignore,
  timeoutMs = BUILD_UPLOAD_TIMEOUT_MS,
}: StoreTieredBuildOptions): Promise<TieredBuildStoreResult> {
  const localPath = (await local.store({ ...target, sourcePath, overwrite, signal: neverAborted() })) || null;

  const tier = await providerTier(loadProvider, warn);
  if (!tier) return { localPath, providerUpload: null, providerName: null };

  const providerUpload = callWithTimeout<void>(async (signal) => {
    await tier.capability.store({ ...target, sourcePath, overwrite, signal });
  }, timeoutMs);
  return { localPath, providerUpload, providerName: tier.name };
}
