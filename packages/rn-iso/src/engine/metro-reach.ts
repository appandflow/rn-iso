// src/engine/metro-reach.ts -- how a REMOTE device reaches this workspace's
// Metro, decided in one place.
//
// This exists because the question has several right answers and one very
// wrong one, and the wrong one used to be the default. rn-iso previously
// INFERRED "the device is on this machine" from "the daemon URL is loopback"
// (isLoopbackDaemon). Those are not the same fact: `ssh -L 4310:localhost:4310
// macmini` makes a REMOTE daemon loopback-reachable, and the inference then
// pointed the app at `localhost:<port>`, which resolves on the Mac mini. Same
// silent wrong-Metro class as a stale tunnel.
//
// So nothing is inferred here. The policy is declared, and `auto` -- the
// default -- assumes the device is somewhere else, which is the safe
// direction: a device that CAN reach localhost loses nothing by being handed
// a tunnel, while a device that cannot loses the whole run.

/** How the device is expected to reach Metro. */
export type TunnelMode = 'auto' | 'off' | 'expo' | 'cloudflared' | 'ngrok';

export const TUNNEL_MODES: readonly TunnelMode[] = ['auto', 'off', 'expo', 'cloudflared', 'ngrok'];

/** The public Metro origin passed from `start` to remote device commands. */
export const PUBLIC_METRO_ENV = 'RN_ISO_METRO_PUBLIC_URL';

/** The tunnel providers rn-iso can start and reap itself. */
const MANAGED_PROVIDERS = ['ngrok', 'cloudflared'] as const;
export type ManagedProvider = (typeof MANAGED_PROVIDERS)[number];

/**
 * What the caller must do to give the device an address for Metro.
 *
 *   { origin }            already known -- use it, no tunnel to start
 *   { expoTunnel: true }  the dev server carries it (`expo start --tunnel`)
 *   { start: provider }   rn-iso starts, records and reaps this one
 *   { failed, remedy }    nothing available; refuse with something actionable
 */
export type ReachPlan =
  | { origin: string; gate: boolean }
  | { expoTunnel: true }
  | { start: ManagedProvider }
  | { failed: string; remedy: string };

export interface ReachInputs {
  mode: TunnelMode;
  metroPort: number | string;
  /** An address the operator supplied: a stable tunnel, or a setting. */
  publicUrl?: string | null;
  /** Whether this workspace's dev server is Expo's (it can tunnel itself). */
  isExpo: boolean;
  /** Which managed providers are on PATH, most preferred first. */
  available?: readonly ManagedProvider[];
}

const NAMED: Record<string, string> = {
  cloudflared: '`cloudflared` (brew install cloudflared)',
  ngrok: '`ngrok` (brew install ngrok, then `ngrok config add-authtoken <token>`)',
};

/**
 * PURE. Decide how the device will reach Metro.
 *
 * Order matters and each step earns its place:
 *
 * 1. `off` is the operator ASSERTING the device shares this host -- a
 *    same-machine `agent-device proxy`. It is the one case that needs no
 *    tunnel and no gate, because localhost genuinely is the answer. It must
 *    be declared rather than detected, which is the whole point of this file.
 * 2. An explicit URL wins over starting anything: the operator already built
 *    a tunnel, and a second one would be waste. It IS gated, because an
 *    address rn-iso did not create is an address it cannot vouch for.
 * 3. Explicit `expo` mode lets Expo tunnel its own dev server.
 * 4. Otherwise rn-iso starts a managed provider, preferring whichever one
 *    the caller ranked first.
 */
export function planMetroReach({ mode, metroPort, publicUrl = null, isExpo, available = [] }: ReachInputs): ReachPlan {
  const named = publicUrl?.trim().replace(/\/+$/, '') || null;

  if (mode === 'off') {
    // Asserted local: no tunnel, and no gate to run -- there is no third
    // party in the path to have got wrong.
    return { origin: `http://localhost:${metroPort}`, gate: false };
  }

  // An operator-supplied address is used whatever the mode says, because
  // starting a tunnel to a port that already has one is pure waste. It is
  // gated: rn-iso did not create it and cannot vouch for what it reaches.
  if (named) return { origin: named, gate: true };

  if (mode === 'expo') {
    if (!isExpo) {
      return {
        failed: 'metro.tunnel is "expo", but this workspace does not run an Expo dev server.',
        remedy: 'Use "auto" to let rn-iso start a tunnel, or "off" if the device shares this machine.',
      };
    }
    return { expoTunnel: true };
  }

  if (mode === 'cloudflared' || mode === 'ngrok') {
    if (!available.includes(mode)) {
      return {
        failed: `metro.tunnel is "${mode}", but ${mode} is not on PATH.`,
        remedy: `Install ${NAMED[mode] ?? mode}, or set metro.tunnel to "auto".`,
      };
    }
    return { start: mode };
  }

  // auto, on a bare RN workspace.
  const provider = available[0];
  if (provider) return { start: provider };
  return {
    failed: `A remote device cannot reach this workspace's Metro on port ${metroPort}, and no tunnel is available to give it one.`,
    remedy:
      `Install ${NAMED.ngrok} or ${NAMED.cloudflared} and rn-iso will manage the tunnel for you. ` +
      'If you already have one, set metro.publicUrl to its URL. ' +
      'If the device shares this machine (a local `agent-device proxy`), set metro.tunnel to "off".',
  };
}

/**
 * Which managed providers this machine can actually start, most preferred
 * first.
 *
 * ngrok outranks cloudflared deliberately. A cloudflared quick tunnel needs no
 * account, which is why it is the easy suggestion, but it hands back a new
 * random hostname every run and takes MINUTES to become routable -- long
 * enough that it reads as broken, which cost real debugging time here. ngrok
 * routes immediately and can hold a reserved domain. Whichever is present
 * wins; when both are, the faster one does.
 */
export function detectProviders(onPath: (bin: string) => boolean): ManagedProvider[] {
  return MANAGED_PROVIDERS.filter((p) => onPath(p));
}
