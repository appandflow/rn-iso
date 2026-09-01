import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import type { NdjsonRecord } from '../ndjson.ts';
import { isBundleProof, readMetroRecords } from './app-install.ts';
import { bundleEntryPoint } from './device-remote.ts';
import { gateMetroOrigin } from './metro-gate.ts';
import type { LanCandidate } from './lan-address.ts';

const IP_TXT = 'ip.txt';

export interface LanSelection {
  address: string;
  interfaceName: string | null;
  pinned: boolean;
  candidates: number;
}

export function chooseLanAddress({
  pinned = null,
  candidates,
}: {
  pinned?: string | null;
  candidates: readonly LanCandidate[];
}): LanSelection | null {
  const list = Array.isArray(candidates) ? candidates : [];
  if (pinned) {
    const known = list.find((candidate) => candidate.address === pinned);
    return { address: pinned, interfaceName: known?.interfaceName ?? null, pinned: true, candidates: list.length };
  }
  const first = list[0];
  if (!first) return null;
  return { address: first.address, interfaceName: first.interfaceName, pinned: false, candidates: list.length };
}

export function lanOriginUrlFor(address: string, port: number | string): string {
  return `http://${address}:${port}`;
}

// RCTBundleURLProvider.mm:206 guessPackagerHost trims newlines and nothing else,
// then hands the value to serverRootWithHostPort (line 70), which interpolates
// it into a URL verbatim and consults the compiled RCT_METRO_PORT default only
// when the value carries no colon. So the file holds exactly `<addr>:<port>`.
export function ipTxtContents(address: string, port: number | string): string {
  return `${String(address).trim()}:${String(port).trim()}\n`;
}

export function writeIpTxt(
  appPath: string,
  address: string,
  port: number | string,
  { write = writeFileSync }: { write?: typeof writeFileSync } = {},
): string {
  const path = join(appPath, IP_TXT);
  write(path, ipTxtContents(address, port), 'utf-8');
  return path;
}

export async function ensureLanReachable({
  origin,
  metroPort,
  root,
  isExpo,
  logsDir,
  gateOrigin = gateMetroOrigin,
  readRecords = null,
}: {
  origin: string;
  metroPort: number | string;
  root: string;
  isExpo: boolean;
  logsDir: string;
  gateOrigin?: typeof gateMetroOrigin;
  readRecords?: (() => NdjsonRecord[]) | null;
}): Promise<{ ok: true } | { failed: string; remedy: string }> {
  const result = await gateOrigin({
    origin,
    metroPort,
    platform: 'ios',
    entryPoint: bundleEntryPoint(root, isExpo),
    readRecords: readRecords ?? (() => readMetroRecords(logsDir)),
    isProof: isBundleProof,
  });
  if (result.failed) {
    return {
      failed: result.reason ?? `${origin} is not this workspace's Metro.`,
      remedy:
        `The phone reaches Metro at ${origin}, so that address has to serve THIS workspace's dev server. ` +
        '`stim start` prints the port it reserved. Set ios.lanHost in .stim.json when this Mac has several ' +
        'network interfaces and the phone shares one that is not the first.',
    };
  }
  return { ok: true };
}

// The cache entry is never modified: the per-run address lives only in the copy
// that gets installed and deleted. `cp -R` preserves the symlinks and the exec
// bit a code signature seals over; `-c` clones the blocks when the filesystem
// can.
export function copyAppAside(
  appPath: string,
  {
    exec = null,
    mkdtemp = () => mkdtempSync(join(tmpdir(), 'stim-ios-device-')),
  }: { exec?: Executor | null; mkdtemp?: () => string } = {},
): { tmpDir: string; appPath: string } {
  const e = exec || getExecutor();
  const tmpDir = mkdtemp();
  const copy = join(tmpDir, basename(appPath));
  try {
    e.runFile('cp', ['-c', '-R', appPath, copy]);
  } catch {
    e.runFile('cp', ['-R', appPath, copy]);
  }
  return { tmpDir, appPath: copy };
}
