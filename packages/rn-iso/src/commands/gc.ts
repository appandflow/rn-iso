import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import chalk from 'chalk';
import { InvalidArgumentError, type Command } from 'commander';
import { clearDevice, getConfigDir, loadConfig } from '../config.ts';
import { formatBytes, isOnMountedVolume, listMountedVolumes, volumeRootFor } from '../fs-util.ts';
import { listBuildLocks, readBuildLock } from '../engine/build-lock.ts';
import { listBuildSlots, readBuildSlot } from '../engine/build-slots.ts';
import {
  findOrphanedOwnedSessions,
  getSessionArgs,
  inspectSessionForTeardown,
  isDefinitiveMissingSessionError,
  listOwnedSessionsArgs,
  parseSessionListPage,
  stopSessionArgs,
  verifyStoppedSession,
  type ScopedSessionSummary,
} from '../engine/eas-simulator.ts';
import { resolveEasCliBin } from '../engine/remote-cache.ts';
import { getExecutor } from '../exec.ts';
import { isPidAlive } from '../metro.ts';
import { detectIsExpo, findProjectRoot } from '../project.ts';
import { reclaimProject } from '../reclaim.ts';
import { listAllIosSims, type IosSimRecord } from '../sim/ios.ts';
import { teardownOwnedIosSim, teardownOwnedAvd } from '../teardown.ts';
import { listAvds } from '../sim/android.ts';
import { declaredCachePaths, discoverCaches, pruneCache, sizeCaches, type CacheDescriptor } from '../caches.ts';
import { workspaceDir, workspaceStateFile } from '../paths.ts';
import { withRemoteSessionLock } from '../engine/device-remote.ts';
import { withEasProjectLock } from '../engine/eas-project-lock.ts';
import {
  easMachineStateRoot,
  readEasSessionLedger,
  removeEasSessionClaim,
  type EasSessionClaim,
} from '../engine/eas-session-ledger.ts';
import type { BuildLockInfo, BuildSlotInfo, Config, GcSkip, OrphanedDevice } from '../types.ts';

interface StaleProjectDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  project: string;
  idleDays: number;
}

interface StaleDeviceRecord {
  kind: 'ios' | 'android';
  id: string;
  project: string;
  owned: boolean;
}

interface KeptDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  reason: string;
}

interface GcCache extends CacheDescriptor {
  machineGlobal?: string | null;
  willEmpty?: boolean;
  emptySkipped?: string | null;
}

interface EasSessionSweep {
  projectScope: string | null;
  orphaned: ScopedSessionSummary[];
  notices: string[];
  deletionSafe: boolean;
}

interface GcReport {
  skipped: GcSkip[];
  deadProjects: string[];
  orphanedDevices: OrphanedDevice[];
  staleDevices: StaleProjectDevice[];
  staleDeviceRecords: StaleDeviceRecord[];
  buildLocks: { stale: BuildLockInfo[]; live: BuildLockInfo[] };
  buildSlots: { stale: BuildSlotInfo[]; live: BuildSlotInfo[] };
  deviceSweepNotices: string[];
  easSessionSweep: EasSessionSweep;
  caches: GcCache[];
  olderThan: number | null;
  all: boolean;
}

interface CollectGcReportOptions {
  olderThan?: number | null;
  all?: boolean;
  now?: number;
  lastTouched?: (path: string) => number;
  unsafeAllowScopedDeviceSweep?: boolean;
}

interface RunGcOptions {
  olderThan?: number;
  all?: boolean;
  delete?: boolean;
  unsafeAllowScopedDeviceSweep?: boolean;
}

interface GcDependencies {
  findProjectRoot?: typeof findProjectRoot;
  detectIsExpo?: typeof detectIsExpo;
  resolveEasCliBin?: typeof resolveEasCliBin;
  runEasFile?: (
    file: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; omitEnv: readonly string[] },
  ) => string;
  withRemoteSessionLock?: typeof withRemoteSessionLock;
  withEasProjectLock?: typeof withEasProjectLock;
  easMaxPages?: number;
  easCollectionTimeoutMs?: number;
  easNow?: () => number;
  easLockWaitMs?: number;
  easLockSnapshotRetries?: number;
  easSweepBlockedNotice?: string;
  easLockedRoots?: readonly string[];
  easLedgerRoot?: string;
  removeEasSessionClaim?: typeof removeEasSessionClaim;
  precollectedEasSessionSweep?: EasSessionSweep;
}

// simctl and emulator listings can exceed 10 seconds on loaded hosts; 30 seconds still bounds hangs.
const DEVICE_LIST_TIMEOUT_MS = 30000;
const EAS_OPERATION_TIMEOUT_MS = 30000;
const EAS_COLLECTION_TIMEOUT_MS = 60000;
const EAS_MAX_LIST_PAGES = 100;
const EAS_LOCK_WAIT_MS = 0;
const EAS_LOCK_SNAPSHOT_RETRIES = 3;
const PROXY_CREDENTIAL_ENV = ['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function describeKept(ref: { path: string; mounted: boolean }): string {
  return ref.mounted
    ? `referenced by ${ref.path}`
    : `referenced by ${ref.path} (volume not mounted; kept just in case)`;
}

export function findOrphanedDevices({
  sims = [],
  avds = [],
  config,
  isMounted,
  deadProjects = [],
}: {
  sims?: IosSimRecord[];
  avds?: string[];
  config: Config | null;
  isMounted?: (path: string) => boolean;
  deadProjects?: string[];
}): { orphaned: OrphanedDevice[]; kept: KeptDevice[] } {
  const dead = new Set(deadProjects);
  const referenced = new Map<string, { path: string; mounted: boolean }>();

  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path)) continue;
    const mounted = isMounted ? isMounted(path) : true;
    const ios = proj?.platforms?.ios;
    if (ios?.deviceUdid) {
      referenced.set(ios.deviceUdid, { path, mounted });
    }
    const android = proj?.platforms?.android;
    if (android?.avdName) {
      referenced.set(android.avdName, { path, mounted });
    }
  }

  const orphaned: OrphanedDevice[] = [];
  const kept: KeptDevice[] = [];

  for (const sim of sims) {
    if (!sim?.name?.startsWith('rn-iso-')) continue;
    const ref = referenced.get(sim.udid);
    if (!ref) {
      orphaned.push({ kind: 'ios', id: sim.udid, name: sim.name });
    } else {
      kept.push({ kind: 'ios', id: sim.udid, name: sim.name, reason: describeKept(ref) });
    }
  }

  for (const avdName of avds) {
    if (!avdName?.startsWith('rn-iso-')) continue;
    const ref = referenced.get(avdName);
    if (!ref) {
      orphaned.push({ kind: 'android', id: avdName, name: avdName });
    } else {
      kept.push({ kind: 'android', id: avdName, name: avdName, reason: describeKept(ref) });
    }
  }

  return { orphaned, kept };
}

