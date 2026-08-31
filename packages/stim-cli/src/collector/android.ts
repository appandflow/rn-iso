import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { type Executor, getExecutor } from '../exec.ts';
import type { NdjsonRecord } from '../ndjson.ts';

const LEVEL_BY_LETTER: Record<string, string> = {
  V: 'debug',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'fatal',
  A: 'fatal',
  S: 'debug',
};

export function levelFromLogcatLetter(letter: string): string {
  return LEVEL_BY_LETTER[String(letter || '').toUpperCase()] ?? 'info';
}

export const NOISE_TAGS: Set<string> = new Set([
  'libEGL',
  'EGL_emulation',
  'eglCodecCommon',
  'emuglGLESv2_enc',
  'HostConnection',
  'OpenGLRenderer',
  'gralloc4',
  'Gralloc4',
  'vulkan',
  'GraphicBufferAllocator',
  'BufferQueueProducer',
  'Surface',
  'ziparchive',
  'chatty',
]);

export function levelForLogcat(letter: string, tag: string): string {
  const level = levelFromLogcatLetter(letter);
  if (level !== 'error') return level;
  return NOISE_TAGS.has(String(tag || '').trim()) ? 'info' : level;
}

const LOGCAT_TIME = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+([A-Z])\/(.*?)\(\s*(\d+)\):\s?(.*)$/;

export function parseLogcatTimestamp(
  {
    month,
    day,
    hour,
    minute,
    second,
    millis,
  }: { month: number; day: number; hour: number; minute: number; second: number; millis: number },
  now: number = Date.now(),
): number {
  const ref = new Date(now);
  let ts = new Date(ref.getFullYear(), month - 1, day, hour, minute, second, millis).getTime();
  if (ts - now > 24 * 60 * 60 * 1000) {
    ts = new Date(ref.getFullYear() - 1, month - 1, day, hour, minute, second, millis).getTime();
  }
  return ts;
}

export function parseLogcatLine(line: string, { now = Date.now }: { now?: () => number } = {}): NdjsonRecord | null {
  if (typeof line !== 'string') return null;
  const m = LOGCAT_TIME.exec(line.trimEnd());
  if (!m) return null;
  const [, month, day, hour, minute, second, millis, letter, tag, pid, msg] = m;
  if (letter === undefined || tag === undefined || msg === undefined) return null;
  if (!msg.trim()) return null;
  return {
    ts: parseLogcatTimestamp(
      {
        month: Number(month),
        day: Number(day),
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second),
        millis: Number(millis),
      },
      now(),
    ),
    src: 'device',
    level: levelForLogcat(letter, tag),
    msg,
    proc: `${tag.trim()}(${pid})`,
  };
}

export function logcatArgs(serial: string, pid: number | string): string[] {
  return ['-s', serial, 'logcat', '--pid', String(pid), '-v', 'time'];
}

export function parsePidof(text: unknown): number | null {
  const first = String(text ?? '')
    .trim()
    .split(/\s+/)[0];
  const pid = Number(first);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function resolveAppPid(
  serial: string,
  packageName: string,
  { exec = null }: { exec?: Executor | null } = {},
): number | null {
  const e = exec || getExecutor();
  try {
    return parsePidof(e.runFile('adb', ['-s', serial, 'shell', 'pidof', '-s', packageName]));
  } catch {
    return null;
  }
}

export interface PidResolution {
  ok?: boolean;
  pid?: number;
  failed?: boolean;
  reason?: string;
}

export async function waitForAppPid({
  serial,
  packageName,
  timeoutMs = 30000,
  pollMs = 500,
  exec = null,
  now = Date.now,
  sleep = defaultSleep,
}: {
  serial: string;
  packageName: string;
  timeoutMs?: number;
  pollMs?: number;
  exec?: Executor | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PidResolution> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const pid = resolveAppPid(serial, packageName, { exec });
    if (pid) return { ok: true, pid };
    if (now() >= deadline) {
      return {
        failed: true,
        reason: `No process for ${packageName} appeared on ${serial} within ${Math.round(timeoutMs / 1000)}s.`,
      };
    }
    await sleep(pollMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export function startAndroidLogcat({
  serial,
  pid,
  spawnFn = null,
}: {
  serial: string;
  pid: number | string;
  spawnFn?: ((cmd: string, args: string[], opts: SpawnOptions) => ChildProcess) | null;
}): ChildProcess {
  const spawn = spawnFn || ((cmd: string, args: string[], opts: SpawnOptions) => getExecutor().spawn(cmd, args, opts));
  return spawn('adb', logcatArgs(serial, pid), {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
}

const PID_WATCH_MS = 3000;

export function pidWatchInterval(): number {
  const override = Number(process.env.STIM_PID_WATCH_MS);
  return Number.isFinite(override) && override > 0 ? override : PID_WATCH_MS;
}

export interface PidWatcher {
  stop(): void;
  probe(): number | null;
  readonly pid: number | null;
}

export function watchAppPid({
  serial,
  packageName,
  pid,
  intervalMs = null,
  exec = null,
  onChange,
  resolve = resolveAppPid,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  serial: string;
  packageName: string;
  pid: number | null;
  intervalMs?: number | null;
  exec?: Executor | null;
  onChange: (nextPid: number) => void | Promise<void>;
  resolve?: (serial: string, packageName: string, opts: { exec?: Executor | null }) => number | null;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}): PidWatcher {
  const every = intervalMs ?? pidWatchInterval();
  let current = pid;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    timer = null;
    if (stopped) return;
    let next: number | null = null;
    try {
      next = resolve(serial, packageName, { exec });
    } catch {}
    if (next && next !== current) {
      current = next;
      try {
        await onChange(next);
      } catch {}
    }
    if (!stopped) timer = setTimer(tick, every);
  };
  timer = setTimer(tick, every);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    probe() {
      try {
        return resolve(serial, packageName, { exec });
      } catch {
        return null;
      }
    },
    get pid() {
      return current;
    },
  };
}
