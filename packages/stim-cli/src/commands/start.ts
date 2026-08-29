import chalk from 'chalk';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { StartError, StartFacts, SupervisorRecord } from '../types.ts';
import { getProject, upsertProject } from '../config.ts';
import { getExecutor } from '../exec.ts';
import { isPidAlive, resolveProjectMetro } from '../metro.ts';
import type { MetroResolution } from '../metro.ts';
import { queryLogs } from '../logs-query.ts';
import { ensureWorkspaceStorage, supervisorLogFile, workspaceLogsDir } from '../paths.ts';
import { reserveMetroPort } from '../ports.ts';
import { detectAndroidPackage, detectBundleId, detectIsExpo, findProjectRoot } from '../project.ts';
import {
  clearManagedMetroTunnel,
  readMetroTunnel,
  readWorkspaceState,
  writeWorkspaceState,
} from '../supervisor/state.ts';
import { workspaceProcessLockError } from '../engine/workspace-process-lock.ts';
import { spawnEntry } from '../spawn-entry.ts';
import {
  publicUrlSetting,
  ngrokUrlSetting,
  metroTunnelSettingError,
  remoteAndroidSetting,
  remoteDeviceSettingError,
  remoteIosSetting,
  resolveSettings,
  tunnelModeSetting,
  unknownSettingKeys,
} from '../settings.ts';
import { detectProviders, planMetroReach, PUBLIC_METRO_ENV, type ManagedProvider } from '../engine/metro-reach.ts';
import {
  startTunnelSequence,
  stopTunnel,
  terminateChild,
  withManagedRemoteWorktreeLock,
  withManagedTunnelLock,
  type StartTunnelSequenceOptions,
  type StartTunnelSequenceResult,
  type TunnelRecord,
} from '../engine/tunnel.ts';
import { gitCommonDir, repoRoot } from '../worktree.ts';
import { stepTimer } from './ios.ts';

const DEFAULT_WAIT_SECONDS = 60;
const POLL_MS = 500;
const LOG_TAIL_LINES = 5;
const ERROR_EVIDENCE_RECORDS = 8;

function writeNote(line: string): void {
  console.error(line);
}

export function supervisorEntry(): string {
  return spawnEntry('supervisor-run');
}

interface WaitResult {
  seconds?: number;
  error?: string;
}

export function wantsExpoOwnTunnel({
  isExpo,
  remote,
  mode,
  publicUrl,
}: {
  isExpo: boolean;
  remote: boolean;
  mode: string;
  publicUrl?: string | null;
}): boolean {
  return remote && isExpo && !publicUrl && mode === 'expo';
}

export function parseWait(value: unknown): WaitResult {
  if (value === undefined || value === null) return { seconds: DEFAULT_WAIT_SECONDS };
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { error: `Invalid --wait value ${JSON.stringify(value)}. Pass a number of seconds, e.g. --wait 90.` };
  }
  return { seconds };
}

interface SupervisorCandidate {
  pid?: unknown;
  port?: unknown;
  mode?: unknown;
  startedAt?: unknown;
}

interface LiveSupervisor {
  pid: number;
  port: number;
  mode: string | null;
  startedAt: string | null;
}

interface ChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function liveSupervisor({
  state,
  project,
  port,
  isAlive = isPidAlive,
}: {
  state?: { supervisor?: SupervisorCandidate | null } | null;
  project?: { supervisor?: SupervisorCandidate | null } | null;
  port?: number;
  isAlive?: (pid: number) => boolean;
} = {}): LiveSupervisor | null {
  const candidates = [state?.supervisor, project?.supervisor].filter((s): s is SupervisorCandidate =>
    Boolean(s && Number.isFinite(Number(s.pid))),
  );
  for (const candidate of candidates) {
    if (Number(candidate.port) !== Number(port)) continue;
    if (!isAlive(Number(candidate.pid))) continue;
    return {
      pid: Number(candidate.pid),
      port: Number(candidate.port),
      mode: (candidate.mode ?? state?.supervisor?.mode ?? null) as string | null,
      startedAt: (candidate.startedAt ?? null) as string | null,
    };
  }
  return null;
}

