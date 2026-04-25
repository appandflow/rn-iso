// src/commands/ios.js
import chalk from 'chalk';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, allClaimedDevices } from '../config.js';
import { allocatePort } from '../ports.js';
import { selectIosDevice, bootIosSim, listIosRuntimes, createIosSim } from '../sim/ios.js';
import { ensureMetro } from '../metro.js';
import { buildIosCommand, resolveSimNameByUdid } from '../runner.js';
import { getExecutor } from '../exec.js';

export default function iosCommand(program) {
  program
    .command('ios')
    .description('Ensure a dedicated iOS simulator + Metro server for the current project; build/install if needed')
    .option('--device-type <name>', 'Explicit opt-in: create a NEW sim of this device type (e.g. "iPhone 17 Pro")')
    .option('--runtime <version>', 'iOS runtime version when creating a new sim (e.g. "26.2"); defaults to latest')
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

      upsertProject(root, { bundleId, androidPackage, isExpo });
      let proj = getProject(root);

      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
        console.log(chalk.dim(`Allocated Metro port: ${port}`));
      }

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
        if (selection.state !== 'Booted') {
          console.log(chalk.dim(`Booting unclaimed sim ${udid}...`));
          bootIosSim(udid);
        } else {
          console.log(chalk.green(`Assigned booted sim ${udid}`));
        }
      } else {
        // needsBoot: no unclaimed sim available.
        if (opts.deviceType) {
          udid = createNewSim({ deviceType: opts.deviceType, runtimeVersion: opts.runtime });
          console.log(chalk.green(`Created and booted new sim ${udid}`));
        } else {
          console.error(chalk.red('No unclaimed iOS simulator available.'));
          console.error(chalk.dim('Options:'));
          console.error(chalk.dim('  - Open a sim in the Simulator app, then re-run'));
          console.error(chalk.dim('  - `rn-iso unreserve --all` if you have stale reservations'));
          console.error(chalk.dim('  - Free another rn-iso project (`rn-iso release` from there)'));
          console.error(chalk.dim('  - Pass --device-type "iPhone 17 Pro" [--runtime 26.2] to create a new sim'));
          process.exit(1);
        }
      }

      setDevice(root, 'ios', { deviceUdid: udid });

      const metro = await ensureMetro({ projectPath: root, isExpo, port: proj.metroPort });
      if (metro.alreadyRunning) {
        console.log(chalk.dim(`Metro already running on port ${proj.metroPort}`));
      } else {
        setMetro(root, proj.metroPort, metro.pid);
        console.log(chalk.green(`Metro started (pid ${metro.pid}, port ${proj.metroPort}) -- logs at ~/.rn-iso/logs/`));
      }

      if (opts.install !== false) {
        const simName = isExpo ? null : resolveSimNameByUdid(udid);
        const cmd = buildIosCommand({ isExpo, udid, port: proj.metroPort, simName });
        console.log(chalk.dim(`> ${cmd}`));
        const exec = getExecutor();
        const child = exec.spawn('sh', ['-c', cmd], { cwd: root, stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code})`)));
        });
      }

      console.log(chalk.green(`\nOK: iOS ready on sim ${udid}, Metro port ${proj.metroPort}`));
    });
}

function createNewSim({ deviceType, runtimeVersion }) {
  const runtimes = listIosRuntimes();
  if (runtimes.length === 0) {
    throw new Error('No iOS runtimes installed; install one via Xcode.');
  }

  // Pick the runtime: explicit version flag, else the latest.
  let runtime;
  if (runtimeVersion) {
    runtime = runtimes.find(r => r.version === runtimeVersion || r.name === `iOS ${runtimeVersion}`);
    if (!runtime) {
      const available = runtimes.map(r => r.version).join(', ');
      throw new Error(`Runtime "${runtimeVersion}" not installed. Available: ${available}`);
    }
  } else {
    runtime = [...runtimes].sort(
      (a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })
    )[0];
  }

  // Resolve the device type within the chosen runtime's compatible list.
  const supported = runtime.supportedDeviceTypes || [];
  const dt = supported.find(d => d.name === deviceType || d.identifier === deviceType);
  if (!dt) {
    const names = supported.map(d => d.name).slice(0, 8).join(', ');
    throw new Error(
      `Device type "${deviceType}" not compatible with runtime ${runtime.version}. ` +
      `Compatible (sample): ${names}...`
    );
  }

  const udid = createIosSim(dt.identifier, runtime.identifier);
  bootIosSim(udid);
  return udid;
}
