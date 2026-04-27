// src/commands/unreserve.js
import chalk from 'chalk';
import { findReservations, removeReservation, clearAllReservations } from '../config.js';

export default function unreserveCommand(program) {
  program
    .command('unreserve [arg1] [arg2]')
    .description('Release a reservation by UDID/serial or by the --label set when reserving')
    .option('--all', 'Remove all reservations')
    .option('--platform <platform>', 'Restrict to ios or android')
    .action((arg1, arg2, opts) => {
      if (opts.all) {
        clearAllReservations();
        console.log(chalk.green('Cleared all reservations.'));
        return;
      }

      // Two-arg form (backward compat): `unreserve ios <id-or-label>`.
      // Single-arg form: `unreserve <id-or-label>` (search across platforms).
      let platform = opts.platform || null;
      let target;
      if (arg2 !== undefined) {
        if (arg1 !== 'ios' && arg1 !== 'android') {
          console.error(chalk.red(`Unknown platform: ${arg1}. Use ios or android.`));
          process.exit(1);
        }
        platform = arg1;
        target = arg2;
      } else {
        target = arg1;
      }

      if (!target) {
        console.error(chalk.red('Usage: rn-iso unreserve <UDID|emulator-PORT|label>'));
        console.error(chalk.dim('       rn-iso unreserve <ios|android> <UDID|emulator-PORT|label>'));
        console.error(chalk.dim('       rn-iso unreserve --all'));
        process.exit(1);
      }

      const matches = findReservations(target, platform);
      if (matches.length === 0) {
        console.log(chalk.dim(
          `No reservation matches "${target}"` +
          (platform ? ` on ${platform}` : '') +
          '.'
        ));
        return;
      }
      for (const m of matches) {
        removeReservation(m.platform, m.id);
        console.log(chalk.green(
          `Released ${m.platform} reservation ${m.id}` +
          (m.label ? ` (${m.label})` : '')
        ));
      }
    });
}
