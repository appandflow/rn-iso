import { realpathSync } from 'node:fs';
import { isPidAlive } from '../metro.ts';
import { readProcessArgs } from '../process-args.ts';

const TITLE_PREFIX = 'stim-collector-';
const COLLECTOR_ENTRY = /(^|\/)(collector-run\.mjs|collector\/run\.ts)$/;

// libuv writes process.title over the argv region, so `ps -o command=` reports
// the title instead of the spawn arguments. The title carries --root because it
// is the only place a live collector can state which workspace owns it.
export function collectorProcessTitle(platform: string, root: string): string {
  return `${TITLE_PREFIX}${platform} --root ${root}`;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sameRoot(recorded: string, actual: string): boolean {
  return recorded === actual || canonical(recorded) === canonical(actual);
}

function identifiesCollector(args: readonly string[], platform: string): boolean {
  if (args[0] === `${TITLE_PREFIX}${platform}`) return true;
  const flag = args.indexOf('--platform');
  if (flag === -1 || args[flag + 1] !== platform) return false;
  return args.some((arg) => COLLECTOR_ENTRY.test(arg));
}

function tokenize(args: readonly string[]): string[] {
  const only = args.length === 1 ? args[0] : null;
  return only && /\s/.test(only) ? only.trim().split(/\s+/) : [...args];
}

function statesRoot(args: readonly string[], root: string): boolean {
  const flag = args.indexOf('--root');
  if (flag === -1) return false;
  const tail = args.slice(flag + 1);
  for (let end = 1; end <= tail.length; end++) {
    const next = tail[end];
    if (next !== undefined && !next.startsWith('--')) continue;
    if (sameRoot(tail.slice(0, end).join(' '), root)) return true;
  }
  return false;
}

export function matchesCollectorProcess(
  args: readonly string[] | null | undefined,
  { platform, root }: { platform: string; root: string },
): boolean {
  if (!args?.length || !platform || !root) return false;
  const tokens = tokenize(args);
  return identifiesCollector(tokens, platform) && statesRoot(tokens, root);
}

export type CollectorOwnership = { status: 'ours' } | { status: 'gone' } | { status: 'unverified'; reason: string };

export function verifyCollectorOwnership({
  pid,
  platform,
  root,
  readArgs = readProcessArgs,
  isAlive = isPidAlive,
}: {
  pid: number;
  platform: string;
  root: string;
  readArgs?: (pid: number) => readonly string[] | null;
  isAlive?: (pid: number) => boolean;
}): CollectorOwnership {
  let args: readonly string[] | null = null;
  try {
    args = readArgs(pid);
  } catch {
    args = null;
  }
  if (!args) {
    return isAlive(pid)
      ? { status: 'unverified', reason: `the command of pid ${pid} could not be read` }
      : { status: 'gone' };
  }
  if (!matchesCollectorProcess(args, { platform, root })) {
    return isAlive(pid)
      ? { status: 'unverified', reason: `pid ${pid} does not run this workspace's ${platform} log collector` }
      : { status: 'gone' };
  }
  return { status: 'ours' };
}
