// engine/app-install.js -- Contract 6, asserted as exact argv.
//
// The whole reason this module exists is that the build cache shares one
// binary across workspaces, so the Metro port cannot be baked in. It is
// applied at launch, and the mechanisms are only correct if the exact key,
// the exact URL shape and the exact reverse pairs are right -- which is why
// every test below asserts argv rather than "something was called".
//
// The two shapes were verified against real source and the citations are in
// the module: RCT_jsLocation in react-native's RCTBundleURLProvider.mm
// (kRCTJsLocationKey line 30, jsLocation line 554, serverRootWithHostPort
// line 70), and the dev-client URL in expo's UrlCreator.ts line 88 plus
// EXDevLauncherURLHelperTests.swift line 15.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NdjsonRecord } from '../ndjson.ts';
import { isBundleActivityLine } from '../supervisor/server-expo.ts';
import {
  DEFAULT_METRO_PORT,
  INSTALL_ERROR,
  LAUNCH_ERROR,
  VERIFY_TIMEOUT_MS,
  devClientUrl,
  isBundleProof,
  unverifiedLaunchLines,
  verifyLaunch,
  amStartError,
  androidDevClientUrl,
  debugHttpHostScript,
  deviceShellArg,
  installAndroidApp,
  installIosApp,
  openAndroidDevClientUrl,
  jsLocationValue,
  launchAndroidApp,
  launchIosApp,
  parseResolvedActivity,
  reverseMetroPorts,
  writeDebugHttpHost,
} from '../engine/app-install.ts';

// launchAndroidApp / launchIosApp return a union of success and failure shapes;
// a permissive structural view lets a test read the branch it exercised.
type LaunchResult = {
  ok?: boolean;
  failed?: boolean;
  code?: string;
  reason?: string;
  mode?: string;
  component?: string;
  devClientUrl?: string;
  devClientNote?: string | null;
  reversed?: string[];
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
  [key: string]: unknown;
};

// Records every runFile call as a flat argv array, and lets a test make a
// particular one fail.
function recordingExec({ fail = null, outputs = {} }: any = {}): any {
  const calls: any[] = [];
  return {
    calls,
    runFile(file: any, args: any) {
      calls.push([file, ...args]);
      const key = [file, ...args].join(' ');
      if (fail && key.includes(fail)) {
        const err = new Error(`Command failed: ${key}`);
        (err as any).stderr = 'device not booted';
        throw err;
      }
      for (const [match, value] of Object.entries(outputs)) {
        if (key.includes(match)) return value;
      }
      return '';
    },
    run() {
      throw new Error('app-install must use runFile, not the shell');
    },
    runQuiet() {
      throw new Error('app-install must use runFile, not the shell');
    },
    spawn() {
      throw new Error('app-install does not spawn');
    },
  };
}

describe('the two pure port-wiring shapes', () => {
  // A host:port string, not a URL and not a bare port: serverRootWithHostPort
  // interpolates it whole when it contains a colon, and appends the default
  // 8081 when it does not.
  test('jsLocationValue is host:port', () => {
    expect(jsLocationValue(8082)).toBe('localhost:8082');
    expect(jsLocationValue(8082)).toMatch(/:/);
  });

  test('devClientUrl matches the shape expo-dev-launcher asserts on', () => {
    expect(devClientUrl('myapp', 8082)).toBe('myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082');
    // The exact string in EXDevLauncherURLHelperTests.swift line 15.
    expect(devClientUrl('scheme', 8081)).toBe('scheme://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081');
  });
});

