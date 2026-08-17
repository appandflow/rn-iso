// src/commands/logs.js
import chalk from 'chalk';
import { existsSync } from 'fs';
import { resolveRegisteredProject } from '../project.js';
import { findProjectByMetroPort } from '../config.js';
import { logFileFor } from '../metro.js';
import { getExecutor } from '../exec.js';

export default function logsCommand(program) {
  program
    .command('logs [target]')
    .description('Print the managed Metro log (bundle progress, resolution errors, client logs). With no arg, the current project. Pass a port (e.g. 8083), a project shortcut, or an absolute path.')
    .option('-n, --lines <count>', 'Number of trailing lines to print', '50')
    .option('-f, --follow', 'Stream the log as it grows (Ctrl-C to stop)')
    .action(async (target, opts) => {
      let root;
      if (target && /^\d+$/.test(target)) {
        root = findProjectByMetroPort(parseInt(target, 10));
        if (!root) {
          console.error(chalk.red(`No project owns Metro port ${target}.`));
          process.exit(1);
        }
      } else {
        const { found, error } = resolveRegisteredProject(target);
        if (!found) {
          console.error(chalk.red(error));
          process.exit(1);
        }
        root = found;
      }

      const path = logFileFor(root);
      if (!existsSync(path)) {
        console.error(chalk.red(`No Metro log for ${root}.`));
        console.error(chalk.dim('The log is created when rn-iso starts Metro (rn-iso up ios / up android / start).'));
        process.exit(1);
      }

      console.log(chalk.dim(`log: ${path}`));
      const args = opts.follow
        ? ['-n', String(opts.lines), '-f', path]
        : ['-n', String(opts.lines), path];
      const child = getExecutor().spawn('tail', args, { stdio: 'inherit' });
      await new Promise((resolve) => child.on('exit', resolve));
    });
}
