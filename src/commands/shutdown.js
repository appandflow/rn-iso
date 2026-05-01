// src/commands/shutdown.js
import chalk from 'chalk';
import prompts from 'prompts';
import { loadConfig, setMetro, clearDevice } from '../config.js';
import { killMetroByPid, findPidListeningOnPort } from '../metro.js';
import { shutdownIosSim, formatIosLabel } from '../sim/ios.js';
import { shutdownAndroidEmulator } from '../sim/android.js';

export default function shutdownCommand(program) {
  program
    .command('shutdown')
    .description('Stop all Metro instances and shut down all simulators/emulators claimed by any rn-iso project; clears device assignments.')
    .option('-y, --yes', 'Skip the confirmation prompt (also implied when stdin is not a TTY)')
    .option('--keep-sims', "Don't shut down simulators/emulators; only kill Metro and clear assignments")
    .action(async (opts) => {
      const cfg = loadConfig();
      const projects = cfg ? Object.entries(cfg.projects || {}) : [];
      if (projects.length === 0) {
        console.log(chalk.dim('No projects registered.'));
        return;
      }

      // Build the work plan up front so the prompt can show counts and so we
      // do all the I/O in clearly separated phases.
      const metros = [];      // { path, port, pid }
      const iosSims = [];     // { path, udid }
      const androidEmus = []; // { path, avdName, consolePort }
      for (const [path, proj] of projects) {
        if (typeof proj.metroPort === 'number') {
          metros.push({ path, port: proj.metroPort, pid: proj.metroPid });
        }
        const ios = proj.platforms?.ios;
        if (ios?.deviceUdid) iosSims.push({ path, udid: ios.deviceUdid });
        const android = proj.platforms?.android;
        if (android?.avdName || typeof android?.consolePort === 'number') {
          androidEmus.push({ path, avdName: android.avdName, consolePort: android.consolePort });
        }
      }

      const hasDeviceAssignments = iosSims.length > 0 || androidEmus.length > 0;
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
      // sim already shut down, adb missing) don't throw.
      if (!opts.keepSims) {
        for (const s of iosSims) {
          shutdownIosSim(s.udid);
          console.log(chalk.green(`Shut down iOS sim ${formatIosLabel(s.udid)} ${chalk.dim(`(${s.path})`)}`));
        }
        for (const a of androidEmus) {
          const serial = `emulator-${a.consolePort}`;
          shutdownAndroidEmulator(serial);
          console.log(chalk.green(`Shut down ${a.avdName ?? serial} (${serial}) ${chalk.dim(`(${a.path})`)}`));
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
