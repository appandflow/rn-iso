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
import { readRemoteSessionId } from '../supervisor/state.ts';
import {
  acceptAlertArgs,
  closeArgs,
  connectArgs,
  daemonEnv,
  disconnectArgs,
  installArgs,
  isLoopbackDaemon,
  metroHintFrom,
  openArgs,
  remoteProfile,
  remoteProfilePath,
} from './agent-device.ts';
import { INSTALL_ERROR, LAUNCH_ERROR } from './app-install.ts';
import {
  createSessionArgs,
  getSessionArgs,
  parseCreatedSession,
  remoteDaemonFrom,
  stopSessionArgs,
  type RemoteDaemon,
} from './eas-simulator.ts';

export const REMOTE_SESSION_ERROR = 'RN_ISO_NO_REMOTE_SESSION';
const REMOTE_METRO_ERROR = 'RN_ISO_REMOTE_METRO_UNREACHABLE';

// Where the app should look for Metro, when the device is not on this machine.
// Set it to a URL that reaches THIS workspace's dev server from the device's
// network -- a cloudflared/ngrok tunnel in front of the reserved port.
export const PUBLIC_METRO_ENV = 'RN_ISO_METRO_PUBLIC_URL';

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
  daemonBaseUrl,
  metroPort,
  publicUrl = null,
}: {
  daemonBaseUrl: string;
  metroPort: number | string;
  publicUrl?: string | null;
}): { origin: string } | { failed: string; remedy: string } {
  const named = publicUrl?.trim();
  if (named) return { origin: named.replace(/\/+$/, '') };
  if (isLoopbackDaemon(daemonBaseUrl)) return { origin: `http://localhost:${metroPort}` };
  return {
    failed: `The remote device is not on this machine (${daemonBaseUrl}), so it cannot reach Metro on localhost:${metroPort}.`,
    remedy: `Expose this workspace's Metro port and name it: tunnel port ${metroPort} (for example \`cloudflared tunnel --url http://127.0.0.1:${metroPort}\`), then export ${PUBLIC_METRO_ENV}=<that url> and run again.`,
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
interface BootResult {
  ok?: boolean;
  udid?: string;
  failed?: boolean;
  reason?: string;
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
  easBin: string;
  agentDeviceBin: string;
  maxDurationMinutes?: number | null;
  // A URL that reaches THIS workspace's Metro from the device's network.
  // Only consulted when the daemon is not on this machine.
  publicMetroUrl?: string | null;
  // The readiness poll's wait, injectable so a test does not sleep for real.
  sleep?: (ms: number) => Promise<void>;
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
  const profile = remoteProfile({ daemon, platform: 'ios', label: ctx.label });
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
    //
    // The name says which KIND of remote device this is, because the two
    // behave differently in ways an operator needs to see in one line: an EAS
    // session is rn-iso's to create and destroy, a daemon from the
    // environment is somebody else's and is never stopped here.
    ensureOwnedDevice: async (): Promise<RemoteDeviceRecord> => ({
      deviceName: ctx.existingDaemon ? 'remote device (your daemon)' : 'EAS Simulator',
      owned: true,
      remote: true,
    }),

    // Creates the session (unless the operator brought one), writes the
    // connection profile, and connects. `connect` is also what prepares
    // Metro: it registers rn-iso's local dev server with the daemon through
    // agent-device's companion tunnel, which is how a cloud simulator reaches
    // a bundler on this laptop.
    ensureBooted: async ({ out = () => {} }: { out?: (msg: string) => void } = {}): Promise<BootResult> => {
      let daemon = ctx.existingDaemon ?? null;
      let id: string | null = null;

      // A session this workspace already recorded is REUSED when it is still
      // live, and STOPPED when it is not usable. Neither is optional.
      //
      // `eas sim` defaults to --force, so every run would otherwise mint a
      // fresh session while the previous one stayed live, unrecorded (the id
      // in state.json is overwritten) and billing to its cap. The documented
      // loop re-runs `ios` after every native change, so that fired
      // constantly. Reuse also removes a 60-90s session creation from the
      // common case, which is the difference between `ios --remote` being
      // idempotent and being expensive.
      if (!daemon) {
        const recorded = readRemoteSessionId(ctx.root);
        if (recorded) {
          const existing = readLiveDaemon(ctx, recorded);
          if (existing) {
            out(`Reusing EAS Simulator session ${recorded}.`);
            daemon = existing;
            id = recorded;
          } else {
            // Not reachable any more (stopped, errored, or a type this cannot
            // drive). Ending it is cheap and is the only way to be sure the
            // one about to be created is the only live one.
            out(`Recorded session ${recorded} is not usable; stopping it before creating another.`);
            try {
              exec().runFile(ctx.easBin, stopSessionArgs(recorded), easEnv);
            } catch {
              /* already gone, or unreachable: the create below still proceeds */
            }
          }
        }
      }

      if (!daemon) {
        out('Creating an EAS Simulator session (this takes a moment).');
        let stdout: string;
        try {
          stdout = exec().runFile(
            ctx.easBin,
            createSessionArgs({
              label: ctx.label,
              platform: 'ios',
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
        // The session EXISTS from this line on, and it bills. Every failure
        // below therefore has to end it rather than return and forget it:
        // nothing else can, because the id is not recorded until this
        // function succeeds. Observed live -- a session with no endpoint yet
        // left an IN_PROGRESS session nothing could find.
        daemon = created.daemon ?? (await waitForDaemon(ctx, created.id, out, { sleep: ctx.sleep ?? defaultSleep }));
        if (!daemon) {
          return abandonSession(
            ctx,
            created.id,
            `Session ${created.id} never published an agent-device endpoint. It may be an appium or argent session rather than an agent-device one.`,
          );
        }
      }

      const profilePath = writeProfile(ctx, daemon);
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
        if (id) return abandonSession(ctx, id, `agent-device connect failed: ${describe(err)}`);
        return { failed: true, reason: `agent-device connect failed: ${describe(err)}` };
      }

      // Surfaced the moment the session is reachable, not at the end: it is
      // how a HUMAN watches a device they cannot see, and it is most useful
      // while the build is still running. On its own line so terminals
      // linkify it.
      if (daemon.webPreviewUrl) out(`Watch this device: ${daemon.webPreviewUrl}`);

      session = { id, daemon, profilePath };
      // `udid` is the field ios.ts reads and prints, and shortUdid truncates
      // it for the phase line. A session id shortens to something meaningful;
      // a base URL shortens to "http..", which is noise. So a daemon with no
      // session of its own reports its host instead.
      return { ok: true, udid: id ?? daemonHostLabel(daemon.baseUrl) };
    },

    installIosApp: ({ appPath }: { udid: string; appPath: string }): InstallResult => {
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
    }): LaunchResult => {
      if (!session) return notConnected(LAUNCH_ERROR);
      // WHERE the app looks for Metro is decided first, and a device that
      // cannot reach this workspace's dev server is a refusal rather than a
      // launch that will never load a bundle.
      const origin = resolveMetroOrigin({
        daemonBaseUrl: session.daemon.baseUrl,
        metroPort,
        publicUrl: ctx.publicMetroUrl ?? null,
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
        exec().runFile(ctx.agentDeviceBin, openArgs(session.profilePath, bundleId, url, metroHintFrom(origin.origin)), {
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
          reason: `agent-device open ${bundleId} failed: ${describe(err)}`,
        };
      }
    },

    // Not a dep override. The command layer calls this to record the session
    // id in state.json, which is the only durable handle `stop` and `gc` get.
    createdSessionId: (): string | null => session?.id ?? null,

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

  // Metro reachability is decided HERE, before anything is created or built.
  //
  // It used to be checked at launch, which is the worst possible place: a run
  // with no reachable Metro would create a billable session, compile for
  // minutes, install, and only then refuse. Everything needed to answer the
  // question is already known at this point -- an EAS session is cloud-hosted
  // and therefore never loopback, and an operator daemon carries its URL.
  const publicMetroUrl = env[PUBLIC_METRO_ENV]?.trim() || null;
  if (!publicMetroUrl && !(existingDaemon && isLoopbackDaemon(existingDaemon.baseUrl))) {
    const where = existingDaemon ? `The daemon at ${existingDaemon.baseUrl} is` : 'An EAS Simulator session is';
    return {
      failed: `${where} not on this machine, so the app it launches cannot reach Metro on localhost.`,
      remedy: `Expose this workspace's Metro port through a tunnel (for example \`cloudflared tunnel --url http://127.0.0.1:<port>\`), export ${PUBLIC_METRO_ENV}=<that url>, and run again. \`rn-iso start\` prints the port.`,
    };
  }

  return {
    ctx: {
      root,
      label,
      easBin: easBin ?? '',
      agentDeviceBin,
      maxDurationMinutes,
      publicMetroUrl,
      existingDaemon,
    },
  };
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
function abandonSession(ctx: RemoteContext, sessionId: string, reason: string): { failed: true; reason: string } {
  try {
    getExecutor().runFile(ctx.easBin, stopSessionArgs(sessionId), { cwd: ctx.root });
    return { failed: true, reason: `${reason} The session was stopped.` };
  } catch (err) {
    return {
      failed: true,
      reason:
        `${reason} rn-iso could not stop it (${describe(err)}), and it bills until its cap -- ` +
        `run \`eas simulator:stop --id ${sessionId}\`.`,
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
    stdout = getExecutor().runFile(ctx.easBin, getSessionArgs(sessionId), { cwd: ctx.root });
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(stdout) as { status?: unknown; remoteConfig?: unknown };
    if (typeof data.status !== 'string' || !LIVE_STATUSES.has(data.status)) return null;
    return remoteDaemonFrom(data.remoteConfig);
  } catch {
    return null;
  }
}

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
