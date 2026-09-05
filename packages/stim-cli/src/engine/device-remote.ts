import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { getExecutor } from '../exec.ts';
import { isPidAlive } from '../metro.ts';
import { gateMetroOrigin, REMOTE_METRO_WRONG } from './metro-gate.ts';
import { workspaceDir, workspaceLogsDir, workspaceStateFile } from '../paths.ts';
import { clearRemoteSession, readMetroTunnel, readRemoteSession } from '../supervisor/state.ts';
import type { RemoteDeviceBackend } from '../types.ts';
import {
  acceptAlertArgs,
  closeArgs,
  connectArgs,
  daemonEnv,
  disconnectArgs,
  installArgs,
  metroHintFrom,
  openArgs,
  remoteProfile,
  remoteProfilePath,
} from './agent-device.ts';
import { planMetroReach, PUBLIC_METRO_ENV, type ManagedProvider, type TunnelMode } from './metro-reach.ts';
import { devClientDeepLink, INSTALL_ERROR, isBundleProof, LAUNCH_ERROR, readMetroRecords } from './app-install.ts';
import {
  createSessionArgs,
  getSessionArgs,
  inspectSessionForTeardown,
  isDefinitiveMissingSessionError,
  parseCreatedSession,
  remoteDaemonFrom,
  stopSessionArgs,
  verifyStoppedSession,
  type RemoteDaemon,
} from './eas-simulator.ts';
import { withWorkspaceProcessLock, type WorkspaceProcessLockOptions } from './workspace-process-lock.ts';
import { withEasProjectLock } from './eas-project-lock.ts';
import {
  easMachineStateRoot,
  readEasSessionLedger,
  recordEasSessionClaim,
  removeEasSessionClaim,
} from './eas-session-ledger.ts';
import { getConfigDir } from '../config.ts';

export const REMOTE_SESSION_ERROR = 'STIM_NO_REMOTE_SESSION';
const REMOTE_METRO_ERROR = 'STIM_REMOTE_METRO_UNREACHABLE';

export { PUBLIC_METRO_ENV } from './metro-reach.ts';

export function resolveMetroOrigin({
  metroPort,
  publicUrl = null,
  mode = 'auto',
  isExpo = false,
  available = [],
}: {
  metroPort: number | string;
  publicUrl?: string | null;
  mode?: TunnelMode;
  isExpo?: boolean;
  available?: readonly ManagedProvider[];
}): { origin: string; gate: boolean } | { failed: string; remedy: string } {
  const plan = planMetroReach({ mode, metroPort, publicUrl, isExpo, available });
  if ('origin' in plan) return plan;
  if ('failed' in plan) return plan;
  return {
    failed: 'Metro has no address the device can reach yet.',
    remedy: 'This is a Stim bug: the tunnel step did not run before the launch.',
  };
}

interface RemoteDeviceRecord {
  deviceName: string;
  owned: true;
  remote: true;
}

interface OpFailure {
  failed: true;
  code: string;
  reason: string;
}

export interface BootResult {
  ok?: boolean;
  udid?: string;
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
}

export interface AbandonCreatedSessionResult {
  ok?: true;
  failed?: true;
  code?: string;
  reason?: string;
  remedy?: string;
  sessionId: string | null;
}
interface InstallResult {
  ok?: boolean;
  appPath?: string;
  failed?: boolean;
  code?: string;
  reason?: string;
}
interface LaunchResult {
  ok?: boolean;
  mode?: string;
  url?: string;
  jsLocation?: string;
  failed?: boolean;
  code?: string;
  reason?: string;
}

function describe(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  return stderr || String(e?.message ?? err);
}

export interface RemoteContext {
  root: string;
  label: string;
  backend: RemoteDeviceBackend;
  easBin: string;
  agentDeviceBin: string;
  platform?: 'ios' | 'android';
  maxDurationMinutes?: number | null;
  publicMetroUrl?: string | null;
  tunnelMode?: TunnelMode;
  isExpo?: boolean;
  sleep?: (ms: number) => Promise<void>;
  existingDaemon?: RemoteDaemon | null;
  easLedgerRoot?: string;
  removeEasSessionClaim?: typeof removeEasSessionClaim;
}

interface RemoteSession {
  id: string | null;
  daemon: RemoteDaemon;
  profilePath: string;
}

