// src/commands/start.js -- reserve the port, spawn the detached supervisor,
// wait until the dev server is verifiably THIS project's, print the facts.
//
// `start` is the one command that blocks on purpose: waiting for health is its
// contract, because everything an agent does next (build, install, launch)
// fails slowly and confusingly if the bundler is not up yet.
//
// Health is `resolveProjectMetro`, never a bare /status probe. A port is not
// identity: a foreign bundler answering /status on our reserved port would
// send the agent's build at someone else's dev server, which is exactly what
// the identity check exists to prevent -- and the reserved port moves instead
// of being reported as a conflict the caller can do nothing about.
//
// Two flags, and only ever two: --json and --wait. Anything a project needs
// beyond that is the project's own bundler command, which is not rn-iso's
// judgment to make.
import chalk from 'chalk';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getProject, upsertProject } from '../config.js';
import { getExecutor } from '../exec.js';
import { isPidAlive, resolveProjectMetro } from '../metro.js';
import { supervisorLogFile, workspaceLogsDir } from '../paths.js';
import { reserveMetroPort } from '../ports.js';
import { detectAndroidPackage, detectBundleId, detectIsExpo, findProjectRoot } from '../project.js';
import { installedSkillVersions, staleSkillCopies } from './skill.js';
import { readWorkspaceState } from '../supervisor/run.js';

const DEFAULT_WAIT_SECONDS = 60;
const POLL_MS = 500;
const LOG_TAIL_LINES = 5;

export function supervisorEntry() {
  return fileURLToPath(new URL('../supervisor/run.js', import.meta.url));
}

export function parseWait(value) {
  if (value === undefined || value === null) return { seconds: DEFAULT_WAIT_SECONDS };
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { error: `Invalid --wait value ${JSON.stringify(value)}. Pass a number of seconds, e.g. --wait 90.` };
  }
  return { seconds };
}

// Pure. The workspace state file is the primary record -- it is the only one
// that carries the mode -- and the global config entry is the fallback for a
// workspace whose .rn-iso directory was removed under a running supervisor.
//
// "Live" is pid alive AND the recorded port is the port we are about to use.
// Both halves matter: a pid alone is not proof (pids are reused, and a stale
// state.json outlives its process), and a supervisor recorded on a different
// port is not the one that would answer here.
export function liveSupervisor({ state, project, port, isAlive = isPidAlive } = {}) {
  const candidates = [state?.supervisor, project?.supervisor].filter(
    (s) => s && Number.isFinite(Number(s.pid))
  );
  for (const candidate of candidates) {
    if (Number(candidate.port) !== Number(port)) continue;
    if (!isAlive(Number(candidate.pid))) continue;
    return {
      pid: Number(candidate.pid),
      port: Number(candidate.port),
      mode: candidate.mode ?? state?.supervisor?.mode ?? null,
      startedAt: candidate.startedAt ?? null,
    };
  }
  return null;
}

// Pure shaping of the --json payload, under the contract every rn-iso command
// with a --json flag follows: one line on stdout, everything else on stderr.
//
// supervisorPid and mode are null when a dev server answers on the port but
// rn-iso did not start it -- an agent that ran the project's own `npm start`
// first. That is reported rather than fought: the port has what it needs, and
// starting a second bundler over it would be the actual failure.
export function startFacts({ port, supervisor, logsDir, alreadyRunning }) {
  return {
    port,
    supervisorPid: supervisor?.pid ?? null,
    mode: supervisor?.mode ?? null,
    logsDir,
    alreadyRunning: Boolean(alreadyRunning),
  };
}

export function tailLines(text, n = LOG_TAIL_LINES) {
  const lines = String(text || '').split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-n);
}

