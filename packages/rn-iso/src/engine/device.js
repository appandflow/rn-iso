// src/engine/device.js -- the owned-device guarantee, shared by every command
// that needs a device to install onto.
//
// `ensureOwnedDevice` moved here verbatim from `commands/up.js`: it is no
// longer `up`'s alone once `ios` / `android` need the same guarantee, and two
// copies of the ownership rule is exactly the drift CLAUDE.md item 2 warns
// about. `up.js` re-exports it so nothing about that command changed.
//
// The ownership rule (CLAUDE.md item 2) is the invariant everything below
// enforces: rn-iso only ever creates, boots, or destroys a device it created
// itself, named `rn-iso-<label>` and recorded with `owned: true`.
import chalk from 'chalk';
import {
  allConsolePortsAndSerials,
  loadConfig,
  setDevice,
} from '../config.js';
import {
  bootIosSim,
  createOwnedIosSim,
  listAllIosSims,
  listIosDeviceTypes,
  resolveOwnedIosSim,
} from '../sim/ios.js';
import {
  bootAndroidEmulator,
  createOwnedAvd,
  listAdbDevices,
  listAvds,
  nextConsolePort,
  ownedAvdName,
  resolveOwnedAvdSerial,
  waitForBoot,
} from '../sim/android.js';

// Reuse the recorded device for `platform`, booting it if we own it and it
// is shut down; create a new owned one if there is no usable record.
//
// Ownership rule: never boot, shut down, or destroy a device rn-iso did not
// create. A legacy record (no `owned: true`) is reused only if it is
// already live; if it is shut down / not running we do NOT boot it -- we
// print a note and leave it as-is (the port is still reserved by the
// caller). A recorded device that no longer exists at all (deleted sim,
// removed AVD) is dropped and falls through to creation.
export async function ensureOwnedDevice({ platform, project, projectPath, label, settings, flags = {}, note = () => {}, out = () => {} }) {
  const record = project?.platforms?.[platform] || null;
  if (platform === 'ios') {
    return ensureOwnedIosDevice({ record, projectPath, label, settings, flags, note, out });
  }
  return ensureOwnedAndroidDevice({ record, projectPath, label, settings, flags, note, out });
}

function ensureOwnedIosDevice({ record, projectPath, label, settings, flags, note, out }) {
  if (record?.deviceUdid) {
    if (record.owned) {
      // Re-verify identity against the LIVE sim list by name BEFORE
      // booting -- a raw udid lookup would boot whatever simulator that
      // udid now resolves to, even if it has since been renamed away from
      // rn-iso- ownership (or the record is stale/mistyped).
      const resolved = resolveOwnedIosSim(record.deviceUdid);
      if (resolved.notOwned) {
        note(chalk.yellow(`Note: recorded sim is now named "${resolved.notOwned}", not rn-iso-owned by name -- creating a fresh owned sim instead of booting it.`));
        // Fall through to creation below; do NOT boot a sim we don't own.
      } else if (resolved.missing) {
        // Sim was deleted out from under the record: fall through to creation.
      } else {
        const sim = resolved.sim;
        // Honour --device-type / settings on REUSE, not just on creation.
        // Silently booting the old model made the flag look broken.
        const wantedType = flags.deviceType || settings?.ios?.deviceType;
        const mismatch = deviceTypeMismatch(sim.deviceTypeIdentifier, wantedType, listIosDeviceTypes());
        if (mismatch) {
          throw new Error(
            `${mismatch}. rn-iso will not silently boot a different model. ` +
            'Run `rn-iso release` to delete the current sim, then `up ios` again to create the requested one.'
          );
        }
        if (sim.state !== 'Booted') {
          out(chalk.dim(`Booting owned sim ${sim.name} (${sim.udid})...`));
          bootIosSim(sim.udid);
        }
        const updated = { deviceUdid: sim.udid, owned: true, deviceName: record.deviceName ?? sim.name };
        setDevice(projectPath, 'ios', updated);
        return updated;
      }
    } else {
      // Legacy: reuse only if already live; never boot it ourselves.
      const sim = listAllIosSims().find(s => s.udid === record.deviceUdid);
      if (sim) {
        if (sim.state !== 'Booted') {
          note(chalk.yellow(`Note: assigned sim ${sim.name} (${sim.udid}) is shut down and is not owned by rn-iso, so it will not be booted automatically.`));
          note(chalk.dim('Boot it yourself, or run `rn-iso release` to switch this project to an owned device.'));
        }
        return record;
      }
      // Sim was deleted out from under the record: fall through to creation.
    }
  }

  const created = createOwnedIosSim(label, {
    deviceType: flags.deviceType || settings.ios?.deviceType,
    runtime: flags.runtime || settings.ios?.runtime,
  });
  out(chalk.dim(`Created owned sim ${created.name} (${created.udid})`));
  // Record ownership BEFORE booting: if boot throws (timeout, etc.) the
  // record must already exist so a retry reuses this sim instead of
  // creating another one.
  const newRecord = { deviceUdid: created.udid, owned: true, deviceName: created.name };
  setDevice(projectPath, 'ios', newRecord);
  bootIosSim(created.udid);
  return newRecord;
}