const PROXY_CREDENTIAL_ENV = ['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN'] as const;

function easExecOptions(root: string): { cwd: string; omitEnv: typeof PROXY_CREDENTIAL_ENV } {
  return { cwd: root, omitEnv: PROXY_CREDENTIAL_ENV };
}

const EAS_OPERATION_TIMEOUT_MS = 30_000;

function easBoundedExecOptions(root: string): {
  cwd: string;
  omitEnv: typeof PROXY_CREDENTIAL_ENV;
  timeoutMs: number;
} {
  return { ...easExecOptions(root), timeoutMs: EAS_OPERATION_TIMEOUT_MS };
}

function writeProfile(ctx: RemoteContext, daemon: RemoteDaemon): string {
  const path = remoteProfilePath(ctx.root);
  mkdirSync(dirname(path), { recursive: true });
  const profile = remoteProfile({ daemon, platform: ctx.platform ?? 'ios', label: ctx.label });
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`);
  return path;
}

function remoteDeviceDeps(ctx: RemoteContext) {
  let session: RemoteSession | null = null;
  let createdSession: string | null = null;

  const easEnv = easExecOptions(ctx.root);

  return {
    checkCapacity: () => null,

    ensureDevice: async (): Promise<RemoteDeviceRecord> => ({
      deviceName: ctx.backend === 'proxy' ? 'remote device (your daemon)' : 'EAS Simulator',
      owned: true,
      remote: true,
    }),

    ensureBooted: async ({ out = () => {} }: { out?: (msg: string) => void } = {}): Promise<BootResult> => {
      session = null;
      createdSession = null;
      const note = (message: string): void => {
        try {
          out(message);
        } catch {
          /* device ownership must not depend on terminal output */
        }
      };
      let daemon = ctx.existingDaemon ?? null;
      let id: string | null = null;
      let createdHere: string | null = null;

      if (!daemon) {
        const recorded = readRemoteSession(ctx.root);
        if (recorded && recorded.platform !== (ctx.platform ?? 'ios')) {
          return {
            failed: true,
            code: 'STIM_REMOTE_PLATFORM_MISMATCH',
            reason: `Session ${recorded.sessionId} belongs to ${recorded.platform ?? 'an unknown platform'}, not ${ctx.platform ?? 'ios'}.`,
            remedy: 'Run `stim stop` for this workspace before selecting a different remote platform.',
          };
        }
        if (recorded) {
          const existing = readLiveDaemon(ctx, recorded.sessionId);
          if (existing) {
            note(`Reusing EAS Simulator session ${recorded.sessionId}.`);
            daemon = existing;
            id = recorded.sessionId;
          } else {
            note(`Recorded session ${recorded.sessionId} is not usable; verifying it before replacement.`);
            const cleanup = teardownRemote(ctx, { sessionId: recorded.sessionId });
            if (cleanup.status === 'failed' || cleanup.reason) {
              return {
                failed: true,
                code: 'STIM_REMOTE_SESSION_CLEANUP',
                reason: cleanup.reason ?? `Could not verify recorded EAS session ${recorded.sessionId}.`,
                remedy: 'Inspect the recorded session, then run `stim stop` again.',
              };
            }
            clearRemoteSession(ctx.root, recorded.sessionId);
          }
        }
      }

      if (!daemon) {
        note('Creating an EAS Simulator session (this takes a moment).');
        let stdout: string;
        try {
          stdout = getExecutor().runFile(
            ctx.easBin,
            createSessionArgs({
              label: ctx.label,
              platform: ctx.platform ?? 'ios',
              maxDurationMinutes: ctx.maxDurationMinutes ?? null,
            }),
            easEnv,
          );
        } catch (err) {
          return { failed: true, reason: `eas sim failed: ${describe(err)}` };
        }
        const created = parseCreatedSession(stdout);
        if (!created) {
          return { failed: true, reason: 'eas sim returned no session; run it by hand to see what it reported.' };
        }
        id = created.id;
        createdHere = created.id;
        daemon = created.daemon ?? (await waitForDaemon(ctx, created.id, note, { sleep: ctx.sleep ?? defaultSleep }));
        if (!daemon) {
          return abandonSession(
            ctx,
            created.id,
            `Session ${created.id} never published an agent-device endpoint. It may be an appium or argent session rather than an agent-device one.`,
          );
        }
      }

      let profilePath: string;
      try {
        profilePath = writeProfile(ctx, daemon);
      } catch (err) {
        const reason = `Could not write the remote connection profile: ${describe(err)}`;
        if (createdHere) return abandonSession(ctx, createdHere, reason);
        return { failed: true, reason };
      }
      try {
        getExecutor().runFile(ctx.agentDeviceBin, closeArgs(profilePath), {
          cwd: ctx.root,
          env: daemonEnv(daemon),
        });
      } catch {
        /* nothing to close, or a lease already expired: connect proceeds */
      }
      try {
        getExecutor().runFile(ctx.agentDeviceBin, connectArgs(profilePath), {
          cwd: ctx.root,
          env: daemonEnv(daemon),
        });
      } catch (err) {
        if (createdHere) return abandonSession(ctx, createdHere, `agent-device connect failed: ${describe(err)}`);
        return { failed: true, reason: `agent-device connect failed: ${describe(err)}` };
      }

      session = { id, daemon, profilePath };
      createdSession = createdHere;
      if (daemon.webPreviewUrl) note(`Watch this device: ${daemon.webPreviewUrl}`);
      return { ok: true, udid: id ?? daemonHostLabel(daemon.baseUrl) };
    },

    installArtifact: (artifactPath: string): InstallResult => {
      if (!session) return notConnected(INSTALL_ERROR);
      try {
        getExecutor().runFile(ctx.agentDeviceBin, installArgs(session.profilePath, artifactPath), {
          cwd: ctx.root,
          env: daemonEnv(session.daemon),
        });
        return { ok: true, appPath: artifactPath };
      } catch (err) {
        return {
          failed: true,
          code: INSTALL_ERROR,
          reason: `agent-device install failed for ${artifactPath}: ${describe(err)}`,
        };
      }
    },

    launchApp: ({
      appId,
      metroPort,
      devClientScheme = null,
    }: {
      appId: string;
      metroPort: number | string | null;
      devClientScheme?: string | null;
    }): LaunchResult => {
      if (!session) return notConnected(LAUNCH_ERROR);
      if (metroPort === null) {
        try {
          getExecutor().runFile(ctx.agentDeviceBin, openArgs(session.profilePath, appId, null, null), {
            cwd: ctx.root,
            env: daemonEnv(session.daemon),
          });
          return { ok: true, mode: 'launch' };
        } catch (err) {
          return { failed: true, code: LAUNCH_ERROR, reason: `agent-device open ${appId} failed: ${describe(err)}` };
        }
      }
      const origin = resolveMetroOrigin({
        metroPort,
        publicUrl: ctx.publicMetroUrl ?? null,
        mode: ctx.tunnelMode ?? 'auto',
        isExpo: ctx.isExpo ?? false,
      });
      if ('failed' in origin) {
        return { failed: true, code: REMOTE_METRO_ERROR, reason: `${origin.failed} ${origin.remedy}` };
      }

      const url = devClientScheme ? devClientDeepLink(devClientScheme, origin.origin) : null;
      try {
        getExecutor().runFile(
          ctx.agentDeviceBin,
          openArgs(session.profilePath, appId, url, metroHintFrom(origin.origin)),
          {
            cwd: ctx.root,
            env: daemonEnv(session.daemon),
          },
        );
        if (url) {
          try {
            getExecutor().runFile(ctx.agentDeviceBin, acceptAlertArgs(session.profilePath), {
              cwd: ctx.root,
              env: daemonEnv(session.daemon),
            });
          } catch {
            /* no alert to accept: the ordinary case once a device has seen one */
          }
        }
        return { ok: true, mode: url ? 'openurl' : 'launch', url: url ?? undefined, jsLocation: origin.origin };
      } catch (err) {
        return {
          failed: true,
          code: LAUNCH_ERROR,
          reason: `agent-device open ${appId} failed: ${describe(err)}`,
        };
      }
    },

    createdSessionId: (): string | null => createdSession,

    abandonCreatedSession: (): AbandonCreatedSessionResult => {
      if (!createdSession) return { ok: true, sessionId: null };
      const id = createdSession;
      const stopped = stopCreatedSession(ctx, id);
      if (stopped.ok) {
        session = null;
        createdSession = null;
      }
      return stopped;
    },

    webPreviewUrl: (): string | null => session?.daemon.webPreviewUrl ?? null,
  };
}

export async function resolveRemoteContext({
  root,
  label,
  backend,
  platform = 'ios',
  easBin,
  env = process.env,
  lookupAgentDevice = defaultLookupAgentDevice,
  maxDurationMinutes = null,
}: {
  root: string;
  label: string;
  backend: RemoteDeviceBackend;
  platform?: 'ios' | 'android';
  easBin: string | null;
  tunnelMode?: TunnelMode;
  publicUrl?: string | null;
  isExpo?: boolean;
  metroPort?: number | string;
  available?: readonly ManagedProvider[];
  env?: NodeJS.ProcessEnv;
  lookupAgentDevice?: () => string | null;
  maxDurationMinutes?: number | null;
}): Promise<{ ctx: RemoteContext } | { failed: string; remedy: string; code?: string }> {
  const agentDeviceBin = lookupAgentDevice();
  if (!agentDeviceBin) {
    return {
      failed: 'agent-device is not on PATH, and it is what drives a remote device.',
      remedy: `Install it (\`npm i -g agent-device\`), then run \`stim ${platform} --remote ${backend}\` again.`,
    };
  }

  const baseUrl = env.AGENT_DEVICE_DAEMON_BASE_URL?.trim();
  const token = env.AGENT_DEVICE_DAEMON_AUTH_TOKEN?.trim();
  let existingDaemon: RemoteDaemon | null = null;
  if (backend === 'proxy') {
    if (!baseUrl && !token) {
      return {
        failed: 'The proxy backend requires AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
        remedy:
          'Export AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN, then run the device command with `--remote proxy` again.',
        code: 'STIM_REMOTE_PROXY_CONFIG',
      };
    }
    if (!baseUrl) {
      return {
        failed: 'The proxy backend requires AGENT_DEVICE_DAEMON_BASE_URL.',
        remedy: 'Export AGENT_DEVICE_DAEMON_BASE_URL, then run the device command with `--remote proxy` again.',
        code: 'STIM_REMOTE_PROXY_CONFIG',
      };
    }
    if (!token) {
      return {
        failed: 'The proxy backend requires AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
        remedy: 'Export AGENT_DEVICE_DAEMON_AUTH_TOKEN, then run the device command with `--remote proxy` again.',
        code: 'STIM_REMOTE_PROXY_CONFIG',
      };
    }
    existingDaemon = { baseUrl, token };
  } else if (!easBin) {
    return {
      failed: 'The eas backend requires eas-cli.',
      remedy: 'Install eas-cli, then run the device command with `--remote eas` again.',
      code: 'STIM_REMOTE_EAS_UNAVAILABLE',
    };
  }

  return {
    ctx: {
      root,
      label,
      backend,
      platform,
      easBin: easBin ?? '',
      agentDeviceBin,
      maxDurationMinutes,
      publicMetroUrl: null,
      existingDaemon,
    },
  };
}

