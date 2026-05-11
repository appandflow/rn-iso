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
  listAdbDevices,
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
      const mySerial = proj.platforms?.android?.serial || null;
      const claimedAvds = claimed.androidAvds.filter(a => a !== myAvd);
      const claimedPorts = claimed.androidConsolePorts.filter(p => p !== myPort);
      const claimedSerials = claimed.androidPhysicalSerials.filter(s => s !== mySerial);

      const selection = selectAndroidDevice({
        existingAvd: myAvd,
        existingSerial: mySerial,
        existingConsolePort: myPort,
        claimedAvds,
        claimedSerials,
        claimedConsolePorts: claimedPorts,
      });

      let avdName = null;
      let consolePort = null;
      let serial = null;
      let isRunning = false;
      let isPhysical = false;
      if (selection.kind === 'reuse') {
        if (selection.deviceKind === 'physical') {
          isPhysical = true;
          serial = selection.serial;
          isRunning = true;
          console.log(chalk.dim(`Reusing physical device ${serial}`));
        } else {
          ({ avdName, consolePort, isRunning } = selection);
          if (isRunning) {
            console.log(chalk.dim(`Reusing running ${avdName} (emulator-${consolePort})`));
          } else {
            console.log(chalk.dim(`Booting assigned ${avdName} (emulator-${consolePort})...`));
          }
        }
      } else if (selection.kind === 'allocate') {
        const picked = (selection.candidates.length === 1 || auto)
          ? { c: selection.candidates[0], prevClaim: null }
          : await pickAndroidDevice({
              candidates: selection.candidates,
              androidClaimsByAvd: claimed.androidClaimsByAvd,
              androidPhysicalClaimsBySerial: claimed.androidPhysicalClaimsBySerial,
            });
        await releasePriorClaim(picked.prevClaim);
        if (picked.c.kind === 'physical') {
          isPhysical = true;
          serial = picked.c.serial;
          isRunning = true;
          console.log(chalk.green(`Picked physical device ${serial}`));
        } else {
          ({ avdName, isRunning, consolePort } = picked.c);
          if (!isRunning) {
            consolePort = nextConsolePort(claimedPorts);
          }
          console.log(isRunning
            ? chalk.green(`Picked ${avdName} (emulator-${consolePort}, running)`)
            : chalk.dim(`Booting ${avdName} (emulator-${consolePort})...`));
        }
      } else if (selection.kind === 'allClaimed') {
        if (auto) {
          console.error(chalk.red('All Android devices are claimed by other rn-iso projects.'));
          console.error(chalk.dim('Re-run without --auto to confirm taking one over, or create a new AVD via Android Studio.'));
          process.exit(1);
        }
        const picked = await pickAndroidDevice({
          candidates: selection.candidates,
          androidClaimsByAvd: claimed.androidClaimsByAvd,
          androidPhysicalClaimsBySerial: claimed.androidPhysicalClaimsBySerial,
          allClaimed: true,
        });
        await releasePriorClaim(picked.prevClaim);
        if (picked.c.kind === 'physical') {
          isPhysical = true;
          serial = picked.c.serial;
          isRunning = true;
          console.log(chalk.green(`Took over physical device ${serial}`));
        } else {
          ({ avdName, isRunning, consolePort } = picked.c);
          if (!isRunning) {
            // Prior owner's port is freed by releasePriorClaim, but compute fresh.
            const fresh = allClaimedDevices().androidConsolePorts.filter(p => p !== myPort);
            consolePort = nextConsolePort(fresh);
          }
          console.log(isRunning
            ? chalk.green(`Took over ${avdName} (emulator-${consolePort}, running)`)
            : chalk.dim(`Booting ${avdName} (emulator-${consolePort})...`));
        }
      } else {
        console.error(chalk.red(
          'No AVDs or physical devices available. Create an AVD via Android Studio (Tools -> Device Manager), or plug in a device with USB debugging enabled.'
        ));
        process.exit(1);
      }

      if (!isPhysical) serial = `emulator-${consolePort}`;
      if (!isPhysical && !isRunning) {
        // Pre-spawn sanity check: an emulator may already be attached on
        // this console port but in `unauthorized` / `offline` state, in
        // which case enumerateAndroidCandidates marked isRunning=false.
        // Spawning a second emulator on the same port would silently
        // collide and the boot wait would poll forever.
        const adb = listAdbDevices();
        const stuck = adb.unhealthy.find(u => u.consolePort === consolePort);
        if (stuck) {
          console.error(chalk.red(
            `adb sees ${stuck.serial} but its status is "${stuck.status}". rn-iso can't drive it in this state.`
          ));
          if (stuck.status === 'unauthorized') {
            console.error(chalk.dim('Likely cause: the emulator and your ~/.android/adbkey.pub are out of sync.'));
            console.error(chalk.dim('Try: `adb kill-server && adb start-server` first; if it stays unauthorized,'));
            console.error(chalk.dim('cold-boot the AVD from Android Studio Device Manager.'));
          } else {
            console.error(chalk.dim('Try: `adb kill-server && adb start-server`, then re-run.'));
          }
          process.exit(1);
        }
        bootAndroidEmulator(avdName, consolePort);
        console.log(chalk.dim('Waiting for boot to complete (this can take 10-30s)...'));
        const result = await waitForBoot(serial, 120000);
        if (!result.ok) {
          console.error(chalk.red(`Emulator ${serial} did not finish booting within 2 minutes.`));
          const d = result.diagnostic;
          console.error(chalk.dim('adb devices ->'));
          console.error(chalk.dim((d.devices || '<no output>').split('\n').map(l => '  ' + l).join('\n')));
          console.error(chalk.dim(
            `getprop sys.boot_completed=${d.sysBoot || '<empty>'} ` +
            `dev.bootcomplete=${d.devBoot || '<empty>'} ` +
            `init.svc.bootanim=${d.bootAnim || '<empty>'}`
          ));
          if (!d.devices.includes(serial)) {
            console.error(chalk.dim(`Hint: ${serial} is not in adb's device list. Try \`adb kill-server && adb start-server\`.`));
          }
          process.exit(1);
        }
      }

      if (isPhysical) {
        setDevice(root, 'android', { serial });
      } else {
        setDevice(root, 'android', { avdName, consolePort });
      }

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

      const readyLabel = isPhysical ? `physical device ${serial}` : `${avdName} (${serial})`;
      console.log(chalk.green(`\nAndroid ready on ${readyLabel}, Metro port ${proj.metroPort}`));
    });
}

