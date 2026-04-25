// src/commands/unreserve.js
import chalk from 'chalk';
import { removeReservation, clearAllReservations } from '../config.js';

export default function unreserveCommand(program) {
  program
    .command('unreserve [platform] [identifier]')
    .description('Release a previously-set reservation so rn-iso can use the device again')
    .option('--all', 'Remove all reservations')
    .action((platform, identifier, opts) => {
      if (opts.all) {
        clearAllReservations();
        console.log(chalk.green('Cleared all reservations.'));
        return;
      }
      if (!platform || !identifier) {
        console.error(chalk.red('Usage: rn-iso unreserve <ios|android> <UDID|emulator-PORT>'));
        console.error(chalk.dim('       rn-iso unreserve --all'));
        process.exit(1);
      }
      if (platform !== 'ios' && platform !== 'android') {
        console.error(chalk.red(`Unknown platform: ${platform}. Use ios or android.`));
        process.exit(1);
      }
      const removed = removeReservation(platform, identifier);
      console.log(removed
        ? chalk.green(`Released ${platform} reservation for ${identifier}`)
        : chalk.dim(`No ${platform} reservation found for ${identifier}`));
    });
}
