// src/commands/reserve.js
import chalk from 'chalk';
import prompts from 'prompts';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage } from '../project.js';
import { getProject, upsertProject, setMetro, setDevice, clearDevice, allClaimedDevices } from '../config.js';
import { allocatePort } from '../ports.js';
import { listBootedIosSims, parseRuntimeVersion, sortSims } from '../sim/ios.js';
import { listAdbDevices, getAvdNameForSerial } from '../sim/android.js';

export default function reserveCommand(program) {
  program
    .command('reserve [platform]')
    .description('Lock a manually-started sim/emulator to the current project (registers without building).')
    .action(async (platform) => {
      const plat = platform || 'ios';
      if (plat !== 'ios' && plat !== 'android') {
        console.error(chalk.red(`Unknown platform: ${plat}. Use ios or android.`));
        process.exit(1);
      }

      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }

      upsertProject(root, {
        bundleId: detectBundleId(root),
        androidPackage: detectAndroidPackage(root),
        isExpo: detectIsExpo(root),
      });
      let proj = getProject(root);
      if (!proj.metroPort) {
        const port = await allocatePort(root);
        setMetro(root, port, null);
        proj = getProject(root);
        console.log(chalk.dim(`Allocated Metro port: ${port}`));
      }

      if (plat === 'ios') {
        await reserveIos(root, proj);
      } else {
        await reserveAndroid(root, proj);
      }
    });
}

async function reserveIos(root, proj) {
  const booted = listBootedIosSims();
  if (booted.length === 0) {
    console.error(chalk.red('No booted iOS simulators found.'));
    console.error(chalk.dim('Boot one (Simulator.app, Xcode, or `xcrun simctl boot`) and re-run.'));
    process.exit(1);
  }

  const claims = allClaimedDevices().iosClaims;
  const sorted = sortSims(booted);

  let pick;
  if (sorted.length === 1) {
    pick = sorted[0];
  } else {
    const nameWidth = Math.max(...sorted.map(s => s.name.length), 18);
    const choices = sorted.map(s => {
      const claim = claims[s.udid];
      const tag = !claim ? ''
        : claim.path === root ? chalk.dim(' [already yours]')
        : chalk.yellow(` [claimed by ${claim.label}]`);
      const title = `${s.name.padEnd(nameWidth)}  ${chalk.dim(parseRuntimeVersion(s.runtime).padStart(6))}${tag}`;
      return { title, value: s };
    });
    const answer = await prompts({
      type: 'select',
      name: 'sim',
      message: 'Pick a booted simulator to lock to this project:',
      choices,
    });
    if (!answer.sim) {
      console.error(chalk.red('Cancelled.'));
      process.exit(1);
    }
    pick = answer.sim;
  }

  const claim = claims[pick.udid];
  if (claim && claim.path !== root) {
    const ok = await prompts({
      type: 'confirm',
      name: 'ok',
      message: `${pick.name} is currently held by project "${claim.label}". Take it over?`,
      initial: false,
    });
    if (!ok.ok) {
      console.error(chalk.red('Cancelled.'));
      process.exit(1);
    }
    clearDevice(claim.path, 'ios');
    console.log(chalk.dim(`Released prior assignment from "${claim.label}"`));
  }

  setDevice(root, 'ios', { deviceUdid: pick.udid });
  console.log(chalk.green(`Locked iOS sim ${pick.name} (${pick.udid}) to ${root}`));
}

async function reserveAndroid(root, proj) {
  const running = listAdbDevices().emulators;
  if (running.length === 0) {
    console.error(chalk.red('No running Android emulators found.'));
    console.error(chalk.dim('Start one (Android Studio or `emulator -avd ...`) and re-run.'));
    process.exit(1);
  }

  const claims = allClaimedDevices().androidClaims;

  let pick;
  if (running.length === 1) {
    pick = running[0];
  } else {
    const choices = running.map(e => {
      const claim = claims[e.consolePort];
      const tag = !claim ? ''
        : claim.path === root ? chalk.dim(' [already yours]')
        : chalk.yellow(` [claimed by ${claim.label}]`);
      return { title: `${e.serial}${tag}`, value: e };
    });
    const answer = await prompts({
      type: 'select',
      name: 'emu',
      message: 'Pick a running emulator to lock to this project:',
      choices,
    });
    if (!answer.emu) {
      console.error(chalk.red('Cancelled.'));
      process.exit(1);
    }
    pick = answer.emu;
  }

  const claim = claims[pick.consolePort];
  if (claim && claim.path !== root) {
    const ok = await prompts({
      type: 'confirm',
      name: 'ok',
      message: `${pick.serial} is held by project "${claim.label}". Take it over?`,
      initial: false,
    });
    if (!ok.ok) {
      console.error(chalk.red('Cancelled.'));
      process.exit(1);
    }
    clearDevice(claim.path, 'android');
    console.log(chalk.dim(`Released prior assignment from "${claim.label}"`));
  }

  const avdName = getAvdNameForSerial(pick.serial) || `emulator-${pick.consolePort}`;
  setDevice(root, 'android', { avdName, consolePort: pick.consolePort });
  console.log(chalk.green(`Locked emulator ${pick.serial} (AVD: ${avdName}) to ${root}`));
}
