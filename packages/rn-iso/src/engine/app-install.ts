// src/engine/app-install.js -- artifact onto device, then launched against
// THIS workspace's Metro port.
//
// Contract 6 is the whole point of this module: the build cache shares one
// binary across every workspace on the machine, so the Metro port must never
// be baked into a build. It is applied at LAUNCH time instead, per platform,
// and each mechanism below is verified against the source that reads it.
//
// Nothing here throws on a tool failure. Every function returns
//   { ok: true, ... }  or  { failed: true, reason, ... }
// because a failed install is a diagnostic the command layer prints with a
// log path, not an exception it has to catch three frames up.
//
// runFile (argv array, no shell) everywhere a path or a URL is involved: an
// app path with a space in it, and a dev-client URL full of `&` and `%`, both
// reach the tool as one literal argument that way. CLAUDE.md's exec rule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import { parseNdjsonText, type NdjsonRecord } from '../ndjson.ts';

export const INSTALL_ERROR = 'RN_ISO_INSTALL_FAILED';
export const LAUNCH_ERROR = 'RN_ISO_LAUNCH_FAILED';

// The port a debug React Native app asks for when nothing tells it otherwise.
// Android's reverse maps THIS to the workspace's reserved port; see below.
export const DEFAULT_METRO_PORT = 8081;

// The injected-executor seam every function in this module accepts.
interface ExecOpt {
  exec?: Executor | null;
}

// --- iOS ------------------------------------------------------------------

export function installIosApp({ udid, appPath }: { udid: string; appPath: string }, { exec = null }: ExecOpt = {}) {
  const e = exec || getExecutor();
  try {
    e.runFile('xcrun', ['simctl', 'install', udid, appPath]);
    return { ok: true, appPath };
  } catch (err) {
    return { failed: true, code: INSTALL_ERROR, reason: `simctl install failed for ${appPath}: ${describe(err)}` };
  }
}

// PURE. The value written to the app's RCT_jsLocation default.
//
// VERIFIED against react-native (checkout at /Volumes/ExternalSSD/Developer/
// react-native), packages/react-native/React/Base/RCTBundleURLProvider.mm:
//   line 30   static NSString *const kRCTJsLocationKey = @"RCT_jsLocation";
//   line 554  - (NSString *)jsLocation
//               { return [[NSUserDefaults standardUserDefaults]
//                          stringForKey:kRCTJsLocationKey]; }
//   line 267  packagerServerHostPort reads jsLocation and returns it verbatim
//             when set, ahead of guessPackagerHost (line 278).
//   line 70   serverRootWithHostPort(hostPort, scheme): when hostPort
//             CONTAINS A COLON it is interpolated whole as
//             "<scheme>://<hostPort>/"; without one, the default port
//             (kRCTBundleURLProviderDefaultPort, 8081) is appended.
// So the value is a host:port string -- "localhost:8082" -- NOT a URL and
// not a bare port. The key lives in the APP's NSUserDefaults domain, which
// is why the write below is scoped to the bundle id.
//
// One behaviour worth knowing (RCTBundleURLProvider.mm line 270): under
// RCT_DEV_MENU the provider checks that a packager is actually running at
// this location and falls back to guessing if not. A jsLocation pointed at a
// dead port therefore degrades to 8081 rather than failing loudly -- which is
// exactly why `ios` refuses to run at all without a healthy Metro on the
// reserved port (RN_ISO_NO_METRO).
export function jsLocationValue(metroPort: number | string) {
  return `localhost:${metroPort}`;
}

