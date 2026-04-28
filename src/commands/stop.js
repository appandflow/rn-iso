// src/commands/stop.js
import chalk from 'chalk';
import { findProjectRoot, resolveRegisteredProject } from '../project.js';
import { loadConfig, getProject, setMetro } from '../config.js';
import { killMetroByPid } from '../metro.js';
import { getExecutor } from '../exec.js';

export default function stopCommand(program) {
  program
    .command('stop [target]')
    .description('Kill Metro. With no arg, stops the current project. Pass a port number (e.g. 8083), a project basename (must be unique), or an absolute project path.')
    .action((target) => {
      if (!target) {
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
        return killForProject(root, proj);
      }

      // Numeric -> port.
      if (/^\d+$/.test(target)) {
        return killByPort(parseInt(target, 10));
      }

      // Path (or basename, if no "/").
      const found = target.includes('/')
        ? resolveByPath(target)
        : resolveByBasename(target);
      if (!found) return; // resolver already printed the error
      const proj = getProject(found);
      if (!proj?.metroPort) {
        console.log(chalk.dim(`No Metro port assigned to ${found}.`));
        return;
      }
      return killForProject(found, proj);
    });
}

function resolveByPath(arg) {
  const { found, error } = resolveRegisteredProject(arg);
  if (!found) {
    console.error(chalk.red(error));
    process.exit(1);
  }
  return found;
}

function resolveByBasename(name) {
  const cfg = loadConfig();
  const matches = Object.keys(cfg?.projects || {}).filter(p => {
    const base = p.split('/').pop();
    return base === name;
  });
  if (matches.length === 0) {
    console.error(chalk.red(`No registered project matches "${name}". See \`rn-iso status\` for the list.`));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(chalk.red(`Multiple projects share the basename "${name}":`));
    for (const m of matches) console.error(chalk.dim(`  ${m}`));
    console.error(chalk.dim('Pass the absolute path to disambiguate.'));
    process.exit(1);
  }
  return matches[0];
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
