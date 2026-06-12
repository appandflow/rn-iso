import { request } from 'http';
import { existsSync } from 'fs';
import { loadConfig, allMetroPorts, removeProject } from './config.js';

export function isMetroRunning(port) {
  return new Promise((resolve) => {
    const req = request(
      { hostname: 'localhost', port, path: '/status', timeout: 2000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data.includes('packager-status:running')));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export function computeNextPort() {
  const ports = allMetroPorts();
  if (ports.length === 0) return 8082;
  return Math.max(...ports, 8081) + 1;
}

export async function findReclaimablePort(excludeProjectPath, probe = isMetroRunning) {
  const cfg = loadConfig();
  if (!cfg?.projects) return null;
  const candidates = [];
  for (const [path, proj] of Object.entries(cfg.projects)) {
    if (path === excludeProjectPath) continue;
    // Only projects whose path no longer exists are reclaimable: reclaiming
    // removes the whole entry, and doing that to a live project would also
    // drop its device claim out from under it.
    if (existsSync(path)) continue;
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

export async function allocatePort(projectPath, probe = isMetroRunning) {
  const reclaim = await findReclaimablePort(projectPath, probe);
  if (reclaim) {
    removeProject(reclaim.ownerPath);
    return reclaim.port;
  }
  return computeNextPort();
}
