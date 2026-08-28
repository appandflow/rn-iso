import { type ChildProcess, type SpawnOptions, execFileSync, execSync, spawn } from 'child_process';

interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
}

export interface Executor {
  run(cmd: string, opts?: ExecOptions): string;
  runFile(file: string, args?: string[], opts?: ExecOptions): string;
  runQuiet(cmd: string, opts?: ExecOptions): string | null;
  spawn(cmd: string, args?: readonly string[], opts?: SpawnOptions): ChildProcess;
}

const MAX_BUFFER = 64 * 1024 * 1024;

const defaultExecutor: Executor = {
  run(cmd, { timeoutMs, cwd } = {}) {
    const opts: Parameters<typeof execSync>[1] = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    if (cwd) opts.cwd = cwd;
    return String(execSync(cmd, opts)).trim();
  },
  runFile(file, args = [], { timeoutMs, cwd } = {}) {
    const opts: Parameters<typeof execFileSync>[2] = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    if (cwd) opts.cwd = cwd;
    return String(execFileSync(file, args, opts)).trim();
  },
  runQuiet(cmd, opts) {
    try {
      return this.run(cmd, opts);
    } catch {
      return null;
    }
  },
  spawn(cmd, args = [], opts = {}) {
    return spawn(cmd, args, opts);
  },
};

// oxlint-disable-next-line typescript/no-explicit-any
export type MockExecutor = { [K in keyof Executor]?: (...args: any[]) => any };

let active: Executor = defaultExecutor;

export function setExecutor(e: MockExecutor): void {
  active = e as Executor;
}

export function resetExecutor(): void {
  active = defaultExecutor;
}

export function getExecutor(): Executor {
  return active;
}
