import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import { parseNdjsonText, type NdjsonRecord } from '../ndjson.ts';
import { deviceHoldsApk, deviceHoldsBundle } from './installed-artifact.ts';

export const INSTALL_ERROR = 'STIM_INSTALL_FAILED';
export const LAUNCH_ERROR = 'STIM_LAUNCH_FAILED';

export const DEFAULT_METRO_PORT = 8081;

const IOS_SCHEME_APPROVAL_DOMAIN = 'com.apple.launchservices.schemeapproval';
const IOS_SCHEME_APPROVAL_OPENER = 'com.apple.CoreSimulator.CoreSimulatorBridge';
const IOS_DEV_MENU_SHOWS_AT_LAUNCH_KEY = 'EXDevMenuShowsAtLaunch';
const DEV_CLIENT_ONBOARDING_QUERY = 'disableOnboarding=1';
const ANDROID_DISABLE_AUTO_LAUNCH_EXTRA = 'EXDevMenuDisableAutoLaunch';

interface ExecOpt {
  exec?: Executor | null;
}

export type IosInstallResult = {
  ok?: boolean;
  appPath?: string;
  skipped?: boolean;
  failed?: boolean;
  code?: string;
  reason?: string;
};

export type IosLaunchResult = {
  ok?: boolean;
  mode?: string;
  url?: string;
  jsLocation?: string;
  pid?: number | null;
  failed?: boolean;
  code?: string;
  reason?: string;
};

export type AndroidInstallResult = {
  ok?: boolean;
  apkPath?: string;
  skipped?: boolean;
  uninstalled?: boolean;
  note?: string;
  failed?: boolean;
  code?: string;
  reason?: string;
};

export type AndroidLaunchResult = {
  ok?: boolean;
  mode?: string;
  component?: string;
  devClientUrl?: string;
  devClientNote?: string | null;
  reversed?: string[];
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
  failed?: boolean;
  code?: string;
  reason?: string;
};

export function installIosApp(
  {
    udid,
    appPath,
    bundleId = null,
    devClientScheme = null,
  }: { udid: string; appPath: string; bundleId?: string | null; devClientScheme?: string | null },
  { exec = null }: ExecOpt = {},
): IosInstallResult {
  const e = exec || getExecutor();
  const skipped = bundleId ? deviceHoldsBundle({ udid, bundleId, appPath }, { exec: e }) : false;
  if (!skipped) {
    try {
      e.runFile('xcrun', ['simctl', 'install', udid, appPath]);
    } catch (err) {
      return { failed: true, code: INSTALL_ERROR, reason: `simctl install failed for ${appPath}: ${describe(err)}` };
    }
  }
  if (bundleId && devClientScheme) {
    try {
      e.runFile('xcrun', [
        'simctl',
        'spawn',
        udid,
        'defaults',
        'write',
        bundleId,
        IOS_DEV_MENU_SHOWS_AT_LAUNCH_KEY,
        '-bool',
        'false',
      ]);
      for (const key of iosSchemeApprovalKeys(bundleId, devClientScheme)) {
        e.runFile('xcrun', [
          'simctl',
          'spawn',
          udid,
          'defaults',
          'write',
          IOS_SCHEME_APPROVAL_DOMAIN,
          key,
          '-string',
          bundleId,
        ]);
      }
    } catch (err) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason: `Installed ${bundleId}, but could not prepare the dev client: ${describe(err)}`,
      };
    }
  }
  return skipped ? { ok: true, appPath, skipped: true } : { ok: true, appPath };
}

export function jsLocationValue(metroPort: number | string): string {
  return `localhost:${metroPort}`;
}

// On iOS expo-dev-launcher reads disableOnboarding off the PROJECT url only,
// not the outer deep link: EXDevLauncherController.m hands `devLauncherUrl.url`
// to EXDevLauncherURLHelper.disableOnboardingPopupIfNeeded. It sets
// EXDevMenuIsOnboardingFinished alone; EXDevMenuShowsAtLaunch is a separate
// preference. Android reads the flag on either url, and its
// EXDevMenuDisableAutoLaunch intent extra sets both (DevLauncherController.kt).
export function devClientDeepLink(scheme: string, projectOrigin: string): string {
  const projectUrl = `${projectOrigin.replace(/\/+$/, '')}/?${DEV_CLIENT_ONBOARDING_QUERY}`;
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(projectUrl)}`;
}

export function devClientUrl(scheme: string, metroPort: number | string, host = 'localhost'): string {
  return devClientDeepLink(scheme, `http://${host}:${metroPort}`);
}

export function iosSchemeApprovalKeys(bundleId: string, devClientScheme: string): string[] {
  return [...new Set([bundleId, devClientScheme])].map((target) => `${IOS_SCHEME_APPROVAL_OPENER}-->${target}`);
}

