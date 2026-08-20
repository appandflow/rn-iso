// src/commands/up.js
//
// `rn-iso up <platform>` is the broker command: it ensures an OWNED device
// (creating one if needed), reserves the Metro port, wires adb reverse on
// Android, and prints the facts. It never runs a build and never starts
// Metro -- the agent starts Metro on the reserved port and runs the
// project's own build against the facts.
import chalk from 'chalk';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage, projectShortcut } from '../project.js';
import { gitCommonDir, repoRoot } from '../worktree.js';
import { resolveSettings } from '../settings.js';
import {
  getProject,
  upsertProject,
  setMetro,
  setDevice,
  allConsolePortsAndSerials,
  loadConfig,
} from '../config.js';
import { allocatePort } from '../ports.js';
import { resolveProjectMetro } from '../metro.js';
import { createOwnedIosSim, bootIosSim, listAllIosSims, resolveOwnedIosSim, listIosDeviceTypes } from '../sim/ios.js';
import {
  createOwnedAvd,
  listAvds,
  bootAndroidEmulator,
  waitForBoot,
  adbReverse,
  nextConsolePort,
  listAdbDevices,
  sanitizeAvdLabel,
  resolveOwnedAvdSerial,
} from '../sim/android.js';

export default function upCommand(program) {
  registerUp(program);
}

export function registerUp(program) {
  program
    .command('up <platform>')
    .description(
      'Ensure an owned device and reserve a Metro port for the current project, and print the facts. ' +
      'Never runs a build and never starts Metro -- start Metro on the reserved port and run the ' +
      'project\'s own build against the printed facts.'
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--device-type <name>', 'iOS device type to use when creating a new owned sim (e.g. "iPhone 17 Pro")')
    .option('--runtime <version>', 'iOS runtime version to use when creating a new owned sim (e.g. "26.2")')
    .option('--system-image <pkg>', 'Android system image package to use when creating a new owned AVD')
    .option('--serial <serial>', 'Android only: assign a connected PHYSICAL device by adb serial instead of creating an owned emulator. rn-iso never boots, shuts down, or deletes hardware')
    .action(async (platform, opts) => {
      const json = Boolean(opts.json);
      // In --json mode the JSON payload is the ONLY stdout content, so every
      // human-readable progress line is redirected to stderr instead of
      // being suppressed.
      const out = (line) => { if (json) console.error(line); else console.log(line); };
      const note = (line) => console.error(line);

      if (platform !== 'ios' && platform !== 'android') {
        note(chalk.red(`Unknown platform "${platform}". Use "ios" or "android".`));
        process.exit(1);
        return;
      }

      // There is no physical-iOS support: simulators only.
      if (opts.serial && platform === 'ios') {
        note(chalk.red('--serial is Android only. rn-iso has no physical-iOS support; iOS is simulators only.'));
        process.exit(1);
        return;
      }

      const root = findProjectRoot(process.cwd());
      if (!root) {
        note(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
        return;
      }

      const settings = resolveSettings({
        projectPath: root,
        gitCommonDir: gitCommonDir(root),
        repoRoot: repoRoot(root),
      });

      const bundleId = detectBundleId(root);
      const androidPackage = detectAndroidPackage(root);
      const isExpo = detectIsExpo(root);

      upsertProject(root, { bundleId, androidPackage, isExpo });
      const proj = getProject(root);
      const label = projectShortcut(root, proj);

      let device;
      try {
        device = await ensureOwnedDevice({
          platform,
          project: proj,
          projectPath: root,
          label,
          settings,
          flags: {
            deviceType: opts.deviceType,
            runtime: opts.runtime,
            systemImage: opts.systemImage,
            serial: opts.serial,
          },
          note,
          out,
        });
      } catch (e) {
        note(chalk.red(`Failed to ensure ${platform} device: ${e?.message || e}`));
        // The avdmanager hint only applies to emulator creation -- printing it
        // after a --serial failure sends the user chasing the wrong thing.
        if (platform === 'android' && !opts.serial) {
          note(chalk.dim('If this looks like an avdmanager failure, check that JAVA_HOME and ANDROID_HOME are set correctly.'));
        }
        process.exit(1);
        return;
      }

      let port = proj.metroPort;
      if (!port) {
        port = await allocatePort(root);
        setMetro(root, port);
      }

      // rn-iso reserves the port but does not start Metro: which bundler
      // command a project needs is project-specific judgment, the same reason
      // the build wrappers were removed. Report what is actually there, and
      // prove identity the same way teardown does -- reporting a foreign
      // listener as "healthy" would send the agent's build at someone else's
      // bundler, since the build CLIs skip spawning when /status answers.
      const metroResolution = await resolveProjectMetro(port, root);
      const metroHealthy = Boolean(metroResolution.metro);
      const metroConflict = metroResolution.notOurs ?? null;
      if (metroHealthy) {
        out(chalk.dim(`Metro running on port ${port} (verified as this project's)`));
      } else if (metroConflict) {
        note(chalk.yellow(`Warning: port ${port} is in use but is NOT this project's Metro: ${metroConflict}.`));
        note(chalk.dim('Start Metro from inside this project directory, or free the port.'));
      } else {
        out(chalk.dim(`Metro port reserved: ${port} (not running -- start it yourself)`));
      }

      if (platform === 'android') {
        const serial = device.avdName ? `emulator-${device.consolePort}` : device.serial;
        const adb = listAdbDevices();
        const live = device.avdName
          ? adb.emulators.some(e => e.consolePort === device.consolePort)
          : adb.physical.some(p => p.serial === device.serial);
        if (live) {
          adbReverse(serial, port);
          out(chalk.dim(`adb reverse tcp:${port} configured for ${serial}`));
        } else {
          note(chalk.yellow(`Note: ${serial} is not currently connected/running; skipping adb reverse.`));
        }
      }

      const metro = { healthy: metroHealthy, conflict: metroConflict };

      const payloadBundleId = platform === 'android' ? androidPackage : bundleId;
      const facts = buildFacts({ platform, device, port, metro, bundleId: payloadBundleId });

      if (json) {
        console.log(JSON.stringify(facts));
      } else {
        const deviceLabel = platform === 'ios' ? facts.udid : facts.serial;
        console.log(chalk.green(`\nOK: ${platform} ready on ${deviceLabel}, Metro port ${port}`));
      }
    });
}

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
    const avdName = `rn-iso-${sanitizeAvdLabel(label)}`;
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

// Pure: shapes the `--json` payload / summary facts from already-resolved
// device and Metro data.
export function buildFacts({ platform, device, port, metro, bundleId }) {
  const base = {
    platform,
    owned: Boolean(device.owned),
    metroPort: port,
    metroHealthy: Boolean(metro.healthy),
    // Non-null only when SOMETHING holds the reserved port but could not be
    // proven to be this project's Metro. metroHealthy alone used to be a bare
    // /status ping, which meant a foreign bundler on our port read as healthy
    // and an agent following "poll until healthy, then build" would build
    // against it. A port is not identity here either.
    metroConflict: metro.conflict ?? null,
    bundleId: bundleId ?? null,
  };
  if (platform === 'ios') {
    return { ...base, udid: device.deviceUdid, deviceName: device.deviceName ?? null };
  }
  if (device.avdName) {
    return { ...base, kind: 'emulator', avdName: device.avdName, serial: `emulator-${device.consolePort}`, consolePort: device.consolePort };
  }
  return { ...base, kind: 'physical', serial: device.serial };
}
