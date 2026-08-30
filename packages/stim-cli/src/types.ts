export type { BuildLockInfo } from './engine/build-lock.ts';
export type { BuildSlotInfo } from './engine/build-slots.ts';

export interface SupervisorRecord {
  pid?: number;
  port?: number;
  startedAt?: string;
  serverPid?: number;
  mode?: string;
  [key: string]: unknown;
}

interface IosDeviceRecord {
  deviceUdid?: string;
  deviceName?: string | null;
  owned?: boolean;
  serial?: string;
  [key: string]: unknown;
}

interface AndroidDeviceRecord {
  avdName?: string;
  consolePort?: number;
  serial?: string;
  kind?: string;
  deviceName?: string | null;
  owned?: boolean;
  setupIncomplete?: boolean;
  [key: string]: unknown;
}

export type DeviceRecord = IosDeviceRecord | AndroidDeviceRecord;

interface PlatformRecords {
  ios?: IosDeviceRecord;
  android?: AndroidDeviceRecord;
  [platform: string]: DeviceRecord | undefined;
}

export interface ProjectRecord {
  metroPort?: number | null;
  platforms?: PlatformRecords;
  supervisor?: SupervisorRecord;
  settings?: SettingsObject;
  worktreeRoot?: boolean;
  worktreeBranch?: string;
  worktreeBranchOwned?: boolean;
  worktreeMainRoot?: string;
  worktreeRemovalComplete?: boolean;
  worktreePendingBranchSha?: string;
  label?: string;
  bundleId?: string;
  androidPackage?: string;
  isExpo?: boolean;
  lastBuild?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RepoRecord {
  settings?: SettingsObject;
  [key: string]: unknown;
}

export interface ConcurrencyLimits {
  maxBuilds: number;
  maxDevices: number;
}

export interface StimCliConfig {
  version?: number;
  projects: Record<string, ProjectRecord>;
  repos: Record<string, RepoRecord>;
  concurrency?: { maxBuilds?: unknown; maxDevices?: unknown };
  caches?: { buildCache?: unknown; metroCache?: unknown; injectMetroStore?: unknown };
  [key: string]: unknown;
}
export type Config = StimCliConfig;

export type SettingsObject = Record<string, unknown>;
export type Settings = SettingsObject;

export type RemoteDeviceBackend = 'proxy' | 'eas';
export type CacheHitLevel = 'local' | 'remote' | false;

type LaunchStatus = boolean | 'unverified' | 'bundling';

export interface WaitedForBuild {
  pid?: number | null;
  ms?: number;
}

interface LogsInfo {
  dir?: string;
}

export interface IosFacts {
  platform: string;
  udid: string;
  deviceName: string | null;
  fingerprint?: string | null;
  configuration: string | null;
  cacheKey?: string | null;
  cacheHit: CacheHitLevel;
  cacheSkipped: boolean;
  waitedForBuild: { pid: number | null; ms: number } | null;
  appPath?: string | null;
  bundleId?: string | null;
  launched: LaunchStatus;
  metroPort?: number | null;
  logs: LogsInfo;
  durationMs?: number;
  webPreviewUrl?: string | null;
}

export interface AndroidFacts {
  platform: string;
  serial: string | null;
  avdName: string | null;
  deviceName: string | null;
  fingerprint: string | null;
  cacheKey: string | null;
  variant: string | null;
  metroPort: number | null;
  cacheHit: CacheHitLevel;
  cacheSkipped: boolean;
  waitedForBuild: { pid: number | null; ms: number } | null;
  appPath: string | null;
  bundleId: string | null;
  launched: LaunchStatus;
  debugHttpHost: string | null;
  debugHttpHostNote: string | null;
  devClientUrl: string | null;
  logs: string | null;
}

export interface StartFacts {
  port: number;
  supervisorPid: number | null;
  mode: string | null;
  logsDir: string;
  alreadyRunning: boolean;
}

export interface StartError {
  code: string;
  message: string;
  remedy: string | null;
}

export interface GcSkip {
  dir: string;
  reason: string;
}

export interface OrphanedDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  bytes?: number;
}
