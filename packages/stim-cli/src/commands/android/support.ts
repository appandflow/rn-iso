import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { SettingsObject } from '../../types.ts';
import {
  listInstalledSystemImages,
  androidHome,
  findBuildTool,
  emulatorDiskSpaceRemedy,
  emulatorFailureRemedy,
  extractEmulatorFailure,
  androidPoolCandidates,
  androidPoolNoCandidatesRefusal,
  memoizeEmulatorProbe,
  listAdbDevices,
  physicalDeviceModel,
  probeEmulatorSerial,
} from '../../sim/android.ts';
import { unknownAndroidSystemImageRefusal, type OwnedDeviceRecord } from '../../engine/device.ts';
import { getExecutor } from '../../exec.ts';
import { devClientScheme as configuredDevClientScheme, pickDevClientScheme } from '../dev-client.ts';
import { selectFromPool } from '../../engine/device-pool.ts';
import type { FailExtra } from './types.ts';

export const PLATFORM = 'android';

export function androidVariantSetting(settings: SettingsObject | null | undefined): string | null {
  const android = settings?.['android'];
  if (!android || typeof android !== 'object' || Array.isArray(android)) return null;
  const raw = (android as Record<string, unknown>)['variant'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function resolveVariant(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || androidVariantSetting(settings);
}

export function androidSystemImageSetting(settings: SettingsObject | null | undefined): string | null {
  const android = settings?.['android'];
  if (!android || typeof android !== 'object' || Array.isArray(android)) return null;
  const raw = (android as Record<string, unknown>)['systemImage'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function resolveSystemImage(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || androidSystemImageSetting(settings);
}

export function systemImageRefusal({
  flag,
  resolved,
  physical,
  remoteBackend,
  listImages,
}: {
  flag: string | null | undefined;
  resolved: string | null;
  physical: boolean;
  remoteBackend: string | null;
  listImages: typeof listInstalledSystemImages;
}): { code: string; message: string; remedy: string } | null {
  if (typeof flag === 'string' && flag.trim() === '') {
    return {
      code: 'STIM_BAD_ARG',
      message: '--system-image was given an empty id.',
      remedy:
        'Pass `--system-image <id>` with an sdkmanager package id, e.g. "system-images;android-36;google_apis;arm64-v8a".',
    };
  }
  if (physical || remoteBackend) return null;
  if (!resolved) return null;
  let images;
  try {
    images = listImages();
  } catch (error) {
    return {
      code: NO_DEVICE,
      message: `Could not read the installed Android system images: ${(error as Error)?.message || error}`,
      remedy: 'Check that ANDROID_HOME points at a readable SDK, then try again.',
    };
  }
  const refusal = unknownAndroidSystemImageRefusal(resolved, images);
  return refusal ? { code: 'STIM_BAD_ARG', message: refusal.message, remedy: refusal.remedy } : null;
}

export function isReleaseVariant(variant: string | null | undefined): boolean {
  return typeof variant === 'string' && /release$/i.test(variant.trim());
}

export const NO_METRO = 'STIM_NO_METRO';

export const NO_FINGERPRINT = 'STIM_NO_FINGERPRINT';

export const NO_DEVICE = 'STIM_NO_DEVICE';

export const INSTALL_FAILED = 'STIM_INSTALL_FAILED';

export const LAUNCH_FAILED = 'STIM_LAUNCH_FAILED';

interface XmlNode {
  tag: string;
  attrs: Record<string, string | null>;
  children: XmlNode[];
  indent: number;
}

interface AaptTool {
  path: string;
  tool: string;
  version: string;
}

export function findAapt(
  home: string = androidHome(),
  {
    readDir = readdirSync,
    exists = existsSync,
  }: { readDir?: (path: string) => string[]; exists?: (path: string) => boolean } = {},
): AaptTool | null {
  const found = findBuildTool(['aapt', 'aapt2'], { home, readDir, exists });
  return found ? { path: found.path, tool: found.tool, version: found.version } : null;
}

export function dumpApkManifest(
  apkPath: unknown,
  { exec = null, aapt = null }: { exec?: import('../../exec.ts').Executor | null; aapt?: AaptTool | null } = {},
): string | null {
  if (typeof apkPath !== 'string' || apkPath.trim() === '') return null;
  const tool = aapt || findAapt();
  if (!tool) return null;
  const e = exec || getExecutor();
  const args =
    tool.tool === 'aapt2'
      ? ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apkPath]
      : ['dump', 'xmltree', apkPath, 'AndroidManifest.xml'];
  try {
    const out = e.runFile(tool.path, args);
    return typeof out === 'string' && out.includes('E: manifest') ? out : null;
  } catch {
    return null;
  }
}

export function parseXmltree(text: unknown): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], indent: -1 };
  const stack: XmlNode[] = [root];
  for (const raw of String(text ?? '').split('\n')) {
    const indent = raw.search(/\S/);
    if (indent < 0) continue;
    const line = raw.trim();
    const element = /^E: ([\w.:-]+)/.exec(line);
    if (element) {
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const node: XmlNode = { tag: element[1]!, attrs: {}, children: [], indent };
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
      continue;
    }
    const attr = /^A: ([^(=]+?)(?:\(0x[0-9a-f]+\))?=(.*)$/.exec(line);
    if (attr && stack.length > 1) {
      const name = attr[1]!.replace(/^http:\/\/schemas\.android\.com\/apk\/res\/android:/, 'android:');
      const value = /^"((?:[^"\\]|\\.)*)"/.exec(attr[2]!);
      stack[stack.length - 1]!.attrs[name] = value ? value[1]! : null;
    }
  }
  return root;
}

