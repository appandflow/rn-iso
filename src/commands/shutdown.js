// src/commands/shutdown.js
import chalk from 'chalk';
import prompts from 'prompts';
import { resolveRegisteredProject } from '../project.js';
import { loadConfig, setMetro, clearDevice } from '../config.js';
import { killMetroByPid, findPidListeningOnPort } from '../metro.js';
import { isSimOccupied, resolveOwnedIosSim, shutdownIosSim, formatIosLabel } from '../sim/ios.js';
import { shutdownAndroidEmulator } from '../sim/android.js';

export default function shutdownCommand(program) {
  program
    .command('shutdown [target]')
    .description('Stop Metro and shut down sims/emulators across rn-iso projects, then clear their device assignments. With no arg, targets every registered project; pass a project shortcut (label or unique basename) or absolute path to scope to one.')
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
      // given — `shutdown` is the explicit "tear everything down" command,
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
      let hasDeviceAssignments = false;
      for (const [path, proj] of projects) {
        if (typeof proj.metroPort === 'number') {
          metros.push({ path, port: proj.metroPort, pid: proj.metroPid });
        }
        const ios = proj.platforms?.ios;
        if (ios?.deviceUdid) {
          hasDeviceAssignments = true;
          if (!opts.keepSims) {
            if (!ios.owned) {
              skippedLegacy.push({ path, platform: 'ios', label: ios.deviceUdid });
            } else if (isSimOccupied(ios.deviceUdid)) {
              skippedOccupied.push({ path, platform: 'ios', label: formatIosLabel(ios.deviceUdid) });
            } else {
              iosSims.push({ path, udid: ios.deviceUdid });
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

      // Phase 1: kill Metro instances. Try the recorded pid first; if that
      // misses, look up whoever's listening on the port. Always clear the
      // recorded metroPid so `status` reflects reality afterward.
      for (const m of metros) {
        let pid = m.pid;
        if (!pid || !killMetroByPid(pid)) {
          pid = findPidListeningOnPort(m.port);
          if (pid) killMetroByPid(pid);
        }
        setMetro(m.path, m.port, null);
        if (pid) {
          console.log(chalk.green(`Killed Metro pid ${pid} on port ${m.port} ${chalk.dim(`(${m.path})`)}`));
        } else {
          console.log(chalk.dim(`No Metro running on port ${m.port} (${m.path})`));
        }
      }

      // Phase 2: shut down sims / emulators. shutdownIosSim and
      // shutdownAndroidEmulator both go through runQuiet so failures (e.g.
      // sim already shut down, adb missing) don't throw -- but resolving
      // ownership (below) and deleteAvd's name guard can, so each device's
      // teardown is wrapped individually: one bad record must not abort the
      // rest of the loop or leave later projects' assignments uncleared by
      // Phase 3.
      if (!opts.keepSims) {
        for (const s of iosSims) {
          try {
            // Best-effort re-check against the live sim list right before
            // the only command this phase issues at it. A record whose
            // udid no longer names an rn-iso-owned sim (renamed, or a
            // stale/mistyped record) must be reported as a skip, not shut
            // down. If the check itself can't be answered (simctl
            // unavailable), fail open and proceed as before rather than
            // block a shutdown on a probe that isn't the actual guard.
            let resolved = null;
            try {
              resolved = resolveOwnedIosSim(s.udid);
            } catch { /* could not determine; proceed as before */ }
            if (resolved?.notOwned) {
              skippedFailed.push({ path: s.path, platform: 'ios', label: `${resolved.notOwned} (${s.udid})`, reason: 'not rn-iso-owned by name (renamed or stale record)' });
              continue;
            }
            if (resolved?.missing) {
              console.log(chalk.dim(`iOS sim ${s.udid} is already gone, nothing to shut down ${chalk.dim(`(${s.path})`)}`));
              continue;
            }
            shutdownIosSim(s.udid);
            console.log(chalk.green(`Shut down iOS sim ${formatIosLabel(s.udid)} ${chalk.dim(`(${s.path})`)}`));
          } catch (e) {
            skippedFailed.push({ path: s.path, platform: 'ios', label: s.udid, reason: String(e?.message || e) });
          }
        }
        for (const a of androidEmus) {
          const serial = `emulator-${a.consolePort}`;
          try {
            shutdownAndroidEmulator(serial);
            console.log(chalk.green(`Shut down ${a.avdName ?? serial} (${serial}) ${chalk.dim(`(${a.path})`)}`));
          } catch (e) {
            skippedFailed.push({ path: a.path, platform: 'android', label: a.avdName ?? serial, reason: String(e?.message || e) });
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

      // Phase 3: clear device assignments so subsequent `rn-iso ios/android`
      // calls re-pick instead of trying to reuse a now-shutdown device.
      for (const [path, proj] of projects) {
        if (proj.platforms?.ios) clearDevice(path, 'ios');
        if (proj.platforms?.android) clearDevice(path, 'android');
      }
    });
}
