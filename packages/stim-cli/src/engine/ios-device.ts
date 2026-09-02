import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import type { NdjsonRecord } from '../ndjson.ts';
import { INSTALL_ERROR } from './app-install.ts';

const DEVICECTL_TIMEOUT_MS = 30_000;

export interface IosDeviceEntry {
  udid: string;
  name: string;
  bootState: string | null;
  developerModeStatus: string | null;
  pairingState: string | null;
  transportType: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseDevicectlDevices(payload: unknown): IosDeviceEntry[] {
  let data: unknown = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  const devices = record(record(data).result).devices;
  if (!Array.isArray(devices)) return [];
  const out: IosDeviceEntry[] = [];
  for (const raw of devices) {
    const entry = record(raw);
    const hardware = record(entry.hardwareProperties);
    const properties = record(entry.deviceProperties);
    const connection = record(entry.connectionProperties);
    const udid = text(hardware.udid);
    if (!udid) continue;
    out.push({
      udid,
      name: text(properties.name) ?? udid,
      bootState: text(properties.bootState),
      developerModeStatus: text(properties.developerModeStatus),
      pairingState: text(connection.pairingState),
      transportType: text(connection.transportType),
    });
  }
  return out;
}

export function listIosDevices({ exec = null }: { exec?: Executor | null } = {}): IosDeviceEntry[] {
  const executor = exec || getExecutor();
  const dir = mkdtempSync(join(tmpdir(), 'stim-devicectl-'));
  const out = join(dir, 'devices.json');
  try {
    executor.runFile('xcrun', ['devicectl', 'list', 'devices', '-j', out], { timeoutMs: DEVICECTL_TIMEOUT_MS });
    return parseDevicectlDevices(readFileSync(out, 'utf-8'));
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ResolvedIosDevice {
  udid?: string;
  name?: string;
  error?: string;
  remedy?: string;
}

const DEVELOPER_MODE_REMEDY =
  'Turn on Settings > Privacy & Security > Developer Mode on the phone, restart it, then reconnect.';
const PAIRING_REMEDY = 'Unlock the phone, tap Trust on the pairing prompt, then reconnect the cable.';
const CABLE_REMEDY = 'Connect the phone with a cable and check `xcrun devicectl list devices`, then retry.';

// devicectl reports transportType 'wired' for a cabled device and 'localNetwork'
// for one it reached over Wi-Fi. v1 installs over the cable only, so a device
// paired only over the network is not a candidate.
const WIRED_TRANSPORTS = new Set(['wired', 'usb']);

function isWired(device: IosDeviceEntry): boolean {
  return device.transportType === null || WIRED_TRANSPORTS.has(device.transportType.toLowerCase());
}

function describe(device: IosDeviceEntry): string {
  return `${device.udid} (${device.name})`;
}

function wirelessRefusal(device: IosDeviceEntry): ResolvedIosDevice {
  return {
    error: `${describe(device)} is paired over ${device.transportType}, not a cable, and Stim installs over the cable only.`,
    remedy: CABLE_REMEDY,
  };
}

function unhealthy(device: IosDeviceEntry): ResolvedIosDevice | null {
  if (device.pairingState !== null && device.pairingState.toLowerCase() !== 'paired') {
    return {
      error: `${describe(device)} is connected but ${device.pairingState}, so devicectl cannot drive it.`,
      remedy: PAIRING_REMEDY,
    };
  }
  if (device.developerModeStatus !== null && device.developerModeStatus.toLowerCase() !== 'enabled') {
    return {
      error: `${describe(device)} has Developer Mode ${device.developerModeStatus}, so it will not run a development build.`,
      remedy: DEVELOPER_MODE_REMEDY,
    };
  }
  return null;
}

export function iosPoolCandidates(devices: readonly IosDeviceEntry[]): IosDeviceEntry[] {
  return (Array.isArray(devices) ? devices : []).filter((device) => isWired(device) && unhealthy(device) === null);
}

export function iosPoolNoCandidatesRefusal(devices: readonly IosDeviceEntry[]): ResolvedIosDevice {
  const listed = Array.isArray(devices) ? devices : [];
  const cabled = listed.filter(isWired);
  const problems = cabled.map((device) => unhealthy(device));
  if (cabled.length > 0 && problems.every((problem) => problem !== null)) {
    const reasons = problems as ResolvedIosDevice[];
    return {
      error: reasons.map((reason) => reason.error!).join(' '),
      remedy: [...new Set(reasons.map((reason) => reason.remedy!))].join(' '),
    };
  }
  return resolveIosPhysicalDevice(null, listed);
}

export function resolveIosPhysicalDevice(requested: string | null, devices: IosDeviceEntry[]): ResolvedIosDevice {
  const listed = Array.isArray(devices) ? devices : [];
  const cabled = listed.filter(isWired);
  const wireless = listed.filter((d) => !isWired(d));
  if (requested) {
    const match = cabled.find((d) => d.udid.toLowerCase() === requested.toLowerCase());
    if (match) return unhealthy(match) ?? { udid: match.udid, name: match.name };
    const overNetwork = wireless.find((d) => d.udid.toLowerCase() === requested.toLowerCase());
    if (overNetwork) return wirelessRefusal(overNetwork);
    return {
      error: cabled.length
        ? `${requested} is not connected. devicectl reports these cabled devices: ${cabled.map(describe).join(', ')}.`
        : `${requested} is not connected by cable, and devicectl reports no cabled device at all.`,
      remedy: 'Check the cable and `xcrun devicectl list devices`, then retry with a UDID it lists.',
    };
  }
  if (cabled.length === 1) {
    const only = cabled[0]!;
    return unhealthy(only) ?? { udid: only.udid, name: only.name };
  }
  if (cabled.length > 1) {
    return {
      error: `Several devices are connected: ${cabled.map(describe).join(', ')}.`,
      remedy: 'Name the one to build for with `stim ios --device <udid>`.',
    };
  }
  const onlyWireless = wireless[0];
  if (onlyWireless) return wirelessRefusal(onlyWireless);
  return {
    error: 'No physical iOS device is connected.',
    remedy:
      'Plug the phone in, unlock it, tap Trust, turn on Settings > Privacy & Security > Developer Mode, then check `xcrun devicectl list devices`.',
  };
}

export const DEVICECTL_INSTALL_TIMEOUT_MS = 300_000;

const LOCKED_REMEDY = 'Unlock the phone and keep it awake, then run the command again.';

function errorText(error: unknown): string {
  const withOutput = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = String(withOutput?.stderr ?? '').trim();
  const stdout = String(withOutput?.stdout ?? '').trim();
  const message = String(withOutput?.message ?? error).trim();
  return [message, stderr, stdout].filter(Boolean).join('\n');
}

export type IosInstallFailureKind = 'signer' | 'locked' | 'untrusted-host' | 'developer-mode' | 'storage' | null;

export function iosInstallFailureKind(output: unknown): IosInstallFailureKind {
  const out = String(output ?? '');
  if (/MismatchedApplicationIdentifierEntitlement|application-identifier entitlement[^\n]*does not match/i.test(out)) {
    return 'signer';
  }
  if (/device is locked|is locked\b|passcode/i.test(out)) return 'locked';
  if (/not paired|pairing|trust this computer|untrusted host/i.test(out)) return 'untrusted-host';
  if (/developer mode/i.test(out)) return 'developer-mode';
  if (/not enough (?:free )?(?:disk )?space|insufficient (?:disk )?space|storage is full/i.test(out)) return 'storage';
  return null;
}

export function iosInstallRemedy(
  kind: IosInstallFailureKind,
  { udid, bundleId }: { udid: string; bundleId: string | null },
): string {
  switch (kind) {
    case 'signer':
      return `${bundleId ?? 'The app'} is already installed on ${udid} under a different team, and Stim could not remove it. Delete the app on the phone (its data goes with it), then run the command again.`;
    case 'locked':
      return LOCKED_REMEDY;
    case 'untrusted-host':
      return 'Unlock the phone, tap Trust on the pairing prompt, then run the command again.';
    case 'developer-mode':
      return 'Turn on Settings > Privacy & Security > Developer Mode on the phone, restart it, then run the command again.';
    case 'storage':
      return 'Free space on the phone (Settings > General > iPhone Storage), then run the command again.';
    default:
      return `Check that ${udid} is still connected and unlocked (\`xcrun devicectl list devices\`), and that the app was built for the iphoneos SDK.`;
  }
}

export interface IosDeviceInstallResult {
  ok?: boolean;
  appPath?: string;
  uninstalled?: boolean;
  note?: string;
  failed?: boolean;
  code?: string;
  reason?: string;
  remedy?: string;
}

export function installIosDeviceApp(
  { udid, appPath, bundleId = null }: { udid: string; appPath: string; bundleId?: string | null },
  { exec = null }: { exec?: Executor | null } = {},
): IosDeviceInstallResult {
  const e = exec || getExecutor();
  const install = () => {
    e.runFile('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, appPath], {
      timeoutMs: DEVICECTL_INSTALL_TIMEOUT_MS,
    });
  };
  try {
    install();
    return { ok: true, appPath };
  } catch (err) {
    const failure = errorText(err);
    const kind = iosInstallFailureKind(failure);
    if (kind !== 'signer' || !bundleId) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason: `devicectl could not install ${appPath} on ${udid}: ${failure}`,
        remedy: iosInstallRemedy(kind, { udid, bundleId }),
      };
    }
    try {
      e.runFile('xcrun', ['devicectl', 'device', 'uninstall', 'app', '--device', udid, bundleId], {
        timeoutMs: DEVICECTL_INSTALL_TIMEOUT_MS,
      });
    } catch (uninstallErr) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason:
          `devicectl refused to install ${appPath} over the copy of ${bundleId} already on ${udid}, ` +
          `which a different team signed, and the uninstall failed too: ${errorText(uninstallErr)}`,
        remedy: iosInstallRemedy('signer', { udid, bundleId }),
      };
    }
    try {
      install();
    } catch (retryErr) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason: `devicectl could not install ${appPath} on ${udid} even after uninstalling ${bundleId}: ${errorText(retryErr)}`,
        remedy: iosInstallRemedy(null, { udid, bundleId }),
      };
    }
    return {
      ok: true,
      appPath,
      uninstalled: true,
      note:
        `${bundleId} was already installed on ${udid} under a different team, so it was uninstalled (its data went ` +
        "with it) before this app could be installed. An uninstall also clears the phone's developer trust and its " +
        'Local Network permission, so the launch below may need Settings > General > VPN & Device Management again',
    };
  }
}

