// src/commands/prune.js
import { existsSync } from 'fs';
import chalk from 'chalk';
import { loadConfig, removeProject, clearDevice } from '../config.js';
import { listAllIosSims, shutdownIosSim } from '../sim/ios.js';
import { listAvds, shutdownAndroidEmulator } from '../sim/android.js';

export default function pruneCommand(program) {
  program
    .command('prune')
    .description('Garbage-collect dead project entries and missing device assignments')
    .option('--shutdown', 'Also shut down sims/emulators referenced only by dropped entries')
    .action((opts) => {
      const cfg = loadConfig();
      if (!cfg?.projects) {
        console.log(chalk.dim('Nothing to prune.'));
        return;
      }

      const allIosUdids = new Set(listAllIosSims().map(s => s.udid));
      const allAvds = new Set(listAvds());

      const droppedSims = [];
      const droppedEmulators = [];

      for (const [path, proj] of Object.entries(cfg.projects)) {
        // Drop entire project if its dir is gone.
        if (!existsSync(path)) {
          if (opts.shutdown) {
            if (proj.platforms?.ios?.deviceUdid) droppedSims.push(proj.platforms.ios.deviceUdid);
            if (proj.platforms?.android?.consolePort) droppedEmulators.push(proj.platforms.android.consolePort);
          }
          removeProject(path);
          console.log(chalk.yellow(`Dropped missing project: ${path}`));
          continue;
        }

        // Drop iOS assignment if UDID no longer exists.
        if (proj.platforms?.ios && !allIosUdids.has(proj.platforms.ios.deviceUdid)) {
          clearDevice(path, 'ios');
          console.log(chalk.dim(`${path}: cleared stale iOS assignment ${proj.platforms.ios.deviceUdid}`));
        }
        // Drop Android assignment if AVD no longer exists.
        if (proj.platforms?.android && !allAvds.has(proj.platforms.android.avdName)) {
          clearDevice(path, 'android');
          console.log(chalk.dim(`${path}: cleared stale Android assignment ${proj.platforms.android.avdName}`));
        }
      }

      if (opts.shutdown) {
        for (const udid of droppedSims) shutdownIosSim(udid);
        for (const port of droppedEmulators) shutdownAndroidEmulator(`emulator-${port}`);
      }

      console.log(chalk.green('Prune complete.'));
    });
}
