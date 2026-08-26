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
import type { Command } from 'commander';
import type { StartError, StartFacts, SupervisorRecord } from '../types.ts';
import { getProject, upsertProject } from '../config.ts';
import { getExecutor } from '../exec.ts';
import { isPidAlive, resolveProjectMetro } from '../metro.ts';
import type { MetroResolution } from '../metro.ts';
import { supervisorLogFile, workspaceLogsDir } from '../paths.ts';
import { reserveMetroPort } from '../ports.ts';
import { detectAndroidPackage, detectBundleId, detectIsExpo, findProjectRoot } from '../project.ts';
import { installedSkillVersions, staleSkillWarning } from './skill.ts';
import { readWorkspaceState } from '../supervisor/state.ts';
import { ensureWorkspaceIgnored } from '../engine/workspace.ts';
import { spawnEntry } from '../spawn-entry.ts';

const DEFAULT_WAIT_SECONDS = 60;
const POLL_MS = 500;
const LOG_TAIL_LINES = 5;

export function supervisorEntry() {
  return spawnEntry('supervisor-run');
}

interface WaitResult {
  seconds?: number;
  error?: string;
}

export function parseWait(value: unknown): WaitResult {
  if (value === undefined || value === null) return { seconds: DEFAULT_WAIT_SECONDS };
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { error: `Invalid --wait value ${JSON.stringify(value)}. Pass a number of seconds, e.g. --wait 90.` };
  }
  return { seconds };
}

// A loose, defensive read of whatever `state.supervisor` / `project.supervisor`
// carries -- state.json's `supervisor` block is a Record<string, unknown> (see
// supervisor/state.ts) and config.ts's ProjectRecord.supervisor does not
// declare `mode`, so this names only the fields liveSupervisor actually reads.
interface SupervisorCandidate {
  pid?: unknown;
  port?: unknown;
  mode?: unknown;
  startedAt?: unknown;
}

interface LiveSupervisor {
  pid: number;
  port: number;
  mode: string | null;
  startedAt: string | null;
}

interface ChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

