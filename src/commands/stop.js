// src/commands/stop.js
import chalk from 'chalk';
import { resolveRegisteredProject } from '../project.js';
import { loadConfig, getProject, setMetro } from '../config.js';
import { killMetroByPid } from '../metro.js';
import { getExecutor } from '../exec.js';

export default function stopCommand(program) {
  program
    .command('stop [target]')
    .description('Kill Metro. With no arg, stops the current project. Pass a port (e.g. 8083), a project shortcut (label or unique basename), or an absolute path.')
    .action((target) => {
      // Numeric -> kill whatever's on that port.
      if (target && /^\d+$/.test(target)) {
        return killByPort(parseInt(target, 10));
      }

      const { found, error } = resolveRegisteredProject(target);
      if (!found) {
        console.error(chalk.red(error));
        process.exit(1);
      }
      const proj = getProject(found);
      if (!proj?.metroPort) {
        console.log(chalk.dim(`No Metro port assigned to ${found}.`));
        return;
      }
      killForProject(found, proj);
    });
}

function killForProject(root, proj) {
  const port = proj.metroPort;
  let pid = proj.metroPid;
  if (!pid || !killMetroByPid(pid)) {
    pid = findPidListeningOnPort(port);
    if (!pid) {
      console.log(chalk.dim(`No Metro process found on port ${port}.`));
      if (proj.metroPid) setMetro(root, port, null);
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      console.log(chalk.dim(`Could not kill pid ${pid}.`));
      return;
    }
  }
  setMetro(root, port, null);
  console.log(chalk.green(`Killed Metro pid ${pid} on port ${port} (${root})`));
}

function killByPort(port) {
  const pid = findPidListeningOnPort(port);
  if (!pid) {
    console.log(chalk.dim(`No process listening on port ${port}.`));
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    console.log(chalk.dim(`Could not kill pid ${pid}: ${e.message}`));
    return;
  }
  console.log(chalk.green(`Killed pid ${pid} on port ${port}`));

  // If a project owned this port, clear its recorded pid so `status` reflects.
  const cfg = loadConfig();
  for (const [path, proj] of Object.entries(cfg?.projects || {})) {
    if (proj.metroPort === port) {
      setMetro(path, port, null);
      console.log(chalk.dim(`Cleared metroPid for ${path}`));
      break;
    }
  }
}

function findPidListeningOnPort(port) {
  const out = getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
  if (!out) return null;
  const pid = parseInt(out.split('\n')[0], 10);
  return Number.isFinite(pid) ? pid : null;
}
