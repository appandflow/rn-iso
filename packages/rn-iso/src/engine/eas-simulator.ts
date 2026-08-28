import { sanitizeDeviceLabel } from '../sim/ios.ts';

const OWNED_PREFIX = 'rn-iso-';

const LIVE_STATUSES = ['new', 'in-progress'] as const;

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

export interface ScopedSessionSummary extends Omit<SessionSummary, 'name' | 'status' | 'platform'> {
  name: string;
  status: string;
  platform: 'ios' | 'android';
  projectScope: string;
}

export interface SessionListPage {
  sessions: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
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

export function ownedSessionName(label: string): string {
  const clean = sanitizeDeviceLabel(label);
  return `${OWNED_PREFIX}${clean.startsWith(OWNED_PREFIX) ? clean.slice(OWNED_PREFIX.length) : clean}`;
}

export function isOwnedSessionName(name: string | null | undefined): name is string {
  return typeof name === 'string' && name.startsWith(OWNED_PREFIX);
}

export function createSessionArgs({
  label,
  platform,
  maxDurationMinutes = null,
}: {
  label: string;
  platform: 'ios' | 'android';
  maxDurationMinutes?: number | null;
}): string[] {
  // eas-cli's default output writes .env.eas-simulator; env output keeps project files unchanged.
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

export function getSessionArgs(sessionId: string): string[] {
  return ['simulator:get', '--id', sessionId, '--json', '--non-interactive'];
}

export function stopSessionArgs(sessionId: string): string[] {
  // eas-cli otherwise selects the session in .env.eas-simulator, which can belong to another worktree.
  return ['simulator:stop', '--id', sessionId, '--json', '--non-interactive'];
}

export function listOwnedSessionsArgs(after: string | null = null): string[] {
  const args = [
    'simulator:list',
    '--name',
    OWNED_PREFIX,
    ...LIVE_STATUSES.flatMap((s) => ['--status', s]),
    '--limit',
    '100',
    '--json',
    '--non-interactive',
  ];
  if (after) args.push('--after', after);
  return args;
}

export function remoteDaemonFrom(config: unknown): RemoteDaemon | null {
  if (!isRecord(config)) return null;
  // eas sim --json omits GraphQL __typename, so the agent-device URL and token identify the variant.
  const typename = str(config['__typename']);
  if (typename && typename !== 'AgentDeviceRunSessionRemoteConfig') return null;
  const baseUrl = str(config.agentDeviceRemoteSessionUrl);
  const token = str(config.agentDeviceRemoteSessionToken);
  if (!baseUrl || !token) return null;
  const daemon: RemoteDaemon = { baseUrl, token };
  const preview = str(config.webPreviewUrl);
  if (preview) daemon.webPreviewUrl = preview;
  return daemon;
}

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

export function parseSessionListPage(
  stdout: string,
): { ok: true; page: SessionListPage } | { ok: false; reason: string } {
  const data = parseJson(stdout);
  if (!isRecord(data) || !Array.isArray(data.sessions)) {
    return { ok: false, reason: 'EAS session list did not return valid JSON with a sessions array.' };
  }
  if (!isRecord(data.pageInfo) || typeof data.pageInfo.hasNextPage !== 'boolean') {
    return { ok: false, reason: 'EAS session list page did not return valid pagination information.' };
  }
  const endCursor = data.pageInfo.endCursor;
  if (endCursor !== null && typeof endCursor !== 'string') {
    return { ok: false, reason: 'EAS session list returned a malformed pagination cursor.' };
  }
  return {
    ok: true,
    page: {
      sessions: data.sessions,
      hasNextPage: data.pageInfo.hasNextPage,
      endCursor,
    },
  };
}

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
    if (!normalizedPlatform || !SESSION_PLATFORMS.has(normalizedPlatform)) {
      blocked.add(id);
      candidates.delete(id);
      notices.push(
        platformValue
          ? `Owned EAS session ${id} has unknown platform ${platformValue}.`
          : `Owned EAS session ${id} has no platform.`,
      );
      continue;
    }
    if (recorded.has(id) || blocked.has(id)) continue;

    const candidate: ScopedSessionSummary = {
      id,
      name,
      status,
      platform: normalizedPlatform as 'ios' | 'android',
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

export function parseStoppedSession(stdout: string): StoppedSession | null {
  const data = parseJson(stdout);
  if (!isRecord(data)) return null;
  const id = str(data.id);
  if (!id) return null;
  return { id, status: str(data.status) };
}
