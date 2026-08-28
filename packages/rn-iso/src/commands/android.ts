import chalk from 'chalk';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { spawnEntry } from '../spawn-entry.ts';
import { InvalidArgumentError, type Command } from 'commander';
import type { AndroidFacts, RemoteDeviceBackend, SettingsObject, WaitedForBuild } from '../types.ts';
import { formatDuration, phaseLine, shortHash } from '../command-output.ts';
import { getConcurrencyLimits, getProject, upsertProject } from '../config.ts';
import { getExecutor } from '../exec.ts';
import {
  buildCacheKey,
  describeFingerprintMiss,
  fingerprintDiffRecord,
  fingerprintDiffSuffix,
  fingerprintProject,
  refingerprintAfterMutation,
  resolveBuild,
  storeBuild,
  storedAssetManifest,
  untrackedMissLine,
  untrackedNativeFiles,
} from '../build-cache.ts';
import type { FingerprintSource } from '@expo/fingerprint';
import {
  acquireBuildLock,
  releaseBuildLock,
  takeoverLine,
  waitForBuild as waitForOtherBuild,
  type BuildLockHandle,
  type WaitForBuildResult,
} from '../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot, type BuildSlotHandle } from '../engine/build-slots.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { isPidAlive, resolveProjectMetro } from '../metro.ts';
import { emulatorLogFile, workspaceLogsDir } from '../paths.ts';
import { detectAndroidPackage, detectBundleId, detectIsExpo, findProjectRoot, projectShortcut } from '../project.ts';
import {
  devClientScheme as configuredDevClientScheme,
  ensureWorkspaceStorageSafely,
  launchOutcomeRecord,
  noMetroMessage,
  noMetroRemedy,
  pickDevClientScheme,
  resolveMetroWithRetry,
  stepTimer,
} from './ios.ts';
import {
  REMOTE_DEVICE_BACKENDS,
  publicUrlSetting,
  remoteAndroidSetting,
  remoteDeviceSettingError,
  resolveSettings,
  tunnelModeSetting,
} from '../settings.ts';
import { gitCommonDir, repoRoot } from '../worktree.ts';
import { readCollectors } from '../collector/state.ts';
import { MODE_BARE, MODE_EXPO, readWorkspaceState, writeWorkspaceState } from '../supervisor/state.ts';
import {
  DEFAULT_METRO_PORT,
  LAUNCH_BUNDLING,
  LAUNCH_UNVERIFIED,
  androidDevClientUrl,
  installAndroidApp,
  launchAndroidApp,
  launchAndroidReleaseApp,
  unverifiedLaunchLines,
  verifyAndroidReleaseLaunch,
  verifyLaunch,
} from '../engine/app-install.ts';
import { androidHome, emulatorFailureRemedy, extractEmulatorFailure, findBuildTool } from '../sim/android.ts';
import { checkDeviceCapacity, ensureBooted, ensureOwnedDevice } from '../engine/device.ts';
import {
  REMOTE_SESSION_ERROR,
  binOnPath,
  ensureRemoteBootOwned,
  ensureMetroReachable as ensureRemoteMetroReachable,
  remoteAndroidDeps,
  resolveRemoteContext,
} from '../engine/device-remote.ts';
import { detectProviders } from '../engine/metro-reach.ts';
import { ownedSessionName } from '../engine/eas-simulator.ts';
import type { OwnedDeviceRecord } from '../engine/device.ts';
import { needsPrebuild, runPrebuild } from '../engine/prebuild.ts';
import { buildAndroid } from '../engine/gradle.ts';
import { resolveKeystore, swapApkBundle } from '../engine/apk-swap.ts';
import { captureAssetManifest } from '../engine/asset-manifest.ts';
import {
  RESOLVE_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  cacheLevel,
  exitAfterFlush,
  checkEasAuth,
  resolveEasCliBin,
  easAuthNote,
  isEasAuthFailureText,
  loadProjectProvider,
  resolveRemote,
  uploadRemote,
  type LoadProjectProviderResult,
} from '../engine/remote-cache.ts';
import { formatDiagnostic, type Diagnostic } from '../engine/errors-gradle.ts';

export { formatDuration, phaseLine, shortHash } from '../command-output.ts';

export const PLATFORM = 'android';

export function androidVariantSetting(settings: SettingsObject | null | undefined): string | null {
  const android = settings?.['android'];
  if (!android || typeof android !== 'object' || Array.isArray(android)) return null;
  const raw = (android as Record<string, unknown>)['variant'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function resolveVariant(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || androidVariantSetting(settings);
}

export function isReleaseVariant(variant: string | null | undefined): boolean {
  return typeof variant === 'string' && /release$/i.test(variant.trim());
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

interface PrebuildResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  lastLines?: string[];
  durationMs?: number;
}

interface BuildAndroidResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
  diagnostics?: Diagnostic[];
  truncated?: number;
  lastLines?: string[];
  durationMs?: number;
  apkPath?: string;
  apkNote?: string | null;
}

interface InstallResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  note?: string;
}

interface LaunchResultLike {
  failed?: boolean;
  code?: string;
  reason?: string;
  mode?: string;
  component?: string;
  devClientNote?: string | null;
  devClientUrl?: string;
  reversed?: string[];
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
}

interface VerifyLaunchResultLike {
  verified?: boolean;
  skipped?: boolean;
  requested?: boolean;
  waitedMs?: number;
}

interface AndroidCommandOptions {
  json?: boolean;
  metroCheck?: boolean;
  buildCache?: boolean;
  variant?: string;
  remote?: RemoteDeviceBackend;
}

interface FailExtra {
  lastBuildStatus?: boolean;
  diagnostics?: string[];
  lines?: string[];
  logPath?: string | null;
}

interface AndroidRecord {
  fingerprint?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  appPath?: string | null;
  bundleId?: string | null;
  avdName?: string | null;
  deviceName?: string | null;
}

export const NO_METRO = 'RN_ISO_NO_METRO';
export const NO_FINGERPRINT = 'RN_ISO_NO_FINGERPRINT';
export const NO_DEVICE = 'RN_ISO_NO_DEVICE';
export const INSTALL_FAILED = 'RN_ISO_INSTALL_FAILED';
export const LAUNCH_FAILED = 'RN_ISO_LAUNCH_FAILED';

const FALLBACK_LINES = 5;

interface XmlNode {
  tag: string;
  attrs: Record<string, string | null>;
  children: XmlNode[];
  indent: number;
}

interface AaptTool {
  path: string;
  tool: string;
  version: string;
}

export function findAapt(
  home: string = androidHome(),
  {
    readDir = readdirSync,
    exists = existsSync,
  }: { readDir?: (path: string) => string[]; exists?: (path: string) => boolean } = {},
): AaptTool | null {
  const found = findBuildTool(['aapt', 'aapt2'], { home, readDir, exists });
  return found ? { path: found.path, tool: found.tool, version: found.version } : null;
}

export function dumpApkManifest(
  apkPath: unknown,
  { exec = null, aapt = null }: { exec?: import('../exec.ts').Executor | null; aapt?: AaptTool | null } = {},
): string | null {
  if (typeof apkPath !== 'string' || apkPath.trim() === '') return null;
  const tool = aapt || findAapt();
  if (!tool) return null;
  const e = exec || getExecutor();
  const args =
    tool.tool === 'aapt2'
      ? ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apkPath]
      : ['dump', 'xmltree', apkPath, 'AndroidManifest.xml'];
  try {
    const out = e.runFile(tool.path, args);
    return typeof out === 'string' && out.includes('E: manifest') ? out : null;
  } catch {
    return null;
  }
}

