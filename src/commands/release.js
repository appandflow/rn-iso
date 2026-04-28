// src/commands/release.js
import chalk from 'chalk';
import { resolveRegisteredProject } from '../project.js';
import { getProject, clearDevice, findProjectByMetroPort } from '../config.js';
import { shutdownIosSim } from '../sim/ios.js';
import { shutdownAndroidEmulator } from '../sim/android.js';

export default function releaseCommand(program) {
  program
    .command('release [target]')
    .description('Free a project assignment. [target] is a Metro port (e.g. 8083), a project shortcut (label or unique basename), or an absolute path. Defaults to the current project.')
    .option('--platform <platform>', 'ios or android (default: both)')
    .option('--shutdown', 'Also shut down the simulator/emulator after releasing')
    .action((target, opts) => {
      let found;
      if (target && /^\d+$/.test(target)) {
        const port = parseInt(target, 10);
        found = findProjectByMetroPort(port);
        if (!found) {
          console.error(chalk.red(`No registered project has Metro port ${port}.`));
          process.exit(1);
        }
      } else {
        const result = resolveRegisteredProject(target);
        if (!result.found) {
          console.error(chalk.red(result.error));
          process.exit(1);
        }
        found = result.found;
      }
      const proj = getProject(found);
      if (!proj) {
        console.log(chalk.dim('No project entry to release.'));
        return;
      }
      const platforms = opts.platform ? [opts.platform] : ['ios', 'android'];
      for (const p of platforms) {
        const entry = proj.platforms?.[p];
        if (!entry) {
          console.log(chalk.dim(`No ${p} assignment to release for ${found}.`));
          continue;
        }
        if (opts.shutdown) {
          if (p === 'ios') {
            shutdownIosSim(entry.deviceUdid);
            console.log(chalk.green(`Shut down iOS sim ${entry.deviceUdid}`));
          } else {
            shutdownAndroidEmulator(`emulator-${entry.consolePort}`);
            console.log(chalk.green(`Shut down emulator-${entry.consolePort}`));
          }
        }
        clearDevice(found, p);
        console.log(chalk.green(`Released ${p} assignment for ${found}.`));
      }
    });
}
