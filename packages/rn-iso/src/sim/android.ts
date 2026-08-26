import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { type Executor, getExecutor } from '../exec.ts';

export interface SystemImage {
  api: number;
  tag: string;
  arch: string;
  pkg: string;
}

interface AdbEmulatorEntry {
  serial: string;
  consolePort: number;
}

interface AdbPhysicalEntry {
  serial: string;
}

interface AdbUnhealthyEntry {
  serial: string;
  kind: 'emulator' | 'physical';
  consolePort?: number;
  status: string;
}

export interface AdbDevices {
  emulators: AdbEmulatorEntry[];
  physical: AdbPhysicalEntry[];
  unhealthy: AdbUnhealthyEntry[];
}

export interface BootResult {
  ok: boolean;
  diagnostic?: {
    devices: string;
    sysBoot: string;
    devBoot: string;
    bootAnim: string;
  };
}

// FLAT rather than a discriminated union -- see the doc comment on
// resolveOwnedAvdSerial for the four outcomes this covers.
export interface ResolvedAvdSerial {
  missing?: true;
  notOwned?: true;
  serial?: string;
  notRunning?: true;
}

export function androidHome(): string {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library', 'Android', 'sdk');
}

function avdmanagerPath(): string {
  return join(androidHome(), 'cmdline-tools', 'latest', 'bin', 'avdmanager');
}

// system-images/<android-XX>/<tag>/<arch>/ on disk.
function listInstalledSystemImages(): SystemImage[] {
  const root = join(androidHome(), 'system-images');
  const images: SystemImage[] = [];
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

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// The 16KB-page-size variants of the system images (`..._ps16k`). They are a
// perfectly good Android, and rn-iso will happily use one when it is the only
// thing installed -- an expo-dev-client debug build installs, launches and
// loads a bundle on one, verified on this machine's only image,
// `system-images;android-36;google_apis_playstore_ps16k;arm64-v8a`.
//
// They are ranked LAST anyway, and ahead of the API-level preference, because
// what they change is exactly what a React Native app is made of: a 16KB-page
// device refuses to load any .so whose segments are aligned to 4KB, which is
// every native module built with an NDK older than r27 and not yet rebuilt.
// The failure is `dlopen failed: ... p_align` at startup, on a build that
// works everywhere else, and an agent debugging THAT is debugging the
// emulator rn-iso silently chose for it. When a plain image exists, it is the
// one that tells you about your app rather than about your device.
function pageSizeRank(image: SystemImage): number {
  return /(^|_)ps16k$/.test(String(image?.tag || '')) ? 1 : 0;
}

// Plain pages first; then highest API; then google_apis over other tags.
// Apple Silicon needs arm64.
export function pickDefaultSystemImage(
  images: SystemImage[],
  { systemImage }: { systemImage?: string } = {},
): SystemImage | null {
  if (systemImage) return images.find((i) => i.pkg === systemImage) || null;
  const arm = images.filter((i) => i.arch === 'arm64-v8a');
  if (arm.length === 0) return null;
  // arm.length > 0 was just checked, so [0] is present after the sort.
  return (
    [...arm].sort(
      (a, b) =>
        pageSizeRank(a) - pageSizeRank(b) ||
        b.api - a.api ||
        (b.tag === 'google_apis' ? 1 : 0) - (a.tag === 'google_apis' ? 1 : 0),
    )[0] ?? null
  );
}

export function createOwnedAvd(label: string, { systemImage }: { systemImage?: string } = {}): { avdName: string } {
  const pick = pickDefaultSystemImage(listInstalledSystemImages(), { systemImage });
  if (!pick) {
    throw new Error(
      'No arm64 Android system image is installed. Install one, e.g.: sdkmanager "system-images;android-36;google_apis;arm64-v8a"',
    );
  }
  const avdName = ownedAvdName(label);
  // avdmanager prompts "Do you wish to create a custom hardware profile?";
  // piping "no" answers it non-interactively.
  getExecutor().run(`echo no | "${avdmanagerPath()}" create avd -n "${avdName}" -k "${pick.pkg}"`);
  return { avdName };
}

function sanitizeAvdLabel(label: string): string {
  return String(label)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// See ownedSimName in sim/ios.js: the `rn-iso-` prefix is the ownership marker,
// and a label that already starts with it must not get a second one.
export function ownedAvdName(label: string): string {
  const clean = sanitizeAvdLabel(label);
  return `rn-iso-${clean.startsWith('rn-iso-') ? clean.slice('rn-iso-'.length) : clean}`;
}

// Defense in depth: deletion must only ever reach an AVD rn-iso created
// itself. A future caller bug (wrong record, stale name) must not be able
// to delete a user's real AVD.
//
// The delete itself runs through the THROWING run(): an avdmanager delete
// that fails leaves the AVD on disk, and teardown.js turns the throw into
// { status: 'failed' } so the caller reports a leak instead of "torn down".
export function deleteAvd(avdName: string): void {
  if (!avdName?.startsWith('rn-iso-')) {
    throw new Error(`Refusing to delete AVD "${avdName}": not an rn-iso-owned AVD (name must start with "rn-iso-").`);
  }
  getExecutor().run(`"${avdmanagerPath()}" delete avd -n "${avdName}"`);
}

export function parseAvdList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('INFO') && !l.startsWith('WARNING'));
}

