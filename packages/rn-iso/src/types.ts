// src/types.ts -- the shared domain vocabulary.
//
// One place the whole codebase reaches for the shapes it passes around: the
// config records, the exec seam, the --json facts payloads, the log record,
// the cache manifest entry, the gc report, the teardown outcomes and the
// device-resolution results. Each interface names the module that PRODUCES it
// so the definition can be checked against the real code, not guessed.
//
// Types that already have a natural home (the log record in ndjson.ts, the
// exec seam in exec.ts, the metro resolution in metro.ts, the cache entry in
// cache-manifest.ts) are RE-EXPORTED from here rather than re-declared, so a
// consumer has a single import to reach the vocabulary while the producer
// module stays the source of truth. This file has no runtime exports.

// --- re-exports from the modules that own these shapes ---------------------

// The build single-flight lock / concurrency-slot records gc reports on.
// Producers: src/engine/build-lock.ts and src/engine/build-slots.ts.
export type { BuildLockInfo } from './engine/build-lock.ts';
export type { BuildSlotInfo } from './engine/build-slots.ts';

// --- config: the ~/.rn-iso/config.json shape -------------------------------
//
// Producer: src/config.ts. The records are a defensive, loosely-typed bag
// written across many commands and read by more; every reader guards for
// absence, so the shapes are flat records of optional keys with an index
// signature rather than closed interfaces.

// The dev server's global registration. Producer: setSupervisor in config.ts.
export interface SupervisorRecord {
  pid?: number;
  port?: number;
  startedAt?: string;
  serverPid?: number;
  // server-*.ts records a `mode` ('bare' | 'expo') the facts payload reads.
  mode?: string;
  [key: string]: unknown;
}

// An owned iOS simulator assignment. Producer: engine/device.ts setDevice(..,
// 'ios', ..) writes { deviceUdid, owned, deviceName }; `serial` is a legacy
// v2 field still tolerated on read.
interface IosDeviceRecord {
  deviceUdid?: string;
  deviceName?: string | null;
  owned?: boolean;
  serial?: string;
  [key: string]: unknown;
}

// An owned Android emulator assignment. Producer: engine/device.ts setDevice(..,
// 'android', ..) writes { avdName, consolePort, owned, deviceName }. `serial`
// and `kind` appear on legacy / physical-device records that nothing issues at
// anymore (see CLAUDE.md item 2) but that config.ts still reads for collision
// avoidance.
interface AndroidDeviceRecord {
  avdName?: string;
  consolePort?: number;
  serial?: string;
  kind?: string;
  deviceName?: string | null;
  owned?: boolean;
  [key: string]: unknown;
}

export type DeviceRecord = IosDeviceRecord | AndroidDeviceRecord;

// A project's platform assignments. `ios` / `android` are the only keys any
// producer writes; the index signature keeps config.ts's `platforms[platform]`
// string-indexed access honest.
interface PlatformRecords {
  ios?: IosDeviceRecord;
  android?: AndroidDeviceRecord;
  [platform: string]: DeviceRecord | undefined;
}

// One project entry, keyed in the config by absolute project path. Producer:
// upsertProject / setDevice / setSupervisor / claimMetroPort in config.ts.
export interface ProjectRecord {
  metroPort?: number | null;
  platforms?: PlatformRecords;
  supervisor?: SupervisorRecord;
  settings?: SettingsObject;
  worktreeRoot?: boolean;
  label?: string;
  bundleId?: string;
  androidPackage?: string;
  isExpo?: boolean;
  lastBuild?: Record<string, unknown>;
  [key: string]: unknown;
}

// One repo entry, keyed by git common dir; carries settings shared across the
// repo's worktrees. Producer: setRepoSetting in config.ts.
export interface RepoRecord {
  settings?: SettingsObject;
  [key: string]: unknown;
}

// The machine-level opt-in caps. Producer: getConcurrencyLimits in config.ts.
export interface ConcurrencyLimits {
  maxBuilds: number;
  maxDevices: number;
}

// The whole ~/.rn-iso/config.json. Producer: config.ts (loadConfig /
// saveConfig / ensureConfig). `RnIsoConfig` and `Config` are the same shape;
// `Config` is the name config.ts has used since Phase 0.
export interface RnIsoConfig {
  version?: number;
  projects: Record<string, ProjectRecord>;
  repos: Record<string, RepoRecord>;
  concurrency?: { maxBuilds?: unknown; maxDevices?: unknown };
  [key: string]: unknown;
}
export type Config = RnIsoConfig;

// --- settings: the layered resolution ---------------------------------------
//
// Producer: src/settings.ts. A settings layer is a bag of arbitrary nested
// JSON; the resolver merges layers and only KNOWN_SETTINGS are actually read.
export type SettingsObject = Record<string, unknown>;
export type Settings = SettingsObject;

// --- facts: the --json payloads ---------------------------------------------

// A build cache hit is reported by LEVEL, not merely truthiness: 'local' and
// 'remote' say which level answered, false says nothing did. Producer:
// cacheLevel in engine/remote-cache.ts.
export type CacheHitLevel = 'local' | 'remote' | false;

// The launch fact is three-valued: true (a bundle request from this
// workspace's Metro was observed), false, or 'unverified' (launched but no
// request seen). Producers: iosFacts / androidFacts.
type LaunchStatus = boolean | 'unverified';

// { pid, ms } when this run installed an artifact ANOTHER workspace compiled
// while it waited; null when nothing was waited for. Producer: engine/build-lock.ts.
export interface WaitedForBuild {
  pid?: number | null;
  ms?: number;
}

// The `logs` sub-object every facts payload carries.
interface LogsInfo {
  dir?: string;
}

// `rn-iso ios` --json payload. Producer: iosFacts in commands/ios.ts.
export interface IosFacts {
  platform: string;
  udid: string;
  deviceName: string | null;
  fingerprint?: string | null;
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
}

// `rn-iso android` --json payload. Producer: androidFacts in commands/android.ts.
export interface AndroidFacts {
  platform: string;
  serial: string | null;
  avdName: string | null;
  deviceName: string | null;
  fingerprint: string | null;
  cacheHit: CacheHitLevel;
  cacheSkipped: boolean;
  waitedForBuild: { pid: number | null; ms: number } | null;
  appPath: string | null;
  bundleId: string | null;
  launched: LaunchStatus;
  debugHttpHost: string | null;
  debugHttpHostNote: string | null;
  devClientUrl: string | null;
  // The Android payload carries the logs DIRECTORY string directly (the iOS
  // payload wraps it as { dir }); reflected honestly rather than unified.
  logs: string | null;
}

// `rn-iso start` --json payload. Producer: startFacts in commands/start.ts.
export interface StartFacts {
  port: number;
  supervisorPid: number | null;
  mode: string | null;
  logsDir: string;
  alreadyRunning: boolean;
}

// The FAILURE half of the start --json contract: a stable code to branch on, a
// message, and an optional remedy. Producer: startError in commands/start.ts.
export interface StartError {
  code: string;
  message: string;
  remedy: string | null;
}

// --- device resolution: the pre-teardown ownership checks -------------------

// --- teardown outcomes ------------------------------------------------------

// --- gc report --------------------------------------------------------------
//
// Producer: collectGcReport in src/commands/gc.ts. The big report object gc
// prints and (only with --delete) acts on.

// A dead-project entry gc declined to sweep because its volume is unmounted.
export interface GcSkip {
  dir: string;
  reason: string;
}

// An owned device with no live project referencing it. Producer:
// findOrphanedDevices in src/commands/gc.ts.
export interface OrphanedDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
}
