// src/commands/start.js -- reserve the port, spawn the detached supervisor,
// wait until the dev server is verifiably THIS project's, print the facts.
//
// `start` is the one command that blocks on purpose: waiting for health is its
// contract, because everything an agent does next (build, install, launch)
// fails slowly and confusingly if the bundler is not up yet.
//
// Health is `resolveProjectMetro`, never a bare /status probe. A port is not
// identity: a foreign bundler answering /status on our reserved port would
// send the agent's build at someone else's dev server, which is exactly what
// the identity check exists to prevent -- and the reserved port moves instead
// of being reported as a conflict the caller can do nothing about.
//
// Three flags: --json, --wait, and --remote. Anything a project needs
// beyond that is the project's own bundler command, which is not rn-iso's
// judgment to make.
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
import { supervisorLogFile, workspaceLogsDir } from '../paths.ts';
import { reserveMetroPort } from '../ports.ts';
import { detectAndroidPackage, detectBundleId, detectIsExpo, findProjectRoot } from '../project.ts';
import {
  clearManagedMetroTunnel,
  readMetroTunnel,
  readWorkspaceState,
  writeWorkspaceState,
} from '../supervisor/state.ts';
import { ensureWorkspaceIgnored } from '../engine/workspace.ts';
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
  withManagedTunnelLock,
  type StartTunnelSequenceOptions,
  type StartTunnelSequenceResult,
  type TunnelRecord,
} from '../engine/tunnel.ts';
import { gitCommonDir, repoRoot } from '../worktree.ts';
// The same stopwatch the build commands stamp their phase lines with, so the
// OK line's total wait reads the same way ("4s", "1m4s").
import { stepTimer } from './ios.ts';

const DEFAULT_WAIT_SECONDS = 60;
const POLL_MS = 500;
const LOG_TAIL_LINES = 5;
const ERROR_EVIDENCE_RECORDS = 8;

export function supervisorEntry(): string {
  return spawnEntry('supervisor-run');
}

interface WaitResult {
  seconds?: number;
  error?: string;
}

// PURE. Whether THIS Expo dev server should tunnel itself.
//
// Matches engine/metro-reach.ts's own condition for its `{ expoTunnel: true }`
// branch (mode is "expo", or "auto" on an Expo project) and its precedence
// (a named metro.publicUrl wins over starting anything). Not routed through
// planMetroReach itself: that function also decides between a managed
// provider and a refusal, neither of which `start` can act on -- there is no
// device here yet to hand a tunnel to, and no `available` providers worth
// probing for a decision this narrow.
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
  return remote && isExpo && !publicUrl && (mode === 'expo' || mode === 'auto');
}

export function parseWait(value: unknown): WaitResult {
  if (value === undefined || value === null) return { seconds: DEFAULT_WAIT_SECONDS };
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { error: `Invalid --wait value ${JSON.stringify(value)}. Pass a number of seconds, e.g. --wait 90.` };
  }
  return { seconds };
}

// A loose, defensive read of whatever `state.supervisor` / `project.supervisor`
// carries -- state.json's `supervisor` block is a Record<string, unknown> (see
// supervisor/state.ts) and config.ts's ProjectRecord.supervisor does not
// declare `mode`, so this names only the fields liveSupervisor actually reads.
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

// Pure. The workspace state file is the primary record -- it is the only one
// that carries the mode -- and the global config entry is the fallback for a
// workspace whose .rn-iso directory was removed under a running supervisor.
//
// "Live" is pid alive AND the recorded port is the port we are about to use.
// Both halves matter: a pid alone is not proof (pids are reused, and a stale
// state.json outlives its process), and a supervisor recorded on a different
// port is not the one that would answer here.
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

// Pure shaping of the --json payload, under the contract every rn-iso command
// with a --json flag follows: one line on stdout, everything else on stderr.
//
// supervisorPid and mode are null when a dev server answers on the port but
// rn-iso did not start it -- an agent that ran the project's own `npm start`
// first. That is reported rather than fought: the port has what it needs, and
// starting a second bundler over it would be the actual failure.
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