export function startFacts({
  port,
  supervisor,
  logsDir,
  alreadyRunning,
}: {
  port: number;
  supervisor?: SupervisorRecord | null;
  logsDir: string;
  alreadyRunning?: unknown;
}): StartFacts {
  return {
    port,
    supervisorPid: supervisor?.pid ?? null,
    mode: supervisor?.mode ?? null,
    logsDir,
    alreadyRunning: Boolean(alreadyRunning),
  };
}

export function startError({
  code,
  message,
  remedy = null,
}: {
  code: string;
  message: string;
  remedy?: string | null;
}): StartError {
  return { code, message, remedy: remedy ?? null };
}

export function tailLines(text: unknown, n: number = LOG_TAIL_LINES): string[] {
  const lines = String(text || '')
    .split('\n')
    .filter((l) => l.trim() !== '');
  return lines.slice(-n);
}

export function readLogTail(file: string, n: number = LOG_TAIL_LINES): string[] {
  try {
    return tailLines(readFileSync(file, 'utf-8'), n);
  } catch {
    return [];
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export default function startCommand(program: Command): void {
  registerStart(program);
}

interface StartOptions {
  json?: boolean;
  wait?: string;
  remote?: boolean;
}

interface StartCommandDeps {
  providers(): ManagedProvider[];
  startTunnelSequence(options: StartTunnelSequenceOptions): Promise<StartTunnelSequenceResult>;
  isTunnelAlive(pid: number): boolean;
  writeTunnelRecord(root: string, patch: Parameters<typeof writeWorkspaceState>[1]): unknown;
  stopTunnel(record: TunnelRecord): ReturnType<typeof stopTunnel>;
  writeSupervisorRecord(root: string, patch: Parameters<typeof writeWorkspaceState>[1]): unknown;
  terminateSupervisorChild(child: ChildProcess): Promise<boolean>;
  withWorktreeLock: typeof withManagedRemoteWorktreeLock;
  withTunnelLock: typeof withManagedTunnelLock;
  clearTunnelRecord(root: string, record: TunnelRecord): void;
}

function providersOnPath(): ManagedProvider[] {
  return detectProviders((bin) => {
    try {
      return Boolean(getExecutor().runQuiet(`command -v ${bin}`, { timeoutMs: 5000 }));
    } catch {
      return false;
    }
  });
}

const DEFAULT_START_DEPS: StartCommandDeps = {
  providers: providersOnPath,
  startTunnelSequence,
  isTunnelAlive: isPidAlive,
  writeTunnelRecord: writeWorkspaceState,
  stopTunnel,
  writeSupervisorRecord: writeWorkspaceState,
  terminateSupervisorChild: (child) =>
    terminateChild(child, {
      alreadyExited: false,
      timeoutMs: 1_000,
      now: Date.now,
      sleep,
      isAlive: isPidAlive,
    }),
  withWorktreeLock: withManagedRemoteWorktreeLock,
  withTunnelLock: withManagedTunnelLock,
  clearTunnelRecord: clearManagedMetroTunnel,
};

interface ManagedTunnelFailure {
  code: string;
  message: string;
  remedy: string;
}

interface ManagedTunnelTracking {
  record: TunnelRecord;
  startedHere: boolean;
}

type ManagedTunnelAcquisition = { origin: string; tunnel: ManagedTunnelTracking } | { failed: ManagedTunnelFailure };

function normalizeManagedTunnelUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function registerStart(program: Command, overrides: Partial<StartCommandDeps> = {}): void {
  const d = { ...DEFAULT_START_DEPS, ...overrides };
  program
    .command('start')
    .description(
      "Start this workspace's dev server under a detached supervisor and wait until it verifies as this project's. " +
        'Idempotent: a healthy dev server on the reserved port is a no-op. Structured logs land in the global workspace logs directory.',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--wait <seconds>', `How long to wait for the dev server to answer (default ${DEFAULT_WAIT_SECONDS})`)
    .option('--remote', 'Prepare the dev server for a remote device')
    .action(async (opts: StartOptions) => {
      const json = Boolean(opts.json);
      const waitTimer = stepTimer();
      const out = (line: string) => {
        if (json) console.error(line);
        else console.log(line);
      };
      const note = writeNote;
      const fail = ({
        code,
        message,
        remedy = null,
        lines = [],
      }: {
        code: string;
        message: string;
        remedy?: string | null;
        lines?: string[];
      }): never => {
        note(chalk.red(message));
        for (const line of lines) note(chalk.dim(`  ${line}`));
        if (remedy) note(chalk.dim(remedy));
        note(chalk.red(`failed: ${code}`));
        if (json) console.log(JSON.stringify(startError({ code, message, remedy })));
        process.exit(1);
      };

      const wait = parseWait(opts.wait);
      if (wait.error) {
        return fail({
          code: 'STIM_CLI_BAD_ARG',
          message: wait.error,
          remedy: 'Pass a whole number of seconds, e.g. --wait 90.',
        });
      }
      const waitSeconds = wait.seconds as number;

      const root = findProjectRoot(process.cwd());
      if (!root) {
        return fail({
          code: 'STIM_CLI_NO_PROJECT',
          message: 'Not in a React Native project (no package.json found).',
          remedy: 'Run this from the app directory -- the one holding package.json.',
        });
      }

      try {
        ensureWorkspaceStorage(root);
      } catch (error) {
        return fail({
          code: (error as Error & { code?: string })?.code || 'STIM_CLI_WORKSPACE_STATE',
          message: `Could not prepare this workspace's stim-cli state: ${(error as Error)?.message || error}`,
          remedy: 'Check that STIM_CLI_HOME is writable and has free space.',
        });
      }

      const isExpo = detectIsExpo(root);
      const worktreeRoot = repoRoot(root) ?? root;
      const settings = resolveSettings({
        projectPath: root,
        gitCommonDir: gitCommonDir(root),
        repoRoot: worktreeRoot,
      });
      for (const key of unknownSettingKeys(settings)) {
        note(chalk.yellow(`Warning: setting "${key}" is not read by stim-cli and will be ignored.`));
      }
      const settingError = metroTunnelSettingError(settings);
      if (settingError) {
        return fail({
          code: 'STIM_CLI_BAD_ARG',
          message: settingError,
          remedy: `Set metro.tunnel to one of: auto, expo, ngrok, cloudflared, off.`,
        });
      }
      const remoteSettingError = remoteDeviceSettingError(settings);
      if (remoteSettingError) {
        return fail({
          code: 'STIM_CLI_BAD_ARG',
          message: remoteSettingError,
          remedy: 'Set ios.remote and android.remote to either proxy or eas.',
        });
      }
      const remote =
        Boolean(opts.remote) || remoteIosSetting(settings) !== null || remoteAndroidSetting(settings) !== null;
      const tunnelMode = tunnelModeSetting(settings) ?? 'auto';
      const publicUrl = publicUrlSetting(settings);
      const tunnel = wantsExpoOwnTunnel({
        isExpo,
        remote,
        mode: tunnelMode,
        publicUrl,
      });
      if (tunnel) note(chalk.dim("note   requesting an Expo tunnel for this workspace's dev server"));

      const managedRemote = remote && !tunnel && !publicUrl && tunnelMode !== 'off';
      const runStart = async (): Promise<void> => {
        upsertProject(root, {
          bundleId: detectBundleId(root) ?? undefined,
          androidPackage: detectAndroidPackage(root) ?? undefined,
          isExpo,
        });

        const logsDir = workspaceLogsDir(root);
        const logFile = supervisorLogFile(root);
        const port = await resolvePort(root, note);
        let publicOrigin = remote ? publicUrl : null;
        let resolution = await resolveProjectMetro(port, root);
        let supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
        let managedTunnel: ManagedTunnelTracking | null = null;
        let spawnedChild: ChildProcess | null = null;
        let spawnedTs: number | null = null;
        let childExit: ChildExitInfo | null = null;

        const spawnSupervisor = (origin: string | null): ChildProcess => {
          mkdirSync(logsDir, { recursive: true });
          const fd = openSync(logFile, 'a');
          spawnedTs = Date.now();
          const supervisorArgs = [
            supervisorEntry(),
            '--root',
            root,
            '--port',
            String(port),
            ...(tunnel ? ['--tunnel'] : []),
          ];
          const child = getExecutor().spawn(process.execPath, supervisorArgs, {
            cwd: root,
            detached: true,
            stdio: ['ignore', fd, fd],
            env: origin
              ? {
                  ...process.env,
                  [PUBLIC_METRO_ENV]: origin,
                  EXPO_PACKAGER_PROXY_URL: origin,
                }
              : process.env,
          });
          child.unref?.();
          child.on?.('exit', (code, signal) => {
            childExit = { code, signal };
          });
          child.on?.('error', (err) => {
            childExit = { code: null, signal: null, error: err };
          });
          out(chalk.dim(`Supervisor pid ${child.pid} starting the dev server on port ${port}...`));
          spawnedChild = child;
          return child;
        };

        const waitForSupervisorHandoff = async (child: ChildProcess): Promise<LiveSupervisor | null> => {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const found = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
            if (found?.pid === child.pid) return found;
            if (childExit !== null || (child.pid ? !isPidAlive(child.pid) : true)) return null;
            await sleep(25);
          }
          return null;
        };

        if (remote && !tunnel && !publicUrl && tunnelMode !== 'off') {
          const available = d.providers();
          const plan = planMetroReach({ mode: tunnelMode, metroPort: port, publicUrl, isExpo, available });
          if ('failed' in plan) {
            return fail({ code: 'STIM_CLI_REMOTE_METRO_UNREACHABLE', message: plan.failed, remedy: plan.remedy });
          }
          if ('start' in plan) {
            const candidates: readonly ManagedProvider[] = tunnelMode === 'auto' ? available : [plan.start];
            const expectedStableUrl = ngrokUrlSetting(settings);
            let acquisition: ManagedTunnelAcquisition;
            try {
              acquisition = await d.withTunnelLock(root, async () => {
                let tracking: ManagedTunnelTracking;
                let startedCleanup: (() => Promise<{ status: 'stopped' | 'failed'; reason?: string }>) | null = null;
                const recorded = readMetroTunnel(root);
                if (recorded?.kind === 'managed' && d.isTunnelAlive(recorded.pid)) {
                  if (!recorded.processToken) {
                    return {
                      failed: {
                        code: 'STIM_CLI_REMOTE_START_REQUIRED',
                        message: 'The recorded managed Metro tunnel has no process identity token.',
                        remedy:
                          'Inspect the process, stop it with the provider tooling, remove the stale metroTunnel state, and retry.',
                      },
                    };
                  }
                  const reusable =
                    recorded.port === port &&
                    candidates.includes(recorded.provider) &&
                    (!expectedStableUrl || normalizeManagedTunnelUrl(recorded.url) === expectedStableUrl);
                  if (!reusable) {
                    return {
                      failed: {
                        code: 'STIM_CLI_REMOTE_START_REQUIRED',
                        message: `A different managed Metro tunnel is already running for this workspace.`,
                        remedy: 'Run `stim stop`, then `stim start --remote`.',
                      },
                    };
                  }
                  tracking = {
                    record: {
                      provider: recorded.provider,
                      pid: recorded.pid,
                      url: normalizeManagedTunnelUrl(recorded.url),
                      port: recorded.port,
                      startedAt: recorded.startedAt,
                      processToken: recorded.processToken,
                      logFile: recorded.logFile,
                    },
                    startedHere: false,
                  };
                } else {
                  const currentResolution = await resolveProjectMetro(port, root);
                  const currentSupervisor = liveSupervisor({
                    state: readWorkspaceState(root),
                    project: getProject(root),
                    port,
                  });
                  if (currentResolution.metro || currentSupervisor) {
                    return {
                      failed: {
                        code: 'STIM_CLI_REMOTE_START_REQUIRED',
                        message: `The dev server on port ${port} is local-only and cannot gain a managed tunnel while it is running.`,
                        remedy: 'Run `stim stop`, then `stim start --remote`.',
                      },
                    };
                  }

                  const started = await d.startTunnelSequence({
                    providers: candidates,
                    port,
                    ngrokUrl: expectedStableUrl,
                    requireReachable: false,
                  });
                  if ('failed' in started) {
                    return {
                      failed: {
                        code: 'STIM_CLI_REMOTE_METRO_UNREACHABLE',
                        message: `Could not start a managed Metro tunnel for port ${port}.`,
                        remedy: started.reason,
                      },
                    };
                  }
                  const record: TunnelRecord = {
                    provider: started.provider,
                    pid: started.pid,
                    url: normalizeManagedTunnelUrl(started.url),
                    port,
                    startedAt: new Date().toISOString(),
                    processToken: started.processToken,
                    logFile: started.logFile,
                  };
                  startedCleanup = started.cleanup;
                  try {
                    d.writeTunnelRecord(root, {
                      metroTunnel: {
                        kind: 'managed',
                        ...record,
                      },
                    });
                  } catch (err) {
                    const stopped = await started.cleanup();
                    return {
                      failed: {
                        code: 'STIM_CLI_REMOTE_METRO_UNREACHABLE',
                        message: `Could not record the managed Metro tunnel: ${(err as Error)?.message || err}`,
                        remedy:
                          stopped.status === 'failed'
                            ? `Cleanup failed. Unmanaged pid ${record.pid} may still be running: ${stopped.reason ?? 'unknown error'}`
                            : 'The tunnel process was stopped. Fix the workspace write error, then retry `stim start --remote`.',
                      },
                    };
                  }
                  tracking = { record, startedHere: true };
                }

                const currentResolution = await resolveProjectMetro(port, root);
                const currentSupervisor = liveSupervisor({
                  state: readWorkspaceState(root),
                  project: getProject(root),
                  port,
                });
                if (currentResolution.metro || currentSupervisor) {
                  if (tracking.startedHere && startedCleanup) {
                    const stopped = await startedCleanup();
                    if (stopped.status === 'failed') {
                      return {
                        failed: {
                          code: 'STIM_CLI_REMOTE_START_REQUIRED',
                          message: `The dev server on port ${port} started before the managed tunnel was ready.`,
                          remedy: `Tunnel cleanup failed for pid ${tracking.record.pid}: ${stopped.reason ?? 'unknown error'}. The tunnel record remains available to \`stim stop\`.`,
                        },
                      };
                    }
                    d.clearTunnelRecord(root, tracking.record);
                    return {
                      failed: {
                        code: 'STIM_CLI_REMOTE_START_REQUIRED',
                        message: `The dev server on port ${port} started before the managed tunnel was ready.`,
                        remedy: 'Run `stim stop`, then `stim start --remote`.',
                      },
                    };
                  }
                  return { origin: tracking.record.url, tunnel: tracking };
                }

                if (!d.isTunnelAlive(tracking.record.pid)) {
                  if (tracking.startedHere && startedCleanup) {
                    const stopped = await startedCleanup();
                    if (stopped.status === 'failed') {
                      return {
                        failed: {
                          code: 'STIM_CLI_REMOTE_METRO_UNREACHABLE',
                          message: `The managed ${tracking.record.provider} tunnel exited before the supervisor started.`,
                          remedy: `Cleanup failed. Unmanaged pid ${tracking.record.pid} may still be running: ${stopped.reason ?? 'unknown error'}. The tunnel record remains available to \`stim stop\`.`,
                        },
                      };
                    }
                  }
                  d.clearTunnelRecord(root, tracking.record);
                  return {
                    failed: {
                      code: 'STIM_CLI_REMOTE_METRO_UNREACHABLE',
                      message: `The managed ${tracking.record.provider} tunnel exited before the supervisor started.`,
                      remedy: 'Retry `stim start --remote`.',
                    },
                  };
                }

                let child: ChildProcess;
                try {
                  child = spawnSupervisor(tracking.record.url);
                } catch (err) {
                  return {
                    failed: {
                      code: 'STIM_CLI_SUPERVISOR_EXITED',
                      message: `Could not spawn the dev server supervisor: ${(err as Error)?.message || err}`,
                      remedy: 'Fix the spawn error, then retry `stim start --remote`.',
                    },
                  };
                }
                const handoffRecord = {
                  pid: child.pid as number,
                  port,
                  mode: isExpo ? 'expo-child' : 'bare-inproc',
                  startedAt: new Date(spawnedTs ?? Date.now()).toISOString(),
                };
                try {
                  d.writeSupervisorRecord(root, { supervisor: handoffRecord });
                } catch {
                  const handedOff = await waitForSupervisorHandoff(child);
                  if (!handedOff) {
                    const stopped = await d.terminateSupervisorChild(child);
                    return {
                      failed: {
                        code: 'STIM_CLI_SUPERVISOR_EXITED',
                        message: `Could not record supervisor pid ${child.pid ?? 'unknown'} before releasing the managed start lock.`,
                        remedy: stopped
                          ? 'The supervisor process was stopped. Retry `stim start --remote`.'
                          : `Cleanup failed. Unmanaged supervisor pid ${child.pid ?? 'unknown'} may still be running. Stop it before retrying.`,
                      },
                    };
                  }
                }
                return { origin: tracking.record.url, tunnel: tracking };
              });
            } catch (err) {
              return fail({
                code: 'STIM_CLI_REMOTE_METRO_UNREACHABLE',
                message: `Could not acquire the managed Metro tunnel lock: ${(err as Error)?.message || err}`,
                remedy: 'Retry `stim start --remote` after the other start command finishes.',
              });
            }
            if ('failed' in acquisition) {
              return fail(acquisition.failed);
            }
            publicOrigin = acquisition.origin;
            managedTunnel = acquisition.tunnel;
            resolution = await resolveProjectMetro(port, root);
            supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
          }
        }

        const managedTunnelExited = () => managedTunnel !== null && !d.isTunnelAlive(managedTunnel.record.pid);
        const failExitedManagedTunnel = async (): Promise<never> => {
          const tracked = managedTunnel as ManagedTunnelTracking;
          const record = tracked.record;
          const stopped = tracked.startedHere ? await d.stopTunnel(record) : { status: 'missing' as const };
          if (stopped.status !== 'failed') d.clearTunnelRecord(root, record);
          return fail({
            code: 'STIM_CLI_REMOTE_METRO_UNREACHABLE',
            message: `The managed ${record.provider} tunnel exited before the dev server became ready.`,
            remedy:
              stopped.status === 'failed'
                ? `The tunnel cleanup also failed: ${stopped.reason ?? 'unknown error'}. Run \`stim stop\`, then retry.`
                : 'Run `stim stop`, then `stim start --remote`.',
          });
        };

        const requireExpoTunnel = () => {
          if (tunnel && (!supervisor || readMetroTunnel(root)?.kind !== 'expo')) {
            fail({
              code: 'STIM_CLI_REMOTE_START_REQUIRED',
              message: `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`,
              remedy: 'Run `stim stop`, then `stim start --remote`.',
            });
          }
        };

        if (!spawnedChild && resolution.metro) {
          if (managedTunnelExited()) return failExitedManagedTunnel();
          if (tunnel && supervisor) {
            const tunnelReady = await waitForExpoTunnel({
              root,
              seconds: waitSeconds,
              aborted: () => !liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }),
            });
            if (!tunnelReady) {
              const stillLive = liveSupervisor({
                state: readWorkspaceState(root),
                project: getProject(root),
                port,
              });
              return fail({
                code: 'STIM_CLI_REMOTE_START_REQUIRED',
                message: stillLive
                  ? `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`
                  : `The Expo dev server on port ${port} stopped before its tunnel became ready.`,
                remedy: stillLive ? 'Run `stim stop`, then `stim start --remote`.' : 'Run `stim start --remote` again.',
              });
            }
            supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
          }
          requireExpoTunnel();
          if (!supervisor) {
            note(chalk.dim(`A dev server for this project already answers on port ${port}, started outside stim-cli.`));
            note(chalk.dim('Leaving it alone: stim-cli will not start a second bundler over a working one.'));
          }
          if (managedTunnelExited()) return failExitedManagedTunnel();
          report({ json, out, port, supervisor, logsDir, alreadyRunning: true, waited: waitTimer() });
          return;
        }

        if (!spawnedChild && supervisor) {
          note(
            chalk.dim(
              `Supervisor pid ${supervisor.pid} is already running for this workspace; waiting for it to answer on port ${port}...`,
            ),
          );
          const healthy = await waitForMetro({
            root,
            port,
            seconds: waitSeconds,
            aborted: managedTunnel ? managedTunnelExited : undefined,
          });
          if (!healthy) {
            if (managedTunnelExited()) return failExitedManagedTunnel();
            return fail({
              code: 'STIM_CLI_METRO_TIMEOUT',
              message: `Supervisor pid ${supervisor.pid} did not serve port ${port} within ${waitSeconds}s.`,
              lines: logTailLines(logFile),
              remedy: 'Run `stim stop` to halt it, then `stim start` again.',
            });
          }
          if (tunnel) {
            const tunnelReady = await waitForExpoTunnel({
              root,
              seconds: waitSeconds,
              aborted: () => !liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }),
            });
            if (!tunnelReady) {
              const stillLive = liveSupervisor({
                state: readWorkspaceState(root),
                project: getProject(root),
                port,
              });
              return fail({
                code: 'STIM_CLI_REMOTE_START_REQUIRED',
                message: stillLive
                  ? `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`
                  : `The Expo dev server on port ${port} stopped before its tunnel became ready.`,
                remedy: stillLive ? 'Run `stim stop`, then `stim start --remote`.' : 'Run `stim start --remote` again.',
              });
            }
          }
          supervisor =
            liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }) ||
            (tunnel ? null : supervisor);
          requireExpoTunnel();
          if (managedTunnelExited()) return failExitedManagedTunnel();
          report({ json, out, port, supervisor, logsDir, alreadyRunning: true, waited: waitTimer() });
          return;
        }

        if (managedTunnelExited()) return failExitedManagedTunnel();
        const child = spawnedChild ?? spawnSupervisor(publicOrigin);
        const attemptStartedTs = spawnedTs ?? Date.now();

        const healthy = await waitForMetro({
          root,
          port,
          seconds: waitSeconds,
          aborted: () => childExit !== null || (child.pid ? !isPidAlive(child.pid) : false) || managedTunnelExited(),
        });

        if (!healthy) {
          if (managedTunnelExited()) return failExitedManagedTunnel();
          const gone = childExit !== null || (child.pid ? !isPidAlive(child.pid) : false);
          const exitInfo = childExit as ChildExitInfo | null;
          const how = exitInfo
            ? exitInfo.signal
              ? `signal ${exitInfo.signal}`
              : `code ${exitInfo.code}`
            : 'without being observed';
          return fail(
            gone
              ? {
                  code: 'STIM_CLI_SUPERVISOR_EXITED',
                  message: `The supervisor exited (${how}) before the dev server came up on port ${port}.`,
                  lines: failureEvidence({ logFile, logsDir, sinceTs: attemptStartedTs }),
                  remedy: 'Fix the error above and run `stim start` again; `stim logs --errors` has the full records.',
                }
              : {
                  code: 'STIM_CLI_METRO_TIMEOUT',
                  message: `The dev server did not answer on port ${port} within ${waitSeconds}s.`,
                  lines: failureEvidence({ logFile, logsDir, sinceTs: attemptStartedTs }),
                  remedy: 'It may still be starting. Run `stim stop` to halt it, or `stim logs` to follow along.',
                },
          );
        }

        if (managedTunnelExited()) return failExitedManagedTunnel();

        if (tunnel) {
          const tunnelReady = await waitForExpoTunnel({
            root,
            seconds: waitSeconds,
            aborted: () => childExit !== null || (child.pid ? !isPidAlive(child.pid) : false),
          });
          if (!tunnelReady) {
            const gone = childExit !== null || (child.pid ? !isPidAlive(child.pid) : false);
            return fail({
              code: gone ? 'STIM_CLI_SUPERVISOR_EXITED' : 'STIM_CLI_METRO_TIMEOUT',
              message: gone
                ? `The supervisor exited before the Expo tunnel became ready on port ${port}.`
                : `Expo did not report a tunnel URL within ${waitSeconds}s.`,
              remedy: 'Run `stim stop`, then `stim start --remote`.',
            });
          }
        }

        supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }) || {
          pid: child.pid as number,
          port,
          mode: null,
          startedAt: null,
        };
        report({ json, out, port, supervisor, logsDir, alreadyRunning: false, waited: waitTimer() });
      };

      if (!managedRemote) return runStart();
      try {
        return await d.withWorktreeLock(worktreeRoot, runStart);
      } catch (err) {
        const lockError = workspaceProcessLockError(err);
        if (lockError === 'refused') {
          return fail({
            code: 'STIM_CLI_WORKTREE_REMOVAL_IN_PROGRESS',
            message: `The worktree at ${worktreeRoot} is being removed.`,
            remedy: 'Retry `stim start --remote` after `stim worktree remove` finishes.',
          });
        }
        if (lockError === 'timeout') {
          return fail({
            code: 'STIM_CLI_REMOTE_METRO_UNREACHABLE',
            message: `Could not acquire the managed remote worktree lock: ${(err as Error)?.message || err}`,
            remedy: 'Retry `stim start --remote` after the other remote start command finishes.',
          });
        }
        throw err;
      }
    });
}

