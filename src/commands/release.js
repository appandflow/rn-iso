// src/commands/release.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject, clearDevice } from '../config.js';

export default function releaseCommand(program) {
  program
    .command('release')
    .description('Unbind device assignment(s) for the current project')
    .option('--platform <platform>', 'ios or android (default: both)')
    .action((opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project.'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj) {
        console.log(chalk.dim('No project entry to release.'));
        return;
      }
      const platforms = opts.platform ? [opts.platform] : ['ios', 'android'];
      for (const p of platforms) {
        if (proj.platforms?.[p]) {
          clearDevice(root, p);
          console.log(chalk.green(`Released ${p} assignment.`));
        } else {
          console.log(chalk.dim(`No ${p} assignment to release.`));
        }
      }
    });
}
