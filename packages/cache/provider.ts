import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CACHE_PROVIDER_API_VERSION = 1 as const;

export const CACHE_PROVIDER_ENV = 'STIM_CACHE_PROVIDER_CONFIG';

/**
 * One resolved provider selection: the module reference, the options passed to
 * its factory, and the directory the reference resolves from.
 */
export interface CacheProviderConfig {
  provider: string;
  options: Record<string, unknown>;
  baseDir: string;
}

export interface MetroCacheContext {
  projectRoot: string;
  cacheName: string;
  signal: AbortSignal;
}

export interface MetroCacheGetInput extends MetroCacheContext {
  key: Buffer;
}

export interface MetroCacheSetInput extends MetroCacheContext {
  key: Buffer;
  value: unknown;
}

/**
 * Metro transform cache. `get` returns `null` or `undefined` for a miss. `set`
 * stores the value under the key. Both receive an `AbortSignal` the provider
 * must honor.
 */
export interface MetroCacheCapability {
  get(input: MetroCacheGetInput): unknown;
  set(input: MetroCacheSetInput): void | Promise<void>;
}

export interface BuildCacheTarget {
  projectRoot: string;
  platform: 'ios' | 'android';
  key: string;
}

export interface BuildCacheContext extends BuildCacheTarget {
  signal: AbortSignal;
}

export interface BuildResolveInput extends BuildCacheContext {
  destinationDir: string;
}

export interface BuildStoreInput extends BuildCacheContext {
  sourcePath: string;
  overwrite: boolean;
}

/**
 * Native build artifacts. `resolve` places the artifact for the key under
 * `destinationDir` and returns its path, or returns `null` for a miss. `store`
 * uploads the `.app` directory or `.apk` file at `sourcePath`; a capability
 * that owns a local path returns it, and any other capability returns nothing.
 * Stim owns fingerprints and cache keys; the capability owns transport,
 * archive format, authentication, and retention.
 */
export interface BuildCacheCapability {
  resolve(input: BuildResolveInput): string | null | Promise<string | null>;
  store(input: BuildStoreInput): string | null | void | Promise<string | null | void>;
}

export interface CacheProvider {
  metro?: MetroCacheCapability;
  builds?: BuildCacheCapability;
}

/**
 * The module shape a provider author exports. The loader rejects any other
 * `apiVersion`.
 */
export interface CacheProviderModule {
  apiVersion: typeof CACHE_PROVIDER_API_VERSION;
  createCacheProvider(input: {
    projectRoot: string;
    options: Record<string, unknown>;
  }): CacheProvider | Promise<CacheProvider>;
}

export interface LoadCacheProviderResult {
  provider?: CacheProvider;
  name?: string;
  none?: true;
  unavailable?: string;
}

export interface ProviderCallResult<T> {
  value?: T;
  failed?: string;
  timedOut?: true;
}

export type WarnOnce = (code: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reason(error: unknown): string {
  const message = String((error as Error)?.message || error || 'unknown error');
  return message.split('\n')[0]!.trim() || 'unknown error';
}

function moduleCandidate(namespace: unknown): unknown {
  if (!isRecord(namespace)) return namespace;
  if ('apiVersion' in namespace) return namespace;
  return 'default' in namespace ? namespace.default : namespace;
}

function capabilityError(provider: CacheProvider): string | null {
  const metro = provider.metro;
  if (metro !== undefined && (typeof metro?.get !== 'function' || typeof metro?.set !== 'function')) {
    return 'the metro capability must implement get() and set()';
  }
  const builds = provider.builds;
  if (builds !== undefined && (typeof builds?.resolve !== 'function' || typeof builds?.store !== 'function')) {
    return 'the builds capability must implement resolve() and store()';
  }
  if (metro === undefined && builds === undefined) {
    return 'the provider advertises neither a metro nor a builds capability';
  }
  return null;
}

export async function loadCacheProvider({
  projectRoot,
  config,
}: {
  projectRoot: string;
  config?: CacheProviderConfig | null;
}): Promise<LoadCacheProviderResult> {
  const reference = typeof config?.provider === 'string' ? config.provider.trim() : '';
  if (!config || reference === '') return { none: true };
  const options = isRecord(config.options) ? config.options : {};
  const baseDir = typeof config.baseDir === 'string' && config.baseDir !== '' ? config.baseDir : projectRoot;

  let namespace: unknown;
  try {
    const resolved = createRequire(join(baseDir, 'package.json')).resolve(reference);
    namespace = await import(pathToFileURL(resolved).href);
  } catch (error) {
    return { name: reference, unavailable: reason(error) };
  }

  const candidate = moduleCandidate(namespace);
  if (!isRecord(candidate) || candidate.apiVersion !== CACHE_PROVIDER_API_VERSION) {
    return {
      name: reference,
      unavailable: `expected apiVersion ${CACHE_PROVIDER_API_VERSION}, found ${JSON.stringify(
        isRecord(candidate) ? candidate.apiVersion : candidate,
      )}`,
    };
  }
  if (typeof candidate.createCacheProvider !== 'function') {
    return { name: reference, unavailable: 'the module does not export createCacheProvider()' };
  }

  let provider: unknown;
  try {
    provider = await (candidate as unknown as CacheProviderModule).createCacheProvider({ projectRoot, options });
  } catch (error) {
    return { name: reference, unavailable: `createCacheProvider() failed: ${reason(error)}` };
  }
  if (!isRecord(provider)) {
    return { name: reference, unavailable: 'createCacheProvider() did not return a provider object' };
  }
  const invalid = capabilityError(provider as CacheProvider);
  if (invalid) return { name: reference, unavailable: invalid };

  return { name: reference, provider: provider as CacheProvider };
}

export async function callWithTimeout<T>(
  call: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
): Promise<ProviderCallResult<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
    timer?.unref?.();
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => call(controller.signal))
        .then(
          (value) => ({ value }) as ProviderCallResult<T>,
          (error: unknown) => ({ failed: reason(error) }) as ProviderCallResult<T>,
        ),
      expired,
    ]);
    return outcome === 'timeout' ? { timedOut: true } : outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createWarnOnce(emit: (message: string) => void): WarnOnce {
  const seen = new Set<string>();
  return (code, message) => {
    if (seen.has(code)) return;
    seen.add(code);
    emit(message);
  };
}

export function cacheProviderEnv(config: CacheProviderConfig): string {
  return JSON.stringify({ provider: config.provider, options: config.options ?? {}, baseDir: config.baseDir });
}

export function cacheProviderConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CacheProviderConfig | null {
  const raw = env[CACHE_PROVIDER_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const provider = parsed.provider;
  const baseDir = parsed.baseDir;
  if (typeof provider !== 'string' || provider.trim() === '' || typeof baseDir !== 'string' || baseDir === '') {
    return null;
  }
  return { provider, options: isRecord(parsed.options) ? parsed.options : {}, baseDir };
}
