// src/commands/prune.js
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { existsSync } from 'fs';
import { reclaimProject } from '../reclaim.js';
import { isOnMountedVolume, listMountedVolumes } from '../artifacts.js';

export default function pruneCommand(program) {
  program
    .command('prune')
    .description('Remove entries for projects whose directory no longer exists (deleted worktrees), freeing their sims/emulators and Metro ports. Live projects are never touched. Does not delete build artifacts; see `gc`.')
    .action(() => {
      const cfg = loadConfig();
      const mountedVolumes = listMountedVolumes();
      const missingPaths = Object.keys(cfg?.projects || {}).filter(p => !existsSync(p));

      // A missing path looks "dead" -- but if it lives on a volume that is
      // simply not mounted right now (e.g. this machine's repos live on an
      // external SSD that gets unplugged), it is not actually gone.
      // Unregistering it would SIGTERM whatever is listening on its Metro
      // port and drop its device claim for good; `prune` is documented as
      // the narrow, always-safe command, so it must leave these alone, the
      // same as gc's project sweep does. See CLAUDE.md #9.
      const deadPaths = [];
      const unmountedPaths = [];
      for (const path of missingPaths) {
        if (isOnMountedVolume(path, mountedVolumes)) deadPaths.push(path);
        else unmountedPaths.push(path);
      }

      if (deadPaths.length === 0) {
        if (unmountedPaths.length > 0) {
          console.log(chalk.dim(
            `Nothing to prune: ${unmountedPaths.length} registered path(s) are on a volume that is not mounted right now; left untouched.`
          ));
        } else {
          console.log(chalk.dim('Nothing to prune: every registered project path still exists.'));
        }
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
      if (unmountedPaths.length > 0) {
        console.log(chalk.dim(`${unmountedPaths.length} more on an unmounted volume left untouched.`));
      }
      if (reclaimableBytes > 0) {
        console.log(chalk.yellow('Build artifacts from these projects are still on disk. Run `rn-iso gc` to review them.'));
      }
    });
}
