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

      const simsByUdid: Record<string, IosSimRecord> = {};
      let simsAvailable = true;
      let simctlError: string | null = null;
      try {
        for (const sim of listAllIosSims()) simsByUdid[sim.udid] = sim;
      } catch (e) {
        simsAvailable = false;
        simctlError = String((e as Error)?.message || e).split('\n')[0] ?? '';
      }

      const worktrees: WorktreeEntry[] = listWorktrees(process.cwd()).slice(1);

      const states: EnvironmentState[] = [];
      const labelOnlyRoots: boolean[] = [];
      for (const [path, proj] of projects) {
        let metro: MetroResolution | null = null;
        if (proj.metroPort) {
          metro = await resolveOnPort(proj.metroPort, path);
        }
        const supervisor = await supervisorFacts(path, proj, metro);
        states.push(
          environmentState(
            { ...proj, __path: path },
            {
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

      if (!simsAvailable) {
        console.log(chalk.yellow(`simctl could not be read (${simctlError}), so no iOS sim below could be checked.`));
      }

      for (const [i, [path, proj]] of projects.entries()) {
        const state = states[i];
        if (!state) continue;
        const shortcut = projectShortcut(path, proj);
        const marker = path === cwdRoot ? chalk.bold.cyan(`* ${shortcut}`) : shortcut;
        const idle = state.live ? '' : chalk.dim(' [idle]');
        console.log(`\n${marker}${idle} ${chalk.dim(`(${path})`)}`);
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

      if (orphanWorktrees.length) {
        console.log(chalk.dim(`\nWorktrees with no environment (${orphanWorktrees.length}):`));
        for (const w of orphanWorktrees) console.log(chalk.dim(`  ${w.path}${w.branch ? ` [${w.branch}]` : ''}`));
      }

      console.log(
        chalk.dim(
          `\n${cap.liveCount} live environment(s), roughly ${formatGb(cap.committedMb)} of ${formatGb(cap.totalMemoryMb)} committed.`,
        ),
      );
      const volumes = readVolumes(cwdRoot || process.cwd());
      const line = diskLine(volumes);
      if (line) {
        const tight = tightVolumes(volumes);
        if (tight.length) {
          const which = tight.map((v) => v.volume).join(' and ');
          console.log(
            chalk.yellow(
              `${line} A single iOS build can exhaust ${which} -- run \`stim-cli gc\` before starting another environment.`,
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

function logFacts(path: string): { dir: string; errorsSinceMarker: number } | null {
  const dir = workspaceLogsDir(path);
  if (!existsSync(dir)) return null;
  try {
    return { dir, errorsSinceMarker: queryLogs({ dir, errorsOnly: true }).length };
  } catch {
    return { dir, errorsSinceMarker: 0 };
  }
}
