// src/commands/stop.js
import chalk from 'chalk';
import prompts from 'prompts';
import { resolveRegisteredProject } from '../project.js';
import { getProject, findProjectByMetroPort } from '../config.js';
import {
  resolveProjectMetro,
  killMetroTree,
  findPidListeningOnPort,
  processGroupLeader,
} from '../metro.js';

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

// Pure: maps a CLI target to what should be stopped. Port targeting lives here
// rather than on `release` because the port is the resource `stop` owns --
// `release` frees the DEVICE. Lookups are injected so this is testable without
// touching config.
export function resolveStopTarget(target, { byPort, byShortcut }) {
  if (target && /^\d+$/.test(target)) {
    const port = parseInt(target, 10);
    const project = byPort(port);
    if (project) return { project, port };
    return { unownedPort: port };
  }
  const { found, error } = byShortcut(target);
  if (!found) return { error };
  return { project: found, port: null };
}

export default function stopCommand(program) {
  program
    .command('stop [target]')
    .description("Kill this project's Metro. rn-iso does not start Metro, so it verifies the process on the reserved port belongs to this project before killing it. [target] is a Metro port (e.g. 8083), a project shortcut, or an absolute path. Defaults to the current project.")
    .option('--force', "Kill whatever listens on the port even if it cannot be identified as this project's Metro (destructive: ask the user first)")
    .action(async (target, opts) => {
      const force = Boolean(opts.force);
      const resolved = resolveStopTarget(target, {
        byPort: findProjectByMetroPort,
        byShortcut: resolveRegisteredProject,
      });

      if (resolved.error) {
        console.error(chalk.red(resolved.error));
        process.exit(1);
      }

      // A port no registered project owns: there is no project to prove
      // identity against, so this is only ever an explicit, confirmed kill.
      if (resolved.unownedPort !== undefined) {
        await killUnownedPort(resolved.unownedPort, force);
        return;
      }

      const proj = getProject(resolved.project);
      const port = resolved.port ?? proj?.metroPort;
      if (!port) {
        console.log(chalk.dim(`No Metro port assigned to ${resolved.project}.`));
        return;
      }

      const resolution = await resolveProjectMetro(port, resolved.project);
      if (resolution.notOurs && force) resolution.pid = findPidListeningOnPort(port);

      const result = stopAction({ resolution, force });
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
      console.log(chalk.green(`Killed Metro on port ${port}${how} (${resolved.project})`));
    });
}

// Moved here from `release`, where it was the one path that killed an
// unregistered process -- odd on the command whose job is device teardown.
async function killUnownedPort(port, force) {
  const pid = findPidListeningOnPort(port);
  if (!pid) {
    console.error(chalk.red(`No registered project has Metro port ${port}, and nothing is listening on that port.`));
    process.exit(1);
  }
  console.error(chalk.dim(`No registered project has Metro port ${port}, but pid ${pid} is listening.`));

  // Nothing can vouch for this process, so it takes an explicit confirmation
  // (or --force). Under a non-TTY there is no way to ask, so refuse.
  if (!force) {
    if (!process.stdin.isTTY) {
      console.error(chalk.red('Refusing to kill an unrecognized process under non-TTY (no way to confirm).'));
      console.error(chalk.dim('Pass --force if you are sure.'));
      process.exit(1);
    }
    const ok = await prompts({
      type: 'confirm',
      name: 'ok',
      message: `Kill pid ${pid} on port ${port}?`,
      initial: false,
    });
    if (!ok.ok) {
      console.error(chalk.red('Cancelled.'));
      process.exit(1);
    }
  }

  // Take the whole group: lsof reports the socket holder, which for a bundler
  // started through a package manager is the node child, not its wrapper.
  const leader = processGroupLeader(pid) ?? pid;
  if (!killMetroTree(leader)) {
    console.error(chalk.red(`Could not kill pid ${pid} on port ${port}.`));
    process.exit(1);
  }
  console.log(chalk.green(`Killed pid ${pid} on port ${port}.`));
}