// Pure. The workspace state file is the primary record -- it is the only one
// that carries the mode -- and the global config entry is the fallback for a
// workspace whose .rn-iso directory was removed under a running supervisor.
//
// "Live" is pid alive AND the recorded port is the port we are about to use.
// Both halves matter: a pid alone is not proof (pids are reused, and a stale
// state.json outlives its process), and a supervisor recorded on a different
// port is not the one that would answer here.
export function liveSupervisor({
  state,
  project,
  port,
  isAlive = isPidAlive,
}: {
  state?: { supervisor?: SupervisorCandidate | null } | null;
  project?: { supervisor?: SupervisorCandidate | null } | null;
  port?: number;
  isAlive?: (pid: number) => boolean;
} = {}): LiveSupervisor | null {
  const candidates = [state?.supervisor, project?.supervisor].filter((s): s is SupervisorCandidate =>
    Boolean(s && Number.isFinite(Number(s.pid))),
  );
  for (const candidate of candidates) {
    if (Number(candidate.port) !== Number(port)) continue;
    if (!isAlive(Number(candidate.pid))) continue;
    return {
      pid: Number(candidate.pid),
      port: Number(candidate.port),
      mode: (candidate.mode ?? state?.supervisor?.mode ?? null) as string | null,
      startedAt: (candidate.startedAt ?? null) as string | null,
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
export function startFacts({
  port,
  supervisor,
  logsDir,
  alreadyRunning,
}: {
  port: number;
  supervisor?: SupervisorRecord | null;
  logsDir: string;
  alreadyRunning?: unknown;
}): StartFacts {
  return {
    port,
    supervisorPid: supervisor?.pid ?? null,
    mode: supervisor?.mode ?? null,
    logsDir,
    alreadyRunning: Boolean(alreadyRunning),
  };
}

// Pure shaping of the FAILURE payload, the other half of the same contract:
// one parseable line on stdout either way. `start --json` used to print nothing
// at all when it failed, so a caller doing `facts=$(rn-iso start --json)` got an
// empty string and had to fall back to scraping stderr prose -- exactly what
// `guide facts` promises the build commands never make you do. The shape is
// theirs: a stable code to branch on, a message, and a remedy (null when there
// is nothing to suggest beyond what was already printed).
export function startError({
  code,
  message,
  remedy = null,
}: {
  code: string;
  message: string;
  remedy?: string | null;
}): StartError {
  return { code, message, remedy: remedy ?? null };
}

export function tailLines(text: unknown, n = LOG_TAIL_LINES): string[] {
  const lines = String(text || '')
    .split('\n')
    .filter((l) => l.trim() !== '');
  return lines.slice(-n);
}

export function readLogTail(file: string, n = LOG_TAIL_LINES): string[] {
  try {
    return tailLines(readFileSync(file, 'utf-8'), n);
  } catch {
    return [];
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export default function startCommand(program: Command, cliVersion?: string | null) {
  registerStart(program, cliVersion);
}

interface StartOptions {
  json?: boolean;
  wait?: string;
}

// `cliVersion` is optional: without it the skill-staleness check is skipped
// rather than comparing against undefined, which would report every installed
// copy as stale. Only bin/cli.js has the real version to pass. This check used
// to live on `up`, which was the command every session ran first; `start` is
// what took that place in the v3 lifecycle.
export function registerStart(program: Command, cliVersion: string | null = null) {
  program
    .command('start')
    .description(
      "Start this workspace's dev server under a detached supervisor and wait until it verifies as this project's. " +
        'Idempotent: a healthy dev server on the reserved port is a no-op. Structured logs land in .rn-iso/logs.',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--wait <seconds>', `How long to wait for the dev server to answer (default ${DEFAULT_WAIT_SECONDS})`)
    .action(async (opts: StartOptions) => {
      const json = Boolean(opts.json);
      const out = (line: string) => {
        if (json) console.error(line);
        else console.log(line);
      };
      const note = (line: string) => console.error(line);
      // Every failure exits the same way: the diagnostic, whatever evidence
      // there is for it, the remedy, and -- under --json -- the error contract
      // as the single line on stdout. Same shape `ios` / `android` use, because
      // an agent branching on `code` must not have to know which command it
      // called.
      const fail = ({
        code,
        message,
        remedy = null,
        lines = [],
      }: {
        code: string;
        message: string;
        remedy?: string | null;
        lines?: string[];
      }): never => {
        note(chalk.red(message));
        for (const line of lines) note(chalk.dim(`  ${line}`));
        if (remedy) note(chalk.dim(remedy));
        note(chalk.red(`failed: ${code}`));
        if (json) console.log(JSON.stringify(startError({ code, message, remedy })));
        process.exit(1);
      };

      // The installed skill is a plain file copy, so upgrading rn-iso never
      // refreshes it. A v2 skill against a v3 CLI describes commands that no
      // longer exist, and nothing else says so. Never fatal, and never on
      // stdout -- see the --json contract above. ONE line however many copies
      // are installed: both targets normally hold the same file, and the
      // warning names neither, so a per-copy loop just said it twice.
      const skillWarning = cliVersion ? staleSkillWarning(installedSkillVersions(), cliVersion) : null;
      if (skillWarning) note(chalk.yellow(skillWarning));

      const wait = parseWait(opts.wait);
      if (wait.error) {
        return fail({
          code: 'RN_ISO_BAD_ARG',
          message: wait.error,
          remedy: 'Pass a whole number of seconds, e.g. --wait 90.',
        });
      }
      // parseWait's contract: exactly one of `error` / `seconds` is set.
      const waitSeconds = wait.seconds as number;

      const root = findProjectRoot(process.cwd());
      if (!root) {
        return fail({
          code: 'RN_ISO_NO_PROJECT',
          message: 'Not in a React Native project (no package.json found).',
          remedy: 'Run this from the app directory -- the one holding package.json.',
        });
      }

      // `start` is the first command of the loop, so it is where the workspace
      // directory first appears. Ensuring git ignores it here rather than in a
      // setup command is what removes the step a repo had to remember: `ios` and
      // `android` call the same function for the same reason, since either can
      // be the first to write into `<root>/.rn-iso`.
      const ignored = ensureWorkspaceIgnored(root);
      if (ignored.added) note(chalk.dim('note   added .rn-iso/ to .gitignore'));
      else if (ignored.error) note(chalk.yellow(`note   could not update ${ignored.path}: ${ignored.error}`));

      upsertProject(root, {
        bundleId: detectBundleId(root) ?? undefined,
        androidPackage: detectAndroidPackage(root) ?? undefined,
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
        report({ json, out, port, supervisor, logsDir, alreadyRunning: true });
        return;
      }

      // A live supervisor that is not answering yet is either still starting
      // (the common case, when two `start` runs race) or wedged. Either way,
      // spawning a second one would leave the workspace with two supervisors
      // and one port, so we wait on the one that exists instead.
      if (supervisor) {
        note(
          chalk.dim(
            `Supervisor pid ${supervisor.pid} is already running for this workspace; waiting for it to answer on port ${port}...`,
          ),
        );
        const healthy = await waitForMetro({ root, port, seconds: waitSeconds });
        if (!healthy) {
          return fail({
            code: 'RN_ISO_METRO_TIMEOUT',
            message: `Supervisor pid ${supervisor.pid} did not serve port ${port} within ${waitSeconds}s.`,
            lines: logTailLines(logFile),
            remedy: 'Run `rn-iso stop` to halt it, then `rn-iso start` again.',
          });
        }
        supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }) || supervisor;
        report({ json, out, port, supervisor, logsDir, alreadyRunning: true });
        return;
      }

      // ---- spawn the supervisor ----
      mkdirSync(logsDir, { recursive: true });
      // Appended, never truncated, and shared by stdout and stderr so the two
      // interleave in the order they were written. This file is the ONLY
      // record of a supervisor that died before it could write a structured
      // one, which is why the failure path below quotes it.
      const fd = openSync(logFile, 'a');
      const child = getExecutor().spawn(process.execPath, [supervisorEntry(), '--root', root, '--port', String(port)], {
        cwd: root,
        // detached: the supervisor leads its own process group, so it
        // survives this command exiting and `stop` can signal that group
        // without reaching the caller's shell.
        detached: true,
        stdio: ['ignore', fd, fd],
        env: process.env,
      });
      child.unref?.();

      let childExit: ChildExitInfo | null = null;
      child.on?.('exit', (code, signal) => {
        childExit = { code, signal };
      });
      child.on?.('error', (err) => {
        childExit = { code: null, signal: null, error: err };
      });

      out(chalk.dim(`Supervisor pid ${child.pid} starting the dev server on port ${port}...`));

      const healthy = await waitForMetro({
        root,
        port,
        seconds: waitSeconds,
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
        // Cast rather than rely on narrowing: childExit is only ever
        // reassigned inside the 'exit'/'error' listeners above, and TS's flow
        // analysis does not see through those closures back to its declared
        // type here.
        const exitInfo = childExit as ChildExitInfo | null;
        const how = exitInfo
          ? exitInfo.signal
            ? `signal ${exitInfo.signal}`
            : `code ${exitInfo.code}`
          : 'without being observed';
        return fail(
          gone
            ? {
                code: 'RN_ISO_SUPERVISOR_EXITED',
                message: `The supervisor exited (${how}) before the dev server came up on port ${port}.`,
                lines: logTailLines(logFile),
                remedy: 'Fix the error above and run `rn-iso start` again.',
              }
            : {
                code: 'RN_ISO_METRO_TIMEOUT',
                message: `The dev server did not answer on port ${port} within ${waitSeconds}s.`,
                lines: logTailLines(logFile),
                remedy: 'It may still be starting. Run `rn-iso stop` to halt it, or `rn-iso logs` to follow along.',
              },
        );
      }

      supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }) ||
        // child.pid is only undefined if the spawn itself failed, which the
        // health check above would already have turned into a failure.
        { pid: child.pid as number, port, mode: null, startedAt: null };
      report({ json, out, port, supervisor, logsDir, alreadyRunning: false });
    });
}

// The reserved port, re-reserved when a FOREIGN process holds it. Reporting
// the conflict instead would strand the project on a port it can never use,
// while our own dev server answering there is the healthy case and must not
// move.
async function resolvePort(root: string, note: (line: string) => void): Promise<number> {
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

async function waitForMetro({
  root,
  port,
  seconds,
  aborted = () => false,
  probe = resolveProjectMetro,
}: {
  root: string;
  port: number;
  seconds: number;
  aborted?: () => boolean;
  probe?: (port: number, root: string) => Promise<MetroResolution>;
}): Promise<boolean> {
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

// The evidence a start failure carries: the last lines of the supervisor's raw
// stdio, then the path to the rest of it. That file is the ONLY record of a
// supervisor that died before it could write a structured one, which is why
// every failure quotes it.
function logTailLines(logFile: string): string[] {
  return [...readLogTail(logFile), `Supervisor log: ${logFile}`];
}

function report({
  json,
  out,
  port,
  supervisor,
  logsDir,
  alreadyRunning,
}: {
  json: boolean;
  out: (line: string) => void;
  port: number;
  supervisor: LiveSupervisor | null;
  logsDir: string;
  alreadyRunning: boolean;
}): StartFacts {
  // LiveSupervisor is a closed, non-null shape (see above); SupervisorRecord
  // is the loose index-signature bag startFacts (and the wider --json
  // contract) is written against. Structurally compatible, cast for the
  // index signature and the null-vs-undefined difference on mode/startedAt.
  const facts = startFacts({
    port,
    supervisor: supervisor as unknown as SupervisorRecord | null,
    logsDir,
    alreadyRunning,
  });
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
