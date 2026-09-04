import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { type Executor, getExecutor } from '../exec.ts';
import { isPidAlive } from '../metro.ts';
import { androidDataPartitionSizeBytes } from '../settings.ts';

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
  exited?: true;
  diagnostic?: {
    devices: string;
    sysBoot: string;
    devBoot: string;
    bootAnim: string;
  };
}

export interface ResolvedAvdSerial {
  missing?: true;
  notOwned?: true;
  serial?: string;
  notRunning?: true;
}

export function androidHome(): string {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library', 'Android', 'sdk');
}

const SDK_TOOL_LOCATIONS = {
  emulator: ['emulator', 'emulator'],
  adb: ['platform-tools', 'adb'],
  avdmanager: ['cmdline-tools', 'latest', 'bin', 'avdmanager'],
} as const;

type AndroidTool = keyof typeof SDK_TOOL_LOCATIONS;

export function androidToolPath(tool: AndroidTool): string {
  const abs = join(androidHome(), ...SDK_TOOL_LOCATIONS[tool]);
  return existsSync(abs) ? abs : tool;
}

export interface BuildToolsEntry {
  path: string;
  tool: string;
  version: string;
  major: number;
}

export function newestBuildTools(names: unknown): string | null {
  return (
    [...(Array.isArray(names) ? names : [])]
      .filter((n) => /^\d+(\.\d+)*(-\w+)?$/.test(String(n)))
      .toSorted((a, b) => {
        const pa = String(a).split(/[.-]/).map(Number);
        const pb = String(b).split(/[.-]/).map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pb[i] || 0) - (pa[i] || 0);
          if (d) return d;
        }
        return 0;
      })[0] ?? null
  );
}

export function buildToolsMajor(version: unknown): number {
  const major = Number(String(version ?? '').split(/[.-]/)[0]);
  return Number.isFinite(major) ? major : 0;
}

export function findBuildTool(
  tools: readonly string[],
  {
    home = androidHome(),
    readDir = readdirSync,
    exists = existsSync,
  }: { home?: string; readDir?: (path: string) => string[]; exists?: (path: string) => boolean } = {},
): BuildToolsEntry | null {
  const root = join(home, 'build-tools');
  let versions: string[] = [];
  try {
    versions = readDir(root);
  } catch {
    return null;
  }
  while (versions.length) {
    const version = newestBuildTools(versions);
    if (!version) return null;
    for (const tool of tools) {
      const path = join(root, version, tool);
      if (exists(path)) return { path, tool, version, major: buildToolsMajor(version) };
    }
    versions = versions.filter((v) => v !== version);
  }
  return null;
}

function androidTool(tool: AndroidTool): string {
  const resolved = androidToolPath(tool);
  return resolved === tool ? tool : `"${resolved}"`;
}

