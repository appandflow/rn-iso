import chalk from 'chalk';
import type { AndroidFacts, CcacheActivity, WaitedForBuild } from '../../types.ts';
import { LAUNCH_BUNDLING, LAUNCH_UNVERIFIED } from '../../engine/app-install.ts';
import {
  cacheLevel,
  UPLOAD_TIMEOUT_MS,
  easAuthNote,
  isEasAuthFailureText,
  type LoadProjectProviderResult,
} from '../../engine/remote-cache.ts';
import { CCACHE_UNAVAILABLE, ccacheActivityLine } from '../../engine/ccache.ts';
import { PLATFORM } from './support.ts';
import { formatDuration, phaseLine } from '../../command-output.ts';
import type { RemoteUploadLike, LaunchResultLike, AndroidRecord, AndroidWriter } from './types.ts';
import type { RunRecorder } from '../../engine/stats.ts';
import { writeWorkspaceState } from '../../supervisor/state.ts';

export function androidFacts({
  serial,
  avdName = null,
  deviceName = null,
  systemImage = null,
  fingerprint,
  cacheKey = null,
  variant = null,
  metroPort = null,
  cacheHit,
  cacheSkipped = false,
  waitedForBuild = null,
  appPath,
  bundleId,
  installSkipped = false,
  launched,
  ccache = CCACHE_UNAVAILABLE,
  logs,
  debugHttpHost = null,
  debugHttpHostNote = null,
  devClientUrl = null,
  durationMs,
  lease,
}: {
  serial?: string | null;
  avdName?: string | null;
  deviceName?: string | null;
  systemImage?: string | null;
  fingerprint?: string | null;
  cacheKey?: string | null;
  variant?: string | null;
  metroPort?: number | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  waitedForBuild?: WaitedForBuild | null;
  appPath?: string | null;
  bundleId?: string | null;
  installSkipped?: boolean;
  launched?: boolean | string;
  ccache?: CcacheActivity;
  logs?: string | null;
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
  devClientUrl?: string | null;
  durationMs?: number;
  lease?: { kind: string; expiresAt: string } | null;
}): AndroidFacts {
  return {
    platform: PLATFORM,
    serial: serial ?? null,
    avdName: avdName ?? null,
    deviceName: deviceName ?? avdName ?? null,
    systemImage: systemImage ?? null,
    fingerprint: fingerprint ?? null,
    cacheKey: cacheKey ?? null,
    variant: variant ?? null,
    metroPort: metroPort ?? null,
    cacheHit: cacheLevel(cacheHit),
    cacheSkipped: Boolean(cacheSkipped),
    waitedForBuild: waitedForBuild ? { pid: waitedForBuild.pid ?? null, ms: waitedForBuild.ms ?? 0 } : null,
    appPath: appPath ?? null,
    bundleId: bundleId ?? null,
    installSkipped: Boolean(installSkipped),
    launched: launched === LAUNCH_UNVERIFIED || launched === LAUNCH_BUNDLING ? launched : Boolean(launched),
    ccache,
    debugHttpHost: debugHttpHost ?? null,
    debugHttpHostNote: debugHttpHostNote ?? null,
    devClientUrl: devClientUrl ?? null,
    logs: logs ?? null,
    durationMs: typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : null,
    ...(lease === undefined ? {} : { lease }),
  };
}

export function lastBuildRecord({
  fingerprint,
  cacheKey,
  cacheHit,
  cacheSkipped = false,
  durationMs,
  appPath,
  bundleId,
  startedAt,
  status,
  errorCode = null,
  avdName = null,
  deviceName = null,
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
  avdName?: string | null;
  deviceName?: string | null;
}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    platform: PLATFORM,
    avdName: avdName ?? null,
    deviceName: deviceName ?? avdName ?? null,
    fingerprint: fingerprint ?? null,
    cacheKey: cacheKey ?? null,
    cacheHit: cacheLevel(cacheHit),
    cacheSkipped: Boolean(cacheSkipped),
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    appPath: appPath ?? null,
    bundleId: bundleId ?? null,
    startedAt,
    status,
  };
  if (errorCode) record.errorCode = errorCode;
  return record;
}

export async function finishAndroidUpload(
  uploadPending: Promise<RemoteUploadLike> | null,
  remote: LoadProjectProviderResult | null,
  phase: (label: unknown, text: string) => void,
): Promise<boolean> {
  if (!uploadPending) return false;
  const upload = await uploadPending;
  if (upload?.uploaded) {
    phase('cache', `uploaded (${remote?.name})`);
  } else if (upload?.timedOut) {
    phase(
      'cache',
      chalk.yellow(`${remote?.name} upload still running after ${formatDuration(UPLOAD_TIMEOUT_MS)}; not waiting`),
    );
    return true;
  } else if (upload?.failed) {
    const authNote =
      remote?.name === 'eas' && isEasAuthFailureText(upload.failed)
        ? easAuthNote({ code: 'logged-out', reason: upload.failed, phase: 'upload' })
        : null;
    phase('cache', chalk.yellow(authNote || `${remote?.name} upload failed: ${upload.failed}`));
  }
  return false;
}