export function parseXmltree(text: unknown): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], indent: -1 };
  const stack: XmlNode[] = [root];
  for (const raw of String(text ?? '').split('\n')) {
    const indent = raw.search(/\S/);
    if (indent < 0) continue;
    const line = raw.trim();
    const element = /^E: ([\w.:-]+)/.exec(line);
    if (element) {
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const node: XmlNode = { tag: element[1]!, attrs: {}, children: [], indent };
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
      continue;
    }
    const attr = /^A: ([^(=]+?)(?:\(0x[0-9a-f]+\))?=(.*)$/.exec(line);
    if (attr && stack.length > 1) {
      const name = attr[1]!.replace(/^http:\/\/schemas\.android\.com\/apk\/res\/android:/, 'android:');
      const value = /^"((?:[^"\\]|\\.)*)"/.exec(attr[2]!);
      stack[stack.length - 1]!.attrs[name] = value ? value[1]! : null;
    }
  }
  return root;
}

function eachNode(node: XmlNode, fn: (node: XmlNode) => void): void {
  fn(node);
  for (const child of node.children) eachNode(child, fn);
}

interface ApkDevClientFacts {
  devClient: boolean;
  schemes: string[];
}

export function apkPackage(text: unknown): string | null {
  const root = parseXmltree(text);
  const manifest = root.children.find((c) => c.tag === 'manifest');
  const pkg = manifest?.attrs['package'];
  return typeof pkg === 'string' && pkg.trim() ? pkg.trim() : null;
}

export function apkDevClientFacts(text: unknown): ApkDevClientFacts {
  const root = parseXmltree(text);
  const facts: ApkDevClientFacts = { devClient: false, schemes: [] };
  let launchable: XmlNode | null = null;
  eachNode(root, (node) => {
    const name = node.attrs['android:name'];
    if (typeof name === 'string' && name.startsWith('expo.modules.devlauncher')) facts.devClient = true;
    if (node.tag !== 'activity' && node.tag !== 'activity-alias') return;
    const filters = node.children.filter((c) => c.tag === 'intent-filter');
    const isLauncher = filters.some((f) =>
      f.children.some((c) => c.tag === 'action' && c.attrs['android:name'] === 'android.intent.action.MAIN'),
    );
    if (!isLauncher || launchable) return;
    launchable = node;
    for (const filter of filters) {
      for (const data of filter.children) {
        if (data.tag !== 'data') continue;
        const scheme = data.attrs['android:scheme'];
        if (typeof scheme === 'string' && scheme.trim()) facts.schemes.push(scheme.trim());
      }
    }
  });
  return facts;
}

export function androidDevClientScheme(
  root: string,
  apkPath: unknown,
  {
    exec = null,
    dump = dumpApkManifest,
    aapt = null,
  }: { exec?: import('../exec.ts').Executor | null; dump?: typeof dumpApkManifest; aapt?: AaptTool | null } = {},
): string | null | undefined {
  const text = dump(apkPath, { exec, aapt });
  if (text) {
    const facts = apkDevClientFacts(text);
    if (!facts.devClient) return undefined;
    const scheme = pickDevClientScheme(facts.schemes);
    if (scheme) return scheme;
  }
  return configuredDevClientScheme(root, null);
}

export function collectorEntry(): string {
  return spawnEntry('collector-run');
}

export function collectorLogFile(root: string): string {
  return join(workspaceLogsDir(root), `collector-${PLATFORM}.log`);
}

const EMULATOR_LOG_TAIL_LINES = 400;

export function noDeviceDiagnostic({
  reason,
  logFile,
  remedy,
  readLog = readEmulatorLogTail,
}: {
  reason: string;
  logFile: string;
  remedy: string;
  readLog?: (file: string) => string;
}): { message: string; remedy: string; lines: string[]; logPath: string | null } {
  const text = readLog(logFile);
  const logPath = text.trim() ? logFile : null;
  const found = extractEmulatorFailure(text);
  if (found.length === 0) return { message: reason, remedy, lines: [], logPath };
  return {
    message: `${reason} The emulator reported: ${found[0]}`,
    remedy: emulatorFailureRemedy(found),
    lines: found.slice(1),
    logPath,
  };
}

function readEmulatorLogTail(file: string): string {
  try {
    return readFileSync(file, 'utf-8').split('\n').slice(-EMULATOR_LOG_TAIL_LINES).join('\n');
  } catch {
    return '';
  }
}

export function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