describe('ios', () => {
  test('installIosApp passes the .app path as one literal argv element', () => {
    const exec = recordingExec();
    const appPath = '/tmp/Build Products/My App.app';
    expect(installIosApp({ udid: 'U1', appPath }, { exec })).toEqual({ ok: true, appPath });
    expect(exec.calls).toEqual([['xcrun', 'simctl', 'install', 'U1', appPath]]);
  });

  test('installIosApp reports a simctl failure instead of throwing', () => {
    const exec = recordingExec({ fail: 'simctl install' });
    const result = installIosApp({ udid: 'U1', appPath: '/tmp/a.app' }, { exec });
    expect(result.code).toBe(INSTALL_ERROR);
    expect(result.reason).toMatch(/device not booted/);
  });

  // RCT_jsLocation is written FIRST and unconditionally. On the bare path it
  // is the only wiring there is; on the dev-client path an in-app reload
  // still goes through RCTBundleURLProvider, and a stale default there would
  // send the reload at 8081 -- another workspace's bundler.
  test('launchIosApp writes RCT_jsLocation before launching, bare RN path', () => {
    const exec = recordingExec();
    const result = launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('launch');
    expect(exec.calls).toEqual([
      ['xcrun', 'simctl', 'spawn', 'U1', 'defaults', 'write', 'com.example.app', 'RCT_jsLocation', 'localhost:8082'],
      ['xcrun', 'simctl', 'launch', 'U1', 'com.example.app'],
    ]);
  });

  test('launchIosApp opens the dev-client URL when a scheme is given, still after the defaults write', () => {
    const exec = recordingExec();
    const result = launchIosApp(
      { udid: 'U1', bundleId: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' },
      { exec },
    );
    expect(result.mode).toBe('openurl');
    expect(exec.calls).toEqual([
      ['xcrun', 'simctl', 'spawn', 'U1', 'defaults', 'write', 'com.example.app', 'RCT_jsLocation', 'localhost:8082'],
      ['xcrun', 'simctl', 'openurl', 'U1', 'myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082'],
    ]);
  });

  test('a failed defaults write stops the launch rather than launching unwired', () => {
    const exec = recordingExec({ fail: 'defaults write' });
    const result = launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec });
    expect(result.code).toBe(LAUNCH_ERROR);
    expect(result.reason).toMatch(/RCT_jsLocation/);
    expect(exec.calls.length).toBe(1);
  });

  test('a failed launch is reported, not thrown', () => {
    const exec = recordingExec({ fail: 'simctl launch' });
    expect(launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec }).reason).toMatch(
      /simctl launch/,
    );
  });
});

describe('android: resolve-activity parsing', () => {
  // Captured verbatim from a live emulator (Android 16):
  //   adb -s emulator-5554 shell cmd package resolve-activity --brief \
  //     -c android.intent.category.LAUNCHER com.android.settings
  const REAL =
    'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.android.settings/.Settings\n';

  test('takes the component line, not the key=value header', () => {
    expect(parseResolvedActivity(REAL)).toBe('com.android.settings/.Settings');
  });

  // Also captured from the same emulator, for a package that does not exist.
  test('returns null for "No activity found", which resolve-activity prints with exit 0', () => {
    expect(parseResolvedActivity('No activity found\n')).toBe(null);
  });

  test('returns null for empty or non-string output', () => {
    expect(parseResolvedActivity('')).toBe(null);
    expect(parseResolvedActivity(null)).toBe(null);
  });

  test('handles a fully qualified activity name', () => {
    expect(parseResolvedActivity('priority=0 isDefault=true\ncom.example.app/com.example.app.MainActivity\n')).toBe(
      'com.example.app/com.example.app.MainActivity',
    );
  });
});