export function binOnPath(bin: string): boolean {
  try {
    return Boolean(getExecutor().runQuiet(`command -v ${bin}`, { timeoutMs: 5000 }));
  } catch {
    return false;
  }
}

function defaultLookupAgentDevice(): string | null {
  const found = getExecutor().runQuiet('command -v agent-device', { timeoutMs: 5000 });
  const file = (String(found ?? '').split('\n')[0] ?? '').trim();
  return file || null;
}

// eas sim can return before its agent-device endpoint exists; cloud VM boot can take minutes.
const DAEMON_WAIT_MS = 180_000;
const DAEMON_POLL_MS = 5_000;

async function waitForDaemon(
  ctx: RemoteContext,
  sessionId: string,
  out: (msg: string) => void,
  { sleep = defaultSleep }: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<RemoteDaemon | null> {
  const attempts = Math.ceil(DAEMON_WAIT_MS / DAEMON_POLL_MS);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const daemon = readDaemon(ctx, sessionId);
    if (daemon) return daemon;
    if (attempt === 0) out(`Waiting for session ${sessionId} to become reachable.`);
    await sleep(DAEMON_POLL_MS);
  }
  return null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopCreatedSession(ctx: RemoteContext, sessionId: string): AbandonCreatedSessionResult {
  let stopOutput: string;
  try {
    stopOutput = getExecutor().runFile(ctx.easBin, stopSessionArgs(sessionId), easBoundedExecOptions(ctx.root));
  } catch (err) {
    return {
      failed: true,
      code: 'STIM_REMOTE_SESSION_CLEANUP',
      reason: `Stim could not stop session ${sessionId} (${describe(err)}). The session bills until its cap.`,
      remedy: `Run \`eas simulator:stop --id ${sessionId}\`.`,
      sessionId,
    };
  }
  const verified = verifyStoppedSession(stopOutput, sessionId);
  if (!verified.ok) {
    return {
      failed: true,
      code: 'STIM_REMOTE_SESSION_CLEANUP',
      reason: `Stim could not verify that session ${sessionId} stopped (${verified.reason}). The session bills until its cap.`,
      remedy: `Run \`eas simulator:stop --id ${sessionId}\`.`,
      sessionId,
    };
  }
  return { ok: true, sessionId };
}

function abandonSession(ctx: RemoteContext, sessionId: string, reason: string): BootResult {
  const stopped = stopCreatedSession(ctx, sessionId);
  if (stopped.ok) return { failed: true, reason: `${reason} The session was stopped.` };
  return {
    failed: true,
    code: stopped.code,
    reason: `${reason} ${stopped.reason} ${stopped.remedy}`,
    remedy: stopped.remedy,
  };
}

export function withRemoteSessionLock<T>(
  root: string,
  fn: () => Promise<T>,
  options: WorkspaceProcessLockOptions = {},
): Promise<T> {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    canonicalRoot = resolvePath(root);
  }
  return withWorkspaceProcessLock(workspaceDir(canonicalRoot), 'remote-session', fn, {
    external: true,
    waitMs: 4 * 60_000,
    ...options,
  });
}

