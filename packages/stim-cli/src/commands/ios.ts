import chalk from 'chalk';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnEntry } from '../spawn-entry.ts';
import { InvalidArgumentError, type Command } from 'commander';
import {
  createWarnOnce,
  loadCacheProvider,
  resolveTieredBuild,
  storeTieredBuild,
  type LoadCacheProviderResult,
  type ProviderCallResult,
} from '@stim-cli/cache';
import {
  buildCacheKey,
  describeFingerprintMiss,
  filesystemBuildCapability,
  fingerprintDiffRecord,
  fingerprintDiffSuffix,
  fingerprintProject,
  prepareProviderDownloadDir,
  providerDownloadPath,
  providerUploadOutcome,
  refingerprintAfterMutation,
  resolveBuild,
  storeBuild,
  untrackedMissLine,
  untrackedNativeFiles,
} from '../build-cache.ts';
import type { FingerprintSource } from '@expo/fingerprint';
import {
  formatDuration,
  launchErrorReport,
  phaseLine,
  shortHash,
  shortUdid,
  type LaunchErrorRecord,
} from '../command-output.ts';
import { verifyCollectorOwnership } from '../collector/ownership.ts';
import { getConcurrencyLimits, getProject, upsertProject } from '../config.ts';
import {
  DEFAULT_METRO_PORT,
  LAUNCH_BUNDLING,
  LAUNCH_FATAL,
  LAUNCH_UNVERIFIED,
  RELEASE_VERIFY_WAIT_MS,
  clearOtherUserApps,
  devClientUrl,
  installIosApp,
  iosAppProcess,
  launchIosApp,
  readCollectorRecords,
  unverifiedLaunchLines,
  verifyLaunch,
  verifyReleaseLaunch,
} from '../engine/app-install.ts';
import {
  acquireBuildLock,
  releaseBuildLock,
  takeoverLine,
  waitForBuild,
  type BuildLockHandle,
  type WaitForBuildResult,
} from '../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot, type BuildSlotHandle } from '../engine/build-slots.ts';
import { readPodState, podsAreStale, runPodInstall } from '../engine/deps.ts';
import {
  checkDeviceCapacity,
  clearIosAdoptionPending,
  ensureBooted,
  ensureOwnedDevice,
  unknownIosDeviceTypeRefusal,
  unknownIosRuntimeRefusal,
} from '../engine/device.ts';
import { listIosRuntimes } from '../sim/ios.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from '../sim-pool.ts';
import {
  REMOTE_SESSION_ERROR,
  binOnPath,
  ensureRemoteBootOwned,
  ensureMetroReachable,
  remoteIosDeps,
  resolveRemoteContext,
} from '../engine/device-remote.ts';
import {
  DEVICECTL_INSTALL_TIMEOUT_MS,
  LAUNCH_PROBE_TIMEOUT_MS,
  awaitIosDeviceLaunch,
  installIosDeviceApp,
  iosDeviceProcess,
  iosPoolCandidates,
  iosPoolNoCandidatesRefusal,
  listIosDevices,
  localNetworkPending,
  resolveIosPhysicalDevice,
  verifyIosDeviceReleaseLaunch,
} from '../engine/ios-device.ts';
import { selectFromPool } from '../engine/device-pool.ts';
import {
  DEBUG_VERIFY_STEP_MS,
  acquireRunLease,
  leaseExpiryText,
  lostLine,
  lostRefusal,
  parseDeviceWait,
  releaseLeaseOnSignal,
  runLease,
  waitFlagConflict,
  type LeaseFacts,
  type RunLease,
} from '../engine/device-lease-run.ts';
import { gateProfileForDevice, sealAppForDevice } from '../engine/ios-signing.ts';
import { chooseLanAddress, copyAppAside, ensureLanReachable, lanOriginUrlFor, writeIpTxt } from '../engine/ios-lan.ts';
import { hostLanCandidates } from '../engine/lan-address.ts';
import { detectProviders } from '../engine/metro-reach.ts';
import { ownedSessionName } from '../engine/eas-simulator.ts';
import { type Diagnostic, describeDiagnostic } from '../engine/errors-xcode.ts';
import { needsPrebuild, runPrebuild } from '../engine/prebuild.ts';
import {
  RESOLVE_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  cacheLevel,
  checkEasAuth,
  easAuthNote,
  exitAfterFlush,
  isEasAuthFailureText,
  loadProjectProvider,
  resolveEasCliBin,
  resolveRemote,
  uploadRemote,
  type LoadProjectProviderResult,
} from '../engine/remote-cache.ts';
import {
  createRunRecorder,
  readRunEstimates,
  recordRunStats,
  statsProjectKey,
  type RunEstimates,
  type RunRecorder,
} from '../engine/stats.ts';
import { swapJsBundle } from '../engine/js-swap.ts';
import {
  buildIos,
  compilationCacheActivityLine,
  COMPILATION_CACHE_NOT_RUN,
  COMPILATION_CACHE_UNAVAILABLE,
  readBundleExecutable,
  readBundleId,
} from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
import type { CacheHitLevel, CompilationCacheActivity, IosFacts, RemoteDeviceBackend } from '../types.ts';
import { NOT_OURS_FOREIGN_CWD, isPidAlive, resolveProjectMetro } from '../metro.ts';
import { createNdjsonWriter, type NdjsonWriter } from '../ndjson.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../paths.ts';
import {
  appProjectProblem,
  detectBundleId,
  detectIsExpo,
  findProjectRoot,
  isPackageResolvable,
  projectShortcut,
} from '../project.ts';
import {
  cacheProviderSettingError,
  iosLanHostSetting,
  iosLanHostSettingError,
  iosSigningIdentitySetting,
  iosSigningIdentitySettingError,
  iosSigningIdentitySha1Setting,
  iosSigningIdentitySha1SettingError,
  publicUrlSetting,
  REMOTE_DEVICE_BACKENDS,
  remoteDeviceSettingError,
  remoteIosSetting,
  resolveCacheProviderConfig,
  resolveSettings,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
  tunnelModeSetting,
  unknownSettingKeys,
  type SettingsObject,
} from '../settings.ts';
import {
  MODE_BARE,
  MODE_EXPO,
  readWorkspaceState,
  writeWorkspaceLaunch,
  writeWorkspaceState,
} from '../supervisor/state.ts';
import { gitCommonDir, repoRoot } from '../worktree.ts';

export { formatDuration, phaseLine, shortHash, shortUdid } from '../command-output.ts';

function writeNote(line: string): void {
  console.error(line);
}

function writePhase(name: unknown, text: string): void {
  console.error(phaseLine(name, text));
}

export const PLATFORM = 'ios';

// xcodebuild cannot target a remote simulator UDID, so remote builds use the generic destination.
const GENERIC_SIM_DESTINATION = 'generic/platform=iOS Simulator';
const IPHONEOS_SDK = 'iphoneos';

const PROVIDER_SKIPPED_ON_DEVICE =
  'a device build is local-tier only: its cache key names the iphoneos slice, and a remote or provider entry is keyed for the simulator';

interface DeviceLike {
  deviceName?: string | null;
  name?: string | null;
  avdName?: string | null;
  deviceType?: string | null;
  runtime?: string | null;
  adopted?: boolean;
  adoptionPending?: boolean;
  parkedCacheKey?: string;
}

interface IosBootLike {
  ok?: boolean;
  failed?: boolean;
  udid?: string;
  reason?: string;
  code?: string;
  remedy?: string;
}

interface PodStateLike {
  hasPodfile?: boolean;
  lockText?: unknown;
  manifestText?: unknown;
}

interface PodVerdictLike {
  stale?: boolean;
  reason?: string;
  noPods?: boolean;
}

interface MetroResolutionLike {
  metro?: { pid?: number } | null;
  kind?: string;
  notOurs?: string | null;
}

interface SupervisorLike {
  pid?: number;
  port?: number;
  mode?: string;
}

interface RemoteUploadLike {
  uploaded?: boolean;
  timedOut?: boolean;
  failed?: string | null;
}

