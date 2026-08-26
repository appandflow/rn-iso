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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getExecutor } from '../exec.ts';
import {
  connectArgs,
  daemonEnv,
  disconnectArgs,
  installArgs,
  openArgs,
  remoteProfile,
  remoteProfilePath,
} from './agent-device.ts';
import { devClientUrl, jsLocationValue, INSTALL_ERROR, LAUNCH_ERROR } from './app-install.ts';
import {
  createSessionArgs,
  getSessionArgs,
  parseCreatedSession,
  remoteDaemonFrom,
  stopSessionArgs,
  type RemoteDaemon,
} from './eas-simulator.ts';

export const REMOTE_SESSION_ERROR = 'RN_ISO_NO_REMOTE_SESSION';

// A cloud session is billable and a build can be long. Ten minutes is too
// short for a cold pod install; a day is a forgotten session nobody notices.
// Two hours covers a full clean build plus a long agent loop, and `stop`,
// `gc` and `worktree remove` all end it sooner in the ordinary case.
export const DEFAULT_MAX_DURATION_MINUTES = 120;

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

function describe(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  return stderr || String(e?.message ?? err);
}

/** What a remote run needs to know, resolved once by the command layer. */
export interface RemoteContext {
  root: string;
  label: string;
  easBin: string;
  agentDeviceBin: string;
  maxDurationMinutes?: number | null;
  // Set when the operator already has a daemon (an `agent-device proxy`, or
  // an exported EAS session). rn-iso then creates NO session and destroys
  // none: it is a guest on someone else's device.
  existingDaemon?: RemoteDaemon | null;
}

// The live session for one `rn-iso ios` run. Held in a closure rather than in
// state.json because the token must not reach disk; the session ID does get
// recorded by the command layer so `stop` and `gc` can find it later.
interface RemoteSession {
  id: string | null;
  daemon: RemoteDaemon;
  profilePath: string;
}

