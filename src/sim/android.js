import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getExecutor } from '../exec.js';

export function androidHome() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library', 'Android', 'sdk');
}

function avdmanagerPath() {
  return join(androidHome(), 'cmdline-tools', 'latest', 'bin', 'avdmanager');
}

// system-images/<android-XX>/<tag>/<arch>/ on disk.
export function listInstalledSystemImages() {
  const root = join(androidHome(), 'system-images');
  const images = [];
  if (!existsSync(root)) return images;
  for (const apiDir of readdirSync(root)) {
    const m = apiDir.match(/^android-(\d+)$/);
    if (!m) continue;
    const apiPath = join(root, apiDir);
    for (const tag of safeList(apiPath)) {
      for (const arch of safeList(join(apiPath, tag))) {
        images.push({ api: Number(m[1]), tag, arch, pkg: `system-images;${apiDir};${tag};${arch}` });
      }
    }
  }
  return images;
}

function safeList(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

// Highest API first; google_apis over other tags; Apple Silicon needs arm64.
export function pickDefaultSystemImage(images, { systemImage } = {}) {
  if (systemImage) return images.find(i => i.pkg === systemImage) || null;
  const arm = images.filter(i => i.arch === 'arm64-v8a');
  if (arm.length === 0) return null;
  return [...arm].sort((a, b) =>
    b.api - a.api || (b.tag === 'google_apis' ? 1 : 0) - (a.tag === 'google_apis' ? 1 : 0))[0];
}

export function createOwnedAvd(label, { systemImage } = {}) {
  const pick = pickDefaultSystemImage(listInstalledSystemImages(), { systemImage });
  if (!pick) {
    throw new Error('No arm64 Android system image is installed. Install one, e.g.: sdkmanager "system-images;android-36;google_apis;arm64-v8a"');
  }
  const avdName = `rn-iso-${sanitizeAvdLabel(label)}`;
  // avdmanager prompts "Do you wish to create a custom hardware profile?";
  // piping "no" answers it non-interactively.
  getExecutor().run(`echo no | "${avdmanagerPath()}" create avd -n "${avdName}" -k "${pick.pkg}"`);
  return { avdName };
}

export function sanitizeAvdLabel(label) {
  return String(label).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

// Defense in depth: deletion must only ever reach an AVD rn-iso created
// itself. A future caller bug (wrong record, stale name) must not be able
// to delete a user's real AVD.
export function deleteAvd(avdName) {
  if (!avdName?.startsWith('rn-iso-')) {
    throw new Error(`Refusing to delete AVD "${avdName}": not an rn-iso-owned AVD (name must start with "rn-iso-").`);
  }
  getExecutor().runQuiet(`"${avdmanagerPath()}" delete avd -n "${avdName}"`);
}

export function parseAvdList(text) {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('INFO') && !l.startsWith('WARNING'));
}

export function parseAdbDevices(text) {
  const lines = text.split('\n').slice(1); // skip "List of devices attached"
  const emulators = [];
  const physical = []; // USB or adb-over-TCP serials (e.g. R5CR70XXX, 192.168.1.5:5555)
  const unhealthy = []; // serials adb sees but can't talk to (unauthorized/offline)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, status] = trimmed.split(/\s+/);
    const m = serial.match(/^emulator-(\d+)$/);
    if (m) {
      if (status === 'device') {
        emulators.push({ serial, consolePort: parseInt(m[1], 10) });
      } else {
        unhealthy.push({ serial, kind: 'emulator', consolePort: parseInt(m[1], 10), status });
      }
    } else {
      if (status === 'device') {
        physical.push({ serial });
      } else {
        unhealthy.push({ serial, kind: 'physical', status });
      }
    }
  }
  return { emulators, physical, unhealthy };
}

export function listAvds({ timeoutMs } = {}) {
  return parseAvdList(getExecutor().run('emulator -list-avds', { timeoutMs }));
}

