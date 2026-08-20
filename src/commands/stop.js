// src/commands/stop.js
import chalk from 'chalk';
import { resolveRegisteredProject } from '../project.js';
import { getProject } from '../config.js';
import { resolveProjectMetro, killMetroTree, findPidListeningOnPort } from '../metro.js';

// Pure: decides what to do with a resolution, so the decision is testable
// without a live process. Order matters -- `missing` is checked before `force`,
// because forcing must never turn "nothing is there" into a kill attempt.
export function stopAction({ resolution, force }) {
  if (resolution.metro) {
    return { action: 'killed', pid: resolution.metro.pid, leader: resolution.metro.leader };
  }
  if (resolution.missing) return { action: 'missing' };
  if (force) return { action: 'forced', pid: resolution.pid ?? null };
  return { action: 'refused', reason: resolution.notOurs };
}

export default function stopCommand(program) {
  program
    .command('stop [target]')
    .description("Kill this project's Metro. rn-iso does not start Metro, so it verifies the process on the assigned port belongs to this project before killing it. Pass a project shortcut or absolute path to target another project.")
    .option('--force', "Kill whatever listens on the port even if it cannot be identified as this project's Metro (destructive: ask the user first)")
    .action(async (target, opts) => {
      const { found, error } = resolveRegisteredProject(target);
      if (!found) {
        console.error(chalk.red(error));
        process.exit(1);
      }
      const proj = getProject(found);
      if (!proj?.metroPort) {
        console.log(chalk.dim(`No Metro port assigned to ${found}.`));
        return;
      }
      const port = proj.metroPort;
      const resolution = await resolveProjectMetro(port, found);
      if (resolution.notOurs && opts.force) resolution.pid = findPidListeningOnPort(port);

      const result = stopAction({ resolution, force: Boolean(opts.force) });
      if (result.action === 'missing') {
        console.log(chalk.dim(`No Metro running on port ${port}.`));
        return;
      }
      if (result.action === 'refused') {
        console.error(chalk.yellow(`Refusing to kill port ${port}: ${result.reason}.`));
        console.error(chalk.dim('Pass --force to kill it anyway.'));
        process.exit(1);
      }
      const leader = result.leader ?? result.pid;
      if (!leader || !killMetroTree(leader)) {
        console.error(chalk.red(`Could not kill the process on port ${port}.`));
        process.exit(1);
      }
      const how = result.action === 'forced' ? ' (forced, identity unverified)' : '';
      console.log(chalk.green(`Killed Metro on port ${port}${how} (${found})`));
    });
}
