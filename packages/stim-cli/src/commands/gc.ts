import { existsSync, rmSync, statSync } from 'fs';
import chalk from 'chalk';
import { InvalidArgumentError, type Command } from 'commander';
import { loadConfig } from '../config.ts';
import { directorySize, isOnMountedVolume, listMountedVolumes, volumeRootFor } from '../fs-util.ts';
import { listBuildLocks, readBuildLock } from '../engine/build-lock.ts';
import { listBuildSlots, readBuildSlot } from '../engine/build-slots.ts';
import { removeExpiredLease } from '../engine/device-lease.ts';
import { isPidAlive } from '../metro.ts';
import { detectIsExpo, findProjectRoot } from '../project.ts';
import { reclaimProject } from '../reclaim.ts';
import { SETTING_SHAPE_REMEDY } from '../settings.ts';
import { listAllIosSims, type IosSimRecord } from '../sim/ios.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from '../sim-pool.ts';
import { listAvds, ownedAvdDirectory } from '../sim/android.ts';
import { declaredCachePaths, discoverCaches, projectSettingShapeErrors, sizeCaches } from '../caches.ts';
import { withEasProjectLock } from '../engine/eas-project-lock.ts';
import type { GcSkip, OrphanedDevice } from '../types.ts';
import { emptyCaches, planCacheEmptying, selectCaches, trimCaches } from './gc/caches.ts';
import {
  collectDeviceLeases,
  collectParkedSims,
  deleteParkedSims,
  deleteProjectDevices,
  describeUnverifiableDevices,
  deviceSweepIsScoped,
  DEVICE_LIST_TIMEOUT_MS,
  findOrphanedDevices,
  findStaleDeviceRecords,
  findStaleProjectDevices,
  withAndroidAvdSizes,
  type GcDeviceDependencies,
  type StaleDeviceRecord,
  type StaleProjectDevice,
} from './gc/devices.ts';
import {
  collectEasSessionSweep,
  deleteEasSessions,
  describeError,
  withRemoteSessionGcLocks,
  type EasGcDependencies,
  type EasSessionSweep,
} from './gc/eas-sessions.ts';
import { formatGcReport, type GcReport } from './gc/report.ts';

export { selectCaches } from './gc/caches.ts';
export {
  deleteParkedSims,
  describeParkedSims,
  describeUnverifiableDevices,
  findOrphanedDevices,
  findStaleDeviceRecords,
  findStaleProjectDevices,
  type ParkedSimReport,
} from './gc/devices.ts';
export { formatGcReport } from './gc/report.ts';

interface CollectGcReportOptions {
  olderThan?: number | null;
  cache?: string | null;
  now?: number;
  lastTouched?: (path: string) => number;
  unsafeAllowScopedDeviceSweep?: boolean;
}

interface RunGcOptions {
  olderThan?: number;
  cache?: string;
  delete?: boolean;
  unsafeAllowScopedDeviceSweep?: boolean;
}

interface GcDependencies extends EasGcDependencies, GcDeviceDependencies {
  settingShapeErrors?: () => string[];
}

function projectLastTouched(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return NaN;
  }
}

