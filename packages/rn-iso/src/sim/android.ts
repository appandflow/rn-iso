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

// Where each SDK tool lives inside an Android SDK root.
const SDK_TOOL_LOCATIONS = {
  emulator: ['emulator', 'emulator'],
  adb: ['platform-tools', 'adb'],
  avdmanager: ['cmdline-tools', 'latest', 'bin', 'avdmanager'],
} as const;

type AndroidTool = keyof typeof SDK_TOOL_LOCATIONS;

// Resolves an SDK tool to an absolute path when it exists under androidHome()
// ($ANDROID_HOME / $ANDROID_SDK_ROOT, defaulting to ~/Library/Android/sdk),
// falling back to the bare name for a PATH lookup. The SDK is normally put on
// PATH by the user's interactive shell rc, which a non-interactive shell
// spawned by a Node process never reads -- so a bare `emulator` fails in
// exactly the shells rn-iso runs from, teardown reports failed, and the
// registry entry outlives its worktree. Absolute resolution makes those
// shells work; the bare-name fallback keeps a PATH-only setup (a custom SDK
// location exported globally) working as before.
export function androidToolPath(tool: AndroidTool): string {
  const abs = join(androidHome(), ...SDK_TOOL_LOCATIONS[tool]);
  return existsSync(abs) ? abs : tool;
}

// The shell-embedded form of androidToolPath: quoted when resolved (an SDK
// path can carry a space), bare otherwise so the shell still does the PATH
// lookup. Every shell invocation of an Android tool in this module goes
// through here; spawn() takes androidToolPath directly (argv, no shell).
function androidTool(tool: AndroidTool): string {
  const resolved = androidToolPath(tool);
  return resolved === tool ? tool : `"${resolved}"`;
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
// The emulator only accelerates images matching the HOST architecture --
// arm64-v8a on Apple Silicon, x86_64 on Intel/AMD (a Linux CI runner). A
// hardcoded arm64 filter returned null on every x86_64 host even with a
// perfectly good x86_64 image installed.
export function hostSystemImageArch(arch: string = process.arch): string {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

export function pickDefaultSystemImage(
  images: SystemImage[],
  { systemImage, hostArch }: { systemImage?: string; hostArch?: string } = {},
): SystemImage | null {
  if (systemImage) return images.find((i) => i.pkg === systemImage) || null;
  const wanted = hostArch ?? hostSystemImageArch();
  const matching = images.filter((i) => i.arch === wanted);
  if (matching.length === 0) return null;
  // matching.length > 0 was just checked, so [0] is present after the sort.
  return (
    [...matching].sort(
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
    const arch = hostSystemImageArch();
    throw new Error(
      `No ${arch} Android system image is installed. Install one, e.g.: sdkmanager "system-images;android-36;google_apis;${arch}"`,
    );
  }
  const avdName = ownedAvdName(label);
  // avdmanager prompts "Do you wish to create a custom hardware profile?";
  // piping "no" answers it non-interactively.
  getExecutor().run(`echo no | ${androidTool('avdmanager')} create avd -n "${avdName}" -k "${pick.pkg}"`);
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
  getExecutor().run(`${androidTool('avdmanager')} delete avd -n "${avdName}"`);
}

export function parseAvdList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('INFO') && !l.startsWith('WARNING'));
}

// rn-iso has no physical-device support, so NOTHING assigns, boots or installs
// onto the `physical` bucket any more. It stays because this is a faithful
// parse of `adb devices` rather than a device picker: a connected phone must
// land somewhere that is not `emulators`, or console-port allocation and the
// owned-AVD identity check would both count it as an emulator. Nothing may
// grow a consumer for it -- there is deliberately no assignment path.
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
  return parseAvdList(getExecutor().run(`${androidTool('emulator')} -list-avds`, { timeoutMs }));
}

export function listAdbDevices(): AdbDevices {
  return parseAdbDevices(getExecutor().run(`${androidTool('adb')} devices`));
}

export function nextConsolePort(claimedPorts: number[]): number {
  if (claimedPorts.length === 0) return 5554;
  const max = Math.max(...claimedPorts);
  return max + 2; // emulator console ports are even
}

// A Linux host with no display -- a CI runner, an SSH session -- cannot open
// the emulator window: without -no-window the emulator dies in display init
// and never registers with adb (observed live on a GitHub runner: the qemu
// process launched, `adb devices` never listed it). Headlessness is a fact of
// the environment, so it is detected, not configured; a desktop session keeps
// its window.
export function headlessEmulatorArgs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return ['-no-window', '-noaudio', '-no-boot-anim', '-gpu', 'swiftshader_indirect'];
  }
  return [];
}

export function bootAndroidEmulator(avdName: string, consolePort: number): void {
  const exec = getExecutor();
  exec
    .spawn(androidToolPath('emulator'), ['-avd', avdName, '-port', String(consolePort), ...headlessEmulatorArgs()], {
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
  const out = exec.runQuiet(`${androidTool('adb')} -s ${serial} shell getprop ${prop}`);
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
  const devicesOut = exec.runQuiet(`${androidTool('adb')} devices`);
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
  getExecutor().runQuiet(`${androidTool('adb')} -s ${serial} emu kill`);
}

// There is no adbReverse here any more. Contract 6's port wiring lives in
// `engine/app-install.js` (`reverseMetroPorts`), which sets BOTH the
// 8081 -> reserved mapping the app actually reads and the same-port one
// tooling asks for. A second, simpler copy in this file is exactly the drift
// CLAUDE.md item 4 warns about: it would map only one of the two, silently.

function getAvdNameForSerial(serial: string): string | null {
  const out = getExecutor().runQuiet(`${androidTool('adb')} -s ${serial} emu avd name`);
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
