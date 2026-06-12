// src/commands/prune.js
import chalk from 'chalk';
import { pruneDeadProjects } from '../config.js';
import { findPidListeningOnPort } from '../metro.js';

export default function pruneCommand(program) {
  program
    .command('prune')
    .description('Remove entries for projects whose directory no longer exists (deleted worktrees), freeing their sims/emulators and Metro ports. Live projects are never touched.')
    .action(() => {
      const removed = pruneDeadProjects();
      if (removed.length === 0) {
        console.log(chalk.dim('Nothing to prune: every registered project path still exists.'));
        return;
      }

      for (const { path, project } of removed) {
        const freed = [];
        const ios = project.platforms?.ios;
        if (ios?.deviceUdid) freed.push(`ios sim ${ios.deviceUdid}`);
        const android = project.platforms?.android;
        if (android?.avdName) freed.push(`android avd ${android.avdName}`);
        else if (android?.serial) freed.push(`android device ${android.serial}`);

        console.log(chalk.green(`Pruned ${path}`));
        if (freed.length) console.log(chalk.dim(`  freed: ${freed.join(', ')}`));

        // A Metro started from the deleted directory can outlive it and squat
        // on the port; kill it so the port is genuinely free.
        if (typeof project.metroPort === 'number') {
          const pid = findPidListeningOnPort(project.metroPort);
          if (pid) {
            try {
              process.kill(pid, 'SIGTERM');
              console.log(chalk.dim(`  killed orphaned Metro pid ${pid} on port ${project.metroPort}`));
            } catch {
              console.log(chalk.dim(`  could not kill pid ${pid} on port ${project.metroPort}`));
            }
          }
        }
      }
      console.log(chalk.dim(`\n${removed.length} project entr${removed.length === 1 ? 'y' : 'ies'} removed.`));
    });
}