export function listInstalledSystemImages(): SystemImage[] {
  const root = join(androidHome(), 'system-images');
  const images: SystemImage[] = [];
  if (!existsSync(root)) return images;
  for (const apiDir of safeList(root)) {
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

function pageSizeRank(image: SystemImage): number {
  return /(^|_)ps16k$/.test(String(image?.tag || '')) ? 1 : 0;
}

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
  return (
    matching.toSorted(
      (a, b) =>
        pageSizeRank(a) - pageSizeRank(b) ||
        b.api - a.api ||
        (b.tag === 'google_apis' ? 1 : 0) - (a.tag === 'google_apis' ? 1 : 0),
    )[0] ?? null
  );
}

export function createOwnedAvd(
  label: string,
  { systemImage }: { systemImage?: string } = {},
): { avdName: string; systemImage: string } {
  const pick = pickDefaultSystemImage(listInstalledSystemImages(), { systemImage });
  if (!pick) {
    const arch = hostSystemImageArch();
    throw new Error(
      `No ${arch} Android system image is installed. Install one, e.g.: sdkmanager "system-images;android-36;google_apis;${arch}"`,
    );
  }
  const avdName = ownedAvdName(label);
  getExecutor().run(`echo no | ${androidTool('avdmanager')} create avd -n "${avdName}" -k "${pick.pkg}"`);
  return { avdName, systemImage: pick.pkg };
}

export function parseAvdSystemImage(configIni: string): string | null {
  for (const line of String(configIni).split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    if (line.slice(0, separator).trim() !== 'image.sysdir.1') continue;
    const dir = line
      .slice(separator + 1)
      .trim()
      .replace(/\/+$/, '');
    if (!dir) return null;
    return dir.split('/').join(';');
  }
  return null;
}

export function ownedAvdSystemImage(
  avdName: string,
  {
    avdDirectory = ownedAvdDirectory,
    readFile = (path: string) => readFileSync(path, 'utf8'),
  }: { avdDirectory?: typeof ownedAvdDirectory; readFile?: (path: string) => string } = {},
): string | null {
  const directory = avdDirectory(avdName);
  if (!directory) return null;
  try {
    return parseAvdSystemImage(readFile(join(directory, 'config.ini')));
  } catch {
    return null;
  }
}

function sanitizeAvdLabel(label: string): string {
  return String(label)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function ownedAvdName(label: string): string {
  const clean = sanitizeAvdLabel(label);
  return `stim-${clean.startsWith('stim-') ? clean.slice('stim-'.length) : clean}`;
}

export function deleteAvd(avdName: string): void {
  if (!avdName?.startsWith('stim-')) {
    throw new Error(`Refusing to delete AVD "${avdName}": not a Stim-owned AVD (name must start with "stim-").`);
  }
  getExecutor().run(`${androidTool('avdmanager')} delete avd -n "${avdName}"`);
}

export function parseAvdList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('INFO') && !l.startsWith('WARNING'));
}