export interface IosDeviceProcess {
  pid: number;
  executable: string;
}

export function parseDeviceProcesses(payload: unknown): IosDeviceProcess[] {
  let data: unknown = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  const running = record(record(data).result).runningProcesses;
  if (!Array.isArray(running)) return [];
  const out: IosDeviceProcess[] = [];
  for (const raw of running) {
    const entry = record(raw);
    const pid = Number(entry.processIdentifier);
    const executable = text(entry.executable);
    if (!Number.isInteger(pid) || pid <= 0 || !executable) continue;
    out.push({ pid, executable });
  }
  return out;
}

export function deviceProcessPid(processes: readonly IosDeviceProcess[], appName: string): number | null {
  const marker = `/${appName}.app/`;
  for (const entry of processes) {
    if (entry.executable.includes(marker)) return entry.pid;
  }
  return null;
}

export function iosDeviceProcess(
  { udid, appName }: { udid: string; appName: string },
  { exec = null }: { exec?: Executor | null } = {},
): number | null | undefined {
  const executor = exec || getExecutor();
  const dir = mkdtempSync(join(tmpdir(), 'stim-devicectl-'));
  const out = join(dir, 'processes.json');
  try {
    executor.runFile(
      'xcrun',
      ['devicectl', 'device', 'info', 'processes', '--device', udid, '--quiet', '--json-output', out],
      {
        timeoutMs: DEVICECTL_TIMEOUT_MS,
      },
    );
    return deviceProcessPid(parseDeviceProcesses(readFileSync(out, 'utf-8')), appName);
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type IosLaunchRefusalKind = 'untrusted-developer' | 'locked' | 'not-installed' | null;

// Each pattern matches within ONE line of devicectl's output: the domain, the
// code and the reason are printed on separate lines of the same error block, so
// testing them against the joined text would let a code from one line pair with
// a reason from another. The shapes are
// __tests__/fixtures/ios-device/launch-untrusted-developer.txt.
const LAUNCH_REFUSALS: Array<[IosLaunchRefusalKind, RegExp]> = [
  ['untrusted-developer', /profile has not been explicitly trusted by the user/i],
  ['untrusted-developer', /FBSOpenApplicationErrorDomain error 3\b/],
  ['untrusted-developer', /denied by service delegate[^\n]*for reason: Security/],
  ['locked', /device is locked|is locked\b|passcode/i],
  ['not-installed', /(?:application|app)[^\n]*\b(?:is )?(?:unknown to FrontBoard|not installed)/i],
];

export function iosLaunchRefusalKind(output: unknown): IosLaunchRefusalKind {
  for (const line of String(output ?? '').split(/\r?\n/)) {
    for (const [kind, pattern] of LAUNCH_REFUSALS) {
      if (pattern.test(line)) return kind;
    }
  }
  return null;
}

export function iosLaunchRemedy(
  kind: IosLaunchRefusalKind,
  { udid, bundleId }: { udid: string; bundleId: string },
): string {
  switch (kind) {
    case 'untrusted-developer':
      return (
        "The phone has not trusted this build's developer certificate, which it refuses to do without a human. " +
        'On the phone open Settings > General > VPN & Device Management, tap the developer profile under DEVELOPER APP, ' +
        'tap Trust, then run the command again.'
      );
    case 'locked':
      return LOCKED_REMEDY;
    case 'not-installed':
      return `${bundleId} is not installed on ${udid} any more. Run the command again to install it.`;
    default:
      return `Run \`xcrun devicectl device process launch --console --device ${udid} ${bundleId}\` to see what the phone reports.`;
  }
}

export interface IosDeviceLaunchResult {
  pid?: number | null;
  failed?: boolean;
  reason?: string;
  remedy?: string;
  lines?: string[];
}

export const LAUNCH_PROBE_TIMEOUT_MS = 45_000;
const LAUNCH_PROBE_POLL_MS = 1000;
const COLLECTOR_ENDED_EVENTS = new Set(['collector_failed', 'collector_stopped']);

function launchEvidence(records: readonly NdjsonRecord[]): string[] {
  const lines: string[] = [];
  for (const entry of records) {
    const msg = typeof entry.msg === 'string' ? entry.msg.trim() : '';
    if (!msg) continue;
    if (entry.event === 'collector_started' || entry.event === 'collector_empty') continue;
    lines.push(msg);
  }
  return lines.slice(-6);
}

export function collectorRecordsFor(records: readonly NdjsonRecord[], collectorPid: number | null): NdjsonRecord[] {
  if (!collectorPid) return [];
  const marker = new RegExp(`\\bcollector pid ${collectorPid}\\b`);
  const start = records.findIndex(
    (entry) => entry.event === 'collector_started' && typeof entry.msg === 'string' && marker.test(entry.msg),
  );
  return start < 0 ? [] : records.slice(start);
}

export async function awaitIosDeviceLaunch({
  udid,
  bundleId,
  appName,
  collectorPid = null,
  readRecords,
  probe,
  timeoutMs = LAUNCH_PROBE_TIMEOUT_MS,
  pollMs = LAUNCH_PROBE_POLL_MS,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  udid: string;
  bundleId: string;
  appName: string;
  collectorPid?: number | null;
  readRecords: () => NdjsonRecord[];
  probe?: () => number | null | undefined;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<IosDeviceLaunchResult> {
  const probeProcess = probe ?? (() => iosDeviceProcess({ udid, appName }));
  const deadline = now() + Math.max(0, timeoutMs);
  for (;;) {
    const records = collectorRecordsFor(readRecords(), collectorPid);
    const ended = records.find((entry) => typeof entry.event === 'string' && COLLECTOR_ENDED_EVENTS.has(entry.event));
    const pid = probeProcess();
    if (typeof pid === 'number') return { pid };
    if (ended) {
      const lines = launchEvidence(records);
      const kind = iosLaunchRefusalKind(lines.join('\n'));
      return {
        failed: true,
        reason: `devicectl could not keep ${bundleId} running on ${udid}: the console ended before the app appeared in the device's process list.`,
        remedy: iosLaunchRemedy(kind, { udid, bundleId }),
        lines,
      };
    }
    if (now() >= deadline) {
      const lines = launchEvidence(records);
      return {
        failed: true,
        reason: `${bundleId} did not appear in ${udid}'s process list within ${Math.round(timeoutMs / 1000)}s of the launch.`,
        remedy: iosLaunchRemedy(iosLaunchRefusalKind(lines.join('\n')), { udid, bundleId }),
        lines,
      };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

export interface IosDeviceReleaseVerification {
  verified: boolean;
  reason?: 'exited' | 'probe-failed';
  waitedMs: number;
  pid?: number | null;
}

// Invariant 11: a device pid is meaningless to `process.kill` on the host, so a
// release launch is proven by re-probing the phone's own process list.
export async function verifyIosDeviceReleaseLaunch({
  udid,
  appName,
  waitMs = 3000,
  probe,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  udid: string;
  appName: string;
  waitMs?: number;
  probe?: () => number | null | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<IosDeviceReleaseVerification> {
  const probeProcess = probe ?? (() => iosDeviceProcess({ udid, appName }));
  const startedAt = now();
  await sleep(Math.max(0, waitMs));
  const pid = probeProcess();
  const waitedMs = now() - startedAt;
  if (pid === undefined) return { verified: false, reason: 'probe-failed', waitedMs };
  return pid === null ? { verified: false, reason: 'exited', waitedMs, pid: null } : { verified: true, waitedMs, pid };
}

// CFNetwork's errno-50 shapes -- `failed to connect 1:50`, `error(1:50)`,
// `Code=-1009` with `_kCFStreamErrorCodeKey=50` -- are generic ENETDOWN and are
// also what Wi-Fi being off or a cellular-only route produce. Only the NWPath
// reason names the permission, so only it is matched: iOS reports every LAN
// connection an ungranted app makes as unsatisfied (Local network prohibited),
// and it reads the same whether the prompt is unanswered or was denied. The
// sibling reasons that must NOT match are (No network route) and (Denied over
// cellular interface). Captured shapes:
// __tests__/fixtures/ios-device/local-network-pending.txt.
const LOCAL_NETWORK_PROHIBITED = /_NSURLErrorNWPathKey=unsatisfied \(Local network prohibited\)/;

export function localNetworkPending(
  records: readonly NdjsonRecord[],
  { since = 0, pid = null, lanOrigin }: { since?: number; pid?: number | null; lanOrigin: string | null },
): boolean {
  if (!lanOrigin) return false;
  const fromApp = pid ? new RegExp(`\\(${pid}\\)$`) : null;
  for (const entry of records) {
    if (Number(entry.ts) < since) continue;
    if (fromApp && !(typeof entry.proc === 'string' && fromApp.test(entry.proc))) continue;
    if (LOCAL_NETWORK_PROHIBITED.test(typeof entry.msg === 'string' ? entry.msg : '')) return true;
  }
  return false;
}