// True if some OTHER registered project's android record already names
// avdName. Used by the avdmanager "already exists" recovery path to tell a
// genuine same-project retry (safe to adopt) apart from a label collision
// with a different project (must error, not silently hijack).
function findOtherProjectOwningAvd(avdName, projectPath) {
  const cfg = loadConfig();
  for (const [path, proj] of Object.entries(cfg?.projects || {})) {
    if (path === projectPath) continue;
    if (proj?.platforms?.android?.avdName === avdName) return path;
  }
  return null;
}

async function ensureOwnedAndroidDevice({ record, projectPath, label, settings, flags, note, out }) {
  // An explicit --serial short-circuits everything: the caller named a piece
  // of hardware, so there is nothing to create, boot, or own.
  if (flags.serial) {
    const resolved = resolvePhysicalSerial(flags.serial, listAdbDevices());
    if (resolved.error) throw new Error(resolved.error);
    setDevice(projectPath, 'android', resolved.ok);
    out(chalk.dim(`Assigned physical device ${resolved.ok.serial} (not owned: never booted or deleted by rn-iso)`));
    return resolved.ok;
  }
  if (record?.avdName) {
    if (record.owned) {
      // Verify identity against the LIVE adb list before deciding "ours is
      // running" -- the recorded consolePort is a slot, not an identity,
      // and may now be held by a foreign emulator (e.g. Android Studio's
      // own default on 5554). Deciding liveness from the port alone would
      // adb-reverse onto, and report the facts of, someone else's emulator.
      const resolved = resolveOwnedAvdSerial(record.avdName);
      if (resolved.notOwned) {
        note(chalk.yellow(`Note: recorded AVD ${record.avdName} is not rn-iso-owned by name -- creating a fresh owned AVD instead of reusing it.`));
        // Fall through to creation below.
      } else if (resolved.serial) {
        // Ours is genuinely running at this serial: reuse it as recorded.
        const consolePort = Number(resolved.serial.replace(/^emulator-/, ''));
        const updated = {
          avdName: record.avdName,
          consolePort,
          owned: true,
          deviceName: record.deviceName ?? record.avdName,
        };
        setDevice(projectPath, 'android', updated);
        return updated;
      } else if (!resolved.missing) {
        // notRunning: the recorded port is either idle or held by a
        // foreign emulator. Boot OUR avd on a newly allocated port instead
        // of trusting the recorded one -- the union port-picking logic
        // below already avoids ports currently in use.
        out(chalk.dim(`Recorded port for owned AVD ${record.avdName} is not currently ours; booting it on a freshly allocated port...`));
        return await bootOwnedAvdOnFreshPort({ avdName: record.avdName, projectPath, deviceName: record.deviceName, out });
      }
      // resolved.missing: AVD was deleted out from under the record --
      // fall through to creation below.
    } else {
      // Legacy: reuse only if already running; never boot it ourselves.
      const avdExists = listAvds().includes(record.avdName);
      if (avdExists) {
        const adb = listAdbDevices();
        const running = adb.emulators.some(e => e.consolePort === record.consolePort);
        if (!running) {
          note(chalk.yellow(`Note: assigned AVD ${record.avdName} (emulator-${record.consolePort}) is shut down and is not owned by rn-iso, so it will not be booted automatically.`));
          note(chalk.dim('Boot it yourself, or run `rn-iso release` to switch this project to an owned device.'));
        }
        return record;
      }
      // AVD was deleted out from under the record: fall through to creation.
    }
  } else if (record?.serial) {
    // Legacy physical-device assignment: always reused as-is, never created
    // or booted (we cannot boot hardware).
    const adb = listAdbDevices();
    const present = adb.physical.some(p => p.serial === record.serial);
    if (!present) {
      note(chalk.yellow(`Note: physical device ${record.serial} is not currently connected.`));
    }
    return record;
  }

  let created;
  try {
    created = createOwnedAvd(label, { systemImage: flags.systemImage || settings.android?.systemImage });
  } catch (e) {
    // A prior run may have created the AVD and then thrown before recording
    // it (e.g. a boot timeout, back when the record was written after
    // boot) -- avdmanager then refuses every subsequent create with
    // "already exists", permanently wedging this project. Since the AVD is
    // ours by name, adopt it instead of failing forever.
    const message = String(e?.message || e);
    const avdName = ownedAvdName(label);
    if (message.includes('already exists') && listAvds().includes(avdName)) {
      // Guard against hijacking another project's device: the "already
      // exists" recovery above exists for THIS project's own abandoned AVD
      // from a prior run, not for adopting a different project's AVD just
      // because its label sanitized to the same name (e.g. two monorepo
      // app-dir projects with no distinguishing --label).
      const owner = findOtherProjectOwningAvd(avdName, projectPath);
      if (owner) {
        throw new Error(`AVD ${avdName} already exists and is owned by another project (${owner}). Pass a distinct --label to avoid the collision instead of hijacking it.`);
      }
      created = { avdName };
      out(chalk.dim(`Recovered existing owned AVD ${avdName} (unrecorded from a prior run)`));
    } else {
      throw e;
    }
  }
  out(chalk.dim(`Created owned AVD ${created.avdName}`));
  return bootOwnedAvdOnFreshPort({ avdName: created.avdName, projectPath, deviceName: created.avdName, out });
}