async function resolvePort(root: string, note: (line: string) => void): Promise<number> {
  const project = getProject(root);
  const recorded = project?.metroPort;
  if (!recorded) return await reserveMetroPort(root);
  const held = await resolveProjectMetro(recorded, root);
  if (!held.notOurs) return recorded;
  const fresh = await reserveMetroPort(root);
  if (fresh !== recorded) {
    note(chalk.yellow(`Port ${recorded} is held by something else (${held.notOurs}).`));
    note(chalk.dim(`Reserved port ${fresh} for this project instead.`));
  }
  return fresh;
}

async function waitForMetro({
  root,
  port,
  seconds,
  aborted = () => false,
  probe = resolveProjectMetro,
}: {
  root: string;
  port: number;
  seconds: number;
  aborted?: () => boolean;
  probe?: (port: number, root: string) => Promise<MetroResolution>;
}): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const resolution = await probe(port, root);
    if (resolution.metro) return true;
    if (aborted()) return false;
    await sleep(POLL_MS);
  }
  const last = await probe(port, root);
  return Boolean(last.metro);
}

async function waitForExpoTunnel({
  root,
  seconds,
  aborted = () => false,
}: {
  root: string;
  seconds: number;
  aborted?: () => boolean;
}): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (aborted()) return false;
    if (readMetroTunnel(root)?.kind === 'expo') return true;
    await sleep(POLL_MS);
  }
  return !aborted() && readMetroTunnel(root)?.kind === 'expo';
}