export function parseLaunchedPid(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/:\s*(\d+)\s*$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function iosAppProcess(
  udid: string,
  bundleId: string,
  { exec = null }: ExecOpt = {},
): number | null | undefined {
  const e = exec || getExecutor();
  let out = '';
  try {
    out = e.runFile('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list']);
  } catch {
    return undefined;
  }
  const label = `UIKitApplication:${bundleId}[`;
  for (const line of out.split('\n')) {
    if (!line.includes(label)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

export function launchIosApp(
  {
    udid,
    bundleId,
    metroPort,
    devClientScheme = null,
  }: { udid: string; bundleId: string; metroPort: number | string | null; devClientScheme?: string | null },
  { exec = null }: ExecOpt = {},
): IosLaunchResult {
  const e = exec || getExecutor();
  if (metroPort !== null) {
    try {
      e.runFile('xcrun', [
        'simctl',
        'spawn',
        udid,
        'defaults',
        'write',
        bundleId,
        'RCT_jsLocation',
        jsLocationValue(metroPort),
      ]);
    } catch (err) {
      return {
        failed: true,
        code: LAUNCH_ERROR,
        reason: `Could not point ${bundleId} at Metro port ${metroPort} (defaults write RCT_jsLocation): ${describe(err)}`,
      };
    }

    if (devClientScheme) {
      const url = devClientUrl(devClientScheme, metroPort);
      try {
        e.runFile('xcrun', ['simctl', 'openurl', udid, url]);
        return { ok: true, mode: 'openurl', url, jsLocation: jsLocationValue(metroPort) };
      } catch (err) {
        return { failed: true, code: LAUNCH_ERROR, reason: `simctl openurl ${url} failed: ${describe(err)}` };
      }
    }
  }

  try {
    const out = e.runFile('xcrun', ['simctl', 'launch', udid, bundleId]);
    const result: IosLaunchResult = { ok: true, mode: 'launch', pid: parseLaunchedPid(out) };
    if (metroPort !== null) result.jsLocation = jsLocationValue(metroPort);
    return result;
  } catch (err) {
    return { failed: true, code: LAUNCH_ERROR, reason: `simctl launch ${bundleId} failed: ${describe(err)}` };
  }
}

export function installConflictKind(text: unknown): 'signature' | 'downgrade' | null {
  const out = String(text ?? '');
  if (
    /INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES|signatures do not match/i.test(
      out,
    )
  ) {
    return 'signature';
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(out)) return 'downgrade';
  return null;
}

export const ADB_INSTALL_TIMEOUT_MS = 300_000;

export function installAndroidApp(
  {
    serial,
    apkPath,
    packageName = null,
    allowUninstall = false,
  }: { serial: string; apkPath: string; packageName?: string | null; allowUninstall?: boolean },
  { exec = null }: ExecOpt = {},
): AndroidInstallResult {
  const e = exec || getExecutor();
  if (packageName && deviceHoldsApk({ serial, packageName, apkPath }, { exec: e })) {
    return { ok: true, apkPath, skipped: true };
  }
  const install = () => {
    e.runFile('adb', ['-s', serial, 'install', '-r', apkPath], { timeoutMs: ADB_INSTALL_TIMEOUT_MS });
  };
  try {
    install();
    return { ok: true, apkPath };
  } catch (err) {
    const conflict = installConflictKind(describe(err));
    if (!conflict || !allowUninstall || !packageName) {
      return { failed: true, code: INSTALL_ERROR, reason: `adb install failed for ${apkPath}: ${describe(err)}` };
    }
    try {
      e.runFile('adb', ['-s', serial, 'uninstall', packageName]);
    } catch (uninstallErr) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason:
          `adb install failed for ${apkPath} (${conflict}) and ${packageName} could not be uninstalled: ` +
          describe(uninstallErr),
      };
    }
    try {
      install();
    } catch (retryErr) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason: `adb install failed for ${apkPath} even after uninstalling ${packageName}: ${describe(retryErr)}`,
      };
    }
    return {
      ok: true,
      apkPath,
      uninstalled: true,
      note:
        conflict === 'signature'
          ? `${packageName} was already installed with a different signer, so it was uninstalled (its data went with it) before this APK could be installed`
          : `${packageName} was already installed at a higher versionCode, so it was uninstalled (its data went with it) before this APK could be installed`,
    };
  }
}

export function parseResolvedActivity(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^No activity found/i.test(line)) return null;
    if (line.includes('=')) continue;
    if (!line.includes('/')) continue;
    return line;
  }
  return null;
}

function resolveLaunchActivity(serial: string, packageName: string, { exec = null }: ExecOpt = {}) {
  const e = exec || getExecutor();
  try {
    const out = e.runFile('adb', [
      '-s',
      serial,
      'shell',
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-c',
      'android.intent.category.LAUNCHER',
      packageName,
    ]);
    return parseResolvedActivity(out);
  } catch {
    return null;
  }
}

