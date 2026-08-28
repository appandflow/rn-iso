import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function configDir(): string {
  return process.env.RN_ISO_HOME || path.join(os.homedir(), '.rn-iso');
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
  return process.env.RN_ISO_BUILD_CACHE || cachePathSetting('buildCache') || path.join(configDir(), 'build-cache');
}

export function metroCacheRoot(name?: string | null): string {
  const override = process.env.RN_ISO_METRO_CACHE || cachePathSetting('metroCache');
  if (override) return override;
  const root = path.join(configDir(), 'metro-cache');
  return name === undefined || name === null || name === '' ? root : path.join(root, cacheNameSegment(name));
}

export const STORE_ROOT_TAG = 'rnIsoStoreRoot';

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
  return `${fingerprintHash}-${buildVariant(platform, opts)}-${buildTarget(opts)}`;
}

export interface RegisterOptions {
  dir: string;
  name: string;
  prune: string;
  note: string;
  entriesDepth?: number;
}

export function registerCache({ dir, name, prune, note, entriesDepth }: RegisterOptions): void {
  try {
    const home = configDir();
    const file = path.join(home, 'caches.json');
    let manifest: { version: number; caches: Array<Record<string, unknown>> } = { version: 1, caches: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { caches?: Array<Record<string, unknown>> };
      if (Array.isArray(parsed?.caches)) manifest = { version: 1, caches: parsed.caches };
    } catch {}
    const others = manifest.caches.filter((c) => c.dir !== dir);
    const record: Record<string, unknown> = { dir, name, prune, note, registeredBy: process.cwd() };
    if (entriesDepth) record.entriesDepth = entriesDepth;
    others.push(record);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, caches: others }, null, 2));
  } catch {}
}
