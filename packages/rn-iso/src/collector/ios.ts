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
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { getExecutor } from '../exec.ts';
import type { NdjsonRecord } from '../ndjson.ts';

// Apple's messageType values, from `man log` ("default", "info", "debug",
// "error", "fault"), as they appear capitalized in the ndjson style. There is
// no warning level in the unified log at all -- warn in Contract 1 is
// therefore unreachable from this source, which is correct rather than a gap:
// inventing one by pattern-matching the message text would misclassify.
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

// --- the demotion list ---------------------------------------------------
//
// FIELD PROVENANCE. On a healthy Expo app running on an iOS 26.5 simulator,
// `rn-iso logs --errors` returned 3,004 records and `status` reported "3004
// errors since the last marker". Not one of them was the app's: they were
// system frameworks logging at messageType Error from INSIDE the app process
// (nw_socket / SecTrust / WebKit / CoreUI / AddInstanceForFactory), plus
// Apple's UIScene deprecation notice, which ships as a Fault and was
// therefore classified FATAL on an app that was working.
//
// The stream predicate cannot exclude them -- they genuinely are in the app's
// process, and that is the same predicate that catches every NSLog the app
// makes. So capture stays unconditional and the level is what changes: these
// records are kept, at info, where `logs` still shows them and `--errors`
// does not. Anything NOT listed keeps the level messageType gave it; an
// unknown Error stays an error, which is the direction that matters.
//
// A rule matches on subsystem (exact, or a dotted parent of it), category,
// message prefix, or message substring -- whichever of those the offender is
// actually identifiable by. Message rules exist because the same emitters
// also reach the DEFAULT subsystem (an empty `subsystem` field) through
// CFNetwork's and AudioToolbox's older logging paths, where there is nothing
// but the text to match on.
export const NOISE_RULES: NoiseRule[] = [
  // ~2/3 of the 3,004. com.apple.network logs at Error for every socket that
  // is reset, retried or torn down, and an RN app holds a websocket to Metro
  // plus HTTP to the dev server, so it never stops.
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
  // Trust evaluation: one Error-typed line per TLS handshake whose trust
  // result is not already cached -- i.e. per cold launch, per host.
  { id: 'sectrust', subsystem: 'com.apple.securityd' },
  { id: 'sectrust-default-subsystem', messagePrefix: ['SecTrust', 'SecOSStatus', 'TrustResultType'] },
  // WebKit's GPU process and its WebPrivacy resource loader chatter at Error
  // whenever a WKWebView exists at all (expo-web-browser, any embedded view).
  { id: 'webkit', subsystem: 'com.apple.WebKit' },
  { id: 'webkit-default-subsystem', messagePrefix: ['WebPrivacy', 'GPUProcessProxy', 'WebProcessProxy'] },
  // AudioToolbox's plugin loader says this on every launch of every app that
  // links AVFoundation, and has since iOS 13. It is not a failure.
  { id: 'audio-factory', messageIncludes: ['AddInstanceForFactory'] },
  // Asset-catalog lookups that fall back: CoreUI logs the miss at Error even
  // when the fallback is the intended asset.
  { id: 'coreui', subsystem: 'com.apple.coreui' },
  { id: 'coreui-default-subsystem', messagePrefix: ['CUICatalog:', 'CoreUI:', 'CoreThemeDefinition'] },
  // The single record the field capture called FATAL. iOS 26 ships the
  // UIScene migration notice as a Fault; it is a deprecation notice with a
  // deadline, not a crash. Matched on the notice's sentence rather than on
  // "UIScene", so a real UIScene fault is still a fault.
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

// The raw event `simctl log stream --style ndjson` produces: Apple's shape,
// not ours, and not documented beyond `man log`'s field list -- a localized
// `any` rather than a guessed-at interface.
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

// PURE. The id of the rule that says this event is device noise, or null.
// Returning the id rather than a boolean is what makes the list auditable
// from a test: a rule that stops matching the shape it was written for fails
// by name.
export function noiseRuleId(event: LogStreamEvent): string | null {
  const subsystem = typeof event?.subsystem === 'string' ? event.subsystem : '';
  const category = typeof event?.category === 'string' ? event.category : '';
  const message = typeof event?.eventMessage === 'string' ? event.eventMessage : '';
  for (const rule of NOISE_RULES) {
    if (ruleMatches(rule, { subsystem, category, message })) return rule.id;
  }
  return null;
}

// PURE. The level this event is recorded at. Demotion only ever applies to
// error and fatal: a rule cannot promote, and demoting a Default-typed line
// to info would be a no-op anyway.
export function levelForEvent(event: LogStreamEvent): string {
  const level = levelFromMessageType(event?.messageType);
  if (level !== 'error' && level !== 'fatal') return level;
  return noiseRuleId(event) ? 'info' : level;
}

// PURE. `log stream` writes the process image path with the executable last:
//   .../RuntimeRoot/usr/libexec/backboardd
//   .../Containers/Bundle/Application/<uuid>/MyApp.app/MyApp
// The executable name is the useful identity in a log line.
export function procFromImagePath(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  const parts = path.split('/');
  return parts[parts.length - 1] || null;
}

// PURE. Apple's timestamp is "2026-08-25 13:18:05.196749-0400" -- a space
// separator and six fractional digits, which V8's Date accepts as-is.
function tsFromEvent(event: LogStreamEvent, now: () => number = Date.now): number {
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

// PURE. One raw stream line -> a record, or null.
//
// The first line `log stream` writes is not JSON at all: a live capture from
// a booted sim opens with
//   Filtering the log data using "processImagePath CONTAINS[c] "MyApp""
// and a JSON.parse of it would throw. Anything unparseable is skipped for the
// same reason ndjson.js skips a corrupt record: a log reader must never be
// the thing that dies.
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

// PURE. The exact argv, so a test can assert it without a device.
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

// PURE. The app name to predicate on when the caller only knows a bundle id.
// An RN app's product name is normally the last bundle-id segment, and the
// caller (which has the .app path) should pass the real one; this is the
// fallback, not the rule.
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
    // NOT detached: the stream dies with the collector that owns it. An
    // orphaned `log stream` writes to a closed pipe forever.
    detached: false,
  });
}