export function reverseMetroPorts(
  {
    serial,
    metroPort,
    devicePorts = null,
  }: { serial: string; metroPort: number | string; devicePorts?: (number | string)[] | null },
  { exec = null }: ExecOpt = {},
): { ok?: boolean; reversed?: string[]; failed?: boolean; code?: string; reason?: string } {
  const e = exec || getExecutor();
  const pairs = (devicePorts ?? [metroPort]).map((device) => [device, metroPort]);
  for (const [device, host] of pairs) {
    try {
      e.runFile('adb', ['-s', serial, 'reverse', `tcp:${device}`, `tcp:${host}`]);
    } catch (err) {
      return {
        failed: true,
        code: LAUNCH_ERROR,
        reason: `adb reverse tcp:${device} tcp:${host} failed on ${serial}: ${describe(err)}`,
      };
    }
  }
  return { ok: true, reversed: pairs.map(([device, host]) => `tcp:${device}->tcp:${host}`) };
}

const EMULATOR_HOST_LOOPBACK = '10.0.2.2';
const PHYSICAL_HOST_LOOPBACK = 'localhost';

function androidMetroHost(physical: boolean): string {
  return physical ? PHYSICAL_HOST_LOOPBACK : EMULATOR_HOST_LOOPBACK;
}

export function deviceShellArg(text: unknown): string {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

export function debugHttpHostScript({
  packageName,
  host,
  dataDir = null,
}: {
  packageName: string;
  host: string;
  dataDir?: string | null;
}): string {
  const dir = dataDir || `/data/data/${packageName}`;
  const prefs = `shared_prefs/${packageName}_preferences.xml`;
  const tmp = `${prefs}.stim.tmp`;
  return [
    `cd ${dir} || exit 1`,
    'mkdir -p shared_prefs || exit 1',
    `printf '%s\\n' '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>' '<map>' > ${tmp} || exit 1`,
    `if [ -f ${prefs} ]; then grep -v 'debug_http_host' ${prefs} | grep -v '<?xml' | grep -v '<map' | grep -v '</map>' >> ${tmp}; fi`,
    `printf '%s\\n' '    <string name="debug_http_host">${host}</string>' '</map>' >> ${tmp} || exit 1`,
    `mv ${tmp} ${prefs} || exit 1`,
    `grep -q '>${host}<' ${prefs} || exit 1`,
  ].join('\n');
}

export function writeDebugHttpHost(
  {
    serial,
    packageName,
    metroPort,
    physical = false,
  }: { serial: string; packageName: string; metroPort: number | string; physical?: boolean },
  { exec = null }: ExecOpt = {},
): { ok: boolean; host?: string; reason?: string } {
  const e = exec || getExecutor();
  const host = `${androidMetroHost(physical)}:${metroPort}`;
  const script = debugHttpHostScript({ packageName, host });
  try {
    e.runFile('adb', ['-s', serial, 'shell', 'run-as', packageName, 'sh', '-c', deviceShellArg(script)]);
    return { ok: true, host };
  } catch (err) {
    return { ok: false, reason: `debug_http_host not written (${describe(err)}); relying on adb reverse` };
  }
}

export function androidDevClientUrl(scheme: string, metroPort: number | string, physical = false): string {
  return devClientUrl(scheme, metroPort, androidMetroHost(physical));
}

export function amStartError(text: unknown): string | null {
  const out = String(text ?? '');
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (/^Error:/i.test(line)) return line;
  }
  return null;
}

export function openAndroidDevClientUrl(
  { serial, url }: { serial: string; url: string },
  { exec = null }: ExecOpt = {},
): { ok?: boolean; url?: string; failed?: boolean; reason?: string } {
  const e = exec || getExecutor();
  let out;
  try {
    out = e.runFile('adb', [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      deviceShellArg(url),
      '--ez',
      ANDROID_DISABLE_AUTO_LAUNCH_EXTRA,
      'true',
    ]);
  } catch (err) {
    return { failed: true, reason: `am start -d ${url} failed on ${serial}: ${describe(err)}` };
  }
  const error = amStartError(out);
  if (error) return { failed: true, reason: `am start -d ${url} did not start anything on ${serial}: ${error}` };
  return { ok: true, url };
}

