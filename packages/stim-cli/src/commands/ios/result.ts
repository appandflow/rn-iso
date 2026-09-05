import chalk from 'chalk';
import {
  cacheLevel,
  UPLOAD_TIMEOUT_MS,
  easAuthNote,
  isEasAuthFailureText,
  type LoadProjectProviderResult,
} from '../../engine/remote-cache.ts';
import { PLATFORM, deviceLabel } from './support.ts';
import { LAUNCH_BUNDLING, LAUNCH_UNVERIFIED } from '../../engine/app-install.ts';
import { COMPILATION_CACHE_NOT_RUN, compilationCacheActivityLine } from '../../engine/xcode.ts';
import type { CompilationCacheActivity, IosFacts, CacheHitLevel } from '../../types.ts';
import type { WaitedForBuild, RemoteUploadLike, DeviceLike } from './types.ts';
import { writeWorkspaceState } from '../../supervisor/state.ts';
import { formatDuration, phaseLine } from '../../command-output.ts';
import type { RunRecorder } from '../../engine/stats.ts';
import type { IosDeps } from './dependencies.ts';

export function lastBuildRecord({
  fingerprint = null,
  cacheKey = null,
  cacheHit = false,
  cacheSkipped = false,
  durationMs = 0,
  appPath = null,
  bundleId = null,
  startedAt,
  status,
  errorCode = null,
}: {
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  durationMs?: number;
  appPath?: string | null;
  bundleId?: string | null;
  startedAt: string;
  status: string;
  errorCode?: string | null;
}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    platform: PLATFORM,
    fingerprint,
    cacheKey,
    cacheHit: cacheLevel(cacheHit),
    cacheSkipped: Boolean(cacheSkipped),
    durationMs,
    appPath,
    bundleId,
    startedAt,
    status,
  };
  if (errorCode) record.errorCode = errorCode;
  return record;
}

export function iosFacts({
  udid,
  deviceName,
  deviceType = null,
  runtime = null,
  fingerprint,
  configuration = null,
  cacheKey,
  cacheHit,
  cacheSkipped = false,
  compilationCache = COMPILATION_CACHE_NOT_RUN,
  waitedForBuild = null,
  appPath,
  bundleId,
  installSkipped = false,
  metroPort,
  logsDir,
  durationMs,
  launched = true,
  webPreviewUrl = null,
  lease,
}: {
  udid: string;
  deviceName?: string | null;
  deviceType?: string | null;
  runtime?: string | null;
  fingerprint?: string | null;
  configuration?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  compilationCache?: CompilationCacheActivity;
  waitedForBuild?: WaitedForBuild | null;
  appPath?: string | null;
  bundleId?: string | null;
  installSkipped?: boolean;
  metroPort?: number | null;
  logsDir?: string;
  durationMs?: number;
  launched?: boolean | string;
  webPreviewUrl?: string | null;
  lease?: { kind: string; expiresAt: string } | null;
}): IosFacts {
  return {
    platform: PLATFORM,
    udid,
    deviceName: deviceName ?? null,
    deviceType: deviceType ?? null,
    runtime: runtime ?? null,
    fingerprint,
    configuration: configuration ?? null,
    cacheKey,
    cacheHit: cacheLevel(cacheHit),
    cacheSkipped: Boolean(cacheSkipped),
    compilationCache,
    waitedForBuild: waitedForBuild ? { pid: waitedForBuild.pid ?? null, ms: waitedForBuild.ms ?? 0 } : null,
    appPath,
    bundleId,
    installSkipped: Boolean(installSkipped),
    launched: launched === LAUNCH_UNVERIFIED || launched === LAUNCH_BUNDLING ? launched : Boolean(launched),
    metroPort,
    logs: { dir: logsDir },
    durationMs,
    ...(webPreviewUrl ? { webPreviewUrl } : {}),
    ...(lease === undefined ? {} : { lease }),
  };
}

export function writeLastBuild(
  root: string,
  record: Record<string, unknown>,
  { write = writeWorkspaceState }: { write?: typeof writeWorkspaceState } = {},
): Record<string, unknown> {
  try {
    write(root, { lastBuild: record });
  } catch {}
  return record;
}

export async function finishIosUpload(
  uploadPending: Promise<RemoteUploadLike> | null,
  remote: LoadProjectProviderResult | null,
  phase: (name: unknown, text: string) => void,
  note: (line: string) => void,
): Promise<boolean> {
  if (!uploadPending) return false;
  const upload = await uploadPending;
  if (upload?.uploaded) {
    phase('cache', `uploaded (${remote?.name})`);
  } else if (upload?.timedOut) {
    note(
      chalk.yellow(
        phaseLine(
          'cache',
          `${remote?.name} upload still running after ${formatDuration(UPLOAD_TIMEOUT_MS)}; not waiting`,
        ),
      ),
    );
    return true;
  } else if (upload?.failed) {
    const authNote =
      remote?.name === 'eas' && isEasAuthFailureText(upload.failed)
        ? easAuthNote({ code: 'logged-out', reason: upload.failed, phase: 'upload' })
        : null;
    note(chalk.yellow(phaseLine('cache', authNote || `${remote?.name} upload failed: ${upload.failed}`)));
  }
  return false;
}

