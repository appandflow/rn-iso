// src/commands/release.js
import chalk from 'chalk';
import { resolveRegisteredProject } from '../project.js';
import { getProject, clearDevice } from '../config.js';

export default function releaseCommand(program) {
  program
    .command('release [project]')
    .description('Unbind device assignment(s). [project] is the directory basename or absolute path; defaults to the current project.')
    .option('--platform <platform>', 'ios or android (default: both)')
    .action((project, opts) => {
      const { found, error } = resolveRegisteredProject(project);
      if (!found) {
        console.error(chalk.red(error));
        process.exit(1);
      }
      const proj = getProject(found);
      if (!proj) {
        console.log(chalk.dim('No project entry to release.'));
        return;
      }
      const platforms = opts.platform ? [opts.platform] : ['ios', 'android'];
      for (const p of platforms) {
        if (proj.platforms?.[p]) {
          clearDevice(found, p);
          console.log(chalk.green(`Released ${p} assignment for ${found.split('/').pop()}.`));
        } else {
          console.log(chalk.dim(`No ${p} assignment to release for ${found.split('/').pop()}.`));
        }
      }
    });
}
