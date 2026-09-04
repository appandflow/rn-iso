import chalk from 'chalk';
import type { Command } from 'commander';
import { phaseLine } from '../command-output.ts';
import { getProject, type ProjectRecord } from '../config.ts';
import { androidAppProcess, iosAppProcess, openAndroidDevClientUrl } from '../engine/app-install.ts';
import { openIosDeepLink, reloadAndroidJs, reloadIosThroughMetro } from '../engine/reload.ts';
import { resolveProjectMetro, type MetroResolution } from '../metro.ts';
import { findProjectRoot } from '../project.ts';
import { resolveOwnedAvdSerial, type ResolvedAvdSerial } from '../sim/android.ts';
import { resolveOwnedIosSim, type ResolvedIosSim } from '../sim/ios.ts';
import {
  readWorkspaceLaunches,
  type WorkspaceLaunchPlatform,
  type WorkspaceLaunchRecord,
} from '../supervisor/state.ts';

type ReloadPlatform = WorkspaceLaunchPlatform;

interface ReloadFacts {
  platform: ReloadPlatform;
  deviceId: string;
  deviceName: string;
  appId: string;
  metroPort: number;
  strategy: 'deep-link' | 'android-broadcast' | 'metro-websocket';
}

interface ReloadFailure {
  code: string;
  message: string;
  remedy: string | null;
}

type ReloadResult = { ok: true; facts: ReloadFacts } | { ok: false; error: ReloadFailure };

interface LiveTarget {
  platform: ReloadPlatform;
  record: WorkspaceLaunchRecord;
  deviceName: string;
}

interface TargetFailure {
  platform: ReloadPlatform;
  error: ReloadFailure;
}

export interface ReloadDeps {
  findProjectRoot: typeof findProjectRoot;
  getProject: typeof getProject;
  readLaunches: typeof readWorkspaceLaunches;
  resolveIos: (udid: string) => ResolvedIosSim;
  resolveAndroid: (avdName: string) => ResolvedAvdSerial;
  iosProcess: typeof iosAppProcess;
  androidProcess: typeof androidAppProcess;
  resolveMetro: (port: number, root: string) => Promise<MetroResolution>;
  openAndroidUrl: typeof openAndroidDevClientUrl;
  openIosUrl: typeof openIosDeepLink;
  reloadAndroid: typeof reloadAndroidJs;
  reloadIosMetro: typeof reloadIosThroughMetro;
}

const DEFAULT_DEPS: ReloadDeps = {
  findProjectRoot,
  getProject,
  readLaunches: readWorkspaceLaunches,
  resolveIos: resolveOwnedIosSim,
  resolveAndroid: resolveOwnedAvdSerial,
  iosProcess: iosAppProcess,
  androidProcess: androidAppProcess,
  resolveMetro: resolveProjectMetro,
  openAndroidUrl: openAndroidDevClientUrl,
  openIosUrl: openIosDeepLink,
  reloadAndroid: reloadAndroidJs,
  reloadIosMetro: reloadIosThroughMetro,
};