// Pure shaping of the FAILURE payload, the other half of the same contract:
// one parseable line on stdout either way. `start --json` used to print nothing
// at all when it failed, so a caller doing `facts=$(rn-iso start --json)` got an
// empty string and had to fall back to scraping stderr prose -- exactly what
// `guide facts` promises the build commands never make you do. The shape is
// theirs: a stable code to branch on, a message, and a remedy (null when there
// is nothing to suggest beyond what was already printed).
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
        'Idempotent: a healthy dev server on the reserved port is a no-op. Structured logs land in .rn-iso/logs.',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--wait <seconds>', `How long to wait for the dev server to answer (default ${DEFAULT_WAIT_SECONDS})`)
    .option('--remote', 'Prepare the dev server for a remote device')
    .action(async (opts: StartOptions) => {
      const json = Boolean(opts.json);
      // Total wait, command start to the OK line: `start` blocks on health by
      // contract, and how long that took is part of the report.
      const waitTimer = stepTimer();
      const out = (line: string) => {
        if (json) console.error(line);
        else console.log(line);
      };
      const note = (line: string) => console.error(line);
      // Every failure exits the same way: the diagnostic, whatever evidence
      // there is for it, the remedy, and -- under --json -- the error contract
      // as the single line on stdout. Same shape `ios` / `android` use, because
      // an agent branching on `code` must not have to know which command it
      // called.
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
          code: 'RN_ISO_BAD_ARG',
          message: wait.error,
          remedy: 'Pass a whole number of seconds, e.g. --wait 90.',
        });
      }
      // parseWait's contract: exactly one of `error` / `seconds` is set.
      const waitSeconds = wait.seconds as number;

      const root = findProjectRoot(process.cwd());
      if (!root) {
        return fail({
          code: 'RN_ISO_NO_PROJECT',
          message: 'Not in a React Native project (no package.json found).',
          remedy: 'Run this from the app directory -- the one holding package.json.',
        });
      }

      // `start` is the first command of the loop, so it is where the workspace
      // directory first appears. Ensuring git ignores it here rather than in a
      // setup command is what removes the step a repo had to remember: `ios` and
      // `android` call the same function for the same reason, since either can
      // be the first to write into `<root>/.rn-iso`.
      const ignored = ensureWorkspaceIgnored(root);
      if (ignored.added) note(chalk.dim('note   added .rn-iso/ to .gitignore'));
      else if (ignored.error) note(chalk.yellow(`note   could not update ${ignored.path}: ${ignored.error}`));

      const isExpo = detectIsExpo(root);
      upsertProject(root, {
        bundleId: detectBundleId(root) ?? undefined,
        androidPackage: detectAndroidPackage(root) ?? undefined,
        isExpo,
      });

      const settings = resolveSettings({
        projectPath: root,
        gitCommonDir: gitCommonDir(root),
        repoRoot: repoRoot(root),
      });
      for (const key of unknownSettingKeys(settings)) {
        note(chalk.yellow(`Warning: setting "${key}" is not read by rn-iso and will be ignored.`));
      }
      const settingError = metroTunnelSettingError(settings);
      if (settingError) {
        return fail({
          code: 'RN_ISO_BAD_ARG',
          message: settingError,
          remedy: `Set metro.tunnel to one of: auto, expo, ngrok, cloudflared, off.`,
        });
      }
      const remoteSettingError = remoteDeviceSettingError(settings);
      if (remoteSettingError) {
        return fail({
          code: 'RN_ISO_BAD_ARG',
          message: remoteSettingError,
          remedy: 'Set ios.remote and android.remote to either proxy or eas.',
        });
      }
      const remote =
        Boolean(opts.remote) || remoteIosSetting(settings) !== null || remoteAndroidSetting(settings) !== null;
      const tunnelMode = tunnelModeSetting(settings) ?? 'auto';
      const publicUrl = publicUrlSetting(settings);
      // Decided here, not at `ios`/`android --remote` time: a later run
      // cannot retroactively add `--tunnel` to an already-running dev server.
      const tunnel = wantsExpoOwnTunnel({
        isExpo,
        remote,
        mode: tunnelMode,
        publicUrl,
      });
      if (tunnel) note(chalk.dim("note   requesting an Expo tunnel for this workspace's dev server"));

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
        // One append-only descriptor preserves stdout and stderr order and
        // records failures that occur before structured logging starts.
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
          // The supervisor owns its process group so it survives this command
          // and can be stopped without signalling the caller's shell.
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
          return fail({ code: 'RN_ISO_REMOTE_METRO_UNREACHABLE', message: plan.failed, remedy: plan.remedy });
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
                      code: 'RN_ISO_REMOTE_START_REQUIRED',
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
                      code: 'RN_ISO_REMOTE_START_REQUIRED',
                      message: `A different managed Metro tunnel is already running for this workspace.`,
                      remedy: 'Run `rn-iso stop`, then `rn-iso start --remote`.',
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
                      code: 'RN_ISO_REMOTE_START_REQUIRED',
                      message: `The dev server on port ${port} is local-only and cannot gain a managed tunnel while it is running.`,
                      remedy: 'Run `rn-iso stop`, then `rn-iso start --remote`.',
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
                      code: 'RN_ISO_REMOTE_METRO_UNREACHABLE',
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
                      code: 'RN_ISO_REMOTE_METRO_UNREACHABLE',
                      message: `Could not record the managed Metro tunnel: ${(err as Error)?.message || err}`,
                      remedy:
                        stopped.status === 'failed'
                          ? `Cleanup failed. Unmanaged pid ${record.pid} may still be running: ${stopped.reason ?? 'unknown error'}`
                          : 'The tunnel process was stopped. Fix the workspace write error, then retry `rn-iso start --remote`.',
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
                        code: 'RN_ISO_REMOTE_START_REQUIRED',
                        message: `The dev server on port ${port} started before the managed tunnel was ready.`,
                        remedy: `Tunnel cleanup failed for pid ${tracking.record.pid}: ${stopped.reason ?? 'unknown error'}. The tunnel record remains available to \`rn-iso stop\`.`,
                      },
                    };
                  }
                  d.clearTunnelRecord(root, tracking.record);
                  return {
                    failed: {
                      code: 'RN_ISO_REMOTE_START_REQUIRED',
                      message: `The dev server on port ${port} started before the managed tunnel was ready.`,
                      remedy: 'Run `rn-iso stop`, then `rn-iso start --remote`.',
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
                        code: 'RN_ISO_REMOTE_METRO_UNREACHABLE',
                        message: `The managed ${tracking.record.provider} tunnel exited before the supervisor started.`,
                        remedy: `Cleanup failed. Unmanaged pid ${tracking.record.pid} may still be running: ${stopped.reason ?? 'unknown error'}. The tunnel record remains available to \`rn-iso stop\`.`,
                      },
                    };
                  }
                }
                d.clearTunnelRecord(root, tracking.record);
                return {
                  failed: {
                    code: 'RN_ISO_REMOTE_METRO_UNREACHABLE',
                    message: `The managed ${tracking.record.provider} tunnel exited before the supervisor started.`,
                    remedy: 'Retry `rn-iso start --remote`.',
                  },
                };
              }

              let child: ChildProcess;
              try {
                child = spawnSupervisor(tracking.record.url);
              } catch (err) {
                return {
                  failed: {
                    code: 'RN_ISO_SUPERVISOR_EXITED',
                    message: `Could not spawn the dev server supervisor: ${(err as Error)?.message || err}`,
                    remedy: 'Fix the spawn error, then retry `rn-iso start --remote`.',
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
                      code: 'RN_ISO_SUPERVISOR_EXITED',
                      message: `Could not record supervisor pid ${child.pid ?? 'unknown'} before releasing the managed start lock.`,
                      remedy: stopped
                        ? 'The supervisor process was stopped. Retry `rn-iso start --remote`.'
                        : `Cleanup failed. Unmanaged supervisor pid ${child.pid ?? 'unknown'} may still be running. Stop it before retrying.`,
                    },
                  };
                }
              }
              return { origin: tracking.record.url, tunnel: tracking };
            });
          } catch (err) {
            return fail({
              code: 'RN_ISO_REMOTE_METRO_UNREACHABLE',
              message: `Could not acquire the managed Metro tunnel lock: ${(err as Error)?.message || err}`,
              remedy: 'Retry `rn-iso start --remote` after the other start command finishes.',
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
          code: 'RN_ISO_REMOTE_METRO_UNREACHABLE',
          message: `The managed ${record.provider} tunnel exited before the dev server became ready.`,
          remedy:
            stopped.status === 'failed'
              ? `The tunnel cleanup also failed: ${stopped.reason ?? 'unknown error'}. Run \`rn-iso stop\`, then retry.`
              : 'Run `rn-iso stop`, then `rn-iso start --remote`.',
        });
      };

      const requireExpoTunnel = () => {
        if (tunnel && (!supervisor || readMetroTunnel(root)?.kind !== 'expo')) {
          fail({
            code: 'RN_ISO_REMOTE_START_REQUIRED',
            message: `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`,
            remedy: 'Run `rn-iso stop`, then `rn-iso start --remote`.',
          });
        }
      };

      // Already up: the whole point of an idempotent start. Two `start` runs in
      // a row must leave one supervisor, not two bundlers fighting for a port.
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
              code: 'RN_ISO_REMOTE_START_REQUIRED',
              message: stillLive
                ? `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`
                : `The Expo dev server on port ${port} stopped before its tunnel became ready.`,
              remedy: stillLive
                ? 'Run `rn-iso stop`, then `rn-iso start --remote`.'
                : 'Run `rn-iso start --remote` again.',
            });
          }
          supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
        }
        requireExpoTunnel();
        if (!supervisor) {
          note(chalk.dim(`A dev server for this project already answers on port ${port}, started outside rn-iso.`));
          note(chalk.dim('Leaving it alone: rn-iso will not start a second bundler over a working one.'));
        }
        if (managedTunnelExited()) return failExitedManagedTunnel();
        report({ json, out, port, supervisor, logsDir, alreadyRunning: true, waited: waitTimer() });
        return;
      }

      // A live supervisor that is not answering yet is either still starting
      // (the common case, when two `start` runs race) or wedged. Either way,
      // spawning a second one would leave the workspace with two supervisors
      // and one port, so we wait on the one that exists instead.
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
            code: 'RN_ISO_METRO_TIMEOUT',
            message: `Supervisor pid ${supervisor.pid} did not serve port ${port} within ${waitSeconds}s.`,
            lines: logTailLines(logFile),
            remedy: 'Run `rn-iso stop` to halt it, then `rn-iso start` again.',
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
              code: 'RN_ISO_REMOTE_START_REQUIRED',
              message: stillLive
                ? `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`
                : `The Expo dev server on port ${port} stopped before its tunnel became ready.`,
              remedy: stillLive
                ? 'Run `rn-iso stop`, then `rn-iso start --remote`.'
                : 'Run `rn-iso start --remote` again.',
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

      // ---- spawn the supervisor ----
      if (managedTunnelExited()) return failExitedManagedTunnel();
      const child = spawnedChild ?? spawnSupervisor(publicOrigin);
      const attemptStartedTs = spawnedTs ?? Date.now();

      const healthy = await waitForMetro({
        root,
        port,
        seconds: waitSeconds,
        // A supervisor that has already exited is never going to answer, so
        // the wait ends at second one instead of at sixty.
        aborted: () => childExit !== null || (child.pid ? !isPidAlive(child.pid) : false) || managedTunnelExited(),
      });

      if (!healthy) {
        if (managedTunnelExited()) return failExitedManagedTunnel();
        // A supervisor that is GONE and one that is merely slow need different
        // next steps, so the two are distinguished rather than both reported
        // as a timeout. The exit event is the better evidence; the liveness
        // check catches the case where the process died without us seeing it.
        const gone = childExit !== null || (child.pid ? !isPidAlive(child.pid) : false);
        // Cast rather than rely on narrowing: childExit is only ever
        // reassigned inside the 'exit'/'error' listeners above, and TS's flow
        // analysis does not see through those closures back to its declared
        // type here.
        const exitInfo = childExit as ChildExitInfo | null;
        const how = exitInfo
          ? exitInfo.signal
            ? `signal ${exitInfo.signal}`
            : `code ${exitInfo.code}`
          : 'without being observed';
        return fail(
          gone
            ? {
                code: 'RN_ISO_SUPERVISOR_EXITED',
                message: `The supervisor exited (${how}) before the dev server came up on port ${port}.`,
                lines: failureEvidence({ logFile, logsDir, sinceTs: attemptStartedTs }),
                remedy:
                  'Fix the error above and run `rn-iso start` again; `rn-iso logs --errors` has the full records.',
              }
            : {
                code: 'RN_ISO_METRO_TIMEOUT',
                message: `The dev server did not answer on port ${port} within ${waitSeconds}s.`,
                lines: failureEvidence({ logFile, logsDir, sinceTs: attemptStartedTs }),
                remedy: 'It may still be starting. Run `rn-iso stop` to halt it, or `rn-iso logs` to follow along.',
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
            code: gone ? 'RN_ISO_SUPERVISOR_EXITED' : 'RN_ISO_METRO_TIMEOUT',
            message: gone
              ? `The supervisor exited before the Expo tunnel became ready on port ${port}.`
              : `Expo did not report a tunnel URL within ${waitSeconds}s.`,
            remedy: 'Run `rn-iso stop`, then `rn-iso start --remote`.',
          });
        }
      }

      supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }) ||
        // child.pid is only undefined if the spawn itself failed, which the
        // health check above would already have turned into a failure.
        { pid: child.pid as number, port, mode: null, startedAt: null };
      report({ json, out, port, supervisor, logsDir, alreadyRunning: false, waited: waitTimer() });
    });
}

