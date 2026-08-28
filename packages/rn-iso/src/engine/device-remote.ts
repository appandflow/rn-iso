// src/engine/device-remote.ts -- the remote half of the device, shaped to
// drop into the dep seam commands/ios.ts already has.
//
// THE SEAM IS NOT NEW. `DEFAULT_DEPS` in commands/ios.ts is documented as
// "the test seam. Every engine call goes through it", and four of its entries
// are the entire device surface: ensureOwnedDevice, ensureBooted,
// installIosApp, launchIosApp. Remote mode replaces those four and nothing
// else. Inventing a parallel DeviceBackend abstraction beside a seam that
// already exists would be a second way to say the same thing.
//
// The consequence worth stating: every call site, every phase line and every
// existing test is untouched. The local path is not refactored at all, so a
// regression there cannot be caused by this file.
//
// WHERE THE EXPENSIVE WORK SITS. Locally, ensureOwnedDevice is cheap (a
// simctl create) and ensureBooted is the ~10s one, which is why the Metro
// gate sits between them: a dead port must cost a second, not a boot. Remote
// inverts the cost -- creating a cloud session is the slow, billable step --
// so `ensureOwnedDevice` here does NOTHING but record intent, and the session
// is created in `ensureBooted`, AFTER the gate. Same ordering property, same
// reason, opposite mechanics.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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
import { INSTALL_ERROR, isBundleProof, LAUNCH_ERROR, readMetroRecords } from './app-install.ts';
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
import { easMachineStateRoot, recordEasSessionClaim, removeEasSessionClaim } from './eas-session-ledger.ts';
import { getConfigDir } from '../config.ts';

export const REMOTE_SESSION_ERROR = 'RN_ISO_NO_REMOTE_SESSION';
const REMOTE_METRO_ERROR = 'RN_ISO_REMOTE_METRO_UNREACHABLE';

// Where the app should look for Metro, when the device is not on this machine.
// Set it to a URL that reaches THIS workspace's dev server from the device's
// network -- a cloudflared/ngrok tunnel in front of the reserved port.
export { PUBLIC_METRO_ENV } from './metro-reach.ts';

/**
 * PURE. The origin the launched app should fetch its bundle from, or a
 * refusal.
 *
 * THIS IS THE HARD PART OF A REMOTE DEVICE, and it is not solved by
 * agent-device for a self-hosted proxy. Established against agent-device
 * 0.20.10: `agent-device proxy` serves /health, /rpc, /upload and /artifacts
 * and NOTHING under /api/metro, so `/api/metro/bridge` is a 404 and the
 * companion-tunnel path is a cloud-only feature. A device on another machine
 * therefore has no route to this laptop's Metro that agent-device will build.
 *
 * So the honest rule:
 *   loopback daemon -> the simulator shares this host's loopback, and
 *                      `localhost:<reserved port>` is correct and verified.
 *   anything else   -> rn-iso cannot invent a reachable address. It refuses,
 *                      unless the operator names one via RN_ISO_METRO_PUBLIC_URL.
 *
 * Refusing beats guessing. `localhost` sent to a remote device resolves on
 * THAT machine, so the app would silently load nothing (or, worse, another
 * project's bundler) and the run would look like a launch that merely failed
 * to verify.
 */
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
  // expoTunnel / start are decisions the COMMAND layer acts on before a launch
  // ever happens; by the time an origin is needed one of them has produced a
  // publicUrl. Reaching here means that step was skipped.
  return {
    failed: 'Metro has no address the device can reach yet.',
    remedy: 'This is an rn-iso bug: the tunnel step did not run before the launch.',
  };
}

// NO DEFAULT DURATION, deliberately.
//
// The cap is per-account and rn-iso cannot know it. A hardcoded 120 was
// rejected live with "Device run session max duration must not exceed 115
// minutes for this account; received 120 minutes", which failed the whole
// command before a session existed. EAS derives its own default from the job
// run priority, so omitting the flag is both correct and account-portable.
//
// What actually bounds the cost is teardown -- `stop`, `worktree remove` and
// `gc` all end the session -- not a number invented here. A caller who wants
// a tighter bound passes one, and the flag is only sent when they do.

// The device record the rest of ios.ts reads. Only `deviceName` is consumed
// (by deviceLabel), so it says what this device IS rather than pretending to
// be a simulator model.
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