export interface ReportIosResultArgs {
  d: IosDeps;
  root: string;
  json: boolean;
  release: boolean;
  configuration: string | null;
  metroCheck: boolean;
  metroPort: number | null;
  logsDir: string;
  device: DeviceLike;
  udid: string;
  appPath: string | null;
  bundleId: string;
  installSkipped: boolean;
  elapsed: () => number;
  startedAt: string;
  storeHash: string | null;
  storeKey: string | null;
  cacheHit: CacheHitLevel;
  compilationCache: CompilationCacheActivity;
  useBuildCache: boolean;
  waitedForBuild: WaitedForBuild | null;
  launchState: boolean | string;
  remote: LoadProjectProviderResult | null;
  providerName: string | null;
  closeWriter: () => void;
  webPreviewUrl: string | null;
  lease?: { kind: string; expiresAt: string } | null;
  recordRun: RunRecorder['record'];
}

export function reportIosResult({
  d,
  root,
  json,
  release,
  configuration,
  metroCheck,
  metroPort,
  logsDir,
  device,
  udid,
  appPath,
  bundleId,
  installSkipped,
  elapsed,
  startedAt,
  storeHash,
  storeKey,
  cacheHit,
  compilationCache,
  useBuildCache,
  waitedForBuild,
  launchState,
  remote,
  providerName,
  closeWriter,
  webPreviewUrl,
  lease,
  recordRun,
}: ReportIosResultArgs): IosFacts {
  const durationMs = elapsed();
  recordRun({ failed: false, cacheHit, waited: waitedForBuild, durationMs });
  writeLastBuild(
    root,
    lastBuildRecord({
      fingerprint: storeHash,
      cacheKey: storeKey,
      cacheHit,
      cacheSkipped: !useBuildCache,
      durationMs,
      appPath,
      bundleId,
      startedAt,
      status: 'ok',
    }),
    { write: d.writeWorkspaceState },
  );
  closeWriter();

  const facts = iosFacts({
    udid,
    deviceName: device?.deviceName ?? null,
    deviceType: device?.deviceType,
    runtime: device?.runtime,
    fingerprint: storeHash,
    configuration,
    cacheKey: storeKey,
    cacheHit,
    compilationCache,
    cacheSkipped: !useBuildCache,
    waitedForBuild,
    appPath,
    bundleId,
    installSkipped,
    metroPort,
    logsDir,
    durationMs,
    launched: launchState,
    webPreviewUrl,
    lease,
  });
  if (json) {
    console.log(JSON.stringify(facts));
  } else {
    const summary =
      `OK: ${bundleId} on ${deviceLabel(device, udid)}, ` +
      (release ? `${configuration} (embedded JS, no Metro)` : `Metro port ${metroPort}`) +
      ` (${cacheDescription(cacheHit, remote?.name ?? providerName)}, ${formatDuration(durationMs)})`;
    const outcome =
      launchState === LAUNCH_UNVERIFIED
        ? chalk.yellow(`${summary} -- launch UNVERIFIED`)
        : launchState === LAUNCH_BUNDLING
          ? chalk.green(`${summary} -- bundle requested, still building`)
          : chalk.green(summary);
    const deviceName = device?.deviceName ?? device?.name ?? udid;
    const cacheResult = useBuildCache ? cacheDescription(cacheHit, remote?.name ?? providerName) : 'bypassed; built';
    const metroResult = release
      ? `embedded (${configuration})`
      : !metroCheck
        ? `check skipped on port ${metroPort}`
        : launchState === LAUNCH_UNVERIFIED
          ? `state unverified on port ${metroPort}`
          : `running on port ${metroPort}`;
    console.log(
      [
        outcome,
        phaseLine('device', `${deviceName} (${udid})`),
        phaseLine('app', bundleId),
        phaseLine('metro', metroResult),
        phaseLine('cache', cacheResult),
        phaseLine('compilation cache', compilationCacheActivityLine(compilationCache)),
        phaseLine('logs', logsDir),
      ].join('\n'),
    );
    if (facts.webPreviewUrl) console.error(chalk.dim(`Watch this device: ${facts.webPreviewUrl}`));
  }
  return facts;
}

export function cacheDescription(cacheHit: CacheHitLevel, providerName: string | null = null): string {
  if (cacheHit === 'remote') return `from ${providerName || 'the remote cache'}`;
  if (cacheHit === 'local') return 'from cache';
  return 'built';
}
