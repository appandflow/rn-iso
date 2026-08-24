// src/commands/status.js
import chalk from 'chalk';
import { totalmem } from 'os';
import { loadConfig } from '../config.js';
import { isMetroRunning } from '../ports.js';
import { resolveProjectMetro } from '../metro.js';
import { findProjectRoot, projectShortcut } from '../project.js';
import { listAllIosSims } from '../sim/ios.js';
import { listWorktrees } from '../worktree.js';
import { capacity, environmentState, unprovisionedWorktrees } from '../status.js';

export default function statusCommand(program) {
  program
    .command('status')
    .description('Show every environment on this machine: devices, ports, what is actually running, and anything stuck.')
    .option('--json', 'print the state as JSON')
    .action(async opts => {
      const cfg = loadConfig();
      const projects = Object.entries(cfg?.projects || {});
      const cwdRoot = findProjectRoot(process.cwd());

      // Tolerate a machine with no simctl (a Linux box doing Android work).
      // "simctl did not answer" and "simctl answered with zero sims" are
      // different facts: only the second one proves a recorded sim is gone.
      let simsByUdid = {};
      let simsAvailable = true;
      let simctlError = null;
      try {
        for (const sim of listAllIosSims()) simsByUdid[sim.udid] = sim;
      } catch (e) {
        simsAvailable = false;
        simctlError = String(e?.message || e).split('\n')[0];
      }

      // The first entry is the main checkout, not a workspace: listing it as
      // "unprovisioned" would flag every repo you ever run this in.
      const worktrees = listWorktrees(process.cwd()).slice(1);

      const states = [];
      for (const [path, proj] of projects) {
        // Resolving Metro's identity costs an lsof per project, which is why it
        // is only done for ports that answer at all.
        let metro = null;
        if (proj.metroPort) {
          metro = (await isMetroRunning(proj.metroPort))
            ? await resolveProjectMetro(proj.metroPort, path)
            : { missing: true };
        }
        states.push(environmentState({ ...proj, __path: path }, { simsByUdid, metro, worktrees, simsAvailable }));
      }

      const totalMemoryMb = Math.round(totalmem() / (1024 * 1024));
      const cap = capacity(states, totalMemoryMb);
      const orphanWorktrees = unprovisionedWorktrees(worktrees, projects.map(([p]) => p));

      if (opts.json) {
        console.log(JSON.stringify({
          environments: states,
          capacity: cap,
          unprovisionedWorktrees: orphanWorktrees,
          simctlAvailable: simsAvailable,
        }, null, 2));
        return;
      }

      if (projects.length === 0 && orphanWorktrees.length === 0) {
        console.log(chalk.dim('No projects registered.'));
        return;
      }

      // Said once, up front: without a sim listing every iOS line below reports
      // a state of "unknown" rather than a fact, and none of them can be
      // checked against the machine.
      if (!simsAvailable) {
        console.log(chalk.yellow(`simctl could not be read (${simctlError}), so no iOS sim below could be checked.`));
      }

      for (const [i, [path, proj]] of projects.entries()) {
        const state = states[i];
        const shortcut = projectShortcut(path, proj);
        const marker = path === cwdRoot ? chalk.bold.cyan(`* ${shortcut}`) : shortcut;
        const idle = state.live ? '' : chalk.dim(' [idle]');
        console.log(`\n${marker}${idle} ${chalk.dim(`(${path})`)}`);
        console.log(chalk.dim(`  app: ${proj.bundleId ?? '?'} (${proj.isExpo ? 'expo' : 'bare'})`));

        if (state.metro) {
          const label = state.metro.running
            ? chalk.green(`running (pid ${state.metro.pid})`)
            : chalk.dim('not running');
          console.log(`  metro: port ${state.metro.port} ${label}`);
        }
        if (state.ios) {
          const booted = state.ios.state === 'Booted' ? chalk.green('booted') : chalk.dim(state.ios.state.toLowerCase());
          const owned = state.ios.owned ? chalk.dim(' (owned)') : '';
          console.log(`  ios: ${chalk.cyan(state.ios.name ?? state.ios.udid)} ${booted}${owned}`);
        }
        if (state.android) {
          const kind = state.android.physical ? chalk.dim('(physical)') : chalk.dim('(emulator)');
          console.log(`  android: ${chalk.cyan(state.android.name)} ${kind}${state.android.owned ? chalk.dim(' (owned)') : ''}`);
        }
        for (const w of state.warnings) console.log(chalk.yellow(`  ! ${w}`));
      }

      // A worktree with no environment is not a problem -- it is just work that
      // has not been provisioned yet -- but it is invisible everywhere else.
      if (orphanWorktrees.length) {
        console.log(chalk.dim(`\nWorktrees with no environment (${orphanWorktrees.length}):`));
        for (const w of orphanWorktrees) console.log(chalk.dim(`  ${w.path}${w.branch ? ` [${w.branch}]` : ''}`));
      }

      const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
      console.log(
        chalk.dim(
          `\n${cap.liveCount} live environment(s), roughly ${gb(cap.committedMb)} of ${gb(cap.totalMemoryMb)} committed.`
        )
      );
      if (cap.overCapacity) {
        console.log(
          chalk.yellow('Over comfortable capacity. A machine that swaps is slower than one working in sequence -- release one before starting another.')
        );
      }
    });
}
