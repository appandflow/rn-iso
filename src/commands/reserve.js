// src/commands/reserve.js
import chalk from 'chalk';
import prompts from 'prompts';
import { addReservation, listReservations, allClaimedDevices } from '../config.js';
import { listBootedIosSims } from '../sim/ios.js';
import { listAdbDevices, getAvdNameForSerial } from '../sim/android.js';

export default function reserveCommand(program) {
  program
    .command('reserve [platform] [identifier]')
    .description('Mark a sim/emulator as in-use by an external process so rn-iso skips it during allocation')
    .option('--label <text>', 'Optional label (e.g. "agent-1") for clarity in `rn-iso status`')
    .option('--list', 'List current reservations and exit')
    .action(async (platform, identifier, opts) => {
      if (opts.list) {
        printReservations();
        return;
      }

      // Direct path: both platform and identifier provided.
      if (platform && identifier) {
        addOne(platform, identifier, opts.label);
        return;
      }

      // Interactive path: list running devices and multi-select.
      if (platform && platform !== 'ios' && platform !== 'android') {
        console.error(chalk.red(`Unknown platform: ${platform}. Use ios or android.`));
        process.exit(1);
      }

      const showIos = !platform || platform === 'ios';
      const showAndroid = !platform || platform === 'android';
      const claimed = allClaimedDevices();
      const claimedIos = new Set(claimed.iosUdids);
      const claimedAndroidPorts = new Set(claimed.androidConsolePorts);

      const choices = [];

      if (showIos) {
        let iosSims = [];
        try {
          iosSims = listBootedIosSims();
        } catch (e) {
          console.error(chalk.dim(`(could not list iOS sims: ${e.message})`));
        }
        for (const sim of iosSims) {
          const taken = claimedIos.has(sim.udid);
          choices.push({
            title: `${chalk.bold('ios')}  ${sim.name.padEnd(22)} ${chalk.dim(sim.udid)}${taken ? chalk.yellow(' [reserved]') : ''}`,
            value: { kind: 'ios', udid: sim.udid, name: sim.name },
            disabled: taken,
          });
        }
      }

      if (showAndroid) {
        let emulators = [];
        try {
          emulators = listAdbDevices().emulators;
        } catch (e) {
          console.error(chalk.dim(`(could not list Android emulators: ${e.message})`));
        }
        for (const e of emulators) {
          const taken = claimedAndroidPorts.has(e.consolePort);
          const avdName = taken ? null : getAvdNameForSerial(e.serial);
          const label = avdName ? `${avdName} on ${e.serial}` : e.serial;
          choices.push({
            title: `${chalk.bold('and')}  ${label}${taken ? chalk.yellow(' [reserved]') : ''}`,
            value: { kind: 'android', serial: e.serial, consolePort: e.consolePort, avdName },
            disabled: taken,
          });
        }
      }

      if (choices.length === 0) {
        const what = !platform ? 'booted iOS sims or running Android emulators'
          : platform === 'ios' ? 'booted iOS sims'
          : 'running Android emulators';
        console.error(chalk.red(`No ${what} found.`));
        process.exit(1);
      }

      const answer = await prompts({
        type: 'multiselect',
        name: 'selected',
        message: 'Pick devices to reserve (space to toggle, enter to confirm)',
        choices,
        instructions: false,
        hint: '- space to select, enter to confirm',
      });

      if (!answer.selected || answer.selected.length === 0) {
        console.log(chalk.dim('Nothing selected.'));
        return;
      }

      let label = opts.label;
      if (!label) {
        const labelAnswer = await prompts({
          type: 'text',
          name: 'label',
          message: 'Label (optional, e.g. "agent-1"):',
        });
        label = labelAnswer.label || undefined;
      }

      for (const sel of answer.selected) {
        if (sel.kind === 'ios') {
          addReservation('ios', { udid: sel.udid, label });
          console.log(chalk.green(`Reserved iOS ${sel.name} (${sel.udid})${label ? ` (${label})` : ''}`));
        } else {
          addReservation('android', {
            serial: sel.serial,
            consolePort: sel.consolePort,
            avdName: sel.avdName,
            label,
          });
          console.log(chalk.green(
            `Reserved emulator ${sel.serial}` +
            (sel.avdName ? ` (AVD: ${sel.avdName})` : '') +
            (label ? ` (${label})` : '')
          ));
        }
      }
    });
}

function addOne(platform, identifier, label) {
  if (platform === 'ios') {
    addReservation('ios', { udid: identifier, label });
    console.log(chalk.green(`Reserved iOS sim ${identifier}${label ? ` (${label})` : ''}`));
    return;
  }
  if (platform === 'android') {
    const m = identifier.match(/^emulator-(\d+)$/);
    if (!m) {
      console.error(chalk.red('Android identifier must look like emulator-5554'));
      process.exit(1);
    }
    const consolePort = parseInt(m[1], 10);
    const avdName = getAvdNameForSerial(identifier);
    addReservation('android', { serial: identifier, consolePort, avdName, label });
    console.log(chalk.green(
      `Reserved emulator ${identifier}` +
      (avdName ? ` (AVD: ${avdName})` : '') +
      (label ? ` (${label})` : '')
    ));
    return;
  }
  console.error(chalk.red(`Unknown platform: ${platform}. Use ios or android.`));
  process.exit(1);
}

function printReservations() {
  const r = listReservations();
  const ios = r.ios || [];
  const android = r.android || [];
  if (ios.length === 0 && android.length === 0) {
    console.log(chalk.dim('No reservations.'));
    return;
  }
  if (ios.length > 0) {
    console.log(chalk.bold('iOS:'));
    for (const e of ios) {
      console.log(`  ${chalk.cyan(e.udid)}${e.label ? chalk.dim(` (${e.label})`) : ''}`);
    }
  }
  if (android.length > 0) {
    console.log(chalk.bold('Android:'));
    for (const e of android) {
      const tag = e.avdName ? `${e.avdName} on ${e.serial}` : e.serial;
      console.log(`  ${chalk.cyan(tag)}${e.label ? chalk.dim(` (${e.label})`) : ''}`);
    }
  }
}
