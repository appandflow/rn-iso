import type { CompilationCacheActivity, RemoteDeviceBackend } from '../../types.ts';
import type { LaunchErrorRecord } from '../../command-output.ts';
import type { LeaseFacts } from '../../engine/device-lease-run.ts';

export interface DeviceLike {
  deviceName?: string | null;
  name?: string | null;
  avdName?: string | null;
  deviceType?: string | null;
  runtime?: string | null;
  adopted?: boolean;
  adoptionPending?: boolean;
  parkedCacheKey?: string;
}

export interface IosBootLike {
  ok?: boolean;
  failed?: boolean;
  udid?: string;
  reason?: string;
  code?: string;
  remedy?: string;
}

export interface PodStateLike {
  hasPodfile?: boolean;
  lockText?: unknown;
  manifestText?: unknown;
}

export interface PodVerdictLike {
  stale?: boolean;
  reason?: string;
  noPods?: boolean;
}

export interface RemoteUploadLike {
  uploaded?: boolean;
  timedOut?: boolean;
  failed?: string | null;
}

export interface BuildIosResultLike {
  failed?: boolean;
  code?: string;
  durationMs?: number;
  diagnostics?: unknown[];
  truncated?: number;
  tail?: string[];
  exitCode?: number | null;
  appPath?: string;
  bundleId?: string;
  compilationCache?: CompilationCacheActivity;
}

export interface VerifyLaunchResultLike {
  verified?: boolean;
  skipped?: boolean;
  requested?: boolean;
  fatal?: boolean;
  processAlive?: boolean | null;
  errors?: LaunchErrorRecord[];
  waitedMs?: number;
}

export interface IosCommandOptions {
  json?: boolean;
  metroCheck?: boolean;
  buildCache?: boolean;
  configuration?: string;
  deviceType?: string;
  runtime?: string;
  device?: string | boolean;
  remote?: RemoteDeviceBackend;
  wait?: string | boolean;
  waitConflict?: boolean;
}

export interface WaitedForBuild {
  pid?: number | null;
  ms?: number;
}

export interface FailArgs {
  code: string;
  message?: string | null;
  remedy?: string | null;
  lines?: string[];
  logPath?: string | null;
  build?: BuildFailureFields | null;
  lease?: LeaseFacts | null;
}

export interface BuildFailureFields {
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  appPath?: string | null;
  bundleId?: string | null;
}
