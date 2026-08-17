// src/commands/up.js
//
// `rn-iso up <platform>` is the broker command: it ensures an OWNED device
// (creating one if needed), allocates the Metro port, ensures managed
// Metro, wires adb reverse on Android, and prints the facts. It never runs
// a build -- the agent runs the project's own build against the facts.
import chalk from 'chalk';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage, projectShortcut } from '../project.js';
import { gitCommonDir, repoRoot } from '../worktree.js';
import { resolveSettings } from '../settings.js';
import {
  getProject,
  upsertProject,
  setMetro,
  setDevice,
  getSetupStatus,
  allClaimedDevices,
} from '../config.js';
import { allocatePort } from '../ports.js';
import { ensureMetro, logFileFor, findPidListeningOnPort } from '../metro.js';
import { createOwnedIosSim, bootIosSim, listAllIosSims } from '../sim/ios.js';
import {
  createOwnedAvd,
  listAvds,
  bootAndroidEmulator,
  waitForBoot,
  adbReverse,
  nextConsolePort,
  listAdbDevices,
} from '../sim/android.js';

export default function upCommand(program) {
  registerUp(program);
}

export function registerUp(program) {
  program
    .command('up <platform>')
    .description(
      'Ensure an owned device, Metro, and port for the current project, and print the facts. ' +
      'Never runs a build -- run the project\'s own build against the printed facts.'
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--device-type <name>', 'iOS device type to use when creating a new owned sim (e.g. "iPhone 17 Pro")')
    .option('--runtime <version>', 'iOS runtime version to use when creating a new owned sim (e.g. "26.2")')
    .option('--system-image <pkg>', 'Android system image package to use when creating a new owned AVD')
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
          },
          note,
          out,
        });
      } catch (e) {
        note(chalk.red(`Failed to ensure ${platform} device: ${e?.message || e}`));
        if (platform === 'android') {
          note(chalk.dim('If this looks like an avdmanager failure, check that JAVA_HOME and ANDROID_HOME are set correctly.'));
        }
        process.exit(1);
        return;
      }

      let port = proj.metroPort;
      if (!port) {
        port = await allocatePort(root);
        setMetro(root, port, null);
      }

      const metroResult = await ensureMetro({ projectPath: root, isExpo, port });
      if (!metroResult.alreadyRunning) {
        setMetro(root, port, metroResult.pid);
        out(chalk.dim(`Metro started detached (pid ${metroResult.pid}, port ${port})`));
      } else {
        out(chalk.dim(`Metro port: ${port} (already running)`));
      }
      if (!metroResult.ready) {
        note(chalk.yellow(`Warning: Metro on port ${port} did not report ready.`));
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

      const metroPid = metroResult.pid ?? findPidListeningOnPort(port);
      const metro = {
        pid: metroPid,
        healthy: metroResult.ready,
        log: logFileFor(root),
      };
      const setup = getSetupStatus(root);

      const facts = buildFacts({ platform, device, port, metro, bundleId, setup });

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
// print a note and leave it as-is (Metro and the port are still ensured by
// the caller). A recorded device that no longer exists at all (deleted sim,
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
    const sim = listAllIosSims().find(s => s.udid === record.deviceUdid);
    if (sim) {
      if (record.owned) {
        if (sim.state !== 'Booted') {
          out(chalk.dim(`Booting owned sim ${sim.name} (${sim.udid})...`));
          bootIosSim(sim.udid);
        }
        const updated = { deviceUdid: sim.udid, owned: true, deviceName: record.deviceName ?? sim.name };
        setDevice(projectPath, 'ios', updated);
        return updated;
      }
      // Legacy: reuse only if already live; never boot it ourselves.
      if (sim.state !== 'Booted') {
        note(chalk.yellow(`Note: assigned sim ${sim.name} (${sim.udid}) is shut down and is not owned by rn-iso, so it will not be booted automatically.`));
        note(chalk.dim('Boot it yourself, or run `rn-iso release` to switch this project to an owned device.'));
      }
      return record;
    }
    // Sim was deleted out from under the record: fall through to creation.
  }

  const created = createOwnedIosSim(label, {
    deviceType: flags.deviceType || settings.ios?.deviceType,
    runtime: flags.runtime || settings.ios?.runtime,
  });
  out(chalk.dim(`Created owned sim ${created.name} (${created.udid})`));
  bootIosSim(created.udid);
  const newRecord = { deviceUdid: created.udid, owned: true, deviceName: created.name };
  setDevice(projectPath, 'ios', newRecord);
  return newRecord;
}

async function ensureOwnedAndroidDevice({ record, projectPath, label, settings, flags, note, out }) {
  if (record?.avdName) {
    const avdExists = listAvds().includes(record.avdName);
    if (avdExists) {
      const adb = listAdbDevices();
      const running = adb.emulators.some(e => e.consolePort === record.consolePort);
      if (record.owned) {
        if (!running) {
          out(chalk.dim(`Booting owned ${record.avdName} (emulator-${record.consolePort})...`));
          bootAndroidEmulator(record.avdName, record.consolePort);
          const serial = `emulator-${record.consolePort}`;
          const result = await waitForBoot(serial);
          if (!result.ok) {
            throw new Error(`Emulator ${serial} did not finish booting.`);
          }
        }
        const updated = {
          avdName: record.avdName,
          consolePort: record.consolePort,
          owned: true,
          deviceName: record.deviceName ?? record.avdName,
        };
        setDevice(projectPath, 'android', updated);
        return updated;
      }
      // Legacy: reuse only if already running; never boot it ourselves.
      if (!running) {
        note(chalk.yellow(`Note: assigned AVD ${record.avdName} (emulator-${record.consolePort}) is shut down and is not owned by rn-iso, so it will not be booted automatically.`));
        note(chalk.dim('Boot it yourself, or run `rn-iso release` to switch this project to an owned device.'));
      }
      return record;
    }
    // AVD was deleted out from under the record: fall through to creation.
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

  const created = createOwnedAvd(label, { systemImage: flags.systemImage || settings.android?.systemImage });
  const claimedPorts = allClaimedDevices().androidConsolePorts;
  const consolePort = nextConsolePort(claimedPorts);
  out(chalk.dim(`Created owned AVD ${created.avdName}`));
  bootAndroidEmulator(created.avdName, consolePort);
  const serial = `emulator-${consolePort}`;
  out(chalk.dim(`Waiting for ${serial} to finish booting...`));
  const result = await waitForBoot(serial);
  if (!result.ok) {
    throw new Error(`Emulator ${serial} did not finish booting.`);
  }
  const newRecord = { avdName: created.avdName, consolePort, owned: true, deviceName: created.avdName };
  setDevice(projectPath, 'android', newRecord);
  return newRecord;
}

// Pure: shapes the `--json` payload / summary facts from already-resolved
// device, Metro, and setup data.
export function buildFacts({ platform, device, port, metro, bundleId, setup }) {
  const base = {
    platform,
    owned: Boolean(device.owned),
    metroPort: port,
    metroPid: metro.pid ?? null,
    metroHealthy: Boolean(metro.healthy),
    metroLog: metro.log ?? null,
    bundleId: bundleId ?? null,
    setup: setup ?? null,
  };
  if (platform === 'ios') {
    return { ...base, udid: device.deviceUdid, deviceName: device.deviceName ?? null };
  }
  if (device.avdName) {
    return { ...base, kind: 'emulator', avdName: device.avdName, serial: `emulator-${device.consolePort}` };
  }
  return { ...base, kind: 'physical', serial: device.serial };
}
