// src/engine/eas-simulator.ts -- the EAS Simulator session, which is how a
// remote device comes into existence.
//
// rn-iso does not drive the remote simulator through eas-cli. It only uses
// eas-cli to CREATE, READ and DESTROY the session; everything after that
// speaks to the agent-device daemon the session hands back. That split is
// what lets one backend serve both EAS Simulator and a self-hosted
// `agent-device proxy`, which produce the same two values.
//
// Every shape below is eas-cli's own, read from its source rather than from
// docs, and cited where it is parsed:
//   packages/eas-cli/src/commands/simulator/index.ts
//     printJsonOnlyOutput({id, name, type, deviceRunSessionUrl, remoteConfig})
//   packages/eas-cli/src/simulator/utils.ts
//     getRemoteSessionEnvironmentVariables() -- the AgentDevice branch is the
//     only one carrying agentDeviceRemoteSessionUrl / ...Token
//   packages/eas-cli/src/commands/simulator/list.ts   {sessions, pageInfo}
//   packages/eas-cli/src/commands/simulator/stop.ts   {id, status}
//
// NOTHING HERE PERSISTS THE TOKEN. The session id is the durable handle; the
// token is re-read per command via `simulator:get`. A state file or a pasted
// build log must never carry a live credential.
import { sanitizeDeviceLabel } from '../sim/ios.ts';

// The prefix that marks a session as rn-iso's own. Identical in role to the
// `rn-iso-` simulator-name prefix the local backend checks before it shuts
// anything down: ownership is decided by name, not by a record we might have
// got wrong.
const OWNED_PREFIX = 'rn-iso-';

// eas-cli's own status values, lower-cased as its --status flag accepts them.
const LIVE_STATUSES = ['new', 'in-progress'] as const;

/** The two values an agent-device client needs, plus the human preview link. */
export interface RemoteDaemon {
  baseUrl: string;
  token: string;
  webPreviewUrl?: string;
}

export interface CreatedSession {
  id: string;
  name: string | null;
  url: string | null;
  daemon: RemoteDaemon | null;
}

export interface SessionSummary {
  id: string;
  name: string | null;
  status: string | null;
  platform: string | null;
}

export interface ScopedSessionSummary extends SessionSummary {
  name: string;
  status: string;
  projectScope: string;
}

export interface StoppedSession {
  id: string;
  status: string | null;
}

export type SessionTeardownInspection =
  | { action: 'stop'; name: string; status: string }
  | { action: 'already-stopped'; name: string | null; status: string }
  | { action: 'refused'; reason: string };

const LIVE_SESSION_STATUSES = new Set(['NEW', 'IN_PROGRESS']);
const TERMINAL_SESSION_STATUSES = new Set(['STOPPED', 'ERRORED']);
const SESSION_PLATFORMS = new Set(['ios', 'android']);

// PURE. The `rn-iso-` prefix is the ownership marker, so it is not optional.
// A label that already carries it (a worktree literally named `rn-iso-test`)
// would otherwise produce `rn-iso-rn-iso-test`, so strip one leading copy
// before prefixing. Same rule, and the same reasoning, as ownedSimName.
export function ownedSessionName(label: string): string {
  const clean = sanitizeDeviceLabel(label);
  return `${OWNED_PREFIX}${clean.startsWith(OWNED_PREFIX) ? clean.slice(OWNED_PREFIX.length) : clean}`;
}

// PURE. Defense in depth for every destructive path, exactly as
// resolveOwnedIosSim's name check is: a session rn-iso did not name is a
// session rn-iso must not stop.
export function isOwnedSessionName(name: string | null | undefined): name is string {
  return typeof name === 'string' && name.startsWith(OWNED_PREFIX);
}