// The reserved port, re-reserved when a FOREIGN process holds it. Reporting
// the conflict instead would strand the project on a port it can never use,
// while our own dev server answering there is the healthy case and must not
// move.
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

// The evidence a start failure carries: the last lines of the supervisor's raw
// stdio, then the path to the rest of it. That file is the ONLY record of a
// supervisor that died before it could write a structured one, which is why
// every failure quotes it.
function logTailLines(logFile: string): string[] {
  return [...readLogTail(logFile), `Supervisor log: ${logFile}`];
}

// The evidence for a spawn-path failure. The supervisor's own log is quoted
// when it has anything to say -- but the death cry is usually NOT there: an
// expo child's output is parsed into the workspace timeline as records, so a
// child that dies before serving (a config PluginError, a bad app config)
// leaves supervisor.log EMPTY while the actual error sits in metro.ndjson.
// Pointing at the empty file was issue #24; the timeline's error records from
// THIS attempt are the part of the answer that was always on disk.
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
  } catch {
    // An unreadable timeline must not mask the failure being reported.
  }
  const since = (rs: ReturnType<typeof queryLogs>) =>
    rs.filter((r) => typeof r.ts === 'number' && r.ts >= sinceTs).slice(-ERROR_EVIDENCE_RECORDS);
  let recent = since(errors);
  // Level inference on a child's raw output is best-effort, so a death cry
  // can sit in the timeline at info (#30). When nothing made it to error
  // level, the last raw lines of THIS attempt are still the best evidence
  // there is -- the same reasoning as quoting supervisor.log's tail.
  const fellBack = recent.length === 0;
  if (fellBack) recent = since(all);
  for (const r of recent) {
    lines.push(`${String(r.src ?? '?')}: ${String(r.msg ?? '').split('\n')[0] ?? ''}`);
  }
  if (recent.length > 0) lines.push(fellBack ? 'Full records: `rn-iso logs`' : 'Full records: `rn-iso logs --errors`');
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
  // Pre-rendered "(4s)": the total wait, stamped by the caller's stepTimer.
  // The --json payload does not carry it -- one contract, unchanged.
  waited: string;
}): StartFacts {
  // LiveSupervisor is a closed, non-null shape (see above); SupervisorRecord
  // is the loose index-signature bag startFacts (and the wider --json
  // contract) is written against. Structurally compatible, cast for the
  // index signature and the null-vs-undefined difference on mode/startedAt.
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
    : 'started outside rn-iso';
  out(chalk.green(`OK: dev server on port ${port}, ${who}${alreadyRunning ? ' (already running)' : ''} ${waited}`));
  out(chalk.dim(`Logs: ${logsDir}`));
  return facts;
}
