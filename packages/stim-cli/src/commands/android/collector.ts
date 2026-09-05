import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import chalk from 'chalk';
import { spawnEntry } from '../../spawn-entry.ts';
import { workspaceLogsDir } from '../../paths.ts';
import { PLATFORM } from './support.ts';
import { verifyCollectorOwnership } from '../../collector/ownership.ts';
import { isPidAlive } from '../../metro.ts';
import { readCollectors } from '../../collector/state.ts';
import { phaseLine } from '../../command-output.ts';

function collectorEntry(): string {
  return spawnEntry('collector-run');
}

export function collectorLogFile(root: string): string {
  return join(workspaceLogsDir(root), `collector-${PLATFORM}.log`);
}

const COLLECTOR_EXIT_WAIT_MS = 2000;

const COLLECTOR_POLL_MS = 25;

export function killPreviousCollector(
  root: string,
  {
    platform = PLATFORM,
    kill = (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
    collectors = null,
    verify = verifyCollectorOwnership,
    isAlive = isPidAlive,
    note = (_line: string) => {},
  }: {
    platform?: string;
    kill?: (pid: number, signal: NodeJS.Signals) => boolean;
    collectors?: Record<string, { pid?: number }> | null;
    verify?: typeof verifyCollectorOwnership;
    isAlive?: (pid: number) => boolean;
    note?: (line: string) => void;
  } = {},
): number | null {
  const record = (collectors ?? readCollectors(root))?.[platform] as { pid?: number } | undefined;
  const pid = Number(record?.pid);
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
  const ownership = verify({ pid, platform, root, isAlive });
  if (ownership.status === 'gone') return null;
  if (ownership.status === 'unverified') {
    note(
      chalk.dim(
        `Previous ${platform} log collector (pid ${pid}): ${ownership.reason}, so it was not signalled -- starting a replacement anyway`,
      ),
    );
    return null;
  }
  try {
    kill(pid, 'SIGTERM');
    return pid;
  } catch {
    return null;
  }
}

export async function startCollector({
  root,
  serial,
  packageName,
  spawn,
  kill,
  alive = isPidAlive,
  verify = verifyCollectorOwnership,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  out,
}: {
  root: string;
  serial?: string;
  packageName: string;
  spawn: (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcess;
  kill: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  verify?: typeof verifyCollectorOwnership;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  out: (line: string) => void;
}): Promise<number | null> {
  const previousPid = killPreviousCollector(root, {
    kill,
    isAlive: alive,
    verify,
    note: (line) => out(phaseLine('logs', line)),
  });
  if (previousPid) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && alive(previousPid)) {
      await sleep(COLLECTOR_POLL_MS);
    }
  }

  let stdio: 'ignore' | (number | 'ignore')[] = 'ignore';
  try {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const fd = openSync(collectorLogFile(root), 'a');
    stdio = ['ignore', fd, fd];
  } catch {}

  try {
    const child = spawn(
      process.execPath,
      [collectorEntry(), '--platform', PLATFORM, '--root', root, '--serial', serial!, '--package', packageName],
      {
        cwd: root,
        detached: true,
        stdio,
        env: process.env,
      },
    );
    child?.unref?.();
    return child?.pid ?? null;
  } catch (err) {
    out(phaseLine('logs', chalk.yellow(`could not start the device log collector: ${(err as Error)?.message || err}`)));
    return null;
  }
}