// Boots avdName on a freshly allocated console port and records ownership
// BEFORE booting: if boot throws (timeout, etc.) the record must already
// exist so a retry reuses/boots this AVD instead of hitting avdmanager's
// "already exists" wedge on re-creation. Shared by fresh-AVD creation and
// by the owned-reuse path's "recorded port isn't ours" fallback (I6).
async function bootOwnedAvdOnFreshPort({ avdName, projectPath, deviceName, out }) {
  // Union config-recorded console ports with ports adb currently sees in
  // use (live emulators, plus unhealthy entries that still carry a
  // console port) -- a foreign emulator (e.g. Android Studio's default on
  // 5554) has no rn-iso config entry, so config-only allocation would spawn
  // straight onto it.
  const adbLive = listAdbDevices();
  const livePorts = [
    ...adbLive.emulators.map(e => e.consolePort),
    ...adbLive.unhealthy.filter(u => u.consolePort != null).map(u => u.consolePort),
  ];
  const claimedPorts = [...allConsolePortsAndSerials().androidConsolePorts, ...livePorts];
  const consolePort = nextConsolePort(claimedPorts);
  const newRecord = { avdName, consolePort, owned: true, deviceName: deviceName ?? avdName };
  setDevice(projectPath, 'android', newRecord);
  bootAndroidEmulator(avdName, consolePort);
  const serial = `emulator-${consolePort}`;
  out(chalk.dim(`Waiting for ${serial} to finish booting...`));
  const result = await waitForBoot(serial, 120000);
  if (!result.ok) {
    throw new Error(`Emulator ${serial} did not finish booting. Diagnostic: ${JSON.stringify(result.diagnostic)}`);
  }
  return newRecord;
}

