import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import { parseNdjsonText, type NdjsonRecord } from '../ndjson.ts';

export const INSTALL_ERROR = 'STIM_CLI_INSTALL_FAILED';
export const LAUNCH_ERROR = 'STIM_CLI_LAUNCH_FAILED';

export const DEFAULT_METRO_PORT = 8081;

const IOS_SCHEME_APPROVAL_DOMAIN = 'com.apple.launchservices.schemeapproval';
const IOS_SCHEME_APPROVAL_OPENER = 'com.apple.CoreSimulator.CoreSimulatorBridge';

interface ExecOpt {
  exec?: Executor | null;
}

export type IosInstallResult = {
  ok?: boolean;
  appPath?: string;
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
  try {
    e.runFile('xcrun', ['simctl', 'install', udid, appPath]);
  } catch (err) {
    return { failed: true, code: INSTALL_ERROR, reason: `simctl install failed for ${appPath}: ${describe(err)}` };
  }
  if (bundleId && devClientScheme) {
    try {
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
        reason: `Installed ${bundleId}, but could not preapprove dev-client scheme ${devClientScheme}: ${describe(err)}`,
      };
    }
  }
  return { ok: true, appPath };
}

export function jsLocationValue(metroPort: number | string): string {
  return `localhost:${metroPort}`;
}

export function devClientUrl(scheme: string, metroPort: number | string, host = 'localhost'): string {
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(`http://${host}:${metroPort}`)}`;
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
  const install = () => {
    e.runFile('adb', ['-s', serial, 'install', '-r', apkPath]);
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
  { serial, metroPort }: { serial: string; metroPort: number | string },
  { exec = null }: ExecOpt = {},
): { ok?: boolean; reversed?: string[]; failed?: boolean; code?: string; reason?: string } {
  const e = exec || getExecutor();
  const pairs = [[DEFAULT_METRO_PORT, metroPort]];
  if (Number(metroPort) !== DEFAULT_METRO_PORT) pairs.push([metroPort, metroPort]);
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
  const tmp = `${prefs}.stim-cli.tmp`;
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
  { serial, packageName, metroPort }: { serial: string; packageName: string; metroPort: number | string },
  { exec = null }: ExecOpt = {},
): { ok: boolean; host?: string; reason?: string } {
  const e = exec || getExecutor();
  const host = `${EMULATOR_HOST_LOOPBACK}:${metroPort}`;
  const script = debugHttpHostScript({ packageName, host });
  try {
    e.runFile('adb', ['-s', serial, 'shell', 'run-as', packageName, 'sh', '-c', deviceShellArg(script)]);
    return { ok: true, host };
  } catch (err) {
    return { ok: false, reason: `debug_http_host not written (${describe(err)}); relying on adb reverse` };
  }
}

export function androidDevClientUrl(scheme: string, metroPort: number | string): string {
  return devClientUrl(scheme, metroPort, EMULATOR_HOST_LOOPBACK);
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
  }: { serial: string; packageName: string; metroPort: number | string; devClientScheme?: string | null },
  { exec = null }: ExecOpt = {},
): AndroidLaunchResult {
  const e = exec || getExecutor();
  const reversed = reverseMetroPorts({ serial, metroPort }, { exec: e });
  if (reversed.failed) return reversed;
  const prefs = writeDebugHttpHost({ serial, packageName, metroPort }, { exec: e });
  const wiring = {
    reversed: reversed.reversed,
    debugHttpHost: prefs.ok ? prefs.host : null,
    debugHttpHostNote: prefs.ok ? null : prefs.reason,
  };

  let devClientNote = null;
  if (devClientScheme) {
    const url = androidDevClientUrl(devClientScheme, metroPort);
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

const RELEASE_VERIFY_WAIT_MS = 3000;

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
      return { verified: true, record: proof, errors, processAlive: alive, mode, waitedMs };
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
  metroOrigin = null,
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
  metroOrigin?: string | null;
  // Explicit return type: isolatedDeclarations requires one at every module
  // boundary.
}): string[] {
  const seconds = Math.round(Number(waitedMs || 0) / 1000);
  const lines = [
    `The app was started, but nothing fetched a bundle from this workspace's Metro (port ${metroPort}) within ${seconds}s.`,
    'The app is launched; what is unproven is that it is talking to THIS dev server. Do this, in order:',
  ];
  const origin = metroOrigin || `http://localhost:${metroPort}`;
  const picker = `If expo-dev-launcher's DEVELOPMENT SERVERS picker is showing, tap the entry for ${origin} -- NOT another workspace's, which would load a different project's bundle onto this device.`;
  let step = 0;
  const push = (text: string) => lines.push(`  ${++step}. ${text}`);
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
        `Re-send the dev-client deep link -- this is the command that points the app at THIS workspace's Metro: adb -s ${serial} shell am start -a android.intent.action.VIEW -d '${url}'`,
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
