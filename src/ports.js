import { request } from 'http';
import { createServer } from 'net';
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

// A real bind, not a /status probe. isMetroRunning only answers for Metro, so
// probing with it would hand out a port held by a web server, a stale bundler,
// or anything else that is not ours. Binding 0.0.0.0 fails with EADDRINUSE if
// anything holds the port on any interface.
export function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

const FIRST_PORT = 8082;
const PORT_SCAN_LIMIT = 200;

// Scans upward for a port that is BOTH unclaimed in the registry and actually
// free on the machine. The old implementation was max(registry)+1 with no
// liveness check, which deterministically handed the same occupied port to
// several projects in a row -- releasing a project lowered the max again, so
// `release` then `up` returned the same bad number. Scanning also reuses gaps
// left by released projects instead of climbing forever.
export async function computeNextPort(isFree = isPortFree) {
  const taken = new Set(allMetroPorts());
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_SCAN_LIMIT; port++) {
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(
    `Found no free Metro port between ${FIRST_PORT} and ${FIRST_PORT + PORT_SCAN_LIMIT - 1}. ` +
    'Free one up, or stop a stale bundler (`rn-iso status`, `rn-iso stop <port>`).'
  );
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

export async function allocatePort(projectPath, probe = isMetroRunning, isFree = isPortFree) {
  const reclaim = await findReclaimablePort(projectPath, probe);
  // A reclaimable port belongs to a project whose directory is gone AND whose
  // Metro no longer answers -- but something unrelated may have taken it since,
  // so it still has to pass the same bind check as a fresh port.
  if (reclaim && await isFree(reclaim.port)) {
    removeProject(reclaim.ownerPath);
    return reclaim.port;
  }
  return computeNextPort(isFree);
}