export function readLogTail(file, n = LOG_TAIL_LINES) {
  try {
    return tailLines(readFileSync(file, 'utf-8'), n);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function startCommand(program, cliVersion) {
  registerStart(program, cliVersion);
}

// `cliVersion` is optional: without it the skill-staleness check is skipped
// rather than comparing against undefined, which would report every installed
// copy as stale. Only bin/cli.js has the real version to pass. This check used
// to live on `up`, which was the command every session ran first; `start` is
// what took that place in the v3 lifecycle.
export function registerStart(program, cliVersion = null) {
  program
    .command('start')
    .description(
      'Start this workspace\'s dev server under a detached supervisor and wait until it verifies as this project\'s. '
      + 'Idempotent: a healthy dev server on the reserved port is a no-op. Structured logs land in .rn-iso/logs.'
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--wait <seconds>', `How long to wait for the dev server to answer (default ${DEFAULT_WAIT_SECONDS})`)
    .action(async (opts) => {
      const json = Boolean(opts.json);
      const out = (line) => { if (json) console.error(line); else console.log(line); };
      const note = (line) => console.error(line);
      const fail = (message) => {
        note(chalk.red(message));
        process.exit(1);
      };

      // The installed skill is a plain file copy, so upgrading rn-iso never
      // refreshes it. A v2 skill against a v3 CLI describes commands that no
      // longer exist, and nothing else says so. Never fatal, and never on
      // stdout -- see the --json contract above.
      for (const stale of cliVersion ? staleSkillCopies(installedSkillVersions(), cliVersion) : []) {
        note(chalk.yellow(
          `Installed rn-iso skill is ${stale.version ?? 'an unstamped older version'} but this CLI is ${cliVersion}. `
          + 'Run `npx rn-iso skill install` so the docs your agent reads match the binary.'
        ));
      }

      const wait = parseWait(opts.wait);
      if (wait.error) return fail(wait.error);

      const root = findProjectRoot(process.cwd());
      if (!root) return fail('Not in a React Native project (no package.json found).');

      upsertProject(root, {
        bundleId: detectBundleId(root),
        androidPackage: detectAndroidPackage(root),
        isExpo: detectIsExpo(root),
      });

      const logsDir = workspaceLogsDir(root);
      const logFile = supervisorLogFile(root);
      const port = await resolvePort(root, note);

      let resolution = await resolveProjectMetro(port, root);
      let supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });

      // Already up: the whole point of an idempotent start. Two `start` runs in
      // a row must leave one supervisor, not two bundlers fighting for a port.
      if (resolution.metro) {
        if (!supervisor) {
          note(chalk.dim(`A dev server for this project already answers on port ${port}, started outside rn-iso.`));
          note(chalk.dim('Leaving it alone: rn-iso will not start a second bundler over a working one.'));
        }
        return report({ json, out, port, supervisor, logsDir, alreadyRunning: true });
      }

      // A live supervisor that is not answering yet is either still starting
      // (the common case, when two `start` runs race) or wedged. Either way,
      // spawning a second one would leave the workspace with two supervisors
      // and one port, so we wait on the one that exists instead.
      if (supervisor) {
        note(chalk.dim(`Supervisor pid ${supervisor.pid} is already running for this workspace; waiting for it to answer on port ${port}...`));
        const healthy = await waitForMetro({ root, port, seconds: wait.seconds });
        if (!healthy) {
          note(chalk.red(`Supervisor pid ${supervisor.pid} did not serve port ${port} within ${wait.seconds}s.`));
          printLogTail(note, logFile);
          note(chalk.dim('Run `rn-iso stop` to halt it, then `rn-iso start` again.'));
          process.exit(1);
          return;
        }
        supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }) || supervisor;
        return report({ json, out, port, supervisor, logsDir, alreadyRunning: true });
      }

      // ---- spawn the supervisor ----
      mkdirSync(logsDir, { recursive: true });
      // Appended, never truncated, and shared by stdout and stderr so the two
      // interleave in the order they were written. This file is the ONLY
      // record of a supervisor that died before it could write a structured
      // one, which is why the failure path below quotes it.
      const fd = openSync(logFile, 'a');
      const child = getExecutor().spawn(
        process.execPath,
        [supervisorEntry(), '--root', root, '--port', String(port)],
        {
          cwd: root,
          // detached: the supervisor leads its own process group, so it
          // survives this command exiting and `stop` can signal that group
          // without reaching the caller's shell.
          detached: true,
          stdio: ['ignore', fd, fd],
          env: process.env,
        }
      );
      child.unref?.();

      let childExit = null;
      child.on?.('exit', (code, signal) => { childExit = { code, signal }; });
      child.on?.('error', (err) => { childExit = { code: null, signal: null, error: err }; });

      out(chalk.dim(`Supervisor pid ${child.pid} starting the dev server on port ${port}...`));

      const healthy = await waitForMetro({
        root,
        port,
        seconds: wait.seconds,
        // A supervisor that has already exited is never going to answer, so
        // the wait ends at second one instead of at sixty.
        aborted: () => childExit !== null || (child.pid ? !isPidAlive(child.pid) : false),
      });

      if (!healthy) {
        // A supervisor that is GONE and one that is merely slow need different
        // next steps, so the two are distinguished rather than both reported
        // as a timeout. The exit event is the better evidence; the liveness
        // check catches the case where the process died without us seeing it.
        const gone = childExit !== null || (child.pid ? !isPidAlive(child.pid) : false);
        if (gone) {
          const how = childExit
            ? (childExit.signal ? `signal ${childExit.signal}` : `code ${childExit.code}`)
            : 'without being observed';
          note(chalk.red(`The supervisor exited (${how}) before the dev server came up on port ${port}.`));
        } else {
          note(chalk.red(`The dev server did not answer on port ${port} within ${wait.seconds}s.`));
        }
        printLogTail(note, logFile);
        note(chalk.dim(gone
          ? 'Fix the error above and run `rn-iso start` again.'
          : 'It may still be starting. Run `rn-iso stop` to halt it, or `rn-iso logs` to follow along.'));
        process.exit(1);
        return;
      }

      supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port })
        || { pid: child.pid, port, mode: null, startedAt: null };
      report({ json, out, port, supervisor, logsDir, alreadyRunning: false });
    });
}