export interface ReportAndroidResultArgs {
  lease?: { kind: string; expiresAt: string } | null;
  json: boolean;
  useBuildCache: boolean;
  variant: string | null;
  release: boolean;
  metroCheck: boolean;
  metroPort: number | null;
  logsDir: string | null;
  serial: string;
  apkPath: string | null;
  androidPackage: string;
  installSkipped: boolean;
  record: AndroidRecord;
  waitedForBuild: WaitedForBuild | null;
  remote: LoadProjectProviderResult | null;
  providerName: string | null;
  launchState: boolean | string;
  launched: LaunchResultLike;
  ccache: CcacheActivity;
  durationMs: number;
  writer: AndroidWriter;
  emit: (line: string) => void;
  recordRun: RunRecorder['record'];
}

export function reportAndroidResult({
  json,
  useBuildCache,
  variant,
  release,
  metroCheck,
  metroPort,
  logsDir,
  serial,
  apkPath,
  androidPackage,
  installSkipped,
  record,
  waitedForBuild,
  remote,
  providerName,
  launchState,
  launched,
  ccache,
  durationMs,
  writer,
  emit,
  lease,
  recordRun,
}: ReportAndroidResultArgs): AndroidFacts {
  recordRun({ failed: false, cacheHit: cacheLevel(record.cacheHit), waited: waitedForBuild, durationMs });
  const facts = androidFacts({
    serial,
    avdName: record.avdName,
    deviceName: record.deviceName,
    systemImage: record.systemImage,
    debugHttpHost: launched.debugHttpHost ?? null,
    debugHttpHostNote: launched.debugHttpHostNote ?? null,
    devClientUrl: launched.devClientUrl ?? null,
    fingerprint: record.fingerprint,
    cacheKey: record.cacheKey,
    variant,
    metroPort,
    cacheHit: record.cacheHit,
    cacheSkipped: !useBuildCache,
    waitedForBuild,
    appPath: apkPath,
    bundleId: androidPackage,
    installSkipped,
    launched: launchState,
    ccache,
    logs: logsDir,
    durationMs,
    lease,
  });
  writer.close();

  if (json) {
    emit(JSON.stringify(facts));
  } else {
    const summary =
      `OK: ${androidPackage} launched on ${serial}, ` +
      `${release ? `${variant} (embedded JS, no Metro)` : `Metro port ${metroPort}`} ` +
      `(${cacheOutcome(record.cacheHit, remote?.name ?? providerName)})`;
    const outcome =
      launchState === LAUNCH_UNVERIFIED
        ? chalk.yellow(`${summary} -- launch UNVERIFIED`)
        : launchState === LAUNCH_BUNDLING
          ? chalk.green(`${summary} -- bundle requested, still building`)
          : chalk.green(summary);
    const deviceName = record.avdName || record.deviceName || serial;
    const cacheResult = useBuildCache ? cacheOutcome(record.cacheHit, remote?.name ?? providerName) : 'bypassed; built';
    const metroResult = release
      ? `embedded (${variant})`
      : !metroCheck
        ? `check skipped on port ${metroPort}`
        : launchState === LAUNCH_UNVERIFIED
          ? `state unverified on port ${metroPort}`
          : `running on port ${metroPort}`;
    emit(
      [
        outcome,
        phaseLine('device', `${deviceName} (${serial})`),
        phaseLine('app', androidPackage),
        phaseLine('metro', metroResult),
        phaseLine('cache', cacheResult),
        phaseLine('compilation cache', ccacheActivityLine(ccache)),
        phaseLine('logs', logsDir || 'unavailable (remote device)'),
      ].join('\n'),
    );
  }
  return facts;
}

function cacheOutcome(cacheHit: unknown, providerName: string | null = null): string {
  if (cacheHit === 'remote') return `cache hit from ${providerName || 'the remote cache'}`;
  if (cacheHit === 'local') return 'cache hit';
  return 'built';
}

export function persistLastBuild({
  writeState,
  root,
  record,
  startedAt,
  durationMs,
  status,
  errorCode = null,
  out,
}: {
  writeState: typeof writeWorkspaceState;
  root: string;
  record: AndroidRecord;
  startedAt: string;
  durationMs: number;
  status: string;
  errorCode?: string | null;
  out: (line: string) => void;
}): Record<string, unknown> {
  const lastBuild = lastBuildRecord({ ...record, startedAt, durationMs, status, errorCode });
  try {
    writeState(root, { lastBuild });
  } catch (err) {
    out(phaseLine('state', chalk.yellow(`could not record lastBuild: ${(err as Error)?.message || err}`)));
  }
  return lastBuild;
}