export function parseAdbDevices(text: string): AdbDevices {
  const lines = text.split('\n').slice(1);
  const emulators: AdbEmulatorEntry[] = [];
  const physical: AdbPhysicalEntry[] = [];
  const unhealthy: AdbUnhealthyEntry[] = []; // serials adb sees but can't talk to (unauthorized/offline)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const serial = match[1]!;
    const status = match[2]!.trim();
    const m = serial.match(/^emulator-(\d+)$/);
    if (m) {
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

const ADB_PROP_TIMEOUT_MS = 5000;
const EMULATOR_HARDWARE = new Set(['ranchu', 'goldfish', 'vbox86', 'vbox86p']);

function adbProp(serial: string, name: string): string | null {
  try {
    const out = getExecutor().runFile(androidToolPath('adb'), ['-s', serial, 'shell', 'getprop', name], {
      timeoutMs: ADB_PROP_TIMEOUT_MS,
    });
    return String(out ?? '').trim() || null;
  } catch {
    return null;
  }
}

export function physicalDeviceModel(serial: string): string | null {
  return adbProp(serial, 'ro.product.model');
}

function looksLikeEmulator({
  kernelQemu,
  hardware,
}: {
  kernelQemu?: string | null;
  hardware?: string | null;
}): boolean {
  if (String(kernelQemu ?? '').trim() === '1') return true;
  return EMULATOR_HARDWARE.has(
    String(hardware ?? '')
      .trim()
      .toLowerCase(),
  );
}

export function probeEmulatorSerial(serial: string): boolean {
  return looksLikeEmulator({
    kernelQemu: adbProp(serial, 'ro.kernel.qemu'),
    hardware: adbProp(serial, 'ro.hardware'),
  });
}

export interface ResolvedPhysicalDevice {
  serial?: string;
  error?: string;
  remedy?: string;
}

function unreachableDeviceRefusal(entry: AdbUnhealthyEntry): ResolvedPhysicalDevice {
  return {
    error: `${entry.serial} is connected but ${entry.status}, so adb cannot talk to it.`,
    remedy:
      entry.status === 'unauthorized'
        ? 'Unlock the device, accept the USB debugging prompt, then retry.'
        : 'Reconnect the device or run `adb reconnect`, then retry.',
  };
}

function emulatorRefusal(serial: string): ResolvedPhysicalDevice {
  return {
    error: `${serial} is an emulator, not a physical device.`,
    remedy: "Run `stim android` without --device to use this workspace's owned emulator.",
  };
}

export function memoizeEmulatorProbe(
  probe: (serial: string) => boolean = probeEmulatorSerial,
): (serial: string) => boolean {
  const seen = new Map<string, boolean>();
  return (serial: string) => {
    const cached = seen.get(serial);
    if (cached !== undefined) return cached;
    const probed = probe(serial);
    seen.set(serial, probed);
    return probed;
  };
}

export function androidPoolCandidates(
  adb: AdbDevices,
  isEmulator: (serial: string) => boolean = probeEmulatorSerial,
): AdbPhysicalEntry[] {
  return (adb?.physical ?? []).filter((entry) => !isEmulator(entry.serial));
}

export function androidPoolNoCandidatesRefusal(
  adb: AdbDevices,
  isEmulator: (serial: string) => boolean = probeEmulatorSerial,
): ResolvedPhysicalDevice {
  const physical = adb?.physical ?? [];
  if (physical.length > 0 && physical.every((entry) => isEmulator(entry.serial))) {
    const reasons = physical.map((entry) => emulatorRefusal(entry.serial));
    return {
      error: reasons.map((reason) => reason.error!).join(' '),
      remedy: [...new Set(reasons.map((reason) => reason.remedy!))].join(' '),
    };
  }
  return resolvePhysicalDevice(null, adb, isEmulator);
}

export function resolvePhysicalDevice(
  requested: string | null,
  adb: AdbDevices,
  isEmulator: (serial: string) => boolean = probeEmulatorSerial,
): ResolvedPhysicalDevice {
  const physical = adb?.physical ?? [];
  const unhealthy = adb?.unhealthy ?? [];
  if (requested) {
    if (physical.some((p) => p.serial === requested)) {
      return isEmulator(requested) ? emulatorRefusal(requested) : { serial: requested };
    }
    if (/^emulator-\d+$/.test(requested)) return emulatorRefusal(requested);
    const unreachable = unhealthy.find((u) => u.serial === requested);
    if (unreachable) return unreachableDeviceRefusal(unreachable);
    const connected = physical.map((p) => p.serial);
    return {
      error: connected.length
        ? `${requested} is not connected. adb reports these physical devices: ${connected.join(', ')}.`
        : `${requested} is not connected, and adb reports no physical device at all.`,
      remedy: 'Check the cable and `adb devices`, then retry with a serial adb lists.',
    };
  }
  if (physical.length === 1) {
    const only = physical[0]!.serial;
    return isEmulator(only) ? emulatorRefusal(only) : { serial: only };
  }
  if (physical.length > 1) {
    return {
      error: `Several physical devices are connected: ${physical.map((p) => p.serial).join(', ')}.`,
      remedy: 'Name the one to build for with `stim android --device <serial>`.',
    };
  }
  const unreachable = unhealthy.find((u) => u.kind === 'physical');
  if (unreachable) return unreachableDeviceRefusal(unreachable);
  return {
    error: 'No physical Android device is connected.',
    remedy: 'Plug the device in, accept the USB debugging prompt, then check `adb devices`.',
  };
}

export function nextConsolePort(claimedPorts: number[]): number {
  if (claimedPorts.length === 0) return 5554;
  const max = Math.max(...claimedPorts);
  return max + 2;
}

export function headlessEmulatorArgs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const args: string[] = [];
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    args.push(
      '-no-window',
      '-noaudio',
      '-no-boot-anim',
      '-gpu',
      'swiftshader_indirect',
      '-no-snapshot-save',
      '-no-snapshot-load',
    );
  }
  return args;
}

export function parseAvdRootIni(contents: string): { path: string | null; relativePath: string | null } {
  let path: string | null = null;
  let relativePath: string | null = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;
    if (key === 'path') path = value;
    if (key === 'path.rel') relativePath = value;
  }
  return { path, relativePath };
}

