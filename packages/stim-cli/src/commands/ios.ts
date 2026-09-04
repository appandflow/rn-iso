import { rmSync } from 'node:fs';
import { type Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import {
  createWarnOnce,
  resolveTieredBuild,
  storeTieredBuild,
  type LoadCacheProviderResult,
  type ProviderCallResult,
} from '@stim-cli/cache';
import type { FingerprintSource } from '@expo/fingerprint';
import { formatDuration, phaseLine, shortHash, SLOW_STEP_MS, stepClock, stepTimer } from '../command-output.ts';
import { waitFlagConflict, leaseExpiryText, parseDeviceWait, type RunLease } from '../engine/device-lease-run.ts';
import type { RemoteDeviceBackend, CacheHitLevel, CompilationCacheActivity, IosFacts } from '../types.ts';
import {
  REMOTE_DEVICE_BACKENDS,
  cacheProviderSettingError,
  iosLanHostSetting,
  iosLanHostSettingError,
  iosSigningIdentitySetting,
  iosSigningIdentitySettingError,
  iosSigningIdentitySha1Setting,
  iosSigningIdentitySha1SettingError,
  publicUrlSetting,
  remoteDeviceSettingError,
  remoteIosSetting,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
  tunnelModeSetting,
  unknownSettingKeys,
} from '../settings.ts';
import type {
  IosCommandOptions,
  IosBootLike,
  RemoteUploadLike,
  BuildIosResultLike,
  WaitedForBuild,
  FailArgs,
  BuildFailureFields,
} from './ios/types.ts';
import { type IosDeps, DEFAULT_DEPS } from './ios/dependencies.ts';
import {
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
import { DEFAULT_METRO_PORT } from '../engine/app-install.ts';
import { takeoverLine, type BuildLockHandle, type WaitForBuildResult } from '../engine/build-lock.ts';
import type { BuildSlotHandle } from '../engine/build-slots.ts';
import { ensureOwnedDevice } from '../engine/device.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from '../sim-pool.ts';
import { REMOTE_SESSION_ERROR, binOnPath } from '../engine/device-remote.ts';
import {
  DEVICECTL_INSTALL_TIMEOUT_MS,
  iosPoolCandidates,
  iosPoolNoCandidatesRefusal,
  resolveIosPhysicalDevice,
} from '../engine/ios-device.ts';
import { chooseLanAddress, copyAppAside, lanOriginUrlFor, writeIpTxt } from '../engine/ios-lan.ts';
import { ownedSessionName } from '../engine/eas-simulator.ts';
import {
  RESOLVE_TIMEOUT_MS,
  easAuthNote,
  isEasAuthFailureText,
  type LoadProjectProviderResult,
} from '../engine/remote-cache.ts';
import { createRunRecorder, statsProjectKey, type RunEstimates } from '../engine/stats.ts';
import { COMPILATION_CACHE_NOT_RUN, COMPILATION_CACHE_UNAVAILABLE } from '../engine/xcode.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { workspaceDir, workspaceLogsDir } from '../paths.ts';
import { type SupervisorLike, noMetroMessage, noMetroRemedy } from './native-runtime.ts';
import {
  PLATFORM,
  buildLogFile,
  deviceLabel,
  resolveConfiguration,
  resolveDeviceType,
  resolveRuntime,
  deviceModelRefusal,
  isReleaseConfiguration,
  podAction,
  xcodeFailureReport,
  printDiagnostics,
} from './ios/support.ts';
import { lastBuildRecord, writeLastBuild } from './ios/result.ts';
import { finishIosRun } from './ios/launch.ts';

export { lastBuildRecord, iosFacts, writeLastBuild, cacheDescription } from './ios/result.ts';

export { devClientScheme, schemesFromInfoPlist, readBundleSchemes, pickDevClientScheme } from './dev-client.ts';

export { collectorLogFile, collectorEntry, stopPreviousCollector, replaceCollector } from './ios/collector.ts';

export {
  GATE_RETRY_DELAYS_MS,
  gateShouldRetry,
  resolveMetroWithRetry,
  noMetroMessage,
  noMetroRemedy,
  ensureWorkspaceStorageSafely,
  launchOutcomeRecord,
} from './native-runtime.ts';

export {
  PLATFORM,
  buildLogFile,
  deviceLabel,
  deviceShortName,
  appNameFromPath,
  iosConfigurationSetting,
  resolveConfiguration,
  resolveDeviceType,
  resolveRuntime,
  isReleaseConfiguration,
  podAction,
  xcodeFailureReport,
} from './ios/support.ts';

export {
  formatDuration,
  phaseLine,
  shortHash,
  shortUdid,
  SLOW_STEP_MS,
  stepClock,
  stepTimer,
} from '../command-output.ts';

function writeNote(line: string): void {
  console.error(line);
}

function writePhase(name: unknown, text: string): void {
  console.error(phaseLine(name, text));
}

// xcodebuild cannot target a remote simulator UDID, so remote builds use the generic destination.
const GENERIC_SIM_DESTINATION = 'generic/platform=iOS Simulator';

const IPHONEOS_SDK = 'iphoneos';

const PROVIDER_SKIPPED_ON_DEVICE =
  'a device build is local-tier only: its cache key names the iphoneos slice, and a remote or provider entry is keyed for the simulator';

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
  let storeHash = '';
  let storeKey = '';
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
          if (after?.moved) {
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

          try {
            const stored = await storeTieredBuild({
              local: filesystemBuildCapability({ resolve: d.resolveBuild, store: d.storeBuild, sources: storeSources }),
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

          if (physical) {
            const prepared = await prepareDeviceApp(appPath!, { fresh: true });
            if (!prepared) return false;
            appPath = prepared;
          }

          if (remote && !physical) {
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
