export type TunnelMode = 'auto' | 'off' | 'expo' | 'cloudflared' | 'ngrok';

export const TUNNEL_MODES: readonly TunnelMode[] = ['auto', 'off', 'expo', 'cloudflared', 'ngrok'];

export const PUBLIC_METRO_ENV = 'STIM_METRO_PUBLIC_URL';

// Prefer ngrok because Cloudflare quick tunnels can take minutes to become routable.
const MANAGED_PROVIDERS = ['ngrok', 'cloudflared'] as const;
export type ManagedProvider = (typeof MANAGED_PROVIDERS)[number];

export type ReachPlan =
  | { origin: string; gate: boolean }
  | { expoTunnel: true }
  | { start: ManagedProvider }
  | { failed: string; remedy: string };

export interface ReachInputs {
  mode: TunnelMode;
  metroPort: number | string;
  publicUrl?: string | null;
  isExpo: boolean;
  available?: readonly ManagedProvider[];
}

const NAMED: Record<string, string> = {
  cloudflared: '`cloudflared` (brew install cloudflared)',
  ngrok: '`ngrok` (brew install ngrok, then `ngrok config add-authtoken <token>`)',
};

export function planMetroReach({ mode, metroPort, publicUrl = null, isExpo, available = [] }: ReachInputs): ReachPlan {
  const named = publicUrl?.trim().replace(/\/+$/, '') || null;

  if (mode === 'off') {
    return { origin: `http://localhost:${metroPort}`, gate: false };
  }

  if (named) return { origin: named, gate: true };

  if (mode === 'expo') {
    if (!isExpo) {
      return {
        failed: 'metro.tunnel is "expo", but this workspace does not run an Expo dev server.',
        remedy: 'Use "auto" to let stim start a tunnel, or "off" if the device shares this machine.',
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

  const provider = available[0];
  if (provider) return { start: provider };
  return {
    failed: `A remote device cannot reach this workspace's Metro on port ${metroPort}, and no tunnel is available to give it one.`,
    remedy:
      `Install ${NAMED.ngrok} or ${NAMED.cloudflared} and Stim will manage the tunnel for you. ` +
      'If you already have one, set metro.publicUrl to its URL. ' +
      'If the device shares this machine (a local `agent-device proxy`), set metro.tunnel to "off".',
  };
}

export function detectProviders(onPath: (bin: string) => boolean): ManagedProvider[] {
  return MANAGED_PROVIDERS.filter((p) => onPath(p));
}
