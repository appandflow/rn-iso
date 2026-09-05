import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_LOCK_STALE_MS = 10000;
const DEFAULT_LOCK_WAIT_MS = 12000;
const DEFAULT_LOCK_POLL_MS = 25;
const lockDepths = new Map<string, number>();

export interface DirLockOptions {
  staleMs?: number;
  waitMs?: number;
  pollMs?: number;
  ensureParent?: () => void;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireDirLock(
  lockPath: string,
  {
    staleMs,
    waitMs,
    pollMs,
    ensureParent,
  }: Required<Pick<DirLockOptions, 'staleMs' | 'waitMs' | 'pollMs'>> & Pick<DirLockOptions, 'ensureParent'>,
): void {
  ensureParent?.();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
    let ageMs: number | null = null;
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs > staleMs) {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {}
      continue;
    }
    if (Date.now() >= deadline) {
      const error = new Error(
        `Timed out waiting for the lock at ${lockPath}. ` +
          'Another Stim process is holding it; if none is running, remove that directory.',
      );
      (error as Error & { code?: string; lockPath?: string }).code = 'STIM_LOCK_TIMEOUT';
      (error as Error & { code?: string; lockPath?: string }).lockPath = lockPath;
      throw error;
    }
    sleepSync(pollMs);
  }
}

function releaseDirLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {}
}

export function withDirLock<T>(
  lockPath: string,
  fn: () => T,
  {
    staleMs = DEFAULT_LOCK_STALE_MS,
    waitMs = DEFAULT_LOCK_WAIT_MS,
    pollMs = DEFAULT_LOCK_POLL_MS,
    ensureParent,
  }: DirLockOptions = {},
): T {
  const depth = lockDepths.get(lockPath) || 0;
  if (depth > 0) {
    lockDepths.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      lockDepths.set(lockPath, (lockDepths.get(lockPath) ?? 1) - 1);
    }
  }
  acquireDirLock(lockPath, { staleMs, waitMs, pollMs, ensureParent });
  lockDepths.set(lockPath, 1);
  try {
    return fn();
  } finally {
    lockDepths.set(lockPath, 0);
    releaseDirLock(lockPath);
  }
}

export function configDir(): string {
  return process.env.STIM_HOME || path.join(os.homedir(), '.stim');
}

export function workspaceSlug(projectRoot: string): string {
  const name = path
    .basename(path.resolve(projectRoot))
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48);
  return name || 'workspace';
}

export function workspaceId(projectRoot: string): string {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

export function workspaceName(projectRoot: string): string {
  return `${workspaceSlug(projectRoot)}--${workspaceId(projectRoot)}`;
}

export function workspaceStateDir(projectRoot: string): string {
  return path.join(configDir(), 'workspaces', workspaceName(projectRoot));
}

export function workspaceLogDir(projectRoot: string): string {
  return path.join(workspaceStateDir(projectRoot), 'logs');
}

export function cachePathSetting(key: 'buildCache' | 'metroCache'): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir(), 'config.json'), 'utf-8')) as {
      caches?: Record<string, unknown>;
    };
    const value = parsed?.caches?.[key];
    return typeof value === 'string' && value.startsWith('/') ? value : null;
  } catch {
    return null;
  }
}

export function cacheNameSegment(name: string | null | undefined): string {
  return (
    String(name)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^\.+/, '') || 'app'
  );
}

export function buildCacheRoot(): string {
  return process.env.STIM_BUILD_CACHE || cachePathSetting('buildCache') || path.join(configDir(), 'build-cache');
}

export function metroCacheRoot(name?: string | null): string {
  const root = process.env.STIM_METRO_CACHE || cachePathSetting('metroCache') || path.join(configDir(), 'metro-cache');
  return name === undefined || name === null || name === '' ? root : path.join(root, cacheNameSegment(name));
}

export const STORE_ROOT_TAG = 'stimStoreRoot';

export function tagSharedStore<T extends object>(store: T, root: string): T {
  try {
    Object.defineProperty(store, STORE_ROOT_TAG, { value: root, enumerable: false, configurable: true });
  } catch {}
  return store;
}

