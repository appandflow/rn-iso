import { existsSync, readdirSync, rmSync } from 'fs';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { directorySize, findOrphanedDerivedData, formatBytes } from '../artifacts.js';
import { reclaimProject } from '../reclaim.js';

// directorySize() returns 0 both for a genuinely empty directory and for one
// it could not measure (the du shellout failed, or the directory vanished
// between listing and measuring). We must not print a bare "0K" as if it
// were a real measurement in the second case. A directory readdirSync finds
// non-empty with a measured size of 0 -- or one that no longer exists at
// all -- can only mean the measurement failed, never that it is truly empty.
function isMeasured(dir, bytes) {
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
    lines.push('Nothing to reclaim.');
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
    .option('--older-than <days>', 'only consider artifacts not accessed in this many days', v => parseInt(v, 10))
    .action(opts => {
      const { orphaned, skipped } = findOrphanedDerivedData({ olderThanDays: opts.olderThan });

      const sized = orphaned.map(entry => {
        const bytes = directorySize(entry.dir);
        return { ...entry, bytes, measured: isMeasured(entry.dir, bytes) };
      });
      const totalBytes = sized.reduce((sum, e) => sum + e.bytes, 0);

      const cfg = loadConfig();
      const deadProjects = Object.keys(cfg?.projects || {}).filter(p => !existsSync(p));

      for (const line of formatGcReport({ orphaned: sized, skipped, deadProjects, totalBytes })) {
        console.log(line);
      }

      if (sized.length === 0 && deadProjects.length === 0) return;

      if (!opts.delete) {
        console.log(chalk.dim('\nDry run. Re-run with --delete to reclaim.'));
        return;
      }

      for (const entry of sized) {
        rmSync(entry.dir, { recursive: true, force: true });
        console.log(chalk.green(`Deleted ${entry.dir}`));
      }
      for (const path of deadProjects) {
        // Artifacts for these were already covered by the orphan sweep above.
        const result = reclaimProject(path, { deleteArtifacts: false });
        console.log(chalk.green(`Pruned ${path}`));
        if (result.killedPid) {
          console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid}`));
        }
      }
      console.log(chalk.dim(`\nReclaimed ${formatBytes(totalBytes)}.`));
    });
}
