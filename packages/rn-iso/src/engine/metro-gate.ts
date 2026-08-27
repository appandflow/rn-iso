// src/engine/metro-gate.ts -- proving that an address actually reaches THIS
// workspace's Metro, before anything expensive depends on it.
//
// WHY THIS EXISTS. The local Metro gate checks the reserved port for IDENTITY,
// not occupancy: resolveProjectMetro proves the process listening there
// belongs to this project and reports `notOurs: foreign-cwd` when it does not,
// precisely so a foreign bundler cannot serve this app. A public URL is a
// SECOND address for that same brokered resource, and it arrived with no such
// check. Observed live: a tunnel built for port 8085 outlived the reservation,
// another workspace took 8085, and the tunnel then published THAT project's
// dev server -- healthy, answering, and wrong.
//
// HOW IT PROVES IT. Not by asking the address what it is; a foreign Metro
// answers `/status` exactly like ours. It asks for a BUNDLE through the
// address and then watches THIS workspace's own NDJSON log for the request
// arriving. That is the same evidence verifyLaunch uses to prove a launch
// reached this dev server, reused one step earlier -- so the gate cannot
// disagree with the verification that follows it.
//
// The request is abandoned as soon as the proof lands: what is being measured
// is that the bytes were ASKED FOR here, not that they arrived back. Metro
// logs the build on start, so the answer comes long before four megabytes of
// bundle would.
import type { NdjsonRecord } from '../ndjson.ts';

export const REMOTE_METRO_WRONG = 'RN_ISO_REMOTE_METRO_WRONG';

// Long enough for a cold Metro to start building a large graph, short enough
// that a dead tunnel does not hold up a run for a minute. A cold bundle can
// take longer to FINISH, but the event this waits for is logged at start.
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
  /** Reads this workspace's Metro records, newest included. */
  readRecords: () => NdjsonRecord[];
  /** True when a record proves a bundle was requested after `since`. */
  isProof: (record: NdjsonRecord, since: number) => boolean;
  /** Status code only, or null when the request never landed. */
  probe?: (url: string, signal: AbortSignal) => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

// The bundle path differs between an Expo dev server and a bare one, but both
// answer this: Expo rewrites /index.bundle onto its virtual entry, and bare RN
// serves it directly. `dev=true` keeps it in the same cache bucket the app
// will use, so the probe warms exactly the bundle the launch then wants
// instead of building a second one.
export function probeBundleUrl(origin: string, platform: 'ios' | 'android'): string {
  return `${origin.replace(/\/+$/, '')}/index.bundle?platform=${platform}&dev=true`;
}

const defaultProbe = async (url: string, signal: AbortSignal): Promise<number | null> => {
  try {
    const res = await fetch(url, { signal, redirect: 'follow' });
    return res.status;
  } catch {
    return null;
  }
};

/**
 * Prove `origin` reaches THIS workspace's Metro, or refuse.
 *
 * Fails CLOSED. An address that cannot be proven is treated as the wrong
 * address, because the failure it guards against is silent: the app loads
 * another project's bundle and everything downstream looks fine.
 */
export async function gateMetroOrigin({
  origin,
  metroPort,
  platform,
  readRecords,
  isProof,
  probe = defaultProbe,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = GATE_TIMEOUT_MS,
}: GateOptions): Promise<GateResult> {
  const since = now();
  const controller = new AbortController();
  // Deliberately not awaited: the proof is the log entry, not the response.
  // A rejection here is not a failure on its own -- aborting the request once
  // the proof lands rejects it by design -- so the outcome is decided purely
  // by what reached the log.
  const request = probe(probeBundleUrl(origin, platform), controller.signal);
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
      '`rn-iso start` prints the port it reserved.',
  };
}

// PURE. What the probe's outcome says about the address, which is more useful
// than "no proof arrived" on its own.
export function describeMiss(origin: string, metroPort: number | string, status: number | null): string {
  if (status === null) {
    return `${origin} did not answer, so it cannot be this workspace's Metro (port ${metroPort}).`;
  }
  if (status >= 500) {
    return `${origin} answered ${status}, so it reached a tunnel but not a dev server (port ${metroPort} may no longer be forwarded).`;
  }
  // The dangerous case: something healthy answered, and it was not us.
  return `${origin} answered ${status}, but the request never reached THIS workspace's Metro on port ${metroPort} -- it is serving a different dev server.`;
}
