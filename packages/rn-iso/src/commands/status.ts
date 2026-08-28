// src/commands/status.js
import chalk from 'chalk';
import { existsSync } from 'fs';
import { totalmem } from 'os';
import type { Command } from 'commander';
import { getConfigDir, loadConfig } from '../config.ts';
import type { ProjectRecord, SupervisorRecord } from '../config.ts';
import { getExecutor } from '../exec.ts';
import { isMetroRunning } from '../ports.ts';
import { isPidAlive, resolveProjectMetro } from '../metro.ts';
import type { MetroResolution } from '../metro.ts';
import { queryLogs } from '../logs-query.ts';
import { workspaceLogsDir } from '../paths.ts';
import { readSupervisorState } from './stop.ts';
import { findProjectRoot, projectShortcut } from '../project.ts';
import { listAllIosSims } from '../sim/ios.ts';
import type { IosSimRecord } from '../sim/ios.ts';
import { listWorktrees } from '../worktree.ts';
import type { WorktreeEntry } from '../worktree.ts';
import { volumeRootFor } from '../fs-util.ts';
import { capacity, diskLine, environmentState, parseDfFree, tightVolumes, unprovisionedWorktrees } from '../status.ts';
import type { EnvironmentState, VolumeInfo, SimFacts, MetroFacts, WorktreeFacts } from '../status.ts';

// config.ts's SupervisorRecord does not declare `mode` (start.ts writes it
// alongside pid/port/startedAt); extended locally rather than editing the
// shared type (see the same extension in commands/stop.ts).
type SupervisorRecordExt = SupervisorRecord & { mode?: string | null };

interface StatusOptions {
  json?: boolean;
}

function formatGb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

