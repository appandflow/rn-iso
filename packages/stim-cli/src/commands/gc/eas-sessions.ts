import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import chalk from 'chalk';
import { loadConfig } from '../../config.ts';
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
} from '../../engine/eas-simulator.ts';
import { resolveEasCliBin } from '../../engine/remote-cache.ts';
import { getExecutor } from '../../exec.ts';
import { detectIsExpo, findProjectRoot } from '../../project.ts';
import { workspaceDir, workspaceStateFile } from '../../paths.ts';
import { withRemoteSessionLock } from '../../engine/device-remote.ts';
import { withEasProjectLock } from '../../engine/eas-project-lock.ts';
import {
  easMachineStateRoot,
  readEasSessionLedger,
  removeEasSessionClaim,
  type EasSessionClaim,
} from '../../engine/eas-session-ledger.ts';
import type { Config } from '../../types.ts';
import { canonicalPath } from './paths.ts';

export interface EasSessionSweep {
  projectScope: string | null;
  orphaned: ScopedSessionSummary[];
  notices: string[];
  deletionSafe: boolean;
}

export interface EasGcDependencies {
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

const EAS_OPERATION_TIMEOUT_MS = 30000;
const EAS_COLLECTION_TIMEOUT_MS = 60000;
const EAS_MAX_LIST_PAGES = 100;
const EAS_LOCK_WAIT_MS = 0;
const EAS_LOCK_SNAPSHOT_RETRIES = 3;
const PROXY_CREDENTIAL_ENV = ['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_DAEMON_AUTH_TOKEN'] as const;

export function describeError(error: unknown): string {
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

export function collectEasSessionSweep(config: Config | null, deps: EasGcDependencies): EasSessionSweep {
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

export async function withRemoteSessionGcLocks<T>(
  projectRoot: string,
  deps: EasGcDependencies,
  fn: (coordinatedDeps: EasGcDependencies) => Promise<T>,
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

export async function deleteEasSessions(easSessionSweep: EasSessionSweep, deps: EasGcDependencies): Promise<number> {
  let deleteFailures = 0;
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

  return deleteFailures;
}