export function findStaleProjectDevices({
  config,
  sims = [],
  avds = [],
  olderThanDays,
  now = Date.now(),
  lastTouched,
  deadProjects = [],
}: {
  config: Config | null;
  sims?: IosSimRecord[];
  avds?: string[];
  olderThanDays?: number;
  now?: number;
  lastTouched?: (path: string) => number;
  deadProjects?: string[];
}): StaleProjectDevice[] {
  if (!Number.isFinite(olderThanDays) || typeof lastTouched !== 'function') return [];
  const cutoff = now - (olderThanDays as number) * DAY_MS;
  const dead = new Set(deadProjects);

  const liveSims = new Map<string, string>(
    sims.filter((s) => s?.name?.startsWith('rn-iso-')).map((s) => [s.udid, s.name] as [string, string]),
  );
  const liveAvds = new Set(avds.filter((a) => typeof a === 'string' && a.startsWith('rn-iso-')));

  const stale: StaleProjectDevice[] = [];
  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path)) continue;
    const touched = lastTouched(path);
    if (!Number.isFinite(touched) || touched >= cutoff) continue;
    const idleDays = Math.floor((now - touched) / DAY_MS);

    const ios = proj?.platforms?.ios;
    if (ios?.owned && ios.deviceUdid && liveSims.has(ios.deviceUdid)) {
      stale.push({
        kind: 'ios',
        id: ios.deviceUdid,
        name: liveSims.get(ios.deviceUdid) as string,
        project: path,
        idleDays,
      });
    }
    const android = proj?.platforms?.android;
    if (android?.owned && android.avdName && liveAvds.has(android.avdName)) {
      stale.push({ kind: 'android', id: android.avdName, name: android.avdName, project: path, idleDays });
    }
  }
  return stale;
}

export function findStaleDeviceRecords({
  config,
  sims = [],
  avds = [],
  deadProjects = [],
  simsChecked = true,
  avdsChecked = true,
}: {
  config: Config | null;
  sims?: IosSimRecord[];
  avds?: string[];
  deadProjects?: string[];
  simsChecked?: boolean;
  avdsChecked?: boolean;
}): StaleDeviceRecord[] {
  const dead = new Set(deadProjects);
  const liveSims = new Set(sims.map((s) => s?.udid).filter(Boolean));
  const liveAvds = new Set(avds.filter((a) => typeof a === 'string'));

  const stale: StaleDeviceRecord[] = [];
  for (const [path, proj] of Object.entries(config?.projects || {})) {
    if (dead.has(path)) continue;

    const ios = proj?.platforms?.ios;
    if (simsChecked && ios?.deviceUdid && !liveSims.has(ios.deviceUdid)) {
      stale.push({ kind: 'ios', id: ios.deviceUdid, project: path, owned: Boolean(ios.owned) });
    }
    const android = proj?.platforms?.android;
    if (avdsChecked && android?.avdName && !liveAvds.has(android.avdName)) {
      stale.push({ kind: 'android', id: android.avdName, project: path, owned: Boolean(android.owned) });
    }
  }
  return stale;
}

export function describeUnverifiableDevices(
  simNames: string[] = [],
  avdNames: string[] = [],
  { reason = 'no rn-iso config found' }: { reason?: string } = {},
): string[] {
  const ours = [...simNames, ...avdNames].filter((n) => typeof n === 'string' && n.startsWith('rn-iso-'));
  if (ours.length === 0) return [`${reason}; device sweep skipped`];
  return [
    `${reason}, so ${ours.length} rn-iso-created device(s) cannot be verified as orphaned: ${ours.join(', ')}`,
    'they were NOT touched. If they are stale, delete them with `xcrun simctl delete <udid>` or `avdmanager delete avd -n <name>`',
  ];
}

function describeError(error: unknown): string {
  const candidate = error as { stderr?: unknown; message?: unknown };
  if (typeof candidate?.stderr === 'string' && candidate.stderr.trim()) return candidate.stderr.trim();
  if (typeof candidate?.message === 'string' && candidate.message.trim()) return candidate.message.trim();
  return String(error);
}

function readRecordedRemoteSessionIds(roots: string[]): {
  ids: string[];
  notices: string[];
  safe: boolean;
} {
  const ids = new Set<string>();
  const notices: string[] = [];
  let safe = true;

  for (const root of new Set(roots)) {
    try {
      if (!statSync(root).isDirectory()) throw new Error('path is not a directory');
      readdirSync(root);
    } catch (error) {
      safe = false;
      notices.push(`${root} is not available as a readable workspace directory: ${describeError(error)}`);
      continue;
    }

    const path = workspaceStateFile(root);
    if (!existsSync(path)) continue;
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    } catch (error) {
      safe = false;
      notices.push(`${path} could not be read as valid JSON: ${describeError(error)}`);
      continue;
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      safe = false;
      notices.push(`${path} does not contain a valid workspace state object.`);
      continue;
    }
    const remote = (state as { remoteDevice?: unknown }).remoteDevice;
    if (remote === undefined) continue;
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
      safe = false;
      notices.push(`${path} has a malformed remote session record.`);
      continue;
    }
    const id = (remote as { sessionId?: unknown }).sessionId;
    if (typeof id !== 'string' || id.length === 0) {
      safe = false;
      notices.push(`${path} has a remote session record with no valid session id.`);
      continue;
    }
    ids.add(id);
  }
  return { ids: [...ids], notices, safe };
}