interface BuildIosResultLike {
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

interface VerifyLaunchResultLike {
  verified?: boolean;
  skipped?: boolean;
  requested?: boolean;
  fatal?: boolean;
  processAlive?: boolean | null;
  errors?: LaunchErrorRecord[];
  waitedMs?: number;
}

interface IosCommandOptions {
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

interface WaitedForBuild {
  pid?: number | null;
  ms?: number;
}

interface FailArgs {
  code: string;
  message?: string | null;
  remedy?: string | null;
  lines?: string[];
  logPath?: string | null;
  build?: BuildFailureFields | null;
  lease?: LeaseFacts | null;
}

interface BuildFailureFields {
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  appPath?: string | null;
  bundleId?: string | null;
}

export function buildLogFile(root: string): string {
  return join(workspaceLogsDir(root), `build-${PLATFORM}.ndjson`);
}

export function collectorLogFile(root: string): string {
  return join(workspaceLogsDir(root), `collector-${PLATFORM}.log`);
}

export function collectorEntry(): string {
  return spawnEntry('collector-run');
}

const MAX_PRINTED_DIAGNOSTICS = 6;

const COLLECTOR_EXIT_WAIT_MS = 2000;
const COLLECTOR_POLL_MS = 25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const SLOW_STEP_MS = 2000;

export function stepClock(now: () => number = Date.now): () => number {
  const t0 = now();
  return () => now() - t0;
}

export function stepTimer(now: () => number = Date.now): () => string {
  const elapsed = stepClock(now);
  return () => `(${formatDuration(elapsed())})`;
}

export function deviceLabel(device: DeviceLike | null | undefined, udid: unknown): string {
  const name = device?.deviceName || device?.name || null;
  return name ? `${name} (${shortUdid(udid)})` : shortUdid(udid);
}

export function deviceShortName(device: DeviceLike | null | undefined, udid: unknown): string {
  return device?.deviceName || device?.name || shortUdid(udid);
}

export function appNameFromPath(appPath: unknown): string | null {
  if (typeof appPath !== 'string' || appPath.trim() === '') return null;
  const name = basename(appPath).replace(/\.app$/i, '');
  return name === '' ? null : name;
}

export function iosConfigurationSetting(settings: SettingsObject | null | undefined): string | null {
  const ios = settings?.['ios'];
  if (!ios || typeof ios !== 'object' || Array.isArray(ios)) return null;
  const raw = (ios as Record<string, unknown>)['configuration'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function resolveConfiguration(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || iosConfigurationSetting(settings);
}

function iosStringSetting(settings: SettingsObject | null | undefined, key: string): string | null {
  const ios = settings?.['ios'];
  if (!ios || typeof ios !== 'object' || Array.isArray(ios)) return null;
  const raw = (ios as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function resolveDeviceType(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || iosStringSetting(settings, 'deviceType');
}

export function resolveRuntime(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || iosStringSetting(settings, 'runtime');
}

function deviceModelRefusal({
  deviceTypeFlag,
  runtimeFlag,
  deviceType,
  runtime,
  physical,
  remoteBackend,
  listRuntimes,
}: {
  deviceTypeFlag: string | undefined;
  runtimeFlag: string | undefined;
  deviceType: string | null;
  runtime: string | null;
  physical: boolean;
  remoteBackend: RemoteDeviceBackend | null;
  listRuntimes: typeof listIosRuntimes;
}): { code: string; message: string; remedy: string } | null {
  if (typeof deviceTypeFlag === 'string' && deviceTypeFlag.trim() === '') {
    return {
      code: 'STIM_BAD_ARG',
      message: '--device-type was given an empty name.',
      remedy:
        'Pass `--device-type <name>` with a model `xcrun simctl list devicetypes` names, e.g. "iPad Pro 13-inch (M4)".',
    };
  }
  if (typeof runtimeFlag === 'string' && runtimeFlag.trim() === '') {
    return {
      code: 'STIM_BAD_ARG',
      message: '--runtime was given an empty version.',
      remedy: 'Pass `--runtime <version>` with a runtime `xcrun simctl list runtimes` reports, e.g. "18.5".',
    };
  }
  if (physical || remoteBackend) return null;
  if (!deviceType && !runtime) return null;
  let runtimes;
  try {
    runtimes = listRuntimes();
  } catch (error) {
    return {
      code: 'STIM_NO_DEVICE',
      message: `Could not read the installed simulator runtimes: ${(error as Error)?.message || error}`,
      remedy: 'Run `stim doctor` to check the simulator toolchain, then try again.',
    };
  }
  const refusal =
    unknownIosRuntimeRefusal(runtime, runtimes) ?? unknownIosDeviceTypeRefusal(deviceType, runtimes, runtime);
  return refusal ? { code: 'STIM_BAD_ARG', message: refusal.message, remedy: refusal.remedy } : null;
}

export function isReleaseConfiguration(configuration: string | null | undefined): boolean {
  return (
    typeof configuration === 'string' && configuration.trim() !== '' && configuration.trim().toLowerCase() !== 'debug'
  );
}

export function podAction(
  podState: PodStateLike | null | undefined,
  verdict: PodVerdictLike | null | undefined,
): { install: boolean; reason?: string } {
  if (verdict?.stale) return { install: true, reason: verdict.reason };
  if (verdict?.noPods && podState?.hasPodfile) {
    return { install: true, reason: 'ios/Podfile exists but no pods are installed' };
  }
  return { install: false };
}

export function devClientScheme(
  root: string,
  appPath: string | null = null,
  { exec = null }: { exec?: import('../exec.ts').Executor | null } = {},
): string | undefined {
  if (!hasDevClient(root)) return undefined;
  const fromBundle = pickDevClientScheme(readBundleSchemes(appPath, { exec }));
  if (fromBundle) return fromBundle;
  const app = readJson(join(root, 'app.json')) as { expo?: { scheme?: unknown }; scheme?: unknown } | null;
  const raw = app?.expo?.scheme ?? app?.scheme ?? null;
  const scheme = Array.isArray(raw) ? raw.find((s) => typeof s === 'string' && s.trim() !== '') : raw;
  if (typeof scheme !== 'string' || scheme.trim() === '') return undefined;
  return scheme.trim();
}

export function schemesFromInfoPlist(plist: unknown): string[] {
  const types = (plist as { CFBundleURLTypes?: unknown })?.CFBundleURLTypes;
  if (!Array.isArray(types)) return [];
  const out: string[] = [];
  for (const type of types) {
    const schemes = (type as { CFBundleURLSchemes?: unknown })?.CFBundleURLSchemes;
    if (Array.isArray(schemes)) out.push(...schemes.filter((s) => typeof s === 'string' && s.trim() !== ''));
  }
  return out;
}

export function readBundleSchemes(
  appPath: unknown,
  { exec = null }: { exec?: import('../exec.ts').Executor | null } = {},
): string[] {
  if (typeof appPath !== 'string' || appPath.trim() === '') return [];
  const e = exec || getExecutor();
  let out;
  try {
    out = e.runFile('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Info.plist')]);
  } catch {
    return [];
  }
  try {
    return schemesFromInfoPlist(JSON.parse(String(out)));
  } catch {
    return [];
  }
}

const THIRD_PARTY_SCHEME =
  /^(?:fb\d+|com\.googleusercontent\.apps\.|msauth\.|msauthv2|twitterkit-|db-[a-z0-9]+$|spotify|snapchat|com\.facebook)/i;

export function pickDevClientScheme(schemes: unknown): string | null {
  const all = (Array.isArray(schemes) ? schemes : [])
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .map((s) => s.trim())
    .filter((s) => !/^(?:https?|mailto|tel|sms|itms(?:-apps)?)$/i.test(s));
  const expo = all.filter((s) => s.startsWith('exp+'));
  const pool = expo.length ? expo : all.filter((s) => !THIRD_PARTY_SCHEME.test(s));
  const sorted = pool.toSorted((a, b) => b.length - a.length);
  return sorted[0] ?? null;
}

function hasDevClient(root: string): boolean {
  const pkg = readJson(join(root, 'package.json')) as {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  } | null;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if ('expo-dev-client' in deps) return true;
  return isPackageResolvable(root, 'expo-dev-client');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export const GATE_RETRY_DELAYS_MS: number[] = [3000, 7000, 10000];

export function gateShouldRetry(resolution: MetroResolutionLike | null | undefined): boolean {
  if (resolution?.metro) return false;
  return resolution?.kind !== NOT_OURS_FOREIGN_CWD;
}

export async function resolveMetroWithRetry(
  resolve: (port: number, root: string) => Promise<MetroResolutionLike>,
  port: number,
  root: string,
  {
    delays = GATE_RETRY_DELAYS_MS,
    sleep: wait = sleep,
    onRetry = (_info: { attempt: number; delayMs: number; resolution: MetroResolutionLike }) => {},
  }: {
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; delayMs: number; resolution: MetroResolutionLike }) => void;
  } = {},
): Promise<MetroResolutionLike> {
  let resolution = await resolve(port, root);
  for (let i = 0; i < delays.length && gateShouldRetry(resolution); i++) {
    const delayMs = delays[i];
    if (delayMs === undefined) break;
    onRetry({ attempt: i + 1, delayMs, resolution });
    await wait(delayMs);
    resolution = await resolve(port, root);
  }
  return resolution;
}

export function noMetroMessage({
  port,
  resolution,
  supervisor,
  supervisorAlive,
}: {
  port: number;
  resolution?: MetroResolutionLike | null;
  supervisor?: SupervisorLike | null;
  supervisorAlive?: boolean;
}): string {
  const foreign = resolution?.notOurs;
  if (supervisor && supervisor.port === port && supervisorAlive) {
    const mode = supervisor.mode ? `${supervisor.mode} ` : '';
    return (
      `A supervisor record exists for port ${port} (pid ${supervisor.pid}, ${mode}dev server) but it did not verify as this workspace's Metro` +
      `${foreign ? `: ${foreign}` : ' -- nothing answered /status'}.` +
      ' Metro may still be indexing this project (a monorepo file-map crawl blocks its event loop for ~20s after the port opens).'
    );
  }
  if (foreign) return `Port ${port} is in use but is NOT this workspace's dev server: ${foreign}.`;
  return `Nothing is serving this workspace's dev server on port ${port}.`;
}

export function noMetroRemedy({
  port,
  supervisor,
  supervisorAlive,
}: {
  port: number;
  supervisor?: SupervisorLike | null;
  supervisorAlive?: boolean;
}): string {
  if (supervisor && supervisor.port === port && supervisorAlive) {
    return 'Re-run `stim ios` in a few seconds, or give the dev server longer to verify with `stim start --wait <seconds>`.';
  }
  return 'Run `stim start` first, or pass --no-metro-check.';
}

export async function ensureWorkspaceStorageSafely(
  root: string,
  { note = (_line: string) => {} }: { note?: (line: string) => void } = {},
): Promise<unknown> {
  try {
    return ensureWorkspaceStorage(root);
  } catch (err) {
    note(chalk.dim(`Could not prepare this workspace's Stim state: ${(err as Error)?.message || err}`));
    throw err;
  }
}

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

interface ReplaceCollectorArgs {
  root: string;
  udid: string;
  bundleId: string;
  appName?: string | null;
  appExecutable?: string | null;
  physical?: boolean;
  payloadUrl?: string | null;
  spawn?: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  readState?: typeof readWorkspaceState;
  verify?: typeof verifyCollectorOwnership;
  waitMs?: number;
  note?: (line: string) => void;
}

// On hardware the collector holds the devicectl console of a running app, and
// an upgrade install terminates that app -- which ends devicectl non-zero and
// records a failure for a normal action. So a device run stops the previous
// collector before it installs, rather than as part of starting its own.
export async function stopPreviousCollector({
  root,
  kill = (pid, signal) => process.kill(pid, signal),
  alive = isPidAlive,
  readState = readWorkspaceState,
  verify = verifyCollectorOwnership,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  note = (_line: string) => {},
}: {
  root: string;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  readState?: typeof readWorkspaceState;
  verify?: typeof verifyCollectorOwnership;
  waitMs?: number;
  note?: (line: string) => void;
}): Promise<{ killed: number | null }> {
  const previous = (readState(root)?.collectors as Record<string, { pid?: number }> | undefined)?.[PLATFORM] || null;
  const previousPid = Number(previous?.pid) || null;
  let killed: number | null = null;

  if (previousPid) {
    const ownership = verify({ pid: previousPid, platform: PLATFORM, root, isAlive: alive });
    if (ownership.status === 'ours') {
      try {
        kill(previousPid, 'SIGTERM');
        killed = previousPid;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
          note(
            chalk.yellow(
              `Could not stop the previous ${PLATFORM} log collector (pid ${previousPid}): ${(err as Error)?.message || err}`,
            ),
          );
        }
      }
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && alive(previousPid)) {
        await sleep(COLLECTOR_POLL_MS);
      }
    } else if (ownership.status === 'unverified') {
      note(
        chalk.dim(
          `Previous ${PLATFORM} log collector (pid ${previousPid}): ${ownership.reason}, so it was not signalled -- starting a replacement anyway`,
        ),
      );
    }
  }
  return { killed };
}

export async function replaceCollector({
  root,
  udid,
  bundleId,
  appName,
  appExecutable,
  physical = false,
  payloadUrl = null,
  spawn = (cmd, args, opts) => getExecutor().spawn(cmd, args, opts),
  kill = (pid, signal) => process.kill(pid, signal),
  alive = isPidAlive,
  readState = readWorkspaceState,
  verify = verifyCollectorOwnership,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  note = (_line: string) => {},
}: ReplaceCollectorArgs): Promise<{ killed: number | null; pid: number | null }> {
  const { killed } = await stopPreviousCollector({ root, kill, alive, readState, verify, waitMs, note });

  const args = [collectorEntry(), '--platform', PLATFORM, '--root', root, '--udid', udid, '--bundle', bundleId];
  if (appName) args.push('--app-name', appName);
  if (appExecutable) args.push('--app-executable', appExecutable);
  if (physical) args.push('--physical');
  if (payloadUrl) args.push('--payload-url', payloadUrl);

  let stdio: 'ignore' | (number | 'ignore')[] = 'ignore';
  try {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const fd = openSync(collectorLogFile(root), 'a');
    stdio = ['ignore', fd, fd];
  } catch {}

  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio,
      env: process.env,
    });
    child?.unref?.();
  } catch (err) {
    note(chalk.yellow(`Could not start the ${PLATFORM} log collector: ${(err as Error)?.message || err}`));
    return { killed, pid: null };
  }
  return { killed, pid: child?.pid ?? null };
}

