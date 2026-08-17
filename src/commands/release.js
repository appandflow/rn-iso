// src/commands/release.js
import chalk from 'chalk';
import prompts from 'prompts';
import { resolveRegisteredProject } from '../project.js';
import { getProject, clearDevice, findProjectByMetroPort } from '../config.js';
import { findPidListeningOnPort } from '../metro.js';
import { isSimOccupied, shutdownIosSim, deleteIosSim, formatIosLabel } from '../sim/ios.js';
import { shutdownAndroidEmulator, deleteAvd } from '../sim/android.js';

// Owned devices are rn-iso's to destroy; releasing one deletes it. Anything
// rn-iso did not create is only ever unassigned.
export function releaseAction({ record, occupied, force }) {
  if (!record?.owned) return { action: 'clear', reason: null };
  if (occupied && !force) {
    return { action: 'clear', reason: 'device is in use by another tool; claim cleared, device kept. Pass --force to delete it anyway' };
  }
  return { action: 'delete', reason: null };
}

export default function releaseCommand(program) {
  program
    .command('release [target]')
    .description('Free a project assignment. [target] is a Metro port (e.g. 8083), a project shortcut (label or unique basename), or an absolute path. Defaults to the current project.')
    .option('--platform <platform>', 'ios or android (default: both)')
    .option('--force', 'delete an owned device even if it is in use by another tool')
    .action(async (target, opts) => {
      let found;
      if (target && /^\d+$/.test(target)) {
        const port = parseInt(target, 10);
        found = findProjectByMetroPort(port);
        if (!found) {
          await handleUnmatchedPort(port);
          return;
        }
      } else {
        const result = resolveRegisteredProject(target);
        if (!result.found) {
          console.error(chalk.red(result.error));
          process.exit(1);
        }
        found = result.found;
      }
      const proj = getProject(found);
      if (!proj) {
        console.log(chalk.dim('No project entry to release.'));
        return;
      }
      const platforms = opts.platform ? [opts.platform] : ['ios', 'android'];
      for (const p of platforms) {
        const entry = proj.platforms?.[p];
        if (!entry) {
          console.log(chalk.dim(`No ${p} assignment to release for ${found}.`));
          continue;
        }
        // Occupancy only matters for owned devices (it decides delete vs.
        // clear); skip the simctl probe entirely for legacy/physical
        // assignments, which are always just cleared.
        const occupied = entry.owned && p === 'ios' ? isSimOccupied(entry.deviceUdid) : false;
        const decision = releaseAction({ record: entry, occupied, force: opts.force });
        if (decision.action === 'delete') {
          if (p === 'ios') {
            const label = formatIosLabel(entry.deviceUdid);
            shutdownIosSim(entry.deviceUdid);
            deleteIosSim(entry.deviceUdid);
            console.log(chalk.green(`Deleted owned iOS sim ${label}`));
          } else if (entry.avdName && typeof entry.consolePort === 'number') {
            shutdownAndroidEmulator(`emulator-${entry.consolePort}`);
            deleteAvd(entry.avdName);
            console.log(chalk.green(`Deleted owned AVD ${entry.avdName} (emulator-${entry.consolePort})`));
          }
        } else if (decision.reason) {
          console.log(chalk.yellow(`Did not delete the device: ${decision.reason}.`));
        }
        clearDevice(found, p);
        console.log(chalk.green(`Released ${p} assignment for ${found}.`));
      }
    });
}

async function handleUnmatchedPort(port) {
  const pid = findPidListeningOnPort(port);
  if (!pid) {
    console.error(chalk.red(`No registered project has Metro port ${port}, and nothing is listening on that port.`));
    process.exit(1);
  }
  console.log(chalk.dim(`No registered project has Metro port ${port}, but pid ${pid} is listening.`));
  if (!process.stdin.isTTY) {
    console.error(chalk.red('Refusing to kill an unrecognized process under non-TTY (no way to confirm).'));
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
  try {
    process.kill(pid, 'SIGTERM');
    console.log(chalk.green(`Killed pid ${pid} on port ${port}.`));
  } catch (e) {
    console.error(chalk.red(`Could not kill pid ${pid}: ${e.message}`));
    process.exit(1);
  }
}