export function ownedAvdDirectory(
  avdName: string,
  {
    env = process.env,
    home = homedir(),
    readFile = (path: string) => readFileSync(path, 'utf8'),
    realpath = realpathSync,
    isDirectory = (path: string) => statSync(path).isDirectory(),
  }: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    readFile?: (path: string) => string;
    realpath?: (path: string) => string;
    isDirectory?: (path: string) => boolean;
  } = {},
): string | null {
  if (!/^stim-[A-Za-z0-9._-]+$/.test(avdName)) return null;
  const roots = [
    env.ANDROID_AVD_HOME,
    env.ANDROID_SDK_HOME ? join(env.ANDROID_SDK_HOME, 'avd') : null,
    join(home, '.android', 'avd'),
  ];
  for (const root of new Set(roots.filter((value): value is string => Boolean(value)))) {
    let ini: string;
    try {
      ini = readFile(join(root, `${avdName}.ini`));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return null;
    }
    const parsed = parseAvdRootIni(ini);
    const candidates = [
      parsed.relativePath && !isAbsolute(parsed.relativePath) ? resolve(dirname(root), parsed.relativePath) : null,
      parsed.path && isAbsolute(parsed.path) ? parsed.path : null,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const canonical = realpath(candidate);
        if (isDirectory(canonical)) return canonical;
      } catch {}
    }
    return null;
  }
  return null;
}

export function withAvdDataPartitionSize(contents: string, sizeBytes: number): string {
  return withAvdConfigOverrides(contents, { 'disk.dataPartition.size': String(sizeBytes) });
}

export function withAvdConfigOverrides(contents: string, overrides: Readonly<Record<string, string>>): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(contents);
  const lines = contents.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  const updated: string[] = [];
  const remaining = new Map(Object.entries(overrides));
  for (const line of lines) {
    const separator = line.indexOf('=');
    const key = separator >= 0 ? line.slice(0, separator).trim() : '';
    if (!remaining.has(key)) {
      if (!Object.hasOwn(overrides, key)) updated.push(line);
      continue;
    }
    updated.push(`${key}=${remaining.get(key)}`);
    remaining.delete(key);
  }
  for (const [key, value] of remaining) updated.push(`${key}=${value}`);
  return updated.join(newline) + (trailingNewline ? newline : '');
}

let avdConfigWriteSequence = 0;

export function configureNewOwnedAvd(
  avdName: string,
  {
    dataPartitionSizeGb,
    avdConfig = {},
  }: { dataPartitionSizeGb: number; avdConfig?: Readonly<Record<string, string>> },
  {
    avdDirectory = ownedAvdDirectory,
    readFile = (path: string) => readFileSync(path, 'utf8'),
    writeFile = (path: string, contents: string) => writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' }),
    rename = renameSync,
    remove = (path: string) => rmSync(path, { force: true }),
  }: {
    avdDirectory?: typeof ownedAvdDirectory;
    readFile?: (path: string) => string;
    writeFile?: (path: string, contents: string) => void;
    rename?: (from: string, to: string) => void;
    remove?: (path: string) => void;
  } = {},
): string {
  const sizeBytes = androidDataPartitionSizeBytes(dataPartitionSizeGb);
  const directory = avdDirectory(avdName);
  if (!directory) throw new Error(`Could not resolve the content directory for newly created AVD ${avdName}.`);
  const configPath = join(directory, 'config.ini');
  const original = readFile(configPath);
  const expected = { ...avdConfig, 'disk.dataPartition.size': String(sizeBytes) };
  const updated = withAvdConfigOverrides(original, expected);
  const tempPath = join(directory, `.config.ini.stim-${process.pid}-${++avdConfigWriteSequence}.tmp`);
  try {
    writeFile(tempPath, updated);
    rename(tempPath, configPath);
  } catch (error) {
    try {
      remove(tempPath);
    } catch {}
    throw error;
  }
  const verified = readFile(configPath);
  for (const [key, value] of Object.entries(expected)) {
    if (!verified.split(/\r?\n/).includes(`${key}=${value}`)) {
      throw new Error(`Could not verify ${key} in ${configPath}.`);
    }
  }
  return configPath;
}

export function bootAndroidEmulator(
  avdName: string,
  consolePort: number,
  { logFile }: { logFile?: string | null } = {},
): number | null {
  const exec = getExecutor();
  const child = exec.spawn(
    androidToolPath('emulator'),
    ['-avd', avdName, '-port', String(consolePort), ...headlessEmulatorArgs()],
    {
      detached: true,
      stdio: emulatorStdio(logFile),
    },
  );
  child?.unref?.();
  return child?.pid ?? null;
}

function emulatorStdio(logFile?: string | null): 'ignore' | (number | 'ignore')[] {
  if (!logFile) return 'ignore';
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, 'w');
    return ['ignore', fd, fd];
  } catch {
    return 'ignore';
  }
}

