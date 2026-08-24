import { existsSync, readdirSync, rmSync } from 'fs';
import chalk from 'chalk';
import { InvalidArgumentError } from 'commander';
import { loadConfig } from '../config.js';
import {
  directorySize,
  findOrphanedDerivedData,
  formatBytes,
  isOnMountedVolume,
  listMountedVolumes,
  volumeRootFor,
} from '../artifacts.js';
import { reclaimProject } from '../reclaim.js';
import { listAllIosSims } from '../sim/ios.js';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.js';
import { listAvds } from '../sim/android.js';
import { discoverCaches, sizeCaches } from '../caches.js';
import { getExecutor } from '../exec.js';
import { resolveSettings } from '../settings.js';

// Bounds each device listing so a wedged simctl/emulator daemon can't hang
// `gc` forever -- see the comment above the listAllIosSims/listAvds calls
// in the action below.
const DEVICE_LIST_TIMEOUT_MS = 10000;

// directorySize() returns 0 both for a genuinely empty directory and for one
// it could not measure (the du shellout failed, or the directory vanished
// between listing and measuring). We must not print a bare "0K" as if it
// were a real measurement in the second case. A directory readdirSync finds
// non-empty with a measured size of 0 -- or one that no longer exists at
// all -- can only mean the measurement failed, never that it is truly empty.
export function isMeasured(dir, bytes) {
  if (bytes > 0) return true;
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

// Pure. Finds rn-iso-owned simulators/AVDs that no live config entry
// references. A device counts as "referenced" the moment ANY project in
// `config` has ANY platform record naming it -- owned or not, and
// regardless of whether that project's path currently exists on disk. Not
// gating on `owned` matters because a device can be named in a non-owned
// record too (e.g. a stale/mid-transition record, or one written before an
// `owned` flag update lands) -- treating only owned records as references
// would let this sweep propose deleting a device an unowned record still
// points at. This is the same fail-closed direction as the artifact sweep
// (CLAUDE.md item 9): a project entry whose directory looks gone only
// because its volume is unplugged right now must not cause its device to
// be swept out from under it, so a reference is honored unconditionally
// rather than gated on existence.
// `isMounted(path)` only shapes the human-readable reason attached to a
// kept device (so a device kept because its owner's volume is not mounted
// reads differently than one kept because its owner is a normal, present
// project) -- it never flips a referenced device into `orphaned`.
// Devices whose name does not start with "rn-iso-" are ignored entirely:
// rn-iso never created them and must never propose touching them.
// `deadProjects` are paths already proven mounted-and-gone by the caller's
// dead-project sweep (gc.js's own check, run just before this). They must
// be excluded from the reference map here, not just pruned from config
// afterward: without this, a dead project's owned device reads as
// "referenced" on this same run (its config entry hasn't been removed
// yet), so the device survives one full `gc --delete` and is only reaped
// on the NEXT run. Excluding them here means dead-project pruning and its
// device sweep land in the same run.
export function findOrphanedDevices({ sims = [], avds = [], config, isMounted, deadProjects = [] } = {}) {
  const dead = new Set(deadProjects);
  const referenced = new Map(); // device id -> { path, mounted }

  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path)) continue;
    const mounted = isMounted ? isMounted(path) : true;
    const ios = proj?.platforms?.ios;
    if (ios?.deviceUdid) {
      referenced.set(ios.deviceUdid, { path, mounted });
    }
    const android = proj?.platforms?.android;
    if (android?.avdName) {
      referenced.set(android.avdName, { path, mounted });
    }
  }

  function describeKept(ref) {
    return ref.mounted
      ? `referenced by ${ref.path}`
      : `referenced by ${ref.path} (volume not mounted; kept just in case)`;
  }

  const orphaned = [];
  const kept = [];

  for (const sim of sims) {
    if (!sim?.name?.startsWith('rn-iso-')) continue;
    const ref = referenced.get(sim.udid);
    if (!ref) {
      orphaned.push({ kind: 'ios', id: sim.udid, name: sim.name });
    } else {
      kept.push({ kind: 'ios', id: sim.udid, name: sim.name, reason: describeKept(ref) });
    }
  }

  for (const avdName of avds) {
    if (!avdName?.startsWith('rn-iso-')) continue;
    const ref = referenced.get(avdName);
    if (!ref) {
      orphaned.push({ kind: 'android', id: avdName, name: avdName });
    } else {
      kept.push({ kind: 'android', id: avdName, name: avdName, reason: describeKept(ref) });
    }
  }

  return { orphaned, kept };
}