interface IosDeps {
  resolveRemoteContext: typeof resolveRemoteContext;
  ensureMetroReachable: typeof ensureMetroReachable;
  ensureRemoteBootOwned: typeof ensureRemoteBootOwned;
  detectProviders: typeof detectProviders;
  remoteIosDeps: typeof remoteIosDeps;
  resolveEasCliBin: typeof resolveEasCliBin;
  findProjectRoot: typeof findProjectRoot;
  resolveSettings: typeof resolveSettings;
  gitCommonDir: typeof gitCommonDir;
  repoRoot: typeof repoRoot;
  detectBundleId: typeof detectBundleId;
  detectIsExpo: typeof detectIsExpo;
  devClientScheme: typeof devClientScheme;
  getProject: typeof getProject;
  upsertProject: typeof upsertProject;
  projectShortcut: typeof projectShortcut;
  checkDeviceCapacity: typeof checkDeviceCapacity;
  ensureOwnedDevice: typeof ensureOwnedDevice;
  listIosRuntimes: typeof listIosRuntimes;
  ensureBooted: typeof ensureBooted;
  resolveProjectMetro: typeof resolveProjectMetro;
  resolveMetroWithRetry: typeof resolveMetroWithRetry;
  readWorkspaceState: typeof readWorkspaceState;
  isPidAlive: typeof isPidAlive;
  getConcurrencyLimits: typeof getConcurrencyLimits;
  fingerprintProject: typeof fingerprintProject;
  untrackedNativeFiles: typeof untrackedNativeFiles;
  resolveBuild: typeof resolveBuild;
  storeBuild: typeof storeBuild;
  resolveCacheProviderConfig: typeof resolveCacheProviderConfig;
  loadCacheProvider: typeof loadCacheProvider;
  acquireBuildLock: typeof acquireBuildLock;
  releaseBuildLock: typeof releaseBuildLock;
  waitForBuild: typeof waitForBuild;
  acquireBuildSlot: typeof acquireBuildSlot;
  releaseBuildSlot: typeof releaseBuildSlot;
  loadProjectProvider: typeof loadProjectProvider;
  checkEasAuth: typeof checkEasAuth;
  resolveRemote: typeof resolveRemote;
  uploadRemote: typeof uploadRemote;
  needsPrebuild: typeof needsPrebuild;
  runPrebuild: typeof runPrebuild;
  readPodState: typeof readPodState;
  podsAreStale: typeof podsAreStale;
  runPodInstall: typeof runPodInstall;
  buildIos: typeof buildIos;
  listIosDevices: typeof listIosDevices;
  hostLanCandidates: typeof hostLanCandidates;
  ensureLanReachable: typeof ensureLanReachable;
  gateProfileForDevice: typeof gateProfileForDevice;
  sealAppForDevice: typeof sealAppForDevice;
  installIosDeviceApp: typeof installIosDeviceApp;
  awaitIosDeviceLaunch: typeof awaitIosDeviceLaunch;
  acquireRunLease: typeof acquireRunLease;
  runLease: typeof runLease;
  selectFromPool: typeof selectFromPool;
  releaseLeaseOnSignal: typeof releaseLeaseOnSignal;
  iosDeviceProcess: typeof iosDeviceProcess;
  verifyIosDeviceReleaseLaunch: typeof verifyIosDeviceReleaseLaunch;
  readBundleId: typeof readBundleId;
  readBundleExecutable: typeof readBundleExecutable;
  swapJsBundle: typeof swapJsBundle;
  installIosApp: typeof installIosApp;
  clearOtherUserApps: typeof clearOtherUserApps;
  clearIosAdoptionPending: typeof clearIosAdoptionPending;
  launchIosApp: typeof launchIosApp;
  verifyLaunch: typeof verifyLaunch;
  verifyReleaseLaunch: typeof verifyReleaseLaunch;
  ensureWorkspaceStorage: typeof ensureWorkspaceStorageSafely;
  replaceCollector: typeof replaceCollector;
  stopPreviousCollector: typeof stopPreviousCollector;
  writeWorkspaceLaunch: typeof writeWorkspaceLaunch;
  writeWorkspaceState: typeof writeWorkspaceState;
  createWriter: typeof createNdjsonWriter;
  recordStats: typeof recordRunStats;
  readEstimates: typeof readRunEstimates;
  now: () => number;
}

const DEFAULT_DEPS: IosDeps = {
  findProjectRoot,
  resolveSettings,
  gitCommonDir,
  repoRoot,
  detectBundleId,
  detectIsExpo,
  devClientScheme,
  getProject,
  upsertProject,
  projectShortcut,
  checkDeviceCapacity,
  ensureOwnedDevice,
  listIosRuntimes,
  ensureBooted,
  resolveRemoteContext,
  remoteIosDeps,
  ensureMetroReachable,
  ensureRemoteBootOwned,
  detectProviders,
  resolveProjectMetro,
  resolveMetroWithRetry,
  readWorkspaceState,
  isPidAlive,
  getConcurrencyLimits,
  fingerprintProject,
  untrackedNativeFiles,
  resolveBuild,
  storeBuild,
  resolveCacheProviderConfig,
  loadCacheProvider,
  acquireBuildLock,
  releaseBuildLock,
  waitForBuild,
  acquireBuildSlot,
  releaseBuildSlot,
  loadProjectProvider,
  checkEasAuth,
  resolveEasCliBin,
  resolveRemote,
  uploadRemote,
  needsPrebuild,
  runPrebuild,
  readPodState,
  podsAreStale,
  runPodInstall,
  buildIos,
  listIosDevices,
  hostLanCandidates,
  ensureLanReachable,
  gateProfileForDevice,
  sealAppForDevice,
  installIosDeviceApp,
  awaitIosDeviceLaunch,
  acquireRunLease,
  runLease,
  selectFromPool,
  releaseLeaseOnSignal,
  iosDeviceProcess,
  verifyIosDeviceReleaseLaunch,
  readBundleId,
  readBundleExecutable,
  swapJsBundle,
  installIosApp,
  clearOtherUserApps,
  clearIosAdoptionPending,
  launchIosApp,
  verifyLaunch,
  verifyReleaseLaunch,
  ensureWorkspaceStorage: ensureWorkspaceStorageSafely,
  replaceCollector,
  stopPreviousCollector,
  writeWorkspaceLaunch,
  writeWorkspaceState,
  createWriter: createNdjsonWriter,
  recordStats: recordRunStats,
  readEstimates: readRunEstimates,
  now: () => Date.now(),
};

export default function iosCommand(program: Command): void {
  registerIos(program);
}

export function registerIos(program: Command, deps: Partial<IosDeps> = {}): void {
  program
    .command('ios')
    .description(
      "Build (or restore from the fingerprint cache), install and launch this workspace's app on its owned " +
        'simulator, wired to the reserved Metro port. Requires a running dev server (`stim start`).',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--no-metro-check', 'Skip the "is this workspace\'s dev server running?" gate and build anyway')
    .option(
      '--no-build-cache',
      "Build fresh, ignoring cached artifacts (local and the project's build-cache provider); the fresh build still replaces the cache entry",
    )
    .option(
      '--configuration <name>',
      'Xcode configuration to build (e.g. Release). A non-Debug configuration embeds the JS bundle and skips Metro entirely. Overrides the ios.configuration setting. Default: Debug',
    )
    .option(
      '--device-type <name>',
      "Simulator model to create this workspace's owned sim as, exactly as `xcrun simctl list devicetypes` names it " +
        '(e.g. "iPad Pro 13-inch (M4)"). Overrides the ios.deviceType setting for this invocation. A model no installed ' +
        'runtime can create refuses with STIM_BAD_ARG and prints the models they do offer.',
    )
    .option(
      '--runtime <version>',
      'Simulator runtime to create this workspace\'s owned sim on, as a version ("18.5") or a runtime\'s full name ' +
        '("iOS 18.5"); nothing else matches. Overrides the ios.runtime setting for this invocation. An unknown version ' +
        'refuses with STIM_BAD_ARG and prints the installed runtimes.',
    )
    .option(
      '--device [udid]',
      "Build the iphoneos slice for a connected iPhone, install it, and launch it, instead of using this workspace's " +
        'owned simulator. With no UDID, the first connected device this workspace can lease is used. In Debug the app is wired to this ' +
        "workspace's Metro over the LAN. Stim never creates, boots, or deletes a physical device.",
    )
    .option(
      '--remote <backend>',
      'Install and launch on a remote device with proxy or EAS. The build still happens here.',
      (value) => {
        if ((REMOTE_DEVICE_BACKENDS as readonly string[]).includes(value)) return value as RemoteDeviceBackend;
        throw new InvalidArgumentError(`expected one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}`);
      },
    )
    .option(
      '--wait <seconds>',
      'How long to wait for another workspace to release the phone it leases, before refusing with STIM_DEVICE_BUSY (default 60, 0 refuses at once). Only with --device.',
    )
    .option(
      '--no-wait',
      "Install on a phone another workspace leases instead of waiting: this run takes no lease and, when both workspaces build the same app id, the install terminates the holder's running app. Only with --device.",
    )
    .action(async (opts: IosCommandOptions) => {
      await runIos({ ...opts, waitConflict: waitFlagConflict(process.argv) }, deps);
    });
}

interface VerifyIosRunArgs {
  d: IosDeps;
  release: boolean;
  launched: ReturnType<IosDeps['launchIosApp']>;
  configuration: string | null;
  phase: (name: unknown, text: string) => void;
  note: (line: string) => void;
  metroCheck: boolean;
  logsDir: string;
  launchedAt: number;
  metroPort: number | null;
  isExpo: boolean;
  bundleId: string;
  udid: string;
  scheme?: string;
  physical: boolean;
  appName: string | null;
  lanAddress: string | null;
  lanOrigin: string | null;
  remoteDevice: boolean;
  metroOrigin: string | null;
}

async function verifyIosRun({
  d,
  release,
  launched,
  configuration,
  phase,
  note,
  metroCheck,
  logsDir,
  launchedAt,
  metroPort,
  isExpo,
  bundleId,
  udid,
  scheme,
  physical,
  appName,
  lanAddress,
  lanOrigin,
  remoteDevice,
  metroOrigin,
}: VerifyIosRunArgs): Promise<boolean | string> {
  const deviceProcess = (): boolean | null => {
    const pid = d.iosDeviceProcess({ udid, appName: appName ?? bundleId });
    return pid === undefined ? null : pid !== null;
  };

  if (release) {
    const processCheck = physical
      ? await d.verifyIosDeviceReleaseLaunch({ udid, appName: appName ?? bundleId })
      : await d.verifyReleaseLaunch({ pid: launched?.pid ?? null });
    if (processCheck?.verified) {
      phase(
        'verify',
        `process alive ${formatDuration(processCheck.waitedMs ?? 0)} after launch (${configuration}: no bundle fetch to observe)`,
      );
      return true;
    }
    phase(
      'verify',
      chalk.yellow(
        processCheck?.reason === 'exited'
          ? `UNVERIFIED: the app process exited within ${formatDuration(processCheck.waitedMs ?? 0)} of launch`
          : physical
            ? `UNVERIFIED: devicectl could not read ${udid}'s process list`
            : 'UNVERIFIED: simctl launch reported no process id to check',
      ),
    );
    note(
      chalk.yellow(
        phaseLine(
          '',
          'A release app that dies at startup usually crashed loading its embedded bundle; `stim logs --errors` has the device log that says why.',
        ),
      ),
    );
    return processCheck?.reason === 'exited' ? LAUNCH_FATAL : LAUNCH_UNVERIFIED;
  }

  const verification: VerifyLaunchResultLike = metroCheck
    ? await d.verifyLaunch({
        logsDir,
        since: launchedAt,
        metroPort,
        platform: 'ios',
        mode: isExpo ? MODE_EXPO : MODE_BARE,
        processAlive: remoteDevice
          ? null
          : physical
            ? deviceProcess
            : () => {
                if (launched?.pid) return d.isPidAlive(launched.pid);
                const pid = iosAppProcess(udid, bundleId);
                return pid === undefined ? null : pid !== null;
              },
      })
    : { verified: false, skipped: true };
  if (verification?.fatal) {
    const reason = verification.processAlive === false ? 'the app process exited' : 'Metro could not build the bundle';
    phase('verify', chalk.red(`FATAL after ${formatDuration(verification.waitedMs ?? 0)}: ${reason}`));
    for (const record of verification.errors ?? []) {
      if (record.msg) note(chalk.red(phaseLine('', String(record.msg))));
    }
    if (verification.processAlive === false) {
      note(
        chalk.yellow(
          phaseLine('remedy', 'Fix the crash, then run `stim ios` again. A Metro reload cannot restart an exited app.'),
        ),
      );
    } else if (verification.processAlive === true && metroPort !== null) {
      note(
        chalk.yellow(
          phaseLine(
            'remedy',
            `The native app is still running. Fix the JavaScript or TypeScript error, then run ${physical || remoteDevice ? `\`agent-device metro reload --metro-port ${metroPort}\`` : '`stim reload ios`'}. Do not run \`stim ios\` unless native inputs changed or the app process exits.`,
          ),
        ),
      );
    }
    return LAUNCH_FATAL;
  }
  if (verification?.verified) {
    phase(
      'verify',
      `bundle loaded` +
        (verification.processAlive === true ? ', process alive' : '') +
        `, stable for 3s -- the first screen may still be rendering` +
        ` (${formatDuration(verification.waitedMs ?? 0)} total)`,
    );
    const hasAppErrors = reportLaunchErrors(verification.errors ?? [], note);
    if (hasAppErrors && verification.processAlive === true && metroPort !== null) {
      note(
        chalk.yellow(
          phaseLine(
            'remedy',
            `The native app is still running. Fix the JavaScript or TypeScript error; Fast Refresh should apply the edit. If the error screen remains, run ${physical || remoteDevice ? `\`agent-device metro reload --metro-port ${metroPort}\`` : '`stim reload ios`'}. Do not run \`stim ios\` unless native inputs changed or the app process exits.`,
          ),
        ),
      );
    }
    return true;
  }
  if (verification?.skipped) {
    phase('verify', 'skipped (--no-metro-check): the launch is reported as unverified');
    return LAUNCH_UNVERIFIED;
  }
  if (verification?.requested) {
    phase(
      'verify',
      `BUNDLING: the app asked port ${metroPort} for its bundle and Metro was still building it ` +
        `after ${formatDuration(verification.waitedMs ?? 0)} (a cold bundle on a large graph outlasts this window)`,
    );
    note(
      chalk.dim(
        phaseLine('', 'Nothing to do: `stim logs --source metro` shows the build finishing, usually within a minute.'),
      ),
    );
    return LAUNCH_BUNDLING;
  }

  phase('verify', chalk.yellow("UNVERIFIED: no bundle request reached this workspace's Metro"));
  for (const line of unverifiedLaunchLines({
    platform: PLATFORM,
    metroPort: metroPort ?? DEFAULT_METRO_PORT,
    waitedMs: verification?.waitedMs,
    bundleId,
    udid,
    devClientUrl: scheme ? devClientUrl(scheme, metroPort ?? DEFAULT_METRO_PORT, lanAddress ?? undefined) : null,
    mode: isExpo ? MODE_EXPO : MODE_BARE,
    remote: remoteDevice,
    physical,
    devClient: Boolean(scheme),
    lanOrigin,
    metroOrigin,
    localNetworkPending:
      physical &&
      localNetworkPending(readCollectorRecords(logsDir), {
        since: launchedAt,
        pid: launched?.pid ?? null,
        lanOrigin,
      }),
  }))
    note(chalk.yellow(phaseLine('', line)));
  return LAUNCH_UNVERIFIED;
}

