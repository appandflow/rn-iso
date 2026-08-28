import chalk from 'chalk';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { StartError, StartFacts, SupervisorRecord } from '../types.ts';
import { getProject, upsertProject } from '../config.ts';
import { getExecutor } from '../exec.ts';
import { isPidAlive, resolveProjectMetro } from '../metro.ts';
import type { MetroResolution } from '../metro.ts';
import { queryLogs } from '../logs-query.ts';
import { ensureWorkspaceStorage, supervisorLogFile, workspaceLogsDir } from '../paths.ts';
import { reserveMetroPort } from '../ports.ts';
import { detectAndroidPackage, detectBundleId, detectIsExpo, findProjectRoot } from '../project.ts';
import { readWorkspaceState } from '../supervisor/state.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { stepTimer } from './ios.ts';

const DEFAULT_WAIT_SECONDS = 60;
const POLL_MS = 500;
const LOG_TAIL_LINES = 5;
const ERROR_EVIDENCE_RECORDS = 8;

function writeNote(line: string): void {
  console.error(line);
}

export function supervisorEntry(): string {
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

export function tailLines(text: unknown, n: number = LOG_TAIL_LINES): string[] {
  const lines = String(text || '')
    .split('\n')
    .filter((l) => l.trim() !== '');
  return lines.slice(-n);
}

export function readLogTail(file: string, n: number = LOG_TAIL_LINES): string[] {
  try {
    return tailLines(readFileSync(file, 'utf-8'), n);
  } catch {
    return [];
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export default function startCommand(program: Command): void {
  registerStart(program);
}

interface StartOptions {
  json?: boolean;
  wait?: string;
}

export function registerStart(program: Command): void {
  program
    .command('start')
    .description(
      "Start this workspace's dev server under a detached supervisor and wait until it verifies as this project's. " +
        'Idempotent: a healthy dev server on the reserved port is a no-op. Structured logs land in the global workspace logs directory.',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--wait <seconds>', `How long to wait for the dev server to answer (default ${DEFAULT_WAIT_SECONDS})`)
    .action(async (opts: StartOptions) => {
      const json = Boolean(opts.json);
      const waitTimer = stepTimer();
      const out = (line: string) => {
        if (json) console.error(line);
        else console.log(line);
      };
      const note = writeNote;
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

      const wait = parseWait(opts.wait);
      if (wait.error) {
        return fail({
          code: 'RN_ISO_BAD_ARG',
          message: wait.error,
          remedy: 'Pass a whole number of seconds, e.g. --wait 90.',
        });
      }
      const waitSeconds = wait.seconds as number;

      const root = findProjectRoot(process.cwd());
      if (!root) {
        return fail({
          code: 'RN_ISO_NO_PROJECT',
          message: 'Not in a React Native project (no package.json found).',
          remedy: 'Run this from the app directory -- the one holding package.json.',
        });
      }

      try {
        ensureWorkspaceStorage(root);
      } catch (error) {
        return fail({
          code: (error as Error & { code?: string })?.code || 'RN_ISO_WORKSPACE_STATE',
          message: `Could not prepare this workspace's rn-iso state: ${(error as Error)?.message || error}`,
          remedy: 'Check that RN_ISO_HOME is writable and has free space.',
        });
      }

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

      if (resolution.metro) {
        if (!supervisor) {
          note(chalk.dim(`A dev server for this project already answers on port ${port}, started outside rn-iso.`));
          note(chalk.dim('Leaving it alone: rn-iso will not start a second bundler over a working one.'));
        }
        report({ json, out, port, supervisor, logsDir, alreadyRunning: true, waited: waitTimer() });
        return;
      }

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
        report({ json, out, port, supervisor, logsDir, alreadyRunning: true, waited: waitTimer() });
        return;
      }

      mkdirSync(logsDir, { recursive: true });
      const fd = openSync(logFile, 'a');
      const spawnedTs = Date.now();
      const child = getExecutor().spawn(process.execPath, [supervisorEntry(), '--root', root, '--port', String(port)], {
        cwd: root,
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
        aborted: () => childExit !== null || (child.pid ? !isPidAlive(child.pid) : false),
      });

      if (!healthy) {
        const gone = childExit !== null || (child.pid ? !isPidAlive(child.pid) : false);
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
                lines: failureEvidence({ logFile, logsDir, sinceTs: spawnedTs }),
                remedy:
                  'Fix the error above and run `rn-iso start` again; `rn-iso logs --errors` has the full records.',
              }
            : {
                code: 'RN_ISO_METRO_TIMEOUT',
                message: `The dev server did not answer on port ${port} within ${waitSeconds}s.`,
                lines: failureEvidence({ logFile, logsDir, sinceTs: spawnedTs }),
                remedy: 'It may still be starting. Run `rn-iso stop` to halt it, or `rn-iso logs` to follow along.',
              },
        );
      }

      supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }) || {
        pid: child.pid as number,
        port,
        mode: null,
        startedAt: null,
      };
      report({ json, out, port, supervisor, logsDir, alreadyRunning: false, waited: waitTimer() });
    });
}

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

function logTailLines(logFile: string): string[] {
  return [...readLogTail(logFile), `Supervisor log: ${logFile}`];
}

export function failureEvidence({
  logFile,
  logsDir,
  sinceTs,
}: {
  logFile: string;
  logsDir: string;
  sinceTs: number;
}): string[] {
  const supTail = readLogTail(logFile);
  const lines = supTail.length > 0 ? [...supTail, `Supervisor log: ${logFile}`] : [];
  let errors: ReturnType<typeof queryLogs> = [];
  let all: ReturnType<typeof queryLogs> = [];
  try {
    errors = queryLogs({ dir: logsDir, minLevel: 'error' });
    all = queryLogs({ dir: logsDir });
  } catch {}
  const since = (rs: ReturnType<typeof queryLogs>) =>
    rs.filter((r) => typeof r.ts === 'number' && r.ts >= sinceTs).slice(-ERROR_EVIDENCE_RECORDS);
  let recent = since(errors);
  const fellBack = recent.length === 0;
  if (fellBack) recent = since(all);
  for (const r of recent) {
    lines.push(`${String(r.src ?? '?')}: ${String(r.msg ?? '').split('\n')[0] ?? ''}`);
  }
  if (recent.length > 0) lines.push(fellBack ? 'Full records: `rn-iso logs`' : 'Full records: `rn-iso logs --errors`');
  return lines;
}

function report({
  json,
  out,
  port,
  supervisor,
  logsDir,
  alreadyRunning,
  waited,
}: {
  json: boolean;
  out: (line: string) => void;
  port: number;
  supervisor: LiveSupervisor | null;
  logsDir: string;
  alreadyRunning: boolean;
  waited: string;
}): StartFacts {
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
  out(chalk.green(`OK: dev server on port ${port}, ${who}${alreadyRunning ? ' (already running)' : ''} ${waited}`));
  out(chalk.dim(`Logs: ${logsDir}`));
  return facts;
}
