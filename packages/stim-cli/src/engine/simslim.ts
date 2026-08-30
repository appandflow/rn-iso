import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { getExecutor } from '../exec.ts';
import { createLineReader, stripAnsi, waitForChild } from '../process-output.ts';

type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

export interface SimSlimResult {
  managed: boolean;
  profile: string | null;
}

export async function reconcileSimSlim({
  udid,
  profile,
  previouslyManaged = false,
  out = () => {},
  spawn,
}: {
  udid: string;
  profile?: string | null;
  previouslyManaged?: boolean;
  out?: (line: string) => void;
  spawn?: SpawnFn;
}): Promise<SimSlimResult> {
  if (!profile && !previouslyManaged) return { managed: false, profile: null };

  const action = profile ? 'on' : 'off';
  const args = profile ? ['on', udid, '--profile', profile] : ['off', udid];
  const lines: string[] = [];
  const onLine = (raw: string) => {
    const line = stripAnsi(raw).trim();
    if (!line) return;
    lines.push(line);
    if (lines.length > 20) lines.shift();
    out(`SimSlim: ${line}`);
  };
  const stdout = createLineReader(onLine);
  const stderr = createLineReader(onLine);

  let child: ChildProcess;
  try {
    child = (spawn ?? ((cmd, childArgs, opts) => getExecutor().spawn(cmd, childArgs, opts)))('simslim', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw simslimLaunchError(error);
  }
  child.stdout?.on('data', (chunk) => stdout.push(chunk));
  child.stderr?.on('data', (chunk) => stderr.push(chunk));
  const result = await waitForChild(child);
  stdout.flush();
  stderr.flush();

  if (result.error) throw simslimLaunchError(result.error);
  if (result.code !== 0) {
    const detail = lines.length ? ` ${lines.join(' | ')}` : '';
    throw new Error(`SimSlim ${action} failed with exit code ${result.code ?? 'unknown'}.${detail}`);
  }
  return { managed: Boolean(profile), profile: profile ?? null };
}

function simslimLaunchError(error: unknown): Error {
  const cause = error as NodeJS.ErrnoException;
  if (cause?.code === 'ENOENT') {
    return new Error(
      'SimSlim is configured but the `simslim` command is not installed. Run `brew install mobai-app/tap/simslim`.',
      { cause },
    );
  }
  return new Error(`Could not start SimSlim: ${String((cause as Error)?.message || cause)}`, { cause });
}

export function simslimIsOnPath(): boolean {
  try {
    return Boolean(getExecutor().runQuiet('command -v simslim', { timeoutMs: 5000 }));
  } catch {
    return false;
  }
}