function eachNode(node: XmlNode, fn: (node: XmlNode) => void): void {
  fn(node);
  for (const child of node.children) eachNode(child, fn);
}

interface ApkDevClientFacts {
  devClient: boolean;
  schemes: string[];
}

export function apkPackage(text: unknown): string | null {
  const root = parseXmltree(text);
  const manifest = root.children.find((c) => c.tag === 'manifest');
  const pkg = manifest?.attrs['package'];
  return typeof pkg === 'string' && pkg.trim() ? pkg.trim() : null;
}

export function apkDevClientFacts(text: unknown): ApkDevClientFacts {
  const root = parseXmltree(text);
  const facts: ApkDevClientFacts = { devClient: false, schemes: [] };
  let launchable: XmlNode | null = null;
  eachNode(root, (node) => {
    const name = node.attrs['android:name'];
    if (typeof name === 'string' && name.startsWith('expo.modules.devlauncher')) facts.devClient = true;
    if (node.tag !== 'activity' && node.tag !== 'activity-alias') return;
    const filters = node.children.filter((c) => c.tag === 'intent-filter');
    const isLauncher = filters.some((f) =>
      f.children.some((c) => c.tag === 'action' && c.attrs['android:name'] === 'android.intent.action.MAIN'),
    );
    if (!isLauncher || launchable) return;
    launchable = node;
    for (const filter of filters) {
      for (const data of filter.children) {
        if (data.tag !== 'data') continue;
        const scheme = data.attrs['android:scheme'];
        if (typeof scheme === 'string' && scheme.trim()) facts.schemes.push(scheme.trim());
      }
    }
  });
  return facts;
}

export function androidDevClientScheme(
  root: string,
  apkPath: unknown,
  {
    exec = null,
    dump = dumpApkManifest,
    aapt = null,
  }: { exec?: import('../../exec.ts').Executor | null; dump?: typeof dumpApkManifest; aapt?: AaptTool | null } = {},
): string | null | undefined {
  const text = dump(apkPath, { exec, aapt });
  if (text) {
    const facts = apkDevClientFacts(text);
    if (!facts.devClient) return undefined;
    const scheme = pickDevClientScheme(facts.schemes);
    if (scheme) return scheme;
  }
  return configuredDevClientScheme(root, null);
}

const EMULATOR_LOG_TAIL_LINES = 400;

export function noDeviceDiagnostic({
  reason,
  logFile,
  remedy,
  localEmulator = true,
  readLog = readEmulatorLogTail,
}: {
  reason: string;
  logFile: string;
  remedy: string;
  localEmulator?: boolean;
  readLog?: (file: string) => string;
}): { message: string; remedy: string; lines: string[]; logPath: string | null } {
  const text = localEmulator ? readLog(logFile) : '';
  const logPath = text.trim() ? logFile : null;
  const found = extractEmulatorFailure(text);
  const diskRemedy = localEmulator ? emulatorDiskSpaceRemedy([reason, ...found]) : null;
  if (found.length === 0) {
    return {
      message: reason,
      remedy: diskRemedy ?? remedy,
      lines: [],
      logPath,
    };
  }
  return {
    message: `${reason} The emulator reported: ${found[0]}`,
    remedy: diskRemedy ?? emulatorFailureRemedy(found),
    lines: found.slice(1),
    logPath,
  };
}

function readEmulatorLogTail(file: string): string {
  try {
    return readFileSync(file, 'utf-8').split('\n').slice(-EMULATOR_LOG_TAIL_LINES).join('\n');
  } catch {
    return '';
  }
}

export function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

export async function pooledAndroidDevice({
  root,
  selectPool,
  listDevices,
  isEmulatorDevice,
  deviceModel,
  waitSeconds,
  noWait,
  now,
  warn,
}: {
  root: string;
  selectPool: typeof selectFromPool;
  listDevices: typeof listAdbDevices;
  isEmulatorDevice: typeof probeEmulatorSerial;
  deviceModel: typeof physicalDeviceModel;
  waitSeconds: number;
  noWait: boolean;
  now: () => number;
  warn: (line: string) => void;
}): Promise<{ device: OwnedDeviceRecord } | { code: string; message: string; remedy: string; extra: FailExtra }> {
  const isEmulator = memoizeEmulatorProbe(isEmulatorDevice);
  const pooled = await selectPool({
    root,
    platform: PLATFORM,
    idLabel: 'serial',
    list: () => androidPoolCandidates(listDevices(), isEmulator).map((entry) => ({ id: entry.serial })),
    noCandidates: () => {
      const resolved = androidPoolNoCandidatesRefusal(listDevices(), isEmulator);
      return { message: resolved.error as string, remedy: resolved.remedy as string };
    },
    waitSeconds,
    noWait,
    now,
    warn,
  });
  if (pooled.status === 'refused') {
    const { code, message, remedy, lease } = pooled.refusal;
    return { code, message, remedy, extra: lease === null ? {} : { lease } };
  }
  return {
    device: {
      serial: pooled.candidate.id,
      deviceName: deviceModel(pooled.candidate.id) ?? pooled.candidate.id,
      owned: false,
    },
  };
}
