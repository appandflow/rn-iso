// src/commands/status.js
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { isMetroRunning } from '../ports.js';
import { findProjectRoot, projectShortcut } from '../project.js';
import { listAllIosSims } from '../sim/ios.js';

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

      // Build a UDID -> sim name map so we can show "iPhone 16 Pro (UDID)"
      // rather than a raw UDID. Tolerate missing simctl (Linux dev box, etc.).
      let iosNameByUdid = {};
      try {
        for (const sim of listAllIosSims()) iosNameByUdid[sim.udid] = sim.name;
      } catch { /* no simctl available; we'll just print the udid */ }

      for (const [path, proj] of Object.entries(cfg?.projects || {})) {
        const isCurrent = path === cwdRoot;
        const shortcut = projectShortcut(path, proj);
        const headerText = `${shortcut} ${chalk.dim(`(${path})`)}`;
        const header = isCurrent ? chalk.bold.cyan(`* ${shortcut}`) + ' ' + chalk.dim(`(${path})`) : headerText;
        console.log('\n' + header);
        console.log(chalk.dim(`  app: ${proj.bundleId ?? '?'} (${proj.isExpo ? 'expo' : 'bare'})`));

        if (proj.metroPort) {
          const running = await isMetroRunning(proj.metroPort);
          const label = running ? chalk.green('running') : chalk.dim('not running');
          console.log(`  metro: port ${proj.metroPort} (${label})`);
        } else {
          console.log(chalk.dim('  metro: unassigned'));
        }

        const ios = proj.platforms?.ios;
        if (ios) {
          const name = iosNameByUdid[ios.deviceUdid] || chalk.dim('(unknown sim)');
          const owned = ios.owned ? chalk.dim(' (owned)') : '';
          console.log(`  ios: ${chalk.cyan(name)} ${chalk.dim(`(${ios.deviceUdid})`)}${owned}`);
        }
        const android = proj.platforms?.android;
        if (android) {
          const owned = android.owned ? chalk.dim(' (owned)') : '';
          if (android.serial && !android.avdName) {
            console.log(`  android: ${chalk.cyan(android.serial)} ${chalk.dim('(physical)')}${owned}`);
          } else {
            console.log(`  android: ${chalk.cyan(android.avdName)} ${chalk.dim(`(emulator-${android.consolePort})`)}${owned}`);
          }
        }
      }
      console.log('');
    });
}
