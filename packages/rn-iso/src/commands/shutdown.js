// src/commands/shutdown.js
import chalk from 'chalk';
import prompts from 'prompts';
import { resolveRegisteredProject } from '../project.js';
import { loadConfig, clearDevice } from '../config.js';
import { resolveProjectMetro, killMetroTree } from '../metro.js';
import { isSimOccupied, resolveOwnedIosSim, formatIosLabel } from '../sim/ios.js';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.js';

export default function shutdownCommand(program) {
  program
    .command('shutdown [target]')
    .description('Stop Metro and shut down sims/emulators across rn-iso projects. Records for owned devices are kept, so `up` boots the same device back up; only assignments for devices rn-iso does not own are cleared. With no arg, targets every registered project; pass a project shortcut (label or unique basename) or absolute path to scope to one.')
    .option('-y, --yes', 'Skip the confirmation prompt (also implied when stdin is not a TTY)')
    .option('--keep-sims', "Don't shut down simulators/emulators; only kill Metro and clear assignments")
    .action(async (target, opts) => {
      const cfg = loadConfig();
      let projects = cfg ? Object.entries(cfg.projects || {}) : [];
      if (projects.length === 0) {
        console.log(chalk.dim('No projects registered.'));
        return;
      }

      // Optional [target] narrows the scope to a single project. We
      // intentionally do NOT default to the current project when no arg is
      // given -- `shutdown` is the explicit "tear everything down" command,
      // so omitting the target means "all projects".
      if (target) {
        const { found, error } = resolveRegisteredProject(target);
        if (!found) {
          console.error(chalk.red(error));
          process.exit(1);
        }
        projects = projects.filter(([path]) => path === found);
      }

      // Build the work plan up front so the prompt can show counts and so we
      // do all the I/O in clearly separated phases. Only `owned: true`
      // records are ever shut down -- a device rn-iso did not create is not
      // rn-iso's to stop, even if a claim for it is recorded. iOS additionally
      // gets an occupancy check: a foreign UI-test runner may still be
      // attached to an owned sim, and shutting it out from under that would
      // break whatever is using it. Skips of both kinds are collected
      // separately so they can be reported distinctly rather than silently
      // folded into "nothing to do".
      const metros = [];      // { path, port, pid }
      const iosSims = [];     // { path, udid }
      const androidEmus = []; // { path, avdName, consolePort }
      const skippedLegacy = [];   // { path, platform, label }
      const skippedOccupied = []; // { path, platform, label }
      const skippedFailed = [];   // { path, platform, label, reason } -- teardown threw or the live sim no longer matches the record
      const alreadyGoneNotices = []; // messages for devices found already gone during classification
      let hasDeviceAssignments = false;
      for (const [path, proj] of projects) {
        if (typeof proj.metroPort === 'number') {
          metros.push({ path, port: proj.metroPort });
        }
        const ios = proj.platforms?.ios;
        if (ios?.deviceUdid) {
          hasDeviceAssignments = true;
          if (!opts.keepSims) {
            if (!ios.owned) {
              skippedLegacy.push({ path, platform: 'ios', label: ios.deviceUdid });
            } else {
              // Verify ownership by name against the live sim list BEFORE
              // probing occupancy -- isSimOccupied shells at the udid too,
              // so probing it first on a renamed/stale record would still
              // land on whatever real simulator that udid now resolves to,
              // and (if occupied) would misreport the skip reason as "in
              // use" instead of "not rn-iso-owned". Phase 2 re-verifies
              // again immediately before shutdownIosSim itself, since state
              // can change between this classification pass and execution.
              let resolved;
              try {
                resolved = resolveOwnedIosSim(ios.deviceUdid);
              } catch (probeErr) {
                skippedFailed.push({ path, platform: 'ios', label: ios.deviceUdid, reason: `ownership could not be verified: ${String(probeErr?.message || probeErr).slice(0, 120)}` });
                resolved = null;
              }
              if (resolved?.notOwned) {
                skippedFailed.push({ path, platform: 'ios', label: `${resolved.notOwned} (${ios.deviceUdid})`, reason: 'not rn-iso-owned by name (renamed or stale record)' });
              } else if (resolved?.missing) {
                alreadyGoneNotices.push(chalk.dim(`iOS sim ${ios.deviceUdid} is already gone, nothing to shut down ${chalk.dim(`(${path})`)}`));
              } else if (resolved?.sim) {
                if (isSimOccupied(ios.deviceUdid)) {
                  skippedOccupied.push({ path, platform: 'ios', label: formatIosLabel(ios.deviceUdid) });
                } else {
                  iosSims.push({ path, udid: ios.deviceUdid });
                }
              }
            }
          }
        }
        const android = proj.platforms?.android;
        if (android?.avdName || typeof android?.consolePort === 'number') {
          hasDeviceAssignments = true;
          if (!opts.keepSims) {
            const label = android.avdName || `emulator-${android.consolePort}`;
            if (!android.owned) {
              skippedLegacy.push({ path, platform: 'android', label });
            } else if (!android.avdName) {
              // An owned record with a console port but no AVD name cannot be
              // identity-verified: resolveOwnedAvdSerial matches on the AVD
              // name, and a console port is a slot a foreign emulator can hold.
              // Reporting it as "already gone" would hide an emulator that is
              // very likely still running, so report it as a skip that names
              // what is missing.
              skippedFailed.push({
                path,
                platform: 'android',
                label,
                reason: 'the record has no AVD name, so the emulator cannot be identified; shut it down by hand (`adb -s emulator-<port> emu kill`)',
              });
            } else {
              androidEmus.push({ path, avdName: android.avdName, consolePort: android.consolePort });
            }
          }
        }
      }

      if (metros.length === 0 && !hasDeviceAssignments) {
        console.log(chalk.dim('Nothing to do (no Metro / device assignments tracked).'));
        return;
      }

      const yes = opts.yes || !process.stdin.isTTY;
      if (!yes) {
        const summary = [];
        if (metros.length) summary.push(`kill ${metros.length} Metro instance${metros.length === 1 ? '' : 's'}`);
        if (!opts.keepSims) {
          if (iosSims.length) summary.push(`shut down ${iosSims.length} iOS sim${iosSims.length === 1 ? '' : 's'}`);
          if (androidEmus.length) summary.push(`shut down ${androidEmus.length} Android emulator${androidEmus.length === 1 ? '' : 's'}`);
        }
        if (hasDeviceAssignments) summary.push('clear device assignments');
        const answer = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `About to ${summary.join(', ')} across ${projects.length} project${projects.length === 1 ? '' : 's'}. Proceed?`,
          initial: false,
        });
        if (!answer.ok) {
          console.error(chalk.red('Cancelled.'));
          process.exit(1);
        }
      }

      // Phase 1: kill Metro instances, identity-verified. rn-iso no longer
      // starts Metro, so a recorded port proves nothing about who holds it now.
      for (const m of metros) {
        const resolution = await resolveProjectMetro(m.port, m.path);
        if (resolution.metro && killMetroTree(resolution.metro.leader)) {
          console.log(chalk.green(`Killed Metro pid ${resolution.metro.pid} on port ${m.port} ${chalk.dim(`(${m.path})`)}`));
        } else if (resolution.notOurs) {
          console.log(chalk.yellow(`Skipped port ${m.port}: ${resolution.notOurs} ${chalk.dim(`(${m.path})`)}`));
        } else {
          console.log(chalk.dim(`No Metro running on port ${m.port} (${m.path})`));
        }
      }

      // Phase 2: shut down sims / emulators via the shared teardown helper,
      // which contains each device's failure so one bad record cannot abort the
      // rest of the loop or leave later projects' assignments uncleared by
      // Phase 3.
      if (!opts.keepSims) {
        for (const msg of alreadyGoneNotices) console.log(msg);
        // Both loops route through the shared teardown helper (del:false --
        // shutdown never deletes), so this site cannot drift from release /
        // reclaim / gc. The helper re-resolves ownership against the live
        // list immediately before the only command issued here, checks
        // occupancy, and contains its own throws.
        for (const s of iosSims) {
          const r = teardownOwnedIosSim(s.udid, { del: false });
          if (r.status === 'torn-down') {
            console.log(chalk.green(`Shut down iOS sim ${formatIosLabel(s.udid)} ${chalk.dim(`(${s.path})`)}`));
          } else if (r.status === 'missing') {
            console.log(chalk.dim(`iOS sim ${s.udid} is already gone, nothing to shut down ${chalk.dim(`(${s.path})`)}`));
          } else if (r.status === 'skipped' && r.kind === 'occupied') {
            skippedOccupied.push({ path: s.path, platform: 'ios', label: s.udid });
          } else if (r.status === 'skipped') {
            skippedFailed.push({ path: s.path, platform: 'ios', label: s.udid, reason: r.reason });
          } else {
            skippedFailed.push({ path: s.path, platform: 'ios', label: s.udid, reason: r.reason });
          }
        }
        for (const a of androidEmus) {
          const fallbackLabel = a.avdName ?? `emulator-${a.consolePort}`;
          const r = teardownOwnedAvd(a.avdName, { del: false });
          if (r.status === 'torn-down') {
            if (r.serial) {
              console.log(chalk.green(`Shut down ${fallbackLabel} (${r.serial}) ${chalk.dim(`(${a.path})`)}`));
            } else {
              console.log(chalk.dim(`Android AVD ${fallbackLabel} is not currently running, nothing to shut down ${chalk.dim(`(${a.path})`)}`));
            }
          } else if (r.status === 'missing') {
            console.log(chalk.dim(`Android AVD ${fallbackLabel} is already gone, nothing to shut down ${chalk.dim(`(${a.path})`)}`));
          } else {
            skippedFailed.push({ path: a.path, platform: 'android', label: fallbackLabel, reason: r.reason });
          }
        }
        for (const sk of skippedOccupied) {
          console.log(chalk.yellow(`Skipped ${sk.platform} device ${sk.label}: in use by another process ${chalk.dim(`(${sk.path})`)}`));
        }
        for (const sk of skippedLegacy) {
          console.log(chalk.dim(`Skipped ${sk.platform} device ${sk.label}: not rn-iso-owned, leaving it running ${chalk.dim(`(${sk.path})`)}`));
        }
        for (const sk of skippedFailed) {
          console.log(chalk.yellow(`Skipped ${sk.platform} device ${sk.label}: ${sk.reason} ${chalk.dim(`(${sk.path})`)}`));
        }
      }

      // Phase 3: clear legacy and physical device assignments so a
      // subsequent `rn-iso up` re-picks instead of trying to reuse a
      // now-shutdown legacy device. Owned records are left in place:
      // shutdown never deletes, so the device still exists and is still
      // ours -- clearing its record here would orphan it (nothing left
      // referencing it, so the next `gc --delete` would destroy it, and
      // the next `up` would build a brand-new device from scratch instead
      // of just booting this one back up). `up`'s owned-device reuse path
      // boots a shut-down owned record back up.
      for (const [path, proj] of projects) {
        const ios = proj.platforms?.ios;
        if (ios && !ios.owned) clearDevice(path, 'ios');
        const android = proj.platforms?.android;
        if (android && !android.owned) clearDevice(path, 'android');
      }
    });
}
