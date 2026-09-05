import chalk from 'chalk';
import { NOT_OURS_FOREIGN_CWD } from '../metro.ts';
import { ensureWorkspaceStorage } from '../paths.ts';
import { LAUNCH_BUNDLING, LAUNCH_UNVERIFIED } from '../engine/app-install.ts';

interface MetroResolutionLike {
  metro?: { pid?: number } | null;
  kind?: string;
  notOurs?: string | null;
}

export interface SupervisorLike {
  pid?: number;
  port?: number;
  mode?: string;
}

export const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

const GATE_RETRY_DELAYS_MS: number[] = [3000, 7000, 10000];

export function gateShouldRetry(resolution: MetroResolutionLike | null | undefined): boolean {
  if (resolution?.metro) return false;
  return resolution?.kind !== NOT_OURS_FOREIGN_CWD;
}

export async function resolveMetroWithRetry(
  resolve: (port: number, root: string) => Promise<MetroResolutionLike>,
  port: number,
  root: string,
  {
    delays = GATE_RETRY_DELAYS_MS,
    sleep: wait = sleep,
    onRetry = (_info: { attempt: number; delayMs: number; resolution: MetroResolutionLike }) => {},
  }: {
    delays?: number[];
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; delayMs: number; resolution: MetroResolutionLike }) => void;
  } = {},
): Promise<MetroResolutionLike> {
  let resolution = await resolve(port, root);
  for (let i = 0; i < delays.length && gateShouldRetry(resolution); i++) {
    const delayMs = delays[i];
    if (delayMs === undefined) break;
    onRetry({ attempt: i + 1, delayMs, resolution });
    await wait(delayMs);
    resolution = await resolve(port, root);
  }
  return resolution;
}

export function noMetroMessage({
  port,
  resolution,
  supervisor,
  supervisorAlive,
}: {
  port: number;
  resolution?: MetroResolutionLike | null;
  supervisor?: SupervisorLike | null;
  supervisorAlive?: boolean;
}): string {
  const foreign = resolution?.notOurs;
  if (supervisor && supervisor.port === port && supervisorAlive) {
    const mode = supervisor.mode ? `${supervisor.mode} ` : '';
    return (
      `A supervisor record exists for port ${port} (pid ${supervisor.pid}, ${mode}dev server) but it did not verify as this workspace's Metro` +
      `${foreign ? `: ${foreign}` : ' -- nothing answered /status'}.` +
      ' Metro may still be indexing this project (a monorepo file-map crawl blocks its event loop for ~20s after the port opens).'
    );
  }
  if (foreign) return `Port ${port} is in use but is NOT this workspace's dev server: ${foreign}.`;
  return `Nothing is serving this workspace's dev server on port ${port}.`;
}

export function noMetroRemedy({
  port,
  supervisor,
  supervisorAlive,
}: {
  port: number;
  supervisor?: SupervisorLike | null;
  supervisorAlive?: boolean;
}): string {
  if (supervisor && supervisor.port === port && supervisorAlive) {
    return 'Re-run `stim ios` in a few seconds, or give the dev server longer to verify with `stim start --wait <seconds>`.';
  }
  return 'Run `stim start` first, or pass --no-metro-check.';
}

export async function ensureWorkspaceStorageSafely(
  root: string,
  { note = (_line: string) => {} }: { note?: (line: string) => void } = {},
): Promise<unknown> {
  try {
    return ensureWorkspaceStorage(root);
  } catch (err) {
    note(chalk.dim(`Could not prepare this workspace's Stim state: ${(err as Error)?.message || err}`));
    throw err;
  }
}

export function launchOutcomeRecord({
  launchState,
  release,
  bundleId,
  configuration,
  metroPort,
}: {
  launchState: boolean | string;
  release: boolean;
  bundleId: string | null;
  configuration: string | null;
  metroPort?: number | null;
}): Record<string, unknown> {
  const unverified = launchState === LAUNCH_UNVERIFIED;
  const bundling = launchState === LAUNCH_BUNDLING;
  let msg: string;
  if (release) {
    msg = unverified
      ? `${bundleId} could not be verified as running after its ${configuration} launch`
      : `${bundleId} is running its embedded ${configuration} bundle`;
  } else if (unverified) {
    msg = `no bundle request from ${bundleId} reached this workspace's Metro on port ${metroPort}`;
  } else if (bundling) {
    msg =
      `${bundleId} requested a bundle from this workspace's Metro on port ${metroPort}; ` +
      'it was still being built when the launch check ended';
  } else {
    msg = `${bundleId} fetched a bundle from this workspace's Metro on port ${metroPort}`;
  }
  return {
    src: 'build',
    level: unverified ? 'warn' : 'info',
    event: unverified ? 'launch_unverified' : bundling ? 'launch_bundling' : 'launch_verified',
    msg,
  };
}
