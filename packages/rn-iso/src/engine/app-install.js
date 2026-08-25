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
import { getExecutor } from '../exec.js';

export const INSTALL_ERROR = 'RN_ISO_INSTALL_FAILED';
export const LAUNCH_ERROR = 'RN_ISO_LAUNCH_FAILED';

// The port a debug React Native app asks for when nothing tells it otherwise.
// Android's reverse maps THIS to the workspace's reserved port; see below.
export const DEFAULT_METRO_PORT = 8081;

// --- iOS ------------------------------------------------------------------

export function installIosApp({ udid, appPath }, { exec = null } = {}) {
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
export function jsLocationValue(metroPort) {
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
export function devClientUrl(scheme, metroPort) {
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${metroPort}`)}`;
}

// Order matters. RCT_jsLocation is written FIRST, unconditionally, even on
// the dev-client path: the openurl carries the port for the launcher, but a
// later in-app reload that goes through RCTBundleURLProvider reads the
// default instead, and a stale one there sends the reload at 8081 -- another
// workspace's bundler.
export function launchIosApp({ udid, bundleId, metroPort, devClientScheme = null }, { exec = null } = {}) {
  const e = exec || getExecutor();
  try {
    e.runFile('xcrun', ['simctl', 'spawn', udid, 'defaults', 'write', bundleId, 'RCT_jsLocation', jsLocationValue(metroPort)]);
  } catch (err) {
    return { failed: true, code: LAUNCH_ERROR, reason: `Could not point ${bundleId} at Metro port ${metroPort} (defaults write RCT_jsLocation): ${describe(err)}` };
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

export function installAndroidApp({ serial, apkPath }, { exec = null } = {}) {
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
export function parseResolvedActivity(text) {
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

export function resolveLaunchActivity(serial, packageName, { exec = null } = {}) {
  const e = exec || getExecutor();
  try {
    const out = e.runFile('adb', ['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', packageName]);
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
export function reverseMetroPorts({ serial, metroPort }, { exec = null } = {}) {
  const e = exec || getExecutor();
  const pairs = [[DEFAULT_METRO_PORT, metroPort]];
  if (Number(metroPort) !== DEFAULT_METRO_PORT) pairs.push([metroPort, metroPort]);
  for (const [device, host] of pairs) {
    try {
      e.runFile('adb', ['-s', serial, 'reverse', `tcp:${device}`, `tcp:${host}`]);
    } catch (err) {
      return { failed: true, code: LAUNCH_ERROR, reason: `adb reverse tcp:${device} tcp:${host} failed on ${serial}: ${describe(err)}` };
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
// Written via run-as, which works because this is always a debuggable build
// on an owned emulator. Best-effort by design: any failure is reported and
// launch proceeds -- the adb reverse mapping covers the 8081 path alone.
export function writeDebugHttpHost({ serial, packageName, metroPort }, { exec = null } = {}) {
  const e = exec || getExecutor();
  const host = `10.0.2.2:${metroPort}`;
  const prefs = `shared_prefs/${packageName}_preferences.xml`;
  const script = [
    `cd /data/data/${packageName} || exit 1`,
    `if [ ! -f ${prefs} ]; then mkdir -p shared_prefs && printf '%s\n' "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>" "<map>" "    <string name=\"debug_http_host\">${host}</string>" "</map>" > ${prefs};`,
    `elif grep -q debug_http_host ${prefs}; then sed -i "s|<string name=\"debug_http_host\">[^<]*</string>|<string name=\"debug_http_host\">${host}</string>|" ${prefs};`,
    `else sed -i "s|</map>|    <string name=\"debug_http_host\">${host}</string>\n</map>|" ${prefs}; fi`,
  ].join(' ');
  try {
    e.runFile('adb', ['-s', serial, 'shell', 'run-as', packageName, 'sh', '-c', script]);
    return { ok: true, host };
  } catch (err) {
    return { ok: false, reason: `debug_http_host not written (${describe(err)}); relying on adb reverse` };
  }
}

export function launchAndroidApp({ serial, packageName, metroPort }, { exec = null } = {}) {
  const e = exec || getExecutor();
  const reversed = reverseMetroPorts({ serial, metroPort }, { exec: e });
  if (reversed.failed) return reversed;
  const prefs = writeDebugHttpHost({ serial, packageName, metroPort }, { exec: e });

  const component = resolveLaunchActivity(serial, packageName, { exec: e });
  if (component) {
    try {
      e.runFile('adb', ['-s', serial, 'shell', 'am', 'start', '-n', component]);
      return { ok: true, mode: 'am-start', component, reversed: reversed.reversed, debugHttpHost: prefs.ok ? prefs.host : null, debugHttpHostNote: prefs.ok ? null : prefs.reason };
    } catch (err) {
      return { failed: true, code: LAUNCH_ERROR, reason: `am start -n ${component} failed on ${serial}: ${describe(err)}` };
    }
  }

  try {
    // monkey with a count of 1 sends the launcher intent the device itself
    // resolved, which covers apps whose manifest resolve-activity could not
    // read (a disabled-by-default alias, a package just installed).
    e.runFile('adb', ['-s', serial, 'shell', 'monkey', '-p', packageName, '1']);
    return { ok: true, mode: 'monkey', reversed: reversed.reversed, debugHttpHost: prefs.ok ? prefs.host : null, debugHttpHostNote: prefs.ok ? null : prefs.reason };
  } catch (err) {
    return { failed: true, code: LAUNCH_ERROR, reason: `Could not launch ${packageName} on ${serial}: no launcher activity resolved and monkey failed: ${describe(err)}` };
  }
}

// execFileSync attaches the child's stderr to the thrown error; that text is
// the actual diagnostic ("No such file or directory", "device offline"),
// while err.message alone is just the command line.
function describe(err) {
  const stderr = err?.stderr ? String(err.stderr).trim() : '';
  const message = err?.message ? String(err.message).trim() : String(err);
  return stderr ? `${message}: ${stderr}` : message;
}