function failure(code: string, message: string, remedy: string | null): ReloadFailure {
  return { code, message, remedy };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processFailure(platform: ReloadPlatform, record: WorkspaceLaunchRecord, d: ReloadDeps): ReloadFailure | null {
  const process =
    platform === 'ios' ? d.iosProcess(record.deviceId, record.appId) : d.androidProcess(record.deviceId, record.appId);
  if (process === undefined) {
    const probe =
      platform === 'ios'
        ? `xcrun simctl spawn ${record.deviceId} launchctl list`
        : `adb -s ${record.deviceId} shell pidof ${record.appId}`;
    return failure(
      'STIM_RELOAD_PROBE_FAILED',
      `Stim could not determine whether ${record.appId} is running on ${record.deviceId}.`,
      `Run \`${probe}\` and retry when the device tool responds.`,
    );
  }
  if (process === null) {
    return failure(
      'STIM_RELOAD_STOPPED',
      `${record.appId} is not running on ${record.deviceId}.`,
      `Run \`stim ${platform}\` to launch it.`,
    );
  }
  return null;
}

function inspectTarget(
  platform: ReloadPlatform,
  record: WorkspaceLaunchRecord,
  project: ProjectRecord,
  d: ReloadDeps,
): LiveTarget | TargetFailure {
  if (platform === 'ios') {
    const configured = project.platforms?.ios;
    if (!configured?.owned || configured.deviceUdid !== record.deviceId) {
      return {
        platform,
        error: failure(
          'STIM_RELOAD_UNOWNED',
          `The recorded iOS launch on ${record.deviceId} is not this workspace's current owned simulator.`,
          "Run `stim ios` to launch the app on this workspace's owned simulator.",
        ),
      };
    }
    let resolved: ResolvedIosSim;
    try {
      resolved = d.resolveIos(record.deviceId);
    } catch (error) {
      return {
        platform,
        error: failure(
          'STIM_RELOAD_PROBE_FAILED',
          `Stim could not inspect iOS simulator ${record.deviceId}: ${describe(error)}`,
          'Run `xcrun simctl list devices` and retry when simctl responds.',
        ),
      };
    }
    if (!resolved.sim || resolved.sim.state !== 'Booted') {
      return {
        platform,
        error: failure(
          'STIM_RELOAD_STOPPED',
          `The recorded iOS app is not running on a booted owned simulator.`,
          'Run `stim ios` to boot, install, and launch it.',
        ),
      };
    }
    const stopped = processFailure(platform, record, d);
    if (stopped) return { platform, error: stopped };
    return { platform, record, deviceName: resolved.sim.name };
  }

  const configured = project.platforms?.android;
  if (!configured?.owned || !configured.avdName) {
    return {
      platform,
      error: failure(
        'STIM_RELOAD_UNOWNED',
        `The recorded Android launch on ${record.deviceId} is not this workspace's current owned emulator.`,
        "Run `stim android` to launch the app on this workspace's owned emulator.",
      ),
    };
  }
  let resolved: ResolvedAvdSerial;
  try {
    resolved = d.resolveAndroid(configured.avdName);
  } catch (error) {
    return {
      platform,
      error: failure(
        'STIM_RELOAD_PROBE_FAILED',
        `Stim could not inspect Android emulator ${configured.avdName}: ${describe(error)}`,
        'Run `adb devices` and retry when adb responds.',
      ),
    };
  }
  if (!resolved.serial || resolved.serial !== record.deviceId) {
    return {
      platform,
      error: failure(
        'STIM_RELOAD_STOPPED',
        `The recorded Android app is not running on this workspace's owned emulator.`,
        'Run `stim android` to boot, install, and launch it.',
      ),
    };
  }
  const stopped = processFailure(platform, record, d);
  if (stopped) return { platform, error: stopped };
  return { platform, record, deviceName: configured.avdName };
}

function isTargetFailure(value: LiveTarget | TargetFailure): value is TargetFailure {
  return 'error' in value;
}

export async function runReload({
  root,
  platform = null,
  deps = {},
}: {
  root: string;
  platform?: ReloadPlatform | null;
  deps?: Partial<ReloadDeps>;
}): Promise<ReloadResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const project = d.getProject(root);
  if (!project) {
    return {
      ok: false,
      error: failure('STIM_NO_PROJECT', `No Stim environment is registered for ${root}.`, 'Run `stim start` first.'),
    };
  }
  const launches = d.readLaunches(root);
  const platforms: ReloadPlatform[] = platform ? [platform] : ['ios', 'android'];
  const inspected = platforms.flatMap((candidate) => {
    const record = launches[candidate];
    return record ? [inspectTarget(candidate, record, project, d)] : [];
  });
  const live = inspected.filter((target): target is LiveTarget => !isTargetFailure(target));

  if (live.length > 1) {
    return {
      ok: false,
      error: failure(
        'STIM_RELOAD_AMBIGUOUS',
        'Both the iOS and Android apps are running.',
        'Choose one with `stim reload ios` or `stim reload android`.',
      ),
    };
  }
  if (live.length === 0) {
    const firstFailure = inspected.find(isTargetFailure)?.error;
    return {
      ok: false,
      error:
        firstFailure ??
        failure(
          'STIM_RELOAD_STOPPED',
          platform ? `No ${platform} app launch is recorded for this workspace.` : 'No live app launch is recorded.',
          platform ? `Run \`stim ${platform}\` first.` : 'Run `stim ios` or `stim android` first.',
        ),
    };
  }

  const target = live[0]!;
  if (target.record.release) {
    return {
      ok: false,
      error: failure(
        'STIM_RELOAD_RELEASE',
        `${target.record.appId} was launched with an embedded release bundle.`,
        `Run \`stim ${target.platform}\` with a Debug configuration or variant before reloading JavaScript.`,
      ),
    };
  }
  const port = target.record.metroPort;
  if (!port || project.metroPort !== port) {
    return {
      ok: false,
      error: failure(
        'STIM_NO_METRO',
        `The launch does not point at this workspace's current Metro reservation.`,
        'Run `stim start`, then launch the app again.',
      ),
    };
  }
  const metro = await d.resolveMetro(port, root);
  if (!metro.metro) {
    return {
      ok: false,
      error: failure(
        'STIM_NO_METRO',
        `Port ${port} is not serving this workspace's Metro.`,
        'Run `stim start`, then retry.',
      ),
    };
  }
  const stopped = processFailure(target.platform, target.record, d);
  if (stopped) return { ok: false, error: stopped };

  let strategy: ReloadFacts['strategy'];
  if (target.record.deepLinkUrl) {
    const opened =
      target.platform === 'ios'
        ? d.openIosUrl(target.record.deviceId, target.record.deepLinkUrl)
        : d.openAndroidUrl({
            serial: target.record.deviceId,
            url: target.record.deepLinkUrl,
            packageName: target.record.appId,
          });
    if (!opened.ok) {
      return {
        ok: false,
        error: failure(
          'STIM_RELOAD_FAILED',
          opened.reason ?? `Could not reopen ${target.record.deepLinkUrl}.`,
          `Run \`stim ${target.platform}\` to re-establish the app launch.`,
        ),
      };
    }
    strategy = 'deep-link';
  } else if (target.platform === 'android') {
    const reloaded = d.reloadAndroid(target.record.deviceId, target.record.appId);
    if (!reloaded.ok) {
      return {
        ok: false,
        error: failure('STIM_RELOAD_FAILED', reloaded.reason ?? 'The Android reload broadcast failed.', null),
      };
    }
    strategy = 'android-broadcast';
  } else {
    const reloaded = await d.reloadIosMetro(port);
    if (reloaded.ok) {
      strategy = 'metro-websocket';
    } else {
      const stoppedAfterMetro = processFailure(target.platform, target.record, d);
      if (stoppedAfterMetro) return { ok: false, error: stoppedAfterMetro };
      const snapshot = `agent-device snapshot -i --platform ios --udid ${target.record.deviceId}`;
      return {
        ok: false,
        error: failure(
          'STIM_RELOAD_FAILED',
          reloaded.reason ?? `No React Native app is connected to Metro on port ${port}.`,
          `Continue in your existing automation session for ${target.record.appId} on ${target.record.deviceId}. Run \`${snapshot}\`, then press the Reload control by the exact ref or label it reports. Do not open another session or rerun \`stim ios\`.`,
        ),
      };
    }
  }

  return {
    ok: true,
    facts: {
      platform: target.platform,
      deviceId: target.record.deviceId,
      deviceName: target.deviceName,
      appId: target.record.appId,
      metroPort: port,
      strategy,
    },
  };
}

