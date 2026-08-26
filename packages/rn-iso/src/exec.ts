import { type ChildProcess, type SpawnOptions, execFileSync, execSync, spawn } from 'child_process';

interface ExecOptions {
  timeoutMs?: number;
  // The working directory the child runs in. Needed by anything whose
  // arguments are RELATIVE to a directory this codebase staged -- `zip -0 -r
  // <apk> assets` writes archive entries at paths relative to the cwd, which
  // is the whole mechanism engine/apk-swap.js uses to put the bundle back at
  // assets/index.android.bundle -- and by a tool that resolves its target from
  // the working directory with no positional for it, which is how `eas sim`
  // finds the project (unlike `expo config --json <root>`). Unset means
  // "inherit", exactly as before.
  cwd?: string;
  // Extra variables for the child, MERGED over process.env rather than
  // replacing it -- a child handed a bare env loses PATH and cannot find the
  // tools it shells out to itself. This exists so a credential can be handed
  // to one child process without being written anywhere: the remote device
  // passes AGENT_DEVICE_DAEMON_AUTH_TOKEN this way.
  env?: Record<string, string>;
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
  // No shell, so an argument carrying a space, a quote, or a `$` reaches the
  // program as one literal argument. Use this whenever an argument is a path
  // the user chose rather than a string this codebase composed.
  runFile(file, args = [], { timeoutMs, cwd, env } = {}) {
    const opts: Parameters<typeof execFileSync>[2] = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    if (cwd) opts.cwd = cwd;
    if (env) opts.env = { ...process.env, ...env };
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