export async function ensureRemoteBootOwned<T extends BootResult>({
  root,
  platform,
  sessionName,
  startedAt,
  boot,
  createdSessionId,
  abandonCreatedSession,
  writeState,
  register = () => {},
  withProjectLock = withEasProjectLock,
  withLock = withRemoteSessionLock,
  removeEasSessionClaim: removeClaim = removeEasSessionClaim,
  ledgerRoot = easMachineStateRoot(),
}: {
  root: string;
  platform: 'ios' | 'android';
  sessionName: string;
  startedAt: string;
  boot: () => Promise<T>;
  createdSessionId: () => string | null;
  abandonCreatedSession: () => AbandonCreatedSessionResult;
  writeState: (root: string, patch: Record<string, unknown>) => unknown;
  register?: () => unknown;
  withProjectLock?: typeof withEasProjectLock;
  withLock?: typeof withRemoteSessionLock;
  removeEasSessionClaim?: typeof removeEasSessionClaim;
  ledgerRoot?: string;
}): Promise<T | BootResult> {
  try {
    return await withProjectLock(
      root,
      () =>
        withLock(root, async () => {
          register();
          const booted = await boot();
          if (booted.failed) return booted;
          const sessionId = createdSessionId();
          if (!sessionId) return booted;
          try {
            recordEasSessionClaim(
              {
                sessionId,
                name: sessionName,
                platform,
                workspaceRoot: root,
                workspaceHome: getConfigDir(),
                stateFile: workspaceStateFile(root),
              },
              ledgerRoot,
            );
            writeState(root, { remoteDevice: { platform, sessionId, startedAt } });
            return booted;
          } catch (err) {
            const cleanup = abandonCreatedSession();
            if (cleanup.ok) {
              let removalFailure = 'the claim store did not remove it';
              try {
                if (removeClaim(sessionId, ledgerRoot)) {
                  return {
                    failed: true,
                    code: 'STIM_REMOTE_SESSION_STATE',
                    reason: `Could not record EAS session ${sessionId}: ${describe(err)}. The session was stopped.`,
                    remedy: 'Fix workspace state storage, then retry the remote command.',
                  };
                }
              } catch (error) {
                removalFailure = describe(error);
              }
              return {
                failed: true,
                code: 'STIM_REMOTE_SESSION_CLEANUP',
                reason: `Could not record EAS session ${sessionId}: ${describe(err)}. The session was stopped, but its ownership claim could not be removed: ${removalFailure}.`,
                remedy: `The stopped session claim remains under ${ledgerRoot}. Repair that ownership ledger before retrying the remote command.`,
              };
            }
            return {
              failed: true,
              code: cleanup.code ?? 'STIM_REMOTE_SESSION_CLEANUP',
              reason: `Could not record EAS session ${sessionId}: ${describe(err)}. ${cleanup.reason ?? ''}`.trim(),
              remedy: cleanup.remedy ?? `Run \`eas simulator:stop --id ${sessionId}\`.`,
            };
          }
        }),
      { ownerPurpose: 'EAS remote start', machineRoot: ledgerRoot },
    );
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? REMOTE_SESSION_ERROR;
    return {
      failed: true,
      code,
      reason: describe(err),
      remedy: 'Retry the remote command after the other workspace operation finishes.',
    };
  }
}

function daemonHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function notConnected(code: string): OpFailure {
  return {
    failed: true,
    code,
    reason: 'No remote session is connected; the device step did not complete.',
  };
}

// EAS retains remoteConfig after STOPPED, so reuse also requires a live status.
const LIVE_STATUSES = new Set(['NEW', 'IN_PROGRESS']);

function readLiveDaemon(ctx: RemoteContext, sessionId: string): RemoteDaemon | null {
  let stdout: string;
  try {
    stdout = getExecutor().runFile(ctx.easBin, getSessionArgs(sessionId), easBoundedExecOptions(ctx.root));
  } catch {
    return null;
  }
  try {
    const inspection = inspectSessionForTeardown(stdout, sessionId);
    if (inspection.action !== 'stop' || !LIVE_STATUSES.has(inspection.status)) return null;
    const data = JSON.parse(stdout) as { remoteConfig?: unknown };
    return remoteDaemonFrom(data.remoteConfig);
  } catch {
    return null;
  }
}

function readDaemon(ctx: RemoteContext, sessionId: string): RemoteDaemon | null {
  let stdout: string;
  try {
    stdout = getExecutor().runFile(ctx.easBin, getSessionArgs(sessionId), easBoundedExecOptions(ctx.root));
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(stdout) as { remoteConfig?: unknown };
    return remoteDaemonFrom(data.remoteConfig);
  } catch {
    return null;
  }
}

