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
        // Needed to tell whether a recorded sim is the device type the caller
        // asked for: the record only carries rn-iso-<label>, not the model.
        deviceTypeIdentifier: dev.deviceTypeIdentifier,
      });
    }
  }
  return sims;
}

export function listAllIosSims({ timeoutMs } = {}) {
  const out = getExecutor().run('xcrun simctl list devices --json', { timeoutMs });
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

// launchctl lines look like:
//   082a\t0\tUIKitApplication:com.example.app[082a][rb-legacy]
// A foreign UI-test runner holding the sim is the case we care about. Apple's
// own system apps are always present and mean nothing.
export function parseOccupyingApps(launchctlOutput) {
  if (typeof launchctlOutput !== 'string' || launchctlOutput.length === 0) return [];
  const ids = [];
  for (const line of launchctlOutput.split('\n')) {
    const m = line.match(/UIKitApplication:([^[\s]+)/);
    if (!m) continue;
    const bundleId = m[1];
    if (bundleId.startsWith('com.apple.')) continue;
    if (!/\.xctrunner$/.test(bundleId)) continue;
    ids.push(bundleId);
  }
  return ids;
}

// Fails CLOSED: an unanswerable probe reports "occupied". The pool-selection
// model this used to fail open for was deleted in 0.7 -- every caller is now a
// teardown site (release, shutdown, reclaim, gc), where failing open means
// deleting a sim that may still be driven by a foreign UI-test runner, which
// is exactly what the probe exists to prevent. Same direction as the
// unmounted-volume guard: on doubt, skip, do not destroy.
//
// A device that is not booted is the one case that is not doubt: nothing can
// be running on it, and `simctl spawn` cannot answer for it either -- it exits
// non-zero with "device is not booted", which the probe alone would read as
// occupied. That made a shut-down orphan permanently unreapable: `gc` reported
// it and skipped it on every run, forever. Check the state first, and only
// probe a device that is actually booted.
export function isSimOccupied(udid) {
  let sim;
  try {
    sim = listAllIosSims().find(s => s.udid === udid);
  } catch {
    // Could not read the device list: that IS doubt, so fall through to the
    // probe and let it fail closed.
    sim = undefined;
  }
  if (sim && sim.state !== 'Booted') return false;
  const out = getExecutor().runQuiet(`xcrun simctl spawn ${udid} launchctl list`);
  if (out === null || out === undefined) return true;
  return parseOccupyingApps(out).length > 0;
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

// Ranks an iPhone device type name for "newest". Sorting these names with
// localeCompare is wrong: letters sort after digits, so "iPhone SE (3rd
// generation)" outranked "iPhone 17 Pro Max" and every default sim on a stock
// Xcode install spawned as an SE. Generation number first, then the base model
// ahead of Pro/Pro Max/Plus -- "newest iPhone" means iPhone 17, and the base
// model is the lightest to boot. Lettered models (SE, Air, X) carry no
// generation and rank below every numbered one, but stay pickable when they
// are all that is installed.
function rankIphone(name) {
  const gen = /^iPhone\s+(\d+)/i.exec(name);
  return {
    gen: gen ? Number(gen[1]) : -1,
    // Shorter name == plainer variant, so the base model wins its generation.
    variant: -name.length,
  };
}

// Newest iPhone device type on the newest installed runtime, unless the
// caller pinned either by name. Pure: takes the listings as data.
export function pickDefaultIosCreation(deviceTypes, runtimes, { deviceType, runtime } = {}) {
  const rts = [...runtimes].sort((a, b) =>
    String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  const wantedRts = runtime
    ? rts.filter(r => r.version === runtime || r.name.endsWith(runtime))
    : rts;
  for (const rt of wantedRts) {
    const supported = (rt.supportedDeviceTypes || []).filter(d =>
      deviceType ? d.name === deviceType : /^iPhone/i.test(d.name));
    if (supported.length === 0) continue;
    const best = [...supported].sort((a, b) => {
      const ra = rankIphone(a.name), rb = rankIphone(b.name);
      return (rb.gen - ra.gen)
        || (rb.variant - ra.variant)
        || b.name.localeCompare(a.name, undefined, { numeric: true });
    })[0];
    return { deviceTypeId: best.identifier, runtimeId: rt.identifier };
  }
  return null;
}

export function sanitizeDeviceLabel(label) {
  return String(label).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function createOwnedIosSim(label, { deviceType, runtime } = {}) {
  const pick = pickDefaultIosCreation(listIosDeviceTypes(), listIosRuntimes(), { deviceType, runtime });
  if (!pick) {
    throw new Error('No matching simulator device type / runtime is installed. Install one via Xcode, or pass --device-type / --runtime.');
  }
  const name = `rn-iso-${sanitizeDeviceLabel(label)}`;
  const udid = getExecutor()
    .run(`xcrun simctl create "${name}" "${pick.deviceTypeId}" "${pick.runtimeId}"`)
    .trim();
  return { udid, name };
}

// Resolves a udid against the live sim list ONCE, before any destructive
// command (shutdown or delete) is issued at it. Ownership is decided purely
// by the "rn-iso-" name prefix -- the same rule deleteIosSim enforces -- so
// a caller can verify ownership up front instead of discovering it only
// after shutdownIosSim has already been fired at someone's real simulator.
// Three outcomes:
//   { sim }             found, and named like an rn-iso sim: safe to touch.
//   { missing: true }   no sim with this udid exists (already gone, or a
//                       stale/mistyped record) -- the honest already-gone
//                       path, not an error.
//   { notOwned: name }  found, but not rn-iso-owned by name (user renamed
//                       it, or the record is stale/wrong) -- must be
//                       reported as a skip, never shut down or deleted.
export function resolveOwnedIosSim(udid) {
  const sim = listAllIosSims().find(s => s.udid === udid);
  if (!sim) return { missing: true };
  if (!sim.name?.startsWith('rn-iso-')) return { notOwned: sim.name };
  return { sim };
}

// Defense in depth: deletion must only ever reach a sim rn-iso created
// itself. A future caller bug (wrong record, stale udid) must not be able
// to delete a user's real simulator. Idempotent: a udid that is already
// gone is a no-op, not an error. This is the backstop -- callers that shut
// a sim down first should verify ownership via resolveOwnedIosSim before
// that shutdown, not rely on this guard alone.
export function deleteIosSim(udid) {
  const result = resolveOwnedIosSim(udid);
  if (result.missing) return;
  if (result.notOwned) {
    throw new Error(`Refusing to delete simulator "${result.notOwned}" (${udid}): not an rn-iso-owned sim (name must start with "rn-iso-").`);
  }
  getExecutor().runQuiet(`xcrun simctl delete ${udid}`);
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