export function launchAndroidApp(
  {
    serial,
    packageName,
    metroPort,
    devClientScheme = null,
    physical = false,
  }: {
    serial: string;
    packageName: string;
    metroPort: number | string;
    devClientScheme?: string | null;
    physical?: boolean;
  },
  { exec = null }: ExecOpt = {},
): AndroidLaunchResult {
  const e = exec || getExecutor();
  const reversed = reverseMetroPorts({ serial, metroPort }, { exec: e });
  if (reversed.failed) return reversed;
  const prefs = writeDebugHttpHost({ serial, packageName, metroPort, physical }, { exec: e });
  let reversedPairs = reversed.reversed ?? [];
  if (!prefs.ok && Number(metroPort) !== DEFAULT_METRO_PORT) {
    const fallback = reverseMetroPorts({ serial, metroPort, devicePorts: [DEFAULT_METRO_PORT] }, { exec: e });
    if (fallback.failed) return fallback;
    reversedPairs = [...reversedPairs, ...(fallback.reversed ?? [])];
  }
  const wiring = {
    reversed: reversedPairs,
    debugHttpHost: prefs.ok ? prefs.host : null,
    debugHttpHostNote: prefs.ok ? null : prefs.reason,
  };

  let devClientNote = null;
  if (devClientScheme) {
    const url = androidDevClientUrl(devClientScheme, metroPort, physical);
    const opened = openAndroidDevClientUrl({ serial, url }, { exec: e });
    if (opened.ok) return { ok: true, mode: 'deep-link', devClientUrl: url, ...wiring };
    devClientNote = `${opened.reason}; fell back to the launcher activity`;
  }

  const component = resolveLaunchActivity(serial, packageName, { exec: e });
  if (component) {
    try {
      e.runFile('adb', ['-s', serial, 'shell', 'am', 'start', '-n', component]);
      return { ok: true, mode: 'am-start', component, devClientNote, ...wiring };
    } catch (err) {
      return {
        failed: true,
        code: LAUNCH_ERROR,
        reason: `am start -n ${component} failed on ${serial}: ${describe(err)}`,
      };
    }
  }

  try {
    e.runFile('adb', ['-s', serial, 'shell', 'monkey', '-p', packageName, '1']);
    return { ok: true, mode: 'monkey', devClientNote, ...wiring };
  } catch (err) {
    return {
      failed: true,
      code: LAUNCH_ERROR,
      reason: `Could not launch ${packageName} on ${serial}: no launcher activity resolved and monkey failed: ${describe(err)}`,
    };
  }
}

export function launchAndroidReleaseApp(
  { serial, packageName }: { serial: string; packageName: string },
  { exec = null }: ExecOpt = {},
): AndroidLaunchResult {
  const e = exec || getExecutor();
  const component = resolveLaunchActivity(serial, packageName, { exec: e });
  if (component) {
    try {
      e.runFile('adb', ['-s', serial, 'shell', 'am', 'start', '-n', component]);
      return { ok: true, mode: 'am-start', component };
    } catch (err) {
      return {
        failed: true,
        code: LAUNCH_ERROR,
        reason: `am start -n ${component} failed on ${serial}: ${describe(err)}`,
      };
    }
  }
  try {
    e.runFile('adb', ['-s', serial, 'shell', 'monkey', '-p', packageName, '1']);
    return { ok: true, mode: 'monkey' };
  } catch (err) {
    return {
      failed: true,
      code: LAUNCH_ERROR,
      reason: `Could not launch ${packageName} on ${serial}: no launcher activity resolved and monkey failed: ${describe(err)}`,
    };
  }
}

function describe(err: unknown) {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = e?.stderr ? String(e.stderr).trim() : '';
  const message = e?.message ? String(e.message).trim() : String(err);
  return stderr ? `${message}: ${stderr}` : message;
}

export type VerifyLaunchResult = {
  verified: boolean;
  record?: NdjsonRecord;
  errors?: NdjsonRecord[];
  fatal?: boolean;
  processAlive?: boolean | null;
  timedOut?: boolean;
  requested?: boolean;
  mode: string | null;
  waitedMs: number;
};

export const RELEASE_VERIFY_WAIT_MS = 3000;

export type ReleaseVerifyResult = {
  verified: boolean;
  reason?: 'no-pid' | 'exited' | 'probe-failed';
  waitedMs: number;
};

