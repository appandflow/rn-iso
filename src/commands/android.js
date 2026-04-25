// src/commands/android.js
import chalk from 'chalk';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, allClaimedDevices } from '../config.js';
import { allocatePort } from '../ports.js';
import { selectAndroidDevice, bootAndroidEmulator, waitForBoot, adbReverse, listAdbDevices } from '../sim/android.js';
import { ensureMetro } from '../metro.js';
import { buildAndroidCommand } from '../runner.js';
import { getExecutor } from '../exec.js';

export default function androidCommand(program) {
  program
    .command('android')
    .description('Ensure a dedicated Android emulator + Metro for the current project; build/install if needed')
    .option('--no-install', 'Skip the build/install step')
    .action(async (opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }

      const bundleId = detectBundleId(root);
      const androidPackage = detectAndroidPackage(root);
      const isExpo = detectIsExpo(root);
      if (!androidPackage) {
        console.error(chalk.red('Could not detect Android package. v1 requires app.json with expo.android.package set.'));
        process.exit(1);
      }

      let proj = getProject(root);
      if (!proj) {
        upsertProject(root, { bundleId, androidPackage, isExpo });
      } else {
        upsertProject(root, { bundleId, androidPackage, isExpo });
      }
      proj = getProject(root);

      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
        console.log(chalk.dim(`Allocated Metro port: ${port}`));
      }

      const claimed = allClaimedDevices();
      const myAvd = proj.platforms?.android?.avdName || null;
      const myPort = proj.platforms?.android?.consolePort || null;
      const claimedAvds = claimed.androidAvds.filter(a => a !== myAvd);
      const claimedPorts = claimed.androidConsolePorts.filter(p => p !== myPort);

      const selection = selectAndroidDevice({
        existingAvd: myAvd,
        existingConsolePort: myPort,
        claimedAvds,
        claimedConsolePorts: claimedPorts,
      });

      if (selection.kind === 'noAvd') {
        console.error(chalk.red(
          'No AVDs available (or all are claimed by other projects). ' +
          'Create one via Android Studio (Tools -> Device Manager).'
        ));
        process.exit(1);
      }

      const { avdName, consolePort, isRunning } = selection;
      const serial = `emulator-${consolePort}`;

      if (!isRunning) {
        console.log(chalk.dim(`Booting emulator ${avdName} on port ${consolePort}...`));
        bootAndroidEmulator(avdName, consolePort);
        console.log(chalk.dim('Waiting for boot to complete (this can take 10-30s)...'));
        const ok = await waitForBoot(serial, 120000);
        if (!ok) {
          console.error(chalk.red(`Emulator ${serial} did not finish booting within 2 minutes.`));
          process.exit(1);
        }
      } else {
        console.log(chalk.dim(`Reusing running emulator ${serial}`));
      }

      setDevice(root, 'android', { avdName, consolePort });

      const metro = await ensureMetro({ projectPath: root, isExpo, port: proj.metroPort });
      if (metro.alreadyRunning) {
        console.log(chalk.dim(`Metro already running on port ${proj.metroPort}`));
      } else {
        setMetro(root, proj.metroPort, metro.pid);
        console.log(chalk.green(`Metro started (pid ${metro.pid}, port ${proj.metroPort})`));
      }

      adbReverse(serial, proj.metroPort);
      console.log(chalk.dim(`adb reverse tcp:${proj.metroPort} configured for ${serial}`));

      if (opts.install !== false) {
        const cmd = buildAndroidCommand({ isExpo, serial, port: proj.metroPort });
        console.log(chalk.dim(`> ${cmd}`));
        const exec = getExecutor();
        const child = exec.spawn('sh', ['-c', cmd], { cwd: root, stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code})`)));
        });
      }

      console.log(chalk.green(`\nAndroid ready on ${serial}, Metro port ${proj.metroPort}`));
    });
}