function reportLaunchErrors(errors: LaunchErrorRecord[], note: (line: string) => void): boolean {
  const report = launchErrorReport(errors);
  if (report.summary) note(chalk.dim(phaseLine('launch', report.summary)));
  for (const line of report.lines) note(chalk.yellow(phaseLine('launch', line)));
  return report.lines.length > 0;
}

async function finishIosUpload(
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

interface ReportIosResultArgs {
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

function reportIosResult({
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

interface FinishIosRunArgs {
  d: IosDeps;
  root: string;
  json: boolean;
  release: boolean;
  configuration: string | null;
  isExpo: boolean;
  metroCheck: boolean;
  metroPort: number | null;
  logsDir: string;
  logFile: string;
  device: DeviceLike;
  udid: string;
  physical: boolean;
  lanAddress: string | null;
  lanOriginUrl: string | null;
  remoteDevice: ReturnType<IosDeps['remoteIosDeps']> | null;
  bootPromise: Promise<IosBootLike | null | undefined>;
  bootDuration: () => string;
  appPath: string | null;
  bundleId: string | null;
  swapDir: string | null;
  buildFailure: BuildFailureFields;
  fail: (args: FailArgs) => null;
  phase: (name: unknown, text: string) => void;
  note: (line: string) => void;
  logWriter: () => NdjsonWriter;
  uploadPending: Promise<RemoteUploadLike> | null;
  providerUpload: Promise<ProviderCallResult<void>> | null;
  providerName: string | null;
  remote: LoadProjectProviderResult | null;
  abandonedRemote: boolean;
  elapsed: () => number;
  startedAt: string;
  storeHash: string | null;
  storeKey: string | null;
  cacheHit: CacheHitLevel;
  compilationCache: CompilationCacheActivity;
  useBuildCache: boolean;
  waitedForBuild: WaitedForBuild | null;
  closeWriter: () => void;
  lease: RunLease | null;
  releaseLease: () => void;
  recordRun: ReportIosResultArgs['recordRun'];
}

function cleanAdoptedIosApps({
  d,
  root,
  udid,
  bundleId,
  phase,
  note,
}: {
  d: IosDeps;
  root: string;
  udid: string;
  bundleId: string | null;
  phase: (name: unknown, text: string) => void;
  note: (line: string) => void;
}): string | null {
  const swept = d.clearOtherUserApps({ udid, keep: bundleId });
  if (swept.removed.length) {
    phase('install', `removed ${swept.removed.join(', ')}, left by the previous workspace`);
  }
  if (swept.listed && swept.failed.length === 0) {
    d.clearIosAdoptionPending(root);
    return null;
  }
  if (!swept.listed) return 'Could not list apps left by the previous workspace.';
  for (const failure of swept.failed) {
    note(chalk.yellow(phaseLine('install', `could not remove ${failure}, left by the previous workspace`)));
  }
  return `Could not remove ${swept.failed.join(', ')}, left by the previous workspace.`;
}

function resolveRunBundleId(d: IosDeps, root: string, appPath: string | null, bundleId: string | null): string | null {
  if (!appPath || bundleId) return bundleId;
  return d.readBundleId(appPath) || d.detectBundleId(root);
}

function removeSwapDirectory(swapDir: string | null): void {
  if (!swapDir) return;
  try {
    rmSync(swapDir, { recursive: true, force: true });
  } catch {}
}

function readRunExecutable(d: IosDeps, appPath: string | null, note: (line: string) => void): string | null {
  const executable = appPath ? d.readBundleExecutable(appPath) : null;
  if (appPath && !executable) {
    note(
      chalk.dim(
        `Could not read CFBundleExecutable from ${appPath}; the device log predicate falls back to the .app basename.`,
      ),
    );
  }
  return executable;
}

function recordIosReloadTarget({
  d,
  root,
  physical,
  remoteDevice,
  bundleId,
  udid,
  metroPort,
  release,
  launched,
  launchedAt,
  note,
}: {
  d: IosDeps;
  root: string;
  physical: boolean;
  remoteDevice: boolean;
  bundleId: string;
  udid: string;
  metroPort: number | null;
  release: boolean;
  launched: ReturnType<IosDeps['launchIosApp']>;
  launchedAt: number;
  note: (line: string) => void;
}): void {
  if (physical || remoteDevice) return;
  const deepLinkUrl = 'url' in launched && typeof launched.url === 'string' ? launched.url : null;
  try {
    d.writeWorkspaceLaunch(root, 'ios', {
      appId: bundleId,
      deviceId: udid,
      metroPort,
      release,
      deepLinkUrl,
      launchedAt: new Date(launchedAt).toISOString(),
    });
  } catch (error) {
    note(chalk.yellow(phaseLine('state', `could not record iOS launch: ${(error as Error)?.message || error}`)));
  }
}

async function finishIosRun({
  d,
  root,
  json,
  release,
  configuration,
  isExpo,
  metroCheck,
  metroPort,
  logsDir,
  logFile,
  device,
  udid,
  physical,
  lanAddress,
  lanOriginUrl,
  remoteDevice,
  bootPromise,
  bootDuration,
  appPath,
  bundleId: initialBundleId,
  swapDir,
  buildFailure,
  fail,
  phase,
  note,
  logWriter,
  uploadPending,
  providerUpload,
  providerName,
  remote,
  abandonedRemote: remoteWasAbandoned,
  elapsed,
  startedAt,
  storeHash,
  storeKey,
  cacheHit,
  compilationCache,
  useBuildCache,
  waitedForBuild,
  closeWriter,
  lease,
  releaseLease,
  recordRun,
}: FinishIosRunArgs): Promise<IosFacts | null> {
  let bundleId = initialBundleId;
  let leaseWarned = false;
  const raiseLeaseFor = (boundMs: number, beforeInstall: boolean): FailArgs | null => {
    const step = lease?.raise(boundMs);
    if (!step || step.ok) return null;
    if (beforeInstall) {
      const refusal = lostRefusal(step.holder, step.expiresAt, d.now());
      return { code: refusal.code, message: refusal.message, remedy: refusal.remedy, lease: refusal.lease };
    }
    if (!leaseWarned) {
      leaseWarned = true;
      note(chalk.yellow(phaseLine('lease', lostLine(step.holder, step.expiresAt, d.now()))));
    }
    return null;
  };

  bundleId = resolveRunBundleId(d, root, appPath, bundleId);
  if (appPath && !bundleId) {
    return fail({
      code: 'STIM_INSTALL_FAILED',
      message: `Could not read a bundle identifier from the cached app at ${appPath}.`,
      remedy: 'Remove the cache entry (`stim gc`) and run again to rebuild it.',
      build: { ...buildFailure, appPath },
    });
  }

  if (bundleId) d.upsertProject(root, { bundleId });

  const booted = await bootPromise;
  if (!booted?.ok) {
    return fail({
      code: booted?.code || 'STIM_NO_DEVICE',
      message: booted?.reason || 'The owned simulator could not be booted.',
      remedy: booted?.remedy || 'Run `stim ios` again to re-establish an owned simulator for this workspace.',
    });
  }
  const deviceOutcome = physical ? 'connected' : `${device?.adopted ? 'adopted' : 'booted'} ${bootDuration()}`;
  phase('device', `${deviceLabel(device, udid)} ${deviceOutcome}`);

  const scheme = release ? undefined : d.devClientScheme(root, appPath);
  const appName = appNameFromPath(appPath);
  const appExecutable = readRunExecutable(d, appPath, note);
  const dropSwapDir = () => removeSwapDirectory(swapDir);
  let installSkipped = false;
  let launched: ReturnType<IosDeps['launchIosApp']> | null = null;
  let launchedAt = d.now();

  if (physical) {
    const lostBeforeInstall = raiseLeaseFor(DEVICECTL_INSTALL_TIMEOUT_MS, true);
    if (lostBeforeInstall) return fail(lostBeforeInstall);
    await d.stopPreviousCollector({ root, note });
    const installTimer = stepTimer(d.now);
    const installed = d.installIosDeviceApp({ udid, appPath: appPath!, bundleId });
    if (installed?.failed) {
      dropSwapDir();
      return fail({
        code: installed.code || 'STIM_INSTALL_FAILED',
        message: installed.reason ?? `devicectl could not install ${appPath} on ${udid}.`,
        remedy: installed.remedy ?? null,
        build: { ...buildFailure, appPath, bundleId },
      });
    }
    phase('install', `${basename(appPath!)} -> ${deviceLabel(device, udid)} ${installTimer()}`);
    if (installed?.note) {
      note(chalk.yellow(phaseLine('install', installed.note)));
      logWriter().write({ src: 'build', level: 'warn', event: 'install_uninstalled_first', msg: installed.note });
    }
    dropSwapDir();

    raiseLeaseFor(COLLECTOR_EXIT_WAIT_MS + LAUNCH_PROBE_TIMEOUT_MS, false);
    const payloadUrl = scheme && metroPort !== null && lanAddress ? devClientUrl(scheme, metroPort, lanAddress) : null;
    const launchTimer = stepTimer(d.now);
    launchedAt = d.now();
    const collector = await d.replaceCollector({
      root,
      udid,
      bundleId: bundleId!,
      appName,
      physical: true,
      payloadUrl,
      note,
    });
    if (!collector?.pid) {
      return fail({
        code: 'STIM_LAUNCH_FAILED',
        message: `The device log collector, which is what launches ${bundleId} on a phone, could not be started.`,
        remedy: `Check ${logFile} and the workspace collector log, then run the command again.`,
        build: { ...buildFailure, appPath, bundleId },
      });
    }
    const started = await d.awaitIosDeviceLaunch({
      udid,
      bundleId: bundleId!,
      appName: appName ?? bundleId!,
      collectorPid: collector.pid,
      readRecords: () => readCollectorRecords(logsDir).filter((entry) => Number(entry.ts) >= launchedAt),
    });
    if (started.failed || !started.pid) {
      return fail({
        code: 'STIM_LAUNCH_FAILED',
        message: started.reason ?? `${bundleId} did not start on ${udid}.`,
        remedy: started.remedy ?? null,
        lines: started.lines ?? [],
        logPath: logsDir,
        build: { ...buildFailure, appPath, bundleId },
      });
    }
    launched = {
      ok: true,
      mode: payloadUrl ? 'payload-url' : 'launch',
      pid: started.pid,
      ...(payloadUrl ? { url: payloadUrl } : {}),
      ...(lanOriginUrl ? { jsLocation: lanOriginUrl } : {}),
    };
    phase('launch', `${bundleId!} pid ${started.pid} ${launchTimer()}`);
  } else {
    const adopting = Boolean(device?.adoptionPending);
    if (adopting) {
      const cleanupFailure = cleanAdoptedIosApps({ d, root, udid, bundleId, phase, note });
      if (cleanupFailure) {
        return fail({
          code: 'STIM_INSTALL_FAILED',
          message: `${cleanupFailure} Stim kept the adoption cleanup pending and did not install or launch the app.`,
          remedy: 'Run `stim ios` again after simulator tooling is responsive.',
          build: { ...buildFailure, appPath, bundleId },
        });
      }
    }
    const installTimer = stepTimer(d.now);
    const installed = d.installIosApp(
      {
        udid,
        appPath: appPath!,
        bundleId,
        devClientScheme: scheme,
        proveInstalled: !adopting || device?.parkedCacheKey === storeKey,
      },
      { now: d.now },
    );
    if (installed?.failed) {
      return fail({
        code: installed.code || 'STIM_INSTALL_FAILED',
        message: installed.reason,
        remedy: 'Check that the simulator is booted and that the app was built for the simulator SDK.',
        build: { ...buildFailure, appPath, bundleId },
      });
    }
    installSkipped = Boolean(installed?.skipped);
    const artifactDuration =
      installed?.artifactDurationMs === undefined
        ? installTimer()
        : `(${formatDuration(installed.artifactDurationMs)})`;
    phase(
      'install',
      installSkipped
        ? `unchanged (${deviceShortName(device, udid)} already has this build) ${artifactDuration}`
        : `${basename(appPath!)} -> ${deviceLabel(device, udid)} ${artifactDuration}`,
    );
    if (!remoteDevice && installed?.devClientPreparationDurationMs !== undefined) {
      phase('install', `dev client prepared (${formatDuration(installed.devClientPreparationDurationMs)})`);
    }

    dropSwapDir();

    const launchTimer = stepTimer(d.now);
    launchedAt = d.now();
    launched = d.launchIosApp({ udid, bundleId: bundleId!, metroPort, devClientScheme: scheme });
    if (launched?.failed) {
      return fail({
        code: launched.code || 'STIM_LAUNCH_FAILED',
        message: launched.reason,
        remedy: `Run \`xcrun simctl launch --console ${udid} ${bundleId}\` to see what the app reports, and check ${logFile}.`,
        build: { ...buildFailure, appPath, bundleId },
      });
    }
    phase('launch', `${bundleId!} ${launchTimer()}`);
  }

  recordIosReloadTarget({
    d,
    root,
    physical,
    remoteDevice: Boolean(remoteDevice),
    bundleId: bundleId!,
    udid,
    metroPort,
    release,
    launched: launched!,
    launchedAt,
    note,
  });

  logWriter().write({
    src: 'build',
    level: 'info',
    marker: true,
    event: 'launch',
    msg: release
      ? `launched ${bundleId} on ${udid} (${configuration}, embedded JS bundle, no Metro)`
      : `launched ${bundleId} on ${udid} against Metro ${lanOriginUrl ?? `port ${metroPort}`}` +
        (launched?.mode === 'openurl' || launched?.mode === 'payload-url' ? ' (expo-dev-client)' : ''),
  });

  if (!physical) await d.replaceCollector({ root, udid, bundleId: bundleId!, appName, appExecutable, note });

  if (physical) raiseLeaseFor(release ? RELEASE_VERIFY_WAIT_MS : DEBUG_VERIFY_STEP_MS, false);
  const launchState = await verifyIosRun({
    d,
    release,
    launched,
    configuration,
    phase,
    note,
    metroCheck,
    logsDir,
    launchedAt,
    metroPort,
    isExpo,
    bundleId: bundleId!,
    udid,
    scheme,
    physical,
    appName,
    lanAddress,
    lanOrigin: lanOriginUrl,
    remoteDevice: Boolean(remoteDevice),
    metroOrigin: typeof launched?.jsLocation === 'string' ? launched.jsLocation : null,
  });
  if (launchState === LAUNCH_FATAL) {
    return fail({
      code: 'STIM_LAUNCH_FAILED',
      message: 'The app failed its launch readiness check.',
      remedy: `Read the launch error above or run \`stim logs --errors\`. The full timeline is in ${logsDir}.`,
      logPath: logsDir,
      build: { ...buildFailure, appPath, bundleId },
    });
  }
  logWriter().write(launchOutcomeRecord({ launchState, release, bundleId, configuration, metroPort }));

  const leaseFacts = lease?.facts() ?? null;
  releaseLease();

  const uploadWasAbandoned = await finishIosUpload(uploadPending, remote, phase, note);
  const providerOutcome = providerUploadOutcome(providerUpload ? await providerUpload : null, providerName);
  if (providerOutcome) {
    if (providerOutcome.warn) note(chalk.yellow(phaseLine('cache', providerOutcome.line)));
    else phase('cache', providerOutcome.line);
  }
  const facts = reportIosResult({
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
    bundleId: bundleId!,
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
    webPreviewUrl: remoteDevice?.webPreviewUrl() ?? null,
    lease: physical ? leaseFacts : undefined,
    recordRun,
  });
  if (remoteWasAbandoned || uploadWasAbandoned) exitAfterFlush(0);
  return facts;
}

export async function runIos(opts: IosCommandOptions = {}, overrides: Partial<IosDeps> = {}): Promise<IosFacts | null> {
  let d: typeof DEFAULT_DEPS = { ...DEFAULT_DEPS, ...overrides };
  const json = Boolean(opts.json);
  const metroCheck = opts.metroCheck !== false;
  const useBuildCache = opts.buildCache !== false;

  const phase = writePhase;
  const note = writeNote;

  const started = d.now();
  const startedAt = new Date(started).toISOString();
  const elapsed = () => d.now() - started;

  const foundRoot = d.findProjectRoot(process.cwd());
  if (!foundRoot) {
    note(chalk.red('Not in a React Native project (no package.json found).'));
    process.exit(1);
    return null;
  }
  const root = foundRoot;
  const projectProblem = appProjectProblem(root);
  if (projectProblem) {
    const { message, remedy } = projectProblem;
    note(chalk.red(phaseLine('error', message)));
    note(chalk.dim(phaseLine('remedy', remedy)));
    note(chalk.red(phaseLine('failed', 'STIM_NO_PROJECT')));
    if (json) console.log(JSON.stringify({ code: 'STIM_NO_PROJECT', message, remedy }));
    process.exit(1);
    return null;
  }

  try {
    await d.ensureWorkspaceStorage(root, { note });
  } catch (error) {
    const code = (error as Error & { code?: string })?.code || 'STIM_WORKSPACE_STATE';
    const message = `Could not prepare this workspace's Stim state: ${(error as Error)?.message || error}`;
    note(chalk.red(`${code}: ${message}`));
    note(
      chalk.dim(
        'Check that STIM_HOME is writable and has free space. An EPERM on a directory you can write is a sandbox: allow writes to STIM_HOME, or run Stim with the sandbox disabled (`stim guide errors`).',
      ),
    );
    if (json)
      console.log(JSON.stringify({ code, message, remedy: 'Check that STIM_HOME is writable and has free space.' }));
    process.exitCode = 1;
    return null;
  }

  const logsDir = workspaceLogsDir(root);
  const logFile = buildLogFile(root);
  let writer = null as NdjsonWriter | null;
  const logWriter = () => (writer ||= d.createWriter(logFile, { truncate: true }));

  let buildLock: BuildLockHandle | null = null;
  const releaseLock = () => {
    if (!buildLock) return;
    const held = buildLock;
    buildLock = null;
    try {
      d.releaseBuildLock(held);
    } catch (e) {
      note(chalk.dim(`Could not release the build lock at ${held.path}: ${(e as Error)?.message || e}`));
    }
  };

  let leaseHandle: RunLease | null = null;
  let stopLeaseSignals: (() => void) | null = null;
  const releaseLease = () => {
    const held = leaseHandle;
    const stopSignals = stopLeaseSignals;
    leaseHandle = null;
    stopLeaseSignals = null;
    stopSignals?.();
    try {
      held?.release();
    } catch (e) {
      note(chalk.dim(`Could not release this run's device lease: ${(e as Error)?.message || e}`));
    }
  };

  let buildSlot: BuildSlotHandle | null = null;
  const releaseSlot = () => {
    if (!buildSlot) return;
    const held = buildSlot;
    buildSlot = null;
    try {
      d.releaseBuildSlot(held);
    } catch (e) {
      note(chalk.dim(`Could not release the build slot: ${(e as Error)?.message || e}`));
    }
  };

  const stats = createRunRecorder({
    platform: PLATFORM,
    write: (statsRun, at) => d.recordStats(statsRun, at),
    now: () => d.now(),
    note: (line) => note(chalk.dim(line)),
  });
  const recordRun = stats.record;

  const fail = ({ code, message, remedy = null, lines = [], logPath = null, build = null, lease }: FailArgs): null => {
    releaseLock();
    releaseSlot();
    releaseLease();
    if (message) note(chalk.red(phaseLine('error', message)));
    for (const line of lines) note(chalk.dim(phaseLine('', line)));
    if (remedy) note(chalk.dim(phaseLine('remedy', remedy)));
    if (logPath) note(chalk.dim(phaseLine('log', logPath)));
    if (build)
      writeLastBuild(
        root,
        lastBuildRecord({ ...build, startedAt, status: 'failed', errorCode: code, durationMs: elapsed() }),
        { write: d.writeWorkspaceState },
      );
    note(chalk.red(phaseLine('failed', code)));
    recordRun({ failed: true, durationMs: elapsed() });
    if (json) {
      console.log(
        JSON.stringify({
          code,
          message: message ?? null,
          remedy: remedy ?? null,
          ...(lease === undefined ? {} : { lease }),
        }),
      );
    }
    writer?.close?.();
    process.exit(1);
    return null;
  };

  const settingsRepoRoot = d.repoRoot(root);
  const settingsContext = {
    projectPath: root,
    gitCommonDir: d.gitCommonDir(root),
    repoRoot: settingsRepoRoot,
  };
  const projectKey = statsProjectKey({ root, commonDir: settingsContext.gitCommonDir, repoRoot: settingsRepoRoot });
  stats.setProject(projectKey);
  let estimatesRead: RunEstimates | null = null;
  const estimates = (): RunEstimates => (estimatesRead ??= d.readEstimates({ projectKey, platform: PLATFORM }));
  const settings = d.resolveSettings(settingsContext);
  const [shapeError, ...moreShapeErrors] = settingShapeErrors(settings);
  if (shapeError) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: shapeError,
      lines: moreShapeErrors,
      remedy: SETTING_SHAPE_REMEDY,
    });
  }
  const cacheProviderConfig = d.resolveCacheProviderConfig(settingsContext);
  for (const key of unknownSettingKeys(settings)) {
    note(phaseLine('setting', chalk.yellow(`Warning: setting "${key}" is not read by Stim and will be ignored.`)));
  }
  const cacheProviderError = cacheProviderSettingError(settings);
  if (cacheProviderError) note(chalk.yellow(phaseLine('cache', `${cacheProviderError} Using the local cache.`)));
  const remoteSettingError = remoteDeviceSettingError(settings);
  if (remoteSettingError) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: remoteSettingError,
      remedy: `Set ios.remote and android.remote to one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}.`,
    });
  }

  const poolError = parkedMaxSetting('ios').error;
  if (poolError) return fail({ code: 'STIM_BAD_ARG', message: poolError, remedy: POOL_SETTING_REMEDY });

  for (const settingError of [
    iosSigningIdentitySettingError(settings),
    iosSigningIdentitySha1SettingError(settings),
    iosLanHostSettingError(settings),
  ]) {
    if (settingError) {
      return fail({
        code: 'STIM_BAD_ARG',
        message: settingError,
        remedy: SETTING_SHAPE_REMEDY,
      });
    }
  }

  const configuration = resolveConfiguration(opts.configuration, settings);
  const release = isReleaseConfiguration(configuration);

  const deviceType = resolveDeviceType(opts.deviceType, settings);
  const runtime = resolveRuntime(opts.runtime, settings);

  const deviceFlag = opts.device;
  const physical = deviceFlag !== null && deviceFlag !== undefined && deviceFlag !== false;
  if (physical && deviceFlag === '') {
    return fail({
      code: 'STIM_BAD_ARG',
      message: '--device was given an empty UDID.',
      remedy:
        'Pass `--device` on its own to take the first connected device this workspace can lease, or ' +
        '`--device <udid>` to name one.',
    });
  }
  if (physical && opts.remote) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: '--device builds for a phone cabled to this machine, and --remote installs on a remote one.',
      remedy: 'Pass only one of --device and --remote.',
    });
  }

  const noWait = opts.wait === false;
  const waitFlagged = opts.wait !== undefined;
  if (opts.waitConflict) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: '--wait and --no-wait ask for opposite things.',
      remedy: 'Pass `--wait <seconds>` to wait for the lease, or `--no-wait` to install without one.',
    });
  }
  if (waitFlagged && !physical) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: '--wait and --no-wait only apply to a `--device` run.',
      remedy: 'This workspace owns its simulator, so nothing contends for it. Drop the flag, or pass `--device`.',
    });
  }
  const waitParsed = parseDeviceWait(noWait ? undefined : opts.wait);
  if ('error' in waitParsed) {
    return fail({
      code: 'STIM_BAD_ARG',
      message: waitParsed.error,
      remedy: 'Pass a whole number of seconds, e.g. --wait 90. `--wait 0` refuses a leased device at once.',
    });
  }
  const waitSeconds = waitParsed.seconds;

  const isExpo = d.detectIsExpo(root);
  const remoteBackend = physical ? null : (opts.remote ?? remoteIosSetting(settings));
  const modelRefusal = deviceModelRefusal({
    deviceTypeFlag: opts.deviceType,
    runtimeFlag: opts.runtime,
    deviceType,
    runtime,
    physical,
    remoteBackend,
    listRuntimes: d.listIosRuntimes,
  });
  if (modelRefusal) return fail(modelRefusal);
  const registerProject = () => d.upsertProject(root, { bundleId: d.detectBundleId(root) ?? undefined, isExpo });
  if (remoteBackend !== 'eas') registerProject();
  const proj = d.getProject(root);
  const label = d.projectShortcut(root, proj);

  let remoteDevice: ReturnType<typeof d.remoteIosDeps> | null = null;
  if (remoteBackend) {
    const resolved = await d.resolveRemoteContext({
      root,
      label,
      backend: remoteBackend,
      easBin: d.resolveEasCliBin(root)?.file ?? null,
    });
    if ('failed' in resolved) {
      return fail({ code: resolved.code ?? REMOTE_SESSION_ERROR, message: resolved.failed, remedy: resolved.remedy });
    }
    remoteDevice = d.remoteIosDeps(resolved.ctx);
    d = {
      ...d,
      checkDeviceCapacity: remoteDevice.checkDeviceCapacity,
      ensureOwnedDevice: remoteDevice.ensureOwnedDevice,
      ensureBooted: remoteDevice.ensureBooted,
      installIosApp: remoteDevice.installIosApp,
      launchIosApp: remoteDevice.launchIosApp,
    };
  }

  const limits = d.getConcurrencyLimits();

  let physicalDevice: { udid: string; name: string } | null = null;
  if (physical && typeof deviceFlag !== 'string') {
    const pooled = await d.selectFromPool({
      root,
      platform: PLATFORM,
      idLabel: 'udid',
      list: () => iosPoolCandidates(d.listIosDevices()).map((entry) => ({ id: entry.udid, name: entry.name })),
      noCandidates: () => {
        const resolved = iosPoolNoCandidatesRefusal(d.listIosDevices());
        return { message: resolved.error as string, remedy: resolved.remedy as string };
      },
      waitSeconds,
      noWait,
      now: d.now,
      warn: (line: string) => note(chalk.yellow(phaseLine('lease', line))),
    });
    if (pooled.status === 'refused') {
      return fail({
        code: pooled.refusal.code,
        message: pooled.refusal.message,
        remedy: pooled.refusal.remedy,
        ...(pooled.refusal.lease === null ? {} : { lease: pooled.refusal.lease }),
      });
    }
    physicalDevice = { udid: pooled.candidate.id, name: pooled.candidate.name ?? pooled.candidate.id };
  } else if (physical) {
    const resolved = resolveIosPhysicalDevice(typeof deviceFlag === 'string' ? deviceFlag : null, d.listIosDevices());
    if (!resolved.udid) {
      return fail({ code: 'STIM_NO_DEVICE', message: resolved.error!, remedy: resolved.remedy! });
    }
    physicalDevice = { udid: resolved.udid, name: resolved.name ?? resolved.udid };
  }
  if (!physical) {
    const capacity = d.checkDeviceCapacity({
      platform: PLATFORM,
      project: proj,
      max: limits.maxDevices,
    });
    if (capacity) return fail(capacity);
  }

  let metroPort = proj?.metroPort ?? null;
  let lanAddress: string | null = null;
  let lanOriginUrl: string | null = null;
  if (!(await resolveMetroPort())) return null;

  let device: Awaited<ReturnType<typeof ensureOwnedDevice>>;
  if (physicalDevice) {
    device = { deviceUdid: physicalDevice.udid, deviceName: physicalDevice.name, owned: false } as Awaited<
      ReturnType<typeof ensureOwnedDevice>
    >;
  } else {
    const prepare = stepClock(d.now);
    try {
      device = await d.ensureOwnedDevice({
        platform: PLATFORM,
        project: proj,
        projectPath: root,
        settingsRoot: settingsRepoRoot ?? root,
        label,
        settings,
        flags: { deviceType, runtime },
        note,
        out: note,
      });
    } catch (e) {
      return fail({
        code: 'STIM_NO_DEVICE',
        message: `Could not ensure an owned iOS simulator: ${(e as Error)?.message || e}`,
        remedy: 'Run `stim doctor` to check the simulator toolchain, then try again.',
      });
    }
    const prepareMs = prepare();
    if (device.created || prepareMs >= SLOW_STEP_MS) {
      phase(
        'device',
        `${deviceLabel(device, device.deviceUdid)} ${device.created ? 'created' : 'prepared'} (${formatDuration(prepareMs)})`,
      );
    }
  }

  let bootDuration = '';
  let bootPromise!: Promise<{ ok?: boolean; reason?: string; udid?: string } | null | undefined>;
  let udid = '';
  let fingerprint = '';
  let fingerprintSources: FingerprintSource[] = [];
  let cacheKey = '';
  let storeHash: string | null = null;
  let storeKey: string | null = null;
  let storeSources: FingerprintSource[] = [];
  let appPath: string | null = null;
  let bundleId: string | null = null;
  let cacheHit: CacheHitLevel = false;
  let compilationCache: CompilationCacheActivity = COMPILATION_CACHE_NOT_RUN;
  let remote: LoadProjectProviderResult | null = null;
  let abandonedRemote = false;
  let uploadPending: Promise<RemoteUploadLike> | null = null;
  let providerUpload: Promise<ProviderCallResult<void>> | null = null;
  let providerName: string | null = null;
  let providerLoad: Promise<LoadCacheProviderResult> | null = null;
  const cacheWarn = createWarnOnce((line) => note(chalk.yellow(phaseLine('cache', line))));
  const loadProvider =
    cacheProviderConfig && !physical
      ? () => (providerLoad ??= d.loadCacheProvider({ projectRoot: root, config: cacheProviderConfig }))
      : null;
  if (cacheProviderConfig && physical) {
    note(chalk.dim(phaseLine('cache', PROVIDER_SKIPPED_ON_DEVICE)));
  }
  let waitedForBuild: WaitedForBuild | null = null;
  let swapDir: string | null = null;
  let swapFellBack = false;
  let buildFailure: BuildFailureFields = {};

  async function resolveMetroPort(): Promise<boolean> {
    if (release) {
      metroPort = null;
      phase('metro', `skipped (${configuration}: the JS bundle is embedded, no dev server is used)`);
    } else if (metroCheck) {
      if (!metroPort) {
        fail({
          code: 'STIM_NO_METRO',
          message: 'No Metro port is reserved for this workspace, so there is no dev server to build against.',
          remedy: 'Run `stim start` first, or pass --no-metro-check.',
        });
        return false;
      }
      const resolution = await d.resolveMetroWithRetry(d.resolveProjectMetro, metroPort, root, {
        onRetry: ({ delayMs }) =>
          note(
            chalk.dim(
              phaseLine(
                'metro',
                `port ${metroPort} did not verify yet; retrying in ${Math.round(delayMs / 1000)}s (Metro may still be indexing)`,
              ),
            ),
          ),
      });
      if (!resolution?.metro) {
        const supervisor = (d.readWorkspaceState(root)?.supervisor ?? null) as SupervisorLike | null;
        const supervisorAlive = Boolean(supervisor?.pid && d.isPidAlive(supervisor.pid));
        fail({
          code: 'STIM_NO_METRO',
          message: noMetroMessage({ port: metroPort, resolution, supervisor, supervisorAlive }),
          remedy: noMetroRemedy({ port: metroPort, supervisor, supervisorAlive }),
        });
        return false;
      }
    } else if (!metroPort) {
      metroPort = DEFAULT_METRO_PORT;
      note(chalk.yellow(`No Metro port is reserved for this workspace; wiring the app to ${metroPort}.`));
    }
    if (physical && metroPort !== null && !(await resolveLanOrigin())) return false;
    if (remoteDevice && metroPort !== null) {
      const reachable = await d.ensureMetroReachable({
        ctx: remoteDevice.ctx,
        metroPort,
        isExpo,
        tunnelMode: tunnelModeSetting(settings) ?? undefined,
        publicUrl: publicUrlSetting(settings),
        available: d.detectProviders(binOnPath),
      });
      if ('failed' in reachable) {
        fail({
          code: reachable.code ?? REMOTE_SESSION_ERROR,
          message: reachable.failed,
          remedy: reachable.remedy,
        });
        return false;
      }
    }
    return true;
  }

  async function resolveLanOrigin(): Promise<boolean> {
    const port = metroPort as number;
    const pinned = iosLanHostSetting(settings);
    const candidates = d.hostLanCandidates();
    const chosen = chooseLanAddress({ pinned, candidates });
    if (!chosen) {
      fail({
        code: 'STIM_NO_LAN_ADDRESS',
        message:
          'A Debug run on a phone needs an address the phone can reach, and this Mac has no non-internal IPv4 interface.',
        remedy:
          'The phone reaches Metro over the network you share, because USB carries no reverse forward. ' +
          'Join a Wi-Fi or Ethernet network, or connect this Mac by cable, then run the command again.',
      });
      return false;
    }
    lanAddress = chosen.address;
    lanOriginUrl = lanOriginUrlFor(chosen.address, port);
    const source = chosen.pinned
      ? 'ios.lanHost'
      : `${chosen.interfaceName ?? 'interface'}${chosen.candidates > 1 ? ` of ${chosen.candidates} candidates` : ''}`;
    phase('lan', `${lanOriginUrl} (${source})`);
    if (publicUrlSetting(settings) || tunnelModeSetting(settings)) {
      note(
        chalk.dim(
          phaseLine(
            'lan',
            'metro.publicUrl and metro.tunnel are ignored on --device: neither channel to a phone carries a URL, ' +
              'only a host and a port. They still apply to --remote.',
          ),
        ),
      );
    }
    if (!metroCheck) return true;
    const reachable = await d.ensureLanReachable({
      origin: lanOriginUrl,
      metroPort: port,
      root,
      isExpo,
      logsDir,
    });
    if ('failed' in reachable) {
      fail({ code: 'STIM_LAN_METRO_UNREACHABLE', message: reachable.failed, remedy: reachable.remedy });
      return false;
    }
    phase('lan', `gated: ${lanOriginUrl} answered as this workspace's Metro`);
    return true;
  }

  async function resolveInitialFingerprint(): Promise<boolean> {
    const bootTimer = stepTimer(d.now);
    const boot = (): Promise<IosBootLike> =>
      physicalDevice
        ? Promise.resolve({ ok: true, udid: physicalDevice.udid })
        : Promise.resolve(d.ensureBooted({ platform: PLATFORM, device, out: note })).catch((e) => ({
            ok: false,
            reason: String((e as Error)?.message || e),
          }));
    bootPromise = (
      remoteDevice?.ctx.backend === 'eas'
        ? d.ensureRemoteBootOwned({
            root,
            platform: PLATFORM,
            sessionName: ownedSessionName(remoteDevice.ctx.label),
            startedAt,
            boot,
            createdSessionId: remoteDevice.createdSessionId,
            abandonCreatedSession: remoteDevice.abandonCreatedSession,
            writeState: d.writeWorkspaceState,
            register: registerProject,
          })
        : boot()
    ).then((result) => {
      bootDuration = bootTimer();
      return result;
    });
    udid = (device.deviceUdid as string | undefined) ?? (await bootPromise)?.udid ?? '';

    const fingerprintTimer = stepTimer(d.now);
    let computedFingerprint: string | null;
    try {
      const computed = await d.fingerprintProject(root, { platform: PLATFORM });
      computedFingerprint = computed?.hash ?? null;
      fingerprintSources = computed?.sources ?? [];
    } catch (e) {
      computedFingerprint = null;
      note(chalk.dim(`Fingerprinting failed: ${(e as Error)?.message || e}`));
    }
    if (!computedFingerprint) {
      fail({
        code: 'STIM_NO_FINGERPRINT',
        message: `Could not fingerprint ${root}: @expo/fingerprint produced no hash for it.`,
        remedy: 'Check the project native inputs and the @expo/fingerprint error above, then retry.',
      });
      return false;
    }
    fingerprint = computedFingerprint;
    cacheKey = buildCacheKey(PLATFORM, fingerprint, {
      ...(configuration ? { configuration } : {}),
      isSimulator: !physical,
    });
    stats.setCacheKey(cacheKey);
    storeHash = fingerprint;
    storeKey = cacheKey;
    storeSources = fingerprintSources;

    const found = await resolveTieredBuild({
      local: filesystemBuildCapability({ resolve: d.resolveBuild, store: d.storeBuild, sources: fingerprintSources }),
      loadProvider,
      target: { projectRoot: root, platform: PLATFORM, key: cacheKey },
      destinationDir: providerDownloadPath(workspaceDir(root)),
      ensureDestination: prepareProviderDownloadDir,
      skipRead: !useBuildCache,
      warn: cacheWarn,
    });
    const cached = found?.tier === 'local' ? found.path : null;
    cacheHit = cached ? 'local' : false;
    let missDiff = '';
    let missUntracked: string | null = null;
    if (!cached) {
      const lastBuild = (d.readWorkspaceState(root)?.lastBuild ?? null) as Record<string, unknown> | null;
      const miss = describeFingerprintMiss({
        platform: PLATFORM,
        current: { hash: fingerprint, sources: fingerprintSources },
        lastBuild,
      });
      if (miss) {
        missDiff = fingerprintDiffSuffix(miss.changed);
        logWriter().write(
          fingerprintDiffRecord({ changed: miss.changed, previousHash: miss.previousHash, hash: fingerprint }),
        );
      } else if (useBuildCache) {
        missUntracked = untrackedMissLine(d.untrackedNativeFiles({ projectRoot: root }));
      }
    }
    phase(
      'fingerprint',
      `${shortHash(fingerprint)} ${cached ? 'hit' : 'miss'}${useBuildCache ? '' : ' (--no-build-cache)'} ${fingerprintTimer()}${missDiff}`,
    );
    if (missUntracked) note(chalk.dim(phaseLine('fingerprint', missUntracked)));
    if (found?.tier === 'provider') {
      cacheHit = 'remote';
      providerName = found.providerName ?? null;
      phase('cache', `provider hit (${providerName})${found.storedLocally ? ' -> stored locally' : ''}`);
    }
    appPath = found?.path ?? null;
    return true;
  }

  async function resolveRemoteArtifact(): Promise<void> {
    if (physical) return;
    if (!appPath) {
      const loaded: LoadProjectProviderResult = await d.loadProjectProvider(root, { isExpo });
      if (loaded?.unavailable) {
        note(chalk.yellow(phaseLine('cache', `provider not usable: ${loaded.unavailable}`)));
      } else if (loaded?.provider) {
        remote = loaded;
      }
      if (remote?.name === 'eas') {
        const auth = d.checkEasAuth({ projectRoot: root, owner: loaded?.owner || null });
        const authNote = easAuthNote(auth as Parameters<typeof easAuthNote>[0]);
        if (authNote) note(chalk.yellow(phaseLine('cache', authNote)));
        if (auth?.code === 'logged-out') remote = null;
      }
    }

    if (remote && useBuildCache) {
      const remoteTimer = stepTimer(d.now);
      const hit = await d.resolveRemote({
        logWriter: logWriter(),
        provider: remote.provider,
        platform: PLATFORM,
        projectRoot: root,
        fingerprintHash: fingerprint,
        runOptions: configuration ? { configuration } : null,
      });
      if (hit?.appPath) {
        let stored = null;
        try {
          stored = d.storeBuild(PLATFORM, cacheKey, hit.appPath, { sources: fingerprintSources });
        } catch (e) {
          note(
            chalk.yellow(phaseLine('cache', `remote hit could not be stored locally: ${(e as Error)?.message || e}`)),
          );
        }
        appPath = stored || hit.appPath;
        cacheHit = 'remote';
        phase('cache', `remote hit (${remote.name})${stored ? ' -> stored locally' : ''} ${remoteTimer()}`);
      } else if (hit?.timedOut) {
        abandonedRemote = true;
        note(
          chalk.yellow(
            phaseLine(
              'cache',
              `${remote.name} did not answer within ${formatDuration(RESOLVE_TIMEOUT_MS)}; building instead`,
            ),
          ),
        );
      } else if (hit?.failed) {
        const authNote =
          remote.name === 'eas' && isEasAuthFailureText(hit.failed)
            ? easAuthNote({ code: 'logged-out', reason: hit.failed })
            : null;
        note(
          chalk.yellow(
            phaseLine('cache', authNote || `${remote.name} could not be used: ${hit.failed}; building instead`),
          ),
        );
      } else {
        phase('cache', `remote miss (${remote.name}) ${remoteTimer()}`);
      }
    }
  }

  async function waitForSharedBuild(): Promise<boolean> {
    if (!appPath && useBuildCache) {
      let attempt: BuildLockHandle | null = null;
      try {
        attempt = d.acquireBuildLock({ platform: PLATFORM, key: cacheKey, root, logFile });
      } catch (e) {
        note(
          chalk.yellow(
            phaseLine('build', `could not take the build lock: ${(e as Error)?.message || e}; building anyway`),
          ),
        );
      }

      if (attempt?.acquired) {
        buildLock = attempt;
        if (attempt.tookOver) note(chalk.yellow(phaseLine('build', takeoverLine(attempt.tookOver))));
      } else if (attempt?.held) {
        const held = attempt.held;
        const who = held.projectRoot || 'another workspace';
        phase(
          'build',
          `${who} is already building ${shortHash(fingerprint)} (pid ${held.pid})` +
            `${held.logFile ? ` -- tail ${held.logFile}` : ''}`,
        );

        let waited: WaitForBuildResult | null = null;
        try {
          waited = await d.waitForBuild({ platform: PLATFORM, key: cacheKey, out: note });
        } catch (e) {
          const err = e as Error & { code?: string; lockPath?: string };
          if (err?.code !== 'STIM_BUILD_WAIT_TIMEOUT') throw e;
          fail({
            code: 'STIM_BUILD_WAIT_TIMEOUT',
            message: err.message,
            remedy: `Check pid ${held.pid}; if it is not really building, remove ${err.lockPath} and run \`stim ios\` again.`,
            build: { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache },
          });
          return false;
        }

        if (waited?.hit) {
          appPath = waited.hit ?? null;
          cacheHit = 'local';
          waitedForBuild = { pid: held.pid, ms: waited.waitedMs };
          phase('build', `waited ${formatDuration(waited.waitedMs)} for ${who}'s build -> installed from cache`);
        } else {
          note(
            chalk.yellow(
              phaseLine('build', `${who}'s build ended without an artifact (${waited?.builderFailed}); building here`),
            ),
          );
          try {
            const takeover = d.acquireBuildLock({ platform: PLATFORM, key: cacheKey, root, logFile });
            if (takeover?.acquired) buildLock = takeover;
          } catch {}
          note(chalk.yellow(phaseLine('build', takeoverLine(held))));
        }
      }
    }
    return true;
  }

  const prepareDeviceApp = async (path: string, { fresh }: { fresh: boolean }): Promise<string | null> => {
    const refuse = (code: string, reason: string, remedy: string): null => {
      if (fresh) {
        fail({ code, message: reason, remedy, build: { ...buildFailure, appPath: path } });
        return null;
      }
      note(chalk.yellow(phaseLine('cache', `${reason} -- building fresh instead`)));
      note(chalk.dim(phaseLine('', remedy)));
      swapFellBack = true;
      return null;
    };
    const gateProfile = (): string | null => {
      const gate = d.gateProfileForDevice({ appPath: path, udid, configuration });
      return gate.ok ? path : refuse(gate.code, gate.reason, gate.remedy);
    };

    if (release) {
      if (!fresh) {
        note(
          chalk.yellow(
            phaseLine(
              'cache',
              `a cached ${configuration} device app carries its builder's JS, and the device JS swap lands with ` +
                "phase 6 of appandflow/stim#178 -- building fresh instead, which bakes in this workspace's JS",
            ),
          ),
        );
        swapFellBack = true;
        return null;
      }
      return gateProfile();
    }

    const scheme = d.devClientScheme(root, path);
    if (scheme) return gateProfile();

    let copy: { tmpDir: string; appPath: string };
    try {
      copy = copyAppAside(path);
    } catch (e) {
      return refuse(
        'STIM_INSTALL_FAILED',
        `Could not copy ${path} aside to write its ip.txt: ${(e as Error)?.message || e}`,
        'Free space in the temporary directory and run the command again.',
      );
    }
    writeIpTxt(copy.appPath, lanAddress as string, metroPort as number);
    const sealed = d.sealAppForDevice({
      appPath: copy.appPath,
      udid,
      configuration,
      pinnedName: iosSigningIdentitySetting(settings),
      pinnedSha1: iosSigningIdentitySha1Setting(settings),
    });
    if (!sealed.ok) {
      try {
        rmSync(copy.tmpDir, { recursive: true, force: true });
      } catch {}
      for (const line of sealed.lastLines ?? []) note(chalk.dim(phaseLine('', line)));
      return refuse(sealed.code, sealed.reason, sealed.remedy);
    }
    if (swapDir) {
      try {
        rmSync(swapDir, { recursive: true, force: true });
      } catch {}
    }
    swapDir = copy.tmpDir;
    phase(
      'ip.txt',
      `${lanAddress}:${metroPort} written into the install copy and re-sealed with "${sealed.identity.name}"` +
        `${sealed.mode === 'preserve-metadata' ? '' : ` (${sealed.mode})`}`,
    );
    return copy.appPath;
  };

  const installableCachedApp = async (cachedPath: string): Promise<string | null> => {
    if (physical) return prepareDeviceApp(cachedPath, { fresh: false });
    if (!release) return cachedPath;
    phase('swap', `regenerating this workspace's JS for the cached ${configuration} app`);
    const swap = await d.swapJsBundle({ root, isExpo, cachedAppPath: cachedPath, logWriter: logWriter() });
    if (swap?.ok && swap.appPath) {
      if (swap.note) note(chalk.yellow(phaseLine('swap', swap.note)));
      swapDir = swap.tmpDir ?? null;
      phase(
        'swap',
        `${swap.hermes ? 'hermes bytecode' : 'plain JS'} + assets replaced, re-signed (${formatDuration(swap.durationMs ?? 0)})`,
      );
      return swap.appPath;
    }
    note(
      chalk.yellow(
        phaseLine(
          'swap',
          `failed at ${swap?.step || 'unknown step'}: ${swap?.reason || 'unknown reason'} -- ` +
            `building fresh instead (a cached ${configuration} app carries its builder's JS; it is never installed after a failed swap)`,
        ),
      ),
    );
    for (const line of swap?.lastLines ?? []) note(chalk.dim(phaseLine('', line)));
    swapFellBack = true;
    return null;
  };

  async function prepareCachedArtifact(): Promise<void> {
    if (appPath && cacheHit) {
      const prepared = await installableCachedApp(appPath);
      appPath = prepared;
      if (!prepared) {
        cacheHit = false;
        waitedForBuild = null;
      }
    }
  }

  async function buildArtifact(): Promise<boolean> {
    buildFailure = { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache };
    if (!appPath) {
      try {
        if (limits.maxBuilds) {
          try {
            buildSlot = await d.acquireBuildSlot({ max: limits.maxBuilds, root, logFile, out: note });
          } catch (e) {
            note(
              chalk.yellow(
                phaseLine('build', `could not take a build slot: ${(e as Error)?.message || e}; building anyway`),
              ),
            );
          }
        }

        const mutatingSteps: string[] = [];

        if (d.needsPrebuild(root, PLATFORM, isExpo)) {
          const result = await d.runPrebuild(root, PLATFORM, logWriter());
          if (result?.failed) {
            phase('prebuild', 'FAILED');
            fail({
              code: result.code || 'STIM_PREBUILD_FAILED',
              message: result.reason || 'expo prebuild failed.',
              remedy: result.remedy || `See ${logFile} for the transcript.`,
              lines: (result.lastLines || []).slice(-5),
              build: buildFailure,
            });
            return false;
          }
          phase('prebuild', `ios/ absent -> generated (${formatDuration(result?.durationMs ?? 0)})`);
          mutatingSteps.push('prebuild');
        }

        const podState = d.readPodState(root);
        const verdict = d.podsAreStale(podState.lockText, podState.manifestText);
        const action = podAction(podState, verdict);
        if (action.install) {
          const result = await d.runPodInstall(root, logWriter(), { estimateMs: estimates().podsMs });
          const podCommand = result?.command || 'pod install';
          for (const line of result?.notes || []) note(chalk.dim(phaseLine('pods', line)));
          if (result?.failed) {
            phase('pods', 'FAILED');
            fail({
              code: result.code || 'STIM_DEPS_FAILED',
              message: result.reason || '`pod install` failed.',
              remedy: result.remedy || `See ${logFile} for the transcript.`,
              lines: result.diagnosticLines?.length ? result.diagnosticLines : (result.lastLines || []).slice(-5),
              build: buildFailure,
            });
            return false;
          }
          stats.setPodsMs(result?.durationMs ?? 0);
          phase(
            'pods',
            `${action.reason} -> installed with \`${podCommand}\` (${formatDuration(result?.durationMs ?? 0)})`,
          );
          mutatingSteps.push(podCommand);
        }

        if (mutatingSteps.length) {
          const after = await refingerprintAfterMutation({
            projectRoot: root,
            platform: PLATFORM,
            previousHash: fingerprint,
            fingerprint: d.fingerprintProject,
          });
          if (!after) {
            storeHash = null;
            storeKey = null;
            buildFailure = { ...buildFailure, fingerprint: null, cacheKey: null };
            note(
              chalk.yellow(
                phaseLine(
                  'fingerprint',
                  `unavailable after ${mutatingSteps.join(', ')}; the build will be installed but not cached`,
                ),
              ),
            );
          } else if (after.moved) {
            storeHash = after.hash;
            storeSources = after.sources;
            storeKey = buildCacheKey(PLATFORM, after.hash, {
              ...(configuration ? { configuration } : {}),
              isSimulator: !physical,
            });
            note(
              chalk.dim(
                phaseLine(
                  'fingerprint',
                  `${shortHash(fingerprint)} -> ${shortHash(storeHash)} (after ${mutatingSteps.join(', ')})`,
                ),
              ),
            );

            const late = useBuildCache ? d.resolveBuild(PLATFORM, storeKey) : null;
            if (late) {
              const prepared = await installableCachedApp(late);
              if (prepared) {
                appPath = prepared;
                cacheHit = 'local';
                phase('cache', `hit ${shortHash(storeHash)} (post-${mutatingSteps.join('/')} key)`);
              }
            }
          }
        }

        if (!appPath) {
          phase('build', `compiling ${configuration || 'Debug'} with xcodebuild`);
          const result: BuildIosResultLike = await d.buildIos({
            root,
            udid,
            destination: remoteDevice ? GENERIC_SIM_DESTINATION : null,
            ...(physical ? { sdk: IPHONEOS_SDK } : {}),
            logWriter: logWriter(),
            ...(configuration ? { configuration } : {}),
            estimateMs: estimates().coldBuildMs,
          });
          if (result?.failed) {
            phase('build', `FAILED after ${formatDuration(result.durationMs)}`);
            printDiagnostics(note, result);
            const report = xcodeFailureReport(result, logFile);
            fail({
              code: result.code || 'STIM_BUILD_FAILED',
              message: report.message,
              remedy: report.remedy,
              logPath: logFile,
              build: buildFailure,
            });
            return false;
          }
          compilationCache = result.compilationCache ?? COMPILATION_CACHE_UNAVAILABLE;
          stats.setBuildMs(result.durationMs ?? 0);
          phase('build', `ok (${formatDuration(result.durationMs)})`);
          appPath = result.appPath ?? null;
          bundleId = result.bundleId ?? null;

          if (storeKey) {
            try {
              const stored = await storeTieredBuild({
                local: filesystemBuildCapability({
                  resolve: d.resolveBuild,
                  store: d.storeBuild,
                  sources: storeSources,
                }),
                loadProvider,
                target: { projectRoot: root, platform: PLATFORM, key: storeKey },
                sourcePath: appPath!,
                overwrite: !useBuildCache || swapFellBack,
                warn: cacheWarn,
              });
              providerUpload = stored.providerUpload;
              providerName = stored.providerName ?? providerName;
            } catch (e) {
              note(chalk.yellow(`Could not store the build in the shared cache: ${(e as Error)?.message || e}`));
            }
          }

          if (physical) {
            const prepared = await prepareDeviceApp(appPath!, { fresh: true });
            if (!prepared) return false;
            appPath = prepared;
          }

          if (remote && !physical && storeHash) {
            uploadPending = d.uploadRemote({
              logWriter: logWriter(),
              provider: remote.provider,
              platform: PLATFORM,
              projectRoot: root,
              fingerprintHash: storeHash,
              buildPath: appPath!,
              runOptions: configuration ? { configuration } : null,
            });
          }
        }
      } finally {
        releaseLock();
        releaseSlot();
      }
    }
    return true;
  }

  try {
    if (!(await resolveInitialFingerprint())) return null;
    await resolveRemoteArtifact();
    if (!(await waitForSharedBuild())) return null;
    await prepareCachedArtifact();
    if (!(await buildArtifact())) return null;

    if (physicalDevice) {
      const acquired = await d.acquireRunLease({
        root,
        platform: PLATFORM,
        id: physicalDevice.udid,
        deviceName: physicalDevice.name,
        idLabel: 'udid',
        waitSeconds,
        noWait,
        installBoundMs: DEVICECTL_INSTALL_TIMEOUT_MS,
        appId: bundleId ?? proj?.bundleId ?? null,
        holderAppId: (holder: string) => d.getProject(holder)?.bundleId ?? null,
        now: d.now,
        warn: (line: string) => note(chalk.yellow(phaseLine('lease', line))),
      });
      if (acquired.status === 'refused') {
        return fail({
          code: acquired.refusal.code,
          message: acquired.refusal.message,
          remedy: acquired.refusal.remedy,
          lease: acquired.refusal.lease,
        });
      }
      leaseHandle = d.runLease({
        root,
        platform: PLATFORM,
        kind: acquired.status === 'leased' ? acquired.kind : null,
        expiresAt: acquired.status === 'leased' ? acquired.expiresAt : null,
      });
      if (acquired.status === 'leased') {
        stopLeaseSignals = d.releaseLeaseOnSignal(releaseLease);
        phase(
          'lease',
          `${acquired.kind} lease on ${physicalDevice.udid} until ${leaseExpiryText(acquired.expiresAt, d.now())}`,
        );
      }
    }

    try {
      return await finishIosRun({
        d,
        root,
        json,
        release,
        configuration,
        isExpo,
        metroCheck,
        metroPort,
        logsDir,
        logFile,
        device,
        udid,
        physical,
        lanAddress,
        lanOriginUrl,
        remoteDevice,
        bootPromise,
        bootDuration: () => bootDuration,
        appPath,
        bundleId,
        swapDir,
        buildFailure,
        fail,
        phase,
        note,
        logWriter,
        uploadPending,
        providerUpload,
        providerName,
        remote,
        abandonedRemote,
        elapsed,
        startedAt,
        storeHash,
        storeKey,
        cacheHit,
        compilationCache,
        useBuildCache,
        waitedForBuild,
        closeWriter: () => writer?.close?.(),
        lease: leaseHandle,
        releaseLease,
        recordRun,
      });
    } finally {
      releaseLease();
    }
  } catch (error) {
    recordRun({ failed: true, durationMs: elapsed() });
    throw error;
  }
}

