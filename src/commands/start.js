// src/commands/start.js
import chalk from 'chalk';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro } from '../config.js';
import { allocatePort } from '../ports.js';
import { ensureMetro } from '../metro.js';

export default function startCommand(program) {
  program
    .command('start')
    .description('Ensure Metro is running for the current project (no platform action)')
    .action(async () => {
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

      const metro = await ensureMetro({ projectPath: root, isExpo, port: proj.metroPort });
      if (metro.alreadyRunning) {
        console.log(chalk.dim(`Metro already running on port ${proj.metroPort}`));
      } else {
        setMetro(root, proj.metroPort, metro.pid);
        console.log(chalk.green(`Metro started (pid ${metro.pid}, port ${proj.metroPort})`));
      }
    });
}
