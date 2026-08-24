// src/commands/release.js
import chalk from 'chalk';
import { resolveRegisteredProject } from '../project.js';
import { getProject, clearDevice, findProjectByMetroPort } from '../config.js';
import { formatIosLabel } from '../sim/ios.js';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.js';

// Legacy/physical assignments are only ever cleared by the caller, never
// touched here: resolveOwnedIosSim would (correctly) refuse to shut down a
// sim rn-iso does not own, so there is nothing to do for a non-owned record.
//
// Returns true when the assignment may be cleared. A FAILED delete returns
// false: the device is still on the machine, and dropping its record here is
// what turns a failed teardown into a leaked simulator nothing references.
function releaseIosDevice(entry) {
  if (!entry.owned) return true;
  // Every guard (ownership re-resolve, occupancy, containment) lives in
  // teardownOwnedIosSim so all four teardown sites cannot drift apart.
  const label = formatIosLabel(entry.deviceUdid);
  const r = teardownOwnedIosSim(entry.deviceUdid, { del: true, label });
  if (r.status === 'torn-down') {
    console.log(chalk.green(`Deleted owned iOS sim ${r.label}`));
  } else if (r.status === 'missing') {
    console.log(chalk.dim(`iOS sim ${entry.deviceUdid} is already gone; nothing to delete.`));
  } else if (r.status === 'failed') {
    console.log(chalk.red(`Could not tear down the ios device: ${r.reason}.`));
    console.log(chalk.dim(`Keeping the ios assignment for ${label} so the device stays tracked; fix the cause and re-run \`rn-iso release\`.`));
    return false;
  } else {
    console.log(chalk.yellow(`Did not delete the device: ${r.reason}.`));
  }
  return true;
}

function releaseAndroidDevice(entry) {
  if (!entry.owned || !entry.avdName) return true;
  // Android has no occupancy probe (see CLAUDE.md item 4), so an owned,
  // identity-verified AVD is always eligible for deletion here.
  const r = teardownOwnedAvd(entry.avdName, { del: true });
  if (r.status === 'torn-down') {
    console.log(chalk.green(`Deleted owned AVD ${entry.avdName}${r.serial ? ` (${r.serial})` : ''}`));
  } else if (r.status === 'missing') {
    console.log(chalk.dim(`Android AVD ${entry.avdName} is already gone; nothing to delete.`));
  } else if (r.status === 'failed') {
    console.log(chalk.red(`Could not tear down the android device: ${r.reason}.`));
    console.log(chalk.dim(`Keeping the android assignment for ${entry.avdName} so the AVD stays tracked; fix the cause and re-run \`rn-iso release\`.`));
    return false;
  } else {
    console.log(chalk.yellow(`Did not delete the device: ${r.reason}.`));
  }
  return true;
}

export default function releaseCommand(program) {
  program
    .command('release [target]')
    .description('Free a project assignment, deleting the device rn-iso owns for it. A device being deleted is not occupancy-checked: it goes away even if another tool is still attached to it. [target] is a Metro port (e.g. 8083), a project shortcut (label or unique basename), or an absolute path. Defaults to the current project.')
    .option('--platform <platform>', 'ios or android (default: both)')
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
        // not crash the command before the other platform is processed.
        let mayClear;
        try {
          mayClear = p === 'ios' ? releaseIosDevice(entry) : releaseAndroidDevice(entry);
        } catch (e) {
          // A probe that threw outside the teardown helper leaves the same
          // doubt a failed teardown does: the device may still exist, so its
          // record stays.
          console.log(chalk.red(`Could not tear down the ${p} device: ${String(e?.message || e)}.`));
          console.log(chalk.dim(`Keeping the ${p} assignment so the device stays tracked; fix the cause and re-run \`rn-iso release\`.`));
          mayClear = false;
        }
        if (!mayClear) {
          process.exitCode = 1;
          continue;
        }
        clearDevice(found, p);
        console.log(chalk.green(`Released ${p} assignment for ${found}.`));
      }
    });
}