export function launchOutcomeRecord({
  launchState,
  release,
  bundleId,
  configuration,
  metroPort,
}: {
  launchState: boolean | string;
  release: boolean;
  bundleId: string | null;
  configuration: string | null;
  metroPort?: number | null;
}): Record<string, unknown> {
  const unverified = launchState === LAUNCH_UNVERIFIED;
  const bundling = launchState === LAUNCH_BUNDLING;
  let msg: string;
  if (release) {
    msg = unverified
      ? `${bundleId} could not be verified as running after its ${configuration} launch`
      : `${bundleId} is running its embedded ${configuration} bundle`;
  } else if (unverified) {
    msg = `no bundle request from ${bundleId} reached this workspace's Metro on port ${metroPort}`;
  } else if (bundling) {
    msg =
      `${bundleId} requested a bundle from this workspace's Metro on port ${metroPort}; ` +
      'it was still being built when the launch check ended';
  } else {
    msg = `${bundleId} fetched a bundle from this workspace's Metro on port ${metroPort}`;
  }
  return {
    src: 'build',
    level: unverified ? 'warn' : 'info',
    event: unverified ? 'launch_unverified' : bundling ? 'launch_bundling' : 'launch_verified',
    msg,
  };
}

export function cacheDescription(cacheHit: CacheHitLevel, providerName: string | null = null): string {
  if (cacheHit === 'remote') return `from ${providerName || 'the remote cache'}`;
  if (cacheHit === 'local') return 'from cache';
  return 'built';
}

