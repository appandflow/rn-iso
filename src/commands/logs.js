// src/commands/logs.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { logFileExists } from '../metro.js';
import { getExecutor } from '../exec.js';

export default function logsCommand(program) {
  program
    .command('logs')
    .description('Tail the Metro log file for the current project')
    .action(() => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project.'));
        process.exit(1);
      }
      const path = logFileExists(root);
      if (!path) {
        console.error(chalk.red('No Metro log file found. Have you run `rn-iso start` or `rn-iso ios/android`?'));
        process.exit(1);
      }
      console.log(chalk.dim(`Tailing ${path}\n`));
      const exec = getExecutor();
      const child = exec.spawn('tail', ['-f', path], { stdio: 'inherit' });
      // Forward SIGINT cleanly
      process.on('SIGINT', () => child.kill('SIGINT'));
    });
}