// v3 removed physical-device support, so NOTHING assigns, boots or installs
// onto the `physical` bucket any more. It stays because this is a faithful
// parse of `adb devices` rather than a device picker: a connected phone must
// land somewhere that is not `emulators`, or console-port allocation and the
// owned-AVD identity check would both count it as an emulator. Nothing may
// grow a consumer for it -- an assignment path is what was deleted.
export function parseAdbDevices(text: string): AdbDevices {
  const lines = text.split('\n').slice(1); // skip "List of devices attached"
  const emulators: AdbEmulatorEntry[] = [];
  const physical: AdbPhysicalEntry[] = []; // USB or adb-over-TCP serials (e.g. R5CR70XXX, 192.168.1.5:5555)
  const unhealthy: AdbUnhealthyEntry[] = []; // serials adb sees but can't talk to (unauthorized/offline)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, status] = trimmed.split(/\s+/);
    // An `adb devices` row is always "serial<whitespace>state"; a row missing
    // either field is malformed output, so skip it.
    if (!serial || !status) continue;
    const m = serial.match(/^emulator-(\d+)$/);
    if (m) {
      // m matched /^emulator-(\d+)$/, so capture group 1 (the digits) is present.
      const consolePort = parseInt(m[1]!, 10);
      if (status === 'device') {
        emulators.push({ serial, consolePort });
      } else {
        unhealthy.push({ serial, kind: 'emulator', consolePort, status });
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

export function listAvds({ timeoutMs }: { timeoutMs?: number } = {}): string[] {
  return parseAvdList(getExecutor().run('emulator -list-avds', { timeoutMs }));
}

export function listAdbDevices(): AdbDevices {
  return parseAdbDevices(getExecutor().run('adb devices'));
}

export function nextConsolePort(claimedPorts: number[]): number {
  if (claimedPorts.length === 0) return 5554;
  const max = Math.max(...claimedPorts);
  return max + 2; // emulator console ports are even
}

export function bootAndroidEmulator(avdName: string, consolePort: number): void {
  const exec = getExecutor();
  exec
    .spawn('emulator', ['-avd', avdName, '-port', String(consolePort)], {
      detached: true,
      stdio: 'ignore',
    })
    .unref();
}

// runQuiet returns null whenever the command fails, which is the normal state
// for most of a boot: adb answers "device offline" or "device not found" until
// the emulator has registered. Null is "not booted yet", so it reads as an
// empty string and the poll continues.
function getprop(exec: Executor, serial: string, prop: string): string {
  const out = exec.runQuiet(`adb -s ${serial} shell getprop ${prop}`);
  return typeof out === 'string' ? out.trim() : '';
}

export async function waitForBoot(serial: string, timeoutMs = 60000): Promise<BootResult> {
  const exec = getExecutor();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // sys.boot_completed is the canonical "system fully up" signal; some
    // older AVD images set dev.bootcomplete sooner. Either is fine.
    if (getprop(exec, serial, 'sys.boot_completed') === '1') return { ok: true };
    if (getprop(exec, serial, 'dev.bootcomplete') === '1') return { ok: true };
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Diagnostic snapshot for the timeout error: shows the user exactly
  // what adb sees and why the polling never resolved.
  const devicesOut = exec.runQuiet('adb devices');
  return {
    ok: false,
    diagnostic: {
      devices: typeof devicesOut === 'string' ? devicesOut.trim() : '',
      sysBoot: getprop(exec, serial, 'sys.boot_completed'),
      devBoot: getprop(exec, serial, 'dev.bootcomplete'),
      bootAnim: getprop(exec, serial, 'init.svc.bootanim'),
    },
  };
}

export function shutdownAndroidEmulator(serial: string): void {
  getExecutor().runQuiet(`adb -s ${serial} emu kill`);
}

// There is no adbReverse here any more. Contract 6's port wiring lives in
// `engine/app-install.js` (`reverseMetroPorts`), which sets BOTH the
// 8081 -> reserved mapping the app actually reads and the same-port one
// tooling asks for. A second, simpler copy in this file is exactly the drift
// CLAUDE.md item 4 warns about: it would map only one of the two, silently.

function getAvdNameForSerial(serial: string): string | null {
  const out = getExecutor().runQuiet(`adb -s ${serial} emu avd name`);
  if (!out) return null;
  // `adb emu avd name` returns the AVD name on the first line, "OK" on the second.
  return out.split('\n')[0]?.trim() || null;
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
export function resolveOwnedAvdSerial(avdName: string): ResolvedAvdSerial {
  if (!listAvds().includes(avdName)) return { missing: true };
  if (!avdName?.startsWith('rn-iso-')) return { notOwned: true };
  const adb = listAdbDevices();
  const match = adb.emulators.find((e) => getAvdNameForSerial(e.serial) === avdName);
  if (match) return { serial: match.serial };
  return { notRunning: true };
}
