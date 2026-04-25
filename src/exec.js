import { execSync, spawn } from 'child_process';

const defaultExecutor = {
  run(cmd) {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
