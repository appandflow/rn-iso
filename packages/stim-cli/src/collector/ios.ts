import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { getExecutor } from '../exec.ts';
import type { NdjsonRecord } from '../ndjson.ts';

const MESSAGE_TYPE_LEVEL: Record<string, string> = {
  Debug: 'debug',
  Info: 'info',
  Default: 'info',
  Error: 'error',
  Fault: 'fatal',
};

export function levelFromMessageType(messageType: unknown): string {
  return MESSAGE_TYPE_LEVEL[messageType as string] ?? 'info';
}

export const NOISE_RULES: NoiseRule[] = [
  { id: 'network', subsystem: 'com.apple.network' },
  {
    id: 'network-default-subsystem',
    messagePrefix: [
      'nw_socket',
      'nw_connection',
      'nw_protocol',
      'nw_endpoint',
      'nw_path',
      'nw_resolver',
      'nw_flow',
      'nw_read_request',
      'nw_write_request',
      'tcp_input',
    ],
  },
  { id: 'sectrust', subsystem: 'com.apple.securityd' },
  { id: 'sectrust-default-subsystem', messagePrefix: ['SecTrust', 'SecOSStatus', 'TrustResultType'] },
  { id: 'webkit', subsystem: 'com.apple.WebKit' },
  { id: 'webkit-default-subsystem', messagePrefix: ['WebPrivacy', 'GPUProcessProxy', 'WebProcessProxy'] },
  { id: 'audio-factory', messageIncludes: ['AddInstanceForFactory'] },
  { id: 'coreui', subsystem: 'com.apple.coreui' },
  { id: 'coreui-default-subsystem', messagePrefix: ['CUICatalog:', 'CoreUI:', 'CoreThemeDefinition'] },
  {
    id: 'uiscene-deprecation',
    messageIncludes: [
      'UIScene lifecycle will soon be required',
      'must migrate to UIScene',
      'migrate to UIScene lifecycle',
    ],
  },
];

interface NoiseRule {
  id: string;
  subsystem?: string;
  category?: string;
  messagePrefix?: string[];
  messageIncludes?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogStreamEvent = any;

function ruleMatches(
  rule: NoiseRule,
  { subsystem, category, message }: { subsystem: string; category: string; message: string },
): boolean {
  if (rule.subsystem && subsystem !== rule.subsystem && !subsystem.startsWith(`${rule.subsystem}.`)) return false;
  if (rule.category && category !== rule.category) return false;
  if (rule.messagePrefix && !rule.messagePrefix.some((p) => message.startsWith(p))) return false;
  if (rule.messageIncludes && !rule.messageIncludes.some((p) => message.includes(p))) return false;
  return true;
}

export function noiseRuleId(event: LogStreamEvent): string | null {
  const subsystem = typeof event?.subsystem === 'string' ? event.subsystem : '';
  const category = typeof event?.category === 'string' ? event.category : '';
  const message = typeof event?.eventMessage === 'string' ? event.eventMessage : '';
  for (const rule of NOISE_RULES) {
    if (ruleMatches(rule, { subsystem, category, message })) return rule.id;
  }
  return null;
}

export function levelForEvent(event: LogStreamEvent): string {
  const level = levelFromMessageType(event?.messageType);
  if (level !== 'error' && level !== 'fatal') return level;
  return noiseRuleId(event) ? 'info' : level;
}

export function procFromImagePath(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  const parts = path.split('/');
  return parts[parts.length - 1] || null;
}

function tsFromEvent(event: LogStreamEvent, now: () => number = Date.now): number {
  const parsed = Date.parse(event?.timestamp);
  return Number.isFinite(parsed) ? parsed : now();
}

function recordFromLogEvent(
  event: LogStreamEvent,
  { now = Date.now }: { now?: () => number } = {},
): NdjsonRecord | null {
  if (!event || typeof event !== 'object') return null;
  const eventType = event.eventType;
  if (eventType && eventType !== 'logEvent') return null;
  const msg = typeof event.eventMessage === 'string' ? event.eventMessage : '';
  if (!msg.trim()) return null;
  const record: NdjsonRecord = {
    ts: tsFromEvent(event, now),
    src: 'device',
    level: levelForEvent(event),
    msg,
  };
  const proc = procFromImagePath(event.processImagePath);
  if (proc) record.proc = proc;
  return record;
}

export function parseLogStreamLine(line: string, { now = Date.now }: { now?: () => number } = {}): NdjsonRecord | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  let event: LogStreamEvent;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return recordFromLogEvent(event, { now });
}

export function logStreamArgs(udid: string, appName: string): string[] {
  return [
    'simctl',
    'spawn',
    udid,
    'log',
    'stream',
    '--style',
    'ndjson',
    '--predicate',
    `processImagePath CONTAINS[c] "${appName}"`,
  ];
}

export function appNameFromBundleId(bundleId: string | null | undefined): string {
  const parts = String(bundleId || '').split('.');
  return parts[parts.length - 1] || String(bundleId || '');
}

export function startIosLogStream({
  udid,
  appName,
  spawnFn = null,
}: {
  udid: string;
  appName: string;
  spawnFn?: ((cmd: string, args: string[], opts: SpawnOptions) => ChildProcess) | null;
}): ChildProcess {
  const spawn = spawnFn || ((cmd: string, args: string[], opts: SpawnOptions) => getExecutor().spawn(cmd, args, opts));
  return spawn('xcrun', logStreamArgs(udid, appName), {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
}
