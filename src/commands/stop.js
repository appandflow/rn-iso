// src/commands/stop.js
import chalk from 'chalk';
import { findProjectRoot } from '../project.js';
import { getProject, setMetro } from '../config.js';
import { killMetroByPid } from '../metro.js';
import { getExecutor } from '../exec.js';

export default function stopCommand(program) {
  program
    .command('stop')
    .description('Kill the Metro process for the current project')
    .action(() => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project.'));
        process.exit(1);
      }
      const proj = getProject(root);
      if (!proj?.metroPort) {
        console.log(chalk.dim('No Metro port assigned to this project.'));
        return;
      }

      // Try the recorded PID first (Metro spawned by `rn-iso start`).
      // If not set or stale, look up by port (Metro spawned by the build CLI).
      let pid = proj.metroPid;
      if (!pid || !killMetroByPid(pid)) {
        pid = findPidListeningOnPort(proj.metroPort);
        if (!pid) {
          console.log(chalk.dim(`No Metro process found on port ${proj.metroPort}.`));
          if (proj.metroPid) setMetro(root, proj.metroPort, null);
          return;
        }
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          console.log(chalk.dim(`Could not kill pid ${pid}.`));
          return;
        }
      }
      setMetro(root, proj.metroPort, null);
      console.log(chalk.green(`Killed Metro pid ${pid} on port ${proj.metroPort}`));
    });
}

function findPidListeningOnPort(port) {
  const out = getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
  if (!out) return null;
  const pid = parseInt(out.split('\n')[0], 10);
  return Number.isFinite(pid) ? pid : null;
}
