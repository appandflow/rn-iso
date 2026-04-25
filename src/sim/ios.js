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

  const candidate = sims.find(s => s.state === 'Booted' && !claimed.has(s.udid));
  if (candidate) {
    return { kind: 'allocate', udid: candidate.udid, state: candidate.state };
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
    .map(r => ({ identifier: r.identifier, name: r.name, version: r.version }));
}
