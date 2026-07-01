import { randomBytes } from 'crypto';
import { getExecutor } from '../exec.js';

export function parseSimctlList(jsonOutput) {
  const data = JSON.parse(jsonOutput);
  const sims = [];
  for (const [runtime, devices] of Object.entries(data.devices || {})) {
    // Skip non-iOS runtimes (watchOS, tvOS, visionOS). iOS runtime IDs look
    // like com.apple.CoreSimulator.SimRuntime.iOS-26-2 (the others have
    // watchOS-, tvOS-, xrOS- in place of iOS-).
    if (!/\.iOS-/.test(runtime)) continue;
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

// "iPhone 16 Pro (ABC-123-...)" if simctl knows about the UDID; the bare
// UDID otherwise (deleted sim, or simctl unavailable).
export function formatIosLabel(udid) {
  try {
    const sim = listAllIosSims().find(s => s.udid === udid);
    if (sim) return `${sim.name} (${udid})`;
  } catch { /* simctl not available */ }
  return udid;
}

export function deviceFamilyRank(name) {
  if (/^iPhone/i.test(name)) return 0;
  if (/^iPad/i.test(name)) return 1;
  return 2;
}

export function sortSims(sims, usage = {}) {
  return [...sims].sort((a, b) => {
    // 1. Family: iPhones before iPads before others.
    const fa = deviceFamilyRank(a.name);
    const fb = deviceFamilyRank(b.name);
    if (fa !== fb) return fa - fb;
    // 2. State: booted before shutdown (within the same family), so an
    // already-running sim is reused instead of booting another.
    if (a.state === 'Booted' && b.state !== 'Booted') return -1;
    if (b.state === 'Booted' && a.state !== 'Booted') return 1;
    // 3. Runtime version: newest iOS runtime first, so --auto and agent
    // selection prefer the latest installed runtime over older ones.
    const va = parseRuntimeVersion(a.runtime);
    const vb = parseRuntimeVersion(b.runtime);
    if (va !== vb) return vb.localeCompare(va, undefined, { numeric: true });
    // 4. Usage count: descending (frequently picked sims float up).
    const ua = usage[a.udid] || 0;
    const ub = usage[b.udid] || 0;
    if (ua !== ub) return ub - ua;
    // 5. Name: stable alphabetical.
    return a.name.localeCompare(b.name);
  });
}

export function selectIosDevice({ existingUdid, claimedUdids, usage = {} }) {
  const sims = listAllIosSims();
  const claimed = new Set(claimedUdids);

  if (existingUdid) {
    const found = sims.find(s => s.udid === existingUdid);
    if (found) {
      return { kind: 'reuse', udid: found.udid, name: found.name, state: found.state };
    }
  }

  if (sims.length === 0) return { kind: 'noSims' };

  const unclaimed = sims.filter(s => !claimed.has(s.udid));
  if (unclaimed.length === 0) {
    // Sims exist but every one is claimed by another project or a
    // reservation. The picker can offer to steal one; the caller decides.
    return { kind: 'allClaimed', candidates: sortSims(sims, usage) };
  }

  return { kind: 'allocate', candidates: sortSims(unclaimed, usage) };
}

export function parseRuntimeVersion(runtimeId) {
  // e.g. com.apple.CoreSimulator.SimRuntime.iOS-26-2 -> "26.2"
  const m = runtimeId.match(/iOS-(\d+)(?:-(\d+))?$/);
  if (!m) return runtimeId;
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
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