// PURE. The expo-dev-client deep link.
//
// VERIFIED against expo (checkout at /Volumes/ExternalSSD/Developer/expo):
//   packages/@expo/cli/src/start/server/UrlCreator.ts line 88
//     const devClientUrl =
//       `${protocol}://expo-development-client/?url=${manifestUrlEncoded}`;
//     where manifestUrlEncoded = encodeURIComponent(manifestUrl) (line 87)
//     and manifestUrl for a localhost host is "http://localhost:<port>"
//     (joinUrlComponents, line 219: no trailing slash).
//   packages/expo-dev-launcher/ios/EXDevLauncherURLHelper.swift line 34
//     isDevLauncherURL is `url?.host == "expo-development-client"` --
//     the host segment is what the launcher matches on, so the `//` and the
//     trailing `/?` both matter.
//   packages/expo-dev-launcher/ios/Tests/EXDevLauncherURLHelperTests.swift
//     line 15 asserts exactly this shape, down to the percent-encoding:
//     "scheme://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
// The CLI delivers it with `simctl openurl` (packages/@expo/cli/src/start/
// platforms/ios/simctl.ts line 191), which is what launchIosApp does below.
//
// `host` is the one thing that differs by platform: a simulator shares the
// mac's loopback, an emulator does not (see EMULATOR_HOST_LOOPBACK below).
// The shape is otherwise identical, and expo-dev-launcher parses it the same
// way on both -- packages/expo-dev-launcher/android/src/debug/java/expo/
// modules/devlauncher/helpers/DevLauncherURLHelper.kt line 7 is
// `fun isDevLauncherUrl(uri: Uri) = uri.host == "expo-development-client"`,
// the same host-segment match EXDevLauncherURLHelper.swift line 34 makes.
export function devClientUrl(scheme: string, metroPort: number | string, host = 'localhost') {
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(`http://${host}:${metroPort}`)}`;
}

// Order matters. RCT_jsLocation is written FIRST, unconditionally, even on
// the dev-client path: the openurl carries the port for the launcher, but a
// later in-app reload that goes through RCTBundleURLProvider reads the
// default instead, and a stale one there sends the reload at 8081 -- another
// workspace's bundler.
export function launchIosApp(
  {
    udid,
    bundleId,
    metroPort,
    devClientScheme = null,
  }: { udid: string; bundleId: string; metroPort: number | string; devClientScheme?: string | null },
  { exec = null }: ExecOpt = {},
) {
  const e = exec || getExecutor();
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

  try {
    e.runFile('xcrun', ['simctl', 'launch', udid, bundleId]);
    return { ok: true, mode: 'launch', jsLocation: jsLocationValue(metroPort) };
  } catch (err) {
    return { failed: true, code: LAUNCH_ERROR, reason: `simctl launch ${bundleId} failed: ${describe(err)}` };
  }
}

// --- Android --------------------------------------------------------------

export function installAndroidApp(
  { serial, apkPath }: { serial: string; apkPath: string },
  { exec = null }: ExecOpt = {},
) {
  const e = exec || getExecutor();
  try {
    // -r reinstalls over an existing copy, keeping data. Without it every
    // second run fails with INSTALL_FAILED_ALREADY_EXISTS.
    e.runFile('adb', ['-s', serial, 'install', '-r', apkPath]);
    return { ok: true, apkPath };
  } catch (err) {
    return { failed: true, code: INSTALL_ERROR, reason: `adb install failed for ${apkPath}: ${describe(err)}` };
  }
}

// PURE. `cmd package resolve-activity --brief` prints a header line of
// key=value pairs and then the component on its own line:
//
//   priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true
//   com.android.settings/.Settings
//
// (captured verbatim from a live emulator-5554, Android 16). When nothing
// matches, the whole output is "No activity found". Returns the component or
// null; the caller falls back to monkey.
export function parseResolvedActivity(text: unknown) {
  if (typeof text !== 'string') return null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^No activity found/i.test(line)) return null;
    // The header line is key=value pairs with no slash; a component always
    // has exactly one, separating package from activity.
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
    // resolve-activity exits 0 even for "No activity found", so a throw here
    // means adb itself failed. Fall back to monkey rather than refusing:
    // monkey resolves the launcher intent inside the device.
    return null;
  }
}

// Contract 6, Android half. TWO reverses, deliberately:
//
//   adb reverse tcp:8081 tcp:<metroPort>
//     The binary is port-agnostic (see the module header), so the app asks
//     for its compiled-in default, 8081. This maps that request to THIS
//     workspace's reservation, which is what lets four worktrees run four
//     bundlers and four apps at once from identical APKs.
//   adb reverse tcp:<metroPort> tcp:<metroPort>
//     Kept for tooling that asks for the real port by number -- a dev-client
//     deep link, a manual `curl localhost:<port>` from an adb shell, the
//     inspector proxy. Skipped when it would duplicate the first.
export function reverseMetroPorts(
  { serial, metroPort }: { serial: string; metroPort: number | string },
  { exec = null }: ExecOpt = {},
) {
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

// The Android analog of iOS's RCT_jsLocation, from react-native-worktree's
// debug_http_host trick. PackagerConnectionSettings.kt reads the
// "debug_http_host" key out of the app's default SharedPreferences and
// returns it VERBATIM as host:port, ahead of every emulator-default fallback
// (unlike the metro.host system property, which AndroidInfoHelpers uses as a
// bare ip and then appends the BAKED dev-server port to -- it cannot carry a
// workspace port). 10.0.2.2 is the emulator's route to the host loopback.
//
// VERIFIED against react-native (checkout at /Volumes/ExternalSSD/Developer/
// react-native), packages/react-native/ReactAndroid/src/main/java/com/
// facebook/react/packagerconnection/PackagerConnectionSettings.kt:
//   line 20  PreferenceManager.getDefaultSharedPreferences(appContext)
//            -- which is <pkg>_preferences.xml, hence the file name below.
//   line 79  private const val PREFS_DEBUG_SERVER_HOST_KEY = "debug_http_host"
//   line 35  getString(PREFS_DEBUG_SERVER_HOST_KEY, null) is returned as-is
//            when non-empty, BEFORE AndroidInfoHelpers.getServerHost.
//
// Written via run-as, which works because this is always a debuggable build
// on an owned emulator. Best-effort by design: any failure is reported and
// launch proceeds -- the adb reverse mapping covers the 8081 path alone.

// The emulator's fixed alias for the host loopback (qemu user-mode
// networking). Everything rn-iso points AT the host from inside an emulator
// uses this and not `localhost`, deliberately and in one place:
// `adb reverse` would make localhost work too, but a reverse is per-adb-
// connection state that dies with an adb server restart or a re-attach and is
// only re-applied by the next `rn-iso android`, while 10.0.2.2 is routing the
// emulator itself provides. It also keeps debug_http_host and the dev-client
// deep link naming the SAME host, which matters because expo-dev-launcher
// persists the url it was opened with in its recent-servers list.
const EMULATOR_HOST_LOOPBACK = '10.0.2.2';

// `adb shell` does NOT escape its arguments -- it joins them with spaces and
// hands the resulting STRING to the device's shell, which parses it. So an
// argv array does not protect anything on the far side: a multi-line script
// passed as one element arrives as many device-shell commands.
//
// OBSERVED, on emulator-5556 running Android 16, with the very script below:
// unquoted, `sh -c` took only the first word (`cd`) and the remaining lines
// ran in the DEVICE shell, whose cwd is `/` --
//   mkdir: 'shared_prefs': Read-only file system
// while the same argv with the script quoted wrote the file correctly. Single
// quotes, because they quote everything (the prefs XML is full of double
// quotes), and `'\''` for the one character they cannot carry.
export function deviceShellArg(text: unknown) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

// PURE. The device-side script that lands debug_http_host in the app's
// default SharedPreferences, whatever state that file is in. Exported so a
// test can EXECUTE it (test/engine-app-install.test.js runs it under a local
// `sh -c` against a temp dir): the previous version of this function was
// asserted only by a regex over its argv, and shipped three separate shell
// defects -- `if`/`then` collapsed onto one line by a `.join(' ')`, inner
// double quotes that closed the outer quoting and turned `>10.0.2.2:8085`
// into a redirection, and `\n` inside a single-line command. A test that
// cannot fail on any of those is not a test of this.
//
// The file is REBUILT rather than patched, which is what removes the sed
// expressions (and toybox's sed, which is what an emulator has, is not GNU
// sed) and what makes one code path cover all four states: no file, a file
// with the key, a file without it, and Android's empty-prefs form `<map />`.
// Everything except the header, the closing tag and any existing
// debug_http_host line is carried over verbatim.
export function debugHttpHostScript({
  packageName,
  host,
  dataDir = null,
}: {
  packageName: string;
  host: string;
  dataDir?: string | null;
}) {
  const dir = dataDir || `/data/data/${packageName}`;
  const prefs = `shared_prefs/${packageName}_preferences.xml`;
  const tmp = `${prefs}.rn-iso.tmp`;
  // Real newlines: this whole string is ONE argv element, quoted by
  // deviceShellArg, so the device shell hands it to `sh -c` as one script.
  return [
    `cd ${dir} || exit 1`,
    'mkdir -p shared_prefs || exit 1',
    `printf '%s\\n' '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>' '<map>' > ${tmp} || exit 1`,
    `if [ -f ${prefs} ]; then grep -v 'debug_http_host' ${prefs} | grep -v '<?xml' | grep -v '<map' | grep -v '</map>' >> ${tmp}; fi`,
    `printf '%s\\n' '    <string name="debug_http_host">${host}</string>' '</map>' >> ${tmp} || exit 1`,
    `mv ${tmp} ${prefs} || exit 1`,
    // The self-check is the whole difference between "adb exited 0" and "the
    // value is in the file": a shell that mis-parses this script can still
    // exit 0 having written nothing, which is exactly how the old one passed
    // for months.
    `grep -q '>${host}<' ${prefs} || exit 1`,
  ].join('\n');
}

export function writeDebugHttpHost(
  { serial, packageName, metroPort }: { serial: string; packageName: string; metroPort: number | string },
  { exec = null }: ExecOpt = {},
) {
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

// PURE. The dev-client deep link for an emulator: the same shape iOS opens
// with `simctl openurl`, pointed at 10.0.2.2 rather than localhost (see
// EMULATOR_HOST_LOOPBACK).
export function androidDevClientUrl(scheme: string, metroPort: number | string) {
  return devClientUrl(scheme, metroPort, EMULATOR_HOST_LOOPBACK);
}

// PURE. `am start` is the one adb command whose EXIT CODE cannot be trusted:
// it prints its diagnosis and still exits 0 for an intent nothing resolves
// ("Error: Activity not started, unable to resolve Intent { ... }"). Expo's
// own CLI reads the output for the same reason (packages/@expo/cli/src/start/
// platforms/android/adb.ts, openAsync: it matches on the text, not the
// status). Returns the error line, or null when the output looks like a
// start.
export function amStartError(text: unknown) {
  const out = String(text ?? '');
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (/^Error:/i.test(line)) return line;
    // "Warning: Activity not started, its current task has been brought to
    // the front" is the SUCCESS case for an app already running -- do not
    // treat a Warning as a failure.
  }
  return null;
}

// The dev-client deep link, delivered with `am start -a VIEW -d <url>` --
// which is what `expo run:android` sends too (packages/@expo/cli/src/start/
// platforms/android/adb.ts line 139, openUrlAsync: `adbShellArgs(device.pid,
// 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url)`).
//
// The url is quoted for the DEVICE shell (deviceShellArg): adb hands the
// joined argv to that shell, and the url carries `?` (a glob) and, for a
// scheme carrying query parameters, `&`.
export function openAndroidDevClientUrl(
  { serial, url }: { serial: string; url: string },
  { exec = null }: ExecOpt = {},
) {
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

// Order on Android mirrors iOS's: the port wiring FIRST (both mechanisms),
// then the launch. The dev-client deep link is what makes a cold launch land
// on this workspace's bundle instead of expo-dev-launcher's DEVELOPMENT
// SERVERS picker -- the same bug iOS's openurl exists for, and the reason
// every Android launch before this reported `unverified`.
//
// A deep link that does not resolve is NOT fatal: the app is installed and a
// plain launcher start still gives the developer the picker, which is
// strictly better than refusing the run. It comes back as `devClientNote`,
// which commands/android.js prints.
export function launchAndroidApp(
  {
    serial,
    packageName,
    metroPort,
    devClientScheme = null,
  }: { serial: string; packageName: string; metroPort: number | string; devClientScheme?: string | null },
  { exec = null }: ExecOpt = {},
) {
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
    // monkey with a count of 1 sends the launcher intent the device itself
    // resolved, which covers apps whose manifest resolve-activity could not
    // read (a disabled-by-default alias, a package just installed).
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

// execFileSync attaches the child's stderr to the thrown error; that text is
// the actual diagnostic ("No such file or directory", "device offline"),
// while err.message alone is just the command line.
function describe(err: unknown) {
  // execFileSync's thrown error is genuinely dynamic (child stderr attached
  // by node, not by any type this module owns).
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = e?.stderr ? String(e.stderr).trim() : '';
  const message = e?.message ? String(e.message).trim() : String(err);
  return stderr ? `${message}: ${stderr}` : message;
}

// --- launch VERIFICATION (the launch is not the proof) --------------------
//
// The bug this exists for: rn-iso reported `launched: true` while the app sat
// on expo-dev-launcher's DEVELOPMENT SERVERS picker, listing every OTHER
// workspace's Metro on the machine. One tap there loads another project's
// bundle onto this workspace's simulator -- the exact cross-workspace
// contamination v3 exists to prevent -- and from the outside a picker looks
// identical to a loaded app. `simctl launch` returning a pid proves a process
// started, and nothing more.
//
// Two things make the picker likely rather than exotic:
//   - a dev-client app with no deep link opens straight into it;
//   - on iOS 26 `simctl openurl` is gated behind an "Open in <app>?" system
//     alert, so even a CORRECT deep link stalls until somebody taps Open.
//
// So the launch is followed by a poll for PROOF: a record in this workspace's
// own metro.ndjson, written after the launch, showing that a bundle was
// requested from THIS Metro. It is the only evidence that names the right
// server -- an app on the picker, or one that loaded a neighbour's bundle,
// produces none of it.
//
// A timeout is NOT a failure: the app may well be fine, and refusing here
// would break every legitimate slow launch. The run stays exit 0 and reports
// `launched: 'unverified'` instead of `true`, with a warning that says what to
// check. Saying "launched" when we did not see a bundle request is the thing
// that must not happen.

export const LAUNCH_UNVERIFIED = 'unverified';

// ~20s: a cold dev-client fetches the manifest, then requests the bundle. On
// the repos this was measured against the first bundle_build_started lands
// 3-8s after launch; 20 is generous without being a wait anybody notices when
// something is wrong.
export const VERIFY_TIMEOUT_MS = 20000;
const VERIFY_POLL_MS = 500;

// Bare path (@rn-iso/metro's ndjsonReporter): Metro's own event names. Any of
// them proves a client asked THIS server for a bundle -- including the
// failures, because a bundling error is still a request that arrived here.
const BUNDLE_EVENTS = new Set([
  'bundle_build_started',
  'bundle_build_done',
  'bundle_build_failed',
  'bundling_error',
  'transformer_error',
]);

// PURE. Does this Contract-1 record prove a bundle was requested from this
// workspace's dev server at or after `since`?
//
// Records with no usable timestamp are NOT proof: the whole question is
// whether the fetch happened after THIS launch, and a previous run's bundle
// build sitting in the same file would otherwise verify a launch that never
// loaded anything.
export function isBundleProof(record: unknown, since: number | string = 0) {
  if (!record || typeof record !== 'object') return false;
  const rec = record as NdjsonRecord;
  const ts = Number(rec.ts);
  if (!Number.isFinite(ts) || ts < Number(since || 0)) return false;
  if (typeof rec.event === 'string' && BUNDLE_EVENTS.has(rec.event)) return true;
  // Expo child: the structure is inferred from stdout (raw: true), so the
  // line itself is the event. See isBundleActivityLine in server-expo.js.
  if (rec.src === 'metro' && typeof rec.msg === 'string' && expoBundleLine(rec.msg)) return true;
  return false;
}

// Kept as a local copy of the ONE regex rather than an import, so this module
// (which every install path loads) does not pull in the supervisor. The
// predicate is exported from server-expo.js as isBundleActivityLine and a test
// asserts the two agree.
function expoBundleLine(msg: string) {
  return /\bBundl(?:ing|ed)\b/.test(msg);
}

// Poll <logsDir>/metro.ndjson for the proof above.
//
// Reading the file rather than subscribing: the dev server is a DETACHED
// supervisor in another process, and its NDJSON timeline is the only channel
// between it and this command. Contract 1 already promises reading never
// throws on a half-written line (parseNdjsonText drops it), which is what
// makes tailing a live file safe here.
export async function verifyLaunch({
  logsDir,
  since,
  // Which dev server produced the timeline. Carried through to the result
  // (and into the warning) rather than used to choose a predicate: a bare
  // workspace never writes expo stdout records and an expo one never writes
  // Metro reporter events, so one predicate covers both without a branch.
  mode = null,
  timeoutMs = VERIFY_TIMEOUT_MS,
  pollMs = VERIFY_POLL_MS,
  readRecords = null,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  logsDir?: string;
  since?: number | string;
  mode?: string | null;
  timeoutMs?: number;
  pollMs?: number;
  readRecords?: (() => NdjsonRecord[]) | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
} = {}) {
  const read = readRecords || (() => readMetroRecords(logsDir));
  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  while (true) {
    for (const record of read()) {
      if (isBundleProof(record, since)) {
        return { verified: true, record, mode, waitedMs: now() - startedAt };
      }
    }
    if (now() >= deadline) {
      return { verified: false, timedOut: true, mode, waitedMs: now() - startedAt };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

function readMetroRecords(logsDir: string | undefined): NdjsonRecord[] {
  if (!logsDir) return [];
  try {
    return parseNdjsonText(readFileSync(join(logsDir, 'metro.ndjson'), 'utf-8'));
  } catch {
    // No dev-server log yet is the ordinary case in the first second of a
    // poll, and an unreadable one is not worth failing a launched app over.
    return [];
  }
}

// PURE. The warning printed when the poll timed out. It is the whole value of
// the check: an agent that reads "unverified" has to know what to do next.
//
// It is a NUMBERED LIST OF ACTIONS, in the order they resolve the state, and
// that ordering is the field-tested part. It used to be a list of "likely
// causes" whose only imperative was `Retry the deep link with: simctl openurl`
// -- and on a fresh simulator iOS 26 raises the "Open in <app>?" alert on EVERY
// first launch, in front of that exact command. So the one instruction the
// block gave re-raised the alert it was stuck behind, forever, while the action
// that clears it (confirm the alert) sat above it as a passive cause. Leading
// with the confirmation, and conditioning the retry on there being no alert, is
// what turns this from a loop into a sequence that terminates.
export function unverifiedLaunchLines({
  platform,
  metroPort,
  waitedMs = VERIFY_TIMEOUT_MS,
  bundleId = null,
  udid = null,
  serial = null,
  devClientUrl: url = null,
  mode = null,
}: {
  platform: string;
  metroPort: number | string;
  waitedMs?: number;
  bundleId?: string | null;
  udid?: string | null;
  serial?: string | null;
  devClientUrl?: string | null;
  mode?: string | null;
}) {
  const seconds = Math.round(Number(waitedMs || 0) / 1000);
  const lines = [
    `The app was started, but nothing fetched a bundle from this workspace's Metro (port ${metroPort}) within ${seconds}s.`,
    'The app is launched; what is unproven is that it is talking to THIS dev server. Do this, in order:',
  ];
  const picker = `If expo-dev-launcher's DEVELOPMENT SERVERS picker is showing, tap the entry for http://localhost:${metroPort} -- NOT another workspace's, which would load a different project's bundle onto this device.`;
  let step = 0;
  const push = (text: string) => lines.push(`  ${++step}. ${text}`);
  if (platform === 'ios') {
    push(
      'If an "Open in <app>?" alert is showing, confirm it with your device tool (iOS 26 raises it on every first launch on a fresh simulator, in front of the deep link); the bundle loads immediately after.',
    );
    push(picker);
    if (url && udid) {
      push(`Only if no alert is showing, retry the deep link: xcrun simctl openurl ${udid} '${url}'`);
    } else if (udid && bundleId) {
      push(`Only if no alert is showing, re-launch: xcrun simctl launch --console ${udid} ${bundleId}`);
    }
  } else {
    // The deep link goes FIRST on Android, and it is the whole answer when
    // it is available: there is no confirmation alert in front of `am start`
    // (that is an iOS 26 thing), so re-sending it is a command that either
    // loads this workspace's bundle or says why it did not. The picker is
    // only what you are looking at when there is no scheme to deep-link
    // with, and the plain re-launch only ever reopens the same picker.
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
  lines.push(`Then check \`rn-iso logs --source metro\`${mode ? ` (${mode})` : ''} for a bundle request.`);
  return lines;
}
