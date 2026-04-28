// src/commands/android.js
import chalk from 'chalk';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, allClaimedDevices } from '../config.js';
import { allocatePort, isMetroRunning } from '../ports.js';
import { selectAndroidDevice, bootAndroidEmulator, waitForBoot, adbReverse } from '../sim/android.js';
import { buildAndroidCommand, detectPackageManager } from '../runner.js';
import { getExecutor } from '../exec.js';

export default function androidCommand(program) {
  program
    .command('android')
    .description('Ensure a dedicated Android emulator + Metro for the current project; build/install if needed')
    .option('--script <name>', 'package.json script to invoke for build/install (default: android)', 'android')
    .option('--no-script', 'Skip the package.json script lookup; run expo/react-native CLI directly')
    .option('--pm <name>', 'Package manager: npm, yarn, pnpm, bun (default: detected from lockfile)')
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

      upsertProject(root, { bundleId, androidPackage, isExpo });
      let proj = getProject(root);

      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
        console.log(chalk.dim(`Allocated Metro port: ${port}`));
      }
      const metroAlreadyUp = await isMetroRunning(proj.metroPort);
      console.log(chalk.dim(
        `Metro port: ${proj.metroPort}` +
        (metroAlreadyUp ? ' (already running)' : ' (will be started by build CLI)')
      ));

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

      // Metro is started by the build CLI; we don't spawn our own. For
      // Metro-only (no build/install), use `rn-iso start`.

      adbReverse(serial, proj.metroPort);
      console.log(chalk.dim(`adb reverse tcp:${proj.metroPort} configured for ${serial}`));

      if (opts.install !== false) {
        const packageManager = opts.pm || detectPackageManager(root);
        const useScript = opts.script !== false;
        const scriptName = useScript ? (typeof opts.script === 'string' ? opts.script : 'android') : null;
        const cmd = buildAndroidCommand({
          projectRoot: root,
          packageManager,
          scriptName,
          isExpo,
          serial,
          port: proj.metroPort,
          useScript,
        });
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