// Pure. Validates an explicit --serial against what adb actually reports.
// Hardware cannot be spawned, so this is the one documented exception to the
// ownership rule: rn-iso assigns the serial and wires adb reverse, and never
// boots, shuts down, or deletes it. owned:false keeps every teardown path on
// the clear-only branch.
export function resolvePhysicalSerial(serial, adb) {
  const physical = adb?.physical || [];
  const emulators = adb?.emulators || [];
  if (emulators.some(e => e.serial === serial)) {
    return { error: `${serial} is an emulator, not a physical device. Use \`up android\` without --serial to get an owned emulator.` };
  }
  if (physical.some(p => p.serial === serial)) {
    return { ok: { serial, kind: 'physical', owned: false } };
  }
  if (physical.length === 0) {
    return { error: `No physical device is connected. adb reports none; check the cable and \`adb devices\`.` };
  }
  return { error: `${serial} is not connected. Connected physical devices: ${physical.map(p => p.serial).join(', ')}.` };
}

// Pure. Answers "is the sim we already own the model the caller just asked
// for?" -- returns a human-readable mismatch or null. Before this, flags.deviceType
// was consulted only on CREATION, so `up ios --device-type X` against an
// existing environment silently booted the old model and the flag looked
// broken. Returns null when either side is unknown: an unrecognized requested
// name is creation's error to report, not ours.
export function deviceTypeMismatch(recordedTypeId, requestedName, deviceTypes) {
  if (!requestedName || !recordedTypeId) return null;
  const wanted = (deviceTypes || []).find(d => d.name === requestedName);
  if (!wanted) return null;
  if (wanted.identifier === recordedTypeId) return null;
  const recorded = (deviceTypes || []).find(d => d.identifier === recordedTypeId);
  return `this project's sim is ${recorded ? recorded.name : recordedTypeId}, but --device-type asked for ${requestedName}`;
}

// --- the booted guarantee -------------------------------------------------
//
// `ensureOwnedDevice` records and STARTS a device; it does not wait for one.
// That was enough for `up`, whose caller went on to run its own build (which
// waits on its own). `ios` / `android` install onto the device in the very
// next step, and `simctl install` against a sim that is still "Booting"
// fails, so the wait has to happen somewhere -- here, once, rather than in
// each command.
//
// Returns the ready-to-install handle for the platform:
//   ios     { ok: true, udid }
//   android { ok: true, serial }
// and never throws on a tool failure: { failed: true, reason } instead, the
// same shape every other engine module in this layer uses, so a command
// branches on data rather than on catching.
const BOOT_POLL_MS = 500;

export async function ensureBooted({ platform, device, timeoutMs = 120000, pollMs = BOOT_POLL_MS, out = () => {} } = {}) {
  if (platform === 'ios') return ensureIosBooted({ device, timeoutMs, pollMs, out });
  if (platform === 'android') return ensureAndroidBooted({ device, timeoutMs, out });
  return { failed: true, reason: `Unknown platform "${platform}".` };
}

