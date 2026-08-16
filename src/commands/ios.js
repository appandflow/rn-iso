// src/commands/ios.js
import chalk from 'chalk';
import prompts from 'prompts';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, clearDevice, allClaimedDevices, recordSimUsage, getSimUsage } from '../config.js';
import { allocatePort, isMetroRunning } from '../ports.js';
import { ensureMetro, logFileFor } from '../metro.js';
import { selectIosDevice, bootIosSim, listIosRuntimes, createIosSim, parseRuntimeVersion, listAllIosSims, sortSims, formatIosLabel, findOccupiedSims, listBootedIosSims } from '../sim/ios.js';
import { buildIosCommand, detectPackageManager } from '../runner.js';
import { getExecutor } from '../exec.js';
import { resolveLabel } from '../labels.js';

export default function iosCommand(program) {
  program
    .command('ios')
    .description('Ensure a dedicated iOS simulator + Metro server for the current project; build/install if needed. Pass extra flags to the build CLI after `--`, e.g. `rn-iso ios -- --variant=release`.')
    .argument('[extras...]', 'Flags forwarded as-is to the underlying build command (after `--`)')
    .option('--device-type <name>', 'Explicit opt-in: create a NEW sim of this device type (e.g. "iPhone 17 Pro")')
    .option('--runtime <version>', 'iOS runtime version when creating a new sim (e.g. "26.2"); defaults to latest')
    .option('--auto', 'Non-interactive: pick the first unclaimed sim without prompting (also implied when stdin is not a TTY)')
    .option('--managed-metro', 'rn-iso starts Metro itself: detached (survives the invoking shell), logged to the per-project file; the build CLI is passed --no-packager / --no-bundler. Recommended for agents and CI; without it the build CLI owns Metro as usual.')
    .option('--label <name>', 'Optional shortcut name; refer to the project as <name> in stop / release / etc.')
    .option('--script <name>', 'package.json script to invoke for build/install (default: project setting `ios.script`, else `ios`)')
    .option('--no-script', 'Skip the package.json script lookup; run expo/react-native CLI directly')
    .option('--pm <name>', 'Package manager: npm, yarn, pnpm, bun (default: project setting `packageManager`, else detected from lockfile)')
    .option('--no-install', 'Skip the build/install step (assume app is already installed)')
    .action(async (extras, opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }

      // Treat non-TTY environments (agents, CI) as if --auto was passed.
      const auto = opts.auto || !process.stdin.isTTY;

      const bundleId = detectBundleId(root);
      const androidPackage = detectAndroidPackage(root);
      const isExpo = detectIsExpo(root);

      const existing = getProject(root);
      const label = await resolveLabel({ root, existingProject: existing, optsLabel: opts.label });
      upsertProject(root, {
        bundleId,
        androidPackage,
        isExpo,
        ...(label ? { label } : {}),
      });
      let proj = getProject(root);

      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
        console.log(chalk.dim(`Allocated Metro port: ${port}`));
      }
      // With --managed-metro, rn-iso owns Metro: detached so it survives the
      // invoking shell (agents run builds from finite shells), output to the
      // per-project log file. The build CLI is then kept from starting its own:
      // bare RN gets --no-packager; expo gets --port and reuses the Metro
      // already listening on that port. ensureMetro waits for /status so the
      // port is bound before the build's reuse check runs. Without the flag,
      // the build CLI owns Metro as usual (interactive bundler UX for humans).
      if (opts.managedMetro) {
        const metro = await ensureMetro({ projectPath: root, isExpo, port: proj.metroPort });
        if (metro.alreadyRunning) {
          console.log(chalk.dim(`Metro port: ${proj.metroPort} (already running)`));
        } else {
          setMetro(root, proj.metroPort, metro.pid);
          console.log(chalk.dim(`Metro started detached (pid ${metro.pid}, port ${proj.metroPort})`));
          console.log(chalk.dim(`Metro log: ${logFileFor(root)}`));
          if (!metro.ready) {
            console.log(chalk.yellow(`Warning: Metro on port ${proj.metroPort} did not report ready; the build may start its own.`));
          }
        }
      } else {
        const metroAlreadyUp = await isMetroRunning(proj.metroPort);
        console.log(chalk.dim(
          `Metro port: ${proj.metroPort}` +
          (metroAlreadyUp ? ' (already running)' : ' (will be started by build CLI)')
        ));
      }

      const claimedDevices = allClaimedDevices();
      const ownUdid = proj.platforms?.ios?.deviceUdid;
      const claimed = claimedDevices.iosUdids.filter(u => u !== ownUdid);
      const usage = getSimUsage().ios || {};
      // Only booted sims can be occupied by a foreign runner, and only ones
      // we have not already claimed ourselves are worth probing.
      const bootedUdids = listBootedIosSims().map(s => s.udid);
      const occupiedUdids = findOccupiedSims(bootedUdids.filter(u => !claimed.includes(u)));
      const selection = selectIosDevice({
        existingUdid: ownUdid || null,
        claimedUdids: claimed,
        occupiedUdids,
        usage,
      });

      let udid;
      if (selection.kind === 'reuse') {
        udid = selection.udid;
        const label = `${selection.name} (${udid})`;
        if (selection.state !== 'Booted') {
          console.log(chalk.dim(`Booting assigned sim ${label}...`));
          bootIosSim(udid);
        } else {
          console.log(chalk.dim(`Reusing assigned sim ${label} (already booted)`));
        }
      } else if (selection.kind === 'allocate') {
        const picked = (selection.candidates.length === 1 || auto)
          ? { sim: selection.candidates[0], prevClaim: null }
          : await pickSim({
              candidates: selection.candidates,
              iosClaims: claimedDevices.iosClaims,
              occupiedUdids,
              usage,
            });
        udid = picked.sim.udid;
        releasePriorClaim(picked.prevClaim);
        if (picked.sim.state !== 'Booted') {
          console.log(chalk.dim(`Booting ${picked.sim.name} (${udid})...`));
          bootIosSim(udid);
        } else {
          console.log(chalk.green(`Assigned ${picked.sim.name} (${udid}, booted)`));
        }
      } else if (selection.kind === 'allClaimed') {
        // Sims exist but every one is claimed by another project. With
        // --auto, refuse rather than silently stealing. Interactive: show
        // picker so the user can confirm-steal one.
        if (auto) {
          if (opts.deviceType) {
            udid = createNewSim({ deviceType: opts.deviceType, runtimeVersion: opts.runtime });
            console.log(chalk.green(`Created and booted new sim ${formatIosLabel(udid)}`));
          } else {
            console.error(chalk.red('All iOS simulators are claimed by other rn-iso projects.'));
            console.error(chalk.dim('Re-run without --auto to confirm taking one over, or pass --device-type to create a new sim.'));
            process.exit(1);
          }
        } else {
          const picked = await pickSim({
            candidates: [],
            iosClaims: claimedDevices.iosClaims,
            occupiedUdids,
            usage,
            allClaimed: true,
          });
          udid = picked.sim.udid;
          releasePriorClaim(picked.prevClaim);
          if (picked.sim.state !== 'Booted') {
            console.log(chalk.dim(`Booting ${picked.sim.name} (${udid})...`));
            bootIosSim(udid);
          } else {
            console.log(chalk.green(`Took over ${picked.sim.name} (${udid}, booted)`));
          }
        }
      } else {
        // noSims: no iOS simulators exist on this machine at all.
        if (opts.deviceType) {
          udid = createNewSim({ deviceType: opts.deviceType, runtimeVersion: opts.runtime });
          console.log(chalk.green(`Created and booted new sim ${udid}`));
        } else {
          console.error(chalk.red('No iOS simulators found.'));
          console.error(chalk.dim('Pass --device-type "iPhone 17 Pro" [--runtime 26.2] to create one,'));
          console.error(chalk.dim('or install a simulator runtime via Xcode.'));
          process.exit(1);
        }
      }

      setDevice(root, 'ios', { deviceUdid: udid });
      recordSimUsage('ios', udid);

      if (opts.install !== false) {
        const settings = proj.settings || {};
        const packageManager = opts.pm ?? settings.packageManager ?? detectPackageManager(root);
        const useScript = opts.script !== false;
        const scriptName = useScript
          ? (typeof opts.script === 'string' ? opts.script : (settings.ios?.script ?? 'ios'))
          : null;
        const cmd = buildIosCommand({
          projectRoot: root,
          packageManager,
          scriptName,
          isExpo,
          udid,
          port: proj.metroPort,
          useScript,
          noPackager: Boolean(opts.managedMetro),
          extras,
        });
        console.log(chalk.dim(`> ${cmd}`));
        const exec = getExecutor();
        const child = exec.spawn('sh', ['-c', cmd], { cwd: root, stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code})`)));
        });

      }

      console.log(chalk.green(`\nOK: iOS ready on sim ${formatIosLabel(udid)}, Metro port ${proj.metroPort}`));
    });
}

async function pickSim({ candidates, iosClaims = {}, occupiedUdids = [], usage = {}, allClaimed = false }) {
  // Show ALL sims so the user has full context. Unclaimed candidates pick
  // immediately; claimed and occupied sims are selectable too but require a
  // confirm prompt so the steal is intentional.
  const allSims = listAllIosSims();
  const candidateUdids = new Set(candidates.map(s => s.udid));
  const occupied = new Set(occupiedUdids);
  const sorted = sortSims(allSims, usage);

  const nameWidth = Math.max(...sorted.map(s => s.name.length), 18);
  const choices = sorted.map(s => {
    const version = parseRuntimeVersion(s.runtime);
    const namePart = s.name.padEnd(nameWidth);
    const versionPart = version.padStart(6);
    const claim = iosClaims[s.udid];
    if (claim) {
      const stateTag = s.state === 'Booted' ? chalk.green(' [booted]') : '';
      return {
        title: chalk.yellow(`${namePart}  ${versionPart}  [claimed by ${claim.label}]${stateTag}`),
        value: { sim: s, claim, occupied: false },
      };
    }
    if (occupied.has(s.udid)) {
      const stateTag = s.state === 'Booted' ? chalk.green(' [booted]') : '';
      return {
        title: chalk.yellow(`${namePart}  ${versionPart}  [in use]${stateTag}`),
        value: { sim: s, claim: null, occupied: true },
      };
    }
    const stateTag = s.state === 'Booted' ? chalk.green('  [booted]') : '';
    const isCandidate = candidateUdids.has(s.udid);
    if (!isCandidate) {
      return { title: chalk.dim(`${namePart}  ${versionPart}`), value: null, disabled: true };
    }
    return {
      title: `${namePart}  ${chalk.dim(versionPart)}${stateTag}`,
      value: { sim: s, claim: null, occupied: false },
    };
  });
  const message = allClaimed
    ? 'All sims are claimed or in use. Pick one to take over:'
    : 'Pick a simulator (claimed/in-use sims will prompt to confirm):';
  const answer = await prompts({
    type: 'select',
    name: 'pick',
    message,
    choices,
  });
  if (!answer.pick) {
    console.error(chalk.red('Cancelled.'));
    process.exit(1);
  }
  const { sim, claim, occupied: isOccupied } = answer.pick;
  if (claim) {
    const confirm = await prompts({
      type: 'confirm',
      name: 'ok',
      message: `${sim.name} is currently held by project "${claim.label}". Take it over?`,
      initial: false,
    });
    if (!confirm.ok) {
      console.error(chalk.red('Cancelled.'));
      process.exit(1);
    }
    return { sim, prevClaim: claim };
  }
  if (isOccupied) {
    const confirm = await prompts({
      type: 'confirm',
      name: 'ok',
      message: `${sim.name} appears to be in use by another process (e.g. a UI test runner). Take it over anyway?`,
      initial: false,
    });
    if (!confirm.ok) {
      console.error(chalk.red('Cancelled.'));
      process.exit(1);
    }
  }
  return { sim, prevClaim: null };
}

function releasePriorClaim(prevClaim) {
  if (!prevClaim?.path) return;
  clearDevice(prevClaim.path, 'ios');
  console.log(chalk.dim(`Released prior assignment from "${prevClaim.label}"`));
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
