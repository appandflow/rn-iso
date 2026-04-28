// src/commands/unreserve.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject, clearDevice } from '../config.js';

export default function unreserveCommand(program) {
  program
    .command('unreserve [platform]')
    .description("Release the current project's lock on its sim/emulator (alias of `release` without shutdown).")
    .action((platform) => {
      const plat = platform || null;
      if (plat && plat !== 'ios' && plat !== 'android') {
        console.error(chalk.red(`Unknown platform: ${plat}. Use ios or android.`));
        process.exit(1);
      }

      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj) {
        console.log(chalk.dim('No project entry to unlock.'));
        return;
      }
      const platforms = plat ? [plat] : ['ios', 'android'];
      for (const p of platforms) {
        if (proj.platforms?.[p]) {
          clearDevice(root, p);
          console.log(chalk.green(`Unlocked ${p} for ${root}.`));
        } else {
          console.log(chalk.dim(`No ${p} lock to release for ${root}.`));
        }
      }
    });
}