// With no config, deleting is off the table -- an empty reference map makes
// every rn-iso-* device look orphaned, including another RN_ISO_HOME's live
// ones. But saying nothing was its own failure mode: a wiped config (or a
// throwaway RN_ISO_HOME) orphaned simulators that nothing would ever surface
// again. Report them by name so a human can judge; never act on them.
export function describeUnverifiableDevices(simNames = [], avdNames = []) {
  const ours = [...simNames, ...avdNames].filter(n => typeof n === 'string' && n.startsWith('rn-iso-'));
  if (ours.length === 0) return ['no rn-iso config found; device sweep skipped'];
  return [
    `no rn-iso config found, so ${ours.length} rn-iso-created device(s) cannot be verified as orphaned: ${ours.join(', ')}`,
    'they were NOT touched. If they are stale, delete them with `xcrun simctl delete <udid>` or `avdmanager delete avd -n <name>`',
  ];
}

export function formatGcReport({
  orphaned,
  skipped,
  deadProjects,
  totalBytes,
  orphanedDevices = [],
  deviceSweepNotices = [],
  caches = [],
}) {
  const lines = [];

  if (orphaned.length === 0 && deadProjects.length === 0 && orphanedDevices.length === 0) {
    const reasons = [];
    if (skipped.length > 0) {
      reasons.push(`${skipped.length} director${skipped.length === 1 ? 'y' : 'ies'} could not be checked`);
    }
    if (deviceSweepNotices.length > 0) {
      reasons.push('device sweep incomplete');
    }
    if (reasons.length > 0) {
      lines.push(`Nothing to reclaim (${reasons.join('; ')}; see below).`);
    } else {
      lines.push('Nothing to reclaim.');
    }
  }

  if (orphaned.length) {
    lines.push(`Orphaned build artifacts (${orphaned.length}):`);
    let unmeasuredCount = 0;
    for (const entry of orphaned) {
      const label = entry.measured === false ? 'unmeasured' : formatBytes(entry.bytes);
      if (entry.measured === false) unmeasuredCount++;
      lines.push(`  ${label.padStart(10)}  ${entry.dir}`);
      lines.push(`              was: ${entry.workspacePath}`);
    }
    const totalSuffix = unmeasuredCount
      ? ` (lower bound; ${unmeasuredCount} entr${unmeasuredCount === 1 ? 'y' : 'ies'} unmeasured)`
      : '';
    lines.push(`  total: ${formatBytes(totalBytes)}${totalSuffix}`);
  }

  if (deadProjects.length) {
    lines.push(`Dead project entries (${deadProjects.length}):`);
    for (const path of deadProjects) lines.push(`  ${path}`);
  }

  if (orphanedDevices.length) {
    lines.push(`Orphaned devices (${orphanedDevices.length}):`);
    for (const d of orphanedDevices) lines.push(`  ${d.kind} ${d.name} (${d.id})`);
  }

  if (deviceSweepNotices.length) {
    lines.push(`Device sweep notices (${deviceSweepNotices.length}):`);
    for (const notice of deviceSweepNotices) lines.push(`  ${notice}`);
  }

  if (skipped.length) {
    lines.push(`Skipped (${skipped.length}) - not classified as orphaned:`);
    for (const entry of skipped) lines.push(`  ${entry.dir}: ${entry.reason}`);
  }

  // Shared caches are reported apart from everything above, and never counted
  // in the reclaim total: the rest of this report is dead weight, while these
  // are alive and load-bearing. Deleting one costs the next build the time the
  // cache was saving -- it is a performance decision, not cleanup.
  if (caches.length) {
    const total = caches.reduce((n, c) => n + c.bytes, 0);
    lines.push(`Shared build caches (${caches.length}) - alive, not garbage:`);
    for (const c of caches) {
      lines.push(`  ${formatBytes(c.bytes).padStart(10)}  ${c.name}`);
      lines.push(`              ${c.dir}`);
      lines.push(`              ${c.bounded ? c.note : `unbounded, ${c.note}`}`);
    }
    lines.push(`  total: ${formatBytes(total)}`);
  }

  return lines;
}