function claimStateAbsence(claim: EasSessionClaim): { absent: boolean; notice: string | null } {
  const stateDir = dirname(claim.stateFile);
  let entries: string[];
  try {
    if (!statSync(stateDir).isDirectory()) throw new Error('path is not a directory');
    entries = readdirSync(stateDir);
  } catch (error) {
    return {
      absent: false,
      notice: `${stateDir} is not available for EAS ownership verification: ${describeError(error)}`,
    };
  }
  if (!entries.includes(basename(claim.stateFile))) return { absent: true, notice: null };
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(claim.stateFile, 'utf-8')) as unknown;
  } catch (error) {
    return { absent: false, notice: `${claim.stateFile} could not be read as valid JSON: ${describeError(error)}` };
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { absent: false, notice: `${claim.stateFile} does not contain a valid workspace state object.` };
  }
  const remote = (state as { remoteDevice?: unknown }).remoteDevice;
  if (remote === undefined) return { absent: true, notice: null };
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
    return { absent: false, notice: `${claim.stateFile} has a malformed remote session record.` };
  }
  const sessionId = (remote as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || !sessionId) {
    return { absent: false, notice: `${claim.stateFile} has a remote session record with no valid session id.` };
  }
  return { absent: sessionId !== claim.sessionId, notice: null };
}

function collectEasSessionSweep(config: Config | null, deps: GcDependencies): EasSessionSweep {
  const projectRoot = (deps.findProjectRoot ?? findProjectRoot)(process.cwd());
  const empty = (notices: string[] = []): EasSessionSweep => ({
    projectScope: projectRoot,
    orphaned: [],
    notices,
    deletionSafe: notices.length === 0,
  });
  if (!projectRoot || !(deps.detectIsExpo ?? detectIsExpo)(projectRoot)) return empty();
  if (deps.easSweepBlockedNotice) return empty([deps.easSweepBlockedNotice]);

  const eas = (deps.resolveEasCliBin ?? resolveEasCliBin)(projectRoot);
  if (!eas) return empty(['EAS session sweep skipped: eas-cli is not available for the current Expo project.']);

  const workspaceRoots = [...Object.keys(config?.projects ?? {}), projectRoot];
  const recorded = readRecordedRemoteSessionIds(workspaceRoots);
  const ledgerRoot = deps.easLedgerRoot ?? easMachineStateRoot();
  const ledger = readEasSessionLedger(ledgerRoot);
  const run = deps.runEasFile ?? ((file, args, options) => getExecutor().runFile(file, args, options));
  const sessions: unknown[] = [];
  const seenCursors = new Set<string>();
  const now = deps.easNow ?? Date.now;
  const collectionTimeoutMs = deps.easCollectionTimeoutMs ?? EAS_COLLECTION_TIMEOUT_MS;
  const maxPages = deps.easMaxPages ?? EAS_MAX_LIST_PAGES;
  const deadline = now() + collectionTimeoutMs;
  let pageCount = 0;
  let after: string | null = null;
  while (true) {
    if (pageCount >= maxPages) {
      return empty([
        ...recorded.notices,
        `EAS session list exceeded the maximum page limit of ${maxPages} for ${projectRoot}.`,
      ]);
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return empty([...recorded.notices, `EAS session list exceeded its total time limit for ${projectRoot}.`]);
    }

    let stdout: string;
    try {
      stdout = run(eas.file, listOwnedSessionsArgs(after), {
        cwd: projectRoot,
        timeoutMs: Math.min(EAS_OPERATION_TIMEOUT_MS, remainingMs),
        omitEnv: PROXY_CREDENTIAL_ENV,
      });
    } catch (error) {
      return empty([...recorded.notices, `EAS session list failed for ${projectRoot}: ${describeError(error)}`]);
    }
    pageCount++;
    if (now() > deadline) {
      return empty([...recorded.notices, `EAS session list exceeded its total time limit for ${projectRoot}.`]);
    }

    const parsed = parseSessionListPage(stdout);
    if (!parsed.ok) return empty([...recorded.notices, parsed.reason]);
    sessions.push(...parsed.page.sessions);
    if (!parsed.page.hasNextPage) break;

    const cursor = parsed.page.endCursor?.trim();
    if (!cursor) {
      return empty([...recorded.notices, 'EAS session list has a next page but returned no pagination cursor.']);
    }
    if (seenCursors.has(cursor)) {
      return empty([...recorded.notices, `EAS session list repeated pagination cursor ${cursor}.`]);
    }
    seenCursors.add(cursor);
    after = cursor;
  }

  const lockedRoots = deps.easLockedRoots;
  if (lockedRoots) {
    const currentRoots = easLockRoots(projectRoot, loadConfig());
    if (currentRoots.some((root) => !lockedRoots.includes(root))) {
      return empty([
        ...recorded.notices,
        'EAS session sweep skipped: registered workspace roots changed after remote-session locks were acquired.',
      ]);
    }
  }

  const compared = findOrphanedOwnedSessions({
    sessions,
    recordedSessionIds: recorded.ids,
    projectScope: projectRoot,
  });
  const notices = [...recorded.notices, ...compared.notices];
  if (ledger.notice) notices.push(ledger.notice);
  const orphaned: ScopedSessionSummary[] = [];
  if (ledger.safe && recorded.safe) {
    for (const session of compared.orphaned) {
      const claim = ledger.claims.get(session.id);
      if (!claim || claim.name !== session.name || claim.platform !== session.platform) {
        notices.push(
          `EAS session ${session.id} (${session.name}) is unclaimed or its fixed ownership record does not match; it was not selected for deletion.`,
        );
        continue;
      }
      const state = claimStateAbsence(claim);
      if (state.notice) {
        notices.push(state.notice);
        continue;
      }
      if (state.absent) orphaned.push(session);
    }
  }
  return {
    projectScope: projectRoot,
    orphaned,
    notices,
    deletionSafe: recorded.safe && ledger.safe,
  };
}

function easLockRoots(projectRoot: string, config: Config | null): string[] {
  return [...new Set([...Object.keys(config?.projects ?? {}), projectRoot].map(canonicalPath))].toSorted();
}

function unavailableLockRootNotice(roots: readonly string[]): string | null {
  for (const root of roots) {
    try {
      if (!statSync(root).isDirectory()) throw new Error('path is not a directory');
      readdirSync(root);
    } catch (error) {
      return `EAS session sweep skipped: ${root} is not available for remote-session lock inspection: ${describeError(error)}`;
    }
  }
  return null;
}