// The exact shapes the local counterparts in engine/app-install.ts return.
// Named because isolatedDeclarations requires it, and useful anyway: this IS
// the contract the dep seam swaps on.
// FLAT and all-optional, matching engine/device.ts's BootResult and the
// app-install results these stand in for. A discriminated union would be
// tidier in isolation, but every caller and every test in this codebase reads
// these shapes field-by-field, and the seam's whole point is that the remote
// half is indistinguishable from the local one.
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

/** What a remote run needs to know, resolved once by the command layer. */
export interface RemoteContext {
  root: string;
  label: string;
  backend: RemoteDeviceBackend;
  easBin: string;
  agentDeviceBin: string;
  // Which device this run wants. Reaches `eas sim --platform` and the
  // connection profile; nothing else in a remote run differs by platform.
  platform?: 'ios' | 'android';
  maxDurationMinutes?: number | null;
  // A URL that reaches THIS workspace's Metro from the device's network.
  // Only consulted when the daemon is not on this machine.
  publicMetroUrl?: string | null;
  // Carried so the launch resolves the origin the same way resolveRemoteContext
  // already did, rather than second-guessing it.
  tunnelMode?: TunnelMode;
  isExpo?: boolean;
  // The readiness poll's wait, injectable so a test does not sleep for real.
  sleep?: (ms: number) => Promise<void>;
  // Set when the operator already has a daemon (an `agent-device proxy`, or
  // an exported EAS session). rn-iso then creates NO session and destroys
  // none: it is a guest on someone else's device.
  existingDaemon?: RemoteDaemon | null;
  easLedgerRoot?: string;
}

// The live session for one `rn-iso ios` run. Held in a closure rather than in
// state.json because the token must not reach disk; the session ID does get
// recorded by the command layer so `stop` and `gc` can find it later.
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

/**
 * The four dep overrides remote mode installs over DEFAULT_DEPS, plus the
 * session accessor the command layer needs to record the id.
 *
 * Each returned function matches its local counterpart's signature exactly.
 * That is the whole design: ios.ts calls `d.installIosApp({udid, appPath})`
 * whether the device is a simulator on this Mac or one in a datacenter.
 */
/**
 * The device operations remote mode performs, in platform-NEUTRAL names.
 *
 * The two platform adapters below are thin because on a remote device the
 * launch is genuinely the same operation: locally iOS points the app at
 * `localhost` and Android at `10.0.2.2` (its own host's loopback), and BOTH
 * are replaced by the one public origin the tunnel serves. What is left
 * differing is only what the two command files call their fields --
 * udid/serial, bundleId/packageName, appPath/apkPath.
 */
function exec() {
  return getExecutor();
}