interface ReloadOptions {
  json?: boolean;
}

export function registerReload(program: Command, deps: Partial<ReloadDeps> = {}): void {
  program
    .command('reload [platform]')
    .description(
      "Reload JavaScript in this workspace's live app without building, installing, or cold-launching it. Specify ios or android when both are live.",
    )
    .option('--json', 'Emit the reload facts as one JSON line')
    .action(async (value: string | undefined, opts: ReloadOptions) => {
      if (value !== undefined && value !== 'ios' && value !== 'android') {
        const error = failure(
          'STIM_BAD_ARG',
          `Unknown reload platform ${JSON.stringify(value)}.`,
          'Use ios or android.',
        );
        if (opts.json) console.log(JSON.stringify(error));
        else {
          console.error(chalk.red(phaseLine('error', `${error.code}: ${error.message}`)));
          if (error.remedy) console.error(phaseLine('remedy', error.remedy));
        }
        process.exitCode = 1;
        return;
      }
      const root = (deps.findProjectRoot ?? DEFAULT_DEPS.findProjectRoot)(process.cwd());
      if (!root) {
        const error = failure(
          'STIM_NO_PROJECT',
          'Not inside a project (no package.json found above the current directory).',
          null,
        );
        if (opts.json) console.log(JSON.stringify(error));
        else console.error(chalk.red(phaseLine('error', `${error.code}: ${error.message}`)));
        process.exitCode = 1;
        return;
      }
      const result = await runReload({ root, platform: value ?? null, deps });
      if (!result.ok) {
        if (opts.json) console.log(JSON.stringify(result.error));
        else {
          console.error(chalk.red(phaseLine('error', `${result.error.code}: ${result.error.message}`)));
          if (result.error.remedy) console.error(phaseLine('remedy', result.error.remedy));
        }
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(result.facts));
      } else {
        const facts = result.facts;
        console.log(
          `Reloaded ${facts.appId} on ${facts.deviceName} (${facts.deviceId}) via ${facts.strategy}; ${facts.platform} Metro port ${facts.metroPort}.`,
        );
      }
    });
}

export default function reloadCommand(program: Command): void {
  registerReload(program);
}
