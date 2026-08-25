// src/commands/up.js
//
// `rn-iso up <platform>` is the broker command: it ensures an OWNED device
// (creating one if needed), reserves the Metro port, wires adb reverse on
// Android, and prints the facts. It never runs a build and never starts
// Metro -- the agent starts Metro on the reserved port and runs the
// project's own build against the facts.
import chalk from 'chalk';
import { installedSkillVersions, staleSkillCopies } from './skill.js';
import { findProjectRoot, detectIsExpo, detectBundleId, detectAndroidPackage, projectShortcut } from '../project.js';
import { gitCommonDir, repoRoot } from '../worktree.js';
import { resolveSettings, unknownSettingKeys } from '../settings.js';
import { getProject, upsertProject } from '../config.js';
import { reserveMetroPort } from '../ports.js';
import { resolveProjectMetro } from '../metro.js';
import { ensureOwnedDevice } from '../engine/device.js';
import { adbReverse, listAdbDevices } from '../sim/android.js';

export default function upCommand(program, cliVersion) {
  registerUp(program, cliVersion);
}

// `cliVersion` is optional: without it the skill-staleness check is skipped
// rather than comparing against undefined, which would report every installed
// copy as stale. Only bin/cli.js has the real version to pass.
export function registerUp(program, cliVersion = null) {
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
    .option('--wait-metro [seconds]', 'Wait until Metro answers on the reserved port before printing the facts (default 60s). Removes the hand-rolled poll loop every agent script otherwise needs')
    .option('--serial <serial>', 'Android only: assign a connected PHYSICAL device by adb serial instead of creating an owned emulator. rn-iso never boots, shuts down, or deletes hardware')
    .action(async (platform, opts) => {
      const json = Boolean(opts.json);
      // In --json mode the JSON payload is the ONLY stdout content, so every
      // human-readable progress line is redirected to stderr instead of
      // being suppressed.
      const out = (line) => { if (json) console.error(line); else console.log(line); };
      const note = (line) => console.error(line);

      // The installed skill is a plain file copy, so upgrading rn-iso never
      // refreshes it. A 0.10.0 skill against a 0.14.0 CLI describes a command
      // surface with four commands missing, and nothing says so. `up` is the
      // command every session runs, so it is where the mismatch is worth one
      // line. Never fatal, and never on stdout -- see the --json contract above.
      for (const stale of cliVersion ? staleSkillCopies(installedSkillVersions(), cliVersion) : []) {
        note(chalk.yellow(
          `Installed rn-iso skill is ${stale.version ?? 'an unstamped older version'} but this CLI is ${cliVersion}. `
          + 'Run `npx rn-iso skill install` so the docs your agent reads match the binary.'
        ));
      }

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

      // Warn loudly about settings rn-iso no longer reads. A key that silently
      // stops being honoured (a committed worktree.install after 0.9.0) shows
      // up only as a downstream mystery.
      for (const key of unknownSettingKeys(settings)) {
        note(chalk.yellow(`Warning: setting "${key}" is not read by rn-iso and will be ignored.`));
      }

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
        port = await reserveMetroPort(root);
      } else {
        // A reservation that something else has taken over is unusable: the
        // agent can never start Metro there, so reporting the conflict every
        // run would strand the project forever. Move it to a free port
        // instead. Only a FOREIGN holder triggers this -- our own Metro
        // answering on the port is the healthy case.
        const held = await resolveProjectMetro(port, root);
        if (held.notOurs) {
          const fresh = await reserveMetroPort(root);
          if (fresh !== port) {
            note(chalk.yellow(`Port ${port} is held by something else (${held.notOurs}).`));
            note(chalk.dim(`Reserved port ${fresh} for this project instead.`));
            port = fresh;
          }
        }
      }

      // rn-iso reserves the port but does not start Metro: which bundler
      // command a project needs is project-specific judgment, the same reason
      // the build wrappers were removed. Report what is actually there, and
      // prove identity the same way teardown does -- reporting a foreign
      // listener as "healthy" would send the agent's build at someone else's
      // bundler, since the build CLIs skip spawning when /status answers.
      let metroResolution = await resolveProjectMetro(port, root);
      // --wait-metro polls for OUR Metro specifically: a foreign listener that
      // answers /status must not satisfy the wait, or the build proceeds
      // against the wrong bundler -- the exact failure metroConflict exists to
      // catch.
      if (opts.waitMetro && !metroResolution.metro) {
        const seconds = opts.waitMetro === true ? 60 : Number(opts.waitMetro);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          note(chalk.red(`Invalid --wait-metro value "${opts.waitMetro}". Pass a number of seconds.`));
          process.exit(1);
          return;
        }
        note(chalk.dim(`Waiting up to ${seconds}s for Metro on port ${port}...`));
        const deadline = Date.now() + seconds * 1000;
        while (Date.now() < deadline && !metroResolution.metro) {
          await new Promise(r => setTimeout(r, 500));
          metroResolution = await resolveProjectMetro(port, root);
        }
        if (!metroResolution.metro) {
          note(chalk.yellow(`Metro did not come up on port ${port} within ${seconds}s.`));
        }
      }
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

// ensureOwnedDevice and its helpers moved to src/engine/device.js when `ios`
// and `android` came to need the same booted-device guarantee -- one copy of
// the ownership rule, not two. They stay exported from here because they are
// part of this module's published surface and its tests.
export { deviceTypeMismatch, resolvePhysicalSerial } from '../engine/device.js';
export { ensureOwnedDevice };


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