describe('android: install and launch', () => {
  test('installAndroidApp uses adb install -r with the apk as one argv element', () => {
    const exec = recordingExec();
    const apkPath = '/tmp/out puts/app-debug.apk';
    expect(installAndroidApp({ serial: 'emulator-5554', apkPath }, { exec })).toEqual({ ok: true, apkPath });
    expect(exec.calls).toEqual([['adb', '-s', 'emulator-5554', 'install', '-r', apkPath]]);
  });

  // Contract 6: the app asks for its compiled-in 8081, and that request is
  // mapped to THIS workspace's reservation. The same-port reverse is kept for
  // tooling that asks for the real port by number.
  test('reverseMetroPorts maps 8081 to the reserved port AND keeps the same-port reverse', () => {
    const exec = recordingExec();
    const result = reverseMetroPorts({ serial: 'emulator-5554', metroPort: 8082 }, { exec });
    expect(result.ok).toBe(true);
    expect(exec.calls).toEqual([
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8082'],
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8082', 'tcp:8082'],
    ]);
  });

  test('a workspace that actually reserved 8081 gets one reverse, not a duplicate', () => {
    const exec = recordingExec();
    reverseMetroPorts({ serial: 'emulator-5554', metroPort: DEFAULT_METRO_PORT }, { exec });
    expect(exec.calls).toEqual([['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8081']]);
  });

  test('launchAndroidApp reverses, resolves the activity, and am starts it', () => {
    const exec = recordingExec({
      outputs: { 'resolve-activity': 'priority=0 isDefault=true\ncom.example.app/.MainActivity\n' },
    });
    const result: any = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
      { exec },
    );
    expect(result.mode).toBe('am-start');
    expect(exec.calls).toEqual([
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8082'],
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8082', 'tcp:8082'],
      // The debug_http_host write sits between the reverses and the launch:
      // exact position pinned so neither mechanism can silently disappear.
      exec.calls[2],
      [
        'adb',
        '-s',
        'emulator-5554',
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-c',
        'android.intent.category.LAUNCHER',
        'com.example.app',
      ],
      ['adb', '-s', 'emulator-5554', 'shell', 'am', 'start', '-n', 'com.example.app/.MainActivity'],
    ]);
    expect(exec.calls[2].slice(0, 6)).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'run-as', 'com.example.app']);
    expect(exec.calls[2].at(-1)).toMatch(/debug_http_host.*10\.0\.2\.2:8082/);
  });

  test('falls back to monkey when no launcher activity resolves', () => {
    const exec = recordingExec({ outputs: { 'resolve-activity': 'No activity found\n' } });
    const result: any = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
      { exec },
    );
    expect(result.mode).toBe('monkey');
    expect(exec.calls.at(-1)).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'monkey', '-p', 'com.example.app', '1']);
  });

  // Wiring the port is not optional: launching an app whose 8081 goes nowhere
  // produces "Could not connect to development server" three seconds later,
  // which is a much worse diagnostic than the adb failure itself.
  test('a failed reverse stops the launch', () => {
    const exec = recordingExec({ fail: 'reverse' });
    const result: any = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
      { exec },
    );
    expect(result.code).toBe(LAUNCH_ERROR);
    expect(result.reason).toMatch(/adb reverse/);
    expect(exec.calls.length).toBe(1);
  });

  test('an am start failure is reported, not thrown', () => {
    const exec = recordingExec({
      fail: 'am start',
      outputs: { 'resolve-activity': 'priority=0\ncom.example.app/.MainActivity\n' },
    });
    expect(
      (launchAndroidApp({ serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 }, { exec }) as any)
        .reason,
    ).toMatch(/am start/);
  });

  test('an adb failure while resolving the activity falls through to monkey', () => {
    const exec = recordingExec({ fail: 'resolve-activity' });
    const result: any = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
      { exec },
    );
    expect(result.mode).toBe('monkey');
  });
});

// --- debug_http_host (the react-native-worktree trick) ----------------------
test('writeDebugHttpHost writes host:port via run-as and reports it', () => {
  const calls: string[][] = [];
  const exec: any = {
    runFile: (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return '';
    },
  };
  const r = writeDebugHttpHost({ serial: 'emulator-5554', packageName: 'com.x', metroPort: 8082 }, { exec });
  expect(r.ok).toBe(true);
  expect(r.host).toBe('10.0.2.2:8082');
  const argv = calls[0];
  expect(argv[0]).toBe('adb');
  expect(argv.slice(1, 6)).toEqual(['-s', 'emulator-5554', 'shell', 'run-as', 'com.x']);
  expect(argv[8]).toMatch(/debug_http_host/);
  expect(argv[8]).toMatch(/10\.0\.2\.2:8082/);
});

