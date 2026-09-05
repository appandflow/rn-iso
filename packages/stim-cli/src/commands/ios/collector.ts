import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import chalk from 'chalk';
import { workspaceLogsDir } from '../../paths.ts';
import { PLATFORM } from './support.ts';
import { spawnEntry } from '../../spawn-entry.ts';
import { verifyCollectorOwnership } from '../../collector/ownership.ts';
import { readWorkspaceState } from '../../supervisor/state.ts';
import { isPidAlive } from '../../metro.ts';
import { sleep } from '../native-runtime.ts';
import { getExecutor } from '../../exec.ts';

function collectorLogFile(root: string): string {
  return join(workspaceLogsDir(root), `collector-${PLATFORM}.log`);
}

export function collectorEntry(): string {
  return spawnEntry('collector-run');
}

export const COLLECTOR_EXIT_WAIT_MS = 2000;

const COLLECTOR_POLL_MS = 25;

interface ReplaceCollectorArgs {
  root: string;
  udid: string;
  bundleId: string;
  appName?: string | null;
  appExecutable?: string | null;
  physical?: boolean;
  payloadUrl?: string | null;
  spawn?: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  readState?: typeof readWorkspaceState;
  verify?: typeof verifyCollectorOwnership;
  waitMs?: number;
  note?: (line: string) => void;
}

// On hardware the collector holds the devicectl console of a running app, and
// an upgrade install terminates that app -- which ends devicectl non-zero and
// records a failure for a normal action. So a device run stops the previous
// collector before it installs, rather than as part of starting its own.
export async function stopPreviousCollector({
  root,
  kill = (pid, signal) => process.kill(pid, signal),
  alive = isPidAlive,
  readState = readWorkspaceState,
  verify = verifyCollectorOwnership,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  note = (_line: string) => {},
}: {
  root: string;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  readState?: typeof readWorkspaceState;
  verify?: typeof verifyCollectorOwnership;
  waitMs?: number;
  note?: (line: string) => void;
}): Promise<{ killed: number | null }> {
  const previous = (readState(root)?.collectors as Record<string, { pid?: number }> | undefined)?.[PLATFORM] || null;
  const previousPid = Number(previous?.pid) || null;
  let killed: number | null = null;

  if (previousPid) {
    const ownership = verify({ pid: previousPid, platform: PLATFORM, root, isAlive: alive });
    if (ownership.status === 'ours') {
      try {
        kill(previousPid, 'SIGTERM');
        killed = previousPid;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
          note(
            chalk.yellow(
              `Could not stop the previous ${PLATFORM} log collector (pid ${previousPid}): ${(err as Error)?.message || err}`,
            ),
          );
        }
      }
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && alive(previousPid)) {
        await sleep(COLLECTOR_POLL_MS);
      }
    } else if (ownership.status === 'unverified') {
      note(
        chalk.dim(
          `Previous ${PLATFORM} log collector (pid ${previousPid}): ${ownership.reason}, so it was not signalled -- starting a replacement anyway`,
        ),
      );
    }
  }
  return { killed };
}

export async function replaceCollector({
  root,
  udid,
  bundleId,
  appName,
  appExecutable,
  physical = false,
  payloadUrl = null,
  spawn = (cmd, args, opts) => getExecutor().spawn(cmd, args, opts),
  kill = (pid, signal) => process.kill(pid, signal),
  alive = isPidAlive,
  readState = readWorkspaceState,
  verify = verifyCollectorOwnership,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  note = (_line: string) => {},
}: ReplaceCollectorArgs): Promise<{ killed: number | null; pid: number | null }> {
  const { killed } = await stopPreviousCollector({ root, kill, alive, readState, verify, waitMs, note });

  const args = [collectorEntry(), '--platform', PLATFORM, '--root', root, '--udid', udid, '--bundle', bundleId];
  if (appName) args.push('--app-name', appName);
  if (appExecutable) args.push('--app-executable', appExecutable);
  if (physical) args.push('--physical');
  if (payloadUrl) args.push('--payload-url', payloadUrl);

  let stdio: 'ignore' | (number | 'ignore')[] = 'ignore';
  try {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const fd = openSync(collectorLogFile(root), 'a');
    stdio = ['ignore', fd, fd];
  } catch {}

  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio,
      env: process.env,
    });
    child?.unref?.();
  } catch (err) {
    note(chalk.yellow(`Could not start the ${PLATFORM} log collector: ${(err as Error)?.message || err}`));
    return { killed, pid: null };
  }
  return { killed, pid: child?.pid ?? null };
}
