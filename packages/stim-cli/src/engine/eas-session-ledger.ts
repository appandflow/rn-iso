import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { withDirLock } from '../dir-lock.ts';
import { workspaceName } from '../paths.ts';

export interface EasSessionClaim {
  sessionId: string;
  name: string;
  platform: 'ios' | 'android';
  workspaceRoot: string;
  workspaceHome: string;
  stateFile: string;
}

interface EasSessionLedger {
  version: 1;
  claims: Record<string, EasSessionClaim>;
}

export interface EasSessionLedgerRead {
  claims: Map<string, EasSessionClaim>;
  notice: string | null;
  safe: boolean;
}

export function easMachineStateRoot(): string {
  return join(homedir(), '.stim', 'machine', 'eas');
}

function easSessionLedgerFile(root: string = easMachineStateRoot()): string {
  return join(root, 'sessions.json');
}

function validClaim(id: string, value: unknown): EasSessionClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const claim = value as Partial<EasSessionClaim>;
  if (claim.sessionId !== id) return null;
  if (typeof claim.name !== 'string' || !claim.name.startsWith('stim-')) return null;
  if (claim.platform !== 'ios' && claim.platform !== 'android') return null;
  if (typeof claim.workspaceRoot !== 'string' || !isAbsolute(claim.workspaceRoot)) return null;
  if (typeof claim.workspaceHome !== 'string' || !isAbsolute(claim.workspaceHome)) return null;
  if (typeof claim.stateFile !== 'string' || !isAbsolute(claim.stateFile)) return null;
  const workspaceRoot = resolve(claim.workspaceRoot);
  const workspaceHome = resolve(claim.workspaceHome);
  const stateFile = resolve(claim.stateFile);
  const stateRelative = relative(workspaceHome, stateFile);
  if (!stateRelative || stateRelative.startsWith('..') || isAbsolute(stateRelative)) return null;
  if (stateFile !== join(workspaceHome, 'workspaces', workspaceName(workspaceRoot), 'state.json')) return null;
  return {
    sessionId: id,
    name: claim.name,
    platform: claim.platform,
    workspaceRoot,
    workspaceHome,
    stateFile,
  };
}

export function readEasSessionLedger(root: string = easMachineStateRoot()): EasSessionLedgerRead {
  const file = easSessionLedgerFile(root);
  if (!existsSync(file)) return { claims: new Map(), notice: null, safe: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
  } catch (error) {
    return {
      claims: new Map(),
      notice: `EAS ownership ledger ${file} is unreadable: ${(error as Error).message}`,
      safe: false,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { claims: new Map(), notice: `EAS ownership ledger ${file} is malformed.`, safe: false };
  }
  const ledger = parsed as { version?: unknown; claims?: unknown };
  if (ledger.version !== 1 || !ledger.claims || typeof ledger.claims !== 'object' || Array.isArray(ledger.claims)) {
    return { claims: new Map(), notice: `EAS ownership ledger ${file} is malformed.`, safe: false };
  }
  const claims = new Map<string, EasSessionClaim>();
  for (const [id, value] of Object.entries(ledger.claims)) {
    const claim = validClaim(id, value);
    if (!claim) return { claims: new Map(), notice: `EAS ownership ledger ${file} is malformed.`, safe: false };
    claims.set(id, claim);
  }
  return { claims, notice: null, safe: true };
}

function writeLedger(root: string, ledger: EasSessionLedger): void {
  mkdirSync(root, { recursive: true });
  const file = easSessionLedgerFile(root);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function recordEasSessionClaim(claim: EasSessionClaim, root: string = easMachineStateRoot()): void {
  const normalized = validClaim(claim.sessionId, claim);
  if (!normalized) throw new Error(`Invalid EAS session claim for ${claim.sessionId}.`);
  withDirLock(
    join(root, 'ledger.lock'),
    () => {
      const current = readEasSessionLedger(root);
      if (!current.safe) throw new Error(current.notice ?? 'EAS ownership ledger is unreadable.');
      current.claims.set(normalized.sessionId, normalized);
      writeLedger(root, { version: 1, claims: Object.fromEntries(current.claims) });
    },
    { ensureParent: () => mkdirSync(dirname(join(root, 'ledger.lock')), { recursive: true }) },
  );
}

export function removeEasSessionClaim(sessionId: string, root: string = easMachineStateRoot()): boolean {
  const file = easSessionLedgerFile(root);
  if (!existsSync(file)) return false;
  return withDirLock(join(root, 'ledger.lock'), () => {
    const current = readEasSessionLedger(root);
    if (!current.safe) return false;
    if (!current.claims.delete(sessionId)) return false;
    writeLedger(root, { version: 1, claims: Object.fromEntries(current.claims) });
    return true;
  });
}
