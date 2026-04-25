// src/commands/reserve.js
import chalk from 'chalk';
import { addReservation, listReservations } from '../config.js';
import { getAvdNameForSerial } from '../sim/android.js';

export default function reserveCommand(program) {
  program
    .command('reserve [platform] [identifier]')
    .description('Mark a sim/emulator as in-use by an external process so rn-iso skips it during allocation')
    .option('--label <text>', 'Optional label (e.g. "agent-1") for clarity in `rn-iso status`')
    .option('--list', 'List current reservations and exit')
    .action((platform, identifier, opts) => {
      if (opts.list) {
        printReservations();
        return;
      }
      if (!platform || !identifier) {
        console.error(chalk.red('Usage: rn-iso reserve <ios|android> <UDID|emulator-PORT> [--label <text>]'));
        console.error(chalk.dim('       rn-iso reserve --list'));
        process.exit(1);
      }
      if (platform === 'ios') {
        addReservation('ios', { udid: identifier, label: opts.label });
        console.log(chalk.green(`Reserved iOS sim ${identifier}${opts.label ? ` (${opts.label})` : ''}`));
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
        addReservation('android', { serial: identifier, consolePort, avdName, label: opts.label });
        console.log(chalk.green(
          `Reserved emulator ${identifier}` +
          (avdName ? ` (AVD: ${avdName})` : '') +
          (opts.label ? ` (${opts.label})` : '')
        ));
        return;
      }
      console.error(chalk.red(`Unknown platform: ${platform}. Use ios or android.`));
      process.exit(1);
    });
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
