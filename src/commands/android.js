// src/commands/android.js
import chalk from 'chalk';
import prompts from 'prompts';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, clearDevice, allClaimedDevices } from '../config.js';
import { allocatePort, isMetroRunning } from '../ports.js';
import {
  selectAndroidDevice,
  sortAndroidCandidates,
  enumerateAndroidCandidates,
  bootAndroidEmulator,
  waitForBoot,
  adbReverse,
  nextConsolePort,
} from '../sim/android.js';
import { buildAndroidCommand, detectPackageManager } from '../runner.js';
import { getExecutor } from '../exec.js';
import { resolveLabel } from '../labels.js';

export default function androidCommand(program) {
  program
    .command('android')
    .description('Ensure a dedicated Android emulator + Metro for the current project; build/install if needed. Pass extra flags to the build CLI after `--`, e.g. `rn-iso android -- --mode=diaRelease`.')
    .argument('[extras...]', 'Flags forwarded as-is to the underlying build command (after `--`)')
    .option('--auto', 'Non-interactive: pick the first unclaimed AVD without prompting (also implied when stdin is not a TTY)')
    .option('--label <name>', 'Optional shortcut name; refer to the project as <name> in stop / release / etc.')
    .option('--script <name>', 'package.json script to invoke for build/install (default: project setting `android.script`, else `android`)')
    .option('--no-script', 'Skip the package.json script lookup; run expo/react-native CLI directly')
    .option('--pm <name>', 'Package manager: npm, yarn, pnpm, bun (default: project setting `packageManager`, else detected from lockfile)')
    .option('--no-install', 'Skip the build/install step')
    .action(async (extras, opts) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }

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
      const metroAlreadyUp = await isMetroRunning(proj.metroPort);
      console.log(chalk.dim(
        `Metro port: ${proj.metroPort}` +
        (metroAlreadyUp ? ' (already running)' : ' (will be started by build CLI)')
      ));

      const auto = isAuto(opts);
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

      let avdName, consolePort, isRunning;
      if (selection.kind === 'reuse') {
        ({ avdName, consolePort, isRunning } = selection);
        if (isRunning) {
          console.log(chalk.dim(`Reusing running ${avdName} (emulator-${consolePort})`));
        } else {
          console.log(chalk.dim(`Booting assigned ${avdName} (emulator-${consolePort})...`));
        }
      } else if (selection.kind === 'allocate') {
        const picked = (selection.candidates.length === 1 || auto)
          ? { c: selection.candidates[0], prevClaim: null }
          : await pickAvd({
              candidates: selection.candidates,
              androidClaimsByAvd: claimed.androidClaimsByAvd,
            });
        await releasePriorClaim(picked.prevClaim);
        ({ avdName, isRunning, consolePort } = picked.c);
        if (!isRunning) {
          consolePort = nextConsolePort(claimedPorts);
        }
        console.log(isRunning
          ? chalk.green(`Picked ${avdName} (emulator-${consolePort}, running)`)
          : chalk.dim(`Booting ${avdName} (emulator-${consolePort})...`));
      } else if (selection.kind === 'allClaimed') {
        if (auto) {
          console.error(chalk.red('All Android AVDs are claimed by other rn-iso projects.'));
          console.error(chalk.dim('Re-run without --auto to confirm taking one over, or create a new AVD via Android Studio.'));
          process.exit(1);
        }
        const picked = await pickAvd({
          candidates: selection.candidates,
          androidClaimsByAvd: claimed.androidClaimsByAvd,
          allClaimed: true,
        });
        await releasePriorClaim(picked.prevClaim);
        ({ avdName, isRunning, consolePort } = picked.c);
        if (!isRunning) {
          // Prior owner's port is freed by releasePriorClaim, but compute fresh.
          const fresh = allClaimedDevices().androidConsolePorts.filter(p => p !== myPort);
          consolePort = nextConsolePort(fresh);
        }
        console.log(isRunning
          ? chalk.green(`Took over ${avdName} (emulator-${consolePort}, running)`)
          : chalk.dim(`Booting ${avdName} (emulator-${consolePort})...`));
      } else {
        console.error(chalk.red(
          'No AVDs available. Create one via Android Studio (Tools -> Device Manager).'
        ));
        process.exit(1);
      }

      const serial = `emulator-${consolePort}`;
      if (!isRunning) {
        bootAndroidEmulator(avdName, consolePort);
        console.log(chalk.dim('Waiting for boot to complete (this can take 10-30s)...'));
        const ok = await waitForBoot(serial, 120000);
        if (!ok) {
          console.error(chalk.red(`Emulator ${serial} did not finish booting within 2 minutes.`));
          process.exit(1);
        }
      }

      setDevice(root, 'android', { avdName, consolePort });

      adbReverse(serial, proj.metroPort);
      console.log(chalk.dim(`adb reverse tcp:${proj.metroPort} configured for ${serial}`));

      if (opts.install !== false) {
        const settings = proj.settings || {};
        const packageManager = opts.pm ?? settings.packageManager ?? detectPackageManager(root);
        const useScript = opts.script !== false;
        const scriptName = useScript
          ? (typeof opts.script === 'string' ? opts.script : (settings.android?.script ?? 'android'))
          : null;
        const cmd = buildAndroidCommand({
          projectRoot: root,
          packageManager,
          scriptName,
          isExpo,
          avdName,
          serial,
          port: proj.metroPort,
          useScript,
          extras,
        });
        console.log(chalk.dim(`> ${cmd}`));
        const exec = getExecutor();
        const child = exec.spawn('sh', ['-c', cmd], { cwd: root, stdio: 'inherit' });
        await new Promise((resolve, reject) => {
          child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Build failed (exit ${code})`)));
        });
      }

      console.log(chalk.green(`\nAndroid ready on ${avdName} (${serial}), Metro port ${proj.metroPort}`));
    });
}

async function pickAvd({ candidates, androidClaimsByAvd = {}, allClaimed = false }) {
  // Show every AVD on disk (parallel to the iOS picker), so the user can
  // see what's claimed and optionally take it over. `candidates` is the
  // unclaimed set passed in by selectAndroidDevice; AVDs outside it are
  // claimed and will require a confirm prompt on selection.
  const allAvds = enumerateAndroidCandidates();
  const candidateAvds = new Set(candidates.map(c => c.avdName));
  const sorted = sortAndroidCandidates(allAvds);

  const nameWidth = Math.max(...sorted.map(c => c.avdName.length), 18);
  const choices = sorted.map(c => {
    const claim = androidClaimsByAvd[c.avdName];
    const isCandidate = candidateAvds.has(c.avdName);
    const runTag = c.isRunning ? chalk.green(` [emulator-${c.consolePort}, running]`) : '';
    if (claim || !isCandidate) {
      const tag = claim ? chalk.yellow(` [claimed by ${claim.label}]`) : '';
      return {
        title: chalk.yellow(`${c.avdName.padEnd(nameWidth)}${tag}${runTag}`),
        value: { c, claim: claim || null },
      };
    }
    return {
      title: `${c.avdName.padEnd(nameWidth)}${runTag}`,
      value: { c, claim: null },
    };
  });
  const message = allClaimed
    ? 'All AVDs are claimed. Pick one to take over:'
    : 'Pick an AVD (claimed AVDs will prompt to confirm):';
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
  const { c, claim } = answer.pick;
  if (claim) {
    const ok = await prompts({
      type: 'confirm',
      name: 'ok',
      message: `${c.avdName} is currently held by project "${claim.label}". Take it over?`,
      initial: false,
    });
    if (!ok.ok) {
      console.error(chalk.red('Cancelled.'));
      process.exit(1);
    }
    return { c, prevClaim: claim };
  }
  return { c, prevClaim: null };
}

async function releasePriorClaim(prevClaim) {
  if (!prevClaim?.path) return;
  clearDevice(prevClaim.path, 'android');
  console.log(chalk.dim(`Released prior assignment from "${prevClaim.label}"`));
}

function isAuto(opts) {
  return opts.auto || !process.stdin.isTTY;
}
