import { request } from 'http';
import { connect } from 'net';
import { existsSync } from 'fs';
import { loadConfig, allMetroPorts, removeProject, claimMetroPort } from './config.ts';
import { isOnMountedVolume, listMountedVolumes } from './fs-util.ts';

export function isMetroRunning(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = request({ hostname: 'localhost', port, path: '/status', timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(data.includes('packager-status:running')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export function isPortFree(port: number, { timeoutMs = 400 }: { timeoutMs?: number } = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (free: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(free);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(false));
    sock.once('error', () => done(true));
    sock.once('timeout', () => done(false));
  });
}

const FIRST_PORT = 8082;
const PORT_SCAN_LIMIT = 200;

export async function computeNextPort(isFree: (port: number) => Promise<boolean> = isPortFree): Promise<number> {
  const taken = new Set(allMetroPorts());
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_SCAN_LIMIT; port++) {
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(
    `Found no free Metro port between ${FIRST_PORT} and ${FIRST_PORT + PORT_SCAN_LIMIT - 1}. ` +
      'Free one up, or stop a stale bundler (`rn-iso status`, `rn-iso stop <port>`).',
  );
}

export interface ReclaimableCandidate {
  port: number;
  ownerPath: string;
}

export async function findReclaimablePort(
  excludeProjectPath: string,
  probe: (port: number) => Promise<boolean> = isMetroRunning,
  {
    isMounted = isOnMountedVolume,
    mountedVolumes,
  }: { isMounted?: (path: string, mountedVolumes?: string[]) => boolean; mountedVolumes?: string[] } = {},
): Promise<ReclaimableCandidate | null> {
  const cfg = loadConfig();
  if (!cfg?.projects) return null;
  const mounted = mountedVolumes || listMountedVolumes();
  const candidates: ReclaimableCandidate[] = [];
  for (const [path, proj] of Object.entries(cfg.projects)) {
    if (path === excludeProjectPath) continue;
    if (existsSync(path)) continue;
    if (!isMounted(path, mounted)) continue;
    if (typeof proj.metroPort === 'number') {
      candidates.push({ port: proj.metroPort, ownerPath: path });
    }
  }
  for (const c of candidates) {
    const alive = await probe(c.port);
    if (!alive) return c;
  }
  return null;
}

export async function allocatePort(
  projectPath: string,
  probe: (port: number) => Promise<boolean> = isMetroRunning,
  isFree: (port: number) => Promise<boolean> = isPortFree,
): Promise<number> {
  const reclaim = await findReclaimablePort(projectPath, probe);
  if (reclaim && (await isFree(reclaim.port))) {
    removeProject(reclaim.ownerPath);
    return reclaim.port;
  }
  return computeNextPort(isFree);
}

const RESERVE_ATTEMPTS = 5;

export async function reserveMetroPort(
  projectPath: string,
  probe: (port: number) => Promise<boolean> = isMetroRunning,
  isFree: (port: number) => Promise<boolean> = isPortFree,
): Promise<number> {
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
    const port = await allocatePort(projectPath, probe, isFree);
    const claimed = claimMetroPort(projectPath, port);
    if (claimed !== null) return claimed;
  }
  throw new Error(
    `Could not reserve a Metro port after ${RESERVE_ATTEMPTS} attempts: another rn-iso run claimed each one first. Retry.`,
  );
}