function logTailLines(logFile: string): string[] {
  return [...readLogTail(logFile), `Supervisor log: ${logFile}`];
}

export function failureEvidence({
  logFile,
  logsDir,
  sinceTs,
}: {
  logFile: string;
  logsDir: string;
  sinceTs: number;
}): string[] {
  const supTail = readLogTail(logFile);
  const lines = supTail.length > 0 ? [...supTail, `Supervisor log: ${logFile}`] : [];
  let errors: ReturnType<typeof queryLogs> = [];
  let all: ReturnType<typeof queryLogs> = [];
  try {
    errors = queryLogs({ dir: logsDir, minLevel: 'error' });
    all = queryLogs({ dir: logsDir });
  } catch {}
  const since = (rs: ReturnType<typeof queryLogs>) =>
    rs.filter((r) => typeof r.ts === 'number' && r.ts >= sinceTs).slice(-ERROR_EVIDENCE_RECORDS);
  let recent = since(errors);
  const fellBack = recent.length === 0;
  if (fellBack) recent = since(all);
  for (const r of recent) {
    lines.push(`${String(r.src ?? '?')}: ${String(r.msg ?? '').split('\n')[0] ?? ''}`);
  }
  if (recent.length > 0) lines.push(fellBack ? 'Full records: `stim logs`' : 'Full records: `stim logs --errors`');
  return lines;
}

function report({
  json,
  out,
  port,
  supervisor,
  logsDir,
  alreadyRunning,
  waited,
}: {
  json: boolean;
  out: (line: string) => void;
  port: number;
  supervisor: LiveSupervisor | null;
  logsDir: string;
  alreadyRunning: boolean;
  waited: string;
}): StartFacts {
  const facts = startFacts({
    port,
    supervisor: supervisor as unknown as SupervisorRecord | null,
    logsDir,
    alreadyRunning,
  });
  if (json) {
    console.log(JSON.stringify(facts));
    return facts;
  }
  const who = facts.supervisorPid
    ? `supervisor pid ${facts.supervisorPid}${facts.mode ? ` (${facts.mode})` : ''}`
    : 'started outside stim-cli';
  out(chalk.green(`OK: dev server on port ${port}, ${who}${alreadyRunning ? ' (already running)' : ''} ${waited}`));
  out(chalk.dim(`Logs: ${logsDir}`));
  return facts;
}