// PURE. argv for `eas`, creating a detached session.
//
// `--out-config-type env` is load-bearing, not a preference. The default,
// `dotenv`, writes `.env.eas-simulator` INTO THE PROJECT DIRECTORY, and it
// does so even under --json (commands/simulator/index.ts, the
// writeSimulatorEnvSafelyAsync call after the poll loop). rn-iso does not
// edit a project's files -- the same rule engine/remote-cache.ts states for
// the build-cache provider -- so the config is printed and parsed instead.
//
// `--json --non-interactive` together make the command PRINT and RETURN
// rather than block until the session ends, which is what lets the session
// outlive the command that made it, the same way the supervisor does.
export function createSessionArgs({
  label,
  platform,
  maxDurationMinutes = null,
}: {
  label: string;
  platform: 'ios' | 'android';
  maxDurationMinutes?: number | null;
}): string[] {
  const args = [
    'sim',
    '--platform',
    platform,
    '--json',
    '--non-interactive',
    '--out-config-type',
    'env',
    '--name',
    ownedSessionName(label),
  ];
  if (maxDurationMinutes) args.push('--max-duration-minutes', String(maxDurationMinutes));
  return args;
}

// PURE. argv reading one session back, which is how the token is obtained
// without ever having stored it.
export function getSessionArgs(sessionId: string): string[] {
  return ['simulator:get', '--id', sessionId, '--json', '--non-interactive'];
}

// PURE. argv destroying one session.
//
// `--id` is always passed. Without it `simulator:stop` falls back to whatever
// session `.env.eas-simulator` names, which in a repo with several worktrees
// is a live session belonging to a different one.
export function stopSessionArgs(sessionId: string): string[] {
  return ['simulator:stop', '--id', sessionId, '--json', '--non-interactive'];
}

// PURE. argv listing rn-iso's own LIVE sessions, which is what `gc` sweeps.
// A stopped or errored session costs nothing and is not a leak.
export function listOwnedSessionsArgs(): string[] {
  return [
    'simulator:list',
    '--name',
    OWNED_PREFIX,
    ...LIVE_STATUSES.flatMap((s) => ['--status', s]),
    '--json',
    '--non-interactive',
  ];
}

// PURE. The daemon coordinates, or null.
//
// Takes `unknown` because eas-cli's remoteConfig is genuinely dynamic
// third-party output, narrowed field by field below rather than trusted
// wholesale.
//
// IDENTIFIED BY ITS FIELDS, NOT BY __typename. eas-cli's own source switches
// on `remoteConfig.__typename` to tell the union members apart, and an
// earlier version of this function copied that -- but __typename exists only
// on the in-memory GraphQL object. The JSON that `--json` prints does not
// carry it, verified against a live session:
//
//   "remoteConfig": {
//     "agentDeviceRemoteSessionUrl": "https://...ngrok.dev",
//     "agentDeviceRemoteSessionToken": "...",
//     "webPreviewUrl": "https://..."
//   }
//
// so requiring it rejected every real agent-device session. The two fields
// below ARE the discriminator: no other member of the union has them.
//
// Returns null rather than a partial record for a session of another type
// (appium, argent, serve-sim). Those are real sessions this backend cannot
// speak to, and a half-filled RemoteDaemon would fail later and further away.
export function remoteDaemonFrom(config: unknown): RemoteDaemon | null {
  if (!isRecord(config)) return null;
  // Honoured when present -- a caller reading the GraphQL object directly
  // still gets the strict answer -- but never required.
  const typename = str(config.__typename);
  if (typename && typename !== 'AgentDeviceRunSessionRemoteConfig') return null;
  const baseUrl = str(config.agentDeviceRemoteSessionUrl);
  const token = str(config.agentDeviceRemoteSessionToken);
  if (!baseUrl || !token) return null;
  const daemon: RemoteDaemon = { baseUrl, token };
  const preview = str(config.webPreviewUrl);
  if (preview) daemon.webPreviewUrl = preview;
  return daemon;
}