export async function verifyReleaseLaunch({
  pid,
  waitMs = RELEASE_VERIFY_WAIT_MS,
  alive = isProcessAlive,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  pid?: number | null;
  waitMs?: number;
  alive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<ReleaseVerifyResult> {
  const startedAt = now();
  if (!pid) return { verified: false, reason: 'no-pid', waitedMs: 0 };
  await sleep(Math.max(0, waitMs));
  const waitedMs = now() - startedAt;
  return alive(pid) ? { verified: true, waitedMs } : { verified: false, reason: 'exited', waitedMs };
}

export function parsePidof(text: unknown): number | null {
  const first = String(text ?? '')
    .trim()
    .split(/\s+/)[0];
  const pid = Number(first);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function parsePsPid(text: unknown, packageName: string): number | null {
  for (const raw of String(text ?? '').split('\n')) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 2) continue;
    if (cols[cols.length - 1] !== packageName) continue;
    const pid = Number(cols[1]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

export function androidAppProcess(
  serial: string,
  packageName: string,
  { exec = null }: ExecOpt = {},
): number | null | undefined {
  const e = exec || getExecutor();
  try {
    const pid = parsePidof(e.runFile('adb', ['-s', serial, 'shell', 'pidof', packageName]));
    if (pid !== null) return pid;
  } catch {}
  try {
    return parsePsPid(e.runFile('adb', ['-s', serial, 'shell', 'ps', '-A']), packageName);
  } catch {
    return undefined;
  }
}

export async function verifyAndroidReleaseLaunch({
  serial,
  packageName,
  waitMs = RELEASE_VERIFY_WAIT_MS,
  exec = null,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  serial: string;
  packageName: string;
  waitMs?: number;
  exec?: Executor | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<ReleaseVerifyResult & { pid?: number | null }> {
  const e = exec || getExecutor();
  const startedAt = now();
  await sleep(Math.max(0, waitMs));
  const pid = androidAppProcess(serial, packageName, { exec: e });
  const waitedMs = now() - startedAt;
  if (pid === undefined) return { verified: false, reason: 'probe-failed', waitedMs };
  return pid === null ? { verified: false, reason: 'exited', waitedMs, pid: null } : { verified: true, waitedMs, pid };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export const LAUNCH_UNVERIFIED = 'unverified';

export const LAUNCH_BUNDLING = 'bundling';

export const LAUNCH_FATAL = 'fatal';

export const VERIFY_TIMEOUT_MS = 20000;
export const STABILITY_WINDOW_MS = 3000;
const VERIFY_POLL_MS = 500;

const BUNDLE_EVENTS = new Set([
  'bundle_build_started',
  'bundle_build_done',
  'bundle_build_failed',
  'bundling_error',
  'transformer_error',
]);

export function isBundleProof(
  record: unknown,
  since: number | string = 0,
  platform: 'ios' | 'android' | null = null,
): boolean {
  if (!record || typeof record !== 'object') return false;
  const rec = record as NdjsonRecord;
  const ts = Number(rec.ts);
  if (!Number.isFinite(ts) || ts < Number(since || 0)) return false;
  if (platform && recordPlatform(rec) !== platform) return false;
  if (typeof rec.event === 'string' && BUNDLE_EVENTS.has(rec.event)) return true;
  if (rec.src === 'metro' && typeof rec.msg === 'string' && expoBundleLine(rec.msg)) return true;
  return false;
}

const BUNDLE_URL_PATH = /\.bundle\b|\/_expo\/|expo-development-client/i;

export function isBundleRequestProof(
  record: unknown,
  since: number | string = 0,
  port: number | string | null = null,
  platform: 'ios' | 'android' | null = null,
): boolean {
  if (!record || typeof record !== 'object' || !port) return false;
  const rec = record as NdjsonRecord;
  const ts = Number(rec.ts);
  if (!Number.isFinite(ts) || ts < Number(since || 0)) return false;
  if (typeof rec.msg !== 'string') return false;
  if (rec.level === 'error' || rec.level === 'fatal') return false;
  const sourcePlatform = recordPlatform(rec);
  if (platform && sourcePlatform && sourcePlatform !== platform) return false;
  const digits = String(port).replace(/[^0-9]/g, '');
  if (!digits) return false;
  if (!new RegExp(`:${digits}\\b`).test(rec.msg)) return false;
  return BUNDLE_URL_PATH.test(rec.msg);
}

function expoBundleLine(msg: string) {
  return /\bBundl(?:ing|ed)\b/.test(msg);
}

export async function verifyLaunch({
  logsDir,
  since,
  metroPort = null,
  platform = null,
  mode = null,
  timeoutMs = VERIFY_TIMEOUT_MS,
  stabilityMs = STABILITY_WINDOW_MS,
  pollMs = VERIFY_POLL_MS,
  readRecords = null,
  readDeviceRecords = null,
  readClientRecords = null,
  processAlive = null,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  logsDir?: string;
  since?: number | string;
  metroPort?: number | string | null;
  platform?: 'ios' | 'android' | null;
  mode?: string | null;
  timeoutMs?: number;
  stabilityMs?: number;
  pollMs?: number;
  readRecords?: (() => NdjsonRecord[]) | null;
  readDeviceRecords?: (() => NdjsonRecord[]) | null;
  readClientRecords?: (() => NdjsonRecord[]) | null;
  processAlive?: (() => boolean | null) | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
} = {}): Promise<VerifyLaunchResult> {
  const read = readRecords || (() => readMetroRecords(logsDir));
  const readDevice = readDeviceRecords || (() => readNdjson(logsDir, 'device.ndjson'));
  const readClient = readClientRecords || (() => readNdjson(logsDir, 'client.ndjson'));
  const startedAt = now();
  const bundleDeadline = startedAt + Math.max(0, timeoutMs);
  let proof: NdjsonRecord | null = null;
  let activity: NdjsonRecord | null = null;
  let stabilityDeadline: number | null = null;
  while (true) {
    const metroRecords = read().filter((record) => after(record, since));
    for (const record of metroRecords) {
      if (isBundleProof(record, since, platform)) activity = record;
      if (!proof && isBundleReadyProof(record, since, platform)) {
        proof = record;
        stabilityDeadline = Number(record.ts) + Math.max(0, stabilityMs);
      }
    }
    const bundleErrors = metroRecords.filter((record) => isFatalLaunchError(record, platform));
    if (bundleErrors.length) {
      const alive = processAlive ? processAlive() : null;
      const fatalRecord = bundleErrors[bundleErrors.length - 1];
      const fatalAt = Number(fatalRecord?.ts ?? since ?? 0);
      const errors = metroRecords.filter(
        (record) =>
          after(record, fatalAt) && recordCouldBelongToPlatform(record, platform) && isLaunchError(record, platform),
      );
      return {
        verified: false,
        fatal: true,
        errors,
        processAlive: alive,
        record: fatalRecord,
        mode,
        waitedMs: now() - startedAt,
      };
    }

    if (proof && stabilityDeadline !== null && now() >= stabilityDeadline) {
      const errorSince = Number(proof.ts ?? since ?? 0);
      const deviceRecords = readDevice().filter((record) => after(record, errorSince));
      const clientRecords = readClient().filter((record) => after(record, errorSince));
      const errors = [
        ...metroRecords.filter((record) => after(record, errorSince) && recordCouldBelongToPlatform(record, platform)),
        ...deviceRecords.filter((record) => recordCouldBelongToPlatform(record, platform)),
        ...clientRecords,
      ].filter((record) => isLaunchError(record, platform));
      const alive = processAlive ? processAlive() : null;
      const waitedMs = now() - startedAt;
      if (alive === false) {
        return {
          verified: false,
          fatal: true,
          errors,
          processAlive: alive,
          record: proof,
          mode,
          waitedMs,
        };
      }
      const actionableErrors = errors.filter((record) => !isIosConnectionRefusal(record, platform));
      return { verified: true, record: proof, errors: actionableErrors, processAlive: alive, mode, waitedMs };
    }

    if (!proof && now() >= bundleDeadline) {
      const deviceRecords = readDevice().filter((record) => after(record, since));
      const requested = findBundleRequest(deviceRecords, since, metroPort, platform) ?? activity;
      const waitedMs = now() - startedAt;
      if (requested) {
        return {
          verified: false,
          timedOut: true,
          requested: true,
          record: requested,
          mode,
          waitedMs,
        };
      }
      return { verified: false, timedOut: true, mode, waitedMs };
    }
    const deadline = stabilityDeadline ?? bundleDeadline;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

function after(record: NdjsonRecord, since: number | string | undefined): boolean {
  const ts = Number(record.ts);
  return Number.isFinite(ts) && ts >= Number(since ?? 0);
}

function isLaunchError(record: NdjsonRecord, platform: 'ios' | 'android' | null): boolean {
  return record.level === 'error' || record.level === 'fatal' || isFatalLaunchError(record, platform);
}

// Apple's Network framework logs a failed TCP connection at Error level with a
// POSIX errno in the text, and 61 is ECONNREFUSED.
const TCP_REFUSAL = /^TCP Conn 0x[0-9a-f]+ Failed : error 0:61 \[61\]$/i;

function isIosConnectionRefusal(record: NdjsonRecord, platform: 'ios' | 'android' | null): boolean {
  return (
    platform === 'ios' &&
    record.src === 'device' &&
    record.level === 'error' &&
    typeof record.msg === 'string' &&
    TCP_REFUSAL.test(record.msg)
  );
}

function isFatalLaunchError(record: NdjsonRecord, platform: 'ios' | 'android' | null): boolean {
  if (platform && recordPlatform(record) !== platform) return false;
  return (
    record.event === 'bundle_build_failed' ||
    record.event === 'bundling_error' ||
    record.event === 'transformer_error' ||
    ((record.event === 'expo_stdout' || record.event === 'expo_stderr') &&
      typeof record.msg === 'string' &&
      /\bBundling failed\b/.test(record.msg))
  );
}

function isBundleReadyProof(
  record: unknown,
  since: number | string = 0,
  platform: 'ios' | 'android' | null = null,
): boolean {
  if (!isBundleProof(record, since, platform)) return false;
  const rec = record as NdjsonRecord;
  if (rec.event === 'bundle_build_done') return true;
  return rec.src === 'metro' && typeof rec.msg === 'string' && /\bBundled\b/.test(rec.msg);
}

function findBundleRequest(
  records: NdjsonRecord[],
  since: number | string | undefined,
  port: number | string | null,
  platform: 'ios' | 'android' | null,
): NdjsonRecord | null {
  for (const record of records) {
    if (isBundleRequestProof(record, since ?? 0, port, platform)) return record;
  }
  return null;
}

function recordCouldBelongToPlatform(record: NdjsonRecord, platform: 'ios' | 'android' | null): boolean {
  if (!platform) return true;
  const sourcePlatform = recordPlatform(record);
  return sourcePlatform === null || sourcePlatform === platform;
}

function recordPlatform(record: NdjsonRecord): 'ios' | 'android' | null {
  if (record.platform === 'ios' || record.platform === 'android') return record.platform;
  if (typeof record.msg !== 'string') return null;
  const match = record.msg.match(/\b(iOS|Android)\s+Bundl(?:ed|ing)\b/i);
  if (!match) return null;
  return match[1]!.toLowerCase() === 'ios' ? 'ios' : 'android';
}

export function readMetroRecords(logsDir: string | undefined): NdjsonRecord[] {
  return readNdjson(logsDir, 'metro.ndjson');
}

export function readCollectorRecords(logsDir: string | undefined): NdjsonRecord[] {
  return readNdjson(logsDir, 'device.ndjson');
}

function readNdjson(logsDir: string | undefined, name: string): NdjsonRecord[] {
  if (!logsDir) return [];
  try {
    return parseNdjsonText(readFileSync(join(logsDir, name), 'utf-8'));
  } catch {
    return [];
  }
}

export function unverifiedLaunchLines({
  platform,
  metroPort,
  waitedMs = VERIFY_TIMEOUT_MS,
  bundleId = null,
  udid = null,
  serial = null,
  devClientUrl: url = null,
  mode = null,
  remote = false,
  physical = false,
  devClient = false,
  lanOrigin = null,
  metroOrigin = null,
  localNetworkPending = false,
}: {
  platform: string;
  metroPort: number | string;
  waitedMs?: number;
  bundleId?: string | null;
  udid?: string | null;
  serial?: string | null;
  devClientUrl?: string | null;
  mode?: string | null;
  remote?: boolean;
  physical?: boolean;
  devClient?: boolean;
  lanOrigin?: string | null;
  metroOrigin?: string | null;
  localNetworkPending?: boolean;
  // Explicit return type: isolatedDeclarations requires one at every module
  // boundary.
}): string[] {
  const seconds = Math.round(Number(waitedMs || 0) / 1000);
  const localNetwork = localNetworkPending && platform === 'ios' && physical;
  const lines = [
    `The app was started, but nothing fetched a bundle from this workspace's Metro (port ${metroPort}) within ${seconds}s.`,
  ];
  const origin = metroOrigin || `http://localhost:${metroPort}`;
  const picker = `If expo-dev-launcher's DEVELOPMENT SERVERS picker is showing, tap the entry for ${origin} -- NOT another workspace's, which would load a different project's bundle onto this device.`;
  let step = 0;
  const push = (text: string) => lines.push(`  ${++step}. ${text}`);
  lines.push(
    localNetwork
      ? `THE PHONE'S LOCAL NETWORK PERMISSION IS NOT GRANTED: the LAN connections this launch made failed with ` +
          `NSURLErrorDomain -1009 and the path reason "unsatisfied (Local network prohibited)", which is what iOS ` +
          'returns while the "would like to find and connect to devices on your local network" prompt is unanswered ' +
          `OR was answered Don't Allow earlier -- the log reads the same either way. Nothing the app sends reaches ` +
          `${lanOrigin || origin} until it is granted. Do this, in order:`
      : 'The app is launched; what is unproven is that it is talking to THIS dev server. Do this, in order:',
  );
  if (remote) {
    push(
      `Check that ${origin} is reachable FROM THE DEVICE's network, not just from this machine. That is the usual cause: a tunnel that stopped, or one this machine can reach and the device cannot.`,
    );
    push(
      'If an "Open in <app>?" alert or the expo-dev-launcher picker is showing on the remote device, confirm it with your device tool (`agent-device snapshot -i`, then `agent-device press`).',
    );
    lines.push(`Then check \`stim logs --source metro\`${mode ? ` (${mode})` : ''} for a bundle request.`);
    return lines;
  }
  if (platform === 'ios' && physical) {
    const target = lanOrigin || origin;
    const relaunch =
      `xcrun devicectl device process launch --device ${udid} --terminate-existing ` +
      (url ? `--payload-url '${url}' ` : '') +
      bundleId;
    if (localNetwork) {
      push(
        `See the prompt: agent-device alert get --platform ios --udid ${udid}. It reads the alert without opening ` +
          'anything, so it works while the app sits behind it.',
      );
      push(
        `Tap Allow: agent-device alert accept --platform ios --udid ${udid}. A second \`alert get\` then finds none.`,
      );
      push(
        'If the FIRST `alert get` already finds no alert, this permission was denied on an earlier run -- a ' +
          "Don't Allow persists across upgrade installs. Turn the app on by hand under Settings > Privacy & " +
          'Security > Local Network; there is no API for that switch.',
      );
      if (devClient) {
        push(
          'The app does NOT retry after the grant -- it stays on "Failed to load app ... The Internet connection ' +
            `appears to be offline." with a Reload button. Press it: agent-device snapshot -i --platform ios --udid ${udid}, ` +
            `then agent-device press 'label="Reload"' --platform ios --udid ${udid}. On a fresh install the Expo dev ` +
            `menu can be over the app first -- the deep link finishes the launcher's onboarding, not ` +
            `EXDevMenuShowsAtLaunch, which defaults true on iOS -- so agent-device press 'label="Close"' ` +
            `--platform ios --udid ${udid} dismisses it.`,
        );
        push(
          `Without agent-device, relaunching also recovers: ${relaunch}. It costs the device log -- it replaces the ` +
            'process the collector follows, so `stim logs --source device` stops for the rest of this run. Pressing ' +
            'Reload keeps the collector alive.',
        );
        push('By hand: tap Allow on the phone, then tap Reload on the app.');
      } else {
        push(
          'The app does NOT retry after the grant. A bare app is expected to show React Native\'s "Could not connect ' +
            'to development server" RedBox -- NOT VERIFIED ON HARDWARE, so read the screen rather than trusting that: ' +
            `agent-device snapshot -i --platform ios --udid ${udid}, then press its Reload button by the ref or label ` +
            'that snapshot reports.',
        );
        push(
          `Cleanest for a bare app: relaunch, which re-reads ip.txt: ${relaunch}. It costs the device log -- it ` +
            'replaces the process the collector follows, so `stim logs --source device` stops for the rest of this run.',
        );
        push('By hand: tap Allow on the phone, then tap Reload on the RedBox.');
      }
      lines.push(
        '`agent-device metro reload` does NOT recover either screen: it only reaches an app already connected to ' +
          "Metro's websocket, and this app never connected.",
      );
      lines.push(`Then check \`stim logs --source metro\`${mode ? ` (${mode})` : ''} for a bundle request.`);
      return lines;
    }
    push(
      `Tap Allow on the phone's "would like to find and connect to devices on your local network" prompt if it is showing, ` +
        'or turn the app on under Settings > Privacy & Security > Local Network. iOS gates every LAN connection behind ' +
        'that permission, it cannot be PRE-granted from this machine -- but once the prompt is up a device tool can ' +
        `accept it (agent-device alert get, then agent-device alert accept, both --platform ios --udid ${udid}) -- and ` +
        `until it is granted nothing the app sends reaches ${target}.`,
    );
    push(
      'Check the phone is on the same network as this Mac -- the same Wi-Fi SSID, not cellular, not a VPN -- and that ' +
        'the network does not isolate clients from each other.',
    );
    push(
      'Check macOS is not blocking inbound connections: System Settings > Network > Firewall, or ' +
        '`/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`. The gate on this machine passes either way, ' +
        'because macOS routes a host connection to its own address over loopback.',
    );
    push(
      `If this Mac has several network interfaces, ${target} may not be the one the phone shares: set ios.lanHost in ` +
        '.stim.json to the address it can reach.',
    );
    // The app takes ip.txt when it has no dev-client scheme, which is what the
    // install path routes on -- an Expo project without expo-dev-client is a
    // bare app here even though its dev server is expo-child.
    if (devClient) {
      push(picker);
      if (url && udid) {
        push(
          `Retry the deep link: xcrun devicectl device process launch --device ${udid} --terminate-existing ` +
            `--payload-url '${url}' ${bundleId}`,
        );
      }
    } else {
      lines.push(
        'AND READ THIS: a Debug device build with no dev client carries the JS bundle baked in when the artifact was ' +
          'built, so an unreachable Metro is silent. The app on screen is not broken -- it is running THAT bundle, ' +
          "which on a cache hit is another workspace's JS, not this workspace's.",
      );
    }
    lines.push(`Then check \`stim logs --source metro\`${mode ? ` (${mode})` : ''} for a bundle request.`);
    return lines;
  }
  if (platform === 'ios') {
    push(picker);
    if (url && udid) {
      push(`Retry the deep link: xcrun simctl openurl ${udid} '${url}'`);
    } else if (udid && bundleId) {
      push(`Re-launch: xcrun simctl launch --console ${udid} ${bundleId}`);
    }
  } else {
    if (url && serial) {
      push(
        `Re-send the dev-client deep link -- this is the command that points the app at THIS workspace's Metro: adb -s ${serial} shell am start -a android.intent.action.VIEW -d '${url}' --ez ${ANDROID_DISABLE_AUTO_LAUNCH_EXTRA} true`,
      );
    }
    push(picker);
    if (serial && bundleId) {
      push(
        `Otherwise the reverse mapping was not in place when the app started. Re-launch: adb -s ${serial} shell monkey -p ${bundleId} 1`,
      );
    }
  }
  lines.push(`Then check \`stim logs --source metro\`${mode ? ` (${mode})` : ''} for a bundle request.`);
  return lines;
}
