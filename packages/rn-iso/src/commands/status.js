// src/commands/status.js
import chalk from 'chalk';
import { existsSync } from 'fs';
import { totalmem } from 'os';
import { loadConfig } from '../config.js';
import { getExecutor } from '../exec.js';
import { isMetroRunning } from '../ports.js';
import { isPidAlive, resolveProjectMetro } from '../metro.js';
import { queryLogs } from '../logs-query.js';
import { workspaceLogsDir } from '../paths.js';
import { readSupervisorState } from './stop.js';
import { findProjectRoot, projectShortcut } from '../project.js';
import { listAllIosSims } from '../sim/ios.js';
import { listWorktrees } from '../worktree.js';
import { capacity, diskIsTight, environmentState, parseDfFree, unprovisionedWorktrees } from '../status.js';

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
          metro = await resolveOnPort(proj.metroPort, path);
        }
        const supervisor = await supervisorFacts(path, proj, metro);
        states.push(environmentState({ ...proj, __path: path }, {
          simsByUdid,
          metro,
          worktrees,
          simsAvailable,
          supervisor,
          logs: logFacts(path),
        }));
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
        // `worktree create` registers the worktree ROOT to reserve its label,
        // but in a monorepo the app lives in a subdirectory and registers its
        // own entry. The root has no bundle id, no port and no device, so an
        // `app: ? (bare)` line described it as a broken app instead of what it
        // is. Only the label-only case is relabelled: a root that IS the app
        // still prints a normal app line.
        const labelOnly = proj.worktreeRoot && !proj.bundleId && !state.metro && !state.ios && !state.android;
        console.log(labelOnly
          ? chalk.dim('  worktree root (holds the label; the app registers its own entry)')
          : chalk.dim(`  app: ${proj.bundleId ?? '?'} (${proj.isExpo ? 'expo' : 'bare'})`));

        if (state.metro) {
          const label = state.metro.running
            ? chalk.green(`running (pid ${state.metro.pid})`)
            : chalk.dim('not running');
          console.log(`  metro: port ${state.metro.port} ${label}`);
        }
        // The supervisor is what `stop` acts on and what `start` reuses, so it
        // is reported even when it is not answering: an agent seeing a pid here
        // and no health is looking at the thing to stop.
        if (state.supervisor) {
          const health = state.supervisor.healthy ? chalk.green('healthy') : chalk.yellow('not answering');
          const mode = state.supervisor.mode ? chalk.dim(` (${state.supervisor.mode})`) : '';
          console.log(`  supervisor: pid ${state.supervisor.pid}${mode} ${health}`);
        }
        if (state.logs) {
          const n = state.logs.errorsSinceMarker;
          const errs = n > 0
            ? chalk.yellow(` (${n} error${n === 1 ? '' : 's'} since the last marker)`)
            : '';
          console.log(chalk.dim(`  logs: ${state.logs.dir}`) + errs);
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
      // RAM was the only resource reported, and disk is the one that actually
      // ran out. Bounded and failure-tolerant: an unreadable df prints nothing.
      const disk = parseDfFree(getExecutor().runQuiet('df -k /', { timeoutMs: 5000 }));
      if (disk) {
        const line = `${gb(disk.availableMb)} free of ${gb(disk.totalMb)} on disk.`;
        console.log(diskIsTight(disk) ? chalk.yellow(`${line} A single iOS build can exhaust that -- run \`rn-iso gc\` before starting another environment.`) : chalk.dim(line));
      }
      if (cap.overCapacity) {
        console.log(
          chalk.yellow('Over comfortable capacity. A machine that swaps is slower than one working in sequence -- release one before starting another.')
        );
      }
    });
}

// Resolving Metro's identity costs an lsof, which is why it only runs for a
// port that answers at all. Contract 3: health is the identity check, never a
// bare /status probe.
async function resolveOnPort(port, path) {
  return (await isMetroRunning(port)) ? resolveProjectMetro(port, path) : { missing: true };
}

// The two records that describe a supervisor: the workspace's state.json and
// the global registration. Either alone is enough to REPORT one -- a workspace
// whose state file was deleted still has a registration, and that is precisely
// what makes a supervisor whose worktree vanished findable.
async function supervisorFacts(path, proj, metroResolution) {
  const state = readSupervisorState(path);
  const record = proj?.supervisor ?? null;
  const pid = state?.pid ?? record?.pid ?? null;
  if (!pid) return null;
  const port = state?.port ?? record?.port ?? null;
  const alive = isPidAlive(pid);
  let healthy = false;
  if (alive && port) {
    // Reuse the resolution already paid for when the supervisor sits on the
    // reserved port, which is the normal case.
    const resolution = port === proj?.metroPort && metroResolution
      ? metroResolution
      : await resolveOnPort(port, path);
    healthy = Boolean(resolution?.metro);
  }
  return {
    pid,
    mode: state?.mode ?? record?.mode ?? null,
    startedAt: state?.startedAt ?? record?.startedAt ?? null,
    alive,
    healthy,
  };
}

// The error count is the query an agent loop actually issues, so it is cheap
// enough to answer here: errors since the most recent marker (a bundle build or
// an app launch), which is the window that describes the CURRENT state.
function logFacts(path) {
  const dir = workspaceLogsDir(path);
  if (!existsSync(dir)) return null;
  try {
    return { dir, errorsSinceMarker: queryLogs({ dir, errorsOnly: true }).length };
  } catch {
    // A log directory that cannot be read is not a reason for `status` to fail:
    // the point of this command is reporting what it can see.
    return { dir, errorsSinceMarker: 0 };
  }
}
