// src/commands/start.js
import chalk from 'chalk';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro } from '../config.js';
import { allocatePort } from '../ports.js';
import { ensureMetro } from '../metro.js';

export default function startCommand(program) {
  program
    .command('start')
    .description('Ensure Metro is running for the current project (no platform action). Pass extra flags to `expo start` / `react-native start` after `--`, e.g. `rn-iso start -- --reset-cache`.')
    .argument('[extras...]', 'Flags forwarded as-is to expo/react-native start (after `--`)')
    .action(async (extras) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }
      const isExpo = detectIsExpo(root);

      let proj = getProject(root);
      if (!proj) {
        upsertProject(root, {
          bundleId: detectBundleId(root),
          androidPackage: detectAndroidPackage(root),
          isExpo,
        });
        proj = getProject(root);
      }
      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
      }

      const metro = await ensureMetro({ projectPath: root, isExpo, port: proj.metroPort, extras });
      if (metro.alreadyRunning) {
        if (extras?.length) {
          console.log(chalk.yellow(
            `Metro already running on port ${proj.metroPort}; extras (${extras.join(' ')}) were not applied. ` +
            `Run \`rn-iso stop\` first and re-run to apply them.`
          ));
        } else {
          console.log(chalk.dim(`Metro already running on port ${proj.metroPort}`));
        }
      } else {
        setMetro(root, proj.metroPort, metro.pid);
        console.log(chalk.green(`Metro started (pid ${metro.pid}, port ${proj.metroPort})`));
      }
    });
}