export function remoteIosDeps(ctx: RemoteContext): {
  ctx: RemoteContext;
  checkDeviceCapacity: () => null;
  ensureOwnedDevice: () => Promise<RemoteDeviceRecord>;
  ensureBooted: (opts?: { out?: (msg: string) => void }) => Promise<BootResult>;
  installIosApp: (a: { udid: string; appPath: string }) => InstallResult;
  launchIosApp: (a: {
    udid: string;
    bundleId: string;
    metroPort: number | string | null;
    devClientScheme?: string | null;
  }) => LaunchResult;
  createdSessionId: () => string | null;
  abandonCreatedSession: () => AbandonCreatedSessionResult;
  webPreviewUrl: () => string | null;
} {
  const shared: RemoteContext = { ...ctx, platform: 'ios' };
  const core = remoteDeviceDeps(shared);
  return {
    ctx: shared,
    checkDeviceCapacity: core.checkCapacity,
    ensureOwnedDevice: core.ensureDevice,
    ensureBooted: core.ensureBooted,
    installIosApp: ({ appPath }) => core.installArtifact(appPath),
    launchIosApp: ({ bundleId, metroPort, devClientScheme }) =>
      core.launchApp({ appId: bundleId, metroPort, devClientScheme }),
    createdSessionId: core.createdSessionId,
    abandonCreatedSession: core.abandonCreatedSession,
    webPreviewUrl: core.webPreviewUrl,
  };
}

// adb reverse and 10.0.2.2 resolve on the remote host, so Android uses the public Metro origin.
export function remoteAndroidDeps(ctx: RemoteContext): {
  ctx: RemoteContext;
  checkCapacity: () => null;
  ensureDevice: () => Promise<RemoteDeviceRecord>;
  ensureDeviceBooted: (opts?: { out?: (msg: string) => void }) => Promise<{
    ok?: boolean;
    serial?: string;
    failed?: boolean;
    reason?: string;
    code?: string;
    remedy?: string;
  }>;
  install: (a: { serial: string; apkPath: string }) => InstallResult;
  launch: (a: {
    serial: string;
    packageName: string;
    metroPort: number | string | null;
    devClientScheme?: string | null;
  }) => LaunchResult;
  createdSessionId: () => string | null;
  abandonCreatedSession: () => AbandonCreatedSessionResult;
  webPreviewUrl: () => string | null;
} {
  const shared: RemoteContext = { ...ctx, platform: 'android' };
  const core = remoteDeviceDeps(shared);
  return {
    ctx: shared,
    checkCapacity: core.checkCapacity,
    ensureDevice: core.ensureDevice,
    ensureDeviceBooted: async (opts) => {
      const booted = await core.ensureBooted(opts);
      return booted.ok ? { ok: true, serial: booted.udid } : booted;
    },
    install: ({ apkPath }) => core.installArtifact(apkPath),
    launch: ({ packageName, metroPort, devClientScheme }) =>
      core.launchApp({ appId: packageName, metroPort, devClientScheme }),
    createdSessionId: core.createdSessionId,
    abandonCreatedSession: core.abandonCreatedSession,
    webPreviewUrl: core.webPreviewUrl,
  };
}