export default function statusCommand(program: Command): void {
  program
    .command('status')
    .description(
      'Show every environment on this machine: devices, ports, what is actually running, and anything stuck.',
    )
    .option('--json', 'print the state as JSON')
    .action(async (opts: StatusOptions) => {
      const cfg = loadConfig();
      const projects = Object.entries(cfg?.projects || {});
      const cwdRoot = findProjectRoot(process.cwd());

      // Tolerate a machine with no simctl (a Linux box doing Android work).
      // "simctl did not answer" and "simctl answered with zero sims" are
      // different facts: only the second one proves a recorded sim is gone.
      const simsByUdid: Record<string, IosSimRecord> = {};
      let simsAvailable = true;
      let simctlError: string | null = null;
      try {
        for (const sim of listAllIosSims()) simsByUdid[sim.udid] = sim;
      } catch (e) {
        simsAvailable = false;
        simctlError = String((e as Error)?.message || e).split('\n')[0] ?? '';
      }

      // The first entry is the main checkout, not a workspace: listing it as
      // "unprovisioned" would flag every repo you ever run this in.
      const worktrees: WorktreeEntry[] = listWorktrees(process.cwd()).slice(1);

      const states: EnvironmentState[] = [];
      // `worktree create` registers the worktree ROOT to reserve its label,
      // but in a monorepo the app lives in a subdirectory and registers its
      // own entry -- so one workspace legitimately holds TWO registry entries.
      // This flags the label-only root, computed once and used by both output
      // modes: the human view relabels the line, and the JSON view carries it
      // as `labelOnly: true` so a consumer counting workspaces can fold the
      // root under its app instead of double-counting. The entry itself stays:
      // it is a real registry record (it holds the label), and `status`
      // reports the registry, it does not editorialize it away.
      const labelOnlyRoots: boolean[] = [];
      for (const [path, proj] of projects) {
        // Resolving Metro's identity costs an lsof per project, which is why it
        // is only done for ports that answer at all.
        let metro: MetroResolution | null = null;
        if (proj.metroPort) {
          metro = await resolveOnPort(proj.metroPort, path);
        }
        const supervisor = await supervisorFacts(path, proj, metro);
        states.push(
          environmentState(
            { ...proj, __path: path },
            {
              // environmentState's Facts views carry an index signature (so it
              // can read facts defensively); the resolved records here --
              // IosSimRecord, MetroResolution, WorktreeEntry -- are closed
              // interfaces, which TS will not assign to an index-signatured type
              // without this bridge. The values are structurally compatible.
              simsByUdid: simsByUdid as unknown as Record<string, SimFacts>,
              metro: metro as unknown as MetroFacts | null,
              worktrees: worktrees as unknown as WorktreeFacts[],
              simsAvailable,
              supervisor,
              logs: logFacts(path),
            },
          ),
        );
        const state = states[states.length - 1];
        labelOnlyRoots.push(
          Boolean(proj.worktreeRoot && !proj.bundleId && !state?.metro && !state?.ios && !state?.android),
        );
      }

      const totalMemoryMb = Math.round(totalmem() / (1024 * 1024));
      const cap = capacity(states, totalMemoryMb);
      const orphanWorktrees = unprovisionedWorktrees(
        worktrees as unknown as WorktreeFacts[],
        projects.map(([p]) => p),
      );

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              environments: states.map((state, i) => (labelOnlyRoots[i] ? { ...state, labelOnly: true } : state)),
              capacity: cap,
              unprovisionedWorktrees: orphanWorktrees,
              simctlAvailable: simsAvailable,
            },
            null,
            2,
          ),
        );
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
        // states is built one-per-project in the loop above, in the same order,
        // so states[i] is always present; guard only to satisfy the checker.
        const state = states[i];
        if (!state) continue;
        const shortcut = projectShortcut(path, proj);
        const marker = path === cwdRoot ? chalk.bold.cyan(`* ${shortcut}`) : shortcut;
        const idle = state.live ? '' : chalk.dim(' [idle]');
        console.log(`\n${marker}${idle} ${chalk.dim(`(${path})`)}`);
        // The root has no bundle id, no port and no device, so an `app: ?
        // (bare)` line described it as a broken app instead of what it is.
        // Only the label-only case (labelOnlyRoots above) is relabelled: a
        // root that IS the app still prints a normal app line.
        console.log(
          labelOnlyRoots[i]
            ? chalk.dim('  worktree root (holds the label; the app registers its own entry)')
            : chalk.dim(`  app: ${proj.bundleId ?? '?'} (${proj.isExpo ? 'expo' : 'bare'})`),
        );

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
          const errs = n > 0 ? chalk.yellow(` (${n} error${n === 1 ? '' : 's'} since the last marker)`) : '';
          console.log(chalk.dim(`  logs: ${state.logs.dir}`) + errs);
        }
        if (state.ios) {
          const booted =
            state.ios.state === 'Booted' ? chalk.green('booted') : chalk.dim(state.ios.state.toLowerCase());
          const owned = state.ios.owned ? chalk.dim(' (owned)') : '';
          console.log(`  ios: ${chalk.cyan(state.ios.name ?? state.ios.udid)} ${booted}${owned}`);
        }
        if (state.android) {
          const kind = state.android.physical ? chalk.dim('(physical)') : chalk.dim('(emulator)');
          console.log(
            `  android: ${chalk.cyan(state.android.name)} ${kind}${state.android.owned ? chalk.dim(' (owned)') : ''}`,
          );
        }
        for (const w of state.warnings) console.log(chalk.yellow(`  ! ${w}`));
      }

      // A worktree with no environment is not a problem -- it is just work that
      // has not been provisioned yet -- but it is invisible everywhere else.
      if (orphanWorktrees.length) {
        console.log(chalk.dim(`\nWorktrees with no environment (${orphanWorktrees.length}):`));
        for (const w of orphanWorktrees) console.log(chalk.dim(`  ${w.path}${w.branch ? ` [${w.branch}]` : ''}`));
      }

      console.log(
        chalk.dim(
          `\n${cap.liveCount} live environment(s), roughly ${formatGb(cap.committedMb)} of ${formatGb(cap.totalMemoryMb)} committed.`,
        ),
      );
      // RAM was the only resource reported, and disk is the one that actually
      // ran out. Bounded and failure-tolerant: an unreadable df prints nothing.
      //
      // Both volumes when the project is not on the boot one. Reporting only
      // `/` described a volume nothing was building on: this machine's repos
      // live on an external SSD, and build output is workspace-local, so the
      // volume that fills up is the project's. The boot volume stays in the
      // report because the shared caches and the simulator device set are on it
      // whatever the project's path.
      const volumes = readVolumes(cwdRoot || process.cwd());
      const line = diskLine(volumes);
      if (line) {
        const tight = tightVolumes(volumes);
        if (tight.length) {
          const which = tight.map((v) => v.volume).join(' and ');
          console.log(
            chalk.yellow(
              `${line} A single iOS build can exhaust ${which} -- run \`rn-iso gc\` before starting another environment.`,
            ),
          );
        } else {
          console.log(chalk.dim(line));
        }
      }
      if (cap.overCapacity) {
        console.log(
          chalk.yellow(
            'Over comfortable capacity. A machine that swaps is slower than one working in sequence -- release one before starting another.',
          ),
        );
      }
    });
}

