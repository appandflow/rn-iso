import { execFileSync, execSync, spawn } from 'child_process';

// execSync's default maxBuffer (1 MB) is too small for real output on a
// large monorepo -- e.g. `git ls-files --others --ignored --exclude-standard`
// over a repo with a multi-GB node_modules can emit tens of MB. Past the
// limit execSync throws ENOBUFS (run) / SIGTERMs the child (run, still --
// runQuiet only swallows the error, it does not change how the child dies),
// which silently truncates callers like listGitignoredFiles into returning
// nothing. 64 MB comfortably covers that case without letting a truly
// runaway command hang the process indefinitely.
const MAX_BUFFER = 64 * 1024 * 1024;

const defaultExecutor = {
  // {timeoutMs} is optional and defaults to no timeout, so every existing
  // caller (which passes nothing) is unaffected. When set, it maps to
  // execSync's own `timeout` option: past it, execSync SIGTERMs the child
  // and throws ETIMEDOUT, same as any other command failure. This exists so
  // a caller that must never hang (e.g. `gc`'s report-mode device sweep,
  // which has to return even when the simulator daemon is wedged) can bound
  // the wait instead of blocking forever.
  run(cmd, { timeoutMs } = {}) {
    const opts = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER };
    if (timeoutMs) opts.timeout = timeoutMs;
    return execSync(cmd, opts).trim();
  },
  // No shell, so an argument carrying a space, a quote, or a `$` reaches the
  // program as one literal argument. Use this whenever an argument is a path
  // the user chose rather than a string this codebase composed.
  runFile(file, args = [], { timeoutMs } = {}) {
    const opts = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER };
    if (timeoutMs) opts.timeout = timeoutMs;
    return execFileSync(file, args, opts).trim();
  },
  runQuiet(cmd, opts) {
    try {
      return this.run(cmd, opts);
    } catch {
      return null;
    }
  },
  spawn(cmd, args, opts) {
    return spawn(cmd, args, opts);
  },
};

let active = defaultExecutor;

export function setExecutor(e) {
  active = e;
}

export function resetExecutor() {
  active = defaultExecutor;
}

export function getExecutor() {
  return active;
}
