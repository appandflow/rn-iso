import { randomBytes } from 'crypto';
import { getExecutor } from '../exec.js';

export function parseSimctlList(jsonOutput) {
  const data = JSON.parse(jsonOutput);
  const sims = [];
  for (const [runtime, devices] of Object.entries(data.devices || {})) {
    for (const dev of devices) {
      if (!dev.isAvailable) continue;
      sims.push({
        udid: dev.udid,
        name: dev.name,
        state: dev.state,
        runtime,
      });
    }
  }
  return sims;
}

export function listAllIosSims() {
  const out = getExecutor().run('xcrun simctl list devices --json');
  return parseSimctlList(out);
}

export function listBootedIosSims() {
  return listAllIosSims().filter(s => s.state === 'Booted');
}

export function selectIosDevice({ existingUdid, claimedUdids }) {
  const sims = listAllIosSims();
  const claimed = new Set(claimedUdids);

  if (existingUdid) {
    const found = sims.find(s => s.udid === existingUdid);
    if (found) {
      return { kind: 'reuse', udid: found.udid, state: found.state };
    }
  }

  // Prefer booted unclaimed sims (no boot needed). Then fall back to shutdown
  // unclaimed sims (boot rather than create new). Only create new when nothing
  // unclaimed exists at all.
  const booted = sims.find(s => s.state === 'Booted' && !claimed.has(s.udid));
  if (booted) {
    return { kind: 'allocate', udid: booted.udid, state: booted.state };
  }
  const shutdown = sims.find(s => s.state === 'Shutdown' && !claimed.has(s.udid));
  if (shutdown) {
    return { kind: 'allocate', udid: shutdown.udid, state: shutdown.state };
  }

  return { kind: 'needsBoot' };
}

export function bootIosSim(udid) {
  const exec = getExecutor();
  try {
    exec.run(`xcrun simctl boot ${udid}`);
  } catch (e) {
    // simctl errors with "Unable to boot device in current state: Booted" if already booted.
    if (!String(e?.message || e).includes('Booted')) throw e;
  }
  exec.runQuiet('open -a Simulator');
}

export function shutdownIosSim(udid) {
  getExecutor().runQuiet(`xcrun simctl shutdown ${udid}`);
}

export function listIosDeviceTypes() {
  const exec = getExecutor();
  const out = exec.run('xcrun simctl list devicetypes --json');
  const data = JSON.parse(out);
  return (data.devicetypes || []).map(dt => ({
    identifier: dt.identifier,
    name: dt.name,
  }));
}

export function createIosSim(deviceTypeId, runtimeId) {
  const suffix = randomBytes(3).toString('hex');
  const name = `rn-iso-${suffix}`;
  const out = getExecutor().run(`xcrun simctl create "${name}" "${deviceTypeId}" "${runtimeId}"`);
  return out.trim();
}

export function listIosRuntimes() {
  const out = getExecutor().run('xcrun simctl list runtimes --json');
  const data = JSON.parse(out);
  return (data.runtimes || [])
    .filter(r => r.isAvailable && r.platform === 'iOS')
    .map(r => ({
      identifier: r.identifier,
      name: r.name,
      version: r.version,
      supportedDeviceTypes: (r.supportedDeviceTypes || []).map(d => ({
        identifier: d.identifier,
        name: d.name,
      })),
    }));
}