export async function collectGcReport(
  {
    olderThan = null,
    cache = null,
    now = Date.now(),
    lastTouched = projectLastTouched,
    unsafeAllowScopedDeviceSweep = false,
  }: CollectGcReportOptions = {},
  deps: GcDependencies = {},
): Promise<GcReport> {
  const scope = typeof cache === 'string' && cache.trim() ? cache : null;
  const all = scope !== null && olderThan === null;
  const selected = selectCaches(discoverCaches({ declared: declaredCachePaths() }), scope);
  const caches = planCacheEmptying(sizeCaches(selected), all);

  if (scope) {
    return {
      skipped: [],
      deadProjects: [],
      orphanedDevices: [],
      staleDevices: [],
      staleDeviceRecords: [],
      buildLocks: { stale: [], live: [] },
      buildSlots: { stale: [], live: [] },
      deviceLeases: { expired: [], kept: [] },
      deviceSweepNotices: [],
      easSessionSweep: { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
      parkedSims: [],
      caches,
      cacheScope: scope,
      olderThan,
      all,
    };
  }

  const mountedVolumes = listMountedVolumes();
  const cfg = loadConfig();
  let easSessionSweep = deps.precollectedEasSessionSweep;
  if (!easSessionSweep) {
    try {
      easSessionSweep = collectEasSessionSweep(cfg, deps);
    } catch (error) {
      easSessionSweep = {
        projectScope: null,
        orphaned: [],
        notices: [`EAS session sweep failed: ${describeError(error)}`],
        deletionSafe: false,
      };
    }
  }
  const parkedSims = collectParkedSims(deps);
  const deadProjects: string[] = [];
  const skipped: GcSkip[] = [];
  for (const path of Object.keys(cfg?.projects || {})) {
    if (existsSync(path)) continue;
    if (!isOnMountedVolume(path, mountedVolumes)) {
      const volume = volumeRootFor(path);
      skipped.push({ dir: path, reason: `volume ${volume} is not mounted` });
    } else {
      deadProjects.push(path);
    }
  }

  const deviceSweepNotices: string[] = [];
  let orphanedDevices: OrphanedDevice[] = [];
  let staleDevices: StaleProjectDevice[] = [];
  let staleDeviceRecords: StaleDeviceRecord[] = [];

  const unsweepableReason =
    cfg === null
      ? 'no Stim config found'
      : deviceSweepIsScoped(unsafeAllowScopedDeviceSweep)
        ? 'STIM_HOME scopes this config, but simulators and AVDs are machine-global'
        : null;

  if (unsweepableReason) {
    let simNames: string[] = [];
    let avdNames: string[] = [];
    try {
      simNames = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }).map((s) => s.name);
    } catch {}
    try {
      avdNames = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {}
    deviceSweepNotices.push(...describeUnverifiableDevices(simNames, avdNames, { reason: unsweepableReason }));
  } else {
    let sims: IosSimRecord[] = [];
    let simsChecked = true;
    try {
      sims = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {
      simsChecked = false;
      deviceSweepNotices.push(
        `ios device sweep skipped: simulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
      );
    }
    let avds: string[] = [];
    let avdsChecked = true;
    try {
      avds = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {
      avdsChecked = false;
      deviceSweepNotices.push(
        `android device sweep skipped: emulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
      );
    }

    const isMounted = (path: string) => isOnMountedVolume(path, mountedVolumes);
    orphanedDevices = withAndroidAvdSizes(
      findOrphanedDevices({ sims, avds, config: cfg, isMounted, deadProjects }).orphaned,
      {
        avdDirectory: deps.avdDirectory ?? ownedAvdDirectory,
        size: deps.directorySize ?? directorySize,
      },
    );
    staleDeviceRecords = findStaleDeviceRecords({
      config: cfg,
      sims,
      avds,
      deadProjects,
      simsChecked,
      avdsChecked,
    });
    if (olderThan !== null) {
      staleDevices = withAndroidAvdSizes(
        findStaleProjectDevices({
          config: cfg,
          sims,
          avds,
          olderThanDays: olderThan,
          now,
          lastTouched,
          deadProjects,
        }),
        {
          avdDirectory: deps.avdDirectory ?? ownedAvdDirectory,
          size: deps.directorySize ?? directorySize,
        },
      );
    }
  }

  const locks = listBuildLocks();
  const slots = listBuildSlots();
  const deviceLeases = collectDeviceLeases(now);

  return {
    skipped,
    deadProjects,
    parkedSims,
    orphanedDevices,
    staleDevices,
    staleDeviceRecords,
    buildLocks: {
      stale: locks.filter((l) => !l.alive),
      live: locks.filter((l) => l.alive),
    },
    buildSlots: {
      stale: slots.filter((s) => !s.alive),
      live: slots.filter((s) => s.alive),
    },
    deviceLeases,
    deviceSweepNotices,
    easSessionSweep,
    caches,
    cacheScope: null,
    olderThan,
    all,
  };
}

export async function runGc(opts: RunGcOptions = {}, deps: GcDependencies = {}): Promise<void> {
  const poolError = parkedMaxSetting('ios').error;
  if (poolError) {
    console.error(chalk.yellow(`${poolError} ${POOL_SETTING_REMEDY}`));
  }
  const shapeErrors = (deps.settingShapeErrors ?? projectSettingShapeErrors)();
  if (shapeErrors.length) {
    for (const message of shapeErrors) console.error(chalk.red(message));
    console.error(chalk.dim(SETTING_SHAPE_REMEDY));
    process.exitCode = 1;
    return;
  }
  if (opts.cache) {
    return runGcCore(opts, {
      ...deps,
      precollectedEasSessionSweep: { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
    });
  }
  let projectRoot: string | null = null;
  try {
    projectRoot = (deps.findProjectRoot ?? findProjectRoot)(process.cwd());
    if (!projectRoot) {
      return runGcCore(opts, {
        ...deps,
        precollectedEasSessionSweep: {
          projectScope: null,
          orphaned: [],
          notices: ['EAS session sweep skipped: no current project was available before EAS project lock acquisition.'],
          deletionSafe: false,
        },
      });
    }
    if (!(deps.detectIsExpo ?? detectIsExpo)(projectRoot)) {
      return runGcCore(opts, {
        ...deps,
        precollectedEasSessionSweep: {
          projectScope: projectRoot,
          orphaned: [],
          notices: [],
          deletionSafe: true,
        },
      });
    }
  } catch (error) {
    return runGcCore(opts, {
      ...deps,
      precollectedEasSessionSweep: {
        projectScope: projectRoot,
        orphaned: [],
        notices: [
          `EAS session sweep skipped: project classification failed before EAS project lock acquisition: ${describeError(error)}`,
        ],
        deletionSafe: false,
      },
    });
  }
  const withProjectLock = deps.withEasProjectLock ?? withEasProjectLock;
  let sweepStarted = false;
  let easSessionSweep: EasSessionSweep;
  try {
    easSessionSweep = await withProjectLock(
      projectRoot,
      () => {
        sweepStarted = true;
        return withRemoteSessionGcLocks(projectRoot, deps, (coordinatedDeps) =>
          Promise.resolve(collectEasSessionSweep(loadConfig(), coordinatedDeps)),
        );
      },
      { waitMs: 0, ownerPurpose: 'EAS orphan sweep', machineRoot: deps.easLedgerRoot },
    );
  } catch (error) {
    const failure = sweepStarted ? 'EAS collection failed' : 'EAS project lock acquisition failed';
    easSessionSweep = {
      projectScope: projectRoot,
      orphaned: [],
      notices: [`EAS session sweep skipped: ${failure}: ${describeError(error)}`],
      deletionSafe: false,
    };
  }
  return runGcCore(opts, { ...deps, precollectedEasSessionSweep: easSessionSweep });
}

async function runGcCore(opts: RunGcOptions, deps: GcDependencies): Promise<void> {
  const olderThan = typeof opts.olderThan === 'number' ? opts.olderThan : null;
  const cache = typeof opts.cache === 'string' && opts.cache.trim() ? opts.cache : null;
  const report = await collectGcReport(
    {
      olderThan,
      cache,
      unsafeAllowScopedDeviceSweep: opts.unsafeAllowScopedDeviceSweep,
    },
    deps,
  );
  if (cache && report.caches.length === 0) {
    const names = [...new Set(discoverCaches({ declared: declaredCachePaths() }).map((c) => c.name))];
    console.log(chalk.yellow(`No shared cache carries "${cache}" in its name or directory.`));
    if (names.length) console.log(chalk.dim(`Caches on this machine: ${names.join(', ')}`));
    return;
  }

  const all = report.all;

  for (const line of formatGcReport(report)) console.log(line);

  const {
    deadProjects,
    orphanedDevices,
    staleDevices,
    staleDeviceRecords,
    buildLocks,
    buildSlots,
    deviceLeases,
    easSessionSweep,
    caches,
  } = report;
  const actionable =
    deadProjects.length > 0 ||
    report.parkedSims.length > 0 ||
    orphanedDevices.length > 0 ||
    staleDevices.length > 0 ||
    staleDeviceRecords.length > 0 ||
    buildLocks.stale.length > 0 ||
    buildSlots.stale.length > 0 ||
    deviceLeases.expired.length > 0 ||
    easSessionSweep.orphaned.length > 0 ||
    ((olderThan !== null || all) && caches.length > 0);

  if (!opts.delete) {
    if (all) console.log(chalk.dim('\nDry run. Re-run with --delete to empty the caches above.'));
    else if (actionable) console.log(chalk.dim('\nDry run. Re-run with --delete to reclaim.'));
    else if (caches.length) {
      console.log(
        chalk.dim(
          '\nPass --delete --cache all to empty the caches above, or --delete --older-than <days> to trim them.',
        ),
      );
    }
    return;
  }

  let deleteFailures = deleteParkedSims(report.parkedSims, deps);

  for (const path of deadProjects) {
    const result = await reclaimProject(path);
    if (result.keptEntry) console.log(chalk.yellow(`Could not fully prune ${path}; its registry entry was kept.`));
    else console.log(chalk.green(`Pruned ${path}`));
    for (const dir of result.removedWorkspaceDirs) console.log(chalk.dim(`  removed workspace output ${dir}`));
    for (const dir of result.failedWorkspaceDirs) {
      console.log(chalk.red(`  could not remove workspace output ${dir}`));
      deleteFailures += 1;
    }
    if (result.killedPid) {
      console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid}`));
    }
    if (result.stoppedSession) {
      console.log(chalk.dim(`  stopped remote session ${result.stoppedSession}`));
    }
    if (result.stoppedTunnel) {
      console.log(chalk.dim(`  stopped ${result.stoppedTunnel} tunnel`));
    }
    for (const s of result.skippedDevices) {
      console.log(chalk.yellow(`  ${s.name}: ${s.reason}`));
    }
  }

  deleteFailures += deleteProjectDevices(orphanedDevices, staleDevices, staleDeviceRecords);

  for (const lock of buildLocks.stale) {
    const current = readBuildLock(lock.path);
    if (current?.pid && isPidAlive(current.pid)) continue;
    try {
      rmSync(lock.path, { recursive: true, force: true });
      console.log(
        chalk.green(
          `Cleared the ${lock.platform} build lock left by pid ${lock.pid ?? '?'} (${lock.projectRoot || 'unrecorded workspace'})`,
        ),
      );
    } catch (err) {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the build lock at ${lock.path}: ${(err as Error)?.message || err}`));
    }
  }

  for (const slot of buildSlots.stale) {
    const current = readBuildSlot(slot.path);
    if (current?.pid && isPidAlive(current.pid)) continue;
    try {
      rmSync(slot.path, { recursive: true, force: true });
      console.log(
        chalk.green(
          `Cleared build slot ${slot.index ?? '?'} left by pid ${slot.pid ?? '?'} (${slot.projectRoot || 'unrecorded workspace'})`,
        ),
      );
    } catch (err) {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the build slot at ${slot.path}: ${(err as Error)?.message || err}`));
    }
  }

  for (const entry of deviceLeases.expired) {
    try {
      if (removeExpiredLease(entry)) {
        console.log(
          chalk.green(
            `Cleared the expired ${entry.platform} device lease on ${entry.id ?? entry.name} (held by ${entry.lease?.holder ?? 'an unrecorded workspace'})`,
          ),
        );
      } else {
        console.log(chalk.dim(`${entry.name} is no longer an expired lease; left alone.`));
      }
    } catch (err) {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the device lease at ${entry.path}: ${(err as Error)?.message || err}`));
    }
  }
  deleteFailures += await deleteEasSessions(easSessionSweep, deps);

  if (deleteFailures) {
    console.log(
      chalk.red(`\n${deleteFailures} entr${deleteFailures === 1 ? 'y' : 'ies'} could not be deleted; see above.`),
    );
  }

  if (all) {
    emptyCaches(caches);
    return;
  }

  if (olderThan === null) {
    if (caches.length) {
      console.log(
        chalk.dim('Shared caches left alone: pass --cache all to empty them, or --older-than <days> to trim them.'),
      );
    }
    return;
  }

  trimCaches(caches, olderThan);
}

