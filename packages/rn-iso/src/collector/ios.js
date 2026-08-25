// src/collector/ios.js -- the iOS device-log source: Apple's unified log,
// filtered to the app's process, parsed into Contract-1 records.
//
// `xcrun simctl spawn <udid> log stream --style ndjson --predicate
//  'processImagePath CONTAINS[c] "<appName>"'`
//
// --style ndjson rather than the default compact style because the compact
// style is a human's column layout that changes between OS releases, while
// ndjson is one JSON object per line with named fields. Filtering happens in
// the DEVICE, via the predicate, so the stream carries the app's output
// instead of the whole system's -- a simulator emits thousands of lines a
// minute otherwise, and the log file would be mostly other people's daemons.
//
// The predicate matches processImagePath and not subsystem/bundle id: NSLog
// and every RN native log go to the default subsystem (com.apple.*), so a
// subsystem predicate misses exactly the lines an RN developer wants. The
// image path ends in <AppName>.app/<AppName>, so a CONTAINS[c] on the app
// name catches them all.
import { getExecutor } from '../exec.js';

// Apple's messageType values, from `man log` ("default", "info", "debug",
// "error", "fault"), as they appear capitalized in the ndjson style. There is
// no warning level in the unified log at all -- warn in Contract 1 is
// therefore unreachable from this source, which is correct rather than a gap:
// inventing one by pattern-matching the message text would misclassify.
const MESSAGE_TYPE_LEVEL = {
  Debug: 'debug',
  Info: 'info',
  Default: 'info',
  Error: 'error',
  Fault: 'fatal',
};

export function levelFromMessageType(messageType) {
  return MESSAGE_TYPE_LEVEL[messageType] ?? 'info';
}

// PURE. `log stream` writes the process image path with the executable last:
//   .../RuntimeRoot/usr/libexec/backboardd
//   .../Containers/Bundle/Application/<uuid>/MyApp.app/MyApp
// The executable name is the useful identity in a log line.
export function procFromImagePath(path) {
  if (typeof path !== 'string' || !path) return null;
  const parts = path.split('/');
  return parts[parts.length - 1] || null;
}

// PURE. Apple's timestamp is "2026-08-25 13:18:05.196749-0400" -- a space
// separator and six fractional digits, which V8's Date accepts as-is.
export function tsFromEvent(event, now = Date.now) {
  const parsed = Date.parse(event?.timestamp);
  return Number.isFinite(parsed) ? parsed : now();
}

// PURE. One parsed ndjson event -> a Contract-1 record, or null to skip.
//
// Only logEvent becomes a record. `log stream` also emits activityCreateEvent
// / activityTransitionEvent / timesyncEvent, which are tracing scaffolding
// with no messageType: they carry an eventMessage ("Incoming Connection") but
// no level, and in a real capture they are a third of the volume. Dropping
// them keeps device.ndjson to what the app actually logged.
export function recordFromLogEvent(event, { now = Date.now } = {}) {
  if (!event || typeof event !== 'object') return null;
  const eventType = event.eventType;
  if (eventType && eventType !== 'logEvent') return null;
  const msg = typeof event.eventMessage === 'string' ? event.eventMessage : '';
  if (!msg.trim()) return null;
  const record = {
    ts: tsFromEvent(event, now),
    src: 'device',
    level: levelFromMessageType(event.messageType),
    msg,
  };
  const proc = procFromImagePath(event.processImagePath);
  if (proc) record.proc = proc;
  return record;
}

// PURE. One raw stream line -> a record, or null.
//
// The first line `log stream` writes is not JSON at all: a live capture from
// a booted sim opens with
//   Filtering the log data using "processImagePath CONTAINS[c] "MyApp""
// and a JSON.parse of it would throw. Anything unparseable is skipped for the
// same reason ndjson.js skips a corrupt record: a log reader must never be
// the thing that dies.
export function parseLogStreamLine(line, { now = Date.now } = {}) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return recordFromLogEvent(event, { now });
}

// PURE. The exact argv, so a test can assert it without a device.
export function logStreamArgs(udid, appName) {
  return [
    'simctl', 'spawn', udid,
    'log', 'stream',
    '--style', 'ndjson',
    '--predicate', `processImagePath CONTAINS[c] "${appName}"`,
  ];
}

// PURE. The app name to predicate on when the caller only knows a bundle id.
// An RN app's product name is normally the last bundle-id segment, and the
// caller (which has the .app path) should pass the real one; this is the
// fallback, not the rule.
export function appNameFromBundleId(bundleId) {
  const parts = String(bundleId || '').split('.');
  return parts[parts.length - 1] || String(bundleId || '');
}

export function startIosLogStream({ udid, appName, spawnFn = null }) {
  const spawn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  return spawn('xcrun', logStreamArgs(udid, appName), {
    stdio: ['ignore', 'pipe', 'pipe'],
    // NOT detached: the stream dies with the collector that owns it. An
    // orphaned `log stream` writes to a closed pipe forever.
    detached: false,
  });
}