// The volumes worth reporting: the boot volume, the global rn-iso state home,
// and the project itself. iOS DerivedData and shared caches use the state-home
// volume; Android build output and source mutations can still use the project
// volume. `volumeRootFor` keeps the labels consistent with gc.
//
// Single-quoted rather than run through runFile: the whole suite's mock
// executors implement `runQuiet` and nothing else, and a status line is not
// worth making every one of them grow a method. Single quotes make a space, a
// `$` and a `"` in a volume name all literal.
export function readVolumes(projectPath: string): VolumeInfo[] {
  const roots = [...new Set(['/', volumeRootFor(getConfigDir()), volumeRootFor(projectPath)])];
  const volumes: VolumeInfo[] = [];
  for (const volume of roots) {
    const quoted = `'${volume.replace(/'/g, "'\\''")}'`;
    const disk = parseDfFree(getExecutor().runQuiet(`df -k ${quoted}`, { timeoutMs: 5000 }));
    if (disk) volumes.push({ volume, disk });
  }
  return volumes;
}

// Resolving Metro's identity costs an lsof, which is why it only runs for a
// port that answers at all. Contract 3: health is the identity check, never a
// bare /status probe.
async function resolveOnPort(port: number, path: string): Promise<MetroResolution> {
  return (await isMetroRunning(port)) ? resolveProjectMetro(port, path) : { missing: true };
}

interface SupervisorFacts {
  pid: number;
  mode: string | null;
  startedAt: string | null;
  alive: boolean;
  healthy: boolean;
}

// The two records that describe a supervisor: the workspace's state.json and
// the global registration. Either alone is enough to REPORT one -- a workspace
// whose state file was deleted still has a registration, and that is precisely
// what makes a supervisor whose worktree vanished findable.
async function supervisorFacts(
  path: string,
  proj: ProjectRecord | undefined,
  metroResolution: MetroResolution | null,
): Promise<SupervisorFacts | null> {
  const state = readSupervisorState(path);
  const record: SupervisorRecordExt | null = proj?.supervisor ?? null;
  const pid = state?.pid ?? record?.pid ?? null;
  if (!pid) return null;
  const port = state?.port ?? record?.port ?? null;
  const alive = isPidAlive(pid);
  let healthy = false;
  if (alive && port) {
    // Reuse the resolution already paid for when the supervisor sits on the
    // reserved port, which is the normal case.
    const resolution = port === proj?.metroPort && metroResolution ? metroResolution : await resolveOnPort(port, path);
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
function logFacts(path: string): { dir: string; errorsSinceMarker: number } | null {
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
