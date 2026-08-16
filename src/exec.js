import { execSync, spawn } from 'child_process';

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
  run(cmd) {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER }).trim();
  },
  runQuiet(cmd) {
    try {
      return this.run(cmd);
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
