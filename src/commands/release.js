// src/commands/release.js
import chalk from 'chalk';
import { resolveRegisteredProject } from '../project.js';
import { getProject, clearDevice, findReservations, removeReservation } from '../config.js';

export default function releaseCommand(program) {
  program
    .command('release [target]')
    .description('Free a project assignment OR a reservation. [target] is an absolute project path, a reservation label (set via `rn-iso reserve --label`), or a UDID/serial. Defaults to the current project.')
    .option('--platform <platform>', 'ios or android (default: both)')
    .action((target, opts) => {
      // 1. If a target was given, try it as a reservation label / id first.
      if (target) {
        const matches = findReservations(target, opts.platform);
        if (matches.length > 0) {
          for (const m of matches) {
            removeReservation(m.platform, m.id);
            console.log(chalk.green(
              `Released ${m.platform} reservation ${m.id}` +
              (m.label ? ` (${m.label})` : '')
            ));
          }
          return;
        }
      }

      // 2. Otherwise treat the target as a project path (or default to cwd).
      const { found, error } = resolveRegisteredProject(target);
      if (!found) {
        console.error(chalk.red(error));
        if (target) {
          console.error(chalk.dim('(Also tried as reservation label/id; no match.)'));
        }
        process.exit(1);
      }
      const proj = getProject(found);
      if (!proj) {
        console.log(chalk.dim('No project entry to release.'));
        return;
      }
      const platforms = opts.platform ? [opts.platform] : ['ios', 'android'];
      for (const p of platforms) {
        if (proj.platforms?.[p]) {
          clearDevice(found, p);
          console.log(chalk.green(`Released ${p} assignment for ${found}.`));
        } else {
          console.log(chalk.dim(`No ${p} assignment to release for ${found}.`));
        }
      }
    });
}
