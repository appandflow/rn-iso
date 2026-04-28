// src/commands/release.js
import chalk from 'chalk';
import { resolveRegisteredProject } from '../project.js';
import { getProject, clearDevice } from '../config.js';
import { shutdownIosSim } from '../sim/ios.js';
import { shutdownAndroidEmulator } from '../sim/android.js';

export default function releaseCommand(program) {
  program
    .command('release [target]')
    .description('Free a project assignment. [target] is an absolute project path; defaults to the current project.')
    .option('--platform <platform>', 'ios or android (default: both)')
    .option('--shutdown', 'Also shut down the simulator/emulator after releasing')
    .action((target, opts) => {
      const { found, error } = resolveRegisteredProject(target);
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
