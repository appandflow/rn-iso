// src/commands/ios.js
import chalk from 'chalk';
import prompts from 'prompts';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, allClaimedDevices, recordSimUsage, getSimUsage } from '../config.js';
import { allocatePort, isMetroRunning } from '../ports.js';
import { selectIosDevice, bootIosSim, listIosRuntimes, createIosSim, parseRuntimeVersion, listAllIosSims, sortSims } from '../sim/ios.js';
import { buildIosCommand, detectPackageManager } from '../runner.js';
import { getExecutor } from '../exec.js';

export default function iosCommand(program) {
  program
    .command('ios')
    .description('Ensure a dedicated iOS simulator + Metro server for the current project; build/install if needed')
    .option('--device-type <name>', 'Explicit opt-in: create a NEW sim of this device type (e.g. "iPhone 17 Pro")')
    .option('--runtime <version>', 'iOS runtime version when creating a new sim (e.g. "26.2"); defaults to latest')
    .option('--auto', 'Non-interactive: pick the first unclaimed sim without prompting')
    .option('--script <name>', 'package.json script to invoke for build/install (default: ios)', 'ios')
    .option('--no-script', 'Skip the package.json script lookup; run expo/react-native CLI directly')
    .option('--pm <name>', 'Package manager: npm, yarn, pnpm, bun (default: detected from lockfile)')
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
      const metroAlreadyUp = await isMetroRunning(proj.metroPort);
      console.log(chalk.dim(
        `Metro port: ${proj.metroPort}` +
        (metroAlreadyUp ? ' (already running)' : ' (will be started by build CLI)')
      ));

      const claimedDevices = allClaimedDevices();
      const ownUdid = proj.platforms?.ios?.deviceUdid;
      const claimed = claimedDevices.iosUdids.filter(u => u !== ownUdid);
      const usage = getSimUsage().ios || {};
      const selection = selectIosDevice({
        existingUdid: ownUdid || null,
        claimedUdids: claimed,
        usage,
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
        const picked = (selection.candidates.length === 1 || opts.auto)
          ? selection.candidates[0]
          : await pickSim(selection.candidates, claimedDevices.iosClaims, usage);
        udid = picked.udid;
        if (picked.state !== 'Booted') {
          console.log(chalk.dim(`Booting ${picked.name} (${udid})...`));
          bootIosSim(udid);
        } else {
          console.log(chalk.green(`Assigned ${picked.name} (${udid}, booted)`));
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
      recordSimUsage('ios', udid);

      // Metro is started by the build CLI (`expo run:ios` / `react-native
      // run-ios`) using the --port we pass below. We don't spawn a separate
      // Metro -- that caused two Metros on the same port. For Metro-only
      // (without build/install), use `rn-iso start`.

      if (opts.install !== false) {
        const packageManager = opts.pm || detectPackageManager(root);
        const useScript = opts.script !== false;
        const scriptName = useScript ? (typeof opts.script === 'string' ? opts.script : 'ios') : null;
        const cmd = buildIosCommand({
          projectRoot: root,
          packageManager,
          scriptName,
          isExpo,
          udid,
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

      console.log(chalk.green(`\nOK: iOS ready on sim ${udid}, Metro port ${proj.metroPort}`));
    });
}

async function pickSim(candidates, iosClaims = {}, usage = {}) {
  // Show ALL sims (not just unclaimed) so the user can see why something
  // they expected isn't selectable. Claimed sims are listed but disabled,
  // labeled with the project/reservation that owns them.
  const allSims = listAllIosSims();
  const candidateUdids = new Set(candidates.map(s => s.udid));
  const sorted = sortSims(allSims, usage);

  const nameWidth = Math.max(...sorted.map(s => s.name.length), 18);
  const choices = sorted.map(s => {
    const version = parseRuntimeVersion(s.runtime);
    const namePart = s.name.padEnd(nameWidth);
    const versionPart = version.padStart(6);
    const claim = iosClaims[s.udid];
    if (claim) {
      const tag = claim.source === 'project'
        ? `[claimed by ${claim.label}]`
        : `[reserved: ${claim.label}]`;
      return {
        title: chalk.dim(`${namePart}  ${versionPart}  ${tag}`),
        value: null,
        disabled: true,
      };
    }
    const stateTag = s.state === 'Booted' ? chalk.green('  [booted]') : '';
    const isCandidate = candidateUdids.has(s.udid);
    if (!isCandidate) {
      // Shouldn't happen with current selectIosDevice, but be safe.
      return { title: chalk.dim(`${namePart}  ${versionPart}`), value: null, disabled: true };
    }
    return {
      title: `${namePart}  ${chalk.dim(versionPart)}${stateTag}`,
      value: s,
    };
  });
  const answer = await prompts({
    type: 'select',
    name: 'sim',
    message: 'Pick a simulator:',
    choices,
  });
  if (!answer.sim) {
    console.error(chalk.red('Cancelled.'));
    process.exit(1);
  }
  return answer.sim;
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