export const MAX_EMULATOR_FAILURE_LINES = 3;

const EMULATOR_PIPE_SEVERITY = /^(?:\S+:\s+)?(FATAL|ERROR)\s*\|\s*\S/;
const EMULATOR_PANIC = /^(?:\S+:\s+)?PANIC:\s*\S/;

export function extractEmulatorFailure(text: unknown): string[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const matched: Array<{ line: string; fatal: boolean; index: number }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] ?? '')
      .replace(/\r/g, '')
      .trim();
    if (!line) continue;
    const pipe = EMULATOR_PIPE_SEVERITY.exec(line);
    if (pipe) {
      matched.push({ line, fatal: pipe[1] !== 'ERROR', index: i });
      continue;
    }
    if (EMULATOR_PANIC.test(line)) matched.push({ line, fatal: true, index: i });
  }
  const fatal = matched.filter((m) => m.fatal);
  const pool = fatal.length > 0 ? fatal : matched;
  const byText = new Map<string, { line: string; index: number }>();
  for (const entry of pool) byText.set(entry.line.replace(/\s+/g, ' ').toLowerCase(), entry);
  return [...byText.values()]
    .toSorted((a, b) => a.index - b.index)
    .slice(-MAX_EMULATOR_FAILURE_LINES)
    .map((entry) => entry.line);
}

export function emulatorDiskSpaceRemedy(lines: string[]): string | null {
  const text = (Array.isArray(lines) ? lines : []).join('\n');
  if (!/ENOSPC|not enough space|no space left|disk (?:is )?full/i.test(text)) return null;
  return (
    'Free disk space (owned AVDs normally live under ~/.android/avd and can use several GB), ' +
    'then run `stim android` again.'
  );
}

export function emulatorFailureRemedy(lines: string[]): string {
  return emulatorDiskSpaceRemedy(lines) ?? 'Fix what the emulator reported above, then run `stim android` again.';
}

// runQuiet returns null whenever the command fails, which is the normal state
// for most of a boot: adb answers "device offline" or "device not found" until
// the emulator has registered. Null is "not booted yet", so it reads as an
// empty string and the poll continues.
function getprop(exec: Executor, serial: string, prop: string): string {
  const out = exec.runQuiet(`${androidTool('adb')} -s ${serial} shell getprop ${prop}`);
  return typeof out === 'string' ? out.trim() : '';
}

