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
import { getExecutor } from '../exec.js';

// logcat's priority letters, from `man logcat`: V(erbose) D(ebug) I(nfo)
// W(arn) E(rror) F(atal). A(ssert) appears in some builds as a synonym for
// fatal, and S(ilent) never actually prints a line but is accepted for
// completeness.
const LEVEL_BY_LETTER = {
  V: 'debug',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'fatal',
  A: 'fatal',
  S: 'debug',
};

export function levelFromLogcatLetter(letter) {
  return LEVEL_BY_LETTER[String(letter || '').toUpperCase()] ?? 'info';
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
export function parseLogcatTimestamp({ month, day, hour, minute, second, millis }, now = Date.now()) {
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
export function parseLogcatLine(line, { now = Date.now } = {}) {
  if (typeof line !== 'string') return null;
  const m = LOGCAT_TIME.exec(line.trimEnd());
  if (!m) return null;
  const [, month, day, hour, minute, second, millis, letter, tag, pid, msg] = m;
  if (!msg.trim()) return null;
  return {
    ts: parseLogcatTimestamp({
      month: Number(month), day: Number(day), hour: Number(hour),
      minute: Number(minute), second: Number(second), millis: Number(millis),
    }, now()),
    src: 'device',
    level: levelFromLogcatLetter(letter),
    msg,
    proc: `${tag.trim()}(${pid})`,
  };
}

// PURE. The exact argv, so a test can assert it without a device.
export function logcatArgs(serial, pid) {
  return ['-s', serial, 'logcat', '--pid', String(pid), '-v', 'time'];
}

// PURE. `pidof -s <pkg>` prints one pid and nothing else when the app is
// running, and nothing at all when it is not. Verified against a live
// emulator: `adb -s emulator-5554 shell pidof -s com.android.settings` ->
// "3132" (exit 0), and an unknown package prints nothing.
export function parsePidof(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0];
  const pid = Number(first);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function resolveAppPid(serial, packageName, { exec = null } = {}) {
  const e = exec || getExecutor();
  try {
    return parsePidof(e.runFile('adb', ['-s', serial, 'shell', 'pidof', '-s', packageName]));
  } catch {
    // `pidof` exits non-zero when it finds nothing on some images, which is
    // "not running yet", not an error.
    return null;
  }
}

// The app is launched immediately before the collector attaches, so the pid
// usually does not exist for the first second or two. Polling is the whole
// reason this is not a single call.
export async function waitForAppPid({ serial, packageName, timeoutMs = 30000, pollMs = 500, exec = null, now = Date.now, sleep = defaultSleep }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const pid = resolveAppPid(serial, packageName, { exec });
    if (pid) return { ok: true, pid };
    if (now() >= deadline) {
      return { failed: true, reason: `No process for ${packageName} appeared on ${serial} within ${Math.round(timeoutMs / 1000)}s.` };
    }
    await sleep(pollMs);
  }
}

function defaultSleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function startAndroidLogcat({ serial, pid, spawnFn = null }) {
  const spawn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  return spawn('adb', logcatArgs(serial, pid), {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
}
