import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';

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