test('a failed prefs write does not fail the launch', () => {
  const exec: any = {
    runFile: (cmd: string, args: string[]) => {
      if (args.includes('run-as')) {
        const e = new Error('run-as: package not debuggable');
        throw e;
      }
      return '';
    },
    runQuiet: () => 'com.x/.MainActivity',
  };
  const r: any = launchAndroidApp({ serial: 'emulator-5554', packageName: 'com.x', metroPort: 8082 }, { exec });
  expect(r.ok).toBe(true);
  expect(r.debugHttpHost).toBe(null);
  expect(r.debugHttpHostNote).toMatch(/relying on adb reverse/);
});

// --- launch verification ---------------------------------------------------
//
// `simctl launch` returning a pid proves a process started. It does NOT prove
// the app loaded a bundle from this workspace's Metro: the observed failure
// was an app sitting on expo-dev-launcher's DEVELOPMENT SERVERS picker,
// listing every other workspace's bundler, while rn-iso reported
// launched: true. These tests pin the three paths that matter -- verified,
// the picker (nothing ever arrives), and the iOS 26 alert stall (something
// arrives, but only after the deadline).

// A fake clock, so a 20-second poll costs no wall time. `sleep` advances it
// instead of waiting, which is the only reason these can assert real
// timeouts.
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

describe('isBundleProof', () => {
  test('a Metro reporter bundle event after the launch is proof', () => {
    expect(isBundleProof({ ts: 100, event: 'bundle_build_started', src: 'metro' }, 100)).toBe(true);
    expect(isBundleProof({ ts: 150, event: 'bundle_build_done', src: 'metro' }, 100)).toBe(true);
    // A bundling error still proves the request reached THIS server.
    expect(isBundleProof({ ts: 150, event: 'bundling_error', src: 'metro' }, 100)).toBe(true);
  });

  test('an expo-child stdout line is the same proof by another route', () => {
    expect(
      isBundleProof(
        { ts: 150, src: 'metro', raw: true, event: 'expo_stdout', msg: 'iOS Bundling complete 812ms' },
        100,
      ),
    ).toBe(true);
    expect(
      isBundleProof(
        { ts: 150, src: 'metro', raw: true, event: 'expo_stdout', msg: 'iOS Bundled 812ms index.js (1150 modules)' },
        100,
      ),
    ).toBe(true);
    // The predicate the supervisor exports and the one this module keeps must
    // not drift apart.
    expect(isBundleActivityLine('Android Bundling failed 91ms')).toBe(true);
    expect(isBundleProof({ ts: 150, src: 'metro', msg: 'Android Bundling failed 91ms' }, 100)).toBe(true);
  });

  test('a record from BEFORE the launch is not proof of this launch', () => {
    // The previous run's bundle build is still in the same file. Trusting it
    // would verify a launch that loaded nothing.
    expect(isBundleProof({ ts: 99, event: 'bundle_build_done' }, 100)).toBe(false);
    expect(isBundleProof({ event: 'bundle_build_done' }, 100)).toBe(false);
  });

  test('server chatter is not proof', () => {
    expect(
      isBundleProof({ ts: 150, src: 'metro', event: 'supervisor_started', msg: 'supervisor pid 1 starting' }, 100),
    ).toBe(false);
    expect(
      isBundleProof({ ts: 150, src: 'metro', event: 'expo_stdout', msg: 'Waiting on http://localhost:8082' }, 100),
    ).toBe(false);
    expect(isBundleProof(null, 100)).toBe(false);
  });
});