function remoteDeviceDeps(ctx: RemoteContext) {
  let session: RemoteSession | null = null;
  let createdSession: string | null = null;

  const easEnv = easExecOptions(ctx.root);

  return {
    // Remote has no local device to count. maxDevices caps booted simulators
    // on THIS machine, and escaping that ceiling is the entire reason to run
    // remote, so enforcing it here would refuse the thing it was asked for.
    checkCapacity: () => null,

    // Records intent only. The session is created in ensureBooted so the
    // Metro gate still runs before the expensive, billable step.
    //
    // The name says which KIND of remote device this is, because the two
    // behave differently in ways an operator needs to see in one line: an EAS
    // session is rn-iso's to create and destroy, a daemon from the
    // environment is somebody else's and is never stopped here.
    ensureDevice: async (): Promise<RemoteDeviceRecord> => ({
      deviceName: ctx.backend === 'proxy' ? 'remote device (your daemon)' : 'EAS Simulator',
      owned: true,
      remote: true,
    }),

    // Creates the session (unless the operator brought one), writes the
    // connection profile, and connects. `connect` is also what prepares
    // Metro: it registers rn-iso's local dev server with the daemon through
    // agent-device's companion tunnel, which is how a cloud simulator reaches
    // a bundler on this laptop.
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

      // A live owned session with a daemon is reused. Any other recorded
      // session is verified before replacement.
      //
      // `eas sim` defaults to --force, so every run would otherwise mint a
      // fresh session while the previous one stayed live, unrecorded (the id
      // in state.json is overwritten) and billing to its cap. The documented
      // loop re-runs `ios` after every native change, so that fired
      // constantly. Reuse also removes a 60-90s session creation from the
      // common case, which is the difference between `ios --remote` being
      // idempotent and being expensive.
      if (!daemon) {
        const recorded = readRemoteSession(ctx.root);
        if (recorded && recorded.platform !== (ctx.platform ?? 'ios')) {
          return {
            failed: true,
            code: 'RN_ISO_REMOTE_PLATFORM_MISMATCH',
            reason: `Session ${recorded.sessionId} belongs to ${recorded.platform ?? 'an unknown platform'}, not ${ctx.platform ?? 'ios'}.`,
            remedy: 'Run `rn-iso stop` for this workspace before selecting a different remote platform.',
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
            if (cleanup.status === 'failed') {
              return {
                failed: true,
                code: 'RN_ISO_REMOTE_SESSION_CLEANUP',
                reason: cleanup.reason ?? `Could not verify recorded EAS session ${recorded.sessionId}.`,
                remedy: 'Inspect the recorded session, then run `rn-iso stop` again.',
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
          stdout = exec().runFile(
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
        // The session EXISTS from this line on, and it bills. Every failure
        // below therefore has to end it rather than return and forget it:
        // nothing else can, because the id is not recorded until this
        // function succeeds. Observed live -- a session with no endpoint yet
        // left an IN_PROGRESS session nothing could find.
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
      // Best-effort, and its failure is expected on a first run: there is no
      // session to close. See closeArgs for why it has to happen anyway.
      try {
        exec().runFile(ctx.agentDeviceBin, closeArgs(profilePath), {
          cwd: ctx.root,
          env: daemonEnv(daemon),
        });
      } catch {
        /* nothing to close, or a lease already expired: connect proceeds */
      }
      try {
        exec().runFile(ctx.agentDeviceBin, connectArgs(profilePath), {
          cwd: ctx.root,
          env: daemonEnv(daemon),
        });
      } catch (err) {
        if (createdHere) return abandonSession(ctx, createdHere, `agent-device connect failed: ${describe(err)}`);
        return { failed: true, reason: `agent-device connect failed: ${describe(err)}` };
      }

      // Surfaced the moment the session is reachable, not at the end: it is
      // how a HUMAN watches a device they cannot see, and it is most useful
      // while the build is still running. On its own line so terminals
      // linkify it.
      session = { id, daemon, profilePath };
      createdSession = createdHere;
      if (daemon.webPreviewUrl) note(`Watch this device: ${daemon.webPreviewUrl}`);
      // `udid` is the field ios.ts reads and prints, and shortUdid truncates
      // it for the phase line. A session id shortens to something meaningful;
      // a base URL shortens to "http..", which is noise. So a daemon with no
      // session of its own reports its host instead.
      return { ok: true, udid: id ?? daemonHostLabel(daemon.baseUrl) };
    },

    installArtifact: (artifactPath: string): InstallResult => {
      if (!session) return notConnected(INSTALL_ERROR);
      try {
        exec().runFile(ctx.agentDeviceBin, installArgs(session.profilePath, artifactPath), {
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
      // A null port is a RELEASE-shaped launch: the JS is embedded, Metro is
      // not part of the run, and there is nothing to point the app at. The
      // reachability question below only exists for a dev build, so skip it
      // rather than refusing a launch that needs no dev server.
      if (metroPort === null) {
        try {
          exec().runFile(ctx.agentDeviceBin, openArgs(session.profilePath, appId, null, null), {
            cwd: ctx.root,
            env: daemonEnv(session.daemon),
          });
          return { ok: true, mode: 'launch' };
        } catch (err) {
          return { failed: true, code: LAUNCH_ERROR, reason: `agent-device open ${appId} failed: ${describe(err)}` };
        }
      }
      // WHERE the app looks for Metro is decided first, and a device that
      // cannot reach this workspace's dev server is a refusal rather than a
      // launch that will never load a bundle.
      const origin = resolveMetroOrigin({
        metroPort,
        publicUrl: ctx.publicMetroUrl ?? null,
        mode: ctx.tunnelMode ?? 'auto',
        isExpo: ctx.isExpo ?? false,
      });
      if ('failed' in origin) {
        return { failed: true, code: REMOTE_METRO_ERROR, reason: `${origin.failed} ${origin.remedy}` };
      }

      // The dev-client link is composed HERE rather than left to
      // agent-device's own Metro hint. That hint writes bare-RN's
      // RCT_jsLocation, which an expo-dev-client ignores
      // (callstack/agent-device#1245). `open <app> <url>` runs simctl openurl
      // with the url verbatim, so rn-iso's own link works today.
      const url = devClientScheme
        ? `${devClientScheme}://expo-development-client/?url=${encodeURIComponent(origin.origin)}`
        : null;
      try {
        exec().runFile(ctx.agentDeviceBin, openArgs(session.profilePath, appId, url, metroHintFrom(origin.origin)), {
          cwd: ctx.root,
          env: daemonEnv(session.daemon),
        });
        // Reports the origin the app was actually pointed at, not a
        // jsLocation this path never wrote.
        // The alert only exists because the line above opened a URL, and it
        // holds the deep link until it is answered -- which is why a remote
        // dev-client launch used to report UNVERIFIED every time. Best-effort:
        // a bare-RN launch opens no URL and raises no alert, and this is then
        // a no-op that must not fail the run.
        if (url) {
          try {
            exec().runFile(ctx.agentDeviceBin, acceptAlertArgs(session.profilePath), {
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

    // Not a dep override. The command layer records a session created by this
    // boot attempt. A reused session already has its durable ownership record.
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

    // Not a dep override either. The browser preview for this device, so the
    // --json payload can carry it and a caller can hand it to a person.
    webPreviewUrl: (): string | null => session?.daemon.webPreviewUrl ?? null,
  };
}

/**
 * Where a remote run gets its tools and, optionally, its daemon.
 *
 *   { ctx }                ready to run
 *   { failed: reason, remedy }  a refusal the command prints as-is
 *
 * The selected backend decides whether credentials connect to an existing
 * proxy or EAS creates a session.
 */
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
  // How this workspace expects the device to reach Metro, and what it has to
  // work with. See engine/metro-reach.ts.
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
      remedy: `Install it (\`npm i -g agent-device\`), then run \`rn-iso ${platform} --remote ${backend}\` again.`,
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
        code: 'RN_ISO_REMOTE_PROXY_CONFIG',
      };
    }
    if (!baseUrl) {
      return {
        failed: 'The proxy backend requires AGENT_DEVICE_DAEMON_BASE_URL.',
        remedy: 'Export AGENT_DEVICE_DAEMON_BASE_URL, then run the device command with `--remote proxy` again.',
        code: 'RN_ISO_REMOTE_PROXY_CONFIG',
      };
    }
    if (!token) {
      return {
        failed: 'The proxy backend requires AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
        remedy: 'Export AGENT_DEVICE_DAEMON_AUTH_TOKEN, then run the device command with `--remote proxy` again.',
        code: 'RN_ISO_REMOTE_PROXY_CONFIG',
      };
    }
    existingDaemon = { baseUrl, token };
  } else if (!easBin) {
    return {
      failed: 'The eas backend requires eas-cli.',
      remedy: 'Install eas-cli, then run the device command with `--remote eas` again.',
      code: 'RN_ISO_REMOTE_EAS_UNAVAILABLE',
    };
  }

  // Metro reachability is decided HERE, before anything is created or built.
  //
  // It used to be checked at launch, which is the worst possible place: a run
  // with no reachable Metro would create a billable session, compile for
  // minutes, install, and only then refuse. Everything needed to answer the
  // question is already known at this point -- an EAS session is cloud-hosted
  // and therefore never loopback, and an operator daemon carries its URL.
  //
  // NOTHING IS INFERRED. This used to accept a loopback daemon URL as proof
  // that the device shares this machine, which `ssh -L 4310:localhost:4310
  // macmini` makes false -- and the app was then pointed at a localhost that
  // resolved on the Mac mini. `metro.tunnel: "off"` is how that case is
  // DECLARED instead; see engine/metro-reach.ts.
  return {
    ctx: {
      root,
      label,
      backend,
      platform,
      easBin: easBin ?? '',
      agentDeviceBin,
      maxDurationMinutes,
      // Filled in later by ensureMetroReachable, once the reserved port is
      // known and the local Metro gate has confirmed a dev server is there.
      publicMetroUrl: null,
      existingDaemon,
    },
  };
}

// PURE-ish. Is this binary on PATH? Used to decide which tunnel providers
// rn-iso could start. Fails CLOSED to "absent": a probe that itself fails
// must not make rn-iso try to spawn something that is not there.
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

// How long to wait for a freshly created session to publish its endpoint,
// and how often to ask. A cloud VM boot is tens of seconds; `eas sim` polls
// internally too but has been seen returning before the endpoint exists.
const DAEMON_WAIT_MS = 180_000;
const DAEMON_POLL_MS = 5_000;

/**
 * Poll `simulator:get` until the session publishes an agent-device endpoint.
 *
 * Bounded, because the alternative is a command that hangs on a session that
 * will never be ready -- while billing.
 */
async function waitForDaemon(
  ctx: RemoteContext,
  sessionId: string,
  out: (msg: string) => void,
  { sleep = defaultSleep }: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<RemoteDaemon | null> {
  // Bounded by ATTEMPTS, not by a wall-clock deadline. A deadline read from
  // the real clock spins without limit the moment `sleep` does not actually
  // sleep, which is exactly what a test injects -- it burned a worker to an
  // out-of-memory before this was counted instead.
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

/**
 * End a session rn-iso created but cannot use, and fold the outcome into the
 * refusal.
 *
 * A session that fails between create and record is invisible to `stop`,
 * `gc` and `worktree remove`, so this is the ONLY place it can be ended. If
 * the stop also fails, the id goes in the message: a human can still run
 * `eas simulator:stop --id <id>`, and a leak nobody is told about is the
 * worst outcome here.
 */
function stopCreatedSession(ctx: RemoteContext, sessionId: string): AbandonCreatedSessionResult {
  let stopOutput: string;
  try {
    stopOutput = getExecutor().runFile(ctx.easBin, stopSessionArgs(sessionId), easBoundedExecOptions(ctx.root));
  } catch (err) {
    return {
      failed: true,
      code: 'RN_ISO_REMOTE_SESSION_CLEANUP',
      reason: `rn-iso could not stop session ${sessionId} (${describe(err)}). The session bills until its cap.`,
      remedy: `Run \`eas simulator:stop --id ${sessionId}\`.`,
      sessionId,
    };
  }
  const verified = verifyStoppedSession(stopOutput, sessionId);
  if (!verified.ok) {
    return {
      failed: true,
      code: 'RN_ISO_REMOTE_SESSION_CLEANUP',
      reason: `rn-iso could not verify that session ${sessionId} stopped (${verified.reason}). The session bills until its cap.`,
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
              removeEasSessionClaim(sessionId, ledgerRoot);
              return {
                failed: true,
                code: 'RN_ISO_REMOTE_SESSION_STATE',
                reason: `Could not record EAS session ${sessionId}: ${describe(err)}. The session was stopped.`,
                remedy: 'Fix workspace state storage, then retry the remote command.',
              };
            }
            return {
              failed: true,
              code: cleanup.code ?? 'RN_ISO_REMOTE_SESSION_CLEANUP',
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

// PURE. The host:port of a daemon, for a phase line that has room for one
// short token. Falls back to the whole URL when it will not parse.
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

// Re-reads the session so the token is fetched, never stored. Returns null on
// any failure: the caller turns that into a refusal with the session id in it,
// which is more useful than a parse error from here.
// The statuses eas-cli reports for a session that still exists and can still
// be driven. Anything else (STOPPED, ERRORED) is a session to replace.
const LIVE_STATUSES = new Set(['NEW', 'IN_PROGRESS']);

// Like readDaemon, but ALSO requires the session to still be live.
//
// Reuse needs both facts and readDaemon only proves one: a STOPPED session
// can still report a remoteConfig, so reusing on config alone would connect
// to a daemon that is gone and fail at install instead of creating a session.
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

/**
 * The dep overrides `ios --remote` installs over DEFAULT_DEPS.
 *
 * Names match commands/ios.ts's seam exactly, so every call site, phase line
 * and existing test is untouched.
 */
export function remoteIosDeps(ctx: RemoteContext): {
  // Handed back so the command layer can pass it to ensureMetroReachable,
  // which fills in the origin once the reserved port is known.
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

/**
 * The same, for `android --remote`, against commands/android.ts's own names.
 *
 * `adb reverse` and `10.0.2.2` do NOT appear here, and their absence is the
 * whole point. Both are host-relative -- a reverse maps a device port to the
 * host running adb, and 10.0.2.2 is the emulator's route to ITS OWN host --
 * so on a remote emulator both name the wrong machine. The public origin
 * replaces them, exactly as it replaces `localhost` on iOS, which is why this
 * adapter is thin rather than a second implementation.
 *
 * The Metro hint still lands: agent-device writes `debug_http_host` (and
 * `dev_server_https`, which a tunnel on 443 needs) into the app's shared
 * prefs from `--metro-host`/`--metro-port`, running adb against ITS OWN
 * emulator where a reverse would be meaningless from here.
 */
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
    // Same identity, different field name: android.ts reads `serial` where
    // ios.ts reads `udid`.
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

/**
 * End the session recorded in state.json. The entry point `stop`, `gc` and
 * `worktree remove` use, so none of them has to know how to resolve a tool
 * or compose an argv.
 *
 * Resolves its own binaries because a teardown runs long after the `ios` that
 * created the session, in a process that has none of its context.
 */
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

/**
 * End a remote session. The inverse of ensureBooted, and the reason
 * `stop` gains a delete it never had locally: a cloud session bills while it
 * lives, so leaving one up is the worse failure.
 *
 * Disconnect first, so the lease is released and the Metro companion this
 * workspace owns is stopped, then stop the session itself. A disconnect
 * failure must not prevent the stop: the session is what costs money.
 */
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
  let sessionOutput: string;
  try {
    sessionOutput = getExecutor().runFile(ctx.easBin, getSessionArgs(sessionId), easBoundedExecOptions(ctx.root));
  } catch (err) {
    if (isDefinitiveMissingSessionError(err, sessionId)) {
      removeEasSessionClaim(sessionId, ctx.easLedgerRoot);
      return { status: 'torn-down' };
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
    removeEasSessionClaim(sessionId, ctx.easLedgerRoot);
    return { status: 'torn-down' };
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
  removeEasSessionClaim(sessionId, ctx.easLedgerRoot);
  return { status: 'torn-down' };
}

/**
 * Give the device an address for Metro, and PROVE it reaches this workspace's.
 *
 * SEPARATE FROM resolveRemoteContext, and called later, because it needs two
 * things that are not known when the dep overrides are installed: the port
 * this workspace actually reserved, and confirmation from the local Metro
 * gate that a dev server is running there at all.
 *
 * Running it earlier looked equivalent and was not. It defaulted the port to
 * 8081 -- so a managed tunnel was built to whatever happened to be on 8081,
 * which on this machine is routinely a DIFFERENT workspace -- and it probed
 * before the local gate had established there was a dev server to reach, so a
 * simply-absent Metro was reported as "the tunnel is serving a different dev
 * server" instead of RN_ISO_NO_METRO.
 *
 * It still runs before ensureBooted, which is what creates the billable
 * session, so every refusal here costs nothing.
 *
 * Mutates `ctx.publicMetroUrl`: remoteIosDeps has already closed over this
 * object by the time this runs, and the launch reads the origin from it.
 */
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
  // The gate probes a platform-specific bundle path; ios is the shape both
  // dev servers answer when a context predates the android wiring.
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

  // Act on the plan: an asserted-local origin needs nothing further; the
  // other two branches produce an origin rn-iso has to arrange itself, and
  // both are non-local -- see the `gate` decision below.
  let resolvedUrl: string | null = null;
  let gate = false;
  if ('origin' in plan) {
    resolvedUrl = plan.origin;
    gate = plan.gate;
  } else if ('expoTunnel' in plan) {
    // `start` records the URL the moment Expo's own tunnel comes up (see
    // supervisor/server-expo.ts); a remote run can only use it, never start
    // one of its own -- `ios --remote` cannot add `--tunnel` to an
    // already-running dev server.
    if (!recorded || recorded.kind !== 'expo') {
      return {
        failed:
          "This workspace's Metro tunnels itself (metro.tunnel is expo, or auto on an Expo project), but no Expo tunnel URL is recorded.",
        remedy: 'Run `rn-iso start --remote` so Expo can establish its own tunnel before a remote device connects.',
      };
    }
    resolvedUrl = recorded.url;
    gate = true;
  } else {
    // { start: provider }. `start --remote` owns provider startup. The device
    // command only accepts its live record, so retries cannot create a second
    // process that has no teardown record.
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
        remedy: 'Run `rn-iso start --remote`, then retry the device command.',
      };
    }
    gate = true;
  }

  // The gate, before anything billable. `resolvedUrl` is a SECOND address for
  // the reserved port -- an operator's own, Expo's, or a managed one -- and
  // none of them are proven to still reach THIS workspace without it (see
  // engine/metro-gate.ts's header for the tunnel-outlived-the-reservation bug
  // this closes).
  if (gate && resolvedUrl) {
    const logsDir = workspaceLogsDir(root);
    const result = await gateOrigin({
      origin: resolvedUrl,
      metroPort,
      platform,
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
