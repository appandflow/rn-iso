import { ensureConfig, loadConfig, saveConfig, withConfigLock } from './config.ts';
import type { Config, DeviceRecord } from './types.ts';

export type PoolPlatform = 'ios' | 'android';

export interface ParkedSim {
  udid: string;
  name: string;
  deviceTypeIdentifier: string;
  runtimeIdentifier: string;
  parkedAt: string;
  simslimManaged: boolean;
  bundleId?: string;
  cacheKey?: string;
}

export const DEFAULT_PARKED_MAX = 3;

export const POOL_SETTING_REMEDY: string =
  'Run `stim guide settings` for the simulator pool bound and where it can be set.';

const MAX_SETTING: Record<PoolPlatform, { key: string; env: string }> = {
  ios: { key: 'iosParkedMax', env: 'STIM_POOL_IOS_PARKED_MAX' },
  android: { key: 'androidParkedMax', env: 'STIM_POOL_ANDROID_PARKED_MAX' },
};

export interface ParkedMax {
  max: number;
  error: string | null;
}

function parseMax(raw: unknown, strings: boolean): number | null {
  const value = strings && typeof raw === 'string' ? (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function parkedMaxSetting(
  platform: PoolPlatform,
  { config, env = process.env }: { config?: Config | null; env?: NodeJS.ProcessEnv } = {},
): ParkedMax {
  const { key, env: envKey } = MAX_SETTING[platform];
  const fromEnv = env[envKey];
  const explicit = fromEnv !== undefined && fromEnv !== '';
  const cfg = config === undefined ? loadConfig() : config;
  const pool = cfg?.pool;
  if (!explicit && pool !== undefined && (pool === null || typeof pool !== 'object' || Array.isArray(pool))) {
    return { max: 0, error: 'Invalid pool value. Expected an object with simulator and emulator bounds.' };
  }
  const fromConfig =
    pool !== null && typeof pool === 'object' && !Array.isArray(pool)
      ? (pool as Record<string, unknown>)[key]
      : undefined;
  const raw = explicit ? fromEnv : fromConfig;
  if (raw === undefined) return { max: env.STIM_HOME ? 0 : DEFAULT_PARKED_MAX, error: null };
  const parsed = parseMax(raw, explicit);
  if (parsed === null) {
    return {
      max: 0,
      error: `Invalid ${explicit ? envKey : `pool.${key}`} value ${JSON.stringify(raw)}. Expected a whole number of parked ${platform === 'ios' ? 'simulators' : 'emulators'}, 0 or more.`,
    };
  }
  return { max: explicit ? parsed : env.STIM_HOME ? 0 : parsed, error: null };
}

function isParkedSim(value: unknown): value is ParkedSim {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.udid === 'string' &&
    typeof record.name === 'string' &&
    record.name.startsWith('stim-') &&
    typeof record.deviceTypeIdentifier === 'string' &&
    typeof record.runtimeIdentifier === 'string' &&
    typeof record.parkedAt === 'string' &&
    typeof record.simslimManaged === 'boolean' &&
    (record.bundleId === undefined || typeof record.bundleId === 'string') &&
    (record.cacheKey === undefined || typeof record.cacheKey === 'string')
  );
}

function poolBlock(config: Config | null): Record<PoolPlatform, ParkedSim[]> {
  const raw = config?.parked;
  const block = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const read = (platform: PoolPlatform): ParkedSim[] => {
    const list = block[platform];
    return Array.isArray(list) ? list.filter(isParkedSim) : [];
  };
  return { ios: read('ios'), android: read('android') };
}

export function readParked(platform: PoolPlatform, { config }: { config?: Config | null } = {}): ParkedSim[] {
  return poolBlock(config === undefined ? loadConfig() : config)[platform];
}

function writeParked(config: Config, platform: PoolPlatform, records: ParkedSim[]): void {
  const block = poolBlock(config);
  block[platform] = records;
  config.parked = { ios: block.ios, android: block.android };
}

function oldestFirst(records: readonly ParkedSim[]): ParkedSim[] {
  return records.toSorted((a, b) => String(a.parkedAt).localeCompare(String(b.parkedAt)));
}

export function selectParked(
  records: readonly ParkedSim[],
  { deviceTypeIdentifier, runtimeIdentifier }: { deviceTypeIdentifier: string; runtimeIdentifier: string },
): ParkedSim[] {
  return oldestFirst(
    records.filter((r) => r.deviceTypeIdentifier === deviceTypeIdentifier && r.runtimeIdentifier === runtimeIdentifier),
  );
}

export function evictOverflow(records: readonly ParkedSim[], max: number): { keep: ParkedSim[]; evicted: ParkedSim[] } {
  if (records.length <= max) return { keep: [...records], evicted: [] };
  const ordered = oldestFirst(records);
  const evicted = ordered.slice(0, ordered.length - max);
  const dropped = new Set(evicted.map((r) => r.udid));
  return { keep: records.filter((r) => !dropped.has(r.udid)), evicted };
}

export function parkSim({
  platform,
  projectPath,
  record,
  max,
}: {
  platform: PoolPlatform;
  projectPath: string;
  record: ParkedSim;
  max: number;
}): ParkedSim[] {
  return withConfigLock(() => {
    const cfg = ensureConfig();
    const kept = readParked(platform, { config: cfg }).filter((r) => r.udid !== record.udid);
    const { keep, evicted } = evictOverflow([...kept, record], max);
    writeParked(cfg, platform, keep);
    const platforms = cfg.projects?.[projectPath]?.platforms;
    if (platforms) delete platforms[platform];
    saveConfig(cfg);
    return evicted;
  });
}

export function adoptParked({
  platform,
  projectPath,
  udid,
  device,
}: {
  platform: PoolPlatform;
  projectPath: string;
  udid: string;
  device: DeviceRecord;
}): ParkedSim | null {
  return withConfigLock(() => {
    const cfg = ensureConfig();
    const records = readParked(platform, { config: cfg });
    const taken = records.find((r) => r.udid === udid);
    if (!taken) return null;
    writeParked(
      cfg,
      platform,
      records.filter((r) => r.udid !== udid),
    );
    const project = cfg.projects[projectPath];
    if (!project) throw new Error(`Project not registered: ${projectPath}`);
    project.platforms = project.platforms || {};
    project.platforms[platform] = device;
    saveConfig(cfg);
    return taken;
  });
}

export function dropParked(platform: PoolPlatform, udid: string): boolean {
  return withConfigLock(() => {
    const cfg = loadConfig();
    if (!cfg) return false;
    const records = readParked(platform, { config: cfg });
    if (!records.some((r) => r.udid === udid)) return false;
    writeParked(
      cfg,
      platform,
      records.filter((r) => r.udid !== udid),
    );
    saveConfig(cfg);
    return true;
  });
}