export function listAdbDevices() {
  return parseAdbDevices(getExecutor().run('adb devices'));
}

export function nextConsolePort(claimedPorts) {
  if (claimedPorts.length === 0) return 5554;
  const max = Math.max(...claimedPorts);
  return max + 2; // emulator console ports are even
}

export function bootAndroidEmulator(avdName, consolePort) {
  const exec = getExecutor();
  exec.spawn('emulator', ['-avd', avdName, '-port', String(consolePort)], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

export async function waitForBoot(serial, timeoutMs = 60000) {
  const exec = getExecutor();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // sys.boot_completed is the canonical "system fully up" signal; some
    // older AVD images set dev.bootcomplete sooner. Either is fine.
    const sysBoot = exec.runQuiet(`adb -s ${serial} shell getprop sys.boot_completed`).trim();
    if (sysBoot === '1') return { ok: true };
    const devBoot = exec.runQuiet(`adb -s ${serial} shell getprop dev.bootcomplete`).trim();
    if (devBoot === '1') return { ok: true };
    await new Promise(r => setTimeout(r, 1000));
  }
  // Diagnostic snapshot for the timeout error: shows the user exactly
  // what adb sees and why the polling never resolved.
  const devices = exec.runQuiet('adb devices').trim();
  return {
    ok: false,
    diagnostic: {
      devices,
      sysBoot: exec.runQuiet(`adb -s ${serial} shell getprop sys.boot_completed`).trim(),
      devBoot: exec.runQuiet(`adb -s ${serial} shell getprop dev.bootcomplete`).trim(),
      bootAnim: exec.runQuiet(`adb -s ${serial} shell getprop init.svc.bootanim`).trim(),
    },
  };
}

export function shutdownAndroidEmulator(serial) {
  getExecutor().runQuiet(`adb -s ${serial} emu kill`);
}

export function adbReverse(serial, port) {
  getExecutor().run(`adb -s ${serial} reverse tcp:${port} tcp:${port}`);
}

export function getAvdNameForSerial(serial) {
  const out = getExecutor().runQuiet(`adb -s ${serial} emu avd name`);
  if (!out) return null;
  // `adb emu avd name` returns the AVD name on the first line, "OK" on the second.
  return out.split('\n')[0].trim() || null;
}

// Resolves an owned AVD name against the LIVE adb device list, verifying
// identity before any destructive command (shutdown or delete) is issued at
// a serial. A console port is a slot, not an identity: Android Studio's
// default emulator also starts at 5554, the same first-free-even rule rn-iso
// uses, so a recorded consolePort can end up occupied by a foreign emulator.
// Blindly shutting down `emulator-<consolePort>` in that case kills the
// user's own emulator, not ours -- the identity check here (matching
// avdName against `adb emu avd name` for every live emulator, the same
// pattern gc.js already used) is what prevents that.
// Four outcomes:
//   { missing: true }    no AVD named avdName exists at all (deleted, or a
//                        stale/mistyped record) -- the honest already-gone
//                        path, not an error.
//   { notOwned: true }   avdName does not start with "rn-iso-" (a stale or
//                        wrong record) -- must be reported as a skip, never
//                        shut down or deleted.
//   { serial }           a live emulator whose AVD identity matches avdName
//                        was found: safe to shut down at this serial.
//   { notRunning: true } the AVD exists and is owned, but no live emulator
//                        currently identifies as it -- skip shutdown,
//                        proceed to deleteAvd where applicable.
export function resolveOwnedAvdSerial(avdName) {
  if (!listAvds().includes(avdName)) return { missing: true };
  if (!avdName?.startsWith('rn-iso-')) return { notOwned: true };
  const adb = listAdbDevices();
  const match = adb.emulators.find(e => getAvdNameForSerial(e.serial) === avdName);
  if (match) return { serial: match.serial };
  return { notRunning: true };
}
