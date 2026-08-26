// src/collector/android.js -- the Android device-log source: logcat, filtered
// to the app's own process, parsed into Contract-1 records.
//
// `adb -s <serial> logcat --pid <pid> -v time`
//
// --pid rather than a tag filter or a grep: an RN app logs under dozens of
// tags (ReactNative, ReactNativeJS, Hermes, plus every native module's own),
// so a tag list is always incomplete, while the process id is exactly "this
// app". It costs one resolution step, which is what resolveAppPid does.
//
// -v time is the format below. `threadtime` carries the tid as well, and
// `brief` carries no timestamp at all; `time` is the smallest format that
// still dates every line, and its layout has been stable for the whole life
// of logcat.
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { type Executor, getExecutor } from '../exec.ts';
import type { NdjsonRecord } from '../ndjson.ts';

// logcat's priority letters, from `man logcat`: V(erbose) D(ebug) I(nfo)
// W(arn) E(rror) F(atal). A(ssert) appears in some builds as a synonym for
// fatal, and S(ilent) never actually prints a line but is accepted for
// completeness.
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

// --- the demotion list ---------------------------------------------------
//
// The iOS side of this collector had to demote 3,004 records from a HEALTHY
// app (see the field note in collector/ios.js). Android did not produce
// anything of the sort, and the reason is structural: `--pid` filters to the
// app's own process, so the system daemons that make up the bulk of a device
// log never arrive. What still gets through is the system code running INSIDE
// the app process -- the emulator's graphics stack and the asset/zip loaders
// -- which logs at E on a launch that worked. Same treatment as iOS, a much
// shorter list, and the same rule: a tag not listed keeps its priority.
//
// Only E is demoted, never F. A fatal line inside an app process is libc
// reporting a signal or ART aborting, and there is no benign version of that.
export const NOISE_TAGS = new Set([
  // Emulator graphics: the goldfish/ranchu GLES and Vulkan bridge logs at E
  // for unimplemented entry points and for buffer metadata it does not know.
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
  // Loaders: ziparchive reports every optional entry it did not find in the
  // apk (`.dm`, per-abi libs) at E, on every cold start.
  'ziparchive',
  // logcat's own throttling notice ("uid=... expire N lines").
  'chatty',
]);

export function levelForLogcat(letter: string, tag: string): string {
  const level = levelFromLogcatLetter(letter);
  if (level !== 'error') return level;
  return NOISE_TAGS.has(String(tag || '').trim()) ? 'info' : level;
}

// `-v time` lines, captured verbatim from a live emulator (Android 16):
//   08-25 13:17:32.222 D/WifiNative(  658): Scan result ready event
//   08-25 13:17:34.441 I/bdee    ( 1670): (REDACTED) getHotwordActive...
// month-day, clock, priority letter, slash, tag (space padded), pid in
// parentheses (space padded), colon, message.
const LOGCAT_TIME = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+([A-Z])\/(.*?)\(\s*(\d+)\):\s?(.*)$/;

// PURE. logcat's `-v time` stamp carries no year, because the format predates
// anyone caring. The year is taken from the reference clock, and a line from
// December read in January is nudged back a year rather than landing eleven
// months in the future -- a record ahead of `now` sorts to the end of the
// merged timeline and would be the first thing `logs` shows.
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
  // A day of slack absorbs clock skew between host and device.
  if (ts - now > 24 * 60 * 60 * 1000) {
    ts = new Date(ref.getFullYear() - 1, month - 1, day, hour, minute, second, millis).getTime();
  }
  return ts;
}

// PURE. One logcat line -> a Contract-1 record, or null.
//
// Non-matching lines are skipped rather than recorded raw. logcat opens every
// buffer with a banner ("--------- beginning of main") and adb interleaves
// its own notices; neither is app output, and a log reader must never be the
// thing that dies on an unexpected line.
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

// PURE. The exact argv, so a test can assert it without a device.
export function logcatArgs(serial: string, pid: number | string): string[] {
  return ['-s', serial, 'logcat', '--pid', String(pid), '-v', 'time'];
}

// PURE. `pidof -s <pkg>` prints one pid and nothing else when the app is
// running, and nothing at all when it is not. Verified against a live
// emulator: `adb -s emulator-5554 shell pidof -s com.android.settings` ->
// "3132" (exit 0), and an unknown package prints nothing.
export function parsePidof(text: unknown): number | null {
  const first = String(text ?? '')
    .trim()
    .split(/\s+/)[0];
  const pid = Number(first);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function resolveAppPid(
  serial: string,
  packageName: string,
  { exec = null }: { exec?: Executor | null } = {},
): number | null {
  const e = exec || getExecutor();
  try {
    return parsePidof(e.runFile('adb', ['-s', serial, 'shell', 'pidof', '-s', packageName]));
  } catch {
    // `pidof` exits non-zero when it finds nothing on some images, which is
    // "not running yet", not an error.
    return null;
  }
}

// The result is a flat, all-optional bag rather than a union: callers check
// `.ok` and fall through to `.reason` on failure, which a flat shape makes a
// plain property read instead of a type-narrowing exercise.
export interface PidResolution {
  ok?: boolean;
  pid?: number;
  failed?: boolean;
  reason?: string;
}

// The app is launched immediately before the collector attaches, so the pid
// usually does not exist for the first second or two. Polling is the whole
// reason this is not a single call.
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

// --- surviving an app restart (the collector used to go silent here) -------
//
// `--pid` is what makes this stream "this app" rather than "this device", and
// it is also what pins it to ONE process. Restarting the app -- the single
// most common thing a developer does between two log reads -- gives it a new
// pid, and everything after that was collected for a process that no longer
// exists: `rn-iso logs --source device` simply stopped having lines, with
// nothing in the timeline saying why. (logcat itself does not fail here. It
// keeps running happily, filtering on a pid nothing will ever write under
// again, which is exactly why this cannot be left to the stream to notice.)
//
// So the pid is re-checked on a timer, unconditionally rather than only while
// the stream is quiet: a quiet stream is not a signal on Android, where a
// backgrounded app can be silent for minutes, and `pidof` is one adb call
// every few seconds.
export const PID_WATCH_MS = 3000;

// A test redirect, in the spirit of RN_ISO_HOME: the collector is spawned as
// a separate PROCESS in its own tests (see collector-run.test.js), so an
// injected interval cannot reach it and a suite must not wait out the real
// one.
export function pidWatchInterval(): number {
  const override = Number(process.env.RN_ISO_PID_WATCH_MS);
  return Number.isFinite(override) && override > 0 ? override : PID_WATCH_MS;
}

export interface PidWatcher {
  stop(): void;
  probe(): number | null;
  readonly pid: number | null;
}

// Polls `pidof -s <pkg>` and calls onChange(newPid) when the app comes back
// under a different one. A pid that has gone to NOTHING is not a change: the
// app being closed is not a restart, and the next poll that finds a pid is
// the restart. Stop() is mandatory -- an unstopped timer keeps the collector
// process alive after finish().
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
    } catch {
      // An adb hiccup is not a restart. The next tick asks again.
    }
    if (next && next !== current) {
      current = next;
      try {
        await onChange(next);
      } catch {
        // The reattach reports its own failures; a throw here must not stop
        // the watcher from trying again on the next tick.
      }
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