async function pickAndroidDevice({ candidates, androidClaimsByAvd = {}, androidPhysicalClaimsBySerial = {}, allClaimed = false }) {
  // Show every AVD on disk plus every physical device adb sees (parallel
  // to the iOS picker), so the user can see what's claimed and optionally
  // take it over. `candidates` is the unclaimed set passed in by
  // selectAndroidDevice; devices outside it are claimed and require a
  // confirm prompt on selection.
  const all = enumerateAndroidCandidates();
  const candidateKeys = new Set(candidates.map(c => candidateKey(c)));
  const sorted = sortAndroidCandidates(all);

  const nameWidth = Math.max(...sorted.map(c => candidateDisplayName(c).length), 18);
  const choices = sorted.map(c => {
    const claim = c.kind === 'physical'
      ? androidPhysicalClaimsBySerial[c.serial]
      : androidClaimsByAvd[c.avdName];
    const isCandidate = candidateKeys.has(candidateKey(c));
    const runTag = c.kind === 'physical'
      ? chalk.green(' [physical]')
      : (c.isRunning ? chalk.green(` [emulator-${c.consolePort}, running]`) : '');
    const name = candidateDisplayName(c);
    if (claim || !isCandidate) {
      const tag = claim ? chalk.yellow(` [claimed by ${claim.label}]`) : '';
      return {
        title: chalk.yellow(`${name.padEnd(nameWidth)}${tag}${runTag}`),
        value: { c, claim: claim || null },
      };
    }
    return {
      title: `${name.padEnd(nameWidth)}${runTag}`,
      value: { c, claim: null },
    };
  });
  const message = allClaimed
    ? 'All Android devices are claimed. Pick one to take over:'
    : 'Pick an Android device (claimed devices will prompt to confirm):';
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
      message: `${candidateDisplayName(c)} is currently held by project "${claim.label}". Take it over?`,
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

function candidateKey(c) {
  return c.kind === 'physical' ? `p:${c.serial}` : `a:${c.avdName}`;
}

function candidateDisplayName(c) {
  return c.kind === 'physical' ? c.serial : c.avdName;
}

async function releasePriorClaim(prevClaim) {
  if (!prevClaim?.path) return;
  clearDevice(prevClaim.path, 'android');
  console.log(chalk.dim(`Released prior assignment from "${prevClaim.label}"`));
}

function isAuto(opts) {
  return opts.auto || !process.stdin.isTTY;
}
