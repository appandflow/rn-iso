import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import chalk from 'chalk';
import type { ProviderCallResult } from '@stim-cli/cache';
import {
  verifyAndroidReleaseLaunch,
  verifyLaunch,
  DEFAULT_METRO_PORT,
  LAUNCH_BUNDLING,
  LAUNCH_FATAL,
  LAUNCH_UNVERIFIED,
  androidDevClientUrl,
  unverifiedLaunchLines,
  androidAppProcess,
  installAndroidApp,
  launchAndroidApp,
  launchAndroidReleaseApp,
  ADB_INSTALL_TIMEOUT_MS,
  RELEASE_VERIFY_WAIT_MS,
  installConflictKind,
} from '../../engine/app-install.ts';
import { formatDuration, launchErrorReport, phaseLine, stepTimer } from '../../command-output.ts';
import { MODE_BARE, MODE_EXPO, writeWorkspaceLaunch, writeWorkspaceState } from '../../supervisor/state.ts';
import type {
  VerifyLaunchResultLike,
  RemoteUploadLike,
  FailExtra,
  AndroidRecord,
  RunAndroidResult,
  AndroidBootLike,
  AndroidWriter,
  InstallResultLike,
  LaunchResultLike,
} from './types.ts';
import {
  PLATFORM,
  androidDevClientScheme,
  NO_DEVICE,
  INSTALL_FAILED,
  LAUNCH_FAILED,
  noDeviceDiagnostic,
  displayPath,
} from './support.ts';
import type { WaitedForBuild } from '../../types.ts';
import { verifyCollectorOwnership } from '../../collector/ownership.ts';
import { isPidAlive } from '../../metro.ts';
import type { OwnedDeviceRecord } from '../../engine/device.ts';
import { remoteAndroidDeps } from '../../engine/device-remote.ts';
import { type RunLease, DEBUG_VERIFY_STEP_MS, lostLine, lostRefusal } from '../../engine/device-lease-run.ts';
import { type LoadProjectProviderResult, exitAfterFlush } from '../../engine/remote-cache.ts';
import { type ReportAndroidResultArgs, finishAndroidUpload, reportAndroidResult, persistLastBuild } from './result.ts';
import { upsertProject } from '../../config.ts';
import { providerUploadOutcome } from '../../build-cache.ts';
import { detectAndroidPackage } from '../../project.ts';
import { launchOutcomeRecord } from '../native-runtime.ts';
import { startCollector } from './collector.ts';

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
  physical: boolean;
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
  physical,
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
    if (processCheck?.reason === 'probe-failed') {
      phase('verify', chalk.yellow('UNVERIFIED: the app process check failed'));
      return LAUNCH_UNVERIFIED;
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
        'A release app that dies at startup usually crashed loading its embedded bundle; `stim logs --errors` has the device log that says why.',
      ),
    );
    return LAUNCH_FATAL;
  }

  const verification: VerifyLaunchResultLike = metroCheck
    ? await verifyLaunched({
        logsDir,
        since: launchedAt,
        metroPort,
        platform: 'android',
        mode: isExpo ? MODE_EXPO : MODE_BARE,
        processAlive: () => {
          const pid = androidAppProcess(serial, androidPackage);
          return pid === undefined ? null : pid !== null;
        },
      })
    : { verified: false, skipped: true };
  if (verification?.fatal) {
    const reason = verification.processAlive === false ? 'the app process exited' : 'Metro could not build the bundle';
    phase('verify', chalk.red(`FATAL after ${formatDuration(verification.waitedMs ?? 0)}: ${reason}`));
    for (const record of verification.errors ?? []) {
      if (record.msg) phase('', chalk.red(String(record.msg)));
    }
    if (verification.processAlive === false) {
      phase(
        'remedy',
        chalk.yellow('Fix the crash, then run `stim android` again. A Metro reload cannot restart an exited app.'),
      );
    } else if (verification.processAlive === true && metroPort !== null) {
      phase(
        'remedy',
        chalk.yellow(
          `The native app is still running. Fix the JavaScript or TypeScript error, then run ${physical ? `\`agent-device metro reload --metro-port ${metroPort}\`` : '`stim reload android`'}. Do not run \`stim android\` unless native inputs changed or the app process exits.`,
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
    const report = launchErrorReport(verification.errors ?? []);
    if (report.summary) phase('launch', chalk.dim(report.summary));
    for (const line of report.lines) phase('launch', chalk.yellow(line));
    if (report.lines.length > 0 && verification.processAlive === true && metroPort !== null) {
      phase(
        'remedy',
        chalk.yellow(
          `The native app is still running. Fix the JavaScript or TypeScript error; Fast Refresh should apply the edit. If the error screen remains, run ${physical ? `\`agent-device metro reload --metro-port ${metroPort}\`` : '`stim reload android`'}. Do not run \`stim android\` unless native inputs changed or the app process exits.`,
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
    phase(
      '',
      chalk.dim('Nothing to do: `stim logs --source metro` shows the build finishing, usually within a minute.'),
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
    devClientUrl: scheme ? androidDevClientUrl(scheme, metroPort ?? DEFAULT_METRO_PORT, physical) : null,
    mode: isExpo ? MODE_EXPO : MODE_BARE,
  }))
    phase('', chalk.yellow(line));
  return LAUNCH_UNVERIFIED;
}

interface FinishAndroidRunArgs {
  lease: RunLease | null;
  releaseLease: () => void;
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
  physical: boolean;
  remoteDevice: ReturnType<typeof remoteAndroidDeps> | null;
  bootPromise: Promise<AndroidBootLike>;
  bootDuration: () => string;
  apkPath: string | null;
  androidPackage: string | null;
  swapDir: string | null;
  record: AndroidRecord;
  waitedForBuild: WaitedForBuild | null;
  uploadPending: Promise<RemoteUploadLike> | null;
  providerUpload: Promise<ProviderCallResult<void>> | null;
  providerName: string | null;
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
  pidAlive: typeof isPidAlive;
  verifyCollector: typeof verifyCollectorOwnership;
  writeLaunch: typeof writeWorkspaceLaunch;
  writeState: typeof writeWorkspaceState;
  now: () => number;
  out: (line: string) => void;
  emit: (line: string) => void;
  recordRun: ReportAndroidResultArgs['recordRun'];
}

export async function finishAndroidRun({
  lease,
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
  bootDuration,
  apkPath,
  androidPackage: initialPackage,
  swapDir,
  record,
  waitedForBuild,
  uploadPending,
  providerUpload,
  providerName,
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
  pidAlive,
  verifyCollector,
  writeLaunch,
  writeState,
  now,
  out,
  emit,
  recordRun,
}: FinishAndroidRunArgs): Promise<RunAndroidResult> {
  let androidPackage = initialPackage;
  let leaseWarned = false;
  const raiseLeaseFor = (boundMs: number, beforeInstall: boolean): RunAndroidResult | null => {
    const step = lease?.raise(boundMs);
    if (!step || step.ok) return null;
    if (beforeInstall) {
      const refusal = lostRefusal(step.holder, step.expiresAt, now());
      return fail(refusal.code, refusal.message, refusal.remedy, { lease: refusal.lease });
    }
    if (!leaseWarned) {
      leaseWarned = true;
      phase('lease', chalk.yellow(lostLine(step.holder, step.expiresAt, now())));
    }
    return null;
  };

  const booted = await bootPromise;
  if (booted.failed) {
    const diag = noDeviceDiagnostic({
      reason: booted.reason ?? 'The emulator did not boot.',
      logFile: emuLog,
      remedy: 'Run `stim status` to see what Stim thinks it owns; re-running `stim android` creates a fresh owned AVD.',
      localEmulator: !physical,
    });
    return fail(NO_DEVICE, diag.message, diag.remedy, {
      lines: diag.lines,
      logPath: diag.logPath ? displayPath(root, diag.logPath) : null,
    });
  }
  const serial = booted.serial!;
  phase(
    'device',
    physical
      ? `${device.deviceName || serial} (${serial}) connected, not owned by Stim`
      : `${device.avdName || serial} (${serial}) booted ${bootDuration()}`,
  );

  const packageFromApk = readApkPackage(apkPath);
  if (packageFromApk && androidPackage && packageFromApk !== androidPackage) {
    phase('install', chalk.dim(`applicationId ${packageFromApk} (from the APK; project files say ${androidPackage})`));
  }
  androidPackage = packageFromApk || androidPackage || detectAndroidPackage(root);

  const lostBeforeInstall = physical ? raiseLeaseFor(ADB_INSTALL_TIMEOUT_MS, true) : null;
  if (lostBeforeInstall) return lostBeforeInstall;
  const installTimer = stepTimer(now);
  const installed: InstallResultLike = install({
    serial,
    apkPath: apkPath!,
    packageName: androidPackage,
    allowUninstall: release,
  });
  if (installed.failed) {
    const conflict = installConflictKind(installed.reason);
    const rerun = useBuildCache
      ? ' Then run this command again; it installs the APK from cache without building it again.'
      : ' Then run this command again.';
    const installRemedy = conflict
      ? `${androidPackage} is already installed on ${serial} ` +
        (conflict === 'signature' ? 'with a different signer' : 'at a higher versionCode') +
        `. Uninstall it first (\`adb -s ${serial} uninstall ${androidPackage}\`); its data goes with it.` +
        rerun
      : `Check that ${serial} is still connected (\`adb devices\`) and has room for the APK.`;
    return fail(installed.code || INSTALL_FAILED, installed.reason, installRemedy, { lastBuildStatus: true });
  }
  const installSkipped = Boolean(installed.skipped);
  phase(
    'install',
    installSkipped
      ? `unchanged (${serial} already has this build) ${installTimer()}`
      : `${basename(apkPath!)} -> ${serial} ${installTimer()}`,
  );
  if (installed.note) {
    phase('install', chalk.yellow(installed.note));
    writer.write({ src: 'build', level: 'warn', event: 'install_uninstalled_first', msg: installed.note });
  }
  if (swapDir) {
    try {
      rmSync(swapDir, { recursive: true, force: true });
    } catch {}
  }

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

  if (physical) raiseLeaseFor(0, false);
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
        physical,
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
  phase('launch', `${androidPackage} ${launchTimer()}`);

  if (!physical && !remoteDevice) {
    const deepLinkUrl = scheme ? androidDevClientUrl(scheme, metroPort ?? DEFAULT_METRO_PORT) : null;
    try {
      writeLaunch(root, 'android', {
        appId: androidPackage,
        deviceId: serial,
        metroPort,
        release,
        deepLinkUrl,
        launchedAt: new Date(launchedAt).toISOString(),
      });
    } catch (error) {
      out(phaseLine('state', chalk.yellow(`could not record Android launch: ${(error as Error)?.message || error}`)));
    }
  }

  const reversedSummary = (launched.reversed ?? []).join(', ') || `tcp:${metroPort}->tcp:${metroPort}`;
  if (!release && launched.debugHttpHost) {
    phase('metro', `debug_http_host ${launched.debugHttpHost} + adb reverse ${reversedSummary}`);
  } else if (!release) {
    phase(
      'metro',
      chalk.yellow(`adb reverse ${reversedSummary}; ${launched.debugHttpHostNote || 'debug_http_host not written'}`),
    );
    writer.write({
      src: 'build',
      level: 'warn',
      event: 'debug_http_host_failed',
      msg: `debug_http_host was not written for ${androidPackage} on ${serial}: ${launched.debugHttpHostNote || 'unknown reason'}`,
    });
  }
  if (launched.devClientNote) {
    phase('metro', chalk.yellow(launched.devClientNote));
    writer.write({ src: 'build', level: 'warn', event: 'dev_client_link_failed', msg: launched.devClientNote });
  }

  const uploadWasAbandoned = await finishAndroidUpload(uploadPending, remote, phase);
  const providerOutcome = providerUploadOutcome(providerUpload ? await providerUpload : null, providerName);
  if (providerOutcome) phase('cache', providerOutcome.warn ? chalk.yellow(providerOutcome.line) : providerOutcome.line);

  persistLastBuild({ writeState, root, record, startedAt, durationMs: now() - started, status: 'ok', out });

  const remoteRelease = Boolean(remoteDevice && release);
  if (!remoteRelease) {
    if (physical) raiseLeaseFor(0, false);
    const collectorPid = await startCollector({
      root,
      serial,
      packageName: androidPackage,
      spawn,
      kill,
      alive: pidAlive,
      verify: verifyCollector,
      out,
    });
    phase('logs', `${displayPath(root, logsDir)}${collectorPid ? ` (collector pid ${collectorPid})` : ''}`);
  }

  if (physical) raiseLeaseFor(release ? RELEASE_VERIFY_WAIT_MS : DEBUG_VERIFY_STEP_MS, false);
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
    physical,
    scheme,
    phase,
  });
  if (launchState === LAUNCH_FATAL) {
    return fail(
      LAUNCH_FAILED,
      'The app failed its launch readiness check.',
      `Read the launch error above or run \`stim logs --errors\`. The full timeline is in ${logsDir}.`,
      { lastBuildStatus: true, logPath: displayPath(root, logsDir) },
    );
  }
  writer.write(
    launchOutcomeRecord({ launchState, release, bundleId: androidPackage, configuration: variant, metroPort }),
  );

  const leaseFacts = lease?.facts() ?? null;
  releaseLease();

  const facts = reportAndroidResult({
    json,
    useBuildCache,
    variant,
    release,
    metroCheck,
    metroPort,
    logsDir: remoteRelease ? null : logsDir,
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
    durationMs: now() - started,
    writer,
    emit,
    lease: physical ? leaseFacts : undefined,
    recordRun,
  });
  if (remoteWasAbandoned || uploadWasAbandoned) exitAfterFlush(0);
  return { ok: true, facts };
}
