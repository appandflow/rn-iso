import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { getExecutor } from '../exec.ts';
import type { NdjsonRecord } from '../ndjson.ts';

// os_log only reaches a process's stderr when OS_ACTIVITY_DT_MODE is set in its
// environment; without it `devicectl --console` carries plain stdout/stderr
// writes alone, and React Native logs through os_log (React/Base/RCTLog.mm).
export const CONSOLE_ENV: Record<string, string> = { OS_ACTIVITY_DT_MODE: 'enable' };

export const FATAL_MARKERS: string[] = [
  '*** Terminating app due to uncaught exception',
  'libc++abi: terminating',
  '*** Assertion failure in',
  'Fatal error: ',
];

const MIRROR_LINE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+[+-]\d{4}) (\S+)\[(\d+):(\d+)\] ?(?:\[([^\]\s]+)\] )?([\s\S]*)$/;

export function deviceConsoleLevel(message: unknown): string {
  const text = typeof message === 'string' ? message : '';
  if (FATAL_MARKERS.some((marker) => text.includes(marker))) return 'fatal';
  return text.startsWith('ERROR: ') ? 'error' : 'info';
}

export function parseDeviceConsoleLine(
  line: string,
  { now = Date.now }: { now?: () => number } = {},
): NdjsonRecord | null {
  if (typeof line !== 'string') return null;
  const text = line.replace(/\r$/, '').trimEnd();
  if (!text.trim()) return null;

  const match = MIRROR_LINE.exec(text);
  const record: NdjsonRecord = {
    ts: now(),
    src: 'device',
    level: 'info',
    msg: text,
    raw: true,
  };
  if (!match) {
    record.level = deviceConsoleLevel(text);
    return record;
  }

  const [, timestamp, proc, pid, , category, message] = match;
  if (message === undefined || !message.trim()) return null;
  const parsed = Date.parse(timestamp as string);
  if (Number.isFinite(parsed)) record.ts = parsed;
  record.msg = message;
  record.level = deviceConsoleLevel(message);
  record.proc = `${proc}(${pid})`;
  if (category) record.category = category;
  return record;
}

export function deviceConsoleArgs({
  udid,
  bundleId,
  payloadUrl = null,
}: {
  udid: string;
  bundleId: string;
  payloadUrl?: string | null;
}): string[] {
  const args = [
    'devicectl',
    'device',
    'process',
    'launch',
    '--quiet',
    '--device',
    udid,
    '--console',
    '--terminate-existing',
    '--environment-variables',
    JSON.stringify(CONSOLE_ENV),
  ];
  if (payloadUrl) args.push('--payload-url', payloadUrl);
  args.push(bundleId);
  return args;
}

export function startIosDeviceConsole({
  udid,
  bundleId,
  payloadUrl = null,
  spawnFn = null,
}: {
  udid: string;
  bundleId: string;
  payloadUrl?: string | null;
  spawnFn?: ((cmd: string, args: string[], opts: SpawnOptions) => ChildProcess) | null;
}): ChildProcess {
  const spawn = spawnFn || ((cmd: string, args: string[], opts: SpawnOptions) => getExecutor().spawn(cmd, args, opts));
  return spawn('xcrun', deviceConsoleArgs({ udid, bundleId, payloadUrl }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
}