export function endRecordedSession({
  root,
  sessionId,
  easBin,
  lookupAgentDevice,
  ledgerRoot,
}: {
  root: string;
  sessionId: string;
  easBin: string | null;
  lookupAgentDevice?: () => string | null;
  ledgerRoot?: string;
}): { status: 'torn-down' | 'failed'; reason?: string } {
  const agentDeviceBin = (lookupAgentDevice ?? defaultLookupAgentDevice)();
  if (!easBin) {
    return {
      status: 'failed',
      reason: `No eas-cli to stop session ${sessionId} with; it keeps billing until its max duration. Run \`eas simulator:stop --id ${sessionId}\`.`,
    };
  }
  return teardownRemote(
    {
      root,
      label: '',
      backend: 'eas',
      easBin,
      agentDeviceBin: agentDeviceBin ?? '',
      existingDaemon: null,
      easLedgerRoot: ledgerRoot,
    },
    { sessionId },
  );
}

export function teardownRemote(
  ctx: RemoteContext,
  { sessionId }: { sessionId: string | null },
): { status: 'torn-down' | 'failed'; reason?: string } {
  const profilePath = remoteProfilePath(ctx.root);
  try {
    getExecutor().runFile(ctx.agentDeviceBin, disconnectArgs(profilePath), { cwd: ctx.root });
  } catch {
    // Nothing to report: a dead or already-released connection is the
    // ordinary case here, and the session stop below is what matters.
  }
  if (!sessionId) return { status: 'torn-down' };
  const ledger = readEasSessionLedger(ctx.easLedgerRoot);
  const claimNeedsRemoval = !ledger.safe || ledger.claims.has(sessionId);
  const removeClaim = (): string | undefined => {
    try {
      const removed = (ctx.removeEasSessionClaim ?? removeEasSessionClaim)(sessionId, ctx.easLedgerRoot);
      if (removed || !claimNeedsRemoval) return undefined;
      return `EAS session ${sessionId} is stopped, but its ownership claim could not be removed. The claim and workspace record were kept for reconciliation. Re-run stop.`;
    } catch (error) {
      return `EAS session ${sessionId} is stopped, but its ownership claim could not be removed: ${describe(error)}. The claim and workspace record were kept for reconciliation. Re-run stop.`;
    }
  };
  let sessionOutput: string;
  try {
    sessionOutput = getExecutor().runFile(ctx.easBin, getSessionArgs(sessionId), easBoundedExecOptions(ctx.root));
  } catch (err) {
    if (isDefinitiveMissingSessionError(err, sessionId)) {
      return { status: 'torn-down', reason: removeClaim() };
    }
    return {
      status: 'failed',
      reason: `Could not verify EAS session ${sessionId}: ${describe(err)}. The session record was kept for retry.`,
    };
  }
  const inspection = inspectSessionForTeardown(sessionOutput, sessionId);
  if (inspection.action === 'refused') {
    return { status: 'failed', reason: `${inspection.reason} The session record was kept for retry.` };
  }
  if (inspection.action === 'already-stopped') {
    return { status: 'torn-down', reason: removeClaim() };
  }

  let stopOutput: string;
  try {
    stopOutput = getExecutor().runFile(ctx.easBin, stopSessionArgs(sessionId), easBoundedExecOptions(ctx.root));
  } catch (err) {
    return {
      status: 'failed',
      reason: `eas simulator:stop ${sessionId} failed: ${describe(err)}. The session record was kept for retry.`,
    };
  }
  const verified = verifyStoppedSession(stopOutput, sessionId);
  if (!verified.ok) return { status: 'failed', reason: `${verified.reason} The session record was kept for retry.` };
  return { status: 'torn-down', reason: removeClaim() };
}

