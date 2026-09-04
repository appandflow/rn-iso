import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { type Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import {
  loadCacheProvider,
  createWarnOnce,
  resolveTieredBuild,
  storeTieredBuild,
  type LoadCacheProviderResult,
  type ProviderCallResult,
} from '@stim-cli/cache';
import type { FingerprintSource } from '@expo/fingerprint';
import { formatDuration, phaseLine, shortHash, SLOW_STEP_MS, stepClock, stepTimer } from '../command-output.ts';
import type { RemoteDeviceBackend, WaitedForBuild } from '../types.ts';
import { findProjectRoot, detectAndroidPackage, detectBundleId, detectIsExpo, projectShortcut } from '../project.ts';
import {
  REMOTE_DEVICE_BACKENDS,
  resolveCacheProviderConfig,
  resolveSettings,
  SETTING_SHAPE_REMEDY,
  androidAvdConfigSettingError,
  androidDataPartitionSizeGbSettingError,
  cacheProviderSettingError,
  publicUrlSetting,
  remoteAndroidSetting,
  remoteDeviceSettingError,
  settingShapeErrors,
  tunnelModeSetting,
  unknownSettingKeys,
} from '../settings.ts';
import {
  waitFlagConflict,
  acquireRunLease,
  releaseLeaseOnSignal,
  runLease,
  leaseExpiryText,
  parseDeviceWait,
  type RunLease,
} from '../engine/device-lease-run.ts';
import { verifyCollectorOwnership } from '../collector/ownership.ts';
import { getConcurrencyLimits, getProject, upsertProject } from '../config.ts';
import {
  fingerprintProject,
  resolveBuild,
  storeBuild,
  storedAssetManifest,
  untrackedNativeFiles,
  buildCacheKey,
  describeFingerprintMiss,
  filesystemBuildCapability,
  fingerprintDiffRecord,
  fingerprintDiffSuffix,
  prepareProviderDownloadDir,
  providerDownloadPath,
  refingerprintAfterMutation,
  untrackedMissLine,
} from '../build-cache.ts';
import {
  acquireBuildLock,
  releaseBuildLock,
  waitForBuild as waitForOtherBuild,
  takeoverLine,
  type BuildLockHandle,
  type WaitForBuildResult,
} from '../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot, type BuildSlotHandle } from '../engine/build-slots.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { isPidAlive, resolveProjectMetro } from '../metro.ts';
import {
  ensureWorkspaceStorageSafely,
  resolveMetroWithRetry,
  noMetroMessage,
  noMetroRemedy,
} from './native-runtime.ts';
import {
  readRunEstimates,
  recordRunStats,
  createRunRecorder,
  statsProjectKey,
  type RunEstimates,
} from '../engine/stats.ts';
import { readWorkspaceState, writeWorkspaceLaunch, writeWorkspaceState } from '../supervisor/state.ts';
import {
  installAndroidApp,
  launchAndroidApp,
  launchAndroidReleaseApp,
  verifyAndroidReleaseLaunch,
  verifyLaunch,
  ADB_INSTALL_TIMEOUT_MS,
  DEFAULT_METRO_PORT,
} from '../engine/app-install.ts';
import {
  listAdbDevices,
  listInstalledSystemImages,
  physicalDeviceModel,
  probeEmulatorSerial,
  resolvePhysicalDevice,
} from '../sim/android.ts';
import { checkDeviceCapacity, ensureBooted, ensureOwnedDevice, type OwnedDeviceRecord } from '../engine/device.ts';
import {
  ensureRemoteBootOwned,
  ensureMetroReachable as ensureRemoteMetroReachable,
  remoteAndroidDeps,
  resolveRemoteContext,
  REMOTE_SESSION_ERROR,
  binOnPath,
} from '../engine/device-remote.ts';
import { detectProviders } from '../engine/metro-reach.ts';
import { selectFromPool } from '../engine/device-pool.ts';
import { needsPrebuild, runPrebuild } from '../engine/prebuild.ts';
import { buildAndroid, productFlavorRefusal, readProductFlavors } from '../engine/gradle.ts';
import { swapApkBundle, resolveKeystore } from '../engine/apk-swap.ts';
import { captureAssetManifest } from '../engine/asset-manifest.ts';
import {
  checkEasAuth,
  resolveEasCliBin,
  loadProjectProvider,
  resolveRemote,
  uploadRemote,
  RESOLVE_TIMEOUT_MS,
  easAuthNote,
  isEasAuthFailureText,
  type LoadProjectProviderResult,
} from '../engine/remote-cache.ts';
import {
  androidDevClientScheme,
  dumpApkManifest,
  apkPackage,
  PLATFORM,
  resolveVariant,
  resolveSystemImage,
  systemImageRefusal,
  isReleaseVariant,
  NO_METRO,
  NO_FINGERPRINT,
  NO_DEVICE,
  noDeviceDiagnostic,
  displayPath,
  pooledAndroidDevice,
} from './android/support.ts';
import { getExecutor } from '../exec.ts';
import { emulatorLogFile, workspaceDir, workspaceLogsDir } from '../paths.ts';
import { gitCommonDir, repoRoot } from '../worktree.ts';
import { ownedSessionName } from '../engine/eas-simulator.ts';
import { formatDiagnostic } from '../engine/errors-gradle.ts';
import type {
  SupervisorLike,
  RemoteUploadLike,
  PrebuildResultLike,
  BuildAndroidResultLike,
  FailExtra,
  AndroidRecord,
  RunAndroidResult,
  AndroidBootLike,
} from './android/types.ts';
import { persistLastBuild } from './android/result.ts';
import { finishAndroidRun } from './android/launch.ts';

export { androidFacts, lastBuildRecord } from './android/result.ts';

export { collectorLogFile, killPreviousCollector, startCollector } from './android/collector.ts';

export {
  androidVariantSetting,
  resolveVariant,
  androidSystemImageSetting,
  resolveSystemImage,
  isReleaseVariant,
  NO_METRO,
  NO_FINGERPRINT,
  NO_DEVICE,
  findAapt,
  dumpApkManifest,
  parseXmltree,
  apkPackage,
  apkDevClientFacts,
  androidDevClientScheme,
  noDeviceDiagnostic,
  displayPath,
} from './android/support.ts';

export { formatDuration, phaseLine, shortHash } from '../command-output.ts';

interface AndroidCommandOptions {
  json?: boolean;
  metroCheck?: boolean;
  buildCache?: boolean;
  variant?: string;
  systemImage?: string;
  remote?: RemoteDeviceBackend;
  device?: string | boolean;
  wait?: string | boolean;
}

const FALLBACK_LINES = 5;

export default function androidCommand(program: Command): void {
  registerAndroid(program);
}

export function registerAndroid(program: Command): void {
  program
    .command('android')
    .description(
      "Build (or install from the shared cache), install and launch this workspace's Android app on its owned " +
        'emulator, wired to the reserved Metro port. Never starts the bundler -- run `stim start` first.',
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
      '--system-image <id>',
      "Android system image to create this workspace's owned AVD from, as the sdkmanager package id " +
        '(e.g. "system-images;android-36;google_apis;arm64-v8a"). Overrides the android.systemImage setting for this ' +
        'invocation. An unknown id refuses with STIM_BAD_ARG and prints the installed images.',
    )
    .option(
      '--device [serial]',
      "Install and launch on a connected physical device instead of this workspace's owned emulator. " +
        'With no serial, the first connected device this workspace can lease is used. Stim never creates, boots, or deletes a physical device.',
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
      'How long to wait for another workspace to release the device it leases, before refusing with STIM_DEVICE_BUSY (default 60, 0 refuses at once). Only with --device.',
    )
    .option(
      '--no-wait',
      "Install on a device another workspace leases instead of waiting: this run takes no lease and, when both workspaces build the same app id, the install terminates the holder's running app. Only with --device.",
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
        systemImage: opts.systemImage ?? null,
        remoteDevice: opts.remote ?? null,
        device: opts.device ?? null,
        wait: opts.wait,
        waitConflict: waitFlagConflict(process.argv),
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
  systemImage?: string | null;
  listSystemImages?: typeof listInstalledSystemImages;
  device?: string | boolean | null;
  wait?: string | boolean;
  waitConflict?: boolean;
  acquireLease?: typeof acquireRunLease;
  makeRunLease?: typeof runLease;
  selectPool?: typeof selectFromPool;
  onLeaseSignal?: typeof releaseLeaseOnSignal;
  listDevices?: typeof listAdbDevices;
  deviceModel?: typeof physicalDeviceModel;
  isEmulatorDevice?: typeof probeEmulatorSerial;
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
  verifyCollector?: typeof verifyCollectorOwnership;
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
  resolveCacheProvider?: typeof resolveCacheProviderConfig;
  loadCacheProviderModule?: typeof loadCacheProvider;
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
  writeLaunch?: typeof writeWorkspaceLaunch;
  writeState?: typeof writeWorkspaceState;
  recordStats?: typeof recordRunStats;
  readEstimates?: typeof readRunEstimates;
  now?: () => number;
  out?: (line: string) => void;
  emit?: (line: string) => void;
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
    systemImage: systemImageFlag = null,
    device: deviceFlag = null,
    wait: waitFlag = undefined,
    waitConflict = false,
    acquireLease = acquireRunLease,
    makeRunLease = runLease,
    selectPool = selectFromPool,
    onLeaseSignal = releaseLeaseOnSignal,
    listDevices = listAdbDevices,
    deviceModel = physicalDeviceModel,
    isEmulatorDevice = probeEmulatorSerial,
    readApkPackage = (apkPath: string | null) => apkPackage(dumpApkManifest(apkPath)),
    getLimits = getConcurrencyLimits,
    checkCapacity = checkDeviceCapacity,
    acquireSlot = acquireBuildSlot,
    releaseSlot = releaseBuildSlot,
    ensureDevice = ensureOwnedDevice,
    listSystemImages = listInstalledSystemImages,
    ensureDeviceBooted = ensureBooted,
    resolveMetro = resolveProjectMetro,
    resolveMetroRetrying = resolveMetroWithRetry,
    readState = readWorkspaceState,
    pidAlive = isPidAlive,
    verifyCollector = verifyCollectorOwnership,
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
    resolveCacheProvider = resolveCacheProviderConfig,
    loadCacheProviderModule = loadCacheProvider,
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
    writeLaunch = writeWorkspaceLaunch,
    writeState = writeWorkspaceState,
    recordStats = recordRunStats,
    readEstimates = readRunEstimates,
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
    systemImageFlag,
    deviceFlag,
    waitFlag,
    waitConflict,
    acquireLease,
    makeRunLease,
    selectPool,
    onLeaseSignal,
    listDevices,
    deviceModel,
    isEmulatorDevice,
    readApkPackage,
    getLimits,
    checkCapacity,
    acquireSlot,
    releaseSlot,
    ensureDevice,
    listSystemImages,
    ensureDeviceBooted,
    resolveMetro,
    resolveMetroRetrying,
    readState,
    pidAlive,
    verifyCollector,
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
    resolveCacheProvider,
    loadCacheProviderModule,
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
    writeLaunch,
    writeState,
    recordStats,
    readEstimates,
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
    systemImageFlag,
    deviceFlag,
    waitFlag,
    waitConflict,
    acquireLease,
    makeRunLease,
    selectPool,
    onLeaseSignal,
    listDevices,
    deviceModel,
    isEmulatorDevice,
    readApkPackage,
    getLimits,
    checkCapacity,
    acquireSlot,
    releaseSlot,
    ensureDevice,
    listSystemImages,
    ensureDeviceBooted,
    resolveMetro,
    resolveMetroRetrying,
    readState,
    pidAlive,
    verifyCollector,
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
    resolveCacheProvider,
    loadCacheProviderModule,
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
    writeLaunch,
    writeState,
    recordStats,
    readEstimates,
    now,
    out,
    emit,
  } = resolveRunAndroidOptions(options);
  const started = now();
  const startedAt = new Date(started).toISOString();
  try {
    await ensureStorage(root, { note: out });
  } catch (error) {
    const code = (error as Error & { code?: string })?.code || 'STIM_WORKSPACE_STATE';
    const message = `Could not prepare this workspace's Stim state: ${(error as Error)?.message || error}`;
    const remedy =
      'Check that STIM_HOME is writable and has free space. An EPERM on a directory you can write is a sandbox: allow writes to STIM_HOME, or run Stim with the sandbox disabled (`stim guide errors`).';
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

  const stats = createRunRecorder({
    platform: PLATFORM,
    write: recordStats,
    now,
    note: (line) => out(phaseLine('stats', chalk.dim(line))),
  });
  const recordRun = stats.record;

  const fail = (
    code: string | undefined,
    message?: string | null,
    remedy?: string | null,
    { lastBuildStatus = false, diagnostics = [], lines = [], logPath = null, lease }: FailExtra = {},
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
    recordRun({ failed: true, durationMs: now() - started });
    if (json) {
      emit(JSON.stringify({ code, message, remedy: remedy ?? null, ...(lease === undefined ? {} : { lease }) }));
    }
    writer.close();
    return { ok: false, error: { code, message, remedy: remedy ?? null } };
  };

  const settingsRepoRoot = repoRoot(root);
  const settingsRoot = settingsRepoRoot ?? root;
  const settingsContext = {
    projectPath: root,
    gitCommonDir: gitCommonDir(root),
    repoRoot: settingsRepoRoot,
  };
  const projectKey = statsProjectKey({ root, commonDir: settingsContext.gitCommonDir, repoRoot: settingsRepoRoot });
  stats.setProject(projectKey);
  let estimatesRead: RunEstimates | null = null;
  const estimates = (): RunEstimates => (estimatesRead ??= readEstimates({ projectKey, platform: PLATFORM }));
  const settings = resolveSettingsFor(settingsContext);
  const [shapeError, ...moreShapeErrors] = settingShapeErrors(settings);
  if (shapeError) {
    return fail('STIM_BAD_ARG', shapeError, SETTING_SHAPE_REMEDY, { lines: moreShapeErrors });
  }
  for (const key of unknownSettingKeys(settings)) {
    out(phaseLine('setting', chalk.yellow(`Warning: setting "${key}" is not read by Stim and will be ignored.`)));
  }
  const cacheProviderConfig = resolveCacheProvider(settingsContext);
  const cacheProviderError = cacheProviderSettingError(settings);
  if (cacheProviderError) out(phaseLine('cache', chalk.yellow(`${cacheProviderError} Using the local cache.`)));
  const dataPartitionSizeError = androidDataPartitionSizeGbSettingError(settings);
  if (dataPartitionSizeError) {
    return fail(
      'STIM_BAD_ARG',
      dataPartitionSizeError,
      'Set android.dataPartitionSizeGb to a whole number of GiB from 6 through 16384.',
    );
  }
  const avdConfigError = androidAvdConfigSettingError(settings, settingsRoot);
  if (avdConfigError) {
    return fail(
      'STIM_BAD_ARG',
      avdConfigError,
      'Use only documented android.avdConfig keys, or an android.avdConfigFile fragment contained by the repository/project settings root.',
    );
  }
  const remoteSettingError = remoteDeviceSettingError(settings);
  if (remoteSettingError) {
    return fail(
      'STIM_BAD_ARG',
      remoteSettingError,
      `Set ios.remote and android.remote to one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}.`,
    );
  }
  const systemImage = resolveSystemImage(systemImageFlag, settings);
  const variant = resolveVariant(variantFlag, settings);
  const flavorRefusal = productFlavorRefusal({ flavors: readProductFlavors(root), variant });
  if (flavorRefusal) return fail(flavorRefusal.code, flavorRefusal.reason, flavorRefusal.remedy);
  const release = isReleaseVariant(variant);
  const isExpo = detectIsExpo(root);
  const physical = deviceFlag !== null && deviceFlag !== undefined && deviceFlag !== false;
  if (physical && deviceFlag === '') {
    return fail(
      'STIM_BAD_ARG',
      '--device was given an empty serial.',
      'Pass `--device` on its own to take the first connected device this workspace can lease, or ' +
        '`--device <serial>` to name one.',
    );
  }
  if (physical && commandRemoteBackend) {
    return fail(
      'STIM_BAD_ARG',
      '--device installs on a device connected to this machine, and --remote installs on a remote one.',
      'Pass only one of --device and --remote.',
    );
  }
  const noWait = waitFlag === false;
  const waitFlagged = waitFlag !== undefined;
  if (waitConflict) {
    return fail(
      'STIM_BAD_ARG',
      '--wait and --no-wait ask for opposite things.',
      'Pass `--wait <seconds>` to wait for the lease, or `--no-wait` to install without one.',
    );
  }
  if (waitFlagged && !physical) {
    return fail(
      'STIM_BAD_ARG',
      '--wait and --no-wait only apply to a `--device` run.',
      'This workspace owns its emulator, so nothing contends for it. Drop the flag, or pass `--device`.',
    );
  }
  const waitParsed = parseDeviceWait(noWait ? undefined : waitFlag);
  if ('error' in waitParsed) {
    return fail(
      'STIM_BAD_ARG',
      waitParsed.error,
      'Pass a whole number of seconds, e.g. --wait 90. `--wait 0` refuses a leased device at once.',
    );
  }
  const waitSeconds = waitParsed.seconds;

  const remoteBackend = physical ? null : (commandRemoteBackend ?? remoteAndroidSetting(settings));
  const imageRefusal = systemImageRefusal({
    flag: systemImageFlag,
    resolved: systemImage,
    physical,
    remoteBackend,
    listImages: listSystemImages,
  });
  if (imageRefusal) return fail(imageRefusal.code, imageRefusal.message, imageRefusal.remedy);
  const requestedSerial = typeof deviceFlag === 'string' ? deviceFlag : null;
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
          'Run `stim start` first, or pass --no-metro-check.',
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

  const emuLog = emulatorLogFile(root);
  const limits = getLimits();
  let device: OwnedDeviceRecord;
  let bootDuration = '';
  let bootPromise: Promise<AndroidBootLike>;

  if (physical && !requestedSerial) {
    const pooled = await pooledAndroidDevice({
      root,
      selectPool,
      listDevices,
      isEmulatorDevice,
      deviceModel,
      waitSeconds,
      noWait,
      now,
      warn: (line: string) => out(phaseLine('lease', chalk.yellow(line))),
    });
    if ('code' in pooled) return fail(pooled.code, pooled.message, pooled.remedy, pooled.extra);
    device = pooled.device;
    bootPromise = Promise.resolve({ ok: true, serial: pooled.device.serial });
  } else if (physical) {
    const resolved = resolvePhysicalDevice(requestedSerial, listDevices(), isEmulatorDevice);
    if (!resolved.serial) return fail(NO_DEVICE, resolved.error!, resolved.remedy!);
    device = {
      serial: resolved.serial,
      deviceName: deviceModel(resolved.serial) ?? resolved.serial,
      owned: false,
    };
    bootPromise = Promise.resolve({ ok: true, serial: resolved.serial });
  } else {
    const capacity = checkCapacity({
      platform: PLATFORM,
      project,
      max: limits.maxDevices,
    });
    if (capacity) return fail(capacity.code, capacity.message, capacity.remedy);

    const prepare = stepClock(now);
    try {
      device = await ensureDevice({
        platform: PLATFORM,
        project,
        projectPath: root,
        settingsRoot,
        label,
        settings,
        flags: { systemImage },
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
    const prepareMs = prepare();
    if (device.created || prepareMs >= SLOW_STEP_MS) {
      phase(
        'device',
        `${device.avdName || device.deviceName || label} ${device.created ? 'created' : 'prepared'} (${formatDuration(prepareMs)})`,
      );
    }

    const bootTimer = stepTimer(now);
    const boot = (): Promise<AndroidBootLike> =>
      Promise.resolve(ensureDeviceBooted({ platform: PLATFORM, device, out, logFile: emuLog })).catch((e) => ({
        failed: true as const,
        reason: String((e as Error)?.message || e),
        serial: undefined,
      }));
    bootPromise = (
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
  }

  if (remoteDevice) {
    const booted = await bootPromise;
    if (booted.failed) {
      if (booted.code) {
        return fail(booted.code, booted.reason ?? 'The remote device did not boot.', booted.remedy ?? null);
      }
      const diag = noDeviceDiagnostic({
        reason: booted.reason ?? 'The remote device did not boot.',
        logFile: emuLog,
        remedy: 'Run `stim status` to inspect the remote device, then retry the command.',
        localEmulator: false,
      });
      return fail(NO_DEVICE, diag.message, diag.remedy, {
        lines: diag.lines,
        logPath: diag.logPath ? displayPath(root, diag.logPath) : null,
      });
    }
  }
  record.avdName = device.avdName ?? null;
  record.deviceName = device.deviceName ?? device.avdName ?? null;
  record.systemImage = device.systemImage;

  let hash = '';
  let providerUpload: Promise<ProviderCallResult<void>> | null = null;
  let providerName: string | null = null;
  let providerLoad: Promise<LoadCacheProviderResult> | null = null;
  const cacheWarn = createWarnOnce((line) => phase('cache', chalk.yellow(line)));
  const loadTieredProvider = cacheProviderConfig
    ? () => (providerLoad ??= loadCacheProviderModule({ projectRoot: root, config: cacheProviderConfig }))
    : null;
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
    stats.setCacheKey(cacheKey);
    record.cacheKey = cacheKey;
    storeHash = hash;
    storeKey = cacheKey;
    storeSources = fingerprintSources;

    const found = await resolveTieredBuild({
      local: filesystemBuildCapability({ resolve: resolveCached, store: storeCached, sources: fingerprintSources }),
      loadProvider: loadTieredProvider,
      target: { projectRoot: root, platform: PLATFORM, key: cacheKey },
      destinationDir: providerDownloadPath(workspaceDir(root)),
      ensureDestination: prepareProviderDownloadDir,
      skipRead: !useBuildCache,
      warn: cacheWarn,
    });
    const cached = found?.tier === 'local' ? found.path : null;
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
    if (found?.tier === 'provider') {
      record.cacheHit = 'remote';
      providerName = found.providerName ?? null;
      phase('cache', `provider hit (${providerName})${found.storedLocally ? ' -> stored locally' : ''}`);
    }
    apkPath = found?.path ?? null;
    return true;
  }

  const runFromFingerprint = async (): Promise<RunAndroidResult> => {
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
            chalk.yellow(
              `${remote.name} did not answer within ${formatDuration(RESOLVE_TIMEOUT_MS)}; building instead`,
            ),
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
            if (wtErr?.code !== 'STIM_BUILD_WAIT_TIMEOUT') throw err;
            phaseFailure = fail(
              'STIM_BUILD_WAIT_TIMEOUT',
              wtErr.message,
              `Check pid ${holder.pid}; if it is not really building, remove ${wtErr.lockPath} and run \`stim android\` again.`,
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
      phase('swap', `regenerating this workspace's JS for the cached ${variant} APK`);
      const swap = await swapApk({
        root,
        isExpo,
        cachedApkPath: cachedPath,
        keystore: resolveKeystore(root, settings),
        logWriter: writer,
        storedAssets: storedAssets(PLATFORM, key),
      });
      if (swap?.ok && swap.apkPath) {
        if (swap.note) phase('swap', chalk.yellow(swap.note));
        swapDir = swap.tmpDir ?? null;
        phase(
          'swap',
          `${swap.hermes ? 'hermes bytecode' : 'plain JS'} repacked (store), zipaligned and re-signed (${formatDuration(swap.durationMs)})`,
        );
        return swap.apkPath;
      }
      if (swap?.assetMismatch) {
        phase(
          'swap',
          chalk.yellow(
            `${swap.reason} -- building fresh instead` +
              (swap.assetDiff ? ' (an APK cannot be made to carry an asset AAPT did not package)' : ''),
          ),
        );
      } else {
        phase(
          'swap',
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
              phase('fingerprint', chalk.dim(`${shortHash(hash)} -> ${shortHash(storeHash)} (after prebuild)`));

              const late = useBuildCache ? resolveCached(PLATFORM, storeKey) : null;
              if (late) {
                const prepared = await installableCachedApk(storeKey, late);
                if (prepared) {
                  apkPath = prepared;
                  record.cacheHit = 'local';
                  phase('cache', `hit ${shortHash(storeHash)} (post-prebuild key)`);
                }
              }
            }
          }

          if (!apkPath) {
            phase('build', `compiling ${variant || 'debug'} with Gradle`);
            const built: BuildAndroidResultLike = await build(
              { root, logWriter: writer, variant },
              { estimateMs: estimates().coldBuildMs },
            );
            if (built.failed) {
              const diagnostics = built.diagnostics || [];
              for (const diag of diagnostics) {
                writer.write({ src: 'build', level: 'error', event: 'gradle_diagnostic', msg: formatDiagnostic(diag) });
              }
              phase('build', chalk.red(`FAILED after ${formatDuration(built.durationMs)}`));
              const extracted = diagnostics.map(formatDiagnostic);
              if ((built.truncated ?? 0) > 0)
                extracted.push(`... and ${built.truncated} more diagnostic(s) in the log`);
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
            stats.setBuildMs(built.durationMs ?? 0);
            phase('build', `ok (${formatDuration(built.durationMs)})`);
            if (built.apkNote) phase('build', chalk.yellow(built.apkNote));

            const beforeBuildHash = storeHash;
            const afterBuild = await refingerprintAfterMutation({
              projectRoot: root,
              platform: PLATFORM,
              previousHash: beforeBuildHash,
              fingerprint,
            });
            if (!afterBuild) {
              record.fingerprint = null;
              record.cacheKey = null;
              phase(
                'fingerprint',
                chalk.yellow('unavailable after Gradle; the build will be installed but not cached'),
              );
            } else {
              if (afterBuild.moved) {
                storeHash = afterBuild.hash;
                storeSources = afterBuild.sources;
                storeKey = buildCacheKey(PLATFORM, afterBuild.hash, variant ? { variant } : {});
                record.fingerprint = storeHash;
                record.cacheKey = storeKey;
                phase(
                  'fingerprint',
                  chalk.dim(`${shortHash(beforeBuildHash)} -> ${shortHash(storeHash)} (after Gradle)`),
                );
              }

              const assetManifest = release ? captureAssets(root, { variant }) : null;
              try {
                const stored = await storeTieredBuild({
                  local: filesystemBuildCapability({
                    resolve: resolveCached,
                    store: storeCached,
                    sources: storeSources,
                    assetManifest,
                  }),
                  loadProvider: loadTieredProvider,
                  target: { projectRoot: root, platform: PLATFORM, key: storeKey },
                  sourcePath: apkPath!,
                  overwrite: !useBuildCache || swapFellBack,
                  warn: cacheWarn,
                });
                providerUpload = stored.providerUpload;
                providerName = stored.providerName ?? providerName;
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
      } catch (err) {
        out(phaseLine('lease', chalk.dim(`could not release this run's lease: ${(err as Error)?.message || err}`)));
      }
    };
    if (physical) {
      const acquired = await acquireLease({
        root,
        platform: PLATFORM,
        id: device.serial!,
        deviceName: device.deviceName ?? null,
        idLabel: 'serial',
        waitSeconds,
        noWait,
        installBoundMs: ADB_INSTALL_TIMEOUT_MS,
        appId: androidPackage,
        holderAppId: (holder: string) => getProject(holder)?.androidPackage ?? null,
        now,
        warn: (line: string) => out(phaseLine('lease', chalk.yellow(line))),
      });
      if (acquired.status === 'refused') {
        return fail(acquired.refusal.code, acquired.refusal.message, acquired.refusal.remedy, {
          lease: acquired.refusal.lease,
        });
      }
      leaseHandle = makeRunLease({
        root,
        platform: PLATFORM,
        kind: acquired.status === 'leased' ? acquired.kind : null,
        expiresAt: acquired.status === 'leased' ? acquired.expiresAt : null,
      });
      if (acquired.status === 'leased') {
        stopLeaseSignals = onLeaseSignal(releaseLease);
        phase(
          'lease',
          `${acquired.kind} lease on ${device.serial} until ${leaseExpiryText(acquired.expiresAt, now())}`,
        );
      }
    }

    try {
      return await finishAndroidRun({
        lease: leaseHandle,
        releaseLease,
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
        physical,
        remoteDevice,
        bootPromise,
        bootDuration: () => bootDuration,
        apkPath,
        androidPackage,
        swapDir,
        record,
        waitedForBuild,
        uploadPending,
        providerUpload,
        providerName,
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
        pidAlive,
        verifyCollector,
        writeLaunch,
        writeState,
        now,
        out,
        emit,
        recordRun,
      });
    } finally {
      releaseLease();
    }
  };

  try {
    return await runFromFingerprint();
  } catch (error) {
    recordRun({ failed: true, durationMs: now() - started });
    throw error;
  }
}

function tail(lines: unknown, n = FALLBACK_LINES): string[] {
  return (Array.isArray(lines) ? lines : []).slice(-n);
}
