import type { NdjsonRecord } from '../ndjson.ts';

export const REMOTE_METRO_WRONG = 'STIM_CLI_REMOTE_METRO_WRONG';

const GATE_TIMEOUT_MS = 25_000;
const POLL_MS = 250;

export interface GateResult {
  ok?: true;
  failed?: true;
  code?: string;
  reason?: string;
  remedy?: string;
}

export interface GateOptions {
  origin: string;
  metroPort: number | string;
  platform: 'ios' | 'android';
  entryPoint?: string;
  readRecords: () => NdjsonRecord[];
  isProof: (record: NdjsonRecord, since: number) => boolean;
  probe?: (url: string, signal: AbortSignal) => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export function probeBundleUrl(origin: string, platform: 'ios' | 'android', entryPoint = 'index'): string {
  const entry = entryPoint.replace(/^\/+/, '').replace(/\.(?:[cm]?[jt]sx?)$/, '');
  return `${origin.replace(/\/+$/, '')}/${entry}.bundle?platform=${platform}&dev=true`;
}

const defaultProbe = async (url: string, signal: AbortSignal): Promise<number | null> => {
  try {
    const res = await fetch(url, { signal, redirect: 'follow' });
    return res.status;
  } catch {
    return null;
  }
};

export async function gateMetroOrigin({
  origin,
  metroPort,
  platform,
  entryPoint = 'index',
  readRecords,
  isProof,
  probe = defaultProbe,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = GATE_TIMEOUT_MS,
}: GateOptions): Promise<GateResult> {
  const since = now();
  const controller = new AbortController();
  const request = probe(probeBundleUrl(origin, platform, entryPoint), controller.signal);
  void request.catch(() => {});

  try {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      for (const record of readRecords()) {
        if (isProof(record, since)) return { ok: true };
      }
      await sleep(POLL_MS);
    }
  } finally {
    controller.abort();
  }

  const status = await request.catch(() => null);
  return {
    failed: true,
    code: REMOTE_METRO_WRONG,
    reason: describeMiss(origin, metroPort, status),
    remedy:
      `Check that ${origin} forwards to port ${metroPort} on THIS machine. ` +
      'A tunnel built for a port this workspace no longer holds will answer normally and serve a different project. ' +
      '`stim-cli start` prints the port it reserved.',
  };
}

export function describeMiss(origin: string, metroPort: number | string, status: number | null): string {
  if (status === null) {
    return `${origin} did not answer, so it cannot be this workspace's Metro (port ${metroPort}).`;
  }
  if (status >= 500) {
    return `${origin} answered ${status}, so it reached a tunnel but not a dev server (port ${metroPort} may no longer be forwarded).`;
  }
  return `${origin} answered ${status}, but the request never reached THIS workspace's Metro on port ${metroPort} -- it is serving a different dev server.`;
}