async function ensureIosBooted({ device, timeoutMs, pollMs, out }) {
  const udid = device?.deviceUdid;
  if (!udid) return { failed: true, reason: 'No iOS simulator is recorded for this project.' };

  // Same rule as teardown: re-resolve against the LIVE sim list before
  // issuing anything at the udid. A sim renamed away from the rn-iso- prefix
  // is not ours to boot, and one that is simply gone is not bootable at all.
  let resolved;
  try {
    resolved = resolveOwnedIosSim(udid);
  } catch (e) {
    return { failed: true, reason: `Could not list simulators: ${e?.message || e}` };
  }
  if (resolved.missing) {
    return { failed: true, reason: `Simulator ${udid} no longer exists. Run \`rn-iso up ios\` to create a fresh owned sim.` };
  }
  if (resolved.notOwned) {
    return { failed: true, reason: `Simulator ${udid} is now named "${resolved.notOwned}" and is not rn-iso-owned; refusing to boot it.` };
  }
  if (resolved.sim.state === 'Booted') return { ok: true, udid };

  out(chalk.dim(`Booting sim ${resolved.sim.name} (${udid})...`));
  try {
    bootIosSim(udid);
  } catch (e) {
    return { failed: true, reason: `Could not boot simulator ${udid}: ${e?.message || e}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let state = null;
    try {
      state = listAllIosSims().find(s => s.udid === udid)?.state ?? null;
    } catch {
      // simctl can fail transiently while a device set is being written;
      // keep polling until the deadline rather than failing on one bad read.
    }
    if (state === 'Booted') return { ok: true, udid };
  }
  return { failed: true, reason: `Simulator ${udid} did not reach the Booted state within ${Math.round(timeoutMs / 1000)}s.` };
}

async function ensureAndroidBooted({ device, timeoutMs, out }) {
  // A physical device (legacy records only -- v3 drops --serial) is never
  // booted by rn-iso: hardware cannot be spawned. It is either there or it
  // is not.
  if (!device?.avdName) {
    const serial = device?.serial;
    if (!serial) return { failed: true, reason: 'No Android device is recorded for this project.' };
    const present = listAdbDevices().physical.some(p => p.serial === serial);
    if (!present) return { failed: true, reason: `Device ${serial} is not connected. rn-iso never boots hardware; plug it in and check \`adb devices\`.` };
    return { ok: true, serial };
  }

  // The recorded console port is a slot, not an identity: resolve the AVD
  // against the live emulator list first, exactly as teardown does.
  let resolved;
  try {
    resolved = resolveOwnedAvdSerial(device.avdName);
  } catch (e) {
    return { failed: true, reason: `Could not list AVDs: ${e?.message || e}` };
  }
  if (resolved.missing) {
    return { failed: true, reason: `AVD ${device.avdName} no longer exists. Run \`rn-iso up android\` to create a fresh owned AVD.` };
  }
  if (resolved.notOwned) {
    return { failed: true, reason: `AVD ${device.avdName} is not rn-iso-owned by name; refusing to boot it.` };
  }
  if (resolved.serial) {
    // Running, but "running" is not "finished booting" -- an emulator answers
    // adb long before the framework is up, and `adb install` against it fails
    // with "Can't find service: package".
    const ready = await waitForBoot(resolved.serial, timeoutMs);
    if (!ready.ok) {
      return { failed: true, reason: `Emulator ${resolved.serial} never reported boot completion. Diagnostic: ${JSON.stringify(ready.diagnostic)}` };
    }
    return { ok: true, serial: resolved.serial };
  }

  // notRunning: boot it on the recorded port, and only fall back to a fresh
  // one when that port is currently taken by something else.
  const serial = `emulator-${pickConsolePort(device.consolePort)}`;
  out(chalk.dim(`Booting owned AVD ${device.avdName} as ${serial}...`));
  try {
    bootAndroidEmulator(device.avdName, Number(serial.replace(/^emulator-/, '')));
  } catch (e) {
    return { failed: true, reason: `Could not start emulator for AVD ${device.avdName}: ${e?.message || e}` };
  }
  const ready = await waitForBoot(serial, timeoutMs);
  if (!ready.ok) {
    return { failed: true, reason: `Emulator ${serial} did not finish booting within ${Math.round(timeoutMs / 1000)}s. Diagnostic: ${JSON.stringify(ready.diagnostic)}` };
  }
  return { ok: true, serial };
}

// The recorded port when nothing live holds it, a freshly allocated one when
// something does. Booting onto an occupied console port silently attaches us
// to a foreign emulator, which is the failure resolveOwnedAvdSerial exists to
// prevent on the teardown side.
function pickConsolePort(recorded) {
  const adb = listAdbDevices();
  const live = [
    ...adb.emulators.map(e => e.consolePort),
    ...adb.unhealthy.filter(u => u.consolePort != null).map(u => u.consolePort),
  ];
  if (recorded && !live.includes(Number(recorded))) return Number(recorded);
  return nextConsolePort([...allConsolePortsAndSerials().androidConsolePorts, ...live]);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