function writeProfile(ctx: RemoteContext, daemon: RemoteDaemon): string {
  const path = remoteProfilePath(ctx.root);
  mkdirSync(dirname(path), { recursive: true });
  const profile = remoteProfile({
    daemon,
    platform: 'ios',
    label: ctx.label,
    projectRoot: ctx.root,
  });
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
export function remoteIosDeps(ctx: RemoteContext) {
  let session: RemoteSession | null = null;

  const exec = () => getExecutor();
  const easEnv = { cwd: ctx.root };

  return {
    // Remote has no local device to count. maxDevices caps booted simulators
    // on THIS machine, and escaping that ceiling is the entire reason to run
    // remote, so enforcing it here would refuse the thing it was asked for.
    checkDeviceCapacity: () => null,

    // Records intent only. The session is created in ensureBooted so the
    // Metro gate still runs before the expensive, billable step.
    ensureOwnedDevice: async (): Promise<RemoteDeviceRecord> => ({
      deviceName: 'EAS Simulator',
      owned: true,
      remote: true,
    }),

    // Creates the session (unless the operator brought one), writes the
    // connection profile, and connects. `connect` is also what prepares
    // Metro: it registers rn-iso's local dev server with the daemon through
    // agent-device's companion tunnel, which is how a cloud simulator reaches
    // a bundler on this laptop.
    ensureBooted: async ({ out = () => {} }: { out?: (msg: string) => void } = {}) => {
      let daemon = ctx.existingDaemon ?? null;
      let id: string | null = null;

      if (!daemon) {
        out('Creating an EAS Simulator session (this takes a moment).');
        let stdout: string;
        try {
          stdout = exec().runFile(
            ctx.easBin,
            createSessionArgs({
              label: ctx.label,
              platform: 'ios',
              maxDurationMinutes: ctx.maxDurationMinutes ?? DEFAULT_MAX_DURATION_MINUTES,
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
        // A session can exist before its daemon is routable, so the config is
        // re-read rather than assumed present on the create payload.
        daemon = created.daemon ?? readDaemon(ctx, created.id);
        if (!daemon) {
          return {
            failed: true,
            reason: `Session ${created.id} has no agent-device endpoint. It may be an appium or argent session, or it may still be starting.`,
          };
        }
      }

      const profilePath = writeProfile(ctx, daemon);
      try {
        exec().runFile(ctx.agentDeviceBin, connectArgs(profilePath), {
          cwd: ctx.root,
          env: daemonEnv(daemon),
        });
      } catch (err) {
        return { failed: true, reason: `agent-device connect failed: ${describe(err)}` };
      }

      session = { id, daemon, profilePath };
      // `udid` is the field ios.ts reads and prints. The session id is the
      // remote analog: the one handle that identifies this device.
      return { ok: true, udid: id ?? daemon.baseUrl };
    },

    installIosApp: ({ appPath }: { udid: string; appPath: string }) => {
      if (!session) return notConnected(INSTALL_ERROR);
      try {
        exec().runFile(ctx.agentDeviceBin, installArgs(session.profilePath, appPath), {
          cwd: ctx.root,
          env: daemonEnv(session.daemon),
        });
        return { ok: true, appPath };
      } catch (err) {
        return {
          failed: true,
          code: INSTALL_ERROR,
          reason: `agent-device install failed for ${appPath}: ${describe(err)}`,
        };
      }
    },

    launchIosApp: ({
      bundleId,
      metroPort,
      devClientScheme = null,
    }: {
      udid: string;
      bundleId: string;
      metroPort: number | string;
      devClientScheme?: string | null;
    }) => {
      if (!session) return notConnected(LAUNCH_ERROR);
      // The dev-client link is composed HERE rather than left to
      // agent-device's own Metro hint. That hint writes bare-RN's
      // RCT_jsLocation, which an expo-dev-client ignores
      // (callstack/agent-device#1245). `open <app> <url>` runs simctl openurl
      // with the url verbatim, so rn-iso's own link works today.
      const url = devClientScheme ? devClientUrl(devClientScheme, metroPort) : null;
      try {
        exec().runFile(ctx.agentDeviceBin, openArgs(session.profilePath, bundleId, url), {
          cwd: ctx.root,
          env: daemonEnv(session.daemon),
        });
        return {
          ok: true,
          mode: url ? 'openurl' : 'launch',
          url: url ?? undefined,
          jsLocation: jsLocationValue(metroPort),
        };
      } catch (err) {
        return {
          failed: true,
          code: LAUNCH_ERROR,
          reason: `agent-device open ${bundleId} failed: ${describe(err)}`,
        };
      }
    },

    // Not a dep override. The command layer calls this to record the session
    // id in state.json, which is the only durable handle `stop` and `gc` get.
    createdSessionId: (): string | null => session?.id ?? null,
  };
}

/**
 * Where a remote run gets its tools and, optionally, its daemon.
 *
 *   { ctx }                ready to run
 *   { failed: reason, remedy }  a refusal the command prints as-is
 *
 * The operator-supplied daemon is read from the environment because that is
 * the shape both producers already emit: eas-cli writes
 * AGENT_DEVICE_DAEMON_BASE_URL / _AUTH_TOKEN into .env.eas-simulator, and
 * `agent-device proxy` documents the same two names. Honouring them means a
 * self-hosted proxy needs no rn-iso-specific setup at all, and it is the only
 * path that works before EAS Simulator leaves its waitlist.
 */
export function resolveRemoteContext({
  root,
  label,
  easBin,
  env = process.env,
  lookupAgentDevice = defaultLookupAgentDevice,
  maxDurationMinutes = null,
}: {
  root: string;
  label: string;
  easBin: string | null;
  env?: NodeJS.ProcessEnv;
  lookupAgentDevice?: () => string | null;
  maxDurationMinutes?: number | null;
}): { ctx: RemoteContext } | { failed: string; remedy: string } {
  const agentDeviceBin = lookupAgentDevice();
  if (!agentDeviceBin) {
    return {
      failed: 'agent-device is not on PATH, and it is what drives a remote device.',
      remedy: 'Install it (`npm i -g agent-device`), then run `rn-iso ios --remote` again.',
    };
  }

  const baseUrl = env.AGENT_DEVICE_DAEMON_BASE_URL?.trim();
  const token = env.AGENT_DEVICE_DAEMON_AUTH_TOKEN?.trim();
  const existingDaemon = baseUrl && token ? { baseUrl, token } : null;

  // An eas-cli is only needed when rn-iso has to CREATE the session. A
  // daemon already in the environment (a proxy, or a session someone else
  // started) makes eas-cli irrelevant, so it must not be a requirement.
  if (!existingDaemon && !easBin) {
    return {
      failed: 'No remote daemon in the environment, and no eas-cli to create an EAS Simulator session with.',
      remedy:
        'Either export AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN (from `eas sim` or `agent-device proxy`), or install eas-cli.',
    };
  }

  if (baseUrl && !token) {
    return {
      failed: 'AGENT_DEVICE_DAEMON_BASE_URL is set but AGENT_DEVICE_DAEMON_AUTH_TOKEN is not.',
      remedy: 'Export both, or unset the base URL to let rn-iso create its own EAS Simulator session.',
    };
  }

  return {
    ctx: {
      root,
      label,
      easBin: easBin ?? '',
      agentDeviceBin,
      maxDurationMinutes,
      existingDaemon,
    },
  };
}

function defaultLookupAgentDevice(): string | null {
  const found = getExecutor().runQuiet('command -v agent-device', { timeoutMs: 5000 });
  const file = (String(found ?? '').split('\n')[0] ?? '').trim();
  return file || null;
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
function readDaemon(ctx: RemoteContext, sessionId: string): RemoteDaemon | null {
  let stdout: string;
  try {
    stdout = getExecutor().runFile(ctx.easBin, getSessionArgs(sessionId), { cwd: ctx.root });
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
}: {
  root: string;
  sessionId: string;
  easBin: string | null;
  lookupAgentDevice?: () => string | null;
}): { status: 'torn-down' | 'failed'; reason?: string } {
  const agentDeviceBin = (lookupAgentDevice ?? defaultLookupAgentDevice)();
  if (!easBin) {
    return {
      status: 'failed',
      reason: `No eas-cli to stop session ${sessionId} with; it keeps billing until its max duration. Run \`eas simulator:stop --id ${sessionId}\`.`,
    };
  }
  return teardownRemote(
    { root, label: '', easBin, agentDeviceBin: agentDeviceBin ?? '', existingDaemon: null },
    { sessionId, stopArgs: stopSessionArgs(sessionId) },
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
  { sessionId, stopArgs }: { sessionId: string | null; stopArgs: string[] },
): { status: 'torn-down' | 'failed'; reason?: string } {
  const profilePath = remoteProfilePath(ctx.root);
  try {
    getExecutor().runFile(ctx.agentDeviceBin, disconnectArgs(profilePath), { cwd: ctx.root });
  } catch {
    // Nothing to report: a dead or already-released connection is the
    // ordinary case here, and the session stop below is what matters.
  }
  if (!sessionId) return { status: 'torn-down' };
  try {
    getExecutor().runFile(ctx.easBin, stopArgs, { cwd: ctx.root });
    return { status: 'torn-down' };
  } catch (err) {
    return { status: 'failed', reason: `eas simulator:stop ${sessionId} failed: ${describe(err)}` };
  }
}
