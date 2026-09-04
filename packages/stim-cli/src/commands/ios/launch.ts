import { basename } from 'node:path';
import { rmSync } from 'node:fs';
import chalk from 'chalk';
import type { ProviderCallResult } from '@stim-cli/cache';
import {
  DEFAULT_METRO_PORT,
  LAUNCH_BUNDLING,
  LAUNCH_FATAL,
  LAUNCH_UNVERIFIED,
  devClientUrl,
  iosAppProcess,
  readCollectorRecords,
  unverifiedLaunchLines,
  RELEASE_VERIFY_WAIT_MS,
} from '../../engine/app-install.ts';
import type { IosDeps } from './dependencies.ts';
import {
  formatDuration,
  phaseLine,
  launchErrorReport,
  type LaunchErrorRecord,
  stepTimer,
} from '../../command-output.ts';
import { localNetworkPending, DEVICECTL_INSTALL_TIMEOUT_MS, LAUNCH_PROBE_TIMEOUT_MS } from '../../engine/ios-device.ts';
import { MODE_BARE, MODE_EXPO } from '../../supervisor/state.ts';
import type {
  VerifyLaunchResultLike,
  DeviceLike,
  IosBootLike,
  RemoteUploadLike,
  WaitedForBuild,
  FailArgs,
  BuildFailureFields,
} from './types.ts';
import { PLATFORM, deviceLabel, deviceShortName, appNameFromPath } from './support.ts';
import { type RunLease, DEBUG_VERIFY_STEP_MS, lostLine, lostRefusal } from '../../engine/device-lease-run.ts';
import { type LoadProjectProviderResult, exitAfterFlush } from '../../engine/remote-cache.ts';
import type { CacheHitLevel, CompilationCacheActivity, IosFacts } from '../../types.ts';
import type { NdjsonWriter } from '../../ndjson.ts';
import { type ReportIosResultArgs, finishIosUpload, reportIosResult } from './result.ts';
import { providerUploadOutcome } from '../../build-cache.ts';
import { launchOutcomeRecord } from '../native-runtime.ts';
import { COLLECTOR_EXIT_WAIT_MS } from './collector.ts';

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
  storeHash: string;
  storeKey: string;
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

export async function finishIosRun({
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
