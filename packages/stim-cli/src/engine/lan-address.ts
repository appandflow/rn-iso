import { networkInterfaces } from 'node:os';

export interface NetworkAddressLike {
  address?: unknown;
  family?: unknown;
  internal?: unknown;
}

export interface LanCandidate {
  interfaceName: string;
  address: string;
}

// react-native/scripts/react-native-xcode.sh probes en0 through en8 with
// `ipconfig getifaddr` and keeps the first that answers. Stim orders its
// candidates the same way so a Stim run and a plain Xcode run pick the same
// interface.
const EN_INTERFACE = /^en(\d+)$/;
const EXCLUDED_INTERFACE = /^(?:utun|bridge|awdl)/;
const LINK_LOCAL = /^169\.254\./;

function isIpv4(entry: NetworkAddressLike): boolean {
  return entry.family === 'IPv4' || entry.family === 4;
}

export function lanCandidates(
  interfaces: Record<string, readonly NetworkAddressLike[] | undefined> | null | undefined,
): LanCandidate[] {
  const ranked: Array<LanCandidate & { rank: number; index: number }> = [];
  const seen = new Set<string>();
  for (const [interfaceName, entries] of Object.entries(interfaces ?? {})) {
    if (EXCLUDED_INTERFACE.test(interfaceName)) continue;
    const en = EN_INTERFACE.exec(interfaceName);
    for (const entry of entries ?? []) {
      if (!entry || typeof entry !== 'object' || !isIpv4(entry) || entry.internal === true) continue;
      const address = typeof entry.address === 'string' ? entry.address.trim() : '';
      if (address === '' || LINK_LOCAL.test(address)) continue;
      if (seen.has(address)) continue;
      seen.add(address);
      ranked.push({
        interfaceName,
        address,
        rank: en ? 0 : 1,
        index: en ? Number(en[1]) : 0,
      });
    }
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.index - b.index ||
      a.interfaceName.localeCompare(b.interfaceName) ||
      a.address.localeCompare(b.address),
  );
  return ranked.map(({ interfaceName, address }) => ({ interfaceName, address }));
}

export function hostLanCandidates(
  interfaces: () => ReturnType<typeof networkInterfaces> = networkInterfaces,
): LanCandidate[] {
  return lanCandidates(interfaces());
}