export async function waitForBoot(
  serial: string,
  timeoutMs = 60000,
  { aborted = () => false, pollMs = 1000 }: { aborted?: () => boolean; pollMs?: number } = {},
): Promise<BootResult> {
  const exec = getExecutor();
  const start = Date.now();
  let exited = false;
  while (Date.now() - start < timeoutMs) {
    if (getprop(exec, serial, 'sys.boot_completed') === '1') return { ok: true };
    if (getprop(exec, serial, 'dev.bootcomplete') === '1') return { ok: true };
    if (aborted()) {
      exited = true;
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const devicesOut = exec.runQuiet(`${androidTool('adb')} devices`);
  return {
    ok: false,
    ...(exited ? { exited: true as const } : {}),
    diagnostic: {
      devices: typeof devicesOut === 'string' ? devicesOut.trim() : '',
      sysBoot: getprop(exec, serial, 'sys.boot_completed'),
      devBoot: getprop(exec, serial, 'dev.bootcomplete'),
      bootAnim: getprop(exec, serial, 'init.svc.bootanim'),
    },
  };
}

const ANDROID_EMULATOR_SHUTDOWN_TIMEOUT_MS = 60_000;
const ANDROID_EMULATOR_SHUTDOWN_POLL_MS = 100;

export function shutdownAndroidEmulator(
  serial: string,
  timeoutMs: number = ANDROID_EMULATOR_SHUTDOWN_TIMEOUT_MS,
): void {
  getExecutor().runQuiet(`${androidTool('adb')} -s ${serial} emu kill`, { timeoutMs });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function avdProcessLockPaths(avdDirectory: string, platform: NodeJS.Platform): string[] {
  const names = ['hardware-qemu.ini.lock', 'userdata-qemu.img.lock'];
  return names.map((name) => join(avdDirectory, name, ...(platform === 'win32' ? ['pid'] : [])));
}

function readAvdProcessId(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').split('\0')[0] ?? '', 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function resolveAvdProcess(
  avdName: string,
  {
    platform = process.platform,
    resolveDirectory = ownedAvdDirectory,
    readProcessId = readAvdProcessId,
  }: {
    platform?: NodeJS.Platform;
    resolveDirectory?: typeof ownedAvdDirectory;
    readProcessId?: (path: string) => number | null;
  } = {},
): { directory: string; processId: number | null } {
  const directory = resolveDirectory(avdName);
  if (!directory) throw new Error(`Could not resolve the content directory for owned AVD ${avdName}.`);
  for (const lockPath of avdProcessLockPaths(directory, platform)) {
    const processId = readProcessId(lockPath);
    if (processId !== null) return { directory, processId };
  }
  return { directory, processId: null };
}

export function assertOwnedAvdStopped(
  avdName: string,
  {
    processAlive = isPidAlive,
    ...resolveOptions
  }: {
    platform?: NodeJS.Platform;
    resolveDirectory?: typeof ownedAvdDirectory;
    readProcessId?: (path: string) => number | null;
    processAlive?: (pid: number) => boolean;
  } = {},
): void {
  const { processId } = resolveAvdProcess(avdName, resolveOptions);
  if (processId !== null && processAlive(processId)) {
    throw new Error(`Owned AVD ${avdName} still has a live emulator process (${processId}).`);
  }
}

export function waitForAndroidEmulatorShutdown(
  avdName: string,
  shutdown: (timeoutMs: number) => void,
  {
    timeoutMs = ANDROID_EMULATOR_SHUTDOWN_TIMEOUT_MS,
    pollMs = ANDROID_EMULATOR_SHUTDOWN_POLL_MS,
    platform = process.platform,
    resolveDirectory = ownedAvdDirectory,
    readProcessId = readAvdProcessId,
    processAlive = isPidAlive,
    directoryExists = (path: string) => statSync(path).isDirectory(),
    now = Date.now,
    sleep = sleepSync,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    platform?: NodeJS.Platform;
    resolveDirectory?: typeof ownedAvdDirectory;
    readProcessId?: (path: string) => number | null;
    processAlive?: (pid: number) => boolean;
    directoryExists?: (path: string) => boolean;
    now?: () => number;
    sleep?: (ms: number) => void;
  } = {},
): void {
  const { directory, processId } = resolveAvdProcess(avdName, { platform, resolveDirectory, readProcessId });
  if (processId === null) {
    throw new Error(`Could not find the emulator process lock for owned AVD ${avdName}.`);
  }
  const deadline = now() + timeoutMs;
  const shutdownTimeoutMs = deadline - now();
  if (shutdownTimeoutMs <= 0) {
    throw new Error(`Owned AVD ${avdName} did not finish shutting down within ${Math.ceil(timeoutMs / 1000)}s.`);
  }
  shutdown(shutdownTimeoutMs);
  while (processAlive(processId)) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`Owned AVD ${avdName} did not finish shutting down within ${Math.ceil(timeoutMs / 1000)}s.`);
    }
    sleep(Math.min(pollMs, remaining));
  }
  if (!directoryExists(directory)) {
    throw new Error(`Could not verify the content directory for owned AVD ${avdName} after shutdown.`);
  }
}

export function getAvdNameForSerial(serial: string): string | null {
  const out = getExecutor().runQuiet(`${androidTool('adb')} -s ${serial} emu avd name`);
  if (!out) return null;
  return out.split('\n')[0]?.trim() || null;
}

export function resolveOwnedAvdSerial(avdName: string): ResolvedAvdSerial {
  if (!listAvds().includes(avdName)) return { missing: true };
  if (!avdName?.startsWith('stim-')) return { notOwned: true };
  const adb = listAdbDevices();
  const candidates = [
    ...adb.emulators,
    ...adb.unhealthy.filter((entry) => entry.kind === 'emulator' && entry.consolePort !== undefined),
  ];
  const match = candidates.find((e) => getAvdNameForSerial(e.serial) === avdName);
  if (match) return { serial: match.serial };
  return { notRunning: true };
}