export default function gcCommand(program) {
  program
    .command('gc')
    .description('Reclaim build artifacts and config entries left behind by worktrees that no longer exist. Reports by default; pass --delete to act.')
    .option('--delete', 'actually delete the reported artifacts and entries')
    .option('--caches', 'also report the shared build caches (Metro, ccache, Xcode compilation cache); with --delete, empty them')
    .option('--older-than <days>', 'only consider artifacts not accessed in this many days', v => {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || String(n) !== String(v).trim()) {
        throw new InvalidArgumentError('must be a whole number of days, e.g. --older-than 30');
      }
      return n;
    })
    .action(async opts => {
      const { orphaned, skipped } = findOrphanedDerivedData({ olderThanDays: opts.olderThan });

      // Opt-in, and separate from everything else this command reclaims. These
      // caches are shared by every project on the machine, so the blast radius
      // is not "this dead worktree" -- it is every build that would have hit
      // them. Sizing walks gigabytes, so only do it when asked.
      const settings = resolveSettings({});
      const caches = opts.caches
        ? sizeCaches(discoverCaches({ declared: settings?.caches }))
        : [];

      const sized = orphaned.map(entry => {
        const bytes = directorySize(entry.dir);
        return { ...entry, bytes, measured: isMeasured(entry.dir, bytes) };
      });
      const totalBytes = sized.reduce((sum, e) => sum + e.bytes, 0);

      // A project path that no longer exists looks "dead" -- but if it lives
      // on a volume that is simply not mounted right now (the whole machine's
      // repos live on an external SSD), unregistering it would destroy its
      // label, metroPort allocation, and device claims for good. Only prune
      // entries whose volume is confirmed mounted; route the rest into
      // skipped, same as the artifact half of this command already does.
      // isOnMountedVolume resolves symlinked ancestors first (the same way
      // the artifact sweep above does) rather than checking the raw path
      // text -- a config key recorded under a symlinked path (e.g. a home
      // folder symlinked onto an external volume) must not be misread as
      // always-mounted just because it textually starts under "/".
      const mountedVolumes = listMountedVolumes();
      const cfg = loadConfig();
      const deadProjects = [];
      const allSkipped = [...skipped];
      for (const path of Object.keys(cfg?.projects || {})) {
        if (existsSync(path)) continue;
        if (!isOnMountedVolume(path, mountedVolumes)) {
          const volume = volumeRootFor(path);
          allSkipped.push({ dir: path, reason: `volume ${volume} is not mounted` });
        } else {
          deadProjects.push(path);
        }
      }

      // Tolerate a missing/unresponsive simctl/emulator toolchain (Linux dev
      // box with no Android SDK, or -- as happened on this machine -- a
      // wedged simctl daemon that never answers) the same way `status`
      // does: an unreadable device list means "skip the device sweep for
      // this platform", not a crashed command. `gc` is advertised as the
      // always-safe command for unattended agents, so it must always
      // return promptly; DEVICE_LIST_TIMEOUT_MS bounds each listing so a
      // wedged daemon can't hang it forever (bare execSync has no timeout
      // by default). A skip is never treated as "no devices exist" (which
      // would be indistinguishable from a clean sweep) -- it is recorded in
      // deviceSweepNotices and surfaced in the report, never silently.
      const deviceSweepNotices = [];
      let orphanedDevices = [];
      if (cfg === null) {
        // No config file at all means rn-iso has never registered a
        // project on this machine (or RN_ISO_HOME points somewhere empty).
        // findOrphanedDevices' reference map would come back empty in this
        // case, which classifies EVERY rn-iso-* sim/AVD on the machine as
        // orphaned -- including devices belonging to another rn-iso HOME,
        // or ones a config read glitch merely failed to surface. Skip the
        // sweep entirely rather than risk `--delete` destroying every live
        // environment on the machine. orphanedDevices stays empty, so
        // --delete cannot touch any of them -- but they are still named.
        let simNames = [];
        let avdNames = [];
        try {
          simNames = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }).map(s => s.name);
        } catch { /* toolchain unavailable: report what we can */ }
        try {
          avdNames = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
        } catch { /* same */ }
        deviceSweepNotices.push(...describeUnverifiableDevices(simNames, avdNames));
      } else {
        let sims = [];
        try {
          sims = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
        } catch {
          deviceSweepNotices.push(
            `ios device sweep skipped: simulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`
          );
        }
        let avds = [];
        try {
          avds = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
        } catch {
          deviceSweepNotices.push(
            `android device sweep skipped: emulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`
          );
        }

        const isMounted = path => isOnMountedVolume(path, mountedVolumes);
        orphanedDevices = findOrphanedDevices({ sims, avds, config: cfg, isMounted, deadProjects }).orphaned;
      }

      for (const line of formatGcReport({ orphaned: sized, skipped: allSkipped, deadProjects, totalBytes, orphanedDevices, deviceSweepNotices, caches })) {
        console.log(line);
      }

      // Caches count toward "is there anything to do": a machine with no dead
      // worktrees can still be carrying gigabytes of shared cache, and that is
      // the whole reason to ask for --caches.
      const nothingToReclaim = sized.length === 0 && deadProjects.length === 0 && orphanedDevices.length === 0;
      if (nothingToReclaim && !caches.length) return;

      if (!opts.delete) {
        console.log(chalk.dim('\nDry run. Re-run with --delete to reclaim.'));
        return;
      }

      let reclaimedBytes = 0;
      let reclaimedUnmeasured = 0;
      let deleteFailures = 0;
      for (const entry of sized) {
        try {
          rmSync(entry.dir, { recursive: true, force: true });
          console.log(chalk.green(`Deleted ${entry.dir}`));
          if (entry.measured === false) {
            reclaimedUnmeasured++;
          } else {
            reclaimedBytes += entry.bytes;
          }
        } catch (err) {
          deleteFailures++;
          console.log(chalk.red(`Failed to delete ${entry.dir}: ${err.message}`));
        }
      }
      for (const path of deadProjects) {
        // Artifacts for these were already covered by the orphan sweep above.
        const result = await reclaimProject(path, { deleteArtifacts: false });
        console.log(chalk.green(`Pruned ${path}`));
        if (result.killedPid) {
          console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid}`));
        }
      }
      // Each device's teardown is wrapped in its own try/catch (the pattern
      // reclaim.js uses): one bad record or exec throw must not abort the
      // rest of the sweep. iOS is re-verified against the live sim list
      // right before shutdown, the same way reclaim.js/release.js/
      // shutdown.js all do: the udid came from the listing taken earlier in
      // this run, and shutting down first on the strength of that snapshot
      // "would already have hit whatever real simulator that udid resolves
      // to" if it has since been renamed away from rn-iso ownership or
      // deleted. A stale/renamed record is reported and left alone
      // (notOwned), an already-gone one is reported as such without being
      // treated as a failure (missing), and a probe that itself throws
      // fails CLOSED -- caught below, reported, and left untouched, same as
      // any other teardown failure. Occupancy no longer defers a delete: an
      // orphaned sim referenced by no live project is going away, and leaving
      // it "for a later gc" only asked the same question again forever.
      for (const d of orphanedDevices) {
        // Every guard lives in the shared teardown helper: ownership
        // re-resolve, occupancy (iOS only), and per-device containment so one
        // bad record cannot abort the sweep.
        const r = d.kind === 'ios'
          ? teardownOwnedIosSim(d.id, { del: true, label: d.name })
          : teardownOwnedAvd(d.name, { del: true });
        const what = d.kind === 'ios' ? `ios sim ${d.name} (${d.id})` : `android avd ${d.name}`;
        if (r.status === 'torn-down') {
          console.log(chalk.green(`Deleted ${what}`));
        } else if (r.status === 'missing') {
          console.log(chalk.dim(`${what} is already gone; nothing to delete.`));
        } else if (r.status === 'skipped') {
          console.log(chalk.yellow(`Skipped ${what}: ${r.reason} -- left for a later gc`));
        } else {
          deleteFailures++;
          console.log(chalk.red(`Failed to delete ${d.kind} device ${d.name}: ${r.reason}`));
        }
      }
      if (deleteFailures) {
        console.log(chalk.red(`\n${deleteFailures} entr${deleteFailures === 1 ? 'y' : 'ies'} could not be deleted; see above.`));
      }
      const reclaimedSuffix = reclaimedUnmeasured
        ? ` (${reclaimedUnmeasured} entr${reclaimedUnmeasured === 1 ? 'y' : 'ies'} unmeasured)`
        : '';
      // Emptied last and counted apart from `reclaimedBytes`: this is not
      // reclaimed garbage, it is a cache someone will now have to refill.
      let cacheBytes = 0;
      for (const c of caches) {
        try {
          if (c.files) {
            // `dir` here is the system temp directory, not a directory this
            // cache owns. Only ever remove the files we listed inside it.
            for (const f of c.files) rmSync(f, { force: true });
          } else if (c.name === 'ccache') {
            // Let ccache clear itself so its config and stats survive.
            getExecutor().runQuiet('ccache --clear');
          } else {
            rmSync(c.dir, { recursive: true, force: true });
          }
          cacheBytes += c.bytes;
          console.log(chalk.green(`Emptied ${c.name} (${formatBytes(c.bytes)})`));
        } catch (e) {
          console.log(chalk.yellow(`Could not empty ${c.name}: ${String(e?.message || e)}`));
        }
      }

      console.log(
        chalk.dim(`\nReclaimed ${reclaimedUnmeasured ? 'at least ' : ''}${formatBytes(reclaimedBytes)}${reclaimedSuffix}.`)
      );
      if (cacheBytes) {
        console.log(
          chalk.dim(`Emptied ${formatBytes(cacheBytes)} of shared cache. The next build in each project pays to refill it.`)
        );
      }
    });
}
