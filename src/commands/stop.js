// src/commands/stop.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject, setMetro } from '../config.js';
import { killMetroByPid } from '../metro.js';

export default function stopCommand(program) {
  program
    .command('stop')
    .description('Kill the Metro process for the current project')
    .action(() => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project.'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj?.metroPid) {
        console.log(chalk.dim('No Metro PID recorded for this project.'));
        return;
      }
      const ok = killMetroByPid(proj.metroPid);
      setMetro(root, proj.metroPort, null);
      console.log(ok
        ? chalk.green(`Killed Metro pid ${proj.metroPid}`)
        : chalk.dim(`Metro pid ${proj.metroPid} was not alive`));
    });
}
