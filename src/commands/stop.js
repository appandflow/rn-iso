// src/commands/stop.js
import chalk from 'chalk';
import prompts from 'prompts';
import { resolveRegisteredProject } from '../project.js';
import { findProjectByMetroPort, loadConfig, isPathPrefix } from '../config.js';
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

// Pure. A worktree root carries the label but owns no port -- `up` registers
// the app DIRECTORY, whose shortcut is "<label>/<basename>". So `stop <label>`
// used to resolve the root, find no port, and exit 0 while Metro kept running.
// Fall through to every registered project underneath the target.
export function stopTargets(targetPath, projects) {
  const own = projects?.[targetPath];
  if (own?.metroPort) return [{ path: targetPath, port: own.metroPort }];
  const nested = [];
  for (const [path, proj] of Object.entries(projects || {})) {
    if (path === targetPath) continue;
    if (!isPathPrefix(targetPath, path)) continue;
    if (proj?.metroPort) nested.push({ path, port: proj.metroPort });
  }
  return nested;
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

      const targets = resolved.port
        ? [{ path: resolved.project, port: resolved.port }]
        : stopTargets(resolved.project, loadConfig()?.projects || {});

      if (targets.length === 0) {
        // Exit NON-ZERO: an agent reads exit 0 as "stopped", and silently
        // doing nothing here stranded live Metros in the field.
        console.error(chalk.red(`No Metro port assigned to ${resolved.project}, and no registered project under it owns one.`));
        console.error(chalk.dim('Run `rn-iso status` to see which projects hold ports.'));
        process.exit(1);
      }

      let failed = false;
      for (const t of targets) {
        const resolution = await resolveProjectMetro(t.port, t.path);
        if (resolution.notOurs && force) resolution.pid = findPidListeningOnPort(t.port);

        const result = stopAction({ resolution, force });
        if (result.action === 'missing') {
          console.log(chalk.dim(`No Metro running on port ${t.port} (${t.path}).`));
          continue;
        }
        if (result.action === 'refused') {
          console.error(chalk.yellow(`Refusing to kill port ${t.port}: ${result.reason}.`));
          console.error(chalk.dim('Pass --force to kill it anyway.'));
          failed = true;
          continue;
        }
        const leader = result.leader ?? result.pid;
        if (!leader || !killMetroTree(leader)) {
          console.error(chalk.red(`Could not kill the process on port ${t.port}.`));
          failed = true;
          continue;
        }
        const how = result.action === 'forced' ? ' (forced, identity unverified)' : '';
        console.log(chalk.green(`Killed Metro on port ${t.port}${how} (${t.path})`));
      }
      if (failed) process.exit(1);
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
