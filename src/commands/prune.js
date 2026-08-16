// src/commands/prune.js
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { existsSync } from 'fs';
import { reclaimProject } from '../reclaim.js';

export default function pruneCommand(program) {
  program
    .command('prune')
    .description('Remove entries for projects whose directory no longer exists (deleted worktrees), freeing their sims/emulators and Metro ports. Live projects are never touched. Does not delete build artifacts; see `gc`.')
    .action(() => {
      const cfg = loadConfig();
      const deadPaths = Object.keys(cfg?.projects || {}).filter(p => !existsSync(p));

      if (deadPaths.length === 0) {
        console.log(chalk.dim('Nothing to prune: every registered project path still exists.'));
        return;
      }

      let reclaimableBytes = 0;
      for (const path of deadPaths) {
        const result = reclaimProject(path, { deleteArtifacts: false });
        console.log(chalk.green(`Pruned ${path}`));
        if (result.freed.length) console.log(chalk.dim(`  freed: ${result.freed.join(', ')}`));
        if (result.killedPid) {
          console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid} on port ${result.metroPort}`));
        }
        for (const artifact of result.artifacts) reclaimableBytes += artifact.bytes;
      }

      console.log(chalk.dim(`\n${deadPaths.length} project entr${deadPaths.length === 1 ? 'y' : 'ies'} removed.`));
      if (reclaimableBytes > 0) {
        console.log(chalk.yellow('Build artifacts from these projects are still on disk. Run `rn-iso gc` to review them.'));
      }
    });
}