export async function ensureMetroReachable({
  ctx,
  metroPort,
  isExpo,
  tunnelMode = 'auto',
  publicUrl = null,
  available = [],
  env = process.env,
  readTunnelRecord = readMetroTunnel,
  isTunnelAlive = isPidAlive,
  gateOrigin = gateMetroOrigin,
}: {
  ctx: RemoteContext;
  metroPort: number | string;
  isExpo: boolean;
  tunnelMode?: TunnelMode;
  publicUrl?: string | null;
  available?: readonly ManagedProvider[];
  env?: NodeJS.ProcessEnv;
  readTunnelRecord?: typeof readMetroTunnel;
  isTunnelAlive?: typeof isPidAlive;
  gateOrigin?: typeof gateMetroOrigin;
}): Promise<{ ok: true } | { failed: string; remedy: string; code?: string }> {
  const { root } = ctx;
  const platform = ctx.platform ?? 'ios';
  const publicMetroUrl = env[PUBLIC_METRO_ENV]?.trim() || publicUrl || null;
  const recorded = readTunnelRecord(root);
  const effectiveAvailable =
    recorded?.kind === 'managed' && isTunnelAlive(recorded.pid)
      ? ([recorded.provider, ...available.filter((provider) => provider !== recorded.provider)] as ManagedProvider[])
      : available;
  const plan = planMetroReach({
    mode: tunnelMode,
    metroPort,
    publicUrl: publicMetroUrl,
    isExpo,
    available: effectiveAvailable,
  });
  if ('failed' in plan) return plan;

  let resolvedUrl: string | null = null;
  let gate = false;
  if ('origin' in plan) {
    resolvedUrl = plan.origin;
    gate = plan.gate;
  } else if ('expoTunnel' in plan) {
    if (!recorded || recorded.kind !== 'expo') {
      return {
        failed:
          "This workspace's Metro tunnels itself (metro.tunnel is expo, or auto on an Expo project), but no Expo tunnel URL is recorded.",
        remedy: 'Run `stim start --remote` so Expo can establish its own tunnel before a remote device connects.',
      };
    }
    resolvedUrl = recorded.url;
    gate = true;
  } else {
    const port = Number(metroPort);
    const providerMatches = tunnelMode === 'auto' || (recorded?.kind === 'managed' && recorded.provider === plan.start);
    if (
      recorded &&
      recorded.kind === 'managed' &&
      recorded.port === port &&
      providerMatches &&
      isTunnelAlive(recorded.pid)
    ) {
      resolvedUrl = recorded.url;
    } else {
      return {
        failed: `No live managed Metro tunnel is recorded for port ${port}.`,
        remedy: 'Run `stim start --remote`, then retry the device command.',
      };
    }
    gate = true;
  }

  if (gate && resolvedUrl) {
    const logsDir = workspaceLogsDir(root);
    const result = await gateOrigin({
      origin: resolvedUrl,
      metroPort,
      platform,
      entryPoint: bundleEntryPoint(root, isExpo),
      readRecords: () => readMetroRecords(logsDir),
      isProof: isBundleProof,
    });
    if (result.failed) {
      return { failed: result.reason ?? 'Metro gate failed.', remedy: result.remedy ?? '', code: REMOTE_METRO_WRONG };
    }
  }
  ctx.publicMetroUrl = resolvedUrl;
  return { ok: true };
}

export function bundleEntryPoint(root: string, isExpo: boolean): string {
  if (!isExpo) return 'index';
  try {
    const pkg = JSON.parse(readFileSync(resolvePath(root, 'package.json'), 'utf-8')) as { main?: unknown };
    if (typeof pkg.main !== 'string' || !pkg.main.trim()) return 'index';
    const main = pkg.main.trim();
    const local = main.startsWith('.') || /\.[cm]?[jt]sx?$/.test(main) || existsSync(resolvePath(root, main));
    const normalized = main.replace(/^\.\//, '').replace(/\.(?:[cm]?[jt]sx?)$/, '');
    return local ? normalized : `node_modules/${normalized}`;
  } catch {
    return 'index';
  }
}
