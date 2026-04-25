// src/commands/shutdown.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject, clearDevice } from '../config.js';
import { shutdownIosSim } from '../sim/ios.js';
import { shutdownAndroidEmulator } from '../sim/android.js';

export default function shutdownCommand(program) {
  program
    .command('shutdown')
    .description('Release and shut down the simulator/emulator(s) for the current project')
    .option('--platform <platform>', 'ios or android (default: both)')
    .action((opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project.'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj) {
        console.log(chalk.dim('No project entry.'));
        return;
      }
      const platforms = opts.platform ? [opts.platform] : ['ios', 'android'];
      for (const p of platforms) {
        const entry = proj.platforms?.[p];
        if (!entry) {
          console.log(chalk.dim(`No ${p} assignment.`));
          continue;
        }
        if (p === 'ios') {
          shutdownIosSim(entry.deviceUdid);
          console.log(chalk.green(`Shut down iOS sim ${entry.deviceUdid}`));
        } else {
          shutdownAndroidEmulator(`emulator-${entry.consolePort}`);
          console.log(chalk.green(`Shut down emulator-${entry.consolePort}`));
        }
        clearDevice(root, p);
      }
    });
}