function malformedRemoteSessionLockNotice(roots: readonly string[]): string | null {
  for (const root of roots) {
    const lockPath = join(workspaceDir(root), 'remote-session.lock');
    if (!existsSync(lockPath)) continue;
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf-8')) as Record<string, unknown>;
      if (typeof owner.pid === 'number' && typeof owner.token === 'string') continue;
    } catch {
      if (!existsSync(lockPath)) continue;
    }
    return `EAS session sweep skipped: the remote-session lock at ${lockPath} has a malformed owner record.`;
  }
  return null;
}

async function withRemoteSessionGcLocks<T>(
  projectRoot: string,
  deps: GcDependencies,
  fn: (coordinatedDeps: GcDependencies) => Promise<T>,
): Promise<T> {
  const withLock = deps.withRemoteSessionLock ?? withRemoteSessionLock;
  const waitMs = deps.easLockWaitMs ?? EAS_LOCK_WAIT_MS;
  const maxSnapshots = deps.easLockSnapshotRetries ?? EAS_LOCK_SNAPSHOT_RETRIES;

  for (let attempt = 0; attempt < maxSnapshots; attempt++) {
    const roots = easLockRoots(projectRoot, loadConfig());
    const unavailable = unavailableLockRootNotice(roots);
    if (unavailable) return fn({ ...deps, easSweepBlockedNotice: unavailable });
    const malformed = malformedRemoteSessionLockNotice(roots);
    if (malformed) return fn({ ...deps, easSweepBlockedNotice: malformed });

    let expanded = false;
    let coreStarted = false;
    const acquire = (index: number): Promise<T | null> =>
      index === roots.length
        ? (async () => {
            const rescannedRoots = easLockRoots(projectRoot, loadConfig());
            if (rescannedRoots.some((root) => !roots.includes(root))) {
              expanded = true;
              return null;
            }
            coreStarted = true;
            return fn({ ...deps, easSweepBlockedNotice: undefined, easLockedRoots: roots });
          })()
        : withLock(roots[index]!, () => acquire(index + 1), { waitMs });

    try {
      const result = await acquire(0);
      if (!expanded) return result as T;
    } catch (error) {
      if (coreStarted) throw error;
      return fn({
        ...deps,
        easSweepBlockedNotice: `EAS session sweep skipped: remote-session lock acquisition failed: ${describeError(error)}`,
      });
    }
  }

  return fn({
    ...deps,
    easSweepBlockedNotice: `EAS session sweep skipped: registered workspace roots kept changing during remote-session lock acquisition.`,
  });
}

function shortKey(key: unknown) {
  const text = String(key ?? '');
  return text.length > 6 ? `${text.slice(0, 6)}..` : text;
}