// The reserved port, re-reserved when a FOREIGN process holds it. Reporting
// the conflict instead would strand the project on a port it can never use,
// while our own dev server answering there is the healthy case and must not
// move.
async function resolvePort(root, note) {
  const project = getProject(root);
  const recorded = project?.metroPort;
  if (!recorded) return await reserveMetroPort(root);
  const held = await resolveProjectMetro(recorded, root);
  if (!held.notOurs) return recorded;
  const fresh = await reserveMetroPort(root);
  if (fresh !== recorded) {
    note(chalk.yellow(`Port ${recorded} is held by something else (${held.notOurs}).`));
    note(chalk.dim(`Reserved port ${fresh} for this project instead.`));
  }
  return fresh;
}

async function waitForMetro({ root, port, seconds, aborted = () => false, probe = resolveProjectMetro }) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const resolution = await probe(port, root);
    if (resolution.metro) return true;
    if (aborted()) return false;
    await sleep(POLL_MS);
  }
  const last = await probe(port, root);
  return Boolean(last.metro);
}

function printLogTail(note, logFile) {
  const tail = readLogTail(logFile);
  for (const line of tail) note(chalk.dim(`  ${line}`));
  note(chalk.dim(`Supervisor log: ${logFile}`));
}

function report({ json, out, port, supervisor, logsDir, alreadyRunning }) {
  const facts = startFacts({ port, supervisor, logsDir, alreadyRunning });
  if (json) {
    console.log(JSON.stringify(facts));
    return facts;
  }
  const who = facts.supervisorPid
    ? `supervisor pid ${facts.supervisorPid}${facts.mode ? ` (${facts.mode})` : ''}`
    : 'started outside rn-iso';
  out(chalk.green(`OK: dev server on port ${port}, ${who}${alreadyRunning ? ' (already running)' : ''}`));
  out(chalk.dim(`Logs: ${logsDir}`));
  return facts;
}
