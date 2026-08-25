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
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBundleActivityLine } from '../src/supervisor/server-expo.js';
import {
  DEFAULT_METRO_PORT,
  INSTALL_ERROR,
  LAUNCH_ERROR,
  VERIFY_TIMEOUT_MS,
  devClientUrl,
  isBundleProof,
  unverifiedLaunchLines,
  verifyLaunch,
  installAndroidApp,
  installIosApp,
  jsLocationValue,
  launchAndroidApp,
  launchIosApp,
  parseResolvedActivity,
  reverseMetroPorts,
  writeDebugHttpHost,
} from '../src/engine/app-install.js';

// Records every runFile call as a flat argv array, and lets a test make a
// particular one fail.
function recordingExec({ fail = null, outputs = {} } = {}) {
  const calls = [];
  return {
    calls,
    runFile(file, args) {
      calls.push([file, ...args]);
      const key = [file, ...args].join(' ');
      if (fail && key.includes(fail)) {
        const err = new Error(`Command failed: ${key}`);
        err.stderr = 'device not booted';
        throw err;
      }
      for (const [match, value] of Object.entries(outputs)) {
        if (key.includes(match)) return value;
      }
      return '';
    },
    run() { throw new Error('app-install must use runFile, not the shell'); },
    runQuiet() { throw new Error('app-install must use runFile, not the shell'); },
    spawn() { throw new Error('app-install does not spawn'); },
  };
}

describe('the two pure port-wiring shapes', () => {
  // A host:port string, not a URL and not a bare port: serverRootWithHostPort
  // interpolates it whole when it contains a colon, and appends the default
  // 8081 when it does not.
  test('jsLocationValue is host:port', () => {
    assert.equal(jsLocationValue(8082), 'localhost:8082');
    assert.match(jsLocationValue(8082), /:/, 'without a colon RN would append its own default port');
  });

  test('devClientUrl matches the shape expo-dev-launcher asserts on', () => {
    assert.equal(
      devClientUrl('myapp', 8082),
      'myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082'
    );
    // The exact string in EXDevLauncherURLHelperTests.swift line 15.
    assert.equal(
      devClientUrl('scheme', 8081),
      'scheme://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081'
    );
  });
});

describe('ios', () => {
  test('installIosApp passes the .app path as one literal argv element', () => {
    const exec = recordingExec();
    const appPath = '/tmp/Build Products/My App.app';
    assert.deepEqual(installIosApp({ udid: 'U1', appPath }, { exec }), { ok: true, appPath });
    assert.deepEqual(exec.calls, [['xcrun', 'simctl', 'install', 'U1', appPath]]);
  });

  test('installIosApp reports a simctl failure instead of throwing', () => {
    const exec = recordingExec({ fail: 'simctl install' });
    const result = installIosApp({ udid: 'U1', appPath: '/tmp/a.app' }, { exec });
    assert.equal(result.code, INSTALL_ERROR);
    assert.match(result.reason, /device not booted/);
  });

  // RCT_jsLocation is written FIRST and unconditionally. On the bare path it
  // is the only wiring there is; on the dev-client path an in-app reload
  // still goes through RCTBundleURLProvider, and a stale default there would
  // send the reload at 8081 -- another workspace's bundler.
  test('launchIosApp writes RCT_jsLocation before launching, bare RN path', () => {
    const exec = recordingExec();
    const result = launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'launch');
    assert.deepEqual(exec.calls, [
      ['xcrun', 'simctl', 'spawn', 'U1', 'defaults', 'write', 'com.example.app', 'RCT_jsLocation', 'localhost:8082'],
      ['xcrun', 'simctl', 'launch', 'U1', 'com.example.app'],
    ]);
  });

  test('launchIosApp opens the dev-client URL when a scheme is given, still after the defaults write', () => {
    const exec = recordingExec();
    const result = launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' }, { exec });
    assert.equal(result.mode, 'openurl');
    assert.deepEqual(exec.calls, [
      ['xcrun', 'simctl', 'spawn', 'U1', 'defaults', 'write', 'com.example.app', 'RCT_jsLocation', 'localhost:8082'],
      ['xcrun', 'simctl', 'openurl', 'U1', 'myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082'],
    ]);
  });

  test('a failed defaults write stops the launch rather than launching unwired', () => {
    const exec = recordingExec({ fail: 'defaults write' });
    const result = launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec });
    assert.equal(result.code, LAUNCH_ERROR);
    assert.match(result.reason, /RCT_jsLocation/);
    assert.equal(exec.calls.length, 1, 'must not go on to launch an app pointed at the wrong port');
  });

  test('a failed launch is reported, not thrown', () => {
    const exec = recordingExec({ fail: 'simctl launch' });
    assert.match(launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec }).reason, /simctl launch/);
  });
});

