import chalk from 'chalk';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnEntry } from '../spawn-entry.ts';
import { InvalidArgumentError, type Command } from 'commander';
import {
  buildCacheKey,
  describeFingerprintMiss,
  fingerprintDiffRecord,
  fingerprintDiffSuffix,
  fingerprintProject,
  refingerprintAfterMutation,
  resolveBuild,
  storeBuild,
  untrackedMissLine,
  untrackedNativeFiles,
} from '../build-cache.ts';
import type { FingerprintSource } from '@expo/fingerprint';
import { getConcurrencyLimits, getProject, upsertProject } from '../config.ts';
import {
  DEFAULT_METRO_PORT,
  LAUNCH_BUNDLING,
  LAUNCH_UNVERIFIED,
  devClientUrl,
  installIosApp,
  launchIosApp,
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
import { checkDeviceCapacity, ensureBooted, ensureOwnedDevice } from '../engine/device.ts';
import {
  REMOTE_SESSION_ERROR,
  binOnPath,
  ensureRemoteBootOwned,
  ensureMetroReachable,
  remoteIosDeps,
  resolveRemoteContext,
} from '../engine/device-remote.ts';
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
import { swapJsBundle } from '../engine/js-swap.ts';
import { buildIos, readBundleId } from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
import type { CacheHitLevel, IosFacts, RemoteDeviceBackend } from '../types.ts';
import { NOT_OURS_FOREIGN_CWD, isPidAlive, resolveProjectMetro } from '../metro.ts';
import { createNdjsonWriter, type NdjsonWriter } from '../ndjson.ts';
import { ensureWorkspaceStorage, workspaceLogsDir } from '../paths.ts';
import { detectBundleId, detectIsExpo, findProjectRoot, isPackageResolvable, projectShortcut } from '../project.ts';
import {
  publicUrlSetting,
  REMOTE_DEVICE_BACKENDS,
  remoteDeviceSettingError,
  remoteIosSetting,
  resolveSettings,
  tunnelModeSetting,
  unknownSettingKeys,
  type SettingsObject,
} from '../settings.ts';
import { MODE_BARE, MODE_EXPO, readWorkspaceState, writeWorkspaceState } from '../supervisor/state.ts';
import { gitCommonDir, repoRoot } from '../worktree.ts';

function writeNote(line: string): void {
  console.error(line);
}

export const PLATFORM = 'ios';

// Build for the simulator platform rather than one device. Used only when the
// device is remote: see the buildIos call for why `id=<udid>` cannot work
// there.
const GENERIC_SIM_DESTINATION = 'generic/platform=iOS Simulator';

// --- local, flat shapes for engine results ---------------------------------
//
// These interfaces describe only the shape THIS file reads off the engine and
// sim results -- a deliberately local, all-optional view, looser than the
// producers' own exported types, matching the defensive reads underneath.

interface DeviceLike {
  deviceName?: string | null;
  name?: string | null;
  avdName?: string | null;
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
}

interface VerifyLaunchResultLike {
  verified?: boolean;
  skipped?: boolean;
  requested?: boolean;
  waitedMs?: number;
}

interface IosCommandOptions {
  json?: boolean;
  metroCheck?: boolean;
  buildCache?: boolean;
  configuration?: string;
  remote?: RemoteDeviceBackend;
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

export function formatDuration(ms: unknown): string {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${Math.round(total)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total - minutes * 60);
  if (seconds === 60) return `${minutes + 1}m0s`;
  return `${minutes}m${seconds}s`;
}

export function stepTimer(now: () => number = Date.now): () => string {
  const t0 = now();
  return () => `(${formatDuration(now() - t0)})`;
}

export function shortHash(hash: unknown): string {
  const text = String(hash ?? '');
  return text.length > 6 ? `${text.slice(0, 6)}..` : text;
}

export function shortUdid(udid: unknown): string {
  const text = String(udid ?? '');
  return text.length > 4 ? `${text.slice(0, 4)}..` : text;
}

export function deviceLabel(device: DeviceLike | null | undefined, udid: unknown): string {
  const name = device?.deviceName || device?.name || null;
  return name ? `${name} (${shortUdid(udid)})` : shortUdid(udid);
}

export function phaseLine(name: unknown, text: string): string {
  return `${String(name).padEnd(11)} ${text}`;
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

export const GATE_RETRY_DELAYS_MS: number[] = [3000, 7000];

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
    return 'Re-run `rn-iso ios` in a few seconds, or give the dev server longer to verify with `rn-iso start --wait <seconds>`.';
  }
  return 'Run `rn-iso start` first, or pass --no-metro-check.';
}

export async function ensureWorkspaceStorageSafely(
  root: string,
  { note = (_line: string) => {} }: { note?: (line: string) => void } = {},
): Promise<unknown> {
  try {
    return ensureWorkspaceStorage(root);
  } catch (err) {
    note(chalk.dim(`Could not prepare this workspace's rn-iso state: ${(err as Error)?.message || err}`));
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
  fingerprint,
  configuration = null,
  cacheKey,
  cacheHit,
  cacheSkipped = false,
  waitedForBuild = null,
  appPath,
  bundleId,
  metroPort,
  logsDir,
  durationMs,
  launched = true,
  webPreviewUrl = null,
}: {
  udid: string;
  deviceName?: string | null;
  fingerprint?: string | null;
  configuration?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  waitedForBuild?: WaitedForBuild | null;
  appPath?: string | null;
  bundleId?: string | null;
  metroPort?: number | null;
  logsDir?: string;
  durationMs?: number;
  launched?: boolean | string;
  webPreviewUrl?: string | null;
}): IosFacts {
  return {
    platform: PLATFORM,
    udid,
    deviceName: deviceName ?? null,
    fingerprint,
    configuration: configuration ?? null,
    cacheKey,
    cacheHit: cacheLevel(cacheHit),
    cacheSkipped: Boolean(cacheSkipped),
    waitedForBuild: waitedForBuild ? { pid: waitedForBuild.pid ?? null, ms: waitedForBuild.ms ?? 0 } : null,
    appPath,
    bundleId,
    launched: launched === LAUNCH_UNVERIFIED || launched === LAUNCH_BUNDLING ? launched : Boolean(launched),
    metroPort,
    logs: { dir: logsDir },
    durationMs,
    // Omitted entirely on a local device rather than carried as null: a key
    // that is always present invites a caller to print an empty link.
    ...(webPreviewUrl ? { webPreviewUrl } : {}),
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
  spawn?: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  readState?: typeof readWorkspaceState;
  waitMs?: number;
  note?: (line: string) => void;
}

export async function replaceCollector({
  root,
  udid,
  bundleId,
  appName,
  spawn = (cmd, args, opts) => getExecutor().spawn(cmd, args, opts),
  kill = (pid, signal) => process.kill(pid, signal),
  alive = isPidAlive,
  readState = readWorkspaceState,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  note = (_line: string) => {},
}: ReplaceCollectorArgs): Promise<{ killed: number | null; pid: number | null }> {
  const previous = (readState(root)?.collectors as Record<string, { pid?: number }> | undefined)?.[PLATFORM] || null;
  const previousPid = Number(previous?.pid) || null;
  let killed: number | null = null;

  if (previousPid) {
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
  }

  const args = [collectorEntry(), '--platform', PLATFORM, '--root', root, '--udid', udid, '--bundle', bundleId];
  if (appName) args.push('--app-name', appName);

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
  // Remote mode's two entries. Everything else in this seam is a local
  // engine call; these are what let `--remote` swap the device out.
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
  readBundleId: typeof readBundleId;
  swapJsBundle: typeof swapJsBundle;
  installIosApp: typeof installIosApp;
  launchIosApp: typeof launchIosApp;
  verifyLaunch: typeof verifyLaunch;
  verifyReleaseLaunch: typeof verifyReleaseLaunch;
  ensureWorkspaceStorage: typeof ensureWorkspaceStorageSafely;
  replaceCollector: typeof replaceCollector;
  writeWorkspaceState: typeof writeWorkspaceState;
  createWriter: typeof createNdjsonWriter;
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
  readBundleId,
  swapJsBundle,
  installIosApp,
  launchIosApp,
  verifyLaunch,
  verifyReleaseLaunch,
  ensureWorkspaceStorage: ensureWorkspaceStorageSafely,
  replaceCollector,
  writeWorkspaceState,
  createWriter: createNdjsonWriter,
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
        'simulator, wired to the reserved Metro port. Requires a running dev server (`rn-iso start`).',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--no-metro-check', 'Skip the "is this workspace\'s dev server running?" gate and build anyway')
    .option(
      '--no-build-cache',
      "Build fresh, ignoring cached artifacts (local and the project's build-cache provider); the fresh build still replaces the cache entry",
    )
    .option(
      '--configuration <name>',
      'Xcode configuration to build (e.g. Release; simulator only). A non-Debug configuration embeds the JS bundle and skips Metro entirely. Overrides the ios.configuration setting. Default: Debug',
    )
    .option(
      '--remote <backend>',
      'Install and launch on a remote device with proxy or EAS. The build still happens here.',
      (value) => {
        if ((REMOTE_DEVICE_BACKENDS as readonly string[]).includes(value)) return value as RemoteDeviceBackend;
        throw new InvalidArgumentError(`expected one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}`);
      },
    )
    .action(async (opts: IosCommandOptions) => {
      await runIos(opts, deps);
    });
}

export async function runIos(opts: IosCommandOptions = {}, overrides: Partial<IosDeps> = {}): Promise<IosFacts | null> {
  // Annotated explicitly: spreading a Partial<> over the full DEFAULT_DEPS
  // would otherwise let TS infer some properties as possibly-undefined, even
  // though every key is always present (DEFAULT_DEPS supplies every one).
  let d: typeof DEFAULT_DEPS = { ...DEFAULT_DEPS, ...overrides };
  const json = Boolean(opts.json);
  const metroCheck = opts.metroCheck !== false;
  const useBuildCache = opts.buildCache !== false;

  const phase = (name: unknown, text: string) => console.error(phaseLine(name, text));
  const note = writeNote;

  const started = d.now();
  const startedAt = new Date(started).toISOString();
  const elapsed = () => d.now() - started;

  const root = d.findProjectRoot(process.cwd());
  if (!root) {
    note(chalk.red('Not in a React Native project (no package.json found).'));
    process.exit(1);
    return null;
  }

  try {
    await d.ensureWorkspaceStorage(root, { note });
  } catch (error) {
    const code = (error as Error & { code?: string })?.code || 'RN_ISO_WORKSPACE_STATE';
    const message = `Could not prepare this workspace's rn-iso state: ${(error as Error)?.message || error}`;
    note(chalk.red(`${code}: ${message}`));
    note(chalk.dim('Check that RN_ISO_HOME is writable and has free space.'));
    if (json)
      console.log(JSON.stringify({ code, message, remedy: 'Check that RN_ISO_HOME is writable and has free space.' }));
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

  const fail = ({ code, message, remedy = null, lines = [], logPath = null, build = null }: FailArgs): null => {
    releaseLock();
    releaseSlot();
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
    if (json) console.log(JSON.stringify({ code, message: message ?? null, remedy: remedy ?? null }));
    writer?.close?.();
    process.exit(1);
    return null;
  };

  const settings = d.resolveSettings({
    projectPath: root,
    gitCommonDir: d.gitCommonDir(root),
    repoRoot: d.repoRoot(root),
  });
  for (const key of unknownSettingKeys(settings)) {
    note(chalk.yellow(`Warning: setting "${key}" is not read by rn-iso and will be ignored.`));
  }
  const remoteSettingError = remoteDeviceSettingError(settings);
  if (remoteSettingError) {
    return fail({
      code: 'RN_ISO_BAD_ARG',
      message: remoteSettingError,
      remedy: `Set ios.remote and android.remote to one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}.`,
    });
  }

  const configuration = resolveConfiguration(opts.configuration, settings);
  const release = isReleaseConfiguration(configuration);

  const isExpo = d.detectIsExpo(root);
  const remoteBackend = opts.remote ?? remoteIosSetting(settings);
  const registerProject = () => d.upsertProject(root, { bundleId: d.detectBundleId(root) ?? undefined, isExpo });
  if (remoteBackend !== 'eas') registerProject();
  const proj = d.getProject(root);
  const label = d.projectShortcut(root, proj);

  // ---- remote device: four dep overrides, or none ----
  //
  // `--remote` swaps the device out and NOTHING else. The build, the
  // fingerprint, the cache and Metro all stay exactly where they were, which
  // is why this is four entries in the dep seam rather than a second command.
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

  // ---- concurrency: opt-in, unlimited by default ----
  const limits = d.getConcurrencyLimits();

  const capacity = d.checkDeviceCapacity({
    platform: PLATFORM,
    project: proj,
    max: limits.maxDevices,
  });
  if (capacity) return fail(capacity);

  let device;
  try {
    device = await d.ensureOwnedDevice({
      platform: PLATFORM,
      project: proj,
      projectPath: root,
      label,
      settings,
      flags: {},
      note,
      out: note,
    });
  } catch (e) {
    return fail({
      code: 'RN_ISO_NO_DEVICE',
      message: `Could not ensure an owned iOS simulator: ${(e as Error)?.message || e}`,
      remedy: 'Run `rn-iso doctor` to check the simulator toolchain, then try again.',
    });
  }

  let metroPort = proj?.metroPort ?? null;
  if (release) {
    metroPort = null;
    phase('metro', `skipped (${configuration}: the JS bundle is embedded, no dev server is used)`);
  } else if (metroCheck) {
    if (!metroPort) {
      return fail({
        code: 'RN_ISO_NO_METRO',
        message: 'No Metro port is reserved for this workspace, so there is no dev server to build against.',
        remedy: 'Run `rn-iso start` first, or pass --no-metro-check.',
      });
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
      return fail({
        code: 'RN_ISO_NO_METRO',
        message: noMetroMessage({ port: metroPort, resolution, supervisor, supervisorAlive }),
        remedy: noMetroRemedy({ port: metroPort, supervisor, supervisorAlive }),
      });
    }
  } else if (!metroPort) {
    metroPort = DEFAULT_METRO_PORT;
    note(chalk.yellow(`No Metro port is reserved for this workspace; wiring the app to ${metroPort}.`));
  }

  // ---- the remote device's route to Metro, and proof of it ----
  //
  // HERE, not with the dep overrides above, and the difference is the whole
  // point: only now is the RESERVED PORT known and only now has the gate
  // above confirmed a dev server is actually on it. Resolving this earlier
  // defaulted the port to 8081 -- so a managed tunnel got built to whatever
  // happened to be on 8081, routinely a different workspace -- and reported a
  // simply-absent Metro as "serving a different dev server".
  //
  // Still before ensureBooted, which is what creates the billable session, so
  // every refusal here is free. A release build has no dev server at all
  // (metroPort is null), so there is nothing to reach and nothing to prove.
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
      return fail({
        code: reachable.code ?? REMOTE_SESSION_ERROR,
        message: reachable.failed,
        remedy: reachable.remedy,
      });
    }
  }

  // Boot is KICKED OFF here and awaited only at install: nothing in between
  // -- the fingerprint, the cache resolution, even xcodebuild (a Shutdown sim
  // is a valid -destination) -- needs a live device, and awaiting up front
  // added the whole boot ahead of a multi-minute compile for no reason. The
  // catch holds a rare boot failure until the await, where it fails with the
  // same code it always did.
  // The boot's own elapsed time, stamped the moment its promise settles: the
  // boot overlaps the build by design, so reading the clock where the await
  // happens would report the build's time, not the boot's.
  const bootTimer = stepTimer(d.now);
  let bootDuration = '';
  const boot = (): Promise<IosBootLike> =>
    Promise.resolve(d.ensureBooted({ platform: PLATFORM, device, out: note })).catch((e) => ({
      ok: false,
      reason: String((e as Error)?.message || e),
    }));
  const bootPromise: Promise<IosBootLike> = (
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
  // The build destination: the udid exists as soon as the device record does.
  // The rare record without one (legacy shapes) waits for the boot to resolve
  // it, which is exactly the old ordering.
  //
  // A REMOTE device has no udid on its record at all -- the session that
  // identifies it does not exist until ensureBooted creates it -- so this
  // await is what serialises session creation ahead of the build. That is
  // deliberate: the artifact has to be uploaded to a device that exists.
  const udid = (device.deviceUdid as string | undefined) ?? (await bootPromise)?.udid ?? '';

  const fingerprintTimer = stepTimer(d.now);
  let fingerprint: string | null;
  let fingerprintSources: FingerprintSource[] = [];
  try {
    const computed = await d.fingerprintProject(root, { platform: PLATFORM });
    fingerprint = computed?.hash ?? null;
    fingerprintSources = computed?.sources ?? [];
  } catch (e) {
    fingerprint = null;
    note(chalk.dim(`Fingerprinting failed: ${(e as Error)?.message || e}`));
  }
  if (!fingerprint) {
    return fail({
      code: 'RN_ISO_NO_FINGERPRINT',
      message: `Could not fingerprint ${root}: @expo/fingerprint produced no hash for it.`,
      remedy: 'Check the project native inputs and the @expo/fingerprint error above, then retry.',
    });
  }
  const cacheKey = buildCacheKey(PLATFORM, fingerprint, configuration ? { configuration } : {});

  let storeHash = fingerprint;
  let storeKey = cacheKey;
  let storeSources = fingerprintSources;

  const cached = useBuildCache ? d.resolveBuild(PLATFORM, cacheKey) : null;
  let cacheHit: CacheHitLevel = cached ? 'local' : false;
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

  let appPath: string | null = cached;
  let bundleId: string | null = null;

  let remote: LoadProjectProviderResult | null = null;
  let abandonedRemote = false;
  let uploadPending: Promise<RemoteUploadLike> | null = null;
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
        note(chalk.yellow(phaseLine('cache', `remote hit could not be stored locally: ${(e as Error)?.message || e}`)));
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

  let waitedForBuild: WaitedForBuild | null = null;
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
        if (err?.code !== 'RN_ISO_BUILD_WAIT_TIMEOUT') throw e;
        return fail({
          code: 'RN_ISO_BUILD_WAIT_TIMEOUT',
          message: err.message,
          remedy: `Check pid ${held.pid}; if it is not really building, remove ${err.lockPath} and run \`rn-iso ios\` again.`,
          build: { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache },
        });
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

  let swapDir: string | null = null;
  const installableCachedApp = async (cachedPath: string): Promise<string | null> => {
    if (!release) return cachedPath;
    phase('js swap', `regenerating this workspace's JS for the cached ${configuration} app`);
    const swap = await d.swapJsBundle({ root, isExpo, cachedAppPath: cachedPath, logWriter: logWriter() });
    if (swap?.ok && swap.appPath) {
      if (swap.note) note(chalk.yellow(phaseLine('js swap', swap.note)));
      swapDir = swap.tmpDir ?? null;
      phase(
        'js swap',
        `${swap.hermes ? 'hermes bytecode' : 'plain JS'} + assets replaced, re-signed (${formatDuration(swap.durationMs ?? 0)})`,
      );
      return swap.appPath;
    }
    note(
      chalk.yellow(
        phaseLine(
          'js swap',
          `failed at ${swap?.step || 'unknown step'}: ${swap?.reason || 'unknown reason'} -- ` +
            `building fresh instead (a cached ${configuration} app carries its builder's JS; it is never installed after a failed swap)`,
        ),
      ),
    );
    for (const line of swap?.lastLines ?? []) note(chalk.dim(phaseLine('', line)));
    return null;
  };

  if (appPath && cacheHit) {
    const prepared = await installableCachedApp(appPath);
    appPath = prepared;
    if (!prepared) {
      cacheHit = false;
      waitedForBuild = null;
    }
  }

  const buildFailure = { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache };

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
          return fail({
            code: result.code || 'RN_ISO_PREBUILD_FAILED',
            message: result.reason || 'expo prebuild failed.',
            remedy: result.remedy || `See ${logFile} for the transcript.`,
            lines: (result.lastLines || []).slice(-5),
            build: buildFailure,
          });
        }
        phase('prebuild', `ios/ absent -> generated (${formatDuration(result?.durationMs ?? 0)})`);
        mutatingSteps.push('prebuild');
      }

      const podState = d.readPodState(root);
      const verdict = d.podsAreStale(podState.lockText, podState.manifestText);
      const action = podAction(podState, verdict);
      if (action.install) {
        const result = await d.runPodInstall(root, logWriter());
        if (result?.failed) {
          phase('pods', 'FAILED');
          return fail({
            code: result.code || 'RN_ISO_DEPS_FAILED',
            message: result.reason || '`pod install` failed.',
            remedy: result.remedy || `See ${logFile} for the transcript.`,
            lines: result.diagnosticLines?.length ? result.diagnosticLines : (result.lastLines || []).slice(-5),
            build: buildFailure,
          });
        }
        phase('pods', `${action.reason} -> installed (${formatDuration(result?.durationMs ?? 0)})`);
        mutatingSteps.push('pod install');
      }

      if (mutatingSteps.length) {
        const after = await refingerprintAfterMutation({
          projectRoot: root,
          platform: PLATFORM,
          previousHash: fingerprint,
          fingerprint: d.fingerprintProject,
        });
        if (after?.moved) {
          storeHash = after.hash;
          storeSources = after.sources;
          storeKey = buildCacheKey(PLATFORM, after.hash, configuration ? { configuration } : {});
          note(
            chalk.dim(
              phaseLine(
                'fingerprint',
                `${shortHash(fingerprint)} -> ${shortHash(storeHash)} after ${mutatingSteps.join(' + ')}; ` +
                  'storing under the new key, which is the one the next run looks up',
              ),
            ),
          );

          const late = useBuildCache ? d.resolveBuild(PLATFORM, storeKey) : null;
          if (late) {
            const prepared = await installableCachedApp(late);
            if (prepared) {
              appPath = prepared;
              cacheHit = 'local';
              phase(
                'cache',
                `hit under the post-${mutatingSteps.join('/')} key (this tree was cold, so the first lookup could not find it)`,
              );
            }
          }
        }
      }

      if (!appPath) {
        const result: BuildIosResultLike = await d.buildIos({
          root,
          udid,
          destination: remoteDevice ? GENERIC_SIM_DESTINATION : null,
          logWriter: logWriter(),
          ...(configuration ? { configuration } : {}),
        });
        if (result?.failed) {
          phase('build', `FAILED after ${formatDuration(result.durationMs)}`);
          printDiagnostics(note, result);
          const report = xcodeFailureReport(result, logFile);
          return fail({
            code: result.code || 'RN_ISO_BUILD_FAILED',
            message: report.message,
            remedy: report.remedy,
            logPath: logFile,
            build: buildFailure,
          });
        }
        phase('build', `ok (${formatDuration(result.durationMs)})`);
        appPath = result.appPath ?? null;
        bundleId = result.bundleId ?? null;

        try {
          d.storeBuild(PLATFORM, storeKey, appPath!, { overwrite: !useBuildCache, sources: storeSources });
        } catch (e) {
          note(chalk.yellow(`Could not store the build in the shared cache: ${(e as Error)?.message || e}`));
        }

        if (remote) {
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

  if (appPath && !bundleId) {
    bundleId = d.readBundleId(appPath) || d.detectBundleId(root);
    if (!bundleId) {
      return fail({
        code: 'RN_ISO_INSTALL_FAILED',
        message: `Could not read a bundle identifier from the cached app at ${appPath}.`,
        remedy: 'Remove the cache entry (`rn-iso gc`) and run again to rebuild it.',
        build: { ...buildFailure, appPath },
      });
    }
  }

  if (bundleId) d.upsertProject(root, { bundleId });

  const booted = await bootPromise;
  if (!booted?.ok) {
    return fail({
      code: booted?.code || 'RN_ISO_NO_DEVICE',
      message: booted?.reason || 'The owned simulator could not be booted.',
      remedy: booted?.remedy || 'Run `rn-iso ios` again to re-establish an owned simulator for this workspace.',
    });
  }
  phase('device', `${deviceLabel(device, udid)} booted ${bootDuration}`);

  const installTimer = stepTimer(d.now);
  const installed = d.installIosApp({ udid, appPath: appPath! });
  if (installed?.failed) {
    return fail({
      code: installed.code || 'RN_ISO_INSTALL_FAILED',
      message: installed.reason,
      remedy: 'Check that the simulator is booted and that the app was built for the simulator SDK.',
      build: { ...buildFailure, appPath, bundleId },
    });
  }
  phase('install', `-> ${deviceLabel(device, udid)} ${installTimer()}`);

  if (swapDir) {
    try {
      rmSync(swapDir, { recursive: true, force: true });
    } catch {}
  }

  const scheme = release ? undefined : d.devClientScheme(root, appPath);
  const launchTimer = stepTimer(d.now);
  const launchedAt = d.now();
  const launched = d.launchIosApp({
    udid,
    bundleId: bundleId!,
    metroPort,
    devClientScheme: scheme,
  });
  if (launched?.failed) {
    return fail({
      code: launched.code || 'RN_ISO_LAUNCH_FAILED',
      message: launched.reason,
      remedy: `Run \`xcrun simctl launch --console ${udid} ${bundleId}\` to see what the app reports, and check ${logFile}.`,
      build: { ...buildFailure, appPath, bundleId },
    });
  }
  phase('launch', `${bundleId!} ${launchTimer()}`);

  logWriter().write({
    src: 'build',
    level: 'info',
    marker: true,
    event: 'launch',
    msg: release
      ? `launched ${bundleId} on ${udid} (${configuration}, embedded JS bundle, no Metro)`
      : `launched ${bundleId} on ${udid} against Metro port ${metroPort}` +
        (launched?.mode === 'openurl' ? ' (expo-dev-client)' : ''),
  });

  await d.replaceCollector({
    root,
    udid,
    bundleId: bundleId!,
    appName: appNameFromPath(appPath),
    note,
  });

  let launchState: boolean | string = true;
  if (release) {
    // A release app fetches nothing from Metro -- its bundle is embedded --
    // so the bundle-request proof does not exist. What can be proven is that
    // the launched PROCESS is still alive a moment later: a bad embedded
    // bundle takes the app down within a second or two of launch.
    const processCheck = await d.verifyReleaseLaunch({ pid: launched?.pid ?? null });
    if (processCheck?.verified) {
      phase(
        'verify',
        `process alive ${formatDuration(processCheck.waitedMs ?? 0)} after launch (${configuration}: no bundle fetch to observe)`,
      );
    } else {
      launchState = LAUNCH_UNVERIFIED;
      phase(
        'verify',
        chalk.yellow(
          processCheck?.reason === 'exited'
            ? `UNVERIFIED: the app process exited within ${formatDuration(processCheck.waitedMs ?? 0)} of launch`
            : 'UNVERIFIED: simctl launch reported no process id to check',
        ),
      );
      note(
        chalk.yellow(
          phaseLine(
            '',
            'A release app that dies at startup usually crashed loading its embedded bundle; `rn-iso logs --errors` has the device log that says why.',
          ),
        ),
      );
    }
  } else {
    const verification: VerifyLaunchResultLike = metroCheck
      ? await d.verifyLaunch({ logsDir, since: launchedAt, metroPort, mode: isExpo ? MODE_EXPO : MODE_BARE })
      : { verified: false, skipped: true };
    if (verification?.verified) {
      phase('verify', `bundle requested from Metro port ${metroPort} (${formatDuration(verification.waitedMs ?? 0)})`);
    } else if (verification?.skipped) {
      launchState = LAUNCH_UNVERIFIED;
      phase('verify', 'skipped (--no-metro-check): the launch is reported as unverified');
    } else if (verification?.requested) {
      launchState = LAUNCH_BUNDLING;
      phase(
        'verify',
        `BUNDLING: the app asked port ${metroPort} for its bundle and Metro was still building it ` +
          `after ${formatDuration(verification.waitedMs ?? 0)} (a cold bundle on a large graph outlasts this window)`,
      );
      note(
        chalk.dim(
          phaseLine(
            '',
            'Nothing to do: `rn-iso logs --source metro` shows the build finishing, usually within a minute.',
          ),
        ),
      );
    } else {
      launchState = LAUNCH_UNVERIFIED;
      const lines = unverifiedLaunchLines({
        platform: PLATFORM,
        metroPort: metroPort ?? DEFAULT_METRO_PORT,
        waitedMs: verification?.waitedMs,
        bundleId,
        udid,
        devClientUrl: scheme ? devClientUrl(scheme, metroPort ?? DEFAULT_METRO_PORT) : null,
        mode: isExpo ? MODE_EXPO : MODE_BARE,
        remote: Boolean(remoteDevice),
        // What the app was ACTUALLY pointed at. On a remote device that is not
        // localhost, and printing localhost sends the reader looking in the
        // wrong place.
        metroOrigin: typeof launched?.jsLocation === 'string' ? launched.jsLocation : null,
      });
      phase('verify', chalk.yellow("UNVERIFIED: no bundle request reached this workspace's Metro"));
      for (const line of lines) note(chalk.yellow(phaseLine('', line)));
    }
  }

  logWriter().write(launchOutcomeRecord({ launchState, release, bundleId, configuration, metroPort }));

  if (uploadPending) {
    const upload = await uploadPending;
    if (upload?.uploaded) {
      phase('cache', `uploaded (${remote?.name})`);
    } else if (upload?.timedOut) {
      abandonedRemote = true;
      note(
        chalk.yellow(
          phaseLine(
            'cache',
            `${remote?.name} upload still running after ${formatDuration(UPLOAD_TIMEOUT_MS)}; not waiting`,
          ),
        ),
      );
    } else if (upload?.failed) {
      const authNote =
        remote?.name === 'eas' && isEasAuthFailureText(upload.failed)
          ? easAuthNote({ code: 'logged-out', reason: upload.failed, phase: 'upload' })
          : null;
      note(chalk.yellow(phaseLine('cache', authNote || `${remote?.name} upload failed: ${upload.failed}`)));
    }
  }

  const durationMs = elapsed();
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

  writer?.close?.();

  const facts = iosFacts({
    udid,
    deviceName: device?.deviceName ?? null,
    fingerprint: storeHash,
    configuration,
    cacheKey: storeKey,
    cacheHit,
    cacheSkipped: !useBuildCache,
    waitedForBuild,
    appPath,
    bundleId,
    metroPort,
    logsDir,
    durationMs,
    launched: launchState,
    webPreviewUrl: remoteDevice?.webPreviewUrl() ?? null,
  });

  if (json) {
    console.log(JSON.stringify(facts));
  } else {
    const summary =
      `OK: ${bundleId} on ${deviceLabel(device, udid)}, ` +
      (release ? `${configuration} (embedded JS, no Metro)` : `Metro port ${metroPort}`) +
      ` (${cacheDescription(cacheHit, remote?.name)}, ${formatDuration(durationMs)})`;
    console.log(
      launchState === LAUNCH_UNVERIFIED
        ? chalk.yellow(`${summary} -- launch UNVERIFIED`)
        : launchState === LAUNCH_BUNDLING
          ? chalk.green(`${summary} -- bundle requested, still building`)
          : chalk.green(summary),
    );
    // Repeated after the outcome, not only when the session was created: by
    // now a build may have scrolled the earlier line away, and this is the
    // only way a person can look at a device in a datacenter.
    if (facts.webPreviewUrl) console.error(chalk.dim(`Watch this device: ${facts.webPreviewUrl}`));
  }

  if (abandonedRemote) exitAfterFlush(0);
  return facts;
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