// Every parse below returns a value or null/[] and never throws: eas-cli
// prints diagnostics to stderr under --json, but a version bump, an auth
// prompt or an outage can still put something unparseable on stdout, and a
// device backend must not die reading it.
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// PURE. Authorizes teardown from the current server record, not the stored id.
export function inspectSessionForTeardown(stdout: string, sessionId: string): SessionTeardownInspection {
  const data = parseJson(stdout);
  if (!isRecord(data)) {
    return { action: 'refused', reason: `Session ${sessionId} lookup did not return valid JSON.` };
  }
  const id = str(data.id);
  if (!id) return { action: 'refused', reason: `Session ${sessionId} lookup returned no session id.` };
  if (id !== sessionId) {
    return { action: 'refused', reason: `Session ${sessionId} lookup returned different session ${id}.` };
  }
  const status = str(data.status);
  if (!status) return { action: 'refused', reason: `Session ${sessionId} lookup returned no status.` };
  const name = str(data.name);
  if (!isOwnedSessionName(name)) {
    return {
      action: 'refused',
      reason: `Session ${sessionId} is not owned by rn-iso (name: ${name ?? 'missing'}).`,
    };
  }
  if (TERMINAL_SESSION_STATUSES.has(status)) return { action: 'already-stopped', name, status };
  if (!LIVE_SESSION_STATUSES.has(status)) {
    return { action: 'refused', reason: `Session ${sessionId} has unknown status ${status}.` };
  }
  return { action: 'stop', name, status };
}

// PURE. Only a session-specific missing result proves the stored resource is gone.
export function isDefinitiveMissingSessionError(error: unknown, sessionId: string): boolean {
  const candidate = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof candidate?.stderr === 'string' ? candidate.stderr : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  const escapedSessionId = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const missingSession = new RegExp(
    `(?:device[\\s-]*run[\\s-]*session|simulator[\\s-]*session)[\\s:#]*\\b${escapedSessionId}\\b[\\s,:]*(?:(?:was\\s+)?not\\s+found|does\\s+not\\s+exist)\\b`,
    'i',
  );
  return `${stderr}\n${message}`
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .some((line) => missingSession.test(line));
}

export function verifyStoppedSession(stdout: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
  const stopped = parseStoppedSession(stdout);
  if (!stopped) return { ok: false, reason: `Stop for session ${sessionId} did not return valid JSON with an id.` };
  if (stopped.id !== sessionId) {
    return { ok: false, reason: `Stop for session ${sessionId} returned different session ${stopped.id}.` };
  }
  if (!stopped.status || !TERMINAL_SESSION_STATUSES.has(stopped.status)) {
    return {
      ok: false,
      reason: `Stop for session ${sessionId} returned unknown status ${stopped.status ?? 'missing'}.`,
    };
  }
  return { ok: true };
}

// PURE. `eas sim --json` stdout -> the session, or null if there is no id.
// No id means no session was created, whatever else the payload says.
export function parseCreatedSession(stdout: string): CreatedSession | null {
  const data = parseJson(stdout);
  if (!isRecord(data)) return null;
  const id = str(data.id);
  if (!id) return null;
  return {
    id,
    name: str(data.name),
    url: str(data.deviceRunSessionUrl),
    daemon: remoteDaemonFrom(data.remoteConfig),
  };
}

// PURE. `eas simulator:list --json` stdout -> the sessions.
// A record with no id cannot be acted on, so it is dropped rather than
// carried as a partial that a later stop would fail on.
export function parseSessionList(stdout: string): SessionSummary[] {
  const data = parseJson(stdout);
  if (!isRecord(data) || !Array.isArray(data.sessions)) return [];
  const out: SessionSummary[] = [];
  for (const raw of data.sessions) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id);
    if (!id) continue;
    out.push({ id, name: str(raw.name), status: str(raw.status), platform: str(raw.platform) });
  }
  return out;
}

