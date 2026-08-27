import { type ChildProcess, type SpawnOptions, execFileSync, execSync, spawn } from 'child_process';

interface ExecOptions {
  timeoutMs?: number;
}

// The seam every child_process call in rn-iso goes through. Tests inject a mock
// via setExecutor(); anything outside this module importing child_process
// directly is a bug.
export interface Executor {
  run(cmd: string, opts?: ExecOptions): string;
  runFile(file: string, args?: string[], opts?: ExecOptions): string;
  runQuiet(cmd: string, opts?: ExecOptions): string | null;
  spawn(cmd: string, args?: readonly string[], opts?: SpawnOptions): ChildProcess;
}

// execSync's default maxBuffer (1 MB) is too small for real output on a
// large monorepo -- e.g. `git ls-files --others --ignored --exclude-standard`
// over a repo with a multi-GB node_modules can emit tens of MB. Past the
// limit execSync throws ENOBUFS (run) / SIGTERMs the child (run, still --
// runQuiet only swallows the error, it does not change how the child dies),
// which silently truncates callers like listGitignoredFiles into returning
// nothing. 64 MB comfortably covers that case without letting a truly
// runaway command hang the process indefinitely.
const MAX_BUFFER = 64 * 1024 * 1024;

const defaultExecutor: Executor = {
  // {timeoutMs} is optional and defaults to no timeout, so every existing
  // caller (which passes nothing) is unaffected. When set, it maps to
  // execSync's own `timeout` option: past it, execSync SIGTERMs the child
  // and throws ETIMEDOUT, same as any other command failure. This exists so
  // a caller that must never hang (e.g. `gc`'s report-mode device sweep,
  // which has to return even when the simulator daemon is wedged) can bound
  // the wait instead of blocking forever.
  run(cmd, { timeoutMs } = {}) {
    const opts: Parameters<typeof execSync>[1] = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    return String(execSync(cmd, opts)).trim();
  },
  // No shell, so an argument carrying a space, a quote, or a `$` reaches the
  // program as one literal argument. Use this whenever an argument is a path
  // the user chose rather than a string this codebase composed.
  runFile(file, args = [], { timeoutMs } = {}) {
    const opts: Parameters<typeof execFileSync>[2] = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    if (timeoutMs) opts.timeout = timeoutMs;
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

// Tests inject partial, loosely-typed mocks (a `run` that returns a canned
// string, a `spawn` that returns a fake child); the seam accepts them while
// getExecutor() still hands callers the full strict Executor. This is the one
// place `any` is deliberate: `Partial<Executor>` would force every mock method
// to match the real signature exactly (a `spawn` returning a fake child object,
// a `run` reading only the args it cares about), which defeats the point of a
// test seam. The `as Executor` in setExecutor is the real boundary.
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