export default function gcCommand(program: Command): void {
  program
    .command('gc')
    .description(
      'Report what Stim has left behind: dead project entries, orphaned owned devices and EAS sessions, records of devices that no longer exist, build locks whose builder is gone, expired physical-device leases, and the shared build caches. Reports by default; pass --delete to act.',
    )
    .option('--delete', 'actually prune the reported entries and reap the reported devices')
    .option(
      '--older-than <days>',
      'also reap owned devices whose project has been untouched this long, and trim shared cache entries nothing has used in that time',
      (v: string) => {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || String(n) !== String(v).trim()) {
          throw new InvalidArgumentError('must be a whole number of days, e.g. --older-than 30');
        }
        return n;
      },
    )
    .option(
      '--cache <name>',
      'act on the shared caches whose name or directory contains <name>, or every cache with --cache all, a reserved name that never selects a single cache. With --delete they are emptied whole, which is the only way to clear an index-backed cache; add --older-than <days> to trim them by age instead. Only those caches are reported; devices and project entries are not inspected. Caches outside the config dir are refused while STIM_HOME is set.',
      (v: string) => {
        if (!v.trim()) throw new InvalidArgumentError('must name a cache, e.g. --cache "compilation cache"');
        return v;
      },
    )
    .action(async (opts: RunGcOptions) => {
      await runGc(opts);
    });
}
