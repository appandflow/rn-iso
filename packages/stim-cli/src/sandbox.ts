import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export type Harness = 'claude' | 'codex';

type AllowanceValue = readonly string[] | true;

export const SANDBOX_ALLOWANCE: Readonly<Record<string, AllowanceValue>> = {
  'sandbox.filesystem.allowWrite': ['~/.stim'],
  'sandbox.network.allowMachLookup': ['com.apple.coresimulator.*'],
  'sandbox.network.allowLocalBinding': true,
};

export const CLAUDE_LOCAL_SETTINGS: string = join('.claude', 'settings.local.json');

export const CODEX_REFUSAL =
  "Codex has one sandbox setting rather than a per-path allowance: sandbox_mode is read-only, workspace-write, or danger-full-access. workspace-write still refuses STIM_HOME, so danger-full-access is the only value that clears it. Turning a sandbox off wholesale is the user's call, not a tool's, so Stim writes nothing here.";

function allowanceLine(key: string, width: number): string {
  const value = SANDBOX_ALLOWANCE[key];
  const rendered = value === true ? 'true' : JSON.stringify(value);
  return `${key.padEnd(width)} ${rendered}`;
}

export function sandboxAllowanceLines(): string[] {
  const keys = Object.keys(SANDBOX_ALLOWANCE);
  const width = Math.max(...keys.map((k) => k.length));
  return keys.map((key) => allowanceLine(key, width));
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

export function detectHarness({
  env = process.env,
  home = homedir(),
  exists = existsSync,
}: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
} = {}): Harness | null {
  if (nonEmpty(env.CLAUDECODE) || nonEmpty(env.CLAUDE_CODE_ENTRYPOINT)) return 'claude';
  if (Object.keys(env).some((key) => key.startsWith('CODEX_') && nonEmpty(env[key]))) return 'codex';
  if (exists(join(home, '.codex', 'config.toml'))) return 'codex';
  return null;
}

export function claudeSettingsPaths(projectRoot: string, home: string = homedir()): string[] {
  return [
    join(projectRoot, CLAUDE_LOCAL_SETTINGS),
    join(projectRoot, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.json'),
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueAt(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function carries(actual: unknown, wanted: AllowanceValue): boolean {
  if (wanted === true) return actual === true;
  return Array.isArray(actual) && wanted.every((entry) => actual.includes(entry));
}

export function sandboxAllowanceSatisfied(settings: readonly unknown[]): boolean {
  return Object.entries(SANDBOX_ALLOWANCE).every(([key, wanted]) =>
    settings.some((source) => carries(valueAt(source, key.split('.')), wanted)),
  );
}

export function readClaudeSettings(paths: readonly string[], read: typeof readFileSync = readFileSync): unknown[] {
  const parsed: unknown[] = [];
  for (const path of paths) {
    let raw: string;
    try {
      raw = read(path, 'utf-8') as string;
    } catch {
      continue;
    }
    try {
      parsed.push(JSON.parse(raw));
    } catch {}
  }
  return parsed;
}

export type SandboxMerge =
  | { ok: true; changed: boolean; content: string; added: string[] }
  | { ok: false; reason: string };

export function mergeSandboxAllowance(source: string | null): SandboxMerge {
  let root: Record<string, unknown> = {};
  if (source !== null && source.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      return { ok: false, reason: `it is not valid JSON: ${(error as Error).message}` };
    }
    if (!isPlainObject(parsed)) return { ok: false, reason: 'its top level is not a JSON object' };
    root = structuredClone(parsed);
  }

  const added: string[] = [];
  for (const [key, wanted] of Object.entries(SANDBOX_ALLOWANCE)) {
    const path = key.split('.');
    const leaf = path[path.length - 1] as string;
    let container = root;
    for (let depth = 0; depth < path.length - 1; depth++) {
      const segment = path[depth] as string;
      const next = container[segment];
      if (next === undefined) {
        const created: Record<string, unknown> = {};
        container[segment] = created;
        container = created;
        continue;
      }
      if (!isPlainObject(next)) {
        return { ok: false, reason: `${path.slice(0, depth + 1).join('.')} is not an object` };
      }
      container = next;
    }

    const current = container[leaf];
    if (wanted === true) {
      if (current !== undefined && typeof current !== 'boolean') {
        return { ok: false, reason: `${key} is not a boolean` };
      }
      if (current !== true) {
        container[leaf] = true;
        added.push(key);
      }
      continue;
    }
    if (current !== undefined && !Array.isArray(current)) {
      return { ok: false, reason: `${key} is not an array` };
    }
    const list = (current as unknown[] | undefined) ?? [];
    const missing = wanted.filter((entry) => !list.includes(entry));
    if (missing.length === 0) continue;
    container[leaf] = [...list, ...missing];
    added.push(key);
  }

  return { ok: true, changed: added.length > 0, content: `${JSON.stringify(root, null, 2)}\n`, added };
}

export interface SandboxFix {
  harness: Harness | null;
  applied: boolean;
  path: string | null;
  message: string;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function applySandboxAllowance({
  projectRoot,
  harness,
  write = writeAtomic,
  read = readFileSync,
}: {
  projectRoot: string;
  harness: Harness | null;
  write?: (path: string, content: string) => void;
  read?: typeof readFileSync;
}): SandboxFix {
  if (harness === null) {
    return {
      harness,
      applied: false,
      path: null,
      message:
        'No sandboxing harness is in this environment, so there is nothing to apply. The allowance only means something to a harness that sandboxes shell commands.',
    };
  }
  if (harness === 'codex') {
    return { harness, applied: false, path: null, message: CODEX_REFUSAL };
  }

  const path = join(projectRoot, CLAUDE_LOCAL_SETTINGS);
  let source: string | null = null;
  try {
    source = read(path, 'utf-8') as string;
  } catch {
    source = null;
  }

  const merged = mergeSandboxAllowance(source);
  if (!merged.ok) {
    return {
      harness,
      applied: false,
      path,
      message: `Refusing to write ${path}: ${merged.reason}. Nothing was changed. Repair the file, or add the three keys by hand.`,
    };
  }
  if (!merged.changed) {
    return {
      harness,
      applied: false,
      path,
      message: `${path} already carries the sandbox allowance. Nothing to write.`,
    };
  }

  write(path, merged.content);
  return {
    harness,
    applied: true,
    path,
    message: `Wrote the sandbox allowance into ${path} (${merged.added.join(', ')}). Every other key in that file is untouched, and the committed .claude/settings.json is never written. Restart the harness session for it to take effect.`,
  };
}