export function sharedStoreRoot(store: unknown): string | null {
  if (store === null || typeof store !== 'object') return null;
  const tagged = (store as Record<string, unknown>)[STORE_ROOT_TAG];
  if (typeof tagged === 'string') return tagged;
  const legacy = (store as { _root?: unknown })._root;
  return typeof legacy === 'string' ? legacy : null;
}

export interface BuildRunOptions {
  variant?: string;
  abi?: string;
  configuration?: string;
  buildConfiguration?: string;
  isSimulator?: boolean;
  device?: string | boolean | null;
}

const SIMULATOR_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMULATOR_SERIAL = /^emulator-\d+$/;

function slug(value: unknown): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildVariant(platform: string, options: BuildRunOptions): string {
  const raw = platform === 'android' ? options.variant : (options.configuration ?? options.buildConfiguration);
  return (typeof raw === 'string' ? slug(raw) : '') || 'debug';
}

function buildTarget(options: BuildRunOptions): string {
  if (typeof options.isSimulator === 'boolean') return options.isSimulator ? 'sim' : 'device';
  const device = options.device;
  if (device === undefined || device === null || device === false) return 'sim';
  if (typeof device !== 'string') return 'prompted';
  const name = device.trim();
  if (name === '' || name === 'generic') return 'sim';
  if (SIMULATOR_UDID.test(name) || EMULATOR_SERIAL.test(name)) return 'sim';
  return `on-${slug(name)}`;
}

export function buildCacheKey(platform: string, fingerprintHash: string, options: unknown = {}): string {
  const opts = (options && typeof options === 'object' ? options : {}) as BuildRunOptions;
  const abi = platform === 'android' && typeof opts.abi === 'string' ? slug(opts.abi) : '';
  return `${fingerprintHash}-${buildVariant(platform, opts)}-${buildTarget(opts)}${abi ? `-${abi}` : ''}`;
}

export interface RegisterOptions {
  dir: string;
  name: string;
  prune: string;
  note: string;
  entriesDepth?: number;
  layout?: string;
  replaces?: CacheRegistrationMatch[];
}

export interface CacheRegistrationMatch {
  dir: string;
  name?: string;
  prune?: string;
  entriesDepth?: number;
  layout?: string | null;
}

export const METRO_NAMED_CACHE_LAYOUT = 'metro-named-v1';

export interface CacheManifest {
  version: number;
  caches: Array<Record<string, unknown>>;
}

export function cacheManifestLockPath(file: string): string {
  return `${file}.lock`;
}

export function readCacheManifest(file: string): CacheManifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { caches?: Array<Record<string, unknown>> };
    return { version: 1, caches: Array.isArray(parsed?.caches) ? parsed.caches : [] };
  } catch {
    return { version: 1, caches: [] };
  }
}

export function updateCacheManifest(
  file: string,
  mutate: (caches: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): CacheManifest {
  const parent = path.dirname(file);
  return withDirLock(
    cacheManifestLockPath(file),
    () => {
      const next: CacheManifest = { version: 1, caches: mutate(readCacheManifest(file).caches) };
      const temporary = path.join(parent, `.${path.basename(file)}.${process.pid}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
        fs.renameSync(temporary, file);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      return next;
    },
    { ensureParent: () => fs.mkdirSync(parent, { recursive: true }) },
  );
}

export function registerCache({ dir, name, prune, note, entriesDepth, layout, replaces = [] }: RegisterOptions): void {
  try {
    updateCacheManifest(path.join(configDir(), 'caches.json'), (caches) => {
      const others = caches.filter(
        (cache) => cache.dir !== dir && !replaces.some((match) => matchesCache(cache, match)),
      );
      const record: Record<string, unknown> = { dir, name, prune, note, registeredBy: process.cwd() };
      if (entriesDepth) record.entriesDepth = entriesDepth;
      if (layout) record.layout = layout;
      others.push(record);
      return others;
    });
  } catch {}
}

function matchesCache(cache: Record<string, unknown>, match: CacheRegistrationMatch): boolean {
  if (cache.dir !== match.dir) return false;
  if (match.name !== undefined && cache.name !== match.name) return false;
  if (match.prune !== undefined && cache.prune !== match.prune) return false;
  if (match.entriesDepth !== undefined && cache.entriesDepth !== match.entriesDepth) return false;
  if (match.layout === null) return !Object.hasOwn(cache, 'layout');
  return match.layout === undefined || cache.layout === match.layout;
}
