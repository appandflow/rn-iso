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
import {
  DEFAULT_METRO_PORT,
  INSTALL_ERROR,
  LAUNCH_ERROR,
  devClientUrl,
  installAndroidApp,
  installIosApp,
  jsLocationValue,
  launchAndroidApp,
  launchIosApp,
  parseResolvedActivity,
  reverseMetroPorts,
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
      ['adb', '-s', 'emulator-5554', 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', 'com.example.app'],
      ['adb', '-s', 'emulator-5554', 'shell', 'am', 'start', '-n', 'com.example.app/.MainActivity'],
    ]);
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