describe('android: resolve-activity parsing', () => {
  // Captured verbatim from a live emulator (Android 16):
  //   adb -s emulator-5554 shell cmd package resolve-activity --brief \
  //     -c android.intent.category.LAUNCHER com.android.settings
  const REAL = 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.android.settings/.Settings\n';

  test('takes the component line, not the key=value header', () => {
    assert.equal(parseResolvedActivity(REAL), 'com.android.settings/.Settings');
  });

  // Also captured from the same emulator, for a package that does not exist.
  test('returns null for "No activity found", which resolve-activity prints with exit 0', () => {
    assert.equal(parseResolvedActivity('No activity found\n'), null);
  });

  test('returns null for empty or non-string output', () => {
    assert.equal(parseResolvedActivity(''), null);
    assert.equal(parseResolvedActivity(null), null);
  });

  test('handles a fully qualified activity name', () => {
    assert.equal(
      parseResolvedActivity('priority=0 isDefault=true\ncom.example.app/com.example.app.MainActivity\n'),
      'com.example.app/com.example.app.MainActivity'
    );
  });
});

describe('android: install and launch', () => {
  test('installAndroidApp uses adb install -r with the apk as one argv element', () => {
    const exec = recordingExec();
    const apkPath = '/tmp/out puts/app-debug.apk';
    assert.deepEqual(installAndroidApp({ serial: 'emulator-5554', apkPath }, { exec }), { ok: true, apkPath });
    assert.deepEqual(exec.calls, [['adb', '-s', 'emulator-5554', 'install', '-r', apkPath]]);
  });

  // Contract 6: the app asks for its compiled-in 8081, and that request is
  // mapped to THIS workspace's reservation. The same-port reverse is kept for
  // tooling that asks for the real port by number.
  test('reverseMetroPorts maps 8081 to the reserved port AND keeps the same-port reverse', () => {
    const exec = recordingExec();
    const result = reverseMetroPorts({ serial: 'emulator-5554', metroPort: 8082 }, { exec });
    assert.equal(result.ok, true);
    assert.deepEqual(exec.calls, [
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8082'],
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8082', 'tcp:8082'],
    ]);
  });

  test('a workspace that actually reserved 8081 gets one reverse, not a duplicate', () => {
    const exec = recordingExec();
    reverseMetroPorts({ serial: 'emulator-5554', metroPort: DEFAULT_METRO_PORT }, { exec });
    assert.deepEqual(exec.calls, [['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8081']]);
  });

  test('launchAndroidApp reverses, resolves the activity, and am starts it', () => {
    const exec = recordingExec({ outputs: { 'resolve-activity': 'priority=0 isDefault=true\ncom.example.app/.MainActivity\n' } });
    const result = launchAndroidApp({ serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 }, { exec });
    assert.equal(result.mode, 'am-start');
    assert.deepEqual(exec.calls, [
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8082'],
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8082', 'tcp:8082'],
      // The debug_http_host write sits between the reverses and the launch:
      // exact position pinned so neither mechanism can silently disappear.
      exec.calls[2],
      ['adb', '-s', 'emulator-5554', 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', 'com.example.app'],
      ['adb', '-s', 'emulator-5554', 'shell', 'am', 'start', '-n', 'com.example.app/.MainActivity'],
    ]);
    assert.deepEqual(exec.calls[2].slice(0, 6), ['adb', '-s', 'emulator-5554', 'shell', 'run-as', 'com.example.app']);
    assert.match(exec.calls[2].at(-1), /debug_http_host.*10\.0\.2\.2:8082/);
  });

  test('falls back to monkey when no launcher activity resolves', () => {
    const exec = recordingExec({ outputs: { 'resolve-activity': 'No activity found\n' } });
    const result = launchAndroidApp({ serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 }, { exec });
    assert.equal(result.mode, 'monkey');
    assert.deepEqual(exec.calls.at(-1), ['adb', '-s', 'emulator-5554', 'shell', 'monkey', '-p', 'com.example.app', '1']);
  });

  // Wiring the port is not optional: launching an app whose 8081 goes nowhere
  // produces "Could not connect to development server" three seconds later,
  // which is a much worse diagnostic than the adb failure itself.
  test('a failed reverse stops the launch', () => {
    const exec = recordingExec({ fail: 'reverse' });
    const result = launchAndroidApp({ serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 }, { exec });
    assert.equal(result.code, LAUNCH_ERROR);
    assert.match(result.reason, /adb reverse/);
    assert.equal(exec.calls.length, 1);
  });

  test('an am start failure is reported, not thrown', () => {
    const exec = recordingExec({ fail: 'am start', outputs: { 'resolve-activity': 'priority=0\ncom.example.app/.MainActivity\n' } });
    assert.match(launchAndroidApp({ serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 }, { exec }).reason, /am start/);
  });

  test('an adb failure while resolving the activity falls through to monkey', () => {
    const exec = recordingExec({ fail: 'resolve-activity' });
    const result = launchAndroidApp({ serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 }, { exec });
    assert.equal(result.mode, 'monkey');
  });
});

// --- debug_http_host (the react-native-worktree trick) ----------------------
test('writeDebugHttpHost writes host:port via run-as and reports it', () => {
  const calls = [];
  const exec = { runFile: (cmd, args) => { calls.push([cmd, ...args]); return ''; } };
  const r = writeDebugHttpHost({ serial: 'emulator-5554', packageName: 'com.x', metroPort: 8082 }, { exec });
  assert.equal(r.ok, true);
  assert.equal(r.host, '10.0.2.2:8082');
  const argv = calls[0];
  assert.equal(argv[0], 'adb');
  assert.deepEqual(argv.slice(1, 6), ['-s', 'emulator-5554', 'shell', 'run-as', 'com.x']);
  assert.match(argv[8], /debug_http_host/);
  assert.match(argv[8], /10\.0\.2\.2:8082/);
});

test('a failed prefs write does not fail the launch', () => {
  const exec = {
    runFile: (cmd, args) => {
      if (args.includes('run-as')) { const e = new Error('run-as: package not debuggable'); throw e; }
      return '';
    },
    runQuiet: () => 'com.x/.MainActivity',
  };
  const r = launchAndroidApp({ serial: 'emulator-5554', packageName: 'com.x', metroPort: 8082 }, { exec });
  assert.equal(r.ok, true, 'launch must proceed on the adb reverse path alone');
  assert.equal(r.debugHttpHost, null);
  assert.match(r.debugHttpHostNote, /relying on adb reverse/);
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
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
    at: () => t,
  };
}

describe('isBundleProof', () => {
  test('a Metro reporter bundle event after the launch is proof', () => {
    assert.equal(isBundleProof({ ts: 100, event: 'bundle_build_started', src: 'metro' }, 100), true);
    assert.equal(isBundleProof({ ts: 150, event: 'bundle_build_done', src: 'metro' }, 100), true);
    // A bundling error still proves the request reached THIS server.
    assert.equal(isBundleProof({ ts: 150, event: 'bundling_error', src: 'metro' }, 100), true);
  });

  test('an expo-child stdout line is the same proof by another route', () => {
    assert.equal(isBundleProof({ ts: 150, src: 'metro', raw: true, event: 'expo_stdout', msg: 'iOS Bundling complete 812ms' }, 100), true);
    assert.equal(isBundleProof({ ts: 150, src: 'metro', raw: true, event: 'expo_stdout', msg: 'iOS Bundled 812ms index.js (1150 modules)' }, 100), true);
    // The predicate the supervisor exports and the one this module keeps must
    // not drift apart.
    assert.equal(isBundleActivityLine('Android Bundling failed 91ms'), true);
    assert.equal(isBundleProof({ ts: 150, src: 'metro', msg: 'Android Bundling failed 91ms' }, 100), true);
  });

  test('a record from BEFORE the launch is not proof of this launch', () => {
    // The previous run's bundle build is still in the same file. Trusting it
    // would verify a launch that loaded nothing.
    assert.equal(isBundleProof({ ts: 99, event: 'bundle_build_done' }, 100), false);
    assert.equal(isBundleProof({ event: 'bundle_build_done' }, 100), false, 'no timestamp is no proof');
  });

  test('server chatter is not proof', () => {
    assert.equal(isBundleProof({ ts: 150, src: 'metro', event: 'supervisor_started', msg: 'supervisor pid 1 starting' }, 100), false);
    assert.equal(isBundleProof({ ts: 150, src: 'metro', event: 'expo_stdout', msg: 'Waiting on http://localhost:8082' }, 100), false);
    assert.equal(isBundleProof(null, 100), false);
  });
});

describe('verifyLaunch', () => {
  test('verified: the poll returns as soon as a bundle request lands', async () => {
    const clock = fakeClock();
    const records = [];
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
    assert.equal(result.verified, true);
    assert.equal(result.record.event, 'bundle_build_started');
    assert.ok(result.waitedMs > 0 && result.waitedMs < VERIFY_TIMEOUT_MS);
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
        { ts: clock.at(), src: 'metro', event: 'supervisor_started', msg: 'supervisor pid 3 starting the expo-child dev server on port 8082' },
      ],
    });
    assert.equal(result.verified, false);
    assert.equal(result.timedOut, true);
    assert.ok(result.waitedMs >= VERIFY_TIMEOUT_MS, `waited ${result.waitedMs}`);
  });

  test('the alert stall: a bundle that arrives after the deadline does not retroactively verify', async () => {
    // iOS 26 gates `simctl openurl` behind an "Open in <app>?" system alert.
    // Somebody taps it 30 seconds later; the run has long since reported.
    const clock = fakeClock();
    const result = await verifyLaunch({
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => (clock.at() > 1000 + 30000
        ? [{ ts: clock.at(), event: 'bundle_build_started' }]
        : []),
    });
    assert.equal(result.verified, false);
    assert.equal(result.timedOut, true);
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
    assert.equal(result.verified, false);
  });

  test('reads the workspace\'s own metro.ndjson, half-written last line and all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn-iso-verify-'));
    try {
      const clock = fakeClock();
      writeFileSync(join(dir, 'metro.ndjson'),
        `${JSON.stringify({ ts: clock.at() - 5, event: 'bundle_build_done' })}\n`
        + `${JSON.stringify({ ts: clock.at() + 10, event: 'bundle_build_started' })}\n`
        + '{"ts":123,"event":"half-writ');
      const result = await verifyLaunch({ logsDir: dir, since: clock.at(), now: clock.now, sleep: clock.sleep });
      assert.equal(result.verified, true);
      assert.equal(result.record.ts, clock.at() + 10, 'the stale record from before the launch was skipped');
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
    assert.match(text, /DEVELOPMENT SERVERS/);
    assert.match(text, /localhost:8082/);
    assert.match(text, /Open in/, 'the iOS 26 confirmation alert is named');
    assert.match(text, /xcrun simctl openurl BF2A1C3D/);
    assert.ok(text.includes(url), 'the retry command carries the real deep link');
  });

  test('with no scheme it offers the launch command instead of a deep link', () => {
    const text = unverifiedLaunchLines({ platform: 'ios', metroPort: 8082, bundleId: 'com.x', udid: 'U1' }).join('\n');
    assert.match(text, /xcrun simctl launch --console U1 com\.x/);
  });

  test('Android names its own re-launch, not simctl', () => {
    const text = unverifiedLaunchLines({ platform: 'android', metroPort: 8082, bundleId: 'com.x', serial: 'emulator-5584' }).join('\n');
    assert.doesNotMatch(text, /simctl/);
    assert.match(text, /adb -s emulator-5584 shell monkey -p com\.x 1/);
    assert.match(text, /DEVELOPMENT SERVERS/);
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
    const alert = lines.findIndex(l => /confirm it with your device tool/.test(l));
    const picker = lines.findIndex(l => /DEVELOPMENT SERVERS/.test(l));
    const retry = lines.findIndex(l => /simctl openurl/.test(l));
    assert.ok(alert !== -1 && picker !== -1 && retry !== -1, lines.join('\n'));
    assert.ok(alert < picker, 'the alert action precedes the picker case');
    assert.ok(picker < retry, 'and the deep-link retry is last');
    assert.match(lines[alert], /every first launch/, 'it is not presented as an edge case');
  });

  test('the retry is conditioned on there being no alert, so it cannot loop', () => {
    const retry = iosLines().find(l => /simctl openurl/.test(l));
    assert.match(retry, /only if no alert is showing/i);
  });

  test('the picker line still carries THIS workspace port, from the facts', () => {
    const picker = iosLines().find(l => /DEVELOPMENT SERVERS/.test(l));
    assert.match(picker, /localhost:8082/);
    assert.match(picker, /NOT another workspace/);
  });

  test('android has no such alert, so it leads with the picker', () => {
    const lines = unverifiedLaunchLines({ platform: 'android', metroPort: 8082, bundleId: 'com.x', serial: 'emulator-5584' });
    const picker = lines.findIndex(l => /DEVELOPMENT SERVERS/.test(l));
    const relaunch = lines.findIndex(l => /monkey -p com\.x/.test(l));
    assert.ok(picker !== -1 && relaunch !== -1);
    assert.ok(picker < relaunch);
    assert.ok(!lines.some(l => /Open in <app>/.test(l)), 'the iOS 26 alert is not an android case');
  });
});
