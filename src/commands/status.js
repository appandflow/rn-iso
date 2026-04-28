// src/commands/status.js
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { isMetroRunning } from '../ports.js';
import { isPidAlive } from '../metro.js';
import { findProjectRoot } from '../project.js';

export default function statusCommand(program) {
  program
    .command('status')
    .description('Show all rn-iso project assignments and Metro state')
    .action(async () => {
      const cfg = loadConfig();
      const hasProjects = cfg && Object.keys(cfg.projects || {}).length > 0;
      if (!hasProjects) {
        console.log(chalk.dim('No projects registered.'));
        return;
      }

      const cwdRoot = findProjectRoot(process.cwd());

      for (const [path, proj] of Object.entries(cfg?.projects || {})) {
        const isCurrent = path === cwdRoot;
        const header = isCurrent ? chalk.bold.cyan(`* ${path}`) : path;
        console.log('\n' + header);
        console.log(chalk.dim(`  app: ${proj.bundleId} (${proj.isExpo ? 'expo' : 'bare'})`));

        if (proj.metroPort) {
          const running = await isMetroRunning(proj.metroPort);
          const pidLive = isPidAlive(proj.metroPid);
          const label = running
            ? chalk.green('running')
            : pidLive ? chalk.yellow('pid alive but not responding') : chalk.dim('stopped');
          console.log(`  metro: port ${proj.metroPort} pid ${proj.metroPid ?? '?'} (${label})`);
        } else {
          console.log(chalk.dim('  metro: unassigned'));
        }

        const ios = proj.platforms?.ios;
        if (ios) console.log(`  ios: ${chalk.cyan(ios.deviceUdid)}`);
        const android = proj.platforms?.android;
        if (android) console.log(`  android: ${chalk.cyan(android.avdName)} on emulator-${android.consolePort}`);
      }
      console.log('');
    });
}