export function formatGcReport({
  skipped = [],
  deadProjects = [],
  orphanedDevices = [],
  staleDevices = [],
  staleDeviceRecords = [],
  buildLocks = { stale: [], live: [] },
  buildSlots = { stale: [], live: [] },
  deviceSweepNotices = [],
  easSessionSweep = { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
  caches = [],
  olderThan = null,
}: Partial<GcReport>): string[] {
  const lines: string[] = [];
  const staleLocks = buildLocks?.stale ?? [];
  const liveLocks = buildLocks?.live ?? [];
  const staleSlots = buildSlots?.stale ?? [];

  if (
    deadProjects.length === 0 &&
    orphanedDevices.length === 0 &&
    staleDevices.length === 0 &&
    staleDeviceRecords.length === 0 &&
    staleLocks.length === 0 &&
    staleSlots.length === 0 &&
    easSessionSweep.orphaned.length === 0
  ) {
    const reasons = [];
    if (skipped.length > 0) {
      reasons.push(`${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} could not be checked`);
    }
    if (deviceSweepNotices.length > 0) {
      reasons.push('device sweep incomplete');
    }
    if (easSessionSweep.notices.length > 0) {
      reasons.push('EAS session sweep incomplete');
    }
    if (reasons.length > 0) {
      lines.push(`Nothing to reclaim (${reasons.join('; ')}; see below).`);
    } else {
      lines.push('Nothing to reclaim.');
    }
  }

  if (deadProjects.length) {
    lines.push(`Dead project entries (${deadProjects.length}):`);
    for (const path of deadProjects) lines.push(`  ${path}`);
  }

  if (orphanedDevices.length) {
    lines.push(`Orphaned devices (${orphanedDevices.length}):`);
    for (const d of orphanedDevices) lines.push(`  ${d.kind} ${d.name} (${d.id})`);
  }

  if (staleDevices.length) {
    lines.push(`Stale owned devices (${staleDevices.length}) - project untouched for ${olderThan ?? '?'}d or more:`);
    for (const d of staleDevices) {
      lines.push(`  ${d.kind} ${d.name} (${d.id})`);
      lines.push(`              ${d.project} (idle ${d.idleDays}d)`);
    }
  }

  if (staleDeviceRecords.length) {
    lines.push(`Stale device records (${staleDeviceRecords.length}) - the device is gone, the project is not:`);
    for (const r of staleDeviceRecords) {
      lines.push(`  ${r.kind} ${r.id} is not on this machine`);
      lines.push(`              recorded by ${r.project}`);
    }
    lines.push('              --delete clears the RECORD only; there is no device left to touch.');
  }

  if (easSessionSweep.orphaned.length) {
    lines.push(`Orphaned EAS sessions (${easSessionSweep.orphaned.length}) - current EAS project only:`);
    for (const session of easSessionSweep.orphaned) {
      const details = [session.platform, session.status].filter(Boolean).join(', ');
      lines.push(`  ${session.name} (${session.id})${details ? ` [${details}]` : ''}`);
      lines.push(`              project scope: ${session.projectScope}`);
      lines.push(`              remedy: eas simulator:stop --id ${session.id}`);
    }
  }

  if (staleLocks.length) {
    lines.push(`Stale build locks (${staleLocks.length}) - the process that was building is gone:`);
    for (const lock of staleLocks) {
      lines.push(`  ${lock.platform} ${shortKey(lock.key)} (pid ${lock.pid ?? '?'} is not running)`);
      lines.push(`              started by ${lock.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  if (staleSlots.length) {
    lines.push(`Stale build slots (${staleSlots.length}) - the process that was building is gone:`);
    for (const slot of staleSlots) {
      lines.push(`  slot ${slot.index ?? '?'} (pid ${slot.pid ?? '?'} is not running)`);
      lines.push(`              held by ${slot.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  if (liveLocks.length) {
    lines.push(`Builds in progress (${liveLocks.length}) - NOT touched, by anything:`);
    for (const lock of liveLocks) {
      lines.push(`  ${lock.platform} ${shortKey(lock.key)} (pid ${lock.pid})`);
      lines.push(`              building in ${lock.projectRoot || 'an unrecorded workspace'}`);
    }
  }

  if (deviceSweepNotices.length) {
    lines.push(`Device sweep notices (${deviceSweepNotices.length}):`);
    for (const notice of deviceSweepNotices) lines.push(`  ${notice}`);
  }

  if (easSessionSweep.notices.length) {
    lines.push(`EAS session sweep notices (${easSessionSweep.notices.length}):`);
    for (const notice of easSessionSweep.notices) lines.push(`  ${notice}`);
  }

  if (skipped.length) {
    lines.push(`Skipped (${skipped.length}) - not classified as dead:`);
    for (const entry of skipped) lines.push(`  ${entry.dir}: ${entry.reason}`);
  }

  if (caches.length) {
    const total = caches.reduce((n, c) => n + (c.bytes ?? 0), 0);
    lines.push(`Shared build caches (${caches.length}) - alive, not garbage:`);
    for (const c of caches) {
      const tag = c.source ? ` (${c.source})` : '';
      lines.push(`  ${formatBytes(c.bytes ?? 0).padStart(10)}  ${c.name}${tag}`);
      lines.push(`              ${c.dir}`);
      if (c.note) lines.push(`              ${c.note}`);
      if (c.willEmpty) lines.push('              --all would EMPTY this cache');
      else if (c.emptySkipped) lines.push(`              --all skips this cache: ${c.emptySkipped}`);
    }
    lines.push(`  total: ${formatBytes(total)}`);
    const doomed = caches.filter((c) => c.willEmpty);
    if (doomed.length) {
      const doomedBytes = doomed.reduce((n, c) => n + (c.bytes ?? 0), 0);
      lines.push(`  --all would empty ${doomed.length} of these (${formatBytes(doomedBytes)})`);
    }
  }

  return lines;
}

function projectLastTouched(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return NaN;
  }
}

function deviceSweepIsScoped(unsafeAllowScopedDeviceSweep?: boolean) {
  return Boolean(process.env.RN_ISO_HOME) && !unsafeAllowScopedDeviceSweep;
}

function cacheSweepIsScoped() {
  return Boolean(process.env.RN_ISO_HOME);
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isInsideConfigDir(dir: string) {
  const root = canonicalPath(getConfigDir());
  const target = canonicalPath(dir);
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function machineGlobalReason(cache: CacheDescriptor): string | null {
  if (!cacheSweepIsScoped()) return null;
  if (cache.source === 'registered') return null;
  if (isInsideConfigDir(cache.dir)) return null;
  return `RN_ISO_HOME scopes this config, but ${cache.dir} is outside it and therefore machine-global`;
}

function planCacheEmptying(caches: CacheDescriptor[], all: boolean): GcCache[] {
  const annotated = caches.map((c) => Object.assign({}, c, { machineGlobal: machineGlobalReason(c) }));
  if (!all) return annotated;
  return annotated.map((c) => {
    if (c.machineGlobal) {
      return Object.assign({}, c, { willEmpty: false, emptySkipped: c.machineGlobal });
    }
    if (!ownsItsDirectory(c)) {
      return Object.assign({}, c, {
        willEmpty: false,
        emptySkipped: `${c.dir} is not a directory this cache owns`,
      });
    }
    return Object.assign({}, c, { willEmpty: true, emptySkipped: null });
  });
}

// A last fail-closed check on the one operation in `gc` that cannot be undone.
// A cache that carries an explicit `files` list does not own its directory --
// Metro's maps live loose in os.tmpdir() alongside everything else's temp
// files -- and a mis-registered `dir` naming a volume root, the user's home,
// the temp dir or the config dir is a typo, never a cache.
function ownsItsDirectory(cache: CacheDescriptor): boolean {
  if (Array.isArray(cache.files)) return false;
  const dir = canonicalPath(cache.dir);
  if (dirname(dir) === dir) return false;
  return ![homedir(), tmpdir(), getConfigDir()].map(canonicalPath).includes(dir);
}

function emptyCache(cache: CacheDescriptor): {
  removed: number;
  bytes: number;
  skipped: string | null;
  failed?: number;
} {
  if (cache.prune !== 'atomic') {
    return pruneCache(cache, { olderThanDays: 0, now: Date.now() + DAY_MS });
  }

  let names: string[];
  try {
    names = readdirSync(cache.dir);
  } catch (e) {
    return { removed: 0, bytes: 0, skipped: `could not read ${cache.dir}: ${(e as Error).message}` };
  }
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    try {
      rmSync(join(cache.dir, name), { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, bytes: failed ? 0 : (cache.bytes ?? 0), failed, skipped: null };
}

export async function collectGcReport(
  {
    olderThan = null,
    all = false,
    now = Date.now(),
    lastTouched = projectLastTouched,
    unsafeAllowScopedDeviceSweep = false,
  }: CollectGcReportOptions = {},
  deps: GcDependencies = {},
): Promise<GcReport> {
  const caches = planCacheEmptying(sizeCaches(discoverCaches({ declared: declaredCachePaths() })), all);

  const mountedVolumes = listMountedVolumes();
  const cfg = loadConfig();
  let easSessionSweep = deps.precollectedEasSessionSweep;
  if (!easSessionSweep) {
    try {
      easSessionSweep = collectEasSessionSweep(cfg, deps);
    } catch (error) {
      easSessionSweep = {
        projectScope: null,
        orphaned: [],
        notices: [`EAS session sweep failed: ${describeError(error)}`],
        deletionSafe: false,
      };
    }
  }
  const deadProjects: string[] = [];
  const skipped: GcSkip[] = [];
  for (const path of Object.keys(cfg?.projects || {})) {
    if (existsSync(path)) continue;
    if (!isOnMountedVolume(path, mountedVolumes)) {
      const volume = volumeRootFor(path);
      skipped.push({ dir: path, reason: `volume ${volume} is not mounted` });
    } else {
      deadProjects.push(path);
    }
  }

  const deviceSweepNotices: string[] = [];
  let orphanedDevices: OrphanedDevice[] = [];
  let staleDevices: StaleProjectDevice[] = [];
  let staleDeviceRecords: StaleDeviceRecord[] = [];

  const unsweepableReason =
    cfg === null
      ? 'no rn-iso config found'
      : deviceSweepIsScoped(unsafeAllowScopedDeviceSweep)
        ? 'RN_ISO_HOME scopes this config, but simulators and AVDs are machine-global'
        : null;

  if (unsweepableReason) {
    let simNames: string[] = [];
    let avdNames: string[] = [];
    try {
      simNames = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }).map((s) => s.name);
    } catch {}
    try {
      avdNames = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {}
    deviceSweepNotices.push(...describeUnverifiableDevices(simNames, avdNames, { reason: unsweepableReason }));
  } else {
    let sims: IosSimRecord[] = [];
    let simsChecked = true;
    try {
      sims = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {
      simsChecked = false;
      deviceSweepNotices.push(
        `ios device sweep skipped: simulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
      );
    }
    let avds: string[] = [];
    let avdsChecked = true;
    try {
      avds = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {
      avdsChecked = false;
      deviceSweepNotices.push(
        `android device sweep skipped: emulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
      );
    }

    const isMounted = (path: string) => isOnMountedVolume(path, mountedVolumes);
    orphanedDevices = findOrphanedDevices({ sims, avds, config: cfg, isMounted, deadProjects }).orphaned;
    staleDeviceRecords = findStaleDeviceRecords({
      config: cfg,
      sims,
      avds,
      deadProjects,
      simsChecked,
      avdsChecked,
    });
    if (olderThan !== null) {
      staleDevices = findStaleProjectDevices({
        config: cfg,
        sims,
        avds,
        olderThanDays: olderThan,
        now,
        lastTouched,
        deadProjects,
      });
    }
  }

  const locks = listBuildLocks();
  const slots = listBuildSlots();

  return {
    skipped,
    deadProjects,
    orphanedDevices,
    staleDevices,
    staleDeviceRecords,
    buildLocks: {
      stale: locks.filter((l) => !l.alive),
      live: locks.filter((l) => l.alive),
    },
    buildSlots: {
      stale: slots.filter((s) => !s.alive),
      live: slots.filter((s) => s.alive),
    },
    deviceSweepNotices,
    easSessionSweep,
    caches,
    olderThan,
    all,
  };
}

export async function runGc(opts: RunGcOptions = {}, deps: GcDependencies = {}): Promise<void> {
  let projectRoot: string | null = null;
  try {
    projectRoot = (deps.findProjectRoot ?? findProjectRoot)(process.cwd());
    if (!projectRoot) {
      return runGcCore(opts, {
        ...deps,
        precollectedEasSessionSweep: {
          projectScope: null,
          orphaned: [],
          notices: ['EAS session sweep skipped: no current project was available before EAS project lock acquisition.'],
          deletionSafe: false,
        },
      });
    }
    if (!(deps.detectIsExpo ?? detectIsExpo)(projectRoot)) {
      return runGcCore(opts, {
        ...deps,
        precollectedEasSessionSweep: {
          projectScope: projectRoot,
          orphaned: [],
          notices: [],
          deletionSafe: true,
        },
      });
    }
  } catch (error) {
    return runGcCore(opts, {
      ...deps,
      precollectedEasSessionSweep: {
        projectScope: projectRoot,
        orphaned: [],
        notices: [
          `EAS session sweep skipped: project classification failed before EAS project lock acquisition: ${describeError(error)}`,
        ],
        deletionSafe: false,
      },
    });
  }
  const withProjectLock = deps.withEasProjectLock ?? withEasProjectLock;
  let sweepStarted = false;
  let easSessionSweep: EasSessionSweep;
  try {
    easSessionSweep = await withProjectLock(
      projectRoot,
      () => {
        sweepStarted = true;
        return withRemoteSessionGcLocks(projectRoot, deps, (coordinatedDeps) =>
          Promise.resolve(collectEasSessionSweep(loadConfig(), coordinatedDeps)),
        );
      },
      { waitMs: 0, ownerPurpose: 'EAS orphan sweep', machineRoot: deps.easLedgerRoot },
    );
  } catch (error) {
    const failure = sweepStarted ? 'EAS collection failed' : 'EAS project lock acquisition failed';
    easSessionSweep = {
      projectScope: projectRoot,
      orphaned: [],
      notices: [`EAS session sweep skipped: ${failure}: ${describeError(error)}`],
      deletionSafe: false,
    };
  }
  return runGcCore(opts, { ...deps, precollectedEasSessionSweep: easSessionSweep });
}

async function runGcCore(opts: RunGcOptions, deps: GcDependencies): Promise<void> {
  const olderThan = typeof opts.olderThan === 'number' ? opts.olderThan : null;
  const all = Boolean(opts.all);
  const report = await collectGcReport(
    {
      olderThan,
      all,
      unsafeAllowScopedDeviceSweep: opts.unsafeAllowScopedDeviceSweep,
    },
    deps,
  );
  for (const line of formatGcReport(report)) console.log(line);

  const {
    deadProjects,
    orphanedDevices,
    staleDevices,
    staleDeviceRecords,
    buildLocks,
    buildSlots,
    easSessionSweep,
    caches,
  } = report;
  const actionable =
    deadProjects.length > 0 ||
    orphanedDevices.length > 0 ||
    staleDevices.length > 0 ||
    staleDeviceRecords.length > 0 ||
    buildLocks.stale.length > 0 ||
    buildSlots.stale.length > 0 ||
    easSessionSweep.orphaned.length > 0 ||
    ((olderThan !== null || all) && caches.length > 0);

  if (!opts.delete) {
    if (all) console.log(chalk.dim('\nDry run. Re-run with --delete --all to empty the caches above.'));
    else if (actionable) console.log(chalk.dim('\nDry run. Re-run with --delete to reclaim.'));
    else if (caches.length) {
      console.log(
        chalk.dim('\nPass --delete --older-than <days> to trim the caches above, or --delete --all to empty them.'),
      );
    }
    return;
  }

  let deleteFailures = 0;
  for (const path of deadProjects) {
    const result = await reclaimProject(path);
    if (result.keptEntry) console.log(chalk.yellow(`Could not fully prune ${path}; its registry entry was kept.`));
    else console.log(chalk.green(`Pruned ${path}`));
    for (const dir of result.removedWorkspaceDirs) console.log(chalk.dim(`  removed workspace output ${dir}`));
    for (const dir of result.failedWorkspaceDirs) {
      console.log(chalk.red(`  could not remove workspace output ${dir}`));
      deleteFailures += 1;
    }
    if (result.killedPid) {
      console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid}`));
    }
    if (result.stoppedSession) {
      console.log(chalk.dim(`  stopped remote session ${result.stoppedSession}`));
    }
    if (result.stoppedTunnel) {
      console.log(chalk.dim(`  stopped ${result.stoppedTunnel} tunnel`));
    }
    for (const s of result.skippedDevices) {
      console.log(chalk.yellow(`  ${s.name}: ${s.reason}`));
    }
  }

  function reap(d: OrphanedDevice | StaleProjectDevice) {
    const r =
      d.kind === 'ios'
        ? teardownOwnedIosSim(d.id, { del: true, label: d.name })
        : teardownOwnedAvd(d.name, { del: true });
    const what = d.kind === 'ios' ? `ios sim ${d.name} (${d.id})` : `android avd ${d.name}`;
    if (r.status === 'torn-down') {
      console.log(chalk.green(`Deleted ${what}`));
    } else if (r.status === 'missing') {
      console.log(chalk.dim(`${what} is already gone; nothing to delete.`));
    } else if (r.status === 'skipped') {
      console.log(chalk.yellow(`Skipped ${what}: ${r.reason} -- left for a later gc`));
    } else {
      deleteFailures++;
      console.log(chalk.red(`Failed to delete ${d.kind} device ${d.name}: ${r.reason}`));
    }
    return r.status;
  }

  for (const d of orphanedDevices) reap(d);

  for (const d of staleDevices) {
    const status = reap(d);
    if (status === 'torn-down' || status === 'missing') {
      clearDevice(d.project, d.kind);
      console.log(chalk.dim(`  cleared the ${d.kind} record for ${d.project}`));
    }
  }

  for (const r of staleDeviceRecords) {
    clearDevice(r.project, r.kind);
    console.log(chalk.green(`Cleared the ${r.kind} record for ${r.project} (${r.id} is not on this machine)`));
  }

  for (const lock of buildLocks.stale) {
    const current = readBuildLock(lock.path);
    if (current?.pid && isPidAlive(current.pid)) continue;
    try {
      rmSync(lock.path, { recursive: true, force: true });
      console.log(
        chalk.green(
          `Cleared the ${lock.platform} build lock left by pid ${lock.pid ?? '?'} (${lock.projectRoot || 'unrecorded workspace'})`,
        ),
      );
    } catch (err) {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the build lock at ${lock.path}: ${(err as Error)?.message || err}`));
    }
  }

  for (const slot of buildSlots.stale) {
    const current = readBuildSlot(slot.path);
    if (current?.pid && isPidAlive(current.pid)) continue;
    try {
      rmSync(slot.path, { recursive: true, force: true });
      console.log(
        chalk.green(
          `Cleared build slot ${slot.index ?? '?'} left by pid ${slot.pid ?? '?'} (${slot.projectRoot || 'unrecorded workspace'})`,
        ),
      );
    } catch (err) {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the build slot at ${slot.path}: ${(err as Error)?.message || err}`));
    }
  }

  if (easSessionSweep.orphaned.length && easSessionSweep.deletionSafe && easSessionSweep.projectScope) {
    const projectScope = easSessionSweep.projectScope;
    const withProjectLock = deps.withEasProjectLock ?? withEasProjectLock;
    let finalSweepStarted = false;
    try {
      await withProjectLock(
        projectScope,
        () => {
          finalSweepStarted = true;
          return withRemoteSessionGcLocks(projectScope, deps, async (lockedDeps) => {
            if (lockedDeps.easSweepBlockedNotice) {
              deleteFailures += easSessionSweep.orphaned.length;
              console.log(chalk.red(`EAS session deletion refused: ${lockedDeps.easSweepBlockedNotice}`));
              return;
            }
            const coordinatedDeps = lockedDeps;
            const currentConfig = loadConfig();
            const currentRoots = easLockRoots(projectScope, currentConfig);
            const registryExpanded =
              coordinatedDeps.easLockedRoots &&
              currentRoots.some((root) => !coordinatedDeps.easLockedRoots!.includes(root));
            const currentRecords = registryExpanded
              ? null
              : readRecordedRemoteSessionIds([...Object.keys(currentConfig?.projects ?? {}), projectScope]);
            const ledgerRoot = coordinatedDeps.easLedgerRoot ?? easMachineStateRoot();
            const ledger = readEasSessionLedger(ledgerRoot);
            const removeClaim = coordinatedDeps.removeEasSessionClaim ?? removeEasSessionClaim;
            const reconcileClaim = (sessionId: string): void => {
              let detail = 'the claim store did not remove it';
              try {
                if (removeClaim(sessionId, ledgerRoot)) return;
              } catch (error) {
                detail = describeError(error);
              }
              deleteFailures++;
              console.log(
                chalk.red(
                  `EAS session ${sessionId} is resolved, but its ownership claim could not be removed: ${detail}. The claim was retained for reconciliation.`,
                ),
              );
            };
            if (registryExpanded) {
              deleteFailures += easSessionSweep.orphaned.length;
              console.log(
                chalk.red('EAS session deletion refused: registered workspace roots changed after classification.'),
              );
            } else if (!currentRecords?.safe || !ledger.safe) {
              deleteFailures += easSessionSweep.orphaned.length;
              for (const notice of [...(currentRecords?.notices ?? []), ...(ledger.notice ? [ledger.notice] : [])]) {
                console.log(chalk.red(`EAS session deletion refused: ${notice}`));
              }
            } else {
              const recorded = new Set(currentRecords.ids);
              const eas = (coordinatedDeps.resolveEasCliBin ?? resolveEasCliBin)(projectScope);
              const run =
                coordinatedDeps.runEasFile ?? ((file, args, options) => getExecutor().runFile(file, args, options));
              for (const session of easSessionSweep.orphaned) {
                if (recorded.has(session.id)) {
                  console.log(chalk.dim(`EAS session ${session.id} has a workspace record and was left running.`));
                  continue;
                }
                const claim = ledger.claims.get(session.id);
                const claimState = claim ? claimStateAbsence(claim) : null;
                if (
                  !claim ||
                  claim.name !== session.name ||
                  claim.platform !== session.platform ||
                  !claimState?.absent ||
                  claimState.notice
                ) {
                  deleteFailures++;
                  console.log(
                    chalk.red(
                      `Could not verify fixed ownership for EAS session ${session.id}: ${claimState?.notice ?? 'the claim is missing, mismatched, or still recorded in workspace state'}.`,
                    ),
                  );
                  continue;
                }
                if (!eas) {
                  deleteFailures++;
                  console.log(chalk.red(`Could not verify EAS session ${session.id}: eas-cli is not available.`));
                  continue;
                }
                const options = {
                  cwd: session.projectScope,
                  timeoutMs: EAS_OPERATION_TIMEOUT_MS,
                  omitEnv: PROXY_CREDENTIAL_ENV,
                };
                let live: string;
                try {
                  live = run(eas.file, getSessionArgs(session.id), options);
                } catch (error) {
                  if (isDefinitiveMissingSessionError(error, session.id)) {
                    console.log(chalk.dim(`EAS session ${session.id} is already gone.`));
                    reconcileClaim(session.id);
                  } else {
                    deleteFailures++;
                    console.log(chalk.red(`Could not verify EAS session ${session.id}: ${describeError(error)}`));
                  }
                  continue;
                }

                const inspection = inspectSessionForTeardown(live, session.id);
                if (inspection.action === 'already-stopped') {
                  console.log(chalk.dim(`EAS session ${session.id} is already stopped (${inspection.status}).`));
                  reconcileClaim(session.id);
                  continue;
                }
                if (inspection.action === 'refused') {
                  deleteFailures++;
                  console.log(chalk.red(`Could not stop EAS session ${session.id}: ${inspection.reason}`));
                  continue;
                }

                let stopped: string;
                try {
                  stopped = run(eas.file, stopSessionArgs(session.id), options);
                } catch (error) {
                  deleteFailures++;
                  console.log(chalk.red(`Could not stop EAS session ${session.id}: ${describeError(error)}`));
                  continue;
                }
                const verified = verifyStoppedSession(stopped, session.id);
                if (!verified.ok) {
                  deleteFailures++;
                  console.log(chalk.red(`Could not verify EAS session ${session.id} stopped: ${verified.reason}`));
                  continue;
                }
                console.log(chalk.green(`Stopped EAS session ${session.id} (${session.name})`));
                reconcileClaim(session.id);
              }
            }
          });
        },
        { waitMs: 0, ownerPurpose: 'EAS orphan deletion', machineRoot: deps.easLedgerRoot },
      );
    } catch (error) {
      deleteFailures += easSessionSweep.orphaned.length;
      const phase = finalSweepStarted ? 'failed' : 'lock acquisition failed';
      console.log(chalk.red(`EAS session deletion ${phase}: ${describeError(error)}`));
    }
  }

  if (deleteFailures) {
    console.log(
      chalk.red(`\n${deleteFailures} entr${deleteFailures === 1 ? 'y' : 'ies'} could not be deleted; see above.`),
    );
  }

  if (all) {
    emptyCaches(caches);
    return;
  }

  if (olderThan === null) {
    if (caches.length) {
      console.log(
        chalk.dim('Shared caches left alone: pass --older-than <days> to trim them, or --all to empty them.'),
      );
    }
    return;
  }

  let cacheBytes = 0;
  for (const c of caches) {
    if (c.machineGlobal) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${c.machineGlobal}`));
      continue;
    }
    const r = pruneCache(c, { olderThanDays: olderThan });
    if (r.skipped) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${r.skipped}`));
    } else if (r.removed) {
      cacheBytes += r.bytes;
      console.log(
        chalk.green(`Trimmed ${c.name}: ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'} (${formatBytes(r.bytes)})`),
      );
    } else {
      console.log(chalk.dim(`${c.name}: nothing older than ${olderThan}d`));
    }
  }

  if (cacheBytes) {
    console.log(
      chalk.dim(
        `Trimmed ${formatBytes(cacheBytes)} of shared cache. The next build that wanted those entries pays to rebuild them.`,
      ),
    );
  }
}

function emptyCaches(caches: GcCache[]) {
  let cacheBytes = 0;
  for (const c of caches) {
    if (!c.willEmpty) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${c.emptySkipped}`));
      continue;
    }
    const r = emptyCache(c);
    if (r.skipped) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${r.skipped}`));
    } else if (r.removed) {
      cacheBytes += r.bytes;
      console.log(
        chalk.green(`Emptied ${c.name}: ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'} (${formatBytes(r.bytes)})`),
      );
    } else {
      console.log(chalk.dim(`${c.name}: already empty`));
    }
    if (r.failed) {
      console.log(chalk.red(`  ${r.failed} entr${r.failed === 1 ? 'y' : 'ies'} in ${c.dir} could not be removed`));
    }
  }
  if (cacheBytes) {
    console.log(
      chalk.dim(
        `Emptied ${formatBytes(cacheBytes)} of shared cache. Every build that wanted any of it now pays to rebuild it.`,
      ),
    );
  }
}

export default function gcCommand(program: Command): void {
  program
    .command('gc')
    .description(
      'Report what rn-iso has left behind: dead project entries, orphaned owned devices and EAS sessions, records of devices that no longer exist, build locks whose builder is gone, and the shared build caches. Reports by default; pass --delete to act.',
    )
    .option('--delete', 'actually prune the reported entries and reap the reported devices')
    .option(
      '--older-than <days>',
      'also reap owned devices whose project has been untouched this long, and trim shared cache entries nothing has used in that time',
      (v: string) => {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || String(n) !== String(v).trim()) {
          throw new InvalidArgumentError('must be a whole number of days, e.g. --older-than 30');
        }
        return n;
      },
    )
    .option(
      '--all',
      'with --delete, empty every shared cache whole rather than trimming it by age -- the only way to clear an index-backed cache. Reaches caches only, never devices or project entries. Caches outside the config dir are refused while RN_ISO_HOME is set.',
    )
    .action(async (opts: RunGcOptions) => {
      await runGc(opts);
    });
}
