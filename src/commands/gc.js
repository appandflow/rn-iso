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

export function formatGcReport({ orphaned, skipped, deadProjects, totalBytes }) {
  const lines = [];

  if (orphaned.length === 0 && deadProjects.length === 0) {
    if (skipped.length > 0) {
      lines.push(
        `Nothing to reclaim (${skipped.length} director${skipped.length === 1 ? 'y' : 'ies'} could not be checked; see below).`
      );
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

  if (skipped.length) {
    lines.push(`Skipped (${skipped.length}) - not classified as orphaned:`);
    for (const entry of skipped) lines.push(`  ${entry.dir}: ${entry.reason}`);
  }

  return lines;
}

export default function gcCommand(program) {
  program
    .command('gc')
    .description('Reclaim build artifacts and config entries left behind by worktrees that no longer exist. Reports by default; pass --delete to act.')
    .option('--delete', 'actually delete the reported artifacts and entries')
    .option('--older-than <days>', 'only consider artifacts not accessed in this many days', v => {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || String(n) !== String(v).trim()) {
        throw new InvalidArgumentError('must be a whole number of days, e.g. --older-than 30');
      }
      return n;
    })
    .action(opts => {
      const { orphaned, skipped } = findOrphanedDerivedData({ olderThanDays: opts.olderThan });

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

      for (const line of formatGcReport({ orphaned: sized, skipped: allSkipped, deadProjects, totalBytes })) {
        console.log(line);
      }

      if (sized.length === 0 && deadProjects.length === 0) return;

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
        const result = reclaimProject(path, { deleteArtifacts: false });
        console.log(chalk.green(`Pruned ${path}`));
        if (result.killedPid) {
          console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid}`));
        }
      }
      if (deleteFailures) {
        console.log(chalk.red(`\n${deleteFailures} entr${deleteFailures === 1 ? 'y' : 'ies'} could not be deleted; see above.`));
      }
      const reclaimedSuffix = reclaimedUnmeasured
        ? ` (${reclaimedUnmeasured} entr${reclaimedUnmeasured === 1 ? 'y' : 'ies'} unmeasured)`
        : '';
      console.log(
        chalk.dim(`\nReclaimed ${reclaimedUnmeasured ? 'at least ' : ''}${formatBytes(reclaimedBytes)}${reclaimedSuffix}.`)
      );
    });
}
