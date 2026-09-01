import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import {
  parseProvisioningProfilePlist,
  parseSigningIdentities,
  profileGate,
  SIGNING_CODES,
  signingGate,
  type ProfileGateResult,
  type ProvisioningProfile,
  type SigningGateResult,
  type SigningIdentity,
  type SigningRefusal,
} from './ios-profile.ts';

export const EMBEDDED_PROFILE = 'embedded.mobileprovision';

const SIGNING_TIMEOUT_MS = 120_000;

function lastLines(text: unknown, count = 5): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-count);
}

function errorText(error: unknown): string {
  const withOutput = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = String(withOutput?.stderr ?? '').trim();
  const stdout = String(withOutput?.stdout ?? '').trim();
  return stderr || stdout || String(withOutput?.message ?? error);
}

export interface EmbeddedProfileRead {
  present: boolean;
  profile: ProvisioningProfile | null;
}

export function readEmbeddedProfile(
  appPath: string,
  { exec = null }: { exec?: Executor | null } = {},
): EmbeddedProfileRead {
  const executor = exec || getExecutor();
  const path = join(appPath, EMBEDDED_PROFILE);
  if (!existsSync(path)) return { present: false, profile: null };
  try {
    const plist = executor.runFile('security', ['cms', '-D', '-i', path], { timeoutMs: SIGNING_TIMEOUT_MS });
    return { present: true, profile: parseProvisioningProfilePlist(plist) };
  } catch {
    return { present: true, profile: null };
  }
}

export function findSigningIdentities({ exec = null }: { exec?: Executor | null } = {}): SigningIdentity[] {
  const executor = exec || getExecutor();
  try {
    return parseSigningIdentities(
      executor.runFile('security', ['find-identity', '-v', '-p', 'codesigning'], { timeoutMs: SIGNING_TIMEOUT_MS }),
    );
  } catch {
    return [];
  }
}

export interface SigningGateOptions {
  appPath: string;
  udid: string | null;
  configuration?: string | null;
  pinnedName?: string | null;
  pinnedSha1?: string | null;
  now?: number;
  exec?: Executor | null;
}

export function gateProfileForDevice(options: SigningGateOptions): ProfileGateResult {
  const read = readEmbeddedProfile(options.appPath, { exec: options.exec ?? null });
  return profileGate({
    profilePresent: read.present,
    profile: read.profile,
    identities: [],
    udid: options.udid,
    configuration: options.configuration ?? null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function gateAppForDevice(options: SigningGateOptions): SigningGateResult {
  const read = readEmbeddedProfile(options.appPath, { exec: options.exec ?? null });
  return signingGate({
    profilePresent: read.present,
    profile: read.profile,
    identities: read.present ? findSigningIdentities({ exec: options.exec ?? null }) : [],
    udid: options.udid,
    configuration: options.configuration ?? null,
    pinnedName: options.pinnedName ?? null,
    pinnedSha1: options.pinnedSha1 ?? null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export type ResealMode = 'preserve-metadata' | 'entitlements' | 'no-entitlements';

export interface ResealSuccess {
  ok: true;
  identity: SigningIdentity;
  mode: ResealMode;
}

export interface ResealFailure extends SigningRefusal {
  lastLines: string[];
}

export type ResealResult = ResealSuccess | ResealFailure;

function extractEntitlements(appPath: string, executor: Executor): string {
  try {
    return String(
      executor.runFile('codesign', ['-d', '--entitlements', '-', '--xml', appPath], { timeoutMs: SIGNING_TIMEOUT_MS }),
    ).trim();
  } catch {
    return '';
  }
}

export function resealBundle({
  appPath,
  identity,
  exec = null,
}: {
  appPath: string;
  identity: SigningIdentity;
  exec?: Executor | null;
}): ResealResult {
  const executor = exec || getExecutor();
  const signAs = identity.sha1 || identity.name;
  let mode: ResealMode = 'preserve-metadata';
  let preserveError: unknown = null;
  try {
    executor.runFile(
      'codesign',
      ['--force', '--sign', signAs, '--preserve-metadata=identifier,entitlements,flags,runtime', appPath],
      { timeoutMs: SIGNING_TIMEOUT_MS },
    );
  } catch (error) {
    preserveError = error;
  }

  let tempDir: string | null = null;
  if (preserveError) {
    const entitlements = extractEntitlements(appPath, executor);
    const args = ['--force', '--sign', signAs];
    if (entitlements !== '') {
      tempDir = mkdtempSync(join(tmpdir(), 'stim-entitlements-'));
      const plist = join(tempDir, 'entitlements.plist');
      writeFileSync(plist, `${entitlements}\n`, 'utf-8');
      args.push('--entitlements', plist);
      mode = 'entitlements';
    } else {
      mode = 'no-entitlements';
    }
    args.push(appPath);
    try {
      executor.runFile('codesign', args, { timeoutMs: SIGNING_TIMEOUT_MS });
    } catch (error) {
      return {
        ok: false,
        code: SIGNING_CODES.codesignFailed,
        reason: `codesign could not re-seal ${appPath} with "${identity.name}": ${errorText(error)}`,
        remedy: `Unlock the login keychain (\`security unlock-keychain\`) and confirm exactly one identity matches "${identity.name}".`,
        lastLines: [...lastLines(errorText(preserveError)), ...lastLines(errorText(error))],
      };
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
  }

  try {
    executor.runFile('codesign', ['--verify', '--strict', appPath], { timeoutMs: SIGNING_TIMEOUT_MS });
  } catch (error) {
    return {
      ok: false,
      code: SIGNING_CODES.codesignFailed,
      reason: `codesign --verify --strict rejected ${appPath} after re-sealing it with "${identity.name}": ${errorText(error)}`,
      remedy:
        'The bundle signed but did not seal. Delete the cached artifact with `stim gc --delete` and build fresh, then retry.',
      lastLines: lastLines(errorText(error)),
    };
  }

  return { ok: true, identity, mode };
}

export function sealAppForDevice(options: SigningGateOptions): ResealResult {
  const gate = gateAppForDevice(options);
  if (!gate.ok) return { ...gate, lastLines: [] };
  return resealBundle({ appPath: options.appPath, identity: gate.identity, exec: options.exec ?? null });
}