export function xcodeFailureReport(result: BuildIosResultLike, logPath: string): { message: string; remedy: string } {
  const diagnostics = (Array.isArray(result?.diagnostics) ? result.diagnostics : []) as Diagnostic[];
  const code = result?.exitCode;
  const how = code === null || code === undefined ? '' : ` (exit code ${code})`;
  const message = diagnostics.length
    ? `\`xcodebuild\` failed${how} with ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}.`
    : `\`xcodebuild\` failed${how} with no recognizable diagnostic.`;
  const remedy = diagnostics.find((d) => d?.remedy)?.remedy || `See ${logPath} for the transcript.`;
  return { message, remedy };
}

function printDiagnostics(note: (line: string) => void, result: BuildIosResultLike) {
  const diagnostics = (Array.isArray(result?.diagnostics) ? result.diagnostics : []) as Diagnostic[];
  const shown = diagnostics.slice(0, MAX_PRINTED_DIAGNOSTICS);
  for (const diagnostic of shown) {
    note(chalk.red(phaseLine('error', describeDiagnostic(diagnostic))));
  }
  const hidden = diagnostics.length - shown.length + (result?.truncated || 0);
  if (hidden > 0) {
    note(chalk.dim(phaseLine('error', `... and ${hidden} more diagnostic${hidden === 1 ? '' : 's'} in the log`)));
  }
  if (diagnostics.length === 0) {
    note(chalk.red(phaseLine('error', 'xcodebuild failed with no recognizable diagnostic; last lines:')));
    for (const line of (result?.tail || []).slice(-5)) note(chalk.dim(phaseLine('', line)));
  }
}
