import chalk from 'chalk';
import type { Command } from 'commander';
import { formatLongDuration } from '../command-output.ts';
import { readStats, statsProjectKey, STATS_VERSION } from '../engine/stats.ts';
import type { StatsBucket, StatsPlatform, StatsScope } from '../engine/stats.ts';
import { findProjectRoot } from '../project.ts';
import { gitCommonDir, repoRoot } from '../worktree.ts';

const PLATFORMS: StatsPlatform[] = ['ios', 'android'];
const PLATFORM_WIDTH = 9;

interface StatsOptions {
  json?: boolean;
}

export default function statsCommand(program: Command): void {
  program
    .command('stats')
    .description(
      'Show how many `ios` and `android` runs this project and this machine have recorded, how many hit the build ' +
        'cache, and an estimate of the time that cache saved.',
    )
    .option('--json', 'print the aggregates as JSON')
    .action((opts: StatsOptions) => {
      const root = findProjectRoot(process.cwd());
      const key = root ? statsProjectKey({ root, commonDir: gitCommonDir(root), repoRoot: repoRoot(root) }) : null;
      const { record, note } = readStats();
      if (note) console.error(chalk.dim(note));
      const machine: StatsScope = record?.machine ?? {};
      const project: StatsScope = key ? (record?.projects?.[key] ?? {}) : {};

      if (opts.json) {
        console.log(
          JSON.stringify({
            version: STATS_VERSION,
            project: key ? { key, ios: project.ios ?? null, android: project.android ?? null } : null,
            machine: { ios: machine.ios ?? null, android: machine.android ?? null },
          }),
        );
        return;
      }

      const lines: string[] = [];
      if (key) lines.push(`project ${key}`, ...sectionLines(project));
      lines.push('machine', ...sectionLines(machine));
      for (const line of lines) console.log(line);
    });
}

function sectionLines(scope: StatsScope): string[] {
  const lines = PLATFORMS.filter((platform) => scope[platform]).map((platform) =>
    bucketLine(platform, scope[platform] as StatsBucket),
  );
  return lines.length ? lines : [chalk.dim('  no runs recorded')];
}

function bucketLine(platform: string, bucket: StatsBucket): string {
  const finished = bucket.runs - bucket.failed;
  const cells = [
    `${bucket.runs} runs${bucket.failed > 0 ? ` (${bucket.failed} failed)` : ''}`,
    `${bucket.hits} hits (${finished > 0 ? `${Math.round((bucket.hits / finished) * 100)}%` : '-'})`,
    `cold run ${average(bucket.coldRunMs, bucket.coldRuns)} avg`,
    `hit run ${average(bucket.hitRunMs, bucket.hitRuns)} avg`,
    `saved ~${formatLongDuration(bucket.timeSavedMs)} (estimated)`,
    `since ${bucket.firstRunAt.slice(0, 10)}`,
  ];
  return `  ${platform.padEnd(PLATFORM_WIDTH)}${cells.join('   ')}`;
}

function average(totalMs: number, runs: number): string {
  return runs > 0 ? formatLongDuration(Math.round(totalMs / runs)) : '-';
}