export function androidFacts({
  serial,
  avdName = null,
  deviceName = null,
  fingerprint,
  cacheKey = null,
  variant = null,
  metroPort = null,
  cacheHit,
  cacheSkipped = false,
  waitedForBuild = null,
  appPath,
  bundleId,
  launched,
  logs,
  debugHttpHost = null,
  debugHttpHostNote = null,
  devClientUrl = null,
}: {
  serial?: string | null;
  avdName?: string | null;
  deviceName?: string | null;
  fingerprint?: string | null;
  cacheKey?: string | null;
  variant?: string | null;
  metroPort?: number | null;
  cacheHit?: boolean | string;
  cacheSkipped?: boolean;
  waitedForBuild?: WaitedForBuild | null;
  appPath?: string | null;
  bundleId?: string | null;
  launched?: boolean | string;
  logs?: string | null;
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
  devClientUrl?: string | null;
}): AndroidFacts {
  return {
    platform: PLATFORM,
    serial: serial ?? null,
    avdName: avdName ?? null,
    deviceName: deviceName ?? avdName ?? null,
    fingerprint: fingerprint ?? null,
    cacheKey: cacheKey ?? null,
    variant: variant ?? null,
    metroPort: metroPort ?? null,
    cacheHit: cacheLevel(cacheHit),
    cacheSkipped: Boolean(cacheSkipped),
    waitedForBuild: waitedForBuild ? { pid: waitedForBuild.pid ?? null, ms: waitedForBuild.ms ?? 0 } : null,
    appPath: appPath ?? null,
    bundleId: bundleId ?? null,
    launched: launched === LAUNCH_UNVERIFIED || launched === LAUNCH_BUNDLING ? launched : Boolean(launched),
    debugHttpHost: debugHttpHost ?? null,
    debugHttpHostNote: debugHttpHostNote ?? null,
    devClientUrl: devClientUrl ?? null,
    logs: logs ?? null,
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

const COLLECTOR_EXIT_WAIT_MS = 2000;
const COLLECTOR_POLL_MS = 25;

export function killPreviousCollector(
  root: string,
  {
    platform = PLATFORM,
    kill = (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
    collectors = null,
  }: {
    platform?: string;
    kill?: (pid: number, signal: NodeJS.Signals) => boolean;
    collectors?: Record<string, { pid?: number }> | null;
  } = {},
): number | null {
  const record = (collectors ?? readCollectors(root))?.[platform] as { pid?: number } | undefined;
  const pid = Number(record?.pid);
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    kill(pid, 'SIGTERM');
    return pid;
  } catch {
    return null;
  }
}

export default function androidCommand(program: Command): void {
  registerAndroid(program);
}

export function registerAndroid(program: Command): void {
  program
    .command('android')
    .description(
      "Build (or install from the shared cache), install and launch this workspace's Android app on its owned " +
        'emulator, wired to the reserved Metro port. Never starts the bundler -- run `rn-iso start` first.',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option(
      '--no-metro-check',
      'Skip the reserved-port Metro health check (the app will load no bundle unless something else serves it)',
    )
    .option(
      '--no-build-cache',
      "Build fresh, ignoring cached artifacts (local and the project's build-cache provider); the fresh build still replaces the cache entry",
    )
    .option(
      '--variant <name>',
      'Gradle variant to assemble and install (e.g. productionDebug on a flavored project); overrides the android.variant setting. A variant ending in Release embeds the JS bundle and skips Metro entirely. Default: debug',
    )
    .option(
      '--remote <backend>',
      'Install and launch on a remote device with proxy or EAS. The build still happens here.',
      (value) => {
        if ((REMOTE_DEVICE_BACKENDS as readonly string[]).includes(value)) return value as RemoteDeviceBackend;
        throw new InvalidArgumentError(`expected one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}`);
      },
    )
    .action(async (opts: AndroidCommandOptions) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
        return;
      }
      const result = await runAndroid({
        root,
        json: Boolean(opts.json),
        metroCheck: opts.metroCheck !== false,
        useBuildCache: opts.buildCache !== false,
        variant: opts.variant ?? null,
        remoteDevice: opts.remote ?? null,
      });
      if (!result.ok) process.exit(1);
    });
}

interface RunAndroidOptions {
  root: string;
  json?: boolean;
  metroCheck?: boolean;
  useBuildCache?: boolean;
  variant?: string | null;
  readApkPackage?: (apkPath: string | null) => string | null;
  remoteDevice?: RemoteDeviceBackend | null;
  resolveSettingsFor?: typeof resolveSettings;
  resolveRemoteDeviceContext?: typeof resolveRemoteContext;
  remoteDeviceDeps?: typeof remoteAndroidDeps;
  resolveEasBin?: typeof resolveEasCliBin;
  ensureMetroReachable?: typeof ensureRemoteMetroReachable;
  ensureRemoteBootOwned?: typeof ensureRemoteBootOwned;
  detectRemoteProviders?: typeof detectProviders;
  getLimits?: typeof getConcurrencyLimits;
  checkCapacity?: typeof checkDeviceCapacity;
  acquireSlot?: typeof acquireBuildSlot;
  releaseSlot?: typeof releaseBuildSlot;
  ensureDevice?: typeof ensureOwnedDevice;
  ensureDeviceBooted?: typeof ensureBooted;
  resolveMetro?: typeof resolveProjectMetro;
  resolveMetroRetrying?: typeof resolveMetroWithRetry;
  readState?: typeof readWorkspaceState;
  pidAlive?: typeof isPidAlive;
  verifyLaunched?: typeof verifyLaunch;
  ensureStorage?: typeof ensureWorkspaceStorageSafely;
  fingerprint?: typeof fingerprintProject;
  untracked?: typeof untrackedNativeFiles;
  resolveCached?: typeof resolveBuild;
  storeCached?: typeof storeBuild;
  storedAssets?: typeof storedAssetManifest;
  captureAssets?: typeof captureAssetManifest;
  acquireLock?: typeof acquireBuildLock;
  releaseLock?: typeof releaseBuildLock;
  waitForBuild?: typeof waitForOtherBuild;
  loadProvider?: typeof loadProjectProvider;
  easAuth?: typeof checkEasAuth;
  resolveRemoteBuild?: typeof resolveRemote;
  uploadRemoteBuild?: typeof uploadRemote;
  needsPrebuildFor?: typeof needsPrebuild;
  prebuild?: typeof runPrebuild;
  build?: typeof buildAndroid;
  install?: typeof installAndroidApp;
  launch?: typeof launchAndroidApp;
  launchRelease?: typeof launchAndroidReleaseApp;
  verifyReleaseLaunched?: typeof verifyAndroidReleaseLaunch;
  swapApk?: typeof swapApkBundle;
  resolveDevClientScheme?: typeof androidDevClientScheme;
  spawn?: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  createWriter?: typeof createNdjsonWriter;
  writeState?: typeof writeWorkspaceState;
  now?: () => number;
  out?: (line: string) => void;
  emit?: (line: string) => void;
}

interface RunAndroidResult {
  ok: boolean;
  error?: { code?: string; message?: string | null; remedy?: string | null };
  facts?: AndroidFacts;
}

interface AndroidBootLike {
  ok?: boolean;
  failed?: boolean;
  serial?: string;
  reason?: string;
  code?: string;
  remedy?: string;
}

type AndroidWriter = ReturnType<typeof createNdjsonWriter>;

interface VerifyAndroidRunArgs {
  release: boolean;
  remoteRelease: boolean;
  verifyReleaseLaunched: typeof verifyAndroidReleaseLaunch;
  verifyLaunched: typeof verifyLaunch;
  serial: string;
  androidPackage: string;
  variant: string | null;
  metroCheck: boolean;
  logsDir: string;
  launchedAt: number;
  metroPort: number | null;
  isExpo: boolean;
  scheme?: string | null;
  phase: (label: unknown, text: string) => void;
}

async function verifyAndroidRun({
  release,
  remoteRelease,
  verifyReleaseLaunched,
  verifyLaunched,
  serial,
  androidPackage,
  variant,
  metroCheck,
  logsDir,
  launchedAt,
  metroPort,
  isExpo,
  scheme,
  phase,
}: VerifyAndroidRunArgs): Promise<boolean | string> {
  if (remoteRelease) {
    phase('verify', chalk.yellow('UNVERIFIED: remote adapter launch accepted; process verification is unavailable'));
    return LAUNCH_UNVERIFIED;
  }
  if (release) {
    const processCheck = await verifyReleaseLaunched({ serial, packageName: androidPackage });
    if (processCheck?.verified) {
      phase(
        'verify',
        `process alive ${formatDuration(processCheck.waitedMs ?? 0)} after launch (${variant}: no bundle fetch to observe)`,
      );
      return true;
    }
    phase(
      'verify',
      chalk.yellow(
        `UNVERIFIED: no ${androidPackage} process on ${serial} ${formatDuration(processCheck?.waitedMs ?? 0)} after launch`,
      ),
    );
    phase(
      '',
      chalk.yellow(
        'A release app that dies at startup usually crashed loading its embedded bundle; `rn-iso logs --errors` has the device log that says why.',
      ),
    );
    return LAUNCH_UNVERIFIED;
  }

  const verification: VerifyLaunchResultLike = metroCheck
    ? await verifyLaunched({ logsDir, since: launchedAt, metroPort, mode: isExpo ? MODE_EXPO : MODE_BARE })
    : { verified: false, skipped: true };
  if (verification?.verified) {
    phase('verify', `bundle requested from Metro port ${metroPort} (${formatDuration(verification.waitedMs ?? 0)})`);
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
    phase(
      '',
      chalk.dim('Nothing to do: `rn-iso logs --source metro` shows the build finishing, usually within a minute.'),
    );
    return LAUNCH_BUNDLING;
  }

  phase('verify', chalk.yellow("UNVERIFIED: no bundle request reached this workspace's Metro"));
  for (const line of unverifiedLaunchLines({
    platform: PLATFORM,
    metroPort: metroPort ?? DEFAULT_METRO_PORT,
    waitedMs: verification?.waitedMs,
    bundleId: androidPackage,
    serial,
    devClientUrl: scheme ? androidDevClientUrl(scheme, metroPort ?? DEFAULT_METRO_PORT) : null,
    mode: isExpo ? MODE_EXPO : MODE_BARE,
  }))
    phase('', chalk.yellow(line));
  return LAUNCH_UNVERIFIED;
}

async function finishAndroidUpload(
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

interface ReportAndroidResultArgs {
  json: boolean;
  useBuildCache: boolean;
  variant: string | null;
  release: boolean;
  metroPort: number | null;
  logsDir: string | null;
  serial: string;
  apkPath: string | null;
  androidPackage: string;
  record: AndroidRecord;
  storeHash: string;
  storeKey: string;
  waitedForBuild: WaitedForBuild | null;
  remote: LoadProjectProviderResult | null;
  launchState: boolean | string;
  launched: LaunchResultLike;
  writer: AndroidWriter;
  emit: (line: string) => void;
}

function reportAndroidResult({
  json,
  useBuildCache,
  variant,
  release,
  metroPort,
  logsDir,
  serial,
  apkPath,
  androidPackage,
  record,
  storeHash,
  storeKey,
  waitedForBuild,
  remote,
  launchState,
  launched,
  writer,
  emit,
}: ReportAndroidResultArgs): AndroidFacts {
  const facts = androidFacts({
    serial,
    avdName: record.avdName,
    deviceName: record.deviceName,
    debugHttpHost: launched.debugHttpHost ?? null,
    debugHttpHostNote: launched.debugHttpHostNote ?? null,
    devClientUrl: launched.devClientUrl ?? null,
    fingerprint: storeHash,
    cacheKey: storeKey,
    variant,
    metroPort,
    cacheHit: record.cacheHit,
    cacheSkipped: !useBuildCache,
    waitedForBuild,
    appPath: apkPath,
    bundleId: androidPackage,
    launched: launchState,
    logs: logsDir,
  });
  writer.close();

  if (json) {
    emit(JSON.stringify(facts));
  } else {
    const summary =
      `OK: ${androidPackage} launched on ${serial}, ` +
      `${release ? `${variant} (embedded JS, no Metro)` : `Metro port ${metroPort}`} ` +
      `(${cacheOutcome(record.cacheHit, remote?.name)})`;
    emit(
      launchState === LAUNCH_UNVERIFIED
        ? chalk.yellow(`${summary} -- launch UNVERIFIED`)
        : launchState === LAUNCH_BUNDLING
          ? chalk.green(`${summary} -- bundle requested, still building`)
          : chalk.green(summary),
    );
  }
  return facts;
}

interface FinishAndroidRunArgs {
  root: string;
  json: boolean;
  metroCheck: boolean;
  useBuildCache: boolean;
  variant: string | null;
  release: boolean;
  isExpo: boolean;
  metroPort: number | null;
  logsDir: string;
  emuLog: string;
  device: OwnedDeviceRecord;
  remoteDevice: ReturnType<typeof remoteAndroidDeps> | null;
  bootPromise: Promise<AndroidBootLike>;
  bootDuration: () => string;
  apkPath: string | null;
  androidPackage: string | null;
  swapDir: string | null;
  record: AndroidRecord;
  storeHash: string;
  storeKey: string;
  waitedForBuild: WaitedForBuild | null;
  uploadPending: Promise<RemoteUploadLike> | null;
  remote: LoadProjectProviderResult | null;
  abandonedRemote: boolean;
  started: number;
  startedAt: string;
  writer: AndroidWriter;
  phase: (label: unknown, text: string) => void;
  fail: (
    code: string | undefined,
    message?: string | null,
    remedy?: string | null,
    extra?: FailExtra,
  ) => RunAndroidResult;
  readApkPackage: (apkPath: string | null) => string | null;
  install: typeof installAndroidApp;
  launch: typeof launchAndroidApp;
  launchRelease: typeof launchAndroidReleaseApp;
  resolveDevClientScheme: typeof androidDevClientScheme;
  verifyLaunched: typeof verifyLaunch;
  verifyReleaseLaunched: typeof verifyAndroidReleaseLaunch;
  spawn: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill: (pid: number, signal: NodeJS.Signals) => boolean;
  writeState: typeof writeWorkspaceState;
  now: () => number;
  out: (line: string) => void;
  emit: (line: string) => void;
}

async function finishAndroidRun({
  root,
  json,
  metroCheck,
  useBuildCache,
  variant,
  release,
  isExpo,
  metroPort,
  logsDir,
  emuLog,
  device,
  remoteDevice,
  bootPromise,
  bootDuration,
  apkPath,
  androidPackage: initialPackage,
  swapDir,
  record,
  storeHash,
  storeKey,
  waitedForBuild,
  uploadPending,
  remote,
  abandonedRemote: remoteWasAbandoned,
  started,
  startedAt,
  writer,
  phase,
  fail,
  readApkPackage,
  install,
  launch,
  launchRelease,
  resolveDevClientScheme,
  verifyLaunched,
  verifyReleaseLaunched,
  spawn,
  kill,
  writeState,
  now,
  out,
  emit,
}: FinishAndroidRunArgs): Promise<RunAndroidResult> {
  let androidPackage = initialPackage;

  const booted = await bootPromise;
  if (booted.failed) {
    const diag = noDeviceDiagnostic({
      reason: booted.reason ?? 'The emulator did not boot.',
      logFile: emuLog,
      remedy:
        'Run `rn-iso status` to see what rn-iso thinks it owns; re-running `rn-iso android` creates a fresh owned AVD.',
    });
    return fail(NO_DEVICE, diag.message, diag.remedy, {
      lines: diag.lines,
      logPath: diag.logPath ? displayPath(root, diag.logPath) : null,
    });
  }
  const serial = booted.serial!;
  phase('device', `${device.avdName || serial} (${serial}) booted ${bootDuration()}`);

  const installTimer = stepTimer(now);
  const installed: InstallResultLike = install({
    serial,
    apkPath: apkPath!,
    packageName: androidPackage,
    allowUninstall: release,
  });
  if (installed.failed) {
    return fail(
      installed.code || INSTALL_FAILED,
      installed.reason,
      `Check that ${serial} is still connected (\`adb devices\`) and has room for the APK.`,
      { lastBuildStatus: true },
    );
  }
  phase('install', `${record.cacheHit ? `from ${record.cacheHit} cache` : basename(apkPath!)} ${installTimer()}`);
  if (installed.note) {
    phase('install', chalk.yellow(installed.note));
    writer.write({ src: 'build', level: 'warn', event: 'install_uninstalled_first', msg: installed.note });
  }
  if (swapDir) {
    try {
      rmSync(swapDir, { recursive: true, force: true });
    } catch {}
  }

  const packageFromApk = readApkPackage(apkPath);
  if (packageFromApk && androidPackage && packageFromApk !== androidPackage) {
    phase('launch', chalk.dim(`applicationId ${packageFromApk} (from the APK; project files say ${androidPackage})`));
  }
  androidPackage = packageFromApk || androidPackage || detectAndroidPackage(root);
  if (androidPackage) upsertProject(root, { androidPackage });
  record.bundleId = androidPackage;
  if (!androidPackage) {
    return fail(
      LAUNCH_FAILED,
      "Could not determine this app's Android package name, so there is nothing to launch.",
      'Set `expo.android.package` in app.json / app.config.js, or `namespace` in android/app/build.gradle.',
      { lastBuildStatus: true },
    );
  }

  const scheme = release ? undefined : resolveDevClientScheme(root, apkPath);
  const launchTimer = stepTimer(now);
  const launchedAt = now();
  const launched: LaunchResultLike = release
    ? remoteDevice
      ? remoteDevice.launch({ serial, packageName: androidPackage, metroPort: null })
      : launchRelease({ serial, packageName: androidPackage })
    : launch({
        serial,
        packageName: androidPackage,
        metroPort: metroPort ?? DEFAULT_METRO_PORT,
        devClientScheme: scheme,
      });
  if (launched.failed) {
    return fail(
      launched.code || LAUNCH_FAILED,
      launched.reason,
      `Check the app installed correctly (\`adb -s ${serial} shell pm list packages ${androidPackage}\`).`,
      { lastBuildStatus: true },
    );
  }
  writer.write({
    src: 'build',
    level: 'info',
    event: 'app_launched',
    marker: true,
    msg: release
      ? `launched ${androidPackage} on ${serial} (${variant}, embedded JS bundle, no Metro)`
      : `launched ${androidPackage} on ${serial} against Metro port ${metroPort}`,
  });
  const launchMode = launched.mode === 'deep-link' ? 'expo-dev-client deep link' : launched.mode;
  phase('launch', `${launchMode ? `${androidPackage} (${launchMode})` : androidPackage} ${launchTimer()}`);

  if (!release && launched.debugHttpHost) {
    phase(
      'wired',
      `debug_http_host ${launched.debugHttpHost} + adb reverse tcp:${DEFAULT_METRO_PORT} -> tcp:${metroPort}`,
    );
  } else if (!release) {
    phase(
      'wired',
      chalk.yellow(
        `adb reverse tcp:${DEFAULT_METRO_PORT} -> tcp:${metroPort}; ${launched.debugHttpHostNote || 'debug_http_host not written'}`,
      ),
    );
    writer.write({
      src: 'build',
      level: 'warn',
      event: 'debug_http_host_failed',
      msg: `debug_http_host was not written for ${androidPackage} on ${serial}: ${launched.debugHttpHostNote || 'unknown reason'}`,
    });
  }
  if (launched.devClientNote) {
    phase('wired', chalk.yellow(launched.devClientNote));
    writer.write({ src: 'build', level: 'warn', event: 'dev_client_link_failed', msg: launched.devClientNote });
  }

  const uploadWasAbandoned = await finishAndroidUpload(uploadPending, remote, phase);

  persistLastBuild({ writeState, root, record, startedAt, durationMs: now() - started, status: 'ok', out });

  const remoteRelease = Boolean(remoteDevice && release);
  if (!remoteRelease) {
    const collectorPid = await startCollector({ root, serial, packageName: androidPackage, spawn, kill, out });
    phase('logs', `${displayPath(root, logsDir)}${collectorPid ? ` (collector pid ${collectorPid})` : ''}`);
  }

  const launchState = await verifyAndroidRun({
    release,
    remoteRelease,
    verifyReleaseLaunched,
    verifyLaunched,
    serial,
    androidPackage,
    variant,
    metroCheck,
    logsDir,
    launchedAt,
    metroPort,
    isExpo,
    scheme,
    phase,
  });
  writer.write(
    launchOutcomeRecord({ launchState, release, bundleId: androidPackage, configuration: variant, metroPort }),
  );

  const facts = reportAndroidResult({
    json,
    useBuildCache,
    variant,
    release,
    metroPort,
    logsDir: remoteRelease ? null : logsDir,
    serial,
    apkPath,
    androidPackage,
    record,
    storeHash,
    storeKey,
    waitedForBuild,
    remote,
    launchState,
    launched,
    writer,
    emit,
  });
  if (remoteWasAbandoned || uploadWasAbandoned) exitAfterFlush(0);
  return { ok: true, facts };
}

function resolveRunAndroidOptions(
  {
    root,
    json = false,
    remoteDevice: commandRemoteBackend = null,
    resolveSettingsFor = resolveSettings,
    resolveRemoteDeviceContext = resolveRemoteContext,
    remoteDeviceDeps: makeRemoteDeviceDeps = remoteAndroidDeps,
    resolveEasBin = resolveEasCliBin,
    ensureMetroReachable: ensureRemoteMetro = ensureRemoteMetroReachable,
    ensureRemoteBootOwned: ensureRemoteOwned = ensureRemoteBootOwned,
    detectRemoteProviders = detectProviders,
    metroCheck = true,
    useBuildCache = true,
    variant: variantFlag = null,
    readApkPackage = (apkPath: string | null) => apkPackage(dumpApkManifest(apkPath)),
    getLimits = getConcurrencyLimits,
    checkCapacity = checkDeviceCapacity,
    acquireSlot = acquireBuildSlot,
    releaseSlot = releaseBuildSlot,
    ensureDevice = ensureOwnedDevice,
    ensureDeviceBooted = ensureBooted,
    resolveMetro = resolveProjectMetro,
    resolveMetroRetrying = resolveMetroWithRetry,
    readState = readWorkspaceState,
    pidAlive = isPidAlive,
    verifyLaunched = verifyLaunch,
    ensureStorage = ensureWorkspaceStorageSafely,
    fingerprint = fingerprintProject,
    untracked = untrackedNativeFiles,
    resolveCached = resolveBuild,
    storeCached = storeBuild,
    storedAssets = storedAssetManifest,
    captureAssets = captureAssetManifest,
    acquireLock = acquireBuildLock,
    releaseLock = releaseBuildLock,
    waitForBuild = waitForOtherBuild,
    loadProvider = loadProjectProvider,
    easAuth = checkEasAuth,
    resolveRemoteBuild = resolveRemote,
    uploadRemoteBuild = uploadRemote,
    needsPrebuildFor = needsPrebuild,
    prebuild = runPrebuild,
    build = buildAndroid,
    install = installAndroidApp,
    launch = launchAndroidApp,
    launchRelease = launchAndroidReleaseApp,
    verifyReleaseLaunched = verifyAndroidReleaseLaunch,
    swapApk = swapApkBundle,
    resolveDevClientScheme = androidDevClientScheme,
    spawn = (cmd, args, opts) => getExecutor().spawn(cmd, args, opts),
    kill = (pid, signal) => process.kill(pid, signal),
    createWriter = createNdjsonWriter,
    writeState = writeWorkspaceState,
    now = Date.now,
    out = (line) => console.error(line),
    emit = (line) => console.log(line),
  }: RunAndroidOptions = {} as RunAndroidOptions,
) {
  return {
    root,
    json,
    commandRemoteBackend,
    resolveSettingsFor,
    resolveRemoteDeviceContext,
    makeRemoteDeviceDeps,
    resolveEasBin,
    ensureRemoteMetro,
    ensureRemoteOwned,
    detectRemoteProviders,
    metroCheck,
    useBuildCache,
    variantFlag,
    readApkPackage,
    getLimits,
    checkCapacity,
    acquireSlot,
    releaseSlot,
    ensureDevice,
    ensureDeviceBooted,
    resolveMetro,
    resolveMetroRetrying,
    readState,
    pidAlive,
    verifyLaunched,
    ensureStorage,
    fingerprint,
    untracked,
    resolveCached,
    storeCached,
    storedAssets,
    captureAssets,
    acquireLock,
    releaseLock,
    waitForBuild,
    loadProvider,
    easAuth,
    resolveRemoteBuild,
    uploadRemoteBuild,
    needsPrebuildFor,
    prebuild,
    build,
    install,
    launch,
    launchRelease,
    verifyReleaseLaunched,
    swapApk,
    resolveDevClientScheme,
    spawn,
    kill,
    createWriter,
    writeState,
    now,
    out,
    emit,
  };
}

export async function runAndroid(options: RunAndroidOptions = {} as RunAndroidOptions): Promise<RunAndroidResult> {
  let {
    root,
    json,
    commandRemoteBackend,
    resolveSettingsFor,
    resolveRemoteDeviceContext,
    makeRemoteDeviceDeps,
    resolveEasBin,
    ensureRemoteMetro,
    ensureRemoteOwned,
    detectRemoteProviders,
    metroCheck,
    useBuildCache,
    variantFlag,
    readApkPackage,
    getLimits,
    checkCapacity,
    acquireSlot,
    releaseSlot,
    ensureDevice,
    ensureDeviceBooted,
    resolveMetro,
    resolveMetroRetrying,
    readState,
    pidAlive,
    verifyLaunched,
    ensureStorage,
    fingerprint,
    untracked,
    resolveCached,
    storeCached,
    storedAssets,
    captureAssets,
    acquireLock,
    releaseLock,
    waitForBuild,
    loadProvider,
    easAuth,
    resolveRemoteBuild,
    uploadRemoteBuild,
    needsPrebuildFor,
    prebuild,
    build,
    install,
    launch,
    launchRelease,
    verifyReleaseLaunched,
    swapApk,
    resolveDevClientScheme,
    spawn,
    kill,
    createWriter,
    writeState,
    now,
    out,
    emit,
  } = resolveRunAndroidOptions(options);
  const started = now();
  const startedAt = new Date(started).toISOString();
  try {
    await ensureStorage(root, { note: out });
  } catch (error) {
    const code = (error as Error & { code?: string })?.code || 'RN_ISO_WORKSPACE_STATE';
    const message = `Could not prepare this workspace's rn-iso state: ${(error as Error)?.message || error}`;
    const remedy = 'Check that RN_ISO_HOME is writable and has free space.';
    out(phaseLine('error', chalk.red(`${code}: ${message}`)));
    out(phaseLine('remedy', remedy));
    if (json) emit(JSON.stringify({ code, message, remedy }));
    return { ok: false, error: { code, message, remedy } };
  }
  const logsDir = workspaceLogsDir(root);
  const buildLog = join(logsDir, 'build-android.ndjson');
  const writer = createWriter(buildLog, { truncate: true });

  const record: AndroidRecord = {
    fingerprint: null,
    cacheKey: null,
    cacheHit: false,
    appPath: null,
    bundleId: null,
    avdName: null,
    deviceName: null,
  };

  let buildLock: BuildLockHandle | null = null;
  const releaseHeldLock = () => {
    if (!buildLock) return;
    const held = buildLock;
    buildLock = null;
    try {
      releaseLock(held);
    } catch (err) {
      out(
        phaseLine(
          'build',
          chalk.dim(`could not release the build lock at ${held.path}: ${(err as Error)?.message || err}`),
        ),
      );
    }
  };

  let buildSlot: BuildSlotHandle | null = null;
  const releaseHeldSlot = () => {
    if (!buildSlot) return;
    const held = buildSlot;
    buildSlot = null;
    try {
      releaseSlot(held);
    } catch (err) {
      out(phaseLine('build', chalk.dim(`could not release the build slot: ${(err as Error)?.message || err}`)));
    }
  };

  const phase = (label: unknown, text: string) => out(phaseLine(label, text));
  const fail = (
    code: string | undefined,
    message?: string | null,
    remedy?: string | null,
    { lastBuildStatus = false, diagnostics = [], lines = [], logPath = null }: FailExtra = {},
  ): RunAndroidResult => {
    if (lastBuildStatus) {
      persistLastBuild({
        writeState,
        root,
        record,
        startedAt,
        durationMs: now() - started,
        status: 'failed',
        errorCode: code,
        out,
      });
    }
    out(phaseLine('error', chalk.red(`${code}: ${message}`)));
    for (const diagnostic of diagnostics) out(phaseLine('error', chalk.red(diagnostic)));
    for (const line of lines) out(phaseLine('', chalk.dim(line)));
    if (remedy) out(phaseLine('remedy', remedy));
    if (logPath) out(phaseLine('log', logPath));
    if (json) emit(JSON.stringify({ code, message, remedy: remedy ?? null }));
    writer.close();
    return { ok: false, error: { code, message, remedy: remedy ?? null } };
  };

  const settings = resolveSettingsFor({
    projectPath: root,
    gitCommonDir: gitCommonDir(root),
    repoRoot: repoRoot(root),
  });
  const remoteSettingError = remoteDeviceSettingError(settings);
  if (remoteSettingError) {
    return fail(
      'RN_ISO_BAD_ARG',
      remoteSettingError,
      `Set ios.remote and android.remote to one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}.`,
    );
  }
  const variant = resolveVariant(variantFlag, settings);
  const release = isReleaseVariant(variant);
  const isExpo = detectIsExpo(root);
  const remoteBackend = commandRemoteBackend ?? remoteAndroidSetting(settings);
  let androidPackage = detectAndroidPackage(root);
  record.bundleId = androidPackage;
  const registerProject = () =>
    upsertProject(root, {
      bundleId: detectBundleId(root) ?? undefined,
      androidPackage: androidPackage ?? undefined,
      isExpo,
    });
  if (remoteBackend !== 'eas') registerProject();
  const project = getProject(root);
  const label = projectShortcut(root, project);

  let remoteDevice: ReturnType<typeof makeRemoteDeviceDeps> | null = null;

  const reservedPort = project?.metroPort ?? null;
  let metroPort: number | null = null;
  let phaseFailure: RunAndroidResult | null = null;

  async function resolveMetroPort(): Promise<boolean> {
    if (release) {
      phase('metro', `skipped (${variant}: the JS bundle is embedded, no dev server is used)`);
    } else if (metroCheck) {
      if (!reservedPort) {
        phaseFailure = fail(
          NO_METRO,
          'No Metro port is reserved for this workspace.',
          'Run `rn-iso start` first, or pass --no-metro-check.',
        );
        return false;
      }
      const held = await resolveMetroRetrying(resolveMetro, reservedPort, root, {
        onRetry: ({ delayMs }) =>
          phase(
            'metro',
            `port ${reservedPort} did not verify yet; retrying in ${Math.round(delayMs / 1000)}s (Metro may still be indexing)`,
          ),
      });
      if (!held.metro) {
        const supervisor = (readState(root)?.supervisor ?? null) as SupervisorLike | null;
        const supervisorAlive = Boolean(supervisor?.pid && pidAlive(supervisor.pid));
        phaseFailure = fail(
          NO_METRO,
          noMetroMessage({ port: reservedPort, resolution: held, supervisor, supervisorAlive }),
          noMetroRemedy({ port: reservedPort, supervisor, supervisorAlive }),
        );
        return false;
      }
      phase('metro', `port ${reservedPort} (pid ${held.metro?.pid})`);
    } else {
      phase(
        'metro',
        reservedPort
          ? `port ${reservedPort} (not checked)`
          : `no reservation; using ${DEFAULT_METRO_PORT} (not checked)`,
      );
    }
    metroPort = release ? null : (reservedPort ?? DEFAULT_METRO_PORT);
    return true;
  }

  if (!(await resolveMetroPort())) return phaseFailure!;

  if (remoteBackend) {
    const resolved = await resolveRemoteDeviceContext({
      root,
      label,
      platform: PLATFORM,
      backend: remoteBackend,
      easBin: resolveEasBin(root)?.file ?? null,
    });
    if ('failed' in resolved) return fail(resolved.code ?? REMOTE_SESSION_ERROR, resolved.failed, resolved.remedy);
    remoteDevice = makeRemoteDeviceDeps(resolved.ctx);

    if (metroPort !== null) {
      const reachable = await ensureRemoteMetro({
        ctx: remoteDevice.ctx,
        metroPort,
        isExpo,
        tunnelMode: tunnelModeSetting(settings) ?? undefined,
        publicUrl: publicUrlSetting(settings),
        available: detectRemoteProviders(binOnPath),
      });
      if ('failed' in reachable) {
        return fail(reachable.code ?? REMOTE_SESSION_ERROR, reachable.failed, reachable.remedy);
      }
    }

    checkCapacity = remoteDevice.checkCapacity;
    ensureDevice = remoteDevice.ensureDevice;
    ensureDeviceBooted = remoteDevice.ensureDeviceBooted;
    install = remoteDevice.install;
    launch = remoteDevice.launch;
  }

  const limits = getLimits();
  const capacity = checkCapacity({
    platform: PLATFORM,
    project,
    max: limits.maxDevices,
  });
  if (capacity) return fail(capacity.code, capacity.message, capacity.remedy);

  const emuLog = emulatorLogFile(root);
  let device: OwnedDeviceRecord;
  try {
    device = await ensureDevice({
      platform: PLATFORM,
      project,
      projectPath: root,
      label,
      settings,
      flags: {},
      note: out,
      out,
      logFile: emuLog,
    });
  } catch (err) {
    const diag = noDeviceDiagnostic({
      reason: `Could not ensure an owned Android emulator: ${(err as Error)?.message || err}`,
      logFile: emuLog,
      remedy:
        'Check that JAVA_HOME and ANDROID_HOME are set correctly, and that an arm64 system image is installed (`sdkmanager "system-images;android-36;google_apis;arm64-v8a"`).',
    });
    return fail(NO_DEVICE, diag.message, diag.remedy, {
      lines: diag.lines,
      logPath: diag.logPath ? displayPath(root, diag.logPath) : null,
    });
  }

  const bootTimer = stepTimer(now);
  let bootDuration = '';
  const boot = (): Promise<AndroidBootLike> =>
    Promise.resolve(ensureDeviceBooted({ platform: PLATFORM, device, out, logFile: emuLog })).catch((e) => ({
      failed: true as const,
      reason: String((e as Error)?.message || e),
      serial: undefined,
    }));
  const bootPromise: Promise<AndroidBootLike> = (
    remoteDevice?.ctx.backend === 'eas'
      ? ensureRemoteOwned({
          root,
          platform: PLATFORM,
          sessionName: ownedSessionName(remoteDevice.ctx.label),
          startedAt,
          boot,
          createdSessionId: remoteDevice.createdSessionId,
          abandonCreatedSession: remoteDevice.abandonCreatedSession,
          writeState,
          register: registerProject,
        })
      : boot()
  ).then((result) => {
    bootDuration = bootTimer();
    return result;
  });

  if (remoteDevice) {
    const booted = await bootPromise;
    if (booted.failed) {
      if (booted.code) {
        return fail(booted.code, booted.reason ?? 'The remote device did not boot.', booted.remedy ?? null);
      }
      const diag = noDeviceDiagnostic({
        reason: booted.reason ?? 'The remote device did not boot.',
        logFile: emuLog,
        remedy: 'Run `rn-iso status` to inspect the remote device, then retry the command.',
      });
      return fail(NO_DEVICE, diag.message, diag.remedy, {
        lines: diag.lines,
        logPath: diag.logPath ? displayPath(root, diag.logPath) : null,
      });
    }
  }
  record.avdName = device.avdName ?? null;
  record.deviceName = device.deviceName ?? device.avdName ?? null;

  let hash = '';
  let fingerprintSources: FingerprintSource[] = [];
  let cacheKey = '';
  let storeHash = '';
  let storeKey = '';
  let storeSources: FingerprintSource[] = [];
  let apkPath: string | null = null;

  async function resolveInitialFingerprint(): Promise<boolean> {
    const fingerprintTimer = stepTimer(now);
    try {
      const computed = await fingerprint(root, { platform: PLATFORM });
      hash = computed?.hash ?? '';
      fingerprintSources = computed?.sources ?? [];
    } catch (err) {
      phaseFailure = fail(
        NO_FINGERPRINT,
        `@expo/fingerprint could not fingerprint ${root}: ${(err as Error)?.message || err}`,
        'Fix the @expo/fingerprint error above, then retry.',
      );
      return false;
    }
    if (!hash) {
      phaseFailure = fail(
        NO_FINGERPRINT,
        `@expo/fingerprint returned no hash for ${root}, so the build cache cannot be addressed.`,
        'Check the project native inputs and the @expo/fingerprint error above, then retry.',
      );
      return false;
    }
    record.fingerprint = hash;
    cacheKey = buildCacheKey(PLATFORM, hash, variant ? { variant } : {});
    record.cacheKey = cacheKey;
    storeHash = hash;
    storeKey = cacheKey;
    storeSources = fingerprintSources;

    const cached = useBuildCache ? resolveCached(PLATFORM, cacheKey) : null;
    record.cacheHit = cached ? 'local' : false;
    record.cacheSkipped = !useBuildCache;
    let missDiff = '';
    let missUntracked: string | null = null;
    if (!cached) {
      const lastBuild = (readState(root)?.lastBuild ?? null) as Record<string, unknown> | null;
      const miss = describeFingerprintMiss({
        platform: PLATFORM,
        current: { hash, sources: fingerprintSources },
        lastBuild,
      });
      if (miss) {
        missDiff = fingerprintDiffSuffix(miss.changed);
        writer.write(fingerprintDiffRecord({ changed: miss.changed, previousHash: miss.previousHash, hash }));
      } else if (useBuildCache) {
        missUntracked = untrackedMissLine(untracked({ projectRoot: root }));
      }
    }
    phase(
      'fingerprint',
      `${shortHash(hash)} ${cached ? 'hit' : 'miss'}${useBuildCache ? '' : ' (--no-build-cache)'} ${fingerprintTimer()}${missDiff}`,
    );
    if (missUntracked) phase('fingerprint', chalk.dim(missUntracked));
    apkPath = cached || null;
    return true;
  }

  if (!(await resolveInitialFingerprint())) return phaseFailure!;

  let remote: LoadProjectProviderResult | null = null;
  let abandonedRemote = false;
  let uploadPending: Promise<RemoteUploadLike> | null = null;

  async function resolveRemoteArtifact(): Promise<void> {
    if (!apkPath) {
      const loaded: LoadProjectProviderResult = await loadProvider(root, { isExpo });
      if (loaded?.unavailable) {
        phase('cache', chalk.yellow(`provider not usable: ${loaded.unavailable}`));
      } else if (loaded?.provider) {
        remote = loaded;
      }
      if (remote?.name === 'eas') {
        const auth = easAuth({ projectRoot: root, owner: loaded?.owner || null });
        const authNote = easAuthNote(auth as Parameters<typeof easAuthNote>[0]);
        if (authNote) phase('cache', chalk.yellow(authNote));
        if (auth?.code === 'logged-out') remote = null;
      }
    }

    if (remote && useBuildCache) {
      const remoteTimer = stepTimer(now);
      const hit = await resolveRemoteBuild({
        logWriter: writer,
        provider: remote.provider,
        platform: PLATFORM,
        projectRoot: root,
        fingerprintHash: hash,
        runOptions: variant ? { variant } : null,
      });
      if (hit?.appPath) {
        let stored = null;
        try {
          stored = storeCached(PLATFORM, cacheKey, hit.appPath, { sources: fingerprintSources });
        } catch (err) {
          phase('cache', chalk.yellow(`remote hit could not be stored locally: ${(err as Error)?.message || err}`));
        }
        apkPath = stored || hit.appPath;
        record.cacheHit = 'remote';
        phase('cache', `remote hit (${remote.name})${stored ? ' -> stored locally' : ''} ${remoteTimer()}`);
      } else if (hit?.timedOut) {
        abandonedRemote = true;
        phase(
          'cache',
          chalk.yellow(`${remote.name} did not answer within ${formatDuration(RESOLVE_TIMEOUT_MS)}; building instead`),
        );
      } else if (hit?.failed) {
        const authNote =
          remote.name === 'eas' && isEasAuthFailureText(hit.failed)
            ? easAuthNote({ code: 'logged-out', reason: hit.failed })
            : null;
        phase('cache', chalk.yellow(authNote || `${remote.name} could not be used: ${hit.failed}; building instead`));
      } else {
        phase('cache', `remote miss (${remote.name}) ${remoteTimer()}`);
      }
    }
  }

  await resolveRemoteArtifact();

  let waitedForBuild: WaitedForBuild | null = null;
  async function waitForSharedBuild(): Promise<boolean> {
    if (!apkPath && useBuildCache) {
      let attempt: BuildLockHandle | null = null;
      try {
        attempt = acquireLock({ platform: PLATFORM, key: cacheKey, root, logFile: buildLog });
      } catch (err) {
        phase(
          'build',
          chalk.yellow(`could not take the build lock: ${(err as Error)?.message || err}; building anyway`),
        );
      }

      if (attempt?.acquired) {
        buildLock = attempt;
        if (attempt.tookOver) phase('build', chalk.yellow(takeoverLine(attempt.tookOver)));
      } else if (attempt?.held) {
        const holder = attempt.held;
        const who = holder.projectRoot || 'another workspace';
        phase(
          'build',
          `${who} is already building ${shortHash(hash)} (pid ${holder.pid})` +
            `${holder.logFile ? ` -- tail ${holder.logFile}` : ''}`,
        );

        let waited: WaitForBuildResult | null = null;
        try {
          waited = await waitForBuild({ platform: PLATFORM, key: cacheKey, out });
        } catch (err) {
          const wtErr = err as Error & { code?: string; lockPath?: string };
          if (wtErr?.code !== 'RN_ISO_BUILD_WAIT_TIMEOUT') throw err;
          phaseFailure = fail(
            'RN_ISO_BUILD_WAIT_TIMEOUT',
            wtErr.message,
            `Check pid ${holder.pid}; if it is not really building, remove ${wtErr.lockPath} and run \`rn-iso android\` again.`,
            { lastBuildStatus: true },
          );
          return false;
        }

        if (waited?.hit) {
          apkPath = waited.hit ?? null;
          record.cacheHit = 'local';
          waitedForBuild = { pid: holder.pid, ms: waited.waitedMs };
          phase('build', `waited ${formatDuration(waited.waitedMs)} for ${who}'s build -> installed from cache`);
        } else {
          phase(
            'build',
            chalk.yellow(`${who}'s build ended without an artifact (${waited?.builderFailed}); building here`),
          );
          try {
            const takeover = acquireLock({ platform: PLATFORM, key: cacheKey, root, logFile: buildLog });
            if (takeover?.acquired) buildLock = takeover;
          } catch {}
          phase('build', chalk.yellow(takeoverLine(holder)));
        }
      }
    }
    return true;
  }

  if (!(await waitForSharedBuild())) return phaseFailure!;

  let swapDir: string | null = null;
  let swapFellBack = false;
  const installableCachedApk = async (key: string, cachedPath: string): Promise<string | null> => {
    if (!release) return cachedPath;
    phase('apk swap', `regenerating this workspace's JS for the cached ${variant} APK`);
    const swap = await swapApk({
      root,
      isExpo,
      cachedApkPath: cachedPath,
      keystore: resolveKeystore(root, settings),
      logWriter: writer,
      storedAssets: storedAssets(PLATFORM, key),
    });
    if (swap?.ok && swap.apkPath) {
      if (swap.note) phase('apk swap', chalk.yellow(swap.note));
      swapDir = swap.tmpDir ?? null;
      phase(
        'apk swap',
        `${swap.hermes ? 'hermes bytecode' : 'plain JS'} repacked (store), zipaligned and re-signed (${formatDuration(swap.durationMs)})`,
      );
      return swap.apkPath;
    }
    if (swap?.assetMismatch) {
      phase(
        'apk swap',
        chalk.yellow(
          `${swap.reason} -- building fresh instead` +
            (swap.assetDiff ? ' (an APK cannot be made to carry an asset AAPT did not package)' : ''),
        ),
      );
    } else {
      phase(
        'apk swap',
        chalk.yellow(
          `failed at ${swap?.step || 'unknown step'}: ${swap?.reason || 'unknown reason'} -- ` +
            `building fresh instead (a cached ${variant} APK carries its builder's JS; it is never installed after a failed swap)`,
        ),
      );
    }
    for (const line of swap?.lastLines ?? []) phase('', chalk.dim(line));
    swapFellBack = true;
    return null;
  };

  async function prepareCachedArtifact(): Promise<void> {
    if (apkPath && record.cacheHit) {
      const prepared = await installableCachedApk(cacheKey, apkPath);
      apkPath = prepared;
      if (!prepared) {
        record.cacheHit = false;
        waitedForBuild = null;
      }
    }
  }

  async function buildArtifact(): Promise<boolean> {
    if (!apkPath) {
      try {
        if (limits.maxBuilds) {
          try {
            buildSlot = await acquireSlot({ max: limits.maxBuilds, root, logFile: buildLog, out });
          } catch (err) {
            phase(
              'build',
              chalk.yellow(`could not take a build slot: ${(err as Error)?.message || err}; building anyway`),
            );
          }
        }

        if (needsPrebuildFor(root, PLATFORM, isExpo)) {
          const pre: PrebuildResultLike = await prebuild(root, PLATFORM, writer, { isExpo });
          if (pre.failed) {
            phaseFailure = fail(pre.code!, pre.reason, pre.remedy, {
              lastBuildStatus: true,
              lines: tail(pre.lastLines),
              logPath: displayPath(root, buildLog),
            });
            return false;
          }
          phase('prebuild', `android/ generated (${formatDuration(pre.durationMs)})`);
          androidPackage = androidPackage || detectAndroidPackage(root);
          record.bundleId = androidPackage;

          const after = await refingerprintAfterMutation({
            projectRoot: root,
            platform: PLATFORM,
            previousHash: hash,
            fingerprint,
          });
          if (after?.moved) {
            storeHash = after.hash;
            storeSources = after.sources;
            storeKey = buildCacheKey(PLATFORM, after.hash, variant ? { variant } : {});
            record.fingerprint = storeHash;
            record.cacheKey = storeKey;
            phase(
              'fingerprint',
              chalk.dim(
                `${shortHash(hash)} -> ${shortHash(storeHash)} after prebuild; ` +
                  'storing under the new key, which is the one the next run looks up',
              ),
            );

            const late = useBuildCache ? resolveCached(PLATFORM, storeKey) : null;
            if (late) {
              const prepared = await installableCachedApk(storeKey, late);
              if (prepared) {
                apkPath = prepared;
                record.cacheHit = 'local';
                phase(
                  'cache',
                  'hit under the post-prebuild key (this tree was cold, so the first lookup could not find it)',
                );
              }
            }
          }
        }

        if (!apkPath) {
          const built: BuildAndroidResultLike = await build({ root, logWriter: writer, variant });
          if (built.failed) {
            const diagnostics = built.diagnostics || [];
            for (const diag of diagnostics) {
              writer.write({ src: 'build', level: 'error', event: 'gradle_diagnostic', msg: formatDiagnostic(diag) });
            }
            phase('build', chalk.red(`FAILED after ${formatDuration(built.durationMs)}`));
            const extracted = diagnostics.map(formatDiagnostic);
            if ((built.truncated ?? 0) > 0) extracted.push(`... and ${built.truncated} more diagnostic(s) in the log`);
            phaseFailure = fail(
              built.code!,
              built.reason,
              diagnostics.find((d) => d.remedy)?.remedy || built.remedy || null,
              {
                lastBuildStatus: true,
                diagnostics: extracted,
                lines: extracted.length ? [] : tail(built.lastLines),
                logPath: displayPath(root, buildLog),
              },
            );
            return false;
          }
          apkPath = built.apkPath ?? null;
          phase('build', `${basename(apkPath!)} (${formatDuration(built.durationMs)})`);
          if (built.apkNote) phase('build', chalk.yellow(built.apkNote));

          const assetManifest = release ? captureAssets(root, { variant }) : null;
          try {
            storeCached(PLATFORM, storeKey, apkPath!, {
              overwrite: !useBuildCache || swapFellBack,
              sources: storeSources,
              assetManifest,
            });
          } catch (err) {
            phase('cache', chalk.yellow(`could not store the build: ${(err as Error)?.message || err}`));
          }

          if (remote) {
            uploadPending = uploadRemoteBuild({
              logWriter: writer,
              provider: remote.provider,
              platform: PLATFORM,
              projectRoot: root,
              fingerprintHash: storeHash,
              buildPath: apkPath!,
              runOptions: variant ? { variant } : null,
            });
          }
        }
      } finally {
        releaseHeldLock();
        releaseHeldSlot();
      }
    }
    return true;
  }

  await prepareCachedArtifact();
  if (!(await buildArtifact())) return phaseFailure!;
  record.appPath = apkPath;

  return finishAndroidRun({
    root,
    json,
    metroCheck,
    useBuildCache,
    variant,
    release,
    isExpo,
    metroPort,
    logsDir,
    emuLog,
    device,
    remoteDevice,
    bootPromise,
    bootDuration: () => bootDuration,
    apkPath,
    androidPackage,
    swapDir,
    record,
    storeHash,
    storeKey,
    waitedForBuild,
    uploadPending,
    remote,
    abandonedRemote,
    started,
    startedAt,
    writer,
    phase,
    fail,
    readApkPackage,
    install,
    launch,
    launchRelease,
    resolveDevClientScheme,
    verifyLaunched,
    verifyReleaseLaunched,
    spawn,
    kill,
    writeState,
    now,
    out,
    emit,
  });
}

export function cacheOutcome(cacheHit: unknown, providerName: string | null = null): string {
  if (cacheHit === 'remote') return `cache hit from ${providerName || 'the remote cache'}`;
  if (cacheHit === 'local') return 'cache hit';
  return 'built';
}

function persistLastBuild({
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

export async function startCollector({
  root,
  serial,
  packageName,
  spawn,
  kill,
  alive = isPidAlive,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  out,
}: {
  root: string;
  serial?: string;
  packageName: string;
  spawn: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  out: (line: string) => void;
}): Promise<number | null> {
  const previousPid = killPreviousCollector(root, { kill });
  if (previousPid) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && alive(previousPid)) {
      await sleep(COLLECTOR_POLL_MS);
    }
  }

  let stdio: 'ignore' | (number | 'ignore')[] = 'ignore';
  try {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const fd = openSync(collectorLogFile(root), 'a');
    stdio = ['ignore', fd, fd];
  } catch {}

  try {
    const child = spawn(
      process.execPath,
      [collectorEntry(), '--platform', PLATFORM, '--root', root, '--serial', serial!, '--package', packageName],
      {
        cwd: root,
        detached: true,
        stdio,
        env: process.env,
      },
    );
    child?.unref?.();
    return child?.pid ?? null;
  } catch (err) {
    out(phaseLine('logs', chalk.yellow(`could not start the device log collector: ${(err as Error)?.message || err}`)));
    return null;
  }
}

function tail(lines: unknown, n = FALLBACK_LINES): string[] {
  return (Array.isArray(lines) ? lines : []).slice(-n);
}
