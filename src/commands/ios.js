// src/commands/ios.js
import chalk from 'chalk';
import prompts from 'prompts';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, allClaimedDevices } from '../config.js';
import { allocatePort } from '../ports.js';
import { selectIosDevice, bootIosSim, listIosDeviceTypes, listIosRuntimes, createIosSim } from '../sim/ios.js';
import { ensureMetro } from '../metro.js';
import { buildIosCommand, resolveSimNameByUdid } from '../runner.js';
import { getExecutor } from '../exec.js';

export default function iosCommand(program) {
  program
    .command('ios')
    .description('Ensure a dedicated iOS simulator + Metro server for the current project; build/install if needed')
    .option('--device-type <name>', 'Device type identifier for new sim (e.g. "iPhone 15 Pro")')
    .option('--auto', 'Non-interactive: boot a fresh sim if none available, no prompts')
    .option('--no-install', 'Skip the build/install step (assume app is already installed)')
    .action(async (opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }

      const bundleId = detectBundleId(root);
      const androidPackage = detectAndroidPackage(root);
      const isExpo = detectIsExpo(root);
      if (!bundleId) {
        console.error(chalk.red('Could not detect iOS bundle identifier. v1 requires app.json with expo.ios.bundleIdentifier set.'));
        process.exit(1);
      }

      // Register or update the project entry.
      let proj = getProject(root);
      if (!proj) {
        upsertProject(root, { bundleId, androidPackage, isExpo });
      } else {
        upsertProject(root, { bundleId, androidPackage, isExpo });
      }
      proj = getProject(root);

      // Allocate Metro port if not yet assigned.
      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
        console.log(chalk.dim(`Allocated Metro port: ${port}`));
      }

      // Pick (or reuse) a simulator.
      const claimed = allClaimedDevices().iosUdids.filter(u => u !== proj.platforms?.ios?.deviceUdid);
      const selection = selectIosDevice({
        existingUdid: proj.platforms?.ios?.deviceUdid || null,
        claimedUdids: claimed,
      });

      let udid;
      if (selection.kind === 'reuse') {
        udid = selection.udid;
        if (selection.state !== 'Booted') {
          console.log(chalk.dim(`Booting assigned sim ${udid}...`));
          bootIosSim(udid);
        } else {
          console.log(chalk.dim(`Reusing assigned sim ${udid} (already booted)`));
        }
      } else if (selection.kind === 'allocate') {
        udid = selection.udid;
        console.log(chalk.green(`Assigned booted sim ${udid}`));
      } else {
        // needsBoot: nothing booted+unclaimed.
        udid = await bootNewSim({ auto: opts.auto, deviceType: opts.deviceType });
        console.log(chalk.green(`Booted new sim ${udid}`));
      }

      setDevice(root, 'ios', { deviceUdid: udid });

      // Ensure Metro is running.
      const metro = await ensureMetro({ projectPath: root, isExpo, port: proj.metroPort });
      if (metro.alreadyRunning) {
        console.log(chalk.dim(`Metro already running on port ${proj.metroPort}`));
      } else {
        setMetro(root, proj.metroPort, metro.pid);
        console.log(chalk.green(`Metro started (pid ${metro.pid}, port ${proj.metroPort}) — logs at ~/.rn-iso/logs/`));
      }

      // Build/install/launch unless --no-install.
      if (opts.install !== false) {
        const simName = isExpo ? null : resolveSimNameByUdid(udid);
        const cmd = buildIosCommand({ isExpo, udid, port: proj.metroPort, simName });
        console.log(chalk.dim(`> ${cmd}`));
        // Stream the build output via spawn-with-inherit-stdio.
        const exec = getExecutor();
        const child = exec.spawn('sh', ['-c', cmd], { cwd: root, stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code})`)));
        });
      }

      console.log(chalk.green(`\n✓ iOS ready on sim ${udid}, Metro port ${proj.metroPort}`));
    });
}

async function bootNewSim({ auto, deviceType }) {
  const types = listIosDeviceTypes().filter(t => t.identifier.includes('iPhone'));
  const runtimes = listIosRuntimes();
  if (runtimes.length === 0) throw new Error('No iOS runtimes installed; install one via Xcode.');
  const latestRuntime = runtimes.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];

  let chosenType;
  if (deviceType) {
    chosenType = types.find(t => t.name === deviceType || t.identifier === deviceType);
    if (!chosenType) throw new Error(`Device type not found: ${deviceType}`);
  } else if (auto) {
    chosenType = types.find(t => t.name === 'iPhone 15 Pro') || types[0];
  } else {
    const choices = types.map(t => ({ title: t.name, value: t.identifier }));
    const answer = await prompts({
      type: 'select',
      name: 'id',
      message: 'No booted simulator available. Pick a device type to boot:',
      choices,
    });
    if (!answer.id) throw new Error('Cancelled.');
    chosenType = types.find(t => t.identifier === answer.id);
  }

  const udid = createIosSim(chosenType.identifier, latestRuntime.identifier);
  bootIosSim(udid);
  return udid;
}
