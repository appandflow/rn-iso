import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { Finding } from './doctor.ts';

export type Harness = 'claude-code' | 'codex' | null;

export interface SandboxAllowance {
  allowWrite: string[];
  allowMachLookup: string[];
  allowLocalBinding: boolean;
}

/**
 * What a sandboxed harness has to permit for Stim to work: its state
 * directory, the XPC service simctl talks to, and the port adb's server binds.
 */
export function sandboxAllowance(stimHome: string = '~/.stim'): SandboxAllowance {
  return {
    allowWrite: [stimHome],
    allowMachLookup: ['com.apple.coresimulator.*'],
    allowLocalBinding: true,
  };
}

export function detectHarness(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Harness {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  if (existsSync(join(home, '.codex', 'config.toml'))) return 'codex';
  return null;
}

/** Where a per-user, gitignored Claude Code settings file belongs for this project. */
export function claudeLocalSettingsPath(root: string): string {
  return join(root, '.claude', 'settings.local.json');
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nested(source: Record<string, unknown> | null, ...keys: string[]): unknown {
  let cursor: unknown = source;
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Which parts of the allowance the settings files already carry. Any file may
 * supply any part, so a project that solved this in one place is not asked to
 * repeat it in another.
 */
export function missingAllowance(paths: string[], stimHome: string = '~/.stim'): string[] {
  const files = paths.map(readJson);
  const writes = files.flatMap((f) => {
    const value = nested(f, 'sandbox', 'filesystem', 'allowWrite');
    return Array.isArray(value) ? value.map(String) : [];
  });
  const lookups = files.flatMap((f) => {
    const value = nested(f, 'sandbox', 'network', 'allowMachLookup');
    return Array.isArray(value) ? value.map(String) : [];
  });
  const binding = files.some((f) => nested(f, 'sandbox', 'network', 'allowLocalBinding') === true);

  const missing: string[] = [];
  const home = stimHome.replace(/\/+$/, '');
  const bare = home.replace(/^~\//, '');
  if (!writes.some((w) => w.replace(/\/+$/, '').replace(/^~\//, '') === bare)) {
    missing.push('sandbox.filesystem.allowWrite');
  }
  if (!lookups.some((l) => l.startsWith('com.apple.coresimulator'))) missing.push('sandbox.network.allowMachLookup');
  if (!binding) missing.push('sandbox.network.allowLocalBinding');
  return missing;
}

/** Merge the allowance into a settings object, leaving everything else as it is. */
export function withAllowance(settings: Record<string, unknown>, allowance: SandboxAllowance): Record<string, unknown> {
  const next = { ...settings };
  const sandbox = { ...(next.sandbox as Record<string, unknown> | undefined) };
  const filesystem = { ...(sandbox.filesystem as Record<string, unknown> | undefined) };
  const network = { ...(sandbox.network as Record<string, unknown> | undefined) };

  const writes = Array.isArray(filesystem.allowWrite) ? filesystem.allowWrite.map(String) : [];
  const lookups = Array.isArray(network.allowMachLookup) ? network.allowMachLookup.map(String) : [];

  filesystem.allowWrite = [...new Set([...writes, ...allowance.allowWrite])];
  network.allowMachLookup = [...new Set([...lookups, ...allowance.allowMachLookup])];
  network.allowLocalBinding = true;

  sandbox.filesystem = filesystem;
  sandbox.network = network;
  next.sandbox = sandbox;
  return next;
}

/** Write the allowance into a Claude Code local settings file, creating it if needed. */
export function applyClaudeAllowance(path: string, allowance: SandboxAllowance): { created: boolean } {
  const existing = readJson(path);
  const created = existing === null && !existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(withAllowance(existing ?? {}, allowance), null, 2)}\n`);
  return { created };
}

/**
 * The finding a sandboxed session should see: what fails, and the one command
 * that fixes it where the harness has a per-path allowance.
 */
export function sandboxFinding(
  settingsRoot: string,
  {
    env = process.env,
    home = homedir(),
    stimHome = process.env.STIM_HOME || '~/.stim',
  }: { env?: NodeJS.ProcessEnv; home?: string; stimHome?: string } = {},
): Finding | null {
  const harness = detectHarness(env, home);
  if (!harness) return null;

  const symptoms = `Writes to ${stimHome} raise EPERM on a directory you can write, the simulator service looks dead, and the adb server looks unreachable.`;
  const title = 'This session sandboxes shell commands, and Stim is not allowed through';

  if (harness === 'codex') {
    return {
      level: 'cost',
      title,
      detail: `${symptoms} Codex has one sandbox setting and no per-path allowance, so there is nothing to add.`,
      fix: 'Run Stim with the sandbox off, or start Codex with `codex -s danger-full-access`, which turns the whole sandbox off rather than allowing these three. See `stim guide errors`.',
    };
  }

  const local = claudeLocalSettingsPath(settingsRoot);
  const missing = missingAllowance(
    [local, join(settingsRoot, '.claude', 'settings.json'), join(home, '.claude', 'settings.json')],
    stimHome,
  );
  if (missing.length === 0) return null;
  return {
    level: 'cost',
    title,
    detail: `${symptoms} Missing: ${missing.join(', ')}.`,
    fix: `Run \`stim doctor --fix\` to add them to ${local}, or add them by hand. See \`stim guide errors\`.`,
  };
}