describe('verifyLaunch', () => {
  test('verified: the poll returns as soon as a bundle request lands', async () => {
    const clock = fakeClock();
    const records: NdjsonRecord[] = [];
    let reads = 0;
    const result = await verifyLaunch({
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => {
        reads += 1;
        // Nothing for the first two polls, then the bundle request.
        if (reads === 3) records.push({ ts: clock.at(), event: 'bundle_build_started' });
        return records;
      },
    });
    expect(result.verified).toBe(true);
    assert(result.record);
    expect(result.record.event).toBe('bundle_build_started');
    expect(result.waitedMs > 0 && result.waitedMs < VERIFY_TIMEOUT_MS).toBeTruthy();
  });

  test('the picker: an app that fetches nothing times out as UNVERIFIED, not as a failure', async () => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      // The dev launcher is showing its server list. The dev server logs its
      // own startup and nothing else -- no bundle is ever requested.
      readRecords: () => [
        {
          ts: clock.at(),
          src: 'metro',
          event: 'supervisor_started',
          msg: 'supervisor pid 3 starting the expo-child dev server on port 8082',
        },
      ],
    });
    expect(result.verified).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.waitedMs >= VERIFY_TIMEOUT_MS).toBeTruthy();
  });

  test('the alert stall: a bundle that arrives after the deadline does not retroactively verify', async () => {
    // iOS 26 gates `simctl openurl` behind an "Open in <app>?" system alert.
    // Somebody taps it 30 seconds later; the run has long since reported.
    const clock = fakeClock();
    const result = await verifyLaunch({
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => (clock.at() > 1000 + 30000 ? [{ ts: clock.at(), event: 'bundle_build_started' }] : []),
    });
    expect(result.verified).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  test('a missing metro.ndjson is a miss, never a throw', async () => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      logsDir: '/nope/does/not/exist',
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 1000,
    });
    expect(result.verified).toBe(false);
  });

  test("reads the workspace's own metro.ndjson, half-written last line and all", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn-iso-verify-'));
    try {
      const clock = fakeClock();
      writeFileSync(
        join(dir, 'metro.ndjson'),
        `${JSON.stringify({ ts: clock.at() - 5, event: 'bundle_build_done' })}\n` +
          `${JSON.stringify({ ts: clock.at() + 10, event: 'bundle_build_started' })}\n` +
          '{"ts":123,"event":"half-writ',
      );
      const result = await verifyLaunch({ logsDir: dir, since: clock.at(), now: clock.now, sleep: clock.sleep });
      expect(result.verified).toBe(true);
      assert(result.record);
      expect(result.record.ts).toBe(clock.at() + 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unverifiedLaunchLines', () => {
  test('iOS names the picker, the iOS 26 alert, and the exact command to retry', () => {
    const url = devClientUrl('io.tlon.groups', 8082);
    const text = unverifiedLaunchLines({
      platform: 'ios',
      metroPort: 8082,
      waitedMs: 20000,
      bundleId: 'io.tlon.groups',
      udid: 'BF2A1C3D',
      devClientUrl: url,
    }).join('\n');
    expect(text).toMatch(/DEVELOPMENT SERVERS/);
    expect(text).toMatch(/localhost:8082/);
    expect(text).toMatch(/Open in/);
    expect(text).toMatch(/xcrun simctl openurl BF2A1C3D/);
    expect(text.includes(url)).toBeTruthy();
  });

  test('with no scheme it offers the launch command instead of a deep link', () => {
    const text = unverifiedLaunchLines({ platform: 'ios', metroPort: 8082, bundleId: 'com.x', udid: 'U1' }).join('\n');
    expect(text).toMatch(/xcrun simctl launch --console U1 com\.x/);
  });

  test('Android names its own re-launch, not simctl', () => {
    const text = unverifiedLaunchLines({
      platform: 'android',
      metroPort: 8082,
      bundleId: 'com.x',
      serial: 'emulator-5584',
    }).join('\n');
    expect(text).not.toMatch(/simctl/);
    expect(text).toMatch(/adb -s emulator-5584 shell monkey -p com\.x 1/);
    expect(text).toMatch(/DEVELOPMENT SERVERS/);
  });
});

// Field-proven on a fresh simulator: the iOS 26 "Open in <app>?" alert fires on
// EVERY first launch, and the only imperative this block used to carry was
// "retry the deep link" -- which re-raises the same alert forever. The action
// that actually works (confirm the alert) appeared as a CAUSE, three lines up
// from the command an agent would run. Order is the fix.
describe('unverifiedLaunchLines: the action comes first', () => {
  function iosLines() {
    return unverifiedLaunchLines({
      platform: 'ios',
      metroPort: 8082,
      waitedMs: 20000,
      bundleId: 'io.tlon.groups',
      udid: 'BF2A1C3D',
      devClientUrl: devClientUrl('io.tlon.groups', 8082),
    });
  }

  test('confirming the alert is step one, the picker is next, the retry is last', () => {
    const lines = iosLines();
    const alert = lines.findIndex((l) => /confirm it with your device tool/.test(l));
    const picker = lines.findIndex((l) => /DEVELOPMENT SERVERS/.test(l));
    const retry = lines.findIndex((l) => /simctl openurl/.test(l));
    expect(alert !== -1 && picker !== -1 && retry !== -1).toBeTruthy();
    expect(alert < picker).toBeTruthy();
    expect(picker < retry).toBeTruthy();
    expect(lines[alert]).toMatch(/every first launch/);
  });

  test('the retry is conditioned on there being no alert, so it cannot loop', () => {
    const retry = iosLines().find((l) => /simctl openurl/.test(l));
    expect(retry).toMatch(/only if no alert is showing/i);
  });

  test('the picker line still carries THIS workspace port, from the facts', () => {
    const picker = iosLines().find((l) => /DEVELOPMENT SERVERS/.test(l));
    expect(picker).toMatch(/localhost:8082/);
    expect(picker).toMatch(/NOT another workspace/);
  });

  test('android has no such alert, so it leads with the picker', () => {
    const lines = unverifiedLaunchLines({
      platform: 'android',
      metroPort: 8082,
      bundleId: 'com.x',
      serial: 'emulator-5584',
    });
    const picker = lines.findIndex((l) => /DEVELOPMENT SERVERS/.test(l));
    const relaunch = lines.findIndex((l) => /monkey -p com\.x/.test(l));
    expect(picker !== -1 && relaunch !== -1).toBeTruthy();
    expect(picker < relaunch).toBeTruthy();
    expect(!lines.some((l) => /Open in <app>/.test(l))).toBeTruthy();
  });
});

// --- debug_http_host: the script is EXECUTED here, not pattern-matched -----
//
// The argv-regex test above passed for the entire life of a writeDebugHttpHost
// that COULD NOT RUN. The script it built had three defects and any one of
// them was fatal: `.join(' ')` put `if` and `then` on one line
// (`sh: syntax error: unexpected 'then'`), the escaped inner double quotes
// closed the outer quoting so `>10.0.2.2:8085` parsed as a REDIRECTION, and
// the `\n` in the printf arguments went into a single-line command. A regex
// over the argv cannot see any of that. Executing the thing can.
//
// The runner below is a faithful stand-in for what adb does with
// `adb shell run-as <pkg> sh -c <arg>`: adb does NOT escape -- it joins the
// argv with spaces and hands the STRING to the device's shell, which parses
// it and hands the quoted script on to `sh -c`. So the outer `sh -c` here is
// the device shell, and the inner one is the script's. (`run-as` itself adds
// no parsing layer: it switches uid and execs its remaining argv.)
//
// Verified against the real thing as well, on a real emulator, with a real
// debuggable app -- see the change's report. This is the part of it that can
// run in CI.
describe('the debug_http_host script, run for real under sh', () => {
  let dir: string;
  const PKG = 'com.example.app';
  const prefsPath = () => join(dir, 'shared_prefs', `${PKG}_preferences.xml`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rn-iso-prefs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The device shell, then the script's shell. Throws (non-zero exit) exactly
  // where adb would report a failure.
  const runScript = (port: number) =>
    execFileSync(
      '/bin/sh',
      [
        '-c',
        `sh -c ${deviceShellArg(debugHttpHostScript({ packageName: PKG, host: `10.0.2.2:${port}`, dataDir: dir }))}`,
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

  // A strict-enough XML reader: it fails on unbalanced or unclosed tags, so
  // "the file parses" is an assertion and not a grep. Returns the <map>'s
  // string entries.
  const parsePrefs = (text: string) => {
    const entries: Record<string, string> = {};
    const stack: Array<{ name: string; attrs: Record<string, string> }> = [];
    const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
    const body = text.replace(/<\?xml[^>]*\?>/g, '');
    let last = 0;
    let m;
    while ((m = tag.exec(body)) !== null) {
      const [full, closing, name, attrs, selfClosing] = m;
      const between = body.slice(last, m.index);
      last = m.index + full.length;
      if (closing) {
        const open = stack.pop();
        assert(open);
        expect(open.name).toBe(name);
        if (name === 'string') entries[open.attrs.name] = between;
        continue;
      }
      const attrMap: Record<string, string> = {};
      for (const a of attrs.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrMap[a[1]] = a[2];
      if (selfClosing) {
        if (name === 'string') entries[attrMap.name] = '';
        continue;
      }
      stack.push({ name, attrs: attrMap });
    }
    expect(stack).toEqual([]);
    expect(body.trim()).toMatch(/^<map>[\s\S]*<\/map>$/);
    return entries;
  };

  test('case 1: no prefs file at all', () => {
    runScript(8085);
    const entries = parsePrefs(readFileSync(prefsPath(), 'utf-8'));
    expect(entries).toEqual({ debug_http_host: '10.0.2.2:8085' });
  });

  test('case 2: a prefs file that already carries the key (the value is replaced, once)', () => {
    runScript(8085);
    runScript(8099);
    const text = readFileSync(prefsPath(), 'utf-8');
    expect(parsePrefs(text)).toEqual({ debug_http_host: '10.0.2.2:8099' });
    const hostMatches = text.match(/debug_http_host/g);
    assert(hostMatches);
    expect(hostMatches.length).toBe(1);
  });

  test('case 3: a prefs file WITHOUT the key keeps every other entry', () => {
    execFileSync('/bin/sh', ['-c', `mkdir -p ${join(dir, 'shared_prefs')}`]);
    writeFileSync(
      prefsPath(),
      [
        // Android's own writer: single-quoted declaration, four-space indent.
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
        '<map>',
        '    <string name="onboarding">done</string>',
        '    <string name="last_route">/settings?tab=1&amp;q=x</string>',
        '</map>',
        '',
      ].join('\n'),
    );
    runScript(8085);
    expect(parsePrefs(readFileSync(prefsPath(), 'utf-8'))).toEqual({
      onboarding: 'done',
      last_route: '/settings?tab=1&amp;q=x',
      debug_http_host: '10.0.2.2:8085',
    });
  });

  test("case 4: Android's empty-prefs form, `<map />`", () => {
    execFileSync('/bin/sh', ['-c', `mkdir -p ${join(dir, 'shared_prefs')}`]);
    writeFileSync(prefsPath(), "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map />\n");
    runScript(8085);
    expect(parsePrefs(readFileSync(prefsPath(), 'utf-8'))).toEqual({ debug_http_host: '10.0.2.2:8085' });
  });

  test('a data directory that does not exist exits non-zero rather than pretending', () => {
    const script = debugHttpHostScript({ packageName: PKG, host: '10.0.2.2:8085', dataDir: join(dir, 'nope') });
    expect(() => execFileSync('/bin/sh', ['-c', `sh -c ${deviceShellArg(script)}`], { stdio: 'ignore' })).toThrow();
  });

  test('the script is multi-line, and every line survives the quoting', () => {
    const script = debugHttpHostScript({ packageName: PKG, host: '10.0.2.2:8085' });
    expect(script.split('\n').length >= 6).toBeTruthy();
    expect(script).toMatch(/^cd \/data\/data\/com\.example\.app \|\| exit 1$/m);
    // The defect that made `>10.0.2.2:8085` a redirection: the XML's double
    // quotes must never be escaped INSIDE a double-quoted shell word.
    expect(script).not.toMatch(/\\"/);
    // Round-trip: what the device shell will hand to `sh -c` is byte for byte
    // what was built.
    const roundTripped = execFileSync('/bin/sh', ['-c', `printf %s ${deviceShellArg(script)}`], { encoding: 'utf-8' });
    expect(roundTripped).toBe(script);
  });
});

// --- the dev-client deep link, Android half --------------------------------
describe('the Android dev-client deep link', () => {
  test('the url is the iOS shape pointed at the emulator loopback', () => {
    expect(androidDevClientUrl('exp+app', 8085)).toBe(
      'exp+app://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8085',
    );
    // Same builder, same shape, different host: iOS keeps localhost.
    expect(devClientUrl('exp+app', 8085)).toBe('exp+app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8085');
  });

  test('launchAndroidApp sends it, quoted for the device shell, and skips resolve-activity', () => {
    const exec = recordingExec();
    const result: LaunchResult = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082, devClientScheme: 'exp+app' },
      { exec },
    );
    expect(result.mode).toBe('deep-link');
    expect(result.devClientUrl).toBe('exp+app://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8082');
    expect(exec.calls.at(-1)).toEqual([
      'adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      // Quoted: adb hands the joined argv to the device's shell, and this url
      // carries `?`.
      '-d',
      `'exp+app://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8082'`,
    ]);
    expect(!exec.calls.some((c: string[]) => c.includes('resolve-activity'))).toBeTruthy();
    // The port wiring still ran first, both halves of it.
    expect(result.debugHttpHost).toBe('10.0.2.2:8082');
    expect(result.reversed).toEqual(['tcp:8081->tcp:8082', 'tcp:8082->tcp:8082']);
  });

  test('am start exits 0 on an intent it could not resolve, so the OUTPUT is read', () => {
    // Captured shape from `am start` itself: it prints the error and returns
    // 0, which is why the exit code cannot be the check.
    expect(
      amStartError(
        'Starting: Intent { act=android.intent.action.VIEW dat=exp+app://expo-development-client/... }\nError: Activity not started, unable to resolve Intent',
      ),
    ).toMatch(/unable to resolve Intent/);
    expect(amStartError('Starting: Intent { act=android.intent.action.VIEW dat=exp+app://... }')).toBe(null);
    // An app already in the foreground: a Warning, and a success.
    expect(
      amStartError(
        'Starting: Intent { ... }\nWarning: Activity not started, its current task has been brought to the front',
      ),
    ).toBe(null);
    expect(amStartError('')).toBe(null);
  });

  test('a deep link nothing answers falls back to the launcher and says so', () => {
    const exec = recordingExec({
      outputs: {
        'android.intent.action.VIEW':
          'Starting: Intent { act=android.intent.action.VIEW dat=exp+app://expo-development-client/... }\nError: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW }',
        'resolve-activity': 'priority=0 isDefault=true\ncom.example.app/.MainActivity\n',
      },
    });
    const result: LaunchResult = launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082, devClientScheme: 'exp+app' },
      { exec },
    );
    // The app is installed and a launcher start still gives the developer
    // something: refusing the run here would be strictly worse.
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('am-start');
    expect(result.devClientNote).toMatch(/unable to resolve Intent/);
    expect(result.devClientNote).toMatch(/fell back to the launcher activity/);
    expect(exec.calls.at(-1)).toEqual([
      'adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-n',
      'com.example.app/.MainActivity',
    ]);
  });

  test('openAndroidDevClientUrl reports an adb failure rather than throwing', () => {
    const exec = recordingExec({ fail: 'am start' });
    const r = openAndroidDevClientUrl({ serial: 'emulator-5554', url: 'exp+app://x' }, { exec });
    expect(r.failed).toBe(true);
    expect(r.reason).toMatch(/am start -d exp\+app:\/\/x failed/);
  });

  test('deviceShellArg quotes what adb will not', () => {
    expect(deviceShellArg('a b')).toBe(`'a b'`);
    expect(deviceShellArg("it's")).toBe(`'it'\\''s'`);
    // The property that matters: one shell round trip returns the input.
    for (const raw of ['a b', "it's", 'x\ny', '?url=a&b=c', '$HOME `id`', '<map>']) {
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${deviceShellArg(raw)}`], { encoding: 'utf-8' })).toBe(raw);
    }
  });
});
