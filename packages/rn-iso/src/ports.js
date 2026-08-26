import { request } from 'http';
import { connect } from 'net';
import { existsSync } from 'fs';
import { loadConfig, allMetroPorts, removeProject, claimMetroPort } from './config.js';
import { isOnMountedVolume, listMountedVolumes } from './fs-util.js';

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

// A real connect, not a /status probe and not a bind.
//
// Not /status: isMetroRunning only answers for Metro, so probing with it would
// hand out a port held by a web server or a stale bundler.
//
// Not bind: a bind test looks right and fails in production. Node sets
// SO_REUSEADDR, so binding 0.0.0.0 SUCCEEDS while another PROCESS holds
// 127.0.0.1 on the same port -- the port reads free and gets handed out
// anyway. (A same-process bind test does raise EADDRINUSE, which is exactly
// how a unit test can pass while the real case fails.)
//
// Connecting to 127.0.0.1 answers the question that actually matters: will a
// bundler started here collide with something already listening?
export function isPortFree(port, { timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (free) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(free);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(false));   // something is listening
    sock.once('error', () => done(true));      // ECONNREFUSED: nothing there
    sock.once('timeout', () => done(false));   // filtered/hung: assume taken
  });
}

const FIRST_PORT = 8082;
const PORT_SCAN_LIMIT = 200;

// Scans upward for a port that is BOTH unclaimed in the registry and actually
// free on the machine. The old implementation was max(registry)+1 with no
// liveness check, which deterministically handed the same occupied port to
// several projects in a row -- releasing a project lowered the max again, so
// two runs in a row returned the same bad number. Scanning also reuses gaps
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

export async function findReclaimablePort(excludeProjectPath, probe = isMetroRunning, { isMounted = isOnMountedVolume, mountedVolumes } = {}) {
  const cfg = loadConfig();
  if (!cfg?.projects) return null;
  const mounted = mountedVolumes || listMountedVolumes();
  const candidates = [];
  for (const [path, proj] of Object.entries(cfg.projects)) {
    if (path === excludeProjectPath) continue;
    // Only projects whose path no longer exists are reclaimable: reclaiming
    // removes the whole entry, and doing that to a live project would also
    // drop its device claim out from under it.
    if (existsSync(path)) continue;
    // A path on a volume that is not mounted right now is not gone, it is
    // unplugged: the project still owns its label, port and device record.
    // allocatePort removes the entry of whatever this returns, so failing
    // open here would silently delete a live project's record -- the same
    // direction gc's dead-entry sweep already fails in (CLAUDE.md item 8).
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

const RESERVE_ATTEMPTS = 5;

// Allocation and recording are two steps with a gap between them: the probes
// take hundreds of milliseconds, and a second `start` running in parallel can
// pick the same port in that window. claimMetroPort writes only if the config
// still shows the port unclaimed, so a loser here simply allocates again --
// and that second pass now sees the winner's record and skips its port.
export async function reserveMetroPort(projectPath, probe = isMetroRunning, isFree = isPortFree) {
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
    const port = await allocatePort(projectPath, probe, isFree);
    const claimed = claimMetroPort(projectPath, port);
    if (claimed !== null) return claimed;
  }
  throw new Error(
    `Could not reserve a Metro port after ${RESERVE_ATTEMPTS} attempts: another rn-iso run claimed each one first. Retry.`
  );
}
