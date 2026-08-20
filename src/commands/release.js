// src/commands/release.js
import chalk from 'chalk';
import { resolveRegisteredProject } from '../project.js';
import { getProject, clearDevice, findProjectByMetroPort } from '../config.js';
import { isSimOccupied, resolveOwnedIosSim, shutdownIosSim, deleteIosSim, formatIosLabel } from '../sim/ios.js';
import { resolveOwnedAvdSerial, shutdownAndroidEmulator, deleteAvd } from '../sim/android.js';

// Owned devices are rn-iso's to destroy; releasing one deletes it. Anything
// rn-iso did not create is only ever unassigned.
export function releaseAction({ record, occupied, force }) {
  if (!record?.owned) return { action: 'clear', reason: null };
  if (occupied && !force) {
    return { action: 'clear', reason: 'device is in use by another tool; claim cleared, device kept. Pass --force to delete it anyway' };
  }
  return { action: 'delete', reason: null };
}

// Legacy/physical assignments are only ever cleared by the caller, never
// touched here -- releaseAction already returns `clear` for them, and
// resolveOwnedIosSim would (correctly) refuse to shut down a sim it doesn't
// own, so there is nothing to do for a non-owned record.
function releaseIosDevice(entry, force) {
  if (!entry.owned) return;
  // Verify ownership by name against the LIVE sim list BEFORE probing
  // occupancy or issuing shutdownIosSim -- isSimOccupied shells at the udid
  // too, so probing it first would still land on whatever real simulator a
  // renamed/stale record's udid now resolves to.
  const resolved = resolveOwnedIosSim(entry.deviceUdid);
  if (resolved.notOwned) {
    console.log(chalk.yellow(`Did not delete the device: sim is now named "${resolved.notOwned}", not rn-iso-owned by name -- leaving it running.`));
    return;
  }
  if (resolved.missing) {
    console.log(chalk.dim(`iOS sim ${entry.deviceUdid} is already gone; nothing to delete.`));
    return;
  }
  const occupied = isSimOccupied(entry.deviceUdid);
  const decision = releaseAction({ record: entry, occupied, force });
  if (decision.action === 'delete') {
    const label = formatIosLabel(entry.deviceUdid);
    shutdownIosSim(entry.deviceUdid);
    deleteIosSim(entry.deviceUdid);
    console.log(chalk.green(`Deleted owned iOS sim ${label}`));
  } else if (decision.reason) {
    console.log(chalk.yellow(`Did not delete the device: ${decision.reason}.`));
  }
}

function releaseAndroidDevice(entry, force) {
  if (!entry.owned || !entry.avdName) return;
  // Verify identity against the LIVE adb list before shutting anything
  // down: the recorded consolePort is a slot, not an identity, and may now
  // be held by a foreign emulator.
  const resolved = resolveOwnedAvdSerial(entry.avdName);
  if (resolved.notOwned) {
    console.log(chalk.yellow(`Did not delete the device: AVD ${entry.avdName} is not rn-iso-owned by name -- leaving it running.`));
    return;
  }
  if (resolved.missing) {
    console.log(chalk.dim(`Android AVD ${entry.avdName} is already gone; nothing to delete.`));
    return;
  }
  // Android has no occupancy probe (see CLAUDE.md item 4), so an owned,
  // identity-verified AVD is always eligible for deletion here.
  const decision = releaseAction({ record: entry, occupied: false, force });
  if (decision.action === 'delete') {
    if (resolved.serial) shutdownAndroidEmulator(resolved.serial);
    deleteAvd(entry.avdName);
    console.log(chalk.green(`Deleted owned AVD ${entry.avdName}${resolved.serial ? ` (${resolved.serial})` : ''}`));
  } else if (decision.reason) {
    console.log(chalk.yellow(`Did not delete the device: ${decision.reason}.`));
  }
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
          // Killing an unregistered port-holder is Metro-lifecycle work, so it
          // lives on `stop`. `release` only ever frees a project's DEVICE.
          console.error(chalk.red(`No registered project has Metro port ${port}.`));
          console.error(chalk.dim(`To kill whatever is listening there, run \`rn-iso stop ${port}\`.`));
          process.exit(1);
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
        // Each platform's device teardown is contained in its own
        // try/catch: a throwing probe (e.g. a wedged simctl daemon) must
        // not crash the command before clearDevice runs, and must not stop
        // the other platform from being processed.
        try {
          if (p === 'ios') {
            releaseIosDevice(entry, opts.force);
          } else {
            releaseAndroidDevice(entry, opts.force);
          }
        } catch (e) {
          console.log(chalk.yellow(`Could not tear down the ${p} device: ${String(e?.message || e)}. Clearing the assignment anyway.`));
        }
        clearDevice(found, p);
        console.log(chalk.green(`Released ${p} assignment for ${found}.`));
      }
    });
}