export function parseSessionListEntries(
  stdout: string,
): { ok: true; sessions: unknown[] } | { ok: false; reason: string } {
  const data = parseJson(stdout);
  if (!isRecord(data) || !Array.isArray(data.sessions)) {
    return { ok: false, reason: 'EAS session list did not return valid JSON with a sessions array.' };
  }
  return { ok: true, sessions: data.sessions };
}

// PURE. Selects active sessions carrying rn-iso's ownership prefix that no
// readable workspace state references. The EAS list is scoped by its cwd, so
// every returned row carries that project directory as its explicit scope.
export function findOrphanedOwnedSessions({
  sessions,
  recordedSessionIds,
  projectScope,
}: {
  sessions: unknown[];
  recordedSessionIds: readonly string[];
  projectScope: string;
}): { orphaned: ScopedSessionSummary[]; notices: string[] } {
  const scope = typeof projectScope === 'string' ? projectScope.trim() : '';
  if (!scope) return { orphaned: [], notices: ['EAS session list has no current-project scope.'] };

  const recorded = new Set(recordedSessionIds.filter((id) => typeof id === 'string' && id.length > 0));
  const candidates = new Map<string, ScopedSessionSummary>();
  const conflicts = new Set<string>();
  const blocked = new Set<string>();
  const notices: string[] = [];

  for (const raw of sessions) {
    if (!isRecord(raw)) {
      notices.push('EAS session list contains a malformed entry.');
      continue;
    }
    const id = str(raw.id);
    const name = str(raw.name);
    if (!id) {
      if (isOwnedSessionName(name)) notices.push('EAS session list contains an owned entry with no session id.');
      continue;
    }
    if (!name) {
      blocked.add(id);
      candidates.delete(id);
      notices.push(`EAS session ${id} has no name and cannot be classified as rn-iso-owned.`);
      continue;
    }
    if (!isOwnedSessionName(name)) continue;

    const statusValue = str(raw.status);
    const status = statusValue?.toUpperCase().replace(/-/g, '_') ?? null;
    if (!status) {
      blocked.add(id);
      candidates.delete(id);
      notices.push(`Owned EAS session ${id} has no status.`);
      continue;
    }
    if (TERMINAL_SESSION_STATUSES.has(status)) continue;
    if (!LIVE_SESSION_STATUSES.has(status)) {
      blocked.add(id);
      candidates.delete(id);
      notices.push(`Owned EAS session ${id} has unknown status ${status}.`);
      continue;
    }

    const platformValue = str(raw.platform);
    const normalizedPlatform = platformValue?.toLowerCase() ?? null;
    if (normalizedPlatform && !SESSION_PLATFORMS.has(normalizedPlatform)) {
      blocked.add(id);
      candidates.delete(id);
      notices.push(`Owned EAS session ${id} has unknown platform ${platformValue}.`);
      continue;
    }
    if (recorded.has(id) || blocked.has(id)) continue;

    const candidate: ScopedSessionSummary = {
      id,
      name,
      status,
      platform: normalizedPlatform,
      projectScope: scope,
    };
    const previous = candidates.get(id);
    if (!previous) {
      candidates.set(id, candidate);
      continue;
    }
    if (
      previous.name !== candidate.name ||
      previous.status !== candidate.status ||
      previous.platform !== candidate.platform
    ) {
      conflicts.add(id);
      candidates.delete(id);
      notices.push(`EAS session list contains conflicting entries for session ${id}.`);
    }
  }

  for (const id of [...conflicts, ...blocked]) candidates.delete(id);
  return { orphaned: [...candidates.values()], notices };
}

// PURE. `eas simulator:stop --json` stdout -> what eas confirmed.
export function parseStoppedSession(stdout: string): StoppedSession | null {
  const data = parseJson(stdout);
  if (!isRecord(data)) return null;
  const id = str(data.id);
  if (!id) return null;
  return { id, status: str(data.status) };
}
