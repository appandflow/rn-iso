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
  // Variables removed from the effective child environment after inherited
  // and extra variables are combined.
  omitEnv?: readonly string[];
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
  // No shell, so an argument carrying a space, a quote, or a `$` reaches the
  // program as one literal argument. Use this whenever an argument is a path
  // the user chose rather than a string this codebase composed.
  runFile(file, args = [], { timeoutMs, cwd, env, omitEnv } = {}) {
    const opts: Parameters<typeof execFileSync>[2] = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    if (cwd) opts.cwd = cwd;
    if (env || omitEnv?.length) {
      const childEnv = { ...process.env, ...env };
      for (const key of omitEnv ?? []) delete childEnv[key];
      opts.env = childEnv;
    }
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
